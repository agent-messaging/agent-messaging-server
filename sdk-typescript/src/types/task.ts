import type { Envelope, Artifact, Budget } from "./envelope.js";

// State set mirrors the A2A Protocol (see SPEC.md §1.3, §7), plus `exhausted`
// from Agent SoW §5.5.5 (https://agentsow.com): under a time and materials
// arrangement, a task in flight when the engagement's not-to-exceed cap is
// reached ends `exhausted`, with whatever artifacts exist attached, billed no
// further than the cap. It is terminal and it is NOT a failure — a runtime MUST
// NOT record an exhausted task as failed.
export type TaskState =
  | "submitted"
  | "working"
  | "input_required"
  | "auth_required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "exhausted";

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "completed",
  "failed",
  "canceled",
  "rejected",
  "exhausted",
]);

export const VALID_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  // Every non-terminal state may end `exhausted`: the cap is reached when it is
  // reached, and the task in flight at that instant concludes wherever it
  // stood (Agent SoW §5.5.5).
  submitted: ["working", "canceled", "rejected", "exhausted"],
  working: ["completed", "failed", "input_required", "auth_required", "canceled", "exhausted"],
  // The paused states can cancel (SPEC.md §7.3): §7.7's BUDGET_EXHAUSTED pause
  // parks a Task in input_required precisely so the requester can revise the
  // budget OR cancel and keep the partial artifacts.
  input_required: ["working", "canceled", "exhausted"],
  auth_required: ["working", "canceled", "exhausted"],
  completed: [],
  failed: [],
  canceled: [],
  rejected: [],
  exhausted: [],
};

export function isValidTransition(from: TaskState, to: TaskState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Cancel reasons (SPEC.md §10.8). A closed enum: a cancel whose reason is
 *  missing or not one of these MUST be rejected as INVALID_ENVELOPE. The
 *  optional free-text note is context for humans; the reason, not the note,
 *  is what the record carries as meaning.
 *
 *  The same vocabulary ends a `failed` Task, where `reason` is OPTIONAL: a
 *  Task that simply did not work out is a complete statement and a responder
 *  is never forced to invent an excuse. When it IS present the rules are
 *  identical. */
export type CancelReason =
  | "user_requested"
  | "superseded"
  | "deadline_exceeded"
  | "budget_exhausted"
  | "upstream_cancelled"
  | "policy"
  /** The caller did not furnish something the offering declared under `needs`
   *  (§8.5.1): the resource never granted, the file never attached, the
   *  sign-in never given or no longer valid. REQUIRES `unmet_need`, because a
   *  claim about the caller that names nothing is an assertion and not
   *  evidence (§10.8a). */
  | "needs_not_furnished"
  /** An outside service the responder depends on, and SHOULD have declared
   *  under `works_with` (§8.8), stopped working. Still the PROVIDER's failure
   *  (§10.8a): the provider chose the dependency. The separate reason buys
   *  legibility, not absolution. */
  | "dependency_failed";

export const CANCEL_REASONS: ReadonlySet<string> = new Set<CancelReason>([
  "user_requested",
  "superseded",
  "deadline_exceeded",
  "budget_exhausted",
  "upstream_cancelled",
  "policy",
  "needs_not_furnished",
  "dependency_failed",
]);

export function isCancelReason(value: unknown): value is CancelReason {
  return typeof value === "string" && CANCEL_REASONS.has(value);
}

/** The §8.5.1 need kinds, which are also the prefixes of an `unmet_need`
 *  reference. */
export const NEED_KINDS: readonly string[] = ["resource", "file", "credential", "text"];

/**
 * An `unmet_need` reference (§10.8): `"<kind>:<value>"`, kind from
 * {@link NEED_KINDS} and value that need entry's own value —
 * `"credential:Salesforce"`, `"resource:git-repo"`,
 * `"file:application/pdf"`. Split at the FIRST colon only: a value may
 * contain colons of its own.
 */
export function isUnmetNeedRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const at = value.indexOf(":");
  if (at <= 0 || at === value.length - 1) return false;
  return NEED_KINDS.includes(value.slice(0, at));
}

/** Split a valid `unmet_need` into its kind and value, or null when the
 *  reference is malformed. */
export function parseUnmetNeedRef(value: unknown): { kind: string; value: string } | null {
  if (!isUnmetNeedRef(value)) return null;
  const at = value.indexOf(":");
  return { kind: value.slice(0, at), value: value.slice(at + 1) };
}

/** The `unmet_need` reference a §8.5.1 need entry answers to, or null for an
 *  entry that names no kind this vocabulary knows. The value is taken
 *  verbatim, so the comparison in {@link isUnmetNeedRef}'s consumers is
 *  between two strings the manifest and the failing agent both wrote. */
export function needRefOf(need: unknown): string | null {
  if (typeof need !== "object" || need === null) return null;
  const entry = need as Record<string, unknown>;
  for (const kind of NEED_KINDS) {
    const value = entry[kind];
    if (typeof value === "string" && value.trim()) return `${kind}:${value.trim()}`;
  }
  return null;
}

/** The note a propagated cancel carries (§10.8): the original reason, then
 *  ": " and the original note when one was present. Pinned by
 *  conformance/cancel.json — both SDKs must produce these exact bytes. */
export function propagatedCancelNote(reason: CancelReason, note?: string): string {
  return note === undefined || note === "" ? reason : `${reason}: ${note}`;
}

export interface Task {
  id: string;
  context_id?: string;
  requester: string;
  responder: string;
  offering: string;
  state: TaskState;
  created_at: string;
  updated_at: string;
  history: Envelope[];
  artifacts: Artifact[];
  /** The budget governing this Task (§7.7): the highest-revision budget seen.
   *  Revisions are absolute, so this is the whole truth, not an accumulation. */
  budget?: Budget;
  meta?: Record<string, unknown>;
}
