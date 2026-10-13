/**
 * An agent's inbox on Agent Messaging's RabbitMQ binding, against a real
 * RabbitMQ (docs/rabbitmq-binding.md §6.1). Skips unless
 *
 *   AMS_TEST_AMQP_URL   amqp://user:pass@127.0.0.1:5672/vhost (a vhost of its own)
 *
 * names a broker. The user logs in as an internal RabbitMQ user, so no mesh
 * server is needed: nobody answers `mesh.registry.register`, which the SDK
 * treats as a mesh without a registry, and the test makes the agent's mailbox
 * queue itself, as the registry does at registration.
 *
 * What it holds: a registered agent receives each inbox message ONCE (the
 * transport hands it over once, not once live and once from the mailbox),
 * an agent that was away gets what waited when it comes back, a dropped
 * connection resumes where it left off, and the registry's probe is answered
 * on its reply address from the mailbox delivery.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nkeys } from "nats.ws";
import { AgentMesh, connectTransport, createEnvelope, decode, encode, signEnvelope } from "../../src/index.js";
import type { ConnectionManager } from "../../src/internal/connection.js";

const RAW = process.env.AMS_TEST_AMQP_URL?.trim();
const live = RAW ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Every delivery the transport hands this connection's owner, by subject:
 *  the live subscriptions' and the durable consumers' alike. */
function countDeliveries(conn: ConnectionManager): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (s: string) => counts.set(s, (counts.get(s) ?? 0) + 1);
  const c = conn as unknown as {
    subscribe(subject: string, handler: (m: { subject: string }) => void): unknown;
    consume(queue: string, opts?: unknown): Promise<AsyncIterable<{ subject: string }> & { stop(): void }>;
  };
  const subscribe = c.subscribe.bind(c);
  c.subscribe = (subject, handler) => subscribe(subject, (m) => {
    bump(m.subject);
    handler(m);
  });
  const consume = c.consume.bind(c);
  c.consume = async (queue, opts) => {
    const inner = await consume(queue, opts);
    return Object.assign(Object.create(inner) as object, {
      stop: () => inner.stop(),
      async *[Symbol.asyncIterator]() {
        for await (const d of inner) {
          bump(d.subject);
          yield d;
        }
      },
    }) as typeof inner;
  };
  return counts;
}

