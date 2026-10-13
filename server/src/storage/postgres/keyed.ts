/**
 * Keyed records on Postgres (step 9 of docs/agent-messaging-server-plan.md):
 * one row per key in `ams_keyed`, holding the key's newest revision, written
 * by `ams_keyed_write` (schema.ts) so a compare-and-set is one atomic call.
 *
 * What it keeps of the interface's promises, and how:
 *  - revisions only grow, per store, and `update` and `previousRevision`
 *    compare against them; a lost compare-and-set throws "wrong last sequence";
 *  - `delete` and `purge` leave a marker row, which `get` returns as an entry
 *    whose operation is not PUT (every caller reads that as absent) and a
 *    watch reports as a removal;
 *  - a store with a time to live (catalog.ts) stamps each value with when it
 *    expires, and an expired value reads as absent everywhere;
 *  - `list` is one query, so it is complete or it throws;
 *  - `watch` sends the current rows, then every row whose revision is newer,
 *    woken by NOTIFY on `ams_keyed` and by a slow poll for a missed one.
 */
import { KEYED_STORE } from "../marks.js";
import type {
  KeyedEntry,
  KeyedListOptions,
  KeyedSnapshot,
  KeyedStore,
  KeyedWatch,
  KeyedWatchOptions,
  KeyedWriteOptions,
  RecordOperation,
} from "../types.js";
import { KeyedListError } from "../types.js";
import { notices } from "./notices.js";
import type { Sql } from "./sql.js";

const td = new TextDecoder();
const te = new TextEncoder();

interface Row {
  key: string;
  value: Uint8Array | Buffer;
  revision: string | number;
  created: Date | string;
  operation: string;
}

function entryOf(r: Row): KeyedEntry {
  const value = r.value instanceof Uint8Array ? new Uint8Array(r.value.buffer, r.value.byteOffset, r.value.byteLength) : new Uint8Array(0);
  return {
    key: r.key,
    value,
    revision: Number(r.revision),
    created: r.created instanceof Date ? r.created : new Date(r.created),
    operation: r.operation as RecordOperation,
    length: value.byteLength,
    json<T>(): T {
      return JSON.parse(td.decode(value)) as T;
    },
    string(): string {
      return td.decode(value);
    },
  };
}

const bytesOf = (v: Uint8Array | string): Uint8Array => (typeof v === "string" ? te.encode(v) : v);

/** What a row must not be, to be live: expired. */
const LIVE = "(expires_at is null or expires_at > clock_timestamp())";

/** A LIKE pattern matching keys that start with `prefix`. */
export function likePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
}

/** How often a watch reads again with no notification, in case one was missed. */
const WATCH_POLL_MS = 5_000;

export class PostgresKeyed implements KeyedStore {
  readonly [KEYED_STORE] = true;

  constructor(
    private readonly sql: Sql,
    /** The store's name in the layer (catalog.ts). */
    readonly store: string,
    /** How long a value lives, from the catalog. */
    private readonly ttlMs?: number,
  ) {}

  private async write(key: string, value: Uint8Array | null, op: RecordOperation, mode: "any" | "expect" | "create", expect: number | null): Promise<number> {
    const r = await this.sql.query<{ rev: string }>("select ams_keyed_write($1, $2, $3, $4, $5, $6, $7) as rev", [
      this.store,
      key,
      value === null ? Buffer.alloc(0) : Buffer.from(value.buffer, value.byteOffset, value.byteLength),
      op,
      mode,
      expect ?? 0,
      op === "PUT" ? (this.ttlMs ?? null) : null,
    ]);
    return Number(r.rows[0]!.rev);
  }

  async get(key: string): Promise<KeyedEntry | null> {
    const r = await this.sql.query<Row>(
      `select key, value, revision, created, operation from ams_keyed where store = $1 and key = $2 and ${LIVE}`,
      [this.store, key],
    );
    return r.rows[0] ? entryOf(r.rows[0]) : null;
  }

  put(key: string, value: Uint8Array | string, opts?: KeyedWriteOptions): Promise<number> {
    return opts?.previousRevision === undefined
      ? this.write(key, bytesOf(value), "PUT", "any", null)
      : this.write(key, bytesOf(value), "PUT", "expect", opts.previousRevision);
  }

