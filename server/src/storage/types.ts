/**
 * The storage layer's interfaces (docs/agent-messaging-server-plan.md, step 8).
 *
 * The core services keep their state in three kinds of store and talk to each
 * other over one messaging interface. Each kind is written here as the
 * smallest interface the core services actually use, so a second binding
 * (Postgres beside RabbitMQ, step 9) can implement it without the services
 * changing:
 *
 *  - keyed records (`KeyedStore`): get, put, compare-and-set on a revision,
 *    delete, list by prefix, and watch;
 *  - streams (`StreamStore`): append, read from a point, and durable consumers
 *    with acknowledgment and redelivery;
 *  - blobs (`BlobStore`): put, get and delete by reference.
 *
 * Nothing in this file names a broker. The JetStream implementation is in
 * `storage/jetstream/`, and it is the only core code that reaches JetStream
 * (tools/ci/check-storage-layer.mjs holds the core folders to that). What the
 * interfaces deliberately leave out, and why, is written in the plan's step 8
 * section.
 */
import type { BlobStoreName, KeyedStoreName, SingleStreamName, StreamFamilyName } from "./catalog.js";
import type { BlobStore } from "./blobs.js";

// ---------------------------------------------------------------------------
// Keyed records
// ---------------------------------------------------------------------------

/** What the newest revision of a key is: a value, a delete, or a purge. */
export type RecordOperation = "PUT" | "DEL" | "PURGE";

/**
 * One revision of one key.
 *
 * `revision` is the store's own counter for the write. It only grows, and it is
 * what `update` and the `previousRevision` options compare against. On
 * JetStream it is the backing stream's sequence, so the numbers a key had
 * before this layer existed are the numbers it has now.
 *
 * A key that was deleted or purged can come back from `get` as an entry whose
 * `operation` is `DEL` or `PURGE` and whose value is empty, because JetStream
 * keeps the marker. Callers treat any entry that is not a `PUT` as absent; a
 * binding that keeps no marker returns null instead, which every caller already
 * reads the same way.
 */
export interface KeyedEntry {
  readonly key: string;
  readonly value: Uint8Array;
  readonly revision: number;
  readonly created: Date;
  readonly operation: RecordOperation;
  readonly length: number;
  json<T>(): T;
  string(): string;
}

/**
 * A complete account of a keyed store at one moment, or a throw.
 *
 * `list` never returns a short list quietly: a read it cannot finish throws
 * (`KeyedListError`), because every "this is stale since it is not in the
 * list" rule turns into a deletion when the list is short.
 */
export interface KeyedSnapshot {
  /** Live keys: those whose newest revision is a PUT. */
  keys: string[];
  /** The live entries, by key, already read. */
  entries: Map<string, KeyedEntry>;
  /** Keys whose newest revision is a delete or purge marker. */
  tombstoned: string[];
  /** Keys that were listed and gone by the time they were read (an expiry or a
   *  concurrent purge). Harmless, and reported so a caller can see it. */
  vanished: string[];
  /** How many keys the store reported, live or not. */
  subjects: number;
  /** How many stored values the store holds, history and markers included. An
   *  upper bound on the live keys, never a lower one. */
  values: number;
}

export interface KeyedListOptions {
  /** Only keys that start with this. */
  prefix?: string;
  /** Read only the keys this says yes to (after `prefix`). */
  only?: (key: string) => boolean;
  /** Refuse to answer with fewer live keys than this. For callers that know a
   *  floor independently, such as a cached count. */
  minKeys?: number;
  /** Concurrent reads while listing. Bounded only to be polite to the store. */
  concurrency?: number;
}

/** A watch: the current value of every key, then every change after it. */
export interface KeyedWatch extends AsyncIterable<KeyedEntry> {
  stop(): void;
}

export interface KeyedWatchOptions {
  /** Start at this revision instead of replaying the current values: a watch
   *  reopened after a break passes one more than the last revision it applied. */
  fromRevision?: number;
}

export interface KeyedWriteOptions {
  /** Write only if the key's newest revision is this one (compare-and-set). */
  previousRevision?: number;
}

/**
 * Keyed records: a value per key, with a revision on every write.
 *
 * `put` writes unconditionally; `create` writes only when the key holds no live
 * value; `update` writes only when the key's newest revision is `revision`.
 * Each returns the revision it wrote, and a lost compare-and-set throws.
 * `delete` leaves a marker that a watch sees; `purge` also drops the key's
 * history. Both are removals as far as `get` and `list` are concerned.
 */
