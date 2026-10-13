/**
 * Revoked agent SIGNING keys (SPEC §5.3, docs/live-revocation-plan.md item 5).
 *
 * A credential revocation (credential-revoke.ts) ends a CONNECTION. It does
 * nothing about the agent key itself: every envelope is signed by the agent key
 * (§4.5), any connection may carry it, so a thief holding a leaked agent seed
 * can keep signing as that agent from a credential of their own. The defence is
 * on the receiving side: receivers ask the registry whether the sender's key is
 * revoked, and refuse it if it is. This is the registry's record of that.
 *
 * Revocation is permanent. There is no `clear`: a key that leaked stays
 * leaked, and an owner who revoked by mistake rotates onto a new key, which
 * costs them nothing a clear would have saved. That is also what makes the
 * holder-signed revoke door safe: whoever holds a key may end it, and ending a
 * key is the one thing a thief cannot turn against the owner.
 *
 * `replaced_by` names the key the owner moved the agent to, when they did, so a
 * receiver that refuses the old key can say where the agent went.
 */
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";

export const AGENT_KEY_REVOCATIONS_BUCKET = "mesh_agent_key_revocations";

/** The `details.reason` a refusal carries, on the registry's get and register
 *  and on a receiver's UNAUTHORIZED. One spelling everywhere. */
export const AGENT_KEY_REVOKED = "agent_key_revoked";

export interface AgentKeyRevocation {
  /** ISO-8601 instant the key was revoked. */
  at: string;
  reason: string;
  /** `holder` (the key itself signed the revocation), `owner:<account id>`,
   *  or `operator`. */
  by: string;
  /** The key the agent moved to, when the owner rotated. */
  replaced_by?: string;
}

/** What the registry handlers need: one question, answered from a short memo. */
export interface AgentKeyRevocationLookup {
  get(agentKey: string): Promise<AgentKeyRevocation | null>;
}

export class AgentKeyRevocationStore implements AgentKeyRevocationLookup {
  /** Revoked answers are kept for the life of the process (revocation is
   *  permanent); "not revoked" answers for NEGATIVE_MS, so a revocation made
   *  by another process is seen within that. */
  private memo = new Map<string, { rec: AgentKeyRevocation | null; until: number }>();
  static readonly NEGATIVE_MS = 15_000;
  private static readonly MEMO_MAX = 20_000;

  private kv: KeyedStore;

  constructor(kv: KeyedLike, private now: () => number = Date.now) {
    this.kv = keyedOf(kv);
  }

  static async create(js: StorageLike): Promise<AgentKeyRevocationStore> {
    // No TTL, history 1: the current record is the whole answer, and a
    // revocation that expired would be a stolen key quietly coming back.
    // The name is written out, not the constant: closure-registry.test.ts
    // finds every bucket by reading the calls that open one in the source.
    return new AgentKeyRevocationStore(await storageOf(js).keyed("mesh_agent_key_revocations"));
  }

  /** Record a revocation. A key already revoked keeps its first record, with
   *  `replaced_by` added when this call names one and the first did not. */
  async revoke(agentKey: string, rec: Omit<AgentKeyRevocation, "at"> & { at?: string }): Promise<AgentKeyRevocation> {
    const prior = await this.read(agentKey);
    const next: AgentKeyRevocation = prior
      ? { ...prior, ...(rec.replaced_by && !prior.replaced_by ? { replaced_by: rec.replaced_by } : {}) }
      : { at: rec.at ?? new Date(this.now()).toISOString(), reason: rec.reason, by: rec.by, ...(rec.replaced_by ? { replaced_by: rec.replaced_by } : {}) };
    await this.kv.put(agentKey, JSON.stringify(next));
    this.remember(agentKey, next);
    return next;
  }

  async get(agentKey: string): Promise<AgentKeyRevocation | null> {
    const hit = this.memo.get(agentKey);
    if (hit && (hit.rec !== null || hit.until > this.now())) return hit.rec;
    const rec = await this.read(agentKey);
    this.remember(agentKey, rec);
    return rec;
  }

  private async read(agentKey: string): Promise<AgentKeyRevocation | null> {
    const entry = await this.kv.get(agentKey);
    if (!entry || entry.operation !== "PUT" || !entry.value.length) return null;
    try {
      return entry.json<AgentKeyRevocation>();
    } catch {
      return null;
    }
  }

  private remember(agentKey: string, rec: AgentKeyRevocation | null): void {
    if (this.memo.size > AgentKeyRevocationStore.MEMO_MAX) {
      // Drop the negative answers; the revoked ones are few and permanent.
      for (const [k, v] of this.memo) if (v.rec === null) this.memo.delete(k);
    }
    this.memo.set(agentKey, { rec, until: this.now() + AgentKeyRevocationStore.NEGATIVE_MS });
  }
}