  create(key: string, value: Uint8Array | string): Promise<number> {
    return this.write(key, bytesOf(value), "PUT", "create", null);
  }

  update(key: string, value: Uint8Array | string, revision: number): Promise<number> {
    return this.write(key, bytesOf(value), "PUT", "expect", revision);
  }

  async delete(key: string, opts?: KeyedWriteOptions): Promise<void> {
    await this.write(key, null, "DEL", opts?.previousRevision === undefined ? "any" : "expect", opts?.previousRevision ?? null);
  }

  async purge(key: string, opts?: KeyedWriteOptions): Promise<void> {
    await this.write(key, null, "PURGE", opts?.previousRevision === undefined ? "any" : "expect", opts?.previousRevision ?? null);
  }

  async list(opts: KeyedListOptions = {}): Promise<KeyedSnapshot> {
    let rows: Row[];
    try {
      const params: unknown[] = [this.store];
      let where = `store = $1 and ${LIVE}`;
      if (opts.prefix !== undefined && opts.prefix !== "") {
        params.push(likePrefix(opts.prefix));
        where += ` and key like $2`;
      }
      rows = (await this.sql.query<Row>(`select key, value, revision, created, operation from ams_keyed where ${where} order by key`, params)).rows;
    } catch (err) {
      throw new KeyedListError(this.store, err instanceof Error ? err.message : String(err));
    }
    const entries = new Map<string, KeyedEntry>();
    const keys: string[] = [];
    const tombstoned: string[] = [];
    for (const r of rows) {
      if (opts.only && !opts.only(r.key)) continue;
      if (r.operation !== "PUT") {
        tombstoned.push(r.key);
        continue;
      }
      keys.push(r.key);
      entries.set(r.key, entryOf(r));
    }
    if (opts.minKeys !== undefined && keys.length < opts.minKeys) {
      throw new KeyedListError(this.store, `listed ${keys.length} live keys, fewer than the ${opts.minKeys} known to exist`);
    }
    return { keys, entries, tombstoned, vanished: [], subjects: rows.length, values: rows.length };
  }

  async watch(opts: KeyedWatchOptions = {}): Promise<KeyedWatch> {
    const sql = this.sql;
    const store = this.store;
    // Read before the first rows are sent, so nothing written in between is
    // lost: a write that lands after the first read has a higher revision and
    // is picked up by the next one.
    let last = opts.fromRevision !== undefined ? opts.fromRevision - 1 : 0;
    let stopped = false;
    let wake: (() => void) | null = null;
    let pending = false;
    const kick = () => {
      pending = true;
      wake?.();
    };
    const unlisten = await notices(sql, "ams_keyed").on(store, kick);
    const poll = setInterval(kick, WATCH_POLL_MS);
    poll.unref?.();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(poll);
      unlisten();
      wake?.();
    };
    async function* iterate(): AsyncGenerator<KeyedEntry> {
      try {
        // The current value of every key (markers included, as JetStream sends
        // them), then each change after it.
        while (!stopped) {
          pending = false;
          const r = await sql.query<Row>(
            `select key, value, revision, created, operation from ams_keyed
               where store = $1 and revision > $2 and ${LIVE} order by revision limit 1000`,
            [store, last],
          );
          for (const row of r.rows) {
            last = Math.max(last, Number(row.revision));
            if (stopped) return;
            // The first pass sends the current values; a marker for a key that
            // was never seen is still sent, as JetStream's last-per-key does.
            yield entryOf(row);
          }
          if (r.rows.length === 1000) continue;
          if (stopped) return;
          if (!pending) await new Promise<void>((res) => (wake = res));
          wake = null;
        }
      } finally {
        stop();
      }
    }
    const it = iterate();
    return Object.assign(it, { stop }) as unknown as KeyedWatch;
  }
}

/** Remove expired values for good. Reads already treat them as absent; this
 *  only gives the space back. */
export async function sweepExpired(sql: Sql): Promise<number> {
  const r = await sql.query("delete from ams_keyed where expires_at is not null and expires_at <= clock_timestamp()");
  return r.rowCount;
}
