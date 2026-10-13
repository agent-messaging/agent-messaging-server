/**
 * Cancel (§10.8): reason validation and the wire input shape.
 *
 * The reason enum is CLOSED: a cancel whose reason is missing or not one of
 * the eight is rejected as INVALID_ENVELOPE — at the door, before any state is
 * touched — exactly as a malformed budget is (§7.7). The strings themselves
 * are pinned by conformance/cancel.json; THE FIXTURE IS THE AUTHORITY.
 *
 * Two fields travel beside the reason and each is meaningful with exactly one
 * of them (§10.8):
 *
 *   - `unmet_need` is REQUIRED with `needs_not_furnished` and refused with any
 *     other reason. It is `"<kind>:<value>"` against the §8.5.1 need kinds,
 *     and the shape is checked here so that a claim about the caller always
 *     names something a reader can go and look up. Whether the named need was
 *     actually DECLARED is a platform question (§10.8a) — no SDK holds the
 *     responder's registered manifest — so this door checks the shape and the
 *     platform checks the truth.
 *   - `dependency` is optional with `dependency_failed` and refused with any
 *     other reason.
 *
 * The same vocabulary ends a `failed` Task, where the reason itself is
 * OPTIONAL: a Task that simply did not work out is a complete statement, and a
 * responder is never forced to invent an excuse. `validateStopFields` is the
 * shared door; the cancel path requires a reason and the failure path does
 * not.
 */
import { MeshError, ErrorCode } from "./types/errors.js";
import {
  CANCEL_REASONS,
  NEED_KINDS,
  isCancelReason,
  isUnmetNeedRef,
  type CancelReason,
} from "./types/task.js";

function invalid(message: string): MeshError {
  return new MeshError(ErrorCode.INVALID_ENVELOPE, `Invalid cancel (§10.8): ${message}`, {
    retryable: false,
  });
}

/** The caller-facing form of §10.8's two qualifying fields, for the methods
 *  that take a reason: `unmetNeed` with `needs_not_furnished`, `dependency`
 *  with `dependency_failed`. */
export interface StopQualifier {
  unmetNeed?: string;
  dependency?: string;
}

/** Why work stopped, as validated: the reason and the fields that qualify it.
 *  `reason` is absent only on a bare failure. */
export interface StopFields {
  reason?: CancelReason;
  note?: string;
  /** REQUIRED with `needs_not_furnished`, absent otherwise (§10.8). */
  unmet_need?: string;
  /** Optional with `dependency_failed`, absent otherwise (§10.8). */
  dependency?: string;
}

/**
 * The shared door for §10.8's reason vocabulary, wherever it appears. `fields`
 * is the raw `{ reason, note, unmet_need, dependency }` as received;
 * `reasonRequired` is true on a cancel and false on a failure.
 *
 * Throws INVALID_ENVELOPE with a §-cited message, mirroring validateBudget.
 */
export function validateStopFields(
  fields: {
    reason?: unknown;
    note?: unknown;
    unmet_need?: unknown;
    dependency?: unknown;
  },
  reasonRequired: boolean,
): StopFields {
  const { reason, note, unmet_need: unmetNeed, dependency } = fields;

  if (reason === undefined) {
    if (reasonRequired) throw invalid("reason is required on every cancel");
    // A bare failure. The qualifying fields have nothing to qualify, and
    // accepting them here would let a responder ship an attribution claim with
    // no reason attached to it.
    if (unmetNeed !== undefined) {
      throw invalid("unmet_need needs a reason of needs_not_furnished to belong to");
    }
    if (dependency !== undefined) {
      throw invalid("dependency needs a reason of dependency_failed to belong to");
    }
    if (note !== undefined && typeof note !== "string") {
      throw invalid("note, when present, is a string");
    }
    return note === undefined ? {} : { note };
  }

  if (!isCancelReason(reason)) {
    throw invalid(
      `reason must be one of ${[...CANCEL_REASONS].join(", ")} — got ${JSON.stringify(reason)}`,
    );
  }
  if (note !== undefined && typeof note !== "string") {
    throw invalid("note, when present, is a string");
  }

  if (reason === "needs_not_furnished") {
    if (unmetNeed === undefined) {
      throw invalid(
        "needs_not_furnished requires unmet_need — a claim about the caller that names " +
          "nothing is an assertion, not evidence (§10.8a)",
      );
    }
    if (!isUnmetNeedRef(unmetNeed)) {
      throw invalid(
        `unmet_need must be "<kind>:<value>" with kind one of ${NEED_KINDS.join(", ")} ` +
          `(§8.5.1) — got ${JSON.stringify(unmetNeed)}`,
      );
    }
  } else if (unmetNeed !== undefined) {
    throw invalid(`unmet_need is meaningful only with needs_not_furnished, not ${reason}`);
  }

  if (reason === "dependency_failed") {
    if (dependency !== undefined && (typeof dependency !== "string" || !dependency.trim())) {
      throw invalid("dependency, when present, is a non-empty string naming the service");
    }
  } else if (dependency !== undefined) {
    throw invalid(`dependency is meaningful only with dependency_failed, not ${reason}`);
  }

  return {
    reason,
    ...(note === undefined ? {} : { note }),
    ...(unmetNeed === undefined ? {} : { unmet_need: unmetNeed as string }),
    ...(dependency === undefined ? {} : { dependency: dependency as string }),
  };
}

/** Reason + optional note, checked against the closed enum (§10.8). Throws
 *  INVALID_ENVELOPE with a §-cited message, mirroring validateBudget.
 *
 *  `unmetNeed` and `dependency` are the §10.8 qualifiers; passing neither
 *  keeps the pre-existing two-argument behavior for every reason that does not
 *  take one. */
export function validateCancelReason(
  reason: unknown,
  note?: unknown,
  unmetNeed?: unknown,
  dependency?: unknown,
): asserts reason is CancelReason {
  validateStopFields(
    {
      reason,
      note,
      ...(unmetNeed === undefined ? {} : { unmet_need: unmetNeed }),
      ...(dependency === undefined ? {} : { dependency }),
    },
    true,
  );
}

/** The parsed input of a `task.cancel` request (§10.8). */
export interface CancelInput {
  taskId: string;
  reason: CancelReason;
  note?: string;
  /** Present exactly when the reason is `needs_not_furnished`. */
  unmetNeed?: string;
  /** Present at most when the reason is `dependency_failed`. */
  dependency?: string;
}

/** Parse and validate a `task.cancel` request's `payload.input`
 *  (`{ task_id, reason, note?, unmet_need?, dependency? }` —
 *  conformance/cancel.json `shapes`).
 *  `envelopeTaskId` is the fallback when the input names no task. */
export function parseCancelInput(input: unknown, envelopeTaskId?: string): CancelInput {
  const obj =
    input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawTaskId = obj.task_id;
  const taskId =
    typeof rawTaskId === "string" && rawTaskId.length > 0 ? rawTaskId : envelopeTaskId;
  if (!taskId) throw invalid("task_id is required (input.task_id or the envelope task_id)");
  const stop = validateStopFields(obj, true);
  return {
    taskId,
    reason: stop.reason as CancelReason,
    ...(stop.note !== undefined ? { note: stop.note } : {}),
    ...(stop.unmet_need !== undefined ? { unmetNeed: stop.unmet_need } : {}),
    ...(stop.dependency !== undefined ? { dependency: stop.dependency } : {}),
  };
}
