/**
 * The Tasks this agent, as a RESPONDER, has paused, and who asked for each
 * (SPEC.md §7.3).
 *
 * A request naming an existing Task (`env.task_id`) is the follow-up §7.3
 * names as the trigger of input_required → working, and the responder records
 * that resume, and its outcome, on the Task. But task ids are not secrets:
 * they are broadcast on `mesh.event.task.*`. So `env.task_id` alone proves
 * nothing, and an agent that took any request naming a Task as its resume
 * would let a third party end somebody else's paused Task (a refund at the
 * responder's expense, or the stranger's output in the requester's record).
 * The task manager cannot stop it: the responder IS a party to the Task.
 *
 * So the responder remembers, for every Task it pauses (`input_required`), the
 * requester (and the offering). Only a paused Task: one still working (a
 * deferral) is not resumable, and a request naming it is new work. A request is a resume only when its task id is
 * remembered here and `env.from` is that requester. The map is in memory, so
 * a restart empties it; the dispatch then reads the Task's own record, which
 * carries both parties, before treating a request as a resume.
 *
 * Entries live as long as the task manager keeps a Task record (seven days,
 * server/src/storage/catalog.ts `mesh_tasks`), and the map is bounded: the
 * oldest entry goes first when it is full. An evicted entry is not lost, the
 * record read covers it.
 *
 * An entry is a HINT, not the truth: the Task can end without this agent
 * seeing it (the requester cancels through the task manager, the overdue
 * sweep ends it). So an entry older than `RESUME_HINT_FRESH_MS` is confirmed
 * against the record before a resume runs (`rememberedAt`).
 *
 * The same class keeps a second map in the SDK: who asked for each dispatch
 * this agent ran under a task id (the only agent whose `task.cancel` for that
 * Task is taken).
 */

/** How long a remembered pause is trusted without reading the record. */
export const RESUME_HINT_FRESH_MS = 30_000;
/** How long "the task manager has no record of this id" is trusted. */
export const NO_RECORD_TTL_MS = 30_000;

/** How long a paused Task stays resumable here: the task record's own life. */
export const RESUMABLE_TASK_TTL_MS = 7 * 24 * 60 * 60_000;
/** The most Tasks remembered at once. */
export const RESUMABLE_TASK_MAX = 10_000;

export interface ResumableTask {
  /** The agent that asked for the Task: the only one whose request resumes it. */
  requester: string;
  /** The offering the Task runs. */
  offering: string;
  /** When this entry was (last) remembered (ms since the epoch). */
  rememberedAt: number;
  /** When this entry stops counting (ms since the epoch). */
  expiresAt: number;
}

export class ResumableTasks {
  private readonly entries = new Map<string, ResumableTask>();

  constructor(
    private readonly ttlMs = RESUMABLE_TASK_TTL_MS,
    private readonly max = RESUMABLE_TASK_MAX,
    private readonly now: () => number = Date.now,
  ) {}

  /** Remember a Task this agent paused or deferred, for `requester`. */
  remember(taskId: string, requester: string, offering: string): void {
    // Re-inserted, so a Task paused again counts as the newest.
    this.entries.delete(taskId);
    const now = this.now();
    this.entries.set(taskId, { requester, offering, rememberedAt: now, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** The remembered Task, or undefined when it is unknown or has expired. */
  get(taskId: string): ResumableTask | undefined {
    const entry = this.entries.get(taskId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(taskId);
      return undefined;
    }
    return entry;
  }

  /** The Task ended: no request resumes it any more. */
  forget(taskId: string): void {
    this.entries.delete(taskId);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Task ids the task manager said it has no record of, each for a short while,
 *  so a run of requests naming one costs one read. Bounded like the map. */
export class NoRecordCache {
  private readonly until = new Map<string, number>();

  constructor(
    private readonly ttlMs = NO_RECORD_TTL_MS,
    private readonly max = RESUMABLE_TASK_MAX,
    private readonly now: () => number = Date.now,
  ) {}

  add(taskId: string): void {
    this.until.delete(taskId);
    this.until.set(taskId, this.now() + this.ttlMs);
    while (this.until.size > this.max) {
      const oldest = this.until.keys().next().value;
      if (oldest === undefined) break;
      this.until.delete(oldest);
    }
  }

  has(taskId: string): boolean {
    const t = this.until.get(taskId);
    if (t === undefined) return false;
    if (t <= this.now()) {
      this.until.delete(taskId);
      return false;
    }
    return true;
  }

  delete(taskId: string): void {
    this.until.delete(taskId);
  }
}
