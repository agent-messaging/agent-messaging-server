/**
 * What a client reads from A2A objects under the binding's rules
 * (bindings/a2a.md §4, §8, §12, §14): the readings the conformance fixture
 * `conformance/a2a-binding.json` pins. Pure functions; the client, the server
 * agent's node and the gateway use them, and the conformance test checks each
 * against the fixture.
 */
import type { Envelope } from "../types/envelope.js";
import { MeshError, ErrorCode } from "../types/errors.js";
import { A2A_WIRE_VERSION, forbiddenFieldsRefusal, readRespondPayload } from "./binding.js";
import {
  A2A_CANCEL_REASONS,
  EXT_BUDGET,
  EXT_OFFERING,
  extensionData,
  isOverdue,
  type A2ABudget,
  type A2ACancel,
} from "./extensions.js";
import type { Task, TaskState } from "./types.js";

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Is this a well-formed budget block (§12.2, SPEC.md §7.7): only
 *  `deadline`, `revision` and `costCeiling`; a non-negative integer revision;
 *  at least one axis; an RFC 3339 deadline; integer micro-units and an ISO
 *  4217 code? */
export function isValidBudgetBlock(b: unknown): b is A2ABudget {
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  const o = b as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "deadline" && k !== "revision" && k !== "costCeiling")) return false;
  if (!Number.isInteger(o.revision) || (o.revision as number) < 0) return false;
  if (o.deadline === undefined && o.costCeiling === undefined) return false;
  if (o.deadline !== undefined && (typeof o.deadline !== "string" || !INSTANT.test(o.deadline))) return false;
  if (o.costCeiling !== undefined) {
    const c = o.costCeiling as Record<string, unknown> | null;
    if (!c || !Number.isInteger(c.amountMicro) || (c.amountMicro as number) < 0 || typeof c.currency !== "string" || !/^[A-Z]{3}$/.test(c.currency)) {
      return false;
    }
  }
  return true;
}

const OUTCOME_STATE: Record<string, TaskState> = {
  insufficient: "TASK_STATE_REJECTED",
  deadline_unmeetable: "TASK_STATE_REJECTED",
  ceiling_reached: "TASK_STATE_INPUT_REQUIRED",
  exhausted: "TASK_STATE_CANCELED",
  completed_late: "TASK_STATE_COMPLETED",
};
const OUTCOME_FIELDS: Record<string, string[]> = {
  insufficient: ["estimate"],
  deadline_unmeetable: ["earliestCompletion"],
  ceiling_reached: ["spent", "estimateToFinish"],
  exhausted: [],
  completed_late: [],
};

/**
 * What a client that knows the budget extension reads from a Task (§12.2):
 * the outcome when the Task is in the state that outcome names (with the
 * fields it carries), else the Task's own state. An exhausted Task is never
 * failed and never retried. During the transition window the older mark
 * `agentmesh.state: "exhausted"` (the A2A Bridge §5.2) on a canceled Task
 * reads as exhausted too.
 */
export function budgetReading(task: Task, opts: { window?: boolean } = {}): { reading: string; failed: boolean; may_retry: boolean } {
  const state = task.status.state;
  const b = extensionData<Record<string, unknown>>(task, EXT_BUDGET);
  const older = (opts.window ?? true) && state === "TASK_STATE_CANCELED" && task.metadata?.["agentmesh.state"] === "exhausted" && b === undefined;
  const out = older ? "exhausted" : typeof b?.outcome === "string" ? b.outcome : undefined;
  if (out !== undefined && OUTCOME_STATE[out] === state && (OUTCOME_FIELDS[out] ?? []).every((k) => b === undefined || k in b)) {
    return { reading: out, failed: false, may_retry: out !== "exhausted" };
  }
  return { reading: state.replace("TASK_STATE_", "").toLowerCase(), failed: state === "TASK_STATE_FAILED", may_retry: true };
}

/** The overdue reading of a status update (§12.2): the mark, the state
 *  unchanged, never a failure. */
export function overdueReading(ev: { statusUpdate?: { status: { state: TaskState }; metadata?: Record<string, unknown> } }): {
  overdue: boolean;
  state: TaskState | undefined;
  failed: false;
} {
  return { overdue: isOverdue(ev.statusUpdate), state: ev.statusUpdate?.status.state, failed: false };
}

const NEED_REF = /^(resource|file|credential|text):.+$/;

/** Is this a well-formed cancel object (§12.6, SPEC.md §10.8)? */
export function isValidCancelObject(o: unknown): o is A2ACancel {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const c = o as Record<string, unknown>;
  if (!(A2A_CANCEL_REASONS as readonly unknown[]).includes(c.reason)) return false;
  if (c.note !== undefined && typeof c.note !== "string") return false;
  if (c.reason === "needs_not_furnished" ? !(typeof c.unmetNeed === "string" && NEED_REF.test(c.unmetNeed)) : c.unmetNeed !== undefined) return false;
  if (c.reason !== "dependency_failed" && c.dependency !== undefined) return false;
  if (c.reason === "dependency_failed" && c.dependency !== undefined && typeof c.dependency !== "string") return false;
  return true;
}

/** Is this a well-formed failure object on a Task in this state (§12.7)? An
 *  absent object (no stated reason) is fine. */
