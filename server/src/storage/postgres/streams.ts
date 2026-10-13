/**
 * Streams on Postgres (step 9 of docs/agent-messaging-server-plan.md).
 *
 * A stream is a row in `ams_streams` and its messages in
 * `ams_stream_messages`, by sequence. `ams_stream_append` (schema.ts) writes a
 * message, applies the stream's limits and drops a repeat of a message id
 * inside the deduplication window, all in one call.
 *
 * What fills a stream is the binding's business, not this file's: on RabbitMQ
 * a capture queue bound to each stream's subjects feeds every published
 * message in (storage/rabbitmq/capture.ts), which the `StreamHooks` tell when
 * a stream's subjects change. `append` writes directly and hands the message
 * to the hooks so live subscribers see it too.
 *
 * A durable consumer keeps its place in `ams_stream_consumers`: the floor
 * below which every message it was handed is acknowledged, and the
 * acknowledged sequences above it. Within the process that runs it, a message
 * handed out and not acknowledged in 30 seconds is handed out again, and
 * `nak(delay)` hands it out again after the delay. A consumer that restarts
 * starts again from its floor and skips what it had acknowledged above it.
 */
import { STREAM_FAMILIES, type SingleStreamName, type StreamFamilyName } from "../catalog.js";
import type {
  ConsumeOptions,
  ConsumerState,
  ReadFromOptions,
  SingleStream,
  StreamConsumer,
  StreamDelivery,
  StreamFamily,
  StreamMessage,
  StreamSpec,
  StreamState,
  StreamStore,
  StreamSummary,
} from "../types.js";
import { notices } from "./notices.js";
import type { Sql } from "./sql.js";

/** What a stream's binding is told when its subjects change or it goes. */
export interface StreamHooks {
  /** The stream was made, or now holds these subjects. */
  subjects?(stream: StreamRef, subjects: string[], previous: string[]): Promise<void>;
  /** The stream was removed. */
  destroyed?(stream: StreamRef, subjects: string[]): Promise<void>;
  /** The stream's messages were removed (purge). */
  purged?(stream: StreamRef): Promise<void>;
  /** These messages were removed from the stream (by `removeMessage` or
   *  `removeMessages`): take the same messages out of wherever else the
   *  binding holds them (on RabbitMQ, an agent's mailbox queue). */
  removed?(stream: StreamRef, messages: Uint8Array[]): Promise<void>;
  /** `append` wrote a message: publish it for live subscribers. */
  appended?(subject: string, data: Uint8Array, msgId: string): void;
  /** A consumer's place the binding keeps itself (on RabbitMQ, an agent's own
   *  mailbox queue). Null when it is not the binding's. */
  consumerState?(stream: StreamRef, durable: string): Promise<ConsumerState | null>;
}

export interface StreamRef {
  name: string;
  family: StreamFamilyName | null;
  member: string | null;
}

/** The single streams' settings on Postgres. MESH_EVENTS and MESH_FEED keep a
 *  day, as on JetStream; there is no interest retention here, so they keep it
 *  whether or not anything consumes them. */
const SINGLE_SPECS: Record<SingleStreamName, () => (StreamSpec & { enabled: boolean }) > = {
  MESH_EVENTS: () => ({ subjects: ["mesh.event.>"], maxAgeMs: 24 * 3600_000, discard: "old", enabled: true }),
  MESH_FEED: () => ({ subjects: ["mesh.feed.*.*"], maxAgeMs: 24 * 3600_000, discard: "old", enabled: true }),
  MESH_METERING: () => {
    const days = Number(process.env.METERING_MAX_AGE_DAYS ?? "");
    return { subjects: ["mesh.event.metering.usage"], maxAgeMs: (Number.isFinite(days) && days > 0 ? days : 400) * 86_400_000, discard: "old", enabled: true };
  },
  MESH_TRACE: () => ({
    subjects: ["mesh.trace.>"],
    maxAgeMs: Number(process.env.TRACE_STREAM_MAX_AGE_MS ?? 6 * 3600_000),
    maxBytes: Number(process.env.TRACE_STREAM_MAX_BYTES ?? 256 * 1024 * 1024),
    discard: "old",
    enabled: process.env.TRACE_STREAM_ENABLED === "1",
  }),
};

/** A NATS-style subject pattern (`*` one token, `>` the rest) as an anchored
 *  Postgres regular expression. */
