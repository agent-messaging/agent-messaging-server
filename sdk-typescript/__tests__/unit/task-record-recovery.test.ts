// A deferred task's terminal answer is never lost to a late subscription.
//
// The requester learns a deferred task's id from the responder's `working`
// answer, so it can only subscribe to the task's updates afterwards. On
// RabbitMQ that subscription is live a few round trips later, and a terminal
// update published in between used to vanish (awaitTask timed out). Now the
// request path waits until the subscription is live before it returns
// `working`, and the task manager's durable record (§7.4) is read for any
// statement published before that, by the watch and by awaitTask.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import type { Envelope } from "../../src/types/envelope.js";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Rec = { requester: string; responder: string; history: Envelope[] };

/** A connection that delivers in-process, answers registry calls, answers
 *  `mesh.task.get.<id>` from `records`, and counts flushes. `liveUpdates:
 *  false` drops every publish on a task's update subject, as a binding that
 *  is not there yet would. */
function makeConn(opts: { liveUpdates?: boolean; flushDelayMs?: number } = {}) {
  let onInboxRequest: (req: Envelope) => Envelope[] = () => [];
  let flushedAt = 0;
  const subs = new Map<string, Set<(msg: unknown) => void>>();
  const service = nkeys.createUser();
  const records = new Map<string, Rec>();
  const published: { subject: string; data: Uint8Array }[] = [];
  let flushes = 0;
  const answer = (req: Envelope, payload: unknown, error?: { code: string; message: string }) => ({
    data: encode(
      signEnvelope(
        createEnvelope({
          type: "respond",
          from: service.getPublicKey(),
          to: req.from,
          in_reply_to: req.id,
          ...(error ? { error: { ...error, retryable: false } } : { payload }),
        }),
        service,
      ),
    ),
  });
  return {
    subs,
    records,
    published,
    get flushes() {
      return flushes;
    },
    get flushedAt() {
      return flushedAt;
    },
    answerInbox(fn: (req: Envelope) => Envelope[]) {
      onInboxRequest = fn;
    },
    publish: vi.fn((subject: string, data: Uint8Array) => {
      published.push({ subject, data });
      if (opts.liveUpdates === false && /^mesh\.task\.[^.]+\.update$/.test(subject)) return;
      for (const cb of subs.get(subject) ?? []) cb({ subject, data, reply: undefined, respond: () => true });
    }),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      if (subject.endsWith(".inbox")) {
        // The responder answers on the requester's inbox (§6.4); the liveness
        // wait on the reply subject stays open, as on a real broker.
        for (const env of onInboxRequest(req)) {
          for (const cb of subs.get(Subjects.agentInbox(req.from)) ?? []) {
            cb({ subject: Subjects.agentInbox(req.from), data: encode(env), reply: undefined, respond: () => true });
          }
        }
        return await new Promise<never>(() => {});
      }
      const m = /^mesh\.task\.get\.(.+)$/.exec(subject);
      if (m) {
        const rec = records.get(m[1]!);
        return rec ? answer(req, rec) : answer(req, undefined, { code: "TASK_NOT_FOUND", message: "no such task" });
      }
      return answer(req, { status: "registered" });
    }),
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
      if (!subs.has(subject)) subs.set(subject, new Set());
      subs.get(subject)!.add(cb);
      return { unsubscribe: () => subs.get(subject)?.delete(cb), drain: async () => {} };
    }),
    flush: vi.fn(async () => {
      flushes++;
      if (opts.flushDelayMs) await sleep(opts.flushDelayMs);
      flushedAt = Date.now();
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    raw: { publish: () => {}, subscribe: () => ({ unsubscribe() {}, [Symbol.asyncIterator]: async function* () {} }) },
    get isClosed() {
      return false;
    },
  };
}
type Conn = ReturnType<typeof makeConn>;

function agentOn(conn: Conn, kp: KeyPair = nkeys.createUser()) {
  const a = AgentMesh.withConnection(conn as unknown as ConnectionManager, kp, nkeys.createUser(), {});
  openAgents.push(a);
  return a;
}

/** A responder's signed `working` answer to `req`, deferring into `taskId`. */
function working(responder: KeyPair, req: Envelope, taskId: string): Envelope {
  return signEnvelope(
    createEnvelope({
      type: "respond",
      from: responder.getPublicKey(),
      to: req.from,
      in_reply_to: req.id,
      task_id: taskId,
      payload: { status: "working" },
    }),
    responder,
  );
}

