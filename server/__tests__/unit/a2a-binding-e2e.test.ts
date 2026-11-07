/**
 * The A2A binding end to end: SDK agents on one bus, the task manager's A2A
 * store observing the inboxes and the stream subjects as it does on a mesh,
 * and the update subjects as it does on a mesh, and the server agent's node answering GetTask and ListTasks from that store
 * (bindings/a2a.md §5, §10), including after the node restarted and forgot
 * the Task.
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeBus, tick, type Bus } from "../../../sdk-typescript/__tests__/unit/a2a-bus.js";
import { A2ATaskStore } from "../../src/task-manager/a2a-store.js";
import { A2A_STORE_SUBJECTS } from "../../../sdk-typescript/src/a2a/server.js";
import { A2AError } from "../../../sdk-typescript/src/a2a/errors.js";
import { nkeys, signEnvelope } from "../../src/sdk.js";
import { memoryKv } from "../helpers/memory-kv.js";

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
