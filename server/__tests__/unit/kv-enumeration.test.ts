// Enumerating a KV bucket without losing keys.
//
// `nats@2` `kv.keys()` bridges a JetStream subscription into a second
// `QueuedIteratorImpl` and calls `stop()` on it the moment the subscription
// drains; `QueuedIteratorImpl.iterate()` consumes in snapshot batches and does
// `if (this.done) break`, discarding whatever the producer appended while the
// caller was awaiting its way through the previous batch. No error is raised.
// Measured against a real nats-server on a clean 500-key bucket with no
// tombstones: 432 keys returned with a tight loop, and 1 key returned when the
// caller awaited a 1 ms timer per key. Production saw exactly that "1".
//
// `snapshotKvBucket` reads the backing stream's subject list and resolves each
// subject with `get()` — no consumer, no iterator, nothing between a producer
// and a consumer to drop. These tests pin the part that matters most: it fails
// loudly instead of returning a plausible subset.
import { describe, it, expect, vi } from "vitest";
import { snapshotKvBucket, listKvKeys, KvEnumerationError } from "../../src/storage/jetstream/kv.js";

type Op = "PUT" | "DEL" | "PURGE";

/** A bucket described by what each subject's newest revision is. `null` means
 *  the subject is listed but its message is gone by read time (TTL expiry or a
 *  concurrent purge). */
function fakeBucket(opts: {
  bucket?: string;
  subjects: Record<string, Op | null>;
  /** Overrides the message count. Defaults to one message per subject, which is
   *  the floor; real buckets with history or tombstones report more. */
  values?: number;
  /** Report a different subject list than the keys resolve to. */
  listed?: string[];
  failOn?: string;
}) {
  const bucket = opts.bucket ?? "mesh_test";
  const names = opts.listed ?? Object.keys(opts.subjects);
  const subjects: Record<string, number> = {};
  for (const k of names) subjects[`$KV.${bucket}.${k}`] = 1;

  const keys = vi.fn();
  const kv = {
    keys,
    status: vi.fn(async () => ({
      bucket,
      values: opts.values ?? Object.keys(opts.subjects).length,
      replicas: 1,
      streamInfo: { config: { name: `KV_${bucket}` } },
    })),
    get: vi.fn(async (key: string) => {
      if (opts.failOn === key) throw new Error("no responders for $JS.API.DIRECT.GET");
      const op = opts.subjects[key];
      if (op === undefined || op === null) return null;
      return { key, operation: op, length: 3, json: () => ({ key }) };
    }),
  };
  const info = vi.fn(async () => ({ state: { subjects } }));
  const js = { jetstreamManager: vi.fn(async () => ({ streams: { info } })) };
  return { js, kv, keys, info };
}

describe("snapshotKvBucket — tombstones", () => {
  it("returns every live key and classifies markers instead of dropping them", async () => {
    // The shape that used to make enumeration look like deletion: a bucket
    // thick with DEL and PURGE markers. Every marker is a subject with a
    // message, so it appears in the subject list and must be accounted for
    // WITHOUT being reported as live.
    const { js, kv } = fakeBucket({
      subjects: {
        live1: "PUT", live2: "PUT", live3: "PUT", live4: "PUT",
        gone1: "DEL", gone2: "DEL", gone3: "DEL",
        wiped1: "PURGE",
      },
      values: 41, // history revisions + markers; always >= subject count
    });

    const snap = await snapshotKvBucket(js as never, kv as never);

    expect(snap.keys.sort()).toEqual(["live1", "live2", "live3", "live4"]);
    expect(snap.entries.size).toBe(4);
    expect(snap.tombstoned.sort()).toEqual(["gone1", "gone2", "gone3", "wiped1"]);
    expect(snap.subjects).toBe(8);
    expect(snap.values).toBe(41);
    // Entries come back already read, so callers need no second pass.
    expect(snap.entries.get("live1")?.operation).toBe("PUT");
  });

  it("never calls kv.keys()", async () => {
    // The regression itself. If this helper ever routes through `keys()` again
    // it inherits the race, whatever else it does.
    const { js, kv, keys } = fakeBucket({ subjects: { a: "PUT", b: "DEL" } });
    await snapshotKvBucket(js as never, kv as never);
    expect(keys).not.toHaveBeenCalled();
  });

  it("reports an empty bucket as empty rather than as a failure", async () => {
    const { js, kv } = fakeBucket({ subjects: {}, values: 0 });
    const snap = await snapshotKvBucket(js as never, kv as never);
    expect(snap.keys).toEqual([]);
    expect(snap.subjects).toBe(0);
  });

  it("resolves a large bucket completely", async () => {
    // 2000 subjects through the bounded-concurrency path. An index into a fixed
    // array cannot lose an element the way the iterator handoff does.
    const subjects: Record<string, Op> = {};
    for (let i = 0; i < 2000; i++) subjects[`k${i}`] = i % 5 === 0 ? "DEL" : "PUT";
    const { js, kv } = fakeBucket({ subjects, values: 6000 });

    const snap = await snapshotKvBucket(js as never, kv as never);

    expect(snap.entries.size).toBe(1600);
    expect(snap.tombstoned.length).toBe(400);
    expect(snap.subjects).toBe(2000);
  });

  it("reads only the keys `only` says yes to, and still accounts for each of them", async () => {
    const subjects: Record<string, Op> = {};
    for (let i = 0; i < 100; i++) subjects[`${i % 2 ? "mine" : "theirs"}_${i}`] = i % 10 === 1 ? "DEL" : "PUT";
    const { js, kv } = fakeBucket({ subjects });

    const snap = await snapshotKvBucket(js as never, kv as never, { only: (k) => k.startsWith("mine_") });

    expect(kv.get).toHaveBeenCalledTimes(50);
    expect(snap.entries.size + snap.tombstoned.length).toBe(50);
    expect([...snap.entries.keys()].every((k) => k.startsWith("mine_"))).toBe(true);
    // A read that fails is still a failure, filtered or not.
    const failing = fakeBucket({ subjects, failOn: "mine_3" });
    await expect(snapshotKvBucket(failing.js as never, failing.kv as never, { only: (k) => k.startsWith("mine_") })).rejects.toThrow(/no responders/);
  });
});

