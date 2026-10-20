// Every Task the SDK drives must reach the task manager as a LEGAL sequence of
// states (SPEC.md §7.3). The task manager creates the record from the first
// update it sees on `mesh.task.{id}.update` and refuses any later update whose
// transition VALID_TRANSITIONS does not list (server/src/task-manager/
// handlers/task-update.ts imports this same table), so an SDK path that
// skips a state leaves the record stuck where it was.
//
// Each test drives one dispatch path through a real AgentMesh on a fake
// connection, collects what it published on the task's update subject, and
// replays it through the server's rules: the first update creates the record
// in any state, and every later one must be a listed transition.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { isValidTransition, type TaskState } from "../../src/types/task.js";
import { InputProblemsError } from "../../src/problems.js";
import { BudgetExhaustedError } from "../../src/budget.js";
import { RejectedError } from "../../src/types/errors.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { RespondPayload } from "../../src/types/primitives.js";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

/** The task manager's records, for `mesh.task.get.<id>`: a record the reader
 *  is a party to is answered, one it is not is UNAUTHORIZED, a missing one is
 *  TASK_NOT_FOUND (server/src/task-manager/handlers/task-get.ts). */
type Records = Map<string, { requester: string; responder: string; state: TaskState }>;

function makeConn(records?: Records) {
  const subs = new Map<string, (msg: unknown) => void>();
  const registryKp = nkeys.createUser();
  const published: { subject: string; data: Uint8Array }[] = [];
  const taskGets: string[] = [];
  return {
    subs,
    published,
    taskGets,
    publish: vi.fn((subject: string, data: Uint8Array) => {
      published.push({ subject, data });
      subs.get(subject)?.({ subject, data, reply: undefined, respond: () => true });
    }),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      if (records && subject.startsWith("mesh.task.get.")) {
        const id = subject.slice("mesh.task.get.".length);
        taskGets.push(id);
        const record = records.get(id);
        const answer = !record
          ? { error: { code: "TASK_NOT_FOUND", message: `Task ${id} not found`, retryable: false } }
          : record.requester !== req.from && record.responder !== req.from
            ? { error: { code: "UNAUTHORIZED", message: "not a party", retryable: false } }
            : { payload: { id, ...record } };
        return {
          data: encode(
            signEnvelope(createEnvelope({ type: "respond", from: registryKp.getPublicKey(), to: req.from, in_reply_to: req.id, ...answer }), registryKp),
          ),
        };
      }
      return {
        data: encode(
          signEnvelope(
            createEnvelope({ type: "respond", from: registryKp.getPublicKey(), to: req.from, in_reply_to: req.id, payload: { status: "registered" } }),
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
    raw: { publish: () => {}, subscribe: () => ({ unsubscribe: () => {} }) },
    get isClosed() {
      return false;
    },
  };
}
type Conn = ReturnType<typeof makeConn>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const problem = { input: "file", problem: "missing" as const, description: "attach the file" };

/** A responder whose handler does whatever `behave` says for each call. */
async function responder(
  behave: (input: { step?: string }) => unknown,
  deferAfterMs?: number,
  opts: { records?: Records; interaction?: "service" | "interactive" } = {},
) {
  const conn = makeConn(opts.records);
  const agent = AgentMesh.withConnection(conn as unknown as ConnectionManager, nkeys.createUser(), nkeys.createUser(), {});
  openAgents.push(agent);
  agent.onRequest("work", (input) => behave(input as { step?: string }), deferAfterMs !== undefined ? { deferAfterMs } : undefined);
  agent.onStreamRequest("stream", async (input, _ctx, writer) => {
    const step = (input as { step?: string }).step;
    if (step === "throw") throw new Error("the stream broke");
    writer.write("a");
    writer.end("done");
  });
  await agent.register({ name: "transitions", ...(opts.interaction ? { interaction: opts.interaction } : {}) });
  return { conn, agent };
}

/** Deliver one signed live request; returns its envelope. */
function deliver(conn: Conn, agentId: string, kp: KeyPair, payload: unknown, taskId?: string): Envelope {
  const env = signEnvelope(
    createEnvelope({ type: "request", from: kp.getPublicKey(), to: agentId, ...(taskId ? { task_id: taskId } : {}), payload }),
    kp,
  );
  conn.subs.set(Subjects.agentInbox(kp.getPublicKey()), () => {});
  conn.subs.get(Subjects.agentInbox(agentId))!({ subject: Subjects.agentInbox(agentId), data: encode(env), reply: "_INBOX.t", respond: () => true });
  return env;
}

/** Everything published on the task's update subject, in order. */
const updates = (conn: Conn, taskId: string): Envelope[] =>
  conn.published.filter((p) => p.subject === Subjects.taskUpdate(taskId)).map((p) => decode(p.data));
const statuses = (envs: Envelope[]) => envs.map((e) => (e.payload as RespondPayload | undefined)?.status).filter(Boolean) as TaskState[];

/** The task manager's rules: create in any state, then only listed transitions. */
function replay(states: TaskState[], from: TaskState | null = null): { state: TaskState | null; refused: string[] } {
  let state = from;
  const refused: string[] = [];
  for (const s of states) {
    if (state === null) state = s;
    else if (isValidTransition(state, s)) state = s;
    else refused.push(`${state} → ${s}`);
  }
  return { state, refused };
}

/** The task id a dispatch ran under: off the first reply naming one. */
const taskIdOf = (conn: Conn, requester: string): string | undefined => {
  for (const p of conn.published) {
    if (p.subject !== Subjects.agentInbox(requester)) continue;
    const e = decode(p.data);
    if (e.task_id) return e.task_id;
  }
  return undefined;
};

async function run(behave: (input: { step?: string }) => unknown, deferAfterMs?: number) {
  const { conn, agent } = await responder(behave, deferAfterMs);
  const kp = nkeys.createUser();
  return { conn, agent, kp, buyer: kp.getPublicKey() };
}

describe("fresh dispatches reach the record legally", () => {
  const cases: { name: string; defer?: number; behave: () => unknown; end: TaskState }[] = [
    { name: "a deferred completion", defer: 20, behave: async () => { await sleep(60); return { ok: true }; }, end: "completed" },
    { name: "a deferred failure", defer: 20, behave: async () => { await sleep(60); throw new Error("x"); }, end: "failed" },
    { name: "a deferred input-problems pause", defer: 20, behave: async () => { await sleep(60); throw new InputProblemsError(problem); }, end: "input_required" },
    { name: "a deferred budget pause", defer: 20, behave: async () => { await sleep(60); throw new BudgetExhaustedError({ message: "ceiling" }); }, end: "input_required" },
    { name: "a deferred rejection", defer: 20, behave: async () => { await sleep(60); throw new RejectedError("no"); }, end: "failed" },
    { name: "a synchronous input-problems pause", behave: () => { throw new InputProblemsError(problem); }, end: "input_required" },
    { name: "a synchronous budget pause", behave: () => { throw new BudgetExhaustedError({ message: "ceiling" }); }, end: "input_required" },
  ];
  for (const c of cases) {
    it(`${c.name}: ends ${c.end} on the record`, async () => {
      const { conn, agent, kp, buyer } = await run(c.behave, c.defer);
      deliver(conn, agent.agentId, kp, { offering: "work", input: {} });
      await sleep(400);
      const T = taskIdOf(conn, buyer)!;
      expect(T).toBeTruthy();
      const r = replay(statuses(updates(conn, T)));
      expect(r.refused).toEqual([]);
      expect(r.state).toBe(c.end);
    });
  }

  it("a deferral records working before anything else", async () => {
    const { conn, agent, kp, buyer } = await run(async () => { await sleep(60); return 1; }, 20);
    deliver(conn, agent.agentId, kp, { offering: "work", input: {} });
    await sleep(400);
    expect(statuses(updates(conn, taskIdOf(conn, buyer)!))).toEqual(["working", "completed"]);
  });

  it("a synchronous bare answer creates no record", async () => {
    const { conn, agent, kp } = await run(() => ({ ok: true }));
    deliver(conn, agent.agentId, kp, { offering: "work", input: {} });
    await sleep(200);
    expect(conn.published.some((p) => p.subject.startsWith("mesh.task.") && p.subject.endsWith(".update"))).toBe(false);
  });

  for (const step of ["end", "throw"]) {
    it(`a stream that ${step === "end" ? "ends" : "throws"}: legal on the record`, async () => {
      const { conn, agent, kp } = await run(() => 1);
      const T = "stream-task-" + step;
      deliver(conn, agent.agentId, kp, { offering: "stream", input: { step }, config: { stream: true } }, T);
      await sleep(200);
      const r = replay(statuses(updates(conn, T)));
      expect(r.refused).toEqual([]);
      expect(r.state).toBe(step === "end" ? "completed" : "failed");
    });
  }
});

describe("a resume after a synchronous pause reaches the record legally", () => {
  // The first call pauses for a file; the resume (a request naming the Task)
  // does what `then` says.
  const cases: { name: string; defer?: number; then: () => unknown; end: TaskState }[] = [
    { name: "completes", then: () => ({ ok: true }), end: "completed" },
    { name: "fails", then: () => { throw new Error("x"); }, end: "failed" },
    { name: "defers, then fails", defer: 20, then: async () => { await sleep(60); throw new Error("x"); }, end: "failed" },
    { name: "defers, then completes", defer: 20, then: async () => { await sleep(60); return 1; }, end: "completed" },
    { name: "is declined", then: () => { throw new RejectedError("no"); }, end: "failed" },
    { name: "pauses for input again", then: () => { throw new InputProblemsError(problem); }, end: "input_required" },
    { name: "pauses on the budget", then: () => { throw new BudgetExhaustedError({ message: "ceiling" }); }, end: "input_required" },
  ];
  for (const c of cases) {
    it(`the resume ${c.name}: input_required → working → ${c.end}`, async () => {
      let calls = 0;
      const { conn, agent, kp, buyer } = await run(() => {
        if (calls++ === 0) throw new InputProblemsError(problem);
        return c.then();
      }, c.defer);
      deliver(conn, agent.agentId, kp, { offering: "work", input: {} });
      await vi.waitFor(() => expect(taskIdOf(conn, buyer)).toBeTruthy());
      const T = taskIdOf(conn, buyer)!;
      expect(replay(statuses(updates(conn, T))).state).toBe("input_required");
      deliver(conn, agent.agentId, kp, { offering: "work", input: { step: "resume" } }, T);
      await sleep(400);
      const all = statuses(updates(conn, T));
      const r = replay(all);
      expect(r.refused).toEqual([]);
      expect(r.state).toBe(c.end);
      expect(all.slice(1, 2)).toEqual(["working"]);
    });
  }
});

/** What this responder sent to `who`'s inbox, decoded, in order. */
const repliesTo = (conn: Conn, who: string): Envelope[] =>
  conn.published.filter((p) => p.subject === Subjects.agentInbox(who)).map((p) => decode(p.data));
/** Anything published about any Task, or any metering event. */
const taskTraffic = (conn: Conn) =>
  conn.published.filter((p) => p.subject.startsWith("mesh.task.") || p.subject.startsWith("mesh.event.metering"));

/** A responder that pauses the first call for a file, then does `then`. */
async function pausing(then: () => unknown, deferAfterMs?: number, opts: Parameters<typeof responder>[2] = {}) {
  const calls: { step?: string }[] = [];
  const { conn, agent } = await responder((input) => {
    calls.push(input);
    if (calls.length === 1) throw new InputProblemsError(problem);
    return then();
  }, deferAfterMs, opts);
  const buyerKp = nkeys.createUser();
  return { conn, agent, calls, buyerKp, buyer: buyerKp.getPublicKey() };
}

describe("only the Task's own requester resumes it", () => {
  // Task ids are public (mesh.event.task.*). A third party that names a
  // buyer's paused Task must not drive it: the task manager would take it,
  // because the responder is a party to that Task.
  const cases: { name: string; offering: string; defer?: number; then: () => unknown; config?: unknown }[] = [
    { name: "answers at once", offering: "work", then: () => ({ theirs: true }) },
    { name: "fails at once", offering: "work", then: () => { throw new Error("x"); } },
    { name: "defers, then completes (the deferred path)", offering: "work", defer: 20, then: async () => { await sleep(60); return 1; } },
    { name: "defers, then fails (the deferred path)", offering: "work", defer: 20, then: async () => { await sleep(60); throw new Error("x"); } },
    { name: "is a stream", offering: "stream", then: () => 1, config: { stream: true } },
  ];
  for (const c of cases) {
    it(`a third party naming a paused Task, whose request ${c.name}, is refused and the Task is untouched`, async () => {
      const { conn, agent, calls, buyerKp, buyer } = await pausing(c.then, c.defer);
      deliver(conn, agent.agentId, buyerKp, { offering: "work", input: {} });
      await vi.waitFor(() => expect(taskIdOf(conn, buyer)).toBeTruthy());
      const T = taskIdOf(conn, buyer)!;
      expect(statuses(updates(conn, T))).toEqual(["input_required"]);

      const strangerKp = nkeys.createUser();
      const stranger = strangerKp.getPublicKey();
      deliver(conn, agent.agentId, strangerKp, { offering: c.offering, input: { step: "end" }, ...(c.config ? { config: c.config } : {}) }, T);
      await sleep(400);
      expect(statuses(updates(conn, T))).toEqual(["input_required"]);
      expect(conn.published.some((p) => p.subject === Subjects.taskStream(T))).toBe(false);
      expect(calls.length).toBe(1);
      const refusal = repliesTo(conn, stranger).find((e) => e.error);
      expect(refusal?.error?.code).toBe("UNAUTHORIZED");
      expect(refusal?.error?.message).toContain(T);

      // The buyer still resumes its own Task.
      deliver(conn, agent.agentId, buyerKp, { offering: "work", input: { step: "resume" } }, T);
      await sleep(400);
      expect(statuses(updates(conn, T)).slice(0, 2)).toEqual(["input_required", "working"]);
      expect(replay(statuses(updates(conn, T))).refused).toEqual([]);
    });
  }

  it("after a restart (nothing remembered), the record decides: its requester resumes, a stranger is refused", async () => {
    const records: Records = new Map();
    const { conn, agent } = await responder(() => ({ ok: true }), undefined, { records });
    const buyerKp = nkeys.createUser();
    const buyer = buyerKp.getPublicKey();
    const T = "paused-before-restart";
    records.set(T, { requester: buyer, responder: agent.agentId, state: "input_required" });

    const strangerKp = nkeys.createUser();
    deliver(conn, agent.agentId, strangerKp, { offering: "work", input: {} }, T);
    await sleep(200);
    expect(updates(conn, T)).toEqual([]);
    expect(repliesTo(conn, strangerKp.getPublicKey()).find((e) => e.error)?.error?.code).toBe("UNAUTHORIZED");
    expect(conn.taskGets).toContain(T);

    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: {} }, T);
    await sleep(200);
    expect(statuses(updates(conn, T))).toEqual(["working", "completed"]);
    expect(replay(statuses(updates(conn, T)), "input_required").refused).toEqual([]);
  });

  it("a record naming another responder is not this agent's to resume, even for its requester", async () => {
    const records: Records = new Map();
    const { conn, agent } = await responder(() => ({ ok: true }), 20, { records });
    const buyerKp = nkeys.createUser();
    const T = "someone-elses-task";
    // The buyer is the requester; the responder is another agent. Reading it
    // answers (the reader is a party); resuming it here would be wrong.
    records.set(T, { requester: buyerKp.getPublicKey(), responder: nkeys.createUser().getPublicKey(), state: "input_required" });
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: {} }, T);
    await sleep(200);
    expect(updates(conn, T)).toEqual([]);
    expect(repliesTo(conn, buyerKp.getPublicKey()).find((e) => e.error)?.error?.code).toBe("UNAUTHORIZED");
  });
});

