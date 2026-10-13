/**
 * The Monitor's tables on the Postgres usage backend: the same pool and the
 * same additive-upsert discipline as the counters (usage-postgres.ts says why
 * an atomic upsert is safe for two writers). What the tables hold, and why
 * nothing more, is in monitor-types.ts. Numeric columns come back from `pg`
 * as strings and are coerced on the way out, as the counters' are.
 */
import type pg from "pg";
import {
  LAT_BUCKETS,
  PAIR_OTHER,
  type Alarm,
  type ComputeRow,
  type MonitorEvent,
  type MonitorRead,
  type MonitorTables,
  type PairRow,
} from "./monitor-types.js";
import { alarmOf, eventOf } from "./monitor-sqlite.js";

const H = Array.from({ length: LAT_BUCKETS }, (_, i) => `h${i}`);
const PAIR_COLS = ["msgs", "delivered", "failed", "refused", "passed", "held", "flagged", "unchecked", "lat_n", "lat_ms", ...H];
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

export const MONITOR_PG_DDL = [
  `CREATE TABLE IF NOT EXISTS monitor_pair_hour (
    hour TEXT NOT NULL, sender_id TEXT NOT NULL, receiver_id TEXT NOT NULL,
    ${PAIR_COLS.map((c) => `${c} BIGINT NOT NULL DEFAULT 0`).join(", ")},
    PRIMARY KEY (hour, sender_id, receiver_id))`,
  "CREATE INDEX IF NOT EXISTS monitor_pair_sender ON monitor_pair_hour (sender_id, hour)",
  "CREATE INDEX IF NOT EXISTS monitor_pair_receiver ON monitor_pair_hour (receiver_id, hour)",
  `CREATE TABLE IF NOT EXISTS monitor_compute_hour (
    hour TEXT NOT NULL, agent_id TEXT NOT NULL, payer TEXT NOT NULL,
    jobs BIGINT NOT NULL DEFAULT 0, job_ms BIGINT NOT NULL DEFAULT 0, failed BIGINT NOT NULL DEFAULT 0,
    mem_mb BIGINT NOT NULL DEFAULT 0, tokens_in BIGINT NOT NULL DEFAULT 0, tokens_out BIGINT NOT NULL DEFAULT 0,
    cost_micros BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, agent_id, payer))`,
  "CREATE INDEX IF NOT EXISTS monitor_compute_agent ON monitor_compute_hour (agent_id, hour)",
  "CREATE INDEX IF NOT EXISTS monitor_compute_payer ON monitor_compute_hour (payer, hour)",
  `CREATE TABLE IF NOT EXISTS monitor_events (
    id TEXT PRIMARY KEY, at BIGINT NOT NULL, sender_id TEXT NOT NULL, receiver_id TEXT NOT NULL,
    outcome TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', ms BIGINT, account_id TEXT, message_id TEXT,
    state TEXT NOT NULL DEFAULT '')`,
  "CREATE INDEX IF NOT EXISTS monitor_events_receiver ON monitor_events (receiver_id, at)",
  "CREATE INDEX IF NOT EXISTS monitor_events_sender ON monitor_events (sender_id, at)",
  "CREATE INDEX IF NOT EXISTS monitor_events_at ON monitor_events (at)",
  `CREATE TABLE IF NOT EXISTS monitor_alarms (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL,
    threshold DOUBLE PRECISION, created_at BIGINT NOT NULL, state TEXT NOT NULL, value DOUBLE PRECISION,
    since BIGINT NOT NULL, emailed_at BIGINT NOT NULL DEFAULT 0)`,
  "CREATE INDEX IF NOT EXISTS monitor_alarms_account ON monitor_alarms (account_id)",
];

function pairOf(r: Record<string, unknown>): PairRow {
  return {
    hour: String(r.hour), sender_id: String(r.sender_id), receiver_id: String(r.receiver_id),
    msgs: num(r.msgs), delivered: num(r.delivered), failed: num(r.failed), refused: num(r.refused),
    passed: num(r.passed), held: num(r.held), flagged: num(r.flagged), unchecked: num(r.unchecked),
    lat_n: num(r.lat_n), lat_ms: num(r.lat_ms), h: H.map((c) => num(r[c])),
  };
}

