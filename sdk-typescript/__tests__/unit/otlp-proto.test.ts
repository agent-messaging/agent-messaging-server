/**
 * The hand-rolled OTLP protobuf encoder (SPEC.md §13.1.1).
 *
 * Hand-written wire format needs a decoder to test it, so this file carries a
 * small one. Asserting on the encoder's own output with the encoder's own
 * assumptions would prove nothing.
 *
 * The trap being guarded: in JSON a trace id is a 32-character hex STRING and
 * in protobuf it is 16 raw BYTES. Encoding the hex text instead produces a
 * payload every backend ACCEPTS and then displays with the wrong ids, which is
 * worse than a rejection because nothing reports it.
 *
 * The bug this file would have caught: OTLP's `Status` has `message` at field 2
 * and `code` at field 3. The first version put the code in field 2, and the
 * reference collector rejected it with a wire-type error.
 */
import { describe, it, expect } from "vitest";
import { otlpTracesProto } from "../../src/internal/otlp-proto.js";
import type { SpanData } from "../../src/internal/spans.js";

// ── a protobuf reader, just enough to check the writer ─────────────────────

interface Field { no: number; wire: number; bytes?: Uint8Array; varint?: number; fixed64?: bigint }

function readVarint(b: Uint8Array, i: number): [number, number] {
  let out = 0, shift = 0, pos = i;
  for (;;) {
    const byte = b[pos++];
    out |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [out >>> 0, pos];
}

function parse(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < b.length) {
    const [tag, next] = readVarint(b, i);
    i = next;
    const no = tag >>> 3, wire = tag & 7;
    if (wire === 2) {
      const [len, afterLen] = readVarint(b, i);
      out.push({ no, wire, bytes: b.slice(afterLen, afterLen + len) });
      i = afterLen + len;
    } else if (wire === 0) {
      const [v, afterV] = readVarint(b, i);
      out.push({ no, wire, varint: v });
      i = afterV;
    } else if (wire === 1) {
      let v = 0n;
      for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[i + k]);
      out.push({ no, wire, fixed64: v });
      i += 8;
    } else {
      throw new Error(`unexpected wire type ${wire} for field ${no}`);
    }
  }
  return out;
}

const only = (fs: Field[], no: number) => fs.find((f) => f.no === no)!;
const all = (fs: Field[], no: number) => fs.filter((f) => f.no === no);
const str = (b?: Uint8Array) => new TextDecoder().decode(b ?? new Uint8Array());
const hex = (b?: Uint8Array) =>
  [...(b ?? new Uint8Array())].map((x) => x.toString(16).padStart(2, "0")).join("");

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT = "00f067aa0ba902b7";
const SPAN = "a1b2c3d4e5f60718";

function fixture(over: Partial<SpanData> = {}): SpanData {
  return {
    trace_id: TRACE, span_id: SPAN, parent_span_id: PARENT,
    agent_id: "UAGENT", kind: "consumer", operation: "request",
    offering: "lead-times",
    started_at: "2026-08-15T04:00:00.000Z",
    ended_at: "2026-08-15T04:00:00.250Z",
    duration_ms: 250, status: "refused", error_code: "BUDGET_EXHAUSTED",
    tags: { peer: "UPEER", task_id: "t-1" },
    ...over,
  };
}

/** Walk ExportTraceServiceRequest → ResourceSpans → ScopeSpans → the one Span. */
function firstSpan(bytes: Uint8Array) {
  const resourceSpans = only(parse(bytes), 1).bytes!;
  const rs = parse(resourceSpans);
  const scopeSpans = parse(only(rs, 2).bytes!);
  return { resource: parse(only(rs, 1).bytes!), scope: parse(only(scopeSpans, 1).bytes!), span: parse(only(scopeSpans, 2).bytes!) };
}

