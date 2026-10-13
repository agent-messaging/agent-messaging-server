/**
 * The core's admin API (step 6 of docs/agent-messaging-server-plan.md): the
 * key chain and tenants, managed by the mesh's operator. It manages agents,
 * not people; people stay in the company's own identity system.
 *
 * Served by the core's mesh API (keychain/mesh-api.ts) under /admin/v1, behind
 * an admin token (admin-auth.ts). The CLI is server/tools/mesh-admin.mjs.
 *
 *   GET    /admin/v1/status                      what this mesh is and holds
 *
 *   GET    /admin/v1/tenants                     list tenants
 *   POST   /admin/v1/tenants                     create one {id?, home_org?, owner_key?, limits?}
 *   GET    /admin/v1/tenants/:id                 one tenant, its limits and agents
 *   PATCH  /admin/v1/tenants/:id                 {disabled?, home_org?, owner_key?}
 *   DELETE /admin/v1/tenants/:id                 only when it owns no agent
 *   PUT    /admin/v1/tenants/:id/limits          {max_agents?, max_rooms?, max_drive_bytes?, requests_per_minute?}
 *   POST   /admin/v1/tenants/:id/enroll-keys     {label, name?}: a one-time enrollment key,
 *                                                the tenant's first credentials (agentmesh up <key>)
 *
 *   GET    /admin/v1/agents?tenant=              list agents (the ownership record)
 *   GET    /admin/v1/agents/:key                 one agent: owner, standing, credentials, admission
 *   PUT    /admin/v1/agents/:key                 enroll {tenant, label?, listed?, org?}
 *   PATCH  /admin/v1/agents/:key                 {tenant?, label?, listed?}: ownership and visibility
 *   DELETE /admin/v1/agents/:key                 remove {reason?}: credentials revoked, deregistered, record removed
 *   GET    /admin/v1/agents/:key/admission       its admission policy
 *   PUT    /admin/v1/agents/:key/admission       {defaults?, entries?, limits?}
 *
 *   GET    /admin/v1/credentials?agent=&tenant=  list node credentials (never a secret)
 *   POST   /admin/v1/credentials                 mint {agents, label?} on a fresh key
 *   POST   /admin/v1/credentials/revoke          {agent | tenant | key, reason?}
 *   POST   /admin/v1/credentials/restore         {agent | tenant}
 *   POST   /admin/v1/agent-keys/revoke           {agent, reason}: a leaked signing key, no undo
 *
 *   GET    /admin/v1/audit?agent=&tenant=&limit=&verify=1
 *
 *   GET    /admin/v1/trust, GET|POST /admin/v1/tenants/:id/trust,
 *   DELETE /admin/v1/tenants/:id/trust/:trustId, GET /admin/v1/agents/:key/identity
 *                                                the identity systems a tenant trusts and
 *                                                where an agent's identity came from (admin-trust.ts)
 *
 * And the read routes in admin-reads.ts and the operator views in
 * admin-views.ts (step 10a): what the core holds, for
 * its operator and for a platform running beside it.
 *
 * Revoking an agent's or a tenant's credentials is the kill switch's network
 * cut: a stop on the stop list, on the operator's authority, that every mint
 * door reads, and every connection carrying the agents revoked at the broker
 * as of now. Revoking one connection key cuts that credential only, and its
 * agent stays in good standing. Enrolling an agent, or restoring it, lifts
 * this API's stops on it.
 *
 * Each route answers { status, body } and never throws.
 *
 * Nothing here names a broker: every store is reached through the core's own
 * interfaces (AdminDeps), and the broker cut through `cut`, so a storage layer
 * for another binding (RabbitMQ and a database) plugs in under the same API.
 */
import { randomBytes } from "node:crypto";
import { nkeys } from "../sdk.js";
import { coreCapabilities } from "../shared/capabilities.js";
import { metrics } from "../shared/ops-events.js";
import { credsFileText } from "../shared/creds-file.js";
import type { AgentKeyRevocationLookup } from "../shared/agent-key-revocations.js";
import type { AgentStatusEntry } from "../shared/agent-status.js";
import { stopPlaceOf, type AgentOwnerRecord, type AgentOwners, type TenantRecord } from "../keychain/agent-owners.js";
import type { AgentKeyRevokeResult } from "../keychain/agent-key-rotate.js";
import type { CredRevocation } from "../keychain/cred-revocation.js";
import { decideRenewal } from "../keychain/cred-revocation.js";
import type { TrackedCred } from "../keychain/cred-renewal-watch.js";
import { NODE_CREDENTIAL_MAX_AGENTS } from "../keychain/cred-template.js";
import type { CredentialRevokeInput, CredentialRevokeResult } from "../keychain/credential-revoke.js";
import { agentLimitRefusal, type DoorAnswer, type Holder } from "../keychain/doors.js";
import type { CutResult } from "../keychain/kill-switch-cut.js";
import { mintNodeCredential } from "../keychain/node-mint.js";
import { ADMIN_VIA, type StopRecord, type StopScope } from "../keychain/stop-record.js";
import { covers, mintRefusal, type StopFinding } from "../keychain/stop-rules.js";
import { newStopId, type StopList } from "../keychain/stop-store.js";
import { LIMIT_NAMES, mergeLimits, type TenantLimitList, type TenantLimits } from "../keychain/tenant-limits.js";
import type { AdminReads } from "./admin-reads.js";
import type { AdminViews } from "./admin-views.js";
import type { AdminAdmission } from "./admin-admission.js";
import type { AdminOwners } from "./admin-owners.js";
import type { AdminAuditRoutes } from "./admin-audit.js";
import type { AdminCredentials } from "./admin-credentials.js";
import type { AdminKeychain } from "./admin-keychain.js";
import type { AdminUsage } from "./admin-usage.js";
import type { AdminStreams } from "./admin-streams.js";
import type { AdminTrust } from "./admin-trust.js";

