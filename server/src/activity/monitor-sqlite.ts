/**
 * The Monitor's tables on the SQLite usage backend: the same file, the same
 * connection and the same additive upserts as the counters beside them
 * (usage-sqlite.ts). What the tables hold, and why nothing more, is in
 * monitor-types.ts.
 *
 * Two processes write this file on the reference instance: the activity
 * service (traffic, from its tap) and the API (guard verdicts at the hosted
 * gateway, job reports, alarms). SQLite in WAL mode takes that, with
 * better-sqlite3's default five-second busy wait, and every write is an
 * additive upsert, so neither can lose the other's counts.
 */
import type Database from "better-sqlite3";
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

const H = Array.from({ length: LAT_BUCKETS }, (_, i) => `h${i}`);
/** SQLite binds at most 32,766 parameters; a read names at most this many
 *  agents, which leaves room for both IN lists. */
const MAX_IDS = 400;

function pairOf(r: Record<string, unknown>): PairRow {
  return {
    hour: String(r.hour), sender_id: String(r.sender_id), receiver_id: String(r.receiver_id),
    msgs: Number(r.msgs), delivered: Number(r.delivered), failed: Number(r.failed), refused: Number(r.refused),
    passed: Number(r.passed), held: Number(r.held), flagged: Number(r.flagged), unchecked: Number(r.unchecked),
    lat_n: Number(r.lat_n), lat_ms: Number(r.lat_ms), h: H.map((c) => Number(r[c] ?? 0)),
  };
}

function computeOf(r: Record<string, unknown>): ComputeRow {
  return {
    hour: String(r.hour), agent_id: String(r.agent_id), payer: String(r.payer),
    jobs: Number(r.jobs), job_ms: Number(r.job_ms), failed: Number(r.failed), mem_mb: Number(r.mem_mb),
    tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out), cost_micros: Number(r.cost_micros),
  };
}

export function eventOf(r: Record<string, unknown>): MonitorEvent {
  return {
    id: String(r.id), at: Number(r.at), sender_id: String(r.sender_id), receiver_id: String(r.receiver_id),
    outcome: String(r.outcome) as MonitorEvent["outcome"], reason: String(r.reason ?? ""),
    ms: r.ms === null || r.ms === undefined ? null : Number(r.ms),
    account_id: r.account_id ? String(r.account_id) : null,
    message_id: r.message_id ? String(r.message_id) : null,
    state: String(r.state ?? "") as MonitorEvent["state"],
  };
}

export function alarmOf(r: Record<string, unknown>): Alarm {
  return {
    id: String(r.id), account_id: String(r.account_id), scope: String(r.scope),
    kind: String(r.kind) as Alarm["kind"],
    threshold: r.threshold === null || r.threshold === undefined ? null : Number(r.threshold),
    created_at: Number(r.created_at), state: String(r.state) as Alarm["state"],
    value: r.value === null || r.value === undefined ? null : Number(r.value),
    since: Number(r.since), emailed_at: Number(r.emailed_at),
  };
}

