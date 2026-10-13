// §7.0 deferral (HandlerOptions.deferAfterMs + awaitTask): a live dispatch
// whose handler outlives the threshold answers the live wait with a
// non-terminal `working` respond carrying the dispatch task id, and its
// terminal statement — completed with the output, or failed — travels
// `mesh.task.{id}.update`, where `awaitTask` finds it. A handler inside the
// threshold stays bare, exactly as before the option existed.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { RespondPayload } from "../../src/types/primitives.js";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

function makeConn() {
  const subs = new Map<string, (msg: unknown) => void>();
  const registryKp = nkeys.createUser();
  const published: { subject: string; data: Uint8Array }[] = [];
  return {
    subs,
    published,
    publish: vi.fn((subject: string, data: Uint8Array) => {
      published.push({ subject, data });
      subs.get(subject)?.({ subject, data, reply: undefined, respond: () => true });
    }),
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
    raw: { publish: () => {} },
    get isClosed() {
      return false;
    },
  };
}
type Conn = ReturnType<typeof makeConn>;

async function makeAgent(opts: {
  conn?: Conn;
  offering?: string;
  deferAfterMs?: number;
  handler?: (input: unknown) => unknown;
}) {
  const conn = opts.conn ?? makeConn();
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
    {},
  );
  openAgents.push(agent);
  if (opts.handler) {
    agent.onRequest(
      opts.offering ?? "chat",
      (input) => opts.handler!(input),
      opts.deferAfterMs !== undefined ? { deferAfterMs: opts.deferAfterMs } : undefined,
    );
  }
  await agent.register({ name: "deferral" });
  return { conn, agent };
}

/** Deliver a signed live request; return the sender-inbox replies array. */
function deliver(conn: Conn, agentId: string, senderKp: KeyPair, payload: unknown): Uint8Array[] {
  const env = createEnvelope({
    type: "request",
    from: senderKp.getPublicKey(),
    to: agentId,
    payload,
  });
  const signed = signEnvelope(env, senderKp);
  const replies: Uint8Array[] = [];
  const cb = conn.subs.get(Subjects.agentInbox(agentId));
  if (!cb) throw new Error("agent is not listening on its inbox");
  conn.subs.set(Subjects.agentInbox(senderKp.getPublicKey()), (m) => {
    replies.push((m as { data: Uint8Array }).data);
  });
  cb({
    subject: Subjects.agentInbox(agentId),
    data: encode(signed),
    reply: "_INBOX.deferral",
    respond: () => true,
  });
  return replies;
}

const decoded = (replies: Uint8Array[]) => replies.map((d) => decode(d));
const statusOf = (e: Envelope) => (e.payload as RespondPayload | undefined)?.status;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("§7.0 deferral", () => {
  it("a slow handler defers: `working` on the live wait, the completion on the task update channel", async () => {
    const { conn, agent } = await makeAgent({
      deferAfterMs: 30,
      handler: async () => {
        await sleep(120);
        return { slow: "answer" };
      },
    });
    const replies = deliver(conn, agent.id, nkeys.createUser(), {
      offering: "chat",
      input: "take your time",
    });

    // The live wait gets the accept, then the non-terminal working respond
    // carrying the task id — and nothing terminal.
    await vi.waitFor(() => {
      expect(decoded(replies).some((e) => statusOf(e) === "working")).toBe(true);
    });
    const working = decoded(replies).find((e) => statusOf(e) === "working")!;
    const taskId = working.task_id;
    expect(taskId).toBeTruthy();
    expect(decoded(replies).every((e) => statusOf(e) !== "completed")).toBe(true);

    // The terminal statement arrives on `mesh.task.{id}.update`, signed, with
    // the output — and a copy on the outbox tap like every other respond.
    await vi.waitFor(() => {
      expect(
        conn.published.some((p) => p.subject === Subjects.taskUpdate(taskId!)),
      ).toBe(true);
    });
    const update = decode(
      conn.published.find((p) => p.subject === Subjects.taskUpdate(taskId!))!.data,
    );
    expect(statusOf(update)).toBe("completed");
    expect((update.payload as RespondPayload).output).toEqual({ slow: "answer" });
    expect(update.task_id).toBe(taskId);
    expect(
      conn.published.filter((p) => p.subject === Subjects.agentOutbox(agent.id)).length,
    ).toBeGreaterThanOrEqual(2); // the working respond and the terminal update, at least
  });

  it("awaitTask resolves with the deferred completion payload", async () => {
    const { conn, agent } = await makeAgent({
      deferAfterMs: 30,
      handler: async () => {
        await sleep(100);
        return { answer: 42 };
      },
    });
    const watcher = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
      {},
    );
    openAgents.push(watcher);

    const replies = deliver(conn, agent.id, nkeys.createUser(), {
      offering: "chat",
      input: "hi",
    });
    await vi.waitFor(() => {
      expect(decoded(replies).some((e) => statusOf(e) === "working")).toBe(true);
    });
    const taskId = decoded(replies).find((e) => statusOf(e) === "working")!.task_id!;

    const terminal = await watcher.awaitTask(taskId, 5_000);
    expect(terminal.status).toBe("completed");
    expect(terminal.output).toEqual({ answer: 42 });
  });

  it("a failing slow handler defers, then fails on the task update channel", async () => {
    const { conn, agent } = await makeAgent({
      deferAfterMs: 30,
      handler: async () => {
        await sleep(100);
        throw new Error("the model fell over");
      },
    });
    const replies = deliver(conn, agent.id, nkeys.createUser(), {
      offering: "chat",
      input: "hi",
    });
    await vi.waitFor(() => {
      expect(decoded(replies).some((e) => statusOf(e) === "working")).toBe(true);
    });
    const taskId = decoded(replies).find((e) => statusOf(e) === "working")!.task_id!;

    await vi.waitFor(() => {
      expect(conn.published.some((p) => p.subject === Subjects.taskUpdate(taskId))).toBe(true);
    });
    const update = decode(conn.published.find((p) => p.subject === Subjects.taskUpdate(taskId))!.data);
    expect(statusOf(update)).toBe("failed");
    expect(update.error?.message).toContain("the model fell over");
  });

  it("a fast handler inside the threshold stays bare — no task, no update traffic", async () => {
    const { conn, agent } = await makeAgent({
      deferAfterMs: 200,
      handler: (input) => ({ echoed: input }),
    });
    const replies = deliver(conn, agent.id, nkeys.createUser(), {
      offering: "chat",
      input: "quick",
    });
    await vi.waitFor(() => {
      expect(decoded(replies).some((e) => statusOf(e) === "completed")).toBe(true);
    });
    const terminal = decoded(replies).find((e) => statusOf(e) === "completed")!;
    expect(terminal.task_id ?? null).toBeNull();
    expect(decoded(replies).some((e) => statusOf(e) === "working")).toBe(false);
    expect(conn.published.some((p) => p.subject.startsWith("mesh.task."))).toBe(false);
  });
});
