/**
 * Inbound direction (BRIDGE-A2A.md §4): a stock A2A client (JSON-RPC 2.0 over
 * HTTP, SSE for streaming) calls mesh agents through this server.
 *
 * Routes:
 *   GET  /                                                bridge info      (open)
 *   GET  /healthz                                         liveness         (open)
 *   GET  /agents                                          exposed agents index
 *   GET  /agents/:id/.well-known/agent-card.json          generated agent card
 *   POST /agents/:id/rpc                                  A2A JSON-RPC endpoint
 *
 * Admission rule: every route that costs MESH work needs a caller (§9). `/` and
 * `/healthz` touch nothing but this process, so they stay open; `/agents`,
 * the card and the RPC endpoint each cause a registry call or a mesh request on
 * an anonymous stranger's behalf, so each requires an authorized caller and each
 * spends that caller's rate budget.
 *
 * `/agents` in particular is a privileged read even though the mesh directory is
 * public to credential holders: this endpoint asks for no credential at all, and
 * it enumerates — one request returns every exposed agent's key, name and
 * description. Fetching a card you were given the id for is a lookup; sweeping
 * the directory is a different capability.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { isExposed, type Bridge, type CallerRefused } from "../bridge.js";
import { AdminError, type AttachmentManager, type CreateAttachmentInput } from "../outbound/manager.js";
import { redactKey } from "./keys.js";
import type { AgentMesh } from "../../../sdk-typescript/src/mesh.js";
import type { Manifest } from "../../../sdk-typescript/src/types/manifest.js";
import { manifestToCard } from "../core/card.js";
import {
  linkFiles,
  meshLinker,
  partsToInput,
  outputToParts,
  FilePartError,
  FileStoreError,
  type FileSink,
  type MeshFile,
} from "../core/parts.js";
import { meshStateToA2A } from "../core/states.js";
import { meshErrorToRpc } from "../core/errors.js";
import {
  A2A_JSON,
  a2aRestError,
  matchRestRoute,
  requestedVersion,
  restVersionServed,
  rpcErrorToRest,
  rpcStreamEventToRest,
  rpcToRest,
  type RestRoute,
} from "../core/httpjson.js";
import { clientAddress } from "./client-address.js";
import { forward, forwardFor, handleAdminRelay, type ForwardRoute } from "./relay.js";
import {
  RpcCode,
  rpcError,
  rpcResult,
  A2A_PROTOCOL_VERSION,
  type A2ATask,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type SendMessageParams,
  type SendMessageResult,
  type StreamEvent,
} from "../core/jsonrpc.js";
import { MeshError, ErrorCode } from "../../../sdk-typescript/src/types/errors.js";
import { fromTraceparent, toTraceparent } from "../../../sdk-typescript/src/internal/trace.js";
import { runWithTrace } from "../../../sdk-typescript/src/internal/trace-ambient.js";
import type { RequestConfig } from "../../../sdk-typescript/src/types/options.js";
import { amEnvOptional } from "../am-env.js";

const BODY_LIMIT = 1024 * 1024; // 1 MB
const SUPPORTED_A2A_VERSIONS = new Set(["1.0", "0.3"]);

/** What an operator needs to read in the log when the port is taken. Exported
 *  so the failure text is asserted rather than hoped for. */
export function portInUseMessage(port: number): string {
  return (
    `port ${port} is already in use, so the A2A bridge cannot bind and is exiting.\n` +
    `  Find the process holding it:  ss -ltnp | grep :${port}    (or: lsof -i :${port})\n` +
    `  If it is an older bridge that was orphaned by a restart, stop that pid, then start again.\n` +
    `  If another service legitimately owns ${port}, set PORT to something else.\n` +
    `  This is a hard exit on purpose: retrying would leave two processes racing for one socket.`
  );
}

export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(portInUseMessage(port));
    this.name = "PortInUseError";
  }
}

/**
 * Bind the HTTP listener. Resolves once the socket is actually held, rejects if
 * it cannot be — in particular EADDRINUSE, which becomes a named error rather
 * than an unhandled `error` event on the server object.
 *
 * This binds before the caller connects to NATS (boot.ts), which is why a port
 * conflict now costs one failed bind instead of a mesh connection and a
 * registration churn per restart attempt.
 */
