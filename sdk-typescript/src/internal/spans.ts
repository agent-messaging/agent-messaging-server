/**
 * Span completion events (SPEC.md §13.1.1).
 *
 * A mesh hop is one span. The sender closes a `producer` span when it has an
 * answer or a failure; the receiver closes a `consumer` span when it has
 * finished handling. Both carry the same `trace_id`, and the consumer is
 * parented under the producer, which is what makes a chain of agents read as
 * one trace instead of a pile of unrelated work.
 *
 * Two properties this file exists to hold:
 *
 * **Nothing about content can leak.** `spanData` builds its output field by
 * field from a typed input. There is no spread of an envelope, no pass-through
 * of a payload, and no place to put a string somebody sent us. That is a
 * deliberate shape rather than a discipline: the way to leak a payload into a
 * span would be to add a field here on purpose.
 *
 * **No amounts.** Price, quoted totals and settled amounts are excluded even
 * though they are genuinely useful for debugging spend, because a span is
 * routinely exported into third-party tooling the counterparty never agreed to.
 * Commercial terms live in the agreement, the meter report and the settlement
 * record, all of which are addressed to the parties.
 *
 * Emission is off unless an operator turns it on. Propagation (§13.1) is
 * always on and costs nothing; producing a record of who you talked to is a
 * different act and wants a decision.
 */
import type { TraceContext } from "../types/envelope.js";

/** Spans publish to their own subject tree, NOT the event bus: they are
 *  telemetry about the mesh rather than application events, and a
 *  `subscribe("trace.>")` consumer has no business receiving them. Matches the
 *  `MESH_TRACE` stream's `mesh.trace.>` filter in §14. */
export function traceSubject(agentId: string): string {
  return `mesh.trace.${agentId}`;
}

export type SpanKind = "producer" | "consumer";

/** How the operation ended. A closed set, so a collector can group on it. */
export type SpanOutcome = "ok" | "error" | "refused" | "timeout" | "canceled";

export interface SpanInput {
  trace: TraceContext;
  kind: SpanKind;
  agentId: string;
  /** Which primitive this span covers (§3). */
  operation: "request" | "respond" | "emit" | "subscribe";
  /** The counterparty's handle or key. Absent for a broadcast. */
  peer?: string;
  /** The offering NAMED, never its input. */
  offering?: string;
  taskId?: string | null;
  contextId?: string | null;
  outcome: SpanOutcome;
  /** The closed-enum error code only. Never a remote party's free text. */
  errorCode?: string;
  /** Epoch ms. */
  startedAt: number;
  endedAt: number;
}

export interface SpanData {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  agent_id: string;
  kind: SpanKind;
  operation: string;
  offering?: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  status: SpanOutcome;
  error_code?: string;
  tags?: { peer?: string; task_id?: string; context_id?: string };
}

/**
 * The `data` of a `span_completed` event, built field by field.
 *
 * Optional fields are OMITTED rather than set to null, so a span carries no
 * evidence of what it declined to say. A collector reading "no offering" and a
 * collector reading `"offering": null` learn different things, and the second
 * one is the beginning of an inference.
 */
export function spanData(s: SpanInput): SpanData {
  const out: SpanData = {
    trace_id: s.trace.trace_id,
    span_id: s.trace.span_id,
    parent_span_id: s.trace.parent_span_id ?? null,
    agent_id: s.agentId,
    kind: s.kind,
    operation: s.operation,
    started_at: new Date(s.startedAt).toISOString(),
    ended_at: new Date(s.endedAt).toISOString(),
    duration_ms: Math.max(0, s.endedAt - s.startedAt),
    status: s.outcome,
  };
  if (s.offering) out.offering = s.offering;
  if (s.errorCode) out.error_code = s.errorCode;

  const tags: NonNullable<SpanData["tags"]> = {};
  if (s.peer) tags.peer = s.peer;
  if (s.taskId) tags.task_id = s.taskId;
  if (s.contextId) tags.context_id = s.contextId;
  if (Object.keys(tags).length) out.tags = tags;

  return out;
}

/** The emit payload wrapping a completed span. */
export function spanPayload(s: SpanInput): { domain: "trace"; event_type: "span_completed"; data: SpanData } {
  return { domain: "trace", event_type: "span_completed", data: spanData(s) };
}

/**
 * Map a thrown error to the closed outcome set plus its code.
 *
 * A `MeshError`'s `code` is already a closed enum, which is the only part of a
 * remote failure that travels. Its `message` may be text a stranger wrote and
 * never leaves this function.
 */
export function outcomeOf(err: unknown): { outcome: SpanOutcome; errorCode?: string } {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return { outcome: "error" };
  if (code === "TRANSPORT_TIMEOUT" || code === "TASK_TIMEOUT") return { outcome: "timeout", errorCode: code };
  if (code === "TASK_CANCELED" || code === "CANCELED") return { outcome: "canceled", errorCode: code };
  if (code === "REFUSED" || code === "ADMISSION_REFUSED" || code === "BUDGET_EXHAUSTED") {
    return { outcome: "refused", errorCode: code };
  }
  return { outcome: "error", errorCode: code };
}