/** A responder's signed terminal statement for `taskId`. */
function terminal(responder: KeyPair, requester: string, taskId: string, output: unknown): Envelope {
  return signEnvelope(
    createEnvelope({
      type: "respond",
      from: responder.getPublicKey(),
      to: requester,
      task_id: taskId,
      payload: { status: "completed", output },
    }),
    responder,
  );
}

describe("deferred task: the terminal answer is never lost to a late subscription", () => {
  it("request() returns `working` only after the task's update subscription is live", async () => {
    const conn = makeConn({ flushDelayMs: 60 });
    const responder = nkeys.createUser();
    const taskId = "01a00000-0000-7000-8000-000000000010";
    conn.answerInbox((req) => [working(responder, req, taskId)]);
    const requester = agentOn(conn);
    await requester.register({ name: "requester" });

    const before = conn.flushes;
    const r = await requester.request(responder.getPublicKey(), "slow", { x: 1 }, { timeout_ms: 5_000 });
    const returnedAt = Date.now();
    expect(r.payload?.status).toBe("working");
    expect(r.task_id).toBe(taskId);
    // A flush was asked for, and had finished, before request() returned.
    expect(conn.flushes).toBeGreaterThan(before);
    expect(conn.flushedAt).toBeGreaterThan(0);
    expect(conn.flushedAt).toBeLessThanOrEqual(returnedAt);

    // The terminal update the responder publishes now arrives on the watch.
    conn.publish(Subjects.taskUpdate(taskId), encode(terminal(responder, requester.id, taskId, { done: true })));
    const done = await requester.awaitTask(taskId, 5_000);
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ done: true });
  });

  it("a terminal update that never arrived live is found in the task record", async () => {
    const conn = makeConn({ liveUpdates: false });
    const responder = nkeys.createUser();
    const taskId = "01a00000-0000-7000-8000-000000000011";
    conn.answerInbox((req) => [working(responder, req, taskId)]);
    const requester = agentOn(conn);
    await requester.register({ name: "requester" });

    const r = await requester.request(responder.getPublicKey(), "slow", {}, { timeout_ms: 5_000 });
    expect(r.task_id).toBe(taskId);
    // The responder finishes; the requester's subscription never sees it, but
    // the task manager recorded it.
    const end = terminal(responder, requester.id, taskId, { from: "the record" });
    conn.publish(Subjects.taskUpdate(taskId), encode(end));
    conn.records.set(taskId, { requester: requester.id, responder: responder.getPublicKey(), history: [end] });

    const done = await requester.awaitTask(taskId, 5_000);
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ from: "the record" });
    expect(requester.getTask(taskId)?.state).toBe("completed");
  });

  it("a requester that holds no local record of the task is answered from the task record", async () => {
    const conn = makeConn();
    const requester = agentOn(conn);
    await requester.register({ name: "requester" });
    const responder = nkeys.createUser();
    const taskId = "01a00000-0000-7000-8000-000000000001";
    conn.records.set(taskId, {
      requester: requester.id,
      responder: responder.getPublicKey(),
      history: [terminal(responder, requester.id, taskId, { restarted: "fine" })],
    });
    const done = await requester.awaitTask(taskId, 5_000);
    expect(done.output).toEqual({ restarted: "fine" });
  });

  it("a record statement that does not verify, or names another requester, is not taken", async () => {
    const conn = makeConn();
    const requester = agentOn(conn);
    await requester.register({ name: "requester" });
    const responder = nkeys.createUser();

    const forgedId = "01a00000-0000-7000-8000-000000000002";
    const forged = terminal(responder, requester.id, forgedId, { forged: true });
    (forged.payload as { output: unknown }).output = { altered: true };
    conn.records.set(forgedId, { requester: requester.id, responder: responder.getPublicKey(), history: [forged] });
    await expect(requester.awaitTask(forgedId, 400)).rejects.toThrow(/no terminal state/);

    const otherId = "01a00000-0000-7000-8000-000000000003";
    conn.records.set(otherId, {
      requester: nkeys.createUser().getPublicKey(),
      responder: responder.getPublicKey(),
      history: [terminal(responder, requester.id, otherId, { not: "yours" })],
    });
    await expect(requester.awaitTask(otherId, 400)).rejects.toThrow(/no terminal state/);
  });
});
