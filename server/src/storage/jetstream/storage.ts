/**
 * The storage layer on NATS JetStream: keyed records are KV buckets, streams
 * are JetStream streams, blobs are object stores (or disk, or Google Cloud
 * Storage, as the operator chooses).
 *
 * It is built from the handle the core has always been given, a JetStream
 * client or a NATS connection, and it opens each store the way the service
 * that owns it opened it before the layer existed: the same name, the same
 * settings, the same calls.
 */
import type { JetStreamClient, JetStreamManager, NatsConnection } from "nats";
import { KEYED_STORES, type BlobStoreName, type KeyedStoreName, type SingleStreamName, type StreamFamilyName } from "../catalog.js";
import type { Storage } from "../types.js";
import type { BlobStore } from "../blobs.js";
import { jetStreamObjectStore } from "./blobs.js";
import { ensureKvBucket } from "./kv.js";
import { JetStreamKeyed } from "./keyed.js";
import { JetStreamFamily, JetStreamSingleStream, type JetStreamAccess } from "./streams.js";

/** What the core has always been handed: a JetStream client, or the NATS
 *  connection it came from. */
export type JetStreamHandle = JetStreamClient | NatsConnection;

export const STORAGE = Symbol.for("agent-messaging.storage");

export function isStorage(x: unknown): x is Storage {
  return typeof x === "object" && x !== null && (x as { [STORAGE]?: boolean })[STORAGE] === true;
}

export class JetStreamStorage implements Storage, JetStreamAccess {
  readonly [STORAGE] = true;
  readonly binding = "jetstream";
  private client: JetStreamClient | null = null;
  private jsm: Promise<JetStreamManager> | null = null;

  constructor(
    private readonly handle: JetStreamHandle,
    /** Where the stream manager comes from, when not from `handle` (a service
     *  handed both the connection and the client asks the connection). */
    private readonly managerHandle: JetStreamHandle = handle,
  ) {}

  /** The JetStream client: the handle itself, or the connection's client,
   *  asked for only when a store needs it. */
  get js(): JetStreamClient {
    if (this.client) return this.client;
    const h = this.handle as Partial<JetStreamClient> & Partial<NatsConnection>;
    this.client = typeof h.views === "object" || typeof h.jetstream !== "function"
      ? (this.handle as JetStreamClient)
      : (h.jetstream as () => JetStreamClient).call(this.handle);
    return this.client;
  }

  /** The stream manager, asked for once and kept; a failed ask is asked again
   *  next time. */
  manager(): Promise<JetStreamManager> {
    if (!this.jsm) {
      const h = this.managerHandle as { jetstreamManager(): Promise<JetStreamManager> };
      const p = Promise.resolve().then(() => h.jetstreamManager());
      this.jsm = p;
      p.catch(() => {
        if (this.jsm === p) this.jsm = null;
      });
    }
    return this.jsm;
  }

  async keyed(name: KeyedStoreName): Promise<JetStreamKeyed> {
    const spec: { history: number; ttlMs?: number } = KEYED_STORES[name];
    const opts: { history: number; ttl?: number } = { history: spec.history };
    if (spec.ttlMs !== undefined) opts.ttl = spec.ttlMs;
    const kv = await ensureKvBucket(this.js, name, opts);
    return new JetStreamKeyed(kv, this.js);
  }

  stream(name: SingleStreamName): JetStreamSingleStream {
    return new JetStreamSingleStream(this, name);
  }

  streams(family: StreamFamilyName): JetStreamFamily {
    return new JetStreamFamily(this, family);
  }

  blobs(name: BlobStoreName): Promise<BlobStore> {
    return jetStreamObjectStore(this.js, name);
  }
}
