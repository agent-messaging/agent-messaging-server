/**
 * The agent ownership record: whose agent each key is, kept by the core.
 *
 * Step 3 of docs/agent-messaging-server-plan.md. The core server answers
 * "whose agent is this" in five places (the renewal door, the stop list, rooms,
 * clearing, the "unlisted" answer) and today every one of them reads the
 * platform's account store to do it. This record is the core's own answer, so
 * the core can give it with no platform beside it.
 *
 * Two buckets:
 *
 *   mesh_agent_owners   agent key → AgentOwnerRecord
 *   mesh_tenants        tenant (account) id → TenantRecord
 *
 * A tenant is what the core knows about an account: whether it is disabled, its
 * home organization and its owner key. The core keeps tenants as records, in
 * one NATS account (the plan's tenancy decision). Nothing here holds an email
 * address of a person except `custody.email`, which is the label the rooms
 * service shows for a hosted seat's rooms (the rooms count against the account).
 *
 * In AgentMesh the platform writes this record whenever the account store
 * changes something that affects ownership (api/owner-projection.ts), and fills
 * it once from the account store at start. A core run alone writes it through
 * its admin API (plan step 6). The platform calls this module rather than
 * opening the buckets, so the core is the only code that names them.
 */
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";

export const AGENT_OWNERS_BUCKET = "mesh_agent_owners";
export const TENANTS_BUCKET = "mesh_tenants";

/** Whose one agent is. */
export interface AgentOwnerRecord {
  /** The agent's public key. */
  key: string;
  /** The tenant (account) that owns it: the one a credential for it is minted
   *  under, and the one its charges go to. Null when no account holds it. */
  account: string | null;
  /** The organization holding it, when an organization does. */
  org: string | null;
  /** For an agent its account still holds directly (not yet moved onto an
   *  organization): that account's home organization. Null otherwise. */
  home_org: string | null;
  /** The person a stop placed on a person reaches it through: the account an
   *  organization is the home of, or the account holding it directly. Null for
   *  an agent an organization owns that is nobody's home. */
  person: string | null;
  /** Its category (Mesh System, Mesh Provided, Account, Mesh Internal Test,
   *  Mesh Demo), as the platform decides it. Null when no account or
   *  organization lists it. */
  category: string | null;
  /** Whether it may appear wherever agents are listed. A test agent, an
   *  archived agent and one in the trash are not, nor one held back below. */
  listed: boolean;
  /** Kept off every list by the platform for a reason of its own, whoever
   *  holds it (the ring's model gateway, which only ring members may use). */
  held_back?: boolean;
  /** Its owner's label for it, when it has one. */
  label: string | null;
  /** A seat whose seed the platform holds for an account (a hosted web
   *  agent): which account, and the label its rooms are counted against. */
  custody: { account: string; email: string | null } | null;
  /** The account its charges go to. Usually `account`; it differs for an
   *  organization whose billing account has gone, for a tenant's owner key,
   *  and for a hosted seat nobody lists. */
  payer: string | null;
  updated_at: string;
}

/** What the core knows about a tenant. */
export interface TenantRecord {
  id: string;
  /** A disabled tenant's agents get no new credential. */
  disabled: boolean;
  /** The tenant's home organization, when it has one. */
  home_org: string | null;
  /** The key the tenant's person signs with, when there is one. */
  owner_key: string | null;
  updated_at: string;
}

// ─── The answers the record gives ─────────────────────────────────────
//
// Each reader asks one of these, so every reader reads the record one way.

/** The tenant a credential for this agent is minted under (the renewal door). */
export function ownerAccountOf(rec: AgentOwnerRecord | null): string | null {
  return rec?.account ?? null;
}

/** Where a stop placed above one agent reaches it (the stop list). Null when
 *  no account or organization lists the agent, so only a stop on the agent
 *  itself, or on the whole mesh, covers it. */
export function stopPlaceOf(rec: AgentOwnerRecord | null): { key: string; person: string | null; org: string | null; category: string; label?: string } | null {
  if (!rec || rec.category === null) return null;
  return {
    key: rec.key,
    person: rec.person,
    org: rec.org ?? rec.home_org,
    category: rec.category,
    ...(rec.label !== null ? { label: rec.label } : {}),
  };
}

/** The operator label for a hosted seat's rooms (rooms): its email, else `account:<id>`.
 *  The limits are counted per account (roomAccountOf); this is the label shown. */
export function roomOperatorOf(rec: AgentOwnerRecord | null): string | null {
  if (!rec?.custody) return null;
  return rec.custody.email ?? `account:${rec.custody.account}`;
}

/** The account that owns an agent, for rooms: the account holding it, else the
 *  account a hosted seat's seed is held for. Any agent with one may open a
 *  durable room, and its rooms count against that account (decided 2026-10-12). */
export function roomAccountOf(rec: AgentOwnerRecord | null): string | null {
  return rec?.account ?? rec?.custody?.account ?? null;
}

/** What a durable room's limits are counted against: `account:<id>` when an
 *  account owns its creator, else the operator label the room was opened under
 *  (an email from the creator's name, for an agent no account owns). Null when
 *  neither is known. */
export function roomQuotaHolder(account: string | null | undefined, operator: string | null | undefined): string | null {
  if (account) return `account:${account}`;
  return operator || null;
}

