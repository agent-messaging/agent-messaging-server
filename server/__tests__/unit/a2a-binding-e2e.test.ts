/**
 * The A2A binding end to end: SDK agents on one bus, the task manager's A2A
 * store observing the inboxes and the update subjects as it does on a mesh,
 * MESH_TASKS holding every stream frame, the server agent's node answering
 * GetTask and ListTasks from the store (bindings/a2a.md §5, §10), including
 * after the node restarted and forgot the Task, and the task manager
 * delivering a stream to its reader from the first event (§8).
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeBus, tick, type Bus } from "../../../sdk-typescript/__tests__/unit/a2a-bus.js";
import { A2ATaskStore } from "../../src/task-manager/a2a-store.js";
import { A2A_STORE_SUBJECTS } from "../../../sdk-typescript/src/a2a/server.js";
import { A2AError } from "../../../sdk-typescript/src/a2a/errors.js";
import { nkeys, signEnvelope } from "../../src/sdk.js";
import { memoryKv } from "../helpers/memory-kv.js";
import { memoryStream } from "../helpers/memory-stream.js";
import { A2AFollow } from "../../src/task-manager/a2a-follow.js";
import { createEnvelope } from "../../src/sdk.js";

let bus: Bus;
afterEach(async () => {
  await bus.close();
});

function withStore() {
  bus = makeBus();
  const store = new A2ATaskStore(memoryKv());
  const svc = nkeys.createUser();
  const tap = bus.conn();
  for (const subject of ["mesh.agent.*.inbox", "mesh.task.*.update"]) {
    tap.subscribe(subject, (m: { subject: string; data: Uint8Array }) => void store.observe(m.subject, m.data));
  }
  bus.service(A2A_STORE_SUBJECTS.GET, async (req) => signEnvelope(await store.handleGet(req, {} as never, svc.getPublicKey()), svc as never));
  bus.service(A2A_STORE_SUBJECTS.LIST, async (req) => signEnvelope(await store.handleList(req, {} as never, svc.getPublicKey()), svc as never));
  return store;
}

/** withStore, plus MESH_TASKS and the task manager's follow service. */
function withFollow() {
  const store = withStore();
  const svc = nkeys.createUser();
  const stream = memoryStream();
  bus.conn().subscribe("mesh.task.*.stream", (m: { subject: string; data: Uint8Array }) => stream.push(m.subject, m.data));
  const follow = new A2AFollow(stream, store, { publish: (subject: string, data?: Uint8Array) => bus.publishRaw(subject, data!) });
  bus.service(A2A_STORE_SUBJECTS.FOLLOW, async (req) => signEnvelope(await follow.handle(req, {} as never, svc.getPublicKey()), svc as never));
  return { store, stream, follow };
}

const msg = (text: string) => ({ messageId: `m-${Math.random()}`, role: "ROLE_USER" as const, parts: [{ text }] });