export function subjectRegex(pattern: string): string {
  const tokens = pattern.split(".");
  const out = tokens.map((t, i) => {
    if (t === ">" && i === tokens.length - 1) return ".+";
    if (t === "*") return "[^.]+";
    return t.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  });
  return `^${out.join("\\.")}$`;
}

interface MessageRow {
  seq: string | number;
  subject: string;
  data: Uint8Array;
  time: Date | string;
}

const bytes = (d: Uint8Array): Uint8Array => new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
const asDate = (t: Date | string): Date => (t instanceof Date ? t : new Date(t));

function messageOf(r: MessageRow): StreamMessage {
  return { subject: r.subject, data: bytes(r.data), seq: Number(r.seq), time: asDate(r.time) };
}

interface StreamRow {
  name: string;
  family: string | null;
  member: string | null;
  subjects: string[];
  last_seq: string | number;
  messages: string | number;
  bytes: string | number;
  created: Date | string;
  first_seq: string | number | null;
  first_time: Date | string | null;
  last_time: Date | string | null;
}

const STATE_SQL = `select s.name, s.family, s.member, s.subjects, s.last_seq, s.messages, s.bytes, s.created,
    (select min(seq) from ams_stream_messages m where m.stream = s.name) as first_seq,
    (select time from ams_stream_messages m where m.stream = s.name order by seq asc limit 1) as first_time,
    (select time from ams_stream_messages m where m.stream = s.name order by seq desc limit 1) as last_time
  from ams_streams s`;

function stateOf(r: StreamRow): StreamState {
  const last = Number(r.last_seq);
  return {
    messages: Number(r.messages),
    bytes: Number(r.bytes),
    firstSeq: r.first_seq === null ? (last > 0 ? last + 1 : 0) : Number(r.first_seq),
    lastSeq: last,
    firstTime: r.first_time === null ? null : asDate(r.first_time),
    lastAt: r.last_time === null ? null : asDate(r.last_time).toISOString(),
    created: asDate(r.created),
    subjects: r.subjects ?? [],
    repairs: [],
  };
}

const notFound = (what: string) => new Error(`${what} not found`);

/** Consumers running in this process, by stream and durable, so
 *  `consumerState` can count what they have handed out. */
const running = new Map<string, PostgresConsumer>();

export class PostgresStream implements StreamStore {
  constructor(
    protected readonly sql: Sql,
    readonly name: string,
    protected readonly ref: StreamRef,
    protected readonly hooks: StreamHooks = {},
  ) {}

  async info(): Promise<StreamState | null> {
    const r = await this.sql.query<StreamRow>(`${STATE_SQL} where s.name = $1`, [this.name]);
    return r.rows[0] ? stateOf(r.rows[0]) : null;
  }

  async create(spec: StreamSpec): Promise<void> {
    await this.upsert(spec, false);
  }

  /** Make the stream, or with `settle` put its settings back to `spec`. */
  protected async upsert(spec: StreamSpec, settle: boolean): Promise<void> {
    const before = await this.sql.query<{ subjects: string[] }>("select subjects from ams_streams where name = $1", [this.name]);
    const previous = before.rows[0]?.subjects ?? [];
    const params = [this.name, this.ref.family, this.ref.member, spec.subjects, spec.maxAgeMs ?? null, spec.maxBytes ?? null, spec.maxMsgs ?? null, spec.discard];
    await this.sql.query(
      `insert into ams_streams (name, family, member, subjects, max_age_ms, max_bytes, max_msgs, discard)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (name) do ${settle
           ? "update set subjects = excluded.subjects, max_age_ms = excluded.max_age_ms, max_bytes = excluded.max_bytes, max_msgs = excluded.max_msgs, discard = excluded.discard"
           : "nothing"}`,
      params,
    );
    const subjects = before.rows[0] && !settle ? previous : spec.subjects;
    await this.hooks.subjects?.(this.ref, subjects, previous);
  }

  async reconfigure(basis: StreamState, change: { subjects?: string[]; repair?: boolean } = {}): Promise<void> {
    if (!change.subjects) return; // nothing on Postgres drifts the way JetStream's settings can
    const r = await this.sql.query("update ams_streams set subjects = $2 where name = $1", [this.name, change.subjects]);
    if (r.rowCount === 0) throw notFound(`stream ${this.name}`);
    await this.hooks.subjects?.(this.ref, change.subjects, basis.subjects);
  }

