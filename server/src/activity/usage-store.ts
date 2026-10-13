/**
 * Usage stats store — the counters behind the published limits.
 *
 * Deliberately NOT a message archive: no payloads, no previews, no per-message
 * rows. Two tables:
 *
 *  - agent_stats: lifetime totals per agent (EXT-2 step 1), so
 *    "40 messages, last active yesterday" survives a service restart.
 *  - agent_stats_daily: per-agent, per-UTC-day counters — messages, bytes,
 *    and DELIVERED bytes (what the mesh sent on this agent's behalf). This is
 *    the table the fair-use numbers on agentmesh.ai/plans.html are measured
 *    against (~10k messages or 15 MB delivered per agent per day).
 *
 * Writes are batched: taps bump in-memory deltas and a timer flushes them in
 * one transaction, so the hot path never touches storage. Daily rows older than
 * RETAIN_DAYS are pruned once per UTC day by that same timer — before the
 * nothing-to-write early return, so retention does not depend on traffic.
 *
 * Erasure: `deleteAgentUsage` (bottom of this file) removes one agent from both
 * tables. The lifetime row has no age limit by design — "40 messages since you
 * joined" is the number it exists to answer — so account closure is the only
 * thing that ever takes it away, and until it existed there was no way out.
 *
 * ## Where the counters live
 *
 * Storage is behind `UsageBackend` (usage-backend.ts) and there are two:
 *
 *  - **Postgres**, when `USAGE_DB_URL` is set. Shared, so two service instances
 *    count into the same rows instead of two divergent files, and the delete path
 *    reaches the same rows whichever process calls it. This is the prerequisite
 *    for running more than one instance of the activity service or the API
 *    gateway.
 *  - **SQLite**, when it is not. A local file, exactly as before — same tables,
 *    same statements, same pragmas.
 *
 * A missing URL is a documented degradation, never an error. Every public deploy
 * bundle and every self-hoster on one machine runs the SQLite path, and nobody
 * should have to operate a database server to count messages. What they give up
 * is stated once, plainly: with SQLite the counters are per-machine, so a second
 * instance would keep its own set and the two would disagree.
 *
 * This file owns everything that is not storage — the delta map, the flush
 * interval, the prune ordering — so those behave identically on both backends by
 * construction rather than by two implementations happening to agree.
 */

import type {
  AgentUsage,
  DailyUsage,
  Delta,
  PeerDelta,
  PeerUsage,
  UsageBackend,
  UsageSummary,
} from "./usage-backend.js";
import { dayKey } from "./usage-backend.js";
import {
  MAX_EVENTS_PER_AGENT_HOUR,
  MAX_SENDERS_PER_RECEIVER_HOUR,
  RETAIN_MONITOR_DAYS,
  bucketOf,
  emptyCompute,
  emptyPair,
  hourKey,
  type ComputeCounts,
  type ComputeRow,
  type MonitorEvent,
  type MonitorRead,
  type MonitorTables,
  type PairCounts,
  type PairRow,
} from "./monitor-types.js";
import { randomUUID } from "node:crypto";
import { SqliteUsageBackend } from "./usage-sqlite.js";
import { PostgresUsageBackend } from "./usage-postgres.js";
import { dataDbPath } from "../data-dir.js";

export type {
  AgentUsage,
  DailyUsage,
  PeerDelta,
  PeerUsage,
  UsageSummary,
  UsageBackend,
} from "./usage-backend.js";
export { dayKey, PEER_OTHER } from "./usage-backend.js";

const FLUSH_INTERVAL_MS = 5_000;
const RETAIN_DAYS = 90;

/** Distinct counterparties one provider's peer rollup may name per day; the
 *  tail folds into PEER_OTHER (usage-backend.ts). 200 comfortably covers a
 *  fleet's real correspondents while bounding a public agent's row growth at
 *  ~200 rows/day instead of one per stranger. */
export const MAX_PEERS_PER_AGENT_DAY = 200;

/** Read caps, applied here so both backends receive the same already-capped
 *  numbers and the caps are pinned in one place. */
const MAX_LIST = 1000;
const MAX_TODAY_IDS = 100;
const MAX_SUMMARY_DAYS = 90;
const MAX_TOP = 50;

