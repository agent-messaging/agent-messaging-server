/**
 * The bridge door's two fronts beside A2A (SPEC §4.15): MCP over streamable
 * HTTP, and HTTPS JSON. Both run the same tools (bridge-door.ts) as the
 * caller's lasting hosted identity.
 *
 *   POST /mcp                                     MCP (JSON-RPC 2.0), JSON responses
 *   GET  /v1/bridge/tools                         the tools, with their input schemas
 *   POST /v1/bridge/tools/:name                   run one; the body is its arguments
 *   GET  /.well-known/oauth-protected-resource    RFC 9728 metadata, so an MCP client
 *   GET  /.well-known/oauth-protected-resource/mcp  finds where to get a token
 *
 * The caller presents its credential in the request: `Authorization: Bearer
 * <token>` for an OAuth token or a SPIFFE JWT-SVID, `Authorization: DPoP
 * <token>` with a `DPoP` header for a bound token, or `Authorization: Bearer
 * <key>` for an API key or a sandbox key. A request with none, or with one
 * that is refused, is answered 401 with a `WWW-Authenticate` header naming
 * the resource metadata (RFC 9728 §5.1).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Bridge } from "../bridge.js";
import { inFront } from "../bridge.js";
import type { BridgeFront } from "../core/card.js";
import { clientAddress } from "./client-address.js";
import { presentedCredential, ProofRefused } from "./proofs.js";
import { BRIDGE_TOOLS, runTool, ToolRefusal } from "./bridge-door.js";
import type { AgentMesh } from "../../../sdk-typescript/src/mesh.js";

const BODY_LIMIT = 2 * 1024 * 1024;
/** The MCP versions this front speaks, newest first. */
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown | "too large" | "not json"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_LIMIT) return "too large";
    chunks.push(c as Buffer);
  }
  if (!size) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return "not json"; }
}

/** Where the resource metadata is, for `WWW-Authenticate`. */
export function resourceMetadataUrl(bridge: Bridge): string {
  return `${bridge.config.publicBaseUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource/mcp`;
}

function challenge(bridge: Bridge, error?: { code: string; message: string }): Record<string, string> {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl(bridge)}"`];
  if (error) parts.push(`error="invalid_token"`, `error_description="${error.message.replace(/["\\]/g, "'")}"`);
  return { "www-authenticate": parts.join(", ") };
}

/** RFC 9728: what this resource is and which authorization servers issue
 *  tokens for it (BRIDGE_AUTHORIZATION_SERVERS). */
export function protectedResourceMetadata(bridge: Bridge, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const servers = (env.BRIDGE_AUTHORIZATION_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    resource: `${bridge.config.publicBaseUrl.replace(/\/$/, "")}/mcp`,
    ...(servers.length ? { authorization_servers: servers } : {}),
    bearer_methods_supported: ["header"],
    dpop_signing_alg_values_supported: ["ES256", "ES384", "EdDSA", "RS256", "PS256"],
    resource_name: "Agent Messaging identity bridge",
  };
}

/** The caller behind a request on the MCP or HTTPS front, admitted and rate-checked. */
async function callerOf(
  bridge: Bridge,
  req: IncomingMessage,
  path: string,
): Promise<{ ok: true; key: string; agent: AgentMesh } | { ok: false; status: number; body: Record<string, unknown>; headers: Record<string, string> }> {
  const cred = presentedCredential(header(req, "authorization"));
  if (cred.type === "none") {
    return { ok: false, status: 401, body: { error: "This door needs a credential: Authorization: Bearer <token or key>.", code: "credentials_required" }, headers: challenge(bridge) };
  }
  let key: string;
  let agent: AgentMesh;
  if (cred.type === "proof") {
    try {
      const url = `${bridge.config.publicBaseUrl.replace(/\/$/, "")}${path}`;
      const got = await bridge.proofIdentity(cred, { method: req.method ?? "POST", url, ...(header(req, "dpop") ? { dpop: header(req, "dpop") } : {}) });
      key = got.key;
      agent = got.agent;
    } catch (err) {
      if (err instanceof ProofRefused) {
        const status = err.status === 503 ? 503 : err.status === 403 ? 403 : 401;
        return { ok: false, status, body: { error: err.message, code: err.code }, headers: status === 401 ? challenge(bridge, { code: err.code, message: err.message }) : {} };
      }
      throw err;
    }
  } else {
    const client = clientAddress(header(req, "x-forwarded-for"), req.socket.remoteAddress, bridge.trustedProxies);
    const who = await bridge.callerIdentity(cred.key, client.address);
    if ("error" in who) return { ok: false, status: 401, body: { error: who.message, code: who.reason }, headers: challenge(bridge, { code: who.reason, message: who.message }) };
    key = who.key;
    agent = who.agent;
  }
  if (!bridge.rateOk(key)) {
    return { ok: false, status: 429, body: { error: "Too many requests from this caller. Try again shortly.", code: "rate_limited" }, headers: { "retry-after": String(bridge.retryAfterSeconds(key)) } };
  }
  return { ok: true, key, agent };
}

