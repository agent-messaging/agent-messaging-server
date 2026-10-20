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
  /** Set to make the task manager unreachable: every record read times out. */
  const taskManager = { down: false };
  return {
    subs,
    published,
    taskGets,
    taskManager,
    publish: vi.fn((subject: string, data: Uint8Array) => {
      published.push({ subject, data });
      subs.get(subject)?.({ subject, data, reply: undefined, respond: () => true });
    }),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      if (records && subject.startsWith("mesh.task.get.")) {
        const id = subject.slice("mesh.task.get.".length);
        taskGets.push(id);
        if (taskManager.down) throw new Error("TIMEOUT");
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

/** A signed task.cancel for `taskId`, from `kp`. */
const cancelFrom = (conn: Conn, agentId: string, kp: KeyPair, taskId: string) =>
  deliver(conn, agentId, kp, { offering: "task.cancel", input: { task_id: taskId, reason: "user_requested" } });

describe("only a paused Task is resumable", () => {
  it("a requester naming its own deferred, still-working Task gets new work, not a second handler on that Task", async () => {
    let calls = 0;
    const { conn, agent, kp, buyer } = await run(async () => {
      calls++;
      await sleep(250);
      return { n: calls };
    }, 20);
    deliver(conn, agent.agentId, kp, { offering: "work", input: {} });
    await vi.waitFor(() => expect(taskIdOf(conn, buyer)).toBeTruthy());
    const T = taskIdOf(conn, buyer)!;
    deliver(conn, agent.agentId, kp, { offering: "work", input: { step: "again" } }, T);
    await sleep(700);
    // One working, one terminal, on T: the second request ran under its own id.
    const onT = statuses(updates(conn, T));
    expect(onT).toEqual(["working", "completed"]);
    expect(replay(onT).refused).toEqual([]);
    const ids = new Set(repliesTo(conn, buyer).map((e) => e.task_id).filter(Boolean));
    expect(ids.size).toBe(2);
  });
});

describe("a remembered pause is a hint", () => {
  it("is forgotten when its requester cancels the Task: a later request naming it is new work", async () => {
    const { conn, agent, buyerKp, buyer } = await pausing(() => ({ ok: true }));
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: {} });
    await vi.waitFor(() => expect(taskIdOf(conn, buyer)).toBeTruthy());
    const T = taskIdOf(conn, buyer)!;
    cancelFrom(conn, agent.agentId, buyerKp, T);
    await sleep(100);
    expect(repliesTo(conn, buyer).some((e) => (e.payload as RespondPayload | undefined)?.status === "canceled")).toBe(true);
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: { step: "resume" } }, T);
    await sleep(200);
    expect(statuses(updates(conn, T))).toEqual(["input_required"]);
  });

  it("an old one is checked against the record: a Task that ended elsewhere is not resumed", async () => {
    const records: Records = new Map();
    const { conn, agent, buyerKp, buyer } = await pausing(() => ({ ok: true }), undefined, { records });
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: {} });
    await vi.waitFor(() => expect(taskIdOf(conn, buyer)).toBeTruthy());
    const T = taskIdOf(conn, buyer)!;
    // The requester canceled through the task manager, which this agent did
    // not see; and the pause was remembered a minute ago.
    records.set(T, { requester: buyer, responder: agent.agentId, state: "canceled" });
    (agent as unknown as { resumableTasks: { get(id: string): { rememberedAt: number } } }).resumableTasks.get(T).rememberedAt -= 60_000;
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: { step: "resume" } }, T);
    await sleep(200);
    expect(conn.taskGets).toContain(T);
    expect(statuses(updates(conn, T))).toEqual(["input_required"]);
  });

  it("an old one the record confirms still resumes", async () => {
    const records: Records = new Map();
    const { conn, agent, buyerKp, buyer } = await pausing(() => ({ ok: true }), undefined, { records });
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: {} });
    await vi.waitFor(() => expect(taskIdOf(conn, buyer)).toBeTruthy());
    const T = taskIdOf(conn, buyer)!;
    records.set(T, { requester: buyer, responder: agent.agentId, state: "input_required" });
    (agent as unknown as { resumableTasks: { get(id: string): { rememberedAt: number } } }).resumableTasks.get(T).rememberedAt -= 60_000;
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: { step: "resume" } }, T);
    await vi.waitFor(() => expect(statuses(updates(conn, T))).toEqual(["input_required", "working", "completed"]));
    expect(conn.taskGets).toContain(T);
  });
});