const NKEY = /^U[A-Z2-7]{55}$/;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.=-]{0,127}$/;
const STANCES = new Set(["allow", "hold", "block"]);

/** What the admin API says on every ownership write when the AgentMesh
 *  platform runs beside the core and keeps its own record of accounts. */
export const PLATFORM_NOTE =
  "The AgentMesh platform runs beside this mesh and keeps its own record of accounts and their agents. " +
  "It writes that record over this one when an account changes, and in full when it starts, so make lasting changes to accounts there.";

/** The audit log, as the admin API reads it (activity/audit-log.ts). */
export interface AuditReader {
  list(agentIds: string[], limit?: number): unknown[];
  verifyChain(agentId: string): { ok: boolean; count: number; brokenAt?: number };
}

export interface AdminDeps {
  owners: AgentOwners;
  limits: TenantLimitList;
  bootTokens: { put(token: string, accountId: string, label: string, name?: string): Promise<void> };
  tombstones: { get(k: string): Promise<CredRevocation | null>; clear(k: string): Promise<unknown> };
  keyRevocations: AgentKeyRevocationLookup;
  agentStatus: { get(k: string): Promise<AgentStatusEntry | null>; set(k: string, rec: AgentStatusEntry): Promise<void>; clear(k: string): Promise<boolean> };
  stops: StopList;
  mintLog: { all(): Promise<TrackedCred[]>; recordMint(m: { key: string; agents: string[]; label?: string; expiresAt: string | null; door: "admin"; account?: string | null }): Promise<void> };
  admission: { get(k: string): Promise<Record<string, unknown> | null>; putAuthorized(k: string, roster: Record<string, unknown>, authored: "admin"): Promise<void> };
  /** The credential doors' standing questions (keychain/doors.ts). */
  holderOf(k: string): Promise<Holder | null>;
  stopsFor(keys: string[]): Promise<Map<string, StopFinding>>;
  /** The one revoke action (keychain/credential-revoke.ts) wired to this process. */
  revokeCredential(input: CredentialRevokeInput): Promise<CredentialRevokeResult>;
  /** The signing key revoke (doors.ts revokeAgentKeyAction). */
  revokeAgentKey(key: string, reason: string, by: string): Promise<AgentKeyRevokeResult>;
  /** The transport cut (keychain/kill-switch-cut.ts cutConnections) wired to this process. */
  cut(keys: string[]): Promise<CutResult>;
  /** The audit log, when it is on this host. */
  audit(): AuditReader | null;
  /** The seed a credential is minted with (keychain/split-keys.ts customerMintSeed). */
  mintSeed(): { ok: true; seed: string } | { ok: false; status: number; error: string };
  issuerAccount?: string;
  /** The `mesh` block a minted credential comes back with. */
  meshInfo(): Record<string, unknown>;
  /** Facts for the status answer: live revocation, the platform. */
  facts(): Record<string, unknown>;
  /** The AgentMesh platform runs beside the core (PLATFORM_STEPS_URL). */
  platformBeside: boolean;
  /** The read routes (admin-reads.ts), when this process can read the stores. */
  reads?: AdminReads;
  /** The operator views (admin-views.ts): rooms, files, boards, tasks, mailboxes. */
  views?: AdminViews;
  /** The admission routes (admin-admission.ts): whole rosters and the held ledger. */
  admissionRoutes?: AdminAdmission;
  /** The ownership record, record by record (admin-owners.ts). */
  ownerRecords?: AdminOwners;
  /** The audit log's routes for a platform beside the core (admin-audit.ts). */
  auditRoutes?: AdminAuditRoutes;
  /** Issuing a credential for a key the caller holds (admin-credentials.ts). */
  credentialRoutes?: AdminCredentials;
  /** The key chain's records and broker actions for a platform beside the core (admin-keychain.ts). */
  keychainRoutes?: AdminKeychain;
  /** The usage store's Monitor tables for a platform beside the core (admin-usage.ts). */
  usageRoutes?: AdminUsage;
  /** The event streams by sequence, and the core scheduler's run records (admin-streams.ts). */
  streamRoutes?: AdminStreams;
  /** The trust records and identity sources (admin-trust.ts). */
  trustRoutes?: AdminTrust;
  now?: () => number;
}

export interface AdminRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  /** The admin token's name, for the record. */
  caller: string;
}

const ok = (body: Record<string, unknown>, status = 200): DoorAnswer => ({ status, body });
const no = (status: number, error: string, extra: Record<string, unknown> = {}): DoorAnswer => ({ status, body: { error, ...extra } });
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A credential as the admin API shows it: never a secret. */
function credView(c: TrackedCred): Record<string, unknown> {
  return {
    key: c.key,
    agents: c.agents,
    ...(c.label ? { label: c.label } : {}),
    issued_at: c.issuedAt,
    expires_at: c.expiresAt,
    renewals: c.renewals,
    ...(c.account ? { tenant: c.account } : {}),
  };
}

function agentView(r: AgentOwnerRecord): Record<string, unknown> {
  return { key: r.key, tenant: r.account, account: r.account, org: r.org, label: r.label, listed: r.listed, category: r.category, updated_at: r.updated_at };
}