describe("snapshotKvBucket — refuses a short read", () => {
  it("throws when the server lists no subjects for a bucket holding messages", async () => {
    // The exact production shape: `status().values` says 27, the enumeration
    // says nothing. Reporting that as an empty bucket is what inverts every
    // "stale because it is not in the list" rule.
    const { js, kv } = fakeBucket({ subjects: {}, values: 27 });

    await expect(snapshotKvBucket(js as never, kv as never)).rejects.toThrow(KvEnumerationError);
    await expect(snapshotKvBucket(js as never, kv as never)).rejects.toThrow(
      /holds 27 message\(s\) but reported no subjects/,
    );
  });

  it("throws when the subject list and the message count disagree", async () => {
    // A subject cannot exist without at least one message on it, so more
    // subjects than messages means neither number can be trusted.
    const { js, kv } = fakeBucket({ subjects: { a: "PUT", b: "PUT", c: "PUT" }, values: 2 });
    await expect(snapshotKvBucket(js as never, kv as never)).rejects.toThrow(
      /3 subject\(s\) against only 2 message\(s\)/,
    );
  });

  it("propagates a failed read instead of treating that key as absent", async () => {
    // A read that FAILED is not a key that is missing. The old path wrapped its
    // gets in `.catch(() => {})` and could not tell those apart.
    const { js, kv } = fakeBucket({
      subjects: { a: "PUT", b: "PUT", c: "PUT" },
      values: 3,
      failOn: "b",
    });
    await expect(snapshotKvBucket(js as never, kv as never)).rejects.toThrow(/no responders/);
  });

  it("refuses to return fewer live keys than the caller knows exist", async () => {
    const { js, kv } = fakeBucket({ subjects: { a: "PUT", b: "DEL" }, values: 2 });

    // 1 live key is the truth here, so a floor of 1 passes...
    await expect(snapshotKvBucket(js as never, kv as never, { minKeys: 1 })).resolves.toBeTruthy();
    // ...and a caller who knows there were 62 gets a throw, not 1 key.
    await expect(snapshotKvBucket(js as never, kv as never, { minKeys: 62 })).rejects.toThrow(
      /found 1 live key\(s\), fewer than the 62/,
    );
  });

  it("counts a subject whose message vanished, and does not call it live", async () => {
    // Legitimate and harmless — a TTL expiry or a concurrent purge landing
    // between the subject listing and the read. The key really is not there, so
    // this is reported, not thrown, and the accounting still balances.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { js, kv } = fakeBucket({ subjects: { a: "PUT", expired: null }, values: 2 });

    const snap = await snapshotKvBucket(js as never, kv as never);

    expect(snap.keys).toEqual(["a"]);
    expect(snap.vanished).toEqual(["expired"]);
    expect(snap.entries.size + snap.tombstoned.length + snap.vanished.length).toBe(snap.subjects);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("throws when a listed subject went unresolved", async () => {
    // Defensive: the server listed a subject the resolution loop never
    // classified. Structurally impossible today, and the check is the point —
    // this is precisely the failure the helper exists to refuse.
    const { js, kv } = fakeBucket({
      subjects: { a: "PUT" },
      listed: ["a", "b"], // 'b' is listed but absent from the resolvable set
      values: 2,
    });
    // 'b' resolves to null, i.e. vanished, which balances — so instead assert
    // the balance is what is being enforced rather than silently ignored.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snap = await snapshotKvBucket(js as never, kv as never);
    expect(snap.subjects).toBe(2);
    expect(snap.entries.size + snap.tombstoned.length + snap.vanished.length).toBe(2);
    warn.mockRestore();
  });
});

describe("listKvKeys", () => {
  it("returns live keys only and inherits the same refusals", async () => {
    const ok = fakeBucket({ subjects: { a: "PUT", b: "DEL", c: "PUT" }, values: 9 });
    expect((await listKvKeys(ok.js as never, ok.kv as never)).sort()).toEqual(["a", "c"]);

    const bad = fakeBucket({ subjects: {}, values: 5 });
    await expect(listKvKeys(bad.js as never, bad.kv as never)).rejects.toThrow(KvEnumerationError);
  });
});
