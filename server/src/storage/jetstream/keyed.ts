/**
 * Keyed records on a JetStream key-value bucket.
 *
 * This wraps today's calls and changes none of them: the bucket, its key
 * format and its revisions are the ones the core used before the storage layer
 * existed, so a bucket already holding production data is read exactly as
 * before. Each method makes the same call on the bucket that the service made
 * itself, with the same arguments (an option the caller did not give is not
 * passed), and returns what the bucket returned.
 *
 * Listing is `snapshotKvBucket` (storage/jetstream/kv.ts), never `kv.keys()`,
 * which drops keys without an error.
 */
import type { JetStreamClient, KV, KvEntry, KvWatchOptions } from "nats";
import type {
  KeyedEntry,
  KeyedListOptions,
  KeyedSnapshot,
  KeyedStore,
  KeyedWatch,
  KeyedWatchOptions,
  KeyedWriteOptions,
} from "../types.js";
import { snapshotKvBucket } from "./kv.js";

/** Marks a value as a storage-layer keyed store, so `keyedOf` adopts a
 *  JetStream bucket and leaves a store from any binding as it is. */
export const KEYED_STORE = Symbol.for("agent-messaging.storage.keyed");

export function isKeyedStore(x: unknown): x is KeyedStore {
  return typeof x === "object" && x !== null && (x as { [KEYED_STORE]?: boolean })[KEYED_STORE] === true;
}

export class JetStreamKeyed implements KeyedStore {
  readonly [KEYED_STORE] = true;

  constructor(
    /** The bucket. */
    readonly kv: KV,
    /** The client the bucket was opened on, for listing. */
    private readonly js?: JetStreamClient,
  ) {}

  get(key: string): Promise<KeyedEntry | null> {
    return this.kv.get(key) as Promise<KvEntry | null>;
  }

  put(key: string, value: Uint8Array | string, opts?: KeyedWriteOptions): Promise<number> {
    return opts?.previousRevision === undefined
      ? this.kv.put(key, value as Uint8Array)
      : this.kv.put(key, value as Uint8Array, { previousSeq: opts.previousRevision });
  }

  create(key: string, value: Uint8Array | string): Promise<number> {
    return this.kv.create(key, value as Uint8Array);
  }

  update(key: string, value: Uint8Array | string, revision: number): Promise<number> {
    return this.kv.update(key, value as Uint8Array, revision);
  }

  delete(key: string, opts?: KeyedWriteOptions): Promise<void> {
    return opts?.previousRevision === undefined
      ? this.kv.delete(key)
      : this.kv.delete(key, { previousSeq: opts.previousRevision });
  }

  purge(key: string, opts?: KeyedWriteOptions): Promise<void> {
    return opts?.previousRevision === undefined
      ? this.kv.purge(key)
      : this.kv.purge(key, { previousSeq: opts.previousRevision });
  }

  async list(opts: KeyedListOptions = {}): Promise<KeyedSnapshot> {
    // The bucket is listed whole by subject and filtered here: JetStream cannot
    // filter a key on the server by part of a token.
    const { prefix, only, ...rest } = opts;
    const filter =
      prefix === undefined && only === undefined
        ? undefined
        : (k: string) => (prefix === undefined || k.startsWith(prefix)) && (only === undefined || only(k));
    return snapshotKvBucket(this.js as JetStreamClient, this.kv, filter ? { ...rest, only: filter } : rest);
  }

  async watch(opts?: KeyedWatchOptions): Promise<KeyedWatch> {
    if (opts === undefined) return (await this.kv.watch()) as unknown as KeyedWatch;
    const o: Partial<KvWatchOptions> = opts.fromRevision === undefined ? {} : { resumeFromRevision: opts.fromRevision };
    return (await this.kv.watch(o)) as unknown as KeyedWatch;
  }
}
