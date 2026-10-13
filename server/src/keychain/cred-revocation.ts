/**
 * Credential revocation: the refusal to renew (SPEC §4.8).
 *
 * WHERE THIS SITS NOW (2026-09-27)
 *
 * The live mechanism is credential-revoke.ts with live-revoke.ts: the
 * connection key goes into the account JWT's `revocations`, the updated JWT is
 * pushed to the running broker on the full resolver, and the connection closes
 * within seconds. This store is step one of that action (it is written first,
 * whatever happens after) and it is the whole of the FALLBACK when the push
 * path is not configured: a revoked key is refused the next time it asks to
 * renew. That fallback is a real control with a real, statable bound:
 *
 *   **A compromised credential stays usable until it expires. With the default
 *   seven-day lifetime and renewal at two thirds, the worst case is the full
 *   remaining life of the credential in hand: up to seven days (thirty for a
 *   credential issued before 2026-09-27 that has not renewed yet), and on
 *   average about two and a half.**
 *
 * Before this, the answer was a hand edit of `resolver_preload` and a broker
 * restart that dropped every connection on the mesh (docs/our-instance.md §6.4
 * describes the migration away from that).
 *
 * WHY A TOMBSTONE AND NOT "IS IT STILL LINKED TO AN ACCOUNT"
 *
 * Account linkage alone cannot express revocation. Retiring an agent unlinks it
 * (`handleAgentRetire`), so "no account holds this key" is true both of a
 * retired agent and of a self-hosted node that was never linked to anything —
 * and refusing the second breaks nodes that are doing nothing wrong. The
 * tombstone distinguishes them: it is written when a key is deliberately taken
 * out of service, and its absence means "unknown", which is not the same as
 * "revoked".
 *
 * A tombstone is cleared automatically when the key turns up under a live
 * account again, so re-linking an agent that was retired by mistake restores it
 * without an operator touching this bucket.
 */
