/**
 * What an A2A Task (wire 0.4.0) gives the platform, against what a 0.3.0
 * Task gives it (handlers/task-update.ts): the lifecycle event
 * `mesh.event.task.<state>`, the §19.2 receipts, the §13.5 terminal meter
 * events, cancel and failure reasons, the §10.8a attribution the platform
 * computes, completed late, trial work, stranded delegates, and the origin
 * and cancel attribution of SPEC.md §7.1 and §10.8 (task-manager/a2a-store.ts,
 * a2a-outputs.ts, task-records.ts, origin-tap.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { A2ATaskStore, type A2ATaskRecord } from "../../src/task-manager/a2a-store.js";
import { memoryKv } from "../helpers/memory-kv.js";
import { nkeys, createEnvelope, encode, decode, signEnvelope } from "../../src/sdk.js";
import type { Envelope } from "../../src/sdk.js";
import type { Task } from "../../../sdk-typescript/src/a2a/types.js";
import { EXT_BUDGET, EXT_CANCEL, EXT_FAILURE, EXT_OFFERING, EXT_TRIAL } from "../../../sdk-typescript/src/a2a/extensions.js";
import { OfferingDirectory } from "../../src/shared/a2a-frames.js";
import { OriginLedger } from "../../src/task-manager/origin.js";
import { OriginTap, ledgerView } from "../../src/task-manager/origin-tap.js";
import { taskRecords } from "../../src/task-manager/task-records.js";
import { publishCanceledBySettled } from "../../src/task-manager/handlers/task-update.js";

const clientKp = nkeys.createUser();
const serverKp = nkeys.createUser();
const svcKp = nkeys.createUser();
const C = clientKp.getPublicKey();
const S = serverKp.getPublicKey();
const inbox = (k: string) => `mesh.agent.${k}.inbox`;
type Kp = ReturnType<typeof nkeys.createUser>;

function frame(kp: Kp, p: Record<string, unknown>): Envelope {
  return signEnvelope(createEnvelope({ v: "0.4.0", from: kp.getPublicKey(), ...p } as never), kp as never);
}
const task = (id: string, state: string, extra: Partial<Task> = {}): Task =>
  ({ id, contextId: "ctx-1", status: { state, timestamp: new Date().toISOString() }, ...extra }) as Task;

/** Every signed emit the store publishes, decoded (its signature checked). */
interface Published { subject: string; env: Envelope; data: Record<string, unknown> }
let published: Published[];
const nc = {
  publish(subject: string, data?: Uint8Array) {
    const env = decode(data!);
    published.push({ subject, env, data: ((env.payload as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown> });
  },
} as never;
const on = (subject: string) => published.filter((p) => p.subject === subject).map((p) => p.data);
const meters = () => published.filter((p) => p.subject === "mesh.event.metering.usage").flatMap((p) => (p.env.payload as { data: { events: Record<string, unknown>[] } }).data.events);

let kv: ReturnType<typeof memoryKv>;
let registry: ReturnType<typeof memoryKv>;
let store: A2ATaskStore;
let declared: Set<string> | null;
beforeEach(() => {
  published = [];
  kv = memoryKv();
  registry = memoryKv();
  declared = new Set(["credential:Salesforce"]);
  store = new A2ATaskStore(kv, {
    nc,
    kp: svcKp as never,
    declaredNeeds: async () => declared,
    offerings: new OfferingDirectory(async () => registry),
  });
});

const record = async (id: string): Promise<A2ATaskRecord> => (await store.read(id))!.record;

/** The client's SendMessage on the server's inbox, then the Task the node
 *  publishes on the update subject in reply. */
async function start(id: string, opts: { state?: string; metadata?: Record<string, unknown>; first?: Partial<Task>; cost?: unknown } = {}): Promise<Envelope> {
  const req = frame(clientKp, {
    type: "request",
    to: S,
    payload: { a2a: { method: "SendMessage", params: { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "go" }], ...(opts.metadata ? { metadata: opts.metadata } : {}) } } } },
  });
  await store.observe(inbox(S), encode(req));
  const resp = frame(serverKp, {
    type: "respond",
    to: C,
    in_reply_to: req.id,
    payload: { a2a: { result: { task: task(id, opts.state ?? "TASK_STATE_WORKING", opts.first) }, seq: 0 }, ...(opts.cost ? { cost: opts.cost } : {}) },
  });
  await store.observe(`mesh.task.${id}.update`, encode(resp));
  return req;
}