export function isValidFailureObject(state: TaskState, o: unknown): boolean {
  if (o === null || o === undefined) return true;
  if (state !== "TASK_STATE_FAILED" || typeof o !== "object" || Array.isArray(o)) return false;
  const f = o as Record<string, unknown>;
  if (!(A2A_CANCEL_REASONS as readonly unknown[]).includes(f.reason)) return false;
  const allowed = new Set(["reason", ...(f.reason === "needs_not_furnished" ? ["unmetNeed"] : []), ...(f.reason === "dependency_failed" ? ["dependency"] : [])]);
  if (Object.keys(f).some((k) => !allowed.has(k))) return false;
  if (f.reason === "needs_not_furnished" && !(typeof f.unmetNeed === "string" && NEED_REF.test(f.unmetNeed))) return false;
  if (f.reason === "dependency_failed" && f.dependency !== undefined && typeof f.dependency !== "string") return false;
  return true;
}

/**
 * Which offering a Message calls (§12.1; the A2A Bridge §4.5): the offering
 * extension's value, or during the transition window the older keys
 * `agentmesh.offering` and `agentmesh.skill` (`added: true` says the
 * extension's key should be added with that value). One declared offering
 * serves a Message naming none, and so does `opts.default` when the agent
 * declares several and names one of them as its default (0.4.2-draft); a
 * named offering always wins. Several and no default, a name not declared,
 * or the two keys disagreeing, is the invalid-parameters error listing the
 * offerings.
 */
export function routeOffering(
  declared: readonly string[],
  metadata: Record<string, unknown> | undefined,
  opts: { window?: boolean; default?: string } = {},
): { offering: string; added?: true } | { error: -32602; offerings: string[] } {
  const md = metadata ?? {};
  const ext = (md[EXT_OFFERING] as { offering?: unknown } | undefined)?.offering;
  const named0 = typeof ext === "string" && ext ? ext : undefined;
  const oldRaw = (opts.window ?? true) ? (md["agentmesh.offering"] ?? md["agentmesh.skill"]) : undefined;
  const old = typeof oldRaw === "string" && oldRaw ? oldRaw : undefined;
  const refuse = { error: -32602 as const, offerings: [...declared] };
  if (named0 !== undefined && old !== undefined && named0 !== old) return refuse;
  const named = named0 ?? old;
  if (named === undefined) {
    if (declared.length === 1) return { offering: declared[0] };
    // §12.1 (0.4.2-draft): an agent with several may name a default.
    return opts.default !== undefined && declared.includes(opts.default) ? { offering: opts.default } : refuse;
  }
  if (!declared.includes(named)) return refuse;
  return named0 === undefined ? { offering: named, added: true } : { offering: named };
}

/**
 * A carrier without stream subjects (§8, such as email) delivers each later
 * change to a Task as a respond frame whose result is the whole Task,
 * numbered by `seq`. The client reads them in `seq` order whatever order they
 * arrive in; the Task it holds is the one with the highest `seq` read
 * without a gap, and `waiting_for` names the seq it lacks.
 */
export function readTaskSnapshots(frames: Envelope[]): { seq: number; state: string | undefined; task?: Task; waiting_for?: number } {
  const bySeq = new Map<number, Task>();
  for (const f of frames) {
    const r = readRespondPayload(f);
    if (!r || r.seq === undefined) continue;
    const t = ((r.result as { task?: Task }).task ?? r.result) as Task;
    if (!bySeq.has(r.seq)) bySeq.set(r.seq, t);
  }
  let seq = -1;
  while (bySeq.has(seq + 1)) seq++;
  const highest = bySeq.size ? Math.max(...bySeq.keys()) : -1;
  const task = bySeq.get(seq);
  return { seq, state: task?.status?.state, ...(task ? { task } : {}), ...(highest > seq ? { waiting_for: seq + 1 } : {}) };
}

/**
 * Whether a receiver takes a frame for its wire version and fields (§4,
 * §14): a 0.4.0 frame without the old envelope fields; a 0.3.0 envelope while
 * the transition window is open, else INVALID_VERSION.
 */
export function wireRefusal(env: Envelope, opts: { window?: boolean } = {}): MeshError | null {
  if (env.v === "0.3.0") {
    return (opts.window ?? true)
      ? null
      : new MeshError(ErrorCode.INVALID_VERSION, "The 0.3.0 wire's transition window has ended; send 0.4.0 frames (A2A binding §14).", { retryable: false });
  }
  if (env.v !== A2A_WIRE_VERSION) return new MeshError(ErrorCode.INVALID_VERSION, `Wire version ${env.v} is not spoken here.`, { retryable: false });
  return forbiddenFieldsRefusal(env);
}

const MESH_REF = /^mesh:(artifacts|rooms):/;

/**
 * Is this a well-formed Part (§6, §12.5): exactly one of `text`, `raw`,
 * `url`, `data`; a reference to a mesh store carries the artifact-refs
 * extension; where the extension sits (on any carrier's `url`), it gives a
 * whole-number size and a lowercase sha256 digest.
 */
export function isValidPart(p: unknown): boolean {
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  const o = p as Record<string, unknown>;
  const kinds = ["text", "raw", "url", "data"].filter((k) => k in o);
  if (kinds.length !== 1) return false;
  const r = (o.metadata as Record<string, unknown> | undefined)?.["https://agentmessaging.ai/extensions/artifact-refs/v1"] as
    | { size?: unknown; digest?: unknown }
    | undefined;
  if (r === undefined) return !(typeof o.url === "string" && MESH_REF.test(o.url));
  if (typeof o.url !== "string") return false;
  return Number.isInteger(r.size) && (r.size as number) >= 0 && typeof r.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(r.digest);
}
