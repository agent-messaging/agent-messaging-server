/**
 * The relay doors: what the gateway does for a protocol front end that runs
 * beside it rather than inside it (step 10a of
 * docs/agent-messaging-server-plan.md). AgentMesh's PACT Provider
 * (BRIDGE-A2A.md §14) is one: it answers people's personal agents over HTTP,
 * and the gateway carries each turn onto the mesh as the hosted caller
 * identity it keeps for that person, as it does for any A2A caller.
 *
 * Behind the admin gate (local and unproxied callers only, server.ts
 * `adminAllowed`), so only a process on this host reaches them.
 *
 *   GET  /admin/relay/agents/:id
 *        { manifest, exposed, priced, descriptor }: the agent's manifest under
 *        the exposure policy (null when it must not be exposed), whether it is
 *        exposed to A2A, whether an outbound attachment prices it, and its
 *        descriptor from the registry (null when it published none).
 *   POST /admin/relay/turn { caller_key, responder, offering, input, context_id?, meta?, timeout_ms?, binding? }
 *        Send `input` to `responder`'s `offering` as the hosted identity the
 *        gateway keeps for `caller_key`, with `meta` (and the gateway's own
 *        attribution marker) on the envelope. A request the responder queues
 *        (REQUEST_QUEUED) is held open for its late reply, up to `timeout_ms`.
 *        Answers { kind: "done", status, output, message? }, { kind: "late" }
 *        when the answer will come later, or { kind: "failed", code }. An
 *        agent that serves the A2A binding (its manifest lists it) is called
 *        with A2A's SendMessage in a 0.4.0 frame, the input as the Message's
 *        parts and the offering in the offering extension, and its A2A answer
 *        is given back in this same shape (relayAnswerOfA2A); the others keep
 *        the 0.3.0 request.
 *
 * Plus the forwarding of whole path prefixes to a front end beside the gateway
 * (FORWARD_ROUTES), so the edge in front of the gateway needs no change.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { isExposed, type Bridge } from "../bridge.js";
import type { AttachmentManager } from "../outbound/manager.js";
import { MeshError, ErrorCode } from "../../../sdk-typescript/src/types/errors.js";
import type { AgentMesh } from "../../../sdk-typescript/src/mesh.js";
import { A2AError } from "../../../sdk-typescript/src/a2a/errors.js";
import { isTerminalState } from "../../../sdk-typescript/src/a2a/binding.js";
import { EXT_OFFERING, isExhausted } from "../../../sdk-typescript/src/a2a/extensions.js";
import { messageOfLegacyInput, outputOfParts } from "../../../sdk-typescript/src/a2a/server.js";
import type { Message, Task } from "../../../sdk-typescript/src/a2a/types.js";

const BODY_LIMIT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const AGENT_ID = /^[A-Z0-9]{56}$/;

export type RelayAnswer =
  | { kind: "done"; status: string; output: unknown; message?: string }
  | { kind: "late" }
  | { kind: "failed"; code: string };

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        resolve(v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/** One turn onto the mesh for an outside caller. Exported for the tests. */
export async function relayTurn(
  bridge: Bridge,
  t: { callerKey: string; responder: string; offering: string; input: unknown; contextId?: string; meta?: Record<string, unknown>; timeoutMs: number; binding: string },
): Promise<RelayAnswer> {
  const requester = await bridge.identityFor(t.callerKey);
  const marker = bridge.attributionMeta(t.callerKey);
  const meta = { ...(marker ?? {}), ...(t.meta ?? {}) };
  const startedAt = Date.now();
  const tap = (outcome: "ok" | "error") =>
    bridge.emitInboundCall(t.callerKey, { responder: t.responder, offering: t.offering, outcome, latencyMs: Date.now() - startedAt, at: new Date().toISOString(), binding: t.binding });
  // An agent that serves the A2A binding is called with A2A's SendMessage in
  // a 0.4.0 frame (bindings/a2a.md); every other agent keeps the 0.3.0 call.
  // The answer to the front end is the same shape either way.
  if (await bridge.servesA2ABinding(t.responder)) return relayTurnA2A(requester, t, meta, startedAt, tap);
  try {
    const result = await requester.request(t.responder, t.offering, t.input, { timeout_ms: t.timeoutMs, ...(t.contextId ? { context_id: t.contextId } : {}), meta });
    tap("ok");
    if (result.task_id !== null) return { kind: "late" };
    return { kind: "done", status: String(result.payload.status), output: result.payload.output, ...(result.payload.message ? { message: result.payload.message } : {}) };
  } catch (err) {
    if (err instanceof MeshError && err.code === ErrorCode.REQUEST_QUEUED) {
      // A packaged agent answers from its mailbox: the request is queued at
      // once and the words come back as a reply naming it. Hold the exchange
      // open for that reply, up to the turn's time.
      tap("ok");
      const requestId = (err.details as { request_id?: unknown } | undefined)?.request_id;
      if (typeof requestId !== "string" || !requestId) return { kind: "late" };
      const left = Math.max(1000, t.timeoutMs - (Date.now() - startedAt));
      const body = await bridge.awaitLateReply(requestId, t.responder, left);
      if (!body) return { kind: "late" };
      const refusal = body.error && typeof body.error === "object" ? (body.error as { message?: unknown; code?: unknown }) : null;
      if (refusal) return { kind: "done", status: "rejected", output: null, message: String(refusal.message ?? refusal.code ?? "") };
      const { in_reply_to: _i, usage: _u, cost: _c, error: _e, job: _j, files: _f, trial: _t, ...answer } = body;
      return { kind: "done", status: "completed", output: answer };
    }
    tap("error");
    const code = err instanceof MeshError ? err.code : "INTERNAL";
    console.warn(`[relay] mesh request to ${t.responder.slice(0, 12)}... failed: ${code}`); // cut-ok: a key prefix in a log line
    return { kind: "failed", code };
  }
}

