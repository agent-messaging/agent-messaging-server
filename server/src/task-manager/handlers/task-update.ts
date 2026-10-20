import type { BusMessage, Messaging } from "../../storage/index.js";
import type { KeyedStore } from "../../storage/index.js";
import type { Envelope, TaskState, RespondPayload } from "../../sdk.js";
import {
  decode,
  createEnvelope,
  isValidTransition,
  TERMINAL_STATES,
  Subjects,
} from "../../sdk.js";
import { idOf, sealEnvelope, type ServiceIdentity } from "../../shared/handler.js";
import { observedTaskTerminal, publishMeterEvents } from "../../shared/metering.js";
import { isPartyToTask, reportRefusal } from "../task-parties.js";
import { audienceRefusal, reportAudienceFirstUpdate } from "../audience.js";
import {
  validateBudget,
  deadlinePassed,
  spendFromPayload,
  BudgetCode,
  type Budget,
  type BudgetEnvelope,
  type BudgetTask,
} from "../budget.js";
import {
  attributionOf,
  validateCancel,
  validateStopFields,
  type CancelFields,
  type CancelReason,
  type DeclaredNeedsFn,
  type FailureFields,
  type TaskCancelFields,
} from "../cancel.js";
import type { LoadTaskEntries } from "../overdue-sweep.js";
import {
  applyEvidence,
  attachOrigin,
  mergeEvidence,
  partiesMatch,
  ORIGIN_SKEW_MS,
  type ContestEvidence,
  type OriginLedger,
} from "../origin.js";
import { rewriteTask } from "../task-write.js";
import { noteOriginMiss } from "../origin-tap.js";
import type { TaskCanceledBy, TaskOrigin } from "../../sdk.js";

/** The stored record, with every additive field family this service writes. */
type TaskRecord = BudgetTask & TaskCancelFields & {
  /** Common Agent §7.7: the task is trial work, admitted on the responder's
   *  trial declaration. Like `requester` and `budget`, it rides the creating
   *  update and is the responder's claim. A trial task gets a `trial`
   *  receipt in place of the completed or canceled one. */
  trial?: boolean;
  /** The request that created the task, as the server observed it routing
   *  that request (origin.ts). Written by this service only, never from an
   *  update's contents, never replaced, and kept outside `history`, so the
   *  history cap cannot drop it. Absent when the request was not observable. */
  origin?: TaskOrigin;
  /** On `canceled`: who asked for it, as this service observed it. */
  canceled_by?: TaskCanceledBy;
};

const MAX_TASK_HISTORY = 50;

/** Append an envelope to the task history, bounded (drop oldest beyond cap). */
function appendHistory(task: BudgetTask, env: Envelope): void {
  if (!task.history) task.history = [];
  task.history.push(env);
  if (task.history.length > MAX_TASK_HISTORY) {
    task.history = task.history.slice(-MAX_TASK_HISTORY);
  }
}

/**
 * Write a record this handler read at the start of its update (`read`, or
 * null for a record this update creates).
 *
 * Compare-and-set against what was read, so a write the origin tap made in
 * between (attaching an origin, or appending to its `contested_by`) is never
 * lost: on a lost race the stored record is read again, its `origin` (written
 * only by this service, never by a party) and its `canceled_by` when this
 * copy has none are taken over, and the write is tried again. The happy path
 * costs no extra read. A store whose entries carry no revisions (a test stub)
 * is written plainly.
 */
async function persist(
  kv: KeyedStore,
  taskId: string,
  task: BudgetTask,
  read: { revision?: number } | null = null,
): Promise<void> {
  const data = () => new TextEncoder().encode(JSON.stringify(task));
  const casable = typeof kv.update === "function" && typeof kv.create === "function" &&
    (read === null || typeof read.revision === "number");
  if (!casable) {
    await kv.put(taskId, data());
    return;
  }
  let revision = read?.revision;
  // Until written: every lost race is another writer's progress, and a plain
  // write here could wipe the contest evidence the origin tap appends.
  for (let attempt = 0; attempt < 10_000; attempt++) {
    try {
      if (revision === undefined) await kv.create(taskId, data());
      else await kv.update(taskId, data(), revision);
      return;
    } catch {
      const cur = await kv.get(taskId).catch(() => null);
      if (!cur || cur.operation === "DEL" || cur.operation === "PURGE" || !cur.value?.length) {
        revision = undefined;
        continue;
      }
      try {
        const stored = cur.json<TaskRecord>();
        const t = task as TaskRecord;
        // The service's own fields take the stored record's side: the origin
        // (never replaced) and its evidence (append-only, merged both ways).
        const ours = evidenceOf(t as unknown as Record<string, unknown>);
        if (stored.origin) t.origin = stored.origin;
        foldLooseEvidence(t as unknown as Record<string, unknown> & { origin?: TaskOrigin });
        applyEvidence(t as unknown as Record<string, unknown> & { origin?: TaskOrigin }, evidenceOf(stored as unknown as Record<string, unknown>));
        applyEvidence(t as unknown as Record<string, unknown> & { origin?: TaskOrigin }, ours);
        if (!t.canceled_by && stored.canceled_by) t.canceled_by = stored.canceled_by;
        const tm = t as unknown as Record<string, unknown>;
        const sm = stored as unknown as Record<string, unknown>;
        if (!tm.origin_mismatch && sm.origin_mismatch) tm.origin_mismatch = sm.origin_mismatch;
        // Other askers' evidence, per asker, append-only both ways.
        const theirs = (sm.contested_by_asker ?? {}) as Record<string, Partial<ContestEvidence>>;
        const mine = { ...((tm.contested_by_asker ?? {}) as Record<string, Partial<ContestEvidence>>) };
        for (const [asker, ev] of Object.entries(theirs)) {
          const m = mergeEvidence(mine[asker] ?? { contested_by: [] }, ev);
          if (m) mine[asker] = m;
        }
        if (Object.keys(mine).length) tm.contested_by_asker = mine;
      } catch { /* an unreadable record has nothing to keep */ }
      revision = cur.revision;
      if (attempt > 2) await new Promise((r) => setTimeout(r, Math.min(50, attempt) * Math.random()));
    }
  }
  console.error(`[task-manager] task ${taskId} could not be written after 10000 tries`);
}

