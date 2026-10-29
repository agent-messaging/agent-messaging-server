/**
 * JSON-RPC 2.0 + A2A wire types (A2A RC v1.0, JSON-RPC binding — a2a_spec.md §9).
 * Pure types and constructors; no I/O. Normative mapping: BRIDGE-A2A.md §3, §4.
 */

export const A2A_PROTOCOL_VERSION = "1.0";

// ─── JSON-RPC 2.0 ────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

// A2A error codes (a2a_spec.md §5.4) + JSON-RPC standard codes.
export const RpcCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
  EXTENDED_CARD_NOT_CONFIGURED: -32007,
  VERSION_NOT_SUPPORTED: -32009,
} as const;

export function rpcResult(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: Record<string, unknown>,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

// ─── A2A data model (subset the bridge speaks — a2a_spec.md §4) ──────

export interface A2ATextPart {
  text: string;
  metadata?: Record<string, unknown>;
}

export interface A2ADataPart {
  data: Record<string, unknown> | unknown[];
  metadata?: Record<string, unknown>;
}

export interface A2AFilePart {
  file: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type A2APart = A2ATextPart | A2ADataPart | A2AFilePart;

export function isTextPart(p: A2APart): p is A2ATextPart {
  return typeof (p as A2ATextPart).text === "string";
}
export function isDataPart(p: A2APart): p is A2ADataPart {
  return (p as A2ADataPart).data !== undefined;
}
/** A file part in either spelling: the `file` wrapper, or A2A 1.0's
 *  top-level `raw` (base64 bytes) or `url`, with `mediaType` and `filename`
 *  beside them. Reading only the wrapper dropped 1.0 file parts unseen. */
export function isFilePart(p: A2APart): p is A2AFilePart {
  const o = p as unknown as Record<string, unknown>;
  return o.file !== undefined || typeof o.raw === "string" || typeof o.url === "string";
}

export interface A2AMessage {
  role: "ROLE_USER" | "ROLE_AGENT";
  parts: A2APart[];
  messageId?: string;
  taskId?: string;
  contextId?: string;
  /** Prior tasks this message refers to; the first is what a mesh request
   *  names as `revises` (Common Agent spec §5.7). */
  referenceTaskIds?: string[];
  /** The URIs of the extensions this message uses (A2A §4.1.4); their data
   *  rides in `metadata` under each URI. */
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

/** A2A JSON task states (a2a_spec.md §4.1.3, JSON string spelling). */
export type A2ATaskStateJson =
  | "submitted"
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

export interface A2ATaskStatus {
  state: A2ATaskStateJson;
  message?: A2AMessage;
  timestamp?: string;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  parts: A2APart[];
}

export interface A2ATask {
  id: string;
  contextId?: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  /** A2A Task metadata: where an extension's data rides (§16). */
  metadata?: Record<string, unknown>;
}

/** SendMessage request params (a2a.proto 1.0 `SendMessageRequest`, subset). */
export interface SendMessageParams {
  message: A2AMessage;
  /** `SendMessageConfiguration`. The 1.0 release candidate's `blocking` is
   *  gone: 1.0 blocks by default and says `returnImmediately` for the other. */
  configuration?: {
    acceptedOutputModes?: string[];
    historyLength?: number;
    returnImmediately?: boolean;
  };
  metadata?: Record<string, unknown>;
}

/** SendMessage result: exactly one of task | message (a2a_spec.md §9.4.1). */
export type SendMessageResult = { task: A2ATask } | { message: A2AMessage };

/** SSE stream event payloads (a2a_spec.md §6.2). */
export type StreamEvent =
  | { task: A2ATask }
  | { message: A2AMessage }
  | { artifactUpdate: { taskId: string; contextId?: string; artifact: A2AArtifact } }
  | { statusUpdate: { taskId: string; contextId?: string; status: A2ATaskStatus; final: boolean } };
