// A keyed store in memory, for tests that need revisions and compare-and-set.
import type { KeyedEntry, KeyedStore, KeyedSnapshot } from "../../src/storage/index.js";

/** A keyed store in memory, with revisions and compare-and-set. */
export function memoryKv(): KeyedStore & { data: Map<string, { value: Uint8Array; revision: number }> } {
  const data = new Map<string, { value: Uint8Array; revision: number }>();
  let rev = 0;
  const entry = (key: string, v: { value: Uint8Array; revision: number }): KeyedEntry => ({
    key,
    value: v.value,
    revision: v.revision,
    created: new Date(),
    operation: "PUT",
    length: v.value.length,
    json: <T>() => JSON.parse(new TextDecoder().decode(v.value)) as T,
    string: () => new TextDecoder().decode(v.value),
  });
  const bytes = (v: Uint8Array | string) => (typeof v === "string" ? new TextEncoder().encode(v) : v);
  return {
    data,
    async get(key) {
      const v = data.get(key);
      return v ? entry(key, v) : null;
    },
    async put(key, value) {
      data.set(key, { value: bytes(value), revision: ++rev });
      return rev;
    },
    async create(key, value) {
      if (data.has(key)) throw new Error("exists");
      data.set(key, { value: bytes(value), revision: ++rev });
      return rev;
    },
    async update(key, value, revision) {
      if (data.get(key)?.revision !== revision) throw new Error("wrong revision");
      data.set(key, { value: bytes(value), revision: ++rev });
      return rev;
    },
    async delete(key) {
      data.delete(key);
    },
    async purge(key) {
      data.delete(key);
    },
    async list() {
      const entries = new Map<string, KeyedEntry>();
      for (const [k, v] of data) entries.set(k, entry(k, v));
      return { keys: [...data.keys()], entries, tombstoned: [], vanished: [], subjects: data.size } as unknown as KeyedSnapshot;
    },
    async watch() {
      throw new Error("not used");
    },
  };
}

