// The fake surface a KV bucket needs in order to be ENUMERATED.
//
// `snapshotKvBucket` (src/shared/kv.ts) does not iterate a bucket. It asks the
// server for the backing stream's SUBJECT list — `streams.info(stream, {
// subjects_filter })` — and then resolves each subject with `kv.get()`. So a fake
// KV that only implements get/put/purge is no longer enough: it also needs
// `status()` (to name its stream), and the JetStream client handed alongside it
// needs a manager that can list that stream's subjects.
//
// This lives in one place on purpose. Four suites need it, and a per-suite copy
// of "what a KV bucket looks like from the outside" is how the fakes drift away
// from what the code actually does — which is what let a fake with a `keys()`
// that could not lose a key stand in for a real one that always did.
import { vi } from "vitest";

/**
 * A fake JetStream client, plus a registry of the fake buckets it can enumerate.
 *
 * ```ts
 * const h = fakeJs();
 * const kv = { ...myFakeBucket, status: h.bucket("mesh_held", () => [...store.keys()]) };
 * const store = new HeldStore(kv as never, h.js as never);
 * ```
 *
 * `live` is called at read time rather than captured, so a bucket that gains or
 * loses keys during a test enumerates as it is at that moment.
 */
export function fakeJs() {
  /** stream name → the live keys of the bucket behind it */
  const buckets = new Map<string, () => string[]>();

  const info = vi.fn(async (stream: string) => {
    const live = buckets.get(stream);
    // Same shape as the server's: an unknown stream is an error, not an empty
    // subject list. `snapshotKvBucket` must be able to tell those apart.
    if (!live) throw new Error(`stream not found: ${stream}`);
    const bucket = stream.replace(/^KV_/, "");
    const subjects: Record<string, number> = {};
    for (const k of live()) subjects[`$KV.${bucket}.${k}`] = 1;
    return { state: { subjects } };
  });

  const jetstreamManager = vi.fn(async () => ({ streams: { info } }));

  return {
    info,
    jetstreamManager,
    js: { jetstreamManager },
    /**
     * Register a bucket and return the `status()` its fake KV should carry.
     *
     * `values` is the backing stream's MESSAGE count, and one message per live key
     * is the floor. A real bucket with history or tombstones reports more —
     * `values` bounds the live-key count from above, never below, which is why
     * nothing checks the result against it.
     */
    bucket(name: string, live: () => string[]) {
      buckets.set(`KV_${name}`, live);
      return vi.fn(async () => ({
        bucket: name,
        values: live().length,
        replicas: 1,
        streamInfo: { config: { name: `KV_${name}` } },
      }));
    },
  };
}

/**
 * A `keys()` that fails the test if anything calls it.
 *
 * Put it on every fake bucket. `kv.keys()` under-returns silently and there is no
 * remaining call site in `services/src`; a future one should break a test rather
 * than pass one, because the real thing would not have broken anything either.
 */
export function forbiddenKeys() {
  return vi.fn(() => {
    throw new Error(
      "kv.keys() must not be used — it drops keys silently. Enumerate with " +
        "snapshotKvBucket / listKvKeys (src/shared/kv.ts).",
    );
  });
}

// ---------------------------------------------------------------------------
// A KV bucket that can be WATCHED
// ---------------------------------------------------------------------------

/** The fields of a real `KvEntry` that anything in this tree reads. */
export interface FakeKvEntry {
  bucket: string;
  key: string;
  value: Uint8Array;
  revision: number;
  operation: "PUT" | "DEL" | "PURGE";
  created: Date;
  delta: number;
  json<T>(): T;
  string(): string;
}

/**
 * An in-memory KV bucket with revisions, a write log, and a real `watch()`.
 *
 * Needed because the registry keeps its manifest cache in step with the bucket
 * through `kv.watch()` (src/registry/manifest-watch.ts), and a bucket fake that
 * cannot be watched can only test half of that. The semantics copied from the
 * server, because they are the ones the code depends on:
 *
 *  - a revision is the backing stream's sequence, so it increases across the
 *    whole bucket and never repeats — which is what makes it usable as a resume
 *    point;
 *  - a watch with no `resumeFromRevision` replays the LAST entry per key (the
 *    client's default `include`), delete markers included, then streams live
 *    changes;
 *  - a watch with `resumeFromRevision: n` replays from revision `n` and skips
 *    everything before it;
 *  - `delete` and `purge` are entries too, with their own revisions, not the
 *    absence of one.
 */
