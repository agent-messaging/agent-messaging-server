/**
 * What an A2A Task (wire 0.4.0, a2a-store.ts) gives the platform, the same as
 * a 0.3.0 Task gives it (handlers/task-update.ts): the record's own fields
 * beside the Task (SPEC.md §7.1), the signed lifecycle event
 * `mesh.event.task.<state>`, the §19.2 metering receipts and the §13.5
 * terminal meter events, and the stranded-delegates flag of §10.8.
 *
 * Every field and event a 0.3.0 Task produces is produced here with the same
 * name and shape, so a consumer reads both wires with the code it has. What
 * differs is only where each fact is read from:
 *
 *   - the state: the Task's A2A state in the 0.3.0 spelling (SPEC.md §6.8),
 *     a canceled Task with the budget extension's `exhausted` outcome being
 *     `exhausted` (shared/a2a-frames.ts `wire030State`);
 *   - the cancel reason: the cancel extension on the canceled Task's
 *     `metadata` (§12.6), else on the CancelTask request the task manager
 *     saw, else `user_requested`, as §12.6 records a cancel without one; an
 *     exhausted Task carries the cancel fields too (its event, its record
 *     and who canceled it), with only a reason it states, and gets no
 *     canceled receipt, as on 0.3.0;
 *   - the failure reason, `unmet_need` and `dependency`: the failure
 *     extension on the failed Task (§12.7), camelCase there, snake_case here;
 *   - the attribution of §10.8a: computed by the platform against the
 *     responder's declared needs, never read from the extension;
 *   - completed late: the budget extension's `completed_late` outcome, or a
 *     completion after the deadline of the budget the starting Message set,
 *     by this service's clock (§7.7);
 *   - the offering, trial work and the budget: the starting request
 *     (a2a-store.ts records them beside the Task);
 *   - the reported spend: `payload.cost` beside `payload.a2a` on the
 *     responder's frames (SPEC.md §13.5, §19.3).
 */
import { createHash } from "node:crypto";
import type { Envelope, TaskCanceledBy, TaskOrigin } from "../sdk.js";
import { createEnvelope, Subjects } from "../sdk.js";
import { checkInputProblem, type InputProblem } from "../../../sdk-typescript/src/problems.js";
import type { KeyedStore, Messaging } from "../storage/index.js";
import { idOf, sealEnvelope, type ServiceIdentity } from "../shared/handler.js";
import { observedTaskTerminal, publishMeterEvents } from "../shared/metering.js";
import { wire030State } from "../shared/a2a-frames.js";
import { attributionOf, type Attribution, type CancelReason, type DeclaredNeedsFn, type FailureFields } from "./cancel.js";
import { BudgetCode, deadlinePassed, type Budget, type CostCeiling } from "./budget.js";
import { broadcastOrigin, canceledBy } from "./handlers/task-update.js";
import type { OriginLedger } from "./origin.js";
import { rewriteTask } from "./task-write.js";
import {
  EXT_BUDGET,
  EXT_CANCEL,
  EXT_FAILURE,
  extensionData,
  isTerminalState,
  isValidCancelObject,
  isValidFailureObject,
  type A2ACancel,
  type Message,
  type Part,
  type Task,
} from "../../../sdk-typescript/src/a2a/index.js";

/** The platform's fields beside an A2A Task (SPEC.md §7.1). Written by the
 *  task manager only, never taken from a party. */