export interface UsageStoreOptions {
  /** Postgres connection URL. Absent falls back to `USAGE_DB_URL`; empty forces
   *  the SQLite path even when the environment sets one (used by tests). */
  url?: string;
  /** SQLite file path, consulted only when there is no URL. */
  dbPath?: string;
  /** Pre-built pool, for tests that drive the Postgres SQL without a server. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool?: any;
}

/** Resolve where the counters go. A bare string is a SQLite path, which is what
 *  the constructor has always taken. */
function resolveTarget(opts: string | UsageStoreOptions): {
  url: string;
  dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool?: any;
} {
  const o: UsageStoreOptions = typeof opts === "string" ? { dbPath: opts } : opts;
  return {
    url: o.url ?? process.env.USAGE_DB_URL ?? "",
    dbPath: o.dbPath ?? dataDbPath("USAGE_DB_PATH", "usage.db"),
    pool: o.pool,
  };
}

export class UsageStore {
  private backend: UsageBackend;
  private pending = new Map<string, Delta>();
  /** Per-counterparty deltas, keyed `provider\x1f consumer` (0x1f cannot occur
   *  in an nkey). Flushed beside `pending`, under the same day. */
  private pendingPeers = new Map<string, PeerDelta>();
  /** The Monitor's un-flushed deltas (monitor-types.ts): pair hours keyed
   *  `hour\x1f sender\x1f receiver`, compute hours `hour\x1f agent\x1f payer`,
   *  and the exceptions in arrival order. Same batching as the counters. */
  private pendingPairs = new Map<string, PairRow>();
  private pendingCompute = new Map<string, ComputeRow>();
  private pendingEvents: MonitorEvent[] = [];
  /** Exceptions logged per `hour agent` this process, for the per-hour cap. */
  private eventCounts = new Map<string, number>();
  private eventCountsHour = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPrunedDay = "";
  /** Failed flushes are logged at most once a minute. A down database would
   *  otherwise log every FLUSH_INTERVAL_MS for as long as it stays down. */
  private lastErrorLog = 0;

  constructor(opts: string | UsageStoreOptions = {}) {
    const { url, dbPath, pool } = resolveTarget(opts);
    if (url || pool) {
      this.backend = new PostgresUsageBackend(url, pool);
      console.log("[activity] usage counters: Postgres (USAGE_DB_URL) — shared across instances");
    } else {
      this.backend = new SqliteUsageBackend(dbPath);
      // A missing URL is a documented degradation, not an error — but it is worth
      // one line, because "the counters disagree between two instances" is very
      // hard to diagnose from the outside and trivial to explain here.
      console.log(
        `[activity] usage counters: SQLite ${dbPath} — USAGE_DB_URL unset, so these are LOCAL ` +
          `to this machine (correct for one instance; set USAGE_DB_URL to share them)`,
      );
    }
  }

  /** Which backend is in use — `"sqlite"` or `"postgres"`. */
  get kind(): UsageBackend["kind"] {
    return this.backend.kind;
  }

  /** Start the periodic flusher. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    // Don't hold the process open just to flush counters.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** A request arrived at an agent's inbox (bytes = envelope size on the wire). */
  recordIn(agentId: string, bytes = 0): void {
    const d = this.bump(agentId);
    d.in += 1;
    d.bin += bytes;
  }

  /** A response left an agent (failed=true counts an error too). */
  recordOut(agentId: string, failed: boolean, bytes = 0): void {
    const d = this.bump(agentId);
    d.out += 1;
    d.bout += bytes;
    if (failed) d.err += 1;
  }

  /** Additional response bytes on an already-counted exchange (task-mode
   *  multi-respond flows count one message but all bytes). */
  recordOutBytes(agentId: string, bytes: number): void {
    this.bump(agentId).bout += bytes;
  }

  /** The mesh delivered a message ON THIS SENDER'S BEHALF — the quantity the
   *  fair-use limit meters, and the quantity egress bills. A message to one
   *  agent is one delivery; the same bytes into a room of 20 would be 20. */
  recordDelivered(senderId: string, bytes = 0): void {
    const d = this.bump(senderId);
    d.dmsgs += 1;
    d.dbytes += bytes;
  }

  private bump(agentId: string): Delta {
    let d = this.pending.get(agentId);
    if (!d) {
      const now = Date.now();
      d = { in: 0, out: 0, bin: 0, bout: 0, dmsgs: 0, dbytes: 0, err: 0, first: now, last: now };
      this.pending.set(agentId, d);
    }
    d.last = Date.now();
    return d;
  }

  /** Account one observation to the (provider, consumer) peer rollup — the
   *  §13.5 fold's counterparty half. Same batching as the counters. */
  recordPeer(provider: string, consumer: string, patch: Partial<PeerDelta>): void {
    if (!provider || !consumer) return;
    const key = `${provider}\x1f${consumer}`;
    let d = this.pendingPeers.get(key);
    if (!d) {
      d = { requests: 0, responses: 0, bytes_in: 0, bytes_out: 0, errors: 0, refusals: 0 };
      this.pendingPeers.set(key, d);
    }
    d.requests += patch.requests ?? 0;
    d.responses += patch.responses ?? 0;
    d.bytes_in += patch.bytes_in ?? 0;
    d.bytes_out += patch.bytes_out ?? 0;
    d.errors += patch.errors ?? 0;
    d.refusals += patch.refusals ?? 0;
  }