/** Whether the agent may be listed (the "unlisted" answer). An agent nobody lists is not held back. */
export function listedOf(rec: AgentOwnerRecord | null): boolean {
  return rec ? rec.listed : true;
}

/** Which account an agent's charges go to (clearing). */
export function payerOf(rec: AgentOwnerRecord | null): string | null {
  return rec?.payer ?? null;
}

/** The fields that carry meaning; `updated_at` is bookkeeping. */
export function sameOwner(a: AgentOwnerRecord | null, b: AgentOwnerRecord | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.key === b.key &&
    a.account === b.account &&
    a.org === b.org &&
    a.home_org === b.home_org &&
    a.person === b.person &&
    a.category === b.category &&
    a.listed === b.listed &&
    !!a.held_back === !!b.held_back &&
    a.label === b.label &&
    (a.custody?.account ?? null) === (b.custody?.account ?? null) &&
    (a.custody?.email ?? null) === (b.custody?.email ?? null) &&
    (a.payer ?? null) === (b.payer ?? null)
  );
}

export function sameTenant(a: TenantRecord | null, b: TenantRecord | null): boolean {
  if (!a || !b) return a === b;
  return a.id === b.id && a.disabled === b.disabled && a.home_org === b.home_org && a.owner_key === b.owner_key;
}

/** Where the record is kept. An interface so the rules can be tested without JetStream. */
export interface AgentOwners {
  agent(key: string): Promise<AgentOwnerRecord | null>;
  putAgent(rec: AgentOwnerRecord): Promise<void>;
  removeAgent(key: string): Promise<void>;
  /** Every record. Throws when the bucket cannot be read completely. */
  allAgents(): Promise<Map<string, AgentOwnerRecord>>;
  tenant(id: string): Promise<TenantRecord | null>;
  putTenant(rec: TenantRecord): Promise<void>;
  removeTenant(id: string): Promise<void>;
  /** Every tenant. Throws when the bucket cannot be read completely. */
  allTenants(): Promise<Map<string, TenantRecord>>;
}

export class AgentOwnerStore implements AgentOwners {
  private agents: KeyedStore;
  private tenants: KeyedStore;

  constructor(agents: KeyedLike, tenants: KeyedLike, js?: StorageLike) {
    this.agents = keyedOf(agents, js);
    this.tenants = keyedOf(tenants, js);
  }

  static async create(js: StorageLike): Promise<AgentOwnerStore> {
    // History 1 (storage/catalog.ts), and removal purges: a record carries
    // account ids, and an old revision left on the stream would outlive the
    // account it names. The names are written out (not the constants) because
    // closure-registry.test.ts finds buckets by reading these calls.
    const storage = storageOf(js);
    const agents = await storage.keyed("mesh_agent_owners");
    const tenants = await storage.keyed("mesh_tenants");
    return new AgentOwnerStore(agents, tenants);
  }

  async agent(key: string): Promise<AgentOwnerRecord | null> {
    const e = await this.agents.get(key);
    return e?.value.length ? e.json<AgentOwnerRecord>() : null;
  }

  async putAgent(rec: AgentOwnerRecord): Promise<void> {
    await this.agents.put(rec.key, JSON.stringify(rec));
  }

  async removeAgent(key: string): Promise<void> {
    await this.agents.purge(key);
  }

  async allAgents(): Promise<Map<string, AgentOwnerRecord>> {
    const snap = await this.agents.list();
    const out = new Map<string, AgentOwnerRecord>();
    for (const [k, e] of snap.entries) {
      try {
        out.set(k, e.json<AgentOwnerRecord>());
      } catch {
        console.warn(`[owners] an unreadable ownership record was skipped (${k.slice(0, 12)}…)`);
      }
    }
    return out;
  }

  async tenant(id: string): Promise<TenantRecord | null> {
    const e = await this.tenants.get(id);
    return e?.value.length ? e.json<TenantRecord>() : null;
  }

  async putTenant(rec: TenantRecord): Promise<void> {
    await this.tenants.put(rec.id, JSON.stringify(rec));
  }

  async removeTenant(id: string): Promise<void> {
    await this.tenants.purge(id);
  }

  async allTenants(): Promise<Map<string, TenantRecord>> {
    const snap = await this.tenants.list();
    const out = new Map<string, TenantRecord>();
    for (const [k, e] of snap.entries) {
      try {
        out.set(k, e.json<TenantRecord>());
      } catch {
        console.warn(`[owners] an unreadable tenant record was skipped (${k})`);
      }
    }
    return out;
  }
}

/** The same record in memory, for tests. */
export class MemoryAgentOwners implements AgentOwners {
  readonly agents = new Map<string, AgentOwnerRecord>();
  readonly tenants = new Map<string, TenantRecord>();
  async agent(key: string) { return this.agents.get(key) ?? null; }
  async putAgent(rec: AgentOwnerRecord) { this.agents.set(rec.key, structuredClone(rec)); }
  async removeAgent(key: string) { this.agents.delete(key); }
  async allAgents() { return new Map(this.agents); }
  async tenant(id: string) { return this.tenants.get(id) ?? null; }
  async putTenant(rec: TenantRecord) { this.tenants.set(rec.id, structuredClone(rec)); }
  async removeTenant(id: string) { this.tenants.delete(id); }
  async allTenants() { return new Map(this.tenants); }
}