export function startInboundServer(bridge: Bridge, manager?: AttachmentManager, forwards: ForwardRoute[] = []): Promise<Server> {
  return new Promise((resolve, reject) => {
    const port = bridge.config.port;
    const server = createServer((req, res) => {
      handle(bridge, req, res, manager, forwards).catch((err) => {
        console.error("[bridge:inbound] unhandled:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      });
    });

    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      reject(err.code === "EADDRINUSE" ? new PortInUseError(port) : err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      // Past bind, a socket error must not become an unhandled event either.
      server.on("error", (err) => console.error("[bridge:inbound] server error:", err));
      // The port actually bound, not the one asked for — they differ when the
      // operator passes 0, and a log that says 0 helps nobody find the socket.
      const addr = server.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      console.log(`[bridge:inbound] listening on :${bound} (public: ${bridge.config.publicBaseUrl})`);
      resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });
}

// ─── Admission ───────────────────────────────────────────────────────

/** Resolve, authorize and rate-check the caller. Every mesh-touching route runs
 *  this before doing any work. */
function admit(
  bridge: Bridge,
  req: IncomingMessage,
): { key: string } | { refused: CallerRefused } | { limited: true; retryAfter: number } {
  const client = clientAddress(
    header(req, "x-forwarded-for"),
    req.socket.remoteAddress,
    bridge.trustedProxies,
  );
  const auth = header(req, "authorization");
  const apiKey = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;

  const decision = bridge.authorizeCaller(apiKey, client.address);
  if ("error" in decision) return { refused: decision };
  if (!bridge.rateOk(decision.key)) return { limited: true, retryAfter: bridge.retryAfterSeconds(decision.key) };
  return { key: decision.key };
}

/**
 * Is this request allowed to reach the /admin surface?
 *
 * "Came in on the loopback socket" is NOT enough: the public reverse proxy
 * (Caddy) also connects from 127.0.0.1, so a socket check alone would open
 * the admin API to the internet through the front door. Proxied requests are
 * distinguishable the same way client-address.ts trusts them: the proxy
 * always adds X-Forwarded-For, and a genuinely local caller never does. So:
 * loopback socket AND no forwarding header, or it did not happen. Exported
 * for the test that pins this exact trap shut.
 */
export function adminAllowed(remoteAddress: string | undefined, forwardedFor: string | undefined): boolean {
  if (forwardedFor !== undefined) return false;
  if (!remoteAddress) return false;
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1"
  );
}

async function handle(
  bridge: Bridge,
  req: IncomingMessage,
  res: ServerResponse,
  manager?: AttachmentManager,
  forwards: ForwardRoute[] = [],
): Promise<void> {
  // CORS: A2A clients may run in browsers. The PACT provider's OAuth pages a
  // person opens are the exception: they set their own headers and refuse
  // framing (BRIDGE-A2A.md §14.8).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, A2A-Version, A2A-Extensions, X-A2A-User-Delegation");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", bridge.config.publicBaseUrl);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/" || path === "/healthz")) {
    return json(res, bridge.ready ? 200 : 503, {
      ok: bridge.ready,
      ready: bridge.ready,
      service: "agentmesh-bridge-a2a",
      direction: ["inbound", "outbound"],
      a2a_protocol_version: A2A_PROTOCOL_VERSION,
      node: bridge.nodeId,
      auth: {
        api_key: bridge.apiKeyRequired,
        anonymous: bridge.anonymousAllowed,
      },
      mapping: "https://github.com/jeffrschneider/agent-messaging-server/blob/main/a2a-gateway/MAPPING.md",
    });
  }

  // Bound to the port but not yet on the mesh (boot.ts binds first, on purpose).
  if (!bridge.ready) {
    return json(res, 503, { error: "bridge is not connected to the mesh yet" });
  }

  // The admin surface (attachments CRUD). Localhost-trusted: see adminAllowed
  // for why the check is two-part. No API key applies here on purpose — the
  // keys admit A2A callers to mesh work, and an attacker holding one must not
  // thereby hold the attachment store.
  if (path.startsWith("/admin/")) {
    if (!adminAllowed(req.socket.remoteAddress, header(req, "x-forwarded-for"))) {
      return json(res, 403, { error: "admin routes answer only local, unproxied callers" });
    }
    if (path.startsWith("/admin/keys")) {
      const keys = bridge.config.keyStore;
      if (!keys) return json(res, 404, { error: "no key store on this bridge" });
      return handleAdminKeys(keys, req, res, path);
    }
    if (path.startsWith("/admin/callers")) {
      return handleAdminCallers(bridge, req, res, path);
    }
    // What a front end beside the gateway needs of it (relay.ts).
    if (path === "/admin/relay" || path.startsWith("/admin/relay/")) {
      return handleAdminRelay(bridge, manager, req, res, path);
    }
    // An admin path a front end beside the gateway answers (FORWARD_ROUTES):
    // forwarded only after the gate above, so it too answers local callers only.
    const adminTarget = forwardFor(forwards, path);
    if (adminTarget) return forward(req, res, adminTarget);
    if (!manager) {
      return json(res, 404, { error: "no attachment manager on this bridge" });
    }
    return handleAdmin(manager, req, res, path);
  }

  // A path prefix a front end beside the gateway answers (FORWARD_ROUTES): on
  // AgentMesh, PACT's routes under /a2a/{brandId} (BRIDGE-A2A.md §14), which
  // the platform's PACT Provider serves. With no forward, /a2a/ is unknown here.
  const target = forwardFor(forwards, url.pathname);
  if (target) return forward(req, res, target);
  if (/^\/a2a(\/|$)/.test(url.pathname)) return bare(res, 404);

  if (req.method === "GET" && path === "/agents") {
    const caller = admit(bridge, req);
    if ("refused" in caller) return refuse(res, caller.refused);
    if ("limited" in caller) return throttle(res, caller.retryAfter);
    const agents = await bridge.listExposable();
    return json(res, 200, {
      agents: agents.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        card: `${bridge.config.publicBaseUrl}/agents/${m.id}/.well-known/agent-card.json`,
        rpc: `${bridge.config.publicBaseUrl}/agents/${m.id}/rpc`,
      })),
    });
  }

  const cardMatch = path.match(/^\/agents\/([^/]+)\/\.well-known\/agent-card\.json$/);
  if (req.method === "GET" && cardMatch) {
    const caller = admit(bridge, req);
    if ("refused" in caller) return refuse(res, caller.refused);
    if ("limited" in caller) return throttle(res, caller.retryAfter);
    const manifest = await bridge.exposableManifest(cardMatch[1]);
    if (!manifest) return json(res, 404, { error: "agent not found" });
    if (!isExposed(manifest)) return json(res, 403, meshOnly(cardMatch[1]));
    return json(
      res,
      200,
      manifestToCard(manifest, bridge.config.publicBaseUrl, {
        apiKey: bridge.apiKeyRequired,
        anonymous: bridge.anonymousAllowed,
      }),
    );
  }

  const rpcMatch = path.match(/^\/agents\/([^/]+)\/rpc$/);
  if (req.method === "POST" && rpcMatch) {
    return withInboundTrace(req, res, () => handleRpc(bridge, req, res, rpcMatch[1], manager));
  }

  // The HTTP+JSON binding (BRIDGE-A2A.md §13): every other path under an
  // agent's interface URL. Unknown paths and wrong methods answer bare.
  const restMatch = path.match(/^\/agents\/([^/]+)\/(.+)$/);
  if (restMatch) {
    const matched = matchRestRoute(req.method ?? "GET", restMatch[2].split("/"));
    if (matched && "route" in matched) {
      return withInboundTrace(req, res, () => handleRest(bridge, req, res, restMatch[1], matched.route, url, manager));
    }
    return bare(res, matched ? 405 : 404);
  }

  json(res, 404, { error: "not found" });
}

// ─── The HTTP+JSON binding (BRIDGE-A2A.md §13) ───────────────────────

/** JSON-RPC method each REST operation stands for. */
const REST_METHOD: Record<RestRoute["op"], string> = {
  send: "SendMessage",
  stream: "SendStreamingMessage",
  getTask: "GetTask",
  cancelTask: "CancelTask",
  listTasks: "ListTasks",
  subscribe: "SubscribeToTask",
  push: "CreateTaskPushNotificationConfig",
  extendedCard: "GetExtendedAgentCard",
};