  // ── the Monitor (monitor-types.ts) ────────────────────────────────────────

  /**
   * Count into one (hour, sender, receiver) row: a message sent, how it came
   * out, what a guard said, and its delivery time as a histogram bucket.
   * Never the message.
   */
  recordPair(
    sender: string,
    receiver: string,
    patch: Partial<Omit<PairCounts, "h" | "lat_n" | "lat_ms">> & { latMs?: number },
    at = Date.now(),
  ): void {
    if (!sender || !receiver) return;
    const hour = hourKey(at);
    const key = `${hour}\x1f${sender}\x1f${receiver}`;
    let row = this.pendingPairs.get(key);
    if (!row) {
      row = { hour, sender_id: sender, receiver_id: receiver, ...emptyPair() };
      this.pendingPairs.set(key, row);
    }
    for (const f of ["msgs", "delivered", "failed", "refused", "passed", "held", "flagged", "unchecked"] as const) {
      row[f] += patch[f] ?? 0;
    }
    if (typeof patch.latMs === "number" && Number.isFinite(patch.latMs) && patch.latMs >= 0) {
      row.lat_n += 1;
      row.lat_ms += Math.round(patch.latMs);
      row.h[bucketOf(patch.latMs)]! += 1;
    }
  }

  /** Count one agent's compute into its hour, under the agent that sent
   *  the work ("" when nobody could say). Memory peak keeps the largest. */
  recordCompute(agent: string, payer: string, patch: Partial<ComputeCounts>, at = Date.now()): void {
    if (!agent) return;
    const hour = hourKey(at);
    const key = `${hour}\x1f${agent}\x1f${payer}`;
    let row = this.pendingCompute.get(key);
    if (!row) {
      row = { hour, agent_id: agent, payer, ...emptyCompute() };
      this.pendingCompute.set(key, row);
    }
    for (const f of ["jobs", "job_ms", "failed", "tokens_in", "tokens_out", "cost_micros"] as const) {
      const v = patch[f];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) row[f] += Math.round(v);
    }
    if (typeof patch.mem_mb === "number" && Number.isFinite(patch.mem_mb)) row.mem_mb = Math.max(row.mem_mb, Math.round(patch.mem_mb));
  }

  /**
   * Log one exception. Returns its id, or null when this agent has already
   * logged MAX_EVENTS_PER_AGENT_HOUR this hour (it still counts in the pair
   * rows; the log just says no more). A hold is born "open".
   */
  recordEvent(e: Omit<MonitorEvent, "id" | "state"> & { id?: string }): string | null {
    const hour = hourKey(e.at);
    if (hour !== this.eventCountsHour) {
      this.eventCounts.clear();
      this.eventCountsHour = hour;
    }
    const capKey = e.receiver_id;
    const n = this.eventCounts.get(capKey) ?? 0;
    if (n >= MAX_EVENTS_PER_AGENT_HOUR) return null;
    this.eventCounts.set(capKey, n + 1);
    const id = e.id ?? randomUUID();
    this.pendingEvents.push({
      ...e,
      id,
      reason: e.reason.slice(0, 200),
      state: e.outcome === "held" && e.message_id ? "open" : "",
    });
    return id;
  }

  /** The Monitor's tables, for decisions and alarms. Reads go through
   *  `monitorRead`/`monitorEvents`, which flush this process's batch first. */
  get monitor(): MonitorTables {
    return this.backend.monitor;
  }

  async monitorRead(agents: string[], sinceHour: string): Promise<MonitorRead> {
    await this.flush();
    return this.backend.monitor.read(agents, sinceHour);
  }

  async monitorEvents(agents: string[], sinceMs: number, limit = 200): Promise<MonitorEvent[]> {
    await this.flush();
    return this.backend.monitor.events(agents, sinceMs, Math.min(Math.max(1, limit), 500));
  }