describe("a requestStream that falls through to a plain handler", () => {
  // requestStream sends a requester-made task_id. With no stream handler for
  // the offering, the plain handler answers, and a synchronous answer is a
  // bare reply (§6.4): no Task, so no record, no §19.2 receipt, no meter events.
  for (const withRecords of [false, true]) {
    it(`answered synchronously creates no record, no receipt and no meter events${withRecords ? " (the record read finds none)" : ""}`, async () => {
      const { conn, agent } = await responder(() => ({ ok: true }), undefined, withRecords ? { records: new Map() } : {});
      const kp = nkeys.createUser();
      const T = "requester-made-stream-id";
      deliver(conn, agent.agentId, kp, { offering: "work", input: {}, config: { stream: true } }, T);
      await sleep(200);
      expect(taskTraffic(conn)).toEqual([]);
      const answer = repliesTo(conn, kp.getPublicKey()).find((e) => (e.payload as RespondPayload | undefined)?.status === "completed");
      expect(answer).toBeDefined();
      expect(answer!.task_id).toBeUndefined();
    });
  }

  it("deferred, it records on the requester's own id, which is nobody else's Task", async () => {
    const { conn, agent } = await responder(async () => { await sleep(60); return 1; }, 20, { records: new Map() });
    const kp = nkeys.createUser();
    const T = "requester-made-deferred";
    deliver(conn, agent.agentId, kp, { offering: "work", input: {}, config: { stream: true } }, T);
    await vi.waitFor(() => expect(statuses(updates(conn, T))).toEqual(["working", "completed"]), { timeout: 2000 });
  });
});

