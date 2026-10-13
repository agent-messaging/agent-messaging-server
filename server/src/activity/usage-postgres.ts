/**
 * The Postgres usage backend — shared counters, so a second service instance is
 * possible.
 *
 * Configured by `USAGE_DB_URL`, a plain Postgres connection URL. When it is unset
 * the store falls back to SQLite and nothing here is loaded (usage-store.ts). The
 * URL is the ONLY thing this file knows about the deployment: nothing here is
 * aware of any cloud, any instance, or any other database. Pointing it at the
 * same server as `METRICS_DB_URL` is fine — these are different tables — and
 * pointing it somewhere else is equally fine.
 *
 * ## Why an atomic upsert rather than per-instance rows
 *
 * Every write is `INSERT ... ON CONFLICT (key) DO UPDATE SET c = table.c +
 * EXCLUDED.c`. Postgres takes a row-level lock on the conflicting row for the
 * duration of the statement, so a second writer's upsert on the same key blocks
 * until the first commits and then re-reads the committed row before adding to
 * it. Two instances each adding 5 therefore leave 10, at the default READ
 * COMMITTED isolation, with no application-level locking, no SELECT-then-UPDATE
 * race to lose, and no SERIALIZABLE retry loop. It is also the same shape the
 * SQLite backend has always used, so the two agree on what a flush means.
 *
 * The alternative — one row per (agent, instance) summed on read — was rejected.
 * It needs a durable instance identity that nothing in this tree has; a container
 * that restarts under a new one would strand a row per (agent, instance, day)
 * forever, on the table with the highest cardinality; every read would become a
 * GROUP BY over N times the rows, including the `today()` the account console
 * hits on each page load; `first_seen`/`last_active` would stop being columns and
 * become MIN/MAX aggregates; and the delete path could no longer honestly report
 * `lifetime: 0 or 1`. The atomic upsert gives the same answer with none of that.
 *
 * ## Schema
 *
 * Created on first use with `CREATE TABLE IF NOT EXISTS`, so a self-hoster who
 * sets the URL needs no migration step. Canonical DDL is also in
 * `services/migrations/usage.sql` for reference, the same arrangement the
 * recorder uses for its tables.
 *
 * Two mappings worth stating:
 *
 *  - Counters are BIGINT, not INTEGER. SQLite's INTEGER is already 64-bit, but
 *    Postgres INTEGER is 32-bit and `delivered_bytes` passes 2^31 after two
 *    gigabytes on one agent-day, which is a fair-use quantity we deliberately
 *    meter. `pg` returns BIGINT as a STRING to avoid silent precision loss, so
 *    every numeric column is coerced with `num()` on the way out rather than by
 *    installing a global type parser — a global parser would also change what the
 *    recorder's pool returns, and this file has no business doing that.
 *  - `day` stays TEXT holding `YYYY-MM-DD`, and `first_seen`/`last_active` stay
 *    epoch-millisecond BIGINTs, exactly as in SQLite. `AgentUsage` documents them
 *    that way and the console consumes them that way; a DATE and a TIMESTAMPTZ
 *    would be tidier in isolation and would make the two backends answer
 *    differently, which is worse. Lexicographic comparison on ISO dates is
 *    correct, which is what `day < $1` and `day > $1` rely on.
 */

import pg from "pg";
import type {
  AgentUsage,
  DailyUsage,
  Delta,
  PeerDelta,
  PeerUsage,
  UsageBackend,
  UsageSummary,
} from "./usage-backend.js";
import { PEER_OTHER } from "./usage-backend.js";
import { MONITOR_PG_DDL, PostgresMonitorTables } from "./monitor-postgres.js";

/** `pg` hands back BIGINT and the NUMERIC that SUM() produces as strings. */
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}

export class PostgresUsageBackend implements UsageBackend {
  readonly kind = "postgres" as const;
  readonly monitor: PostgresMonitorTables;

