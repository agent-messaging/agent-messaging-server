// One usage receipt per request (§13.5).
//
// Each answer is its own envelope, and the metering fold dedupes declared
// events by (meter, envelope_id), so before this a provider could declare
// usage again with every extra answer it sent to one request: a second
// `completed` respond, or a second inbox-mode answer. Now the FIRST answer to
// a request that carries a valid receipt has it honoured, and every later
// receipt on that request is dropped; bytes still meter on every answer. "First
// receipt" rather than "first answer": a task-mode agent sends `working` with
// no receipt, then its terminal respond with one, and that receipt counts.
//
// The rule holds in the ring, after eviction (the exchange index's
// `receiptAt`, written serially like `respondedAt`), across the two, and
// across a restart. An index record written before `receiptAt` existed reads
// as no receipt yet.
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


// Each test re-imports the service and opens SQLite files, a few seconds under
// a full parallel suite; the default 20s left no headroom there.
vi.setConfig({ testTimeout: 60_000 });

const AGENT = "UAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CALLER = "UCALLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FLOODER = "UFLOODERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const STRANGER = "USTRANGERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SERVICE = "USERVICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

type MemoryStore = KeyedStore & { data: Map<string, string> };

/** A keyed store in memory. */
function memoryStore(): MemoryStore {
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
  } as MemoryStore;
}

interface Svc {
  entries: Array<{ requestId?: string }>;
  index: { drain(): Promise<void> } | null;
  recordRequest(env: Envelope, bytes?: number): void;
  recordRequestOrAnswer(env: Envelope, bytes?: number): void;
  recordResponse(env: Envelope, bytes?: number): void;
  stop(): Promise<void>;
  audit: { close(): void };
  usage: { close(): Promise<void> };
}

function request(from = CALLER, to = AGENT, over: Partial<{ task_id: string }> = {}): Envelope {
  return {
    v: "0.1",
    id: uuid7(),
    type: "request",
    from,
    to,
    ts: new Date().toISOString(),
    ...(over.task_id ? { task_id: over.task_id } : {}),
    payload: { offering: "summarize", input: { q: 1 } },
  } as unknown as Envelope;
}

/** The inbox-mode answer: a fresh request from the asked agent, threading the original. */
function answer(
  inReplyTo: string,
  over: Partial<{ from: string; to: string; payload: Record<string, unknown>; meta: Record<string, unknown> }> = {},
): Envelope {
  return {
    v: "0.1",
    id: uuid7(),
    type: "request",
    from: over.from ?? AGENT,
    to: over.to ?? CALLER,
    in_reply_to: inReplyTo,
    ts: new Date().toISOString(),
    ...(over.meta ? { meta: over.meta } : {}),
    payload: over.payload ?? { offering: "message", input: { text: "here is your summary" } },
  } as unknown as Envelope;
}

function respond(over: Partial<{ from: string; in_reply_to: string; task_id: string }>): Envelope {
  return {
    v: "0.1",
    id: uuid7(),
    type: "respond",
    from: over.from ?? AGENT,
    to: CALLER,
    ...(over.in_reply_to ? { in_reply_to: over.in_reply_to } : {}),
    ...(over.task_id ? { task_id: over.task_id } : {}),
    ts: new Date().toISOString(),
    payload: { status: "completed", output: { a: 1 } },
  } as unknown as Envelope;
}

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