/**
 * One HTTP+JSON call. The version is checked here (this interface serves 1.0,
 * and a request naming none is served as 1.0); everything else is the shared
 * handler's, run on the JSON-RPC request the call stands for, with its answer
 * reshaped on the way out.
 */
async function handleRest(
  bridge: Bridge,
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  route: RestRoute,
  url: URL,
  manager?: AttachmentManager,
): Promise<void> {
  const version = requestedVersion(header(req, "a2a-version"), url);
  if (!restVersionServed(version)) {
    const e = a2aRestError("VERSION_NOT_SUPPORTED", `A2A version ${version} is not served on this interface; it serves 1.0`);
    return restJson(res, e.http, e.body);
  }

  let params: unknown;
  if (route.op === "send" || route.op === "stream") {
    try {
      params = JSON.parse(await readBody(req));
    } catch {
      // A body that is not JSON. The caller is still admitted first, so a
      // stranger learns nothing from a malformed body that a well-formed one
      // would not have told it.
      const caller = admit(bridge, req);
      if ("refused" in caller) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="agentmesh-bridge-a2a"');
        const g = rpcErrorToRest({ code: RpcCode.INTERNAL_ERROR, message: caller.refused.message, data: { agentmesh_code: "UNAUTHORIZED" } }, 401);
        return restJson(res, g.http, g.body);
      }
      if ("limited" in caller) {
        res.setHeader("Retry-After", String(caller.retryAfter));
        const g = rpcErrorToRest({ code: RpcCode.INTERNAL_ERROR, message: "Rate limited", data: { agentmesh_code: "RATE_LIMITED" } }, 429);
        return restJson(res, g.http, g.body);
      }
      const e = a2aRestError("INVALID_PARAMS", "The request body is not JSON");
      return restJson(res, e.http, e.body);
    }
  } else if (route.op === "getTask" || route.op === "cancelTask") {
    params = { id: route.id };
  } else if (route.op === "subscribe") {
    params = { id: route.id };
  }

  const rpc: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: REST_METHOD[route.op], ...(params !== undefined ? { params } : {}) };
  const capture = new RestCapture(res, { unwrapTask: route.op === "getTask" || route.op === "cancelTask" });
  await handleRpc(bridge, req, capture as unknown as ServerResponse, agentId, manager, rpc);
  capture.finish();
}

/**
 * Stands in for the ServerResponse the shared handler writes to, and writes
 * the HTTP+JSON form to the real one. A unary answer is buffered and reshaped
 * whole; a stream is reshaped one `data:` event at a time as it is written.
 */
class RestCapture {
  headersSent = false;
  private status = 200;
  private headers: Record<string, string> = {};
  private body = "";
  private streaming = false;
  private done = false;

  constructor(
    private readonly real: ServerResponse,
    private readonly opts: { unwrapTask: boolean },
  ) {}

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
    return this;
  }

  writeHead(status: number, headers?: Record<string, string | number>): this {
    this.status = status;
    for (const [k, v] of Object.entries(headers ?? {})) this.headers[k] = String(v);
    this.headersSent = true;
    const type = Object.entries(this.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    if (type.startsWith("text/event-stream")) {
      this.streaming = true;
      this.real.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    }
    return this;
  }

  write(chunk: string | Buffer): boolean {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (!this.streaming) {
      this.body += text;
      return true;
    }
    for (const event of text.split("\n\n")) {
      const line = event.trim();
      if (!line.startsWith("data:")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.slice("data:".length).trim());
      } catch {
        continue;
      }
      this.real.write(`data: ${JSON.stringify(rpcStreamEventToRest(parsed))}\n\n`);
    }
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.write(chunk);
    if (this.streaming) {
      this.done = true;
      this.real.end();
    }
    return this;
  }

  /** Send the buffered unary answer, reshaped. Called once the shared
   *  handler has returned. */
  finish(): void {
    if (this.done || this.streaming) return;
    this.done = true;
    if (this.real.headersSent) return;
    let parsed: unknown = null;
    try {
      parsed = this.body ? JSON.parse(this.body) : null;
    } catch {
      parsed = null;
    }
    const answer = rpcToRest(parsed, this.status, this.headers, { unwrapTask: this.opts.unwrapTask });
    restJson(this.real, answer.http, answer.body, answer.headers);
  }
}

function restJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": A2A_JSON, ...headers });
  res.end(JSON.stringify(body));
}

/** A status with no body at all: an unknown path (404) or a known path with
 *  the wrong method (405). */
function bare(res: ServerResponse, status: number): void {
  if (res.headersSent) return;
  res.writeHead(status);
  res.end();
}

/** The refusal an outside caller gets for an agent its operator has not
 *  opened to the outside: the same sentence on the card route and the RPC
 *  route, so a client sees one story. */
function meshOnly(agentId: string): { error: string; agentmesh_code: "MESH_ONLY"; agent: string } {
  return {
    error: "This agent is reachable on the AgentMesh network only. Its operator has not opened it to callers outside the mesh, so this gateway names no door for it.",
    agentmesh_code: "MESH_ONLY",
    agent: agentId,
  };
}

