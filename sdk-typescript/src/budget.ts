import type { Budget, CostCeiling } from "./types/envelope.js";
import { MeshError, ErrorCode } from "./types/errors.js";
import { MAX_CLOCK_SKEW_AHEAD_MS } from "./constants.js";

// The budget (§7.7): the requester's statement of the most a piece of work may
// cost and the latest it may finish. This module is the shared arithmetic —
// validation, the deadline predicates, and the typed refusals a responder uses
// at admission (BUDGET_INSUFFICIENT / DEADLINE_UNMEETABLE) and at the ceiling
// (BUDGET_EXHAUSTED). The lifecycle — attaching a budget to a request, revising
// it on a Task, latest-wins bookkeeping — lives on AgentMesh.

/** A budget revision as a caller states it: the whole budget (revisions are
 *  absolute, never deltas — §7.7), with `revision` optional because the SDK
 *  tracks the current revision per task and increments it when omitted. */
export type BudgetRevision = Omit<Budget, "revision"> & { revision?: number };

/** An RFC-3339 date-time instant. Any offset form is accepted (§22.3: a
 *  receiver that recognises only a trailing `Z` refuses perfectly good
 *  messages); a bare date is not — a deadline is a moment, not a day. */
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** Parse an RFC-3339 deadline to epoch ms, or NaN when it is not one. */
function parseDeadline(deadline: string): number {
  if (!RFC3339_RE.test(deadline)) return NaN;
  // RFC 3339 permits a space or lowercase `t` as the separator and a lowercase
  // `z`; Date.parse is only guaranteed the uppercase `T`/`Z` forms, so
  // normalize rather than refuse perfectly good instants (§22.3).
  const normalized =
    deadline.slice(0, 10) + "T" + deadline.slice(11).replace(/z$/, "Z");
  return Date.parse(normalized);
}

function invalid(message: string): MeshError {
  return new MeshError(ErrorCode.INVALID_ENVELOPE, `Invalid budget (§7.7): ${message}`, {
    retryable: false,
  });
}

/**
 * Validate a budget block (§7.7, §19.3). Throws `INVALID_ENVELOPE` unless:
 *
 * - `revision` is an integer >= 0 (0 on the initiating request, +1 per revision);
 * - at least one of `deadline` / `cost_ceiling` is present — a budget that
 *   constrains nothing is not a budget;
 * - `deadline`, when present, is an RFC-3339 instant;
 * - `cost_ceiling.amount_micro`, when present, is a non-negative integer —
 *   micro-units, because no floating point ever touches money (§19.3) — and
 *   `cost_ceiling.currency` is an ISO 4217 code.
 */
export function validateBudget(budget: unknown): asserts budget is Budget {
  if (typeof budget !== "object" || budget === null || Array.isArray(budget)) {
    throw invalid("budget must be a non-null object");
  }
  const b = budget as Record<string, unknown>;

  if (!Number.isSafeInteger(b.revision) || (b.revision as number) < 0) {
    throw invalid("'revision' is required and must be an integer >= 0");
  }

  if (b.deadline === undefined && b.cost_ceiling === undefined) {
    throw invalid("at least one of 'deadline' / 'cost_ceiling' must be present");
  }

  if (b.deadline !== undefined) {
    if (typeof b.deadline !== "string" || Number.isNaN(parseDeadline(b.deadline))) {
      throw invalid("'deadline' must be an RFC-3339 date-time instant");
    }
  }

  if (b.cost_ceiling !== undefined) {
    const c = b.cost_ceiling;
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      throw invalid("'cost_ceiling' must be an object (§19.3)");
    }
    const cc = c as Record<string, unknown>;
    if (!Number.isSafeInteger(cc.amount_micro) || (cc.amount_micro as number) < 0) {
      throw invalid(
        "'cost_ceiling.amount_micro' must be a non-negative integer of micro-units — never a float (§19.3)",
      );
    }
    if (typeof cc.currency !== "string" || !/^[A-Z]{3}$/.test(cc.currency)) {
      throw invalid("'cost_ceiling.currency' must be an ISO 4217 code (e.g. \"USD\")");
    }
  }
}

/**
 * Whether a budget's deadline has passed, under the same clock-skew tolerance
 * as the §22.3 freshness window and at second granularity.
 *
 * Two deliberate softenings, both from §7.7:
 *
 * - **Skew.** The deadline was written by another party's clock, so it is not
 *   treated as past until `now` exceeds it by more than `skewMs` — the same
 *   `MAX_CLOCK_SKEW_AHEAD_MS` every other timestamp comparison in this SDK
 *   uses. The grace runs in the deadline's favour on purpose: a completion
 *   that only *looks* late by clock disagreement must not be recorded late,
 *   and a responder must not down tools over the same disagreement.
 * - **Seconds.** Deadlines SHOULD NOT be finer than one second — below that a
 *   deadline measures network jitter, not the work — so the comparison is at
 *   whole-second granularity: sub-second differences never flip the verdict.
 *
 * A budget with no deadline (or an unparseable one — validateBudget's job to
 * refuse) is never past.
 */
