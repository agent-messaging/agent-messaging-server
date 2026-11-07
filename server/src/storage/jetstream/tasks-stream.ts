/**
 * The `MESH_TASKS` stream (SPEC §18.3; A2A binding §8): what is published on
 * a Task's subjects, kept for the Task horizon, so a reader that starts late
 * or loses its connection gets every event from the first.
 *
 * It holds `mesh.task.*.stream` (the events of each stream, binding §8) and
 * `mesh.task.*.update` (the changes the task store records, binding §5), and
 * not the rest of `mesh.task.>`: `mesh.task.get.*` and `mesh.task.a2a.*` are
 * request subjects, and a stream that held them would answer each request with
 * a pub-ack that races the service's real reply.
 *
 * Limits retention: a reader's consumer is made when it asks to follow a
 * stream (task-manager/a2a-follow.ts), which may be after the first events
 * were published, and interest retention would have dropped them by then.
 * Seven days, the Task horizon of the task stores. `no_ack` because the
 * subjects are published fire-and-forget and nobody waits on an answer.
 */
import type { JetStreamManager } from "nats";
import { RetentionPolicy, DiscardPolicy, StorageType } from "nats";
import { jsReplicas } from "./kv.js";

export const TASKS_STREAM = "MESH_TASKS";
export const TASKS_SUBJECTS = ["mesh.task.*.stream", "mesh.task.*.update"];

const DAY_NS = 24 * 60 * 60 * 1_000_000_000;

/** The stream's settings, fresh per call (`num_replicas` reads
 *  MESH_JS_REPLICAS at creation time). */
export function tasksStreamConfig() {
  return {
    name: TASKS_STREAM,
    subjects: [...TASKS_SUBJECTS],
    retention: RetentionPolicy.Limits,
    discard: DiscardPolicy.Old,
    storage: StorageType.File,
    max_age: 7 * DAY_NS,
    max_bytes: Number(process.env.MESH_TASKS_MAX_BYTES ?? 1024 * 1024 * 1024),
    duplicate_window: 2 * 60 * 1_000_000_000,
    num_replicas: jsReplicas(),
    no_ack: true,
  };
}

/**
 * Create MESH_TASKS when it is missing, and put its subjects back when they
 * drifted. Returns whether it is usable. Fail-soft and loud: without it a
 * reader falls back to reading the Task, which loses nothing that matters to
 * the record but can miss events in between.
 */
export async function ensureTasksStream(jsm: JetStreamManager): Promise<boolean> {
  try {
    try {
      const info = await jsm.streams.info(TASKS_STREAM);
      const subjects = info.config.subjects ?? [];
      if (subjects.length !== TASKS_SUBJECTS.length || TASKS_SUBJECTS.some((s) => !subjects.includes(s))) {
        await jsm.streams.update(TASKS_STREAM, { ...info.config, subjects: [...TASKS_SUBJECTS] });
      }
      return true;
    } catch (err) {
      if (!/not found/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
    await jsm.streams.add(tasksStreamConfig());
    return true;
  } catch (err) {
    console.error(
      `[storage] ${TASKS_STREAM} could not be made: ${err instanceof Error ? err.message : err}. ` +
        "Task streams then reach late readers only through GetTask.",
    );
    return false;
  }
}