async function handleRpc(
  bridge: Bridge,
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  manager?: AttachmentManager,
  /** The request already built by the HTTP+JSON binding (BRIDGE-A2A.md §13),
   *  which has read the body itself. */
  preparsed?: JsonRpcRequest,
): Promise<void> {
  let rpc: JsonRpcRequest;
  if (preparsed) {
    rpc = preparsed;
  } else {
    try {
      const body = await readBody(req);
      rpc = JSON.parse(body) as JsonRpcRequest;
    } catch {
      return json(res, 200, rpcError(null, RpcCode.PARSE_ERROR, "Invalid JSON"));
    }
  }
  const id = rpc?.id ?? null;
  if (rpc?.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return json(res, 200, rpcError(id, RpcCode.INVALID_REQUEST, "Not a JSON-RPC 2.0 request"));
  }

  // Version negotiation (BRIDGE-A2A.md §3).
  const versionHeader = header(req, "a2a-version");
  if (versionHeader && !SUPPORTED_A2A_VERSIONS.has(versionHeader)) {
    return json(res, 200, rpcError(id, RpcCode.VERSION_NOT_SUPPORTED, `A2A version ${versionHeader} is not supported; supported: ${[...SUPPORTED_A2A_VERSIONS].join(", ")}`));
  }

  // Caller identity + rate limit (BRIDGE-A2A.md §9). Fail-closed: no key and no
  // ALLOW_ANONYMOUS means no mesh identity is minted and no mesh work is done.
  const admitted = admit(bridge, req);
  if ("refused" in admitted) {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="agentmesh-bridge-a2a"',
    });
    return void res.end(
      JSON.stringify(
        rpcError(id, RpcCode.INTERNAL_ERROR, admitted.refused.message, {
          agentmesh_code: "UNAUTHORIZED",
          reason: admitted.refused.reason,
        }),
      ),
    );
  }
  if ("limited" in admitted) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(admitted.retryAfter) });
    return void res.end(JSON.stringify(rpcError(id, RpcCode.INTERNAL_ERROR, "Rate limited", { agentmesh_code: "RATE_LIMITED" })));
  }
  const callerKey = admitted.key;

  // Unimplemented methods answer with their exact mapped error (§4.2).
  switch (rpc.method) {
    case "ListTasks":
    case "SubscribeToTask":
      return json(res, 200, rpcError(id, RpcCode.UNSUPPORTED_OPERATION, `${rpc.method} is not supported by this bridge (BRIDGE-A2A.md 4.2)`));
    case "CreateTaskPushNotificationConfig":
    case "GetTaskPushNotificationConfig":
    case "ListTaskPushNotificationConfig":
    case "DeleteTaskPushNotificationConfig":
      return json(res, 200, rpcError(id, RpcCode.PUSH_NOTIFICATION_NOT_SUPPORTED, "Push notifications are not supported by this bridge (BRIDGE-A2A.md 4.2)"));
    case "GetExtendedAgentCard":
      return json(res, 200, rpcError(id, RpcCode.EXTENDED_CARD_NOT_CONFIGURED, "No extended agent card is configured (BRIDGE-A2A.md 4.2)"));
  }

  const manifest = await bridge.exposableManifest(agentId);
  if (!manifest) {
    return json(res, 200, rpcError(id, RpcCode.INVALID_PARAMS, "Unknown agent", { agentmesh_code: "AGENT_UNAVAILABLE" }));
  }
  // Mesh only: the operator has not opened this agent to callers outside
  // the mesh. A typed refusal, not silence, so a developer holding the
  // platform's card for it learns why the call does not go through.
  if (!isExposed(manifest)) {
    return json(res, 403, rpcError(id, RpcCode.INVALID_PARAMS, meshOnly(agentId).error, { agentmesh_code: "MESH_ONLY" }));
  }

  // Priced attachments clear in credits (BRIDGE-A2A.md §9.1's 402, live).
  // The pre-check runs BEFORE any mesh work: an account-less caller or an
  // empty pocket is refused here, and an unreachable ledger fails CLOSED for
  // priced calls — an open till is a policy, a broken till is not.
  if (manager && (rpc.method === "SendMessage" || rpc.method === "SendStreamingMessage")) {
    const priced = await manager.priceForAgent(agentId);
    if (priced) {
      const account = await bridge.accountForCallerKey(callerKey);
      // Where a caller gets an account key and credits: the platform's app,
      // from the deployment's environment file. A gateway run without one
      // (the Agent Messaging Server alone) still refuses with 402 and points
      // the caller at the mesh's operator instead of failing with a 500.
      const creditsUrl = amEnvOptional("urls.app");
      const where = creditsUrl ? `at ${creditsUrl} (A2A API keys card)` : "from this mesh's operator";
      // The caller is usually an AGENT, so the refusal carries its facts as
      // data, not just prose: the price, the balance where one exists, and —
      // load-bearing for the future — `accepted`, an ARRAY of settlement
      // methods (SPEC.md §1.3, payments: the protocol defines the shape of
      // the demand, never the movement of the money). One entry today, the
      // platform ledger; an x402 entry (chain, asset, address) drops in
      // beside it later without changing any consumer that learned to read
      // the array. `credits_url` stays as a convenience alias of accepted[0].
      const refuse402 = (message: string, detail: Record<string, unknown> = {}) => {
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            rpcError(id, RpcCode.INTERNAL_ERROR, message, {
              agentmesh_code: "PAYMENT_REQUIRED",
              price_credits: priced.retail,
              // §9.2: the retail total contains the operator's cut, and the
              // refusal says so on its own line rather than quoting one number
              // that is silently two. A refusal carrying no line asserts that
              // no operator fee is inside its total, so the line is omitted
              // only where nothing was taken.
              ...(priced.operatorFee ? { operator_fee: priced.operatorFee } : {}),
              // Each accepted method quotes in its OWN unit, so a future
              // x402 entry says {amount:"0.002", unit:"USDC", chain, address}
              // beside this one and pricing is per-rail data, not a schema.
              // §9.2 rule 2: an entry that carries a fee carries its OWN line,
              // in its own denomination, and never inherits another entry's.
              accepted: [
                {
                  method: "agentmesh-credits",
                  amount: priced.retail,
                  unit: "credit",
                  ...(creditsUrl ? { url: creditsUrl } : {}),
                  ...(priced.operatorFee ? { operator_fee: priced.operatorFee } : {}),
                },
              ],
              ...(creditsUrl ? { credits_url: creditsUrl } : {}),
              ...detail,
            }),
          ),
        );
      };
      if (!account) {
        return refuse402(
          `This agent charges ${priced.retail} credit(s) per call. Calls are charged to an account: mint an account-backed API key ${where} and retry with it. Accounts start with a credit grant.`,
          { reason: "no_account" },
        );
      }
      if (account !== priced.ownerAccount) {
        const balance = await manager.ledgerBalance(account);
        if (balance === null) {
          return refuse402("This agent charges credits and the ledger is unreachable; try again shortly.", {
            reason: "ledger_unreachable",
          });
        }
        if (balance < priced.retail) {
          return refuse402(
            `This agent charges ${priced.retail} credit(s) per call and this account holds ${balance}. ` +
              (creditsUrl
                ? `Credits arrive as a monthly grant today (see the Credits card at ${creditsUrl}); earning them by serving priced calls works too, and buying them is coming.`
                : "Ask this mesh's operator for credits."),
            { reason: "insufficient", balance_credits: balance },
          );
        }
      }
    }
  }

  // Mint (or revive) the hosted identity only now that there is real work to
  // vouch for. Awaited: on first sight this reads the caller's durable record
  // and registers the §2.1 rule 2 marker manifest, both once per caller.
  const requester = await bridge.identityFor(callerKey);

  switch (rpc.method) {
    case "SendMessage":
      return sendMessage(bridge, res, id, rpc.params as SendMessageParams, manifest, requester, callerKey);
    case "SendStreamingMessage":
      return sendStreamingMessage(bridge, res, id, rpc.params as SendMessageParams, manifest, requester, callerKey);
    case "GetTask":
      return getTask(bridge, res, id, rpc.params as { id?: string }, callerKey);
    case "CancelTask":
      return cancelTask(bridge, res, id, rpc.params as { id?: string }, manifest, requester, callerKey);
    default:
      return json(res, 200, rpcError(id, RpcCode.METHOD_NOT_FOUND, `Unknown method: ${rpc.method}`));
  }
}