/** All contest evidence a record holds, on its origin and loose on itself. */
function evidenceOf(task: Record<string, unknown>): ContestEvidence | null {
  const o = (task.origin ?? {}) as Partial<ContestEvidence>;
  const l = task as Partial<ContestEvidence>;
  const merged = mergeEvidence({ contested_by: o.contested_by, contested_overflow: o.contested_overflow, contested_overflow_since: o.contested_overflow_since }, l);
  return merged ?? (o.contested_by?.length || o.contested_overflow ? (o as ContestEvidence) : null);
}

/** On a record that has an origin, evidence left loose moves onto the origin. */
function foldLooseEvidence(task: Record<string, unknown> & { origin?: TaskOrigin }): void {
  if (!task.origin || (!task.contested_by && !task.contested_overflow)) return;
  const loose: Partial<ContestEvidence> = {
    contested_by: task.contested_by as string[] | undefined,
    contested_overflow: task.contested_overflow as number | undefined,
    contested_overflow_since: task.contested_overflow_since as string | undefined,
  };
  task.origin = { ...task.origin };
  applyEvidence(task, loose);
  delete task.contested_by;
  delete task.contested_overflow;
  delete task.contested_overflow_since;
}

export async function handleTaskUpdate(
  msg: BusMessage,
  kv: KeyedStore,
  nc: Messaging,
  serviceId: ServiceIdentity,
  /** §10.8 stranded-delegate fan-out needs to enumerate the bucket, and
   *  enumeration must never go through `kv.keys()` (it provably under-returns
   *  — shared/kv.ts). The service wires the same snapshot loader the overdue
   *  sweep uses; tests inject a map. Left unwired, the fan-out is skipped. */
  loadEntries?: LoadTaskEntries,
  /** §10.8a attribution: the responder's own declared `needs` references, so a
   *  "the caller did not furnish X" claim can be checked against a declaration
   *  the responder published before the work started. Left unwired, every
   *  failure is attributed to the provider — the same answer an unbacked claim
   *  gets, and the only safe default when the check cannot run. */
  declaredNeeds?: DeclaredNeedsFn,
  /** The task-origin ledger (origin.ts): the requests the server observed
   *  routing, and which one each Task id is bound to. Left unwired, records
   *  get no `origin` and a cancel's `requester_request` is always null. */
  origins?: OriginLedger,
): Promise<void> {
  let env: Envelope;
  try {
    env = decode(msg.data);
  } catch {
    console.error("[task-manager] failed to decode task update envelope");
    return;
  }

  // The task manager's own rebroadcasts and overdue notices are published on
  // this same subject (so a counterparty's existing task-update subscription
  // sees them), and the queue-group subscription loops them back here. They are
  // not inputs — this service is not a party to any task (task-parties.ts), so
  // processing them could only ever refuse them noisily. Recognized by the
  // verified `from`: only the holder of this service's key can produce them.
  if (env.from === idOf(serviceId)) return;

  // Extract task_id from subject: mesh.task.{task_id}.update
  const parts = msg.subject.split(".");
  const taskId = parts[2];
  if (!taskId) return;

  // §5.7: a message for the person behind an agent is never a Task
  // transition. An update whose `meta.audience` is present and is anything
  // other than "agent" leaves the Task as it was, creates no Task, and is
  // reported as an invalid transition is (§7.3), to a party only (see the
  // party check below for why a stranger gets no signed event).
  const audience = audienceRefusal(env);
  if (audience !== null) {
    const existing = await kv.get(taskId);
    if (!existing) {
      reportAudienceFirstUpdate(taskId, env.from, audience);
      return;
    }
    const current = existing.json<TaskRecord>();
    if (!isPartyToTask(current, env.from)) {
      reportRefusal(
        `an update marked meta.audience ${audience} on task ${taskId}`,
        env.from,
        `it is neither the requester nor the responder of this task.`,
      );
      return;
    }
    const toState = (env.payload as RespondPayload | undefined)?.status ?? null;
    console.warn(
      `[task-manager] invalid transition: an update marked meta.audience ${audience} ` +
        `for task ${taskId} (a message for a person is never a Task transition, §5.7)`,
    );
    const errEnv = createEnvelope({
      type: "emit",
      from: idOf(serviceId),
      payload: {
        domain: "task",
        event_type: "invalid_transition",
        data: {
          task_id: taskId,
          from_state: current.state,
          to_state: toState,
          agent: env.from,
          reason: "audience",
        },
      },
    });
    nc.publish(Subjects.event("task.invalid_transition"), sealEnvelope(errEnv, serviceId));
    return;
  }

  // §5.2 `budget` field, validated AT THE DOOR (§7.7): a malformed block
  // refuses the whole update before it touches any state — same
  // warn-and-return shape as the missing-status refusal below. Validated even
  // on updates where the block is otherwise ignored, because a block bad
  // enough to fail validation is a sender bug worth refusing loudly.
  const rawBudget = (env as BudgetEnvelope).budget;
  let envBudget: Budget | undefined;
  if (rawBudget !== undefined) {
    const checked = validateBudget(rawBudget);
    if (typeof checked === "string") {
      console.warn(`[task-manager] refused task update for ${taskId}: malformed budget — ${checked}`);
      return;
    }
    envBudget = checked;
  }

  // Determine new state from the envelope.
  //
  // `payload.status` is a RespondStatus, which is one value WIDER than the
  // Task state set: `"accepted"`, the §6.4a accept signal. That signal is a
  // delivery-time fact ("delivered, admitted, handler running"), deliberately
  // NOT a Task state — it chooses neither mode, never appears in a Task
  // record, and §7.2's state set is unchanged by it. This is the boundary
  // where respond statuses become task states, so it is narrowed away HERE —
  // dropped without effect, exactly as it has no effect on a Task anywhere
  // else — and the TaskState union is never widened to smuggle it through.
  const payload = env.payload as RespondPayload | undefined;
  const status = payload?.status;
  if (status === "accepted") return;
  const newState: TaskState | undefined = status;
  if (!newState) {
    // §7.7: a task update carrying only the `budget` block is a budget
    // revision, not a state transition.
    if (envBudget) {
      await handleBudgetRevision(taskId, env, envBudget, kv, nc, serviceId);
      return;
    }
    console.warn(`[task-manager] task update missing status: ${taskId}`);
    return;
  }

  // §10.8 cancel reason, validated AT THE DOOR — the same warn-and-return
  // shape as the malformed-budget refusal above, and for the same reason:
  // this subject is fire-and-forget, so INVALID_ENVELOPE here is a refusal
  // with nothing persisted and nothing published. Before the KV load on
  // purpose: a malformed cancel from ANYONE — party or stranger — is silence,
  // and never costs a read.
  let cancel: CancelFields | undefined;
  if (newState === "canceled") {
    const checked = validateCancel(payload);
    if (typeof checked === "string") {
      console.warn(
        `[task-manager] refused canceled update for ${taskId}: ${checked} (INVALID_ENVELOPE, §10.8)`,
      );
      return;
    }
    cancel = checked;
  }

  // §10.8: the same vocabulary ends a `failed` Task, with the reason OPTIONAL
  // — a Task that simply did not work out is a complete statement. The door is
  // the same one: a stated reason outside the enum, or an `unmet_need` that is
  // missing or malformed, refuses the whole update rather than being recorded
  // as a claim nobody can read.
  let failure: FailureFields | undefined;
  if (newState === "failed") {
    const checked = validateStopFields(payload, false);
    if (typeof checked === "string") {
      console.warn(
        `[task-manager] refused failed update for ${taskId}: ${checked} (INVALID_ENVELOPE, §10.8)`,
      );
      return;
    }
    failure = checked;
  }

  // Load current task record from KV
  const entry = await kv.get(taskId);

  let task: TaskRecord;
  if (entry) {
    // Task exists — authorize the sender, THEN validate the state transition
    task = entry.json<TaskRecord>();

    // The check that was missing. `decode()` above proved the sender holds the
    // key in `from`; it did not ask whether that key has anything to do with
    // this task, and `isValidTransition` below asks a question about the state
    // machine, not about identity. `pub mesh.task.>` is in every durable
    // credential (keychain/cred-template.ts) and task ids are broadcast on
    // `mesh.event.task.*`, so without this any signed-up agent could drive a
    // stranger's task to `completed` or `failed`, append its envelope to the
    // history and its artifacts to the deliverables, and make this service sign
    // and publish `mesh.event.task.<state>` about it. See task-parties.ts for
    // which two fields identify the parties, why either of them may drive any
    // §7.3 transition, and why no third party is allowed.
    //
    // BEFORE the transition check on purpose: an unauthorized sender must not be
    // able to make the service emit a signed `task.invalid_transition` either.
    // A PARTY's invalid transition still emits exactly one (conformance c02
    // counts them).
    if (!isPartyToTask(task, env.from)) {
      reportRefusal(
        `${task.state} → ${newState} on task ${taskId}`,
        env.from,
        // Coerced: a record whose parties are missing entirely still has to log,
        // not throw, or the diagnostic disappears into the service's catch-all.
        `it is neither the requester (${String(task.requester ?? "none").slice(0, 12)}…) nor ` +
          `the responder (${String(task.responder ?? "none").slice(0, 12)}…) of this task.`,
      );
      return;
    }

    if (!isValidTransition(task.state, newState)) {
      console.warn(
        `[task-manager] invalid transition: ${task.state} → ${newState} for task ${taskId}`,
      );

      // Publish error event
      const errEnv = createEnvelope({
        type: "emit",
        from: idOf(serviceId),
        payload: {
          domain: "task",
          event_type: "invalid_transition",
          data: {
            task_id: taskId,
            from_state: task.state,
            to_state: newState,
            agent: env.from,
          },
        },
      });
      nc.publish(Subjects.event("task.invalid_transition"), sealEnvelope(errEnv, serviceId));
      return;
    }

    // Update task state
    task.state = newState;
    task.updated_at = new Date().toISOString();

    // Append to history (bounded — drop oldest beyond cap)
    appendHistory(task, env);

    // Add artifacts if present
    if (env.artifacts?.length) {
      if (!task.artifacts) task.artifacts = [];
      task.artifacts.push(...env.artifacts);
    }

    // A `budget` block on a STATE update to an existing task is neither a
    // request nor a revision, and §5.2 says the field is "ignored elsewhere" —
    // a revision is a task update carrying ONLY the block (§7.7), so it cannot
    // ride along on a transition and skip the revision checks.
    if (envBudget) {
      console.warn(
        `[task-manager] ignored budget block on a state update for ${taskId} — ` +
          `a revision is a task update carrying only the budget block (§7.7)`,
      );
    }

    // An origin bound after this record was created (the tap and this handler
    // run independently) is attached here, on the record's next update, if a
    // compare-and-set from the tap did not already do it or was overwritten.
    // Never replaces one: an origin, once on the record, is the record's.
    if (!task.origin && origins) {
      const found = await lookupOrigin(origins, task.requester, task.responder, taskId);
      if (found && partiesMatch(task, found) && !createdLongBefore(task.created_at, found.observed_at)) {
        task.origin = found;
      }
    }
  } else {
    // Task doesn't exist yet — create it.
    //
    // This is the record's genesis: nothing else writes this bucket, so the
    // first update on the subject is where the task's two parties are fixed, and
    // every later authorization decision rests on what is written here. The
    // creator is the responder by definition (§7.0: the responder creates the
    // task), and its identity is the one field that is not a claim — `env.from`
    // was verified against the signature.
    //
    // `requester` is NOT verified. It is the creator's assertion of who asked,
    // because the task manager never sees the `request` that started the work
    // and so has nothing to check it against. Two consequences, stated rather
    // than papered over: a record created this way can name any agent as its
    // requester, and the `mesh.event.task.<state>` this service signs below then
    // carries that name. The blast radius is bounded — the creator can only ever
    // nominate a counterparty for a task id nobody else is using (ids are uuids;
    // an existing record takes the authorized branch above), and it cannot touch
    // an existing task — but a consumer must not read `requester` on a freshly
    // created task as proof that agent asked for anything. What a consumer CAN
    // read as proof is `origin` (origin.ts): the request the server itself
    // observed, attached only when its parties are this record's parties. A
    // record with no `origin` is one whose request the server did not see.
    //
    // A creating update with no `to` is refused. There would be no second party:
    // `requester` used to be set to "", which matches no sender, so the real
    // requester could neither progress nor read its own task for the seven days
    // the record lives — and each such record still costs a signed event on the
    // public bus. Every genuine publisher sets `to` (sdk-typescript
    // internal/stream.ts and mesh.ts, sdk-rust client.rs), so this refuses only
    // records that were already unusable.
    const requester = env.to?.trim();
    if (!requester) {
      reportRefusal(
        `creation of task ${taskId} (${newState})`,
        env.from,
        `the update names no requester in \`to\`, so the record would have no second party ` +
          `and the requester could never progress or read its own task.`,
      );
      return;
    }

    task = {
      id: taskId,
      requester,
      responder: env.from,
      // §8.5 deprecation window: pre-rename senders say `skill`.
      offering:
        ((env.payload as Record<string, unknown>)?.offering as string) ??
        ((env.payload as Record<string, unknown>)?.skill as string) ??
        "",
      state: newState,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      context_id: env.context_id,
      history: [env],
      artifacts: env.artifacts ?? [],
      // §7.7: trial work says so on the creating update, beside `offering`.
      ...((env.payload as Record<string, unknown> | undefined)?.trial === true ? { trial: true } : {}),
    };

    // The creating request, as the server observed it (origin.ts). Looked up
    // by the record's two parties and this Task id, so it attaches only when
    // the request the server saw was from this requester to this responder.
    // Nothing in this update is read for it.
    if (origins) {
      const found = await lookupOrigin(origins, requester, env.from, taskId);
      if (found) task.origin = found;
    }

    // §7.7 "Scope": when the responder goes deferred, the Task INHERITS the
    // request's budget. The task manager never sees the request itself (see the
    // genesis comment above), so inheritance rides the creating update: a
    // `budget` block here is the request's budget, persisted whole as the
    // current revision (0 on an initiating request). Like `requester`, it is
    // the creator's claim about the request — nothing exists to check it
    // against — and the requester can correct it by revision.
    if (envBudget) {
      task.budget = envBudget;
      if (envBudget.revision !== 0) {
        console.warn(
          `[task-manager] task ${taskId} created with budget revision ` +
            `${envBudget.revision} (a budget is revision 0 on the initiating request, §7.7)`,
        );
      }
    }
  }

  // §19.3: the responder's reported spend, off `payload.cost`. The RESPONDER's
  // claim only — a spend report is the seller's statement, and the requester's
  // updates (cancel, resume) must not overwrite it. Latest report wins; feeds
  // the retroactive-ceiling check on revisions and the metering receipt.
  const spend = env.from === task.responder ? spendFromPayload(env.payload) : undefined;
  if (spend) task.reported_spend = spend;

  // §7.7: a completion arriving after the deadline is ACCEPTED — the state
  // transition above already went through — and recorded as completed late.
  // DEADLINE_EXCEEDED is noted on the record and on the signed completion
  // event below, not written into the responder's envelope in `history`, whose
  // signature covers its bytes as sent.
  if (newState === "completed" && task.budget?.deadline && deadlinePassed(task.budget.deadline)) {
    task.completed_late = true;
    task.meta = { ...task.meta, deadline_exceeded: BudgetCode.DEADLINE_EXCEEDED };
  }

  // §10.8: the reason is what the record keeps as the meaning of the
  // cancellation. The free-text note is NOT stored as a field — it lives only
  // inside the sender's envelope in `history`, whose signature covers its
  // bytes as sent.
  if (newState === "canceled" && cancel) {
    task.canceled_by = await canceledBy(task, env, taskId, origins);
    task.cancel_reason = cancel.reason;
    if (cancel.unmet_need !== undefined) task.unmet_need = cancel.unmet_need;
    if (cancel.dependency !== undefined) task.dependency = cancel.dependency;
  }

  // §10.8a: whose failure this was. The responder stated a reason; this
  // service decides what the reason is worth by checking the named need
  // against the responder's OWN registered declarations — published before the
  // work started, where the caller could read them. The answer is written to
  // the record and stamped on the signed event below, and it is the only
  // attribution anything downstream may read: a party's own claim about whose
  // fault it was is not an input.
  //
  // Fails closed. A claim naming nothing declared, and a claim nobody could
  // check because the registry was unreadable, both come back `provider`. A
  // provider must not be able to buy a clean record with an assertion, and it
  // must not profit from an outage either; declaring what you need costs
  // nothing and is available to every honest provider in advance.
  let attributionFields: ReturnType<typeof attributionOf> | undefined;
  if (newState === "failed" && failure) {
    if (failure.reason !== undefined) task.failure_reason = failure.reason;
    if (failure.unmet_need !== undefined) task.unmet_need = failure.unmet_need;
    if (failure.dependency !== undefined) task.dependency = failure.dependency;

    let declared: ReadonlySet<string> | null = null;
    if (failure.reason === "needs_not_furnished" && declaredNeeds && task.responder) {
      try {
        declared = await declaredNeeds(task.responder, task.offering || undefined);
      } catch (err) {
        console.warn(
          `[task-manager] could not read declarations for ${String(task.responder).slice(0, 12)}…` +
            ` while attributing task ${taskId}; the claim stays with the provider:`,
          err,
        );
        declared = null;
      }
    }
    attributionFields = attributionOf(failure, declared);
    task.attribution = attributionFields.attribution;
    if (attributionFields.unmet_need_declared !== undefined) {
      task.unmet_need_declared = attributionFields.unmet_need_declared;
    }
  }

  // The record carries everything the ledger holds about this Task, on every
  // write, append-only: every asker's evidence, and for an asker the record
  // does not name, its observed requests and the mismatch. A contest the
  // record side missed repairs itself here.
  if (origins && task.responder) {
    foldLooseEvidence(task as unknown as Record<string, unknown> & { origin?: TaskOrigin });
    await origins.projectAll(task as unknown as Record<string, unknown>, taskId).catch((err) => {
      console.warn(`[task-manager] could not read the contest evidence of task ${taskId}:`, err);
    });
  }

  // Persist to KV
  await persist(kv, taskId, task, entry);

  // A record this update created: evidence the tap wrote between the read
  // above and this write found no record to go on (a Task created already
  // terminal is never written again), so it is read again now and mirrored.
  if (!entry && origins && task.responder) {
    const askers = new Set(await origins.askersOf(task.responder, taskId).catch(() => [] as string[]));
    if (task.requester) askers.add(task.requester);
    for (const a of askers) {
      await origins.mirror(taskId, a, task.responder).catch(() => undefined);
    }
  }

  // The tap may bind this Task id between the lookup above and the write just
  // made: its compare-and-set then found no record to attach to, or attached
  // to the revision this unconditional write has just replaced. One more look
  // closes that window, on every write that left the record without one.
  if (!task.origin && origins) {
    const found = await lookupOrigin(origins, task.requester, task.responder, taskId);
    if (found && (await attachOrigin(kv, taskId, found).catch(() => false))) task.origin = found;
    // Ending with no origin: the request never crossed this server, or an
    // observation was lost. Counted, so a mesh losing them says so.
    if (!task.origin && TERMINAL_STATES.has(newState)) {
      noteOriginMiss("terminal_without_origin", { task_id: taskId, state: newState });
    }
  }

  // Publish state change event.
  //
  // This service SIGNS this event with its own key, so whatever is in it goes
  // out with the platform's signature on it and consumers will treat it as
  // authoritative. What each field is actually worth, now that the transition
  // above is authorized:
  //
  //   - `task_id` / `state` — the subject token and the payload status, i.e.
  //     attacker-chosen before this fix and party-chosen after it. A party
  //     setting its own task's state is the intended mechanism.
  //   - `requester` / `responder` — read from the STORED record, not from this
  //     envelope, so on an existing task they are whatever the task was created
  //     with and cannot be steered by the update. `responder` was verified at
  //     creation (it was the creator's `from`); `requester` was the creator's
  //     unverified claim (see the creation branch above), and a consumer must
  //     not treat it as proof that agent asked for the work.
  //   - `offering` — also from the record, and also unverified: it comes from a
  //     `offering` field on the creating update's payload, which is not part of
  //     `RespondPayload` at all (§6.5), so in practice it is empty for every
  //     task the SDKs create.
  const eventEnv = createEnvelope({
    type: "emit",
    from: idOf(serviceId),
    payload: {
      domain: "task",
      event_type: newState,
      data: {
        task_id: taskId,
        state: newState,
        requester: task.requester,
        responder: task.responder,
        offering: task.offering,
        // The creating request as this service observed it, when it did.
        // Without its contest lists and its multiple_requests: request ids are
        // the record's business (and the platform's privileged read), not a
        // broadcast's.
        ...(task.origin ? { origin: broadcastOrigin(task.origin) } : {}),
        // §7.7: the late-completion record, on the platform-signed event the
        // requester can hold. Present only when a deadline was actually missed.
        ...(task.completed_late
          ? { completed_late: true, code: BudgetCode.DEADLINE_EXCEEDED }
          : {}),
        // §10.8: the cancel reason, additively, on the canceled lifecycle
        // event — the same enum the record and the §19.2 receipt carry.
        ...(newState === "canceled" && cancel ? { cancel_reason: cancel.reason } : {}),
        ...(newState === "canceled" && task.canceled_by ? { canceled_by: task.canceled_by } : {}),
        // §10.8/§10.8a: the failure's reason and the attribution this service
        // COMPUTED for it. Everything downstream that scores an outcome — the
        // reputation bureau above all — reads attribution from here, off an
        // event this service signed, and never from a party's own envelope.
        ...(newState === "failed" && failure
          ? {
              ...(failure.reason ? { failure_reason: failure.reason } : {}),
              ...(failure.unmet_need ? { unmet_need: failure.unmet_need } : {}),
              ...(failure.dependency ? { dependency: failure.dependency } : {}),
              attribution: attributionFields?.attribution ?? "provider",
              ...(attributionFields?.unmet_need_declared !== undefined
                ? { unmet_need_declared: attributionFields.unmet_need_declared }
                : {}),
            }
          : {}),
      },
    },
  });
  nc.publish(Subjects.event(`task.${newState}`), sealEnvelope(eventEnv, serviceId));

  // §19.2: the metering receipt, one per completed task (a platform SHOULD).
  // Cost in currency micro-units only — token counts are deliberately absent
  // (§19.1: a bare token count is meaningless across responders). `cost` is
  // the responder's reported spend (informative, unverified); `budget` is the
  // final (highest-revision) budget that applied, so the receipt records the
  // terms as well as the spend. Both omitted when never supplied.
  if (newState === "completed" && !task.trial) {
    const completedAtMs = Date.parse(task.updated_at);
    const startedAtMs = Date.parse(task.created_at);
    const receiptData = {
      task_id: taskId,
      requester: task.requester,
      responder: task.responder,
      offering: task.offering,
      // The Task's context, when it has one — additive (§19.2 receipts are a
      // platform SHOULD, and consumers ignore unknown fields). What lets the
      // EXT-8 §3 per-context spend rollup be computed FROM the receipt, and
      // spares every other consumer a task-record read to learn the context.
      ...(task.context_id ? { context_id: task.context_id } : {}),
      started_at: task.created_at,
      completed_at: task.updated_at,
      duration_ms: Math.max(0, completedAtMs - startedAtMs),
      ...(task.reported_spend ? { cost: task.reported_spend } : {}),
      ...(task.budget ? { budget: task.budget } : {}),
      completed_late: task.completed_late === true,
      status: "completed",
    };
    const meteringEnv = createEnvelope({
      type: "emit",
      from: idOf(serviceId),
      payload: {
        domain: "metering",
        event_type: "task_completed",
        data: receiptData,
      },
    });
    nc.publish(Subjects.event("metering.task_completed"), sealEnvelope(meteringEnv, serviceId));
    // §13.5: the task's terminal meter events, beside the receipt the stream
    // can later derive it from. Deriving envelope: the terminal update
    // (§13.5's rule for events not derived from a single envelope). Guarded on
    // both parties because `requester` is the creator's unverified claim and
    // may be absent — a meter event without both sides is not a meter event.
    if (task.responder && task.requester) {
      publishMeterEvents(
        nc,
        serviceId,
        observedTaskTerminal(
          task.responder,
          task.requester,
          env.id,
          taskId,
          Math.max(0, completedAtMs - startedAtMs),
          true,
          task.offering || undefined,
        ),
      );
    }
    // EXT-8 §3: the reported-spend rollup is folded from this receipt by
    // whoever operates the mesh, from the bus (on AgentMesh,
    // platform-shared/spend-rollup.ts); never a block on anything here.
  }

  // §19.2: a cancellation ends spending authority the way a completion does,
  // so a canceled task gets a receipt too — on a DISTINCT subject, so a
  // consumer folding completed receipts never has cancellations arrive under
  // the name `task_completed`. Same fields, with `canceled_at` in place of
  // `completed_at`, no `completed_late`, plus `cancel_reason`. The free-text
  // note is deliberately not carried: the enum is the meaning the record
  // keeps.
  // §7.7: trial work gets a receipt under its own name, `trial`, for every
  // way it can end, so a consumer folding completed receipts never counts a
  // trial as a sale. It rates to zero for the requester, always: its meter
  // events carry `trial: true`, which rating drops like a refusal. The
  // responder's reported spend on it is the publisher's, so it is not folded
  // into the requester's spend rollup.
  if (task.trial && (newState === "completed" || newState === "failed" || (newState === "canceled" && cancel))) {
    const endedAtMs = Date.parse(task.updated_at);
    const startedAtMs = Date.parse(task.created_at);
    const receiptData = {
      task_id: taskId,
      requester: task.requester,
      responder: task.responder,
      offering: task.offering,
      ...(task.context_id ? { context_id: task.context_id } : {}),
      started_at: task.created_at,
      ended_at: task.updated_at,
      ended: newState,
      duration_ms: Math.max(0, endedAtMs - startedAtMs),
      ...(task.reported_spend ? { cost: task.reported_spend } : {}),
      ...(newState === "canceled" && cancel ? { cancel_reason: cancel.reason } : {}),
      ...(newState === "failed" && task.failure_reason ? { failure_reason: task.failure_reason } : {}),
      rated_micro: 0,
      status: "trial",
    };
    nc.publish(
      Subjects.event("metering.task_trial"),
      sealEnvelope(
        createEnvelope({ type: "emit", from: idOf(serviceId), payload: { domain: "metering", event_type: "task_trial", data: receiptData } }),
        serviceId,
      ),
    );
    if (task.responder && task.requester) {
      const batch = observedTaskTerminal(task.responder, task.requester, env.id, taskId, Math.max(0, endedAtMs - startedAtMs), newState === "completed", task.offering || undefined);
      publishMeterEvents(nc, serviceId, { ...batch, events: batch.events.map((e) => ({ ...e, trial: true })) });
    }
  }

  if (newState === "canceled" && cancel && !task.trial) {
    const canceledAtMs = Date.parse(task.updated_at);
    const startedAtMs = Date.parse(task.created_at);
    const receiptData = {
      task_id: taskId,
      requester: task.requester,
      responder: task.responder,
      offering: task.offering,
      // Additive, same as the completed receipt: the context the rollup
      // accounts this spend to.
      ...(task.context_id ? { context_id: task.context_id } : {}),
      started_at: task.created_at,
      canceled_at: task.updated_at,
      duration_ms: Math.max(0, canceledAtMs - startedAtMs),
      ...(task.reported_spend ? { cost: task.reported_spend } : {}),
      ...(task.budget ? { budget: task.budget } : {}),
      status: "canceled",
      cancel_reason: cancel.reason,
      ...(task.canceled_by ? { canceled_by: task.canceled_by } : {}),
    };
    const meteringEnv = createEnvelope({
      type: "emit",
      from: idOf(serviceId),
      payload: {
        domain: "metering",
        event_type: "task_canceled",
        data: receiptData,
      },
    });
    nc.publish(Subjects.event("metering.task_canceled"), sealEnvelope(meteringEnv, serviceId));
    // §13.5: `task_ms` on every terminal state; `tasks_completed` only on
    // completion, which this is not.
    if (task.responder && task.requester) {
      publishMeterEvents(
        nc,
        serviceId,
        observedTaskTerminal(
          task.responder,
          task.requester,
          env.id,
          taskId,
          Math.max(0, canceledAtMs - startedAtMs),
          false,
          task.offering || undefined,
        ),
      );
    }
    // EXT-8 §3: a cancellation ends spending authority the way a completion
    // does, so its reported spend rolls up the same way, from this receipt.
  }

  // §10.8 stranded delegates: the teeth on the propagation MUST. The
  // performer's duty to forward the cancel to its delegates is honor-system
  // inside the performer — nothing on the mesh can see its delegation
  // decisions — so the task manager looks for the observable residue: live
  // children of the canceled task's delegation chain. Skipped unless the
  // service wired an enumeration loader (never `kv.keys()` — shared/kv.ts).
  if (newState === "canceled" && cancel && task.context_id && loadEntries) {
    try {
      await flagStrandedDelegates(task, cancel.reason, kv, nc, serviceId, loadEntries);
    } catch (err) {
      // The cancel itself is already recorded and announced; a failed
      // enumeration loses only this pass of the stranded check.
      console.error(`[task-manager] stranded-delegate check failed for ${taskId}:`, err);
    }
  }

  console.log(`[task-manager] task ${taskId}: ${newState}`);
}