function computeOf(r: Record<string, unknown>): ComputeRow {
  return {
    hour: String(r.hour), agent_id: String(r.agent_id), payer: String(r.payer),
    jobs: num(r.jobs), job_ms: num(r.job_ms), failed: num(r.failed), mem_mb: num(r.mem_mb),
    tokens_in: num(r.tokens_in), tokens_out: num(r.tokens_out), cost_micros: num(r.cost_micros),
  };
}

export class PostgresMonitorTables implements MonitorTables {
  constructor(private pool: pg.Pool, private ready: Promise<void>) {}

  async write(pairs: PairRow[], compute: ComputeRow[], events: MonitorEvent[], maxSenders: number): Promise<void> {
    if (!pairs.length && !compute.length && !events.length) return;
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const counts = new Map<string, number>();
      for (const p of pairs) {
        let sender = p.sender_id;
        if (sender !== PAIR_OTHER) {
          const seen = await client.query(
            "SELECT 1 FROM monitor_pair_hour WHERE hour = $1 AND sender_id = $2 AND receiver_id = $3",
            [p.hour, sender, p.receiver_id],
          );
          if (seen.rowCount === 0) {
            const k = `${p.hour} ${p.receiver_id}`;
            let n = counts.get(k);
            if (n === undefined) {
              const c = await client.query(
                "SELECT COUNT(*) AS n FROM monitor_pair_hour WHERE hour = $1 AND receiver_id = $2 AND sender_id != $3",
                [p.hour, p.receiver_id, PAIR_OTHER],
              );
              n = num(c.rows[0]?.n);
            }
            if (n >= maxSenders) sender = PAIR_OTHER;
            else counts.set(k, n + 1);
          }
        }
        const vals = [p.hour, sender, p.receiver_id,
          p.msgs, p.delivered, p.failed, p.refused, p.passed, p.held, p.flagged, p.unchecked, p.lat_n, p.lat_ms,
          ...H.map((_, i) => p.h[i] ?? 0)];
        await client.query(
          `INSERT INTO monitor_pair_hour (hour, sender_id, receiver_id, ${PAIR_COLS.join(", ")})
           VALUES (${vals.map((_, i) => `$${i + 1}`).join(",")})
           ON CONFLICT (hour, sender_id, receiver_id) DO UPDATE SET
             ${PAIR_COLS.map((c) => `${c} = monitor_pair_hour.${c} + EXCLUDED.${c}`).join(", ")}`,
          vals,
        );
      }
      for (const c of compute) {
        await client.query(
          `INSERT INTO monitor_compute_hour (hour, agent_id, payer, jobs, job_ms, failed, mem_mb, tokens_in, tokens_out, cost_micros)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (hour, agent_id, payer) DO UPDATE SET
             jobs = monitor_compute_hour.jobs + EXCLUDED.jobs, job_ms = monitor_compute_hour.job_ms + EXCLUDED.job_ms,
             failed = monitor_compute_hour.failed + EXCLUDED.failed, mem_mb = GREATEST(monitor_compute_hour.mem_mb, EXCLUDED.mem_mb),
             tokens_in = monitor_compute_hour.tokens_in + EXCLUDED.tokens_in, tokens_out = monitor_compute_hour.tokens_out + EXCLUDED.tokens_out,
             cost_micros = monitor_compute_hour.cost_micros + EXCLUDED.cost_micros`,
          [c.hour, c.agent_id, c.payer, c.jobs, c.job_ms, c.failed, c.mem_mb, c.tokens_in, c.tokens_out, c.cost_micros],
        );
      }
      for (const e of events) {
        await client.query(
          `INSERT INTO monitor_events (id, at, sender_id, receiver_id, outcome, reason, ms, account_id, message_id, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
          [e.id, e.at, e.sender_id, e.receiver_id, e.outcome, e.reason, e.ms, e.account_id, e.message_id, e.state],
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

  async read(agents: string[], sinceHour: string): Promise<MonitorRead> {
    if (!agents.length) return { pairs: [], compute: [] };
    await this.ready;
    const pairs = agents.length
      ? (await this.pool.query(
          "SELECT * FROM monitor_pair_hour WHERE hour >= $1 AND (sender_id = ANY($2::text[]) OR receiver_id = ANY($2::text[]))",
          [sinceHour, agents],
        )).rows.map(pairOf)
      : [];
    const compute = (await this.pool.query(
      "SELECT * FROM monitor_compute_hour WHERE hour >= $1 AND (agent_id = ANY($2::text[]) OR payer = ANY($2::text[]))",
      [sinceHour, agents],
    )).rows.map(computeOf);
    return { pairs, compute };
  }

  async events(agents: string[], sinceMs: number, limit: number): Promise<MonitorEvent[]> {
    if (!agents.length) return [];
    await this.ready;
    return (await this.pool.query(
      `SELECT * FROM monitor_events
       WHERE at >= $1 AND (receiver_id = ANY($2::text[]) OR (sender_id = ANY($2::text[]) AND outcome IN ('failed', 'refused')))
       ORDER BY at DESC, id DESC LIMIT $3`,
      [sinceMs, agents, limit],
    )).rows.map(eventOf);
  }

  async event(id: string): Promise<MonitorEvent | null> {
    await this.ready;
    const r = (await this.pool.query("SELECT * FROM monitor_events WHERE id = $1", [id])).rows[0];
    return r ? eventOf(r) : null;
  }

  async decide(id: string, state: "released" | "discarded"): Promise<boolean> {
    await this.ready;
    const r = await this.pool.query("UPDATE monitor_events SET state = $1 WHERE id = $2 AND state = 'open'", [state, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async openHeld(agents: string[], sinceMs: number): Promise<number> {
    if (!agents.length) return 0;
    await this.ready;
    const r = await this.pool.query(
      "SELECT COUNT(*) AS n FROM monitor_events WHERE at >= $1 AND outcome = 'held' AND state = 'open' AND receiver_id = ANY($2::text[])",
      [sinceMs, agents],
    );
    return num(r.rows[0]?.n);
  }

  async prune(cutoffHour: string, cutoffMs: number): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM monitor_pair_hour WHERE hour < $1", [cutoffHour]);
    await this.pool.query("DELETE FROM monitor_compute_hour WHERE hour < $1", [cutoffHour]);
    await this.pool.query("DELETE FROM monitor_events WHERE at < $1", [cutoffMs]);
  }

  async forget(agentId: string): Promise<number> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let n = 0;
      n += (await client.query("DELETE FROM monitor_pair_hour WHERE sender_id = $1 OR receiver_id = $1", [agentId])).rowCount ?? 0;
      n += (await client.query("DELETE FROM monitor_compute_hour WHERE agent_id = $1", [agentId])).rowCount ?? 0;
      n += (await client.query("DELETE FROM monitor_events WHERE sender_id = $1 OR receiver_id = $1", [agentId])).rowCount ?? 0;
      n += (await client.query("DELETE FROM monitor_alarms WHERE scope = $1", [agentId])).rowCount ?? 0;
      await client.query("COMMIT");
      return n;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async alarms(accountId: string | null): Promise<Alarm[]> {
    await this.ready;
    const r = accountId === null
      ? await this.pool.query("SELECT * FROM monitor_alarms ORDER BY created_at")
      : await this.pool.query("SELECT * FROM monitor_alarms WHERE account_id = $1 ORDER BY created_at", [accountId]);
    return r.rows.map(alarmOf);
  }

  async putAlarm(a: Alarm): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO monitor_alarms (id, account_id, scope, kind, threshold, created_at, state, value, since, emailed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, value = EXCLUDED.value, since = EXCLUDED.since,
         emailed_at = EXCLUDED.emailed_at, threshold = EXCLUDED.threshold`,
      [a.id, a.account_id, a.scope, a.kind, a.threshold, a.created_at, a.state, a.value, a.since, a.emailed_at],
    );
  }

  async deleteAlarm(id: string, accountId: string): Promise<boolean> {
    await this.ready;
    const r = await this.pool.query("DELETE FROM monitor_alarms WHERE id = $1 AND account_id = $2", [id, accountId]);
    return (r.rowCount ?? 0) > 0;
  }
}