  private pool: pg.Pool;
  private ready: Promise<void>;
  private lastErrorLog = 0;

  /** `pool` is injectable so tests can drive the SQL without a live server. */
  constructor(url: string, pool?: pg.Pool) {
    // Cloud-hosted Postgres over a public IP wants TLS; self-hosted often does
    // not. Same handling as platform-shared/recorder.ts: `sslmode=require|no-verify` in
    // the URL means TLS without CA verification, and the parameter is stripped
    // before `pg` sees the string.
    const ssl = /sslmode=(require|no-verify)/.test(url) ? { rejectUnauthorized: false } : undefined;
    this.pool =
      pool ?? new pg.Pool({ connectionString: url.replace(/[?&]sslmode=[a-z-]+/, ""), ssl, max: 3 });
    this.pool.on("error", (e) => this.logError("pool", e));
    this.ready = this.ensureSchema();
    this.monitor = new PostgresMonitorTables(this.pool, this.ready);
  }

  /**
   * Idempotent, and the whole schema — there is no migration step for a
   * self-hoster to run and no earlier Postgres shape to migrate FROM, because
   * this file is the first one. (The SQLite backend's `ALTER TABLE ADD COLUMN`
   * dance exists only because byte accounting was added to an already-deployed
   * file; there is no equivalent history here, so inventing one would be dead
   * code that reads like a real migration.)
   */
  private async ensureSchema(): Promise<void> {
    try {
      await this.createTables();
    } catch (e) {
      // Logged, not rethrown, and `this.ready` still resolves. A rejected `ready`
      // would surface as an unhandled rejection in any process that constructs
      // the store and has not yet counted anything, and it would hide the real
      // symptom behind it: an unreachable or unprivileged database shows up as a
      // failed flush naming the missing relation, once a minute, on the path that
      // actually needed it.
      this.logError("schema", e);
    }
  }

