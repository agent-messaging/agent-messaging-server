/**
 * Task origin: the request that created a Task, as the server observed it.
 *
 * ## Why
 *
 * The task manager builds a Task record from the updates on
 * `mesh.task.<id>.update`, and every one of those is the responder's (or the
 * requester's) own statement. Before this file, the only link from a Task back
 * to the request that created it was the `in_reply_to` on the first history
 * entry, and that link had two flaws:
 *
 *  - It was the responder's unchecked claim, and ordinary SDK paths leave it
 *    out: a streaming handler that throws publishes a `failed` update with no
 *    `in_reply_to`, and a synchronous `InputProblemsError` creates the Task with
 *    an `input_required` update that has none either.
 *  - `history` is capped (MAX_TASK_HISTORY), so a party can push the first
 *    entry out with enough updates.
 *
 * Anything that has to act on "the exchange this Task belongs to" (a refund of
 * exactly that exchange, say) needs a link nobody but the server writes.
 *
 * ## What the server observes
 *
 * The task manager taps `mesh.agent.*.inbox`, the subject every request is
 * delivered on and every answer reaches its requester on (§6.4; the admission
 * guard's relay forwards answers there too). Not the outbox: a responder's
 * outbox mirror is a copy only the responder writes, so it can say things the
 * requester never received. Every envelope is decoded with its signature
 * verified, so `from` is a fact, and it counts only when the inbox it arrived
 * on is its addressee's. From that traffic:
 *
 *  - every `request` an agent sends another agent is recorded by its envelope
 *    id: requester (`from`), responder (`to`), offering, the time we saw it;
 *  - a request that names a `task_id` (a requester-chosen id, which is what a
 *    stream request carries) binds that Task id to itself (`bound_by:
 *    "request"`);
 *  - the FIRST answer from the asked agent to the asker (a `respond` naming the
 *    request in `in_reply_to`, accept signals aside, or an inbox-mode answer
 *    request) is recorded per request, once. When it carries a `task_id`, that
 *    Task id is bound to the request (`bound_by: "answer"`): it is the reply the
 *    requester's own SDK learns the Task id from. When it carries none (a bare
 *    answer, a refusal), the request is closed and no later answer binds it, so
 *    a provider cannot point a new Task at an old, already-answered exchange;
 *  - a `task.cancel` request is recorded per (Task id, sender, addressee), so
 *    a later `canceled` transition can say whether the original requester
 *    asked for it, and when.
 *
 * ## The rules that keep it the server's
 *
 *  - Nothing here reads a task update. The origin's request id, parties and
 *    offering are what the request said when the server saw it.
 *  - First observation wins, both ways: a Task id (per requester and
 *    responder) is bound to one request, and a request to one Task id. Every
 *    write is `create`, so two task-manager instances observing the same
 *    envelope agree, and a later envelope cannot rebind anything.
 *  - The FIRST binding of a Task id (per requester and responder) stands, and
 *    an origin on a record is never removed or replaced.
 *  - Every OTHER request the server sees answered with that Task id ends up
 *    on the record, append-only, terminal or not: it CONTESTED the Task. That
 *    covers a second request's first answer naming a bound Task, a request
 *    answered with the Task after its first answer said something else, a
 *    first answer seen more than ORIGIN_SKEW_MS after the Task existed, and
 *    a stream request naming a Task an answer had already bound. Only the
 *    responder can make two exchanges claim one Task, so the evidence is kept
 *    against it rather than resolved in its favour: a consumer refunding the
 *    origin refunds every contesting request too. The list holds up to
 *    MAX_CONTESTED_BY ids; past that, `contested_overflow` counts the rest and
 *    `contested_overflow_since` says when the first one did not fit (a
 *    consumer then treats every exchange between the two parties since the
 *    Task's creation as contested). With an origin the fields sit on it
 *    (`origin.contested_by`); without one, on the record itself
 *    (`contested_by`), so the evidence is never hidden by a missing origin.
 *    The genuine resume, a non-stream request naming a Task whose record
 *    already existed when the request was seen, is the one exception; a
 *    stream request is never a resume, and the rule does not change with how
 *    long ago the Task was created.
 *  - When the record names a requester other than the one the server saw ask
 *    (the responder claimed another buyer), the observed requests still go on
 *    the record, as record-level evidence, with `origin_mismatch: {requester:
 *    <the observed asker>}` beside them.
 *  - Delivery signals are not answers: neither an accept (§6.4a) nor a queued
 *    acknowledgement (`{queued: true, inbox_id}`, the held-delivery paths:
 *    a door hold, an attended session, a mailbox) opens or closes a request.
 *  - Requests that never create a Task are not recorded: registry probes,
 *    `describe` (§10.14) and `knock` (EXT-6), which the SDKs answer bare
 *    themselves, and `task.cancel` (recorded as a cancel instead). An
 *    inbox-mode answer is recorded as its request's answer, not as a request.
 *  - A binding attaches to a Task only when the Task's recorded parties are
 *    the request's parties: the responder is the verified creator of the
 *    record, and the requester the creator named. A stranger's request naming
 *    somebody else's Task id binds nothing (the key includes both parties).
 *  - A request (or an answer) first seen well after its Task already existed
 *    did not create it (a resume names an existing Task id, for instance), so
 *    it binds nothing (ORIGIN_SKEW_MS).
 *  - When none of this was observable (the Task was created without its
 *    request crossing the server, or the request was seen by no instance),
 *    the record has no `origin`. Nothing guesses one.
 *
 * Keys are hashed: ids are sender-supplied strings and a keyed store's key
 * alphabet is narrower than an envelope id's (exchange-index.ts does the same).
 *
 *  - `r.<sha(request id)>` → {@link ObservedRequest}
 *  - `q.<sha(request id)>` → `{ task_id }`: the Task id the request is bound to
 *  - `t.<sha(requester \n responder \n task id)>` → {@link TaskOrigin}
 *  - `a.<sha(request id)>` → {@link FirstAnswer}: the request's first answer
 *  - `c.<sha(task id \n sender \n addressee)>` → {@link CancelRequests}: every
 *    `task.cancel` request (up to MAX_CANCEL_REQUESTS, earliest received
 *    first), each stamped when the server received it
 *  - `g.settle_grace_ms` → `{ grace_ms }`: the grace period an instance last
 *    said it uses (checkGraceConfig)
 *  - `w.<sha(task id \n sender \n addressee)>` → `{ pending }`: the cancel
 *    requests received there whose write did not succeed (yet), so a read
 *    knows the window is incomplete
 *  - `k.<sha(requester \n responder \n task id)>` → {@link ContestEvidence}
 *  - `m.<sha(requester \n responder \n task id)>` → `{ multiple_requests }`:
 *    every request that NAMED a stream-created Task id and was answered
 *    under it, when there was more than one (see `bind`)
 *  - `p.<sha(responder \n task id)>` → `{ requesters }`: every asker the
 *    responder ANSWERED with this Task id, so a record naming someone else
 *    can still be given what was seen (a third party's own request naming
 *    the Task id never gets an asker in here)
 *  - `n.<sha(evidence key \n request id)>` → a request already counted in
 *    `contested_overflow`
 *
 * Values expire with the store (`mesh_task_origins`, storage/catalog.ts: seven
 * days, the Task horizon).
 */

import { createHash } from "node:crypto";
import type { Envelope, TaskCanceledBy, TaskOrigin } from "../sdk.js";
import { audienceOf, TERMINAL_STATES } from "../sdk.js";
import type { KeyedStore } from "../storage/index.js";
import { noteOriginMiss } from "./origin-tap.js";
import { rewriteTask } from "./task-write.js";

export type { TaskOrigin };

/** One request as the tap saw it. Content-free. */
export interface ObservedRequest {
  v: 1;
  request_id: string;
  requester: string;
  responder: string;
  offering: string;
  /** The request's own `task_id`, when the requester set one. */
  task_id?: string;
  /** A stream request (§11): its `task_id` is a new Task, never a resume. */
  stream?: true;
  observed_at: string;
}

/** The contest evidence for one Task id between two parties. Append-only. */
export interface ContestEvidence {
  contested_by: string[];
  contested_overflow?: number;
  contested_overflow_since?: string;
}

/** A request's first answer as the tap saw it: the Task id it carried, or
 *  null for an answer that closed the exchange without one. */
export interface FirstAnswer {
  v: 1;
  answer_id: string;
  task_id: string | null;
  observed_at: string;
}

/** What one observation came to, for the tap's counters. */
export type Observation =
  | "recorded"
  | "ignored"
  /** An answer whose request is not recorded (yet). */
  | "unknown_request"
  /** An answer after the request's first answer, carrying another Task id
   *  or answering an exchange the first answer closed. */
  | "not_first"
  /** A binding refused because its Task existed long before the request was
   *  seen (ORIGIN_SKEW_MS). */
  | "late"
  /** A request's first answer named a Task id already bound to another
   *  request: refused, and listed in that origin's `contested_by`. */
  | "contested";