  async append(subject: string, data: Uint8Array, opts: { msgId?: string } = {}): Promise<number> {
    const msgId = opts.msgId ?? `ams-${crypto.randomUUID()}`;
    const r = await this.sql.query<{ seq: string }>("select ams_stream_append($1, $2, $3, $4) as seq", [
      this.name,
      subject,
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      msgId,
    ]);
    this.hooks.appended?.(subject, data, msgId);
    return Number(r.rows[0]!.seq);
  }

  async read(seq: number): Promise<StreamMessage> {
    const r = await this.sql.query<MessageRow>("select seq, subject, data, time from ams_stream_messages where stream = $1 and seq = $2", [this.name, seq]);
    if (!r.rows[0]) throw new Error(`no message found at sequence ${seq} of ${this.name}`);
    return messageOf(r.rows[0]);
  }

  async *readFrom(seq: number, opts: ReadFromOptions): AsyncIterable<StreamMessage> {
    // Postgres answers with what the stream holds now; it does not wait for
    // more to arrive (the callers read a record that is already written).
    const r = await this.sql.query<MessageRow>(
      "select seq, subject, data, time from ams_stream_messages where stream = $1 and seq >= $2 order by seq limit $3",
      [this.name, seq, opts.max],
    );
    for (const row of r.rows) yield messageOf(row);
  }

  async removeMessage(seq: number): Promise<void> {
    const r = await this.sql.query<{ data: Uint8Array }>("delete from ams_stream_messages where stream = $1 and seq = $2 returning data", [this.name, seq]);
    if (r.rowCount === 0) throw new Error(`no message found at sequence ${seq} of ${this.name}`);
    await this.hooks.removed?.(this.ref, r.rows.map((x) => bytes(x.data)));
  }

  async removeMessages(seqs: number[]): Promise<number> {
    if (!seqs.length) return 0;
    const r = await this.sql.query<{ data: Uint8Array }>(
      "delete from ams_stream_messages where stream = $1 and seq = any($2::bigint[]) returning data",
      [this.name, seqs],
    );
    if (r.rows.length) await this.hooks.removed?.(this.ref, r.rows.map((x) => bytes(x.data)));
    return r.rows.length;
  }

  async purge(): Promise<void> {
    await this.sql.query("delete from ams_stream_messages where stream = $1", [this.name]);
    await this.hooks.purged?.(this.ref);
  }

  async destroy(): Promise<void> {
    const r = await this.sql.query<{ subjects: string[] }>("delete from ams_streams where name = $1 returning subjects", [this.name]);
    if (!r.rows[0]) throw notFound(`stream ${this.name}`);
    await this.sql.query("delete from ams_stream_messages where stream = $1", [this.name]);
    await this.sql.query("delete from ams_stream_consumers where stream = $1", [this.name]);
    await this.sql.query("select pg_notify('ams_stream', $1)", [this.name]);
    await this.hooks.destroyed?.(this.ref, r.rows[0].subjects ?? []);
  }

  async consume(durable: string, opts: ConsumeOptions = {}): Promise<StreamConsumer> {
    const exists = await this.sql.query("select 1 from ams_streams where name = $1", [this.name]);
    if (!exists.rows[0]) throw notFound(`stream ${this.name}`);
    await this.sql.query(
      "insert into ams_stream_consumers (stream, durable, filter) values ($1, $2, $3) on conflict do nothing",
      [this.name, durable, opts.filter ?? null],
    );
    const r = await this.sql.query<{ filter: string | null; ack_floor: string; acked: (string | number)[] }>(
      "select filter, ack_floor, acked from ams_stream_consumers where stream = $1 and durable = $2",
      [this.name, durable],
    );
    const row = r.rows[0]!;
    const filter = opts.filter ?? row.filter ?? null;
    if (filter !== row.filter) {
      await this.sql.query("update ams_stream_consumers set filter = $3 where stream = $1 and durable = $2", [this.name, durable, filter]);
    }
    const consumer = new PostgresConsumer(this.sql, this.name, durable, filter, Number(row.ack_floor), (row.acked ?? []).map(Number));
    await consumer.listen();
    running.set(`${this.name}\u0000${durable}`, consumer);
    consumer.onClose(() => {
      if (running.get(`${this.name}\u0000${durable}`) === consumer) running.delete(`${this.name}\u0000${durable}`);
    });
    return consumer;
  }

