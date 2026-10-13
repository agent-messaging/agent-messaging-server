/**
 * Each stopped agent's status, for the services that are not the API
 * (docs/kill-switch-plan.md item 3; SPEC §9 registry status).
 *
 * The stop list (keychain/stop-store.ts) is the record, and the API's mint doors
 * read it live, resolving person and organization stops through the account
 * records. The registry, the rooms service and the inbox buffer hold no
 * account records and must not grow a staler copy of them, so the kill switch
 * writes the answer out per agent when it presses and lifts: one entry per
 * stopped agent key, `paused` or `terminated`, and no entry for an agent that
 * is running. A terminated entry is never removed.
 *
 * Reads are memoized briefly, the way agent-key-revocations.ts does it: a
 * stopped answer for STOPPED_MS, a running answer for RUNNING_MS, so a stop
 * placed by the API is seen by the registry within seconds.
 */
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";

export type StoppedStatus = "paused" | "terminated";

export interface AgentStatusEntry {
  status: StoppedStatus;
  /** When the stop that decides was placed. */
  since: string;
  /** The stop that decides (keychain/stop-store.ts), for the record. */
  stop_id: string;
  scope: "agent" | "person" | "org" | "mesh";
}

export interface AgentStatusLookup {
  get(agentKey: string): Promise<AgentStatusEntry | null>;
}

export class AgentStatusStore implements AgentStatusLookup {
  static readonly STOPPED_MS = 5_000;
  static readonly RUNNING_MS = 5_000;
  private memo = new Map<string, { rec: AgentStatusEntry | null; until: number }>();

  private kv: KeyedStore;

  constructor(kv: KeyedLike, private now: () => number = Date.now) {
    this.kv = keyedOf(kv);
  }

  static async create(js: StorageLike): Promise<AgentStatusStore> {
    // History 1, no TTL: an entry that expired would be a stopped agent
    // quietly running again as far as the registry could tell.
    return new AgentStatusStore(await storageOf(js).keyed("mesh_agent_status"));
  }

  async get(agentKey: string): Promise<AgentStatusEntry | null> {
    const hit = this.memo.get(agentKey);
    if (hit && hit.until > this.now()) return hit.rec;
    let rec: AgentStatusEntry | null = null;
    const e = await this.kv.get(agentKey);
    if (e?.value.length) rec = e.json<AgentStatusEntry>();
    this.memo.set(agentKey, { rec, until: this.now() + (rec ? AgentStatusStore.STOPPED_MS : AgentStatusStore.RUNNING_MS) });
    if (this.memo.size > 20_000) this.memo.clear();
    return rec;
  }

  async set(agentKey: string, rec: AgentStatusEntry): Promise<void> {
    const prior = await this.get(agentKey).catch(() => null);
    // Terminated is final: nothing downgrades it to paused.
    if (prior?.status === "terminated" && rec.status !== "terminated") return;
    await this.kv.put(agentKey, JSON.stringify(rec));
    this.memo.set(agentKey, { rec, until: this.now() + AgentStatusStore.STOPPED_MS });
  }

  /** Follow every change: each stopped agent now, then each change as it
   *  lands (null means running again). For the admission service, which
   *  answers senders on a stopped agent's behalf. Returns a stop function. */
  async follow(onChange: (agentKey: string, rec: AgentStatusEntry | null) => void): Promise<() => void> {
    const iter = await this.kv.watch();
    void (async () => {
      for await (const e of iter) {
        let rec: AgentStatusEntry | null = null;
        if (e.operation === "PUT" && e.value.length) {
          try { rec = e.json<AgentStatusEntry>(); } catch { rec = null; }
        }
        this.memo.set(e.key, { rec, until: this.now() + AgentStatusStore.STOPPED_MS });
        try { onChange(e.key, rec); } catch { /* one bad handler must not end the watch */ }
      }
    })();
    return () => iter.stop();
  }

  /** Mark an agent running again. A terminated agent stays terminated. */
  async clear(agentKey: string): Promise<boolean> {
    const prior = await this.get(agentKey).catch(() => null);
    if (prior?.status === "terminated") return false;
    await this.kv.purge(agentKey);
    this.memo.set(agentKey, { rec: null, until: this.now() + AgentStatusStore.RUNNING_MS });
    return true;
  }
}

/** The same in memory, for tests. */
export class MemoryAgentStatus implements AgentStatusLookup {
  map = new Map<string, AgentStatusEntry>();
  async get(k: string) { return this.map.get(k) ?? null; }
  async set(k: string, rec: AgentStatusEntry) {
    if (this.map.get(k)?.status === "terminated" && rec.status !== "terminated") return;
    this.map.set(k, rec);
  }
  async clear(k: string) {
    if (this.map.get(k)?.status === "terminated") return false;
    this.map.delete(k);
    return true;
  }
}
