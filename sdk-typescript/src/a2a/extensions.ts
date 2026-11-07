/**
 * The A2A extensions of the binding (bindings/a2a.md §12).
 *
 * Each is an A2A extension (A2A §4.6): an agent lists the ones it supports in
 * its card's `capabilities.extensions` with `required: false`, a client
 * activates one in the `A2A-Extensions` service parameter (§7), and its data
 * sits in the `metadata` of the object it describes, under its URI. Pure
 * helpers; each returns a new object and never edits its input.
 */
import type { Budget } from "../types/envelope.js";
import type { AgentExtension, Message, Part, Task, TaskState } from "./types.js";

export const EXT_OFFERING = "https://agentmessaging.ai/extensions/offering/v1";
export const EXT_BUDGET = "https://agentmessaging.ai/extensions/budget/v1";
export const EXT_AUDIENCE = "https://agentmessaging.ai/extensions/audience/v1";
export const EXT_ECONOMICS = "https://agentmessaging.ai/extensions/economics/v1";
export const EXT_ARTIFACT_REFS = "https://agentmessaging.ai/extensions/artifact-refs/v1";
export const EXT_CANCEL = "https://agentmessaging.ai/extensions/cancel/v1";
export const EXT_FAILURE = "https://agentmessaging.ai/extensions/failure/v1";

export const BINDING_EXTENSIONS = [EXT_OFFERING, EXT_BUDGET, EXT_AUDIENCE, EXT_ECONOMICS, EXT_ARTIFACT_REFS, EXT_CANCEL, EXT_FAILURE] as const;

const DESCRIPTIONS: Record<string, string> = {
  [EXT_OFFERING]: "Which declared offering a message calls (Agent Messaging §8.5).",
  [EXT_BUDGET]: "A budget, and why a Task ended at its cap (Agent Messaging §7.7).",
  [EXT_AUDIENCE]: "A message meant for the person behind the agent (Agent Messaging §5.7).",
  [EXT_ECONOMICS]: "Payment required, with the price and how to pay (Agent Messaging §19).",
  [EXT_ARTIFACT_REFS]: "A large Part's size and digest (Agent Messaging §7.5.1).",
  [EXT_CANCEL]: "Why a Task was canceled (Agent Messaging §10.8).",
  [EXT_FAILURE]: "Why a Task failed (Agent Messaging §10.8, §10.8a).",
};

/** The card's `capabilities.extensions` entries for the extensions given
 *  (all five by default), each `required: false` (§12). */
export function cardExtensions(uris: readonly string[] = BINDING_EXTENSIONS): AgentExtension[] {
  return uris.map((uri) => ({ uri, ...(DESCRIPTIONS[uri] ? { description: DESCRIPTIONS[uri] } : {}), required: false }));
}

type WithMetadata = { metadata?: Record<string, unknown> };

/** An extension's data on an object, or undefined. */
export function extensionData<T = Record<string, unknown>>(obj: WithMetadata | undefined, uri: string): T | undefined {
  const v = obj?.metadata?.[uri];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : undefined;
}

/** A copy of the object with an extension's data set under its URI. */
export function withExtensionData<O extends WithMetadata>(obj: O, uri: string, data: Record<string, unknown>): O {
  return { ...obj, metadata: { ...(obj.metadata ?? {}), [uri]: data } };
}

/** A copy of a Message that lists the extension in its `extensions`. */
function usesExtension(m: Message, uri: string): Message {
  const list = m.extensions ?? [];
  return list.includes(uri) ? m : { ...m, extensions: [...list, uri] };
}

// ─── §12.1 Offering ─────────────────────────────────────────────────

export function withOffering(message: Message, offering: string): Message {
  return usesExtension(withExtensionData(message, EXT_OFFERING, { offering }), EXT_OFFERING);
}

export function offeringOf(message: Message | undefined): string | undefined {
  const o = extensionData<{ offering?: unknown }>(message, EXT_OFFERING)?.offering;
  return typeof o === "string" && o ? o : undefined;
}

// ─── §12.2 Budget ───────────────────────────────────────────────────

/** The budget extension's data (camelCase on the A2A side). */
export interface A2ABudget {
  deadline?: string;
  revision: number;
  costCeiling?: { amountMicro: number; currency: string };
}

