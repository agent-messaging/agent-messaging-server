// §13.5 request_id (Agent Messaging 0.9.5-draft): every meter event derived
// from an ANSWER names the request it answers, so a reader folding the stream
// joins a request's batch (keyed by its own envelope_id) to its answer's
// without the in-memory correlation the activity tap holds. Request-side
// events carry no request_id, because their envelope_id IS the request id.
//
// The fixture half reads conformance/metering.json's `request_id` group. THE
// FIXTURE IS THE AUTHORITY: when this fails, fix the code.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  declaredUsage,
  observedRefusal,
  observedRequest,
  observedResponse,
  observedResponseBytes,
  observedTaskTerminal,
  readBatch,
  validMeterEvent,
  METERING_SUBJECT,
  type MeterEvent,
  type MeterEventBatch,
} from "../../src/shared/metering.js";
import { applyBatch } from "../../src/activity/metering-fold.js";
import type { Envelope } from "../../src/sdk.js";
import { uuid7 } from "../../src/sdk.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../conformance/metering.json"), "utf8"),
) as {
  request_id: {
    valid: MeterEvent[];
    join: {
      events: MeterEvent[];
      expect: Array<{
        request_id: string;
        request_meters: string[];
        answer_meters: string[];
        answer_envelope_ids: string[];
      }>;
    };
  };
  receipt: { signed_envelope: { signed: { id: string; in_reply_to: string } } };
};

const P = "UPROVIDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const C = "UCONSUMERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const ids = (b: MeterEventBatch) => b.events.map((e) => e.request_id);

describe("§13.5 request_id: the builders", () => {
  it("every response-side builder sets it when given the request id", () => {
    expect(ids(observedResponse(P, C, "S1", 200, false, "summarize", "t-1", "R1"))).toEqual(["R1", "R1"]);
    expect(ids(observedResponse(P, C, "S1", 200, true, undefined, undefined, "R1"))).toEqual(["R1", "R1"]);
    expect(ids(observedResponseBytes(P, C, "S2", 50, "R1"))).toEqual(["R1"]);
    expect(ids(observedRefusal(P, C, "S3", "BUDGET_INSUFFICIENT", "summarize", "R1"))).toEqual(["R1"]);
    const { batch } = declaredUsage(P, C, "S4", [{ meter: "tokens_out", quantity: 10 }], "summarize", undefined, "R1");
    expect(ids(batch)).toEqual(["R1"]);
    for (const b of [
      observedResponse(P, C, "S1", 200, false, "summarize", "t-1", "R1"),
      observedResponseBytes(P, C, "S2", 50, "R1"),
      observedRefusal(P, C, "S3", "BUDGET_INSUFFICIENT", "summarize", "R1"),
      batch,
    ]) {
      for (const e of b.events) expect(validMeterEvent(e)).toBe(true);
    }
  });

  it("omits it when no request id is known, and leaves every other member as it was", () => {
    for (const b of [
      observedResponse(P, C, "S1", 200, false, "summarize", "t-1"),
      observedResponseBytes(P, C, "S2", 50),
      observedRefusal(P, C, "S3", "BUDGET_INSUFFICIENT", "summarize"),
      declaredUsage(P, C, "S4", [{ meter: "tokens_out", quantity: 10 }]).batch,
    ]) {
      for (const e of b.events) expect("request_id" in e).toBe(false);
    }
    const r = observedResponse(P, C, "S1", 200, true, "summarize", "t-1", "R1");
    expect(r.failed).toBe(true);
    expect(r.events[0]).toMatchObject({ meter: "responses", envelope_id: "S1", offering: "summarize", task_id: "t-1" });
  });

  it("request-side and task-terminal events never carry it", () => {
    for (const e of observedRequest(P, C, "R1", 100, "summarize", "t-1").events) expect("request_id" in e).toBe(false);
    for (const e of observedTaskTerminal(P, C, "T1", "t-1", 8000, true).events) expect("request_id" in e).toBe(false);
  });
});

