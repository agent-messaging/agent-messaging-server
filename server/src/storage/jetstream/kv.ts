/**
 * JetStream's key-value helpers: bucket creation with the replica count, and
 * complete enumeration. Part of the storage layer's JetStream implementation
 * (storage/jetstream/keyed.ts wraps a bucket with them). `shared/kv.ts`
 * re-exports this file for the platform code that still opens buckets itself.
 */
import type { JetStreamClient, JetStreamManager, KV, KvEntry } from "nats";
import { KeyedListError } from "../types.js";

// ---------------------------------------------------------------------------
// Replication
// ---------------------------------------------------------------------------

/** Env var naming the replica count for every JetStream asset we create. */
export const REPLICAS_ENV = "MESH_JS_REPLICAS";

/** JetStream's hard ceiling on `num_replicas`. */
const MAX_REPLICAS = 5;

/**
 * Replica count for every JetStream asset this platform creates — the KV
 * buckets below, each agent's inbox buffer (`registry/inbox-buffer.ts`) and
 * each durable room's record stream (`rooms/rooms-service.ts`).
 *
 * **Default 1**, so a single-node deployment behaves exactly as it did before
 * this knob existed. Set `MESH_JS_REPLICAS=3` on a 3-node JetStream cluster to
 * get actual redundancy: without it, clustering buys connection failover and
 * nothing else, because the registry, accounts, rosters, guard state, offline
 * mail and room records each still live on ONE node with no copy of them
 * anywhere. Failover then moves the connection to a node that does not have
 * the data.
 *
 * Must be an integer 1..5. Anything else throws HERE, at boot, on the first
 * bucket or stream creation, instead of being coerced to something that
 * quietly under-replicates. Read in this one place; the three creation sites
 * call this function rather than each reading the environment.
 */
export function jsReplicas(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[REPLICAS_ENV];
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_REPLICAS) {
    throw new Error(
      `${REPLICAS_ENV}="${raw}" is not a usable replica count: ` +
        `it must be an integer 1..${MAX_REPLICAS} (1 = no redundancy, the default; ` +
        `use the cluster size, typically 3). Refusing to boot rather than silently ` +
        `creating single-replica assets on a cluster you believe is replicated.`,
    );
  }
  return n;
}

/**
 * Reject `replicas > 1` against a server that is not clustered, before asking
 * it to create anything.
 *
 * The server would reject it anyway ("replicas > 1 not supported in
 * non-clustered mode"), but that error surfaces from whichever creation call
 * happens to run first, and several of ours are wrapped in best-effort
 * try/catch for good reasons of their own. Checking the INFO we already have
 * turns "some bucket failed" into one sentence naming the env var.
 *
 * `nc.info.cluster` is set iff the server is in a cluster. Reached off the
 * JetStream client because that is what these functions are handed; if the
 * shape ever changes we skip the pre-flight and fall back to the server's own
 * rejection, which is correct but less legible.
 */
function assertReplicationPossible(js: JetStreamClient, replicas: number, what: string): void {
  if (replicas <= 1) return;
  const info = (js as unknown as { nc?: { info?: { cluster?: string } } }).nc?.info;
  if (info && !info.cluster) {
    throw new Error(
      `${REPLICAS_ENV}=${replicas} but this server is not clustered, so it cannot ` +
        `hold ${replicas} replicas of ${what}. Point the service at a JetStream ` +
        `cluster of at least ${replicas} nodes, or unset ${REPLICAS_ENV}.`,
    );
  }
}

/**
 * True when the error is JetStream refusing the requested replica count.
 *
 * Exported so callers that swallow creation failures on purpose can let this
 * one through: a misconfigured replica count is an operator error to be fixed
 * at boot, not a degraded-mode condition to be tolerated for the life of the
 * process.
 */
export function isReplicaError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /replicas?\s*>\s*1 not supported|insufficient replicas|replicas.*exceed/i.test(m);
}

/**
 * Warn when an asset that already existed kept a replica count below the one
 * we asked for.
 *
 * JetStream treats `views.kv` / `streams.add` on an existing name as a
 * no-op-if-compatible, and a replica count is not part of what it reconciles:
 * asking for 3 replicas of a bucket created with 1 returns success and leaves
 * it at 1. That is the silent degradation this whole item exists to remove, so
 * it is reported loudly with the exact remedy.
 *
 * Deliberately NOT fatal. Refusing to boot here would turn "your existing data
 * is under-replicated" into "your mesh is down", and the fix is a replica
 * scale-up that moves data between nodes — an operation the service must not
 * start on its own during startup.
 */
function warnUnderReplicated(what: string, stream: string, got: number, want: number): void {
  if (got >= want) return;
  console.error(
    `[kv] ${what} has ${got} replica(s), not the ${want} ${REPLICAS_ENV} asks for. ` +
      `JetStream does not change replication when an existing asset is reopened, so this ` +
      `one is NOT redundant. Scale it up out of band: nats stream update ${stream} --replicas=${want}`,
  );
}

