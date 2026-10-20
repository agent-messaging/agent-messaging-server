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

/**
 * Where a Task came from, as the PLATFORM saw it: the request that created the
 * Task, observed by the server as it routed that request. Never taken from the
 * responder's task updates, never changed once set, and never trimmed with
 * `history`. Absent when the server could not observe the creating request
 * (a Task created some other way); a reader must treat absence as "unknown",
 * never as "no request".
 */
export interface TaskOrigin {
  /** The creating request's envelope id: the same id answer-derived meter
   *  events carry as `request_id` (§13.5). */
  request_id: string;
  /** The request's `from`, verified by its signature. */
  requester: string;
  /** The request's `to`: the agent asked, which is the Task's responder. */
  responder: string;
  /** The offering the request named (`""` when it named none). */
  offering: string;
  /** When the server observed the request (the server's clock). */
  observed_at: string;
  /** What tied the request to this Task id. `"request"`: the request itself
   *  named the Task id (a requester-chosen id, as a stream request carries).
   *  `"answer"`: the request's FIRST answer (accept signals aside), delivered
   *  to the requester's inbox, carried the Task id (the reply the requester's
   *  own SDK learns the id from); a first answer without one closes the
   *  request, so no later answer can bind it. Either way the request's id, parties and offering
   *  are what the server observed, and a Task id is bound to one request and
   *  a request to one Task id, first observation wins. */
  bound_by: "request" | "answer";
  /** Every other request the server saw answered with this Task's id (a
   *  genuine resume aside): the first binding stands, and these are listed
   *  because only the responder can make two exchanges claim one Task, so a
   *  consumer that refunds the origin refunds these as well. Append-only, on
   *  terminal Tasks too. At most 256 ids. Absent when none. */
  contested_by?: string[];
  /** How many contesting requests did not fit in `contested_by`. */
  contested_overflow?: number;
  /** When the first contesting request did not fit (the server's clock). A
   *  consumer then treats every exchange between the two parties since the
   *  Task's creation as contested. */
  contested_overflow_since?: string;
}

/**
 * Who asked for a cancellation, as the PLATFORM saw it. Written once, on the
 * `canceled` transition, beside `cancel_reason` (which stays the canceling
 * party's own signed claim).
 */
