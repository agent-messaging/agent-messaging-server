/**
 * The A2A 1.0 HTTP+JSON binding (A2A §11; BRIDGE-A2A.md §13). Pure functions:
 * route matching, the AIP-193 error envelope, the enum spellings, and the
 * reshaping of a JSON-RPC answer into its HTTP+JSON form.
 *
 * The HTTP+JSON routes run the same operations as the JSON-RPC route. The
 * server turns each REST call into the JSON-RPC request it stands for, runs it
 * through the one handler both bindings share, and reshapes what comes back
 * with `rpcToRest` below. That keeps admission, pricing, files and task
 * records in one place, and JSON-RPC behaves exactly as it did.
 */
import { RpcCode, type JsonRpcError } from "./jsonrpc.js";

export const A2A_JSON = "application/a2a+json";
export const ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";
export const A2A_DOMAIN = "a2a-protocol.org";
/** The domain of the gateway's own refusals (§9.1), which are not A2A errors. */
export const GATEWAY_DOMAIN = "agentmesh.ai";

// ─── Routes (A2A §11.3) ─────────────────────────────────────────────

export type RestRoute =
  | { op: "send" }
  | { op: "stream" }
  | { op: "getTask"; id: string }
  | { op: "cancelTask"; id: string }
  | { op: "listTasks" }
  | { op: "subscribe"; id: string }
  | { op: "push" }
  | { op: "extendedCard" };

/** What a path relative to an interface URL is, given its method. `route`
 *  is the matched operation; `methodNotAllowed` means the path is known but
 *  the method is not (405); neither means the path is unknown (404). */
export function matchRestRoute(
  method: string,
  segments: string[],
): { route: RestRoute } | { methodNotAllowed: true } | null {
  const path = segments.map(decodeSegment);
  const m = method.toUpperCase();
  const one = path.length === 1 ? path[0] : undefined;

  if (one === "message:send") return m === "POST" ? { route: { op: "send" } } : { methodNotAllowed: true };
  if (one === "message:stream") return m === "POST" ? { route: { op: "stream" } } : { methodNotAllowed: true };
  if (one === "tasks") return m === "GET" ? { route: { op: "listTasks" } } : { methodNotAllowed: true };
  if (one === "extendedAgentCard") return m === "GET" ? { route: { op: "extendedCard" } } : { methodNotAllowed: true };

  if (path.length === 2 && path[0] === "tasks" && path[1]) {
    const seg = path[1];
    const cancel = seg.match(/^(.+):cancel$/);
    if (cancel) return m === "POST" ? { route: { op: "cancelTask", id: cancel[1] } } : { methodNotAllowed: true };
    const subscribe = seg.match(/^(.+):subscribe$/);
    if (subscribe) return m === "POST" ? { route: { op: "subscribe", id: subscribe[1] } } : { methodNotAllowed: true };
    if (seg.includes(":")) return null;
    return m === "GET" ? { route: { op: "getTask", id: seg } } : { methodNotAllowed: true };
  }
  if (path.length === 3 && path[0] === "tasks" && path[1] && path[2] === "pushNotificationConfigs") {
    return m === "GET" || m === "POST" ? { route: { op: "push" } } : { methodNotAllowed: true };
  }
  if (path.length === 4 && path[0] === "tasks" && path[1] && path[2] === "pushNotificationConfigs" && path[3]) {
    return m === "GET" || m === "DELETE" ? { route: { op: "push" } } : { methodNotAllowed: true };
  }
  return null;
}

/** A path segment, with a percent-encoded colon (`message%3Asend`) decoded.
 *  Anything that does not decode is kept as it came. */
function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ─── Versions (A2A §3.6; BRIDGE-A2A.md §13.2) ───────────────────────

/** The A2A version a REST request asked for: the header, else the query
 *  parameter, else none. */