export class SqliteMonitorTables implements MonitorTables {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_pair_hour (
        hour        TEXT NOT NULL,
        sender_id   TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        msgs INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0,
        passed INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0,
        flagged INTEGER NOT NULL DEFAULT 0, unchecked INTEGER NOT NULL DEFAULT 0,
        lat_n INTEGER NOT NULL DEFAULT 0, lat_ms INTEGER NOT NULL DEFAULT 0,
        ${H.map((c) => `${c} INTEGER NOT NULL DEFAULT 0`).join(", ")},
        PRIMARY KEY (hour, sender_id, receiver_id)
      )`);
    db.exec("CREATE INDEX IF NOT EXISTS monitor_pair_sender ON monitor_pair_hour (sender_id, hour)");
    db.exec("CREATE INDEX IF NOT EXISTS monitor_pair_receiver ON monitor_pair_hour (receiver_id, hour)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_compute_hour (
        hour     TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        payer    TEXT NOT NULL,
        jobs INTEGER NOT NULL DEFAULT 0, job_ms INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0, mem_mb INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour, agent_id, payer)
      )`);
    db.exec("CREATE INDEX IF NOT EXISTS monitor_compute_agent ON monitor_compute_hour (agent_id, hour)");
    db.exec("CREATE INDEX IF NOT EXISTS monitor_compute_payer ON monitor_compute_hour (payer, hour)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_events (
        id          TEXT PRIMARY KEY,
        at          INTEGER NOT NULL,
        sender_id   TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        outcome     TEXT NOT NULL,
        reason      TEXT NOT NULL DEFAULT '',
        ms          INTEGER,
        account_id  TEXT,
        message_id  TEXT,
        state       TEXT NOT NULL DEFAULT ''
      )`);
    db.exec("CREATE INDEX IF NOT EXISTS monitor_events_receiver ON monitor_events (receiver_id, at)");
    db.exec("CREATE INDEX IF NOT EXISTS monitor_events_sender ON monitor_events (sender_id, at)");
    db.exec("CREATE INDEX IF NOT EXISTS monitor_events_at ON monitor_events (at)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_alarms (
        id         TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        scope      TEXT NOT NULL,
        kind       TEXT NOT NULL,
        threshold  REAL,
        created_at INTEGER NOT NULL,
        state      TEXT NOT NULL,
        value      REAL,
        since      INTEGER NOT NULL,
        emailed_at INTEGER NOT NULL DEFAULT 0
      )`);
    db.exec("CREATE INDEX IF NOT EXISTS monitor_alarms_account ON monitor_alarms (account_id)");
  }

  async write(pairs: PairRow[], compute: ComputeRow[], events: MonitorEvent[], maxSenders: number): Promise<void> {
    if (!pairs.length && !compute.length && !events.length) return;
    const cols = ["msgs", "delivered", "failed", "refused", "passed", "held", "flagged", "unchecked", "lat_n", "lat_ms", ...H];
    const upsertPair = this.db.prepare(`
      INSERT INTO monitor_pair_hour (hour, sender_id, receiver_id, ${cols.join(", ")})
      VALUES (?, ?, ?, ${cols.map(() => "?").join(", ")})
      ON CONFLICT(hour, sender_id, receiver_id) DO UPDATE SET
        ${cols.map((c) => `${c} = ${c} + excluded.${c}`).join(",\n        ")}`);
    const seen = this.db.prepare("SELECT 1 FROM monitor_pair_hour WHERE hour = ? AND sender_id = ? AND receiver_id = ?");
    const senders = this.db.prepare("SELECT COUNT(*) AS n FROM monitor_pair_hour WHERE hour = ? AND receiver_id = ? AND sender_id != ?");
    const upsertCompute = this.db.prepare(`
      INSERT INTO monitor_compute_hour (hour, agent_id, payer, jobs, job_ms, failed, mem_mb, tokens_in, tokens_out, cost_micros)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour, agent_id, payer) DO UPDATE SET
        jobs = jobs + excluded.jobs, job_ms = job_ms + excluded.job_ms, failed = failed + excluded.failed,
        mem_mb = MAX(mem_mb, excluded.mem_mb), tokens_in = tokens_in + excluded.tokens_in,
        tokens_out = tokens_out + excluded.tokens_out, cost_micros = cost_micros + excluded.cost_micros`);
    const insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO monitor_events (id, at, sender_id, receiver_id, outcome, reason, ms, account_id, message_id, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.transaction(() => {
      const counts = new Map<string, number>();
      for (const p of pairs) {
        let sender = p.sender_id;
        if (sender !== PAIR_OTHER && !seen.get(p.hour, sender, p.receiver_id)) {
          const k = `${p.hour} ${p.receiver_id}`;
          let n = counts.get(k);
          if (n === undefined) n = (senders.get(p.hour, p.receiver_id, PAIR_OTHER) as { n: number }).n;
          if (n >= maxSenders) sender = PAIR_OTHER;
          else counts.set(k, n + 1);
        }
        upsertPair.run(p.hour, sender, p.receiver_id,
          p.msgs, p.delivered, p.failed, p.refused, p.passed, p.held, p.flagged, p.unchecked, p.lat_n, p.lat_ms,
          ...H.map((_, i) => p.h[i] ?? 0));
      }
      for (const c of compute) {
        upsertCompute.run(c.hour, c.agent_id, c.payer, c.jobs, c.job_ms, c.failed, c.mem_mb, c.tokens_in, c.tokens_out, c.cost_micros);
      }
      for (const e of events) {
        insertEvent.run(e.id, e.at, e.sender_id, e.receiver_id, e.outcome, e.reason, e.ms, e.account_id, e.message_id, e.state);
      }
    })();
  }

  async read(agents: string[], sinceHour: string): Promise<MonitorRead> {
    const ids = agents.slice(0, MAX_IDS);
    if (!ids.length) return { pairs: [], compute: [] };
    const q = ids.map(() => "?").join(",");
    const pairs = (this.db.prepare(`SELECT * FROM monitor_pair_hour WHERE hour >= ? AND (sender_id IN (${q}) OR receiver_id IN (${q}))`)
      .all(sinceHour, ...ids, ...ids) as Record<string, unknown>[]).map(pairOf);
    const compute = (this.db.prepare(`SELECT * FROM monitor_compute_hour WHERE hour >= ? AND (agent_id IN (${q}) OR payer IN (${q}))`)
      .all(sinceHour, ...ids, ...ids) as Record<string, unknown>[]).map(computeOf);
    return { pairs, compute };
  }

  async events(agents: string[], sinceMs: number, limit: number): Promise<MonitorEvent[]> {
    const ids = agents.slice(0, MAX_IDS);
    if (!ids.length) return [];
    const q = ids.map(() => "?").join(",");
    return (this.db.prepare(`
      SELECT * FROM monitor_events
      WHERE at >= ? AND (receiver_id IN (${q}) OR (sender_id IN (${q}) AND outcome IN ('failed', 'refused')))
      ORDER BY at DESC, id DESC LIMIT ?`).all(sinceMs, ...ids, ...ids, limit) as Record<string, unknown>[]).map(eventOf);
  }

  async event(id: string): Promise<MonitorEvent | null> {
    const r = this.db.prepare("SELECT * FROM monitor_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? eventOf(r) : null;
  }

  async decide(id: string, state: "released" | "discarded"): Promise<boolean> {
    return this.db.prepare("UPDATE monitor_events SET state = ? WHERE id = ? AND state = 'open'").run(state, id).changes > 0;
  }

  async openHeld(agents: string[], sinceMs: number): Promise<number> {
    const ids = agents.slice(0, MAX_IDS);
    if (!ids.length) return 0;
    const q = ids.map(() => "?").join(",");
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM monitor_events WHERE at >= ? AND outcome = 'held' AND state = 'open' AND receiver_id IN (${q})`)
      .get(sinceMs, ...ids) as { n: number }).n;
  }

  async prune(cutoffHour: string, cutoffMs: number): Promise<void> {
    this.db.prepare("DELETE FROM monitor_pair_hour WHERE hour < ?").run(cutoffHour);
    this.db.prepare("DELETE FROM monitor_compute_hour WHERE hour < ?").run(cutoffHour);
    this.db.prepare("DELETE FROM monitor_events WHERE at < ?").run(cutoffMs);
  }

  async forget(agentId: string): Promise<number> {
    return this.db.transaction(() => this.forgetInside(agentId))();
  }

  /** The deletes alone, for a caller already inside a transaction (the
   *  backend's own deleteAgent, so a closure never half-deletes). */
  forgetInside(agentId: string): number {
    return this.db.prepare("DELETE FROM monitor_pair_hour WHERE sender_id = ? OR receiver_id = ?").run(agentId, agentId).changes +
      this.db.prepare("DELETE FROM monitor_compute_hour WHERE agent_id = ?").run(agentId).changes +
      this.db.prepare("DELETE FROM monitor_events WHERE sender_id = ? OR receiver_id = ?").run(agentId, agentId).changes +
      this.db.prepare("DELETE FROM monitor_alarms WHERE scope = ?").run(agentId).changes;
  }

  async alarms(accountId: string | null): Promise<Alarm[]> {
    const rows = accountId === null
      ? this.db.prepare("SELECT * FROM monitor_alarms ORDER BY created_at").all()
      : this.db.prepare("SELECT * FROM monitor_alarms WHERE account_id = ? ORDER BY created_at").all(accountId);
    return (rows as Record<string, unknown>[]).map(alarmOf);
  }

  async putAlarm(a: Alarm): Promise<void> {
    this.db.prepare(`
      INSERT INTO monitor_alarms (id, account_id, scope, kind, threshold, created_at, state, value, since, emailed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, value = excluded.value, since = excluded.since,
        emailed_at = excluded.emailed_at, threshold = excluded.threshold`)
      .run(a.id, a.account_id, a.scope, a.kind, a.threshold, a.created_at, a.state, a.value, a.since, a.emailed_at);
  }

  async deleteAlarm(id: string, accountId: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM monitor_alarms WHERE id = ? AND account_id = ?").run(id, accountId).changes > 0;
  }
}
