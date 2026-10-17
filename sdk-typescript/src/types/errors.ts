import type { ErrorObject } from "./envelope.js";

export enum ErrorCode {
  // Transport
  TRANSPORT_TIMEOUT = "TRANSPORT_TIMEOUT",
  TRANSPORT_NO_RESPONDERS = "TRANSPORT_NO_RESPONDERS",
  TRANSPORT_PERMISSION_DENIED = "TRANSPORT_PERMISSION_DENIED",
  // Protocol
  INVALID_ENVELOPE = "INVALID_ENVELOPE",
  INVALID_VERSION = "INVALID_VERSION",
  IDENTITY_MISMATCH = "IDENTITY_MISMATCH",
  INVALID_MANIFEST = "INVALID_MANIFEST",
  INVALID_QUERY = "INVALID_QUERY",
  // Task
  TASK_NOT_FOUND = "TASK_NOT_FOUND",
  TASK_INVALID_TRANSITION = "TASK_INVALID_TRANSITION",
  TASK_NOT_CANCELABLE = "TASK_NOT_CANCELABLE",
  TASK_EXPIRED = "TASK_EXPIRED",
  // Agent
  AGENT_UNAVAILABLE = "AGENT_UNAVAILABLE",
  /** SDK-local (like the TRANSPORT_* codes): the target's node answered with
   *  the §6.4a queued acknowledgement — `{queued: true, inbox_id}` — meaning a
   *  held mailbox has the message and the real reply, if any, arrives later at
   *  THIS agent's own inbox, correlated by `in_reply_to`. Not a failure and
   *  not an answer: §6.4a forbids treating the ack as the substantive reply,
   *  so `request()` rejects with this code instead of resolving. The ack's
   *  fields ride in `details` (`inbox_id`, `request_id`). Never appears on the
   *  wire. */
  REQUEST_QUEUED = "REQUEST_QUEUED",
  AGENT_OVERLOADED = "AGENT_OVERLOADED",
  OFFERING_NOT_FOUND = "OFFERING_NOT_FOUND",
  INPUT_INVALID = "INPUT_INVALID",
  /** The message did not carry the input the offering declares, or did not
   *  say which offering it was for (§12.2, Common Agent §4.7.1). The standard
   *  reply: `message` is a sentence a person can act on, and `details` names
   *  the reason, the offering, what is missing, what it expects and an
   *  example that fits (input-fit.ts inputNotUnderstood). */
  INPUT_NOT_UNDERSTOOD = "INPUT_NOT_UNDERSTOOD",
  /** SPEC.md §5.7: a message marked for the person behind the receiving
   *  agent, to a receiver that does not declare `mesh://extensions/audience/v1`
   *  (or whose manifest could not be read), so nothing says it will reach the
   *  person. Raised locally by `sendToPerson` and `replyToPerson` before
   *  anything is published, unless the caller chose to send anyway.
   *  `details.receivers` names the receivers. */
  AUDIENCE_NOT_SUPPORTED = "AUDIENCE_NOT_SUPPORTED",
  CONTENT_TYPE_NOT_SUPPORTED = "CONTENT_TYPE_NOT_SUPPORTED",
  UNAUTHORIZED = "UNAUTHORIZED",
  /** The recipient declares `sealing: "required"` (§8.9) and the request
   *  arrived in the clear, so its content was not read. Also raised LOCALLY by
   *  a sender that is about to send to such an agent and cannot seal to it —
   *  refusing at home rather than leaking the payload onto the wire to earn the
   *  same refusal remotely. Not retryable as sent: resolve the recipient's
   *  manifest, seal to its verified `encryption_key`, send again. */
  SEALING_REQUIRED = "SEALING_REQUIRED",
  COST_LIMIT_EXCEEDED = "COST_LIMIT_EXCEEDED",
  // Budget (§7.7, §12.2). None retryable: an admission refusal wants better
  // terms (resubmit is the counter-offer), an exhaustion wants a revision, and
  // DEADLINE_EXCEEDED is a marker on a late completion, not a failure at all.
  /** Refused at admission: the work cannot be done within the offered cost
   *  ceiling. SHOULD carry the responder's estimate (see budgetInsufficient). */
  BUDGET_INSUFFICIENT = "BUDGET_INSUFFICIENT",
  /** Refused at admission: the work cannot be completed by the offered
   *  deadline. SHOULD carry the earliest realistic completion. */
  DEADLINE_UNMEETABLE = "DEADLINE_UNMEETABLE",
  /** The cost ceiling was reached mid-work; the Task pauses in
   *  `input_required` with spend so far and an estimate to finish. Resolved by
   *  a budget revision or cancellation, never by retry. */
  BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED",
  /** Recorded on a completion that arrived after the deadline (completed
   *  late). A marker, not a failure: the requester decides what a late answer
   *  is worth. */
  DEADLINE_EXCEEDED = "DEADLINE_EXCEEDED",
  /** Refused at admission: a paid SKU covers the requested offering and the
   *  consumer's account holds no agreement for the SKU's CURRENT digest.
   *  `details` names the `sku`, the `sku_digest`, and the `approval_url` —
   *  §1.3's "payment required" refusal, typed (§19.5, see agreementRequired). */
  AGREEMENT_REQUIRED = "AGREEMENT_REQUIRED",
  /** Refused at admission: the consumer's account HAS agreed to the terms and
   *  its balance does not cover the job, so the platform would not authorise a
   *  hold. `details` names the `sku` and, when the platform said so, the
   *  amount, the shortfall and where to add funds (see insufficientFunds).
   *
   *  In the enum rather than a module-local string constant because THIS SDK
   *  emits it on the wire: its sibling AGREEMENT_REQUIRED is here, the two
   *  leave the same admission slot, and a caller matching on `err.code` should
   *  not have to know that one of them is an enum member and the other is not.
   *  (The string-constant precedent — `BudgetCode` in the task manager —
   *  belongs to a service that defines the vocabulary it never emits.) */
  INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS",
  /** Refused at admission: a request marked `trial: true` that the trial
   *  declaration does not allow (Common Agent §7.7). `details` carries
   *  `reason` (budget, not_offered, not_eligible, input, requester_day, day,
   *  requester_ever, funds), `limit` and `resets_at` where they apply, and
   *  `quote`, what the same work costs as an ordinary request (trial.ts
   *  trialRefused). Never retryable as sent: waiting helps only where
   *  `resets_at` says so. */
  TRIAL_REFUSED = "TRIAL_REFUSED",
  // Streaming
  STREAM_CLOSED = "STREAM_CLOSED",
  // Processing
  INTERNAL_ERROR = "INTERNAL_ERROR",
  DEPENDENCY_FAILED = "DEPENDENCY_FAILED",
  CONTEXT_TOO_LARGE = "CONTEXT_TOO_LARGE",
  RATE_LIMITED = "RATE_LIMITED",
  // Resources (rooms drive, provisioned storage)
  NOT_FOUND = "NOT_FOUND",
  QUOTA_EXCEEDED = "QUOTA_EXCEEDED",
  /** One object exceeds what this mesh will store or carry (§7.5.2, §18.9).
   *  Distinct from QUOTA_EXCEEDED on purpose: a quota is freed by deleting
   *  something, and this one never is — the same bytes are too big next
   *  time, so the remediation is to send less, not to tidy up. */
  PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE",
  /** A board claim (or withdraw) lost: the item is already claimed and its
   *  lease live, or otherwise not takeable (EXT-5 §10.1) — the refusal a
   *  losing claimant gets; recover by listing again, not by hammering claim. */
  BOARD_ITEM_TAKEN = "BOARD_ITEM_TAKEN",
  /** The artifact existed and its bytes have been reclaimed (§7.5.2).
   *  Deliberately not NOT_FOUND: "this expired" and "this never existed here"
   *  are different facts about a deliverable, and a store that collapses them
   *  makes every old task record unreadable in the same ambiguous way. The
   *  reference stays truthful about what it was — the error carries the size
   *  and digest it had. */
  ARTIFACT_GONE = "ARTIFACT_GONE",
  /** SDK-local, raised before anything is published: this agent has no handle
   *  in the global naming standard (its name, a dot, its owner's email), so it
   *  sends nothing. Only when the agent connected with `requireNamed`. The
   *  message is the owner's words (conformance/naming-gate.json) and `details`
   *  carries `proposed_handle` and how to start naming. Not retryable as is:
   *  name the agent, then send again. */
  NOT_NAMED = "NOT_NAMED",
}