export function requestedVersion(header: string | undefined, url: URL): string | undefined {
  const h = header?.trim();
  if (h) return h;
  const q = url.searchParams.get("A2A-Version")?.trim();
  return q || undefined;
}

/** Whether this interface serves the version: 1.0, or none given. */
export function restVersionServed(version: string | undefined): boolean {
  return version === undefined || version === "1.0";
}

// ─── Errors (A2A §11.6, AIP-193) ────────────────────────────────────

export type A2AReason =
  | "INVALID_PARAMS"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_CANCELABLE"
  | "PUSH_NOTIFICATION_NOT_SUPPORTED"
  | "UNSUPPORTED_OPERATION"
  | "CONTENT_TYPE_NOT_SUPPORTED"
  | "INVALID_AGENT_RESPONSE"
  | "EXTENDED_AGENT_CARD_NOT_CONFIGURED"
  | "VERSION_NOT_SUPPORTED"
  | "INTERNAL";

/** BRIDGE-A2A.md §13.3's table: HTTP status and canonical status name. */
export const A2A_REASONS: Record<A2AReason, { http: number; status: string }> = {
  INVALID_PARAMS: { http: 400, status: "INVALID_ARGUMENT" },
  TASK_NOT_FOUND: { http: 404, status: "NOT_FOUND" },
  TASK_NOT_CANCELABLE: { http: 400, status: "FAILED_PRECONDITION" },
  PUSH_NOTIFICATION_NOT_SUPPORTED: { http: 400, status: "FAILED_PRECONDITION" },
  UNSUPPORTED_OPERATION: { http: 400, status: "FAILED_PRECONDITION" },
  CONTENT_TYPE_NOT_SUPPORTED: { http: 400, status: "INVALID_ARGUMENT" },
  INVALID_AGENT_RESPONSE: { http: 500, status: "INTERNAL" },
  EXTENDED_AGENT_CARD_NOT_CONFIGURED: { http: 400, status: "FAILED_PRECONDITION" },
  VERSION_NOT_SUPPORTED: { http: 400, status: "FAILED_PRECONDITION" },
  INTERNAL: { http: 500, status: "INTERNAL" },
};

/** The gateway's own refusals (§9.1), sent in the same envelope under
 *  `agentmesh.ai`. */
export type GatewayReason = "UNAUTHORIZED" | "RATE_LIMITED" | "PAYMENT_REQUIRED" | "MESH_ONLY" | "AGENT_UNAVAILABLE";

export const GATEWAY_REASONS: Record<GatewayReason, { http: number; status: string }> = {
  UNAUTHORIZED: { http: 401, status: "UNAUTHENTICATED" },
  RATE_LIMITED: { http: 429, status: "RESOURCE_EXHAUSTED" },
  PAYMENT_REQUIRED: { http: 402, status: "FAILED_PRECONDITION" },
  MESH_ONLY: { http: 403, status: "PERMISSION_DENIED" },
  AGENT_UNAVAILABLE: { http: 404, status: "NOT_FOUND" },
};

/** The canonical status name for an HTTP status the table does not fix. */
function statusName(http: number): string {
  switch (http) {
    case 400:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 502:
    case 503:
      return "UNAVAILABLE";
    case 504:
      return "DEADLINE_EXCEEDED";
    default:
      return "INTERNAL";
  }
}

export interface RestErrorBody {
  error: {
    code: number;
    status: string;
    message: string;
    details: Array<{ "@type": string; reason: string; domain: string; metadata?: Record<string, string> }>;
  };
}

/** One AIP-193 error envelope. ErrorInfo metadata is a string map, so any
 *  value that is not a string is written as JSON text. */
export function restError(
  http: number,
  status: string,
  reason: string,
  message: string,
  domain: string = A2A_DOMAIN,
  metadata?: Record<string, unknown>,
): RestErrorBody {
  const meta = metadata && Object.keys(metadata).length ? stringMap(metadata) : undefined;
  return {
    error: {
      code: http,
      status,
      message,
      details: [{ "@type": ERROR_INFO_TYPE, reason, domain, ...(meta ? { metadata: meta } : {}) }],
    },
  };
}

