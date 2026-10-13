/**
 * The §13.5 usage receipt, responder side: declared meter quantities a host
 * reports during a dispatch, attached to the terminal respond as
 * `payload.usage` — where the envelope signature already covers them, which is
 * the whole design ("a usage report is a signed receipt with no new
 * signature"). The platform lifts the entries into declared meter events at
 * delivery; the signature proves authorship, not truth.
 *
 * This is the quantity twin of the EXT-8 allowance's money ledger: the
 * allowance meters what usage COSTS the owner (and feeds `payload.cost`,
 * §19.3); this ledger records what was CONSUMED, in the responder's own named
 * units (`tokens_out`, `tool_calls`, …), and feeds `payload.usage`. They are
 * reported separately because they answer different questions and only one of
 * them requires a cost model.
 */

import { MeshError, ErrorCode } from "../types/errors.js";

/** §13.5: the closed set of observed meter names. A DECLARED meter must not
 *  collide with them — the class is a trust statement, and a collision would
 *  launder a responder's claim as a platform observation. Mirrors the set in
 *  conformance/metering.json (`observed_meters`). */
export const OBSERVED_METERS: ReadonlySet<string> = new Set([
  "requests",
  "responses",
  "events",
  "bytes_in",
  "bytes_out",
  "tasks_completed",
  "task_ms",
]);

const METER_NAME_RE = /^[a-z0-9_]{1,64}$/;

/** One receipt entry: `{ meter, quantity }`, quantity a non-negative integer
 *  in the meter's unit (fractional units do not exist — §13.5). */
export interface UsageEntry {
  meter: string;
  quantity: number;
}

/** Validate one report. Throws INPUT_INVALID — a malformed meter report is a
 *  host programming error and must fail at the report site, not surface as a
 *  quietly absent receipt three calls later. */
export function validateMeterReport(meter: string, quantity: number): void {
  if (typeof meter !== "string" || !METER_NAME_RE.test(meter)) {
    throw new MeshError(
      ErrorCode.INPUT_INVALID,
      `meter name must match [a-z0-9_]{1,64} (§13.5): ${JSON.stringify(meter).slice(0, 80)}`,
    );
  }
  if (OBSERVED_METERS.has(meter)) {
    throw new MeshError(
      ErrorCode.INPUT_INVALID,
      `'${meter}' is an OBSERVED meter (§13.5) — a responder declares its own meters ` +
        `(tokens_in, tokens_out, model_ms, tool_calls, …), never the platform's`,
    );
  }
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 0) {
    throw new MeshError(
      ErrorCode.INPUT_INVALID,
      `meter quantity must be a non-negative integer (§13.5: a meter that needs ` +
        `fractions has the wrong unit): ${String(quantity)}`,
    );
  }
}

/** How many tasks' un-attached reports are held before the oldest is dropped.
 *  A task whose terminal respond never happens (crash, cancel-with-no-reply)
 *  must not leak its accumulator forever; first-seen eviction, the same shape
 *  as every other bounded ledger in this SDK. */
const MAX_TASKS = 1000;

/**
 * Per-task accumulation of declared meter reports. `report` is ADDITIVE within
 * a task (two model calls both reporting `tokens_out` sum); `take` returns the
 * task's entries — sorted by meter name, so the receipt's canonical bytes are
 * deterministic for identical reports — and forgets them, because the terminal
 * respond is the receipt and a second terminal respond must not double-report.
 */
export class MeterUsageLedger {
  private tasks = new Map<string, Map<string, number>>();

  report(taskId: string, meter: string, quantity: number): void {
    validateMeterReport(meter, quantity);
    if (!taskId) return;
    let m = this.tasks.get(taskId);
    if (!m) {
      m = new Map();
      this.tasks.set(taskId, m);
      if (this.tasks.size > MAX_TASKS) {
        const oldest = this.tasks.keys().next().value as string;
        this.tasks.delete(oldest);
      }
    }
    m.set(meter, (m.get(meter) ?? 0) + quantity);
  }

  /** The task's receipt entries, or null when nothing was reported. Clears the
   *  task's accumulator — attach-once. */
  take(taskId: string): UsageEntry[] | null {
    const m = this.tasks.get(taskId);
    if (!m || m.size === 0) return null;
    this.tasks.delete(taskId);
    return Array.from(m.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([meter, quantity]) => ({ meter, quantity }));
  }
}
