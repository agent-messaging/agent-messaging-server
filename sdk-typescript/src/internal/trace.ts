import type { TraceContext } from "../types/envelope.js";

/**
 * Trace ids are W3C Trace Context format (§13.1): trace_id is 16 random bytes
 * as 32 lowercase hex chars, span_id is 8 bytes as 16 hex chars — exactly the
 * fields of a `traceparent` header, so a context round-trips losslessly to and
 * from HTTP-instrumented systems (OpenTelemetry, A2A endpoints, webhooks).
 */
function randHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  // W3C forbids the all-zero id; a re-roll is astronomically rare.
  return /^0+$/.test(s) ? randHex(bytes) : s;
}

/** Create a new root trace context. */
export function newTraceContext(): TraceContext {
  return {
    trace_id: randHex(16),
    span_id: randHex(8),
    parent_span_id: null,
  };
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
/** W3C caps `tracestate` at 512 chars; longer is a header no HTTP hop would
 *  carry, so it is either a mistake or someone padding our envelopes. */
const MAX_TRACESTATE_LEN = 512;

/**
 * Whether a context is a well-formed W3C Trace Context (§13.1): 32/16 lowercase
 * hex chars, neither all-zero (W3C forbids both), `parent_span_id` absent, null
 * or a span id, and a `tracestate` short enough to be real.
 *
 * `validateEnvelope` deliberately checks only that `trace` is an object, so an
 * inbound trace is whatever the sender typed. It is not worth rejecting a
 * message over — the trace is bookkeeping, not content — but it must not be
 * COPIED, which is what childSpan below is for.
 */
export function isValidTraceContext(t: unknown): t is TraceContext {
  if (!t || typeof t !== "object") return false;
  const c = t as Record<string, unknown>;
  if (typeof c.trace_id !== "string" || !TRACE_ID_RE.test(c.trace_id)) return false;
  if (/^0+$/.test(c.trace_id)) return false;
  if (typeof c.span_id !== "string" || !SPAN_ID_RE.test(c.span_id)) return false;
  if (/^0+$/.test(c.span_id)) return false;
  if (
    c.parent_span_id !== undefined &&
    c.parent_span_id !== null &&
    (typeof c.parent_span_id !== "string" || !SPAN_ID_RE.test(c.parent_span_id))
  )
    return false;
  if (
    c.tracestate !== undefined &&
    (typeof c.tracestate !== "string" || c.tracestate.length > MAX_TRACESTATE_LEN)
  )
    return false;
  return true;
}

/**
 * Create a child span preserving trace_id (and tracestate), linking to parent
 * span.
 *
 * A parent that is not a valid context gets a FRESH ROOT rather than being
 * copied. Every propagation site — the reply to a request, anything a handler
 * emits while the inbound trace is ambient, every stream chunk — reaches the
 * wire through here, so this is the one place that has to hold: a sender that
 * supplies another party's `trace_id` (or a megabyte of `tracestate`) would
 * otherwise have it stamped verbatim onto everything the receiving agent says
 * next, merging its traffic into someone else's trace in the history record.
 * Losing the link on a malformed trace is the correct failure: the alternative
 * is a trace that lies.
 */
export function childSpan(parent: TraceContext): TraceContext {
  if (!isValidTraceContext(parent)) return newTraceContext();
  return {
    trace_id: parent.trace_id,
    span_id: randHex(8),
    parent_span_id: parent.span_id,
    ...(parent.tracestate !== undefined ? { tracestate: parent.tracestate } : {}),
  };
}

/** Render a context as a version-00 W3C `traceparent` header value. */
export function toTraceparent(t: TraceContext): string {
  return `00-${t.trace_id}-${t.span_id}-01`;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/**
 * Build a mesh trace context from an inbound `traceparent` header: the header's
 * span becomes the parent, and the mesh operation gets a fresh span in the same
 * trace. Returns null if the header does not parse.
 */
export function fromTraceparent(traceparent: string, tracestate?: string): TraceContext | null {
  const m = TRACEPARENT_RE.exec(traceparent.trim());
  if (!m) return null;
  return {
    trace_id: m[1],
    span_id: randHex(8),
    parent_span_id: m[2],
    ...(tracestate !== undefined ? { tracestate } : {}),
  };
}