/** An origin as the broadcast lifecycle event carries it: no request ids
 *  beyond the origin's own. */
function broadcastOrigin(origin: TaskOrigin): TaskOrigin {
  const {
    contested_by: _c,
    contested_overflow: _o,
    contested_overflow_since: _s,
    multiple_requests: _m,
    ...rest
  } = origin as TaskOrigin & { multiple_requests?: string[] };
  return rest;
}

/** The ledger's binding for these parties, or null (also on a read failure:
 *  an origin nobody could read is an origin not observed, never a guess). */
async function lookupOrigin(
  origins: OriginLedger,
  requester: string | undefined,
  responder: string | undefined,
  taskId: string,
): Promise<TaskOrigin | null> {
  if (!requester || !responder) return null;
  try {
    return await origins.originFor(requester, responder, taskId);
  } catch (err) {
    console.warn(`[task-manager] could not read the origin of task ${taskId}:`, err);
    return null;
  }
}

/** A request first seen well after the Task existed did not create it. */
function createdLongBefore(createdAt: string | undefined, observedAt: string): boolean {
  const created = Date.parse(createdAt ?? "");
  const seen = Date.parse(observedAt);
  return Number.isFinite(created) && Number.isFinite(seen) && seen - created > ORIGIN_SKEW_MS;
}