/**
 * An A2A answer as the relay's answer, the shape its callers read on 0.3.0:
 *
 *  - a Message: `done`, `completed`, its parts as the output (a lone data
 *    part's data, else the text, as the SDK maps an A2A answer for a 0.3.0
 *    handler);
 *  - a Task in a terminal state: `done`, its state as the 0.3.0 wire spells
 *    it (`completed`, `failed`, `canceled`, `rejected`, `exhausted`), the
 *    artifacts' parts as the output of a completed Task (null otherwise), and
 *    the status message's text as `message`;
 *  - a Task that is not finished: `late`, as a 0.3.0 Task answer is.
 */
export function relayAnswerOfA2A(result: unknown): RelayAnswer {
  const r = (result ?? {}) as { message?: Message; task?: Task };
  if (r.message && !r.task) return { kind: "done", status: "completed", output: outputOfParts(r.message.parts ?? []) };
  const task = r.task;
  if (!task || !isTerminalState(task.status?.state)) return { kind: "late" };
  const status = isExhausted(task) ? "exhausted" : task.status.state.replace(/^TASK_STATE_/, "").toLowerCase();
  const words = (task.status.message?.parts ?? []).filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
  return {
    kind: "done",
    status,
    output: status === "completed" ? outputOfParts((task.artifacts ?? []).flatMap((a) => a.parts ?? [])) : null,
    ...(words ? { message: words } : {}),
  };
}

/** One turn to an agent that serves the A2A binding. */
async function relayTurnA2A(
  requester: AgentMesh,
  t: { responder: string; offering: string; input: unknown; contextId?: string; timeoutMs: number },
  meta: Record<string, unknown>,
  startedAt: number,
  tap: (outcome: "ok" | "error") => void,
): Promise<RelayAnswer> {
  const message: Message = { ...messageOfLegacyInput(t.input, t.offering), ...(t.contextId ? { contextId: t.contextId } : {}) };
  // A request the agent's node queues answers later, naming the request
  // (A2ACallOptions.onLateAnswer): held open for it, up to the turn's time.
  let late: (answer: RelayAnswer) => void = () => undefined;
  const lateAnswer = new Promise<RelayAnswer>((resolve) => (late = resolve));
  try {
    const res = await requester.a2a.sendMessage(t.responder, message, {
      timeoutMs: t.timeoutMs,
      meta,
      extensions: [EXT_OFFERING],
      onLateAnswer: (answer) => {
        if ("result" in answer) late(relayAnswerOfA2A(answer.result));
        else late({ kind: "done", status: "rejected", output: null, message: answer.error.message });
      },
    });
    tap("ok");
    return relayAnswerOfA2A(res);
  } catch (err) {
    if (err instanceof MeshError && err.code === ErrorCode.REQUEST_QUEUED) {
      tap("ok");
      const left = Math.max(1000, t.timeoutMs - (Date.now() - startedAt));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = await Promise.race([
        lateAnswer,
        new Promise<RelayAnswer>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "late" }), left);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      return waited;
    }
    tap("error");
    const code = err instanceof A2AError ? err.code : err instanceof MeshError ? err.code : "INTERNAL";
    console.warn(`[relay] A2A request to ${t.responder.slice(0, 12)}... failed: ${code}`); // cut-ok: a key prefix in a log line
    return { kind: "failed", code };
  }
}

