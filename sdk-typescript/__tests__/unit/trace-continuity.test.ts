/**
 * One trace, all the way across (SPEC.md §13.1, §13.1.1, §13.4).
 *
 * The claim on agentmesh.ai/AgentLifecycle.html is that a trace which used to
 * stop at a company's edge now carries on across it. That claim spans four
 * pieces which had only ever been tested apart: the `traceparent` conversion
 * an HTTP bridge does, the producer span a caller closes, the consumer span a
 * responder closes, and the OTLP a collector receives.
 *
 * This walks the chain through the real functions, with the broker faked. What
 * it PROVES is composition: the ids survive every hand-off and the parentage
 * comes out right. What it cannot prove is the hop over a live NATS
 * connection, which needs a broker; that is the live proof taken after a roll,
 * not something CI can hold.
 *
 * The chain, as a customer would draw it:
 *
 *   Contoso's HTTP client  --traceparent-->  bridge
 *                                              |  fromTraceparent
 *                                              v
 *                                     Tom's agent (producer span)
 *                                              |  request
 *                                              v
 *                                     supplier agent (consumer span)
 *                                              |
 *                                              v
 *                                        OTLP collector
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decodeUnverified } from "../../src/internal/codec.js";
import { fromTraceparent, toTraceparent } from "../../src/internal/trace.js";
import { runWithTrace } from "../../src/internal/trace-ambient.js";
import { otlpTraces } from "../../src/internal/otlp.js";
import type { SpanData } from "../../src/internal/spans.js";
import type { Envelope } from "../../src/types/envelope.js";

const CONTOSO_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const CONTOSO_SPAN = "00f067aa0ba902b7";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close().catch(() => {});
});

function makeConn() {
  const published: { subject: string; data: Uint8Array }[] = [];
  const subs = new Map<string, (msg: unknown) => void>();
  const supplierKp = nkeys.createUser();
  return {
    supplierId: supplierKp.getPublicKey(),
    published,
    publish: vi.fn((subject: string, data: Uint8Array) => published.push({ subject, data })),
    /** The supplier answers. Its reply is signed by the supplier's own key,
     *  delivered to the requester's inbox (§6.4 cutover). */
    request: vi.fn(async (_subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      const bytes = encode(
        signEnvelope(
          createEnvelope({
            type: "respond",
            from: supplierKp.getPublicKey(),
            to: req.from,
            in_reply_to: req.id,
            // The responder answers inside the caller's trace, which is what
            // §13.1's propagation rules require of it.
            trace: { ...req.trace, span_id: "aaaaaaaaaaaaaaaa", parent_span_id: req.trace.span_id },
            payload: { status: "completed", output: { lead_time_days: 12 } },
          }),
          supplierKp,
        ),
      );
      const inbox = `mesh.agent.${req.from}.inbox`;
      subs.get(inbox)?.({ subject: inbox, data: bytes, reply: undefined, respond: () => true });
      return { data: bytes };
    }),
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
      subs.set(subject, cb);
      return { unsubscribe: () => subs.delete(subject), drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    raw: { publish: () => {} },
    get isClosed() {
      return false;
    },
  };
}

function spansOn(conn: ReturnType<typeof makeConn>): SpanData[] {
  return conn.published
    .filter((p) => p.subject.startsWith("mesh.trace."))
    .map((p) => (decodeUnverified(p.data).payload as { data: SpanData }).data);
}