/**
 * Who asked for this cancellation, as this service observed it.
 *
 * `party` is the signer of the canceled update against the record: the
 * responder whenever the responder signed it, whatever `reason` it gives (a
 * responder that also named itself requester is still the responder).
 *
 * `requester_request` is the cancel the server observed from the ORIGINAL
 * requester, the origin's, before this transition: this update itself when the
 * original requester signed it, else the first `task.cancel` request it sent
 * the responder about this Task. Without an origin there is no original
 * requester the server can vouch for, and it is null.
 */
async function canceledBy(
  task: TaskRecord,
  env: Envelope,
  taskId: string,
  origins: OriginLedger | undefined,
): Promise<TaskCanceledBy> {
  const now = new Date().toISOString();
  const party: TaskCanceledBy["party"] = env.from === task.responder ? "responder" : "requester";
  let requesterRequest: TaskCanceledBy["requester_request"] = null;
  const origin = task.origin;
  if (origin && env.from === origin.requester && env.from !== origin.responder) {
    requesterRequest = { request_id: env.id, observed_at: now, via: "update" };
  } else if (origin && origins) {
    try {
      const seen = await origins.cancelRequest(taskId, origin.requester, origin.responder);
      if (seen) requesterRequest = { request_id: seen.request_id, observed_at: seen.observed_at, via: "cancel_request" };
    } catch (err) {
      console.warn(`[task-manager] could not read the cancel requests of task ${taskId}:`, err);
    }
  }
  return { party, requester_request: requesterRequest, at: now };
}