export function budgetToA2A(b: Budget): A2ABudget {
  return {
    ...(b.deadline !== undefined ? { deadline: b.deadline } : {}),
    revision: b.revision,
    ...(b.cost_ceiling ? { costCeiling: { amountMicro: b.cost_ceiling.amount_micro, currency: b.cost_ceiling.currency } } : {}),
  };
}

export function budgetFromA2A(b: A2ABudget): Budget {
  return {
    ...(b.deadline !== undefined ? { deadline: b.deadline } : {}),
    revision: b.revision,
    ...(b.costCeiling ? { cost_ceiling: { amount_micro: b.costCeiling.amountMicro, currency: b.costCeiling.currency } } : {}),
  };
}

/** A Message that starts or revises work under a budget. */
export function withBudget(message: Message, budget: Budget | A2ABudget): Message {
  const data = "cost_ceiling" in budget || !("costCeiling" in budget) ? budgetToA2A(budget as Budget) : (budget as A2ABudget);
  return usesExtension(withExtensionData(message, EXT_BUDGET, data as unknown as Record<string, unknown>), EXT_BUDGET);
}

/** The budget a Message carries, in the SDK's own shape, or undefined when it
 *  carries none or one that is not well formed (revision a non-negative
 *  integer, at least one of the two axes). */
export function budgetOf(message: Message | undefined): Budget | undefined {
  const d = extensionData<Partial<A2ABudget>>(message, EXT_BUDGET);
  if (!d || typeof d.revision !== "number" || !Number.isInteger(d.revision) || d.revision < 0) return undefined;
  if (d.deadline === undefined && d.costCeiling === undefined) return undefined;
  return budgetFromA2A(d as A2ABudget);
}

function statusMessage(text: string, task: Task): Message {
  return {
    messageId: `status-${task.id}-${Date.now().toString(36)}`,
    role: "ROLE_AGENT",
    parts: [{ text }],
    taskId: task.id,
    ...(task.contextId ? { contextId: task.contextId } : {}),
  };
}

function ended(task: Task, state: TaskState, text: string, data: Record<string, unknown>, uri: string): Task {
  const next = withExtensionData(task, uri, data);
  return {
    ...next,
    status: { state, message: statusMessage(text, task), timestamp: new Date().toISOString() },
  };
}

/**
 * §12.2: the engagement's not-to-exceed cap ended the work. The Task ends in
 * `TASK_STATE_CANCELED` with `{"outcome": "exhausted"}` under the budget URI
 * and a status message saying so. Artifacts already attached stay. A client
 * that knows the extension never records it as failed and never retries it.
 */
export function exhaustedTask(task: Task, text = "The engagement's not-to-exceed cap was reached; the work stopped there."): Task {
  return ended(task, "TASK_STATE_CANCELED", text, { outcome: "exhausted" }, EXT_BUDGET);
}

/** Did this Task end at its budget's cap (§12.2)? */
export function isExhausted(task: Task | undefined): boolean {
  return task?.status?.state === "TASK_STATE_CANCELED" && extensionData<{ outcome?: unknown }>(task, EXT_BUDGET)?.outcome === "exhausted";
}

/** A money amount on the A2A side of the budget extension. */
export interface A2AAmount {
  amountMicro: number;
  currency: string;
}

/** §12.2: the work does not fit the cost ceiling, refused at admission.
 *  `TASK_STATE_REJECTED` with `{"outcome": "insufficient", "estimate"}`. */
export function insufficientBudgetTask(task: Task, estimate: A2AAmount | Record<string, unknown>, text = "The work does not fit the budget."): Task {
  return ended(task, "TASK_STATE_REJECTED", text, { outcome: "insufficient", estimate }, EXT_BUDGET);
}

/** §12.2: the deadline cannot be met, refused at admission.
 *  `TASK_STATE_REJECTED` with `{"outcome": "deadline_unmeetable", "earliestCompletion"}`. */
export function deadlineUnmeetableTask(task: Task, earliestCompletion: string, text = "The deadline cannot be met."): Task {
  return ended(task, "TASK_STATE_REJECTED", text, { outcome: "deadline_unmeetable", earliestCompletion }, EXT_BUDGET);
}

