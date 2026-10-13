// Durable event subscriptions (SPEC §18.6 Event Consumer).
//
// subscribe(pattern, handler, { durable }) binds a durable JetStream consumer
// on MESH_EVENTS. The consumer NAME is a cross-SDK contract, pinned here with
// a hardcoded fixture the Rust SDK pins byte-identically:
//
//     subscriptionHash = first 16 lowercase hex chars of
//                        SHA-256(UTF-8 "billing.invoice_ready")
//                      = "99397ba4a29eec30"
//
// Against a fake JetStream, like the drain suites: what needs pinning is the
// consumer name, the config, the ack discipline and the freshness window, not
// the transport.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AckPolicy, DeliverPolicy } from "nats.ws";
import { AgentMesh, type DurableEventSubscription } from "../../src/mesh.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode, MeshError } from "../../src/types/errors.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import type { Envelope } from "../../src/types/envelope.js";

const PATTERN = "billing.invoice_ready";
const FIXTURE_HASH = "99397ba4a29eec30"; // sha256("billing.invoice_ready")[0..16), pinned cross-SDK

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

/** One JetStream delivery the durable loop reads. */
type JsMsgLike = { data: Uint8Array; subject?: string; ack: () => void };

/** A push-driven consume() iterable: the test feeds messages in, stop() ends it. */
function makeMessages() {
  const pending: JsMsgLike[] = [];
  let notify: (() => void) | null = null;
  let stopped = false;
  return {
    stopCalls: 0,
    push(m: JsMsgLike) {
      pending.push(m);
      notify?.();
    },
    stop() {
      this.stopCalls++;
      stopped = true;
      notify?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (pending.length) yield pending.shift()!;
        if (stopped) return;
        await new Promise<void>((r) => {
          notify = r;
        });
        notify = null;
      }
    },
  };
}

function makeConn(opts?: { consumerExists?: boolean; jetstreamBroken?: boolean }) {
  const subs = new Map<string, (msg: unknown) => void>();
  const registryKp = nkeys.createUser();
  const messages = makeMessages();
  const added: Array<{ stream: string; config: Record<string, unknown> }> = [];
  const infoCalls: Array<{ stream: string; durable: string }> = [];
  const deleted: string[] = [];
  const gets: Array<{ stream: string; durable: string }> = [];

  const jsm = {
    consumers: {
      info: vi.fn(async (stream: string, durable: string) => {
        infoCalls.push({ stream, durable });
        if (!opts?.consumerExists) throw new Error("consumer not found");
        return { num_pending: 0, num_ack_pending: 0 };
      }),
      add: vi.fn(async (stream: string, config: Record<string, unknown>) => {
        added.push({ stream, config });
        return { num_pending: 0, num_ack_pending: 0 };
      }),
      delete: vi.fn(async (_stream: string, durable: string) => {
        deleted.push(durable);
        return true;
      }),
    },
    streams: {
      // The mailbox drain also calls streams.info; irrelevant here, and the
      // durable path never does.
      info: vi.fn(async () => {
        throw new Error("no mailbox stream in this fake");
      }),
    },
  };
  const consumer = {
    consume: vi.fn(async () => messages),
    delete: vi.fn(async () => {
      deleted.push("via consumer.delete");
      return true;
    }),
  };
  const raw = {
    jetstreamManager: vi.fn(async () => {
      if (opts?.jetstreamBroken) throw new Error("jetstream API refused for this credential");
      return jsm;
    }),
    jetstream: vi.fn(() => ({
      consumers: {
        get: vi.fn(async (stream: string, durable: string) => {
          gets.push({ stream, durable });
          return consumer;
        }),
      },
    })),
    publish: vi.fn(() => {}),
  };

  const conn = {
    subs,
    messages,
    added,
    infoCalls,
    deleted,
    gets,
    jsm,
    raw,
    publish: vi.fn(() => {}),
    request: vi.fn(async (_subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      return {
        data: encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: registryKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload: { status: "registered" },
            }),
            registryKp,
          ),
        ),
      };
    }),
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
      subs.set(subject, cb);
      return { unsubscribe: () => subs.delete(subject), drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    get isClosed() {
      return false;
    },
  };
  return conn;
}
type Conn = ReturnType<typeof makeConn>;

function agentOn(conn: Conn) {
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
    { fenceInbound: false },
  );
  openAgents.push(agent);
  return agent;
}