// ─── Files (§7.5) ────────────────────────────────────────────────────

/** Where a file an A2A caller attached is served from once stored. The bridge
 *  and the artifact door are usually the same deployment but need not be, so
 *  it is configurable and defaults to the public mesh. */

/**
 * Put an inbound file into the mesh artifact store, as the bridge's own agent.
 *
 * The bytes are stored under the BRIDGE's owner, not the caller's — an A2A
 * caller has no mesh identity and therefore no quota of its own, so the party
 * accountable for the storage is the one that chose to accept the request.
 * That is also what makes the bridge's own quota the natural limit on how much
 * an anonymous caller can push into the mesh.
 */
function fileSink(requester: AgentMesh): FileSink {
  return {
    async store({ name, mediaType, bytes }): Promise<MeshFile> {
      const stored = await requester.putArtifact(bytes, { media_type: mediaType, name });
      return {
        ...(stored.name ? { name: stored.name } : {}),
        ...(stored.media_type ? { media_type: stored.media_type } : {}),
        ref: stored.ref,
        size: stored.size,
      };
    },
  };
}

// ─── SendMessage (§4.3) ──────────────────────────────────────────────

function resolveSkill(params: SendMessageParams, manifest: Manifest): string | { rpcError: JsonRpcResponse["error"] } {
  // "skill" is A2A-side vocabulary and stays in messages TO a2a callers; the
  // mesh-side concept is the offering (§8.5). Both metadata keys are read —
  // `agentmesh.offering` is canonical, `agentmesh.skill` the pre-rename spelling.
  const hint = params.message?.metadata?.["agentmesh.offering"] ?? params.message?.metadata?.["agentmesh.skill"];
  const skillIds = manifest.offerings.map((s) => s.id);
  if (typeof hint === "string") {
    if (skillIds.includes(hint)) return hint;
    return { rpcError: { code: RpcCode.INVALID_PARAMS, message: `Skill "${hint}" is not declared by this agent. Declared skills: ${skillIds.join(", ")}` } };
  }
  if (skillIds.length === 1) return skillIds[0];
  return { rpcError: { code: RpcCode.INVALID_PARAMS, message: `This agent declares ${skillIds.length} skills; set message.metadata["agentmesh.offering"] to one of: ${skillIds.join(", ")}` } };
}

async function validateAndPrepare(
  params: SendMessageParams | undefined,
  manifest: Manifest,
  sink?: FileSink,
): Promise<{ skill: string; input: unknown } | { errResp: (id: JsonRpcRequest["id"]) => JsonRpcResponse }> {
  if (!params?.message?.parts?.length) {
    return { errResp: (id) => rpcError(id, RpcCode.INVALID_PARAMS, "params.message.parts is required") };
  }
  const skill = resolveSkill(params, manifest);
  if (typeof skill !== "string") {
    return { errResp: (id) => ({ jsonrpc: "2.0", id, error: skill.rpcError! }) };
  }
  try {
    const base = await partsToInput(params.message.parts, sink);
    // A revision (Common Agent spec §5.7) in A2A's own vocabulary: the first
    // referenceTaskId is the prior task, and the job's manifest reference and
    // the steps to redo ride the message metadata. Merged onto the input so
    // the mesh side sees the same request a mesh caller would send.
    const m = params.message;
    const meta = m.metadata ?? {};
    const revises = Array.isArray(m.referenceTaskIds) && typeof m.referenceTaskIds[0] === "string" ? m.referenceTaskIds[0] : undefined;
    const jobRef = typeof meta["agentmesh.job"] === "string" ? (meta["agentmesh.job"] as string) : undefined;
    const steps = Array.isArray(meta["agentmesh.steps"]) ? (meta["agentmesh.steps"] as unknown[]).filter((s): s is string => typeof s === "string") : [];
    const extra = { ...(revises ? { revises } : {}), ...(jobRef ? { job: { manifest: jobRef } } : {}), ...(steps.length ? { steps } : {}) };
    const input = Object.keys(extra).length && base && typeof base === "object" && !Array.isArray(base)
      ? { ...(base as Record<string, unknown>), ...extra }
      : base;
    return { skill, input };
  } catch (err) {
    // A file the bridge could not store is INTERNAL, not "unsupported type":
    // the type IS supported now, and telling a caller otherwise sends them off
    // to re-encode a file that was never the problem.
    if (err instanceof FileStoreError) {
      return { errResp: (id) => rpcError(id, RpcCode.INTERNAL_ERROR, err.message) };
    }
    if (err instanceof FilePartError) {
      return { errResp: (id) => rpcError(id, RpcCode.CONTENT_TYPE_NOT_SUPPORTED, err.message) };
    }
    throw err;
  }
}

/**
 * The attribution every inbound mesh request carries (BRIDGE-A2A.md §2.1 rule
 * 2, §8.3): `meta.a2a_bridge`, naming the direction, the vouching node, and the
 * stable opaque handle for the caller. Envelope `meta` is covered by the
 * envelope signature, so what the receiver reads is what the bridge node
 * signed — not a header an intermediary could have written.
 */
function withAttribution<T extends RequestConfig>(bridge: Bridge, callerKey: string, config: T): T {
  const meta = bridge.attributionMeta(callerKey);
  return meta ? { ...config, meta } : config;
}

/** One inbound gateway call, onto the usage topic. Fire-and-forget by
 *  construction (bridge.emitUsage swallows), so it can sit on the response
 *  path without being able to affect it. */