/**
 * §12.2: the work reached its cost ceiling and paused for more money.
 * `TASK_STATE_INPUT_REQUIRED` with `{"outcome": "ceiling_reached", "spent",
 * "estimateToFinish"}`. The Task resumes on a Message whose budget `revision`
 * is higher than any before it, or ends on a cancel with the reason
 * `budget_exhausted` (§12.6).
 */
export function ceilingReachedTask(
  task: Task,
  spent: A2AAmount | Record<string, unknown>,
  estimateToFinish: A2AAmount | Record<string, unknown>,
  text = "The work reached its cost ceiling. Raise the budget to go on, or cancel.",
): Task {
  return ended(task, "TASK_STATE_INPUT_REQUIRED", text, { outcome: "ceiling_reached", spent, estimateToFinish }, EXT_BUDGET);
}

/** §12.2: the work completed after the deadline. `TASK_STATE_COMPLETED` with
 *  `{"outcome": "completed_late"}`, a marker and not a failure. */
export function completedLateTask(task: Task, text = "Completed after the deadline."): Task {
  return ended(task, "TASK_STATE_COMPLETED", text, { outcome: "completed_late" }, EXT_BUDGET);
}

/** §12.2: the overdue mark, on the status update event that reports the
 *  deadline passed while the work goes on: `{"overdue": true}`. */
export const OVERDUE_METADATA = { [EXT_BUDGET]: { overdue: true } } as const;

/** Does this status update (or Task) carry the overdue mark? */
export function isOverdue(obj: { metadata?: Record<string, unknown> } | undefined): boolean {
  return extensionData<{ overdue?: unknown }>(obj, EXT_BUDGET)?.overdue === true;
}

/** The budget outcomes of §12.2 that put a Task in a state. */
export type BudgetOutcome = "insufficient" | "deadline_unmeetable" | "ceiling_reached" | "exhausted" | "completed_late";

/** The budget outcome on a Task (§12.2), with the fields it carries. */
export function budgetOutcomeOf(task: Task | undefined): ({ outcome: string } & Record<string, unknown>) | undefined {
  const d = extensionData<Record<string, unknown>>(task, EXT_BUDGET);
  if (!d || typeof d.outcome !== "string") return undefined;
  return { ...d, outcome: d.outcome };
}

/** Is this Task paused at its cost ceiling, waiting for a higher budget? */
export function isCeilingReached(task: Task | undefined): boolean {
  return task?.status?.state === "TASK_STATE_INPUT_REQUIRED" && budgetOutcomeOf(task)?.outcome === "ceiling_reached";
}

/** The highest budget `revision` among the client's messages in a Task's
 *  history, or -1 when none carried a budget. A paused Task resumes only on a
 *  revision above it (§12.2). */
export function highestBudgetRevision(task: Task | undefined): number {
  let best = -1;
  for (const m of task?.history ?? []) {
    if (m.role !== "ROLE_USER") continue;
    const b = budgetOf(m);
    if (b && b.revision > best) best = b.revision;
  }
  return best;
}

// ─── §12.6 Cancel reasons ───────────────────────────────────────────

/** The closed list of SPEC.md §10.8. */
export const A2A_CANCEL_REASONS = [
  "user_requested",
  "superseded",
  "deadline_exceeded",
  "budget_exhausted",
  "upstream_cancelled",
  "policy",
  "needs_not_furnished",
  "dependency_failed",
] as const;

export type A2ACancelReason = (typeof A2A_CANCEL_REASONS)[number];

/** The cancel extension's data: the reason, an optional note, and the fields
 *  §10.8 requires for a reason (`unmetNeed` with `needs_not_furnished`,
 *  `dependency` with `dependency_failed`). */
export interface A2ACancel {
  reason: A2ACancelReason;
  note?: string;
  unmetNeed?: string;
  dependency?: string;
}

/** A CancelTask request's metadata with a reason under the cancel URI. */
export function withCancelReason<O extends { metadata?: Record<string, unknown> }>(obj: O, cancel: A2ACancel): O {
  return withExtensionData(obj, EXT_CANCEL, cancel as unknown as Record<string, unknown>);
}