describe("§13.5 request_id: the fixture (conformance/metering.json)", () => {
  it("every valid event validates and survives readBatch with its request_id", () => {
    for (const e of fixture.request_id.valid) {
      expect(validMeterEvent(e)).toBe(true);
      expect(typeof e.request_id).toBe("string");
    }
    const env = { payload: { data: { events: structuredClone(fixture.request_id.valid) } } } as unknown as Envelope;
    const { batch, dropped } = readBatch(env);
    expect(dropped).toBe(0);
    expect(batch.events.map((e) => e.request_id)).toEqual(fixture.request_id.valid.map((e) => e.request_id));
  });

  it("the join meets on the request id: request events by envelope_id, answer events by request_id", () => {
    const { events, expect: want } = fixture.request_id.join;
    for (const e of events) expect(validMeterEvent(e)).toBe(true);
    const got = want.map((w) => {
      const req = events.filter((e) => e.request_id === undefined && e.envelope_id === w.request_id);
      const ans = events.filter((e) => e.request_id === w.request_id);
      return {
        request_id: w.request_id,
        request_meters: req.map((e) => e.meter).sort(),
        answer_meters: ans.map((e) => e.meter).sort(),
        answer_envelope_ids: [...new Set(ans.map((e) => e.envelope_id))].sort(),
      };
    });
    expect(got).toEqual(want);
    // The joined answer is the fixture's really-signed respond.
    const signed = fixture.receipt.signed_envelope.signed;
    expect(want[0].request_id).toBe(signed.in_reply_to);
    expect(want[0].answer_envelope_ids).toEqual([signed.id]);
  });

  it("a malformed request_id is dropped from the event, never the event itself", () => {
    const ok = observedResponse(P, C, "S1", 200, false).events[0];
    const env = {
      payload: { data: { events: [{ ...ok, request_id: 7 }, { ...ok, meter: "bytes_out", request_id: "" }] } },
    } as unknown as Envelope;
    const { batch, dropped } = readBatch(env);
    expect(dropped).toBe(0);
    expect(batch.events).toHaveLength(2);
    for (const e of batch.events) expect("request_id" in e).toBe(false);
  });

  it("members a reader does not know are ignored, and the counters fold exactly as before", () => {
    const calls: unknown[][] = [];
    const usage = new Proxy({}, {
      get: (_t, name) => (...args: unknown[]) => { calls.push([name, ...args]); },
    }) as never;
    const withId = observedResponse(P, C, "S1", 200, true, "summarize", undefined, "R1");
    const without = observedResponse(P, C, "S1", 200, true, "summarize");
    const future = { ...without, events: without.events.map((e) => ({ ...e, some_later_member: { x: 1 } })) };
    for (const e of future.events) expect(validMeterEvent(e)).toBe(true);
    applyBatch(usage, withId);
    const a = calls.splice(0);
    applyBatch(usage, without);
    const b = calls.splice(0);
    applyBatch(usage, future as MeterEventBatch);
    const c = calls.splice(0);
    expect(a).toEqual(b);
    expect(c).toEqual(b);
  });
});

// ── the tap: what the activity service actually publishes ───────────────────

const AGENT = "UAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CALLER = "UCALLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SERVICE = "USERVICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

interface Svc {
  recordRequest(env: Envelope, bytes?: number): void;
  recordResponse(env: Envelope, bytes?: number): void;
  audit: { close(): void };
  usage: { close(): Promise<void> };
}

function requestEnv(over: Partial<{ task_id: string }> = {}): Envelope {
  return {
    v: "0.1",
    id: uuid7(),
    type: "request",
    from: CALLER,
    to: AGENT,
    ts: new Date().toISOString(),
    ...(over.task_id ? { task_id: over.task_id } : {}),
    payload: { offering: "summarize", input: { q: 1 } },
  } as unknown as Envelope;
}

function respondEnv(
  over: Partial<{ in_reply_to: string; task_id: string; payload: Record<string, unknown>; error: { code: string; message: string } }>,
): Envelope {
  return {
    v: "0.1",
    id: uuid7(),
    type: "respond",
    from: AGENT,
    to: CALLER,
    ...(over.in_reply_to ? { in_reply_to: over.in_reply_to } : {}),
    ...(over.task_id ? { task_id: over.task_id } : {}),
    ts: new Date().toISOString(),
    ...(over.error ? { error: over.error } : {}),
    payload: over.payload ?? { status: "completed", output: { a: 1 } },
  } as unknown as Envelope;
}

