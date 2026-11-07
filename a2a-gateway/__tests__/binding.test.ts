/**
 * The gateway's A2A binding path (MAPPING.md §4.1; bindings/a2a.md §13): an
 * HTTP A2A caller reaches a mesh agent served by the SDK's `mesh.a2a.serve`,
 * and the A2A objects pass between JSON-RPC (or HTTP+JSON) and 0.4.0 frames
 * unchanged. The bridge's node hosts real SDK agents on an in-memory bus.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fromSeed } from "nkeys.js";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { manifestToCard } from "../src/core/card.js";
import { manifestFixture } from "./helpers.js";
import { makeBus, type Bus } from "../../sdk-typescript/__tests__/unit/a2a-bus.js";
import { A2A_BINDING_URI } from "../../sdk-typescript/src/a2a/binding.js";
import type { AgentMesh } from "../../sdk-typescript/src/mesh.js";
import type { Manifest } from "../../sdk-typescript/src/types/manifest.js";

const open: Server[] = [];
let bus: Bus;
afterEach(async () => {
  while (open.length) {
    const s = open.pop()!;
    s.closeAllConnections?.();
    s.close();
  }
  await bus?.close();
});

/** A bridge whose node mints real SDK agents on the bus, in front of one
 *  mesh agent that serves A2A (or, with `binding: false`, does not). */
async function gateway(serve: (agent: AgentMesh) => void, binding = true) {
  bus = makeBus();
  const target = bus.agent();
  serve(target);
  const manifest: Manifest = manifestFixture({
    id: target.id,
    endpoint: `mesh.agent.${target.id}.inbox`,
    capabilities: binding ? [A2A_BINDING_URI] : ["echo"],
  });
  const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, apiKeys: { k1: "partner" } });
  const internals = bridge as unknown as { node: unknown; courier: unknown };
  internals.node = {
    id: "UNODEFAKEFAKEFAKEFAKE",
    addAgent: (opts?: { nkeySeed?: string }) =>
      bus.agent(opts?.nkeySeed ? (fromSeed(new TextEncoder().encode(opts.nkeySeed)) as never) : undefined),
    removeAgent: async () => true,
    drain: async () => undefined,
    startHeartbeat: () => undefined,
  };
  internals.courier = {
    discover: async () => ({ agents: [manifest], total: 1 }),
    getManifest: async (id: string) => {
      if (id !== target.id) throw new Error("no such agent");
      return manifest;
    },
  };
  const server = await startInboundServer(bridge);
  open.push(server);
  const port = (server.address() as AddressInfo).port;
  const rpc = async (method: string, params: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/agents/${target.id}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer k1", "A2A-Version": "1.0", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
    });
    return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
  };
  return { target, manifest, port, rpc };
}

const message = (text: string, extra: Record<string, unknown> = {}) => ({ messageId: `m-${Math.random()}`, role: "ROLE_USER", parts: [{ text }], ...extra });