function eventEnvelope(senderKp: KeyPair, data: unknown, tsOffsetMs = 0): Envelope {
  const env = createEnvelope({
    type: "emit",
    from: senderKp.getPublicKey(),
    payload: { domain: "billing", event_type: "invoice_ready", data },
  });
  if (tsOffsetMs !== 0) env.ts = new Date(Date.now() + tsOffsetMs).toISOString();
  return signEnvelope(env, senderKp);
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("§18.6 durable name: the cross-SDK derivation fixture", () => {
  it(`derives mesh_event_{agent_id}_${FIXTURE_HASH} for "${PATTERN}"`, async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const sub = await agent.subscribe(PATTERN, () => {}, { durable: "billing" });
    expect(sub.durable).toBe(`mesh_event_${agent.id}_${FIXTURE_HASH}`);
    // The same name is what was bound on the stream, info-then-add then get.
    expect(conn.infoCalls).toEqual([{ stream: "MESH_EVENTS", durable: sub.durable }]);
    expect(conn.gets).toEqual([{ stream: "MESH_EVENTS", durable: sub.durable }]);
    await sub.stop();
  });
});

describe("§18.6 consumer config", () => {
  it("creates the consumer with the pinned config: Explicit acks, New delivery, 30s ack_wait, 5 deliveries, filtered to the pattern", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const sub = await agent.subscribe(PATTERN, () => {}, { durable: "billing" });
    expect(conn.added).toHaveLength(1);
    expect(conn.added[0].stream).toBe("MESH_EVENTS");
    expect(conn.added[0].config).toEqual({
      durable_name: `mesh_event_${agent.id}_${FIXTURE_HASH}`,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.New,
      ack_wait: 30_000_000_000,
      max_deliver: 5,
      filter_subject: Subjects.event(PATTERN),
    });
    await sub.stop();
  });

  it("replay: true creates with DeliverPolicy.All", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const sub = await agent.subscribe(PATTERN, () => {}, { durable: "billing", replay: true });
    expect(conn.added[0].config.deliver_policy).toBe(DeliverPolicy.All);
    await sub.stop();
  });

  it("an existing durable is bound as-is: no add, cursor preserved", async () => {
    const conn = makeConn({ consumerExists: true });
    const agent = agentOn(conn);
    const sub = await agent.subscribe(PATTERN, () => {}, { durable: "billing", replay: true });
    expect(conn.added).toEqual([]);
    await sub.stop();
  });
});