/** An origin from an observed request. */
function originOf(rec: ObservedRequest, by: TaskOrigin["bound_by"]): TaskOrigin {
  return {
    request_id: rec.request_id,
    requester: rec.requester,
    responder: rec.responder,
    offering: rec.offering,
    observed_at: rec.observed_at,
    bound_by: by,
  };
}

/** How many other askers a record lists; the rest are counted. */
export const MAX_ASKERS = 64;

/** The askers index for one Task: who the provider answered with its id. */
export interface Askers {
  requesters: string[];
  askers_overflow?: number;
  askers_overflow_since?: string;
}

/** One `task.cancel` request as the tap saw it. */
export interface ObservedCancel {
  v: 1;
  request_id: string;
  /** When this server received it (the tap's arrival time). */
  observed_at: string;
  /** The envelope's own `ts`, signed by its sender (the requester). */
  sent_at?: string;
}

/**
 * How long after a Task's creation a request may first be seen and still be
 * the one that created it. The tap and the update handler run independently,
 * so a creating update can be recorded a little before its request is; a
 * request first seen later than this names a Task that already existed. Wide
 * enough for a tap that has fallen behind under load (it stamps `observed_at`
 * when it gets to an envelope); a genuine resume of a Task older than this is
 * what it keeps out.
 */
export const ORIGIN_SKEW_MS = 60_000;

/** The offering a `task.cancel` request names (§10.8). */
const CANCEL_OFFERING = "task.cancel";

/** Requests that never create a Task, so the ledger keeps nothing for them:
 *  the registry's liveness probe, and the two exchanges the SDKs answer bare
 *  themselves before any handler runs, `describe` (§10.14) and `knock`
 *  (EXT-6). An agent that registers a handler of the same name and makes a
 *  Task of it gets no origin for that Task, which is safe. */
const NO_TASK_OFFERINGS: ReadonlySet<string> = new Set(["__registry_probe__", "describe", "knock"]);

/**
 * A delivery signal rather than an answer: the §6.4a accept, or a queued
 * acknowledgement, the answer a held delivery gets (a door hold, an attended
 * session, a mailbox) before the real one arrives later. The queued shape is
 * the SDK's `queuedAckOf` matcher (conformance/accept-signal.json): no error,
 * and `queued: true` with a non-empty `inbox_id` on the payload or its output.
 */