async function status(id: string, seq: number, state: string, metadata?: Record<string, unknown>, cost?: unknown): Promise<Envelope> {
  const env = frame(serverKp, {
    type: "respond",
    to: C,
    payload: { a2a: { result: { statusUpdate: { taskId: id, contextId: "ctx-1", status: { state }, ...(metadata ? { metadata } : {}) } }, seq }, ...(cost ? { cost } : {}) },
  });
  await store.observe(`mesh.task.${id}.update`, encode(env));
  return env;
}

describe("lifecycle events and the completed receipt", () => {
  it("announces each state as a 0.3.0 Task does, and receipts the completion with budget, cost and context", async () => {
    await start("t1", {
      metadata: { [EXT_OFFERING]: { offering: "quote" }, [EXT_BUDGET]: { revision: 0, costCeiling: { amountMicro: 4_000_000, currency: "USD" } } },
    });
    expect(on("mesh.event.task.working")).toEqual([{ task_id: "t1", state: "working", requester: C, responder: S, offering: "quote" }]);
    const end = await status("t1", 1, "TASK_STATE_COMPLETED", undefined, { amount_micro: 17_000, currency: "USD" });
    expect(on("mesh.event.task.completed")).toEqual([{ task_id: "t1", state: "completed", requester: C, responder: S, offering: "quote" }]);
    const [receipt] = on("mesh.event.metering.task_completed");
    expect(receipt).toMatchObject({
      task_id: "t1", requester: C, responder: S, offering: "quote", context_id: "ctx-1",
      cost: { amount_micro: 17_000, currency: "USD" },
      budget: { revision: 0, cost_ceiling: { amount_micro: 4_000_000, currency: "USD" } },
      completed_late: false, status: "completed",
    });
    expect(Object.keys(receipt!).sort()).toEqual(
      ["task_id", "requester", "responder", "offering", "context_id", "started_at", "completed_at", "duration_ms", "cost", "budget", "completed_late", "status"].sort(),
    );
    const m = meters();
    expect(m.map((e) => e.meter).sort()).toEqual(["task_ms", "tasks_completed"]);
    expect(m.every((e) => e.task_id === "t1" && e.offering === "quote" && e.envelope_id === end.id && e.provider === S && e.consumer === C)).toBe(true);
    // Signed by the task manager, as the 0.3.0 events are.
    expect(published.every((p) => p.env.from === svcKp.getPublicKey())).toBe(true);
    // The record keeps the platform's fields beside the Task, and the frames.
    const r = await record("t1");
    expect(r).toMatchObject({ offering: "quote", reported_spend: { amount_micro: 17_000 } });
    expect(r.frames?.length).toBe(2);
  });

  it("an artifact update announces nothing; a repeated state is announced again, as on 0.3.0", async () => {
    await start("t2");
    await store.observe("mesh.task.t2.update", encode(frame(serverKp, { type: "respond", to: C, payload: { a2a: { result: { artifactUpdate: { taskId: "t2", contextId: "ctx-1", artifact: { artifactId: "a", parts: [] } } }, seq: 1 } } })));
    await status("t2", 2, "TASK_STATE_WORKING");
    expect(on("mesh.event.task.working").length).toBe(2);
  });

  it("a call naming no offering is recorded under the agent's one offering, else under none", async () => {
    await registry.put(S, JSON.stringify({ offerings: [{ id: "only" }] }));
    await start("t3");
    expect((await record("t3")).offering).toBe("only");
    await registry.put(S, JSON.stringify({ offerings: [{ id: "a" }, { id: "b" }] }));
    const other = new A2ATaskStore(memoryKv(), { nc, kp: svcKp as never, offerings: new OfferingDirectory(async () => registry) });
    store = other;
    await start("t4");
    expect((await record("t4")).offering).toBe("");
  });

  it("completed late: by the budget outcome, or by the deadline the starting Message set", async () => {
    await start("t5");
    await status("t5", 1, "TASK_STATE_COMPLETED", { [EXT_BUDGET]: { outcome: "completed_late" } });
    expect(on("mesh.event.task.completed")[0]).toMatchObject({ completed_late: true, code: "DEADLINE_EXCEEDED" });
    published = [];
    await start("t6", { metadata: { [EXT_BUDGET]: { revision: 0, deadline: "2020-01-01T00:00:00Z" } } });
    await status("t6", 1, "TASK_STATE_COMPLETED");
    expect(on("mesh.event.metering.task_completed")[0]).toMatchObject({ completed_late: true });
  });
});