describe("the protobuf encoder puts things where OTLP expects them", () => {
  it("writes ids as raw bytes, never as hex text", () => {
    const bytes = otlpTracesProto([fixture()]);
    const { span } = firstSpan(bytes);

    expect(hex(only(span, 1).bytes)).toBe(TRACE);   // trace_id
    expect(hex(only(span, 2).bytes)).toBe(SPAN);    // span_id
    expect(hex(only(span, 4).bytes)).toBe(PARENT);  // parent_span_id
    expect(only(span, 1).bytes).toHaveLength(16);
    expect(only(span, 2).bytes).toHaveLength(8);

    // And the hex TEXT must appear nowhere in the payload.
    expect(new TextDecoder().decode(bytes)).not.toContain(TRACE);
  });

  it("puts the status code in field 3, where Status.code lives", () => {
    // Field 2 is Status.message, a string. The first version of this encoder
    // put the code there and the reference collector rejected the payload.
    const { span } = firstSpan(otlpTracesProto([fixture()]));
    const status = parse(only(span, 15).bytes!);
    expect(only(status, 3).varint).toBe(2); // refused maps to ERROR
    expect(status.find((f) => f.no === 2)).toBeUndefined();
  });

  it("writes kind, name and times where they belong", () => {
    const { span } = firstSpan(otlpTracesProto([fixture()]));
    expect(str(only(span, 5).bytes)).toBe("request lead-times");
    expect(only(span, 6).varint).toBe(5); // consumer
    expect(only(span, 7).fixed64).toBe(BigInt(Date.parse("2026-08-15T04:00:00.000Z")) * 1_000_000n);
    expect(only(span, 8).fixed64).toBe(BigInt(Date.parse("2026-08-15T04:00:00.250Z")) * 1_000_000n);
  });

  it("carries the same attributes the JSON encoder does, including the span kind", () => {
    const { span } = firstSpan(otlpTracesProto([fixture()]));
    const attrs = Object.fromEntries(all(span, 9).map((f) => {
      const kv = parse(f.bytes!);
      return [str(only(kv, 1).bytes), str(only(parse(only(kv, 2).bytes!), 1).bytes)];
    }));
    expect(attrs["openinference.span.kind"]).toBe("AGENT");
    expect(attrs["agentmesh.primitive"]).toBe("request");
    expect(attrs["agentmesh.outcome"]).toBe("refused");
    expect(attrs["agentmesh.error_code"]).toBe("BUDGET_EXHAUSTED");
    expect(attrs["agentmesh.peer"]).toBe("UPEER");
    expect(attrs["agentmesh.task_id"]).toBe("t-1");
  });

  it("omits parent_span_id on a root rather than writing empty bytes", () => {
    const { span } = firstSpan(otlpTracesProto([fixture({ parent_span_id: null })]));
    expect(span.find((f) => f.no === 4)).toBeUndefined();
  });

  it("carries caller-supplied resource attributes, which is what Google demands", () => {
    const bytes = otlpTracesProto([fixture()], { resourceAttributes: { "gcp.project_id": "proj-1" } });
    const { resource } = firstSpan(bytes);
    const attrs = Object.fromEntries(all(resource, 1).map((f) => {
      const kv = parse(f.bytes!);
      return [str(only(kv, 1).bytes), str(only(parse(only(kv, 2).bytes!), 1).bytes)];
    }));
    expect(attrs["service.name"]).toBe("UAGENT");
    expect(attrs["gcp.project_id"]).toBe("proj-1");
  });

  it("groups by agent, so each arrives as its own service", () => {
    const bytes = otlpTracesProto([fixture({ agent_id: "UONE" }), fixture({ agent_id: "UTWO" })]);
    expect(all(parse(bytes), 1)).toHaveLength(2);
  });

  it("carries no content, the same refusal the JSON encoder makes", () => {
    const wire = new TextDecoder().decode(otlpTracesProto([fixture()]));
    for (const forbidden of ["price", "cost", "amount", "payload", "prompt"]) {
      expect(wire.toLowerCase()).not.toContain(forbidden);
    }
  });
});