export function isDeliverySignal(env: Envelope): boolean {
  const p = env.payload as Record<string, unknown> | null | undefined;
  if (p?.status === "accepted") return true;
  if (env.error) return false;
  for (const c of [p, p?.output as Record<string, unknown> | null | undefined]) {
    if (c && typeof c === "object" && c.queued === true && typeof c.inbox_id === "string" && c.inbox_id.length > 0) {
      return true;
    }
  }
  return false;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

export const requestKey = (requestId: string) => `r.${sha(requestId)}`;
export const requestBindingKey = (requestId: string) => `q.${sha(requestId)}`;
export const taskBindingKey = (requester: string, responder: string, taskId: string) =>
  `t.${sha(`${requester}\n${responder}\n${taskId}`)}`;
export const firstAnswerKey = (requestId: string) => `a.${sha(requestId)}`;
/** How many contesting request ids a record lists; the rest are counted. */
export const MAX_CONTESTED_BY = 256;
export const multipleKey = (requester: string, responder: string, taskId: string) =>
  `m.${sha(`${requester}\n${responder}\n${taskId}`)}`;
export const askersKey = (responder: string, taskId: string) => `p.${sha(`${responder}\n${taskId}`)}`;
export const overflowKey = (evidenceKey: string, requestId: string) => `n.${sha(`${evidenceKey}\n${requestId}`)}`;
export const contestKey = (requester: string, responder: string, taskId: string) =>
  `k.${sha(`${requester}\n${responder}\n${taskId}`)}`;
export const cancelKey = (taskId: string, from: string, to: string) => `c.${sha(`${taskId}\n${from}\n${to}`)}`;
/** The window marker beside a cancel key: received and unwritten cancel requests. */
export const cancelWindowKey = (taskId: string, from: string, to: string) => `w.${sha(`${taskId}\n${from}\n${to}`)}`;

/** The parts of a stored Task record origin binding reads. */
interface TaskParties {
  requester?: string;
  responder?: string;
  created_at?: string;
  origin?: TaskOrigin;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** `create`, where an existing key is not an error: first write wins. */
async function createOnce(store: KeyedStore, key: string, value: unknown): Promise<boolean> {
  try {
    await store.create(key, enc(value));
    return true;
  } catch {
    // Either the key exists (the case this is for) or the write failed; a
    // read tells the two apart for the callers that care.
    return false;
  }
}

async function read<T>(store: KeyedStore, key: string): Promise<T | null> {
  const e = await store.get(key);
  if (!e || e.operation === "DEL" || e.operation === "PURGE" || e.length === 0) return null;
  try {
    return e.json<T>();
  } catch {
    return null;
  }
}

/**
 * Whether a Task record's parties are the origin's: the condition for a
 * binding to attach to it.
 */
export function partiesMatch(task: TaskParties, origin: TaskOrigin): boolean {
  return task.responder === origin.responder && task.requester === origin.requester;
}

/** A request observed later than ORIGIN_SKEW_MS after its Task existed did not create it. */
function seenTooLate(task: TaskParties, observedAt: string): boolean {
  const created = Date.parse(task.created_at ?? "");
  const seen = Date.parse(observedAt);
  return Number.isFinite(created) && Number.isFinite(seen) && seen - created > ORIGIN_SKEW_MS;
}

/**
 * How long the update handler waits for the cancel-request read that decides
 * `canceled_by.requester_request`. Past it the attribution is written
 * unverified (never as "the requester did not ask") and settled later.
 */
export const CANCEL_READ_TIMEOUT_MS = 5_000;

/**
 * The grace period G: how long after a cancel (`at`) the server waits before
 * it may conclude "the requester did not ask" (`requester_request: null`).
 * Long enough for every task-manager instance's in-flight cancel-request write
 * and a normal tap backlog to land. Configurable (TASK_CANCEL_SETTLE_GRACE_MS,
 * task-manager-service.ts). Every instance must run a release with this rule:
 * an older instance still writes `requester_request: null` at the transition,
 * so instances are upgraded together.
 */
export const CANCEL_SETTLE_GRACE_MS = 60_000;

/** Past `at` plus this, an attribution still unverified becomes unverified
 *  `expired`: final, an operator's, and not swept again. Well inside the
 *  ledger's seven-day horizon, so no marker it relies on has expired. */
export const CANCEL_SETTLE_HORIZON_MS = 24 * 60 * 60_000;

/** When an unverified `canceled_by` is retried after the transition: early
 *  tries (a request seen settles at once), then just past G, then later. */
export function cancelSettleDelays(graceMs: number): number[] {
  return [...[1_000, 5_000, 30_000].filter((d) => d < graceMs), graceMs + 1_000, graceMs + 30_000, graceMs + 120_000];
}

/** How often the sweep looks for records still unverified. */
export const CANCEL_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Why a `canceled_by` is unverified.
 *  - `settling`: no cancel request seen yet, and the grace period has not
 *    passed; every responder-signed cancel without a seen request starts here.
 *  - `window_incomplete`: the reads worked, but a `task.cancel` request for
 *    this Task was received and not (or not yet) written.
 *  - `expired`: still unverified 24 hours after `at`; final, an operator's.
 *  - `no_origin`: the Task has no origin, so there is no original requester
 *    to vouch for; settled only if an origin is attached later. */
export type CancelReadFailure =
  | "read_failed"
  | "read_timed_out"
  | "ledger_unavailable"
  | "window_incomplete"
  | "settling"
  | "expired"
  | "no_origin";

/** The cancel-request read: what it found, or why it could not tell. `seen`
 *  is every cancel request recorded, earliest received first, and `overflow`
 *  whether more did not fit; `incomplete` says a received one is not
 *  recorded. */
export type CancelRead =
  | { ok: true; seen: ObservedCancel[]; overflow?: boolean; incomplete: boolean }
  | { ok: false; reason: "read_failed" | "read_timed_out" | "ledger_unavailable" };

/** Every `task.cancel` request `from` sent `to` about one Task, as kept under
 *  its cancel key: up to MAX_CANCEL_REQUESTS, earliest received first, and how
 *  many more did not fit. A v1 value (one request) reads as a list of one. */
export interface CancelRequests {
  v: 2;
  requests: ObservedCancel[];
  /** Requests received past the cap; any makes "none counts" unknowable. */
  overflow?: number;
}

/** How many cancel requests are kept per (Task id, sender, addressee). */
export const MAX_CANCEL_REQUESTS = 8;

function cancelListOf(raw: unknown): CancelRequests | null {
  const r = raw as { requests?: ObservedCancel[]; overflow?: number; request_id?: unknown } | null;
  if (!r || typeof r !== "object") return null;
  if (Array.isArray(r.requests)) return { v: 2, requests: r.requests, ...(r.overflow ? { overflow: r.overflow } : {}) };
  if (typeof r.request_id === "string") return { v: 2, requests: [r as ObservedCancel] };
  return null;
}

/** Background retries of a window marker write that failed. */
export const WINDOW_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 5_000, 30_000];

/** The store key holding the grace period the instances last said they use. */
export const GRACE_CONFIG_KEY = "g.settle_grace_ms";

/** The `task.cancel` requests received and not yet written, per window key. */
interface CancelWindow {
  v: 1;
  /** Envelope ids received whose write has not succeeded. */
  pending: string[];
}

/**
 * Read the first `task.cancel` request `from` sent `to` about this Task, and
 * whether the window it was recorded in is complete, bounded by `timeoutMs`.
 * A failure or a timeout is reported as such, never as "none seen".
 */
export async function readCancelRequest(
  origins: OriginLedger | undefined,
  taskId: string,
  from: string,
  to: string,
  timeoutMs = CANCEL_READ_TIMEOUT_MS,
): Promise<CancelRead> {
  if (!origins) return { ok: false, reason: "ledger_unavailable" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<CancelRead>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "read_timed_out" }), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  const read = Promise.all([origins.cancelRequests(taskId, from, to), origins.cancelWindowIncomplete(taskId, from, to)]).then(
    ([list, incomplete]): CancelRead => ({ ok: true, seen: list?.requests ?? [], overflow: !!list?.overflow, incomplete }),
    (err): CancelRead => {
      console.warn(`[task-manager] could not read the cancel requests of task ${taskId}:`, err);
      return { ok: false, reason: "read_failed" };
    },
  );
  try {
    const out = await Promise.race([read, timedOut]);
    if (!out.ok && out.reason === "read_timed_out") {
      console.warn(`[task-manager] reading the cancel requests of task ${taskId} timed out after ${timeoutMs}ms`);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a recorded cancel request counts as the requester asking before the
 * cancel at `atMs`: received at or before it, or received within the grace
 * period after it and signed by the requester as sent at or before it (a tap
 * whose subscription buffer was behind stamps its arrival late; the
 * requester's own `ts` can only cost the requester, never the responder).
 */
export function cancelRequestCounts(seen: ObservedCancel, atMs: number, graceMs: number): boolean {
  const received = Date.parse(seen.observed_at);
  if (received <= atMs) return true;
  const sent = Date.parse(seen.sent_at ?? "");
  return received <= atMs + graceMs && Number.isFinite(sent) && sent <= atMs;
}

/**
 * The attribution a cancel-request read supports, for a cancel the original
 * requester did not sign itself. One rule at the transition and on every
 * retry:
 *  - a seen request that counts ({@link cancelRequestCounts}) is verified, at
 *    any time;
 *  - `requester_request: null` ("did not ask") is NEVER written at the
 *    transition; a retry concludes it only from a read that worked, over a
 *    complete window, at least `graceMs` after `at` and within 24 hours;
 *  - past `at` + 24 h a retry writes unverified `expired`, final.
 * Every recorded request is weighed, so a later request that counts is not
 * hidden by an earlier one that does not; more requests than were kept make
 * "none counts" unknowable (`window_incomplete`).
 * A cancel the REQUESTER signed is the requester asking, whatever the reads
 * say: with `requesterUpdate` (its canceled update) it is verified
 * `via: "update"`, and without it it is never concluded null.
 * Everything else is unverified, `settling` while nothing says otherwise. A
 * retry's verified or expired result carries `resolved_at` (`nowMs`).
 */
export function cancelAttribution(
  party: TaskCanceledBy["party"],
  at: string,
  got: CancelRead,
  o: { nowMs: number; graceMs: number; atTransition?: boolean; requesterUpdate?: { request_id: string } | null },
): TaskCanceledBy {
  const atMs = Date.parse(at);
  const resolved = o.atTransition ? {} : { resolved_at: new Date(o.nowMs).toISOString() };
  if (party === "requester" && o.requesterUpdate) {
    return { party, requester_request: { request_id: o.requesterUpdate.request_id, observed_at: at, via: "update" }, at, ...resolved };
  }
  if (!o.atTransition && o.nowMs > atMs + CANCEL_SETTLE_HORIZON_MS) {
    return { party, at, unverified: true, unverified_reason: "expired", resolved_at: new Date(o.nowMs).toISOString() };
  }
  if (party === "requester") return { party, at, unverified: true, unverified_reason: "settling" };
  if (!got.ok) return { party, at, unverified: true, unverified_reason: got.reason };
  const seen = got.seen.find((x) => cancelRequestCounts(x, atMs, o.graceMs));
  if (seen) {
    return {
      party,
      requester_request: { request_id: seen.request_id, observed_at: seen.observed_at, via: "cancel_request" },
      at,
      ...resolved,
    };
  }
  if (got.incomplete || got.overflow) return { party, at, unverified: true, unverified_reason: "window_incomplete" };
  if (o.atTransition || o.nowMs < atMs + o.graceMs) return { party, at, unverified: true, unverified_reason: "settling" };
  return { party, requester_request: null, at, ...resolved };
}

/** The requester's own canceled update in a record's history (the signed
 *  envelope that moved it to `canceled`), when the requester signed it. */
export function requesterCancelUpdateOf(record: { requester?: string; responder?: string; history?: unknown }): { request_id: string } | null {
  const history = Array.isArray(record.history) ? (record.history as Envelope[]) : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const status = (h?.payload as { status?: unknown } | undefined)?.status;
    if (status !== "canceled") continue;
    if (!h.from || h.from === record.responder || h.from !== record.requester) return null;
    return typeof h.id === "string" && h.id ? { request_id: h.id } : null;
  }
  return null;
}

/** The (Task id, sender, addressee) a `task.cancel` request is recorded
 *  under, or null when the envelope is not one. */
export function cancelIdentity(env: Envelope): { taskId: string; from: string; to: string } | null {
  if (env.type !== "request") return null;
  const payload = env.payload as { offering?: unknown; skill?: unknown; input?: { task_id?: unknown } } | undefined;
  if ((str(payload?.offering) ?? str(payload?.skill)) !== CANCEL_OFFERING) return null;
  const taskId = str(payload?.input?.task_id) ?? str(env.task_id);
  const from = str(env.from);
  const to = str(env.to);
  if (!taskId || !from || !to || from === to) return null;
  return { taskId, from, to };
}

/** A settled `canceled_by`, and the record it was written to. */
export type CancelSettlement = {
  outcome: "settled" | "unverified" | "nothing";
  /** The record's `canceled_by` as it now stands (absent when there is none). */
  canceled_by?: TaskCanceledBy;
};

export class OriginLedger {
  constructor(
    private readonly store: KeyedStore,
    /** The Task records (`mesh_tasks`), read to gate a binding and written
     *  (compare-and-set) to attach an origin to a record that already exists. */
    private readonly tasks: KeyedStore,
    private readonly opts: {
      /** Called for a record whose `canceled_by` a retry settled (verified,
       *  or unverified `expired`), with the record as written: the service
       *  announces it on `mesh.event.task.canceled_by_settled`. At least once:
       *  the sweep calls it again for a settled record not yet flagged
       *  `canceled_by_announced_at`. */
      onCanceledBySettled?: (record: Record<string, unknown>) => void;
      /** The grace period G ({@link CANCEL_SETTLE_GRACE_MS}). */
      graceMs?: number;
    } = {},
  ) {}

  /** The grace period G this ledger settles with. */
  get graceMs(): number {
    return this.opts.graceMs ?? CANCEL_SETTLE_GRACE_MS;
  }

  /** Whether a sweep is running in this process (one at a time). */
  private sweeping = false;

  /** `task.cancel` requests received and not yet written, by window key:
   *  this process's copy of the window markers, kept even when the store
   *  cannot be written. */
  private readonly pendingCancels = new Map<string, Set<string>>();
  /** Envelope ids this process took out of a window and has not yet seen
   *  removed from the store's marker. */
  private readonly clearedCancels = new Map<string, Set<string>>();
  /** One store write of a window marker at a time, per window, in order. */
  private readonly windowChains = new Map<string, Promise<void>>();

  /**
   * One envelope from the inbox tap, already decoded with its signature
   * verified. `deliveredTo` is the agent whose inbox it arrived on; an
   * envelope addressed to anyone else is not observed. Returns once whatever
   * it records is written.
   */
  async observe(
    env: Envelope,
    deliveredTo: string,
    opts: {
      final?: boolean;
      /** When this server received the envelope (the tap's arrival time), so
       *  a tap that is behind does not stamp a later time. Defaults to now. */
      receivedAt?: number;
    } = {},
  ): Promise<Observation> {
    // §5.7: a message for a person is never work and never creates a Task.
    if (audienceOf(env) !== "agent") return "ignored";
    if (!deliveredTo || env.to !== deliveredTo) return "ignored";
    if (env.type === "request") {
      // An inbox-mode answer (§13.5) is a request naming the request it
      // answers: it is that request's answer, with no Task id, and nothing
      // else. Seen before its request, it is reported so the tap tries again
      // (it closes that request, so losing it would leave the request open).
      if (str(env.in_reply_to) && !isDeliverySignal(env)) {
        const fa = await this.firstAnswer(env, null);
        if (fa === "recorded" || fa === "not_first") return fa;
        if (fa === "unknown_request") {
          // Not its request's answer as far as anything here knows. Tried
          // again until the tap's last attempt; then it is recorded as the
          // ordinary request it may well be, and still reported as a miss.
          if (!opts.final) return fa;
          await this.observeRequest(env, opts.receivedAt);
          return fa;
        }
      }
      return this.observeRequest(env, opts.receivedAt);
    }
    if (env.type === "respond") return this.observeAnswer(env);
    return "ignored";
  }

  private async observeRequest(env: Envelope, receivedAt?: number): Promise<Observation> {
    const requester = str(env.from);
    const responder = str(env.to);
    if (!requester || !responder || requester === responder) return "ignored";
    const payload = env.payload as { offering?: unknown; skill?: unknown; input?: unknown } | undefined;
    // §8.5 deprecation window: pre-rename senders say `skill`.
    const offering = str(payload?.offering) ?? str(payload?.skill) ?? "";
    if (NO_TASK_OFFERINGS.has(offering)) return "ignored";
    const now = new Date().toISOString();

    if (offering === CANCEL_OFFERING) {
      // §10.8: the Task id rides the input (the SDKs), or the envelope.
      const input = payload?.input as { task_id?: unknown } | undefined;
      const taskId = str(input?.task_id) ?? str(env.task_id);
      if (!taskId) return "ignored";
      const at = receivedAt !== undefined ? new Date(receivedAt).toISOString() : now;
      const sent = str(env.ts);
      const rec: ObservedCancel = {
        v: 1,
        request_id: env.id,
        observed_at: at,
        ...(sent && Number.isFinite(Date.parse(sent)) ? { sent_at: sent } : {}),
      };
      await this.recordCancel(taskId, requester, responder, rec);
      return "recorded";
    }

    const rec: ObservedRequest = {
      v: 1,
      request_id: env.id,
      requester,
      responder,
      offering,
      ...(str(env.task_id) ? { task_id: env.task_id } : {}),
      ...((payload as { config?: { stream?: unknown } } | undefined)?.config?.stream === true ? { stream: true as const } : {}),
      observed_at: now,
    };
    if (!(await createOnce(this.store, requestKey(env.id), rec))) {
      // Seen already (another instance, or the outbox mirror). The binding
      // below is idempotent, so the first record is the one used.
      return "recorded";
    }
    // Nothing is bound or listed from a request's own naming of a Task id:
    // only the provider's answer carrying the Task id ties a request to it
    // (observeAnswer). A stream's opening respond is that answer.
    return "recorded";
  }

  private async observeAnswer(env: Envelope): Promise<Observation> {
    const replyTo = str(env.in_reply_to);
    if (!replyTo) return "ignored";
    // An accept or a queued acknowledgement is a delivery signal, never the
    // exchange's answer: the real answer is still to come.
    if (isDeliverySignal(env)) return "ignored";
    const taskId = str(env.task_id) ?? null;
    const outcome = await this.firstAnswer(env, taskId);
    if (outcome === "not_first" && taskId !== null) {
      // The asked agent answered this request with a Task id after its first
      // answer said something else (no Task, or another one). It binds
      // nothing, and the request is evidence against that Task.
      const rec = await read<ObservedRequest>(this.store, requestKey(replyTo));
      if (rec && rec.task_id !== taskId) return this.contest(rec, taskId, "not_first");
      return outcome;
    }
    if (outcome !== "recorded" || taskId === null) return outcome;
    const rec = await read<ObservedRequest>(this.store, requestKey(replyTo));
    if (!rec) return "unknown_request";
    // A request that named its own Task id is bound by it already, and an
    // answer cannot move it elsewhere (first observation wins anyway).
    return this.bind(rec, taskId, rec.task_id === taskId ? "request" : "answer");
  }

  /**
   * Record `env` as its request's first answer, or check it against the first
   * answer already recorded. "recorded" means `env` may speak for the
   * exchange: it is the first answer, or it repeats the first answer's Task id
   * (a task-mode responder answers more than once on the same Task). An
   * answer that closed the exchange without a Task id closes it for good, so a
   * later answer naming a Task binds nothing.
   */
  private async firstAnswer(env: Envelope, taskId: string | null): Promise<Observation> {
    const replyTo = str(env.in_reply_to)!;
    const rec = await read<ObservedRequest>(this.store, requestKey(replyTo));
    if (!rec) return "unknown_request";
    // Only the asked agent, answering the asker, speaks for this exchange.
    if (rec.responder !== env.from || rec.requester !== env.to) return "ignored";
    const mine: FirstAnswer = { v: 1, answer_id: env.id, task_id: taskId, observed_at: new Date().toISOString() };
    if (await createOnce(this.store, firstAnswerKey(replyTo), mine)) return "recorded";
    const first = await read<FirstAnswer>(this.store, firstAnswerKey(replyTo));
    if (!first) return "ignored";
    if (first.answer_id === env.id) return "recorded"; // the same answer, seen again
    if (taskId !== null && first.task_id === taskId) return "recorded";
    return "not_first";
  }

  /**
   * Bind `taskId` to the request `rec`, first observation winning both ways,
   * then attach the origin to the Task record when that record already exists.
   */
  /**
   * Bind `taskId` to `rec`, whose answer from the provider carried `taskId`
   * (the only way a request is ever tied to a Task: never from the request's
   * own naming of one). `by` says whether the request had named the Task
   * itself ("request", a stream) or the answer chose it ("answer").
   */
  private async bind(rec: ObservedRequest, taskId: string, by: TaskOrigin["bound_by"]): Promise<Observation> {
    const existing = await read<TaskParties>(this.tasks, taskId);
    const key = taskBindingKey(rec.requester, rec.responder, taskId);

    if (by === "request") {
      // The request's OWN envelope named this Task id, and the provider
      // answered under it. The reference SDK echoes a requester-named id, so
      // this is the requester's choice and never evidence against the
      // provider: on the record's own requester's Task it is part of that Task
      // (a resume, a same-task stream), and on anyone else's it is nothing at
      // all (#41's SDK refuses it, or answers under the id only while it could
      // not read the record).
      if (existing && existing.requester !== rec.requester) {
        noteOriginMiss("foreign_task_named", { task_id: taskId, request_id: rec.request_id });
        return "ignored";
      }
      // Its own Task, created long before: a resume or a same-task stream,
      // nothing new. Recently created (the creating update raced the tap), or
      // no record yet: the stream that creates the Task binds if nothing has;
      // otherwise it is part of the Task, silently.
      if (existing && seenTooLate(existing, rec.observed_at)) {
        const stored = await read<TaskOrigin>(this.store, key);
        if (stored && stored.bound_by === "request" && stored.request_id !== rec.request_id) {
          await appendMultiple(this.store, multipleKey(rec.requester, rec.responder, taskId), stored.request_id, rec.request_id);
          await this.mirror(taskId, rec.requester, rec.responder);
        }
        return "recorded";
      }
      if (!(await createOnce(this.store, requestBindingKey(rec.request_id), { task_id: taskId }))) {
        const bound = await read<{ task_id?: string }>(this.store, requestBindingKey(rec.request_id));
        if (!bound || bound.task_id !== taskId) return "recorded";
      }
      const origin = originOf(rec, by);
      let stored: TaskOrigin | null = origin;
      if (!(await createOnce(this.store, key, origin))) stored = await read<TaskOrigin>(this.store, key);
      if (!stored) return "recorded";
      if (stored.request_id !== rec.request_id) {
        // A second request naming the Task a stream created, answered under
        // it: two of the requester's requests ran as one Task. Not the origin
        // (the first stands) and not evidence against the provider (the
        // requester chose the id), but the refund consumer must see that more
        // than one request is in this Task.
        if (stored.bound_by === "request") {
          await appendMultiple(this.store, multipleKey(rec.requester, rec.responder, taskId), stored.request_id, rec.request_id);
          await this.mirror(taskId, rec.requester, rec.responder);
        }
        return "recorded";
      }
      await attachOrigin(this.tasks, taskId, stored);
      await this.mirror(taskId, rec.requester, rec.responder);
      return "recorded";
    }

    // The provider answered a request that did NOT name this Task id with it:
    // the provider's own doing, so everything past the first binding is
    // evidence against the provider.
    await this.noteAsker(rec.responder, taskId, rec.requester);

    // Seen well after the Task already existed: it did not create the Task.
    if (existing && seenTooLate(existing, rec.observed_at)) {
      const stored = await read<TaskOrigin>(this.store, key);
      if (stored?.request_id === rec.request_id) return "recorded";
      return this.contest(rec, taskId, "late");
    }

    // One Task id per request: a request already bound elsewhere is evidence.
    if (!(await createOnce(this.store, requestBindingKey(rec.request_id), { task_id: taskId }))) {
      const bound = await read<{ task_id?: string }>(this.store, requestBindingKey(rec.request_id));
      if (!bound || bound.task_id !== taskId) return this.contest(rec, taskId, "not_first");
    }

    // One request per Task id (for these two parties): the first stands.
    const origin = originOf(rec, by);
    let stored: TaskOrigin | null = origin;
    if (!(await createOnce(this.store, key, origin))) stored = await read<TaskOrigin>(this.store, key);
    if (!stored) return "ignored";
    if (stored.request_id !== rec.request_id) return this.contest(rec, taskId, "bound");
    await attachOrigin(this.tasks, taskId, stored);
    // Evidence gathered before the origin attached goes onto it, and a record
    // naming another requester is given what was seen.
    await this.mirror(taskId, rec.requester, rec.responder);
    return "recorded";
  }

  /** Record `rec` as having contested `taskId`, on the evidence and the record. */
  private async contest(rec: ObservedRequest, taskId: string, why: "bound" | "late" | "not_first"): Promise<Observation> {
    const bound = await read<TaskOrigin>(this.store, taskBindingKey(rec.requester, rec.responder, taskId));
    noteOriginMiss("contested", {
      task_id: taskId,
      request_id: rec.request_id,
      bound_request_id: bound?.request_id ?? null,
      why,
    });
    await this.noteAsker(rec.responder, taskId, rec.requester);
    // The evidence first, then the record. The tap never waits for a record
    // that does not exist yet: if this mirror finds none, the update handler
    // creating it reads the evidence AFTER its create and mirrors it (written
    // before this read, so one of the two always sees it).
    await appendEvidence(this.store, contestKey(rec.requester, rec.responder, taskId), rec.request_id);
    await this.mirror(taskId, rec.requester, rec.responder);
    return "contested";
  }

  /** Remember that `requester` asked `responder` about `taskId`, until written. */
  private async noteAsker(responder: string, taskId: string, requester: string): Promise<void> {
    const key = askersKey(responder, taskId);
    let counted = false;
    for (let attempt = 0; attempt < UNTIL_WRITTEN; attempt++) {
      const e = await this.store.get(key);
      const live = e && e.operation !== "DEL" && e.operation !== "PURGE" && e.length > 0;
      const cur: Askers = live ? e!.json<Askers>() : { requesters: [] };
      if (cur.requesters.includes(requester)) return;
      let next: Askers;
      if (cur.requesters.length < MAX_ASKERS) {
        next = { ...cur, requesters: [...cur.requesters, requester] };
      } else {
        // Past the cap: counted once per asker, with when the first did not fit.
        if (!counted) {
          if (!(await createOnce(this.store, overflowKey(key, requester), { v: 1 }))) return;
          counted = true;
        }
        next = {
          ...cur,
          askers_overflow: (cur.askers_overflow ?? 0) + 1,
          askers_overflow_since: cur.askers_overflow_since ?? new Date().toISOString(),
        };
      }
      try {
        if (live) await this.store.update(key, enc(next), e!.revision);
        else await this.store.create(key, enc(next));
        return;
      } catch {
        await pause(attempt);
      }
    }
  }

  /** The askers index for this Task (listed askers, and how many did not fit). */
  async askersIndex(responder: string, taskId: string): Promise<Askers> {
    return (await read<Askers>(this.store, askersKey(responder, taskId))) ?? { requesters: [] };
  }

  /** Every asker the responder answered with this Task id. */
  async askersOf(responder: string, taskId: string): Promise<string[]> {
    return (await read<{ requesters: string[] }>(this.store, askersKey(responder, taskId)))?.requesters ?? [];
  }

  /**
   * Put what the ledger holds for (requester, responder, taskId) on a record
   * object, append-only (see {@link projectOnto}). Returns whether it changed.
   */
  async projectFor(task: TaskParties & Record<string, unknown>, taskId: string, requester: string, responder: string): Promise<boolean> {
    // A record naming someone else is given this asker's evidence only when
    // the responder answered the asker about this Task (askersOf).
    const mismatch = task.requester !== requester;
    if (mismatch && !(await this.askersOf(responder, taskId)).includes(requester)) return false;
    const [origin, ev, multiple] = await Promise.all([
      read<TaskOrigin>(this.store, taskBindingKey(requester, responder, taskId)),
      read<ContestEvidence>(this.store, contestKey(requester, responder, taskId)),
      read<{ multiple_requests: string[] }>(this.store, multipleKey(requester, responder, taskId)),
    ]);
    const changed = projectOnto(task, requester, responder, origin, ev);
    // Its own requester's several requests in one Task: on the origin, or on
    // the record while it has none. Append-only. Never for another asker.
    if (!multiple?.multiple_requests?.length || task.requester !== requester || task.responder !== responder) return changed;
    const target = (task.origin ?? task) as { multiple_requests?: string[] };
    const have = target.multiple_requests ?? [];
    const next = [...have];
    for (const id of multiple.multiple_requests) if (!next.includes(id)) next.push(id);
    if (next.length === have.length) return changed;
    target.multiple_requests = next;
    return true;
  }

  /** {@link projectFor}, for every asker the ledger knows about this Task. */
  async projectAll(task: TaskParties & Record<string, unknown>, taskId: string): Promise<boolean> {
    if (!task.responder) return false;
    const index = await this.askersIndex(task.responder, taskId);
    const askers = new Set(index.requesters);
    if (task.requester) askers.add(task.requester);
    let changed = false;
    for (const a of askers) if (await this.projectFor(task, taskId, a, task.responder)) changed = true;
    // Askers past the cap: counted on the record, append-only.
    if (index.askers_overflow && (task.askers_overflow as number | undefined ?? 0) < index.askers_overflow) {
      task.askers_overflow = index.askers_overflow;
      changed = true;
    }
    if (index.askers_overflow_since && !task.askers_overflow_since) {
      task.askers_overflow_since = index.askers_overflow_since;
      changed = true;
    }
    return changed;
  }

  /**
   * Write what the ledger holds for these parties onto the stored record,
   * append-only and until written, terminal or not. A record that does not
   * exist yet is left to the update handler, which projects the ledger when
   * it creates one; this never waits.
   */
  async mirror(taskId: string, requester: string, responder: string): Promise<void> {
    for (let attempt = 0; attempt < UNTIL_WRITTEN; attempt++) {
      const e = await this.tasks.get(taskId);
      if (!e || e.operation === "DEL" || e.operation === "PURGE" || e.length === 0) return;
      let task: TaskParties & Record<string, unknown>;
      try {
        task = e.json<typeof task>();
      } catch {
        return;
      }
      if (!(await this.projectFor(task, taskId, requester, responder))) return;
      try {
        await this.tasks.update(taskId, enc(task), e.revision);
        return;
      } catch {
        await pause(attempt);
      }
    }
    console.error(`[task-manager] contest evidence for task ${taskId} could not be mirrored after ${UNTIL_WRITTEN} tries`);
  }

  /**
   * The record as a reader should see it: the stored record with what the
   * ledger holds projected onto a copy, the origin included when it was never
   * attached (under the attach rules). Nothing is written. A terminal record
   * whose mirror was lost (a crash between the ledger write and the record
   * write) still shows its evidence this way.
   */
  async view<T extends Record<string, unknown>>(record: T, taskId: string): Promise<T> {
    const task = JSON.parse(JSON.stringify(record)) as T & TaskParties;
    try {
      if (!task.origin && task.requester && task.responder) {
        const origin = await this.originFor(task.requester, task.responder, taskId);
        if (origin && partiesMatch(task, origin) && !seenTooLate(task, origin.observed_at)) {
          task.origin = { ...origin };
          foldLoose(task);
        }
      }
      await this.projectAll(task, taskId);
    } catch (err) {
      console.warn(`[task-manager] could not read the ledger for task ${taskId}; showing the record as stored:`, err);
      return record;
    }
    // An unverified cancel attribution is settled on the stored record (by
    // compare-and-set, announced once) when the read now supports it, and the
    // reader sees the result; while it cannot be, the reader sees unverified.
    const t = task as unknown as { origin?: TaskOrigin; canceled_by?: TaskCanceledBy };
    if (t.canceled_by?.unverified && t.origin) {
      const r = await this.settleCanceledBy(taskId).catch(() => null);
      if (r?.canceled_by && !r.canceled_by.unverified) t.canceled_by = r.canceled_by;
    }
    return task;
  }

  /** The contest evidence for this Task id between these parties, if any. */
  async evidenceFor(requester: string, responder: string, taskId: string): Promise<ContestEvidence | null> {
    if (!requester || !responder) return null;
    return read<ContestEvidence>(this.store, contestKey(requester, responder, taskId));
  }

  /** The origin bound to this Task id for these two parties, if any. */
  async originFor(requester: string, responder: string, taskId: string): Promise<TaskOrigin | null> {
    if (!requester || !responder) return null;
    return read<TaskOrigin>(this.store, taskBindingKey(requester, responder, taskId));
  }

  /** Every `task.cancel` request `from` sent `to` about this Task (kept up to
   *  MAX_CANCEL_REQUESTS, earliest received first), if any. */
  async cancelRequests(taskId: string, from: string, to: string): Promise<CancelRequests | null> {
    return cancelListOf(await read<unknown>(this.store, cancelKey(taskId, from, to)));
  }

  /** The earliest-received `task.cancel` request `from` sent `to` about this Task, if seen. */
  async cancelRequest(taskId: string, from: string, to: string): Promise<ObservedCancel | null> {
    return (await this.cancelRequests(taskId, from, to))?.requests[0] ?? null;
  }

  /**
   * Record a `task.cancel` request beside the others for this (Task id,
   * sender, addressee): every one up to MAX_CANCEL_REQUESTS, ordered by when
   * it was received (a retried write can land after a later request's), and a
   * count of the rest. A write that fails leaves the envelope pending in the
   * window, in memory and in the store's marker (written at once, retried in
   * the background), and throws so the tap retries.
   */
  private async recordCancel(taskId: string, from: string, to: string, rec: ObservedCancel): Promise<void> {
    const key = cancelKey(taskId, from, to);
    const wkey = cancelWindowKey(taskId, from, to);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.store.create(key, enc({ v: 2, requests: [rec] } satisfies CancelRequests));
          break;
        } catch (err) {
          const e = await this.store.get(key);
          if (!e || e.operation === "DEL" || e.operation === "PURGE" || e.length === 0) throw err;
          const have = cancelListOf(e.json<unknown>()) ?? { v: 2 as const, requests: [] };
          if (have.requests.some((x) => x.request_id === rec.request_id)) break;
          const next: CancelRequests =
            have.requests.length < MAX_CANCEL_REQUESTS
              ? {
                  ...have,
                  requests: [...have.requests, rec].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at)),
                }
              : { ...have, overflow: (have.overflow ?? 0) + 1 };
          try {
            await this.store.update(key, enc(next), e.revision);
            break;
          } catch (lost) {
            if (attempt >= 10) throw lost;
          }
        }
      }
    } catch (err) {
      await this.markCancelPending(wkey, rec.request_id);
      throw err;
    }
    await this.cancelWritten(wkey, rec.request_id);
  }

  /**
   * A received `task.cancel` request whose write has not succeeded yet: kept
   * in memory, and written to the store's marker at once (in order with the
   * window's other marker writes, retried in the background when it fails),
   * so a settle on ANOTHER instance sees the window incomplete too.
   */
  markCancelPending(wkey: string, envelopeId: string): Promise<void> {
    const set = this.pendingCancels.get(wkey) ?? new Set<string>();
    set.add(envelopeId);
    this.pendingCancels.set(wkey, set);
    this.clearedCancels.get(wkey)?.delete(envelopeId);
    return this.syncWindow(wkey);
  }

  /** The tap's mark for an envelope it received, before it is written. */
  cancelArrived(env: Envelope): Promise<void> {
    const id = cancelIdentity(env);
    return id ? this.markCancelPending(cancelWindowKey(id.taskId, id.from, id.to), env.id) : Promise.resolve();
  }

  /** The tap is done with an envelope the ledger ignored or wrote. */
  async cancelSettledInTap(env: Envelope): Promise<void> {
    const id = cancelIdentity(env);
    if (id) await this.cancelWritten(cancelWindowKey(id.taskId, id.from, id.to), env.id);
  }

  /** An envelope's write succeeded (or it was never one to write): out of the
   *  window's pending list, in memory and in the store. A store marker that
   *  cannot be cleared is retried; until then it reads as incomplete. */
  private cancelWritten(wkey: string, envelopeId: string): Promise<void> {
    const set = this.pendingCancels.get(wkey);
    if (set) {
      set.delete(envelopeId);
      if (!set.size) this.pendingCancels.delete(wkey);
    }
    const cleared = this.clearedCancels.get(wkey) ?? new Set<string>();
    cleared.add(envelopeId);
    this.clearedCancels.set(wkey, cleared);
    return this.syncWindow(wkey);
  }

  /**
   * Bring the store's marker for one window in line with this process: add
   * every id pending here, remove every id cleared here. Queued per window so
   * an add never lands after its own removal; a failure is retried in the
   * background (WINDOW_RETRY_DELAYS_MS) and by the sweep. Resolves when this
   * attempt is done, whatever its outcome.
   */
  private syncWindow(wkey: string, attempt = 0): Promise<void> {
    const prev = this.windowChains.get(wkey) ?? Promise.resolve();
    const run = prev.then(async () => {
      const add = [...(this.pendingCancels.get(wkey) ?? [])];
      const remove = [...(this.clearedCancels.get(wkey) ?? [])];
      if (!add.length && !remove.length) return;
      try {
        await this.writeWindow(wkey, (w) => {
          const kept = w.pending.filter((x) => !remove.includes(x));
          const next = [...kept, ...add.filter((x) => !kept.includes(x))];
          const same = next.length === w.pending.length && next.every((x) => w.pending.includes(x));
          return same ? null : { ...w, pending: next };
        });
        const cleared = this.clearedCancels.get(wkey);
        if (cleared) {
          for (const x of remove) cleared.delete(x);
          if (!cleared.size) this.clearedCancels.delete(wkey);
        }
      } catch {
        if (attempt < WINDOW_RETRY_DELAYS_MS.length) {
          const t = setTimeout(() => void this.syncWindow(wkey, attempt + 1), WINDOW_RETRY_DELAYS_MS[attempt]);
          (t as { unref?: () => void }).unref?.();
        } else {
          console.warn(`[task-manager] the cancel window marker ${wkey} could not be written; the sweep keeps trying`);
        }
      }
    });
    this.windowChains.set(wkey, run);
    void run.finally(() => {
      if (this.windowChains.get(wkey) === run) this.windowChains.delete(wkey);
    });
    return run;
  }

  /** Compare-and-set the window marker; `next` returns null for no change. */
  private async writeWindow(wkey: string, next: (w: CancelWindow) => CancelWindow | null): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const e = await this.store.get(wkey);
      const live = e && e.operation !== "DEL" && e.operation !== "PURGE" && e.length > 0;
      const cur: CancelWindow = live ? e.json<CancelWindow>() : { v: 1, pending: [] };
      const want = next(cur);
      if (!want) return;
      try {
        if (live) await this.store.update(wkey, enc(want), e.revision);
        else await this.store.create(wkey, enc(want));
        return;
      } catch {
        await pause(attempt);
      }
    }
    throw new Error(`cancel window ${wkey} could not be written`);
  }

  /** Whether a `task.cancel` request `from` sent `to` about this Task was
   *  received and is not written (here or, per the store, anywhere). */
  async cancelWindowIncomplete(taskId: string, from: string, to: string): Promise<boolean> {
    const wkey = cancelWindowKey(taskId, from, to);
    if (this.pendingCancels.get(wkey)?.size) return true;
    const w = await read<CancelWindow>(this.store, wkey);
    return !!w?.pending?.length;
  }

  /** Bring every window marker this process holds marks for in line with
   *  the store (the sweep), past the background retries. */
  async flushPendingCancels(): Promise<void> {
    const keys = new Set([...this.pendingCancels.keys(), ...this.clearedCancels.keys()]);
    for (const wkey of keys) await this.syncWindow(wkey, WINDOW_RETRY_DELAYS_MS.length);
  }

  /**
   * The grace period G must be the same on every task-manager instance: a
   * settle on an instance with a shorter G could conclude "did not ask"
   * before another instance's in-flight write lands. Each instance compares
   * its G with the one last written to the store, warns when they differ, and
   * writes its own. Run at start and on every sweep. Returns the G the store
   * held before (null when none).
   */
  async checkGraceConfig(): Promise<number | null> {
    let before: number | null = null;
    try {
      const v = await read<{ grace_ms?: unknown }>(this.store, GRACE_CONFIG_KEY);
      before = typeof v?.grace_ms === "number" ? v.grace_ms : null;
      if (before !== null && before !== this.graceMs) {
        console.warn(
          `[task-manager] TASK_CANCEL_SETTLE_GRACE_MS differs between task-manager instances: this one uses ${this.graceMs} ms, ` +
            `another wrote ${before} ms. Every instance must use the same grace period.`,
        );
      }
      if (before !== this.graceMs) await this.store.put(GRACE_CONFIG_KEY, enc({ grace_ms: this.graceMs }));
    } catch (err) {
      console.warn("[task-manager] could not check the cancel settle grace period against the other instances:", err);
    }
    return before;
  }

  /**
   * Settle an unverified `canceled_by` on the stored record by the rule in
   * {@link cancelAttribution}: read the original requester's cancel requests
   * and window again and, when they now support a verified attribution (or
   * the 24-hour horizon has passed: `expired`), write it by compare-and-set,
   * with `resolved_at`, and announce it. A read that still cannot conclude
   * leaves it unverified, with the reason updated. Returns the outcome and the
   * record's `canceled_by` as it now stands.
   */
  async settleCanceledBy(
    taskId: string,
    timeoutMs = CANCEL_READ_TIMEOUT_MS,
    nowMs = Date.now(),
  ): Promise<CancelSettlement> {
    const e = await this.tasks.get(taskId);
    if (!e || e.operation === "DEL" || e.operation === "PURGE" || e.length === 0) return { outcome: "nothing" };
    let stored: { origin?: TaskOrigin; canceled_by?: TaskCanceledBy; requester?: string; responder?: string; history?: unknown };
    try {
      stored = e.json<typeof stored>();
    } catch {
      return { outcome: "nothing" };
    }
    const c = stored.canceled_by;
    if (!c?.unverified || c.unverified_reason === "expired" || !stored.origin) {
      return { outcome: "nothing", ...(c ? { canceled_by: c } : {}) };
    }
    // The requester signed the canceled state itself: it asked. Its own
    // update is the evidence, never a read of cancel requests, never null.
    const requesterUpdate = c.party === "requester" ? requesterCancelUpdateOf(stored) : null;
    const expired = nowMs > Date.parse(c.at) + CANCEL_SETTLE_HORIZON_MS;
    const got: CancelRead =
      expired || c.party === "requester"
        ? { ok: false, reason: "read_failed" } // not read: the horizon or the requester's own update decides
        : await readCancelRequest(this, taskId, stored.origin.requester, stored.origin.responder, timeoutMs);
    const next = cancelAttribution(c.party, c.at, got, { nowMs, graceMs: this.graceMs, requesterUpdate });
    if (next.unverified && next.unverified_reason !== "expired") {
      if (next.unverified_reason !== c.unverified_reason && got.ok) {
        const w = await rewriteTask<{ canceled_by?: TaskCanceledBy }>(this.tasks, taskId, (t) => {
          if (!t.canceled_by?.unverified || t.canceled_by.unverified_reason === "expired") return false;
          if (t.canceled_by.unverified_reason === next.unverified_reason) return false;
          t.canceled_by = next;
          return true;
        }).catch(() => null);
        if (w?.canceled_by) return { outcome: "unverified", canceled_by: w.canceled_by };
      }
      return { outcome: "unverified", canceled_by: c };
    }
    const written = await rewriteTask<Record<string, unknown> & { canceled_by?: TaskCanceledBy }>(this.tasks, taskId, (t) => {
      if (!t.canceled_by?.unverified || t.canceled_by.unverified_reason === "expired") return false;
      t.canceled_by = next;
      delete t.canceled_by_announced_at;
      return true;
    });
    if (!written) {
      const now = await read<{ canceled_by?: TaskCanceledBy }>(this.tasks, taskId).catch(() => null);
      return { outcome: "nothing", ...(now?.canceled_by ? { canceled_by: now.canceled_by } : {}) };
    }
    if (next.unverified) {
      noteOriginMiss("canceled_by_expired", { task_id: taskId });
      console.error(`[task-manager] canceled_by of task ${taskId} is still unverified 24 hours after the cancel: expired, for an operator`);
    }
    await this.announceSettled(taskId, written);
    return { outcome: "settled", canceled_by: next };
  }

  /** Announce a settled record, then flag it announced (compare-and-set). A
   *  failed announce or flag leaves it for the sweep to announce again. */
  private async announceSettled(taskId: string, record: Record<string, unknown> & { canceled_by?: TaskCanceledBy }): Promise<void> {
    const resolvedAt = record.canceled_by?.resolved_at;
    if (!resolvedAt || !this.opts.onCanceledBySettled) return;
    try {
      this.opts.onCanceledBySettled(record);
    } catch (err) {
      console.warn(`[task-manager] could not announce the settled canceled_by of task ${taskId}:`, err);
      return;
    }
    const stamp = new Date().toISOString();
    await rewriteTask<Record<string, unknown> & { canceled_by?: TaskCanceledBy }>(this.tasks, taskId, (t) => {
      if (t.canceled_by?.resolved_at !== resolvedAt || t.canceled_by_announced_at) return false;
      t.canceled_by_announced_at = stamp;
      return true;
    }).catch(() => null);
  }

  /**
   * Retry {@link settleCanceledBy} in the background, stopping once it is
   * settled ({@link cancelSettleDelays}, from G). Timers do not hold the
   * process open; a restart loses them, and the sweep
   * ({@link sweepCanceledBy}) and every read of the record (task.get, the
   * privileged read) settle it instead.
   */
  settleCanceledByLater(taskId: string, delays: readonly number[] = cancelSettleDelays(this.graceMs)): void {
    let i = 0;
    let waited = 0;
    const next = () => {
      if (i >= delays.length) {
        console.warn(`[task-manager] canceled_by of task ${taskId} is still unverified after ${delays.length} retries; the sweep keeps trying`);
        return;
      }
      const t = setTimeout(() => {
        void this.settleCanceledBy(taskId)
          .catch((): CancelSettlement => ({ outcome: "unverified" }))
          .then((r) => {
            if (r.outcome === "unverified") next();
          });
      }, Math.max(0, delays[i] - waited));
      waited = delays[i++];
      (t as { unref?: () => void }).unref?.();
    };
    next();
  }

  /**
   * One sweep, one at a time in this process: write this process's pending
   * cancel marks to the store; announce again every settled record not yet
   * flagged announced; settle every record still unverified (not `expired`)
   * at least G after its cancel. Returns the ids it settled.
   */
  async sweepCanceledBy(
    loadEntries: () => Promise<Iterable<[string, { json<T>(): T }]>>,
    nowMs = Date.now(),
  ): Promise<string[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      await this.flushPendingCancels();
      await this.checkGraceConfig();
      const settled: string[] = [];
      for (const [key, entry] of await loadEntries()) {
        let rec: Record<string, unknown> & { canceled_by?: TaskCanceledBy };
        try {
          rec = entry.json<typeof rec>();
        } catch {
          continue;
        }
        const c = rec.canceled_by;
        if (!c) continue;
        if (c.resolved_at && !rec.canceled_by_announced_at) {
          await this.announceSettled(key, rec);
          continue;
        }
        if (!c.unverified || c.unverified_reason === "expired" || nowMs - Date.parse(c.at) < this.graceMs) continue;
        if (!rec.origin) continue; // nothing to read until an origin is attached
        const r = await this.settleCanceledBy(key, CANCEL_READ_TIMEOUT_MS, nowMs).catch(() => null);
        if (r?.outcome === "settled") settled.push(key);
      }
      return settled;
    } finally {
      this.sweeping = false;
    }
  }
}