import { isKeyedStore, keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";

export interface CredRevocation {
  /** ISO-8601 instant the key was taken out of service. */
  at: string;
  /** Free text for whoever reads this later during an incident. */
  reason: string;
  /** Who did it: an account id, `operator`, or a subsystem name. */
  by: string;
}

/**
 * Keys that must not be issued a fresh credential.
 *
 * Keyed by AGENT public nkey, not by connection key. An agent's identity is the
 * stable thing an owner recognises and the thing every other surface (retire,
 * the console, the audit trail) already names; the connection key is an
 * implementation detail that a re-mint can change. Refusing renewal for an
 * agent refuses every credential that covers it, which is the intent.
 */
/** Whether a tombstone says the agent was retired by its owner or removed from
 *  its host: such an agent is on no list (owner, 2026-10-04). */
export function isRetirement(reason: string | undefined): boolean {
  return /^(retired\b|removed from its host\b)/i.test(reason ?? "");
}

export class CredRevocationStore {
  private kv: KeyedStore;
  /** Whether the store can be listed: a JetStream bucket handed in without
   *  the client it was opened on cannot. */
  private listable: boolean;

  constructor(kv: KeyedLike, js: StorageLike | null = null) {
    this.kv = keyedOf(kv, js ?? undefined);
    this.listable = js !== null || isKeyedStore(kv);
  }

  /** The keys of every agent retired or removed from its host. Throws when
   *  the bucket cannot be read completely. */
  async retiredKeys(): Promise<Set<string>> {
    if (!this.listable) throw new Error("listing tombstones needs a JetStream client");
    const out = new Set<string>();
    const snap = await this.kv.list();
    for (const [k, e] of snap.entries) {
      try {
        if (isRetirement(e.json<CredRevocation>().reason)) out.add(k);
      } catch { /* not a tombstone this reads */ }
    }
    return out;
  }

  static async create(js: StorageLike): Promise<CredRevocationStore> {
    // No TTL: a tombstone that expires is a revocation that quietly undoes
    // itself. History 1 — the current state is the whole answer.
    return new CredRevocationStore(await storageOf(js).keyed("mesh_cred_revocations"));
  }

  async revoke(agentKey: string, reason: string, by: string): Promise<CredRevocation> {
    const record: CredRevocation = { at: new Date().toISOString(), reason, by };
    await this.kv.put(agentKey, JSON.stringify(record));
    return record;
  }

  async get(agentKey: string): Promise<CredRevocation | null> {
    try {
      const entry = await this.kv.get(agentKey);
      if (!entry?.value.length) return null;
      return entry.json<CredRevocation>();
    } catch {
      return null;
    }
  }

  /** Lift a revocation. Called by an operator undoing a mistake, and
   *  automatically when the key reappears under a live account. */
  async clear(agentKey: string): Promise<boolean> {
    try {
      await this.kv.purge(agentKey);
      return true;
    } catch {
      return false;
    }
  }
}

/** What a renewal decision can conclude, and why. The reason strings are
 *  operator-facing: they end up in a log line and in the HTTP body the node
 *  sees, so they say what to do about it. */
export type RenewalDecision =
  | { allow: true; accountId: string | null; leftOff?: Array<{ id: string; reason: "retired" | "key_revoked" }> }
  | { allow: false; status: number; error: string };

export interface RenewalContext {
  /** The account currently holding this agent key, or null if none does. */
  holderOf(agentKey: string): Promise<{ id: string; disabled?: boolean } | null>;
  /** The tombstone for this agent key, or null. */
  revocationOf(agentKey: string): Promise<CredRevocation | null>;
  /** Best-effort tombstone cleanup once a key is seen under a live account. */
  clearRevocation?(agentKey: string): Promise<unknown>;
  /** Whether the agent's SIGNING key is revoked (agent-key-revocations.ts).
   *  Unlike a tombstone this is never lifted by re-linking: a leaked key stays
   *  leaked, and the owner moves the agent to a new key instead. */
  signingKeyRevoked?(agentKey: string): Promise<boolean>;
}

/**
 * Decide whether a node may be issued (or re-issued) a credential covering
 * `agentIds`.
 *
 * Proof-of-possession has already happened by the time this runs — the caller
 * demonstrated control of the node key and of every agent key. This is the
 * standing question on top of that: is this agent still allowed to be on the
 * mesh at all?
 *
 * The three outcomes, and why each is what it is:
 *
 *   - **Held by a live account** → allow. The ordinary case.
 *   - **Held by a DISABLED account** → refuse. Disabling an account is the
 *     operator's moderation lever, and it has until now been documented as not
 *     reaching existing credentials at all. It reaches them now, at the pace of
 *     the lease.
 *   - **Tombstoned** → refuse. The deliberate revocation.
 *   - **Held by nobody and not tombstoned** → allow. A self-hosted node that
 *     never linked to an account is not a revoked one, and the pre-existing
 *     behaviour of this door was to grant on proof-of-possession alone. Silence
 *     is not consent to refuse.
 *
 * All agents on one credential must resolve to the same account when any of
 * them resolves to one: a credential is a single blast radius, and letting one
 * node's roster straddle two tenants would make "which account is this
 * connection" unanswerable.
 */
export async function decideRenewal(
  ctx: RenewalContext,
  agentIds: string[],
  /** A node of many (the renewal door): a retired agent, or one whose key is
   *  revoked, is LEFT OFF the credential and named in `leftOff`, instead of
   *  refusing the whole roster, so retiring or terminating one agent does not
   *  take the others on its node down (docs/kill-switch-plan.md item 6). When
   *  every agent is left off, the answer is the refusal it always was. A
   *  disabled account and a roster straddling two accounts still refuse. */
  opts: { leaveOff?: boolean } = {},
): Promise<RenewalDecision> {
  let accountId: string | null = null;
  const leftOff: Array<{ id: string; reason: "retired" | "key_revoked" }> = [];
  let firstRefusal: { allow: false; status: number; error: string } | null = null;
  for (const id of agentIds) {
    if (ctx.signingKeyRevoked && (await ctx.signingKeyRevoked(id))) {
      const refusal = {
        allow: false as const,
        status: 403,
        error:
          `agent ${id.slice(0, 12)}... has a revoked key, so no credential covers it again. ` +
          `Its owner moves the agent to a new key (agentmesh key rotate); take this key off the node.`,
      };
      if (!opts.leaveOff) return refusal;
      firstRefusal ??= refusal;
      leftOff.push({ id, reason: "key_revoked" });
      continue;
    }
    const tomb = await ctx.revocationOf(id);
    const holder = await ctx.holderOf(id);

    if (holder && !holder.disabled) {
      // Live under an account: any tombstone is stale (the key was re-linked),
      // so lift it rather than leaving a trap for the next renewal.
      if (tomb && ctx.clearRevocation) await ctx.clearRevocation(id).catch(() => undefined);
      if (accountId && accountId !== holder.id) {
        return {
          allow: false,
          status: 409,
          error:
            "one credential cannot cover agents from two different accounts — " +
            "mint a credential per account",
        };
      }
      accountId = holder.id;
      continue;
    }

    if (holder?.disabled) {
      return {
        allow: false,
        status: 403,
        error:
          `the account owning agent ${id.slice(0, 12)}… is disabled, so its credential ` +
          `will not be renewed. The credential already in hand keeps working until it expires.`,
      };
    }

    if (tomb) {
      const refusal = {
        allow: false as const,
        status: 403,
        error:
          `agent ${id.slice(0, 12)}… has been retired or revoked (${tomb.reason}), so its ` +
          `credential will not be renewed. Re-link it to an account to bring it back.`,
      };
      if (!opts.leaveOff) return refusal;
      firstRefusal ??= refusal;
      leftOff.push({ id, reason: "retired" });
      continue;
    }
  }
  if (opts.leaveOff && leftOff.length) {
    if (leftOff.length === agentIds.length) return firstRefusal!;
    return { allow: true, accountId, leftOff };
  }
  return { allow: true, accountId };
}