export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.TRANSPORT_TIMEOUT,
  ErrorCode.AGENT_UNAVAILABLE,
  ErrorCode.AGENT_OVERLOADED,
  ErrorCode.INTERNAL_ERROR,
  ErrorCode.DEPENDENCY_FAILED,
  ErrorCode.RATE_LIMITED,
]);

/**
 * Thrown by a request handler to **decline** a task (§7.2 `rejected`). Distinct
 * from an error during execution (which yields `failed`): a rejection means the
 * responder will not perform the offering at all. Terminal.
 */
export class RejectedError extends Error {
  constructor(message = "Task rejected by responder") {
    super(message);
    this.name = "RejectedError";
  }
}

export class MeshError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly retry_after_ms?: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: {
      details?: Record<string, unknown>;
      retryable?: boolean;
      retry_after_ms?: number;
      cause?: Error;
    },
  ) {
    super(message, { cause: opts?.cause });
    this.name = "MeshError";
    this.code = code;
    this.retryable = opts?.retryable ?? RETRYABLE_CODES.has(code);
    this.details = opts?.details;
    this.retry_after_ms = opts?.retry_after_ms;
  }

  toErrorObject(): ErrorObject {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
      retry_after_ms: this.retry_after_ms ?? null,
    };
  }

  static fromErrorObject(err: ErrorObject): MeshError {
    return new MeshError(err.code as ErrorCode, err.message, {
      details: err.details,
      retryable: err.retryable,
      retry_after_ms: err.retry_after_ms ?? undefined,
    });
  }
}
