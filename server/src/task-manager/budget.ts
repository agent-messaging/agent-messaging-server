/**
 * The budget mechanism (§7.7), as the task manager sees it.
 *
 * A budget is the requester's statement of the most a piece of work may cost
 * and the latest it may finish: an absolute `deadline` (core), a `cost_ceiling`
 * (Economics extension, §19.3 — integer micro-units so no floating point ever
 * touches money), and a `revision` counter. It rides the OPTIONAL envelope
 * `budget` field (§5.2) — meaningful on `request` and on budget revisions,
 * ignored elsewhere.
 *
 * What the task manager enforces is deliberately only the half it CAN enforce
 * (§7.7 "Enforcement, honestly"): time. It holds Task state and its own clock
 * centrally, needs no cooperation from the responder, and so owns the overdue
 * mark and the late-completion record. The spend half is an honor-system MUST
 * between the parties — admission refusal (`BUDGET_INSUFFICIENT`,
 * `DEADLINE_UNMEETABLE`) and the mid-work ceiling pause (`BUDGET_EXHAUSTED`)
 * happen at the RESPONDER, which is why this module defines those codes but the
 * task manager never emits them itself.
 */

import type { Envelope, Task } from "../sdk.js";

// ─── §12.2: the four budget codes ───────────────────────────────────────────
//
// Defined here as string constants rather than added to the SDK `ErrorCode`
// enum, because the SDKs are integrated separately; the strings are the wire
// contract either way. None is retryable (§12.2).
export const BudgetCode = {
  /** Refused at admission: the work cannot fit the offered ceiling. Emitted by
   *  RESPONDERS, never by the task manager. */
  BUDGET_INSUFFICIENT: "BUDGET_INSUFFICIENT",
  /** Refused at admission: the work cannot finish by the offered deadline.
   *  Emitted by RESPONDERS, never by the task manager. */
  DEADLINE_UNMEETABLE: "DEADLINE_UNMEETABLE",
  /** Ceiling reached mid-work; Task paused in `input_required`. Emitted by
   *  RESPONDERS, never by the task manager. */
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  /** Recorded on a completion that arrived after the deadline. A marker, not a
   *  failure (§7.7) — the one code the task manager itself writes. */
  DEADLINE_EXCEEDED: "DEADLINE_EXCEEDED",
} as const;

// ─── Shapes ─────────────────────────────────────────────────────────────────

/** §19.3: integer micro-units (1,000,000 = one unit) + ISO 4217 code. */
export interface CostCeiling {
  amount_micro: number;
  currency: string;
}

/** §7.7: the budget block. `revision` REQUIRED; at least one axis present. */
export interface Budget {
  revision: number;
  deadline?: string;
  cost_ceiling?: CostCeiling;
}

/**
 * What the budget mechanism adds to the STORED task record. Additive fields on
 * the KV JSON — the SDK `Task` type is integrated separately, and a reader that
 * does not know these keys is unaffected by them.
 */
export interface TaskBudgetFields {
  /** The latest budget revision, whole (§7.7: revisions are absolute, never
   *  deltas — only the latest revision is stored, and it is the whole truth). */
  budget?: Budget;
  /** §7.7: the task manager marked this task past its deadline. A flag, NOT a
   *  lifecycle state — the task stays wherever it is in §7.2. */
  overdue?: boolean;
  /** When the overdue mark was applied (task manager's clock, the
   *  authoritative one per §7.7). */
  overdue_at?: string;
  /** §7.7: the completion arrived after the deadline. Accepted and recorded —
   *  what a late answer is worth is the requester's decision. */
  completed_late?: boolean;
  /** The responder's latest reported spend (§19.3 — informative, unverified:
   *  "you can oblige an agent to respect a ceiling, but you cannot oblige its
   *  spend report to be true"). Read from `payload.cost` on the responder's own
   *  updates; what the retroactive-ceiling check and the metering receipt use. */
  reported_spend?: CostCeiling;
}

export type BudgetTask = Task & TaskBudgetFields;

/** An envelope as it looks with the §5.2 `budget` field on it. The SDK
 *  `Envelope` type gains the field at SDK integration; the canonical signing
 *  bytes already cover it (§4.5 signs all fields except `sig`). */
export type BudgetEnvelope = Envelope & { budget?: unknown };

// ─── Validation ─────────────────────────────────────────────────────────────

