/**
 * The 0.3.0 wire's transition window (A2A binding §14, SPEC.md §20.1).
 *
 * Agent Messaging 0.10 carries calls between agents as A2A operations in
 * 0.4.0 frames, and a node accepts the 0.3.0 calls of Agent Messaging 0.9
 * until its operator ends that window. On this server the window is one
 * setting, `MESH_WIRE_0_3_0`:
 *
 *   accept   (the default) 0.3.0 calls are served as they always were
 *   refuse   the window is over:
 *            - the task manager refuses 0.3.0 Task updates on
 *              `mesh.task.*.update` (logged; the subject has no reply) and
 *              answers 0.3.0 Task reads on `mesh.task.get.*` with
 *              INVALID_VERSION;
 *            - credentials stop granting subscribe on `mesh.task.>`. A 0.4.0
 *              reader gets its stream through the task manager instead, which
 *              checks it may read the Task first (task-manager/a2a-follow.ts).
 *
 * The channel's own requests (registry, rooms, admission and the rest) are not
 * calls between agents and are served at either wire version.
 */
import type { ErrorObject } from "../sdk.js";
import { ErrorCode } from "../sdk.js";

export const WIRE_0_3_0_SETTING = "MESH_WIRE_0_3_0";

/** Is the 0.3.0 window over (`MESH_WIRE_0_3_0=refuse`)? Anything but `refuse`
 *  leaves it open; an unknown value is warned about once. */
export function wire030Refused(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[WIRE_0_3_0_SETTING]?.trim().toLowerCase();
  if (v === undefined || v === "" || v === "accept") return false;
  if (v === "refuse") return true;
  if (!warned) {
    warned = true;
    console.warn(`[wire] ${WIRE_0_3_0_SETTING}=${v} is neither accept nor refuse; the 0.3.0 window stays open`);
  }
  return false;
}
let warned = false;

/** The refusal a 0.3.0 call gets once the window is over. */
export function wire030RefusalError(): ErrorObject {
  return {
    code: ErrorCode.INVALID_VERSION,
    message:
      "This mesh has ended the 0.3.0 wire's transition window: calls between agents are A2A operations in 0.4.0 frames " +
      "(A2A over Agent Messaging, https://agentmessaging.ai/bindings/a2a/v1). Upgrade the SDK and use its A2A calls.",
    details: { reason: "wire_0_3_0_refused", setting: WIRE_0_3_0_SETTING },
    retryable: false,
  };
}