describe("a slow or absent task manager", () => {
  /** One broker for several agents: callback and iterable subscriptions, a
   *  registry that registers, and a task manager whose record reads hang
   *  until the caller's timeout while it is `down`. */
  function makeBus(records: Records) {
    type M = { subject: string; data: Uint8Array; reply?: string; respond: () => boolean };
    const cbs = new Map<string, Set<(m: M) => void>>();
    const raws = new Map<string, Set<(m: M) => void>>();
    const registryKp = nkeys.createUser();
    const published: { subject: string; data: Uint8Array }[] = [];
    const taskManager = { down: true, reads: 0 };
    const fanOut = (subject: string, data: Uint8Array, reply?: string) => {
      const m: M = { subject, data, reply, respond: () => true };
      for (const cb of cbs.get(subject) ?? []) cb(m);
      for (const push of raws.get(subject) ?? []) push(m);
    };
    const add = <T,>(map: Map<string, Set<T>>, subject: string, v: T) => {
      if (!map.has(subject)) map.set(subject, new Set());
      map.get(subject)!.add(v);
      return () => map.get(subject)?.delete(v);
    };
    const answer = (req: Envelope, body: Partial<Envelope>) => ({
      data: encode(signEnvelope(createEnvelope({ type: "respond", from: registryKp.getPublicKey(), to: req.from, in_reply_to: req.id, ...body }), registryKp)),
    });
    const conn = () => ({
      publish: (subject: string, data: Uint8Array) => {
        published.push({ subject, data });
        fanOut(subject, data);
      },
      request: (subject: string, data: Uint8Array, opts?: { timeout?: number }) => {
        const req = decodeUnverified(data);
        if (subject.startsWith("mesh.task.get.")) {
          taskManager.reads++;
          const id = subject.slice("mesh.task.get.".length);
          if (taskManager.down) {
            return new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), opts?.timeout ?? 10_000));
          }
          const record = records.get(id);
          return Promise.resolve(
            answer(req, record ? { payload: { id, ...record } } : { error: { code: "TASK_NOT_FOUND", message: "not found", retryable: false } }),
          );
        }
        if (cbs.has(subject) && cbs.get(subject)!.size > 0) {
          // An agent's inbox: delivered, and the live wait answers at the
          // requester's own inbox, never here.
          fanOut(subject, data, "_INBOX.bus");
          return new Promise(() => {});
        }
        return Promise.resolve(answer(req, { payload: { status: "registered" } }));
      },
      subscribe: (subject: string, cb: (m: M) => void) => {
        const off = add(cbs, subject, cb);
        return { unsubscribe: off, drain: async () => off() };
      },
      raw: {
        publish: (subject: string, data: Uint8Array) => fanOut(subject, data),
        subscribe: (subject: string) => {
          const queue: M[] = [];
          let wake: (() => void) | undefined;
          let closed = false;
          const off = add(raws, subject, (m: M) => {
            queue.push(m);
            wake?.();
          });
          return {
            unsubscribe: () => {
              closed = true;
              off();
              wake?.();
            },
            async *[Symbol.asyncIterator]() {
              while (!closed) {
                if (queue.length) {
                  yield queue.shift()!;
                  continue;
                }
                await new Promise<void>((r) => (wake = r));
              }
            },
          };
        },
      },
      drain: async () => {},
      close: async () => {},
      get isClosed() {
        return false;
      },
    });
    return { conn, published, taskManager };
  }

  async function streamPair(records: Records, gapMs = 0) {
    const bus = makeBus(records);
    const provider = AgentMesh.withConnection(bus.conn() as unknown as ConnectionManager, nkeys.createUser(), nkeys.createUser(), {});
    openAgents.push(provider);
    provider.onStreamRequest("stream", async (_input, _ctx, writer) => {
      writer.write("a");
      if (gapMs) await sleep(gapMs);
      writer.write("b");
      if (gapMs) await sleep(gapMs);
      writer.end("done");
    });
    await provider.register({ name: "streamer" });
    const caller = AgentMesh.withConnection(bus.conn() as unknown as ConnectionManager, nkeys.createUser(), nkeys.createUser(), {});
    openAgents.push(caller);
    return { bus, provider, caller };
  }

  const readAll = async (chunks: AsyncIterable<{ data: unknown; final: boolean }>) => {
    const got: { data: unknown; final: boolean }[] = [];
    for await (const c of chunks) {
      got.push({ data: c.data, final: c.final });
      if (c.final) break;
    }
    return got;
  };

  it("a requestStream caller still gets every chunk and the end when the record cannot be read, and nothing is recorded", async () => {
    const { bus, provider, caller } = await streamPair(new Map());
    const started = Date.now();
    const s = await caller.requestStream(provider.agentId, "stream", {}, { timeout_ms: 8_000 });
    // The record read is capped on the dispatch path: about a second, not ten.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(bus.taskManager.reads).toBeGreaterThan(0);
    expect(await readAll(s.chunks)).toEqual([
      { data: "a", final: false },
      { data: "b", final: false },
      { data: "done", final: true },
    ]);
    await sleep(200);
    // The id could not be checked, so nothing is recorded on it.
    expect(bus.published.some((p) => p.subject === Subjects.taskUpdate(s.task_id))).toBe(false);
  }, 15_000);

  it("once a later read clears the id, the stream's completion is recorded on it", async () => {
    const { bus, provider, caller } = await streamPair(new Map());
    const s = await caller.requestStream(provider.agentId, "stream", {}, { timeout_ms: 8_000 });
    bus.taskManager.down = false; // the task manager is back: the id has no record, so it is nobody else's
    expect((await readAll(s.chunks)).at(-1)).toEqual({ data: "done", final: true });
    await vi.waitFor(() => expect(bus.published.some((p) => p.subject === Subjects.taskUpdate(s.task_id))).toBe(true), { timeout: 5_000 });
    // Cleared: the id is no longer being checked.
    expect((provider as unknown as { unconfirmedTasks: Map<string, unknown> }).unconfirmedTasks.size).toBe(0);
  }, 15_000);

  it("a later read that shows somebody else's Task records nothing on it", async () => {
    const records: Records = new Map();
    const { bus, provider, caller } = await streamPair(records);
    const s = await caller.requestStream(provider.agentId, "stream", {}, { timeout_ms: 8_000 });
    records.set(s.task_id, { requester: nkeys.createUser().getPublicKey(), responder: provider.agentId, state: "input_required" });
    bus.taskManager.down = false;
    expect((await readAll(s.chunks)).at(-1)).toEqual({ data: "done", final: true });
    await sleep(1_500);
    expect(bus.published.some((p) => p.subject === Subjects.taskUpdate(s.task_id))).toBe(false);
    // The verdict is in: the entry is gone, and the stranger's run under the
    // id did not make it the id's owner here (the real requester is not refused).
    const inner = provider as unknown as { unconfirmedTasks: Map<string, unknown>; dispatchOwners: { get(id: string): unknown } };
    await vi.waitFor(() => expect(inner.unconfirmedTasks.size).toBe(0), { timeout: 6_000 });
    expect(inner.dispatchOwners.get(s.task_id)).toBeUndefined();
    expect(bus.published.some((p) => p.subject === Subjects.taskUpdate(s.task_id))).toBe(false);
  }, 15_000);

  it("an id the task manager never answers for reaches a verdict too, and its entry goes", async () => {
    const { bus, provider, caller } = await streamPair(new Map());
    const s = await caller.requestStream(provider.agentId, "stream", {}, { timeout_ms: 8_000 });
    expect((await readAll(s.chunks)).at(-1)).toEqual({ data: "done", final: true });
    const inner = provider as unknown as { unconfirmedTasks: Map<string, unknown>; dispatchOwners: { get(id: string): unknown } };
    await vi.waitFor(() => expect(inner.unconfirmedTasks.size).toBe(0), { timeout: 8_000 });
    expect(inner.dispatchOwners.get(s.task_id)).toBeUndefined();
    expect(bus.published.some((p) => p.subject === Subjects.taskUpdate(s.task_id))).toBe(false);
  }, 15_000);

  it("chunks the honest responder signs for a stranger naming the stream's id are not the stream", async () => {
    // The buyer's stream runs. The provider then forgets it (a restart, a
    // replica, an eviction) and the task manager does not answer, so a
    // stranger's stream request naming the buyer's id runs under it: signed
    // chunks from the same responder land on the buyer's stream subject.
    const { bus, provider, caller } = await streamPair(new Map(), 800);
    bus.taskManager.down = false;
    const s = await caller.requestStream(provider.agentId, "stream", {}, { timeout_ms: 8_000 });
    (provider as unknown as { dispatchOwners: { forget(id: string): void } }).dispatchOwners.forget(s.task_id);
    bus.taskManager.down = true;
    const strangerKp = nkeys.createUser();
    const stranger = strangerKp.getPublicKey();
    const theirs = signEnvelope(
      createEnvelope({
        type: "request",
        from: stranger,
        to: provider.agentId,
        task_id: s.task_id,
        payload: { offering: "stream", input: {}, config: { stream: true } },
      }),
      strangerKp,
    );
    bus.conn().publish(Subjects.agentInbox(provider.agentId), encode(theirs));
    const got = await readAll(s.chunks);
    expect(got).toEqual([
      { data: "a", final: false },
      { data: "b", final: false },
      { data: "done", final: true },
    ]);
    // The stranger's run did put signed chunks on the subject: the filter, not
    // luck, kept them out.
    await vi.waitFor(() =>
      expect(
        bus.published.some((p) => p.subject === Subjects.taskStream(s.task_id) && decodeUnverified(p.data).to === stranger),
      ).toBe(true),
    );
  }, 15_000);

  it("a plain request naming an id it cannot check is refused, retryably, and nothing runs", async () => {
    const records: Records = new Map();
    let calls = 0;
    const { conn, agent } = await responder(async () => { calls++; await sleep(60); return 1; }, 20, { records });
    conn.taskManager.down = true;
    const kp = nkeys.createUser();
    const X = "named-while-down";
    deliver(conn, agent.agentId, kp, { offering: "work", input: {} }, X);
    await sleep(400);
    expect(calls).toBe(0);
    expect(taskTraffic(conn)).toEqual([]);
    const refusal = repliesTo(conn, kp.getPublicKey()).find((e) => e.error);
    expect(refusal?.error?.code).toBe("AGENT_UNAVAILABLE");
    expect(refusal?.error?.retryable).toBe(true);
  });

  it("a resume this agent cannot confirm (the record does not answer) is refused, retryably, not started as new work", async () => {
    const records: Records = new Map();
    let calls = 0;
    const { conn, agent } = await responder(() => {
      if (calls++ === 0) throw new InputProblemsError(problem);
      return { ok: true };
    }, undefined, { records });
    const kp = nkeys.createUser();
    const buyer = kp.getPublicKey();
    deliver(conn, agent.agentId, kp, { offering: "work", input: {} });
    await vi.waitFor(() => expect(taskIdOf(conn, buyer)).toBeTruthy());
    const T = taskIdOf(conn, buyer)!;
    // The pause is no longer remembered (a resume that admission refused gave
    // up its claim), and the task manager does not answer.
    (agent as unknown as { resumableTasks: { forget(id: string): void } }).resumableTasks.forget(T);
    conn.taskManager.down = true;
    deliver(conn, agent.agentId, kp, { offering: "work", input: { step: "resume" } }, T);
    await sleep(300);
    expect(calls).toBe(1);
    const refusal = repliesTo(conn, buyer).find((e) => e.error);
    expect(refusal?.error?.code).toBe("AGENT_UNAVAILABLE");
    expect(refusal?.error?.retryable).toBe(true);
    expect(repliesTo(conn, buyer).filter((e) => e.task_id && e.task_id !== T)).toEqual([]);
  });

  it("'no record' is remembered briefly: two cancels for an unknown id read the record once", async () => {
    const records: Records = new Map();
    const { conn, agent } = await responder(() => 1, undefined, { records });
    const kp = nkeys.createUser();
    cancelFrom(conn, agent.agentId, kp, "never-ran-here");
    await sleep(100);
    cancelFrom(conn, agent.agentId, kp, "never-ran-here");
    await sleep(100);
    expect(conn.taskGets.filter((id) => id === "never-ran-here")).toHaveLength(1);
  });
});

