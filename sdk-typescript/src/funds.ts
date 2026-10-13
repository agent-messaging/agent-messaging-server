/**
 * The funds hold (§19.5, the funds-hold contract of 2026-09-12) — the second
 * half of the paid-work gate.
 *
 * The §19.5 agreement check answers "did this account AGREE to the price?".
 * It never answered "can this account PAY it?", so a buyer who accepted terms
 * with an empty balance was admitted, worked for, and billed into a debt
 * nobody had authorised. The hold closes that: after coverage is established
 * and before the work is admitted, the seller asks the platform to authorise
 * the job against the buyer's balance, and carries the refusal when it cannot.
 *
 * **The seller names the job; the platform names the amount.** Nothing in this
 * module carries money out. A request says which account, which SKU and which
 * job — never how much — because the platform already holds the agreement and
 * already resolves the live SKU for the rating fold, and a hold priced by the
 * seller could disagree with the charge that follows it. This is an
 * authorization hold in the card sense: the buyer's signed agreement is the
 * authorization, the seller presents the job, the platform authorizes against
 * the balance.
 *
 * Shapes here are the wire contract between the three implementations (SDK,
 * platform, fleet) and must not drift: see `docs/funds-hold-contract.md`.
 */

import { MeshError, ErrorCode } from "./types/errors.js";

/**
 * What the seller asks for on `mesh.funds.hold`. The envelope's verified
 * `from` IS the seller — exactly as on `mesh.agreements.list` — so no field
 * here names one.
 */
export interface FundsHoldRequest {
  /** The buyer: the owner account (§8.6) behind the requesting agent. */
  consumer_owner: string;
  /** Which declared SKU (§19.1) the requested offering falls under. */
  sku: string;
  /** The unit of work. Makes the hold idempotent: the platform derives the
   *  hold id from it, so a re-delivered request re-authorises the same hold
   *  instead of stacking a second one. */
  job_id: string;
  /** Per-unit SKUs only; the platform defaults it to 1. The SDK's automatic
   *  gate never sends it — at admission the work has not run and the quantity
   *  is not known yet, and a guessed quantity would be the seller naming the
   *  amount by the back door. The platform's rule covers the gap: a final
   *  quantity above the held one draws what it can and posts the remainder as
   *  an ordinary charge. Present for hosts driving the seam themselves with a
   *  quantity they genuinely know in advance. */
  quantity?: number;
}

/**
 * What the platform answers. `hold_id` is null exactly when `free` is true:
 * a zero-value agreement (or a free SKU that should never have got here) is
 * answered without touching the ledger, because a ledger hold of nothing is a
 * failure rather than a no-op.
 */
export interface FundsHoldResult {
  hold_id: string | null;
  amount_micro: number;
  currency?: string;
  free: boolean;
  /** True while the deployment's credits are not backed by real money. Carried
   *  so a seller (and every surface downstream of it) can say so on the face
   *  of the hold; the SDK does not decide anything on it. */
  simulated?: boolean;
  /** The buyer's remaining available balance after the hold, in micro-units. */
  available_after?: number;
}

/** What the refusal's `details` carries. The field names are the protocol
 *  between implementations, like `AgreementRequiredDetails`. */
export interface InsufficientFundsDetails {
  sku: string;
  /** What the hold would have cost, as the PLATFORM priced it. Absent when the
   *  platform did not say. */
  amount_micro?: number;
  currency?: string;
  /** How far short the balance fell, when the platform named it. */
  shortfall_micro?: number;
  /** Where a human adds funds, when the deployment configures one. */
  top_up_url?: string;
}

/**
 * Admission refusal: the requested work is covered by a paid SKU the buyer HAS
 * agreed to, and the buyer's balance does not cover it (§19.5, the funds-hold
 * contract). Refused BEFORE any work, in the same slot and the same shape as
 * `agreementRequired` — the two are siblings on purpose, because they are the
 * same sentence about two different obstacles and a caller matching on
 * `err.code` should find them typed the same way.
 *
 * Not retryable: the identical message sent again gets the identical answer.
 * What clears it is money, not a retry.
 */
export function insufficientFunds(
  details: InsufficientFundsDetails,
  message?: string,
): MeshError {
  return new MeshError(
    ErrorCode.INSUFFICIENT_FUNDS,
    message ??
      `Refused at admission: '${details.sku}' is a paid offering and this account's balance ` +
        `does not cover it (§19.5).` +
        (details.top_up_url ? ` Add funds at ${details.top_up_url}` : ""),
    { retryable: false, details: { ...details } },
  );
}

/**
 * Read the platform's hold answer, or throw.
 *
 * Fail-closed on purpose, and for the same reason the agreement lookup throws
 * rather than returning an empty list: an answer this SDK cannot read is not
 * "the hold succeeded", and a gate that shrugged at a malformed reply would
 * give paid work away on the one input an attacker (or a half-deployed
 * platform) most easily controls. `amount_micro` is checked as a non-negative
 * SAFE INTEGER because no floating point ever touches money (§19.3).
 */
export function loadFundsHoldResult(raw: unknown): FundsHoldResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MeshError(
      ErrorCode.INTERNAL_ERROR,
      "Funds hold answer must be an object (funds-hold contract)",
      { retryable: false },
    );
  }
  const r = raw as Record<string, unknown>;
  const free = r.free === true;
  const holdId = r.hold_id;
  if (free) {
    if (holdId !== null && holdId !== undefined) {
      throw new MeshError(
        ErrorCode.INTERNAL_ERROR,
        "Funds hold answer says free and still names a hold_id — one of the two is wrong",
        { retryable: false },
      );
    }
  } else if (typeof holdId !== "string" || holdId === "") {
    throw new MeshError(
      ErrorCode.INTERNAL_ERROR,
      "Funds hold answer must name a non-empty hold_id unless it says free",
      { retryable: false },
    );
  }
  const amount = r.amount_micro;
  if (!Number.isSafeInteger(amount) || (amount as number) < 0) {
    throw new MeshError(
      ErrorCode.INTERNAL_ERROR,
      "Funds hold answer must carry amount_micro as a non-negative integer of micro-units (§19.3)",
      { retryable: false },
    );
  }
  const out: FundsHoldResult = {
    hold_id: free ? null : (holdId as string),
    amount_micro: amount as number,
    free,
  };
  if (typeof r.currency === "string") out.currency = r.currency;
  if (typeof r.simulated === "boolean") out.simulated = r.simulated;
  if (Number.isSafeInteger(r.available_after)) out.available_after = r.available_after as number;
  return out;
}

/** Why a hold is being released. Free text on the wire; these are the reasons
 *  the SDK's own gate emits, kept together so the reservations table reads the
 *  same way whoever wrote the row. */
export const FundsReleaseReason = {
  /** The handler threw: the task ended `failed`. */
  TASK_FAILED: "task_failed",
  /** The handler declined the task (§7.2 `rejected`) — never started. */
  REJECTED: "rejected",
  /** The application's own `admit` hook refused after the hold was placed. */
  ADMISSION_REFUSED: "admission_refused",
  /** Nothing was registered to do the work (OFFERING_NOT_FOUND). */
  OFFERING_NOT_FOUND: "offering_not_found",
  /** The work ran but the deliverable could not be sealed back to the sender
   *  (§8.9), so nothing was delivered. */
  SEALING_REQUIRED: "sealing_required",
  /** The task was canceled (§10.8). */
  CANCELED: "canceled",
} as const;

export type FundsReleaseReasonValue =
  (typeof FundsReleaseReason)[keyof typeof FundsReleaseReason];