export function memKv(name: string, h?: ReturnType<typeof fakeJs>) {
  const store = new Map<string, { value: Uint8Array; revision: number }>();
  /** Every write ever made, in revision order. A watch replays out of this. */
  const log: FakeKvEntry[] = [];
  let revision = 0;

  interface Watcher {
    opts: { resumeFromRevision?: number };
    queue: FakeKvEntry[];
    wake: (() => void) | null;
    done: boolean;
    err: Error | null;
  }
  const watchers: Watcher[] = [];
  let nextWatchFails: Error | null = null;

  const entryFor = (
    key: string,
    value: Uint8Array,
    rev: number,
    operation: FakeKvEntry["operation"],
  ): FakeKvEntry => ({
    bucket: name,
    key,
    value,
    revision: rev,
    operation,
    created: new Date(),
    delta: 0,
    json<T>(): T {
      return JSON.parse(new TextDecoder().decode(value)) as T;
    },
    string(): string {
      return new TextDecoder().decode(value);
    },
  });

  function record(entry: FakeKvEntry): void {
    log.push(entry);
    for (const w of watchers) {
      if (w.done) continue;
      w.queue.push(entry);
      w.wake?.();
      w.wake = null;
    }
  }

  /** Write raw bytes under a key, valid JSON or not. */
  function writeRaw(key: string, text: string): number {
    const value = new TextEncoder().encode(text);
    revision++;
    store.set(key, { value, revision });
    record(entryFor(key, value, revision, "PUT"));
    return revision;
  }

  function removeKey(key: string, operation: "DEL" | "PURGE"): void {
    revision++;
    store.delete(key);
    record(entryFor(key, new Uint8Array(), revision, operation));
  }

  const kv = {
    put: vi.fn(async (key: string, data: Uint8Array | string) =>
      writeRaw(key, typeof data === "string" ? data : new TextDecoder().decode(data)),
    ),
    // The server's compare-and-set pair, semantics copied because they are the
    // ones claims and leases depend on: `create` fails while a live value
    // exists (a deleted key can be created again), `update` fails unless the
    // caller names the key's CURRENT revision. Every write bumps the
    // bucket-wide revision, same as `put`.
    create: vi.fn(async (key: string, data: Uint8Array | string) => {
      if (store.has(key)) throw new Error(`wrong last sequence: key exists: ${key}`);
      return writeRaw(key, typeof data === "string" ? data : new TextDecoder().decode(data));
    }),
    update: vi.fn(async (key: string, data: Uint8Array | string, version: number) => {
      const cur = store.get(key);
      if (!cur || cur.revision !== version) {
        throw new Error(`wrong last sequence: ${cur?.revision ?? 0}`);
      }
      return writeRaw(key, typeof data === "string" ? data : new TextDecoder().decode(data));
    }),
    get: vi.fn(async (key: string) => {
      const cur = store.get(key);
      return cur ? entryFor(key, cur.value, cur.revision, "PUT") : null;
    }),
    purge: vi.fn(async (key: string) => removeKey(key, "PURGE")),
    delete: vi.fn(async (key: string) => removeKey(key, "DEL")),
    keys: forbiddenKeys(),
    watch: vi.fn(async (opts: { resumeFromRevision?: number } = {}) => {
      if (nextWatchFails) {
        const err = nextWatchFails;
        nextWatchFails = null;
        throw err;
      }
      const w: Watcher = { opts, queue: [], wake: null, done: false, err: null };
      // Initial replay, exactly as the client's `include` semantics do it.
      if (opts.resumeFromRevision && opts.resumeFromRevision > 0) {
        w.queue.push(...log.filter((e) => e.revision >= opts.resumeFromRevision!));
      } else {
        const last = new Map<string, FakeKvEntry>();
        for (const e of log) last.set(e.key, e);
        w.queue.push(...[...last.values()].sort((a, b) => a.revision - b.revision));
      }
      watchers.push(w);
      return {
        stop(): void {
          w.done = true;
          w.wake?.();
          w.wake = null;
        },
        async *[Symbol.asyncIterator](): AsyncGenerator<FakeKvEntry> {
          for (;;) {
            if (w.queue.length) {
              yield w.queue.shift()!;
              continue;
            }
            if (w.err) throw w.err;
            if (w.done) return;
            await new Promise<void>((r) => {
              w.wake = r;
            });
          }
        },
      };
    }),
    ...(h ? { status: h.bucket(name, () => [...store.keys()]) } : {}),
  };

  return {
    kv,
    store,
    log,
    watchers,
    get revision(): number {
      return revision;
    },
    /** Bytes under a key that are not parseable JSON. */
    writeRaw,
    /** Make the NEXT `watch()` call reject, as a broker refusing a consumer would. */
    failNextWatch(err: Error): void {
      nextWatchFails = err;
    },
    /** End every open watcher with an error — the ordered consumer dying under a
     *  watch that the caller never stopped. */
    breakWatch(err: Error = new Error("consumer deleted")): void {
      for (const w of watchers) {
        if (w.done) continue;
        // Both: the iterator checks `err` before `done`, so it still throws — and
        // a dead watcher stops being fed by later writes.
        w.err = err;
        w.done = true;
        w.wake?.();
        w.wake = null;
      }
    },
    /** The options every `watch()` was opened with, in order. */
    watchOpts(): Array<{ resumeFromRevision?: number }> {
      return watchers.map((w) => w.opts);
    },
  };
}
