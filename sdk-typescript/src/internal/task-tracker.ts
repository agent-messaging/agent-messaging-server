import type { Task, TaskState } from "../types/task.js";
import type { Envelope, Artifact, Budget } from "../types/envelope.js";
import { isValidTransition, TERMINAL_STATES } from "../types/task.js";
import { MeshError, ErrorCode } from "../types/errors.js";
import { DEFAULT_TASK_MAX_LIFETIME_MS } from "../constants.js";

const MAX_TASK_HISTORY = 50;

/** Copy a budget so tracker state never aliases a caller's (or the wire's)
 *  object — the same reason create() and get() copy. */
function cloneBudget(budget: Budget | undefined): Budget | undefined {
  if (budget === undefined) return undefined;
  const copy: Budget = { revision: budget.revision };
  if (budget.deadline !== undefined) copy.deadline = budget.deadline;
  if (budget.cost_ceiling !== undefined) copy.cost_ceiling = { ...budget.cost_ceiling };
  return copy;
}

export class TaskTracker {
  private tasks = new Map<string, Task>();

  /** Start tracking a task.
   *
   *  A collision is REFUSED rather than overwritten. In Task mode the id comes
   *  from the RESPONDER (§6.4), so a plain `Map.set` let one responder replace
   *  the tracked state, history and artifacts of a task belonging to another —
   *  answer a request with the `task_id` of the caller's in-flight stream and
   *  that stream's record becomes yours. Ids are UUIDv7, so an honest collision
   *  does not happen; there is nothing to lose by refusing. */
  create(task: Task): void {
    if (this.tasks.has(task.id)) {
      throw new MeshError(
        ErrorCode.TASK_INVALID_TRANSITION,
        `Task ${task.id} is already tracked — refusing to replace it`,
      );
    }
    this.tasks.set(task.id, { ...task, budget: cloneBudget(task.budget) });
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  get(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    return task
      ? {
          ...task,
          history: [...task.history],
          artifacts: [...task.artifacts],
          budget: cloneBudget(task.budget),
        }
      : undefined;
  }

  /**
   * Apply a budget revision under §7.7 latest-wins semantics: revisions are
   * absolute, so the highest `revision` is simply the whole truth. A revision
   * at or below the one already held is IGNORED, not merged — a reordered or
   * replayed revision must not move the budget backwards. Returns whether the
   * budget was applied (also true for the first budget a task sees).
   */
  applyBudget(taskId: string, budget: Budget): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.budget !== undefined && budget.revision <= task.budget.revision) return false;
    task.budget = cloneBudget(budget);
    task.updated_at = new Date().toISOString();
    return true;
  }

  transition(taskId: string, newState: TaskState): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new MeshError(ErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    }
    if (!isValidTransition(task.state, newState)) {
      throw new MeshError(
        ErrorCode.TASK_INVALID_TRANSITION,
        `Invalid transition: ${task.state} -> ${newState} for task ${taskId}`,
      );
    }
    task.state = newState;
    task.updated_at = new Date().toISOString();
  }

  addToHistory(taskId: string, envelope: Envelope): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.history.push(envelope);
      if (task.history.length > MAX_TASK_HISTORY) {
        task.history = task.history.slice(-MAX_TASK_HISTORY);
      }
    }
  }

  addArtifacts(taskId: string, artifacts: Artifact[]): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.artifacts.push(...artifacts);
    }
  }

  /** Drop finished tasks after `maxAgeMs`, and unfinished ones after
   *  `maxLifetimeMs`.
   *
   *  The second bound is the one that matters for a long-lived agent: only
   *  terminal tasks used to be pruned, so any responder that answered with a
   *  `task_id` and then never finalized it left one entry behind — per request,
   *  forever, chosen by the remote side. Aging a non-terminal task out drops
   *  local bookkeeping only; it cancels nothing and tells nobody. */
  prune(
    maxAgeMs: number = 300_000,
    maxLifetimeMs: number = DEFAULT_TASK_MAX_LIFETIME_MS,
  ): void {
    const now = Date.now();
    const terminalCutoff = now - maxAgeMs;
    const lifetimeCutoff = now - maxLifetimeMs;
    for (const [id, task] of this.tasks) {
      const terminal = TERMINAL_STATES.has(task.state);
      if (terminal && new Date(task.updated_at).getTime() < terminalCutoff) {
        this.tasks.delete(id);
      } else if (!terminal && new Date(task.created_at).getTime() < lifetimeCutoff) {
        this.tasks.delete(id);
      }
    }
  }
}