// ---------------------------------------------------------------------------
// Bucket creation
// ---------------------------------------------------------------------------

export async function ensureKvBucket(
  js: JetStreamClient,
  name: string,
  opts: { history?: number; ttl?: number; replicas?: number } = {},
): Promise<KV> {
  const replicas = opts.replicas ?? jsReplicas();
  assertReplicationPossible(js, replicas, `KV bucket '${name}'`);
  const kv = await js.views.kv(name, {
    history: opts.history ?? 5,
    ttl: opts.ttl,
    replicas,
  });
  if (replicas > 1) {
    const st = await kv.status();
    warnUnderReplicated(`KV bucket '${name}'`, `KV_${name}`, st.replicas, replicas);
  }
  console.log(`[kv] bucket '${name}' ready${replicas > 1 ? ` (r${replicas})` : ""}`);
  return kv;
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/**
 * Raised when a bucket cannot be enumerated completely.
 *
 * The point of this type is that it EXISTS: the failure mode being replaced
 * returned a short list and no error at all, and every "X is stale because it
 * is not in the list" rule inverts when the list is short. A throw is always
 * safer than a plausible-looking subset.
 */
export const KvEnumerationError = KeyedListError;
export type KvEnumerationError = KeyedListError;

/** A complete accounting of one KV bucket at a point in time. */
export interface KvSnapshot {
  /** Live keys — those whose newest revision is a PUT. */
  keys: string[];
  /** The live entries, by key. Already fetched; callers need no second read. */
  entries: Map<string, KvEntry>;
  /** Keys whose newest revision is a DEL or PURGE marker. */
  tombstoned: string[];
  /**
   * Subjects the server listed whose messages were gone by the time we read
   * them — a TTL expiry or a concurrent `purge()` landing between the two
   * calls. Legitimate and harmless (the key really is not there), reported so
   * a caller that cares can see it happened.
   */
  vanished: string[];
  /** Distinct subjects the server reported for the bucket. */
  subjects: number;
  /** `status().values`, i.e. the backing stream's MESSAGE count. See below. */
  values: number;
}

interface SnapshotOpts {
  /** Reuse a manager instead of asking the connection for one. */
  jsm?: JetStreamManager;
  /** Concurrent `get()`s. Bounded only to be polite to the server. */
  concurrency?: number;
  /**
   * Refuse to return fewer than this many LIVE keys. For callers that know a
   * floor independently (a cached count, a previous snapshot).
   */
  minKeys?: number;
  /**
   * Read only the keys this says yes to. The subject list is still the whole
   * bucket's (a key cannot be filtered on the server by part of a token), but
   * the values fetched are only these: a store whose keys start with an
   * account's prefix reads that account's records and nobody else's.
   */
  only?: (key: string) => boolean;
}

/**
 * Enumerate a KV bucket completely, or throw.
 *
 * ## Why this exists — `kv.keys()` loses keys, silently
 *
 * `nats@2` `KvImpl.keys()` is a bridge between two iterators. It subscribes an
 * ordered consumer, drains that subscription in a detached `async` loop at
 * full speed, pushes each key into a SECOND `QueuedIteratorImpl`, and calls
 * `keys.stop()` the instant the subscription is done. The caller reads from
 * that second iterator.
 *
 * `QueuedIteratorImpl.iterate()` consumes in snapshot batches:
 *
 * ```js
 * const yields = this.yields; this.yields = [];   // take a batch
 * for (...) { yield yields[i]; }                  // caller awaits per item
 * if (this.done) break;                           // <-- drops this.yields
 * ```
 *
 * Whatever the producer appended to the fresh `this.yields` while the caller
 * was awaiting its way through the previous batch is discarded by that `break`.
 * `stop()` sets no error, so the caller sees an iteration that ended cleanly.
 * `push()` also returns early once `done`, dropping later arrivals the same way.
 *
 * So the result is a race between the producer finishing and the consumer
 * draining, and it always resolves SHORT. Measured against a local
 * nats-server, 500 live keys, no tombstones, healthy bucket:
 *
 * | caller's per-key work | keys returned | still queued when dropped |
 * |---|---|---|
 * | none (tight push loop) | 432 | 68 |
 * | `await Promise.resolve()` | 406 | 94 |
 * | `await sleep(1)` | **1** | 499 |
 *
 * Zero errors raised in every one of those runs. That "1" is the shape seen in
 * production. Tombstones, purge markers, thick history and bucket size are NOT
 * the cause — a bucket with 25% tombstones enumerated *correctly* under a tight
 * loop, because tombstones slow the producer and so help the consumer win the
 * race. Nor is it a timeout, a pagination bug or an ordered-consumer reset: a
 * single-iterator reimplementation of `keys()` returned all 500 even when
 * stalled for 12 seconds mid-drain, with `consumer_restarts: 0`.
 *
 * ## What this does instead
 *
 * `streams.info(stream, { subjects_filter })` — the server computes the whole
 * subject list, the client pages it with plain awaited requests, and no
 * consumer or iterator is involved anywhere. Each subject is then resolved with
 * `get()`, which is one request per key. Nothing can be dropped between
 * producer and consumer because there is no producer and no consumer.
 *
 * ## On `status().values`
 *
 * It is tempting as a floor to check the result against, and it is the wrong
 * number: `KvStatusImpl.values` returns `streamInfo.state.messages`, the
 * MESSAGE count. A bucket with 375 live keys and 250 tombstones reports 625. So
 * `values` bounds the live-key count from ABOVE, never below, and the check
 * that means something is the exact one below: every subject the server listed
 * must be accounted for as live, tombstoned or vanished.
 */
export async function snapshotKvBucket(
  js: JetStreamClient,
  kv: KV,
  opts: SnapshotOpts = {},
): Promise<KvSnapshot> {
  const status = await kv.status();
  const bucket = status.bucket;
  const stream = status.streamInfo.config.name;
  const values = status.values;

  // The subject a KV key lives on. Plain buckets only — a mirrored or sourced
  // bucket would carry a different prefix, and we create none.
  const prefix = `$KV.${bucket}.`;

  const jsm = opts.jsm ?? (await js.jetstreamManager());
  const info = await jsm.streams.info(stream, { subjects_filter: `${prefix}>` });
  const subjects = Object.keys(info.state.subjects ?? {});

  // The server said this bucket holds messages but listed no subjects for it.
  // Never a legitimately empty bucket; a wrong stream, a wrong filter, or a
  // truncated response. Exactly the shape that reads as "everything is gone".
  if (subjects.length === 0 && values > 0) {
    throw new KvEnumerationError(
      bucket,
      `the backing stream '${stream}' holds ${values} message(s) but reported no ` +
        `subjects for '${prefix}>'. Refusing to report an empty bucket.`,
    );
  }
  // A subject cannot exist without at least one message on it.
  if (subjects.length > values) {
    throw new KvEnumerationError(
      bucket,
      `${subjects.length} subject(s) against only ${values} message(s) — the ` +
        `subject list and the message count disagree, so neither can be trusted.`,
    );
  }

  const all = subjects.map((s) => s.slice(prefix.length));
  const keys = opts.only ? all.filter(opts.only) : all;
  const entries = new Map<string, KvEntry>();
  const tombstoned: string[] = [];
  const vanished: string[] = [];

  // Bounded concurrency over an ARRAY. Not an iterator, on purpose: an index
  // into a fixed array cannot lose an element the way the bug above does.
  const width = Math.max(1, Math.min(opts.concurrency ?? 32, keys.length || 1));
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= keys.length) return;
        const key = keys[i];
        // No catch. A read that failed is not a key that is absent, and the
        // whole class of bug here is the difference between those two.
        const entry = await kv.get(key);
        if (!entry) vanished.push(key);
        else if (entry.operation === "PUT") entries.set(key, entry);
        else tombstoned.push(key);
      }
    }),
  );

  // Defensive: every listed subject took exactly one of the three branches.
  const accounted = entries.size + tombstoned.length + vanished.length;
  if (accounted !== keys.length) {
    throw new KvEnumerationError(
      bucket,
      `resolved ${accounted} of ${keys.length} subject(s) — the enumeration ` +
        `lost some, which is the failure it exists to prevent.`,
    );
  }
  if (opts.minKeys !== undefined && entries.size < opts.minKeys) {
    throw new KvEnumerationError(
      bucket,
      `found ${entries.size} live key(s), fewer than the ${opts.minKeys} the ` +
        `caller knows exist. Treating this as a failed read, not as deletions.`,
    );
  }
  if (vanished.length > 0) {
    console.warn(
      `[kv] '${bucket}': ${vanished.length} listed subject(s) had no message by the ` +
        `time they were read (TTL expiry or a concurrent purge); not counted as live.`,
    );
  }

  return {
    keys: [...entries.keys()],
    entries,
    tombstoned,
    vanished,
    subjects: subjects.length,
    values,
  };
}

/**
 * The live keys of a bucket, or a throw. Thin wrapper over
 * {@link snapshotKvBucket} for callers that want names and not values; prefer
 * the snapshot when you are about to read each value anyway, since it has
 * already fetched them.
 */
export async function listKvKeys(
  js: JetStreamClient,
  kv: KV,
  opts: SnapshotOpts = {},
): Promise<string[]> {
  return (await snapshotKvBucket(js, kv, opts)).keys;
}