/**
 * §10.8 "stranded delegates": having just recorded `canceled` on a task that
 * belongs to a context, find every record that (a) is non-terminal, (b) shares
 * the canceled task's `context_id`, (c) was requested BY the canceled task's
 * responder — the delegation chain: the canceled task's performer requested
 * them — and (d) is not the canceled task itself. Each is flagged
 * (`stranded: true`, a flag, NOT a lifecycle state — the child stays wherever
 * it is in §7.2), persisted, and announced once on `mesh.event.task.stranded`
 * with this service's signature, so a performer that habitually strands its
 * delegates is one an operator can see.
 */
async function flagStrandedDelegates(
  canceled: TaskRecord,
  reason: CancelReason,
  kv: KeyedStore,
  nc: Messaging,
  serviceId: ServiceIdentity,
  loadEntries: LoadTaskEntries,
): Promise<void> {
  const entries = await loadEntries();

  for (const [key, entry] of entries) {
    let child: TaskRecord;
    try {
      child = entry.json<TaskRecord>();
    } catch {
      // Same shape as the overdue sweep: a record this service cannot parse
      // is skipped loudly, never allowed to abort the pass.
      console.warn(`[task-manager] stranded check: unparseable task record '${key}', skipped`);
      continue;
    }

    if (child.id === canceled.id) continue; // the canceled task itself
    if (TERMINAL_STATES.has(child.state)) continue; // finished — nothing stranded
    if (child.context_id !== canceled.context_id) continue; // a different conversation
    if (child.requester !== canceled.responder) continue; // not the delegation chain

    // Written against the record as stored now (task-write.ts), not the
    // snapshot copy, so an update or an attached origin since the snapshot is
    // kept, and a child that finished meanwhile is left alone.
    const now = new Date().toISOString();
    const written = await rewriteTask<TaskRecord>(kv, key, (current) => {
      if (TERMINAL_STATES.has(current.state)) return false;
      current.stranded = true;
      current.stranded_at = now;
      current.updated_at = now;
      return true;
    });
    if (!written) continue;
    child = written;

    const ev = createEnvelope({
      type: "emit",
      from: idOf(serviceId),
      payload: {
        domain: "task",
        event_type: "stranded",
        data: {
          task_id: child.id,
          context_id: canceled.context_id,
          canceled_task_id: canceled.id,
          requester: child.requester,
          responder: child.responder,
          cancel_reason: reason,
        },
      },
    });
    nc.publish(Subjects.event("task.stranded"), sealEnvelope(ev, serviceId));
    console.log(
      `[task-manager] task ${child.id}: stranded by cancel of ${canceled.id} (${reason})`,
    );
  }
}