/** A tap with metering on and a ring of 2; `index` null means no exchange index. */
async function makeTap(index: KeyedStore | null = memoryStore(), opts: { own?: boolean } = {}) {
  dir ??= mkdtempSync(join(tmpdir(), "activity-inbox-answer-"));
  vi.resetModules();
  vi.stubEnv("AUDIT_DB_PATH", join(dir, `audit-${uuid7()}.db`));
  vi.stubEnv("USAGE_DB_PATH", join(dir, `usage-${uuid7()}.db`));
  vi.stubEnv("ACTIVITY_MAX_ENTRIES", "2");
  const mod = await import("../../src/activity/activity-service.js");
  const events: MeterEvent[] = [];
  const nc = {
    publish: (subject: string, data: Uint8Array) => {
      if (subject !== METERING_SUBJECT) return;
      const env = JSON.parse(new TextDecoder().decode(data)) as { payload: { data: MeterEventBatch } };
      events.push(...env.payload.data.events);
    },
  };
  const kv = { put: async () => 1, purge: async () => {} };
  const svc = (
    index
      ? new mod.ActivityService(nc as never, {} as never, kv as never, index as never)
      : new mod.ActivityService(nc as never, {} as never, kv as never)
  ) as unknown as Svc;
  (svc as unknown as { meteringOn: boolean }).meteringOn = true;
  // An unsigned service identity: the capture reads the batch, not the seal.
  Object.defineProperty(svc, "kp", { value: SERVICE });
  if (opts.own !== false) {
    closers.push(() => svc.audit.close());
    closers.push(() => svc.usage.close());
  }
  return { svc, events };
}

const settle = async (svc: Svc) => {
  for (let i = 0; i < 5; i++) {
    await svc.index?.drain();
    await new Promise((r) => setTimeout(r, 0));
  }
};

/** Push earlier requests out of the ring with two cheap requests from somebody else. */
function flood(svc: Svc): void {
  svc.recordRequest(request(FLOODER), 10);
  svc.recordRequest(request(FLOODER), 10);
}

const of = (events: MeterEvent[], envelopeId: string) => events.filter((e) => e.envelope_id === envelopeId);
const meters = (events: MeterEvent[]) => events.map((e) => e.meter).sort();


const usage = (q: number) => [{ meter: "tokens_out", quantity: q }];

function completed(reqId: string, q: number): Envelope {
  return {
    ...respond({ in_reply_to: reqId }),
    payload: { status: "completed", output: { a: 1 }, usage: usage(q) },
  } as unknown as Envelope;
}

function working(reqId: string): Envelope {
  return { ...respond({ in_reply_to: reqId }), payload: { status: "working" } } as unknown as Envelope;
}

function inboxAnswer(reqId: string, q: number): Envelope {
  return answer(reqId, { payload: { offering: "message", input: { text: "done" }, usage: usage(q) } });
}

const declared = (events: MeterEvent[]) => events.filter((e) => e.class === "declared");

/** The recorder an answer goes through: respond or inbox answer. */
function send(svc: Svc, env: Envelope, bytes: number): void {
  if (env.type === "request") svc.recordRequestOrAnswer(env, bytes);
  else svc.recordResponse(env, bytes);
}