describe("cancellation", () => {
  it("the canceled Task's cancel extension is the reason; the receipt carries it and who canceled", async () => {
    await start("c1");
    await status("c1", 1, "TASK_STATE_CANCELED", { [EXT_CANCEL]: { reason: "superseded", note: "newer one" } });
    const [ev] = on("mesh.event.task.canceled");
    expect(ev).toMatchObject({ task_id: "c1", state: "canceled", cancel_reason: "superseded" });
    // No ledger wired: the server cannot vouch for an original requester.
    expect(ev!.canceled_by).toMatchObject({ party: "responder", unverified: true, unverified_reason: "no_origin" });
    const [receipt] = on("mesh.event.metering.task_canceled");
    expect(receipt).toMatchObject({ task_id: "c1", status: "canceled", cancel_reason: "superseded", canceled_by: { party: "responder" } });
    expect(receipt).not.toHaveProperty("completed_late");
    expect(meters().map((e) => e.meter)).toEqual(["task_ms"]);
    expect(await record("c1")).toMatchObject({ cancel_reason: "superseded" });
  });

  it("falls back to the CancelTask the task manager saw, then to user_requested (§12.6)", async () => {
    await start("c2");
    const cancel = frame(clientKp, { type: "request", to: S, payload: { a2a: { method: "CancelTask", params: { id: "c2", metadata: { [EXT_CANCEL]: { reason: "needs_not_furnished", unmetNeed: "file:application/pdf" } } } } } });
    await store.observe(inbox(S), encode(cancel));
    await status("c2", 1, "TASK_STATE_CANCELED");
    expect(await record("c2")).toMatchObject({ cancel_reason: "needs_not_furnished", unmet_need: "file:application/pdf" });
    await start("c3");
    await status("c3", 1, "TASK_STATE_CANCELED");
    expect(on("mesh.event.metering.task_canceled").find((r) => r.task_id === "c3")).toMatchObject({ cancel_reason: "user_requested" });
  });

  it("exhausted: canceled with the exhausted outcome is announced as exhausted, with no canceled receipt", async () => {
    await start("x1");
    await status("x1", 1, "TASK_STATE_CANCELED", { [EXT_BUDGET]: { outcome: "exhausted" } });
    expect(on("mesh.event.task.exhausted")).toEqual([{ task_id: "x1", state: "exhausted", requester: C, responder: S, offering: "" }]);
    expect(on("mesh.event.task.canceled")).toEqual([]);
    expect(on("mesh.event.metering.task_canceled")).toEqual([]);
  });

  it("a canceled Task whose cancel object is malformed is not applied (§10.8)", async () => {
    await start("c4");
    await status("c4", 1, "TASK_STATE_CANCELED", { [EXT_CANCEL]: { reason: "bored" } });
    expect((await record("c4")).task.status.state).toBe("TASK_STATE_WORKING");
    expect(on("mesh.event.task.canceled")).toEqual([]);
  });

  it("stranded delegates: a live Task in the context that the canceled Task's responder requested is flagged", async () => {
    await start("p1");
    // The parent's responder (S) asks a delegate (D) in the same context.
    const dKp = nkeys.createUser();
    const D = dKp.getPublicKey();
    const req = frame(serverKp, { type: "request", to: D, payload: { a2a: { method: "SendMessage", params: { message: { messageId: "d1", role: "ROLE_USER", parts: [], contextId: "ctx-1" } } } } });
    await store.observe(inbox(D), encode(req));
    await store.observe("mesh.task.k1.update", encode(frame(dKp, { type: "respond", to: S, in_reply_to: req.id, payload: { a2a: { result: { task: task("k1", "TASK_STATE_WORKING") }, seq: 0 } } })));
    await status("p1", 1, "TASK_STATE_CANCELED", { [EXT_CANCEL]: { reason: "user_requested" } });
    expect(on("mesh.event.task.stranded")).toEqual([{ task_id: "k1", context_id: "ctx-1", canceled_task_id: "p1", requester: S, responder: D, cancel_reason: "user_requested" }]);
    expect(await record("k1")).toMatchObject({ stranded: true });
  });
});

