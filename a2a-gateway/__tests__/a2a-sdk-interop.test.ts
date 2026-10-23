/**
 * The gateway against A2A 1.0 as the Python `a2a-sdk` 1.1.0 speaks it, both
 * directions.
 *
 * Found by a frozen fleet (AgentMesh PR #617): the gateway sent
 * `configuration: {blocking: true}`, the 1.0 release candidate's field, and the
 * A2A project's Hello World sample on a2a-sdk 1.1.0 refused every forwarded
 * call with -32602. 1.1.0 parses requests and responses strictly against
 * a2a.proto (ProtoJSON), so a field 1.0 does not have fails the whole call.
 *
 * Two layers:
 *   - fixtures, always run: a remote that holds requests to 1.1.0's field
 *     lists (copied from its -32602 answers) and answers with what the sample
 *     answered, and the inbound route's 1.0 answers held to the same lists;
 *   - the real thing, when `A2A_SDK_PYTHON` names a Python with a2a-sdk 1.1.0
 *     installed (CI sets it): the sample itself, attached through the
 *     gateway, and a 1.1.0 client calling the gateway's inbound side.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { attach } from "../src/outbound/attach.js";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { fakeConnect, manifestFixture, type FakeMesh } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.A2A_SDK_PYTHON?.trim() || "";

const open: Array<{ close(): void }> = [];
const children: ChildProcess[] = [];
afterEach(() => {
  while (open.length) {
    const s = open.pop()!;
    try {
      (s as Server).closeAllConnections?.();
    } catch {
      /* not a server */
    }
    s.close();
  }
  while (children.length) children.pop()!.kill();
});

// ─── a2a-sdk 1.1.0's field lists (a2a.proto 1.0, lf.a2a.v1) ──────────

/** The fields each message has, as a2a-sdk 1.1.0 lists them when it refuses
 *  one it does not know ("Available Fields(except extensions)"). */
const FIELDS = {
  SendMessageRequest: ["tenant", "message", "configuration", "metadata"],
  SendMessageConfiguration: ["acceptedOutputModes", "taskPushNotificationConfig", "historyLength", "returnImmediately"],
  Message: ["messageId", "contextId", "taskId", "role", "parts", "metadata", "extensions", "referenceTaskIds"],
  Part: ["text", "raw", "url", "data", "metadata", "filename", "mediaType"],
  Task: ["id", "contextId", "status", "artifacts", "history", "metadata"],
  TaskStatus: ["state", "message", "timestamp"],
  Artifact: ["artifactId", "name", "description", "parts", "metadata", "extensions"],
  TaskStatusUpdateEvent: ["taskId", "contextId", "status", "metadata"],
  TaskArtifactUpdateEvent: ["taskId", "contextId", "artifact", "append", "lastChunk", "metadata"],
} as const;

const TASK_STATES = [
  "TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED", "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED", "TASK_STATE_INPUT_REQUIRED", "TASK_STATE_REJECTED", "TASK_STATE_AUTH_REQUIRED",
];

type Obj = Record<string, unknown>;

