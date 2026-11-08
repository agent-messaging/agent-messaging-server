/**
 * Server 0.5.3: what an A2A Task (wire 0.4.0) still lacked beside a 0.3.0
 * Task. The overdue sweep marks it and notifies the requester without moving
 * its state; an exhausted Task keeps its cancel fields; the record keeps the
 * creating Message's parts (`inputs`) and the problem reports of an input wait
 * (`waiting_on`); and the server agent may read its own Task, which is how a
 * node that restarted takes up a Task it handed back.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { A2ATaskStore, type A2ATaskRecord } from "../../src/task-manager/a2a-store.js";
import { OverdueSweep } from "../../src/task-manager/overdue-sweep.js";
import { INPUTS_INLINE_MAX, inputsOf } from "../../src/task-manager/a2a-outputs.js";
import { memoryKv } from "../helpers/memory-kv.js";
import { nkeys, createEnvelope, encode, decode, signEnvelope } from "../../src/sdk.js";
import type { Envelope } from "../../src/sdk.js";
import type { Task } from "../../../sdk-typescript/src/a2a/types.js";
import { EXT_BUDGET, EXT_CANCEL } from "../../../sdk-typescript/src/a2a/extensions.js";

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

let published: Array<{ subject: string; env: Envelope }>;
const nc = {
  publish(subject: string, data?: Uint8Array) {
    published.push({ subject, env: decode(data!) });
  },
} as never;
const dataOn = (subject: string) => published.filter((p) => p.subject === subject).map((p) => (p.env.payload as { data: Record<string, unknown> }).data);

let kv: ReturnType<typeof memoryKv>;
let store: A2ATaskStore;
beforeEach(() => {
  published = [];
  kv = memoryKv();
  store = new A2ATaskStore(kv, { nc, kp: svcKp as never });
});
const record = async (id: string): Promise<A2ATaskRecord> => (await store.read(id))!.record;

async function start(id: string, opts: { parts?: unknown[]; metadata?: Record<string, unknown>; state?: string } = {}): Promise<Envelope> {
  const req = frame(clientKp, {
    type: "request",
    to: S,
    payload: { a2a: { method: "SendMessage", params: { message: { messageId: `m-${id}`, role: "ROLE_USER", parts: opts.parts ?? [{ text: "go" }], ...(opts.metadata ? { metadata: opts.metadata } : {}) } } } },
  });
  await store.observe(inbox(S), encode(req));
  await store.observe(`mesh.task.${id}.update`, encode(frame(serverKp, { type: "respond", to: C, in_reply_to: req.id, payload: { a2a: { result: { task: task(id, opts.state ?? "TASK_STATE_WORKING") }, seq: 0 } } })));
  return req;
}

async function status(id: string, seq: number, state: string, extra: { metadata?: Record<string, unknown>; message?: unknown } = {}): Promise<void> {
  const env = frame(serverKp, {
    type: "respond",
    to: C,
    payload: { a2a: { result: { statusUpdate: { taskId: id, contextId: "ctx-1", status: { state, ...(extra.message ? { message: extra.message } : {}) }, ...(extra.metadata ? { metadata: extra.metadata } : {}) } }, seq } },
  });
  await store.observe(`mesh.task.${id}.update`, encode(env));
}

const PAST = "2026-01-01T00:00:00Z";
const budgetPast = { [EXT_BUDGET]: { deadline: PAST, revision: 0 } };

describe("the overdue sweep, for A2A Tasks (SPEC.md §7.7)", () => {
  const sweep = () => new OverdueSweep(nc, {} as never, kv as never, svcKp as never, async () => new Map(), { store: kv as never });

  it("marks a working Task past its deadline beside the Task, and notifies the requester with the A2A overdue mark", async () => {
    await start("o1", { metadata: budgetPast });
    published = [];
    expect(await sweep().sweep()).toEqual(["o1"]);
    const r = await record("o1");
    expect(r).toMatchObject({ overdue: true });
    expect(typeof r.overdue_at).toBe("string");
    // The A2A state is untouched, and nothing went inside the Task.
    expect(r.task.status.state).toBe("TASK_STATE_WORKING");
    expect(r.task.metadata).toBeUndefined();

    const notices = published.filter((p) => p.subject === "mesh.task.o1.update");
    expect(notices.length).toBe(1);
    const n = notices[0]!.env;
    expect(n).toMatchObject({ v: "0.4.0", type: "respond", from: svcKp.getPublicKey(), to: C, meta: { overdue: true, deadline: PAST } });
    expect(n).not.toHaveProperty("task_id");
    expect(n).not.toHaveProperty("budget");
    const ev = (n.payload as { a2a: { result: { statusUpdate: Record<string, unknown> }; seq?: number } }).a2a;
    expect(ev.seq).toBeUndefined();
    expect(ev.result.statusUpdate).toMatchObject({ taskId: "o1", contextId: "ctx-1", status: { state: "TASK_STATE_WORKING" }, metadata: { [EXT_BUDGET]: { overdue: true } } });
    // No lifecycle event: 0.3.0 publishes none for overdue either.
    expect(published.filter((p) => p.subject.startsWith("mesh.event."))).toEqual([]);

    // The store, which sees the notice on the update subject, leaves the Task as it is.
    const before = await store.read("o1");
    await store.observe("mesh.task.o1.update", encode(n));
    expect((await store.read("o1"))!.revision).toBe(before!.revision);
  });

  it("marks once, and leaves alone a finished Task, one with no deadline, and one whose deadline has not passed", async () => {
    await start("o2", { metadata: budgetPast });
    await start("o3", { metadata: budgetPast });
    await status("o3", 1, "TASK_STATE_COMPLETED");
    await start("o4");
    await start("o5", { metadata: { [EXT_BUDGET]: { deadline: "2099-01-01T00:00:00Z", revision: 0 } } });
    const s = sweep();
    expect(await s.sweep()).toEqual(["o2"]);
    expect(await s.sweep()).toEqual([]);
    expect((await record("o3")).overdue).toBeUndefined();
    expect((await record("o4")).overdue).toBeUndefined();
    expect((await record("o5")).overdue).toBeUndefined();
  });

  it("a Task waiting on the client is swept too, and a later completion is recorded late", async () => {
    await start("o6", { metadata: budgetPast });
    await status("o6", 1, "TASK_STATE_INPUT_REQUIRED");
    expect(await sweep().sweep()).toEqual(["o6"]);
    expect((await record("o6")).task.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    await status("o6", 2, "TASK_STATE_COMPLETED");
    expect(await record("o6")).toMatchObject({ overdue: true, completed_late: true });
  });
});

describe("an exhausted A2A Task keeps its cancel fields", () => {
  it("writes cancel_reason and canceled_by on the record and the exhausted event, with no canceled receipt", async () => {
    await start("x1");
    await status("x1", 1, "TASK_STATE_CANCELED", { metadata: { [EXT_BUDGET]: { outcome: "exhausted" }, [EXT_CANCEL]: { reason: "policy" } } });
    expect(await record("x1")).toMatchObject({ cancel_reason: "policy", canceled_by: { party: "responder" } });
    expect(dataOn("mesh.event.task.exhausted")).toEqual([expect.objectContaining({ state: "exhausted", cancel_reason: "policy", canceled_by: expect.objectContaining({ party: "responder" }) })]);
    expect(dataOn("mesh.event.metering.task_canceled")).toEqual([]);
    expect(dataOn("mesh.event.task.canceled")).toEqual([]);
  });

  it("takes the reason from the CancelTask the store saw when the Task states none", async () => {
    await start("x2");
    await store.observe(inbox(S), encode(frame(clientKp, { type: "request", to: S, payload: { a2a: { method: "CancelTask", params: { id: "x2", metadata: { [EXT_CANCEL]: { reason: "superseded" } } } } } })));
    await status("x2", 1, "TASK_STATE_CANCELED", { metadata: { [EXT_BUDGET]: { outcome: "exhausted" } } });
    expect((await record("x2")).cancel_reason).toBe("superseded");
    expect(dataOn("mesh.event.task.exhausted")[0]).toMatchObject({ cancel_reason: "superseded" });
  });
});

describe("the creating Message's parts beside the Task", () => {
  it("keeps the parts as the client sent them", async () => {
    await start("i1", { parts: [{ text: "quote this" }, { data: { sku: "A-1", qty: 3 } }, { url: "https://example.com/f.pdf", mediaType: "application/pdf" }] });
    expect((await record("i1")).inputs).toEqual({
      message_id: "m-i1",
      parts: [{ text: "quote this" }, { data: { sku: "A-1", qty: 3 } }, { url: "https://example.com/f.pdf", mediaType: "application/pdf" }],
    });
  });

  it("keeps a part too large to keep whole as a reference: its kind, size and digest", async () => {
    const raw = Buffer.alloc(INPUTS_INLINE_MAX + 10, 7).toString("base64");
    await start("i2", { parts: [{ text: "small" }, { raw, mediaType: "image/png", filename: "a.png" }] });
    const parts = (await record("i2")).inputs!.parts;
    expect(parts[0]).toEqual({ text: "small" });
    expect(parts[1]).toMatchObject({ omitted: true, kind: "raw", size: INPUTS_INLINE_MAX + 10, mediaType: "image/png", filename: "a.png" });
    expect((parts[1] as { digest: string }).digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("lists at most 64 parts and counts the rest", () => {
    const got = inputsOf({ messageId: "m", role: "ROLE_USER", parts: Array.from({ length: 70 }, (_, i) => ({ text: String(i) })) });
    expect(got!.parts.length).toBe(64);
    expect(got!.parts_omitted).toBe(6);
  });

  it("a Message that continues a Task does not replace them", async () => {
    await start("i3", { parts: [{ text: "first" }] });
    await status("i3", 1, "TASK_STATE_INPUT_REQUIRED");
    await store.observe(inbox(S), encode(frame(clientKp, { type: "request", to: S, payload: { a2a: { method: "SendMessage", params: { message: { messageId: "m2", role: "ROLE_USER", taskId: "i3", parts: [{ text: "second" }] } } } } })));
    await status("i3", 2, "TASK_STATE_WORKING");
    expect((await record("i3")).inputs).toEqual({ message_id: "m-i3", parts: [{ text: "first" }] });
  });
});

describe("problem reports on an input wait", () => {
  const problems = [{ input: "invoice", problem: "missing", description: "Attach the March invoice as a PDF.", expected: "application/pdf" }];
  const msg = (data: unknown) => ({ messageId: "s1", role: "ROLE_AGENT", parts: [{ text: "Need the invoice." }, { data }] });

  it("records the reports while the Task waits, and drops them once it moves on", async () => {
    await start("w1");
    await status("w1", 1, "TASK_STATE_INPUT_REQUIRED", { message: msg({ problems: [...problems, { input: "x" }] }) });
    // The malformed second report is dropped, never repaired.
    expect((await record("w1")).waiting_on).toEqual(problems);
    await status("w1", 2, "TASK_STATE_WORKING");
    expect((await record("w1")).waiting_on).toBeUndefined();
  });

  it("a new pause without reports has none, and reports later in the same pause replace them", async () => {
    await start("w2");
    await status("w2", 1, "TASK_STATE_INPUT_REQUIRED", { message: msg({ problems }) });
    await status("w2", 2, "TASK_STATE_WORKING");
    await status("w2", 3, "TASK_STATE_INPUT_REQUIRED", { message: { messageId: "s2", role: "ROLE_AGENT", parts: [{ text: "Paused." }] } });
    expect((await record("w2")).waiting_on).toBeUndefined();
    const other = [{ input: "po", problem: "other", description: "The purchase order number is needed." }];
    await status("w2", 4, "TASK_STATE_INPUT_REQUIRED", { message: msg({ problems: other }) });
    expect((await record("w2")).waiting_on).toEqual(other);
  });

  it("a Task born waiting carries its reports", async () => {
    const req = frame(clientKp, { type: "request", to: S, payload: { a2a: { method: "SendMessage", params: { message: { messageId: "m", role: "ROLE_USER", parts: [] } } } } });
    await store.observe(inbox(S), encode(req));
    await store.observe("mesh.task.w3.update", encode(frame(serverKp, { type: "respond", to: C, in_reply_to: req.id, payload: { a2a: { result: { task: task("w3", "TASK_STATE_INPUT_REQUIRED", { status: { state: "TASK_STATE_INPUT_REQUIRED", message: msg({ problems }) } as never }) }, seq: 0 } } })));
    expect((await record("w3")).waiting_on).toEqual(problems);
  });
});

describe("the server agent reads its own Task", () => {
  const ask = (kp: Kp, id: string) => frame(kp, { type: "request", to: svcKp.getPublicKey(), payload: { id } });

  it("answers the responder with the Task, its place and its requester, and anyone else not found", async () => {
    await start("r1");
    await status("r1", 1, "TASK_STATE_WORKING");
    const mine = await store.handleGet(ask(serverKp, "r1"), {} as never, svcKp.getPublicKey());
    expect(mine.error).toBeUndefined();
    expect(mine.payload).toMatchObject({ seq: 1, requester: C, task: { id: "r1", status: { state: "TASK_STATE_WORKING" } } });
    const theirs = await store.handleGet(ask(clientKp, "r1"), {} as never, svcKp.getPublicKey());
    expect(theirs.error?.code).toBe("TaskNotFoundError");
    const none = await store.handleGet(ask(serverKp, "nope"), {} as never, svcKp.getPublicKey());
    expect(none.error?.code).toBe("TaskNotFoundError");
  });
});
