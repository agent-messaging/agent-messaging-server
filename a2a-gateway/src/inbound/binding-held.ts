/**
 * The Tasks the bridge holds itself (MAPPING.md §4.3, the A2A Bridge
 * 0.9.1-draft): the channel's answers an A2A client cannot read as they are.
 *
 * When the agent's node answers a request with a queued acknowledgement
 * (SPEC.md §6.4a), no A2A answer has come yet. The bridge answers the caller
 * with a Task of its own whose `id` is the request frame's `id`:
 *
 *   - `TASK_STATE_SUBMITTED` when the acknowledgement says `delivered: true`
 *     or `paused: true` (the message waits in the agent's inbox);
 *   - `TASK_STATE_AUTH_REQUIRED` when it says neither: the agent's door has
 *     not let the caller in (EXT-14 §9).
 *
 * Its `metadata` carries the bridge marker's URI with `{"held": true}`, so a
 * caller can tell it from a Task the agent made. When the agent's first A2A
 * answer to the request arrives (from that agent, naming the request in
 * `in_reply_to`; the SDK checks both):
 *
 *   - a Message moves the held Task to `TASK_STATE_COMPLETED` with that
 *     Message as its status message;
 *   - a Task replaces it: from then on GetTask, SubscribeToTask and
 *     CancelTask on the held id are answered with the agent's Task, and the
 *     held id's metadata names it, `{"held": true, "taskId": "<agent's id>"}`;
 *   - an A2A error ends the held Task in `TASK_STATE_FAILED`, with the error's
 *     message and name.
 *
 * A held Task is read only by the caller credential that sent the request,
 * and is kept a day.
 */
import { randomUUID } from "node:crypto";
import { BRIDGE_EXTENSION_URI } from "../core/card.js";
import { A2AError } from "../../../sdk-typescript/src/a2a/errors.js";
import { isTerminalState } from "../../../sdk-typescript/src/a2a/binding.js";
import type { Message, Task, TaskState } from "../../../sdk-typescript/src/a2a/types.js";
import type { MeshError } from "../../../sdk-typescript/src/types/errors.js";

export const HELD_TTL_MS = 24 * 3600_000;
const HELD_MAX = 10_000;

const QUEUED_WORDS =
  "The agent's node has queued this message for its attended session, so a person or a live session answers it, and that can take hours. " +
  "The answer lands on this task: read it with GetTask rather than holding the call. The bridge keeps this task for 24 hours.";
const DOOR_WORDS =
  "This message waits at the agent's door: the agent has not let you in yet. It reaches the agent if the agent admits you, " +
  "and the answer then lands on this task.";

interface Held {
  task: Task;
  callerKey: string;
  responder: string;
  agentTaskId?: string;
  at: number;
}

export class HeldTasks {
  private readonly held = new Map<string, Held>();

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.held) if (now - v.at > HELD_TTL_MS) this.held.delete(k);
    while (this.held.size >= HELD_MAX) {
      const first = this.held.keys().next().value;
      if (first === undefined) break;
      this.held.delete(first);
    }
  }

  /** Hold a Task for a request the agent's node queued (§4.3). */
  hold(requestId: string, opts: { callerKey: string; responder: string; delivered: boolean; paused: boolean; contextId?: string }): Task {
    this.sweep();
    const state: TaskState = opts.delivered || opts.paused ? "TASK_STATE_SUBMITTED" : "TASK_STATE_AUTH_REQUIRED";
    const contextId = opts.contextId ?? randomUUID();
    const task: Task = {
      id: requestId,
      contextId,
      status: {
        state,
        timestamp: new Date().toISOString(),
        message: {
          messageId: `${requestId}-held`,
          role: "ROLE_AGENT",
          parts: [{ text: state === "TASK_STATE_SUBMITTED" ? QUEUED_WORDS : DOOR_WORDS }],
          taskId: requestId,
          contextId,
        },
      },
      metadata: { [BRIDGE_EXTENSION_URI]: { held: true } },
    };
    this.held.set(requestId, { task, callerKey: opts.callerKey, responder: opts.responder, at: Date.now() });
    return structuredClone(task);
  }

  /** The agent's first A2A answer to the held request (§4.3). */
  settle(requestId: string, answer: { result: unknown } | { error: A2AError | MeshError }): void {
    const h = this.held.get(requestId);
    if (!h || h.agentTaskId || isTerminalState(h.task.status.state)) return;
    const now = new Date().toISOString();
    if ("error" in answer) {
      const code = answer.error instanceof A2AError ? answer.error.code : String((answer.error as MeshError).code);
      h.task = {
        ...h.task,
        status: {
          state: "TASK_STATE_FAILED",
          timestamp: now,
          message: { messageId: `${requestId}-failed`, role: "ROLE_AGENT", parts: [{ text: answer.error.message }], taskId: requestId, contextId: h.task.contextId },
        },
        metadata: { ...(h.task.metadata ?? {}), [BRIDGE_EXTENSION_URI]: { held: true, error: code } },
      };
      return;
    }
    const r = answer.result as { message?: Message; task?: Task } | null;
    if (r?.task && typeof r.task.id === "string") {
      h.agentTaskId = r.task.id;
      h.task = { ...h.task, metadata: { ...(h.task.metadata ?? {}), [BRIDGE_EXTENSION_URI]: { held: true, taskId: r.task.id } } };
      return;
    }
    if (r?.message) {
      h.task = { ...h.task, status: { state: "TASK_STATE_COMPLETED", timestamp: now, message: r.message } };
    }
  }

  /** The held Task with this id, for the caller that sent the request. */
  get(id: unknown, callerKey: string): { task: Task; agentTaskId?: string; responder: string } | undefined {
    if (typeof id !== "string") return undefined;
    const h = this.held.get(id);
    if (!h || h.callerKey !== callerKey || Date.now() - h.at > HELD_TTL_MS) return undefined;
    return { task: structuredClone(h.task), ...(h.agentTaskId ? { agentTaskId: h.agentTaskId } : {}), responder: h.responder };
  }

  /** Cancel a held Task no agent Task stands behind yet. Throws
   *  TaskNotCancelableError when it already ended. */
  cancel(id: string, callerKey: string): Task {
    const h = this.held.get(id);
    if (!h || h.callerKey !== callerKey) throw new A2AError("TaskNotFoundError", "No task with that id.", { taskId: id });
    if (isTerminalState(h.task.status.state)) throw new A2AError("TaskNotCancelableError", "The task is in a terminal state and cannot be canceled.", { taskId: id });
    h.task = { ...h.task, status: { state: "TASK_STATE_CANCELED", timestamp: new Date().toISOString() } };
    return structuredClone(h.task);
  }
}

/** The bridge process's held Tasks. */
export const heldTasks = new HeldTasks();