  private async createTables(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_stats (
        agent_id     TEXT PRIMARY KEY,
        messages_in  BIGINT NOT NULL DEFAULT 0,
        messages_out BIGINT NOT NULL DEFAULT 0,
        bytes_in     BIGINT NOT NULL DEFAULT 0,
        bytes_out    BIGINT NOT NULL DEFAULT 0,
        errors       BIGINT NOT NULL DEFAULT 0,
        first_seen   BIGINT NOT NULL,
        last_active  BIGINT NOT NULL
      )`);
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS agent_stats_last_active ON agent_stats (last_active DESC)",
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_stats_daily (
        agent_id        TEXT NOT NULL,
        day             TEXT NOT NULL,
        msgs_in         BIGINT NOT NULL DEFAULT 0,
        msgs_out        BIGINT NOT NULL DEFAULT 0,
        bytes_in        BIGINT NOT NULL DEFAULT 0,
        bytes_out       BIGINT NOT NULL DEFAULT 0,
        delivered_msgs  BIGINT NOT NULL DEFAULT 0,
        delivered_bytes BIGINT NOT NULL DEFAULT 0,
        errors          BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, day)
      )`);
    // The prune and the aggregate both filter on `day` alone across every agent.
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS agent_stats_daily_day ON agent_stats_daily (day)",
    );
    // The per-counterparty daily rollup (§13.5 fold) — see usage-backend.ts for
    // the cardinality bounds. The PK serves the provider-side reads and the
    // write path; the consumer-side reads get their own index.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_stats_daily_peer (
        day         TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        requests    BIGINT NOT NULL DEFAULT 0,
        responses   BIGINT NOT NULL DEFAULT 0,
        bytes_in    BIGINT NOT NULL DEFAULT 0,
        bytes_out   BIGINT NOT NULL DEFAULT 0,
        errors      BIGINT NOT NULL DEFAULT 0,
        refusals    BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (day, provider_id, consumer_id)
      )`);
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS peer_consumer_day ON agent_stats_daily_peer (consumer_id, day)",
    );
    // The Monitor's tables (monitor-postgres.ts), on the same database.
    for (const ddl of MONITOR_PG_DDL) await this.pool.query(ddl);
  }

  /**
   * One batch, two multi-row upserts, one transaction.
   *
   * `batch` carries at most one entry per agent id (it comes from a Map), which
   * matters: `ON CONFLICT DO UPDATE` refuses to affect the same row twice within
   * one statement, so a batch with a repeated key would error rather than
   * miscount. The `(agent_id, day)` batch is unique for the same reason plus a
   * single `day` per flush.
   *
   * `first_seen` is absent from both SET lists on purpose — an existing agent
   * keeps the first time it was seen, matching SQLite. `last_active` uses
   * GREATEST, which is Postgres's spelling of SQLite's two-argument MAX().
   */
  async write(day: string, batch: Array<[string, Delta]>): Promise<void> {
    if (batch.length === 0) return;
    await this.ready;

    const lifeValues: unknown[] = [];
    const lifeRows = batch.map(([id, d], i) => {
      const o = i * 8;
      lifeValues.push(id, d.in, d.out, d.bin, d.bout, d.err, d.first, d.last);
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`;
    });

    const dailyValues: unknown[] = [day];
    const dailyRows = batch.map(([id, d], i) => {
      const o = i * 8 + 1;
      dailyValues.push(id, d.in, d.out, d.bin, d.bout, d.dmsgs, d.dbytes, d.err);
      return `($${o + 1},$1,$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`;
    });

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO agent_stats
           (agent_id, messages_in, messages_out, bytes_in, bytes_out, errors, first_seen, last_active)
         VALUES ${lifeRows.join(",")}
         ON CONFLICT (agent_id) DO UPDATE SET
           messages_in  = agent_stats.messages_in  + EXCLUDED.messages_in,
           messages_out = agent_stats.messages_out + EXCLUDED.messages_out,
           bytes_in     = agent_stats.bytes_in     + EXCLUDED.bytes_in,
           bytes_out    = agent_stats.bytes_out    + EXCLUDED.bytes_out,
           errors       = agent_stats.errors       + EXCLUDED.errors,
           last_active  = GREATEST(agent_stats.last_active, EXCLUDED.last_active)`,
        lifeValues,
      );
      await client.query(
        `INSERT INTO agent_stats_daily
           (agent_id, day, msgs_in, msgs_out, bytes_in, bytes_out, delivered_msgs, delivered_bytes, errors)
         VALUES ${dailyRows.join(",")}
         ON CONFLICT (agent_id, day) DO UPDATE SET
           msgs_in         = agent_stats_daily.msgs_in         + EXCLUDED.msgs_in,
           msgs_out        = agent_stats_daily.msgs_out        + EXCLUDED.msgs_out,
           bytes_in        = agent_stats_daily.bytes_in        + EXCLUDED.bytes_in,
           bytes_out       = agent_stats_daily.bytes_out       + EXCLUDED.bytes_out,
           delivered_msgs  = agent_stats_daily.delivered_msgs  + EXCLUDED.delivered_msgs,
           delivered_bytes = agent_stats_daily.delivered_bytes + EXCLUDED.delivered_bytes,
           errors          = agent_stats_daily.errors          + EXCLUDED.errors`,
        dailyValues,
      );
      await client.query("COMMIT");
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async prune(cutoffDay: string): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM agent_stats_daily WHERE day < $1", [cutoffDay]);
  }

  /**
   * The cap check runs inside the same transaction as the upserts, with the
   * count re-read per provider and advanced locally as the batch introduces new
   * pairs — so a single batch cannot blow past the cap by checking a stale
   * pre-batch count per row. Two concurrent WRITERS could still each admit a
   * new pair under a cap with one slot left; the activity service is
   * single-instance (activity-service.ts says why), and the failure mode is a
   * cap of 201 for a day, not unbounded growth — noted rather than locked.
   */
  async writePeers(
    day: string,
    batch: Array<[string, string, PeerDelta]>,
    maxPeers: number,
  ): Promise<void> {
    if (batch.length === 0) return;
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const counts = new Map<string, number>();
      for (const [prov, consWanted, d] of batch) {
        let cons = consWanted;
        if (cons !== PEER_OTHER) {
          const seen = await client.query(
            "SELECT 1 FROM agent_stats_daily_peer WHERE day = $1 AND provider_id = $2 AND consumer_id = $3",
            [day, prov, cons],
          );
          if (seen.rowCount === 0) {
            let n = counts.get(prov);
            if (n === undefined) {
              const c = await client.query(
                "SELECT COUNT(*) AS n FROM agent_stats_daily_peer WHERE day = $1 AND provider_id = $2 AND consumer_id != $3",
                [day, prov, PEER_OTHER],
              );
              n = num(c.rows[0]?.n);
            }
            if (n >= maxPeers) cons = PEER_OTHER;
            else counts.set(prov, n + 1);
          }
        }
        await client.query(
          `INSERT INTO agent_stats_daily_peer
             (day, provider_id, consumer_id, requests, responses, bytes_in, bytes_out, errors, refusals)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (day, provider_id, consumer_id) DO UPDATE SET
             requests  = agent_stats_daily_peer.requests  + EXCLUDED.requests,
             responses = agent_stats_daily_peer.responses + EXCLUDED.responses,
             bytes_in  = agent_stats_daily_peer.bytes_in  + EXCLUDED.bytes_in,
             bytes_out = agent_stats_daily_peer.bytes_out + EXCLUDED.bytes_out,
             errors    = agent_stats_daily_peer.errors    + EXCLUDED.errors,
             refusals  = agent_stats_daily_peer.refusals  + EXCLUDED.refusals`,
          [day, prov, cons, d.requests, d.responses, d.bytes_in, d.bytes_out, d.errors, d.refusals],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async peersFor(
    agentId: string,
    sinceDay: string,
    limit: number,
  ): Promise<{ served: PeerUsage[]; consumed: PeerUsage[] }> {
    await this.ready;
    const toPeer = (r: Record<string, unknown>): PeerUsage => ({
      peer_id: String(r.peer_id),
      requests: num(r.requests),
      responses: num(r.responses),
      bytes_in: num(r.bytes_in),
      bytes_out: num(r.bytes_out),
      errors: num(r.errors),
      refusals: num(r.refusals),
      days_active: num(r.days_active),
    });
    const served = (
      await this.pool.query(
        `SELECT consumer_id AS peer_id,
                SUM(requests) AS requests, SUM(responses) AS responses,
                SUM(bytes_in) AS bytes_in, SUM(bytes_out) AS bytes_out,
                SUM(errors) AS errors, SUM(refusals) AS refusals,
                COUNT(DISTINCT day) AS days_active
         FROM agent_stats_daily_peer
         WHERE provider_id = $1 AND day > $2
         GROUP BY consumer_id ORDER BY SUM(requests) DESC LIMIT $3`,
        [agentId, sinceDay, limit],
      )
    ).rows.map(toPeer);
    const consumed = (
      await this.pool.query(
        `SELECT provider_id AS peer_id,
                SUM(requests) AS requests, SUM(responses) AS responses,
                SUM(bytes_in) AS bytes_in, SUM(bytes_out) AS bytes_out,
                SUM(errors) AS errors, SUM(refusals) AS refusals,
                COUNT(DISTINCT day) AS days_active
         FROM agent_stats_daily_peer
         WHERE consumer_id = $1 AND day > $2
         GROUP BY provider_id ORDER BY SUM(requests) DESC LIMIT $3`,
        [agentId, sinceDay, limit],
      )
    ).rows.map(toPeer);
    return { served, consumed };
  }

  async prunePeers(cutoffDay: string): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM agent_stats_daily_peer WHERE day < $1", [cutoffDay]);
  }

  async listLifetime(limit: number): Promise<AgentUsage[]> {
    await this.ready;
    const { rows } = await this.pool.query(
      `SELECT agent_id, messages_in, messages_out, bytes_in, bytes_out, errors, first_seen, last_active
       -- agent_id breaks the tie; see the sqlite backend for why.
       FROM agent_stats ORDER BY last_active DESC, agent_id ASC LIMIT $1`,
      [limit],
    );
    return rows.map((r: Record<string, unknown>) => ({
      agent_id: String(r.agent_id),
      messages_in: num(r.messages_in),
      messages_out: num(r.messages_out),
      bytes_in: num(r.bytes_in),
      bytes_out: num(r.bytes_out),
      errors: num(r.errors),
      first_seen: num(r.first_seen),
      last_active: num(r.last_active),
    }));
  }

  /** Re-ordered to the caller's id order, because the SQLite backend answers in
   *  that order (it queries per id) and `ANY($2)` makes no such promise. */
  async dailyFor(day: string, agentIds: string[]): Promise<DailyUsage[]> {
    await this.ready;
    if (agentIds.length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT agent_id, day, msgs_in, msgs_out, bytes_in, bytes_out, delivered_msgs, delivered_bytes, errors
       FROM agent_stats_daily WHERE day = $1 AND agent_id = ANY($2::text[])`,
      [day, agentIds],
    );
    const byId = new Map<string, DailyUsage>();
    for (const r of rows as Array<Record<string, unknown>>) {
      byId.set(String(r.agent_id), {
        agent_id: String(r.agent_id),
        day: String(r.day),
        msgs_in: num(r.msgs_in),
        msgs_out: num(r.msgs_out),
        bytes_in: num(r.bytes_in),
        bytes_out: num(r.bytes_out),
        delivered_msgs: num(r.delivered_msgs),
        delivered_bytes: num(r.delivered_bytes),
        errors: num(r.errors),
      });
    }
    const out: DailyUsage[] = [];
    for (const id of agentIds) {
      const row = byId.get(id);
      if (row) out.push(row);
    }
    return out;
  }

  async aggregate(today: string, sinceDay: string, topN: number): Promise<UsageSummary> {
    await this.ready;
    const series = (
      await this.pool.query(
        `SELECT day,
                SUM(msgs_in + msgs_out)   AS messages,
                SUM(bytes_in + bytes_out) AS bytes,
                COUNT(DISTINCT agent_id)  AS active_agents
         FROM agent_stats_daily
         WHERE day > $1
         GROUP BY day ORDER BY day DESC`,
        [sinceDay],
      )
    ).rows.map((r: Record<string, unknown>) => ({
      day: String(r.day),
      messages: num(r.messages),
      bytes: num(r.bytes),
      active_agents: num(r.active_agents),
    }));
    const todayRow = series.find((r) => r.day === today);
    const delivered = (
      await this.pool.query(
        "SELECT COALESCE(SUM(delivered_bytes),0) AS db FROM agent_stats_daily WHERE day = $1",
        [today],
      )
    ).rows[0] as { db: unknown };
    // The ORDER BY repeats the expressions rather than naming the output aliases.
    // SQLite resolves `ORDER BY delivered_bytes` to the alias; in Postgres a bare
    // name that is BOTH a base column and an output alias is a trap worth not
    // setting, and the expressions say exactly what the alias means.
    const top = (
      await this.pool.query(
        `SELECT agent_id,
                (msgs_in + msgs_out)          AS msgs,
                (delivered_bytes + bytes_out) AS delivered_bytes
         FROM agent_stats_daily WHERE day = $1
         ORDER BY (delivered_bytes + bytes_out) DESC, (msgs_in + msgs_out) DESC LIMIT $2`,
        [today, topN],
      )
    ).rows.map((r: Record<string, unknown>) => ({
      agent_id: String(r.agent_id),
      msgs: num(r.msgs),
      delivered_bytes: num(r.delivered_bytes),
    }));
    return {
      today: {
        day: today,
        messages: todayRow?.messages ?? 0,
        bytes: todayRow?.bytes ?? 0,
        delivered_bytes: num(delivered?.db),
        active_agents: todayRow?.active_agents ?? 0,
      },
      days: series,
      top,
    };
  }

  /**
   * Both DELETEs in one transaction, so a closure never half-deletes.
   *
   * ## There is no Postgres equivalent of `secure_delete`, and it is not needed
   *
   * The SQLite backend sets `secure_delete = ON` and checkpoints the WAL so the
   * agent id is gone from the FILE, not merely from every query. That was worth
   * doing there because the file is a plain local file on the service host: any
   * operator, backup, or disk snapshot can `grep` it, so "unreachable by query"
   * and "gone" are genuinely different outcomes.
   *
   * Postgres offers nothing equivalent and a client could not reach it if it did.
   * A DELETE marks the tuple dead; the bytes stay in the heap page until VACUUM
   * makes the space reusable, and VACUUM does not zero them — it marks the line
   * pointer unused, so the old tuple can remain legible in the page until a later
   * write happens to overwrite it. Actually removing the bytes from the file would
   * take `VACUUM FULL` (an ACCESS EXCLUSIVE lock and a full table rewrite, needing
   * privileges the service does not and should not have), and even that would not
   * touch the WAL segments holding the delete record, nor any archived WAL,
   * replica, or base backup. Issuing it would be expensive theatre that still did
   * not deliver the guarantee.
   *
   * So the guarantee changes, and this is the honest statement of it: on SQLite,
   * account closure removes the agent's counters from the database file; on
   * Postgres, it removes them from the database, and their disappearance from
   * physical storage follows the server's own vacuum and backup lifecycle. That
   * is the standard boundary for every other record we keep in Postgres — the
   * recorder's `events` rows name the same agents — and it is addressed where it
   * belongs, in the server's encryption-at-rest and backup-retention policy,
   * rather than by a per-DELETE flag a client can set.
   *
   * What this method does do, and what matters most: a hard DELETE rather than a
   * tombstone or a soft-delete flag, both tables in one transaction, and no audit
   * or shadow row holding the id afterwards. One residual to be aware of when
   * operating it: the id travels as a query PARAMETER, so a server configured with
   * statement logging can retain it in the Postgres log independently of the
   * table.
   */
  async deleteAgent(agentId: string): Promise<{ lifetime: number; daily: number }> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const life = await client.query("DELETE FROM agent_stats WHERE agent_id = $1", [agentId]);
      const daily = await client.query("DELETE FROM agent_stats_daily WHERE agent_id = $1", [agentId]);
      // Peer rows go on both sides — usage-backend.ts says why.
      await client.query(
        "DELETE FROM agent_stats_daily_peer WHERE provider_id = $1 OR consumer_id = $1",
        [agentId],
      );
      // And the Monitor's rows naming it (monitor-types.ts), in the same
      // transaction, so a closure never half-deletes.
      await client.query("DELETE FROM monitor_pair_hour WHERE sender_id = $1 OR receiver_id = $1", [agentId]);
      await client.query("DELETE FROM monitor_compute_hour WHERE agent_id = $1", [agentId]);
      await client.query("DELETE FROM monitor_events WHERE sender_id = $1 OR receiver_id = $1", [agentId]);
      await client.query("DELETE FROM monitor_alarms WHERE scope = $1", [agentId]);
      await client.query("COMMIT");
      return { lifetime: life.rowCount ?? 0, daily: daily.rowCount ?? 0 };
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Pool-level errors are asynchronous and can repeat once per broken
   *  connection, so they are throttled the way the recorder throttles its own.
   *  Errors on a specific query are NOT swallowed here — they propagate to
   *  `UsageStore`, which decides what a failed flush means. */
  private logError(where: string, e: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLog < 60_000) return;
    this.lastErrorLog = now;
    console.error(`[activity] usage ${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
