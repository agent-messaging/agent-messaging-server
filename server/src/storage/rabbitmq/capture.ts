/**
 * What fills the streams on RabbitMQ (step 9 of
 * docs/agent-messaging-server-plan.md).
 *
 * On JetStream a stream captures what is published on its subjects by itself.
 * Here one durable queue, `ams.capture`, is bound to every stream's subjects,
 * and the pump consumes it and writes each message into every stream whose
 * subjects it matches (a domain event can belong to MESH_EVENTS, a room's
 * record and MESH_METERING at once). A message is acknowledged to RabbitMQ
 * only once Postgres has it, so a crash between the two writes it again, and
 * the stream's deduplication window drops the repeat.
 *
 * Deduplication is on receipt (SPEC §18.1, §22.2): the key is the envelope's
 * `(from, id)` when the message is a signed envelope, else the publisher's
 * message id. The queue is a single-active-consumer queue, so however many
 * core processes run a pump, one writes at a time and each stream keeps the
 * order the queue had.
 */
import type { Channel, ConsumeMessage } from "amqplib";
import type { Sql } from "../postgres/sql.js";
import { notices } from "../postgres/notices.js";
import type { AmqpLink } from "./link.js";
import { bindingKey, cameOnSubject, LIVE_EXPIRATION, MESH_EXCHANGE, subjectMatches } from "./subjects.js";

export const CAPTURE_QUEUE = "ams.capture";

const td = new TextDecoder();

/** The deduplication key of a captured message. */
export function dedupKey(content: Uint8Array, messageId: string | undefined): string | null {
  if (content.length > 1 && content[0] === 0x7b /* { */) {
    try {
      const env = JSON.parse(td.decode(content)) as { from?: unknown; id?: unknown };
      if (typeof env.from === "string" && typeof env.id === "string" && env.from && env.id) {
        // §22.2: a repeat is the same sender's same id. A publisher's message
        // id that names something else wins, so `append`'s own id still holds.
        if (messageId === undefined || messageId === env.id) return `${env.from}|${env.id}`;
      }
    } catch {
      /* not an envelope */
    }
  }
  return messageId ?? null;
}

interface Route {
  stream: string;
  subjects: string[];
}

/** Every subject held by any stream, for the capture bindings. */
async function routes(sql: Sql): Promise<Route[]> {
  const r = await sql.query<{ name: string; subjects: string[] }>("select name, subjects from ams_streams");
  return r.rows.map((x) => ({ stream: x.name, subjects: x.subjects ?? [] }));
}

/** Declare the capture queue and bind every stream's subjects to it. */
export async function ensureCaptureBindings(ch: Channel, sql: Sql): Promise<void> {
  await ch.assertQueue(CAPTURE_QUEUE, { durable: true, arguments: { "x-single-active-consumer": true } });
  const keys = new Set<string>();
  for (const r of await routes(sql)) for (const s of r.subjects) keys.add(bindingKey(s));
  for (const k of keys) await ch.bindQueue(CAPTURE_QUEUE, MESH_EXCHANGE, k);
}

export async function bindCapture(ch: Channel, subjects: string[]): Promise<void> {
  await ch.assertQueue(CAPTURE_QUEUE, { durable: true, arguments: { "x-single-active-consumer": true } });
  for (const s of subjects) await ch.bindQueue(CAPTURE_QUEUE, MESH_EXCHANGE, bindingKey(s));
}

/** Unbind the subjects no stream holds any more. */
export async function unbindCapture(ch: Channel, sql: Sql, subjects: string[]): Promise<void> {
  const still = new Set<string>();
  for (const r of await routes(sql)) for (const s of r.subjects) still.add(s);
  for (const s of subjects) if (!still.has(s)) await ch.unbindQueue(CAPTURE_QUEUE, MESH_EXCHANGE, bindingKey(s)).catch(() => undefined);
}

/** Tell every pump that the streams changed (their routes are cached). */
export async function announceRoutes(sql: Sql): Promise<void> {
  await sql.query("select pg_notify('ams_routes', 'changed')");
}

export class CapturePump {
  private table: Route[] = [];
  private channel: Channel | null = null;
  private stopped = false;
  private unlisten: (() => void) | null = null;
  private refresh: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly link: AmqpLink,
    private readonly sql: Sql,
  ) {}

  async start(): Promise<void> {
    await this.reload();
    this.unlisten = await notices(this.sql, "ams_routes").on("changed", () => void this.reload());
    this.refresh = setInterval(() => void this.reload(), 30_000);
    this.refresh.unref?.();
    await this.consume(false);
    this.link.onReconnect(() => this.consume(true));
  }

  private async reload(): Promise<void> {
    try {
      this.table = await routes(this.sql);
    } catch (err) {
      console.error("[capture] could not read the streams:", err instanceof Error ? err.message : err);
    }
  }

  private async consume(restoring: boolean): Promise<void> {
    if (this.stopped) return;
    const ch = await this.link.channel(restoring);
    this.channel = ch;
    await ensureCaptureBindings(ch, this.sql);
    await ch.prefetch(64);
    await ch.consume(CAPTURE_QUEUE, (m) => {
      if (m) void this.write(ch, m);
    });
  }

  private matching(subject: string): string[] {
    return this.table.filter((r) => r.subjects.some((p) => subjectMatches(p, subject))).map((r) => r.stream);
  }

  // One message at a time, in the order the queue hands them over.
  private queue: Promise<void> = Promise.resolve();

  private write(ch: Channel, m: ConsumeMessage): Promise<void> {
    this.queue = this.queue.then(async () => {
      const subject = m.fields.routingKey;
      // Put into the capture queue by its name, not sent on a subject: no
      // stream keeps it (subjects.ts, cameOnSubject).
      if (!cameOnSubject(m)) {
        ch.ack(m);
        return;
      }
      // A live request (the registry's probe) is for a receiver listening
      // now and is kept nowhere, the record of a mailbox included.
      if (m.properties.expiration === LIVE_EXPIRATION) {
        ch.ack(m);
        return;
      }
      try {
        let streams = this.matching(subject);
        if (!streams.length) {
          // A stream made a moment ago in another process: read the routes again once.
          await this.reload();
          streams = this.matching(subject);
        }
        const key = dedupKey(m.content, m.properties.messageId as string | undefined);
        for (const s of streams) {
          try {
            await this.sql.query("select ams_stream_append($1, $2, $3, $4)", [s, subject, m.content, key]);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // A full stream that refuses new messages, or one removed since:
            // the message is not that stream's to keep.
            if (!/maximum messages|stream not found/.test(msg)) throw err;
          }
        }
        ch.ack(m);
      } catch (err) {
        console.error(`[capture] could not store a message on ${subject}; it will come again:`, err instanceof Error ? err.message : err);
        try {
          ch.nack(m, false, true);
        } catch {
          /* the channel is gone; RabbitMQ hands it out again */
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    });
    return this.queue;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refresh) clearInterval(this.refresh);
    this.unlisten?.();
    await this.queue;
    await this.channel?.close().catch(() => undefined);
  }
}