/** The relay doors, under /admin/relay/ (already behind the admin gate). */
export async function handleAdminRelay(bridge: Bridge, manager: AttachmentManager | undefined, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const seg = path.split("/").filter(Boolean).slice(2); // after "admin", "relay"
  const method = (req.method ?? "GET").toUpperCase();
  if (seg.length === 2 && seg[0] === "agents" && method === "GET") {
    const id = decodeURIComponent(seg[1]!);
    if (!AGENT_ID.test(id)) return json(res, 400, { error: "That is not an agent id." });
    const manifest = await bridge.exposableManifest(id);
    const priced = manager ? !!(await manager.priceForAgent(id)) : false;
    const descriptor = manifest ? await bridge.agentDescriptor(id) : null;
    return json(res, 200, { manifest, exposed: manifest ? isExposed(manifest) : false, priced, descriptor });
  }
  if (seg.length === 1 && seg[0] === "turn" && method === "POST") {
    const b = await readJson(req);
    if (!b) return json(res, 400, { error: "The body is one JSON object of at most 256 KiB." });
    const callerKey = typeof b.caller_key === "string" && b.caller_key ? b.caller_key : null;
    const responder = typeof b.responder === "string" && AGENT_ID.test(b.responder) ? b.responder : null;
    const offering = typeof b.offering === "string" && b.offering ? b.offering : null;
    if (!callerKey || !responder || !offering || b.input === undefined) return json(res, 400, { error: "caller_key, responder, offering and input are required." });
    const meta = b.meta && typeof b.meta === "object" && !Array.isArray(b.meta) ? (b.meta as Record<string, unknown>) : undefined;
    const timeoutMs = Math.max(1000, Math.min(Number(b.timeout_ms ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
    try {
      const answer = await relayTurn(bridge, {
        callerKey, responder, offering, input: b.input, timeoutMs,
        ...(typeof b.context_id === "string" && b.context_id ? { contextId: b.context_id } : {}),
        ...(meta ? { meta } : {}),
        binding: typeof b.binding === "string" && b.binding ? b.binding : "relay",
      });
      return json(res, 200, answer);
    } catch (err) {
      console.error("[relay] turn failed:", err instanceof Error ? err.message : err);
      return json(res, 503, { error: "The turn could not be relayed just now." });
    }
  }
  return json(res, 404, { error: "no such relay route" });
}

/** Path prefixes forwarded whole to a front end beside the gateway:
 *  FORWARD_ROUTES="/a2a/=http://127.0.0.1:8091,/admin/pact=http://127.0.0.1:8091". */
/** A path prefix the gateway passes whole to a front end beside it. */
export interface ForwardRoute {
  prefix: string;
  target: URL;
}

export function parseForwardRoutes(raw: string | undefined): ForwardRoute[] {
  const out: ForwardRoute[] = [];
  for (const part of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      const target = new URL(part.slice(i + 1));
      if (target.protocol === "http:" || target.protocol === "https:") out.push({ prefix: part.slice(0, i), target });
    } catch {
      console.warn(`[bridge] FORWARD_ROUTES entry "${part}" is not prefix=url; ignored`);
    }
  }
  return out;
}

/** The forward that takes this path, if any. */
export function forwardFor(routes: ForwardRoute[], path: string): URL | null {
  for (const r of routes) {
    const bare = r.prefix.replace(/\/+$/, "");
    if (path === bare || path.startsWith(r.prefix.endsWith("/") ? r.prefix : `${r.prefix}/`)) return r.target;
  }
  return null;
}

/** Pass one request through to the front end and its answer back, streamed. */
export function forward(req: IncomingMessage, res: ServerResponse, target: URL): Promise<void> {
  return new Promise((resolve) => {
    const headers = { ...req.headers };
    delete headers.host;
    const up = httpRequest(
      { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
        answer.on("end", () => resolve());
        answer.on("error", () => resolve());
      },
    );
    up.on("error", (err) => {
      console.warn(`[bridge] the front end at ${target.host} did not answer: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "the service behind this path is not answering" }));
      }
      resolve();
    });
    req.pipe(up);
  });
}