describe("failure and attribution (§10.8a)", () => {
  it("a declared need not furnished is the client's; the platform computes it, never reads it", async () => {
    await start("f1");
    await status("f1", 1, "TASK_STATE_FAILED", { [EXT_FAILURE]: { reason: "needs_not_furnished", unmetNeed: "credential:Salesforce", attribution: "provider" } });
    expect(on("mesh.event.task.failed")[0]).toEqual({
      task_id: "f1", state: "failed", requester: C, responder: S, offering: "",
      failure_reason: "needs_not_furnished", unmet_need: "credential:Salesforce", attribution: "client", unmet_need_declared: true,
    });
  });

  it("an undeclared need, a dependency, a plain failure, and an unreadable registry are the provider's", async () => {
    await start("f2");
    await status("f2", 1, "TASK_STATE_FAILED", { [EXT_FAILURE]: { reason: "needs_not_furnished", unmetNeed: "file:text/csv", attribution: "client" } });
    await start("f3");
    await status("f3", 1, "TASK_STATE_FAILED", { [EXT_FAILURE]: { reason: "dependency_failed", dependency: "stripe" } });
    await start("f4");
    await status("f4", 1, "TASK_STATE_FAILED");
    declared = null;
    await start("f5");
    await status("f5", 1, "TASK_STATE_FAILED", { [EXT_FAILURE]: { reason: "needs_not_furnished", unmetNeed: "credential:Salesforce" } });
    const evs = on("mesh.event.task.failed");
    expect(evs.map((e) => e.attribution)).toEqual(["provider", "provider", "provider", "provider"]);
    expect(evs[1]).toMatchObject({ failure_reason: "dependency_failed", dependency: "stripe" });
    expect(evs[2]).not.toHaveProperty("failure_reason");
    // A failure gets no receipt, as on 0.3.0.
    expect(on("mesh.event.metering.task_completed").length + on("mesh.event.metering.task_canceled").length).toBe(0);
  });

  it("a failure reason outside the list is not applied", async () => {
    await start("f6");
    await status("f6", 1, "TASK_STATE_FAILED", { [EXT_FAILURE]: { reason: "tired" } });
    expect((await record("f6")).task.status.state).toBe("TASK_STATE_WORKING");
  });
});

describe("trial work (§12.8)", () => {
  it("a trial gets a trial receipt and trial meter events, never the completed receipt", async () => {
    await start("tr1", { metadata: { [EXT_TRIAL]: { trial: true } } });
    await status("tr1", 1, "TASK_STATE_COMPLETED");
    expect(on("mesh.event.metering.task_completed")).toEqual([]);
    expect(on("mesh.event.metering.task_trial")[0]).toMatchObject({ task_id: "tr1", ended: "completed", rated_micro: 0, status: "trial" });
    expect(meters().every((e) => e.trial === true)).toBe(true);
    expect((await record("tr1")).trial).toBe(true);
  });

  it("a refused trial is a rejected Task: announced, no receipt", async () => {
    await start("tr2", { metadata: { [EXT_TRIAL]: { trial: true } }, state: "TASK_STATE_REJECTED", first: { metadata: { [EXT_TRIAL]: { refusal: "TRIAL_REFUSED", reason: "day", limit: 10 } } } });
    expect(on("mesh.event.task.rejected").length).toBe(1);
    expect(on("mesh.event.metering.task_trial")).toEqual([]);
  });
});

describe("budget revisions (§7.7)", () => {
  it("a higher revision from the requester replaces the budget the receipt carries", async () => {
    await start("b1", { metadata: { [EXT_BUDGET]: { revision: 0, costCeiling: { amountMicro: 100, currency: "USD" } } } });
    const resume = frame(clientKp, { type: "request", to: S, payload: { a2a: { method: "SendMessage", params: { message: { messageId: "m2", role: "ROLE_USER", parts: [], taskId: "b1", metadata: { [EXT_BUDGET]: { revision: 1, costCeiling: { amountMicro: 900, currency: "USD" } } } } } } } });
    await store.observe(inbox(S), encode(resume));
    await status("b1", 1, "TASK_STATE_COMPLETED");
    expect(on("mesh.event.metering.task_completed")[0]).toMatchObject({ budget: { revision: 1, cost_ceiling: { amount_micro: 900 } } });
  });
});