/** Retry a compare-and-set loop "until written": every lost race is another
 *  writer's progress, so this ends; the bound only stops a broken store from
 *  spinning forever, and is loud when reached. */
const UNTIL_WRITTEN = 10_000;
const pause = (attempt: number) =>
  attempt < 3 ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, Math.min(50, attempt) * Math.random()));

/** `ev` with `requestId` added, or `ev` itself when already listed. Listed up
 *  to MAX_CONTESTED_BY; after that counted, with when the first did not fit. */
export function withContest(ev: ContestEvidence, requestId: string, now = new Date().toISOString()): ContestEvidence {
  if (ev.contested_by.includes(requestId)) return ev;
  if (ev.contested_by.length < MAX_CONTESTED_BY) return { ...ev, contested_by: [...ev.contested_by, requestId] };
  return {
    ...ev,
    contested_overflow: (ev.contested_overflow ?? 0) + 1,
    contested_overflow_since: ev.contested_overflow_since ?? now,
  };
}

/**
 * Merge contest evidence into a record's, append-only: the union of the two
 * lists (the evidence's order first), the larger overflow count, the earlier
 * overflow time. Returns null when `into` already holds all of `ev`.
 */
export function mergeEvidence(into: Partial<ContestEvidence>, ev: Partial<ContestEvidence>): ContestEvidence | null {
  const have = into.contested_by ?? [];
  const list = [...(ev.contested_by ?? [])];
  for (const id of have) if (!list.includes(id)) list.push(id);
  const overflow = Math.max(into.contested_overflow ?? 0, ev.contested_overflow ?? 0);
  const sinces = [into.contested_overflow_since, ev.contested_overflow_since].filter((x): x is string => !!x).sort();
  const merged: ContestEvidence = {
    contested_by: list,
    ...(overflow ? { contested_overflow: overflow } : {}),
    ...(sinces.length ? { contested_overflow_since: sinces[0] } : {}),
  };
  const same =
    list.length === have.length &&
    overflow === (into.contested_overflow ?? 0) &&
    (merged.contested_overflow_since ?? null) === (into.contested_overflow_since ?? null);
  return same ? null : merged;
}