export function pastDeadline(
  budget: Budget,
  nowMs: number = Date.now(),
  skewMs: number = MAX_CLOCK_SKEW_AHEAD_MS,
): boolean {
  if (budget.deadline === undefined) return false;
  const deadlineMs = parseDeadline(budget.deadline);
  if (Number.isNaN(deadlineMs)) return false;
  // Inclusive bound, like §22.3: exactly at deadline + skew is still inside.
  return Math.floor(nowMs / 1000) > Math.floor((deadlineMs + skewMs) / 1000);
}

/**
 * Milliseconds until the budget's deadline — negative once it has passed, and
 * `null` when the budget has no (parseable) deadline. The raw difference, with
 * no skew grace: this is a planning number ("how long do I have?"), and the
 * skew tolerance belongs only to the verdict (`pastDeadline`), where being
 * wrong penalises somebody.
 */
export function budgetRemainingMs(budget: Budget, nowMs: number = Date.now()): number | null {
  if (budget.deadline === undefined) return null;
  const deadlineMs = parseDeadline(budget.deadline);
  if (Number.isNaN(deadlineMs)) return null;
  return deadlineMs - nowMs;
}

/**
 * Admission refusal: the work cannot be done within the offered cost ceiling
 * (§7.7). Throw this from an `onRequest` handler *before doing any work* —
 * accepting work the budget never covered and then failing is the one outcome
 * §7.7 treats as the responder's fault.
 *
 * `estimate` is the responder's price for the work, carried in the error's
 * `details.estimate`. The refusal SHOULD carry it: refuse-with-estimate is the
 * negotiation mechanism — resubmitting with better terms is the counter-offer
 * (§10.4) — and a refusal without a number gives the requester nothing to
 * counter with.
 */
export function budgetInsufficient(estimate?: CostCeiling, message?: string): MeshError {
  return new MeshError(
    ErrorCode.BUDGET_INSUFFICIENT,
    message ??
      "Refused at admission: the work cannot be done within the offered cost ceiling (§7.7)",
    {
      retryable: false,
      details: estimate === undefined ? undefined : { estimate: { ...estimate } },
    },
  );
}

/**
 * Admission refusal: the work cannot be completed by the offered deadline
 * (§7.7). Throw this from an `onRequest` handler before doing any work.
 *
 * `earliestCompletion` is the responder's earliest realistic completion, an
 * RFC-3339 instant carried in the error's `details.earliest_completion` — the
 * time-axis half of refuse-with-estimate, so the requester can resubmit with a
 * deadline the work actually fits.
 */
export function deadlineUnmeetable(earliestCompletion?: string, message?: string): MeshError {
  return new MeshError(
    ErrorCode.DEADLINE_UNMEETABLE,
    message ??
      "Refused at admission: the work cannot be completed by the offered deadline (§7.7)",
    {
      retryable: false,
      details:
        earliestCompletion === undefined
          ? undefined
          : { earliest_completion: earliestCompletion },
    },
  );
}

/**
 * Thrown by a request handler that reached the cost ceiling mid-work (§7.7):
 * the responder MUST stop *before crossing it* and pause rather than press on
 * or fail. The SDK turns this into a non-terminal `input_required` reply
 * carrying `BUDGET_EXHAUSTED` and a `task_id` — which for a bare request is
 * the §7.0 promotion to a Task, since the budget conversation continues there.
 *
 * The input required is money: the requester either raises the budget by
 * revision (`reviseBudget`) and work resumes, or cancels and keeps the partial
 * artifacts. Hence `spent` (what has been spent so far) and
 * `estimate_to_finish` (what finishing would take) — the two numbers the
 * requester needs to make that call, carried in the error's `details` under
 * exactly those keys (conformance/budget.json pins them).
 */
export class BudgetExhaustedError extends MeshError {
  readonly spent?: CostCeiling;
  readonly estimate_to_finish?: CostCeiling;

  constructor(
    opts: { spent?: CostCeiling; estimate_to_finish?: CostCeiling; message?: string } = {},
  ) {
    const details: Record<string, unknown> = {};
    if (opts.spent !== undefined) details.spent = { ...opts.spent };
    if (opts.estimate_to_finish !== undefined) {
      details.estimate_to_finish = { ...opts.estimate_to_finish };
    }
    super(
      ErrorCode.BUDGET_EXHAUSTED,
      opts.message ??
        "Cost ceiling reached mid-work; the task is paused awaiting a budget revision or cancellation (§7.7)",
      {
        retryable: false,
        details: Object.keys(details).length > 0 ? details : undefined,
      },
    );
    this.name = "BudgetExhaustedError";
    this.spent = opts.spent;
    this.estimate_to_finish = opts.estimate_to_finish;
  }
}
