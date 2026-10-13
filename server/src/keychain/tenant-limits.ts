/**
 * Limits and rate caps per tenant, set through the admin API (step 6 of
 * docs/agent-messaging-server-plan.md).
 *
 * One bucket, `mesh_tenant_limits`: tenant id → TenantLimits. It is kept apart
 * from `mesh_tenants` on purpose. In AgentMesh the platform rewrites a tenant's
 * record from its account store whenever the account changes, and a limit
 * stored on that record would be lost the next time it did. Here only the
 * admin API writes.
 *
 * A tenant with no entry has no limit of its own: every number below falls back
 * to the mesh's setting, so a mesh where nobody set a limit runs exactly as
 * before. What each limit reaches:
 *
 *   max_agents           the agents its ownership record lists; checked when an
 *                        agent is enrolled (the bootstrap door and the admin API)
 *   max_rooms            durable rooms counted against it (the rooms service)
 *   max_drive_bytes      bytes in those rooms' drives (the rooms service)
 *   requests_per_minute  requests to the mesh's own services from all its
 *                        agents together (shared/handler.ts). Messages between
 *                        agents go straight over NATS and are not counted.
 *
 * Each process that enforces a limit keeps the whole bucket in memory and
 * follows its changes (TenantLimitCache), so a check never waits on JetStream.
 */
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";
import { RateLimiter, type RateLimitResult } from "../shared/rate-limiter.js";
import { setTenantRateCheck } from "../shared/tenant-rate.js";
import { AgentOwnerStore, type AgentOwners } from "./agent-owners.js";

export const TENANT_LIMITS_BUCKET = "mesh_tenant_limits";

export interface TenantLimits {
  max_agents?: number;
  max_rooms?: number;
  max_drive_bytes?: number;
  requests_per_minute?: number;
}

/** The limit names, in the order they are shown. */
export const LIMIT_NAMES = ["max_agents", "max_rooms", "max_drive_bytes", "requests_per_minute"] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];

/**
 * Read a limits change from a request body. Each named limit is a whole number
 * of at least 0, or null to remove it. Returns the merged limits, or a sentence
 * saying what is wrong.
 */
