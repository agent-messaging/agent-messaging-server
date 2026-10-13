// Retention on the activity ring — safety register 5.8 / 6.3.
//
// An activity entry carries `inputPreview`, the first 200 characters of a real
// request's input. Until now the only bound on that was a 500-entry ring with no
// expiry of any kind, which on a quiet mesh is a rolling window of what people
// asked each other's agents held indefinitely. These tests pin the fix: a count
// bound AND a time bound, both enforced, whichever binds first; removal that
// actually removes (purge, not soft-delete, so no prior revision survives on the
// backing stream); and a service boot that is not itself a deletion event.
import { describe, it, expect, afterEach, vi } from "vitest";
import { fakeJs, forbiddenKeys } from "../helpers/fake-kv.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvelope } from "../../src/sdk.js";
import type { Envelope } from "../../src/sdk.js";
import type { ActivityEntry, ActivityService } from "../../src/activity/activity-service.js";

const READER = "UREADERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const AGENT = "UAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CALLER = "UCALLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-01T00:00:00.000Z");

// ── Mock KV, modelling the one detail that matters ─────────────────
//
// `delete` is a SOFT delete: the current value stops being readable, but the
// revision stays on the backing stream where `kv.history()` still yields it.
// `purge` is a rollup that drops the revisions too. A test asserting "removed"
// has to be able to tell those apart, so the mock keeps both.

function createMockKv(opts: { failPurge?: boolean } = {}) {
  const store = new Map<string, string>();
  const history = new Map<string, string[]>();
  const calls = { purge: 0, delete: 0 };
  return {
    store,
    history,
    calls,
    seed(entry: ActivityEntry): void {
      const body = JSON.stringify(entry);
      store.set(entry.id, body);
      history.set(entry.id, [...(history.get(entry.id) ?? []), body]);
    },
    async put(key: string, data: Uint8Array): Promise<number> {
      const body = new TextDecoder().decode(data);
      store.set(key, body);
      const revs = [...(history.get(key) ?? []), body];
      history.set(key, revs);
      return revs.length;
    },
    async get(key: string) {
      const body = store.get(key);
      if (body === undefined) return null;
      return {
        key,
        operation: "PUT" as const,
        revision: (history.get(key) ?? []).length,
        length: body.length,
        value: new TextEncoder().encode(body),
        json: <T>(): T => JSON.parse(body) as T,
        string: () => body,
      };
    },
    // Nothing may enumerate through `keys()` any more — it loses keys, and the
    // sweep below is the only thing that ever removes a stored request preview.
    keys: forbiddenKeys(),
    async delete(key: string): Promise<void> {
      calls.delete++;
      store.delete(key); // revisions in `history` deliberately survive
    },
    async purge(key: string): Promise<void> {
      calls.purge++;
      if (opts.failPurge) throw new Error("stream does not allow rollup headers");
      store.delete(key);
      history.delete(key);
    },
  };
}

type MockKv = ReturnType<typeof createMockKv>;

function createMockNc() {
  const sub = {
    unsubscribe() {},
    async *[Symbol.asyncIterator]() { /* no traffic */ },
  };
  return {
    subscribe: () => sub,
    request: async () => {
      throw new Error("no registry in this test");
    },
  };
}

/** Private surface these tests reach into: the tap and the read path. */
type Internals = {
  entries: ActivityEntry[];
  recordRequest(env: Envelope, bytes?: number): void;
  handleList(env: Envelope): Promise<Envelope>;
};

function entry(id: string, ageDays: number): ActivityEntry {
  return {
    id,
    ts: new Date(NOW - ageDays * DAY).toISOString(),
    from: CALLER,
    to: AGENT,
    offering: "summarize",
    taskId: `task-${id}`,
    requestId: `req-${id}`,
    inputPreview: `{"text":"private content ${id}"}`,
    status: "completed",
  };
}