/**
 * §7.7 "Revisions": either PARTY to a Task may send a budget revision as a
 * task update carrying only the `budget` block. Revisions are absolute, never
 * deltas — the accepted block replaces the stored one entirely, and only the
 * latest revision is stored, so a lost or reordered revision cannot corrupt
 * anyone's arithmetic.
 *
 * The block arrives here already validated (the door check in
 * `handleTaskUpdate`). What is enforced, in order:
 *
 *   1. The task exists. A revision revises a live budget; there is nothing to
 *      revise otherwise. (Log-and-drop, like every other reference to a task
 *      this service has no record of.)
 *   2. Parties only (`UNAUTHORIZED`) — the same `isPartyToTask` gate as state
 *      transitions, checked BEFORE anything that could emit a signed event,
 *      for the same reason (see task-parties.ts: refusals of strangers are
 *      logged, never published, so a stranger cannot drive signed platform
 *      traffic about a task it has no part in).
 *   3. Not in a terminal state (`TASK_INVALID_TRANSITION`) — a finished task's
 *      budget is a record, not a live constraint.
 *   4. Strictly increasing `revision` — the highest revision is the whole
 *      truth, so a stale or duplicate counter is refused, not merged.
 *   5. No retroactive violation (`TASK_INVALID_TRANSITION`): a revision whose
 *      deadline is already past (task manager's clock, §22.3 skew, second
 *      granularity), or whose ceiling is already below the responder's
 *      reported spend, would render the present moment over budget the instant
 *      it was accepted. A revision constrains only the future.
 *
 * A PARTY's refused revision emits one signed `mesh.event.task.budget_rejected`
 * carrying the §12.2 code — the same shape as `task.invalid_transition`, and
 * the only reply channel a fire-and-forget subject has. An accepted revision
 * is persisted and rebroadcast to the counterparty as a normal task update
 * (this service's signature, the whole new block), so the party that did NOT
 * send it learns the terms it is now working under.
 */
