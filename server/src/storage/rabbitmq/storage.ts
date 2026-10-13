/**
 * The storage layer on RabbitMQ with Postgres beside it (step 9 of
 * docs/agent-messaging-server-plan.md).
 *
 *  - Keyed records and streams are Postgres (storage/postgres/).
 *  - A stream is filled by the capture queue (capture.ts): when a stream is
 *    made or its subjects change, its subjects are bound to that queue.
 *  - An agent's mailbox (`MESH_INBOX_<agent>`) is also a durable RabbitMQ
 *    queue of the same name, bound to the agent's inbox subject, with the
 *    mailbox's age and size limits. That queue is what the agent's node
 *    consumes, with acknowledgment, so it holds mail while the agent is away
 *    and hands it over in order when it comes back (store and forward); the
 *    Postgres copy is the record the audit backstop reads. A purge empties
 *    both, removing messages (the kill switch's discard) removes them from
 *    both, and removing the mailbox removes both.
 *  - Blobs are a folder (MESH_BLOB_DIR, else `blobs` in MESH_DATA_DIR), or
 *    Google Cloud Storage when the operator sets it, as before.
 */
import type { Channel } from "amqplib";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ownFolderStore, type BlobStore } from "../blobs.js";
import type { BlobStoreName, KeyedStoreName, SingleStreamName, StreamFamilyName } from "../catalog.js";
import { STORAGE } from "../marks.js";
import type { PostgresKeyed } from "../postgres/keyed.js";
import type { Sql } from "../postgres/sql.js";
import { PostgresState } from "../postgres/state.js";
import type { PostgresFamily, PostgresSingleStream, StreamHooks, StreamRef } from "../postgres/streams.js";
import type { ConsumerState, Messaging, Storage } from "../types.js";
import { announceRoutes, bindCapture, unbindCapture } from "./capture.js";
import type { AmqpLink } from "./link.js";
import { bindingKey, MESH_EXCHANGE } from "./subjects.js";

const MAILBOXES: StreamFamilyName = "MESH_INBOX_<agent>";

/** The arguments of an agent's mailbox queue, from the mailbox's limits. */
export function mailboxQueueArgs(limits: { maxAgeMs: number | null; maxBytes: number | null }): Record<string, unknown> {
  const args: Record<string, unknown> = { "x-queue-type": "classic", "x-overflow": "drop-head" };
  if (limits.maxAgeMs && limits.maxAgeMs > 0) args["x-message-ttl"] = limits.maxAgeMs;
  if (limits.maxBytes && limits.maxBytes > 0) args["x-max-length-bytes"] = limits.maxBytes;
  return args;
}

const digest = (d: Uint8Array): string => createHash("sha256").update(d).digest("hex");

/**
 * Take these messages out of a queue (the kill switch's "discard what was
 * held", where the record's messages were just removed). AMQP 0-9-1 cannot
 * remove a message by position, so the queue is read through once on a
 * channel of its own: a message with the same bytes as one removed is
 * acknowledged, which removes it, and every other one is left unacknowledged,
 * so closing the channel puts it back where it was, in order. Only what is
 * waiting in the queue can be reached: a message the agent's node has already
 * taken is in its hands. Returns how many were removed.
 */
export async function removeFromQueue(ch: Channel, queue: string, messages: Uint8Array[]): Promise<number> {
  const gone = new Set(messages.map(digest));
  if (!gone.size) return 0;
  let held: number;
  try {
    held = (await ch.checkQueue(queue)).messageCount;
  } catch {
    return 0; // no queue: nothing held there
  }
  let removed = 0;
  for (let i = 0; i < held; i++) {
    const m = await ch.get(queue, { noAck: false });
    if (!m) break;
    if (gone.has(digest(m.content))) {
      ch.ack(m);
      removed++;
    }
  }
  return removed;
}

export class RabbitMqStorage implements Storage {
  readonly [STORAGE] = true;
  readonly binding = "rabbitmq";
  readonly state: PostgresState;