describe("activity ring retention", () => {
  let dir: string;
  const live: ActivityService[] = [];

  /** Import the module with these env vars in force — the bounds are read at
   *  module load, exactly as they are in production. */
  async function load(
    env: Record<string, string>,
    kv: MockKv,
    h: ReturnType<typeof fakeJs> = fakeJs(),
  ): Promise<ActivityService> {
    dir ??= mkdtempSync(join(tmpdir(), "activity-"));
    vi.resetModules();
    vi.stubEnv("USAGE_DB_PATH", join(dir, "usage.db"));
    vi.stubEnv("ACTIVITY_READER_KEYS", READER);
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const mod = await import("../../src/activity/activity-service.js");
    // The load and the retention sweep both enumerate the bucket off its backing
    // stream's subject list, so the fake needs `status()` and a manager. The key
    // list is read at call time, so the sweep sees the bucket as it is then.
    const bucket = Object.assign(kv, { status: h.bucket("mesh_activity", () => [...kv.store.keys()]) });
    const js = { views: { kv: async () => bucket }, jetstreamManager: h.jetstreamManager };
    const svc = await mod.ActivityService.create(createMockNc() as never, js as never);
    live.push(svc);
    return svc;
  }

  /** Let the fire-and-forget kv.put / forget promises settle. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  afterEach(async () => {
    for (const svc of live.splice(0)) {
      try { await svc.stop(); } catch { /* already stopped */ }
    }
    vi.unstubAllEnvs();
    vi.useRealTimers();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined as unknown as string;
  });

  it("still enforces the count bound on insert, and purges what it evicts", async () => {
    const kv = createMockKv();
    const svc = await load({ ACTIVITY_MAX_ENTRIES: "3" }, kv);
    const inner = svc as unknown as Internals;

    for (let i = 0; i < 6; i++) {
      inner.recordRequest(
        createEnvelope({ type: "request", from: CALLER, to: AGENT, payload: { offering: "s", input: `q${i}` } }),
      );
    }
    await settle();

    expect(inner.entries).toHaveLength(3);
    expect(kv.store.size).toBe(3);
    expect(kv.calls.purge).toBe(3);   // the three evicted rows
    expect(kv.calls.delete).toBe(0);  // never the soft path
  });

  it("does not delete anything by age while loading — a boot is not a deletion", async () => {
    const kv = createMockKv();
    for (const [id, age] of [["old-1", 400], ["old-2", 90], ["new-1", 1]] as const) {
      kv.seed(entry(id, age));
    }

    const svc = await load({ ACTIVITY_MAX_AGE_MS: String(30 * DAY) }, kv);

    // Everything the bucket held is still there, and still served.
    expect(kv.store.size).toBe(3);
    expect(kv.calls.purge).toBe(0);
    expect(kv.calls.delete).toBe(0);
    expect((svc as unknown as Internals).entries).toHaveLength(3);
  });

  it("removes rows past the age bound rather than hiding them", async () => {
    const kv = createMockKv();
    kv.seed(entry("old", 40));
    kv.seed(entry("fresh", 2));

    const svc = await load({ ACTIVITY_MAX_AGE_MS: String(30 * DAY) }, kv);
    const result = await svc.sweepExpired(NOW);

    expect(result).toEqual({ dropped: 1, purged: 1 });
    // Gone from the read path...
    expect((svc as unknown as Internals).entries.map((e) => e.id)).toEqual(["fresh"]);
    // ...gone from the bucket...
    expect([...kv.store.keys()]).toEqual(["fresh"]);
    // ...and gone from the revision history, i.e. purged, not soft-deleted.
    expect(kv.history.has("old")).toBe(false);
    expect(kv.calls.delete).toBe(0);

    // The proof that it is removal and not concealment: a fresh service loading
    // the same bucket cannot see it either.
    const reloaded = await load({ ACTIVITY_MAX_AGE_MS: String(30 * DAY) }, kv);
    expect((reloaded as unknown as Internals).entries.map((e) => e.id)).toEqual(["fresh"]);
  });

  it("says the bucket scan failed instead of reporting a sweep that purged nothing", async () => {
    // The sweep is the ONLY thing that ever removes a stored `inputPreview`, so a
    // scan that comes back short (which is what `kv.keys()` did) silently leaves
    // expired request content in the bucket while reporting a successful pass.
    // `listKvKeys` raises instead, and this pins that the raise is SAID: purged
    // stays 0, the row stays, and the log names what is still there.
    const kv = createMockKv();
    kv.seed(entry("old", 40));
    const h = fakeJs();
    const svc = await load({ ACTIVITY_MAX_AGE_MS: String(30 * DAY) }, kv, h);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.info.mockRejectedValueOnce(new Error("no responders for $JS.API.STREAM.INFO"));

    const result = await svc.sweepExpired(NOW);

    expect(result).toEqual({ dropped: 1, purged: 0 }); // dropped from memory, NOT purged
    expect(kv.store.has("old")).toBe(true);
    expect(err.mock.calls.flat().join(" ")).toMatch(/STILL in mesh_activity/);
    err.mockRestore();
  });

  it("purges a stale key even when its in-memory row is already gone", async () => {
    // The case a walk of `this.entries` would miss: a key the read path has no
    // row for, so nothing would ever come back for it. Content outliving the
    // read path is the whole failure this bound closes.
    const kv = createMockKv();
    kv.seed(entry("orphan", 60));

    const svc = await load({ ACTIVITY_MAX_AGE_MS: String(30 * DAY) }, kv);
    (svc as unknown as Internals).entries.length = 0; // simulate a lost row

    const result = await svc.sweepExpired(NOW);
    expect(result.purged).toBe(1);
    expect(kv.store.size).toBe(0);
    expect(kv.history.size).toBe(0);
  });

  it("composes the two bounds — whichever binds first", async () => {
    const kv = createMockKv();
    // 8 rows: 3 fresh, 5 stale. The count bound keeps the 5 newest; the age
    // bound then takes the 2 stale ones among those.
    for (const age of [1, 2, 3, 35, 36, 37, 38, 39]) kv.seed(entry(`e${age}`, age));

    const svc = await load(
      { ACTIVITY_MAX_ENTRIES: "5", ACTIVITY_MAX_AGE_MS: String(30 * DAY) },
      kv,
    );
    const inner = svc as unknown as Internals;

    await settle();
    expect(inner.entries).toHaveLength(5);          // count bound bound first
    expect(kv.store.size).toBe(5);

    await svc.sweepExpired(NOW);
    expect(inner.entries.map((e) => e.id)).toEqual(["e1", "e2", "e3"]); // then age
    expect([...kv.store.keys()].sort()).toEqual(["e1", "e2", "e3"]);
  });

  it("treats a row with an undatable timestamp as expired", async () => {
    const kv = createMockKv();
    const broken = { ...entry("broken", 1), ts: "not a date" };
    kv.seed(broken);
    kv.seed(entry("fine", 1));

    const svc = await load({ ACTIVITY_MAX_AGE_MS: String(30 * DAY) }, kv);
    await svc.sweepExpired(NOW);

    // A row that cannot be dated cannot be aged out later either, which is the
    // indefinite retention this bound exists to end.
    expect([...kv.store.keys()]).toEqual(["fine"]);
  });

  it("keeps everything when ACTIVITY_MAX_AGE_MS is 0, count bound aside", async () => {
    const kv = createMockKv();
    kv.seed(entry("ancient", 900));
    kv.seed(entry("fresh", 1));

    const svc = await load({ ACTIVITY_MAX_AGE_MS: "0" }, kv);
    expect(await svc.sweepExpired(NOW)).toEqual({ dropped: 0, purged: 0 });
    expect(kv.store.size).toBe(2);
  });

  it("ignores a bound that is not a number instead of reading it as 'forever'", async () => {
    const kv = createMockKv();
    kv.seed(entry("ancient", 900));
    kv.seed(entry("fresh", 1));

    // "30d" is NaN, which in `now - ts > NaN` would be false for every row.
    const svc = await load({ ACTIVITY_MAX_AGE_MS: "30d" }, kv);
    await svc.sweepExpired(NOW);
    expect([...kv.store.keys()]).toEqual(["fresh"]); // fell back to the 30d default
  });

  it("falls back to a soft delete when the bucket will not accept a purge", async () => {
    const kv = createMockKv({ failPurge: true });
    kv.seed(entry("old", 40));

    const svc = await load({ ACTIVITY_MAX_AGE_MS: String(30 * DAY) }, kv);
    const result = await svc.sweepExpired(NOW);

    // Still removed from the read path and from the bucket — a weaker guarantee
    // than purge (the revision survives), but better than leaving the row.
    expect(result.purged).toBe(1);
    expect(kv.calls.purge).toBe(1);
    expect(kv.calls.delete).toBe(1);
    expect(kv.store.size).toBe(0);
    expect(kv.history.has("old")).toBe(true); // the residue purge would have taken
  });

  it("stops serving expired previews on the read path", async () => {
    const kv = createMockKv();
    kv.seed(entry("old", 40));
    kv.seed(entry("fresh", 1));

    const svc = await load({ ACTIVITY_MAX_AGE_MS: String(30 * DAY) }, kv);
    const inner = svc as unknown as Internals;
    const ask = () =>
      inner.handleList(createEnvelope({ type: "request", from: READER, payload: {} }));

    const before = await ask();
    expect((before.payload as { entries: ActivityEntry[] }).entries).toHaveLength(2);

    await svc.sweepExpired(NOW);

    const after = await ask();
    const entries = (after.payload as { entries: ActivityEntry[] }).entries;
    expect(entries.map((e) => e.id)).toEqual(["fresh"]);
    expect(JSON.stringify(entries)).not.toContain("private content old");
  });

  it("a postdated envelope cannot postpone its own row's expiry", async () => {
    // `ts` is the sender's claim — recordRequest copies env.ts and nothing
    // verifies it. When the age bound read that field, a requester could stamp
    // its envelope a year out and the row holding the first 200 characters of its
    // own request would sit in the bucket until the year was up. The bound now
    // reads `recordedAt`, which the service stamps from its own clock.
    const kv = createMockKv();
    const svc = await load({ ACTIVITY_MAX_AGE_MS: String(30 * DAY) }, kv);
    const inner = svc as unknown as Internals;

    const postdated = createEnvelope({
      type: "request",
      from: CALLER,
      to: AGENT,
      payload: { offering: "s", input: "private content postdated" },
    });
    const claim = new Date(Date.now() + 365 * DAY).toISOString();
    (postdated as { ts: string }).ts = claim;
    inner.recordRequest(postdated);
    await settle();

    const [row] = inner.entries;
    // The claim is kept on the record — it is what the envelope said...
    expect(row.ts).toBe(claim);
    // ...but the row is dated by us, now, not by the sender's year from now.
    expect(row.recordedAt).toBeDefined();
    expect(Date.parse(row.recordedAt!)).toBeLessThanOrEqual(Date.now());

    // A moment past the bound measured from the recording. Under the old rule
    // this row survived — its `ts` is 335 days the far side of this cutoff.
    const result = await svc.sweepExpired(Date.now() + 30 * DAY + 1000);

    expect(result).toEqual({ dropped: 1, purged: 1 });
    expect(inner.entries).toHaveLength(0);
    expect(kv.store.size).toBe(0);
    expect(kv.history.size).toBe(0);
    expect(JSON.stringify([...kv.history.values()])).not.toContain("private content postdated");
  });

  it("does not expire a row the sender backdated before it is due either", async () => {
    // The mirror image, and the reason this is a correctness fix and not just a
    // hardening one: `ts` in the past would have thrown away a row we recorded
    // seconds ago. Retention has to mean 30 days of OUR time in both directions.
    const kv = createMockKv();
    const svc = await load({ ACTIVITY_MAX_AGE_MS: String(30 * DAY) }, kv);
    const inner = svc as unknown as Internals;

    const backdated = createEnvelope({
      type: "request",
      from: CALLER,
      to: AGENT,
      payload: { offering: "s", input: "just arrived" },
    });
    (backdated as { ts: string }).ts = new Date(Date.now() - 900 * DAY).toISOString();
    inner.recordRequest(backdated);
    await settle();

    expect(await svc.sweepExpired(Date.now())).toEqual({ dropped: 0, purged: 0 });
    expect(inner.entries).toHaveLength(1);
    expect(kv.store.size).toBe(1);
  });

  it("ages a pre-recordedAt row by its ts, rather than treating it as expired", async () => {
    // Rows already in the bucket have no `recordedAt`. They fall back to `ts`,
    // which preserves exactly the behaviour they had before this field existed —
    // the alternative, counting them expired, would make deploying this fix a
    // mass deletion, and this service's rule is that coming up is not a deletion
    // event.
    const kv = createMockKv();
    const old = entry("legacy-old", 40);
    const fresh = entry("legacy-fresh", 2);
    expect(old.recordedAt).toBeUndefined();
    expect(fresh.recordedAt).toBeUndefined();
    kv.seed(old);
    kv.seed(fresh);

    const svc = await load({ ACTIVITY_MAX_AGE_MS: String(30 * DAY) }, kv);
    await svc.sweepExpired(NOW);

    // The 40-day-old one goes on its `ts`; the 2-day-old one is kept, not
    // destroyed for lacking the new field.
    expect([...kv.store.keys()]).toEqual(["legacy-fresh"]);
  });

  it("orders the ring by recorded-at, so a postdated row cannot evict genuine ones", async () => {
    // The count bound trims the tail of the load-time sort. Sorting on `ts` let a
    // postdated envelope pin itself to the front and push real rows out of a full
    // ring — the same unverified field, the same fix.
    const kv = createMockKv();
    const future = {
      ...entry("postdated", 0),
      ts: new Date(NOW + 365 * DAY).toISOString(),
      recordedAt: new Date(NOW - 100 * DAY).toISOString(),
    };
    kv.seed(future);
    for (const age of [1, 2]) {
      kv.seed({ ...entry(`real-${age}`, age), recordedAt: new Date(NOW - age * DAY).toISOString() });
    }

    const svc = await load({ ACTIVITY_MAX_ENTRIES: "2", ACTIVITY_MAX_AGE_MS: "0" }, kv);
    await settle();

    // Sorted by recordedAt, the postdated row is the OLDEST and is what the count
    // bound evicts. Sorted by `ts` it would have been newest, and `real-2` would
    // have gone instead.
    expect((svc as unknown as Internals).entries.map((e) => e.id)).toEqual(["real-1", "real-2"]);
    expect([...kv.store.keys()].sort()).toEqual(["real-1", "real-2"]);
  });

  it("schedules the sweep on start and cancels it on stop", async () => {
    vi.useFakeTimers();
    const kv = createMockKv();
    kv.seed(entry("old", 40));

    const svc = await load(
      { ACTIVITY_MAX_AGE_MS: String(30 * DAY), ACTIVITY_SWEEP_INTERVAL_MS: "60000" },
      kv,
    );
    await svc.start();

    expect(kv.store.size).toBe(1); // start() alone deletes nothing
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kv.store.size).toBe(0); // the first scheduled pass takes it

    kv.seed(entry("old-2", 40));
    await svc.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(kv.store.size).toBe(1); // no sweeps after stop
  });
});