/** ISO 4217: three uppercase letters. Shape check only — a currency whitelist
 *  is a policy question, not an envelope-validity one. */
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Validate a wire `budget` block. Returns the typed block, or a reason string
 * — the same accept-or-say-why shape the rest of the service uses at its doors.
 *
 * §7.7's rules, checked literally: `revision` REQUIRED (a non-negative
 * integer — it starts at 0 and only ever increments); at least one of
 * `deadline` / `cost_ceiling` present; `deadline` a parseable RFC 3339 instant
 * (§22.3 rule 1: any RFC 3339 form, so the check is "does it parse", not "does
 * it end in Z"); `amount_micro` an INTEGER (§19.3 exists so no floating point
 * ever touches money — a fractional micro-unit is exactly that).
 */
export function validateBudget(raw: unknown): Budget | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "budget must be an object";
  }
  const b = raw as Record<string, unknown>;

  if (b.revision === undefined) return "budget.revision is required";
  if (typeof b.revision !== "number" || !Number.isInteger(b.revision) || b.revision < 0) {
    return "budget.revision must be a non-negative integer";
  }

  if (b.deadline === undefined && b.cost_ceiling === undefined) {
    return "budget must carry at least one of deadline / cost_ceiling";
  }

  if (b.deadline !== undefined) {
    if (typeof b.deadline !== "string" || !Number.isFinite(Date.parse(b.deadline))) {
      return "budget.deadline is not a parseable RFC 3339 timestamp";
    }
  }

  if (b.cost_ceiling !== undefined) {
    const c = b.cost_ceiling as Record<string, unknown>;
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      return "budget.cost_ceiling must be an object";
    }
    if (
      typeof c.amount_micro !== "number" ||
      !Number.isInteger(c.amount_micro) ||
      c.amount_micro < 0
    ) {
      return "budget.cost_ceiling.amount_micro must be a non-negative integer";
    }
    if (typeof c.currency !== "string" || !CURRENCY_RE.test(c.currency)) {
      return "budget.cost_ceiling.currency must be an ISO 4217 code";
    }
  }

  return raw as Budget;
}

// ─── Deadline comparison ────────────────────────────────────────────────────

/**
 * §22.3's clock-skew tolerance, applied to deadline comparisons as §7.7
 * requires. Same 5 minutes as `max_clock_skew_ahead` (and as `FUTURE_SKEW_MS`
 * in api/ci-results.ts, the other place this service compares a wire timestamp
 * against its own clock): the requester set the deadline on ITS clock, and a
 * deadline is only treated as passed once it is past by more than the skew two
 * honest clocks may legitimately disagree by.
 */
export const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Has this deadline passed, on the task manager's own clock (authoritative per
 * §7.7)? Compared at SECOND granularity — §7.7: a deadline finer than one
 * second measures network jitter, not the work — and under the §22.3 skew
 * tolerance, so it answers true only when the deadline is past beyond any
 * legitimate clock disagreement. Used identically at all three sites: the
 * overdue sweep, the late-completion record, and the no-retroactive-violation
 * check on a revision.
 */
export function deadlinePassed(deadline: string, nowMs: number = Date.now()): boolean {
  const overshootMs = nowMs - CLOCK_SKEW_MS - Date.parse(deadline);
  // Passed only once a FULL second beyond the skew bound: an instant exactly at
  // a bound is inside the window (§22.3's inclusive-bounds rule, applied here),
  // and a sub-second overshoot is jitter, not lateness (§7.7).
  return overshootMs >= 1000;
}

// ─── Spend reports ──────────────────────────────────────────────────────────

/**
 * The responder's reported spend off an update's `payload.cost` (§19.3), if
 * one is present and well-formed. Malformed spend is ignored rather than
 * refused: it is informative-only, and a bad claim must not block a genuine
 * state transition.
 */
export function spendFromPayload(payload: unknown): CostCeiling | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const cost = (payload as Record<string, unknown>).cost;
  if (typeof cost !== "object" || cost === null) return undefined;
  const c = cost as Record<string, unknown>;
  if (typeof c.amount_micro !== "number" || !Number.isInteger(c.amount_micro) || c.amount_micro < 0) {
    return undefined;
  }
  if (typeof c.currency !== "string" || !CURRENCY_RE.test(c.currency)) return undefined;
  return { amount_micro: c.amount_micro, currency: c.currency };
}