/**
 * Put contest evidence on a Task record object, append-only: on its origin
 * when it has one, else on the record itself. Returns whether it changed.
 * Never adds, removes or alters any other origin field.
 */
export function applyEvidence(task: Record<string, unknown> & { origin?: TaskOrigin }, ev: Partial<ContestEvidence> | null): boolean {
  if (!ev || !ev.contested_by?.length && !ev.contested_overflow) return false;
  const target = (task.origin ?? task) as Partial<ContestEvidence>;
  const merged = mergeEvidence(target, ev);
  if (!merged) return false;
  target.contested_by = merged.contested_by;
  if (merged.contested_overflow) target.contested_overflow = merged.contested_overflow;
  if (merged.contested_overflow_since) target.contested_overflow_since = merged.contested_overflow_since;
  return true;
}

/** At most this many request ids in `multiple_requests`. */
export const MAX_MULTIPLE = 256;

/** Record that `requestId` also named and ran under a stream-created Task
 *  whose origin is `originId`: the list starts with the origin. Until written. */
async function appendMultiple(store: KeyedStore, key: string, originId: string, requestId: string): Promise<void> {
  for (let attempt = 0; attempt < UNTIL_WRITTEN; attempt++) {
    const e = await store.get(key);
    const live = e && e.operation !== "DEL" && e.operation !== "PURGE" && e.length > 0;
    const cur = live ? e!.json<{ multiple_requests: string[] }>() : { multiple_requests: [originId] };
    if (cur.multiple_requests.includes(requestId) || cur.multiple_requests.length >= MAX_MULTIPLE) return;
    const next = { multiple_requests: [...cur.multiple_requests, requestId] };
    try {
      if (live) await store.update(key, enc(next), e!.revision);
      else await store.create(key, enc(next));
      return;
    } catch {
      await pause(attempt);
    }
  }
}

