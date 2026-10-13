/**
 * Mesh spans to OTLP (SPEC.md §13.1.1, §13.4).
 *
 * A pure function, in the SDK rather than in the exporter, for two reasons.
 * Anyone writing their own collector should not have to re-derive the mapping
 * from a payload; and a conversion that only exists inside a CLI is a
 * conversion nobody can test against the emitter that produces its input.
 *
 * JSON deliberately, because it costs no code generation and nothing to keep in
 * sync, which is what a long-lived sidecar wants. It is not universally
 * accepted, so `otlp-proto.ts` carries a hand-written protobuf encoder for the
 * backends that refuse it.
 *
 * §13.4's division of labour is what makes the output useful: OpenTelemetry
 * describes what happens inside an agent, the mesh describes what happens
 * between them, and the two compose into one trace because they already share
 * W3C Trace Context. Nothing here translates an identifier.
 */
import type { SpanData } from "./spans.js";

/** OTLP span kinds from the OpenTelemetry proto. */
const OTLP_KIND: Record<string, number> = { producer: 4, consumer: 5 };
/** OTLP status codes: 0 UNSET, 1 OK, 2 ERROR. */
const OTLP_STATUS: Record<string, number> = { ok: 1, error: 2, refused: 2, timeout: 2, canceled: 2 };

export interface OtlpOptions {
  /** Reported as the instrumentation scope version. */
  scopeVersion?: string;
  /**
   * Extra resource attributes, merged onto every resource.
   *
   * This exists because backends demand their own. Google's Telemetry API
   * refuses a payload outright with `Resource is missing required attribute
   * "gcp.project_id"`, and that is a fact about one vendor rather than about
   * OTLP, so it belongs in a caller's configuration and not hardcoded here.
   * A vendor key baked into the SDK is a vendor key every other user carries.
   */
  resourceAttributes?: Record<string, string>;
}

function attr(key: string, value: string) {
  return { key, value: { stringValue: String(value) } };
}

function nanos(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? String(BigInt(ms) * 1_000_000n) : "0";
}

/**
 * Build one OTLP `ExportTraceServiceRequest` from completed mesh spans.
 *
 * Grouped by emitting agent, so each mesh agent arrives at the collector as
 * its own `service.name` rather than every agent on a host collapsing into one
 * blob that nobody can filter.
 */
export function otlpTraces(spans: SpanData[], opts: OtlpOptions = {}): unknown {
  const byAgent = new Map<string, SpanData[]>();
  for (const s of spans) {
    const key = s.agent_id || "unknown";
    const list = byAgent.get(key);
    if (list) list.push(s);
    else byAgent.set(key, [s]);
  }

  return {
    resourceSpans: [...byAgent].map(([agentId, group]) => ({
      resource: {
        attributes: [
          attr("service.name", agentId),
          attr("agentmesh.agent", agentId),
          ...Object.entries(opts.resourceAttributes ?? {}).map(([k, v]) => attr(k, v)),
        ],
      },
      scopeSpans: [
        {
          scope: { name: "agentmesh", version: opts.scopeVersion ?? "" },
          spans: group.map((s) => {
            const attributes = [
              // OpenInference (the convention Phoenix and its lineage read) so
              // a mesh hop identifies itself instead of rendering as UNKNOWN
              // beside properly typed agent spans. It is a type label and
              // carries no content, so it costs nothing against §13.1.1's
              // refusals. AGENT rather than TOOL: both ends of this hop are
              // agents, and calling one is not the same act as invoking a tool
              // inside your own process.
              attr("openinference.span.kind", "AGENT"),
              attr("agentmesh.primitive", s.operation),
              attr("agentmesh.outcome", s.status),
            ];
            if (s.offering) attributes.push(attr("agentmesh.offering", s.offering));
            if (s.error_code) attributes.push(attr("agentmesh.error_code", s.error_code));
            if (s.tags?.peer) attributes.push(attr("agentmesh.peer", s.tags.peer));
            if (s.tags?.task_id) attributes.push(attr("agentmesh.task_id", s.tags.task_id));
            if (s.tags?.context_id) attributes.push(attr("agentmesh.context_id", s.tags.context_id));

            const out: Record<string, unknown> = {
              traceId: s.trace_id,
              spanId: s.span_id,
              name: s.offering ? `${s.operation} ${s.offering}` : s.operation,
              kind: OTLP_KIND[s.kind] ?? 0,
              startTimeUnixNano: nanos(s.started_at),
              endTimeUnixNano: nanos(s.ended_at),
              attributes,
              status: { code: OTLP_STATUS[s.status] ?? 0 },
            };
            // Omitted rather than empty for a root: an empty parentSpanId is a
            // valid OTLP encoding but several collectors render it as a broken
            // link rather than as a root.
            if (s.parent_span_id) out.parentSpanId = s.parent_span_id;
            return out;
          }),
        },
      ],
    })),
  };
}
