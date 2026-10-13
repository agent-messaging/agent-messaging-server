/**
 * Monitor: the hourly aggregates and the exceptions log behind the app's
 * Monitor page (owner approved 2026-09-29).
 *
 * The usage store's rule holds here too, and is the reason for every shape in
 * this file: this is NOT a message archive. No payloads, no previews, no
 * per-message rows for ordinary traffic. What is kept:
 *
 *  - PAIR HOURS. One row per (hour, sender, receiver): how many messages, how
 *    they came out (delivered, failed, refused), what the guard said (passed,
 *    held, flagged, unchecked) and a delivery-time histogram, which is enough
 *    for the median and the slowest 5% without keeping any single time. An
 *    agent's own totals are the sum of the rows it is on, so there is no
 *    second per-agent table to drift from this one.
 *  - COMPUTE HOURS. One row per (hour, agent, payer): jobs, run time, failed
 *    jobs, memory peak where the host knows it, model tokens and spend. The
 *    payer is the AGENT that sent the work, so an account using an
 *    AgentMesh platform agent can be shown the jobs its own agents sent and
 *    nobody else's.
 *  - EVENTS. Only the exceptions: held, flagged, unchecked, failed, refused.
 *    Who, when, the outcome, a reason category in words and the timing.
 *    Never what a message said.
 *  - ALARMS. What an account asked to be emailed about, and each alarm's
 *    last state. Configuration, kept beside the numbers it reads.
 *
 * Retention: hourly rows and events 30 days (RETAIN_MONITOR_DAYS). Thirty,
 * because the page's longest range is 30 days and nothing reads further back;
 * the daily usage rollups keep their own 90.
 */

/** Hourly rows and events are kept this long. */
export const RETAIN_MONITOR_DAYS = 30;

/** Upper bounds, in ms, of the delivery-time buckets; one more bucket holds
 *  everything slower than the last. Twelve buckets, roughly doubling, from a
 *  quarter second to five minutes: a median or a slowest-5% read off them is
 *  good to about one bucket, which is as fine as a person reads a chart. */
export const LAT_BOUNDS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;
export const LAT_BUCKETS = LAT_BOUNDS_MS.length + 1;

/** The exceptions the log keeps. Ordinary delivered traffic is never a row. */
export type MonitorOutcome = "held" | "flagged" | "unchecked" | "failed" | "refused";
export const MONITOR_OUTCOMES: readonly MonitorOutcome[] = ["held", "flagged", "unchecked", "failed", "refused"];

/** What a held row came to. "" for every outcome that has no decision. */
export type EventState = "open" | "released" | "discarded" | "";

/** A distinct sender beyond this many, for one receiver in one hour, is
 *  counted under PAIR_OTHER, so a public agent cannot grow the table with
 *  the square of the mesh. */
export const MAX_SENDERS_PER_RECEIVER_HOUR = 200;
export const PAIR_OTHER = "~other";
/** Exceptions kept per receiving agent per hour; past it they still count in
 *  the pair rows, and the log says nothing more that hour. */
export const MAX_EVENTS_PER_AGENT_HOUR = 60;

export interface PairCounts {
  msgs: number;
  delivered: number;
  failed: number;
  refused: number;
  passed: number;
  held: number;
  flagged: number;
  unchecked: number;
  /** Deliveries timed, and their total, for a mean if one is ever wanted. */
  lat_n: number;
  lat_ms: number;
  /** The histogram, LAT_BUCKETS long. */
  h: number[];
}

export interface PairRow extends PairCounts {
  hour: string;
  sender_id: string;
  receiver_id: string;
}

export interface ComputeCounts {
  jobs: number;
  /** Run time, ms, summed over the jobs that reported one. */
  job_ms: number;
  failed: number;
  /** The largest memory peak reported, MB; 0 when none was. */
  mem_mb: number;
  tokens_in: number;
  tokens_out: number;
  /** Model spend in millionths of a dollar, so it stays an integer. */
  cost_micros: number;
}

export interface ComputeRow extends ComputeCounts {
  hour: string;
  agent_id: string;
  /** The agent that sent the work; "" when nobody could say. */
  payer: string;
}

export interface MonitorEvent {
  id: string;
  at: number;
  sender_id: string;
  receiver_id: string;
  outcome: MonitorOutcome;
  /** A reason category in words, never message content. */
  reason: string;
  /** Delivery time, ms, when there was one. */
  ms: number | null;
  /** For a hold at a hosted agent: the account whose mailbox holds it, and
   *  the message's id there, which is what Release and Discard act on. */
  account_id: string | null;
  message_id: string | null;
  state: EventState;
}

export type AlarmKind = "held" | "failed" | "slow" | "unchecked" | "silent";
export const ALARM_KINDS: readonly AlarmKind[] = ["held", "failed", "slow", "unchecked", "silent"];
export type AlarmState = "ALARM" | "OK" | "NOT ENOUGH DATA";