/** Append one contesting request to the evidence, until written. A request
 *  past the cap is counted once however often it is seen (a marker per
 *  request), so `contested_overflow` is exact. */
async function appendEvidence(store: KeyedStore, key: string, requestId: string): Promise<ContestEvidence> {
  let counted = false;
  for (let attempt = 0; attempt < UNTIL_WRITTEN; attempt++) {
    const e = await store.get(key);
    const live = e && e.operation !== "DEL" && e.operation !== "PURGE" && e.length > 0;
    const cur: ContestEvidence = live ? e!.json<ContestEvidence>() : { contested_by: [] };
    if (cur.contested_by.includes(requestId)) return cur;
    if (cur.contested_by.length >= MAX_CONTESTED_BY && !counted) {
      // Past the cap: count this request only if no sighting counted it yet.
      if (!(await createOnce(store, overflowKey(key, requestId), { v: 1 }))) return cur;
      counted = true;
    }
    const next = withContest(cur, requestId);
    if (next === cur) return cur;
    try {
      if (live) await store.update(key, enc(next), e!.revision);
      else await store.create(key, enc(next));
      return next;
    } catch {
      await pause(attempt); // another writer got there first: read again
    }
  }
  console.error(`[task-manager] contest evidence for ${key} could not be written after ${UNTIL_WRITTEN} tries`);
  noteOriginMiss("error", { key, request_id: requestId });
  return { contested_by: [requestId] };
}

