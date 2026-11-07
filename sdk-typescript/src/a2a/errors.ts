/**
 * A2A errors on a respond frame (bindings/a2a.md §9).
 *
 * An A2A error travels as the frame's `error`: `code` is the error's name as
 * A2A §3.3.2 spells it, `details.a2a.code` the integer A2A's JSON-RPC binding
 * gives it, and `details.a2a.data` its data. A client or bridge that speaks
 * JSON-RPC uses the integer unchanged. Errors that come from the channel (a
 * refused signature, a sender not admitted, a timeout) keep their Agent
 * Messaging codes and are never given an A2A name; they stay `MeshError`.
 */
import type { ErrorObject } from "../types/envelope.js";

/** Every A2A error name, with its JSON-RPC code (A2A §3.3.2, §9.5). The
 *  JSON-RPC protocol errors are listed too, because A2A's invalid-parameters
 *  and internal errors are those (the offering extension, §12.1, answers with
 *  the first). */
export const A2A_ERROR_CODES = {
  TaskNotFoundError: -32001,
  TaskNotCancelableError: -32002,
  PushNotificationNotSupportedError: -32003,
  UnsupportedOperationError: -32004,
  ContentTypeNotSupportedError: -32005,
  InvalidAgentResponseError: -32006,
  ExtendedAgentCardNotConfiguredError: -32007,
  ExtensionSupportRequiredError: -32008,
  VersionNotSupportedError: -32009,
  JSONParseError: -32700,
  InvalidRequestError: -32600,
  MethodNotFoundError: -32601,
  InvalidParamsError: -32602,
  InternalError: -32603,
} as const;

export type A2AErrorName = keyof typeof A2A_ERROR_CODES;

const NAME_BY_CODE = new Map<number, A2AErrorName>(
  Object.entries(A2A_ERROR_CODES).map(([n, c]) => [c, n as A2AErrorName]),
);

export function isA2AErrorName(v: unknown): v is A2AErrorName {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(A2A_ERROR_CODES, v);
}

/** The A2A error name a JSON-RPC code stands for, if it is one of A2A's. */
export function a2aErrorNameOf(rpcCode: number): A2AErrorName | undefined {
  return NAME_BY_CODE.get(rpcCode);
}

/** An A2A error, thrown by a handler or raised on the client from a respond
 *  frame. `data` is the error's data (A2A §3.3.2). */
export class A2AError extends Error {
  readonly code: A2AErrorName;
  readonly data: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: A2AErrorName, message: string, data: Record<string, unknown> = {}, retryable = false) {
    super(message);
    this.name = "A2AError";
    this.code = code;
    this.data = data;
    this.retryable = retryable;
  }

  /** The JSON-RPC integer for this error. */
  get rpcCode(): number {
    return A2A_ERROR_CODES[this.code];
  }

  /** The respond frame's `error` (§9). */
  toErrorObject(): ErrorObject {
    return {
      code: this.code,
      message: this.message,
      details: { a2a: { code: this.rpcCode, data: this.data } },
      retryable: this.retryable,
    };
  }

  /** The A2A error a frame's `error` carries, or null when it is a channel
   *  error (an Agent Messaging code), which the caller raises as a MeshError. */
  static fromErrorObject(err: ErrorObject): A2AError | null {
    if (!isA2AErrorName(err.code)) return null;
    const a2a = (err.details?.a2a ?? {}) as { data?: unknown };
    const data = a2a.data && typeof a2a.data === "object" && !Array.isArray(a2a.data) ? (a2a.data as Record<string, unknown>) : {};
    return new A2AError(err.code, err.message, data, err.retryable === true);
  }
}

/** Shorthands for the errors the binding names. */
export const A2AErrors = {
  taskNotFound: (id?: string) =>
    new A2AError("TaskNotFoundError", "No task with that id.", id ? { taskId: id } : {}),
  taskNotCancelable: (id: string, state?: string) =>
    new A2AError("TaskNotCancelableError", "The task is in a terminal state and cannot be canceled.", {
      taskId: id,
      ...(state ? { state } : {}),
    }),
  pushNotSupported: () =>
    new A2AError("PushNotificationNotSupportedError", "This agent does not support push notifications."),
  unsupported: (what: string) => new A2AError("UnsupportedOperationError", `${what} is not supported by this agent.`),
  extendedCardNotConfigured: () =>
    new A2AError("ExtendedAgentCardNotConfiguredError", "This agent has no extended agent card."),
  invalidParams: (message: string, data: Record<string, unknown> = {}) =>
    new A2AError("InvalidParamsError", message, data),
  methodNotFound: (method: unknown) =>
    new A2AError("MethodNotFoundError", `Unknown A2A method ${JSON.stringify(method)}.`, {
      method: typeof method === "string" ? method : null,
    }),
  internal: (message: string) => new A2AError("InternalError", message),
  invalidAgentResponse: (message: string) => new A2AError("InvalidAgentResponseError", message),
};
