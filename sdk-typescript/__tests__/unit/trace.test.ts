import { describe, it, expect } from "vitest";
import { newTraceContext, childSpan } from "../../src/internal/trace.js";

describe("newTraceContext", () => {
  it("creates a trace context with trace_id, span_id, and null parent", () => {
    const ctx = newTraceContext();
    expect(ctx.trace_id).toBeTruthy();
    expect(ctx.span_id).toBeTruthy();
    expect(ctx.parent_span_id).toBeNull();
  });

  it("produces unique trace_ids", () => {
    const a = newTraceContext();
    const b = newTraceContext();
    expect(a.trace_id).not.toBe(b.trace_id);
  });
});

describe("childSpan", () => {
  it("preserves trace_id and sets parent_span_id", () => {
    const parent = newTraceContext();
    const child = childSpan(parent);
    expect(child.trace_id).toBe(parent.trace_id);
    expect(child.parent_span_id).toBe(parent.span_id);
    expect(child.span_id).not.toBe(parent.span_id);
  });
});

// ─── W3C Trace Context (§13.1) ──────────────────────────────────────────────

import { toTraceparent, fromTraceparent } from "../../src/internal/trace.js";
import { runWithTrace, currentTrace } from "../../src/internal/trace-ambient.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";

describe("W3C id formats", () => {
  it("trace_id is 32 lowercase hex chars, span_id is 16", () => {
    const ctx = newTraceContext();
    expect(ctx.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(childSpan(ctx).span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("omits tracestate when absent, carries it verbatim through childSpan", () => {
    const plain = childSpan(newTraceContext());
    expect("tracestate" in plain).toBe(false);
    const withState = childSpan({ ...newTraceContext(), tracestate: "vendor=abc" });
    expect(withState.tracestate).toBe("vendor=abc");
  });

  it("round-trips through a traceparent header", () => {
    const ctx = newTraceContext();
    const header = toTraceparent(ctx);
    expect(header).toBe(`00-${ctx.trace_id}-${ctx.span_id}-01`);
    const back = fromTraceparent(header, "vendor=abc");
    expect(back).not.toBeNull();
    expect(back!.trace_id).toBe(ctx.trace_id);
    expect(back!.parent_span_id).toBe(ctx.span_id);
    expect(back!.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(back!.tracestate).toBe("vendor=abc");
  });

  it("rejects malformed traceparent", () => {
    expect(fromTraceparent("garbage")).toBeNull();
    expect(fromTraceparent("00-shorttrace-span-01")).toBeNull();
  });
});

describe("ambient propagation (§13.1 automatic)", () => {
  it("envelopes built inside runWithTrace become children of the ambient trace", async () => {
    // The ambient store loads via dynamic import; give it a microtask turn.
    await new Promise((r) => setTimeout(r, 10));
    const inbound = newTraceContext();
    const env = await runWithTrace(inbound, async () => {
      await new Promise((r) => setTimeout(r, 1)); // survive an await boundary
      expect(currentTrace()).toEqual(inbound);
      return createEnvelope({ type: "request", from: "UAGENT" });
    });
    expect(env.trace.trace_id).toBe(inbound.trace_id);
    expect(env.trace.parent_span_id).toBe(inbound.span_id);
    expect(env.trace.span_id).not.toBe(inbound.span_id);
  });

  it("explicit trace wins over ambient; no ambient means a fresh root", async () => {
    const inbound = newTraceContext();
    const explicit = newTraceContext();
    const env = runWithTrace(inbound, () =>
      createEnvelope({ type: "request", from: "UAGENT", trace: explicit }),
    );
    expect(env.trace).toEqual(explicit);
    const root = createEnvelope({ type: "request", from: "UAGENT" });
    expect(root.trace.parent_span_id).toBeNull();
    expect(root.trace.trace_id).not.toBe(inbound.trace_id);
  });
});
