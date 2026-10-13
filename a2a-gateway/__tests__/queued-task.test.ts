/**
 * A2A is synchronous HTTP; the mesh is not. An agent with a person in the
 * loop answers a message hours later, and its node says so at once with the
 * §6.4a queued acknowledgement. The gateway turns that into what A2A has for
 * "received, nothing has happened yet": a task in `submitted`, which the
 * caller polls, and which the agent's late reply completes.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { fakeConnect, manifestFixture, sendMessageBody, type FakeMesh } from "./helpers.js";
import { MeshError, ErrorCode } from "../../sdk-typescript/src/types/errors.js";

const RESPONDER = "UAGENTPUBKEY";
const REQUEST_ID = "01a081de-a9ce-7000-8298-d804c04390cf";

function queuedAck(): never {
  throw new MeshError(ErrorCode.REQUEST_QUEUED, "queued for an attended session", {
    retryable: false,
    details: { queued: true, inbox_id: "inbox-7", request_id: REQUEST_ID },
  });
}

describe("a queued message is a submitted task, completed by the late reply", () => {
  const open: Server[] = [];
  afterEach(() => {
    while (open.length) {
      const s = open.pop()!;
      try {
        s.closeAllConnections?.();
      } catch {
        /* older node */
      }
      s.close();
    }
  });

  async function boot(): Promise<{ mesh: FakeMesh; port: number; bridge: Bridge }> {
    const bridge = new Bridge({
      meshUrl: "ws://127.0.0.1:1",
      publicBaseUrl: "http://127.0.0.1",
      port: 0,
      apiKeys: { k1: "partner", k2: "someone-else" },
    });
    const mesh = fakeConnect(bridge, {
      discover: async () => ({ agents: [manifestFixture()], total: 1 }),
      getManifest: async (id: string) => {
        if (id !== RESPONDER) throw new Error("no such agent");
        return manifestFixture();
      },
    });
    const server = await startInboundServer(bridge);
    open.push(server);
    return { mesh, port: (server.address() as AddressInfo).port, bridge };
  }

  async function rpc(port: number, key: string, body: string): Promise<Record<string, unknown>> {
    const res = await fetch(`http://127.0.0.1:${port}/agents/${RESPONDER}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  const getTask = (taskId: string) =>
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: taskId } });

  it("SendMessage answers with a task in submitted, named by the mesh request id", async () => {
    const { mesh, port } = await boot();
    mesh.answer = queuedAck;

    const out = await rpc(port, "k1", sendMessageBody("what are you?"));
    expect(out.error).toBeUndefined();
    const task = (out.result as { task: { id: string; status: { state: string; message?: { parts: Array<{ text?: string }> } } } }).task;
    expect(task.id).toBe(REQUEST_ID);
    expect(task.status.state).toBe("submitted");
    // The status message tells the client what it is holding and what to do.
    expect(task.status.message?.parts[0]?.text).toMatch(/poll GetTask/);

    const polled = await rpc(port, "k1", getTask(REQUEST_ID));
    expect((polled.result as { task: { status: { state: string } } }).task.status.state).toBe("submitted");
  });

  it("the agent's late reply completes the task with the answer as an artifact", async () => {
    const { mesh, port } = await boot();
    mesh.answer = queuedAck;
    await rpc(port, "k1", sendMessageBody("what are you?"));

    // The reply arrives at the caller identity's inbox as a fresh request
    // whose input names the original request (the adapter's shape).
    const callerId = mesh.mintedAgentIds[0];
    const handler = mesh.defaultHandlers.get(callerId);
    expect(handler).toBeTypeOf("function");
    const ack = handler!(
      { text: "An explainer: I write short explanations.", in_reply_to: REQUEST_ID, usage: [{ meter: "tokens_out", quantity: 9 }] },
      { envelope: { from: RESPONDER } },
    );
    expect(ack).toEqual({ received: true });

    const polled = await rpc(port, "k1", getTask(REQUEST_ID));
    const task = (polled.result as {
      task: { status: { state: string; message?: { parts: Array<{ text?: string }> } }; artifacts?: Array<{ name?: string; parts: Array<{ text?: string }> }> };
    }).task;
    expect(task.status.state).toBe("completed");
    expect(task.artifacts).toHaveLength(1);
    expect(task.artifacts![0].parts).toEqual([{ text: "An explainer: I write short explanations." }]);
    // The bookkeeping the adapter sends beside the answer is not the answer.
    expect(JSON.stringify(task)).not.toContain("tokens_out");
  });

  it("reads the answer from the verbatim envelope, not the framed copy the SDK hands a handler", async () => {
    const { mesh, port } = await boot();
    mesh.answer = queuedAck;
    await rpc(port, "k1", sendMessageBody("what are you?"));
    const framed = ["=== agentmesh message ===", "from: agent UAGENTPUBKEY", "--- BEGIN SENDER MESSAGE ---", "the words", "--- END SENDER MESSAGE ---"].join("\n");
    mesh.defaultHandlers.get(mesh.mintedAgentIds[0])!(
      { text: framed, in_reply_to: REQUEST_ID },
      { envelope: { from: RESPONDER, payload: { offering: "chat", input: { text: "the words", in_reply_to: REQUEST_ID } } } },
    );
    const polled = await rpc(port, "k1", getTask(REQUEST_ID));
    const task = (polled.result as { task: { status: { state: string }; artifacts?: Array<{ parts: Array<{ text?: string }> }> } }).task;
    expect(task.status.state).toBe("completed");
    expect(task.artifacts![0].parts).toEqual([{ text: "the words" }]);
  });

  it("a refusal from the agent fails the task and says why", async () => {
    const { mesh, port } = await boot();
    mesh.answer = queuedAck;
    await rpc(port, "k1", sendMessageBody("what are you?"));
    mesh.defaultHandlers.get(mesh.mintedAgentIds[0])!(
      { text: "", in_reply_to: REQUEST_ID, error: { code: "REFUSED", message: "Not something I answer." } },
      { envelope: { from: RESPONDER } },
    );
    const polled = await rpc(port, "k1", getTask(REQUEST_ID));
    const task = (polled.result as { task: { status: { state: string; message?: { parts: Array<{ text?: string }> } }; artifacts?: unknown[] } }).task;
    expect(task.status.state).toBe("failed");
    expect(task.status.message?.parts[0]?.text).toBe("Not something I answer.");
    expect(task.artifacts).toBeUndefined();
  });

  it("only the agent the message was queued at can complete it; anything else is refused by name", async () => {
    const { mesh, port } = await boot();
    mesh.answer = queuedAck;
    await rpc(port, "k1", sendMessageBody("what are you?"));
    const handler = mesh.defaultHandlers.get(mesh.mintedAgentIds[0])!;

    // A third party threading the task id.
    expect(() => handler({ text: "gotcha", in_reply_to: REQUEST_ID }, { envelope: { from: "UIMPOSTOR" } })).toThrow(MeshError);
    // An ordinary request to a caller identity: it takes none.
    expect(() => handler({ text: "hello?" }, { envelope: { from: RESPONDER } })).toThrow(/takes no requests of its own/);
    // A reply naming a task nobody queued.
    expect(() => handler({ text: "late", in_reply_to: "never-asked" }, { envelope: { from: RESPONDER } })).toThrow(MeshError);

    const polled = await rpc(port, "k1", getTask(REQUEST_ID));
    expect((polled.result as { task: { status: { state: string } } }).task.status.state).toBe("submitted");
  });

  it("tasks stay caller-scoped: another key's GetTask finds nothing", async () => {
    const { mesh, port } = await boot();
    mesh.answer = queuedAck;
    await rpc(port, "k1", sendMessageBody("what are you?"));
    const other = await rpc(port, "k2", getTask(REQUEST_ID));
    expect((other.error as { code: number }).code).toBe(-32001);
  });
});