  async consumerState(durable: string): Promise<ConsumerState> {
    const own = await this.hooks.consumerState?.(this.ref, durable);
    if (own) return own;
    const r = await this.sql.query<{ filter: string | null; ack_floor: string; acked: (string | number)[] }>(
      "select filter, ack_floor, acked from ams_stream_consumers where stream = $1 and durable = $2",
      [this.name, durable],
    );
    const row = r.rows[0];
    if (!row) throw notFound(`consumer ${durable} on ${this.name}`);
    const live = running.get(`${this.name}\u0000${durable}`);
    const floor = live ? live.floor : Number(row.ack_floor);
    const acked = live ? [...live.acked] : (row.acked ?? []).map(Number);
    const params: unknown[] = [this.name, floor, acked];
    let where = "stream = $1 and seq > $2 and not (seq = any($3::bigint[]))";
    if (row.filter) {
      params.push(subjectRegex(row.filter));
      where += " and subject ~ $4";
    }
    const c = await this.sql.query<{ n: string }>(`select count(*) as n from ams_stream_messages where ${where}`, params);
    const ackPending = live ? live.outstandingCount : 0;
    return { pending: Math.max(0, Number(c.rows[0]!.n) - ackPending), ackPending, ackFloor: floor };
  }
}

/** How long a message handed out may go unacknowledged before it is handed
 *  out again (JetStream's ack wait for these consumers). */
const ACK_WAIT_MS = 30_000;
/** At most this many handed out and unacknowledged at once. */
const MAX_ACK_PENDING = 1000;
const FETCH = 200;
const POLL_MS = 2_000;

interface Outstanding {
  row: MessageRow;
  timer: ReturnType<typeof setTimeout> | null;
}

class PostgresConsumer implements StreamConsumer {
  /** Everything at or below this is acknowledged (or was never this
   *  consumer's, by its filter). */
  floor: number;
  /** Acknowledged sequences above the floor. */
  readonly acked: Set<number>;
  /** The highest sequence read from the stream. */
  private cursor: number;
  private readonly outstanding = new Map<number, Outstanding>();
  private readonly again: number[] = [];
  private stopped = false;
  private wake: (() => void) | null = null;
  private pending = false;
  private unlisten: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private readonly closers: (() => void)[] = [];
  private readonly regex: string | null;

  constructor(
    private readonly sql: Sql,
    private readonly stream: string,
    private readonly durable: string,
    filter: string | null,
    floor: number,
    acked: number[],
  ) {
    this.floor = floor;
    this.cursor = floor;
    this.acked = new Set(acked.filter((s) => s > floor));
    this.regex = filter ? subjectRegex(filter) : null;
  }

  get outstandingCount(): number {
    return this.outstanding.size;
  }

  onClose(fn: () => void): void {
    this.closers.push(fn);
  }

  async listen(): Promise<void> {
    this.unlisten = await notices(this.sql, "ams_stream").on(this.stream, () => this.kick());
    this.poll = setInterval(() => this.kick(), POLL_MS);
    this.poll.unref?.();
  }

  private kick(): void {
    this.pending = true;
    this.wake?.();
  }

  private delivery(row: MessageRow): StreamDelivery {
    const seq = Number(row.seq);
    let settled = false;
    return {
      subject: row.subject,
      data: bytes(row.data),
      seq,
      ack: () => {
        if (settled) return;
        settled = true;
        this.ack(seq);
      },
      nak: (delayMs?: number) => {
        if (settled) return;
        settled = true;
        this.redeliverAfter(seq, delayMs ?? 0);
      },
    };
  }

  private handOut(row: MessageRow): StreamDelivery {
    const seq = Number(row.seq);
    const prior = this.outstanding.get(seq);
    if (prior?.timer) clearTimeout(prior.timer);
    const o: Outstanding = { row, timer: null };
    o.timer = setTimeout(() => this.redeliverAfter(seq, 0), ACK_WAIT_MS);
    o.timer.unref?.();
    this.outstanding.set(seq, o);
    return this.delivery(row);
  }

  private redeliverAfter(seq: number, delayMs: number): void {
    const o = this.outstanding.get(seq);
    if (!o || this.stopped) return;
    if (o.timer) clearTimeout(o.timer);
    const due = () => {
      o.timer = null;
      if (!this.outstanding.has(seq) || this.stopped) return;
      this.again.push(seq);
      this.kick();
    };
    if (delayMs <= 0) due();
    else {
      o.timer = setTimeout(due, delayMs);
      o.timer.unref?.();
    }
  }

