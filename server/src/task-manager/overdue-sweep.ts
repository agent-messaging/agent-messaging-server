import type { Messaging } from "../storage/index.js";
import { createEnvelope, Subjects, TERMINAL_STATES } from "../sdk.js";
import { idOf, sealEnvelope, type ServiceIdentity } from "../shared/handler.js";
import { keyedOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";
import { deadlinePassed, type BudgetTask, type BudgetEnvelope } from "./budget.js";
import { rewriteTask } from "./task-write.js";

/** Same cadence as the presence sweep (registry/heartbeat-monitor.ts). A
 *  deadline is second-granularity under a five-minute skew tolerance (§7.7,
 *  §22.3), so half a minute of sweep latency is inside the noise the
 *  comparison already tolerates. Env-tunable like the reaper's interval. */
const SWEEP_INTERVAL_MS = Number(process.env.TASK_OVERDUE_SWEEP_MS ?? 30_000);

/** The one slice of a task entry the sweep reads. Matches `KvEntry`; tests
 *  inject a loader returning plain objects of this shape. */
export interface TaskEntryLike {
  json<T>(): T;
}

export type LoadTaskEntries = () => Promise<Map<string, TaskEntryLike>>;

/**
 * §7.7 "What the deadline means": the deadline is the moment the requester's
 * obligation to wait ends and the responder's authorization to spend ends —
 * and the task manager, which holds the clock centrally and needs no
 * cooperation from the responder, is what makes that true. This sweep marks a
 * non-terminal task **overdue** once its deadline passes and notifies the
 * requester, who then holds every partial artifact received so far and a
 * choice: cancel, or keep listening.
 *
 * Overdue is a FLAG on the record, deliberately not a lifecycle state: the
 * task stays exactly where it is in §7.2, because the deadline is not a kill
 * switch — a completion after it is still accepted (and recorded late by the
 * update handler). The mark is applied once; a task already flagged is skipped
 * on every later sweep.
 *
 * The clock is this service's own (§7.7 makes it authoritative), compared at
 * second granularity under the §22.3 skew tolerance — the same `deadlinePassed`
 * the revision and late-completion checks use, so all three sites agree about
 * when a deadline has passed.
 *
 * Enumeration goes through `snapshotKvBucket`, never `kv.keys()` — the
 * iterator provably under-returns (see shared/kv.ts), and a task the
 * enumeration silently dropped would be a deadline nobody ever enforced.
 *
 * Multi-instance, stated plainly: the sweep runs per instance on a timer, so
 * two task-manager instances can race the same freshly-expired task and the
 * requester can receive the notice twice. The mark itself is idempotent
 * (`overdue: true` is a constant write), the duplicate is advisory, and the
 * queue group on the update subject does not help a timer. The same trade the
 * presence sweep makes, accepted for the same reason.
 */
export class OverdueSweep {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly loadEntries: LoadTaskEntries;

  private kv: KeyedStore;

  constructor(
    private nc: Messaging,
    js: StorageLike,
    kv: KeyedLike,
    private serviceId: ServiceIdentity,
    /** Test seam: replaces the KV snapshot as the source of task entries. */
    loadEntries?: LoadTaskEntries,
  ) {
    this.kv = keyedOf(kv, js);
    this.loadEntries =
      loadEntries ?? (async () => (await this.kv.list()).entries);
  }

  start(): void {
    this.timer = setInterval(() => {
      this.sweep().catch((err) => console.error("[task-manager] overdue sweep failed:", err));
    }, SWEEP_INTERVAL_MS);
    console.log(`[task-manager] overdue sweep active (every ${SWEEP_INTERVAL_MS / 1000}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Returns the ids of tasks marked overdue by THIS pass. */
  async sweep(nowMs: number = Date.now()): Promise<string[]> {
    const entries = await this.loadEntries();
    const marked: string[] = [];

    for (const [key, entry] of entries) {
      let task: BudgetTask;
      try {
        task = entry.json<BudgetTask>();
      } catch {
        console.warn(`[task-manager] overdue sweep: unparseable task record '${key}', skipped`);
        continue;
      }

      if (TERMINAL_STATES.has(task.state)) continue; // finished inside or outside the budget — nothing left to enforce
      if (task.overdue) continue; // marked on an earlier pass
      const deadline = task.budget?.deadline;
      if (!deadline) continue; // no deadline axis — nothing the mesh can enforce (§7.7)
      if (!deadlinePassed(deadline, nowMs)) continue;

      // The mark: a flag and a timestamp, no state change. Written against the
      // record as stored now (task-write.ts), not the snapshot copy, so an
      // update or an attached origin since the snapshot is kept, and a task
      // that finished or was marked meanwhile is left alone.
      const at = new Date(nowMs).toISOString();
      const written = await rewriteTask<BudgetTask>(this.kv, key, (current) => {
        if (TERMINAL_STATES.has(current.state) || current.overdue) return false;
        current.overdue = true;
        current.overdue_at = at;
        current.updated_at = at;
        return true;
      });
      if (!written) continue;
      task = written;

      // Notify the requester via a task update (§7.7): this service's
      // signature, the task's own update subject — the one the requester's
      // subscription already watches — with the state untouched and the reason
      // in `meta`. The loop back into the service's own queue-group
      // subscription is dropped by the own-key guard in `handleTaskUpdate`.
      const notice = createEnvelope({
        type: "respond",
        from: idOf(this.serviceId),
        to: task.requester,
        task_id: task.id,
        payload: {
          message:
            `deadline ${deadline} has passed; the task is marked overdue and remains ` +
            `${task.state}. Work past the deadline is at the responder's own risk (§7.7).`,
        },
        meta: { overdue: true, deadline },
      }) as BudgetEnvelope;
      if (task.budget) notice.budget = task.budget;
      this.nc.publish(Subjects.taskUpdate(task.id), sealEnvelope(notice, this.serviceId));

      marked.push(task.id);
      console.log(`[task-manager] task ${task.id}: overdue (deadline ${deadline})`);
    }

    return marked;
  }
}
