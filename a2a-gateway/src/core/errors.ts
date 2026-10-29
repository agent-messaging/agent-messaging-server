/**
 * Error mapping (BRIDGE-A2A.md §7). Mesh error codes → A2A JSON-RPC errors,
 * with the original mesh code preserved in data.agentmesh_code. Pure functions.
 */
import { ErrorCode, MeshError } from "../../../sdk-typescript/src/types/errors.js";
import { RpcCode, type JsonRpcError } from "./jsonrpc.js";

interface Mapped {
  rpcCode: number;
  httpStatus: number;
}

const MAP: Partial<Record<ErrorCode, Mapped>> = {
  [ErrorCode.TASK_NOT_FOUND]: { rpcCode: RpcCode.TASK_NOT_FOUND, httpStatus: 200 },
  [ErrorCode.TASK_EXPIRED]: { rpcCode: RpcCode.TASK_NOT_FOUND, httpStatus: 200 },
  [ErrorCode.TASK_NOT_CANCELABLE]: { rpcCode: RpcCode.TASK_NOT_CANCELABLE, httpStatus: 200 },
  [ErrorCode.TASK_INVALID_TRANSITION]: { rpcCode: RpcCode.TASK_NOT_CANCELABLE, httpStatus: 200 },
  [ErrorCode.CONTENT_TYPE_NOT_SUPPORTED]: { rpcCode: RpcCode.CONTENT_TYPE_NOT_SUPPORTED, httpStatus: 200 },
  [ErrorCode.OFFERING_NOT_FOUND]: { rpcCode: RpcCode.INVALID_PARAMS, httpStatus: 200 },
  [ErrorCode.INPUT_INVALID]: { rpcCode: RpcCode.INVALID_PARAMS, httpStatus: 200 },
  [ErrorCode.INVALID_QUERY]: { rpcCode: RpcCode.INVALID_PARAMS, httpStatus: 200 },
  [ErrorCode.UNAUTHORIZED]: { rpcCode: RpcCode.INTERNAL_ERROR, httpStatus: 401 },
  [ErrorCode.TRANSPORT_PERMISSION_DENIED]: { rpcCode: RpcCode.INTERNAL_ERROR, httpStatus: 403 },
  [ErrorCode.AGENT_UNAVAILABLE]: { rpcCode: RpcCode.INTERNAL_ERROR, httpStatus: 502 },
  [ErrorCode.AGENT_OVERLOADED]: { rpcCode: RpcCode.INTERNAL_ERROR, httpStatus: 502 },
  [ErrorCode.TRANSPORT_NO_RESPONDERS]: { rpcCode: RpcCode.INTERNAL_ERROR, httpStatus: 502 },
  [ErrorCode.TRANSPORT_TIMEOUT]: { rpcCode: RpcCode.INTERNAL_ERROR, httpStatus: 504 },
  [ErrorCode.RATE_LIMITED]: { rpcCode: RpcCode.INTERNAL_ERROR, httpStatus: 429 },
  [ErrorCode.INVALID_ENVELOPE]: { rpcCode: RpcCode.INVALID_AGENT_RESPONSE, httpStatus: 200 },
  [ErrorCode.IDENTITY_MISMATCH]: { rpcCode: RpcCode.INVALID_AGENT_RESPONSE, httpStatus: 200 },
};

export interface MappedRpcError {
  httpStatus: number;
  error: JsonRpcError;
}

/** Mesh error → JSON-RPC error + HTTP status (BRIDGE-A2A.md §7). */
export function meshErrorToRpc(err: unknown): MappedRpcError {
  if (err instanceof MeshError) {
    const mapped = MAP[err.code] ?? { rpcCode: RpcCode.INTERNAL_ERROR, httpStatus: 200 };
    return {
      httpStatus: mapped.httpStatus,
      error: {
        code: mapped.rpcCode,
        message: err.message,
        // A budget refusal carries its estimate and spend (Agent Messaging
        // §7.7), which the caller needs to decide whether to try again.
        data: { agentmesh_code: err.code, ...(String(err.code).startsWith("BUDGET_") && err.details ? { details: err.details } : {}) },
      },
    };
  }
  return {
    httpStatus: 200,
    error: {
      code: RpcCode.INTERNAL_ERROR,
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

/** Outbound inverse: an A2A JSON-RPC error from a remote server → mesh error
 *  object fields, with the A2A code preserved (BRIDGE-A2A.md §7). */
export function rpcErrorToMesh(rpcErr: JsonRpcError): {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  meta: Record<string, unknown>;
} {
  const code =
    rpcErr.code === RpcCode.TASK_NOT_FOUND
      ? ErrorCode.TASK_NOT_FOUND
      : rpcErr.code === RpcCode.TASK_NOT_CANCELABLE
        ? ErrorCode.TASK_NOT_CANCELABLE
        : rpcErr.code === RpcCode.CONTENT_TYPE_NOT_SUPPORTED
          ? ErrorCode.CONTENT_TYPE_NOT_SUPPORTED
          : rpcErr.code === RpcCode.INVALID_PARAMS
            ? ErrorCode.INPUT_INVALID
            : ErrorCode.DEPENDENCY_FAILED;
  return {
    code,
    message: rpcErr.message,
    retryable: code === ErrorCode.DEPENDENCY_FAILED,
    meta: { a2a_code: rpcErr.code },
  };
}
