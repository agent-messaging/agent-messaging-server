/**
 * Cancellation and attributed failure (§10.8, §10.8a), as the task manager
 * sees them.
 *
 * A cancel reaches this service as a `respond` on `mesh.task.{id}.update` with
 * `payload: { status: "canceled", reason: "<CancelReason>", note?: string }`.
 * `reason` is REQUIRED and the enum is CLOSED: a canceled update whose reason
 * is missing or not one of the eight exact strings is refused at the door as
 * INVALID_ENVELOPE — warn-and-return, nothing persisted, nothing published,
 * because the subject is fire-and-forget (same door as a malformed budget
 * block, §7.7). The optional free-text `note` is context for humans; the
 * enum, not the note, is what the record carries as meaning — the task record
 * and the §19.2 receipt store `reason`, and the note lives only inside the
 * sender's own envelope in `history`, whose signature covers its bytes as
 * sent.
 *
 * A FAILURE may carry the same vocabulary, and there the reason is OPTIONAL: a
 * Task that simply did not work out is a complete statement and a responder is
 * never forced to invent an excuse. What a stated reason buys is §10.8a's
 * distinction between three endings that used to be indistinguishable in the
 * record — the responder did not deliver, the caller never furnished something
 * the offering declared it needed, and an outside service the responder
 * depends on broke.
 *
 * Attribution (`attributionOf`) is the part a party does not get to write. The
 * responder states a reason; this service decides what the reason is worth by
 * checking the named need against a declaration the responder published before
 * the work started. An unbacked claim, and a claim that could not be checked,
 * are both `provider` — a provider must not be able to buy a clean record with
 * an assertion, nor profit from a registry outage. The remedy costs nothing
 * and is available in advance: declare what you need.
 *
 * The stranded-delegate check is this service's share of §10.8's propagation
 * rule. The MUST — a performer whose Task is canceled forwards the cancel to
 * each still-live delegate — is honor-system inside the performer; the teeth
 * are central visibility: the task manager can observe a canceled Task whose
 * delegated children (non-terminal Tasks sharing its `context_id` whose
 * requester is the canceled Task's responder) remain live, flags them
 * (`stranded: true`) and announces each on `mesh.event.task.stranded`, so a
 * performer that habitually strands its delegates is one an operator can see.
 */

// Deep import into the SDK source, deliberately: the services barrel
// (src/sdk.ts) does not re-export the cancel names yet and is outside this
// change's file set. The barrel imports this same source tree, so the module
// resolves identically either way.
import {
  CANCEL_REASONS,
  NEED_KINDS,
  isCancelReason,
  isUnmetNeedRef,
  needRefOf,
  type CancelReason,
} from "../../../sdk-typescript/src/types/task.js";

export { CANCEL_REASONS, needRefOf };
export type { CancelReason };

/** What a validated canceled update carries alongside its status. */
export interface CancelFields {
  reason: CancelReason;
  note?: string;
  /** §10.8: present exactly when the reason is `needs_not_furnished`. */
  unmet_need?: string;
  /** §10.8: present at most when the reason is `dependency_failed`. */
  dependency?: string;
}

/** What a validated FAILED update carries. Everything is optional: a bare
 *  failure is a legal, complete statement. */
export type FailureFields = Partial<CancelFields>;

/** §10.8a: whose failure the platform judges this to be. Computed here, never
 *  read off a party's envelope. */
export type Attribution = "provider" | "client";

/**
 * What cancellation adds to the STORED task record. Additive fields on the KV
 * JSON, in `TaskBudgetFields`' convention (budget.ts) — the SDK `Task` type is
 * integrated separately, and a reader that does not know these keys is
 * unaffected by them.
 */
export interface TaskCancelFields {
  /** §10.8: the reason recorded on a canceled task. The closed enum, not the
   *  free-text note, is the meaning the record keeps. */
  cancel_reason?: CancelReason;
  /** §10.8: the reason recorded on a FAILED task, kept under its own key so a
   *  reader never has to guess which ending a stored reason belonged to. */
  failure_reason?: CancelReason;
  /** §10.8: the declared need (§8.5.1) the responder says was not furnished,
   *  as `"<kind>:<value>"`. A claim, on either ending. */
  unmet_need?: string;
  /** §10.8: the outside service the responder says stopped working. */
  dependency?: string;
  /** §10.8a: whose failure this was, as the PLATFORM judged it — not as the
   *  responder claimed. Written only on `failed`. */
  attribution?: Attribution;
  /** §10.8a: whether `unmet_need` was found in the responder's registered
   *  declarations. Absent when no claim was made; `false` records both "not
   *  declared" and "could not check", which is why `attribution` is the field
   *  to read for consequences and this one is for explaining them. */
  unmet_need_declared?: boolean;
  /** §10.8 stranded delegates: this non-terminal task's upstream — the task
   *  whose responder requested this one, in the same `context_id` — was
   *  canceled, and no cancel reached this task. A flag, NOT a lifecycle
   *  state: the task stays wherever it is in §7.2. */
  stranded?: true;
  /** When the stranded flag was applied (task manager's clock). */
  stranded_at?: string;
}

/**
 * Validate the reason half of a terminal update's payload. Returns the typed
 * fields, or a reason string — the same accept-or-say-why shape as
 * `validateBudget` (budget.ts), so the caller's warn can name the exact
 * refusal.
 *
 * §10.8's rules, checked literally: `reason` one of the eight exact strings
 * (no case folding, absent is omitted — never null) and REQUIRED unless
 * `reasonRequired` is false; `note`, when present, a string; `unmet_need`
 * REQUIRED with `needs_not_furnished`, well-formed, and refused with any other
 * reason; `dependency` refused with any reason but `dependency_failed`.
 */