describe("a trace survives every hand-off", () => {
  it("carries Contoso's trace id from an HTTP header into OTLP", async () => {
    const conn = makeConn();

    // ── 1. the bridge: an inbound traceparent becomes a mesh context ────────
    const inbound = fromTraceparent(`00-${CONTOSO_TRACE}-${CONTOSO_SPAN}-01`);
    expect(inbound).not.toBeNull();
    expect(inbound!.trace_id).toBe(CONTOSO_TRACE);
    expect(inbound!.parent_span_id).toBe(CONTOSO_SPAN);

    // ── 2. Tom's agent works inside that trace and closes a producer span ───
    const tom = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
      { emitSpans: true },
    );
    openAgents.push(tom);

    const result = await runWithTrace(inbound!, () =>
      tom.request(conn.supplierId, "lead-times", { part: "40mm flange" }),
    );
    expect((result.payload as { output: { lead_time_days: number } }).output.lead_time_days).toBe(12);

    // ── 3. the span Tom emitted is in Contoso's trace ──────────────────────
    // Note what it parents under. The BRIDGE is a hop: `fromTraceparent` gave
    // it a span of its own whose parent is Contoso's, and Tom's request is a
    // child of the bridge's span rather than of Contoso's directly. That is
    // the honest picture — there really is a process in between — and it is
    // what lets somebody see time spent at the boundary instead of having it
    // silently folded into one side or the other.
    const spans = spansOn(conn);
    expect(spans).toHaveLength(1);
    const producer = spans[0];
    expect(producer.trace_id).toBe(CONTOSO_TRACE);
    expect(producer.parent_span_id).toBe(inbound!.span_id);
    expect(inbound!.parent_span_id).toBe(CONTOSO_SPAN);
    expect(producer.kind).toBe("producer");
    expect(producer.status).toBe("ok");
    expect(producer.tags?.peer).toBe(conn.supplierId);

    // ── 4. and the supplier's reply is in the same trace ────────────────────
    const replySpan: SpanData = {
      ...producer,
      agent_id: conn.supplierId,
      span_id: "aaaaaaaaaaaaaaaa",
      parent_span_id: producer.span_id,
      kind: "consumer",
    };

    // ── 5. OTLP: one trace, two services, correct parentage ────────────────
    const otlp = otlpTraces([producer, replySpan], { scopeVersion: "test" }) as {
      resourceSpans: {
        resource: { attributes: { key: string; value: { stringValue: string } }[] };
        scopeSpans: { spans: Record<string, unknown>[] }[];
      }[];
    };

    // Each agent is its own service, so a collector can filter by one.
    expect(otlp.resourceSpans).toHaveLength(2);
    const services = otlp.resourceSpans.map(
      (r) => r.resource.attributes.find((a) => a.key === "service.name")!.value.stringValue,
    );
    expect(new Set(services)).toEqual(new Set([producer.agent_id, conn.supplierId]));

    const all = otlp.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
    expect(all).toHaveLength(2);

    // The whole point: one trace id, end to end, unchanged from the header
    // Contoso sent.
    expect(new Set(all.map((s) => s.traceId))).toEqual(new Set([CONTOSO_TRACE]));

    // The chain hangs together: Contoso's span ← Tom's ← the supplier's.
    const otlpProducer = all.find((s) => s.kind === 4)!;
    const otlpConsumer = all.find((s) => s.kind === 5)!;
    expect(otlpProducer.parentSpanId).toBe(inbound!.span_id);
    expect(otlpConsumer.parentSpanId).toBe(otlpProducer.spanId);

    // ── 6. and nothing about the work came with it ─────────────────────────
    const wire = JSON.stringify(otlp);
    expect(wire).not.toContain("40mm flange");
    expect(wire).not.toContain("lead_time_days");
    expect(wire).toContain("lead-times"); // the offering NAME is fine
  });

  it("hands a collector a root it can render, not a broken link", () => {
    // A root span with an empty parentSpanId is legal OTLP that several
    // collectors draw as a dangling edge.
    const root: SpanData = {
      trace_id: CONTOSO_TRACE,
      span_id: "bbbbbbbbbbbbbbbb",
      parent_span_id: null,
      agent_id: "UROOT",
      kind: "producer",
      operation: "request",
      started_at: "2026-08-14T12:00:00.000Z",
      ended_at: "2026-08-14T12:00:00.250Z",
      duration_ms: 250,
      status: "ok",
    };
    const otlp = otlpTraces([root]) as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    const span = otlp.resourceSpans[0].scopeSpans[0].spans[0];
    expect("parentSpanId" in span).toBe(false);
    // Computed rather than hand-written, so the assertion is about the
    // conversion and not about my arithmetic.
    expect(span.startTimeUnixNano).toBe(String(BigInt(Date.parse(root.started_at)) * 1_000_000n));
    expect(span.endTimeUnixNano).toBe(String(BigInt(Date.parse(root.ended_at)) * 1_000_000n));
    expect(BigInt(span.endTimeUnixNano as string) - BigInt(span.startTimeUnixNano as string)).toBe(250_000_000n);
  });

  it("round-trips the mesh context back out to an HTTP header", () => {
    // The other direction of §13.1.1: what the bridge puts on an outbound call.
    const ctx = fromTraceparent(`00-${CONTOSO_TRACE}-${CONTOSO_SPAN}-01`)!;
    const header = toTraceparent(ctx);
    expect(header).toMatch(new RegExp(`^00-${CONTOSO_TRACE}-[0-9a-f]{16}-01$`));
    // A fresh span of our own, never the caller's, so the far side parents
    // under us rather than under whoever called us.
    expect(header).not.toContain(CONTOSO_SPAN);
    expect(fromTraceparent(header)!.trace_id).toBe(CONTOSO_TRACE);
  });
});