/**
 * Put one asker's binding and evidence on a record object, append-only.
 *
 * When the record names this asker as its requester, the evidence goes on
 * its origin, or on the record itself while it has none (the origin itself
 * is attached by attachOrigin / the update handler, under their own rules):
 * `origin.contested_by` and the record-level `contested_by` only ever hold
 * the record's own requester's requests. When the record names SOMEONE ELSE,
 * this asker's observed requests (its bound request and every contest) go
 * under `contested_by_asker[<asker>]`, kept apart from everyone else's, with
 * `origin_mismatch: {requester}` naming the first such asker: the responder
 * claimed a different buyer, and that is not allowed to hide what was seen.
 * Nothing for another responder. Returns whether it changed.
 */
export function projectOnto(
  task: TaskParties & Record<string, unknown>,
  requester: string,
  responder: string,
  origin: TaskOrigin | null,
  ev: ContestEvidence | null,
): boolean {
  if (task.responder !== responder) return false;
  if (task.requester === requester) return applyEvidence(task, ev);
  const ids = [...(origin ? [origin.request_id] : []), ...(ev?.contested_by ?? [])];
  if (!ids.length && !ev?.contested_overflow) return false;
  const byAsker = (task.contested_by_asker ?? {}) as Record<string, Partial<ContestEvidence>>;
  // At most MAX_ASKERS askers listed; the index counts the rest.
  if (!(requester in byAsker) && Object.keys(byAsker).length >= MAX_ASKERS) return false;
  const mine = byAsker[requester] ?? { contested_by: [] };
  const merged = mergeEvidence(mine, {
    contested_by: ids,
    ...(ev?.contested_overflow ? { contested_overflow: ev.contested_overflow } : {}),
    ...(ev?.contested_overflow_since ? { contested_overflow_since: ev.contested_overflow_since } : {}),
  });
  let changed = false;
  if (merged) {
    task.contested_by_asker = { ...byAsker, [requester]: merged };
    changed = true;
  }
  if (!task.origin_mismatch) {
    task.origin_mismatch = { requester };
    changed = true;
  }
  return changed;
}