export interface A2APlatformFields {
  /** The offering the call was for: the one the starting Message named, else
   *  the agent's one declared offering (§12.1), else "". */
  offering?: string;
  /** Common Agent §7.7: the starting Message asked for trial work (§12.8). */
  trial?: boolean;
  /** The budget the starting Message set, in the 0.3.0 shape the receipts
   *  carry, raised by a later revision from the requester (§7.7). */
  budget?: Budget;
  /** The responder's latest reported spend (§19.3). */
  reported_spend?: CostCeiling;
  origin?: TaskOrigin;
  canceled_by?: TaskCanceledBy;
  cancel_reason?: CancelReason;
  failure_reason?: CancelReason;
  unmet_need?: string;
  dependency?: string;
  attribution?: Attribution;
  unmet_need_declared?: boolean;
  completed_late?: boolean;
  /** SPEC.md §7.7: the deadline passed while the Task was not finished, on
   *  this service's clock (overdue-sweep.ts). A mark, never a state. */
  overdue?: boolean;
  overdue_at?: string;
  stranded?: true;
  stranded_at?: string;
  /** The parts of the Message that created the Task, as the client sent
   *  them, so a reader need not dig them out of the Task's history (which
   *  the server agent writes). Large parts are kept as references. */
  inputs?: A2AInputs;
  /** While the Task waits in TASK_STATE_INPUT_REQUIRED: the problem reports
   *  of the latest pause, exactly as the server agent sent them (SPEC.md
   *  §6.5, a `{"problems": [...]}` data part in the status message). Gone
   *  once the Task moves on. */
  waiting_on?: InputProblem[];
  /** The signed frames that changed the Task, for audit (§7.1), newest last,
   *  at most MAX_FRAMES. */
  frames?: Envelope[];
}

export const MAX_FRAMES = 50;

/** A part of the creating Message too large to keep whole: what it was, how
 *  big, and the SHA-256 of its bytes (the decoded bytes of a `raw` part, the
 *  UTF-8 of a `text` or `url` part, the JSON of a `data` part). */
export interface A2AInputRef {
  omitted: true;
  kind: "text" | "raw" | "url" | "data";
  size: number;
  digest: string;
  mediaType?: string;
  filename?: string;
}

/** The creating Message's parts, kept beside the Task. */
export interface A2AInputs {
  message_id: string;
  parts: Array<Part | A2AInputRef>;
  /** Parts past the count kept, not listed. */
  parts_omitted?: number;
}

/** How much of the creating Message is kept whole, in bytes of JSON; parts
 *  past it are kept as references. */
export const INPUTS_INLINE_MAX = 16 * 1024;
/** How many parts are listed at most. */
export const INPUTS_PARTS_MAX = 64;

function inputRef(part: Part): A2AInputRef {
  let kind: A2AInputRef["kind"];
  let bytes: Uint8Array;
  if (typeof part.raw === "string") {
    kind = "raw";
    bytes = Buffer.from(part.raw, "base64");
  } else if (typeof part.text === "string") {
    kind = "text";
    bytes = Buffer.from(part.text, "utf8");
  } else if (typeof part.url === "string") {
    kind = "url";
    bytes = Buffer.from(part.url, "utf8");
  } else {
    kind = "data";
    bytes = Buffer.from(JSON.stringify(part.data ?? null), "utf8");
  }
  return {
    omitted: true,
    kind,
    size: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    ...(typeof part.mediaType === "string" ? { mediaType: part.mediaType } : {}),
    ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
  };
}

/** What the record keeps of a creating Message: its parts in order, whole
 *  while they fit INPUTS_INLINE_MAX, each one past it as a reference, at most
 *  INPUTS_PARTS_MAX of them. Undefined for a Message with no id or parts. */
export function inputsOf(message: Message | undefined): A2AInputs | undefined {
  if (!message || typeof message.messageId !== "string" || !Array.isArray(message.parts)) return undefined;
  let room = INPUTS_INLINE_MAX;
  const parts: A2AInputs["parts"] = [];
  for (const part of message.parts.slice(0, INPUTS_PARTS_MAX)) {
    if (!part || typeof part !== "object") continue;
    const size = Buffer.byteLength(JSON.stringify(part), "utf8");
    if (size <= room) {
      parts.push(part);
      room -= size;
    } else {
      parts.push(inputRef(part));
    }
  }
  const omitted = Math.max(0, message.parts.length - INPUTS_PARTS_MAX);
  return { message_id: message.messageId, parts, ...(omitted ? { parts_omitted: omitted } : {}) };
}

/** The problem reports a status message carries (SPEC.md §6.5): the
 *  well-formed entries of its `{"problems": [...]}` data part, as sent. A
 *  malformed entry is dropped, never repaired. */
export function problemsOf(task: Task): InputProblem[] {
  for (const part of task.status?.message?.parts ?? []) {
    const list = (part?.data as { problems?: unknown } | undefined)?.problems;
    if (!Array.isArray(list)) continue;
    const ok = list.filter((p): p is InputProblem => checkInputProblem(p).length === 0);
    if (ok.length) return ok;
  }
  return [];
}

