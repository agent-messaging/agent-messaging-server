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
 *  - `c.<sha(task id \n sender \n addressee)>` → {@link ObservedCancel}
 *  - `k.<sha(requester \n responder \n task id)>` → {@link ContestEvidence}
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
import type { Envelope, TaskOrigin } from "../sdk.js";
import { audienceOf, TERMINAL_STATES } from "../sdk.js";
import type { KeyedStore } from "../storage/index.js";
import { noteOriginMiss } from "./origin-tap.js";

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
  observed_at: string;
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
export const askersKey = (responder: string, taskId: string) => `p.${sha(`${responder}\n${taskId}`)}`;
export const overflowKey = (evidenceKey: string, requestId: string) => `n.${sha(`${evidenceKey}\n${requestId}`)}`;
export const contestKey = (requester: string, responder: string, taskId: string) =>
  `k.${sha(`${requester}\n${responder}\n${taskId}`)}`;
export const cancelKey = (taskId: string, from: string, to: string) => `c.${sha(`${taskId}\n${from}\n${to}`)}`;

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

export class OriginLedger {
  constructor(
    private readonly store: KeyedStore,
    /** The Task records (`mesh_tasks`), read to gate a binding and written
     *  (compare-and-set) to attach an origin to a record that already exists. */
    private readonly tasks: KeyedStore,
  ) {}

  /**
   * One envelope from the inbox tap, already decoded with its signature
   * verified. `deliveredTo` is the agent whose inbox it arrived on; an
   * envelope addressed to anyone else is not observed. Returns once whatever
   * it records is written.
   */
  async observe(env: Envelope, deliveredTo: string, opts: { final?: boolean } = {}): Promise<Observation> {
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
          await this.observeRequest(env);
          return fa;
        }
      }
      return this.observeRequest(env);
    }
    if (env.type === "respond") return this.observeAnswer(env);
    return "ignored";
  }

  private async observeRequest(env: Envelope): Promise<Observation> {
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
      const rec: ObservedCancel = { v: 1, request_id: env.id, observed_at: now };
      await createOnce(this.store, cancelKey(taskId, requester, responder), rec);
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
      if (existing && seenTooLate(existing, rec.observed_at)) return "recorded";
      if (!(await createOnce(this.store, requestBindingKey(rec.request_id), { task_id: taskId }))) {
        const bound = await read<{ task_id?: string }>(this.store, requestBindingKey(rec.request_id));
        if (!bound || bound.task_id !== taskId) return "recorded";
      }
      const origin = originOf(rec, by);
      let stored: TaskOrigin | null = origin;
      if (!(await createOnce(this.store, key, origin))) stored = await read<TaskOrigin>(this.store, key);
      if (!stored || stored.request_id !== rec.request_id) return "recorded";
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
    const [origin, ev] = await Promise.all([
      read<TaskOrigin>(this.store, taskBindingKey(requester, responder, taskId)),
      read<ContestEvidence>(this.store, contestKey(requester, responder, taskId)),
    ]);
    return projectOnto(task, requester, responder, origin, ev);
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

  /** The first `task.cancel` request `from` sent `to` about this Task, if seen. */
  async cancelRequest(taskId: string, from: string, to: string): Promise<ObservedCancel | null> {
    return read<ObservedCancel>(this.store, cancelKey(taskId, from, to));
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
    try {
      await tasks.update(taskId, enc(task), e.revision);
      return true;
    } catch {
      // Lost the compare-and-set to a concurrent update; read again.
    }
  }
  return false;
}
