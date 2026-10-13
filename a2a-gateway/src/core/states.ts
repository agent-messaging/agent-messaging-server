/**
 * Task-state mapping (BRIDGE-A2A.md §5). The sets were identical by design
 * (SPEC.md §7 mirrors A2A §4.1.3), differing only in spelling, until the mesh
 * gained `exhausted` for work that stopped on reaching a time-and-materials
 * cap (Agent SoW §5.5.5). A2A has no equivalent, so the mapping is total
 * outbound and lossy inbound: an A2A `canceled` returns as mesh `canceled`,
 * never as `exhausted`.
 */
import type { TaskState } from "../../../sdk-typescript/src/types/task.js";
import type { RespondStatus } from "../../../sdk-typescript/src/types/primitives.js";
import type { A2ATaskStateJson } from "./jsonrpc.js";

const MESH_TO_A2A: Record<TaskState, A2ATaskStateJson> = {
  submitted: "submitted",
  working: "working",
  input_required: "input-required",
  auth_required: "auth-required",
  completed: "completed",
  failed: "failed",
  canceled: "canceled",
  rejected: "rejected",
  // Best-effort work that ran to its cap. `completed` would claim the
  // objective was met and `failed` is forbidden outright, since a spent
  // budget carries no blame. `canceled` is the only A2A state that says
  // "stopped short of the objective, nobody's fault", which is what happened.
  exhausted: "canceled",
};

const A2A_TO_MESH: Record<A2ATaskStateJson, TaskState> = {
  submitted: "submitted",
  working: "working",
  "input-required": "input_required",
  "auth-required": "auth_required",
  completed: "completed",
  failed: "failed",
  canceled: "canceled",
  rejected: "rejected",
};

/** A2A protobuf-style enum spelling (TASK_STATE_*) → mesh state. */
function fromEnumSpelling(s: string): TaskState | undefined {
  if (!s.startsWith("TASK_STATE_")) return undefined;
  const bare = s.slice("TASK_STATE_".length).toLowerCase();
  return bare in MESH_TO_A2A ? (bare as TaskState) : undefined;
}

/**
 * Accepts the full RespondStatus, not just TaskState: a respond may carry
 * `accepted` (SDK primitives.ts — "got it, task underway"), which is not a
 * task state of its own. A2A has no separate spelling for it either; it is
 * the moment a task exists and nothing has progressed, which is exactly
 * `submitted`.
 */
export function meshStateToA2A(state: RespondStatus): A2ATaskStateJson {
  return state === "accepted" ? "submitted" : MESH_TO_A2A[state];
}

/** Accepts both JSON ("input-required") and enum ("TASK_STATE_INPUT_REQUIRED")
 *  spellings, per A2A binding conventions. */
export function a2aStateToMesh(state: string): TaskState | undefined {
  return A2A_TO_MESH[state as A2ATaskStateJson] ?? fromEnumSpelling(state);
}
