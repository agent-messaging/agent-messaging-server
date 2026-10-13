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
 *        when the answer will come later, or { kind: "failed", code }.
 *
 * Plus the forwarding of whole path prefixes to a front end beside the gateway
 * (FORWARD_ROUTES), so the edge in front of the gateway needs no change.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { isExposed, type Bridge } from "../bridge.js";
import type { AttachmentManager } from "../outbound/manager.js";
import { MeshError, ErrorCode } from "../../../sdk-typescript/src/types/errors.js";

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
