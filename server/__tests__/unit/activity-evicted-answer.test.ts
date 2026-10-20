// An answer whose request has left the activity ring still meters.
//
// The ring holds ACTIVITY_MAX_ENTRIES exchanges MESH-WIDE (500 by default), and
// `recordResponse` used to find an answer's request only there: a respond whose
// request had been pushed out by 500 later requests from anyone emitted no
// `responses`, no `bytes_out`, no failed flag, no refusal and no declared usage,
// and so no request_id to join on. A buyer could flood cheap requests to push a
// request out on purpose. These tests pin the fix: the answer is metered from
// the exchange index (activity/exchange-index.ts), a durable, content-free
// record keyed by request id — the same events, under the same
// (meter, envelope_id) keys, with the ring's guards.
//
// The ring is set to 2 here so that two later requests evict a request.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METERING_SUBJECT, type MeterEvent, type MeterEventBatch } from "../../src/shared/metering.js";
import type { Envelope } from "../../src/sdk.js";
import { uuid7 } from "../../src/sdk.js";
import { KEYED_STORE } from "../../src/storage/jetstream/keyed.js";
import type { KeyedEntry, KeyedStore } from "../../src/storage/index.js";
import { requestKey } from "../../src/activity/exchange-index.js";
import { fakeJs, forbiddenKeys } from "../helpers/fake-kv.js";

const AGENT = "UAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CALLER = "UCALLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FLOODER = "UFLOODERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "UOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SERVICE = "USERVICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** A keyed store in memory, durable across service instances in one test. */
function memoryStore(): KeyedStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  let rev = 0;
  const entry = (key: string, body: string): KeyedEntry => ({
    key,
    value: new TextEncoder().encode(body),
    revision: rev,
    created: new Date(),
    operation: "PUT",
    length: body.length,
    json: <T>() => JSON.parse(body) as T,
    string: () => body,
  });
  const text = (v: Uint8Array | string) => (typeof v === "string" ? v : new TextDecoder().decode(v));
  return {
    [KEYED_STORE]: true,
    data,
    async get(key) {
      const body = data.get(key);
      return body === undefined ? null : entry(key, body);
    },
    async put(key, value) {
      data.set(key, text(value));
      return ++rev;
    },
    async create(key, value) {
      if (data.has(key)) throw new Error("wrong last sequence");
      data.set(key, text(value));
      return ++rev;
    },
    async update(key, value) {
      data.set(key, text(value));
      return ++rev;
    },
    async delete(key) { data.delete(key); },
    async purge(key) { data.delete(key); },
    async list() { throw new Error("not used"); },
    async watch() { throw new Error("not used"); },
  } as KeyedStore & { data: Map<string, string> };
}

interface Svc {
  entries: Array<{ requestId?: string }>;
  index: { drain(): Promise<void> } | null;
  recordRequest(env: Envelope, bytes?: number): void;
  recordResponse(env: Envelope, bytes?: number): void;
  audit: { close(): void };
  usage: { close(): Promise<void> };
}

function request(from = CALLER, over: Partial<{ task_id: string }> = {}): Envelope {
  return {
    v: "0.1",
    id: uuid7(),
    type: "request",
    from,
    to: AGENT,
    ts: new Date().toISOString(),
    ...(over.task_id ? { task_id: over.task_id } : {}),
    payload: { offering: "summarize", input: { q: 1 } },
  } as unknown as Envelope;
}

function respond(
  over: Partial<{
    from: string;
    in_reply_to: string;
    task_id: string;
    payload: Record<string, unknown>;
    error: { code: string; message: string };
  }>,
): Envelope {
  return {
    v: "0.1",
    id: uuid7(),
    type: "respond",
    from: over.from ?? AGENT,
    to: CALLER,
    ...(over.in_reply_to ? { in_reply_to: over.in_reply_to } : {}),
    ...(over.task_id ? { task_id: over.task_id } : {}),
    ts: new Date().toISOString(),
    ...(over.error ? { error: over.error } : {}),
    payload: over.payload ?? { status: "completed", output: { a: 1 } },
  } as unknown as Envelope;
}