function tapInbound(
  bridge: Bridge,
  callerKey: string,
  fields: { responder: string; offering: string; outcome: "ok" | "error"; startedAt: number },
): void {
  bridge.emitInboundCall(callerKey, {
    responder: fields.responder,
    offering: fields.offering,
    outcome: fields.outcome,
    latencyMs: Date.now() - fields.startedAt,
    at: new Date().toISOString(),
  });
}

/**
 * The §6.4a queued acknowledgement, as an A2A task. The responder's node has
 * the message in a held mailbox for an attended session; no mesh task exists,
 * and the reply, if any, arrives later at the caller identity's inbox. A2A
 * has one spelling for "received, nothing has happened yet": a task in
 * `submitted`. The task's id is the mesh request's id, because that is what
 * the reply names when it comes (Bridge.lateReply completes it).
 */
function queuedTask(err: MeshError): A2ATask | null {
  const det = (err.details ?? {}) as { request_id?: unknown; inbox_id?: unknown };
  if (typeof det.request_id !== "string" || !det.request_id) return null;
  return {
    id: det.request_id,
    status: {
      state: "submitted",
      timestamp: new Date().toISOString(),
      message: {
        role: "ROLE_AGENT",
        parts: [{ text: QUEUED_SENTENCE }],
        messageId: `${det.request_id}-queued`,
      },
    },
  };
}
const QUEUED_SENTENCE =
  "The agent's node has queued this message for its attended session, so a person or a live session answers it, and that can take hours. The reply, if any, lands on this task as an artifact: poll GetTask for it rather than holding the call. The gateway keeps this task for 24 hours.";

function queuedInboxId(err: MeshError): string | null {
  const det = (err.details ?? {}) as { inbox_id?: unknown };
  return typeof det.inbox_id === "string" ? det.inbox_id : null;
}

async function sendMessage(
  bridge: Bridge,
  res: ServerResponse,
  id: JsonRpcRequest["id"],
  params: SendMessageParams | undefined,
  manifest: Manifest,
  requester: AgentMesh,
  callerKey: string,
): Promise<void> {
  const prep = await validateAndPrepare(params, manifest, fileSink(requester));
  if ("errResp" in prep) return json(res, 200, prep.errResp(id));

  const startedAt = Date.now();
  const tap = (outcome: "ok" | "error") =>
    tapInbound(bridge, callerKey, { responder: manifest.id, offering: prep.skill, outcome, startedAt });

  try {
    const contextId = typeof params?.message?.contextId === "string" && params.message.contextId ? params.message.contextId : undefined;
    const result = await requester.request(
      manifest.id,
      prep.skill,
      prep.input,
      withAttribution(bridge, callerKey, { timeout_ms: 60_000, ...(contextId ? { context_id: contextId } : {}) }),
    );
    tap("ok");

    if (result.task_id === null) {
      // Bare terminal response → direct Message or JSON-RPC error (§4.3).
      if (result.payload.status === "completed") {
        const out: SendMessageResult = {
          message: {
            role: "ROLE_AGENT",
            // Files by signed link, made with this caller's mesh identity
            // (AgentMesh technical debt 447: the run-file door needs a session).
            parts: outputToParts(await linkFiles(result.payload.output, meshLinker(requester))),
            messageId: result.envelope.id,
          },
        };
        return json(res, 200, rpcResult(id, out));
      }
      const code = result.payload.status === "rejected" ? RpcCode.UNSUPPORTED_OPERATION : RpcCode.INTERNAL_ERROR;
      return json(res, 200, rpcError(id, code, result.payload.message ?? `Agent ${result.payload.status} the request`, { agentmesh_status: result.payload.status }));
    }

    // Task mode (deferred) → A2A Task (§4.3).
    const taskCtx = (result.envelope as { context_id?: string } | undefined)?.context_id ?? contextId;
    const task: A2ATask = {
      id: result.task_id,
      ...(taskCtx ? { contextId: taskCtx } : {}),
      status: { state: meshStateToA2A(result.payload.status), timestamp: new Date().toISOString() },
    };
    bridge.putTask({ task, responder: manifest.id, callerKey });
    return json(res, 200, rpcResult(id, { task } satisfies SendMessageResult));
  } catch (err) {
    // Queued at the responder's node for an attended session: delivered, not
    // answered. That is a task in `submitted`, and the call succeeded.
    const queued = err instanceof MeshError && err.code === ErrorCode.REQUEST_QUEUED ? queuedTask(err) : null;
    if (queued) {
      tap("ok");
      bridge.putTask({ task: queued, responder: manifest.id, callerKey, queued: { inbox_id: queuedInboxId(err as MeshError) } });
      return json(res, 200, rpcResult(id, { task: queued } satisfies SendMessageResult));
    }
    tap("error");
    const mapped = meshErrorToRpc(err);
    res.writeHead(mapped.httpStatus === 200 ? 200 : mapped.httpStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: mapped.error }));
  }
}

// ─── SendStreamingMessage (§4.4) ─────────────────────────────────────

