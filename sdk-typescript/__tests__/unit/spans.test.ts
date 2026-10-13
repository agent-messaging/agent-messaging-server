/**
 * Span completion events (SPEC.md §13.1.1).
 *
 * Most of this file is about what a span REFUSES to say, because that is the
 * part that cannot be walked back. A span leaves the mesh for third-party
 * tooling the counterparty never agreed to and cannot see, so a payload that
 * leaks into one has left the building permanently. The shape tests below
 * exist so that adding such a field has to be a deliberate act that breaks a
 * test named after the reason it is wrong.
 *
 * The wiring tests pin the other half: emission is OFF until an operator turns
 * it on, and turning it on produces one span per hop with the right kind.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decodeUnverified } from "../../src/internal/codec.js";
import { newTraceContext } from "../../src/internal/trace.js";
import { Subjects } from "../../src/internal/subjects.js";
import { spanData, spanPayload, outcomeOf, traceSubject, type SpanInput } from "../../src/internal/spans.js";
import { MeshError, ErrorCode } from "../../src/types/errors.js";
import type { Envelope } from "../../src/types/envelope.js";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close().catch(() => {});
});

function baseInput(over: Partial<SpanInput> = {}): SpanInput {
  return {
    trace: newTraceContext(),
    kind: "producer",
    agentId: "UME",
    operation: "request",
    peer: "UTHEM",
    offering: "quote",
    outcome: "ok",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_250,
    ...over,
  };
}

describe("what a span carries", () => {
  it("has the W3C ids, the parties, the outcome and the duration", () => {
    const d = spanData(baseInput());
    expect(d.duration_ms).toBe(250);
    expect(d.status).toBe("ok");
    expect(d.kind).toBe("producer");
    expect(d.operation).toBe("request");
    expect(d.offering).toBe("quote");
    expect(d.agent_id).toBe("UME");
    expect(d.tags?.peer).toBe("UTHEM");
    expect(d.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(d.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(d.started_at).toBe("2023-11-14T22:13:20.000Z");
  });

  it("omits what it has nothing to say about, rather than writing null", () => {
    // A reader who sees `"offering": null` learns that there WAS an offering
    // slot and this hop declined to fill it. Absence says less, which is the
    // point.
    const d = spanData(baseInput({ offering: undefined, peer: undefined, taskId: null }));
    expect("offering" in d).toBe(false);
    expect(d.tags).toBeUndefined();
  });

  it("never carries a negative duration, however the clocks behaved", () => {
    expect(spanData(baseInput({ startedAt: 500, endedAt: 100 })).duration_ms).toBe(0);
  });
});

describe("what a span refuses to carry", () => {
  const forbidden = ["input", "output", "payload", "artifact", "message", "text", "content", "data"];

  it("has no field that could hold what was said", () => {
    const d = spanData(baseInput()) as Record<string, unknown>;
    for (const key of forbidden) {
      expect(Object.keys(d), `span must not have a "${key}" field`).not.toContain(key);
      expect(Object.keys(d.tags ?? {}), `span tags must not have "${key}"`).not.toContain(key);
    }
  });

  it("has nowhere to put an amount", () => {
    // §13.1.1: price and settled totals are genuinely useful for debugging
    // spend and are excluded anyway, because a span is exported into tooling
    // the counterparty never agreed to. Commercial terms stay in the
    // agreement, the meter report and the settlement record.
    const d = JSON.stringify(spanData(baseInput()));
    for (const money of ["price", "cost", "amount", "total", "currency", "xcr"]) {
      expect(d.toLowerCase()).not.toContain(money);
    }
  });

  it("keeps a remote error's CODE and drops its prose", () => {
    // The code is a closed enum we defined. The message may be a sentence a
    // stranger wrote, and a span is the wrong place for a stranger's sentence.
    const err = new MeshError(ErrorCode.OFFERING_NOT_FOUND, "no such thing, and by the way ${SECRET}");
    const { outcome, errorCode } = outcomeOf(err);
    expect(outcome).toBe("error");
    expect(errorCode).toBe("OFFERING_NOT_FOUND");
    const d = JSON.stringify(spanData(baseInput({ outcome, errorCode })));
    expect(d).toContain("OFFERING_NOT_FOUND");
    expect(d).not.toContain("SECRET");
    expect(d).not.toContain("no such thing");
  });

  it("sorts failures into the closed outcome set", () => {
    expect(outcomeOf(new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "")).outcome).toBe("timeout");
    expect(outcomeOf(new Error("plain")).outcome).toBe("error");
    expect(outcomeOf(new Error("plain")).errorCode).toBeUndefined();
    expect(outcomeOf(undefined).outcome).toBe("error");
  });
});

describe("the envelope a span rides in", () => {
  it("is addressed to the trace subject, not the event bus", () => {
    // A `subscribe("trace.>")` handler has no business receiving telemetry,
    // and the MESH_TRACE stream filters on `mesh.trace.>` (§14).
    expect(traceSubject("UME")).toBe("mesh.trace.UME");
    expect(traceSubject("UME")).not.toContain("mesh.event");
  });

  it("names itself as a trace domain event", () => {
    const p = spanPayload(baseInput());
    expect(p.domain).toBe("trace");
    expect(p.event_type).toBe("span_completed");
  });
});

// ── the wiring ──────────────────────────────────────────────────────────────

function makeConn() {
  const subs = new Map<string, (msg: unknown) => void>();
  const registryKp = nkeys.createUser();
  const published: { subject: string; data: Uint8Array }[] = [];
  return {
    subs,
    published,
    publish: vi.fn((subject: string, data: Uint8Array) => published.push({ subject, data })),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      const bytes = encode(
        signEnvelope(
          createEnvelope({
            type: "respond",
            from: registryKp.getPublicKey(),
            to: req.from,
            in_reply_to: req.id,
            payload: { status: "completed", output: { ok: true } },
          }),
          registryKp,
        ),
      );
      // §6.4 cutover: an agent-send's answer arrives at the requester's inbox;
      // the reply subject's data is ignored.
      if (subject.endsWith(".inbox")) {
        subs.get(Subjects.agentInbox(req.from))?.({
          subject: Subjects.agentInbox(req.from),
          data: bytes,
          reply: undefined,
          respond: () => true,
        });
      }
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

function agentOn(conn: ReturnType<typeof makeConn>, emitSpans?: boolean) {
  const a = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
    emitSpans === undefined ? undefined : { emitSpans },
  );
  openAgents.push(a);
  return a;
}

function spansIn(conn: ReturnType<typeof makeConn>): Envelope[] {
  return conn.published
    .filter((p) => p.subject.startsWith("mesh.trace."))
    .map((p) => decodeUnverified(p.data));
}

describe("every construction path honours the switch", () => {
  // 0.43.0 shipped with `connect()` ignoring emitSpans while hostedBy and
  // withConnection honoured it. ConnectOptions declared the field, so a caller
  // could set it, typecheck clean, and get silence — and `connect()` is the
  // path the reference adapter uses, so it was the one that mattered.
  it("applies emitSpans on every path that builds an agent", () => {
    const paths = ["connect", "hostedBy", "withConnection"] as const;
    const applied = paths.filter((p) => {
      const src = readFileSync(new URL(`../../src/mesh.ts`, import.meta.url), "utf8");
      const body = src.slice(src.indexOf(`${p === "connect" ? "static async connect(" : `static ${p}(`}`));
      return body.slice(0, 4000).includes("spansEnabled = opts?.emitSpans");
    });
    expect(applied).toEqual([...paths]);
  });
});

describe("emission is a decision, not a default", () => {
  it("publishes nothing at all unless it was turned on", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    await agent.request("UTHEM", "quote", "how much?");
    expect(spansIn(conn)).toHaveLength(0);
  });

  it("publishes a producer span for a request once it is on", async () => {
    const conn = makeConn();
    const agent = agentOn(conn, true);
    await agent.request("UTHEM", "quote", "how much?");

    const spans = spansIn(conn);
    expect(spans).toHaveLength(1);
    const data = (spans[0].payload as { data: ReturnType<typeof spanData> }).data;
    expect(data.kind).toBe("producer");
    expect(data.operation).toBe("request");
    expect(data.offering).toBe("quote");
    expect(data.status).toBe("ok");
    expect(data.tags?.peer).toBe("UTHEM");
    // The span describes the hop, so it carries the hop's own context rather
    // than opening a child of it.
    expect(data.trace_id).toBe(spans[0].trace.trace_id);
    // And it says nothing about what was asked.
    expect(JSON.stringify(data)).not.toContain("how much?");
  });

  it("records a failed hop as failed", async () => {
    const conn = makeConn();
    conn.request = vi.fn(async () => {
      throw new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "nobody home");
    }) as never;
    const agent = agentOn(conn, true);

    await expect(agent.request("UTHEM", "quote", "how much?")).rejects.toThrow();

    const spans = spansIn(conn);
    expect(spans).toHaveLength(1);
    const data = (spans[0].payload as { data: ReturnType<typeof spanData> }).data;
    expect(data.status).toBe("timeout");
    expect(data.error_code).toBe("TRANSPORT_TIMEOUT");
    expect(JSON.stringify(data)).not.toContain("nobody home");
  });
});