describe("a stream that resumes a paused Task", () => {
  it("records working first, so its ending is legal on the record", async () => {
    const { conn, agent, buyerKp, buyer } = await pausing(() => ({ ok: true }));
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: {} });
    await vi.waitFor(() => expect(taskIdOf(conn, buyer)).toBeTruthy());
    const T = taskIdOf(conn, buyer)!;
    deliver(conn, agent.agentId, buyerKp, { offering: "stream", input: { step: "end" }, config: { stream: true } }, T);
    await vi.waitFor(() => expect(replay(statuses(updates(conn, T))).state).toBe("completed"));
    expect(statuses(updates(conn, T))).toEqual(["input_required", "working", "completed"]);
    expect(replay(statuses(updates(conn, T))).refused).toEqual([]);
  });
});

describe("only a Task's requester cancels it", () => {
  it("a stranger's cancel of a paused Task is refused, releases nothing, and leaves it resumable", async () => {
    const { conn, agent, buyerKp, buyer } = await pausing(() => ({ ok: true }));
    const releases = vi.spyOn(agent as unknown as { releaseHold: (...a: unknown[]) => void }, "releaseHold");
    const propagations = vi.spyOn(agent as unknown as { propagateCancel: (...a: unknown[]) => void }, "propagateCancel");
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: {} });
    await vi.waitFor(() => expect(taskIdOf(conn, buyer)).toBeTruthy());
    const T = taskIdOf(conn, buyer)!;
    releases.mockClear();

    const strangerKp = nkeys.createUser();
    cancelFrom(conn, agent.agentId, strangerKp, T);
    await sleep(100);
    const answer = repliesTo(conn, strangerKp.getPublicKey())[0];
    expect(answer?.error?.code).toBe("UNAUTHORIZED");
    expect((answer?.payload as RespondPayload | undefined)?.status).not.toBe("canceled");
    expect(releases).not.toHaveBeenCalled();
    expect(propagations).not.toHaveBeenCalled();

    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: { step: "resume" } }, T);
    await vi.waitFor(() => expect(statuses(updates(conn, T))).toEqual(["input_required", "working", "completed"]));
  });

  it("after a restart, the record decides who may cancel", async () => {
    const records: Records = new Map();
    const { conn, agent } = await responder(() => 1, undefined, { records });
    const buyerKp = nkeys.createUser();
    const T = "paused-before-restart-cancel";
    records.set(T, { requester: buyerKp.getPublicKey(), responder: agent.agentId, state: "input_required" });
    const strangerKp = nkeys.createUser();
    cancelFrom(conn, agent.agentId, strangerKp, T);
    cancelFrom(conn, agent.agentId, buyerKp, T);
    await sleep(150);
    expect(repliesTo(conn, strangerKp.getPublicKey())[0]?.error?.code).toBe("UNAUTHORIZED");
    expect((repliesTo(conn, buyerKp.getPublicKey())[0]?.payload as RespondPayload | undefined)?.status).toBe("canceled");
  });
});

describe("two resumes of one pause, a moment apart", () => {
  it("only the first resumes the Task; the second is new work", async () => {
    let calls = 0;
    const { conn, agent, buyerKp, buyer } = await pausing(async () => {
      calls++;
      await sleep(80);
      return { n: calls };
    }, 20);
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: {} });
    await vi.waitFor(() => expect(taskIdOf(conn, buyer)).toBeTruthy());
    const T = taskIdOf(conn, buyer)!;
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: { step: "resume" } }, T);
    deliver(conn, agent.agentId, buyerKp, { offering: "work", input: { step: "resume" } }, T);
    await sleep(500);
    const onT = statuses(updates(conn, T));
    expect(onT).toEqual(["input_required", "working", "completed"]);
    expect(replay(onT).refused).toEqual([]);
  });
});