export interface KeyedStore {
  get(key: string): Promise<KeyedEntry | null>;
  put(key: string, value: Uint8Array | string, opts?: KeyedWriteOptions): Promise<number>;
  create(key: string, value: Uint8Array | string): Promise<number>;
  update(key: string, value: Uint8Array | string, revision: number): Promise<number>;
  delete(key: string, opts?: KeyedWriteOptions): Promise<void>;
  purge(key: string, opts?: KeyedWriteOptions): Promise<void>;
  list(opts?: KeyedListOptions): Promise<KeyedSnapshot>;
  watch(opts?: KeyedWatchOptions): Promise<KeyedWatch>;
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/**
 * A stream holds what is published on its subjects, in order, each message
 * under a sequence number that only grows. The core services write to their
 * streams by publishing on those subjects (the messaging interface); `append`
 * is the same write for a caller that wants to know it landed.
 */
export interface StreamMessage {
  readonly subject: string;
  readonly data: Uint8Array;
  readonly seq: number;
  readonly time: Date;
}

/** One message handed to a durable consumer. It is redelivered until it is
 *  acknowledged; `nak` asks for it again, after `delayMs` when given. */
export interface StreamDelivery {
  readonly subject: string;
  readonly data: Uint8Array;
  readonly seq: number;
  ack(): void;
  nak(delayMs?: number): void;
}

/** A durable consumer's deliveries, until `stop`. The iteration ends when the
 *  stream is removed. */
export interface StreamConsumer extends AsyncIterable<StreamDelivery> {
  stop(): void;
  /** Stop, and wait until the binding has let go. */
  close(): Promise<unknown>;
}

export interface ConsumeOptions {
  /** Only messages on this subject. */
  filter?: string;
  /** Where a consumer that does not exist yet starts: the binding's default,
   *  or `all` from the first message the stream holds. */
  from?: "all";
}

/** Where a durable consumer stands. */
export interface ConsumerState {
  /** Messages not yet delivered to it. */
  pending: number;
  /** Delivered and not yet acknowledged. */
  ackPending: number;
  /** The highest sequence below which everything is acknowledged. */
  ackFloor: number;
}

/** What a stream holds now. */
export interface StreamState {
  messages: number;
  bytes: number;
  firstSeq: number;
  lastSeq: number;
  /** When the oldest message held arrived; null when there is none. */
  firstTime: Date | null;
  /** When the newest message arrived, in RFC 3339 as the binding reports it
   *  (it goes out on the wire in the rooms status answer as it is). */
  lastAt: string | null;
  /** When the stream was made; null when the binding cannot say. */
  created: Date | null;
  /** The subjects it holds itself. Empty when it holds a slice of another
   *  stream instead (on JetStream, a sourced stream). */
  subjects: string[];
  /** Settings that differ from what the layer creates the stream with and that
   *  `reconfigure` puts back, in words for a log line. Empty when none. */
  repairs: string[];
}

/** How a stream that is one of a family (one per agent, one per room) is made. */
export interface StreamSpec {
  /** The subjects it holds. */
  subjects: string[];
  maxAgeMs?: number;
  maxBytes?: number;
  maxMsgs?: number;
  /** When full: drop the oldest (`old`), or refuse the new (`new`). */
  discard: "old" | "new";
  /** Capture without answering the publisher. For streams that hold request
   *  subjects, where an answer from the store would race the real reply. */
  silent?: boolean;
}

export interface ReadFromOptions {
  /** At most this many messages. */
  max: number;
  /** Stop waiting for more after this long (at least a second on JetStream). */
  waitMs: number;
}

export interface StreamStore {
  /** The stream's name, which is its name on the broker. */
  readonly name: string;
  /** What it holds now; null when there is no such stream. Other failures throw. */
  info(): Promise<StreamState | null>;
  /** Make a family member with this spec (a single stream is made by `ensure`). */
  create(spec: StreamSpec): Promise<void>;
  /** Hold `subjects` instead when given, and with `repair` put back the
   *  settings `info().repairs` named. `basis` is the state just read, so the
   *  change is made on it and nothing else moves. */
  reconfigure(basis: StreamState, change?: { subjects?: string[]; repair?: boolean }): Promise<void>;
  /** Write one message on one of the stream's subjects and return its
   *  sequence. `msgId` makes a repeat of the same write a no-op within the
   *  stream's window. A `silent` stream does not answer its publishers, so it
   *  cannot confirm an append; it is written by publishing. */
  append(subject: string, data: Uint8Array, opts?: { msgId?: string }): Promise<number>;
  /** One message by sequence. Throws when there is none at that sequence. */
  read(seq: number): Promise<StreamMessage>;
  /** Up to `max` messages from sequence `seq` on. */
  readFrom(seq: number, opts: ReadFromOptions): AsyncIterable<StreamMessage>;
  /** Remove one message. */
  removeMessage(seq: number): Promise<void>;
  /** Remove several messages at once, where the binding holds a stream's
   *  messages in more than one place and removing them one by one would walk
   *  the other place for each (on RabbitMQ, an agent's mailbox queue). Returns
   *  how many were removed. A binding without it removes them one by one. */
  removeMessages?(seqs: number[]): Promise<number>;
  /** Remove every message and keep the stream. */
  purge(): Promise<void>;
  /** Remove the stream. */
  destroy(): Promise<void>;
  /** A durable consumer by name, made on first use. */
  consume(durable: string, opts?: ConsumeOptions): Promise<StreamConsumer>;
  /** Where a durable consumer stands. Throws when there is no such consumer. */
  consumerState(durable: string): Promise<ConsumerState>;
}

/** A stream the layer makes itself, with fixed settings (MESH_EVENTS and the
 *  rest). */
export interface SingleStream extends StreamStore {
  /** Make it when it is missing and put back what must not drift. False when
   *  it cannot be used; the reason is logged. */
  ensure(): Promise<boolean>;
}

/** One line of a family's roster. */
export interface StreamSummary {
  name: string;
  /** The member's id: the agent's key, the room's id. */
  id: string;
  state: StreamState;
}

/** A family of streams, one per member, made and removed with their member. */
export interface StreamFamily {
  member(id: string): StreamStore;
  /** Every member stream that exists now. */
  list(): AsyncIterable<StreamSummary>;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/** One message as a subscriber gets it. `respond` answers on `reply`, when the
 *  sender asked for an answer (request-reply); it says whether it could. */
export interface BusMessage {
  readonly subject: string;
  readonly data: Uint8Array;
  readonly reply?: string;
  respond(data?: Uint8Array): boolean;
}

/** A subscription's messages, until `unsubscribe`. */
export interface BusSubscription extends AsyncIterable<BusMessage> {
  unsubscribe(): void;
}

export interface PublishOptions {
  /** Where an answer should go (the relay of a request through a service). */
  reply?: string;
  /** The message's id for publish-side deduplication by a stream that holds
   *  the subject (on NATS, the `Nats-Msg-Id` header). */
  msgId?: string;
}

export interface RequestOptions {
  timeout: number;
  /** For a receiver listening now only, never kept for one that is away (the
   *  registry's liveness probe). A plain request on NATS; on RabbitMQ, where an
   *  agent's mailbox queue holds its inbox subject, the request expires in the
   *  queue unless a consumer takes it at once. */
  live?: boolean;
}

export interface SubscribeOptions {
  /** Members of one queue share the subject's messages: each goes to one of
   *  them (shared/queue-groups.ts). */
  queue?: string;
}

/**
 * The core services' own publish, subscribe and request-reply. Subjects are
 * the mesh's (`mesh.*`, SPEC §14); a binding maps them to its own routing
 * (on RabbitMQ, routing keys on a topic exchange).
 */
export interface Messaging {
  publish(subject: string, data?: Uint8Array, opts?: PublishOptions): void;
  subscribe(subject: string, opts?: SubscribeOptions): BusSubscription;
  /** Send and wait for one answer, or throw after `timeout` milliseconds (or
   *  at once when nobody listens on the subject). */
  request(subject: string, data: Uint8Array, opts: RequestOptions): Promise<BusMessage>;
  /** A fresh private subject to take answers on. */
  newInbox(): string;
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

/**
 * Where the core's stores live. A service asks for a store by its name in the
 * layer (storage/catalog.ts); the binding creates it on first use with the
 * catalog's settings and opens it after that.
 */
export interface Storage {
  /** The binding that holds the stores, for logs and the status answer. */
  readonly binding: string;
  keyed(name: KeyedStoreName): Promise<KeyedStore>;
  stream(name: SingleStreamName): SingleStream;
  streams(family: StreamFamilyName): StreamFamily;
  /** The binding's own blob store of this name. A service opens a blob store
   *  through `openBlobStore` (storage/blobs.ts), which honours the operator's
   *  choice of a folder or Google Cloud Storage instead. */
  blobs(name: BlobStoreName): Promise<BlobStore>;
}

/** Raised when a keyed store cannot be listed completely. */
export class KeyedListError extends Error {
  constructor(
    readonly bucket: string,
    message: string,
  ) {
    super(`[kv] cannot enumerate '${bucket}': ${message}`);
    this.name = "KvEnumerationError";
  }
}