/** On a record that has an origin, its own requester's loose evidence moves
 *  onto the origin (the same fold attachOrigin does). */
function foldLoose(task: Record<string, unknown> & { origin?: TaskOrigin }): void {
  if (task.origin && Array.isArray(task.multiple_requests)) {
    const have = (task.origin as { multiple_requests?: string[] }).multiple_requests ?? [];
    const next = [...have];
    for (const id of task.multiple_requests as string[]) if (!next.includes(id)) next.push(id);
    (task.origin as { multiple_requests?: string[] }).multiple_requests = next;
    delete task.multiple_requests;
  }
  if (!task.origin || (!task.contested_by && !task.contested_overflow)) return;
  applyEvidence(task, {
    contested_by: task.contested_by as string[] | undefined,
    contested_overflow: task.contested_overflow as number | undefined,
    contested_overflow_since: task.contested_overflow_since as string | undefined,
  });
  delete task.contested_by;
  delete task.contested_overflow;
  delete task.contested_overflow_since;
}

/**
 * What a party other than the responder may see of a record: everything
 * about itself, nothing the server recorded about OTHER askers. The
 * requester's own origin, contests and cancel attribution stay; another
 * asker's requests (`contested_by_asker`), the mismatch naming that asker,
 * and the count of further askers are removed. The responder, and the
 * platform's privileged read, see all of it.
 */
export function redactForRequester<T extends Record<string, unknown>>(record: T): T {
  const out = { ...record };
  delete out.contested_by_asker;
  delete out.origin_mismatch;
  delete out.askers_overflow;
  delete out.askers_overflow_since;
  return out;
}

/**
 * Attach an origin to an existing Task record that has none, by
 * compare-and-set so a concurrent update is not overwritten. Never replaces an
 * origin, never attaches to a record whose parties differ, and gives up
 * quietly after a few lost races: the update handler looks the binding up
 * again on the record's next update.
 */
export async function attachOrigin(tasks: KeyedStore, taskId: string, origin: TaskOrigin): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const e = await tasks.get(taskId);
    if (!e || e.operation === "DEL" || e.operation === "PURGE" || e.length === 0) return false;
    let task: TaskParties & Record<string, unknown>;
    try {
      task = e.json<TaskParties & Record<string, unknown>>();
    } catch {
      return false;
    }
    if (task.origin) return false;
    if (!partiesMatch(task, origin)) {
      console.warn(
        `[task-manager] origin for task ${taskId} not attached: the request's parties ` +
          `(${origin.requester.slice(0, 12)}… → ${origin.responder.slice(0, 12)}…) are not the record's`,
      );
      return false;
    }
    if (seenTooLate(task, origin.observed_at)) return false;
    task.origin = origin;
    // Evidence recorded while the record had no origin moves onto it, whole.
    const loose: Partial<ContestEvidence> = {
      contested_by: task.contested_by as string[] | undefined,
      contested_overflow: task.contested_overflow as number | undefined,
      contested_overflow_since: task.contested_overflow_since as string | undefined,
    };
    if (loose.contested_by?.length || loose.contested_overflow) {
      task.origin = { ...origin };
      applyEvidence(task, loose);
      delete task.contested_by;
      delete task.contested_overflow;
      delete task.contested_overflow_since;
    }
    if (Array.isArray(task.multiple_requests) && task.multiple_requests.length) {
      task.origin = { ...task.origin, multiple_requests: task.multiple_requests as string[] } as TaskOrigin;
      delete task.multiple_requests;
    }
    try {
      await tasks.update(taskId, enc(task), e.revision);
      return true;
    } catch {
      // Lost the compare-and-set to a concurrent update; read again.
    }
  }
  return false;
}
