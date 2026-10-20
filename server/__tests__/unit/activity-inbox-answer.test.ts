// An inbox-mode answer is metered as its exchange's response.
//
// An agent that answers later (a human-paced or mailbox agent, whose node
// queued the asking envelope) sends its answer as a fresh `request` whose
// `in_reply_to` names the original request (§6.4a, §13.5). The tap used to
// record that as an ordinary request: `requests`/`bytes_in` with the parties
// reversed (the original requester billed as the provider), the answer's
// `payload.usage` receipt dropped, and no request_id. These tests pin the fix:
// the answer meters as the ORIGINAL exchange's response (same provider and
// consumer as the request, `responses`/`bytes_out` on the first answer,
// request_id the original request, the receipt honoured) and no new request.
// Only the asked agent answering the original requester counts; anything else
// threading `in_reply_to` stays an ordinary request.
//
// The ring is set to 2 so that two later requests evict a request; the evicted
// cases go through the durable exchange index.
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

describe("an inbox-mode answer (a request carrying in_reply_to)", () => {
  /** Ask, optionally evict, then answer in inbox mode. */
  async function exchange(evict: boolean, payload?: Record<string, unknown>) {
    const index = memoryStore();
    const tap = await makeTap(index);
    const req = request();
    tap.svc.recordRequest(req, 100);
    if (evict) flood(tap.svc);
    await settle(tap.svc);
    expect(tap.svc.entries.some((e) => e.requestId === req.id)).toBe(!evict);
    const ans = answer(req.id, payload ? { payload } : {});
    tap.svc.recordRequestOrAnswer(ans, 300);
    await settle(tap.svc);
    return { ...tap, index, req, ans };
  }

  for (const evict of [false, true]) {
    const where = evict ? "after its request left the ring" : "with its request in the ring";

    it(`meters as the original exchange's response, ${where}`, async () => {
      const { svc, events, req, ans } = await exchange(evict);
      const mine = of(events, ans.id);
      expect(meters(mine)).toEqual(["bytes_out", "responses"]);
      for (const e of mine) {
        // The asked agent provided, the original requester consumed: the
        // request's own parties, never the answer's from/to.
        expect(e).toMatchObject({
          provider: AGENT,
          consumer: CALLER,
          request_id: req.id,
          offering: "summarize",
          class: "observed",
        });
      }
      expect(mine.find((e) => e.meter === "bytes_out")!.quantity).toBe(300);
      // No new request: nothing billed with the parties reversed, and no ring row.
      expect(events.some((e) => e.provider === CALLER)).toBe(false);
      expect(svc.entries.some((e) => e.requestId === ans.id)).toBe(false);
    });

    it(`honours the answer's payload.usage receipt, ${where}`, async () => {
      const { events, req, ans } = await exchange(evict, {
        offering: "message",
        input: { text: "done" },
        usage: [{ meter: "tokens_out", quantity: 42 }],
      });
      const declared = of(events, ans.id).filter((e) => e.class === "declared");
      expect(declared).toHaveLength(1);
      expect(declared[0]).toMatchObject({
        meter: "tokens_out",
        quantity: 42,
        provider: AGENT,
        consumer: CALLER,
        request_id: req.id,
      });
    });

    it(`a second answer counts bytes only, and one answer seen twice counts once, ${where}`, async () => {
      const { svc, events, req, ans } = await exchange(evict);
      svc.recordRequestOrAnswer(ans, 300); // the same envelope on a second subject
      const second = answer(req.id);
      svc.recordRequestOrAnswer(second, 50);
      await settle(svc);
      expect(events.filter((e) => e.request_id === req.id && e.meter === "responses")).toHaveLength(1);
      expect(meters(of(events, ans.id))).toEqual(["bytes_out", "responses"]);
      expect(of(events, second.id)).toEqual([
        expect.objectContaining({ meter: "bytes_out", quantity: 50, provider: AGENT, consumer: CALLER, request_id: req.id }),
      ]);
    });

    it(`a forged in_reply_to is an ordinary request, ${where}`, async () => {
      const index = memoryStore();
      const { svc, events } = await makeTap(index);
      const req = request();
      svc.recordRequest(req, 100);
      if (evict) flood(svc);
      await settle(svc);
      const forged = [
        // A stranger threads the id at the requester, to bill the exchange.
        answer(req.id, { from: STRANGER }),
        // The requester threads its own request back at the agent.
        answer(req.id, { from: CALLER, to: AGENT }),
        // The asked agent, but to somebody else.
        answer(req.id, { to: STRANGER }),
        // An id nobody asked.
        answer(uuid7()),
        // A message for the requester's person (§5.7 rule 1: answers no wait).
        answer(req.id, { meta: { audience: "person" } }),
      ];
      for (const f of forged) svc.recordRequestOrAnswer(f, 70);
      await settle(svc);
      for (const f of forged) {
        const mine = of(events, f.id);
        expect(meters(mine)).toEqual(["bytes_in", "requests"]);
        for (const e of mine) {
          expect(e).toMatchObject({ provider: f.to, consumer: f.from });
          expect(e.request_id).toBeUndefined();
        }
      }
      // The real exchange was not touched, in the ring or in the index.
      expect(events.some((e) => e.request_id === req.id)).toBe(false);
      expect(JSON.parse(index.data.get(requestKey(req.id))!).respondedAt).toBeUndefined();
      // And the real answer still counts as the first.
      const real = answer(req.id);
      svc.recordRequestOrAnswer(real, 300);
      await settle(svc);
      expect(meters(of(events, real.id))).toEqual(["bytes_out", "responses"]);
    });
  }

  it("a request with no in_reply_to is still an ordinary request", async () => {
    const { svc, events } = await makeTap();
    const req = request();
    svc.recordRequestOrAnswer(req, 100);
    await settle(svc);
    expect(meters(of(events, req.id))).toEqual(["bytes_in", "requests"]);
    expect(svc.entries.some((e) => e.requestId === req.id)).toBe(true);
  });

  it("without an exchange index, an evicted exchange's answer stays an ordinary request", async () => {
    const { svc, events } = await makeTap(null);
    const req = request();
    svc.recordRequest(req, 100);
    flood(svc);
    const ans = answer(req.id);
    svc.recordRequestOrAnswer(ans, 300);
    await settle(svc);
    expect(meters(of(events, ans.id))).toEqual(["bytes_in", "requests"]);
  });
});

