/**
 * Tasks the bridge holds (MAPPING.md §4.3): when the agent's node answers a
 * binding request with a queued acknowledgement, the HTTP caller gets a Task
 * the bridge holds, id = the request frame's id, with the bridge marker's
 * `{"held": true}`; the agent's later A2A answer settles it, a Message by
 * completing it and a Task by standing behind the held id. Through JSON-RPC
 * and through the A2A project's JS client.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fromSeed } from "nkeys.js";
import { nkeys } from "nats.ws";
import { ClientFactory, ClientFactoryOptions } from "@a2a-js/sdk/client";
import { Role, TaskState } from "@a2a-js/sdk";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { BRIDGE_EXTENSION_URI } from "../src/core/card.js";
import { manifestFixture } from "./helpers.js";
import { makeBus, tick, type Bus } from "../../sdk-typescript/__tests__/unit/a2a-bus.js";
import { A2A_BINDING_URI } from "../../sdk-typescript/src/a2a/binding.js";
import { createEnvelope } from "../../sdk-typescript/src/internal/envelope-builder.js";
import { signEnvelope } from "../../sdk-typescript/src/internal/identity.js";
import { decodeUnverified, encode } from "../../sdk-typescript/src/internal/codec.js";
import { Subjects } from "../../sdk-typescript/src/internal/subjects.js";
import type { Envelope } from "../../sdk-typescript/src/types/envelope.js";

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

type Later = { message: string } | { task: string } | "never";

/**
 * A server agent's node that queues SendMessage for an attended session and
 * answers later, and answers GetTask for the Tasks it made. `later` decides
 * the late answer per message text.
 */
function queuingNode(opts: { delivered: boolean; later: (text: string) => Later }) {
  const kp = nkeys.createUser();
  const id = kp.getPublicKey();
  const tasks = new Map<string, { requester: string; task: unknown }>();
  const answer = (req: Envelope, payload: unknown, extra: Record<string, unknown> = {}) =>
    bus.publishRaw(Subjects.agentInbox(req.from), encode(signEnvelope(createEnvelope({ type: "respond", from: id, to: req.from, in_reply_to: req.id, ...extra, ...(payload !== undefined ? { payload } : {}) } as never), kp)));
  bus.conn().subscribe(Subjects.agentInbox(id), (m: { data: Uint8Array }) => {
    const req = decodeUnverified(m.data);
    if (req.type !== "request") return;
    const a2a = (req.payload as { a2a?: { method?: string; params?: Record<string, unknown> } }).a2a;
    if (a2a?.method === "GetTask") {
      const t = tasks.get(String(a2a.params?.id));
      if (t && t.requester === req.from) answer(req, { a2a: { result: t.task } }, { v: "0.4.0" });
      else answer(req, undefined, { v: "0.4.0", error: { code: "TaskNotFoundError", message: "No task with that id.", details: { a2a: { code: -32001, data: {} } }, retryable: false } });
      return;
    }
    if (a2a?.method !== "SendMessage" && a2a?.method !== "SendStreamingMessage") return;
    answer(req, { output: { queued: true, inbox_id: req.id, ...(opts.delivered ? { delivered: true } : {}) } });
    const text = String(((a2a.params?.message as { parts?: Array<{ text?: string }> })?.parts ?? [])[0]?.text ?? "");
    const later = opts.later(text);
    if (later === "never") return;
    setTimeout(() => {
      if ("message" in later) {
        answer(req, { a2a: { result: { message: { messageId: "late-1", role: "ROLE_AGENT", parts: [{ text: later.message }] } } } }, { v: "0.4.0" });
      } else {
        const task = { id: later.task, contextId: "ctx-late", status: { state: "TASK_STATE_COMPLETED", timestamp: new Date().toISOString() }, artifacts: [{ artifactId: "q", parts: [{ text: "the quote" }] }] };
        tasks.set(later.task, { requester: req.from, task });
        answer(req, { a2a: { result: { task } } }, { v: "0.4.0" });
      }
    }, 80);
  });
  return { id };
}

