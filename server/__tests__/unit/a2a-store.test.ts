/**
 * The durable store of A2A Tasks (task-manager/a2a-store.ts; bindings/a2a.md
 * §5, §10, §11): built from the frames the task manager observes, read only by
 * a Task's creator through its responder's node.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { A2ATaskStore, type A2ATaskRecord } from "../../src/task-manager/a2a-store.js";
import { memoryKv } from "../helpers/memory-kv.js";
import { nkeys, createEnvelope, encode, signEnvelope } from "../../src/sdk.js";
import type { Envelope } from "../../src/sdk.js";
import type { Task } from "../../../sdk-typescript/src/a2a/types.js";

const client = nkeys.createUser();
const server = nkeys.createUser();
const stranger = nkeys.createUser();
const service = nkeys.createUser();
const C = client.getPublicKey();
const S = server.getPublicKey();
const X = stranger.getPublicKey();
const inbox = (k: string) => `mesh.agent.${k}.inbox`;

function frame(kp: ReturnType<typeof nkeys.createUser>, p: Record<string, unknown>): Envelope {
  return signEnvelope(createEnvelope({ v: "0.4.0", from: kp.getPublicKey(), ...p } as never), kp as never);
}

const task = (id: string, state: string, extra: Partial<Task> = {}): Task =>
  ({ id, contextId: "ctx", status: { state, timestamp: new Date().toISOString() }, ...extra }) as Task;

let kv: ReturnType<typeof memoryKv>;
let store: A2ATaskStore;
beforeEach(() => {
  kv = memoryKv();
  store = new A2ATaskStore(kv);
});

async function record(id: string): Promise<A2ATaskRecord | undefined> {
  return (await store.read(id))?.record;
}

/** The client asks, the server answers with a Task: both observed on the inboxes. */
async function created(id = "t1", state = "TASK_STATE_WORKING", meta?: Record<string, unknown>): Promise<Envelope> {
  const req = frame(client, {
    type: "request",
    to: S,
    payload: { a2a: { method: "SendMessage", params: { message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "go" }] } } } },
    ...(meta ? { meta } : {}),
  });
  await store.observe(inbox(S), encode(req));
  const resp = frame(server, { type: "respond", to: C, in_reply_to: req.id, payload: { a2a: { result: { task: task(id, state) }, seq: 0 } } });
  await store.observe(inbox(C), encode(resp));
  return req;
}

const stream = (seq: number, ev: unknown, from = server) =>
  encode(frame(from, { type: "respond", to: C, payload: { a2a: { result: ev, seq, ...(seq === 99 ? { final: true } : {}) } } }));