  private ack(seq: number): void {
    const o = this.outstanding.get(seq);
    if (o?.timer) clearTimeout(o.timer);
    this.outstanding.delete(seq);
    if (seq > this.floor) this.acked.add(seq);
    this.advance();
    this.kick();
  }

  /** Move the floor up to just below the oldest message still out. */
  private advance(): void {
    let floor = this.cursor;
    for (const s of this.outstanding.keys()) if (s - 1 < floor) floor = s - 1;
    for (const s of this.again) if (s - 1 < floor) floor = s - 1;
    if (floor > this.floor) {
      this.floor = floor;
      for (const s of this.acked) if (s <= floor) this.acked.delete(s);
    }
    this.save();
  }

  private save(): void {
    const floor = this.floor;
    const acked = [...this.acked];
    this.saving = this.saving
      .then(() =>
        this.sql.query("update ams_stream_consumers set ack_floor = $3, acked = $4 where stream = $1 and durable = $2", [
          this.stream,
          this.durable,
          floor,
          acked,
        ]),
      )
      .then(
        () => undefined,
        (err) => console.error(`[storage] could not save the place of ${this.durable} on ${this.stream}:`, err instanceof Error ? err.message : err),
      );
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamDelivery> {
    try {
      while (!this.stopped) {
        this.pending = false;
        if (this.again.length) {
          const seq = this.again.shift()!;
          const o = this.outstanding.get(seq);
          if (o) yield this.handOut(o.row);
          continue;
        }
        let read = 0;
        if (this.outstanding.size < MAX_ACK_PENDING) {
          const params: unknown[] = [this.stream, this.cursor, FETCH];
          let where = "stream = $1 and seq > $2";
          if (this.regex) {
            params.push(this.regex);
            where += " and subject ~ $4";
          }
          const r = await this.sql.query<MessageRow>(`select seq, subject, data, time from ams_stream_messages where ${where} order by seq limit $3`, params);
          read = r.rows.length;
          if (!read) {
            // Nothing new. If the stream itself is gone, the consumer ends, as on JetStream.
            const s = await this.sql.query("select last_seq from ams_streams where name = $1", [this.stream]);
            if (!s.rows[0]) return;
          }
          for (const row of r.rows) {
            if (this.stopped) return;
            const seq = Number(row.seq);
            this.cursor = Math.max(this.cursor, seq);
            if (this.acked.has(seq)) continue;
            yield this.handOut(row);
          }
          if (read) {
            this.advance();
            continue;
          }
        }
        if (this.stopped) return;
        if (!this.pending && !this.again.length) await new Promise<void>((res) => (this.wake = res));
        this.wake = null;
      }
    } finally {
      this.stop();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    this.unlisten?.();
    for (const o of this.outstanding.values()) if (o.timer) clearTimeout(o.timer);
    this.wake?.();
    for (const fn of this.closers) fn();
  }

  async close(): Promise<unknown> {
    this.stop();
    await this.saving;
    return undefined;
  }
}

export class PostgresSingleStream extends PostgresStream implements SingleStream {
  constructor(sql: Sql, private readonly single: SingleStreamName, hooks: StreamHooks = {}) {
    super(sql, single, { name: single, family: null, member: null }, hooks);
  }

  async ensure(): Promise<boolean> {
    const { enabled, ...spec } = SINGLE_SPECS[this.single]();
    if (!enabled) return true;
    try {
      await this.upsert(spec, true);
      return true;
    } catch (err) {
      console.error(`[storage] stream ${this.single} could not be made:`, err instanceof Error ? err.message : err);
      return false;
    }
  }
}

export class PostgresFamily implements StreamFamily {
  private readonly prefix: string;
  constructor(
    private readonly sql: Sql,
    private readonly family: StreamFamilyName,
    private readonly hooks: StreamHooks = {},
  ) {
    this.prefix = STREAM_FAMILIES[family].prefix;
  }

  member(id: string): StreamStore {
    const name = `${this.prefix}${id}`;
    return new PostgresStream(this.sql, name, { name, family: this.family, member: id }, this.hooks);
  }

  async *list(): AsyncIterable<StreamSummary> {
    const r = await this.sql.query<StreamRow>(`${STATE_SQL} where s.family = $1 order by s.name`, [this.family]);
    for (const row of r.rows) yield { name: row.name, id: row.member ?? row.name.slice(this.prefix.length), state: stateOf(row) };
  }
}
