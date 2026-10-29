/**
 * The conversation over A2A (EXT-14 §7, MAPPING.md §5) and the knock (EXT-14
 * §8).
 *
 * An agent that asks for more input pauses its task in input_required; the
 * A2A caller sees that on GetTask and answers on the same task, and the
 * gateway sends the answer as the follow-up request on the same mesh task.
 * `exhausted` maps to `canceled` and says so in the task's metadata. A first
 * contact the mesh's door holds is a task in auth-required that says how to
 * be let in, and a knock carries no words.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createUser } from "nkeys.js";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { OVER_A2A_URI } from "../src/core/over-a2a.js";
import { meshStateToA2A } from "../src/core/states.js";
import { fakeConnect, manifestFixture, type FakeMesh, type FakeRequest } from "./helpers.js";
import { createEnvelope } from "../../sdk-typescript/src/internal/envelope-builder.js";
import { signEnvelope, keyPairFromSeed } from "../../sdk-typescript/src/internal/identity.js";
import { Subjects } from "../../sdk-typescript/src/internal/subjects.js";
import { MeshError, ErrorCode } from "../../sdk-typescript/src/types/errors.js";
import type { Envelope } from "../../sdk-typescript/src/types/envelope.js";

const kp = () => keyPairFromSeed(new TextDecoder().decode(createUser().getSeed()));
const agent = kp();
const door = kp();
const caller = kp();
const AGENT = agent.getPublicKey();
const manifest = () => manifestFixture({ id: AGENT, offerings: [{ id: "quote", name: "Quote", description: "Quotes a price" }] });

describe("the conversation and the knock", () => {
  const open: Server[] = [];
  afterEach(() => {
    while (open.length) {
      const s = open.pop()!;
      s.closeAllConnections?.();
      s.close();
    }
  });

  async function boot(): Promise<{ mesh: FakeMesh; port: number }> {
    const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, apiKeys: { k1: "partner", k2: "other" } });
    const mesh = fakeConnect(bridge, { discover: async () => ({ agents: [manifest()], total: 1 }), getManifest: async () => manifest() });
    const server = await startInboundServer(bridge);
    open.push(server);
    return { mesh, port: (server.address() as AddressInfo).port };
  }

  async function rpc(port: number, method: string, params: unknown, key = "k1"): Promise<Record<string, any>> {
    const res = await fetch(`http://127.0.0.1:${port}/agents/${AGENT}/rpc`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return (await res.json()) as Record<string, any>;
  }
  const say = (text: string, extra: Record<string, unknown> = {}) => ({ message: { role: "ROLE_USER", parts: [{ text }], ...extra } });

  it("the caller sees input-required and its answer goes to the same mesh task", async () => {
    const { mesh, port } = await boot();
    mesh.answer = (req: FakeRequest) =>
      req.config && (req.config as { task_id?: string }).task_id
        ? { task_id: "t-1", payload: { status: "completed", output: { text: "40 chairs, delivered: 1,260 USD" } }, envelope: { id: "e-2", from: AGENT } }
        : { task_id: "t-1", payload: { status: "working" }, envelope: { id: "e-1", from: AGENT, context_id: "ctx-1" } };
    const first = await rpc(port, "SendMessage", say("Quote for 40 chairs"));
    expect(first.result.task).toMatchObject({ id: "t-1", contextId: "ctx-1", status: { state: "working" } });

    // The agent pauses for input; the caller's GetTask says so, with its question.
    mesh.liveTasks.set("t-1", { state: "input_required", history: [{ id: "u-1", payload: { status: "input_required", message: "Which delivery date?" } }] });
    const waiting = await rpc(port, "GetTask", { id: "t-1" });
    expect(waiting.result.task.status.state).toBe("input-required");
    expect(waiting.result.task.status.message.parts[0].text).toBe("Which delivery date?");

    // The answer, on the same task.
    const answered = await rpc(port, "SendMessage", say("By 14 November", { taskId: "t-1", contextId: "ctx-1" }));
    const followUp = mesh.requests[1];
    expect(followUp.offering).toBe("quote");
    expect(followUp.input).toEqual({ text: "By 14 November" });
    expect(followUp.config).toMatchObject({ task_id: "t-1", context_id: "ctx-1" });
    expect(followUp.config?.meta?.identity_bridge).toBeDefined();
    expect(answered.result.task.status.state).toBe("completed");
    expect(answered.result.task.status.message.parts).toEqual([{ text: "40 chairs, delivered: 1,260 USD" }]);
  });

  it("a first answer that already asks for input carries the agent's question, and GetTask keeps it", async () => {
    const { mesh, port } = await boot();
    mesh.answer = () => ({ task_id: "t-5", payload: { status: "input_required", message: "Which delivery date?" }, envelope: { id: "e-5", from: AGENT } });
    const first = await rpc(port, "SendMessage", say("Quote for 40 chairs"));
    expect(first.result.task.status).toMatchObject({ state: "input-required", message: { parts: [{ text: "Which delivery date?" }] } });
    mesh.liveTasks.set("t-5", { state: "input_required", history: [] });
    const got = await rpc(port, "GetTask", { id: "t-5" });
    expect(got.result.task.status.message.parts[0].text).toBe("Which delivery date?");
  });

  it("refuses an answer on a task that is not waiting, on another caller's task, or with a mismatched context", async () => {
    const { mesh, port } = await boot();
    mesh.answer = () => ({ task_id: "t-2", payload: { status: "working" }, envelope: { id: "e-1", from: AGENT, context_id: "ctx-2" } });
    await rpc(port, "SendMessage", say("Quote"));
    const notWaiting = await rpc(port, "SendMessage", say("x", { taskId: "t-2" }));
    expect(notWaiting.error.data.agentmesh_code).toBe("TASK_INVALID_TRANSITION");
    mesh.liveTasks.set("t-2", { state: "input_required" });
    expect((await rpc(port, "SendMessage", say("x", { taskId: "t-2" }), "k2")).error.code).toBe(-32001);
    expect((await rpc(port, "SendMessage", say("x", { taskId: "nope" }))).error.code).toBe(-32001);
    expect((await rpc(port, "SendMessage", say("x", { taskId: "t-2", contextId: "other" }))).error.code).toBe(-32602);
    expect(mesh.requests).toHaveLength(1);
  });

  it("exhausted maps to canceled and says so in the task's metadata", async () => {
    expect(meshStateToA2A("exhausted")).toBe("canceled");
    const { mesh, port } = await boot();
    mesh.answer = () => ({ task_id: "t-3", payload: { status: "working" }, envelope: { id: "e-1", from: AGENT } });
    await rpc(port, "SendMessage", say("Quote"));
    mesh.liveTasks.set("t-3", { state: "exhausted" });
    const got = await rpc(port, "GetTask", { id: "t-3" });
    expect(got.result.task.status.state).toBe("canceled");
    expect(got.result.task.metadata["agentmesh.state"]).toBe("exhausted");
  });

  it("a signed task's exhausted update says so too", async () => {
    const { mesh, port } = await boot();
    const req = signEnvelope(createEnvelope({ type: "request", from: caller.getPublicKey(), to: AGENT, payload: { offering: "quote", input: {} } }), caller);
    const iv = setInterval(() => {
      if (!mesh.relayed[0]) return;
      clearInterval(iv);
      mesh.deliver(Subjects.agentInbox(caller.getPublicKey()), signEnvelope(createEnvelope({ type: "respond", from: AGENT, to: caller.getPublicKey(), in_reply_to: req.id, task_id: "t-4", payload: { status: "working" } }), agent));
    }, 5);
    await rpc(port, "SendMessage", { message: { role: "ROLE_USER", parts: [], extensions: [OVER_A2A_URI], metadata: { [OVER_A2A_URI]: { envelope: req } } } });
    mesh.deliver(Subjects.taskUpdate("t-4"), signEnvelope(createEnvelope({ type: "respond", from: AGENT, to: caller.getPublicKey(), task_id: "t-4", payload: { status: "exhausted" } }), agent));
    const got = await rpc(port, "GetTask", { id: "t-4" });
    expect(got.result.task.status.state).toBe("canceled");
    expect(got.result.task.metadata["agentmesh.state"]).toBe("exhausted");
  });

  it("a first contact the mesh's door holds is auth-required with a note on how to be let in", async () => {
    const { mesh, port } = await boot();
    mesh.answer = (req: FakeRequest) => {
      const onQueued = (req.config as { onQueued?: (ack: unknown, env: unknown) => void }).onQueued;
      onQueued?.({ queued: true, inbox_id: "i-1" }, { from: door.getPublicKey() });
      throw new MeshError(ErrorCode.REQUEST_QUEUED, "queued", { details: { queued: true, inbox_id: "i-1", request_id: "r-1" } });
    };
    const out = await rpc(port, "SendMessage", say("Quote for 40 chairs"));
    expect(out.result.task).toMatchObject({ id: "r-1", status: { state: "auth-required" }, metadata: { "agentmesh.admission": "held" } });
    expect(out.result.task.status.message.parts[0].text).toMatch(/has not let you in/);
  });

  it("a hold at the agent's own door gets the same answer as the mesh's door", async () => {
    const { mesh, port } = await boot();
    mesh.answer = (req: FakeRequest) => {
      (req.config as { onQueued?: (ack: unknown, env: unknown) => void }).onQueued?.({ queued: true, inbox_id: "i-1" }, { from: AGENT, payload: { status: "completed", output: { queued: true, inbox_id: "i-1", text: "Sent; it reaches Quote if Quote admits you." } } });
      throw new MeshError(ErrorCode.REQUEST_QUEUED, "queued", { details: { queued: true, inbox_id: "i-1", request_id: "r-3" } });
    };
    const out = await rpc(port, "SendMessage", say("Quote"));
    expect(out.result.task.status.state).toBe("auth-required");
    expect(out.result.task.metadata["agentmesh.admission"]).toBe("held");
  });

  it("a message put in the agent's inbox stays a submitted task", async () => {
    const { mesh, port } = await boot();
    mesh.answer = (req: FakeRequest) => {
      (req.config as { onQueued?: (ack: unknown, env: unknown) => void }).onQueued?.({ queued: true, inbox_id: "i-1" }, { from: AGENT, payload: { status: "completed", output: { queued: true, inbox_id: "i-1", delivered: true } } });
      throw new MeshError(ErrorCode.REQUEST_QUEUED, "queued", { details: { queued: true, inbox_id: "i-1", request_id: "r-2" } });
    };
    expect((await rpc(port, "SendMessage", say("Quote"))).result.task.status.state).toBe("submitted");
  });

  it("a knock carries no words, and gets the same answer unless the caller is let in", async () => {
    const { mesh, port } = await boot();
    const knock = (k: unknown) => rpc(port, "SendMessage", say("Please let me in, I have a great offer", { extensions: [OVER_A2A_URI], metadata: { [OVER_A2A_URI]: { knock: k } } }));
    mesh.answer = () => ({ task_id: null, payload: { status: "completed", output: { received: true } }, envelope: { id: "e-k", from: AGENT } });
    const waiting = await knock({ via: "example.com quote desk" });
    expect(mesh.requests[0]).toMatchObject({ offering: "knock", input: { via: "example.com quote desk", grants: [] } });
    expect(JSON.stringify(mesh.requests[0].input)).not.toMatch(/great offer/);
    expect(waiting.result.task.status.state).toBe("auth-required");
    expect(waiting.result.task.metadata["agentmesh.admission"]).toBe("knocked");

    // Held, blocked or no such agent: the same answer.
    mesh.answer = () => {
      throw new MeshError(ErrorCode.REQUEST_QUEUED, "queued", { details: { queued: true, inbox_id: "i", request_id: "r" } });
    };
    expect((await knock({})).result.task.status.message.parts[0].text).toBe(waiting.result.task.status.message.parts[0].text);

    // Let in: a message that says so.
    mesh.answer = () => ({ task_id: null, payload: { status: "completed", output: { received: true, admitted: true, extensions: [] } }, envelope: { id: "e-k2", from: AGENT } });
    expect((await knock({})).result.message.parts[0].data).toEqual({ admitted: true, extensions: [] });

    // Words in a knock are refused before anything is sent.
    const n = mesh.requests.length;
    expect((await knock({ text: "hello" })).error.data.agentmesh_code).toBe("KNOCK_CARRIES_NO_MESSAGE");
    expect(mesh.requests).toHaveLength(n);
  });

  it("a signed knock is relayed, and a door that holds answers auth-required", async () => {
    const { mesh, port } = await boot();
    const k = signEnvelope(createEnvelope({ type: "request", from: caller.getPublicKey(), to: AGENT, payload: { offering: "knock", input: {} } }), caller);
    const iv = setInterval(() => {
      if (!mesh.relayed[0]) return;
      clearInterval(iv);
      mesh.deliver(Subjects.agentInbox(caller.getPublicKey()), signEnvelope(createEnvelope({ type: "respond", from: AGENT, to: caller.getPublicKey(), in_reply_to: k.id, payload: { status: "completed", output: { received: true } } }), agent));
    }, 5);
    const out = await rpc(port, "SendMessage", { message: { role: "ROLE_USER", parts: [], extensions: [OVER_A2A_URI], metadata: { [OVER_A2A_URI]: { envelope: k } } } });
    expect((mesh.relayed[0] as unknown as Envelope).id).toBe(k.id);
    expect(out.result.task.status.state).toBe("auth-required");
  });
});