describe("one usage receipt per request", () => {
  for (const evict of [false, true]) {
    const where = evict ? "after the request left the ring" : "with the request in the ring";

    async function run(answers: (reqId: string) => Envelope[]) {
      const index = memoryStore();
      const { svc, events } = await makeTap(index);
      const req = request();
      svc.recordRequest(req, 100);
      if (evict) flood(svc);
      await settle(svc);
      expect(svc.entries.some((e) => e.requestId === req.id)).toBe(!evict);
      const sent = answers(req.id);
      for (const a of sent) {
        send(svc, a, 40);
        await settle(svc);
      }
      return { svc, events, req, sent, index };
    }

    it(`two completed responds with usage declare once, ${where}`, async () => {
      const { events, req, sent } = await run((id) => [completed(id, 5), completed(id, 7)]);
      const d = declared(events);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ envelope_id: sent[0].id, quantity: 5, provider: AGENT, consumer: CALLER, request_id: req.id });
      // The second still meters its bytes.
      expect(of(events, sent[1].id).map((e) => e.meter)).toEqual(["bytes_out"]);
    });

    it(`a working respond, then a completed one with the receipt, declares once (task mode), ${where}`, async () => {
      const { events, sent } = await run((id) => [working(id), completed(id, 9), completed(id, 9)]);
      const d = declared(events);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ envelope_id: sent[1].id, quantity: 9 });
      expect(events.filter((e) => e.meter === "responses")).toHaveLength(1);
    });

    it(`two inbox answers with usage declare once, ${where}`, async () => {
      const { events, req, sent } = await run((id) => [inboxAnswer(id, 3), inboxAnswer(id, 4)]);
      const d = declared(events);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ envelope_id: sent[0].id, quantity: 3, provider: AGENT, consumer: CALLER, request_id: req.id });
      expect(of(events, sent[1].id).map((e) => e.meter)).toEqual(["bytes_out"]);
    });

    it(`a respond's receipt and an inbox answer's share the one per request, ${where}`, async () => {
      const { events, sent } = await run((id) => [completed(id, 2), inboxAnswer(id, 6)]);
      expect(declared(events).map((e) => e.envelope_id)).toEqual([sent[0].id]);
    });

    it(`a receipt with no valid entries does not use up the request's one, ${where}`, async () => {
      const bad = (id: string) =>
        ({ ...respond({ in_reply_to: id }), payload: { status: "working", usage: [{ meter: "", quantity: -1 }] } }) as unknown as Envelope;
      const badTerminal = (id: string) =>
        ({ ...respond({ in_reply_to: id }), payload: { status: "completed", usage: [{ meter: "", quantity: -1 }] } }) as unknown as Envelope;
      const { events, sent } = await run((id) => [bad(id), badTerminal(id), completed(id, 8)]);
      expect(declared(events).map((e) => e.envelope_id)).toEqual([sent[2].id]);
    });
  }

  it("a receipt honoured in the ring is remembered after the request leaves it", async () => {
    const index = memoryStore();
    const { svc, events } = await makeTap(index);
    const req = request();
    svc.recordRequest(req, 100);
    svc.recordResponse(working(req.id), 10); // first answer, no receipt
    svc.recordResponse(completed(req.id, 5), 10); // the receipt, on a later answer
    flood(svc);
    await settle(svc);
    expect(JSON.parse(index.data.get(requestKey(req.id))!).receiptAt).toEqual(expect.any(String));
    svc.recordResponse(completed(req.id, 5), 10);
    await settle(svc);
    expect(declared(events)).toHaveLength(1);
  });

  it("survives a restart: a fresh instance on the same index drops a second receipt", async () => {
    const index = memoryStore();
    const first = await makeTap(index);
    const req = request();
    first.svc.recordRequest(req, 100);
    flood(first.svc);
    await settle(first.svc);
    first.svc.recordResponse(completed(req.id, 5), 10);
    await settle(first.svc);
    expect(declared(first.events)).toHaveLength(1);

    const second = await makeTap(index); // empty ring, same durable index
    second.svc.recordRequestOrAnswer(inboxAnswer(req.id, 5), 10);
    second.svc.recordResponse(completed(req.id, 5), 10);
    await settle(second.svc);
    expect(declared(second.events)).toEqual([]);
    expect(second.events.filter((e) => e.meter === "bytes_out")).toHaveLength(2);
  });

  it("an index record written before receiptAt existed reads as no receipt yet", async () => {
    const index = memoryStore();
    const { svc, events } = await makeTap(index);
    const req = request();
    // An answered exchange, recorded by a build that had no receiptAt.
    index.data.set(
      requestKey(req.id),
      JSON.stringify({
        v: 1, requestId: req.id, from: CALLER, to: AGENT, offering: "summarize",
        recordedAt: new Date().toISOString(), respondedAt: new Date().toISOString(),
      }),
    );
    const ans = completed(req.id, 5);
    svc.recordResponse(ans, 10);
    await settle(svc);
    expect(declared(events).map((e) => e.envelope_id)).toEqual([ans.id]);
    const rec = JSON.parse(index.data.get(requestKey(req.id))!);
    expect(rec.receiptAt).toEqual(expect.any(String));
    svc.recordResponse(completed(req.id, 5), 10);
    await settle(svc);
    expect(declared(events)).toHaveLength(1);
  });
});