describe("the evicted path correlates as the ring does", () => {
  async function evicted(taskId: string) {
    const tap = await makeTap();
    const req = request(CALLER, AGENT, { task_id: taskId });
    tap.svc.recordRequest(req, 100);
    flood(tap.svc);
    await settle(tap.svc);
    return { ...tap, req };
  }

  it("a respond whose in_reply_to names nothing known falls back to its task id", async () => {
    const { svc, events, req } = await evicted("task-9");
    const ans = respond({ in_reply_to: uuid7(), task_id: "task-9" });
    svc.recordResponse(ans, 300);
    await settle(svc);
    const mine = of(events, ans.id);
    expect(meters(mine)).toEqual(["bytes_out", "responses"]);
    for (const e of mine) expect(e).toMatchObject({ provider: AGENT, consumer: CALLER, request_id: req.id });
  });

  it("the task-id fallback still requires the answering agent to be the one asked", async () => {
    const { svc, events } = await evicted("task-9");
    const forged = respond({ from: STRANGER, in_reply_to: uuid7(), task_id: "task-9" });
    svc.recordResponse(forged, 300);
    await settle(svc);
    expect(of(events, forged.id)).toEqual([]);
    // The real answer, by task id alone, is still the exchange's first.
    const real = respond({ task_id: "task-9" });
    svc.recordResponse(real, 300);
    await settle(svc);
    expect(meters(of(events, real.id))).toEqual(["bytes_out", "responses"]);
  });
});

describe("a respond's receipt", () => {
  it("is never read in the inbox-answer direction: a non-terminal respond carries none", async () => {
    const { svc, events } = await makeTap();
    const req = request();
    svc.recordRequest(req, 100);
    const working = {
      ...respond({ in_reply_to: req.id }),
      payload: { status: "working", usage: [{ meter: "tokens_out", quantity: 9 }] },
    } as unknown as Envelope;
    svc.recordResponse(working, 80);
    await settle(svc);
    expect(of(events, working.id).filter((e) => e.class === "declared")).toEqual([]);
    expect(events.some((e) => e.provider === CALLER)).toBe(false);
  });
});

describe("stop()", () => {
  it("waits for queued exchange-index writes", async () => {
    const store = memoryStore();
    const put = store.put.bind(store);
    store.put = async (key, value) => {
      await new Promise((r) => setTimeout(r, 50));
      return put(key, value);
    };
    // stop() closes the audit log and the usage store itself.
    const { svc } = await makeTap(store, { own: false });
    const req = request();
    svc.recordRequest(req, 100);
    expect(store.data.has(requestKey(req.id))).toBe(false);
    await svc.stop();
    expect(store.data.has(requestKey(req.id))).toBe(true);
  });
});