/** Every problem a strict 1.0 parser would have with `value` as `type`. */
function strict(type: keyof typeof FIELDS | "SendMessageResponse" | "StreamResponse", value: unknown, at = type as string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${at}: not an object`];
  const v = value as Obj;
  if (type === "SendMessageResponse" || type === "StreamResponse") {
    const oneof = type === "SendMessageResponse" ? ["task", "message"] : ["task", "message", "statusUpdate", "artifactUpdate"];
    const keys = Object.keys(v);
    if (keys.length !== 1 || !oneof.includes(keys[0])) return [`${at}: expected exactly one of ${oneof.join(", ")}, got ${keys.join(", ")}`];
    const sub = { task: "Task", message: "Message", statusUpdate: "TaskStatusUpdateEvent", artifactUpdate: "TaskArtifactUpdateEvent" }[keys[0]] as keyof typeof FIELDS;
    return strict(sub, v[keys[0]], `${at}.${keys[0]}`);
  }
  const problems = Object.keys(v)
    .filter((k) => !(FIELDS[type] as readonly string[]).includes(k))
    .map((k) => `${at}: no field named "${k}"`);
  const nested: Array<[string, keyof typeof FIELDS, boolean]> = [
    ["configuration", "SendMessageConfiguration", false],
    ["message", "Message", false],
    ["parts", "Part", true],
    ["status", "TaskStatus", false],
    ["artifacts", "Artifact", true],
    ["history", "Message", true],
    ["artifact", "Artifact", false],
  ];
  for (const [field, sub, repeated] of nested) {
    if (v[field] === undefined || !(FIELDS[type] as readonly string[]).includes(field)) continue;
    if (repeated) (v[field] as unknown[]).forEach((x, i) => problems.push(...strict(sub, x, `${at}.${field}[${i}]`)));
    else problems.push(...strict(sub, v[field], `${at}.${field}`));
  }
  if (type === "TaskStatus" && !TASK_STATES.includes(v.state as string)) problems.push(`${at}.state: "${String(v.state)}" is not a TaskState`);
  if (type === "Message" && v.role !== "ROLE_USER" && v.role !== "ROLE_AGENT") problems.push(`${at}.role: "${String(v.role)}" is not a Role`);
  return problems;
}

// ─── Outbound: the gateway calling a 1.0 agent ───────────────────────

/** What the Hello World sample on a2a-sdk 1.1.0 answered a blocking
 *  SendMessage with, recorded from a run (ids shortened). */
function sampleTask(text: string): Obj {
  return {
    task: {
      id: "67cd978a",
      contextId: "3787090d",
      status: {
        state: "TASK_STATE_COMPLETED",
        message: { messageId: "530df83d", role: "ROLE_AGENT", parts: [{ text: "Request is completed!" }] },
        timestamp: "2026-10-23T17:24:18.196401Z",
      },
      artifacts: [{ artifactId: "8093c0af", parts: [{ text: `Hello, World! I have received your request (${text})`, mediaType: "text/plain" }] }],
    },
  };
}

/** A remote that refuses as a2a-sdk 1.1.0 refuses, and otherwise answers as
 *  the sample answers. */
async function strictRemote(): Promise<{ base: string; requests: Obj[] }> {
  const requests: Obj[] = [];
  const state = { base: "" };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          name: "Hello World Agent",
          description: "Just a hello world agent",
          supportedInterfaces: [{ url: state.base, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
          version: "0.0.1",
          capabilities: { streaming: true, extendedAgentCard: true },
          defaultInputModes: ["text/plain"],
          defaultOutputModes: ["text/plain"],
          skills: [{ id: "echo_bot", name: "Echo Bot", description: "Echoes", inputModes: ["text/plain"], outputModes: ["text/plain"] }],
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString()) as { id: unknown; method: string; params: Obj };
      requests.push(rpc.params);
      const problems = strict("SendMessageRequest", rpc.params);
      const reply = problems.length
        ? { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "Invalid params", data: problems.join("; ") } }
        : { jsonrpc: "2.0", id: rpc.id, result: sampleTask("") };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(server);
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base: state.base, requests };
}

function fakeMeshForAttach() {
  const handlers = new Map<string, (input: unknown, ctx: unknown) => Promise<unknown>>();
  const node = {
    addAgent: () => ({
      id: "UATTACHEDFAKE0000000",
      onRequest: (id: string, h: (input: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(id, h),
      register: async () => undefined,
      deregister: async () => undefined,
    }),
    removeAgent: async () => true,
  };
  return { bridge: { meshNode: node } as unknown as Bridge, handlers };
}

async function attachTo(url: string) {
  const mesh = fakeMeshForAttach();
  const attachment = await attach(mesh.bridge, { url });
  open.push({ close: () => void attachment.detach() });
  return mesh.handlers;
}

describe("outbound to an a2a-sdk 1.1.0 agent (fixture)", () => {
  it("sends a SendMessage request a strict 1.0 server accepts: no `blocking`, files as url parts", async () => {
    const remote = await strictRemote();
    const handlers = await attachTo(remote.base);
    const out = await handlers.get("echo_bot")!(
      { text: "hi", files: [{ uri: "https://files.example/a.pdf", name: "a.pdf", media_type: "application/pdf" }] },
      { taskId: "t-1", envelope: { from: "UCALLER" } },
    );
    expect(out).toEqual({ text: "Hello, World! I have received your request ()" });
    expect(remote.requests).toHaveLength(1);
    expect(strict("SendMessageRequest", remote.requests[0])).toEqual([]);
    expect(remote.requests[0]).not.toHaveProperty("configuration");
    const parts = (remote.requests[0].message as { parts: Obj[] }).parts;
    expect(parts).toContainEqual({ url: "https://files.example/a.pdf", filename: "a.pdf", mediaType: "application/pdf" });
  });
});

// ─── Inbound: a 1.0 client calling the gateway ───────────────────────

const KEY = "interop-key";
const AUTH = { Authorization: `Bearer ${KEY}` };

/** The gateway's inbound side on a fake mesh whose agent answers by the text
 *  it is sent: `message` and `file` finish at once, `task` defers, `stream`
 *  streams two chunks. */
async function startGateway(): Promise<{ agent: string; mesh: FakeMesh }> {
  const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, apiKeys: { [KEY]: "interop" } });
  const manifest = manifestFixture({ offerings: [{ id: "echo", name: "Echo", description: "Returns input", streaming: true }] });
  const mesh = fakeConnect(bridge, { discover: async () => ({ agents: [manifest], total: 1 }), getManifest: async () => manifest });
  mesh.answer = (req) => {
    if (req.offering === "task.cancel") return { task_id: null, payload: { status: "canceled" }, envelope: { id: "e-cancel" } };
    const text = (req.input as { text?: string })?.text;
    if (text === "task") return { task_id: "task-1", payload: { status: "working" }, envelope: { id: "e-task" } };
    if (text === "file") {
      return {
        task_id: null,
        payload: { status: "completed", output: { text: "here", files: [{ uri: "https://files.example/r.pdf", name: "r.pdf", media_type: "application/pdf" }] } },
        envelope: { id: "e-file" },
      };
    }
    return { task_id: null, payload: { status: "completed", output: { text: `you said ${text}` } }, envelope: { id: "e-msg" } };
  };
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
  const server = await startInboundServer(bridge);
  open.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The card names its interfaces from the public base URL, and a client
  // calls the one it names: point it at the port this server took.
  (bridge.config as { publicBaseUrl: string }).publicBaseUrl = base;
  return { agent: `${base}/agents/UAGENTPUBKEY`, mesh };
}

async function rpc10(
  agent: string,
  method: string,
  params: unknown,
  version: string | null = "1.0",
  opts: { auth?: boolean; query?: string } = {},
): Promise<Response> {
  return fetch(`${agent}/rpc${opts.query ?? ""}`, {
    method: "POST",
    headers: { ...(opts.auth === false ? {} : AUTH), "Content-Type": "application/json", ...(version ? { "A2A-Version": version } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

const send = (text: string) => ({ message: { messageId: `m-${text}`, role: "ROLE_USER", parts: [{ text }] } });

describe("inbound from an A2A 1.0 client (fixture)", () => {
  it("answers SendMessage in shapes a strict 1.0 client parses", async () => {
    const { agent } = await startGateway();
    for (const text of ["message", "file", "task"]) {
      const body = (await (await rpc10(agent, "SendMessage", send(text))).json()) as { result: unknown };
      expect(strict("SendMessageResponse", body.result), text).toEqual([]);
    }
    const file = (await (await rpc10(agent, "SendMessage", send("file"))).json()) as { result: { message: { parts: Obj[] } } };
    expect(file.result.message.parts).toContainEqual({ url: "https://files.example/r.pdf", filename: "r.pdf", mediaType: "application/pdf" });
  });

  it("answers GetTask with the Task itself, its state an enum name", async () => {
    const { agent } = await startGateway();
    await rpc10(agent, "SendMessage", send("task"));
    const body = (await (await rpc10(agent, "GetTask", { id: "task-1" })).json()) as { result: Obj };
    expect(strict("Task", body.result)).toEqual([]);
    expect(body.result).toMatchObject({ id: "task-1", status: { state: "TASK_STATE_WORKING" } });
  });

  it("streams StreamResponses with no `final` on the status update", async () => {
    const { agent } = await startGateway();
    const res = await rpc10(agent, "SendStreamingMessage", send("stream"));
    const events = (await res.text())
      .split("\n\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => (JSON.parse(l.slice(5)) as { result: unknown }).result);
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const e of events) expect(strict("StreamResponse", e)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ statusUpdate: { taskId: "st-1", status: { state: "TASK_STATE_COMPLETED" } } });
    // A2A 1.0 requires a context on each update event.
    for (const e of events.slice(1) as Array<Record<string, { contextId?: string }>>) {
      expect(Object.values(e)[0].contextId).toBe("st-1");
    }
  });

  it("answers CancelTask with the Task itself", async () => {
    const { agent } = await startGateway();
    await rpc10(agent, "SendMessage", send("task"));
    const body = (await (await rpc10(agent, "CancelTask", { id: "task-1" })).json()) as { result: Obj };
    expect(strict("Task", body.result)).toEqual([]);
    expect(body.result).toMatchObject({ id: "task-1", status: { state: "TASK_STATE_CANCELED" } });
  });

  it("hears the version as a request parameter too (A2A 1.0 §3.2.6)", async () => {
    const { agent } = await startGateway();
    await rpc10(agent, "SendMessage", send("task"));
    const body = (await (await rpc10(agent, "GetTask", { id: "task-1" }, null, { query: "?A2A-Version=1.0" })).json()) as { result: Obj };
    expect(body.result).toMatchObject({ id: "task-1", status: { state: "TASK_STATE_WORKING" } });
  });

  it("keeps a refusal's status and headers, with 1.0's error details", async () => {
    const { agent } = await startGateway();
    const res = await rpc10(agent, "SendMessage", send("message"), "1.0", { auth: false });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    const body = (await res.json()) as { error: { code: number; data: Array<Record<string, unknown>> } };
    expect(Array.isArray(body.error.data)).toBe(true);
    expect(body.error.data[0]).toMatchObject({ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "UNAUTHORIZED" });
    const missing = (await (await rpc10(agent, "GetTask", { id: "nope" })).json()) as { error: { code: number; data: Array<Record<string, unknown>> } };
    expect(missing.error).toMatchObject({ code: -32001, data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "TASK_NOT_FOUND", domain: "a2a-protocol.org" }] });
  });

  it("answers the 1.0 name ListTaskPushNotificationConfigs, as unsupported", async () => {
    const { agent } = await startGateway();
    const body = (await (await rpc10(agent, "ListTaskPushNotificationConfigs", { taskId: "t" })).json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32003);
  });

  it("keeps its older shapes for a caller that names no version, or 0.3", async () => {
    const { agent } = await startGateway();
    for (const version of [null, "0.3"]) {
      await rpc10(agent, "SendMessage", send("task"), version);
      const body = (await (await rpc10(agent, "GetTask", { id: "task-1" }, version)).json()) as { result: { task: { status: { state: string } } } };
      expect(body.result.task.status.state).toBe("working");
    }
  });

  it("declares its security in 1.0's card shapes", async () => {
    const { agent } = await startGateway();
    const card = (await (await fetch(`${agent}/.well-known/agent-card.json`, { headers: AUTH })).json()) as Obj;
    expect(card).not.toHaveProperty("security");
    expect(card.securitySchemes).toEqual({ "a2a-gateway": { httpAuthSecurityScheme: { scheme: "bearer", description: expect.any(String) } } });
    expect(card.securityRequirements).toEqual([{ schemes: { "a2a-gateway": { list: [] } } }]);
  });
});

// ─── The real a2a-sdk 1.1.0 ──────────────────────────────────────────

/** Start the sample and wait for the port it prints. */
async function startSample(): Promise<string> {
  const child = spawn(PYTHON, ["-I", join(HERE, "a2a-sdk", "sample_agent.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let err = "";
  child.stderr!.on("data", (c: Buffer) => (err += c.toString()));
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the sample did not start: ${err}`)), 30_000);
    let out = "";
    child.stdout!.on("data", (c: Buffer) => {
      out += c.toString();
      const m = out.match(/PORT (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    child.on("exit", (code) => reject(new Error(`the sample exited (${code}): ${err}`)));
  });
}

/** Run the 1.1.0 client against the gateway; one parsed line per step. */
async function runClient(agent: string): Promise<Record<string, { ok: boolean; result?: unknown; error?: string }>> {
  const child = spawn(PYTHON, ["-I", join(HERE, "a2a-sdk", "client_check.py"), agent, KEY], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout!.on("data", (c: Buffer) => (out += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (err += c.toString()));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  if (code !== 0) throw new Error(`the client exited (${code}): ${err}`);
  const steps: Record<string, { ok: boolean; result?: unknown; error?: string }> = {};
  for (const line of out.split("\n").filter(Boolean)) {
    const s = JSON.parse(line) as { step: string; ok: boolean; result?: unknown; error?: string };
    steps[s.step] = s;
  }
  return steps;
}

describe.skipIf(!PYTHON)("with the real a2a-sdk 1.1.0 (A2A_SDK_PYTHON)", () => {
  it("forwards a mesh request to the A2A Hello World sample and maps its answer back", async () => {
    const handlers = await attachTo(await startSample());
    const out = await handlers.get("echo_bot")!({ text: "hi from the mesh" }, { taskId: "t-real", envelope: { from: "UCALLER" } });
    expect(out).toEqual({ text: "Hello, World! I have received your request (hi from the mesh)" });
  }, 60_000);

  it("forwards a file as a part the sample accepts", async () => {
    const handlers = await attachTo(await startSample());
    const out = await handlers.get("echo_bot")!(
      { text: "with a file", files: [{ uri: "https://files.example/a.pdf", name: "a.pdf", media_type: "application/pdf" }] },
      { taskId: "t-file", envelope: { from: "UCALLER" } },
    );
    expect(out).toEqual({ text: "Hello, World! I have received your request (with a file)" });
  }, 60_000);

  it("serves a 1.1.0 client on both bindings: card, message, file, task, GetTask and a stream all parse", async () => {
    const { agent } = await startGateway();
    const steps = await runClient(agent);
    for (const prefix of ["", "rest_"]) {
      for (const name of ["message", "file", "task", "get_task", "stream"]) {
        const step = `${prefix}${name}`;
        expect(steps[step], `${step}: ${steps[step]?.error ?? "missing"}`).toMatchObject({ ok: true });
      }
    }
    expect(steps.message.result).toEqual([
      { message: { messageId: "e-msg", role: "ROLE_AGENT", parts: [{ text: "you said message" }] } },
    ]);
    expect(JSON.stringify(steps.file.result)).toContain('"url":"https://files.example/r.pdf"');
    expect(steps.get_task.result).toMatchObject({ id: "task-1", status: { state: "TASK_STATE_WORKING" } });
    const stream = steps.stream.result as Array<Record<string, unknown>>;
    expect(stream.at(-1)).toMatchObject({ statusUpdate: { taskId: "st-1", status: { state: "TASK_STATE_COMPLETED" } } });
  }, 60_000);
});