  constructor(
    readonly link: AmqpLink,
    readonly sql: Sql,
    private readonly messaging: Messaging,
    private readonly blobDir: string,
  ) {
    this.state = new PostgresState(sql, this.hooks());
  }

  /** Run `fn` on a channel of its own, closed afterwards: a refused queue
   *  operation closes its channel, and must not take anyone else's with it. */
  private async withChannel<T>(fn: (ch: Channel) => Promise<T>): Promise<T> {
    const ch = await this.link.channel();
    try {
      return await fn(ch);
    } finally {
      await ch.close().catch(() => undefined);
    }
  }

  private hooks(): StreamHooks {
    return {
      subjects: async (ref: StreamRef, subjects: string[], previous: string[]) => {
        await this.withChannel(async (ch) => {
          await bindCapture(ch, subjects);
          if (ref.family === MAILBOXES) await this.mailboxQueue(ch, ref, subjects, previous);
        });
        const dropped = previous.filter((s) => !subjects.includes(s));
        if (dropped.length) await this.withChannel((ch) => unbindCapture(ch, this.sql, dropped));
        await announceRoutes(this.sql);
      },
      destroyed: async (ref: StreamRef, subjects: string[]) => {
        await this.withChannel((ch) => unbindCapture(ch, this.sql, subjects));
        if (ref.family === MAILBOXES) await this.withChannel((ch) => ch.deleteQueue(ref.name).then(() => undefined)).catch(() => undefined);
        await announceRoutes(this.sql);
      },
      purged: async (ref: StreamRef) => {
        if (ref.family === MAILBOXES) await this.withChannel((ch) => ch.purgeQueue(ref.name).then(() => undefined)).catch(() => undefined);
      },
      removed: async (ref: StreamRef, messages: Uint8Array[]) => {
        if (ref.family === MAILBOXES) await this.withChannel((ch) => removeFromQueue(ch, ref.name, messages));
      },
      appended: (subject, data, msgId) => this.messaging.publish(subject, data, { msgId }),
      consumerState: async (ref: StreamRef, durable: string): Promise<ConsumerState | null> => {
        // The agent's own place in its mailbox is the queue itself: what is in
        // it has not been acknowledged by the agent's node.
        if (ref.family !== MAILBOXES || durable !== `inbox_${ref.member}`) return null;
        const q = await this.withChannel((ch) => ch.checkQueue(ref.name));
        return { pending: q.messageCount, ackPending: 0, ackFloor: 0 };
      },
    };
  }

  /** The agent's mailbox queue: made with the mailbox's limits, bound to its
   *  subjects, and unbound from the ones it no longer holds. */
  private async mailboxQueue(ch: Channel, ref: StreamRef, subjects: string[], previous: string[]): Promise<void> {
    const r = await this.sql.query<{ max_age_ms: string | null; max_bytes: string | null }>(
      "select max_age_ms, max_bytes from ams_streams where name = $1",
      [ref.name],
    );
    const row = r.rows[0];
    const args = mailboxQueueArgs({
      maxAgeMs: row?.max_age_ms == null ? null : Number(row.max_age_ms),
      maxBytes: row?.max_bytes == null ? null : Number(row.max_bytes),
    });
    await ch.assertQueue(ref.name, { durable: true, arguments: args });
    for (const s of subjects) await ch.bindQueue(ref.name, MESH_EXCHANGE, bindingKey(s));
    for (const s of previous) if (!subjects.includes(s)) await ch.unbindQueue(ref.name, MESH_EXCHANGE, bindingKey(s));
  }

  async open(): Promise<void> {
    await this.state.open();
  }

  keyed(name: KeyedStoreName): Promise<PostgresKeyed> {
    return Promise.resolve(this.state.keyed(name));
  }

  stream(name: SingleStreamName): PostgresSingleStream {
    return this.state.stream(name);
  }

  streams(family: StreamFamilyName): PostgresFamily {
    return this.state.streams(family);
  }

  blobs(name: BlobStoreName): Promise<BlobStore> {
    return ownFolderStore(join(this.blobDir, name));
  }
}
