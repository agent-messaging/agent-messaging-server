/**
 * Streams on JetStream.
 *
 * Each stream is the JetStream stream it always was, made with the settings it
 * always had: the single streams through the ensure functions moved here with
 * the storage layer (events-stream.ts, feed-stream.ts, metering-stream.ts,
 * trace-stream.ts), and the family members (an agent's mailbox, a room's
 * record) from the configs their services built before (`mailboxConfig`,
 * `roomRecordConfig`). Each method makes the call the service made, so a
 * stream that already holds messages is read and consumed as before.
 */
import type { ConsumerConfig, JetStreamClient, JetStreamManager, JsMsg, StreamInfo } from "nats";
import { AckPolicy, DeliverPolicy, DiscardPolicy, RetentionPolicy, StorageType } from "nats";
import { STREAM_FAMILIES, type SingleStreamName, type StreamFamilyName } from "../catalog.js";
import type {
  ConsumeOptions,
  ConsumerState,
  ReadFromOptions,
  SingleStream,
  StreamConsumer,
  StreamFamily,
  StreamMessage,
  StreamSpec,
  StreamState,
  StreamStore,
  StreamSummary,
} from "../types.js";
import { jsReplicas } from "./kv.js";
import { ensureEventsStream, EVENTS_STREAM } from "./events-stream.js";
import { ensureFeedStream } from "./feed-stream.js";
import { ensureMeteringStream } from "./metering-stream.js";
import { ensureTraceStream } from "./trace-stream.js";

/** What a stream needs from the binding: the manager, and the client for
 *  consumers. Both asked for only when a call needs them. */
export interface JetStreamAccess {
  manager(): Promise<JetStreamManager>;
  readonly js: JetStreamClient;
}

/** The config each StreamState was read from, for `reconfigure`. */
const rawConfig = new WeakMap<StreamState, Record<string, unknown>>();

const isNotFound = (err: unknown) => /not found/i.test(err instanceof Error ? err.message : String(err));

function stateOf(info: StreamInfo, repairs: string[]): StreamState {
  const st = (info.state ?? {}) as Partial<StreamInfo["state"]>;
  const firstTs = st.first_ts ? new Date(st.first_ts) : null;
  const state: StreamState = {
    messages: st.messages ?? 0,
    bytes: st.bytes ?? 0,
    firstSeq: st.first_seq ?? 0,
    lastSeq: st.last_seq ?? 0,
    firstTime: firstTs,
    lastAt: st.last_ts ?? null,
    created: info.created ? new Date(info.created) : null,
    subjects: info.config?.subjects ?? [],
    repairs,
  };
  rawConfig.set(state, (info.config ?? {}) as unknown as Record<string, unknown>);
  return state;
}

/** One JetStream stream by name. */
export class JetStreamStream implements StreamStore {
  constructor(
    protected readonly access: JetStreamAccess,
    readonly name: string,
    /** Builds the config for `create`, for a family member. */
    private readonly configFor: ((name: string, spec: StreamSpec) => Record<string, unknown>) | null = null,
    /** Settings that must hold, and the patch that puts each back. */
    private readonly repairsOf: (config: Record<string, unknown>) => Array<{ word: string; patch: Record<string, unknown> }> = () => [],
  ) {}