export function mergeLimits(prior: TenantLimits | null, body: Record<string, unknown>): { ok: true; limits: TenantLimits } | { ok: false; error: string } {
  const out: TenantLimits = { ...(prior ?? {}) };
  const unknown = Object.keys(body).filter((k) => !(LIMIT_NAMES as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, error: `Unknown limit: ${unknown.join(", ")}. The limits are ${LIMIT_NAMES.join(", ")}.` };
  for (const name of LIMIT_NAMES) {
    if (!(name in body)) continue;
    const v = body[name];
    if (v === null) { delete out[name]; continue; }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return { ok: false, error: `${name} must be a whole number of 0 or more, or null to remove it.` };
    out[name] = v;
  }
  return { ok: true, limits: out };
}

export function hasLimits(l: TenantLimits | null | undefined): boolean {
  return !!l && LIMIT_NAMES.some((n) => typeof l[n] === "number");
}

/** Where the limits are kept. An interface so the rules can be tested without JetStream. */
export interface TenantLimitList {
  get(tenant: string): Promise<TenantLimits | null>;
  put(tenant: string, limits: TenantLimits): Promise<void>;
  remove(tenant: string): Promise<void>;
  /** Every tenant's limits. Throws when the bucket cannot be read completely. */
  all(): Promise<Map<string, TenantLimits>>;
}

export class TenantLimitStore implements TenantLimitList {
  private kv: KeyedStore;

  constructor(kv: KeyedLike, js?: StorageLike) {
    this.kv = keyedOf(kv, js);
  }

  static async create(js: StorageLike): Promise<TenantLimitStore> {
    // History 1: the current limits are the whole answer. The name is written
    // out because closure-registry.test.ts finds buckets by reading these calls.
    return new TenantLimitStore(await storageOf(js).keyed("mesh_tenant_limits"));
  }

  get bucket(): KeyedStore { return this.kv; }

  async get(tenant: string): Promise<TenantLimits | null> {
    const e = await this.kv.get(tenant);
    return e?.value.length ? e.json<TenantLimits>() : null;
  }

  async put(tenant: string, limits: TenantLimits): Promise<void> {
    if (!hasLimits(limits)) return this.remove(tenant);
    await this.kv.put(tenant, JSON.stringify(limits));
  }

  async remove(tenant: string): Promise<void> {
    await this.kv.purge(tenant);
  }

  async all(): Promise<Map<string, TenantLimits>> {
    const snap = await this.kv.list();
    const out = new Map<string, TenantLimits>();
    for (const [k, e] of snap.entries) {
      try { out.set(k, e.json<TenantLimits>()); } catch { console.warn(`[limits] an unreadable limits record was skipped (${k})`); }
    }
    return out;
  }
}

/** The same in memory, for tests. */
export class MemoryTenantLimits implements TenantLimitList {
  readonly map = new Map<string, TenantLimits>();
  async get(t: string) { return this.map.get(t) ?? null; }
  async put(t: string, l: TenantLimits) { if (hasLimits(l)) this.map.set(t, { ...l }); else this.map.delete(t); }
  async remove(t: string) { this.map.delete(t); }
  async all() { return new Map(this.map); }
}

/**
 * Every tenant's limits, in memory, kept current by following the bucket.
 * Also answers the rate cap: one window per tenant, sized to its limit.
 */
export class TenantLimitCache {
  private limits = new Map<string, TenantLimits>();
  private windows = new Map<string, { max: number; limiter: RateLimiter }>();
  private accountOf = new Map<string, { at: number; account: string | null }>();
  private stopFollow: (() => void) | null = null;

  constructor(private owners: Pick<AgentOwners, "agent"> | null, private now: () => number = Date.now) {}

  /** Replace the whole map (tests, and the first read). */
  load(all: Map<string, TenantLimits>): void {
    this.limits = new Map(all);
  }

  /** One tenant changed (null: its limits were removed). */
  apply(tenant: string, limits: TenantLimits | null): void {
    if (limits && hasLimits(limits)) this.limits.set(tenant, limits);
    else this.limits.delete(tenant);
    const w = this.windows.get(tenant);
    if (w && w.max !== limits?.requests_per_minute) this.windows.delete(tenant);
  }

  /** Follow the bucket: every entry now, then every change. */
  async follow(kv: KeyedLike): Promise<void> {
    const iter = await keyedOf(kv).watch();
    this.stopFollow = () => iter.stop();
    void (async () => {
      for await (const e of iter) {
        let l: TenantLimits | null = null;
        if (e.operation === "PUT" && e.value.length) {
          try { l = e.json<TenantLimits>(); } catch { l = null; }
        }
        this.apply(e.key, l);
      }
    })();
  }

  stop(): void {
    this.stopFollow?.();
  }

  /** A tenant's limits, or null when it has none of its own. */
  limitsFor(tenant: string | null | undefined): TenantLimits | null {
    return tenant ? this.limits.get(tenant) ?? null : null;
  }

  /** Whether any tenant has a rate cap (the check costs nothing when none does). */
  get anyRateCap(): boolean {
    for (const l of this.limits.values()) if (typeof l.requests_per_minute === "number") return true;
    return false;
  }

  /** The tenant that owns an agent, from the ownership record, kept a minute. */
  private async tenantOf(agentKey: string): Promise<string | null> {
    const hit = this.accountOf.get(agentKey);
    if (hit && this.now() - hit.at < 60_000) return hit.account;
    let account: string | null = null;
    try { account = (await this.owners?.agent(agentKey))?.account ?? null; } catch { account = hit?.account ?? null; }
    this.accountOf.set(agentKey, { at: this.now(), account });
    if (this.accountOf.size > 50_000) this.accountOf.clear();
    return account;
  }

  /**
   * The rate cap for one request from `from`: null when its tenant has none
   * (or none does), otherwise whether this request fits in the tenant's
   * minute. Every agent of the tenant shares the one window.
   */
  async rateCheck(from: string): Promise<(RateLimitResult & { tenant: string; limit: number }) | null> {
    if (!this.anyRateCap) return null;
    const tenant = await this.tenantOf(from);
    const max = this.limitsFor(tenant)?.requests_per_minute;
    if (!tenant || typeof max !== "number") return null;
    let w = this.windows.get(tenant);
    if (!w || w.max !== max) {
      w = { max, limiter: new RateLimiter(max, 60_000) };
      this.windows.set(tenant, w);
    }
    if (max === 0) return { allowed: false, retryAfterMs: 60_000, tenant, limit: max };
    return { ...w.limiter.check(tenant), tenant, limit: max };
  }
}

// ── One cache per process ───────────────────────────────────────────────

let installed: Promise<TenantLimitCache | null> | null = null;

/**
 * Open the limits once in this process, follow them, and switch on the rate
 * cap in every service handler (shared/handler.ts). Never throws: a mesh whose
 * limits cannot be read runs with none, and says so.
 */
export function installTenantLimits(js: StorageLike): Promise<TenantLimitCache | null> {
  installed ??= (async () => {
    try {
      const store = await TenantLimitStore.create(js);
      const owners = await AgentOwnerStore.create(js);
      const cache = new TenantLimitCache(owners);
      cache.load(await store.all());
      await cache.follow(store.bucket);
      setTenantRateCheck((from) => cache.rateCheck(from));
      return cache;
    } catch (err) {
      console.error(`[limits] the tenant limits could not be read, so no tenant's own limit applies in this process: ${(err as Error).message}`);
      return null;
    }
  })();
  return installed;
}

/** This process's cache, once installed; null before, or when it could not be. */
export async function tenantLimitCache(): Promise<TenantLimitCache | null> {
  return installed ? installed : null;
}