/** An A2A error by its reason, with the table's status. */
export function a2aRestError(reason: A2AReason, message: string, metadata?: Record<string, unknown>): { http: number; body: RestErrorBody } {
  const r = A2A_REASONS[reason];
  return { http: r.http, body: restError(r.http, r.status, reason, message, A2A_DOMAIN, metadata) };
}

function stringMap(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

const RPC_TO_REASON: Record<number, A2AReason> = {
  [RpcCode.PARSE_ERROR]: "INVALID_PARAMS",
  [RpcCode.INVALID_REQUEST]: "INVALID_PARAMS",
  [RpcCode.INVALID_PARAMS]: "INVALID_PARAMS",
  [RpcCode.METHOD_NOT_FOUND]: "UNSUPPORTED_OPERATION",
  [RpcCode.INTERNAL_ERROR]: "INTERNAL",
  [RpcCode.TASK_NOT_FOUND]: "TASK_NOT_FOUND",
  [RpcCode.TASK_NOT_CANCELABLE]: "TASK_NOT_CANCELABLE",
  [RpcCode.PUSH_NOTIFICATION_NOT_SUPPORTED]: "PUSH_NOTIFICATION_NOT_SUPPORTED",
  [RpcCode.UNSUPPORTED_OPERATION]: "UNSUPPORTED_OPERATION",
  [RpcCode.CONTENT_TYPE_NOT_SUPPORTED]: "CONTENT_TYPE_NOT_SUPPORTED",
  [RpcCode.INVALID_AGENT_RESPONSE]: "INVALID_AGENT_RESPONSE",
  [RpcCode.EXTENDED_CARD_NOT_CONFIGURED]: "EXTENDED_AGENT_CARD_NOT_CONFIGURED",
  [RpcCode.VERSION_NOT_SUPPORTED]: "VERSION_NOT_SUPPORTED",
};

const GATEWAY_CODES = new Set<string>(Object.keys(GATEWAY_REASONS));

/**
 * A JSON-RPC error, as the shared handler wrote it with the HTTP status it
 * chose, in its HTTP+JSON form (BRIDGE-A2A.md §13.3).
 *
 * The gateway's own refusals are told apart by their `agentmesh_code` and the
 * way the handler sent them: a refusal of the gateway's own is never an A2A
 * error, so it goes out under `agentmesh.ai`. Everything else is an A2A error
 * found by its JSON-RPC code, and a transport failure keeps the 502 or 504 the
 * handler chose.
 */
export function rpcErrorToRest(err: JsonRpcError, handlerStatus: number): { http: number; body: RestErrorBody } {
  const data = (err.data ?? {}) as Record<string, unknown>;
  const meshCode = typeof data.agentmesh_code === "string" ? data.agentmesh_code : undefined;
  const { agentmesh_code: _code, ...rest } = data;
  const metadata = { ...(meshCode ? { agentmesh_code: meshCode } : {}), ...rest };

  // A gateway refusal: the unknown-agent answer (sent 200 with -32602), and
  // the refusals sent with their own HTTP status (401, 402, 403, 429).
  const gatewayRefusal =
    meshCode !== undefined &&
    GATEWAY_CODES.has(meshCode) &&
    ((meshCode === "AGENT_UNAVAILABLE" && err.code === RpcCode.INVALID_PARAMS) ||
      (meshCode !== "AGENT_UNAVAILABLE" && handlerStatus === GATEWAY_REASONS[meshCode as GatewayReason].http));
  if (gatewayRefusal) {
    const g = GATEWAY_REASONS[meshCode as GatewayReason];
    return { http: g.http, body: restError(g.http, g.status, meshCode, err.message, GATEWAY_DOMAIN, metadata) };
  }

  const reason = RPC_TO_REASON[err.code] ?? "INTERNAL";
  const fixed = A2A_REASONS[reason];
  // INTERNAL keeps the transport status the handler chose (§7: 502, 504).
  const http = reason === "INTERNAL" && handlerStatus >= 500 ? handlerStatus : fixed.http;
  const status = reason === "INTERNAL" ? statusName(http) : fixed.status;
  return { http, body: restError(http, status, reason, err.message, A2A_DOMAIN, metadata) };
}

// ─── Enum spellings (A2A §5.5) ──────────────────────────────────────

const STATE_ENUM: Record<string, string> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  "auth-required": "TASK_STATE_AUTH_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
  canceled: "TASK_STATE_CANCELED",
  rejected: "TASK_STATE_REJECTED",
};

