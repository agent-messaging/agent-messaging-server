/**
 * OTLP over protobuf, hand-encoded (SPEC.md §13.1.1).
 *
 * Why this exists: Arize Phoenix, the reference implementation of the
 * OpenInference convention, answers `415 Unsupported Media Type` to OTLP/JSON
 * and accepts protobuf only. It is not alone, and "point the exporter at
 * anything that speaks OTLP" was not true while we could only speak JSON.
 *
 * Why it is hand-written rather than a dependency: the encoding below is about
 * a hundred lines of wire format that has not changed since OTLP 1.0, against
 * a protobuf library that would pull a code generator and a schema into a
 * package whose whole point is being one file with one dependency. The trade
 * is deliberate, and the test that guards it sends the same spans down both
 * encodings to the reference collector and asserts they arrive identical.
 *
 * The one trap worth naming: in JSON a trace id is a 32-character hex STRING,
 * and in protobuf it is 16 raw BYTES. Encoding the hex string as if it were
 * the id produces a payload every backend accepts and every backend then shows
 * with the wrong ids, which is worse than a rejection.
 */
import type { SpanData } from "./spans.js";
import type { OtlpOptions } from "./otlp.js";

// ── minimal protobuf writer ────────────────────────────────────────────────

const enc = new TextEncoder();

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 127) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

/** field, wire type 2 (length-delimited), with its payload. */
function bytesField(field: number, payload: number[] | Uint8Array): number[] {
  const body = Array.from(payload);
  return [...varint((field << 3) | 2), ...varint(body.length), ...body];
}

function stringField(field: number, value: string): number[] {
  return bytesField(field, enc.encode(value));
}

/** field, wire type 1 (64-bit fixed). OTLP times are fixed64 nanoseconds. */
function fixed64Field(field: number, value: bigint): number[] {
  const out = [...varint((field << 3) | 1)];
  let v = value;
  for (let i = 0; i < 8; i++) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
}

/** field, wire type 0 (varint). */
function varintField(field: number, value: number): number[] {
  return [...varint(field << 3), ...varint(value)];
}

/** Hex string to raw bytes. Ids are `bytes` on the wire, never hex text. */
function hexBytes(hex: string): number[] {
  const clean = (hex || "").trim();
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

function nanos(iso: string): bigint {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? BigInt(ms) * 1_000_000n : 0n;
}

// ── OTLP messages ──────────────────────────────────────────────────────────
// Field numbers from opentelemetry/proto/{common,resource,trace}/v1.

/** common.v1.AnyValue { string_value = 1 } */
function anyValue(v: string): number[] {
  return stringField(1, v);
}

/** common.v1.KeyValue { key = 1, value = 2 } */
function keyValue(k: string, v: string): number[] {
  return [...stringField(1, k), ...bytesField(2, anyValue(v))];
}

const OTLP_KIND: Record<string, number> = { producer: 4, consumer: 5 };
const OTLP_STATUS: Record<string, number> = { ok: 1, error: 2, refused: 2, timeout: 2, canceled: 2 };

/** trace.v1.Span */
function span(s: SpanData): number[] {
  const attrs: [string, string][] = [
    ["openinference.span.kind", "AGENT"],
    ["agentmesh.primitive", s.operation],
    ["agentmesh.outcome", s.status],
  ];
  if (s.offering) attrs.push(["agentmesh.offering", s.offering]);
  if (s.error_code) attrs.push(["agentmesh.error_code", s.error_code]);
  if (s.tags?.peer) attrs.push(["agentmesh.peer", s.tags.peer]);
  if (s.tags?.task_id) attrs.push(["agentmesh.task_id", s.tags.task_id]);
  if (s.tags?.context_id) attrs.push(["agentmesh.context_id", s.tags.context_id]);

  const out: number[] = [
    ...bytesField(1, hexBytes(s.trace_id)),   // trace_id
    ...bytesField(2, hexBytes(s.span_id)),    // span_id
  ];
  if (s.parent_span_id) out.push(...bytesField(4, hexBytes(s.parent_span_id))); // parent_span_id
  out.push(
    ...stringField(5, s.offering ? `${s.operation} ${s.offering}` : s.operation), // name
    ...varintField(6, OTLP_KIND[s.kind] ?? 0),          // kind
    ...fixed64Field(7, nanos(s.started_at)),            // start_time_unix_nano
    ...fixed64Field(8, nanos(s.ended_at)),              // end_time_unix_nano
  );
  for (const [k, v] of attrs) out.push(...bytesField(9, keyValue(k, v))); // attributes
  // status = 15. Status { message = 2 (string), code = 3 (enum) } — field 2 is
  // the human message, NOT the code, and putting the code there is a wire-type
  // error the collector catches by name.
  out.push(...bytesField(15, varintField(3, OTLP_STATUS[s.status] ?? 0)));
  return out;
}

/**
 * One `ExportTraceServiceRequest`, protobuf-encoded, grouped by emitting agent
 * exactly as the JSON encoder groups it.
 */
export function otlpTracesProto(spans: SpanData[], opts: OtlpOptions = {}): Uint8Array {
  const byAgent = new Map<string, SpanData[]>();
  for (const s of spans) {
    const key = s.agent_id || "unknown";
    const list = byAgent.get(key);
    if (list) list.push(s);
    else byAgent.set(key, [s]);
  }

  const out: number[] = [];
  for (const [agentId, group] of byAgent) {
    // resource.v1.Resource { attributes = 1 }
    const resourceAttrs: [string, string][] = [
      ["service.name", agentId],
      ["agentmesh.agent", agentId],
      ...Object.entries(opts.resourceAttributes ?? {}),
    ];
    const resource: number[] = [];
    for (const [k, v] of resourceAttrs) resource.push(...bytesField(1, keyValue(k, String(v))));

    // trace.v1.ScopeSpans { scope = 1, spans = 2 }
    const scope = [
      ...stringField(1, "agentmesh"),
      ...stringField(2, opts.scopeVersion ?? ""),
    ];
    const scopeSpans: number[] = [...bytesField(1, scope)];
    for (const s of group) scopeSpans.push(...bytesField(2, span(s)));

    // trace.v1.ResourceSpans { resource = 1, scope_spans = 2 }
    const resourceSpans = [...bytesField(1, resource), ...bytesField(2, scopeSpans)];

    // ExportTraceServiceRequest { resource_spans = 1 }
    out.push(...bytesField(1, resourceSpans));
  }
  return new Uint8Array(out);
}