describe("origin and cancel attribution on an A2A Task (SPEC.md §7.1, §10.8)", () => {
  it("the request the server saw is the Task's origin; the requester's CancelTask verifies who canceled", async () => {
    const tasks = memoryKv();
    const ledgerStore = memoryKv();
    const records = taskRecords(tasks, kv);
    const ledger = new OriginLedger(ledgerStore, records);
    store = new A2ATaskStore(kv, { nc, kp: svcKp as never, origins: ledger, records });
    const tap = new OriginTap(ledger, { sleep: async () => undefined });
    const both = async (subject: string, env: Envelope) => {
      await tap.push(subject, encode(env));
      await tap.drain();
      await store.observe(subject, encode(env));
    };
    const req = frame(clientKp, { type: "request", to: S, payload: { a2a: { method: "SendMessage", params: { message: { messageId: "m1", role: "ROLE_USER", parts: [], metadata: { [EXT_OFFERING]: { offering: "quote" } } } } } } });
    await both(inbox(S), req);
    const answer = frame(serverKp, { type: "respond", to: C, in_reply_to: req.id, payload: { a2a: { result: { task: task("o1", "TASK_STATE_WORKING") } } } });
    await both(inbox(C), answer);
    await store.observe("mesh.task.o1.update", encode(frame(serverKp, { type: "respond", to: C, in_reply_to: req.id, payload: { a2a: { result: { task: task("o1", "TASK_STATE_WORKING") }, seq: 0 } } })));
    const r = await record("o1");
    expect(r.origin).toMatchObject({ request_id: req.id, requester: C, responder: S, offering: "quote", bound_by: "answer" });
    expect(on("mesh.event.task.working")[0]).toMatchObject({ origin: { request_id: req.id } });

    const cancel = frame(clientKp, { type: "request", to: S, payload: { a2a: { method: "CancelTask", params: { id: "o1", metadata: { [EXT_CANCEL]: { reason: "user_requested" } } } } } });
    await both(inbox(S), cancel);
    await status("o1", 1, "TASK_STATE_CANCELED", { [EXT_CANCEL]: { reason: "user_requested" } });
    const [ev] = on("mesh.event.task.canceled");
    expect(ev!.canceled_by).toMatchObject({ party: "responder", requester_request: { request_id: cancel.id, via: "cancel_request" } });
    expect(ev!.canceled_by).not.toHaveProperty("unverified");
  });

  it("the ledger view: reads bind nothing, their answers are not judged, and the 0.4.0 accept is a delivery signal", () => {
    const seen = new Set<string>();
    const get = frame(clientKp, { type: "request", to: S, payload: { a2a: { method: "GetTask", params: { id: "o1" } } } });
    expect(ledgerView(get, seen)).toBeNull();
    const ans = frame(serverKp, { type: "respond", to: C, in_reply_to: get.id, payload: { a2a: { result: task("o1", "TASK_STATE_WORKING") } } });
    expect(ledgerView(ans, seen)).toBeNull();
    const send = frame(clientKp, { type: "request", to: S, payload: { a2a: { method: "SendMessage", params: { message: { messageId: "m", role: "ROLE_USER", parts: [], taskId: "o1" } } } } });
    expect(ledgerView(send, seen)).toMatchObject({ id: send.id, task_id: "o1", payload: { offering: "" } });
    const accept = frame(serverKp, { type: "respond", to: C, in_reply_to: send.id, payload: { accepted: {} } });
    expect(ledgerView(accept, seen)?.payload).toEqual({ status: "accepted" });
    const cancel = frame(clientKp, { type: "request", to: S, payload: { a2a: { method: "CancelTask", params: { id: "o1" } } } });
    expect(ledgerView(cancel, seen)?.payload).toEqual({ offering: "task.cancel", input: { task_id: "o1" } });
  });

  it("canceled_by_settled names an A2A Task by its id and its state", () => {
    publishCanceledBySettled(nc, svcKp as never, {
      task: task("s1", "TASK_STATE_CANCELED"), requester: C, responder: S, offering: "q", cancel_reason: "user_requested",
      canceled_by: { party: "responder", requester_request: null, at: "2026-11-07T00:00:00Z", resolved_at: "2026-11-07T00:01:00Z" },
    });
    expect(on("mesh.event.task.canceled_by_settled")[0]).toMatchObject({ task_id: "s1", state: "canceled", requester: C, offering: "q" });
  });
});

describe("a read settles an unverified cancel attribution (§10.8)", () => {
  it("GetTask through the responder's node asks the ledger to settle it", async () => {
    const settled: string[] = [];
    const origins = { settleCanceledBy: async (id: string) => { settled.push(id); return { outcome: "nothing" }; } } as never;
    store = new A2ATaskStore(kv, { origins });
    await kv.put("g1", JSON.stringify({
      task: task("g1", "TASK_STATE_CANCELED"), requester: C, responder: S, engagement: null, seq: 1,
      created_at: "2026-11-07T00:00:00Z", updated_at: "2026-11-07T00:01:00Z",
      origin: { request_id: "r", requester: C, responder: S, offering: "", observed_at: "2026-11-07T00:00:00Z", bound_by: "answer" },
      canceled_by: { party: "responder", at: "2026-11-07T00:01:00Z", unverified: true, unverified_reason: "settling" },
    }));
    const get = frame(clientKp, { type: "request", to: S, payload: { a2a: { method: "GetTask", params: { id: "g1" } } } });
    const relay = signEnvelope(createEnvelope({ type: "request", from: S, payload: { frame: get } }), serverKp as never);
    const resp = await store.handleGet(relay, {} as never, svcKp.getPublicKey());
    expect(resp.error).toBeUndefined();
    expect(settled).toEqual(["g1"]);
  });
});