async function handleBudgetRevision(
  taskId: string,
  env: Envelope,
  revision: Budget,
  kv: KeyedStore,
  nc: Messaging,
  serviceId: ServiceIdentity,
): Promise<void> {
  const entry = await kv.get(taskId);
  if (!entry) {
    console.warn(`[task-manager] budget revision for unknown task: ${taskId}`);
    return;
  }
  const task = entry.json<BudgetTask>();

  if (!isPartyToTask(task, env.from)) {
    reportRefusal(
      `budget revision ${revision.revision} on task ${taskId}`,
      env.from,
      `it is neither the requester (${String(task.requester ?? "none").slice(0, 12)}…) nor ` +
        `the responder (${String(task.responder ?? "none").slice(0, 12)}…) of this task (UNAUTHORIZED).`,
    );
    return;
  }

  const reject = (reason: string): void => {
    console.warn(
      `[task-manager] rejected budget revision ${revision.revision} on task ${taskId}: ${reason}`,
    );
    const errEnv = createEnvelope({
      type: "emit",
      from: idOf(serviceId),
      payload: {
        domain: "task",
        event_type: "budget_rejected",
        data: {
          task_id: taskId,
          code: "TASK_INVALID_TRANSITION",
          reason,
          revision: revision.revision,
          agent: env.from,
        },
      },
    });
    nc.publish(Subjects.event("task.budget_rejected"), sealEnvelope(errEnv, serviceId));
  };

  if (TERMINAL_STATES.has(task.state)) {
    return reject(`task is ${task.state} (terminal) — a finished task's budget cannot be revised`);
  }

  // Strictly greater than the stored revision. A task with no stored budget
  // has nothing to compare against: §7.7's absolute semantics make accepting
  // the block safe (it IS the whole truth), and refusing would leave a task
  // whose creating update lost its budget un-budgetable forever.
  const stored = task.budget?.revision;
  if (stored !== undefined && revision.revision <= stored) {
    return reject(
      `revision ${revision.revision} is not greater than the stored revision ${stored} — ` +
        `the highest revision is the whole truth (§7.7)`,
    );
  }

  // No retroactive violation: a revision constrains only the future.
  if (revision.deadline && deadlinePassed(revision.deadline)) {
    return reject(`its deadline ${revision.deadline} is already past`);
  }
  if (
    revision.cost_ceiling &&
    task.reported_spend &&
    revision.cost_ceiling.currency === task.reported_spend.currency &&
    revision.cost_ceiling.amount_micro < task.reported_spend.amount_micro
  ) {
    return reject(
      `its ceiling ${revision.cost_ceiling.amount_micro} is below the responder's ` +
        `reported spend ${task.reported_spend.amount_micro} ${task.reported_spend.currency}`,
    );
  }

  // Accepted: the new block replaces the old ENTIRELY (absolute semantics —
  // an axis absent from the revision is gone, not carried over).
  task.budget = revision;
  task.updated_at = new Date().toISOString();
  appendHistory(task, env);
  await persist(kv, taskId, task, entry);

  // Rebroadcast to the counterparty as a normal task update: same subject its
  // existing subscription already watches, this service's signature, the whole
  // accepted block and nothing else. The loop back into our own queue-group
  // subscription is dropped by the own-key guard at the top of
  // `handleTaskUpdate`.
  const counterparty = env.from === task.requester ? task.responder : task.requester;
  const rebroadcast = createEnvelope({
    type: "respond",
    from: idOf(serviceId),
    to: counterparty,
    task_id: taskId,
  }) as BudgetEnvelope;
  rebroadcast.budget = revision;
  nc.publish(Subjects.taskUpdate(taskId), sealEnvelope(rebroadcast, serviceId));

  console.log(
    `[task-manager] task ${taskId}: budget revised to revision ${revision.revision} by ` +
      `${env.from === task.requester ? "requester" : "responder"}`,
  );
}