async function sendStreamingMessage(
  bridge: Bridge,
  res: ServerResponse,
  id: JsonRpcRequest["id"],
  params: SendMessageParams | undefined,
  manifest: Manifest,
  requester: AgentMesh,
  callerKey: string,
): Promise<void> {
  const prep = await validateAndPrepare(params, manifest, fileSink(requester));
  if ("errResp" in prep) return json(res, 200, prep.errResp(id));

  const streamingSkill = manifest.offerings.find((s) => s.id === prep.skill)?.streaming === true;
  if (!streamingSkill) {
    return json(res, 200, rpcError(id, RpcCode.UNSUPPORTED_OPERATION, `Skill "${prep.skill}" does not support streaming`));
  }

  const startedAt = Date.now();
  const tap = (outcome: "ok" | "error") =>
    tapInbound(bridge, callerKey, { responder: manifest.id, offering: prep.skill, outcome, startedAt });

  let stream;
  try {
    stream = await requester.requestStream(
      manifest.id,
      prep.skill,
      prep.input,
      withAttribution(bridge, callerKey, { timeout_ms: 60_000 }),
    );
  } catch (err) {
    // Queued for an attended session: one event, the submitted task, and the
    // stream ends. The reply lands on the task; the client polls GetTask.
    const queued = err instanceof MeshError && err.code === ErrorCode.REQUEST_QUEUED ? queuedTask(err) : null;
    if (queued) {
      tap("ok");
      bridge.putTask({ task: queued, responder: manifest.id, callerKey, queued: { inbox_id: queuedInboxId(err as MeshError) } });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify(rpcResult(id, { task: queued }))}\n\n`);
      res.end();
      return;
    }
    tap("error");
    const mapped = meshErrorToRpc(err);
    return json(res, 200, { jsonrpc: "2.0", id, error: mapped.error });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: StreamEvent) => {
    res.write(`data: ${JSON.stringify(rpcResult(id, event))}\n\n`);
  };

  const taskId = stream.task_id;
  const task: A2ATask = { id: taskId, status: { state: "working", timestamp: new Date().toISOString() } };
  bridge.putTask({ task, responder: manifest.id, callerKey });
  send({ task });

  try {
    // The SDK verifies stream-level auth including final chunk_count (§11.6);
    // iteration throws on truncation/tamper, which we surface as -32006.
    for await (const chunk of stream.chunks) {
      send({
        artifactUpdate: {
          taskId,
          artifact: { artifactId: `${taskId}-${chunk.chunk_index}`, parts: outputToParts(await linkFiles(chunk.data, meshLinker(requester))) },
        },
      });
      if (chunk.final) {
        const status = { state: "completed" as const, timestamp: new Date().toISOString() };
        bridge.updateTask(taskId, { ...task, status });
        send({ statusUpdate: { taskId, status, final: true } });
      }
    }
    tap("ok");
  } catch (err) {
    tap("error");
    bridge.updateTask(taskId, { ...task, status: { state: "failed", timestamp: new Date().toISOString() } });
    const message = err instanceof MeshError ? err.message : String(err);
    res.write(`data: ${JSON.stringify(rpcError(id, RpcCode.INVALID_AGENT_RESPONSE, `Stream failed verification or aborted: ${message}`, { agentmesh_code: err instanceof MeshError ? err.code : "INTERNAL_ERROR" }))}\n\n`);
  }
  res.end();
}

// ─── GetTask / CancelTask (§4.1) ─────────────────────────────────────

function getTask(
  bridge: Bridge,
  res: ServerResponse,
  id: JsonRpcRequest["id"],
  params: { id?: string } | undefined,
  callerKey: string,
): void {
  const rec = params?.id ? bridge.getTaskRecord(params.id) : undefined;
  // Tasks are caller-scoped: another caller's task IDs are "not found".
  if (!rec || rec.callerKey !== callerKey) {
    return json(res, 200, rpcError(id, RpcCode.TASK_NOT_FOUND, "Task not found"));
  }
  json(res, 200, rpcResult(id, { task: rec.task }));
}

async function cancelTask(
  bridge: Bridge,
  res: ServerResponse,
  id: JsonRpcRequest["id"],
  params: { id?: string } | undefined,
  manifest: Manifest,
  requester: AgentMesh,
  callerKey: string,
): Promise<void> {
  const rec = params?.id ? bridge.getTaskRecord(params.id) : undefined;
  if (!rec || rec.callerKey !== callerKey) {
    return json(res, 200, rpcError(id, RpcCode.TASK_NOT_FOUND, "Task not found"));
  }
  try {
    // Cancel is the composed operation (SPEC.md §10.8): request skill "task.cancel".
    // §10.8 requires a closed-enum reason. An A2A tasks/cancel carries no reason
    // of its own, and it is always the calling client asking, so it maps to
    // user_requested; the note records the provenance for humans.
    const result = await requester.request(
      rec.responder,
      "task.cancel",
      { task_id: rec.task.id, reason: "user_requested", note: "via A2A tasks/cancel" },
      withAttribution(bridge, callerKey, { timeout_ms: 15_000 }),
    );
    const state = meshStateToA2A(result.payload.status);
    const task: A2ATask = { ...rec.task, status: { state, timestamp: new Date().toISOString() } };
    bridge.updateTask(rec.task.id, task);
    json(res, 200, rpcResult(id, { task }));
  } catch (err) {
    // A responder without a task.cancel handler cannot cancel — that is
    // "not cancelable", not "internal error".
    if (err instanceof MeshError && (err.code === ErrorCode.OFFERING_NOT_FOUND || (err.code as string) === "SKILL_NOT_FOUND" || err.code === ErrorCode.TASK_NOT_CANCELABLE)) {
      return json(res, 200, rpcError(id, RpcCode.TASK_NOT_CANCELABLE, "This agent does not support cancellation", { agentmesh_code: err.code }));
    }
    const mapped = meshErrorToRpc(err);
    json(res, 200, { jsonrpc: "2.0", id, error: mapped.error });
  }
}

// ─── Admin surface (attachments) ─────────────────────────────────────

async function handleAdmin(
  manager: AttachmentManager,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  try {
    if (req.method === "POST" && path === "/admin/attachments/preview") {
      const body = (await readJson(req)) as { url?: string; headers?: Record<string, string> };
      if (!body?.url) throw new AdminError(422, "url is required");
      return json(res, 200, await manager.preview(body.url, body.headers));
    }
    if (req.method === "POST" && path === "/admin/attachments") {
      const body = (await readJson(req)) as CreateAttachmentInput & { exposedOfferings?: string[] };
      if (!body?.url) throw new AdminError(422, "url is required");
      // §8.5 rename: `exposedOfferings` is the canonical API spelling; the
      // stored record keeps `exposedSkills` (records already exist under it,
      // and the ids ARE the remote card's A2A skill ids).
      if (body.exposedOfferings !== undefined && body.exposedSkills === undefined) {
        body.exposedSkills = body.exposedOfferings;
      }
      const rec = await manager.create(body);
      const { identitySeed: _seed, headers: _headers, ...safe } = rec;
      return json(res, 201, safe);
    }
    if (req.method === "GET" && path === "/admin/attachments") {
      return json(res, 200, { attachments: await manager.list() });
    }
    // Charges that have not reached the ledger, and charges that never will.
    // An abandoned settlement is money somebody was owed for work that was
    // delivered, and this is where it can be found rather than only in the log
    // line written the moment it was given up on.
    if (req.method === "POST" && path === "/admin/settlements/retry") {
      await manager.retrySettlements();
      const after = await manager.unsettled();
      return json(res, 200, {
        pending: after.filter((s) => s.state === "pending").length,
        abandoned: after.filter((s) => s.state === "abandoned").length,
      });
    }
    if (req.method === "GET" && path === "/admin/settlements") {
      const settlements = await manager.unsettled();
      return json(res, 200, {
        settlements,
        pending: settlements.filter((s) => s.state === "pending").length,
        abandoned: settlements.filter((s) => s.state === "abandoned").length,
      });
    }
    const approveMatch = path.match(/^\/admin\/attachments\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      return json(res, 200, await manager.approve(approveMatch[1]));
    }
    const idMatch = path.match(/^\/admin\/attachments\/([^/]+)$/);
    if (idMatch) {
      const id = idMatch[1];
      if (req.method === "GET") {
        const rec = await manager.get(id);
        if (!rec) throw new AdminError(404, "no such attachment");
        return json(res, 200, rec);
      }
      if (req.method === "PATCH") {
        return json(res, 200, await manager.patch(id, (await readJson(req)) as Record<string, unknown>));
      }
      if (req.method === "DELETE") {
        await manager.detach(id);
        return json(res, 200, { detached: id });
      }
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    if (err instanceof AdminError) return json(res, err.status, { error: err.message });
    throw err;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    throw new AdminError(400, "body must be JSON");
  }
}

/**
 * The key admin surface, behind the same local-and-unproxied gate. The mint
 * response is the ONLY place a raw key ever appears; listings carry prefix
 * and metadata, nothing presentable.
 */
async function handleAdminKeys(
  keys: NonNullable<Bridge["config"]["keyStore"]>,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  if (req.method === "POST" && path === "/admin/keys") {
    const body = (await readJson(req)) as { accountId?: string | null; label?: string };
    const { record, rawKey } = await keys.mint({ accountId: body?.accountId, label: body?.label });
    return json(res, 201, { key: rawKey, record: redactKey(record) });
  }
  if (req.method === "GET" && path === "/admin/keys") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const accountId = url.searchParams.get("accountId");
    const list = await keys.list(accountId === null ? undefined : accountId);
    return json(res, 200, { keys: list.map(redactKey) });
  }
  const idMatch = path.match(/^\/admin\/keys\/([^/]+)$/);
  if (idMatch) {
    if (req.method === "GET") {
      const rec = await keys.get(idMatch[1]);
      if (!rec) return json(res, 404, { error: "no such key" });
      return json(res, 200, redactKey(rec));
    }
    if (req.method === "DELETE") {
      const ok = await keys.revoke(idMatch[1]);
      if (!ok) return json(res, 404, { error: "no such live key" });
      return json(res, 200, { revoked: idMatch[1] });
    }
  }
  json(res, 404, { error: "not found" });
}

/**
 * "Who was this?" — the attribution lookup, behind the same local-and-unproxied
 * gate as the rest of /admin.
 *
 * This is the door the durable caller record exists for. An audit row, a
 * settlement, or an activity entry names a hosted mesh identity; before the
 * record, that string resolved to an account only while the process that
 * minted it was still running, so an investigation started a week later found
 * nothing. Now it resolves by agent id, by the `caller_ref` the §8.3 marker
 * publishes, or by account (which is the key list an account-scoped audit
 * export would need in order to include that account's gateway traffic).
 *
 * Everything here is redacted: no identity seed, and no caller-key digest —
 * an operator's env key is short and chosen by a person, so its digest would
 * be a guessing oracle.
 */
function handleAdminCallers(
  bridge: Bridge,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): void {
  if (req.method !== "GET") return json(res, 405, { error: "read-only surface" });
  if (!bridge.config.callerStore) {
    return json(res, 404, { error: "no caller-identity store on this bridge" });
  }
  if (path === "/admin/callers") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const accountId = url.searchParams.get("accountId");
    return json(res, 200, { callers: bridge.listCallers(accountId === null ? undefined : accountId) });
  }
  const idMatch = path.match(/^\/admin\/callers\/([^/]+)$/);
  if (idMatch) {
    // One path, either key: a mesh agent id is what a record names you with,
    // a ref is what the wire marker names you with, and an investigator has
    // whichever one their evidence carried.
    const found = bridge.callerForAgentId(idMatch[1]) ?? bridge.callerForRef(idMatch[1]);
    if (!found) return json(res, 404, { error: "no caller identity by that agent id or ref" });
    return json(res, 200, found);
  }
  json(res, 404, { error: "not found" });
}

// ─── plumbing ────────────────────────────────────────────────────────

function refuse(res: ServerResponse, refusal: CallerRefused): void {
  if (res.headersSent) return;
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Bearer realm="agentmesh-bridge-a2a"',
  });
  res.end(JSON.stringify({ error: refusal.message, reason: refusal.reason, agentmesh_code: "UNAUTHORIZED" }));
}

function throttle(res: ServerResponse, retryAfter: number): void {
  if (res.headersSent) return;
  res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfter) });
  res.end(JSON.stringify({ error: "Rate limited", agentmesh_code: "RATE_LIMITED" }));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(", ") : v;
}

/**
 * Carry an inbound W3C trace across the HTTP-to-mesh boundary (SPEC.md §13.1).
 *
 * The bridge is the one hop where a trace would otherwise break, and it breaks
 * at exactly the interesting place: the edge between two companies. A caller
 * that sends `traceparent` gets the mesh work it triggers filed under the same
 * trace, so its own tooling sees one continuous story instead of a request that
 * vanishes and an unrelated span appearing on the far side.
 *
 * Ambient rather than threaded through every call site: `createEnvelope` reads
 * the ambient context when no explicit trace is given, so every mesh message
 * any RPC method sends inherits it without each handler remembering to.
 *
 * A header that does not parse is simply ignored. `fromTraceparent` validates
 * the format, and the mesh side starts a fresh root rather than trusting bytes
 * a stranger typed. The response echoes the span the bridge actually used, so
 * the caller can link its side to ours without guessing.
 */
function withInboundTrace<T>(req: IncomingMessage, res: ServerResponse, fn: () => T): T {
  const traceparent = header(req, "traceparent");
  if (!traceparent) return fn();

  const ctx = fromTraceparent(traceparent, header(req, "tracestate"));
  if (!ctx) return fn();

  if (!res.headersSent) res.setHeader("traceparent", toTraceparent(ctx));
  return runWithTrace(ctx, fn);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
