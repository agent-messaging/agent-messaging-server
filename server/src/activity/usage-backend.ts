/**
 * The storage contract behind the usage counters, and the types that cross it.
 *
 * `UsageStore` (usage-store.ts) owns everything that is NOT storage: the
 * in-memory delta map, the flush interval, the once-per-UTC-day prune guard and
 * the order those happen in. A backend owns only the persistence, so the
 * batching semantics and the retention behaviour are identical whichever one is
 * configured, by construction rather than by two implementations agreeing.
 *
 * Two backends exist:
 *   - usage-sqlite.ts   — a local file. The default, and the only one a
 *                         single-machine deployment needs.
 *   - usage-postgres.ts — a shared database, so two service instances count
 *                         into the same rows instead of two divergent files.
 *
 * Every method is async because one of the two talks to a network. The SQLite
 * implementation resolves immediately and does no more work than it did when it
 * was synchronous.
 */

import type { MonitorTables } from "./monitor-types.js";

/** Per-agent lifetime totals (EXT-2 step 1). */
export interface AgentUsage {
  agent_id: string;
  messages_in: number;
  messages_out: number;
  bytes_in: number;
  bytes_out: number;
  errors: number;
  first_seen: number;   // epoch ms
  last_active: number;  // epoch ms
}

/** Per-agent, per-UTC-day counters — what the published fair-use limits are
 *  measured against. */
export interface DailyUsage {
  agent_id: string;
  day: string;          // UTC, YYYY-MM-DD
  msgs_in: number;
  msgs_out: number;
  bytes_in: number;
  bytes_out: number;
  delivered_msgs: number;
  delivered_bytes: number;
  errors: number;
}

export interface UsageSummary {
  today: { day: string; messages: number; bytes: number; delivered_bytes: number; active_agents: number };
  days: Array<{ day: string; messages: number; bytes: number; active_agents: number }>;
  top: Array<{ agent_id: string; msgs: number; delivered_bytes: number }>;
}

/**
 * Per-counterparty, per-UTC-day counters — the fold of §13.5 meter events that
 * makes consumption attributable in both directions. One table answers both
 * questions: rows grouped by `provider_id` are "who did I serve", rows grouped
 * by `consumer_id` are "whose agents did I consume".
 *
 * Cardinality is bounded twice: daily rows only (never lifetime), and at most
 * MAX_PEERS_PER_AGENT_DAY distinct consumers per provider per day — the tail
 * folds into the reserved counterparty id `~other`, so one busy public agent
 * cannot grow the table with the square of the mesh. `~` is not a legal nkey
 * character, so the sentinel can never collide with a real agent.
 */
export interface PeerDelta {
  requests: number;
  responses: number;
  bytes_in: number;
  bytes_out: number;
  errors: number;
  /** Admission refusals (quantity-0 `requests` events): demand that was
   *  declined — the consumer's "what did I fail to buy" and the provider's
   *  "what work did I turn away". */
  refusals: number;
}

/** One counterparty's aggregate, as the read path answers it. */
export interface PeerUsage extends PeerDelta {
  peer_id: string;
  days_active: number;
}

/** The reserved counterparty id the per-day tail folds into. */
export const PEER_OTHER = "~other";

/** One agent's un-flushed counters. Accumulated in memory, applied as a batch. */
export interface Delta {
  in: number;
  out: number;
  bin: number;
  bout: number;
  dmsgs: number;
  dbytes: number;
  err: number;
  first: number;
  last: number;
}

/** UTC day key, matching the "per day" in the published limits. */
export function dayKey(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * What a usage backend has to be able to do.
 *
 * Note what is NOT here: no read-then-write pair, and no "set" of any kind.
 * Every write is an ADDITIVE upsert applied inside the store, which is what lets
 * two instances write to the same row without either losing the other's
 * increments. A backend that offered `get` + `put` could not make that promise.
 */
export interface UsageBackend {
  /** Which one this is, for logging and for tests that assert the fallback. */
  readonly kind: "sqlite" | "postgres";

  /** The Monitor's hourly rows, exceptions and alarms, on the same database
   *  (monitor-types.ts). */
  readonly monitor: MonitorTables;

  /**
   * Apply one batch of deltas: add each agent's counters to its lifetime row and
   * to its row for `day`, atomically.
   *
   * `batch` has at most one entry per agent id (it comes from a Map), which is
   * what lets both backends do it as one multi-row upsert per table.
   */
  write(day: string, batch: Array<[string, Delta]>): Promise<void>;

  /** Drop daily rows for days strictly before `cutoffDay` (the 90-day bound). */
  prune(cutoffDay: string): Promise<void>;

  /** Lifetime totals, most recently active first. `limit` is already capped. */
  listLifetime(limit: number): Promise<AgentUsage[]>;

  /**
   * `day`'s counters for `agentIds`, in the order the ids were given, omitting
   * ids with no row. `agentIds` is already capped.
   */
  dailyFor(day: string, agentIds: string[]): Promise<DailyUsage[]>;

  /** Mesh-wide aggregate: `today`'s totals, the per-day series for days strictly
   *  after `sinceDay`, and `today`'s top talkers by delivered bytes. */
  aggregate(today: string, sinceDay: string, topN: number): Promise<UsageSummary>;

  /**
   * Apply one batch of per-counterparty deltas to `day`'s peer rows,
   * additively (same upsert discipline as `write`). A NEW (provider, consumer)
   * pair on a day where the provider already has `maxPeers` distinct
   * counterparties is accounted to `PEER_OTHER` instead — the cap is per
   * provider per day, enforced at write time so the table's cardinality is a
   * promise rather than a hope.
   */
  writePeers(
    day: string,
    batch: Array<[provider: string, consumer: string, delta: PeerDelta]>,
    maxPeers: number,
  ): Promise<void>;

  /**
   * Both directions for one agent over days strictly after `sinceDay`:
   * `served` groups by consumer over rows where the agent is the provider,
   * `consumed` groups by provider over rows where the agent is the consumer.
   * Each side ordered by requests descending, capped at `limit`.
   */
  peersFor(
    agentId: string,
    sinceDay: string,
    limit: number,
  ): Promise<{ served: PeerUsage[]; consumed: PeerUsage[] }>;

  /** Drop peer rows for days strictly before `cutoffDay` (same bound as the
   *  daily rollups — the peer table is a daily rollup). */
  prunePeers(cutoffDay: string): Promise<void>;

  /** Forget one agent: its lifetime row and every daily row. Returns the rows
   *  removed from each. Idempotent — an unknown agent returns zeroes.
   *
   *  Peer rows go on BOTH sides (as provider and as consumer): a peer row is
   *  identity-resolved usage of the closed account (EXT-2 §8's purge), and the
   *  counterparty keeps its own aggregate counters in agent_stats — what it
   *  loses is the per-peer detail naming the deleted agent, which is the
   *  point of deleting it. */
  deleteAgent(agentId: string): Promise<{ lifetime: number; daily: number }>;

  close(): Promise<void>;
}