async function run(bridge: Bridge, front: BridgeFront, key: string, agent: AgentMesh, name: string, args: unknown) {
  return inFront(front, () => runTool({ bridge, agent, key, front }, name, args));
}

// ─── HTTPS JSON ──────────────────────────────────────────────────────

export async function handleHttpsFront(bridge: Bridge, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (req.method === "GET" && path === "/v1/bridge/tools") {
    return send(res, 200, { tools: BRIDGE_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema })) });
  }
  const m = /^\/v1\/bridge\/tools\/([a-z_]+)$/.exec(path);
  if (!m || req.method !== "POST") return send(res, 404, { error: "not found" });
  const caller = await callerOf(bridge, req, path);
  if (!caller.ok) return send(res, caller.status, caller.body, caller.headers);
  const body = await readBody(req);
  if (body === "too large") return send(res, 413, { error: "The request body is over 2 MB." });
  if (body === "not json") return send(res, 400, { error: "The request body is not JSON." });
  try {
    return send(res, 200, await run(bridge, "https", caller.key, caller.agent, m[1]!, body ?? {}));
  } catch (err) {
    if (err instanceof ToolRefusal) return send(res, err.code === "UNKNOWN_TOOL" ? 404 : 400, { error: err.message, code: err.code });
    console.error(`[bridge:https] ${m[1]}:`, err);
    return send(res, 502, { error: `The mesh could not do that right now: ${(err as Error).message}`, code: "UNAVAILABLE" });
  }
}

// ─── MCP over streamable HTTP ────────────────────────────────────────

interface RpcMsg { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });

export async function handleMcp(bridge: Bridge, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (req.method === "GET" || req.method === "DELETE") {
    // No server-to-client stream and no sessions: every answer comes back on its POST.
    return send(res, 405, { error: "This MCP server answers POST only." }, { allow: "POST" });
  }
  if (req.method !== "POST") return send(res, 405, { error: "This MCP server answers POST only." }, { allow: "POST" });
  const caller = await callerOf(bridge, req, path);
  if (!caller.ok) return send(res, caller.status, caller.body, caller.headers);
  const body = await readBody(req);
  if (body === "too large") return send(res, 413, rpcError(null, -32600, "The request is over 2 MB."));
  if (body === "not json" || body === undefined) return send(res, 400, rpcError(null, -32700, "The request body is not JSON."));
  if (Array.isArray(body)) return send(res, 400, rpcError(null, -32600, "Send one JSON-RPC message per request."));
  const msg = body as RpcMsg;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return send(res, 400, rpcError(msg.id, -32600, "Not a JSON-RPC 2.0 request."));
  // A notification (no id) gets no answer.
  if (msg.id === undefined || msg.id === null) { res.writeHead(202); res.end(); return; }
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return send(res, 200, rpcResult(msg.id, {
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-messaging-identity-bridge", title: "Agent Messaging", version: "1" },
        instructions:
          "These tools put you on an Agent Messaging mesh as your own agent. Use find_agents to see who is here, describe_agent " +
          "before contacting anyone, knock when an agent holds messages from strangers, send to message an agent, and check_inbox " +
          "to read what has arrived. You hold no mesh key: the bridge signs for you, and receivers can see that.",
      }));
    }
    case "ping":
      return send(res, 200, rpcResult(msg.id, {}));
    case "tools/list":
      return send(res, 200, rpcResult(msg.id, { tools: BRIDGE_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      try {
        const out = await run(bridge, "mcp", caller.key, caller.agent, name, params.arguments ?? {});
        return send(res, 200, rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false }));
      } catch (err) {
        if (err instanceof ToolRefusal && err.code === "UNKNOWN_TOOL") return send(res, 200, rpcError(msg.id, -32602, err.message));
        const words = err instanceof ToolRefusal ? `${err.code}: ${err.message}` : `The mesh could not do that right now: ${(err as Error).message}`;
        if (!(err instanceof ToolRefusal)) console.error(`[bridge:mcp] ${name}:`, err);
        return send(res, 200, rpcResult(msg.id, { content: [{ type: "text", text: words }], isError: true }));
      }
    }
    default:
      return send(res, 200, rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
  }
}