  async info(): Promise<StreamState | null> {
    const jsm = await this.access.manager();
    let info: StreamInfo;
    try {
      info = await jsm.streams.info(this.name);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    return stateOf(info, this.repairsOf((info.config ?? {}) as unknown as Record<string, unknown>).map((r) => r.word));
  }

  async create(spec: StreamSpec): Promise<void> {
    if (!this.configFor) throw new Error(`${this.name} is made by ensure(), not create()`);
    const jsm = await this.access.manager();
    const config = this.configFor(this.name, spec);
    await jsm.streams.add(config as never);
    // A stream that sources its slice of MESH_EVENTS (a room's record) holds
    // nothing until its source is running, about a fifth of a second after it
    // is made. MESH_EVENTS keeps a message only while a consumer has an
    // interest in it (SPEC §18.3), so on a server with no other consumer there
    // (the Agent Messaging Server alone) what a room's first members post in
    // that moment would never reach the record. Wait until every source is
    // active, at most five seconds, before the room is handed out.
    if (Array.isArray(config.sources) && config.sources.length) {
      const until = Date.now() + 5000;
      for (;;) {
        const si = await Promise.resolve().then(() => jsm.streams.info(this.name)).catch(() => null);
        // A broker that does not report its sources cannot be waited on.
        if (!si || !Array.isArray(si.sources)) break;
        const sources = si.sources as Array<{ active?: number }>;
        if (sources.every((s) => typeof s.active === "number" && s.active >= 0)) break;
        if (Date.now() >= until) {
          console.warn(`[streams] ${this.name}: its source is not running after 5 s; what is published before it starts is not recorded`);
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  async reconfigure(basis: StreamState, change: { subjects?: string[]; repair?: boolean } = {}): Promise<void> {
    const config = rawConfig.get(basis) ?? {};
    let patch: Record<string, unknown> = { ...config };
    if (change.repair) for (const r of this.repairsOf(config)) patch = { ...patch, ...r.patch };
    if (change.subjects) patch.subjects = change.subjects;
    const jsm = await this.access.manager();
    await jsm.streams.update(this.name, patch as never);
  }

  async append(subject: string, data: Uint8Array, opts: { msgId?: string } = {}): Promise<number> {
    const ack = await this.access.js.publish(subject, data, opts.msgId ? { msgID: opts.msgId, expect: { streamName: this.name } } : { expect: { streamName: this.name } });
    return ack.seq;
  }

  async read(seq: number): Promise<StreamMessage> {
    const jsm = await this.access.manager();
    const m = await jsm.streams.getMessage(this.name, { seq });
    return m as unknown as StreamMessage;
  }

  async *readFrom(seq: number, opts: ReadFromOptions): AsyncIterable<StreamMessage> {
    // An ordered consumer from `seq`, fetched once: what the rooms service's
    // replay and dossier did before.
    const consumer = await this.access.js.consumers.get(this.name, { opt_start_seq: seq } as never);
    const batch = await consumer.fetch({ max_messages: opts.max, expires: opts.waitMs });
    for await (const m of batch) yield messageOf(m);
  }

  async removeMessage(seq: number): Promise<void> {
    const jsm = await this.access.manager();
    await jsm.streams.deleteMessage(this.name, seq, false);
  }

  async purge(): Promise<void> {
    const jsm = await this.access.manager();
    await jsm.streams.purge(this.name);
  }

  async destroy(): Promise<void> {
    const jsm = await this.access.manager();
    await jsm.streams.delete(this.name);
  }

  async consume(durable: string, opts: ConsumeOptions = {}): Promise<StreamConsumer> {
    const jsm = await this.access.manager();
    try {
      await jsm.consumers.info(this.name, durable);
    } catch {
      const config: Partial<ConsumerConfig> = { durable_name: durable, ack_policy: AckPolicy.Explicit };
      if (opts.from === "all") config.deliver_policy = DeliverPolicy.All;
      if (opts.filter !== undefined) config.filter_subject = opts.filter;
      await jsm.consumers.add(this.name, config);
    }
    const consumer = await this.access.js.consumers.get(this.name, durable);
    return (await consumer.consume()) as unknown as StreamConsumer;
  }

  async consumerState(durable: string): Promise<ConsumerState> {
    const jsm = await this.access.manager();
    const ci = await jsm.consumers.info(this.name, durable);
    return { pending: ci.num_pending, ackPending: ci.num_ack_pending, ackFloor: ci.ack_floor?.stream_seq ?? 0 };
  }
}

/** A message from a fetch, with its arrival time read only when asked for. */
function messageOf(m: JsMsg): StreamMessage {
  return {
    subject: m.subject,
    data: m.data,
    seq: m.seq,
    get time() {
      return new Date(Math.floor(m.info.timestampNanos / 1_000_000));
    },
  };
}

const ENSURE: Record<SingleStreamName, (jsm: JetStreamManager) => Promise<boolean>> = {
  MESH_EVENTS: ensureEventsStream,
  MESH_FEED: ensureFeedStream,
  MESH_METERING: ensureMeteringStream,
  MESH_TRACE: async (jsm) => {
    await ensureTraceStream(jsm);
    return true;
  },
};

export class JetStreamSingleStream extends JetStreamStream implements SingleStream {
  constructor(access: JetStreamAccess, private readonly stream: SingleStreamName) {
    super(access, stream);
  }

  async ensure(): Promise<boolean> {
    return ENSURE[this.stream](await this.access.manager());
  }
}

// ── Families ────────────────────────────────────────────────────────────────

/**
 * An agent's mailbox, as the registry's inbox buffer made it: limits
 * retention, discard-old, on file, and no_ack, because without it JetStream
 * answers every captured request's reply subject with a pub-ack that races the
 * agent's real reply.
 */
export function mailboxConfig(name: string, spec: StreamSpec, replicas: number) {
  return {
    name,
    subjects: spec.subjects,
    retention: RetentionPolicy.Limits,
    discard: spec.discard === "new" ? DiscardPolicy.New : DiscardPolicy.Old,
    storage: StorageType.File,
    max_age: (spec.maxAgeMs ?? 0) * 1_000_000, // ns
    max_bytes: spec.maxBytes,
    num_replicas: replicas,
    no_ack: spec.silent === true,
  };
}

/** Whether every subject is under `mesh.event.>`, which MESH_EVENTS owns. */
const underEvents = (subjects: string[]) => subjects.length > 0 && subjects.every((s) => s.startsWith("mesh.event."));

/**
 * A durable room's record, as the rooms service made it. A room whose subjects
 * are under `mesh.event.>` SOURCES its slice from MESH_EVENTS, because
 * nats-server refuses two streams binding overlapping subjects and MESH_EVENTS
 * owns that space since the 2026-08-18 migration (events-stream.ts); a room on
 * the enforced `mesh.aclroom.*` namespace binds its subjects itself.
 */
export function roomRecordConfig(name: string, spec: StreamSpec) {
  const base = {
    name,
    max_msgs: spec.maxMsgs,
    max_bytes: spec.maxBytes,
    max_age: (spec.maxAgeMs ?? 0) * 1_000_000,
    discard: spec.discard as never, // a full record stops recording; it never rolls off its own genesis
    storage: "file" as never,
    num_replicas: jsReplicas(),
  };
  if (!underEvents(spec.subjects)) return { ...base, subjects: spec.subjects };
  return { ...base, sources: spec.subjects.map((s) => ({ name: EVENTS_STREAM, filter_subject: s })) };
}

export class JetStreamFamily implements StreamFamily {
  private readonly prefix: string;
  /** Read when the family is opened, which is at boot: a replica count that
   *  cannot be used throws there, not on every member it would make. */
  private readonly replicas: number | null;

  constructor(
    private readonly access: JetStreamAccess,
    private readonly family: StreamFamilyName,
  ) {
    this.prefix = STREAM_FAMILIES[family].prefix;
    this.replicas = family === "MESH_INBOX_<agent>" ? jsReplicas() : null;
  }

  member(id: string): StreamStore {
    const name = `${this.prefix}${id}`;
    if (this.family === "MESH_INBOX_<agent>") {
      const replicas = this.replicas!;
      return new JetStreamStream(
        this.access,
        name,
        (n, spec) => mailboxConfig(n, spec, replicas),
        // A mailbox made before the no_ack fix breaks live request-reply.
        (config) => (config.no_ack ? [] : [{ word: "no_ack enabled", patch: { no_ack: true } }]),
      );
    }
    return new JetStreamStream(this.access, name, (n, spec) => roomRecordConfig(n, spec));
  }

  async *list(): AsyncIterable<StreamSummary> {
    const jsm = await this.access.manager();
    for await (const si of jsm.streams.list()) {
      const name = si.config?.name;
      if (!name || !name.startsWith(this.prefix)) continue;
      yield { name, id: name.slice(this.prefix.length), state: stateOf(si, []) };
    }
  }
}