describe("the durable dispatch loop", () => {
  it("acks AFTER the handler returns, and not when the handler throws", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const order: string[] = [];
    let throwNext = false;
    const sub = await agent.subscribe(
      PATTERN,
      () => {
        order.push("handler");
        if (throwNext) throw new Error("handler broke");
      },
      { durable: "billing" },
    );

    const senderKp = nkeys.createUser();
    conn.messages.push({
      data: encode(eventEnvelope(senderKp, { n: 1 })),
      subject: Subjects.event(PATTERN),
      ack: () => order.push("ack"),
    });
    await settle();
    // The ack is the "durably handled" signal, so it follows the handler.
    expect(order).toEqual(["handler", "ack"]);

    throwNext = true;
    let ackedFailed = false;
    conn.messages.push({
      data: encode(eventEnvelope(senderKp, { n: 2 })),
      subject: Subjects.event(PATTERN),
      ack: () => {
        ackedFailed = true;
      },
    });
    await settle();
    // No ack: ack_wait redelivers, up to max_deliver.
    expect(order).toEqual(["handler", "ack", "handler"]);
    expect(ackedFailed).toBe(false);
    await sub.stop();
  });

  it("acks undecodable bytes without dispatching them", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const seen: unknown[] = [];
    const sub = await agent.subscribe(PATTERN, (p) => seen.push(p), { durable: "billing" });
    let acked = false;
    conn.messages.push({
      data: new Uint8Array([1, 2, 3]),
      subject: Subjects.event(PATTERN),
      ack: () => {
        acked = true;
      },
    });
    await settle();
    expect(seen).toEqual([]);
    expect(acked).toBe(true); // drop, don't loop
    await sub.stop();
  });

  it("accepts an hours-old replayed event under the BUFFERED window that the live path refuses", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const senderKp = nkeys.createUser();
    // Five hours old: far outside the 10-minute live window, well inside the
    // buffered one. Replay exists to deliver exactly this.
    const old = eventEnvelope(senderKp, { n: "replayed" }, -5 * 3_600_000);

    // The live (ephemeral) path refuses it outright.
    const liveSeen: unknown[] = [];
    agent.subscribe(PATTERN, (p) => liveSeen.push(p));
    conn.subs.get(Subjects.event(PATTERN))!({
      subject: Subjects.event(PATTERN),
      data: encode(old),
    });
    await settle();
    expect(liveSeen).toEqual([]);

    // The durable path dispatches it. A DIFFERENT sender's copy, because the
    // two paths share the §22.2 event memory and the live refusal above
    // already remembered the first (from, id).
    const freshSender = nkeys.createUser();
    const durableSeen: unknown[] = [];
    const sub = await agent.subscribe(PATTERN, (p) => durableSeen.push(p), { durable: "billing" });
    conn.messages.push({
      data: encode(eventEnvelope(freshSender, { n: "replayed" }, -5 * 3_600_000)),
      subject: Subjects.event(PATTERN),
      ack: () => {},
    });
    await settle();
    expect(durableSeen).toHaveLength(1);
    expect((durableSeen[0] as { data: unknown }).data).toEqual({ n: "replayed" });
    await sub.stop();
  });

  it("shares the §22.2 event memory with the ephemeral path: a copy either path saw is refused, then acked", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const senderKp = nkeys.createUser();
    const env = eventEnvelope(senderKp, { n: 1 });

    const liveSeen: unknown[] = [];
    agent.subscribe(PATTERN, (p) => liveSeen.push(p));
    conn.subs.get(Subjects.event(PATTERN))!({
      subject: Subjects.event(PATTERN),
      data: encode(env),
    });
    await settle();
    expect(liveSeen).toHaveLength(1);

    const durableSeen: unknown[] = [];
    const sub = await agent.subscribe(PATTERN, (p) => durableSeen.push(p), { durable: "billing" });
    let acked = false;
    conn.messages.push({
      data: encode(env),
      subject: Subjects.event(PATTERN),
      ack: () => {
        acked = true;
      },
    });
    await settle();
    // Refused as a duplicate, which is complete handling: acked, not redelivered.
    expect(durableSeen).toEqual([]);
    expect(acked).toBe(true);
    await sub.stop();
  });

  it("scopes the §22.2 event memory per subscription: deliberately overlapping patterns each deliver, a repeat on one is refused", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const senderKp = nkeys.createUser();
    const env = eventEnvelope(senderKp, { n: 1 });

    // An agent overlapping an exact pattern with a wildcard registered two
    // handlers on purpose; the broker delivers one publish to both
    // subscriptions, and §22.2 must not starve the second (the c01 regression).
    const exact: unknown[] = [];
    const wild: unknown[] = [];
    agent.subscribe(PATTERN, (p) => exact.push(p));
    agent.subscribe("billing.*", (p) => wild.push(p));
    const delivery = { subject: Subjects.event(PATTERN), data: encode(env) };
    conn.subs.get(Subjects.event(PATTERN))!(delivery);
    conn.subs.get(Subjects.event("billing.*"))!(delivery);
    await settle();
    expect(exact).toHaveLength(1);
    expect(wild).toHaveLength(1);

    // The scope is the subscription, not the agent: the SAME subscription
    // seeing the same envelope again is still refused.
    conn.subs.get(Subjects.event(PATTERN))!(delivery);
    await settle();
    expect(exact).toHaveLength(1);
  });
});

describe("failure and teardown", () => {
  it("throws loudly when JetStream is unavailable, naming MESH_EVENTS and the sandbox-credential cause", async () => {
    const conn = makeConn({ jetstreamBroken: true });
    const agent = agentOn(conn);
    let thrown: MeshError | undefined;
    try {
      await agent.subscribe(PATTERN, () => {}, { durable: "billing" });
    } catch (err) {
      thrown = err as MeshError;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.code).toBe(ErrorCode.DEPENDENCY_FAILED);
    expect(thrown!.message).toContain("MESH_EVENTS");
    expect(thrown!.message).toContain("sandbox");
  });

  it("without opts the ephemeral path is untouched: a plain transport subscription comes back synchronously", () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const sub = agent.subscribe(PATTERN, () => {});
    expect(typeof (sub as { unsubscribe?: unknown }).unsubscribe).toBe("function");
    expect((sub as { then?: unknown }).then).toBeUndefined(); // not a promise
    expect(conn.raw.jetstreamManager).not.toHaveBeenCalled();
  });

  it("stop() ends the iterator and NEVER deletes the durable (the consumer is the cursor)", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const sub: DurableEventSubscription = await agent.subscribe(PATTERN, () => {}, {
      durable: "billing",
    });
    await sub.stop();
    expect(conn.messages.stopCalls).toBeGreaterThan(0);
    expect(conn.deleted).toEqual([]);
    expect(conn.jsm.consumers.delete).not.toHaveBeenCalled();
  });

  it("close() stops the durable loop without deleting the consumer", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    await agent.subscribe(PATTERN, () => {}, { durable: "billing" });
    await agent.close();
    expect(conn.messages.stopCalls).toBeGreaterThan(0);
    expect(conn.deleted).toEqual([]);
  });
});
