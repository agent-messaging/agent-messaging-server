/**
 * The SQLite usage backend — a local file, and the default.
 *
 * This is the original implementation, moved behind `UsageBackend` unchanged: the
 * same two tables, the same pragmas, the same statements, byte for byte. It is
 * what a deployment gets when no `USAGE_DB_URL` is configured, which is every
 * self-hoster on one machine and every public deploy bundle — a shared database
 * is not something you should have to run to count messages.
 *
 * Its one limitation is the reason usage-postgres.ts exists: the file is local,
 * so two service instances keep two divergent sets of counters and the delete
 * path can only reach the file it was pointed at.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
import { SqliteMonitorTables } from "./monitor-sqlite.js";

export class SqliteUsageBackend implements UsageBackend {
  readonly kind = "sqlite" as const;
  readonly monitor: SqliteMonitorTables;

  private db: Database.Database;
  private upsert: Database.Statement;
  private upsertDaily: Database.Statement;
  private selectAll: Database.Statement;
  private selectDayFor: Database.Statement;
  private deleteStats: Database.Statement;
  private deleteDaily: Database.Statement;

  constructor(dbPath: string) {
    const path = resolve(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    // Erasure has to actually erase. A plain SQLite DELETE unlinks the row but
    // leaves its bytes legible in the freed page until something overwrites them,
    // which for `deleteAgentUsage` (an account-closure call) would make "deleted"
    // mean "not in any query" rather than "gone from the file". `secure_delete`
    // zeroes freed content as it goes; it costs a little on DELETE, and the only
    // DELETEs here are the once-a-day rollup prune and account closure.
    //
    // This pragma is SQLite-specific and has NO Postgres counterpart; see the
    // `deleteAgent` comment in usage-postgres.ts for what changes when the
    // counters move to a server.
    this.db.pragma("secure_delete = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_stats (
        agent_id     TEXT PRIMARY KEY,
        messages_in  INTEGER NOT NULL DEFAULT 0,
        messages_out INTEGER NOT NULL DEFAULT 0,
        errors       INTEGER NOT NULL DEFAULT 0,
        first_seen   INTEGER NOT NULL,
        last_active  INTEGER NOT NULL
      )
    `);
    // Bytes came later (fair-use accounting); older DBs gain the columns here.
    for (const col of ["bytes_in", "bytes_out"]) {
      try { this.db.exec(`ALTER TABLE agent_stats ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`); }
      catch { /* already present */ }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_stats_daily (
        agent_id        TEXT NOT NULL,
        day             TEXT NOT NULL,
        msgs_in         INTEGER NOT NULL DEFAULT 0,
        msgs_out        INTEGER NOT NULL DEFAULT 0,
        bytes_in        INTEGER NOT NULL DEFAULT 0,
        bytes_out       INTEGER NOT NULL DEFAULT 0,
        delivered_msgs  INTEGER NOT NULL DEFAULT 0,
        delivered_bytes INTEGER NOT NULL DEFAULT 0,
        errors          INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, day)
      )
    `);
    // The per-counterparty daily rollup (§13.5 fold). Daily only, capped per
    // provider per day at write time (writePeers) — see usage-backend.ts.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_stats_daily_peer (
        day         TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        requests    INTEGER NOT NULL DEFAULT 0,
        responses   INTEGER NOT NULL DEFAULT 0,
        bytes_in    INTEGER NOT NULL DEFAULT 0,
        bytes_out   INTEGER NOT NULL DEFAULT 0,
        errors      INTEGER NOT NULL DEFAULT 0,
        refusals    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, provider_id, consumer_id)
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS peer_consumer_day ON agent_stats_daily_peer (consumer_id, day)",
    );
    this.upsert = this.db.prepare(`
      INSERT INTO agent_stats (agent_id, messages_in, messages_out, bytes_in, bytes_out, errors, first_seen, last_active)
      VALUES (@id, @in, @out, @bin, @bout, @err, @first, @last)
      ON CONFLICT(agent_id) DO UPDATE SET
        messages_in  = messages_in  + excluded.messages_in,
        messages_out = messages_out + excluded.messages_out,
        bytes_in     = bytes_in     + excluded.bytes_in,
        bytes_out    = bytes_out    + excluded.bytes_out,
        errors       = errors       + excluded.errors,
        last_active  = MAX(last_active, excluded.last_active)
    `);
    this.upsertDaily = this.db.prepare(`
      INSERT INTO agent_stats_daily (agent_id, day, msgs_in, msgs_out, bytes_in, bytes_out, delivered_msgs, delivered_bytes, errors)
      VALUES (@id, @day, @in, @out, @bin, @bout, @dmsgs, @dbytes, @err)
      ON CONFLICT(agent_id, day) DO UPDATE SET
        msgs_in         = msgs_in         + excluded.msgs_in,
        msgs_out        = msgs_out        + excluded.msgs_out,
        bytes_in        = bytes_in        + excluded.bytes_in,
        bytes_out       = bytes_out       + excluded.bytes_out,
        delivered_msgs  = delivered_msgs  + excluded.delivered_msgs,
        delivered_bytes = delivered_bytes + excluded.delivered_bytes,
        errors          = errors          + excluded.errors
    `);
    this.selectAll = this.db.prepare(`
      SELECT agent_id, messages_in, messages_out, bytes_in, bytes_out, errors, first_seen, last_active
      -- agent_id breaks the tie. last_active is whole milliseconds, so two
      -- agents active in the same tick ordered arbitrarily: rows swapped places
      -- between runs on the operator's screen, and a test asserting "the first
      -- row is A" passed locally and failed in CI for no reason anyone could
      -- see. A list with no total order is a list that reorders itself.
      FROM agent_stats ORDER BY last_active DESC, agent_id ASC LIMIT ?
    `);
    this.selectDayFor = this.db.prepare(`
      SELECT agent_id, day, msgs_in, msgs_out, bytes_in, bytes_out, delivered_msgs, delivered_bytes, errors
      FROM agent_stats_daily WHERE day = ? AND agent_id = ?
    `);
    this.monitor = new SqliteMonitorTables(this.db);
    this.deleteStats = this.db.prepare("DELETE FROM agent_stats WHERE agent_id = ?");
    this.deleteDaily = this.db.prepare("DELETE FROM agent_stats_daily WHERE agent_id = ?");
  }

  async write(day: string, batch: Array<[string, Delta]>): Promise<void> {
    const tx = this.db.transaction((entries: Array<[string, Delta]>) => {
      for (const [id, d] of entries) {
        this.upsert.run({ id, in: d.in, out: d.out, bin: d.bin, bout: d.bout, err: d.err, first: d.first, last: d.last });
        this.upsertDaily.run({ id, day, in: d.in, out: d.out, bin: d.bin, bout: d.bout, dmsgs: d.dmsgs, dbytes: d.dbytes, err: d.err });
      }
    });
    tx(batch);
  }

  async prune(cutoffDay: string): Promise<void> {
    this.db.prepare("DELETE FROM agent_stats_daily WHERE day < ?").run(cutoffDay);
  }

  async writePeers(
    day: string,
    batch: Array<[string, string, PeerDelta]>,
    maxPeers: number,
  ): Promise<void> {
    if (batch.length === 0) return;
    const upsertPeer = this.db.prepare(`
      INSERT INTO agent_stats_daily_peer
        (day, provider_id, consumer_id, requests, responses, bytes_in, bytes_out, errors, refusals)
      VALUES (@day, @prov, @cons, @req, @res, @bin, @bout, @err, @ref)
      ON CONFLICT(day, provider_id, consumer_id) DO UPDATE SET
        requests  = requests  + excluded.requests,
        responses = responses + excluded.responses,
        bytes_in  = bytes_in  + excluded.bytes_in,
        bytes_out = bytes_out + excluded.bytes_out,
        errors    = errors    + excluded.errors,
        refusals  = refusals  + excluded.refusals
    `);
    const exists = this.db.prepare(
      "SELECT 1 FROM agent_stats_daily_peer WHERE day = ? AND provider_id = ? AND consumer_id = ?",
    );
    const countPeers = this.db.prepare(
      "SELECT COUNT(*) AS n FROM agent_stats_daily_peer WHERE day = ? AND provider_id = ? AND consumer_id != ?",
    );
    const tx = this.db.transaction((entries: Array<[string, string, PeerDelta]>) => {
      // Cap bookkeeping is per provider WITHIN the transaction too: a batch
      // that introduces many new consumers at once must not blow past the cap
      // because each row checked the pre-batch count.
      const counts = new Map<string, number>();
      for (const [prov, consWanted, d] of entries) {
        let cons = consWanted;
        if (cons !== PEER_OTHER && !exists.get(day, prov, cons)) {
          let n = counts.get(prov);
          if (n === undefined) {
            n = (countPeers.get(day, prov, PEER_OTHER) as { n: number }).n;
          }
          if (n >= maxPeers) cons = PEER_OTHER;
          else counts.set(prov, n + 1);
        }
        upsertPeer.run({
          day, prov, cons,
          req: d.requests, res: d.responses, bin: d.bytes_in, bout: d.bytes_out,
          err: d.errors, ref: d.refusals,
        });
      }
    });
    tx(batch);
  }

  async peersFor(
    agentId: string,
    sinceDay: string,
    limit: number,
  ): Promise<{ served: PeerUsage[]; consumed: PeerUsage[] }> {
    const served = this.db.prepare(`
      SELECT consumer_id AS peer_id,
             SUM(requests) AS requests, SUM(responses) AS responses,
             SUM(bytes_in) AS bytes_in, SUM(bytes_out) AS bytes_out,
             SUM(errors) AS errors, SUM(refusals) AS refusals,
             COUNT(DISTINCT day) AS days_active
      FROM agent_stats_daily_peer
      WHERE provider_id = ? AND day > ?
      GROUP BY consumer_id ORDER BY SUM(requests) DESC LIMIT ?
    `).all(agentId, sinceDay, limit) as PeerUsage[];
    const consumed = this.db.prepare(`
      SELECT provider_id AS peer_id,
             SUM(requests) AS requests, SUM(responses) AS responses,
             SUM(bytes_in) AS bytes_in, SUM(bytes_out) AS bytes_out,
             SUM(errors) AS errors, SUM(refusals) AS refusals,
             COUNT(DISTINCT day) AS days_active
      FROM agent_stats_daily_peer
      WHERE consumer_id = ? AND day > ?
      GROUP BY provider_id ORDER BY SUM(requests) DESC LIMIT ?
    `).all(agentId, sinceDay, limit) as PeerUsage[];
    return { served, consumed };
  }

  async prunePeers(cutoffDay: string): Promise<void> {
    this.db.prepare("DELETE FROM agent_stats_daily_peer WHERE day < ?").run(cutoffDay);
  }

  async listLifetime(limit: number): Promise<AgentUsage[]> {
    return this.selectAll.all(limit) as AgentUsage[];
  }

  async dailyFor(day: string, agentIds: string[]): Promise<DailyUsage[]> {
    const out: DailyUsage[] = [];
    for (const id of agentIds) {
      const row = this.selectDayFor.get(day, id) as DailyUsage | undefined;
      if (row) out.push(row);
    }
    return out;
  }

  async aggregate(today: string, sinceDay: string, topN: number): Promise<UsageSummary> {
    const series = this.db.prepare(`
      SELECT day,
             SUM(msgs_in + msgs_out)          AS messages,
             SUM(bytes_in + bytes_out)        AS bytes,
             COUNT(DISTINCT agent_id)         AS active_agents
      FROM agent_stats_daily
      WHERE day > ?
      GROUP BY day ORDER BY day DESC
    `).all(sinceDay) as Array<{ day: string; messages: number; bytes: number; active_agents: number }>;
    const todayRow = series.find((r) => r.day === today);
    const delivered = this.db.prepare(
      "SELECT COALESCE(SUM(delivered_bytes),0) AS db FROM agent_stats_daily WHERE day = ?",
    ).get(today) as { db: number };
    const top = this.db.prepare(`
      SELECT agent_id,
             (msgs_in + msgs_out)                AS msgs,
             (delivered_bytes + bytes_out)       AS delivered_bytes
      FROM agent_stats_daily WHERE day = ?
      ORDER BY delivered_bytes DESC, msgs DESC LIMIT ?
    `).all(today, topN) as Array<{ agent_id: string; msgs: number; delivered_bytes: number }>;
    return {
      today: {
        day: today,
        messages: todayRow?.messages ?? 0,
        bytes: todayRow?.bytes ?? 0,
        delivered_bytes: delivered.db,
        active_agents: todayRow?.active_agents ?? 0,
      },
      days: series,
      top,
    };
  }

  /**
   * Both DELETEs in one transaction, then a WAL checkpoint.
   *
   * With `secure_delete` the freed pages are zeroed, but the PRE-delete images of
   * those pages are still sitting in `usage.db-wal` until a checkpoint retires
   * them. This is the SQLite equivalent of purging a KV key rather than
   * soft-deleting it, and it is cheap because closure is rare.
   */
  async deleteAgent(agentId: string): Promise<{ lifetime: number; daily: number }> {
    const deletePeers = this.db.prepare(
      "DELETE FROM agent_stats_daily_peer WHERE provider_id = ? OR consumer_id = ?",
    );
    const counts = this.db.transaction((id: string) => {
      deletePeers.run(id, id); // both sides — usage-backend.ts says why
      this.monitor.forgetInside(id); // the Monitor's rows, same transaction
      return {
        lifetime: this.deleteStats.run(id).changes,
        daily: this.deleteDaily.run(id).changes,
      };
    })(agentId);
    try { this.db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* non-fatal */ }
    return counts;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