describe("the A2A binding with the durable task store", () => {
  it("a long Task finishes after the answer; the store follows it; a restarted node answers from the store", async () => {
    const store = withStore();
    const serverKp = nkeys.createUser();
    const client = bus.agent();
    const server = bus.agent(serverKp);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.a2a.serve(
      async (_m, ctx) => {
        const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
        await gate;
        t.artifact({ artifactId: "report", parts: [{ text: "the report" }] });
        t.complete("Done.");
        return t;
      },
      { replyWindowMs: 30 },
    );
    const res = await client.a2a.sendMessage(server.id, msg("long"), { engagement: "eng-7" });
    expect(res.task?.status.state).toBe("TASK_STATE_WORKING");
    const id = res.task!.id;
    await tick(30);
    expect((await store.read(id))?.record).toMatchObject({ requester: client.id, responder: server.id, engagement: "eng-7", seq: 0 });

    release();
    await tick(60);
    const rec = (await store.read(id))!.record;
    expect(rec.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(rec.seq).toBe(2);

    // The node restarts: a new process with the same key holds no Tasks.
    await server.close();
    const again = bus.agent(serverKp);
    again.a2a.serve(() => undefined);
    const task = await client.a2a.getTask(again.id, id);
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(task.artifacts?.[0].parts[0].text).toBe("the report");
    const list = await client.a2a.listTasks(again.id);
    expect(list.tasks.map((t) => t.id)).toEqual([id]);

    const stranger = bus.agent();
    const err = (await stranger.a2a.getTask(again.id, id).catch((e) => e)) as A2AError;
    expect(err).toBeInstanceOf(A2AError);
    expect(err.code).toBe("TaskNotFoundError");
    expect((await stranger.a2a.listTasks(again.id)).tasks).toEqual([]);

    // A finished Task refuses a cancel, even on the restarted node.
    const cancel = (await client.a2a.cancelTask(again.id, id).catch((e) => e)) as A2AError;
    expect(cancel.code).toBe("TaskNotCancelableError");
  });

  it("a restarted node cancels a Task the store holds as working, and the store records the cancel", async () => {
    const store = withStore();
    const serverKp = nkeys.createUser();
    const client = bus.agent();
    const server = bus.agent(serverKp);
    server.a2a.serve((_m, ctx) => ctx.startTask({ state: "TASK_STATE_WORKING" }));
    const res = await client.a2a.sendMessage(server.id, msg("go"));
    await tick(30);
    await server.close();
    const again = bus.agent(serverKp);
    again.a2a.serve(() => undefined);
    const canceled = await client.a2a.cancelTask(again.id, res.task!.id, { cancel: { reason: "superseded" } });
    expect(canceled.status.state).toBe("TASK_STATE_CANCELED");
    await tick(40);
    const rec = (await store.read(res.task!.id))!.record;
    expect(rec.task.status.state).toBe("TASK_STATE_CANCELED");
    expect(rec.task.metadata?.["https://agentmessaging.ai/extensions/cancel/v1"]).toEqual({ reason: "superseded" });
    expect(rec.seq).toBe(1);
  });
});

describe("streams from MESH_TASKS (§8)", () => {
  it("a reader gets every event of its stream from the first, though they were sent before it listened", async () => {
    const { stream, follow } = withFollow();
    const client = bus.agent();
    const server = bus.agent();
    server.a2a.serve((_m, ctx) => {
      // Every event goes out at once, before the client could have listened.
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      t.artifact({ artifactId: "a", parts: [{ text: "one" }] });
      t.status("TASK_STATE_WORKING", "still going");
      t.complete("done");
      return t;
    });
    const s = client.a2a.sendStreamingMessage(server.id, msg("go"));
    const events = [];
    for await (const ev of s) events.push(ev);
    expect(events.map((e) => Object.keys(e)[0])).toEqual(["task", "artifactUpdate", "statusUpdate", "statusUpdate"]);
    expect(events.at(-1)?.statusUpdate?.status.state).toBe("TASK_STATE_COMPLETED");
    // Delivered by the task manager, with no read of the Task needed.
    const methods = bus.log.map((l) => (l.env.payload as { a2a?: { method?: string } })?.a2a?.method).filter(Boolean);
    expect(methods).not.toContain("GetTask");
    await tick(20);
    expect(stream.removed).toHaveLength(1);
    follow.stopAll();
  });

  it("only the agent that opened the stream, and created the Task, is delivered it", async () => {
    const { follow } = withFollow();
    const client = bus.agent();
    const server = bus.agent();
    const strangerKp = nkeys.createUser();
    server.a2a.serve((_m, ctx) => ctx.startTask({ state: "TASK_STATE_WORKING" }));
    const s = client.a2a.sendStreamingMessage(server.id, msg("go"));
    const it = s[Symbol.asyncIterator]();
    await it.next();
    const taskId = s.taskId!;
    const opening = bus.log.find((l) => (l.env.payload as { a2a?: { method?: string } })?.a2a?.method === "SendStreamingMessage")!.env;
    await tick(30);
    // A stranger presenting the client's frame: not its own.
    const asStranger = signEnvelope(createEnvelope({ type: "request", from: strangerKp.getPublicKey(), payload: { frame: opening, taskId } }), strangerKp as never);
    const a = await follow.handle(asStranger, {} as never, "USVC");
    expect(a.error?.code).toBe("TaskNotFoundError");
    // A stranger with a stream frame of its own, for a Task it did not create.
    const own = signEnvelope(
      createEnvelope({ type: "request", from: strangerKp.getPublicKey(), to: server.id, v: "0.4.0", payload: { a2a: { method: "SubscribeToTask", params: { id: taskId } } } }),
      strangerKp as never,
    );
    const b = await follow.handle(
      signEnvelope(createEnvelope({ type: "request", from: strangerKp.getPublicKey(), payload: { frame: own, taskId } }), strangerKp as never),
      {} as never,
      "USVC",
    );
    expect(b.error?.code).toBe("TaskNotFoundError");
    follow.stopAll();
    void it.return?.();
  });
});
