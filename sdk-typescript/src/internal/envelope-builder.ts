import type {
  Envelope,
  PrimitiveType,
  TraceContext,
  ErrorObject,
  Artifact,
  Budget,
} from "../types/envelope.js";
import { PROTOCOL_VERSION } from "../types/envelope.js";
import { uuid7 } from "./uuid.js";
import { newTraceContext, childSpan } from "./trace.js";
import { currentTrace } from "./trace-ambient.js";
import { MeshError, ErrorCode } from "../types/errors.js";

const VALID_TYPES: PrimitiveType[] = [
  "register",
  "discover",
  "request",
  "respond",
  "emit",
  "subscribe",
];

export interface EnvelopeParams {
  type: PrimitiveType;
  from: string;
  to?: string;
  trace?: TraceContext;
  task_id?: string;
  in_reply_to?: string;
  context_id?: string;
  /** The sender's budget (§7.7). Signed like every other field — the canonical
   *  bytes cover the whole envelope minus `sig`, so nothing here changes. */
  budget?: Budget;
  error?: ErrorObject;
  payload?: unknown;
  artifacts?: Artifact[];
  meta?: Record<string, unknown>;
}

/** Build a valid Envelope. Auto-fills v, id, ts, trace. Validates at construction. */
export function createEnvelope(params: EnvelopeParams): Envelope {
  if (!params.type) {
    throw new MeshError(ErrorCode.INVALID_ENVELOPE, "Envelope 'type' is required");
  }
  if (!params.from) {
    throw new MeshError(ErrorCode.INVALID_ENVELOPE, "Envelope 'from' is required");
  }
  if (!VALID_TYPES.includes(params.type)) {
    throw new MeshError(
      ErrorCode.INVALID_ENVELOPE,
      `Invalid envelope type '${params.type}'. Must be one of: ${VALID_TYPES.join(", ")}`,
    );
  }

  // Explicit trace wins; otherwise an envelope built while a handler is
  // running becomes a child of the inbound trace (§13.1 automatic
  // propagation); otherwise it starts a new root.
  const ambient = params.trace === undefined ? currentTrace() : undefined;
  const envelope: Envelope = {
    v: PROTOCOL_VERSION,
    id: uuid7(),
    type: params.type,
    ts: new Date().toISOString(),
    from: params.from,
    trace: params.trace ?? (ambient ? childSpan(ambient) : newTraceContext()),
  };

  if (params.to !== undefined) envelope.to = params.to;
  if (params.task_id !== undefined) envelope.task_id = params.task_id;
  if (params.in_reply_to !== undefined) envelope.in_reply_to = params.in_reply_to;
  if (params.context_id !== undefined) envelope.context_id = params.context_id;
  if (params.budget !== undefined) envelope.budget = params.budget;
  if (params.error !== undefined) envelope.error = params.error;
  if (params.payload !== undefined) envelope.payload = params.payload;
  if (params.artifacts !== undefined) envelope.artifacts = params.artifacts;
  if (params.meta !== undefined) envelope.meta = params.meta;

  return envelope;
}

/** Validate a decoded envelope from the wire. Throws MeshError if invalid. */
export function validateEnvelope(env: unknown): asserts env is Envelope {
  if (typeof env !== "object" || env === null) {
    throw new MeshError(ErrorCode.INVALID_ENVELOPE, "Envelope must be a non-null object");
  }

  const e = env as Record<string, unknown>;

  if (typeof e.v !== "string") {
    throw new MeshError(ErrorCode.INVALID_ENVELOPE, "Missing or invalid 'v' field");
  }
  if (typeof e.id !== "string") {
    throw new MeshError(ErrorCode.INVALID_ENVELOPE, "Missing or invalid 'id' field");
  }
  if (typeof e.type !== "string") {
    throw new MeshError(ErrorCode.INVALID_ENVELOPE, "Missing or invalid 'type' field");
  }
  if (typeof e.ts !== "string") {
    throw new MeshError(ErrorCode.INVALID_ENVELOPE, "Missing or invalid 'ts' field");
  }
  if (typeof e.from !== "string") {
    throw new MeshError(ErrorCode.INVALID_ENVELOPE, "Missing or invalid 'from' field");
  }
  if (typeof e.trace !== "object" || e.trace === null) {
    throw new MeshError(ErrorCode.INVALID_ENVELOPE, "Missing or invalid 'trace' field");
  }

  const [major] = e.v.split(".");
  const [expectedMajor] = PROTOCOL_VERSION.split(".");
  if (major !== expectedMajor) {
    throw new MeshError(
      ErrorCode.INVALID_VERSION,
      `Unsupported protocol version '${e.v}'. Expected major version ${expectedMajor}.`,
    );
  }
}
