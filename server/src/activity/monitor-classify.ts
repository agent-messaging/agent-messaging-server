/**
 * How the Monitor names what happened to a message, from the answer the
 * activity tap saw. Pure, so the words are tested once and read the same on
 * every surface. A reason is a category in plain words, never anything the
 * message said.
 */
import { ADMISSION_REFUSAL_CODES } from "../shared/metering.js";

export type TapOutcome = { outcome: "delivered" } | { outcome: "failed" | "refused"; reason: string };

/** Codes that mean the recipient's door turned the message away, as opposed
 *  to a delivery that went wrong. */
const REFUSED: Record<string, string> = {
  BUDGET_INSUFFICIENT: "not enough budget for its price",
  DEADLINE_UNMEETABLE: "it could not meet the deadline asked",
  AGREEMENT_REQUIRED: "it needs an agreement first",
  UNAUTHORIZED: "not admitted by its access rules",
  SEALING_REQUIRED: "it takes sealed messages only",
  COST_LIMIT_EXCEEDED: "over the cost limit",
};

const FAILED: Record<string, string> = {
  AGENT_OVERLOADED: "it was too busy to take it",
  AGENT_UNAVAILABLE: "it was not available",
  TRANSPORT_TIMEOUT: "no answer in time",
  TRANSPORT_NO_RESPONDERS: "nobody was there to take it",
  TRANSPORT_PERMISSION_DENIED: "the mesh would not carry it",
  OFFERING_NOT_FOUND: "it does not offer what was asked",
  INPUT_INVALID: "it could not read the request",
  INPUT_NOT_UNDERSTOOD: "it could not read the request",
  CONTENT_TYPE_NOT_SUPPORTED: "it does not take that kind of content",
  BUDGET_EXHAUSTED: "the budget ran out",
  DEADLINE_EXCEEDED: "the deadline passed",
  TASK_EXPIRED: "the task expired",
};

/** The outcome of one exchange from its first answer's error code (none
 *  means it was delivered). */
export function tapOutcome(code: string | undefined | null): TapOutcome {
  if (!code) return { outcome: "delivered" };
  if (REFUSED[code] || ADMISSION_REFUSAL_CODES.has(code)) {
    return { outcome: "refused", reason: REFUSED[code] ?? "turned away at its door" };
  }
  return { outcome: "failed", reason: FAILED[code] ?? "it answered with an error" };
}

/** What an unanswered exchange is called, after the audit's threshold. */
export function unansweredReason(afterMs: number): string {
  const min = Math.round(afterMs / 60_000);
  return `no answer in ${min} minute${min === 1 ? "" : "s"}`;
}