describe("what fills the store", () => {
  it("records a Task from the first answer, with its creator, its responder and the engagement beside it", async () => {
    await created("t1", "TASK_STATE_WORKING", { engagement: "eng-42" });
    const r = await record("t1");
    expect(r).toMatchObject({ requester: C, responder: S, engagement: "eng-42", seq: 0 });
    expect(r!.task).toEqual(expect.objectContaining({ id: "t1", status: expect.objectContaining({ state: "TASK_STATE_WORKING" }) }));
    // Beside the Task, never inside it.
    expect(Object.keys(r!.task)).not.toContain("requester");
  });

  it("folds later events from the stream subject in seq order, and drops what it already has", async () => {
    await created();
    await store.observe("mesh.task.t1.stream", stream(1, { artifactUpdate: { taskId: "t1", contextId: "ctx", artifact: { artifactId: "a", parts: [{ text: "x" }] } } }));
    await store.observe("mesh.task.t1.stream", stream(1, { artifactUpdate: { taskId: "t1", contextId: "ctx", artifact: { artifactId: "b", parts: [] } } }));
    await store.observe("mesh.task.t1.stream", stream(2, { statusUpdate: { taskId: "t1", contextId: "ctx", status: { state: "TASK_STATE_COMPLETED" } } }));
    const r = await record("t1");
    expect(r!.seq).toBe(2);
    expect(r!.task.artifacts?.map((a) => a.artifactId)).toEqual(["a"]);
    expect(r!.task.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("a Task in a terminal state does not move again", async () => {
    await created("t1", "TASK_STATE_COMPLETED");
    await store.observe("mesh.task.t1.stream", stream(1, { statusUpdate: { taskId: "t1", contextId: "ctx", status: { state: "TASK_STATE_WORKING" } } }));
    expect((await record("t1"))!.task.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("only the Task's responder moves it", async () => {
    await created();
    await store.observe("mesh.task.t1.stream", stream(1, { statusUpdate: { taskId: "t1", contextId: "ctx", status: { state: "TASK_STATE_FAILED" } } }, stranger));
    expect((await record("t1"))!.task.status.state).toBe("TASK_STATE_WORKING");
  });

  it("refuses a 0.4.0 frame carrying task_id, context_id or artifacts, and ignores 0.3.0 frames", async () => {
    const bad = frame(server, { type: "respond", to: C, task_id: "t9", payload: { a2a: { result: { task: task("t9", "TASK_STATE_WORKING") } } } });
    await store.observe(inbox(C), encode(bad));
    expect(await record("t9")).toBeUndefined();
    const old = signEnvelope(
      createEnvelope({ type: "respond", from: S, to: C, payload: { a2a: { result: { task: task("t8", "TASK_STATE_WORKING") } } } }),
      server as never,
    );
    await store.observe(inbox(C), encode(old));
    expect(await record("t8")).toBeUndefined();
  });

  it("a lone update creates nothing, and a forged signature is ignored", async () => {
    await store.observe("mesh.task.t2.stream", stream(1, { statusUpdate: { taskId: "t2", contextId: "c", status: { state: "TASK_STATE_WORKING" } } }));
    expect(await record("t2")).toBeUndefined();
    const forged = frame(server, { type: "respond", to: C, payload: { a2a: { result: { task: task("t3", "TASK_STATE_WORKING") } } } });
    forged.to = X;
    await store.observe(inbox(X), encode(forged));
    expect(await record("t3")).toBeUndefined();
  });
});

describe("who reads it (§10)", () => {
  /** The server agent's node relays its client's signed frame. */
  const relay = (node: ReturnType<typeof nkeys.createUser>, clientFrame: Envelope) =>
    signEnvelope(createEnvelope({ type: "request", from: node.getPublicKey(), payload: { frame: clientFrame } }), node as never);

  const getFrame = (kp: ReturnType<typeof nkeys.createUser>, id: string, to = S) =>
    frame(kp, { type: "request", to, payload: { a2a: { method: "GetTask", params: { id } } } });

  it("answers the Task's creator, through its responder's node", async () => {
    await created();
    const resp = await store.handleGet(relay(server, getFrame(client, "t1")), {} as never, service.getPublicKey());
    expect(resp.error).toBeUndefined();
    expect(resp.payload).toMatchObject({ task: { id: "t1" }, seq: 0, requester: C });
  });

  it("anyone else gets TaskNotFoundError: another client, another node, a frame for someone else, a tampered frame", async () => {
    await created();
    const cases = [
      relay(server, getFrame(stranger, "t1")),
      relay(stranger, getFrame(client, "t1", X)),
      relay(server, getFrame(client, "t1", X)),
      (() => {
        const f = getFrame(client, "t1");
        (f.payload as { a2a: { params: { id: string } } }).a2a.params.id = "t1 ";
        return relay(server, f);
      })(),
      relay(server, getFrame(client, "nope")),
    ];
    for (const req of cases) {
      const resp = await store.handleGet(req, {} as never, service.getPublicKey());
      expect(resp.error?.code).toBe("TaskNotFoundError");
      expect(resp.error?.details).toMatchObject({ a2a: { code: -32001 } });
    }
  });

  it("a message continuing a Task is read by the Task id it names", async () => {
    await created();
    const f = frame(client, { type: "request", to: S, payload: { a2a: { method: "SendMessage", params: { message: { messageId: "m2", role: "ROLE_USER", parts: [], taskId: "t1" } } } } });
    const resp = await store.handleGet(relay(server, f), {} as never, service.getPublicKey());
    expect(resp.payload).toMatchObject({ task: { id: "t1" } });
  });

  it("lists only the client's Tasks with the relaying node", async () => {
    await created("t1");
    await created("t2", "TASK_STATE_COMPLETED");
    const list = (kp: ReturnType<typeof nkeys.createUser>, params: Record<string, unknown> = {}) =>
      frame(kp, { type: "request", to: S, payload: { a2a: { method: "ListTasks", params } } });
    const mine = await store.handleList(relay(server, list(client)), {} as never, service.getPublicKey());
    expect((mine.payload as { result: { totalSize: number } }).result.totalSize).toBe(2);
    const done = await store.handleList(relay(server, list(client, { status: "TASK_STATE_COMPLETED" })), {} as never, service.getPublicKey());
    expect((done.payload as { result: { tasks: Task[] } }).result.tasks.map((t) => t.id)).toEqual(["t2"]);
    const theirs = await store.handleList(relay(server, list(stranger)), {} as never, service.getPublicKey());
    expect((theirs.payload as { result: { totalSize: number } }).result.totalSize).toBe(0);
    const bad = await store.handleList(relay(server, list(client, { pageSize: 0 })), {} as never, service.getPublicKey());
    expect(bad.error?.code).toBe("InvalidParamsError");
  });
});