live("an agent's inbox on the RabbitMQ binding (live broker)", () => {
  const url = new URL(RAW ?? "amqp://localhost");
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";
  const base = url.toString();
  const dial = () => connectTransport({ servers: [base], auth: { user, pass }, name: "amqp-inbox.test", reconnectTimeWait: 300 });

  let admin: { checkQueue(q: string): Promise<{ messageCount: number; consumerCount: number }>; close(): Promise<void> } & Record<string, (...a: unknown[]) => Promise<unknown>>;
  let adminConn: { close(): Promise<void>; createChannel(): Promise<unknown> };
  const open: AgentMesh[] = [];

  beforeAll(async () => {
    const amqp = (await import("amqplib")) as unknown as { connect(u: string): Promise<typeof adminConn> };
    adminConn = await amqp.connect(RAW!);
    admin = (await adminConn.createChannel()) as typeof admin;
    await admin.assertExchange("mesh", "topic", { durable: true });
  });

  afterAll(async () => {
    for (const a of open) await a.close().catch(() => undefined);
    await adminConn?.close().catch(() => undefined);
  });

  /** What the registry makes at registration: the mailbox queue on the inbox. */
  async function makeMailbox(agentId: string): Promise<string> {
    const q = `MESH_INBOX_${agentId}`;
    await admin.assertQueue(q, { durable: true, arguments: { "x-queue-type": "classic", "x-overflow": "drop-head" } });
    await admin.bindQueue(q, "mesh", `mesh.agent.${agentId}.inbox`);
    return q;
  }

  async function receiver(kp: ReturnType<typeof nkeys.createUser>) {
    const conn = await dial();
    const counts = countDeliveries(conn);
    const agent = AgentMesh.withConnection(conn, kp, undefined, { refuseRevokedSenders: false });
    open.push(agent);
    const handled: unknown[] = [];
    agent.onRequest("echo", (input) => {
      handled.push(input);
      return input;
    });
    await agent.register({ name: "amqp-inbox" });
    return { conn, agent, counts, handled };
  }

  it("hands each message over once, holds it while the agent is away, and resumes after a dropped connection", async () => {
    const kp = nkeys.createUser();
    const id = kp.getPublicKey();
    const inbox = `mesh.agent.${id}.inbox`;
    const queue = await makeMailbox(id);

    const sender = AgentMesh.withConnection(await dial(), nkeys.createUser(), undefined, { refuseRevokedSenders: false });
    open.push(sender);

    // ── online: five requests, five deliveries ──────────────────────────
    const r1 = await receiver(kp);
    await until("the mailbox consumer", async () => (await admin.checkQueue(queue)).consumerCount === 1);
    for (let i = 0; i < 5; i++) {
      const res = await sender.request(id, "echo", { n: i }, { timeout: 10_000 });
      expect(res.payload.output).toEqual({ n: i });
    }
    await sleep(2000); // long enough for a second copy, were there one, to arrive
    expect(r1.handled).toHaveLength(5);
    expect(r1.counts.get(inbox)).toBe(5); // once each, not once live and once from the mailbox

    // ── away: what is sent waits in the mailbox ─────────────────────────
    await r1.agent.close();
    open.splice(open.indexOf(r1.agent), 1);
    await until("the consumer to go", async () => (await admin.checkQueue(queue)).consumerCount === 0);
    const waiting = [5, 6, 7].map((n) => sender.request(id, "echo", { n }, { timeout: 30_000 }));
    await until("three messages held", async () => (await admin.checkQueue(queue)).messageCount === 3);

    // ── back: the same key gets them, once each ─────────────────────────
    const r2 = await receiver(kp);
    const answers = await Promise.all(waiting);
    expect(answers.map((a) => a.payload.output)).toEqual([{ n: 5 }, { n: 6 }, { n: 7 }]);
    await until("the mailbox emptied", async () => (await admin.checkQueue(queue)).messageCount === 0);
    expect(r2.handled).toEqual([{ n: 5 }, { n: 6 }, { n: 7 }]);
    expect(r2.counts.get(inbox)).toBe(3);

    // ── a dropped connection: it comes back and carries on ───────────────
    const raw = r2.conn as unknown as { conn: { close(): Promise<void> } | null };
    await raw.conn!.close();
    const during = [8, 9].map((n) => sender.request(id, "echo", { n }, { timeout: 30_000 }));
    const after = await Promise.all(during);
    expect(after.map((a) => a.payload.output)).toEqual([{ n: 8 }, { n: 9 }]);
    await sleep(500);
    expect(r2.handled).toEqual([{ n: 5 }, { n: 6 }, { n: 7 }, { n: 8 }, { n: 9 }]);
    expect(r2.counts.get(inbox)).toBe(5);
    expect((await admin.checkQueue(queue)).messageCount).toBe(0);
  }, 90_000);

  it("answers the registry's probe on its reply address, from the mailbox delivery", async () => {
    const kp = nkeys.createUser();
    const id = kp.getPublicKey();
    const queue = await makeMailbox(id);
    const r = await receiver(kp);
    await until("the mailbox consumer", async () => (await admin.checkQueue(queue)).consumerCount === 1);

    const registry = nkeys.createUser();
    const env = createEnvelope({ type: "request", from: registry.getPublicKey(), to: id, payload: { offering: "__registry_probe__", input: null } });
    signEnvelope(env, registry);
    const caller = await dial();
    const reply = await caller.request(`mesh.agent.${id}.inbox`, encode(env), { timeout: 5000 });
    const answer = decode(reply.data);
    expect(answer.type).toBe("respond");
    expect(answer.in_reply_to).toBe(env.id);
    expect(r.counts.get(`mesh.agent.${id}.inbox`)).toBe(1);
    await caller.close();
  }, 30_000);
});