describe("an answer whose request has left the activity ring", () => {
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

  function capture() {
    const batches: Array<{ events: MeterEvent[]; failed?: boolean }> = [];
    const nc = {
      publish: (subject: string, data: Uint8Array) => {
        if (subject !== METERING_SUBJECT) return;
        const env = JSON.parse(new TextDecoder().decode(data)) as { payload: { data: MeterEventBatch } };
        batches.push(env.payload.data);
      },
    };
    return { nc, batches };
  }

  async function loadModule() {
    dir ??= mkdtempSync(join(tmpdir(), "activity-evicted-"));
    vi.resetModules();
    vi.stubEnv("AUDIT_DB_PATH", join(dir, `audit-${uuid7()}.db`));
    vi.stubEnv("USAGE_DB_PATH", join(dir, `usage-${uuid7()}.db`));
    vi.stubEnv("ACTIVITY_MAX_ENTRIES", "2");
    return import("../../src/activity/activity-service.js");
  }

  function prime(svc: Svc): void {
    (svc as unknown as { meteringOn: boolean }).meteringOn = true;
    // An unsigned service identity: the capture reads the batch, not the seal.
    Object.defineProperty(svc, "kp", { value: SERVICE });
    closers.push(() => svc.audit.close());
    closers.push(() => svc.usage.close());
  }

  /** A tap with metering on, a ring of 2, and the given index store. */
  async function makeTap(index: KeyedStore = memoryStore()) {
    const mod = await loadModule();
    const { nc, batches } = capture();
    const svc = new mod.ActivityService(nc as never, {} as never, { put: async () => 1, purge: async () => {} } as never, index as never) as unknown as Svc;
    prime(svc);
    return { svc, batches, index };
  }

  const settle = async (svc: Svc) => {
    for (let i = 0; i < 5; i++) {
      await svc.index?.drain();
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  /** Push `req` out of the ring with two cheap requests from somebody else. */
  function flood(svc: Svc): void {
    svc.recordRequest(request(FLOODER), 10);
    svc.recordRequest(request(FLOODER), 10);
  }

  const answerSide = (batches: Array<{ events: MeterEvent[] }>, req: Envelope) =>
    batches.flatMap((b) => b.events).filter((e) => e.envelope_id !== req.id && e.consumer === CALLER);

  it("still emits responses and bytes_out, naming the request, after a flood evicts it", async () => {
    const { svc, batches } = await makeTap();
    const req = request();
    svc.recordRequest(req, 100);
    flood(svc);
    await settle(svc);
    expect(svc.entries.some((e) => e.requestId === req.id)).toBe(false); // evicted

    const ans = respond({ in_reply_to: req.id });
    svc.recordResponse(ans, 300);
    await settle(svc);

    const events = answerSide(batches, req);
    expect(events.map((e) => e.meter).sort()).toEqual(["bytes_out", "responses"]);
    for (const e of events) {
      expect(e).toMatchObject({
        provider: AGENT,
        consumer: CALLER,
        envelope_id: ans.id,
        request_id: req.id,
        offering: "summarize",
        class: "observed",
      });
    }
    expect(events.find((e) => e.meter === "bytes_out")!.quantity).toBe(300);
  });

  it("emits exactly what the ring path emits for the same answer", async () => {
    const run = async (evict: boolean) => {
      const { svc, batches } = await makeTap();
      const req = request();
      svc.recordRequest(req, 100);
      if (evict) flood(svc);
      const ans = respond({
        in_reply_to: req.id,
        payload: { status: "completed", output: { a: 1 }, usage: [{ meter: "tokens_out", quantity: 42 }] },
      });
      svc.recordResponse(ans, 300);
      await settle(svc);
      return answerSide(batches, req).map(({ ts: _ts, envelope_id: _e, request_id: _r, ...rest }) => rest);
    };
    const inRing = await run(false);
    const evicted = await run(true);
    expect(inRing.map((e) => e.meter).sort()).toEqual(["bytes_out", "responses", "tokens_out"]);
    expect(evicted).toEqual(inRing);
  });

  it("an error answer is a failed responses batch, and an admission refusal still records its refusal event", async () => {
    const { svc, batches } = await makeTap();
    const req = request();
    svc.recordRequest(req, 100);
    flood(svc);
    svc.recordResponse(
      respond({ in_reply_to: req.id, payload: { status: "failed" }, error: { code: "BUDGET_INSUFFICIENT", message: "over budget" } }),
      120,
    );
    await settle(svc);
    const failed = batches.find((b) => b.failed === true)!;
    expect(failed.events.map((e) => [e.meter, e.request_id])).toEqual([["responses", req.id], ["bytes_out", req.id]]);
    const refusal = batches.flatMap((b) => b.events).find((e) => e.refused === true)!;
    expect(refusal).toMatchObject({ refusal_code: "BUDGET_INSUFFICIENT", request_id: req.id, quantity: 0 });
  });

  it("an exchange answered in the ring and followed up after eviction counts responses once", async () => {
    const { svc, batches } = await makeTap();
    const req = request();
    svc.recordRequest(req, 100);
    svc.recordResponse(respond({ in_reply_to: req.id, payload: { status: "working" } }), 200);
    flood(svc);
    await settle(svc);
    svc.recordResponse(respond({ in_reply_to: req.id }), 300);
    await settle(svc);
    const events = answerSide(batches, req);
    expect(events.filter((e) => e.meter === "responses")).toHaveLength(1);
    expect(events.filter((e) => e.meter === "bytes_out").map((e) => e.quantity)).toEqual([200, 300]);
    for (const e of events) expect(e.request_id).toBe(req.id);
  });

  it("two answers to one evicted request, arriving together, count responses once", async () => {
    const { svc, batches } = await makeTap();
    const req = request();
    svc.recordRequest(req, 100);
    flood(svc);
    svc.recordResponse(respond({ in_reply_to: req.id, payload: { status: "working" } }), 200);
    svc.recordResponse(respond({ in_reply_to: req.id }), 300);
    await settle(svc);
    const events = answerSide(batches, req);
    expect(events.filter((e) => e.meter === "responses")).toHaveLength(1);
    expect(events.filter((e) => e.meter === "bytes_out")).toHaveLength(2);
  });

  it("one respond seen on the inbox and the outbox after eviction counts once", async () => {
    const { svc, batches } = await makeTap();
    const req = request();
    svc.recordRequest(req, 100);
    flood(svc);
    const ans = respond({ in_reply_to: req.id });
    svc.recordResponse(ans, 300);
    svc.recordResponse(ans, 300);
    await settle(svc);
    expect(answerSide(batches, req).map((e) => e.meter).sort()).toEqual(["bytes_out", "responses"]);
  });

  it("a respond from anyone but the agent asked is not counted, evicted or not", async () => {
    const { svc, batches } = await makeTap();
    const req = request();
    svc.recordRequest(req, 100);
    flood(svc);
    svc.recordResponse(respond({ from: OTHER, in_reply_to: req.id }), 300);
    await settle(svc);
    expect(answerSide(batches, req)).toEqual([]);
    // ...and the real answer still counts as the first.
    svc.recordResponse(respond({ in_reply_to: req.id }), 300);
    await settle(svc);
    expect(answerSide(batches, req).map((e) => e.meter).sort()).toEqual(["bytes_out", "responses"]);
  });

  it("a task-mode answer with only a task id is correlated through the requester's task alias", async () => {
    const { svc, batches } = await makeTap();
    const req = request(CALLER, { task_id: "task-77" });
    svc.recordRequest(req, 100);
    flood(svc);
    svc.recordResponse(respond({ task_id: "task-77" }), 300);
    await settle(svc);
    const events = answerSide(batches, req);
    expect(events.map((e) => e.meter).sort()).toEqual(["bytes_out", "responses"]);
    for (const e of events) expect(e).toMatchObject({ request_id: req.id, task_id: "task-77" });
  });

  it("does not depend on this process at all: a fresh instance with an empty ring meters the answer", async () => {
    const index = memoryStore();
    const first = await makeTap(index);
    const req = request();
    first.svc.recordRequest(req, 100);
    await settle(first.svc);

    const second = await makeTap(index);
    expect(second.svc.entries).toEqual([]);
    second.svc.recordResponse(respond({ in_reply_to: req.id }), 300);
    await settle(second.svc);
    expect(answerSide(second.batches, req).map((e) => e.meter).sort()).toEqual(["bytes_out", "responses"]);
  });

  it("the index holds no request content", async () => {
    const { svc, index } = await makeTap();
    const req = request();
    (req.payload as { input: unknown }).input = { secret: "private request text" };
    svc.recordRequest(req, 100);
    await settle(svc);
    const stored = (index as unknown as { data: Map<string, string> }).data.get(requestKey(req.id))!;
    expect(stored).not.toContain("private request text");
    expect(JSON.parse(stored)).toEqual({
      v: 1,
      requestId: req.id,
      from: CALLER,
      to: AGENT,
      offering: "summarize",
      recordedAt: expect.any(String),
    });
  });

  it("an unknown request is still nothing to meter", async () => {
    const { svc, batches } = await makeTap();
    svc.recordResponse(respond({ in_reply_to: uuid7() }), 300);
    await settle(svc);
    expect(batches).toEqual([]);
  });

  it("boot seeds the index from ring rows that predate it, before the trim drops them", async () => {
    const mod = await loadModule();
    // Three pre-index rows in the activity bucket; the ring keeps two.
    const ringRows = new Map<string, string>();
    const reqIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = uuid7();
      reqIds.push(id);
      const at = new Date(Date.now() - (3 - i) * 1000).toISOString();
      ringRows.set(`row-${i}`, JSON.stringify({
        id: `row-${i}`, ts: at, recordedAt: at, from: CALLER, to: AGENT, offering: "summarize",
        taskId: uuid7(), requestId: id, inputPreview: "", status: "completed",
      }));
    }
    const h = fakeJs();
    const bucket = {
      status: h.bucket("mesh_activity", () => [...ringRows.keys()]),
      keys: forbiddenKeys(),
      async get(key: string) {
        const body = ringRows.get(key);
        if (body === undefined) return null;
        return { key, operation: "PUT", revision: 1, length: body.length, value: new TextEncoder().encode(body), json: () => JSON.parse(body), string: () => body };
      },
      async put(key: string, v: Uint8Array) { ringRows.set(key, new TextDecoder().decode(v)); return 1; },
      async purge(key: string) { ringRows.delete(key); },
      async delete(key: string) { ringRows.delete(key); },
    };
    const index = memoryStore();
    // The index bucket as JetStream would hand it over; JetStreamKeyed wraps it.
    const rawIndex = {
      get: (k: string) => index.get(k),
      put: (k: string, v: Uint8Array) => index.put(k, v),
      create: (k: string, v: Uint8Array) => index.create(k, v),
    };
    const js = {
      views: { kv: async (name: string) => (name === "mesh_activity" ? bucket : rawIndex) },
      jetstreamManager: h.jetstreamManager,
    };
    const { nc, batches } = capture();
    const svc = (await mod.ActivityService.create(nc as never, js as never)) as unknown as Svc;
    prime(svc);
    await settle(svc);
    expect(svc.entries.map((e) => e.requestId)).toEqual([reqIds[2], reqIds[1]]);
    expect(ringRows.has("row-0")).toBe(false); // trimmed and purged

    const oldest = { id: reqIds[0] } as Envelope;
    svc.recordResponse(respond({ in_reply_to: oldest.id }), 300);
    await settle(svc);
    expect(answerSide(batches, oldest).map((e) => [e.meter, e.request_id]).sort()).toEqual([
      ["bytes_out", reqIds[0]],
      ["responses", reqIds[0]],
    ]);
  });
});