export function validateStopFields(
  payload: unknown,
  reasonRequired: boolean,
): FailureFields | string {
  const p = (
    typeof payload === "object" && payload !== null ? payload : {}
  ) as Record<string, unknown>;

  if (p.note !== undefined && typeof p.note !== "string") {
    return "note, when present, must be a string";
  }
  const note = p.note as string | undefined;

  if (p.reason === undefined) {
    if (reasonRequired) return "reason is required on a canceled update";
    // A bare failure. The qualifying fields have nothing to qualify, and
    // accepting them here would let a responder ship an attribution claim with
    // no reason attached to it.
    if (p.unmet_need !== undefined) {
      return "unmet_need needs a reason of needs_not_furnished to belong to";
    }
    if (p.dependency !== undefined) {
      return "dependency needs a reason of dependency_failed to belong to";
    }
    return note === undefined ? {} : { note };
  }

  if (typeof p.reason !== "string") {
    return "reason must be a string (absent is omitted, never null)";
  }
  if (!isCancelReason(p.reason)) {
    // Sender text — sliced so a hostile reason cannot flood the log line.
    return (
      `reason '${p.reason.slice(0, 64)}' is not one of the eight §10.8 reasons ` +
      `(${[...CANCEL_REASONS].join(", ")})`
    );
  }
  const reason = p.reason;

  if (reason === "needs_not_furnished") {
    if (p.unmet_need === undefined) {
      return (
        "needs_not_furnished requires unmet_need — a claim about the caller that names " +
        "nothing is an assertion, not evidence (§10.8a)"
      );
    }
    if (!isUnmetNeedRef(p.unmet_need)) {
      return (
        `unmet_need must be "<kind>:<value>" with kind one of ${NEED_KINDS.join(", ")} ` +
        `(§8.5.1)`
      );
    }
  } else if (p.unmet_need !== undefined) {
    return `unmet_need is meaningful only with needs_not_furnished, not ${reason}`;
  }

  if (reason === "dependency_failed") {
    if (
      p.dependency !== undefined &&
      (typeof p.dependency !== "string" || !p.dependency.trim())
    ) {
      return "dependency, when present, must be a non-empty string naming the service";
    }
  } else if (p.dependency !== undefined) {
    return `dependency is meaningful only with dependency_failed, not ${reason}`;
  }

  return {
    reason,
    ...(note === undefined ? {} : { note }),
    ...(p.unmet_need === undefined ? {} : { unmet_need: p.unmet_need as string }),
    ...(p.dependency === undefined ? {} : { dependency: p.dependency as string }),
  };
}

/**
 * Validate the cancel half of a `{ status: "canceled", ... }` payload.
 * Reason is REQUIRED here, so a success always carries one.
 */
export function validateCancel(payload: unknown): CancelFields | string {
  const checked = validateStopFields(payload, true);
  if (typeof checked === "string") return checked;
  return checked as CancelFields;
}

/**
 * §10.8a: whose failure this is. `declaredNeeds` is the set of `"<kind>:<value>"`
 * references the responder's registered manifest declares, or `null` when the
 * declarations could not be read at all.
 *
 * `client` needs BOTH halves: the reason that says the caller failed to
 * furnish, and a named need that the responder really did declare, in public,
 * before the work started. Anything else is `provider` — a plain failure, a
 * dependency the provider chose, an assertion backed by no declaration, and an
 * assertion nobody could check.
 */
export function attributionOf(
  fields: FailureFields,
  declaredNeeds: ReadonlySet<string> | null,
): { attribution: Attribution; unmet_need_declared?: boolean } {
  if (fields.reason !== "needs_not_furnished" || !fields.unmet_need) {
    return { attribution: "provider" };
  }
  const declared = declaredNeeds !== null && declaredNeeds.has(fields.unmet_need.trim());
  return {
    attribution: declared ? "client" : "provider",
    unmet_need_declared: declared,
  };
}

/**
 * Every `"<kind>:<value>"` reference a stored manifest declares, across its
 * offerings.
 *
 * Scoped to one offering when `offering` names one that exists, and to every
 * offering otherwise. The fallback is not laziness: the task record's
 * `offering` comes from a field that is not part of `RespondPayload` at all
 * (§6.5), so in practice it is empty for every task the SDKs create, and
 * refusing to check without it would mean the check never runs. Across all
 * offerings the question is still the one that matters — did this provider
 * declare this need where a caller could read it.
 */
export function declaredNeedRefs(
  manifest: unknown,
  offering?: string,
): ReadonlySet<string> {
  const refs = new Set<string>();
  const m = (typeof manifest === "object" && manifest !== null ? manifest : {}) as {
    offerings?: unknown;
  };
  const offerings = Array.isArray(m.offerings) ? m.offerings : [];
  const named = offering
    ? offerings.filter((o) => (o as { id?: unknown })?.id === offering)
    : [];
  for (const o of named.length ? named : offerings) {
    const needs = (o as { needs?: unknown })?.needs;
    for (const need of Array.isArray(needs) ? needs : []) {
      const ref = needRefOf(need);
      if (ref) refs.add(ref);
    }
  }
  return refs;
}

/** Resolve the declared `unmet_need` references for one responder, or null
 *  when the registry could not be read. Injected into the task update handler
 *  so tests need no KV and a deployment without a registry still runs tasks. */
export type DeclaredNeedsFn = (
  responder: string,
  offering?: string,
) => Promise<ReadonlySet<string> | null>;
