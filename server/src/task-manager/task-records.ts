/**
 * Both kinds of Task record, read and written as one store, for the origin
 * ledger (origin.ts).
 *
 * The ledger attaches an origin, mirrors contest evidence and settles a
 * cancel attribution on a Task record by compare-and-set. A 0.3.0 Task's
 * record is in `mesh_tasks`; an A2A Task's (wire 0.4.0, a2a-store.ts) is in
 * `mesh_a2a_tasks`, with the same platform fields beside the Task (SPEC.md
 * §7.1): `requester`, `responder`, `created_at`, `origin`, the contest
 * fields and `canceled_by`. Task ids are unique across both, so a key lives
 * in one store: this store reads `mesh_tasks` first and the A2A store when
 * `mesh_tasks` has nothing live under the key, and writes a key back to the
 * store that holds it. A key that is in neither is created in `mesh_tasks`,
 * as it always was.
 */
import type { KeyedEntry, KeyedSnapshot, KeyedStore, KeyedWatch, KeyedWriteOptions, KeyedListOptions, KeyedWatchOptions } from "../storage/index.js";

const live = (e: KeyedEntry | null): e is KeyedEntry =>
  !!e && e.operation !== "DEL" && e.operation !== "PURGE" && e.length !== 0;

/** Is this stored record an A2A Task's record (a2a-store.ts)? */
export function isA2ARecord(r: unknown): r is { task: { id: string; status: { state: string } } } {
  const t = (r as { task?: { id?: unknown; status?: unknown } } | null)?.task;
  return !!t && typeof t === "object" && typeof t.id === "string" && !!t.status && typeof t.status === "object";
}

export function taskRecords(tasks: KeyedStore, a2a: KeyedStore): KeyedStore {
  /** The store that holds `key` now: `mesh_tasks` when it has it live. */
  const holder = async (key: string): Promise<KeyedStore> => (live(await tasks.get(key).catch(() => null)) ? tasks : (live(await a2a.get(key).catch(() => null)) ? a2a : tasks));
  return {
    async get(key) {
      const e = await tasks.get(key);
      if (live(e)) return e;
      const b = await a2a.get(key);
      return live(b) ? b : e;
    },
    async put(key, value, opts?: KeyedWriteOptions) {
      return (await holder(key)).put(key, value, opts);
    },
    async create(key, value) {
      if (live(await a2a.get(key).catch(() => null))) throw new Error(`task ${key} exists`);
      return tasks.create(key, value);
    },
    async update(key, value, revision) {
      return (await holder(key)).update(key, value, revision);
    },
    async delete(key, opts?: KeyedWriteOptions) {
      return (await holder(key)).delete(key, opts);
    },
    async purge(key, opts?: KeyedWriteOptions) {
      return (await holder(key)).purge(key, opts);
    },
    async list(opts?: KeyedListOptions): Promise<KeyedSnapshot> {
      const [x, y] = await Promise.all([tasks.list(opts), a2a.list(opts)]);
      const entries = new Map(y.entries);
      for (const [k, v] of x.entries) entries.set(k, v);
      return {
        keys: [...entries.keys()],
        entries,
        tombstoned: [...x.tombstoned, ...y.tombstoned.filter((k) => !entries.has(k))],
        vanished: [...x.vanished, ...y.vanished],
        subjects: x.subjects + y.subjects,
        values: x.values + y.values,
      };
    },
    async watch(opts?: KeyedWatchOptions): Promise<KeyedWatch> {
      // Nothing here watches Task records; a watch of the 0.3.0 store is
      // what this store's callers had before.
      return tasks.watch(opts);
    },
  };
}
