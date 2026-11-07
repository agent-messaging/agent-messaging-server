/**
 * MESH_TASKS and stream following against a real nats-server (A2A binding
 * §8): the stream is made with its subjects, keeps frames published before
 * anyone follows, and the task manager's follow delivers a stream's frames to
 * its reader's inbox from the first, ending at the final one.
 *
 * Needs a nats-server binary (NATS_SERVER_BIN, or the checked-in Windows one);
 * without one every test skips.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JetStreamClient, JetStreamManager } from "nats";
import { startNatsServer, type TestServer } from "../helpers/nats-server.js";
import { messagingOf, storageOf } from "../../src/storage/index.js";
import { A2AFollow } from "../../src/task-manager/a2a-follow.js";
import { A2ATaskStore } from "../../src/task-manager/a2a-store.js";
import { createEnvelope, encode, nkeys, signEnvelope, decode } from "../../src/sdk.js";
import { memoryKv } from "../helpers/memory-kv.js";

let server: TestServer | null = null;
let js: JetStreamClient;
let jsm: JetStreamManager;

beforeAll(async () => {
  server = await startNatsServer("a2a-tasks-stream");
  if (!server) return;
  js = server.nc.jetstream();
  jsm = await server.nc.jetstreamManager();
}, 30_000);

afterAll(async () => {
  await server?.stop();
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MESH_TASKS on JetStream", () => {
  it("is made holding the Task stream and update subjects, and nothing else of mesh.task", async (ctx) => {
    if (!server) return ctx.skip();
    expect(await storageOf(js).stream("MESH_TASKS").ensure()).toBe(true);
    const info = await jsm.streams.info("MESH_TASKS");
    expect(info.config.subjects?.sort()).toEqual(["mesh.task.*.stream", "mesh.task.*.update"]);
    expect(info.config.max_age).toBe(7 * 24 * 3600 * 1e9);
    // Ensuring again changes nothing.
    expect(await storageOf(js).stream("MESH_TASKS").ensure()).toBe(true);
  });

  it("delivers a stream's frames to its reader from the first, though they came before it followed", async (ctx) => {
    if (!server) return ctx.skip();
    const nc = server.nc;
    const tasks = storageOf(js).stream("MESH_TASKS");
    await tasks.ensure();
    const client = nkeys.createUser();
    const agent = nkeys.createUser();
    const C = client.getPublicKey();
    const A = agent.getPublicKey();
    const opening = signEnvelope(
      createEnvelope({ type: "request", from: C, to: A, v: "0.4.0", payload: { a2a: { method: "SendStreamingMessage", params: { message: { messageId: "m", role: "ROLE_USER", parts: [] } } } } }),
      client as never,
    );
    const taskId = "task-js-1";
    const frame = (seq: number, state: string, final = false, streamId = opening.id) =>
      encode(
        signEnvelope(
          createEnvelope({
            type: "respond",
            from: A,
            to: C,
            v: "0.4.0",
            payload: { a2a: { result: { statusUpdate: { taskId, contextId: "c", status: { state } } }, streamId, seq, ...(final ? { final: true } : {}) } },
          }),
          agent as never,
        ),
      );
    // Published before anyone follows; one of another stream on the same subject.
    nc.publish(`mesh.task.${taskId}.stream`, frame(1, "TASK_STATE_WORKING"));
    nc.publish(`mesh.task.${taskId}.stream`, frame(1, "TASK_STATE_WORKING", false, "another-stream"));
    nc.publish(`mesh.task.${taskId}.stream`, frame(2, "TASK_STATE_COMPLETED", true));
    await nc.flush();
    await tick(100);

    const got: Array<{ seq: number; final?: boolean }> = [];
    const sub = nc.subscribe(`mesh.agent.${C}.inbox`);
    void (async () => {
      for await (const m of sub) got.push((decode(m.data).payload as { a2a: { seq: number; final?: boolean } }).a2a);
    })();

    const follow = new A2AFollow(tasks, new A2ATaskStore(memoryKv()), messagingOf(nc));
    const req = signEnvelope(createEnvelope({ type: "request", from: C, v: "0.4.0", payload: { frame: opening, taskId } }), client as never);
    const answer = await follow.handle(req, {} as never, "USVC");
    expect(answer.error).toBeUndefined();
    const durable = (answer.payload as { durable: string }).durable;

    for (let i = 0; i < 40 && got.length < 2; i++) await tick(50);
    expect(got.map((a) => a.seq)).toEqual([1, 2]);
    expect(got[1].final).toBe(true);
    // The consumer is removed once the stream ended.
    for (let i = 0; i < 20; i++) {
      const gone = await jsm.consumers.info("MESH_TASKS", durable).then(() => false, () => true);
      if (gone) break;
      await tick(50);
    }
    await expect(jsm.consumers.info("MESH_TASKS", durable)).rejects.toBeTruthy();
    sub.unsubscribe();
  });
});