async function gateway(node: { id: string }, anonymous = false) {
  const manifest = manifestFixture({ id: node.id, endpoint: `mesh.agent.${node.id}.inbox`, capabilities: [A2A_BINDING_URI] });
  const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, ...(anonymous ? { allowAnonymous: true } : { apiKeys: { k1: "partner", k2: "other" } }) });
  const internals = bridge as unknown as { node: unknown; courier: unknown; config: { publicBaseUrl: string } };
  internals.node = {
    id: "UNODEFAKEFAKEFAKEFAKE",
    addAgent: (o?: { nkeySeed?: string }) => bus.agent(o?.nkeySeed ? (fromSeed(new TextEncoder().encode(o.nkeySeed)) as never) : undefined),
    removeAgent: async () => true,
    drain: async () => undefined,
    startHeartbeat: () => undefined,
  };
  internals.courier = {
    discover: async () => ({ agents: [manifest], total: 1 }),
    getManifest: async (id: string) => {
      if (id !== node.id) throw new Error("no such agent");
      return manifest;
    },
  };
  const server = await startInboundServer(bridge);
  open.push(server);
  const port = (server.address() as AddressInfo).port;
  internals.config.publicBaseUrl = `http://127.0.0.1:${port}`;
  const rpc = async (method: string, params: unknown, key = "k1") => {
    const res = await fetch(`http://127.0.0.1:${port}/agents/${node.id}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "A2A-Version": "1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return JSON.parse(await res.text());
  };
  return { rpc, base: `http://127.0.0.1:${port}/agents/${node.id}` };
}

const message = (text: string) => ({ messageId: `m-${Math.random()}`, role: "ROLE_USER", parts: [{ text }] });

describe("a held Task through JSON-RPC (§4.3)", () => {
  it("a queued request is answered with a held Task; the later Message completes it", async () => {
    bus = makeBus();
    const node = queuingNode({ delivered: true, later: () => ({ message: "answered later" }) });
    const { rpc } = await gateway(node);
    const sent = await rpc("SendMessage", { message: message("hello") });
    const held = sent.result.task;
    const frame = bus.log.find((l) => l.env.type === "request" && l.env.to === node.id)!.env;
    expect(held.id).toBe(frame.id);
    expect(held.status.state).toBe("TASK_STATE_SUBMITTED");
    expect(held.metadata[BRIDGE_EXTENSION_URI]).toEqual({ held: true });
    await tick(200);
    const got = await rpc("GetTask", { id: held.id });
    expect(got.result.status.state).toBe("TASK_STATE_COMPLETED");
    expect(got.result.status.message.parts[0].text).toBe("answered later");
  });

  it("a request held at the agent's door is a held Task in TASK_STATE_AUTH_REQUIRED", async () => {
    bus = makeBus();
    const node = queuingNode({ delivered: false, later: () => "never" });
    const { rpc } = await gateway(node);
    const sent = await rpc("SendMessage", { message: message("let me in") });
    expect(sent.result.task.status.state).toBe("TASK_STATE_AUTH_REQUIRED");
    expect(sent.result.task.metadata[BRIDGE_EXTENSION_URI]).toEqual({ held: true });
  });

  it("a later Task stands behind the held id: GetTask on it answers with the agent's Task", async () => {
    bus = makeBus();
    const node = queuingNode({ delivered: true, later: () => ({ task: "agent-task-1" }) });
    const { rpc } = await gateway(node);
    const held = (await rpc("SendMessage", { message: message("quote") })).result.task;
    await tick(200);
    const got = await rpc("GetTask", { id: held.id });
    expect(got.result.id).toBe("agent-task-1");
    expect(got.result.artifacts[0].parts[0].text).toBe("the quote");
  });

  it("only the caller that sent it reads a held Task, and it may cancel it before an answer", async () => {
    bus = makeBus();
    const node = queuingNode({ delivered: true, later: () => "never" });
    const { rpc } = await gateway(node);
    const held = (await rpc("SendMessage", { message: message("wait") })).result.task;
    const other = await rpc("GetTask", { id: held.id }, "k2");
    expect(other.error.code).toBe(-32001);
    const canceled = await rpc("CancelTask", { id: held.id });
    expect(canceled.result.status.state).toBe("TASK_STATE_CANCELED");
    const again = await rpc("CancelTask", { id: held.id });
    expect(again.error.code).toBe(-32002);
  });

  it("a streaming request that is queued gets one event, the held Task", async () => {
    bus = makeBus();
    const node = queuingNode({ delivered: true, later: () => "never" });
    const { base } = await gateway(node);
    const res = await fetch(`${base}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer k1", "A2A-Version": "1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendStreamingMessage", params: { message: message("stream") } }),
    });
    const events = (await res.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)).result);
    expect(events).toHaveLength(1);
    expect(events[0].task.metadata[BRIDGE_EXTENSION_URI]).toEqual({ held: true });
  });
});

describe("a held Task through @a2a-js/sdk", () => {
  it("the JS client gets the held Task, then reads it completed", async () => {
    bus = makeBus();
    const node = queuingNode({ delivered: true, later: () => ({ message: "answered later" }) });
    const { base } = await gateway(node, true);
    const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, { preferredTransports: ["JSONRPC"] }));
    const client = await factory.createFromUrl(`${base}/.well-known/agent-card.json`, "");
    const msg = { messageId: "js-1", role: Role.ROLE_USER, parts: [{ content: { $case: "text", value: "hello" } }], contextId: "", taskId: "", extensions: [], referenceTaskIds: [] };
    const task = (await client.sendMessage({ message: msg } as never)) as unknown as { id: string; status: { state: number }; metadata?: Record<string, unknown> };
    expect(task.status.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(task.metadata?.[BRIDGE_EXTENSION_URI]).toEqual({ held: true });
    await tick(200);
    const got = (await client.getTask({ id: task.id, tenant: "" } as never)) as unknown as { status: { state: number; message?: { parts: Array<{ content?: { value?: unknown } }> } } };
    expect(got.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(got.status.message?.parts[0].content?.value).toBe("answered later");
  });
});
