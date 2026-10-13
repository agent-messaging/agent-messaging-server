/**
 * The keyed records and streams a binding keeps in Postgres (step 9 of
 * docs/agent-messaging-server-plan.md). The RabbitMQ binding's storage
 * (storage/rabbitmq/storage.ts) is built on this, adding the capture of
 * published messages into streams and the agents' mailbox queues through the
 * stream hooks.
 */
import { KEYED_STORES, type KeyedStoreName, type SingleStreamName, type StreamFamilyName } from "../catalog.js";
import { PostgresKeyed, sweepExpired } from "./keyed.js";
import { applySchema } from "./schema.js";
import type { Sql } from "./sql.js";
import { PostgresFamily, PostgresSingleStream, type StreamHooks } from "./streams.js";

/** How often expired values and aged-out stream messages are cleared away. */
const SWEEP_MS = 60_000;

export class PostgresState {
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly sql: Sql,
    private readonly hooks: StreamHooks = {},
  ) {}

  /** Apply the schema and start the sweep. */
  async open(): Promise<void> {
    await applySchema(this.sql);
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweeper.unref?.();
  }

  async sweep(): Promise<void> {
    try {
      await sweepExpired(this.sql);
      // Streams with an age limit lose old messages on every append; a stream
      // nobody writes to is aged here.
      await this.sql.query(
        `delete from ams_stream_messages m using ams_streams s
           where m.stream = s.name and coalesce(s.max_age_ms, 0) > 0
             and m.time < clock_timestamp() - s.max_age_ms * interval '1 millisecond'`,
      );
    } catch (err) {
      console.error("[storage] sweep failed:", err instanceof Error ? err.message : err);
    }
  }

  keyed(name: KeyedStoreName): PostgresKeyed {
    const spec: { history: number; ttlMs?: number } = KEYED_STORES[name];
    return new PostgresKeyed(this.sql, name, spec.ttlMs);
  }

  stream(name: SingleStreamName): PostgresSingleStream {
    return new PostgresSingleStream(this.sql, name, this.hooks);
  }

  streams(family: StreamFamilyName): PostgresFamily {
    return new PostgresFamily(this.sql, family, this.hooks);
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}