export interface TaskCanceledBy {
  /** The party that signed the `canceled` update: `"responder"` whenever the
   *  responder did, whatever reason it gave. */
  party: "requester" | "responder";
  /** The cancel the server observed from the ORIGINAL requester
   *  (`origin.requester`) before the transition: the requester's own
   *  `canceled` update (`via: "update"`) or a `task.cancel` request it sent
   *  the responder (`via: "cancel_request"`). `null` when the server observed
   *  none, which includes every Task without an `origin`. */
  requester_request: {
    request_id: string;
    observed_at: string;
    via: "update" | "cancel_request";
  } | null;
  /** When the server recorded the transition (the server's clock). */
  at: string;
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
  /** The creating request, as the server observed it. See {@link TaskOrigin}. */
  origin?: TaskOrigin;
  /** On a canceled Task: who asked for the cancellation, as the server
   *  observed it. See {@link TaskCanceledBy}. */
  canceled_by?: TaskCanceledBy;
  /** Contest evidence on a Task with NO origin: the record's OWN
   *  requester's requests the server saw answered with this Task's id although
   *  none could be bound to it. Same meaning and limits as
   *  `origin.contested_by`; with an origin, the evidence is on the origin
   *  instead. Another asker's requests are never here (`contested_by_asker`). */
  contested_by?: string[];
  contested_overflow?: number;
  contested_overflow_since?: string;
  /** Set when the record names a requester other than the one the server
   *  saw ask the responder about this Task (the responder claimed another
   *  buyer): `requester` is the asker the server saw, whose observed requests
   *  are in the record-level `contested_by`. */
  origin_mismatch?: { requester: string };
  /** Requests from askers OTHER than the record's requester that the
   *  provider answered with this Task's id, kept per asker key so nobody's
   *  requests are mixed with anyone else's. Same limits per asker. */
  contested_by_asker?: Record<string, { contested_by: string[]; contested_overflow?: number; contested_overflow_since?: string }>;
  meta?: Record<string, unknown>;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const isIso = (v: unknown): v is string => isStr(v) && Number.isFinite(Date.parse(v));

/**
 * A Task record's `origin`, read strictly: the {@link TaskOrigin} when every
 * field is present and well-formed, else null. Null means "no origin the
 * platform vouches for", never a partial one; pinned by
 * conformance/task-origin.json.
 */
export function taskOriginOf(record: unknown): TaskOrigin | null {
  const o = (record as { origin?: unknown } | null)?.origin as Record<string, unknown> | undefined;
  if (typeof o !== "object" || o === null) return null;
  if (!isStr(o.request_id) || !isStr(o.requester) || !isStr(o.responder)) return null;
  if (typeof o.offering !== "string" || !isIso(o.observed_at)) return null;
  if (o.bound_by !== "request" && o.bound_by !== "answer") return null;
  // A malformed contest field is dropped on its own: the origin it sits on
  // is still the origin.
  return {
    request_id: o.request_id,
    requester: o.requester,
    responder: o.responder,
    offering: o.offering,
    observed_at: o.observed_at,
    bound_by: o.bound_by,
    ...contestFieldsOf(o),
  };
}

/** The well-formed contest fields of an object; each malformed one is left out. */
function contestFieldsOf(o: Record<string, unknown>): Partial<Pick<TaskOrigin, "contested_by" | "contested_overflow" | "contested_overflow_since">> {
  const out: Partial<Pick<TaskOrigin, "contested_by" | "contested_overflow" | "contested_overflow_since">> = {};
  if (Array.isArray(o.contested_by) && o.contested_by.every(isStr)) out.contested_by = [...(o.contested_by as string[])];
  if (typeof o.contested_overflow === "number" && Number.isInteger(o.contested_overflow) && o.contested_overflow >= 0) {
    out.contested_overflow = o.contested_overflow;
  }
  if (isIso(o.contested_overflow_since)) out.contested_overflow_since = o.contested_overflow_since;
  return out;
}

/** A Task record's record-level contest evidence: see {@link taskContestsOf}. */
export interface TaskContests {
  contested_by?: string[];
  contested_overflow?: number;
  contested_overflow_since?: string;
  /** The requester the server saw ask, when the record names someone else. */
  origin_mismatch?: { requester: string };
  /** Other askers' observed requests, per asker key. */
  contested_by_asker?: Record<string, { contested_by: string[]; contested_overflow?: number; contested_overflow_since?: string }>;
}

/**
 * A Task record's RECORD-LEVEL contest evidence, read strictly: the requests
 * the server saw answered with this Task's id that are not on an origin (the
 * Task has none, or the record names a different requester than the one the
 * server saw ask, `origin_mismatch`). Each malformed field is left out; null
 * when nothing well-formed is there. The evidence on an origin is read by
 * {@link taskOriginOf}. Pinned by conformance/task-origin.json.
 */
export function taskContestsOf(record: unknown): TaskContests | null {
  if (typeof record !== "object" || record === null) return null;
  const r = record as Record<string, unknown>;
  const out: TaskContests = { ...contestFieldsOf(r) };
  const m = r.origin_mismatch as Record<string, unknown> | undefined;
  if (m && typeof m === "object" && isStr(m.requester)) out.origin_mismatch = { requester: m.requester };
  const by = r.contested_by_asker as Record<string, unknown> | undefined;
  if (by && typeof by === "object" && !Array.isArray(by)) {
    const kept: NonNullable<TaskContests["contested_by_asker"]> = {};
    for (const [asker, v] of Object.entries(by)) {
      if (!isStr(asker) || typeof v !== "object" || v === null) continue;
      const f = contestFieldsOf(v as Record<string, unknown>);
      if (f.contested_by) kept[asker] = { ...f, contested_by: f.contested_by };
    }
    if (Object.keys(kept).length) out.contested_by_asker = kept;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A canceled Task record's `canceled_by`, read strictly: the
 * {@link TaskCanceledBy} when well-formed, else null. Pinned by
 * conformance/task-origin.json.
 */
export function taskCanceledByOf(record: unknown): TaskCanceledBy | null {
  const c = (record as { canceled_by?: unknown } | null)?.canceled_by as Record<string, unknown> | undefined;
  if (typeof c !== "object" || c === null) return null;
  if (c.party !== "requester" && c.party !== "responder") return null;
  if (!isIso(c.at)) return null;
  const r = c.requester_request as Record<string, unknown> | null | undefined;
  if (r === null) return { party: c.party, requester_request: null, at: c.at };
  if (typeof r !== "object" || r === undefined) return null;
  if (!isStr(r.request_id) || !isIso(r.observed_at)) return null;
  if (r.via !== "update" && r.via !== "cancel_request") return null;
  return {
    party: c.party,
    requester_request: { request_id: r.request_id, observed_at: r.observed_at, via: r.via },
    at: c.at,
  };
}