describe("§13.5 request_id: the activity tap", () => {
  let dir: string | undefined;
  let closers: Array<() => unknown> = [];

  afterEach(async () => {
    for (const c of closers) await c();
    closers = [];
    vi.unstubAllEnvs();
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows holds SQLite WAL files briefly; a leaked tmpdir is harmless */
    }
    dir = undefined;
  });

  /** A tap with metering ON whose publishes are captured, one batch each. */
  async function makeTap(): Promise<{ svc: Svc; batches: Array<{ events: MeterEvent[]; failed?: boolean }> }> {
    dir = mkdtempSync(join(tmpdir(), "meter-request-id-"));
    vi.resetModules();
    vi.stubEnv("AUDIT_DB_PATH", join(dir, "audit.db"));
    vi.stubEnv("USAGE_DB_PATH", join(dir, "usage.db"));
    const mod = await import("../../src/activity/activity-service.js");
    const batches: Array<{ events: MeterEvent[]; failed?: boolean }> = [];
    const nc = {
      publish: (subject: string, data: Uint8Array) => {
        if (subject !== METERING_SUBJECT) return;
        const env = JSON.parse(new TextDecoder().decode(data)) as { payload: { data: MeterEventBatch } };
        batches.push(env.payload.data);
      },
    };
    const svc = new mod.ActivityService(nc as never, {} as never, { put: async () => 1 } as never) as unknown as Svc;
    const s = svc as unknown as { meteringOn: boolean; kp: string };
    s.meteringOn = true;
    // An unsigned service identity: the capture reads the batch, not the seal.
    Object.defineProperty(svc, "kp", { value: SERVICE });
    closers.push(() => svc.audit.close());
    closers.push(() => svc.usage.close());
    return { svc, batches };
  }

  it("the request's batch has none; the first respond's responses, bytes_out and declared events name the request", async () => {
    const { svc, batches } = await makeTap();
    const req = requestEnv();
    svc.recordRequest(req, 100);
    svc.recordResponse(
      respondEnv({
        in_reply_to: req.id,
        payload: { status: "completed", output: { a: 1 }, usage: [{ meter: "tokens_out", quantity: 42 }] },
      }),
      300,
    );

    const all = batches.flatMap((b) => b.events);
    const reqSide = all.filter((e) => e.envelope_id === req.id);
    expect(reqSide.map((e) => e.meter).sort()).toEqual(["bytes_in", "requests"]);
    for (const e of reqSide) expect("request_id" in e).toBe(false);

    const ansSide = all.filter((e) => e.envelope_id !== req.id);
    expect(ansSide.map((e) => e.meter).sort()).toEqual(["bytes_out", "responses", "tokens_out"]);
    for (const e of ansSide) expect(e.request_id).toBe(req.id);
  });

  it("a follow-up respond's bytes_out names the request too (task-mode multi-respond)", async () => {
    const { svc, batches } = await makeTap();
    const req = requestEnv();
    svc.recordRequest(req, 100);
    svc.recordResponse(respondEnv({ in_reply_to: req.id, payload: { status: "working" } }), 200);
    svc.recordResponse(respondEnv({ in_reply_to: req.id }), 300);
    const follow = batches.at(-1)!;
    expect(follow.events.map((e) => e.meter)).toEqual(["bytes_out"]);
    expect(follow.events[0].request_id).toBe(req.id);
  });

  it("a respond correlated by task_id alone (no in_reply_to) still names the request", async () => {
    const { svc, batches } = await makeTap();
    const req = requestEnv({ task_id: "task-77" });
    svc.recordRequest(req, 100);
    svc.recordResponse(respondEnv({ task_id: "task-77" }), 300);
    const ans = batches.flatMap((b) => b.events).filter((e) => e.envelope_id !== req.id);
    expect(ans.length).toBeGreaterThan(0);
    for (const e of ans) expect(e.request_id).toBe(req.id);
  });

  it("an admission refusal: the failed responses batch and the refusal event both name the refused request", async () => {
    const { svc, batches } = await makeTap();
    const req = requestEnv();
    svc.recordRequest(req, 100);
    svc.recordResponse(
      respondEnv({
        in_reply_to: req.id,
        payload: { status: "failed" },
        error: { code: "BUDGET_INSUFFICIENT", message: "over budget" },
      }),
      120,
    );
    const failed = batches.find((b) => b.failed === true)!;
    expect(failed.events.map((e) => e.request_id)).toEqual([req.id, req.id]);
    const refusal = batches.flatMap((b) => b.events).find((e) => e.refused === true)!;
    expect(refusal.refusal_code).toBe("BUDGET_INSUFFICIENT");
    expect(refusal.request_id).toBe(req.id);
    expect(refusal.envelope_id).not.toBe(req.id);
  });
});