describe("JSON-RPC to a binding agent", () => {
  it("passes SendMessage through: the A2A Message comes back unchanged", async () => {
    const { rpc } = await gateway((a) =>
      a.a2a.serve((m) => ({ messageId: "r1", role: "ROLE_AGENT", parts: [{ text: `echo ${m.parts[0].text}` }], metadata: { k: 1 } })),
    );
    const res = await rpc("SendMessage", { message: message("hi") });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { message: { messageId: "r1", role: "ROLE_AGENT", parts: [{ text: "echo hi" }], metadata: { k: 1 } } },
    });
    const frame = bus.log.find((l) => l.env.type === "request" && (l.env.payload as { a2a?: unknown }).a2a)!.env;
    expect(frame.v).toBe("0.4.0");
    expect((frame.payload as { a2a: { params: { message: { parts: unknown } } } }).a2a.params.message.parts).toEqual([{ text: "hi" }]);
  });

  it("a Task, then GetTask, ListTasks and CancelTask, with A2A 1.0 state names", async () => {
    const { rpc } = await gateway((a) => a.a2a.serve((_m, ctx) => ctx.startTask({ state: "TASK_STATE_WORKING" })));
    const sent = JSON.parse((await rpc("SendMessage", { message: message("go") })).text);
    const id = sent.result.task.id;
    expect(sent.result.task.status.state).toBe("TASK_STATE_WORKING");
    const got = JSON.parse((await rpc("GetTask", { id })).text);
    expect(got.result.id).toBe(id);
    const list = JSON.parse((await rpc("ListTasks", {})).text);
    expect(list.result.tasks.map((t: { id: string }) => t.id)).toEqual([id]);
    const canceled = JSON.parse((await rpc("CancelTask", { id })).text);
    expect(canceled.result.status.state).toBe("TASK_STATE_CANCELED");
    const again = JSON.parse((await rpc("CancelTask", { id })).text);
    expect(again.error.code).toBe(-32002);
  });

  it("maps the binding's errors by their JSON-RPC integers", async () => {
    const { rpc } = await gateway((a) => a.a2a.serve(() => undefined));
    expect(JSON.parse((await rpc("GetTask", { id: "nope" })).text).error.code).toBe(-32001);
    expect(JSON.parse((await rpc("CreateTaskPushNotificationConfig", { taskId: "t", url: "https://x.example/h" })).text).error.code).toBe(-32003);
    expect(JSON.parse((await rpc("GetExtendedAgentCard", {})).text).error.code).toBe(-32007);
  });

  it("streams SendStreamingMessage as Server-Sent Events of the A2A stream events", async () => {
    const { rpc } = await gateway((a) =>
      a.a2a.serve(async (_m, ctx) => {
        const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
        t.artifact({ artifactId: "a", parts: [{ text: "x" }] });
        t.complete("done");
        return t;
      }),
    );
    const res = await rpc("SendStreamingMessage", { message: message("go") });
    expect(res.type).toContain("text/event-stream");
    const events = res.text
      .split("\n\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)).result);
    const last = events.at(-1);
    expect(last.statusUpdate?.status.state ?? last.task?.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("an agent on the 0.3.0 wire keeps the translation, and ListTasks stays unsupported for it", async () => {
    const { rpc } = await gateway((a) => a.onRequest("echo", (input) => input), false);
    const list = JSON.parse((await rpc("ListTasks", {})).text);
    expect(list.error.code).toBe(-32004);
  });
});

describe("HTTP+JSON to a binding agent", () => {
  it("GET /tasks with query parameters is ListTasks", async () => {
    const { port, target, rpc } = await gateway((a) =>
      a.a2a.serve((m, ctx) => {
        const t = ctx.startTask({ contextId: m.contextId });
        t.complete();
        return t;
      }),
    );
    await rpc("SendMessage", { message: message("a", { contextId: "c1" }) });
    await rpc("SendMessage", { message: message("b", { contextId: "c2" }) });
    const res = await fetch(`http://127.0.0.1:${port}/agents/${target.id}/tasks?contextId=c1&pageSize=10`, {
      headers: { Authorization: "Bearer k1", "A2A-Version": "1.0" },
    });
    const body = (await res.json()) as { tasks: Array<{ contextId: string }>; totalSize: number };
    expect(res.status).toBe(200);
    expect(body.totalSize).toBe(1);
    expect(body.tasks[0].contextId).toBe("c1");
  });
});

describe("generated cards (§3)", () => {
  it("list the binding with the mesh home, /agents/ and the agent, and the binding's extensions", () => {
    const m = manifestFixture({ capabilities: [A2A_BINDING_URI] });
    const card = manifestToCard(m, "https://a2a.mesh.example.com", { apiKey: true, anonymous: false }, "https://api.mesh.example.com");
    expect(card.supportedInterfaces).toContainEqual({
      url: `https://api.mesh.example.com/agents/${m.id}`,
      protocolBinding: A2A_BINDING_URI,
      protocolVersion: "1.0",
    });
    expect(card.capabilities.pushNotifications).toBe(false);
    const uris = (card.capabilities.extensions ?? []).map((e) => e.uri);
    expect(uris).toContain("https://agentmessaging.ai/extensions/budget/v1");
    expect(uris).toContain("https://agentmessaging.ai/extensions/cancel/v1");
    const plain = manifestToCard(manifestFixture(), "https://a2a.mesh.example.com", { apiKey: true, anonymous: false }, "https://api.mesh.example.com");
    expect(plain.supportedInterfaces.map((i) => i.protocolBinding)).toEqual(["JSONRPC", "HTTP+JSON"]);
  });
});