export interface Alarm {
  id: string;
  account_id: string;
  /** One agent's key, or "*" for every agent the account has. */
  scope: string;
  kind: AlarmKind;
  /** N in "above N an hour", "above N seconds", "for N hours"; null for the
   *  kinds that trip on any one event. */
  threshold: number | null;
  created_at: number;
  state: AlarmState;
  value: number | null;
  /** When the state last changed, and when it last emailed. */
  since: number;
  emailed_at: number;
}

/** What one account's page reads from storage. */
export interface MonitorRead {
  pairs: PairRow[];
  compute: ComputeRow[];
}

/** The monitor half of a usage backend (usage-backend.ts). Same database,
 *  same connection, same additive-upsert discipline as the counters. */
export interface MonitorTables {
  /** Add one batch: pair rows and compute rows additively (memory peak by
   *  MAX), events inserted once each. A NEW sender for a receiver that has
   *  `maxSenders` already this hour is counted under PAIR_OTHER. */
  write(pairs: PairRow[], compute: ComputeRow[], events: MonitorEvent[], maxSenders: number): Promise<void>;
  /** Pair rows at or after `sinceHour` where either side is in `agents`, and
   *  compute rows for `agents` or whose work one of `agents` sent. */
  read(agents: string[], sinceHour: string): Promise<MonitorRead>;
  /** Events at or after `sinceMs` where the receiver is in `agents`, or the
   *  sender is and the outcome is one the sender was told (failed, refused).
   *  Newest first. */
  events(agents: string[], sinceMs: number, limit: number): Promise<MonitorEvent[]>;
  event(id: string): Promise<MonitorEvent | null>;
  /** Decide an open hold. False when it was not open. */
  decide(id: string, state: "released" | "discarded"): Promise<boolean>;
  /** Open holds at or after `sinceMs` at any of `agents`. */
  openHeld(agents: string[], sinceMs: number): Promise<number>;
  prune(cutoffHour: string, cutoffMs: number): Promise<void>;
  /** Every row naming the agent on either side, gone (account closure). */
  forget(agentId: string): Promise<number>;
  /** An account's alarms, or every alarm when `accountId` is null. */
  alarms(accountId: string | null): Promise<Alarm[]>;
  putAlarm(a: Alarm): Promise<void>;
  deleteAlarm(id: string, accountId: string): Promise<boolean>;
}

// ── pure helpers ────────────────────────────────────────────────────────────

/** The UTC hour a moment falls in, "YYYY-MM-DDTHH". Sorts as it reads. */
export function hourKey(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 13);
}

/** The start of an hour key, epoch ms. */
export function hourStart(hour: string): number {
  return Date.parse(`${hour}:00:00.000Z`);
}

export function bucketOf(ms: number): number {
  for (let i = 0; i < LAT_BOUNDS_MS.length; i++) if (ms <= LAT_BOUNDS_MS[i]!) return i;
  return LAT_BUCKETS - 1;
}

export function emptyPair(): PairCounts {
  return { msgs: 0, delivered: 0, failed: 0, refused: 0, passed: 0, held: 0, flagged: 0, unchecked: 0, lat_n: 0, lat_ms: 0, h: new Array(LAT_BUCKETS).fill(0) };
}

export function emptyCompute(): ComputeCounts {
  return { jobs: 0, job_ms: 0, failed: 0, mem_mb: 0, tokens_in: 0, tokens_out: 0, cost_micros: 0 };
}

export const PAIR_FIELDS = ["msgs", "delivered", "failed", "refused", "passed", "held", "flagged", "unchecked", "lat_n", "lat_ms"] as const;
export const COMPUTE_SUM_FIELDS = ["jobs", "job_ms", "failed", "tokens_in", "tokens_out", "cost_micros"] as const;

/** Add `b` into `a`. */
export function addPair(a: PairCounts, b: PairCounts): PairCounts {
  for (const f of PAIR_FIELDS) a[f] += b[f];
  for (let i = 0; i < LAT_BUCKETS; i++) a.h[i]! += b.h[i] ?? 0;
  return a;
}

export function addCompute(a: ComputeCounts, b: ComputeCounts): ComputeCounts {
  for (const f of COMPUTE_SUM_FIELDS) a[f] += b[f];
  a.mem_mb = Math.max(a.mem_mb, b.mem_mb);
  return a;
}

/**
 * A quantile of a histogram, in ms, interpolated inside the bucket it falls
 * in. Null with nothing timed. The open top bucket answers its lower bound,
 * which under-reads the slowest deliveries rather than inventing a number.
 */
export function quantileMs(h: readonly number[], q: number): number | null {
  const n = h.reduce((s, v) => s + v, 0);
  if (n <= 0) return null;
  const want = Math.max(1, Math.ceil(q * n));
  let seen = 0;
  for (let i = 0; i < h.length; i++) {
    const c = h[i] ?? 0;
    if (c <= 0) continue;
    if (seen + c >= want) {
      const lo = i === 0 ? 0 : LAT_BOUNDS_MS[i - 1]!;
      if (i >= LAT_BOUNDS_MS.length) return lo;
      const hi = LAT_BOUNDS_MS[i]!;
      return Math.round(lo + ((want - seen) / c) * (hi - lo));
    }
    seen += c;
  }
  return LAT_BOUNDS_MS[LAT_BOUNDS_MS.length - 1]!;
}
