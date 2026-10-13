/**
 * The A2A 1.0 HTTP+JSON binding (A2A §11; BRIDGE-A2A.md §13), through the real
 * HTTP surface. Each case names the A2A section it comes from. The JSON-RPC
 * route's own tests stay as they were: both bindings share one handler, and
 * the existing suite is what proves JSON-RPC did not change.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { matchRestRoute, rpcErrorToRest, stateEnum, withEnumStates, A2A_REASONS } from "../src/core/httpjson.js";
import { RpcCode } from "../src/core/jsonrpc.js";
import { MeshError, ErrorCode } from "../../sdk-typescript/src/types/errors.js";
import { fakeConnect, manifestFixture, type FakeMesh } from "./helpers.js";

const open: Server[] = [];
afterEach(() => {
  while (open.length) {
    const s = open.pop()!;
    s.closeAllConnections?.();
    s.close();
  }
});

const KEY = "test-key";
const AUTH = { Authorization: `Bearer ${KEY}` };

async function start(config: Partial<ConstructorParameters<typeof Bridge>[0]> = {}): Promise<{ base: string; mesh: FakeMesh; agent: string }> {
  const bridge = new Bridge({
    meshUrl: "ws://127.0.0.1:1",
    publicBaseUrl: "http://127.0.0.1",
    port: 0,
    apiKeys: { [KEY]: "tests" },
    ...config,
  });
  const mesh = fakeConnect(bridge, {
    discover: async () => ({ agents: [manifestFixture()], total: 1 }),
    getManifest: async (id: string) => {
      if (id === "UAGENTPUBKEY") return manifestFixture();
      if (id === "UMESHONLY") return manifestFixture({ id: "UMESHONLY", public: {} as never });
      throw new Error("no such agent");
    },
  });
  const server = await startInboundServer(bridge);
  open.push(server);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, mesh, agent: `http://127.0.0.1:${port}/agents/UAGENTPUBKEY` };
}

const sendBody = (text = "hello") => JSON.stringify({ message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text }] } });

async function reason(res: Response): Promise<{ reason: string; domain: string; code: number; status: string; metadata?: Record<string, string> }> {
  const body = (await res.json()) as { error: { code: number; status: string; details: Array<{ reason: string; domain: string; metadata?: Record<string, string> }> } };
  return { ...body.error.details[0], code: body.error.code, status: body.error.status };
}

describe("routes (A2A §11.3)", () => {
  it("matches every operation by method and path", () => {
    expect(matchRestRoute("POST", ["message:send"])).toEqual({ route: { op: "send" } });
    expect(matchRestRoute("POST", ["message%3Asend"])).toEqual({ route: { op: "send" } });
    expect(matchRestRoute("POST", ["message:stream"])).toEqual({ route: { op: "stream" } });
    expect(matchRestRoute("GET", ["tasks", "t-1"])).toEqual({ route: { op: "getTask", id: "t-1" } });
    expect(matchRestRoute("POST", ["tasks", "t-1:cancel"])).toEqual({ route: { op: "cancelTask", id: "t-1" } });
    expect(matchRestRoute("POST", ["tasks", "t-1:subscribe"])).toEqual({ route: { op: "subscribe", id: "t-1" } });
    expect(matchRestRoute("GET", ["tasks"])).toEqual({ route: { op: "listTasks" } });
    expect(matchRestRoute("POST", ["tasks", "t-1", "pushNotificationConfigs"])).toEqual({ route: { op: "push" } });
    expect(matchRestRoute("DELETE", ["tasks", "t-1", "pushNotificationConfigs", "c-1"])).toEqual({ route: { op: "push" } });
    expect(matchRestRoute("GET", ["extendedAgentCard"])).toEqual({ route: { op: "extendedCard" } });
  });

  it("tells a known path with the wrong method from an unknown path", () => {
    expect(matchRestRoute("GET", ["message:send"])).toEqual({ methodNotAllowed: true });
    expect(matchRestRoute("POST", ["tasks"])).toEqual({ methodNotAllowed: true });
    expect(matchRestRoute("DELETE", ["tasks", "t-1", "pushNotificationConfigs"])).toEqual({ methodNotAllowed: true });
    expect(matchRestRoute("POST", ["tasks", "t-1", "pushNotificationConfigs", "c-1"])).toEqual({ methodNotAllowed: true });
    expect(matchRestRoute("GET", ["nothing"])).toBeNull();
    expect(matchRestRoute("POST", ["tasks", "t-1:explode"])).toBeNull();
  });
});

describe("errors (A2A §5.4, §11.6)", () => {
  it("maps every A2A error code to its reason and HTTP status", () => {
    const cases: Array<[number, string, number]> = [
      [RpcCode.TASK_NOT_FOUND, "TASK_NOT_FOUND", 404],
      [RpcCode.TASK_NOT_CANCELABLE, "TASK_NOT_CANCELABLE", 400],
      [RpcCode.PUSH_NOTIFICATION_NOT_SUPPORTED, "PUSH_NOTIFICATION_NOT_SUPPORTED", 400],
      [RpcCode.UNSUPPORTED_OPERATION, "UNSUPPORTED_OPERATION", 400],
      [RpcCode.CONTENT_TYPE_NOT_SUPPORTED, "CONTENT_TYPE_NOT_SUPPORTED", 400],
      [RpcCode.INVALID_AGENT_RESPONSE, "INVALID_AGENT_RESPONSE", 500],
      [RpcCode.EXTENDED_CARD_NOT_CONFIGURED, "EXTENDED_AGENT_CARD_NOT_CONFIGURED", 400],
      [RpcCode.VERSION_NOT_SUPPORTED, "VERSION_NOT_SUPPORTED", 400],
      [RpcCode.INVALID_PARAMS, "INVALID_PARAMS", 400],
      [RpcCode.INTERNAL_ERROR, "INTERNAL", 500],
    ];
    for (const [code, want, http] of cases) {
      const out = rpcErrorToRest({ code, message: "m" }, 200);
      expect(out.http, want).toBe(http);
      expect(out.body.error.code).toBe(http);
      expect(out.body.error.details[0]).toEqual({ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: want, domain: "a2a-protocol.org" });
      expect(out.body.error.status).toBe(A2A_REASONS[want as keyof typeof A2A_REASONS].status);
    }
  });

  it("keeps the transport status for an internal error and the mesh code in metadata (§7)", () => {
    const out = rpcErrorToRest({ code: RpcCode.INTERNAL_ERROR, message: "timeout", data: { agentmesh_code: "TRANSPORT_TIMEOUT" } }, 504);
    expect(out.http).toBe(504);
    expect(out.body.error.status).toBe("DEADLINE_EXCEEDED");
    expect(out.body.error.details[0].metadata).toEqual({ agentmesh_code: "TRANSPORT_TIMEOUT" });
  });

  it("sends the gateway's own refusals under agentmesh.ai, not as A2A errors (§9.1)", () => {
    const unknown = rpcErrorToRest({ code: RpcCode.INVALID_PARAMS, message: "Unknown agent", data: { agentmesh_code: "AGENT_UNAVAILABLE" } }, 200);
    expect(unknown.http).toBe(404);
    expect(unknown.body.error.details[0]).toMatchObject({ reason: "AGENT_UNAVAILABLE", domain: "agentmesh.ai" });
    const pay = rpcErrorToRest({ code: RpcCode.INTERNAL_ERROR, message: "pay", data: { agentmesh_code: "PAYMENT_REQUIRED", price_credits: 6 } }, 402);
    expect(pay.http).toBe(402);
    expect(pay.body.error.details[0]).toMatchObject({ reason: "PAYMENT_REQUIRED", domain: "agentmesh.ai", metadata: { agentmesh_code: "PAYMENT_REQUIRED", price_credits: "6" } });
    // A mesh-side AGENT_UNAVAILABLE (the agent is down) is an internal error, not the gateway's.
    const down = rpcErrorToRest({ code: RpcCode.INTERNAL_ERROR, message: "down", data: { agentmesh_code: "AGENT_UNAVAILABLE" } }, 502);
    expect(down.http).toBe(502);
    expect(down.body.error.details[0]).toMatchObject({ reason: "INTERNAL", domain: "a2a-protocol.org" });
  });
});

describe("enum spellings (A2A §5.5)", () => {
  it("writes task states as TASK_STATE_* names", () => {
    expect(stateEnum("input-required")).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(stateEnum("TASK_STATE_WORKING")).toBe("TASK_STATE_WORKING");
    expect(withEnumStates({ task: { id: "t", status: { state: "submitted" } } })).toEqual({ task: { id: "t", status: { state: "TASK_STATE_SUBMITTED" } } });
    expect(withEnumStates({ statusUpdate: { taskId: "t", status: { state: "completed" }, final: true } })).toEqual({
      statusUpdate: { taskId: "t", status: { state: "TASK_STATE_COMPLETED" }, final: true },
    });
  });
});

describe("POST message:send (A2A §11.3.1, §11.4)", () => {
  it("answers a Message with application/a2a+json", async () => {
    const { agent, mesh } = await start();
    mesh.answer = () => ({ task_id: null, payload: { status: "completed", output: { text: "hi back" } }, envelope: { id: "env-1" } });
    const res = await fetch(`${agent}/message:send`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/a2a+json", "A2A-Version": "1.0" }, body: sendBody() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/a2a+json");
    expect(await res.json()).toEqual({ message: { role: "ROLE_AGENT", parts: [{ text: "hi back" }], messageId: "env-1" } });
    expect(mesh.requests[0]).toMatchObject({ to: "UAGENTPUBKEY", offering: "echo", input: { text: "hello" } });
  });

  it("answers a deferred task with its state as an enum, and GET tasks/{id} reads it back", async () => {
    const { agent, mesh } = await start();
    mesh.answer = () => ({ task_id: "task-9", payload: { status: "working" }, envelope: { id: "env-2" } });
    const res = await fetch(`${agent}/message:send`, { method: "POST", headers: AUTH, body: sendBody() });
    const body = (await res.json()) as { task: { id: string; status: { state: string } } };
    expect(body.task.id).toBe("task-9");
    expect(body.task.status.state).toBe("TASK_STATE_WORKING");
    const read = await fetch(`${agent}/tasks/task-9`, { headers: AUTH });
    expect(read.status).toBe(200);
    const task = (await read.json()) as { id: string; status: { state: string } };
    expect(task.id).toBe("task-9");
    expect(task.status.state).toBe("TASK_STATE_WORKING");
  });

  it("serves a request with the colon percent-encoded", async () => {
    const { agent } = await start();
    const res = await fetch(`${agent}/message%3Asend`, { method: "POST", headers: AUTH, body: sendBody() });
    expect(res.status).toBe(200);
  });

  it("refuses a body that is not JSON with INVALID_PARAMS", async () => {
    const { agent } = await start();
    const res = await fetch(`${agent}/message:send`, { method: "POST", headers: AUTH, body: "{" });
    expect(res.status).toBe(400);
    expect((await reason(res)).reason).toBe("INVALID_PARAMS");
  });

  it("reads an A2A 1.0 url part as a file instead of dropping it", async () => {
    const { agent, mesh } = await start();
    const res = await fetch(`${agent}/message:send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        message: { role: "ROLE_USER", parts: [{ text: "see this" }, { url: "https://files.example/a.pdf", mediaType: "application/pdf", filename: "a.pdf" }] },
      }),
    });
    expect(res.status).toBe(200);
    expect(mesh.requests[0].input).toEqual({ text: "see this", files: [{ name: "a.pdf", media_type: "application/pdf", uri: "https://files.example/a.pdf" }] });
  });

  it("an A2A 1.0 raw part reaches the file store, and with none is INTERNAL rather than dropped", async () => {
    const { agent } = await start();
    const res = await fetch(`${agent}/message:send`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ message: { role: "ROLE_USER", parts: [{ raw: "aGVsbG8=", mediaType: "text/plain" }] } }),
    });
    // The fake hosted identity has no artifact store, so storing fails by name.
    expect(res.status).toBe(500);
    expect((await reason(res)).reason).toBe("INTERNAL");
  });

  it("maps a mesh timeout to INTERNAL with 504", async () => {
    const { agent, mesh } = await start();
    mesh.answer = () => {
      throw new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "no answer in time");
    };
    const res = await fetch(`${agent}/message:send`, { method: "POST", headers: AUTH, body: sendBody() });
    expect(res.status).toBe(504);
    const r = await reason(res);
    expect(r).toMatchObject({ reason: "INTERNAL", status: "DEADLINE_EXCEEDED" });
    expect(r.metadata?.agentmesh_code).toBe("TRANSPORT_TIMEOUT");
  });
});

describe("versions (A2A §3.6; BRIDGE-A2A.md §13.2)", () => {
  it("serves 1.0, and a request naming no version", async () => {
    const { agent } = await start();
    expect((await fetch(`${agent}/message:send`, { method: "POST", headers: { ...AUTH, "A2A-Version": "1.0" }, body: sendBody() })).status).toBe(200);
    expect((await fetch(`${agent}/message:send`, { method: "POST", headers: AUTH, body: sendBody() })).status).toBe(200);
    expect((await fetch(`${agent}/message:send?A2A-Version=1.0`, { method: "POST", headers: AUTH, body: sendBody() })).status).toBe(200);
  });

  it("refuses any other version with VERSION_NOT_SUPPORTED, header or query", async () => {
    const { agent } = await start();
    for (const url of [`${agent}/message:send`, `${agent}/message:send?A2A-Version=0.3`]) {
      const headers = url.includes("?") ? AUTH : { ...AUTH, "A2A-Version": "2.0" };
      const res = await fetch(url, { method: "POST", headers, body: sendBody() });
      expect(res.status).toBe(400);
      expect((await reason(res)).reason).toBe("VERSION_NOT_SUPPORTED");
    }
  });
});

describe("operations the bridge does not offer (BRIDGE-A2A.md §4.2, §13.1)", () => {
  it("answers each with its A2A error after admission", async () => {
    const { agent } = await start();
    const cases: Array<[string, string, string, number]> = [
      ["GET", "tasks/unknown-task", "TASK_NOT_FOUND", 404],
      ["POST", "tasks/unknown-task:cancel", "TASK_NOT_FOUND", 404],
      ["GET", "tasks", "UNSUPPORTED_OPERATION", 400],
      ["POST", "tasks/t-1:subscribe", "UNSUPPORTED_OPERATION", 400],
      ["GET", "tasks/t-1/pushNotificationConfigs", "PUSH_NOTIFICATION_NOT_SUPPORTED", 400],
      ["POST", "tasks/t-1/pushNotificationConfigs", "PUSH_NOTIFICATION_NOT_SUPPORTED", 400],
      ["GET", "tasks/t-1/pushNotificationConfigs/c-1", "PUSH_NOTIFICATION_NOT_SUPPORTED", 400],
      ["DELETE", "tasks/t-1/pushNotificationConfigs/c-1", "PUSH_NOTIFICATION_NOT_SUPPORTED", 400],
      ["GET", "extendedAgentCard", "EXTENDED_AGENT_CARD_NOT_CONFIGURED", 400],
    ];
    for (const [method, path, want, http] of cases) {
      const res = await fetch(`${agent}/${path}`, { method, headers: AUTH });
      expect(res.status, `${method} ${path}`).toBe(http);
      expect(res.headers.get("content-type")).toBe("application/a2a+json");
      expect((await reason(res)).reason, `${method} ${path}`).toBe(want);
    }
  });

  it("answers unknown paths 404 and wrong methods 405, with no body", async () => {
    const { agent } = await start();
    for (const [method, path, http] of [
      ["GET", "nothing-here", 404],
      ["GET", "message:send", 405],
      ["PUT", "message:send", 405],
      ["POST", "tasks", 405],
    ] as const) {
      const res = await fetch(`${agent}/${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(http);
      expect(await res.text()).toBe("");
    }
  });
});

describe("the gateway's refusals in the HTTP+JSON envelope (BRIDGE-A2A.md §13.3)", () => {
  it("no key: 401 UNAUTHORIZED under agentmesh.ai with WWW-Authenticate", async () => {
    const { agent, mesh } = await start();
    const res = await fetch(`${agent}/message:send`, { method: "POST", body: sendBody() });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await reason(res)).toMatchObject({ reason: "UNAUTHORIZED", domain: "agentmesh.ai", status: "UNAUTHENTICATED" });
    expect(mesh.requests).toHaveLength(0);
  });

  it("a mesh-only agent: 403 MESH_ONLY", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/agents/UMESHONLY/message:send`, { method: "POST", headers: AUTH, body: sendBody() });
    expect(res.status).toBe(403);
    expect(await reason(res)).toMatchObject({ reason: "MESH_ONLY", domain: "agentmesh.ai" });
  });

  it("an unknown agent: 404 AGENT_UNAVAILABLE", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/agents/UNOBODY/message:send`, { method: "POST", headers: AUTH, body: sendBody() });
    expect(res.status).toBe(404);
    expect(await reason(res)).toMatchObject({ reason: "AGENT_UNAVAILABLE", domain: "agentmesh.ai" });
  });

  it("over the rate: 429 RATE_LIMITED with Retry-After", async () => {
    const { agent } = await start({ ratePerMinute: 1 });
    await fetch(`${agent}/message:send`, { method: "POST", headers: AUTH, body: sendBody() });
    const res = await fetch(`${agent}/message:send`, { method: "POST", headers: AUTH, body: sendBody() });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await reason(res)).toMatchObject({ reason: "RATE_LIMITED", domain: "agentmesh.ai" });
  });
});

describe("POST message:stream (A2A §11.7)", () => {
  it("sends StreamResponse objects with no JSON-RPC wrapper and enum states", async () => {
    const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, apiKeys: { [KEY]: "tests" } });
    const streaming = manifestFixture({ offerings: [{ id: "echo", name: "Echo", description: "x", streaming: true }] });
    const mesh = fakeConnect(bridge, {
      discover: async () => ({ agents: [streaming], total: 1 }),
      getManifest: async () => streaming,
    });
    // The fake node has no requestStream; give the one hosted identity a stream.
    const internals = bridge as unknown as { node: { addAgent: (o?: unknown) => Record<string, unknown> } };
    const add = internals.node.addAgent;
    internals.node.addAgent = (o?: unknown) => {
      const a = add(o);
      a.requestStream = async () => ({
        task_id: "st-1",
        chunks: (async function* () {
          yield { chunk_index: 0, data: { text: "one" }, final: false };
          yield { chunk_index: 1, data: { text: "two" }, final: true };
        })(),
      });
      return a;
    };
    void mesh;
    const server = await startInboundServer(bridge);
    open.push(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/agents/UAGENTPUBKEY/message:stream`, { method: "POST", headers: AUTH, body: sendBody() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const events = (await res.text())
      .split("\n\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)));
    expect(events[0]).toEqual({ task: { id: "st-1", status: { state: "TASK_STATE_WORKING", timestamp: expect.any(String) } } });
    expect(events.some((e) => "jsonrpc" in e)).toBe(false);
    expect(events.at(-1)).toMatchObject({ statusUpdate: { taskId: "st-1", status: { state: "TASK_STATE_COMPLETED" }, final: true } });
  });
});

describe("JSON-RPC is unchanged beside it", () => {
  it("still answers SendMessage on /rpc with the JSON-RPC envelope and lowercase states", async () => {
    const { agent, mesh } = await start();
    mesh.answer = () => ({ task_id: "task-2", payload: { status: "working" }, envelope: { id: "e" } });
    const res = await fetch(`${agent}/rpc`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ text: "x" }] } } }),
    });
    const body = (await res.json()) as { jsonrpc: string; id: number; result: { task: { status: { state: string } } } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(7);
    expect(body.result.task.status.state).toBe("working");
  });
});