export function adminApi(deps: AdminDeps) {
  const now = deps.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const by = (caller: string) => `admin:${caller}`;
  const noted = (body: Record<string, unknown>) => (deps.platformBeside ? { ...body, note: PLATFORM_NOTE } : body);

  const record = (caller: string, what: string, target: string, meta: Record<string, unknown> = {}) => {
    console.log(`[admin] ${caller}: ${what} ${target.length > 40 ? `${target.slice(0, 12)}…` : target}`);
    metrics.event({ kind: "admin_action", actor: `admin:${caller}`, target, meta: { what, ...meta } });
  };

  const agentsOf = async (tenant: string): Promise<AgentOwnerRecord[]> =>
    [...(await deps.owners.allAgents()).values()].filter((r) => r.account === tenant);

  /** The agents a stop on this scope and target covers, by the mint doors' rule. */
  const coveredBy = async (scope: StopScope, target: string): Promise<string[]> => {
    if (scope === "agent") return [target];
    const out: string[] = [];
    for (const r of (await deps.owners.allAgents()).values()) {
      const place = stopPlaceOf(r);
      if (place && covers({ scope, target }, place)) out.push(r.key);
    }
    return out;
  };

  // ── Status ──────────────────────────────────────────────────────────

  async function status(caller: string): Promise<DoorAnswer> {
    const caps = coreCapabilities();
    const [tenants, agents, creds, stops] = await Promise.all([
      deps.owners.allTenants().then((m) => m.size).catch(() => null),
      deps.owners.allAgents().then((m) => m.size).catch(() => null),
      deps.mintLog.all().then((l) => l.length).catch(() => null),
      deps.stops.active().catch(() => null),
    ]);
    return ok({
      mesh: deps.meshInfo().name ?? null,
      agent_messaging: caps.agent_messaging,
      profile: caps.profile,
      protocol: caps.protocol,
      tenancy: caps.tenancy,
      server: caps.server ?? null,
      platform_beside: deps.platformBeside,
      ...deps.facts(),
      counts: {
        tenants,
        agents,
        credentials: creds,
        stops_in_force: stops ? stops.length : null,
        revoked_by_admin: stops ? stops.filter((s) => s.via === ADMIN_VIA).length : null,
      },
      token: caller,
    });
  }

  // ── Tenants ─────────────────────────────────────────────────────────

  async function listTenants(): Promise<DoorAnswer> {
    const [tenants, agents, limits] = await Promise.all([deps.owners.allTenants(), deps.owners.allAgents(), deps.limits.all()]);
    const count = new Map<string, number>();
    for (const r of agents.values()) if (r.account) count.set(r.account, (count.get(r.account) ?? 0) + 1);
    const list = [...tenants.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => ({ id: t.id, disabled: t.disabled, home_org: t.home_org, agents: count.get(t.id) ?? 0, limits: limits.get(t.id) ?? {} }));
    return ok({ tenants: list });
  }

  async function createTenant(b: Record<string, unknown>, caller: string): Promise<DoorAnswer> {
    const id = str(b.id) ?? `tenant_${randomBytes(8).toString("hex")}`;
    if (!TENANT_ID.test(id)) return no(400, "A tenant id is 1 to 128 letters, digits, dots, dashes, underscores or equals signs, starting with a letter or digit.");
    const ownerKey = str(b.owner_key);
    if (ownerKey && !NKEY.test(ownerKey)) return no(400, "owner_key must be a user public key (U followed by 55 characters).");
    if (await deps.owners.tenant(id)) return no(409, `Tenant ${id} already exists.`);
    let limits: TenantLimits | null = null;
    if (b.limits !== undefined) {
      if (!b.limits || typeof b.limits !== "object" || Array.isArray(b.limits)) return no(400, "limits must be an object.");
      const m = mergeLimits(null, b.limits as Record<string, unknown>);
      if (!m.ok) return no(400, m.error);
      limits = m.limits;
    }
    const rec: TenantRecord = { id, disabled: false, home_org: str(b.home_org), owner_key: ownerKey, updated_at: iso() };
    await deps.owners.putTenant(rec);
    if (limits) await deps.limits.put(id, limits);
    record(caller, "created tenant", id);
    return ok(noted({ tenant: { ...rec, limits: limits ?? {} } }), 201);
  }

  async function showTenant(id: string): Promise<DoorAnswer> {
    const t = await deps.owners.tenant(id);
    if (!t) return no(404, `No tenant ${id} on this mesh.`);
    const [limits, agents] = await Promise.all([deps.limits.get(id), agentsOf(id)]);
    return ok({ tenant: { ...t, limits: limits ?? {} }, agents: agents.map(agentView) });
  }

  async function patchTenant(id: string, b: Record<string, unknown>, caller: string): Promise<DoorAnswer> {
    const t = await deps.owners.tenant(id);
    if (!t) return no(404, `No tenant ${id} on this mesh.`);
    const next: TenantRecord = { ...t };
    if ("disabled" in b) {
      if (typeof b.disabled !== "boolean") return no(400, "disabled must be true or false.");
      next.disabled = b.disabled;
    }
    if ("home_org" in b) next.home_org = str(b.home_org);
    if ("owner_key" in b) {
      const k = str(b.owner_key);
      if (k && !NKEY.test(k)) return no(400, "owner_key must be a user public key (U followed by 55 characters).");
      next.owner_key = k;
    }
    next.updated_at = iso();
    await deps.owners.putTenant(next);
    record(caller, next.disabled !== t.disabled ? (next.disabled ? "disabled tenant" : "enabled tenant") : "changed tenant", id);
    const words = next.disabled && !t.disabled
      ? "Its agents get no new credential from now on. To cut the connections they hold now as well, revoke the tenant's credentials."
      : undefined;
    return ok(noted({ tenant: next, ...(words ? { what_now: words } : {}) }));
  }

  async function deleteTenant(id: string, caller: string): Promise<DoorAnswer> {
    const t = await deps.owners.tenant(id);
    if (!t) return no(404, `No tenant ${id} on this mesh.`);
    const agents = await agentsOf(id);
    if (agents.length) return no(409, `Tenant ${id} still owns ${agents.length} agent${agents.length === 1 ? "" : "s"}. Remove ${agents.length === 1 ? "it" : "them"} first.`, { agents: agents.map((a) => a.key) });
    await deps.owners.removeTenant(id);
    await deps.limits.remove(id);
    record(caller, "deleted tenant", id);
    return ok(noted({ deleted: id }));
  }

  async function putLimits(id: string, b: Record<string, unknown>, caller: string): Promise<DoorAnswer> {
    if (!(await deps.owners.tenant(id))) return no(404, `No tenant ${id} on this mesh.`);
    const m = mergeLimits(await deps.limits.get(id), b);
    if (!m.ok) return no(400, m.error);
    await deps.limits.put(id, m.limits);
    record(caller, "set limits for tenant", id, { limits: m.limits });
    return ok({ tenant: id, limits: m.limits, names: [...LIMIT_NAMES] });
  }

  async function enrollKey(id: string, b: Record<string, unknown>, caller: string): Promise<DoorAnswer> {
    const t = await deps.owners.tenant(id);
    if (!t) return no(404, `No tenant ${id} on this mesh.`);
    if (t.disabled) return no(409, `Tenant ${id} is disabled. Enable it first.`);
    const label = str(b.label);
    if (!label || label.length > 120) return no(400, "Give the agent a label of up to 120 characters, so you can tell it apart later.");
    const name = str(b.name) ?? undefined;
    if (name && !/^[^\s@]{1,64}$/.test(name)) return no(400, "name must be up to 64 characters with no spaces and no @.");
    const key = `am_${randomBytes(24).toString("base64url")}`;
    await deps.bootTokens.put(key, id, label, name);
    record(caller, "made an enrollment key for tenant", id, { label });
    return ok({
      key,
      tenant: id,
      label,
      single_use: true,
      expires_in_days: 7,
      how: "Give the key to one agent. It enrolls with: agentmesh up <key> (or POST /v1/bootstrap with the key and its public key).",
    }, 201);
  }

  // ── Agents ──────────────────────────────────────────────────────────

  async function listAgents(q: URLSearchParams): Promise<DoorAnswer> {
    const tenant = str(q.get("tenant"));
    let list = [...(await deps.owners.allAgents()).values()];
    if (tenant) list = list.filter((r) => r.account === tenant);
    list.sort((a, b) => (a.account ?? "").localeCompare(b.account ?? "") || (a.label ?? "").localeCompare(b.label ?? "") || a.key.localeCompare(b.key));
    return ok({ agents: list.map(agentView) });
  }

  async function showAgent(key: string): Promise<DoorAnswer> {
    const [rec, tomb, keyRev, st, creds, roster] = await Promise.all([
      deps.owners.agent(key),
      deps.tombstones.get(key).catch(() => null),
      deps.keyRevocations.get(key).catch(() => null),
      deps.agentStatus.get(key).catch(() => null),
      deps.mintLog.all().catch(() => [] as TrackedCred[]),
      deps.admission.get(key).catch(() => null),
    ]);
    let stops: StopFinding | undefined;
    try { stops = (await deps.stopsFor([key])).get(key); } catch { stops = undefined; }
    return ok({
      agent: key,
      owner: rec ? agentView(rec) : null,
      standing: {
        revoked: tomb ? { at: tomb.at, reason: tomb.reason, by: tomb.by } : null,
        signing_key_revoked: keyRev ? { at: keyRev.at } : null,
        stopped: stops ? { action: stops.action, since: stops.stop.at, scope: stops.stop.scope, by_admin: stops.stop.via === ADMIN_VIA, why: stops.stop.why } : null,
        status: st?.status ?? "running",
      },
      credentials: creds.filter((c) => c.agents.includes(key)).map(credView),
      admission: roster ?? null,
    });
  }

  /** Lift every stop this API placed on exactly this scope and target. */
  async function liftAdminStops(scope: StopScope, target: string, caller: string, why: string | null): Promise<{ lifted: StopRecord[]; resumed: string[]; cut: string | null }> {
    const active = await deps.stops.active();
    const mine = active.filter((s) => s.via === ADMIN_VIA && s.scope === scope && s.target === target);
    if (!mine.length) return { lifted: [], resumed: [], cut: null };
    const at = iso();
    for (const s of mine) {
      s.lifted = { at, by: { authority: "operator" }, via: ADMIN_VIA, ...(why ? { why } : {}) };
      await deps.stops.put(s);
    }
    // Who runs again: covered, and held by no other stop still in force.
    const covered = await coveredBy(scope, target);
    let still: Map<string, StopFinding> = new Map();
    try { still = await deps.stopsFor(covered); } catch { /* the doors read the list again at the next mint */ }
    const resumed = covered.filter((k) => !still.has(k));
    for (const k of resumed) await deps.agentStatus.clear(k).catch(() => false);
    // A node that kept running without them re-mints at once, with them back.
    const keys = [...new Set(mine.flatMap((s) => s.cut_keys ?? []))];
    const recut = keys.length ? await deps.cut(keys).catch((err) => ({ mode: "none" as const, user_keys: 0, shared: 0, note: (err as Error).message })) : null;
    record(caller, `lifted ${mine.length} revoke(s) on ${scope}`, target, { resumed: resumed.length });
    return { lifted: mine, resumed, cut: recut?.note ?? null };
  }

  async function enrollAgent(key: string, b: Record<string, unknown>, caller: string): Promise<DoorAnswer> {
    const tenantId = str(b.tenant);
    if (!tenantId) return no(400, "Say which tenant the agent belongs to (tenant).");
    const tenant = await deps.owners.tenant(tenantId);
    if (!tenant) return no(404, `No tenant ${tenantId} on this mesh. Create it first.`);
    if (await deps.keyRevocations.get(key).catch(() => null)) {
      return no(409, "This agent's signing key was revoked, so it cannot come back on this key. Its owner makes a new key and enrolls that.");
    }
    const prior = await deps.owners.agent(key);
    if (prior?.account && prior.account !== tenantId) {
      return no(409, `This agent is enrolled under tenant ${prior.account}. To move it, change its tenant (PATCH, or mesh-admin agents set --tenant).`);
    }
    if ("listed" in b && typeof b.listed !== "boolean") return no(400, "listed must be true or false.");
    const limit = await agentLimitRefusal({ owners: deps.owners, limits: deps.limits }, tenantId, key);
    if (limit) return no(403, limit.error, { code: limit.code });
    // Enrolling again under the same tenant keeps what the record already
    // says about where the agent sits; only a new agent is placed here.
    const same = prior?.account === tenantId;
    const org = str(b.org) ?? prior?.org ?? null;
    const rec: AgentOwnerRecord = {
      key,
      account: tenantId,
      org,
      home_org: same && !str(b.org) ? prior!.home_org : org ? null : tenant.home_org,
      person: same ? prior!.person : tenantId,
      category: prior?.category ?? "account",
      listed: typeof b.listed === "boolean" ? b.listed : prior?.listed ?? true,
      ...(prior?.held_back ? { held_back: true } : {}),
      label: str(b.label) ?? prior?.label ?? null,
      custody: prior?.custody ?? null,
      payer: same ? prior!.payer : tenantId,
      updated_at: iso(),
    };
    await deps.owners.putAgent(rec);
    const tomb = await deps.tombstones.get(key).catch(() => null);
    if (tomb) await deps.tombstones.clear(key);
    const lifted = await liftAdminStops("agent", key, caller, "enrolled again");
    record(caller, prior ? "enrolled again" : "enrolled agent", key, { tenant: tenantId });
    const back = tomb || lifted.lifted.length
      ? "It may have a credential again: its node gets one at its next renewal, or enrolls with an enrollment key."
      : "It gets a credential through an enrollment key (mesh-admin tenants key), its node's renewal, or mesh-admin credentials mint.";
    return ok(noted({ agent: agentView(rec), revoke_lifted: !!tomb || lifted.lifted.length > 0, what_now: back }), prior ? 200 : 201);
  }

  async function patchAgent(key: string, b: Record<string, unknown>, caller: string): Promise<DoorAnswer> {
    const prior = await deps.owners.agent(key);
    if (!prior) return no(404, "This agent is not enrolled on this mesh. Enroll it first.");
    const next: AgentOwnerRecord = { ...prior };
    if ("listed" in b) {
      if (typeof b.listed !== "boolean") return no(400, "listed must be true or false.");
      next.listed = b.listed;
    }
    if ("label" in b) next.label = str(b.label);
    const tenantId = str(b.tenant);
    if (tenantId && tenantId !== prior.account) {
      const tenant = await deps.owners.tenant(tenantId);
      if (!tenant) return no(404, `No tenant ${tenantId} on this mesh.`);
      const limit = await agentLimitRefusal({ owners: deps.owners, limits: deps.limits }, tenantId, key);
      if (limit) return no(403, limit.error, { code: limit.code });
      Object.assign(next, { account: tenantId, person: tenantId, payer: tenantId, org: null, home_org: tenant.home_org });
    }
    next.updated_at = iso();
    await deps.owners.putAgent(next);
    record(caller, "changed agent", key, { tenant: next.account, listed: next.listed });
    const moved = next.account !== prior.account
      ? "Its next credential is minted under the new tenant. A node carrying agents of the old tenant too must take them on separate credentials."
      : undefined;
    return ok(noted({ agent: agentView(next), ...(moved ? { what_now: moved } : {}) }));
  }

  async function removeAgent(key: string, b: Record<string, unknown>, caller: string): Promise<DoorAnswer> {
    const prior = await deps.owners.agent(key);
    const reason = str(b.reason);
    const out = await deps.revokeCredential({
      agentKey: key,
      reason: `retired by the operator${reason ? `: ${reason}` : ""}`,
      by: by(caller),
      refuseRenewal: true,
      deregister: true,
    });
    if (prior) await deps.owners.removeAgent(key);
    record(caller, "removed agent", key, { mode: out.mode });
    return ok(noted({ removed: key, was_enrolled: !!prior, revoke: out }));
  }

  async function getAdmission(key: string): Promise<DoorAnswer> {
    const roster = await deps.admission.get(key);
    return ok({ agent: key, roster: roster ?? null, ...(roster ? {} : { default: defaultRoster() }) });
  }

  async function putAdmission(key: string, b: Record<string, unknown>, caller: string): Promise<DoorAnswer> {
    const prior = (await deps.admission.get(key)) ?? defaultRoster();
    const next: Record<string, unknown> = { ...prior };
    if (b.defaults !== undefined) {
      if (!b.defaults || typeof b.defaults !== "object" || Array.isArray(b.defaults)) return no(400, "defaults must be an object of tier: stance, such as {\"anonymous\": \"block\"}.");
      const d = { ...((prior.defaults as Record<string, string>) ?? {}) };
      for (const [tier, stance] of Object.entries(b.defaults as Record<string, unknown>)) {
        if (typeof stance !== "string" || !STANCES.has(stance)) return no(400, `The stance for ${tier} must be allow, hold or block.`);
        d[tier] = stance;
      }
      next.defaults = d;
    }
    if (b.entries !== undefined) {
      if (!Array.isArray(b.entries)) return no(400, "entries must be a list of {subject, stance}.");
      const entries: Array<{ subject: string; stance: string }> = [];
      for (const e of b.entries as Array<Record<string, unknown>>) {
        const subject = str(e?.subject);
        const stance = str(e?.stance);
        if (!subject || !stance || !STANCES.has(stance)) return no(400, "Each entry needs a subject (an agent key or name) and a stance: allow, hold or block.");
        entries.push({ subject, stance });
      }
      next.entries = entries;
    }
    if (b.limits !== undefined) {
      const l = b.limits as Record<string, unknown> | null;
      const n = l?.per_sender_per_hour;
      if (!l || typeof l !== "object" || (n !== undefined && (typeof n !== "number" || !Number.isInteger(n) || n < 1))) {
        return no(400, "limits.per_sender_per_hour must be a whole number of 1 or more.");
      }
      next.limits = { ...((prior.limits as Record<string, unknown>) ?? {}), ...(n !== undefined ? { per_sender_per_hour: n } : {}) };
    }
    delete next.sig;
    await deps.admission.putAuthorized(key, next, "admin");
    record(caller, "set admission policy for", key);
    return ok({
      agent: key,
      roster: { ...next, owner_key: key, authored: "admin" },
      what_now: "The mesh drops what this policy blocks for agents that asked to be guarded (EXT-6). The agent's own client applies hold and allow.",
    });
  }

  // ── Credentials ─────────────────────────────────────────────────────

  async function listCredentials(q: URLSearchParams): Promise<DoorAnswer> {
    const agent = str(q.get("agent"));
    const tenant = str(q.get("tenant"));
    let list = await deps.mintLog.all();
    if (agent) list = list.filter((c) => c.agents.includes(agent));
    if (tenant) {
      const mine = new Set((await agentsOf(tenant)).map((r) => r.key));
      list = list.filter((c) => c.account === tenant || c.agents.some((a) => mine.has(a)));
    }
    list.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    return ok({ credentials: list.map(credView) });
  }

  async function mintCredential(b: Record<string, unknown>, caller: string): Promise<DoorAnswer> {
    const ids = Array.isArray(b.agents) ? [...new Set(b.agents.filter((a): a is string => typeof a === "string"))] : [];
    if (!ids.length) return no(400, "Name the agents the credential is for (agents: a list of agent public keys).");
    if (ids.length > NODE_CREDENTIAL_MAX_AGENTS) return no(400, `A node credential covers at most ${NODE_CREDENTIAL_MAX_AGENTS} agents.`);
    const bad = ids.find((k) => !NKEY.test(k));
    if (bad) return no(400, `${bad.slice(0, 12)}… is not an agent public key (U followed by 55 characters).`);
    let decision: Awaited<ReturnType<typeof decideRenewal>>;
    let stopped: Map<string, StopFinding>;
    try {
      decision = await decideRenewal(
        {
          holderOf: (k) => deps.holderOf(k),
          revocationOf: (k) => deps.tombstones.get(k),
          signingKeyRevoked: async (k) => !!(await deps.keyRevocations.get(k)),
        },
        ids,
      );
      stopped = await deps.stopsFor(ids);
    } catch (err) {
      return no(503, `Could not check these agents' standing right now, so no credential was minted: ${(err as Error).message}`);
    }
    if (!decision.allow) return no(decision.status, decision.error);
    const first = ids.find((k) => stopped.has(k));
    if (first) {
      const r = mintRefusal(stopped.get(first)!, first);
      return { status: r.status, body: r.body };
    }
    const seed = deps.mintSeed();
    if (!seed.ok) return no(seed.status, seed.error);
    const ukp = nkeys.createUser();
    const minted = await mintNodeCredential({ subject: ukp, agentIds: ids, mintSeed: seed.seed, issuerAccount: deps.issuerAccount, namePrefix: "node" });
    const userSeed = new TextDecoder().decode(ukp.getSeed());
    const label = str(b.label) ?? undefined;
    await deps.mintLog.recordMint({ key: minted.subject, agents: ids, label, expiresAt: minted.expiresAt, door: "admin", account: decision.accountId });
    record(caller, `minted a credential for ${ids.length} agent(s) on`, minted.subject);
    return ok({
      user_key: minted.subject,
      agents: ids,
      tenant: decision.accountId,
      expires_at: minted.expiresAt,
      creds: credsFileText(minted.jwt, userSeed),
      mesh: deps.meshInfo(),
      what_now: "Keep the creds file private. The node renews it before it expires at POST /v1/node-credential, signing with this key.",
    }, 201);
  }

  /** Exactly one of agent, tenant or key, checked. */
  function oneTarget(b: Record<string, unknown>, allowKey: boolean): { scope: "agent" | "person" | "key"; target: string } | DoorAnswer {
    const agent = str(b.agent);
    const tenant = str(b.tenant);
    const key = allowKey ? str(b.key) : null;
    const n = [agent, tenant, key].filter(Boolean).length;
    if (n !== 1) return no(400, allowKey ? "Name exactly one of agent, tenant or key." : "Name exactly one of agent or tenant.");
    if (agent) return NKEY.test(agent) ? { scope: "agent", target: agent } : no(400, "agent must be an agent public key (U followed by 55 characters).");
    if (key) return NKEY.test(key) ? { scope: "key", target: key } : no(400, "key must be a connection public key (U followed by 55 characters).");
    return { scope: "person", target: tenant! };
  }

  async function revoke(b: Record<string, unknown>, caller: string): Promise<DoorAnswer> {
    const t = oneTarget(b, true);
    if ("status" in t) return t;
    const why = str(b.reason);
    if (t.scope === "key") {
      const out = await deps.revokeCredential({ userKeys: [t.target], reason: why ?? "revoked by the operator", by: by(caller), refuseRenewal: false, deregister: false });
      record(caller, "revoked the credential on", t.target, { mode: out.mode });
      return ok({ revoked: "credential", key: t.target, result: out, what_now: "Only this credential was revoked. Its agents stay in good standing, and their node can renew on a new key." });
    }
    if (t.scope === "person" && !(await deps.owners.tenant(t.target))) return no(404, `No tenant ${t.target} on this mesh.`);
    const active = await deps.stops.active();
    if (active.some((s) => s.via === ADMIN_VIA && s.scope === t.scope && s.target === t.target)) {
      return no(409, t.scope === "agent" ? "This agent's credentials are already revoked." : "This tenant's credentials are already revoked.");
    }
    const covered = await coveredBy(t.scope, t.target);
    const label = t.scope === "agent" ? (await deps.owners.agent(t.target))?.label ?? undefined : undefined;
    const rec: StopRecord = {
      id: newStopId(),
      scope: t.scope,
      target: t.target,
      ...(label ? { target_label: label } : {}),
      action: "pause",
      by: { authority: "operator" },
      why: (why ?? "revoked by this mesh's operator").slice(0, 500), // cut-ok: a reason sentence, stored whole up to the record's limit
      at: iso(),
      count: covered.length,
      via: ADMIN_VIA,
    };
    // Written first: from here every mint door refuses these agents.
    await deps.stops.put(rec);
    let marked = 0;
    for (const k of covered) {
      try { await deps.agentStatus.set(k, { status: "paused", since: rec.at, stop_id: rec.id, scope: t.scope }); marked++; } catch { /* the mint doors still refuse it */ }
    }
    const cut: CutResult = covered.length
      ? await deps.cut(covered).catch((err): CutResult => ({ mode: "none", user_keys: 0, shared: 0, note: `The connections could not be cut: ${(err as Error).message}. Every mint door refuses these agents, so they stop at their next renewal at the latest.` }))
      : { mode: "none", user_keys: 0, shared: 0, note: "No agents were covered." };
    rec.cut = cut.note;
    if (cut.keys?.length) rec.cut_keys = cut.keys.slice(0, 2000); // cut-ok: the record's bound; the cut itself used every key
    await deps.stops.put(rec).catch(() => undefined);
    record(caller, `revoked the credentials of ${t.scope === "agent" ? "agent" : "tenant"}`, t.target, { covered: covered.length, cut: cut.mode });
    return ok({
      revoked: t.scope === "agent" ? "agent" : "tenant",
      target: t.target,
      agents: covered.length,
      stop_id: rec.id,
      cut: { mode: cut.mode, connections: cut.user_keys, note: cut.note },
      marked_stopped: marked,
      what_now: `No credential is issued for ${t.scope === "agent" ? "this agent" : "these agents"} until it is restored (mesh-admin credentials restore${t.scope === "agent" ? ", or agents enroll" : ""}).`,
    });
  }

  async function restore(b: Record<string, unknown>, caller: string): Promise<DoorAnswer> {
    const t = oneTarget(b, false);
    if ("status" in t) return t;
    const scope = t.scope as "agent" | "person";
    const out = await liftAdminStops(scope, t.target, caller, str(b.reason));
    if (!out.lifted.length) return no(404, scope === "agent" ? "No revoke by this admin API is in force for that agent." : "No revoke by this admin API is in force for that tenant.");
    // A key the operator restores is not a retired one: clear its tombstone too.
    if (scope === "agent") {
      const tomb = await deps.tombstones.get(t.target).catch(() => null);
      if (tomb) await deps.tombstones.clear(t.target);
    }
    return ok({
      restored: scope === "agent" ? "agent" : "tenant",
      target: t.target,
      resumed: out.resumed.length,
      still_stopped: (await coveredBy(scope, t.target)).length - out.resumed.length,
      ...(out.cut ? { recut: out.cut } : {}),
      what_now: "Each agent gets a credential again at its node's next renewal, within a few minutes.",
    });
  }

  async function revokeSigningKey(b: Record<string, unknown>, caller: string): Promise<DoorAnswer> {
    const key = str(b.agent);
    if (!key || !NKEY.test(key)) return no(400, "agent must be an agent public key (U followed by 55 characters).");
    const reason = str(b.reason);
    if (!reason) return no(400, "Say why. A revoked signing key cannot be restored, and the reason is kept with it.");
    try {
      const out = await deps.revokeAgentKey(key, reason, by(caller));
      record(caller, "revoked the signing key of", key);
      return ok({ revoked: "signing key", agent: key, result: out as unknown as Record<string, unknown>, what_now: "Receivers refuse what this key signs from now on. Its owner moves the agent to a new key and enrolls that." });
    } catch (err) {
      return no(503, (err as Error).message);
    }
  }

  // ── Audit ───────────────────────────────────────────────────────────

  async function audit(q: URLSearchParams): Promise<DoorAnswer> {
    const log = deps.audit();
    if (!log) return no(503, "The audit log is not on this host, so it cannot be read here.");
    const agent = str(q.get("agent"));
    const tenant = str(q.get("tenant"));
    if (!!agent === !!tenant) return no(400, "Name exactly one of agent or tenant.");
    if (agent && !NKEY.test(agent)) return no(400, "agent must be an agent public key (U followed by 55 characters).");
    const ids = agent ? [agent] : (await agentsOf(tenant!)).map((r) => r.key);
    const limit = Math.max(1, Math.min(Number(q.get("limit") ?? 50) || 50, 500));
    const entries = log.list(ids, limit);
    const verify = q.get("verify") === "1" || q.get("verify") === "true";
    return ok({
      agents: ids.length,
      entries,
      ...(verify ? { chains: ids.map((id) => ({ agent: id, ...log.verifyChain(id) })) } : {}),
      about: "Metadata and input hashes only, never content. Each agent's rows form a hash chain; verify walks it.",
    });
  }

  // ── Routing ─────────────────────────────────────────────────────────

  async function handle(req: AdminRequest): Promise<DoorAnswer> {
    const { method, path, query, caller } = req;
    const b = req.body ?? {};
    const seg = path.replace(/^\/admin\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    try {
      if (seg.length === 1 && seg[0] === "status" && method === "GET") return await status(caller);
      const read = (deps.reads ? await deps.reads.handle(req) : null)
        ?? (deps.views ? await deps.views.handle(req) : null)
        ?? (deps.admissionRoutes ? await deps.admissionRoutes.handle(req) : null)
        ?? (deps.ownerRecords ? await deps.ownerRecords.handle(req) : null)
        ?? (deps.auditRoutes ? await deps.auditRoutes.handle(req) : null)
        ?? (deps.credentialRoutes ? await deps.credentialRoutes.handle(req) : null)
        ?? (deps.keychainRoutes ? await deps.keychainRoutes.handle(req) : null)
        ?? (deps.usageRoutes ? await deps.usageRoutes.handle(req) : null)
        ?? (deps.streamRoutes ? await deps.streamRoutes.handle(req) : null)
        ?? (deps.trustRoutes ? await deps.trustRoutes.handle(req) : null);
      if (read) return read;

      if (seg[0] === "tenants") {
        if (seg.length === 1 && method === "GET") return await listTenants();
        if (seg.length === 1 && method === "POST") return await createTenant(b, caller);
        const id = seg[1];
        if (id && !TENANT_ID.test(id)) return no(400, "That is not a tenant id.");
        if (seg.length === 2 && method === "GET") return await showTenant(id!);
        if (seg.length === 2 && method === "PATCH") return await patchTenant(id!, b, caller);
        if (seg.length === 2 && method === "DELETE") return await deleteTenant(id!, caller);
        if (seg.length === 3 && seg[2] === "limits" && method === "PUT") return await putLimits(id!, b, caller);
        if (seg.length === 3 && seg[2] === "enroll-keys" && method === "POST") return await enrollKey(id!, b, caller);
      }

      if (seg[0] === "agents") {
        if (seg.length === 1 && method === "GET") return await listAgents(query);
        const key = seg[1];
        if (key && !NKEY.test(key)) return no(400, "That is not an agent public key (U followed by 55 characters).");
        if (seg.length === 2 && method === "GET") return await showAgent(key!);
        if (seg.length === 2 && method === "PUT") return await enrollAgent(key!, b, caller);
        if (seg.length === 2 && method === "PATCH") return await patchAgent(key!, b, caller);
        if (seg.length === 2 && method === "DELETE") return await removeAgent(key!, b, caller);
        if (seg.length === 3 && seg[2] === "admission" && method === "GET") return await getAdmission(key!);
        if (seg.length === 3 && seg[2] === "admission" && method === "PUT") return await putAdmission(key!, b, caller);
      }

      if (seg[0] === "credentials") {
        if (seg.length === 1 && method === "GET") return await listCredentials(query);
        if (seg.length === 1 && method === "POST") return await mintCredential(b, caller);
        if (seg.length === 2 && seg[1] === "revoke" && method === "POST") return await revoke(b, caller);
        if (seg.length === 2 && seg[1] === "restore" && method === "POST") return await restore(b, caller);
      }

      if (seg.length === 2 && seg[0] === "agent-keys" && seg[1] === "revoke" && method === "POST") return await revokeSigningKey(b, caller);
      if (seg.length === 1 && seg[0] === "audit" && method === "GET") return await audit(query);

      return no(404, "No such admin route. mesh-admin help lists them.");
    } catch (err) {
      console.error(`[admin] ${method} ${path}: ${(err as Error).message}`);
      return no(503, `This could not be done right now: ${(err as Error).message}`);
    }
  }

  return { handle };
}

export type AdminApi = ReturnType<typeof adminApi>;

/** The roster an agent has before anyone sets one (the account console's default). */
export function defaultRoster(): Record<string, unknown> {
  return {
    admission: "v1",
    defaults: { registered: "hold", anonymous: "block" },
    limits: { per_sender_per_hour: 12 },
    entries: [],
  };
}