  /**
   * Write pending deltas in one transaction, and enforce RETAIN_DAYS.
   *
   * The prune comes FIRST, above the nothing-to-write early return. It used to
   * sit at the bottom of this method, below `if (this.pending.size === 0)
   * return`, which made the documented 90-day retention conditional on traffic:
   * a mesh with nothing to flush took the early return on every timer tick and
   * never reached the DELETE, so rows outlived the retention indefinitely on
   * exactly the quiet deployment where nothing else would trim them either. A
   * retention limit that only holds while somebody is talking is not a retention
   * limit.
   *
   * Nothing more elaborate than this ordering is needed, because `flush()`
   * ALREADY runs on a timer independent of traffic (`start()`, every
   * FLUSH_INTERVAL_MS) and the `lastPrunedDay` guard already keeps the DELETE to
   * once per UTC day. Hoisting it is the whole fix; a second timer would only
   * duplicate the one above.
   *
   * One consequence worth naming: the first flush after boot now prunes, where
   * before it was the first flush WITH TRAFFIC. That is a change in timing, not
   * in what goes — these are counters, not content (the activity ring's request
   * previews are the store that deliberately never deletes on load), and a row
   * past 90 days is past the published retention whether or not the service has
   * just restarted.
   *
   * The ordering lives HERE, above the backend, so it holds for SQLite and
   * Postgres alike. `lastPrunedDay` is per-instance, so with N instances the
   * prune runs up to N times a day rather than once — the DELETE is idempotent
   * and bounded by the same cutoff, so that costs a few redundant statements and
   * changes nothing about what is retained.
   *
   * A failed flush drops that batch, exactly as it always has: the counters for
   * one interval are lost and the mesh is unaffected. Buffering failed batches
   * for a retry would be a behaviour change and an unbounded memory risk while a
   * database stayed down, so it is not one this made.
   */
  async flush(): Promise<void> {
    const day = dayKey();

    if (this.lastPrunedDay !== day) {
      this.lastPrunedDay = day;
      const cutoff = dayKey(Date.now() - RETAIN_DAYS * 86_400_000);
      try { await this.backend.prune(cutoff); }
      catch { /* non-fatal */ }
      // The peer table is a daily rollup on the same retention bound.
      try { await this.backend.prunePeers(cutoff); }
      catch { /* non-fatal */ }
      // The Monitor's hours and exceptions keep 30 days, on the same once-a-day
      // guard, so it too holds on a mesh with nothing to write.
      const monitorCutoff = Date.now() - RETAIN_MONITOR_DAYS * 86_400_000;
      try { await this.backend.monitor.prune(hourKey(monitorCutoff), monitorCutoff); }
      catch { /* non-fatal */ }
    }

    if (this.pendingPairs.size > 0 || this.pendingCompute.size > 0 || this.pendingEvents.length > 0) {
      const pairs = [...this.pendingPairs.values()];
      const compute = [...this.pendingCompute.values()];
      const events = this.pendingEvents;
      this.pendingPairs = new Map();
      this.pendingCompute = new Map();
      this.pendingEvents = [];
      try {
        await this.backend.monitor.write(pairs, compute, events, MAX_SENDERS_PER_RECEIVER_HOUR);
      } catch (err) {
        this.logFlushError(err); // batch dropped, same policy as the counters
      }
    }

    if (this.pending.size > 0) {
      const batch = this.pending;
      this.pending = new Map();
      try {
        await this.backend.write(day, Array.from(batch.entries()));
      } catch (err) {
        this.logFlushError(err);
      }
    }

    if (this.pendingPeers.size > 0) {
      const peerBatch = this.pendingPeers;
      this.pendingPeers = new Map();
      try {
        await this.backend.writePeers(
          day,
          Array.from(peerBatch.entries()).map(([k, d]) => {
            const [prov, cons] = k.split("\x1f");
            return [prov, cons, d] as [string, string, PeerDelta];
          }),
          MAX_PEERS_PER_AGENT_DAY,
        );
      } catch (err) {
        this.logFlushError(err); // batch dropped, same policy as the counters
      }
    }
  }

