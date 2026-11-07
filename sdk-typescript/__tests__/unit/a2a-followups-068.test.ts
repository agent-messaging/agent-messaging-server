/**
 * SDK 0.68.0: what moving AgentMesh to wire 0.4.0 needed from the public
 * API. A call's frames (`callWithFrames`, `onRequestFrame`); keeping
 * OFFERING_NOT_FOUND for 0.3.0 requests (`claimUnhandledOfferings: false`);
 * usage on the A2A handler's context (`ctx.reportMeter`, riding beside
 * `payload.a2a`); Task handles that survive a restart (`taskState`,
 * `mesh.a2a.taskHandle`) and finished Tasks let go of; and the fixture's
 * extension block read against the SDK's URIs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nkeys } from "nats.ws";
import { makeBus, tick, waitFor, type Bus } from "./a2a-bus.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { MeshError, ErrorCode } from "../../src/types/errors.js";
import type { Envelope } from "../../src/types/envelope.js";
import {
  A2AError,
  A2A_STORE_SUBJECTS,
  EXT_ARTIFACT_REFS,
  EXT_AUDIENCE,
  EXT_BUDGET,
  EXT_CANCEL,
  EXT_ECONOMICS,
  EXT_FAILURE,
  EXT_OFFERING,
  EXT_REPLY,
  EXT_TRIAL,
  withOffering,
  type A2ATaskState,
  type A2ATaskStateStore,
  type Message,
  type StreamResponse,
  type Task,
} from "../../src/a2a/index.js";

let bus: Bus;
afterEach(async () => {
  await bus?.close();
});

const userMsg = (text = "go"): Message => ({ messageId: `m-${Math.random().toString(36).slice(2)}`, role: "ROLE_USER", parts: [{ text }] });
const agentMsg = (text: string): Message => ({ messageId: `r-${Math.random().toString(36).slice(2)}`, role: "ROLE_AGENT", parts: [{ text }] });
const usageOf = (env: Envelope) => (env.payload as { usage?: unknown } | undefined)?.usage;

function setup() {
  bus = makeBus();
  return { client: bus.agent(), server: bus.agent() };
}

describe("a call's frames (callWithFrames, onRequestFrame)", () => {
  it("answers with the result, the request frame's id and trace, and both frames", async () => {
    const { client, server } = setup();
    server.a2a.serve(() => agentMsg("hi"));
    let seen: Envelope | null = null;
    const got = await client.a2a.sendMessageWithFrames(server.id, userMsg(), { onRequestFrame: (f) => (seen = f) });
    expect(got.result.message?.parts[0].text).toBe("hi");
    expect(got.frames.request.id).toBe(got.requestId);
    expect(got.frames.request.trace).toEqual(got.trace);
    expect(got.frames.request.from).toBe(client.id);
    expect(got.frames.response.in_reply_to).toBe(got.requestId);
    expect(got.frames.response.from).toBe(server.id);
    expect(seen!.id).toBe(got.requestId);
    // The plain call returns the same result.
    expect((await client.a2a.sendMessage(server.id, userMsg())).message?.parts[0].text).toBe("hi");
  });

  it("onRequestFrame sees the frame of a call that then fails, once", async () => {
    const { client, server } = setup();
    server.a2a.serve(() => {
      throw new A2AError("UnsupportedOperationError", "not today");
    });
    const frames: Envelope[] = [];
    await expect(client.a2a.callWithFrames(server.id, "SendMessage", { message: userMsg() }, { onRequestFrame: (f) => frames.push(f) })).rejects.toMatchObject({ code: "UnsupportedOperationError" });
    expect(frames).toHaveLength(1);
    const answer = bus.log.find((l) => l.env.type === "respond" && l.env.to === client.id && l.env.error);
    expect(answer!.env.in_reply_to).toBe(frames[0]!.id);
  });
});

describe("keeping OFFERING_NOT_FOUND for 0.3.0 requests (claimUnhandledOfferings)", () => {
  it("false: a 0.3.0 request for an offering with no handler is refused, and a registered one is answered", async () => {
    const { client, server } = setup();
    server.onRequest("quote", () => ({ price: 40 }));
    server.a2a.serve(() => agentMsg("a2a"), { claimUnhandledOfferings: false });
    const err = await client.request(server.id, "anything", { n: 1 }, { timeout_ms: 2000 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MeshError);
    expect((err as MeshError).code).toBe(ErrorCode.OFFERING_NOT_FOUND);
    expect((await client.request(server.id, "quote", {}, { timeout_ms: 2000 })).payload.output).toEqual({ price: 40 });
  });

  it("a later serve with false removes the adapter an earlier serve installed; an onDefault of the agent's own stays", async () => {
    const { client, server } = setup();
    server.a2a.serve(() => agentMsg("a2a"));
    expect((await client.request(server.id, "anything", {}, { timeout_ms: 2000 })).payload.output).toBe("a2a");
    server.a2a.serve(() => agentMsg("a2a"), { claimUnhandledOfferings: false });
    const err = await client.request(server.id, "anything", {}, { timeout_ms: 2000 }).then(() => null, (e: unknown) => e);
    expect((err as MeshError).code).toBe(ErrorCode.OFFERING_NOT_FOUND);
    server.onDefault(() => "mine");
    server.a2a.serve(() => agentMsg("a2a"), { claimUnhandledOfferings: false });
    expect((await client.request(server.id, "anything", {}, { timeout_ms: 2000 })).payload.output).toBe("mine");
  });
});

describe("usage on the A2A handler's context (ctx.reportMeter)", () => {
  it("rides beside payload.a2a on the Message that answers the call", async () => {
    const { client, server } = setup();
    server.a2a.serve((_m, ctx) => {
      ctx.reportMeter("tokens_out", 40);
      ctx.reportMeter("tokens_out", 2);
      ctx.reportMeter("tokens_in", 7);
      return agentMsg("done");
    });
    const got = await client.a2a.sendMessageWithFrames(server.id, userMsg());
    expect(usageOf(got.frames.response)).toEqual([{ meter: "tokens_in", quantity: 7 }, { meter: "tokens_out", quantity: 42 }]);
    expect((got.frames.response.payload as { a2a: unknown }).a2a).toBeTruthy();
  });

  it("rides on the frames that finish a Task (its update, its streams), once per Task", async () => {
    const { client, server } = setup();
    server.a2a.serve((_m, ctx) => {
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      ctx.reportMeter("pages", 3);
      setTimeout(() => {
        t.artifact({ artifactId: "a", parts: [{ text: "x" }] });
        t.complete("ok");
      }, 30);
      return t;
    });
    const stream = client.a2a.sendStreamingMessage(server.id, userMsg());
    await stream[Symbol.asyncIterator]().next();
    const final = (subject: RegExp) => bus.log.filter((l) => subject.test(l.subject)).map((l) => l.env);
    await waitFor(() => final(/^mesh\.task\.[^.]+\.update$/).length === 3 && final(/^mesh\.task\.[^.]+\.stream$/).length === 2);
    expect(final(/^mesh\.task\.[^.]+\.update$/).map(usageOf)).toEqual([undefined, undefined, [{ meter: "pages", quantity: 3 }]]);
    expect(final(/^mesh\.task\.[^.]+\.stream$/).map(usageOf)).toEqual([undefined, [{ meter: "pages", quantity: 3 }]]);
  });

  it("a Task finished before its first answer carries the receipt on that answer", async () => {
    const { client, server } = setup();
    server.a2a.serve((_m, ctx) => {
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      ctx.reportMeter("pages", 1);
      t.complete("quick");
      return t;
    });
    const got = await client.a2a.sendMessageWithFrames(server.id, userMsg());
    expect(got.result.task?.status.state).toBe("TASK_STATE_COMPLETED");
    expect(usageOf(got.frames.response)).toEqual([{ meter: "pages", quantity: 1 }]);
  });

  it("a 0.3.0 handler answering a 0.4.0 call reports through its own ctx.reportMeter, and so does a 0.3.0 request to an A2A handler", async () => {
    const { client, server } = setup();
    server.onRequest("quote", (_input, ctx) => {
      ctx.reportMeter("lookups", 2);
      return { price: 40 };
    });
    (server as unknown as { listenInbox(): void }).listenInbox();
    const got = await client.a2a.sendMessageWithFrames(server.id, withOffering(userMsg(), "quote"));
    expect(usageOf(got.frames.response)).toEqual([{ meter: "lookups", quantity: 2 }]);

    const b = setup();
    b.server.a2a.serve((_m, ctx) => {
      ctx.reportMeter("tokens_out", 5);
      return agentMsg("hi");
    });
    const res = await b.client.request(b.server.id, "anything", {}, { timeout_ms: 2000 });
    expect(res.payload.usage).toEqual([{ meter: "tokens_out", quantity: 5 }]);
  });

  it("refuses a malformed report", async () => {
    const { client, server } = setup();
    server.a2a.serve((_m, ctx) => {
      ctx.reportMeter("Bad Name", 1);
      return agentMsg("never");
    });
    await expect(client.a2a.sendMessage(server.id, userMsg())).rejects.toBeTruthy();
  });
});

describe("Task handles that survive a restart", () => {
  function memoryState(): A2ATaskStateStore & { map: Map<string, A2ATaskState> } {
    const map = new Map<string, A2ATaskState>();
    return {
      map,
      save: (s) => void map.set(s.task.id, JSON.parse(JSON.stringify(s))),
      load: (id) => map.get(id) ?? null,
      remove: (id) => void map.delete(id),
    };
  }

  it("taskState: a restarted agent takes up the Task, its order of changes and its open stream, and finishes it", async () => {
    bus = makeBus();
    const client = bus.agent();
    const kp = nkeys.createUser();
    const first = bus.agent(kp);
    const state = memoryState();
    first.a2a.serve((_m, ctx) => ctx.startTask({ state: "TASK_STATE_WORKING" }), { taskState: state });
    const stream = client.a2a.sendStreamingMessage(first.id, userMsg(), { idleResyncMs: 60_000 });
    const it = stream[Symbol.asyncIterator]();
    const ev0 = (await it.next()).value as StreamResponse;
    const taskId = ev0.task!.id;
    await waitFor(() => state.map.get(taskId)?.streams.length === 1);
    const saved = state.map.get(taskId)!;
    expect(saved).toMatchObject({ requester: client.id, version: 0, task: { id: taskId, status: { state: "TASK_STATE_WORKING" } } });

    // The restart: the old node goes, a new one with the same key comes up.
    await first.close();
    const second = bus.agent(kp);
    second.a2a.serve(() => undefined, { taskState: state });
    expect(second.a2a.task(taskId)).toBeUndefined();
    const handle = await second.a2a.taskHandle(taskId);
    expect(handle?.id).toBe(taskId);
    handle!.complete("finished after the restart");

    // The open stream goes on under its own id, with the next seq, and ends.
    const frame = bus.log.filter((l) => l.subject === `mesh.task.${taskId}.stream`).at(-1)!.env;
    expect(frame).toMatchObject({ from: kp.getPublicKey(), to: client.id });
    expect((frame.payload as { a2a: Record<string, unknown> }).a2a).toMatchObject({ streamId: saved.streams[0]!.id, seq: 1, final: true, result: { statusUpdate: { status: { state: "TASK_STATE_COMPLETED" } } } });
    const update = bus.log.filter((l) => l.subject === `mesh.task.${taskId}.update`).at(-1)!.env;
    expect((update.payload as { a2a: { seq: number } }).a2a.seq).toBe(1);
    expect(update.from).toBe(kp.getPublicKey());
    // Finished: its saved state goes.
    await waitFor(() => !state.map.has(taskId));
  });

  it("without saved state, the handle is rebuilt from the mesh's task store, which answers the Task's own agent", async () => {
    const { client, server } = setup();
    const svc = nkeys.createUser();
    const stored: Task = { id: "from-store", contextId: "c", status: { state: "TASK_STATE_WORKING", timestamp: "2026-11-07T00:00:00Z" } };
    const asks: Envelope[] = [];
    bus.service(A2A_STORE_SUBJECTS.GET, (req) => {
      asks.push(req);
      const p = req.payload as { id?: string; frame?: unknown };
      const ok = p.frame === undefined && p.id === stored.id && req.from === server.id;
      return signEnvelope(
        createEnvelope({
          type: "respond",
          from: svc.getPublicKey(),
          in_reply_to: req.id,
          ...(ok ? { payload: { task: stored, seq: 4, requester: client.id } } : { error: new A2AError("TaskNotFoundError", "No task with that id.").toErrorObject() }),
        }),
        svc,
      );
    });
    server.a2a.serve(() => undefined);
    const handle = await server.a2a.taskHandle("from-store");
    expect(handle?.task.status.state).toBe("TASK_STATE_WORKING");
    handle!.complete();
    const update = bus.log.filter((l) => l.subject === "mesh.task.from-store.update").at(-1)!.env;
    expect(update.to).toBe(client.id);
    expect((update.payload as { a2a: { seq: number } }).a2a.seq).toBe(5);
    expect(await server.a2a.taskHandle("unknown")).toBeUndefined();
    expect(asks.every((a) => (a.payload as { frame?: unknown }).frame === undefined)).toBe(true);
  });

  it("keeps only the newest finished Tasks in memory (keepFinished)", async () => {
    const { client, server } = setup();
    server.a2a.serve((_m, ctx) => {
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      t.complete("ok");
      return t;
    }, { keepFinished: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await client.a2a.sendMessage(server.id, userMsg())).task!.id);
    // A Task still running is never dropped.
    server.a2a.serve((_m, ctx) => ctx.startTask({ state: "TASK_STATE_WORKING" }), { keepFinished: 2 });
    const running = (await client.a2a.sendMessage(server.id, userMsg())).task!.id;
    await tick();
    const held = (server as unknown as { a2aServer(): { tasks(): Task[] } }).a2aServer().tasks().map((t) => t.id).sort();
    expect(held).toEqual([ids[2]!, ids[3]!, running].sort());
  });
});

describe("the fixture's extension block", () => {
  it("lists only URIs the SDK knows, each under its own name", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const F = JSON.parse(readFileSync(join(here, "..", "..", "..", "conformance", "a2a-binding.json"), "utf8")) as { extensions: Record<string, string> };
    const known: Record<string, string> = {
      offering: EXT_OFFERING,
      budget: EXT_BUDGET,
      audience: EXT_AUDIENCE,
      economics: EXT_ECONOMICS,
      artifactRefs: EXT_ARTIFACT_REFS,
      cancel: EXT_CANCEL,
      failure: EXT_FAILURE,
      trial: EXT_TRIAL,
      reply: EXT_REPLY,
    };
    for (const [name, uri] of Object.entries(F.extensions)) expect([name, uri]).toEqual([name, known[name]]);
  });
});