/**
 * Keep `waiting_on` with the Task's state (mutates `record`): the problem
 * reports of the latest pause while it waits in TASK_STATE_INPUT_REQUIRED, and
 * nothing once it moves on. A pause entered without reports has none; a later
 * status update in the same pause that carries reports replaces them.
 */
export function applyWaitingOn(record: A2ARecordLike, prevState: string | null): void {
  if (record.task.status?.state !== "TASK_STATE_INPUT_REQUIRED") {
    delete record.waiting_on;
    return;
  }
  const problems = problemsOf(record.task);
  if (problems.length) record.waiting_on = problems;
  else if (prevState !== "input_required") delete record.waiting_on;
}

/** The record as these functions read it. */
export interface A2ARecordLike extends A2APlatformFields {
  task: Task;
  requester: string;
  responder: string;
  created_at: string;
  updated_at: string;
}

/** What the outputs need. Absent `nc` or `kp`: nothing is published. */
export interface A2AOutputDeps {
  nc?: Messaging;
  kp?: ServiceIdentity;
  declaredNeeds?: DeclaredNeedsFn;
  origins?: OriginLedger;
}

const ATTRIBUTION_KEY = "attribution";

/**
 * Why the store must not apply this Task (SPEC.md §10.8): a failed Task whose
 * failure object names a reason outside the list or a malformed `unmetNeed`,
 * or a canceled Task whose cancel object does. A 0.3.0 update so shaped is
 * refused at the door; an A2A change so shaped is not applied. An
 * `attribution` in the failure object is ignored, never refused (§10.8a).
 * Null when the Task is fine.
 */
export function stopObjectRefusal(task: Task): string | null {
  const state = task.status?.state;
  if (state === "TASK_STATE_FAILED") {
    const raw = extensionData<Record<string, unknown>>(task, EXT_FAILURE);
    if (raw === undefined) return null;
    const { [ATTRIBUTION_KEY]: _ignored, ...failure } = raw;
    return isValidFailureObject("TASK_STATE_FAILED", failure) ? null : "its failure reason is outside the list of §10.8, or its unmetNeed is missing or malformed";
  }
  if (state === "TASK_STATE_CANCELED") {
    const cancel = extensionData<Record<string, unknown>>(task, EXT_CANCEL);
    if (cancel === undefined) return null;
    return isValidCancelObject(cancel) ? null : "its cancel reason is outside the list of §10.8, or its unmetNeed is missing or malformed";
  }
  return null;
}

/** The failure a failed Task states (§12.7), in the record's spelling. */
function failureOf(task: Task): FailureFields | undefined {
  const raw = extensionData<Record<string, unknown>>(task, EXT_FAILURE);
  if (!raw || typeof raw.reason !== "string") return undefined;
  return {
    reason: raw.reason as CancelReason,
    ...(typeof raw.unmetNeed === "string" ? { unmet_need: raw.unmetNeed } : {}),
    ...(typeof raw.dependency === "string" ? { dependency: raw.dependency } : {}),
  };
}

/**
 * Write the fields a state brings onto `record` (mutated): the cancel or
 * failure fields and the attribution, who canceled, and completed late. Run
 * once, on the change that brings the Task to that state.
 *
 * `env` is the responder's frame that made the change; `seenCancel` the
 * CancelTask the task manager saw for this Task, if any.
 */
