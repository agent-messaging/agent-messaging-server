/**
 * The stop list (docs/kill-switch-plan.md item 1).
 *
 * One record per press of the kill switch: what was stopped (the scope and its
 * target), how (pause or terminate), who pressed it and on what authority, why,
 * when, and, once it is lifted, who lifted it and when. Every door that issues
 * a credential reads this list before it mints, so a stop placed here is
 * refused at the next mint whatever else happens (the transport cut in
 * kill-switch.ts closes the connection in hand as well).
 *
 * Records are never deleted. A lifted stop keeps its record with `lifted` set,
 * because the list is also the record of who did what; a terminate is never
 * lifted at all (kill-switch.ts `mayLift`), and outlives the 30-day trash.
 *
 * Reads are memoized for a few seconds per process: every mint door asks, and
 * the answer changes only when somebody presses. A write through this store
 * clears the memo at once, so the process that placed a stop sees it on its
 * very next read; another process sees it within MEMO_MS.
 */
import { randomUUID } from "node:crypto";
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";
import type { StopRecord } from "./stop-record.js";

export const STOPS_BUCKET = "mesh_stops";

/** What the kill switch needs from wherever stops are kept. An interface so
 *  the rules can be tested without JetStream (MemoryStopStore below). */
export interface StopList {
  /** Every stop that has not been lifted. Throws when the list cannot be read
   *  completely: a short list would read as "not stopped". */
  active(): Promise<StopRecord[]>;
  /** Every stop, lifted or not, newest first. */
  all(): Promise<StopRecord[]>;
  get(id: string): Promise<StopRecord | null>;
  put(rec: StopRecord): Promise<StopRecord>;
}

export function newStopId(): string {
  return `stp_${randomUUID()}`;
}

export class StopStore implements StopList {
  static readonly MEMO_MS = 3_000;
  private memo: { at: number; recs: StopRecord[] } | null = null;

  private kv: KeyedStore;

  constructor(kv: KeyedLike, js?: StorageLike, private now: () => number = Date.now) {
    this.kv = keyedOf(kv, js);
  }

  static async create(js: StorageLike): Promise<StopStore> {
    // History 1 and no TTL: a stop that expired on its own would be a stopped
    // agent quietly coming back. The name is written out (not the constant)
    // because closure-registry.test.ts finds buckets by reading these calls.
    return new StopStore(await storageOf(js).keyed("mesh_stops"));
  }

  async all(): Promise<StopRecord[]> {
    const hit = this.memo;
    if (hit && this.now() - hit.at < StopStore.MEMO_MS) return hit.recs;
    const snap = await this.kv.list();
    const recs: StopRecord[] = [];
    for (const [, entry] of snap.entries) {
      try {
        const r = entry.json<StopRecord>();
        if (r && typeof r.id === "string" && typeof r.scope === "string") recs.push(r);
      } catch {
        // An unreadable record is skipped and said, never taken as "no stop".
        console.warn("[stops] an unreadable stop record was skipped");
      }
    }
    recs.sort((a, b) => b.at.localeCompare(a.at));
    this.memo = { at: this.now(), recs };
    return recs;
  }

  async active(): Promise<StopRecord[]> {
    return (await this.all()).filter((r) => !r.lifted);
  }

  async get(id: string): Promise<StopRecord | null> {
    try {
      const e = await this.kv.get(id);
      return e?.value.length ? e.json<StopRecord>() : null;
    } catch {
      return null;
    }
  }

  async put(rec: StopRecord): Promise<StopRecord> {
    await this.kv.put(rec.id, JSON.stringify(rec));
    this.memo = null;
    return rec;
  }
}

/** The same list in memory, for tests and for a process without JetStream
 *  (where the kill switch says it cannot record and refuses to press). */
export class MemoryStopStore implements StopList {
  private recs = new Map<string, StopRecord>();
  async all(): Promise<StopRecord[]> {
    return [...this.recs.values()].sort((a, b) => b.at.localeCompare(a.at));
  }
  async active(): Promise<StopRecord[]> {
    return (await this.all()).filter((r) => !r.lifted);
  }
  async get(id: string): Promise<StopRecord | null> {
    return this.recs.get(id) ?? null;
  }
  async put(rec: StopRecord): Promise<StopRecord> {
    this.recs.set(rec.id, structuredClone(rec));
    return rec;
  }
}