  private logFlushError(err: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLog < 60_000) return;
    this.lastErrorLog = now;
    console.error("[activity] usage flush failed:", err instanceof Error ? err.message : err);
  }

  /**
   * Forget one agent completely: its lifetime `agent_stats` row and every
   * `agent_stats_daily` row. Returns how many rows of each went.
   *
   * This is the erasure path EXT-2 §8 requires ("account deletion purges usage
   * records") and that nothing implemented — the daily rows expire after
   * RETAIN_DAYS, but the lifetime row beside them had no retention limit and no
   * way out at all, so a closed account's totals stayed forever.
   *
   * It drops any un-flushed in-memory delta for the agent FIRST, or the next
   * `flush()` five seconds later would write the row straight back. Everything
   * else is the backend's: both DELETEs inside one transaction so a closure never
   * half-deletes, and on SQLite the zeroing of freed pages and the WAL checkpoint
   * that make the id gone from the file rather than merely unreachable by query.
   * `PostgresUsageBackend.deleteAgent` states what changes there and why there is
   * no client-side equivalent.
   *
   * Idempotent: deleting an agent that was never seen returns zeroes.
   */
  async deleteAgent(agentId: string): Promise<{ lifetime: number; daily: number }> {
    this.pending.delete(agentId);
    // Un-flushed peer deltas naming the agent on either side go too, or the
    // next flush writes a row straight back — same reasoning as `pending`.
    for (const key of this.pendingPeers.keys()) {
      const [prov, cons] = key.split("\x1f");
      if (prov === agentId || cons === agentId) this.pendingPeers.delete(key);
    }
    // The Monitor's rows naming the agent go too, pending ones first.
    for (const [key, r] of this.pendingPairs) if (r.sender_id === agentId || r.receiver_id === agentId) this.pendingPairs.delete(key);
    for (const [key, r] of this.pendingCompute) if (r.agent_id === agentId) this.pendingCompute.delete(key);
    this.pendingEvents = this.pendingEvents.filter((e) => e.sender_id !== agentId && e.receiver_id !== agentId);
    // The backend deletes them in the same transaction as the counters.
    return this.backend.deleteAgent(agentId);
  }

  /** Both directions for one agent: who it served, whose agents it consumed —
   *  the two-sided view the §13.5 stream exists to answer. `days` is a lookback
   *  window over the daily rollups (capped at the retention bound). */
  async peers(
    agentId: string,
    days = 30,
    limit = 100,
  ): Promise<{ since: string; served: PeerUsage[]; consumed: PeerUsage[] }> {
    await this.flush();
    const window = Math.min(Math.max(1, days), RETAIN_DAYS);
    // `day > since` is strict, so subtract one more day to include the whole window.
    const since = dayKey(Date.now() - (window + 1) * 86_400_000);
    const both = await this.backend.peersFor(agentId, since, Math.min(Math.max(1, limit), 200));
    return { since, ...both };
  }

  /** Per-agent lifetime totals, most recently active first. */
  async list(limit = 100): Promise<AgentUsage[]> {
    await this.flush(); // serve fresh numbers
    return this.backend.listLifetime(Math.min(limit, MAX_LIST));
  }

  /** Today's counters for specific agents (missing ids = zero usage today). */
  async today(agentIds: string[]): Promise<DailyUsage[]> {
    await this.flush();
    return this.backend.dailyFor(dayKey(), agentIds.slice(0, MAX_TODAY_IDS));
  }

  /** Mesh-wide aggregate: today's totals, a daily series, and top talkers by
   *  delivered bytes — what the operator console's aggregate view reads. */
  async summary(days = 7, topN = 10): Promise<UsageSummary> {
    await this.flush();
    const since = dayKey(Date.now() - Math.min(days, MAX_SUMMARY_DAYS) * 86_400_000);
    return this.backend.aggregate(dayKey(), since, Math.min(topN, MAX_TOP));
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    await this.backend.close();
  }
}

/**
 * Delete one agent's usage stats — the hook for an account-closure cascade.
 *
 * A plain function over the STORAGE rather than a method call, because the closer
 * is not the activity service: account deletion runs in the API gateway, in a
 * different process, and has no handle on the live `UsageStore`. It opens its own
 * connection to whatever is configured, deletes, and closes.
 *
 * On the SQLite path that means opening the same file the running service holds,
 * which is safe: SQLite in WAL mode takes concurrent writers. On the Postgres path
 * it is a second short-lived pool against the same rows, which is the whole point
 * — before this, a second instance would have deleted out of the wrong file.
 *
 * Call it once per agent id on the account (`Account.agents`), not once per
 * account — these tables are keyed by agent public key and know nothing about
 * accounts.
 *
 * Two caveats the caller needs:
 *
 *  - The activity service may hold up to FLUSH_INTERVAL_MS of un-flushed
 *    counters for the agent and will write them after this returns, recreating
 *    the row with a last few messages on it. Deregister the agent first so its
 *    traffic has stopped; if the closure has to be airtight, call this again a
 *    few seconds later.
 *  - This removes COUNTERS only. The activity ring's request previews
 *    (`activity-service.ts`, `inputPreview`) are a separate store on a time
 *    bound and are not touched here.
 *
 * Returns the rows removed: `lifetime` is 0 or 1, `daily` is one per day the
 * agent was active inside the retention window.
 */
export async function deleteAgentUsage(
  agentId: string,
  opts: string | UsageStoreOptions = {},
): Promise<{ lifetime: number; daily: number }> {
  const store = new UsageStore(opts);
  try {
    return await store.deleteAgent(agentId);
  } finally {
    await store.close();
  }
}