export async function applyStateFields(
  record: A2ARecordLike,
  state: string,
  env: Envelope,
  taskId: string,
  deps: A2AOutputDeps,
  seenCancel?: A2ACancel,
): Promise<void> {
  const task = record.task;
  // An exhausted Task is TASK_STATE_CANCELED with the budget extension's
  // `exhausted` outcome (SPEC.md §7.7), so it carries the cancel fields too.
  // Exhaustion is not a cancellation a party asked for, so its reason is only
  // the one the Task or a CancelTask states, never the `user_requested` a
  // bare cancel is recorded as.
  if (state === "canceled" || state === "exhausted") {
    const own = extensionData<Record<string, unknown>>(task, EXT_CANCEL);
    const stated = own && isValidCancelObject(own) ? own : seenCancel && isValidCancelObject(seenCancel) ? seenCancel : undefined;
    const cancel: A2ACancel | undefined = stated ?? (state === "canceled" ? { reason: "user_requested" } : undefined);
    if (cancel) {
      record.cancel_reason = cancel.reason;
      if (cancel.unmetNeed !== undefined) record.unmet_need = cancel.unmetNeed;
      if (cancel.dependency !== undefined) record.dependency = cancel.dependency;
    }
    record.canceled_by = await canceledBy(record as never, env, taskId, deps.origins);
  }
  if (state === "failed") {
    const failure = failureOf(task) ?? {};
    if (failure.reason !== undefined) record.failure_reason = failure.reason;
    if (failure.unmet_need !== undefined) record.unmet_need = failure.unmet_need;
    if (failure.dependency !== undefined) record.dependency = failure.dependency;
    let declared: ReadonlySet<string> | null = null;
    if (failure.reason === "needs_not_furnished" && deps.declaredNeeds) {
      try {
        declared = await deps.declaredNeeds(record.responder, record.offering || undefined);
      } catch {
        declared = null; // could not check: the claim stays with the provider
      }
    }
    const a = attributionOf(failure, declared);
    record.attribution = a.attribution;
    if (a.unmet_need_declared !== undefined) record.unmet_need_declared = a.unmet_need_declared;
  }
  if (state === "completed") {
    const outcome = extensionData<{ outcome?: unknown }>(task, EXT_BUDGET)?.outcome;
    if (outcome === "completed_late" || (record.budget?.deadline && deadlinePassed(record.budget.deadline))) record.completed_late = true;
  }
}

function emit(deps: A2AOutputDeps, subject: string, domain: string, eventType: string, data: Record<string, unknown>): void {
  if (!deps.nc || !deps.kp) return;
  const env = createEnvelope({ type: "emit", from: idOf(deps.kp), payload: { domain, event_type: eventType, data } });
  deps.nc.publish(Subjects.event(subject), sealEnvelope(env, deps.kp));
}

/**
 * The signed lifecycle event for a state the Task entered, and on a terminal
 * state the receipts and meter events, exactly as handlers/task-update.ts
 * publishes them for a 0.3.0 Task. `env` is the terminal frame, the envelope
 * the terminal meter events derive from (§13.5).
 */
