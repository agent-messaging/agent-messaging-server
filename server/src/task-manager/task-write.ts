import type { KeyedStore } from "../storage/index.js";

/**
 * Rewrite one stored Task record from what is stored NOW, by compare-and-set.
 *
 * For the writers that change a record they did not just receive an update
 * for: the overdue sweep and the stranded-delegate fan-out. Each used to write
 * back the copy it read from a bucket snapshot, which could be seconds old, so
 * whatever had been written since (a state transition, or the `origin` the
 * origin tap attaches by compare-and-set, origin.ts) was replaced by the old
 * copy. Here the record is read fresh, `mutate` decides on it (returning
 * false leaves it alone, which is how a condition that no longer holds is
 * respected), and the write succeeds only against the revision that was
 * read; a lost race reads again.
 *
 * A store without revisions on its entries (a test stub) is written plainly.
 * Returns the record written, or null when nothing was.
 */
export async function rewriteTask<T extends object>(
  kv: KeyedStore,
  key: string,
  mutate: (task: T) => boolean,
): Promise<T | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const e = await kv.get(key);
    if (!e || e.operation === "DEL" || e.operation === "PURGE" || e.value?.length === 0) return null;
    const task = e.json<T>();
    if (!mutate(task)) return null;
    const data = new TextEncoder().encode(JSON.stringify(task));
    if (typeof kv.update !== "function" || typeof e.revision !== "number") {
      await kv.put(key, data);
      return task;
    }
    try {
      await kv.update(key, data, e.revision);
      return task;
    } catch {
      // Written in between: read again and decide again.
    }
  }
  console.warn(`[task-manager] gave up rewriting task ${key} after repeated concurrent writes`);
  return null;
}