describe("a pause creates its record before the inbox reply", () => {
  const cases: { name: string; behave: () => unknown }[] = [
    { name: "an input-problems pause", behave: () => { throw new InputProblemsError(problem); } },
    { name: "a budget pause", behave: () => { throw new BudgetExhaustedError({ message: "ceiling" }); } },
  ];
  for (const c of cases) {
    it(`${c.name}: the input_required record, then the reply`, async () => {
      const { conn, agent, kp, buyer } = await run(c.behave);
      deliver(conn, agent.agentId, kp, { offering: "work", input: {} });
      await sleep(200);
      const T = taskIdOf(conn, buyer)!;
      const at = (pred: (p: { subject: string; data: Uint8Array }) => boolean) => conn.published.findIndex(pred);
      const record = at((p) => p.subject === Subjects.taskUpdate(T));
      const reply = at((p) => p.subject === Subjects.agentInbox(buyer) && (decode(p.data).payload as RespondPayload | undefined)?.status === "input_required");
      expect(record).toBeGreaterThanOrEqual(0);
      expect(reply).toBeGreaterThanOrEqual(0);
      expect(record).toBeLessThan(reply);
    });
  }
});

describe("an interactive agent that answers a resume with a queued ack", () => {
  it("records working and no completion until the real answer", async () => {
    const { conn, agent, buyerKp, buyer } = await pausing(
      () => ({ queued: true, inbox_id: "0198c001-0000-7000-8000-0000000000ff" }),
      undefined,
      { interaction: "interactive" },
    );
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: {} });
    await vi.waitFor(() => expect(taskIdOf(conn, buyer)).toBeTruthy());
    const T = taskIdOf(conn, buyer)!;
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: { step: "resume" } }, T);
    await sleep(200);
    expect(statuses(updates(conn, T))).toEqual(["input_required", "working"]);
  });
});