/** A task state in its ProtoJSON enum name. An enum name already is one. */
export function stateEnum(state: string): string {
  return STATE_ENUM[state] ?? state;
}

/** A task, a status update, or a whole send/stream result with every task
 *  state in its enum spelling. Returns new objects; never edits its input. */
export function withEnumStates<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...v };
  if (v.task && typeof v.task === "object") out.task = taskWithEnumState(v.task as Record<string, unknown>);
  if (v.statusUpdate && typeof v.statusUpdate === "object") {
    const su = v.statusUpdate as Record<string, unknown>;
    out.statusUpdate = { ...su, ...(su.status ? { status: statusWithEnum(su.status as Record<string, unknown>) } : {}) };
  }
  if (typeof v.id === "string" && v.status && typeof v.status === "object") return taskWithEnumState(v) as T;
  return out as T;
}

function taskWithEnumState(task: Record<string, unknown>): Record<string, unknown> {
  return { ...task, ...(task.status ? { status: statusWithEnum(task.status as Record<string, unknown>) } : {}) };
}

function statusWithEnum(status: Record<string, unknown>): Record<string, unknown> {
  return { ...status, ...(typeof status.state === "string" ? { state: stateEnum(status.state) } : {}) };
}

// ─── Reshaping a JSON-RPC answer ────────────────────────────────────

export type RestAnswer = { http: number; body: unknown; headers?: Record<string, string> };

/**
 * The HTTP+JSON answer for one JSON-RPC answer from the shared handler.
 * `unwrapTask` is for GetTask and CancelTask, whose JSON-RPC result the
 * handler wraps as `{task}` and whose REST result is the Task itself.
 */
export function rpcToRest(
  rpcBody: unknown,
  handlerStatus: number,
  handlerHeaders: Record<string, string>,
  opts: { unwrapTask?: boolean } = {},
): RestAnswer {
  const body = rpcBody as { result?: unknown; error?: JsonRpcError } | null;
  const carry: Record<string, string> = {};
  for (const [k, v] of Object.entries(handlerHeaders)) {
    if (k.toLowerCase() === "www-authenticate" || k.toLowerCase() === "retry-after") carry[k] = v;
  }
  if (body && body.error) {
    const mapped = rpcErrorToRest(body.error, handlerStatus);
    return { http: mapped.http, body: mapped.body, headers: carry };
  }
  if (!body || body.result === undefined) {
    const e = a2aRestError("INTERNAL", "The gateway produced no answer");
    return { http: e.http, body: e.body };
  }
  let result = body.result as Record<string, unknown>;
  if (opts.unwrapTask && result && typeof result === "object" && result.task) result = result.task as Record<string, unknown>;
  return { http: 200, body: withEnumStates(result), headers: carry };
}

/** One SSE `data:` payload from the JSON-RPC stream, as its HTTP+JSON line:
 *  the StreamResponse alone, or an error envelope. */
export function rpcStreamEventToRest(rpcEvent: unknown): unknown {
  const e = rpcEvent as { result?: unknown; error?: JsonRpcError } | null;
  if (e && e.error) return rpcErrorToRest(e.error, 200).body;
  return withEnumStates(e?.result);
}