export function publishStateOutputs(record: A2ARecordLike, state: string, env: Envelope, deps: A2AOutputDeps): void {
  if (!deps.nc || !deps.kp) return;
  const taskId = record.task.id;
  const offering = record.offering ?? "";
  const failed = state === "failed";
  const stopped = state === "canceled" || state === "exhausted";
  emit(deps, `task.${state}`, "task", state, {
    task_id: taskId,
    state,
    requester: record.requester,
    responder: record.responder,
    offering,
    ...(record.origin ? { origin: broadcastOrigin(record.origin) } : {}),
    ...(state === "completed" && record.completed_late ? { completed_late: true, code: BudgetCode.DEADLINE_EXCEEDED } : {}),
    ...(stopped && record.cancel_reason ? { cancel_reason: record.cancel_reason } : {}),
    ...(stopped && record.canceled_by ? { canceled_by: record.canceled_by } : {}),
    ...(failed
      ? {
          ...(record.failure_reason ? { failure_reason: record.failure_reason } : {}),
          ...(record.unmet_need ? { unmet_need: record.unmet_need } : {}),
          ...(record.dependency ? { dependency: record.dependency } : {}),
          attribution: record.attribution ?? "provider",
          ...(record.unmet_need_declared !== undefined ? { unmet_need_declared: record.unmet_need_declared } : {}),
        }
      : {}),
  });

  const startedMs = Date.parse(record.created_at);
  const endedMs = Date.parse(record.updated_at);
  const durationMs = Math.max(0, (Number.isFinite(endedMs) ? endedMs : Date.now()) - (Number.isFinite(startedMs) ? startedMs : Date.now()));
  const contextId = record.task.contextId;
  const terminal = (completed: boolean, trial = false) => {
    const batch = observedTaskTerminal(record.responder, record.requester, env.id, taskId, durationMs, completed, offering || undefined);
    publishMeterEvents(deps.nc!, deps.kp!, trial ? { ...batch, events: batch.events.map((e) => ({ ...e, trial: true })) } : batch);
  };

  if (state === "completed" && !record.trial) {
    emit(deps, "metering.task_completed", "metering", "task_completed", {
      task_id: taskId,
      requester: record.requester,
      responder: record.responder,
      offering,
      ...(contextId ? { context_id: contextId } : {}),
      started_at: record.created_at,
      completed_at: record.updated_at,
      duration_ms: durationMs,
      ...(record.reported_spend ? { cost: record.reported_spend } : {}),
      ...(record.budget ? { budget: record.budget } : {}),
      completed_late: record.completed_late === true,
      status: "completed",
    });
    terminal(true);
  }
  if (record.trial && (state === "completed" || state === "failed" || state === "canceled")) {
    emit(deps, "metering.task_trial", "metering", "task_trial", {
      task_id: taskId,
      requester: record.requester,
      responder: record.responder,
      offering,
      ...(contextId ? { context_id: contextId } : {}),
      started_at: record.created_at,
      ended_at: record.updated_at,
      ended: state,
      duration_ms: durationMs,
      ...(record.reported_spend ? { cost: record.reported_spend } : {}),
      ...(state === "canceled" && record.cancel_reason ? { cancel_reason: record.cancel_reason } : {}),
      ...(state === "failed" && record.failure_reason ? { failure_reason: record.failure_reason } : {}),
      rated_micro: 0,
      status: "trial",
    });
    terminal(state === "completed", true);
  }
  if (state === "canceled" && !record.trial) {
    emit(deps, "metering.task_canceled", "metering", "task_canceled", {
      task_id: taskId,
      requester: record.requester,
      responder: record.responder,
      offering,
      ...(contextId ? { context_id: contextId } : {}),
      started_at: record.created_at,
      canceled_at: record.updated_at,
      duration_ms: durationMs,
      ...(record.reported_spend ? { cost: record.reported_spend } : {}),
      ...(record.budget ? { budget: record.budget } : {}),
      status: "canceled",
      cancel_reason: record.cancel_reason ?? "user_requested",
      ...(record.canceled_by ? { canceled_by: record.canceled_by } : {}),
    });
    terminal(false);
  }
}

/**
 * §10.8 stranded delegates, for an A2A Task just canceled: every A2A Task in
 * the same context that is not terminal and that the canceled Task's
 * responder requested is flagged `stranded: true` and announced on
 * `mesh.event.task.stranded`, as handlers/task-update.ts does for 0.3.0
 * Tasks.
 */
export async function flagStrandedA2A(canceled: A2ARecordLike, kv: KeyedStore, deps: A2AOutputDeps): Promise<void> {
  const contextId = canceled.task.contextId;
  if (!contextId || !canceled.cancel_reason) return;
  const entries = (await kv.list()).entries;
  for (const [key, entry] of entries) {
    let child: A2ARecordLike;
    try {
      child = entry.json<A2ARecordLike>();
    } catch {
      continue;
    }
    if (!child?.task || child.task.id === canceled.task.id) continue;
    if (isTerminalState(child.task.status?.state) || child.task.contextId !== contextId || child.requester !== canceled.responder) continue;
    const now = new Date().toISOString();
    const written = await rewriteTask<A2ARecordLike>(kv, key, (cur) => {
      if (isTerminalState(cur.task?.status?.state) || cur.stranded) return false;
      cur.stranded = true;
      cur.stranded_at = now;
      cur.updated_at = now;
      return true;
    });
    if (!written) continue;
    emit(deps, "task.stranded", "task", "stranded", {
      task_id: written.task.id,
      context_id: contextId,
      canceled_task_id: canceled.task.id,
      requester: written.requester,
      responder: written.responder,
      cancel_reason: canceled.cancel_reason,
    });
    console.log(`[task-manager] A2A task ${written.task.id}: stranded by cancel of ${canceled.task.id} (${canceled.cancel_reason})`);
  }
}

/** The state an A2A Task is in, as the lifecycle events spell it. */
export { wire030State };