/** §12.7: why a Task failed. The reason is one of §10.8's, with `unmetNeed`
 *  for needs_not_furnished and `dependency` for dependency_failed. */
export interface A2AFailure {
  reason: A2ACancelReason;
  unmetNeed?: string;
  dependency?: string;
}

/** The failure reason on a failed Task (§12.7), if it states one. */
export function failureReasonOf(task: { metadata?: Record<string, unknown> } | undefined): A2AFailure | undefined {
  const d = extensionData<Record<string, unknown>>(task, EXT_FAILURE);
  return d && typeof d.reason === "string" ? (d as unknown as A2AFailure) : undefined;
}

/** The cancel reason on a CancelTask request or a canceled Task (§12.6). */
export function cancelReasonOf(obj: { metadata?: Record<string, unknown> } | undefined): A2ACancel | undefined {
  const d = extensionData<Record<string, unknown>>(obj, EXT_CANCEL);
  return d && typeof d.reason === "string" ? (d as unknown as A2ACancel) : undefined;
}

// ─── §12.3 Audience ─────────────────────────────────────────────────

/** A Message meant for the person behind the receiving agent. */
export function forPerson(message: Message): Message {
  return usesExtension(withExtensionData(message, EXT_AUDIENCE, { audience: "person" }), EXT_AUDIENCE);
}

export function isForPerson(message: Message | undefined): boolean {
  return extensionData<{ audience?: unknown }>(message, EXT_AUDIENCE)?.audience === "person";
}

// ─── §12.4 Economics ────────────────────────────────────────────────

export interface PaymentRequired {
  price: Record<string, unknown>;
  accepted: unknown[];
}

/** §12.4: payment is required before the work. `TASK_STATE_REJECTED` with
 *  `{"paymentRequired": {price, accepted}}` under the economics URI. */
export function paymentRequiredTask(task: Task, payment: PaymentRequired, text = "Payment is required before this work."): Task {
  return ended(task, "TASK_STATE_REJECTED", text, { paymentRequired: payment }, EXT_ECONOMICS);
}

export function paymentRequiredOf(task: Task | undefined): PaymentRequired | undefined {
  const p = extensionData<{ paymentRequired?: unknown }>(task, EXT_ECONOMICS)?.paymentRequired;
  if (!p || typeof p !== "object") return undefined;
  const o = p as Record<string, unknown>;
  return {
    price: (o.price && typeof o.price === "object" ? o.price : {}) as Record<string, unknown>,
    accepted: Array.isArray(o.accepted) ? o.accepted : [],
  };
}

// ─── §12.5 Artifact references ──────────────────────────────────────

/** A `url` Part whose bytes are held outside the message, with their size
 *  and digest under the artifact-refs URI. The reference is any URI its
 *  carrier defines: an Agent Messaging artifact reference on a mesh, a `cid:`
 *  attachment by email, an `https:` URL. Takes the SDK's `putArtifact` result
 *  directly. */
export function artifactRefPart(ref: {
  ref: string;
  size: number;
  digest?: string;
  media_type?: string;
  mediaType?: string;
  name?: string;
  filename?: string;
}): Part {
  const mediaType = ref.mediaType ?? ref.media_type;
  const filename = ref.filename ?? ref.name;
  return {
    url: ref.ref,
    ...(mediaType ? { mediaType } : {}),
    ...(filename ? { filename } : {}),
    metadata: { [EXT_ARTIFACT_REFS]: { size: ref.size, ...(ref.digest ? { digest: ref.digest } : {}) } },
  };
}

/** The artifact reference a Part carries: its URI, size and digest, or
 *  undefined when the Part is not one. */
export function artifactRefOf(part: Part): { ref: string; size: number; digest?: string; mediaType?: string; filename?: string } | undefined {
  if (typeof part.url !== "string") return undefined;
  const d = extensionData<{ size?: unknown; digest?: unknown }>(part, EXT_ARTIFACT_REFS);
  if (!d || typeof d.size !== "number") return undefined;
  return {
    ref: part.url,
    size: d.size,
    ...(typeof d.digest === "string" ? { digest: d.digest } : {}),
    ...(part.mediaType ? { mediaType: part.mediaType } : {}),
    ...(part.filename ? { filename: part.filename } : {}),
  };
}
