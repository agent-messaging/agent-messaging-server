/**
 * The core's admin API (admin/admin-api.ts, step 6 of
 * docs/agent-messaging-server-plan.md): tenants and their limits, agents
 * and their ownership, credentials and the kill switch's cut, admission policy
 * and the audit log. Wired here to the same in-memory stores as the
 * credential doors, so a revoke is checked by the door that must then refuse,
 * and an enroll by the door that must then mint.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nkeys } from "nats";
import { memKv } from "../helpers/fake-kv.js";
import { adminApi, PLATFORM_NOTE, type AdminDeps } from "../../src/admin/admin-api.js";
import { credentialDoors } from "../../src/keychain/doors.js";
import { BootTokens } from "../../src/keychain/boot-tokens.js";
import { MemoryAgentOwners } from "../../src/keychain/agent-owners.js";
import { MemoryStopStore } from "../../src/keychain/stop-store.js";
import { MemoryTenantLimits } from "../../src/keychain/tenant-limits.js";
import { MemoryAgentStatus } from "../../src/shared/agent-status.js";
import { ADMIN_VIA } from "../../src/keychain/stop-record.js";
import type { TrackedCred } from "../../src/keychain/cred-renewal-watch.js";

let dir = "";
const env: NodeJS.ProcessEnv = {};
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "admin-"));
  const seedFile = join(dir, "mint.seed");
  writeFileSync(seedFile, new TextDecoder().decode(nkeys.createAccount().getSeed()));
  env.ROOMS_MINT_SEED_FILE = seedFile;
  env.MESH_NAME = "test.mesh";
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function rig(opts: { platformBeside?: boolean } = {}) {
  const owners = new MemoryAgentOwners();
  const limits = new MemoryTenantLimits();
  const tokens = new BootTokens(memKv("mesh_boot_tokens").kv as never);
  const tombstones = new Map<string, { at: string; reason: string; by: string }>();
  const keyRevs = new Map<string, { at: string; reason: string; by: string }>();
  const mints: TrackedCred[] = [];
  const stops = new MemoryStopStore();
  const status = new MemoryAgentStatus();
  const rosters = new Map<string, Record<string, unknown>>();
  const revoked: Array<Record<string, unknown>> = [];
  const cuts: string[][] = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const tombStore = {
    get: async (k: string) => tombstones.get(k) ?? null,
    clear: async (k: string) => tombstones.delete(k),
    revoke: async (k: string, reason: string, by: string) => { const r = { at: "now", reason, by }; tombstones.set(k, r); return r; },
  };
  const mintLog = {
    all: async () => [...mints],
    recordMint: async (m: { key: string; agents: string[]; label?: string; expiresAt: string | null; account?: string | null }) => {
      mints.push({ key: m.key, agents: m.agents, ...(m.label ? { label: m.label } : {}), issuedAt: new Date().toISOString(), expiresAt: m.expiresAt, renewals: 0, ...(m.account ? { account: m.account } : {}) });
    },
    cutAt: async () => null,
  };
  const revokeCredential = async (input: Record<string, unknown>) => {
    revoked.push(input);
    if (input.refuseRenewal !== false && input.agentKey) await tombStore.revoke(String(input.agentKey), String(input.reason), String(input.by));
    return { ok: true, revoked: true, at: "now", mode: "live", user_keys: [], also_disconnected_agents: [], deregistered: !!input.deregister, disconnected: true, still_connected: [], took_ms: 400, note: "Revoked on the broker." } as never;
  };
  const doors = credentialDoors({
    owners, bootTokens: tokens, tombstones: tombStore as never,
    keyRevocations: { get: async (k: string) => keyRevs.get(k) ?? null, revoke: async (k: string, r: { reason: string; by: string }) => { const x = { at: "now", ...r }; keyRevs.set(k, x); return x; } } as never,
    agentStatus: status, stops, mintLog: mintLog as never, limits,
    revokeCredential: revokeCredential as never, platform: {}, baseUrl: "https://mesh.test", env,
  });
  const deps: AdminDeps = {
    owners, limits, bootTokens: tokens, tombstones: tombStore,
    keyRevocations: { get: async (k: string) => (keyRevs.get(k) as never) ?? null },
    agentStatus: status, stops, mintLog,
    admission: {
      get: async (k: string) => rosters.get(k) ?? null,
      putAuthorized: async (k: string, r: Record<string, unknown>, authored: string) => { rosters.set(k, { ...r, owner_key: k, authored }); },
    },
    holderOf: (k) => doors.holderOf(k),
    stopsFor: (keys) => doors.stopsFor(keys),
    revokeCredential: revokeCredential as never,
    revokeAgentKey: (k, reason, by) => doors.revokeAgentKeyAction(k, reason, by),
    cut: async (keys) => { cuts.push(keys); return { mode: "live", user_keys: keys.length, shared: 0, note: `${keys.length} connection(s) closed within 0.4 seconds.`, keys: keys.map((k) => `${k}-conn`) }; },
    audit: () => ({
      list: (ids: string[], limit = 50) => auditRows.filter((r) => ids.includes(String(r.agent_id))).slice(0, limit), // cut-ok: the test's own fake honours the limit
      verifyChain: (id: string) => ({ ok: true, count: auditRows.filter((r) => r.agent_id === id).length }),
    }),
    mintSeed: () => ({ ok: true, seed: new TextDecoder().decode(nkeys.createAccount().getSeed()) }),
    meshInfo: () => ({ name: "test.mesh", protocol: "0.3", nats_endpoints: [] }),
    facts: () => ({ live_revocation: "on", minting: "on" }),
    platformBeside: !!opts.platformBeside,
  };
  const api = adminApi(deps);
  const call = (method: string, path: string, body: Record<string, unknown> | null = null, query = "") =>
    api.handle({ method, path: `/admin/v1${path}`, query: new URLSearchParams(query), body, caller: "ops" });
  return { api, call, doors, owners, limits, tokens, tombstones, keyRevs, mints, stops, status, rosters, revoked, cuts, auditRows };
}

const sign = (kp: ReturnType<typeof nkeys.createUser>, s: string) => Buffer.from(kp.sign(new TextEncoder().encode(s))).toString("base64");
function renewal(agent: ReturnType<typeof nkeys.createUser>) {
  const node = nkeys.createUser();
  const nodeId = node.getPublicKey();
  const ts = Math.floor(Date.now() / 1000);
  const key = agent.getPublicKey();
  return { node_id: nodeId, ts, node_sig: sign(node, `mesh-node-cred-v1:${ts}:${nodeId}:${key}`), agents: [{ id: key, sig: sign(agent, `mesh-node-agent-v1:${ts}:${nodeId}:${key}`) }] };
}

describe("tenants", () => {
  it("creates, lists, shows, disables, sets limits on and deletes a tenant", async () => {
    const r = rig();
    const made = await r.call("POST", "/tenants", { id: "acme", limits: { max_agents: 2 } });
    expect(made.status).toBe(201);
    expect(made.body.note).toBeUndefined();
    expect((await r.call("POST", "/tenants", { id: "acme" })).status).toBe(409);
    expect((await r.call("POST", "/tenants", { id: "bad id!" })).status).toBe(400);
    const list = await r.call("GET", "/tenants");
    expect(list.body.tenants).toEqual([{ id: "acme", disabled: false, home_org: null, agents: 0, limits: { max_agents: 2 } }]);

    const lim = await r.call("PUT", "/tenants/acme/limits", { requests_per_minute: 30, max_agents: null });
    expect(lim.body.limits).toEqual({ requests_per_minute: 30 });
    expect((await r.call("PUT", "/tenants/acme/limits", { max_agents: -1 })).status).toBe(400);
    expect((await r.call("PUT", "/tenants/acme/limits", { speed: 3 })).status).toBe(400);

    const off = await r.call("PATCH", "/tenants/acme", { disabled: true });
    expect(off.body.tenant).toMatchObject({ disabled: true });
    expect(String(off.body.what_now)).toContain("revoke the tenant's credentials");
    expect((await r.call("POST", "/tenants/acme/enroll-keys", { label: "laptop" })).status).toBe(409);

    await r.owners.putAgent({ key: nkeys.createUser().getPublicKey(), account: "acme", org: null, home_org: null, person: "acme", category: "account", listed: true, label: null, custody: null, payer: "acme", updated_at: "x" });
    expect((await r.call("DELETE", "/tenants/acme")).status).toBe(409);
    await r.owners.agents.clear();
    expect((await r.call("DELETE", "/tenants/acme")).body).toMatchObject({ deleted: "acme" });
    expect(await r.limits.get("acme")).toBeNull();
    expect((await r.call("GET", "/tenants/acme")).status).toBe(404);
  });

  it("an enrollment key enrolls one agent at the bootstrap door, once, and the tenant's agent limit holds there", async () => {
    const r = rig();
    await r.call("POST", "/tenants", { id: "acme", limits: { max_agents: 1 } });
    const k1 = await r.call("POST", "/tenants/acme/enroll-keys", { label: "first" });
    expect(k1.status).toBe(201);
    expect(String(k1.body.key)).toMatch(/^am_/);
    const a1 = nkeys.createUser().getPublicKey();
    const b1 = await r.doors.bootstrap({ token: String(k1.body.key), agent_id: a1 });
    expect(b1.status).toBe(200);
    expect(r.owners.agents.get(a1)).toMatchObject({ account: "acme", label: "first" });
    expect((await r.doors.bootstrap({ token: String(k1.body.key), agent_id: nkeys.createUser().getPublicKey() })).status).toBe(400);

    const k2 = await r.call("POST", "/tenants/acme/enroll-keys", { label: "second" });
    const b2 = await r.doors.bootstrap({ token: String(k2.body.key), agent_id: nkeys.createUser().getPublicKey() });
    expect(b2.status).toBe(403);
    expect(b2.body).toMatchObject({ code: "tenant_agent_limit" });
    // Refused for the limit, the key is kept for when there is room.
    await r.call("PUT", "/tenants/acme/limits", { max_agents: 2 });
    expect((await r.doors.bootstrap({ token: String(k2.body.key), agent_id: nkeys.createUser().getPublicKey() })).status).toBe(200);
  });
});

describe("agents", () => {
  it("enrolls, lists, shows, changes visibility and moves an agent, inside each tenant's limit", async () => {
    const r = rig();
    await r.call("POST", "/tenants", { id: "acme", limits: { max_agents: 1 } });
    await r.call("POST", "/tenants", { id: "beta" });
    const a = nkeys.createUser().getPublicKey();
    const b = nkeys.createUser().getPublicKey();
    expect((await r.call("PUT", `/agents/${a}`, { tenant: "nope" })).status).toBe(404);
    const e = await r.call("PUT", `/agents/${a}`, { tenant: "acme", label: "bot" });
    expect(e.status).toBe(201);
    expect(e.body.agent).toMatchObject({ key: a, tenant: "acme", label: "bot", listed: true });
    const full = await r.call("PUT", `/agents/${b}`, { tenant: "acme" });
    expect(full.status).toBe(403);
    expect(full.body.code).toBe("tenant_agent_limit");
    expect((await r.call("PUT", `/agents/${a}`, { tenant: "beta" })).status).toBe(409);

    expect((await r.call("PATCH", `/agents/${a}`, { listed: false })).body.agent).toMatchObject({ listed: false });
    const moved = await r.call("PATCH", `/agents/${a}`, { tenant: "beta" });
    expect(moved.body.agent).toMatchObject({ tenant: "beta" });
    expect(r.owners.agents.get(a)).toMatchObject({ account: "beta", person: "beta", payer: "beta" });
    expect((await r.call("GET", "/agents", null, "tenant=beta")).body.agents).toHaveLength(1);
    expect((await r.call("GET", "/agents", null, "tenant=acme")).body.agents).toHaveLength(0);
    const shown = await r.call("GET", `/agents/${a}`);
    expect(shown.body).toMatchObject({ agent: a, owner: { tenant: "beta" }, standing: { revoked: null, stopped: null, status: "running" } });
    expect((await r.call("GET", "/agents/not-a-key")).status).toBe(400);
  });

  it("says the platform rewrites ownership when it runs beside the core", async () => {
    const r = rig({ platformBeside: true });
    const made = await r.call("POST", "/tenants", { id: "acme" });
    expect(made.body.note).toBe(PLATFORM_NOTE);
    expect((await r.call("PUT", `/agents/${nkeys.createUser().getPublicKey()}`, { tenant: "acme" })).body.note).toBe(PLATFORM_NOTE);
  });

  it("removing an agent revokes its credentials, deregisters it and drops its record; the renewal door then refuses it", async () => {
    const r = rig();
    await r.call("POST", "/tenants", { id: "acme" });
    const agent = nkeys.createUser();
    const key = agent.getPublicKey();
    await r.call("PUT", `/agents/${key}`, { tenant: "acme" });
    expect((await r.doors.nodeCredential(renewal(agent), "ip", () => ({}))).status).toBe(200);
    const out = await r.call("DELETE", `/agents/${key}`, { reason: "left the company" });
    expect(out.body).toMatchObject({ removed: key, was_enrolled: true });
    expect(r.revoked[0]).toMatchObject({ agentKey: key, refuseRenewal: true, deregister: true, by: "admin:ops", reason: "retired by the operator: left the company" });
    expect(r.owners.agents.has(key)).toBe(false);
    expect((await r.doors.nodeCredential(renewal(agent), "ip", () => ({}))).status).toBe(403);
    // Enrolled again, it comes back.
    await r.call("PUT", `/agents/${key}`, { tenant: "acme" });
    expect(r.tombstones.has(key)).toBe(false);
    expect((await r.doors.nodeCredential(renewal(agent), "ip", () => ({}))).status).toBe(200);
  });

  it("sets an agent's admission policy on the operator's authority", async () => {
    const r = rig();
    const key = nkeys.createUser().getPublicKey();
    const before = await r.call("GET", `/agents/${key}/admission`);
    expect(before.body.roster).toBeNull();
    expect((before.body.default as Record<string, unknown>).defaults).toEqual({ registered: "hold", anonymous: "block" });
    const set = await r.call("PUT", `/agents/${key}/admission`, { defaults: { registered: "allow" }, entries: [{ subject: "UPEER", stance: "block" }], limits: { per_sender_per_hour: 30 } });
    expect(set.status).toBe(200);
    expect(r.rosters.get(key)).toMatchObject({ authored: "admin", owner_key: key, defaults: { registered: "allow", anonymous: "block" }, entries: [{ subject: "UPEER", stance: "block" }], limits: { per_sender_per_hour: 30 } });
    expect((await r.call("PUT", `/agents/${key}/admission`, { defaults: { registered: "maybe" } })).status).toBe(400);
    expect((await r.call("PUT", `/agents/${key}/admission`, { entries: [{ subject: "x" }] })).status).toBe(400);
  });
});

describe("credentials and the kill switch", () => {
  it("revoking an agent stops it, cuts its connections and refuses its renewal until an enroll lets it back", async () => {
    const r = rig();
    await r.call("POST", "/tenants", { id: "acme" });
    const agent = nkeys.createUser();
    const key = agent.getPublicKey();
    await r.call("PUT", `/agents/${key}`, { tenant: "acme", label: "bot" });
    expect((await r.doors.nodeCredential(renewal(agent), "ip", () => ({}))).status).toBe(200);

    const rv = await r.call("POST", "/credentials/revoke", { agent: key, reason: "acting strangely" });
    expect(rv.status).toBe(200);
    expect(rv.body).toMatchObject({ revoked: "agent", agents: 1, cut: { mode: "live" }, marked_stopped: 1 });
    expect(r.cuts).toEqual([[key]]);
    const stop = (await r.stops.active())[0]!;
    expect(stop).toMatchObject({ scope: "agent", target: key, action: "pause", by: { authority: "operator" }, via: ADMIN_VIA, why: "acting strangely", cut_keys: [`${key}-conn`] });
    expect((await r.status.get(key))?.status).toBe("paused");
    expect((await r.call("POST", "/credentials/revoke", { agent: key })).status).toBe(409);

    const refused = await r.doors.nodeCredential(renewal(agent), "ip", () => ({}));
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "agent_paused" });
    expect(String(refused.body.error)).toContain("this mesh's operator");
    expect((await r.doors.keyCheck(key)).body).toMatchObject({ stopped: "paused" });
    // An admin mint is refused too.
    expect((await r.call("POST", "/credentials", { agents: [key] })).status).toBe(403);
    expect((await r.call("GET", `/agents/${key}`)).body.standing).toMatchObject({ status: "paused", stopped: { by_admin: true } });

    const back = await r.call("PUT", `/agents/${key}`, { tenant: "acme" });
    expect(back.status).toBe(200);
    expect(back.body.revoke_lifted).toBe(true);
    expect(await r.stops.active()).toEqual([]);
    expect(await r.status.get(key)).toBeNull();
    // The lift cut the old connections once more, so a shared node re-mints with it.
    expect(r.cuts[1]).toEqual([`${key}-conn`]);
    expect((await r.doors.nodeCredential(renewal(agent), "ip", () => ({}))).status).toBe(200);
  });

  it("revokes and restores a whole tenant; restore says when nothing was revoked", async () => {
    const r = rig();
    await r.call("POST", "/tenants", { id: "acme" });
    await r.call("POST", "/tenants", { id: "beta" });
    const a = nkeys.createUser(); const b = nkeys.createUser(); const c = nkeys.createUser();
    await r.call("PUT", `/agents/${a.getPublicKey()}`, { tenant: "acme" });
    await r.call("PUT", `/agents/${b.getPublicKey()}`, { tenant: "acme" });
    await r.call("PUT", `/agents/${c.getPublicKey()}`, { tenant: "beta" });
    expect((await r.call("POST", "/credentials/restore", { tenant: "acme" })).status).toBe(404);
    const rv = await r.call("POST", "/credentials/revoke", { tenant: "acme" });
    expect(rv.body).toMatchObject({ revoked: "tenant", agents: 2 });
    expect(new Set(r.cuts[0])).toEqual(new Set([a.getPublicKey(), b.getPublicKey()]));
    expect((await r.doors.nodeCredential(renewal(a), "ip", () => ({}))).status).toBe(403);
    expect((await r.doors.nodeCredential(renewal(c), "ip", () => ({}))).status).toBe(200);
    const back = await r.call("POST", "/credentials/restore", { tenant: "acme" });
    expect(back.body).toMatchObject({ restored: "tenant", resumed: 2, still_stopped: 0 });
    expect((await r.doors.nodeCredential(renewal(a), "ip", () => ({}))).status).toBe(200);
    expect((await r.call("POST", "/credentials/revoke", { tenant: "nope" })).status).toBe(404);
    expect((await r.call("POST", "/credentials/revoke", { tenant: "acme", agent: a.getPublicKey() })).status).toBe(400);
  });

  it("revoking one connection key cuts that credential only and leaves its agent in good standing", async () => {
    const r = rig();
    const conn = nkeys.createUser().getPublicKey();
    const out = await r.call("POST", "/credentials/revoke", { key: conn });
    expect(out.body).toMatchObject({ revoked: "credential", key: conn });
    expect(r.revoked[0]).toMatchObject({ userKeys: [conn], refuseRenewal: false, deregister: false });
    expect(await r.stops.active()).toEqual([]);
  });

  it("mints a node credential on a fresh key, records it without the secret, and lists it", async () => {
    const r = rig();
    await r.call("POST", "/tenants", { id: "acme" });
    const a = nkeys.createUser().getPublicKey();
    await r.call("PUT", `/agents/${a}`, { tenant: "acme" });
    const m = await r.call("POST", "/credentials", { agents: [a], label: "ci node" });
    expect(m.status).toBe(201);
    expect(String(m.body.creds)).toContain("BEGIN USER NKEY SEED");
    expect(m.body).toMatchObject({ agents: [a], tenant: "acme" });
    const list = await r.call("GET", "/credentials", null, `agent=${a}`);
    expect(list.body.credentials).toEqual([expect.objectContaining({ key: m.body.user_key, agents: [a], label: "ci node", tenant: "acme" })]);
    expect(JSON.stringify(list.body)).not.toContain("SEED");
    expect((await r.call("GET", "/credentials", null, "tenant=acme")).body.credentials).toHaveLength(1);
    expect((await r.call("POST", "/credentials", { agents: [] })).status).toBe(400);
    expect((await r.call("POST", "/credentials", { agents: ["nope"] })).status).toBe(400);
  });

  it("revokes a signing key with a reason, after which nothing brings the agent back on that key", async () => {
    const r = rig();
    await r.call("POST", "/tenants", { id: "acme" });
    const agent = nkeys.createUser();
    const key = agent.getPublicKey();
    await r.call("PUT", `/agents/${key}`, { tenant: "acme" });
    expect((await r.call("POST", "/agent-keys/revoke", { agent: key })).status).toBe(400);
    const out = await r.call("POST", "/agent-keys/revoke", { agent: key, reason: "seed leaked" });
    expect(out.status).toBe(200);
    expect(r.keyRevs.get(key)).toMatchObject({ reason: "seed leaked", by: "admin:ops" });
    expect((await r.doors.keyCheck(key)).body).toMatchObject({ revoked: true });
    expect((await r.call("PUT", `/agents/${key}`, { tenant: "acme" })).status).toBe(409);
  });
});

describe("status and the audit log", () => {
  it("answers what the mesh is and holds", async () => {
    const r = rig();
    await r.call("POST", "/tenants", { id: "acme" });
    const s = await r.call("GET", "/status");
    expect(s.body).toMatchObject({ mesh: "test.mesh", profile: "core", tenancy: "one_nats_account", platform_beside: false, live_revocation: "on", counts: { tenants: 1, agents: 0, stops_in_force: 0 }, token: "ops" });
  });

  it("reads an agent's or a tenant's rows, and walks the chains when asked", async () => {
    const r = rig();
    await r.call("POST", "/tenants", { id: "acme" });
    const a = nkeys.createUser().getPublicKey();
    await r.call("PUT", `/agents/${a}`, { tenant: "acme" });
    r.auditRows.push({ agent_id: a, seq: 1, role: "served", skill: "echo" }, { agent_id: "other", seq: 1 });
    const one = await r.call("GET", "/audit", null, `agent=${a}&verify=1`);
    expect(one.body.entries).toHaveLength(1);
    expect(one.body.chains).toEqual([{ agent: a, ok: true, count: 1 }]);
    expect((await r.call("GET", "/audit", null, "tenant=acme")).body.entries).toHaveLength(1);
    expect((await r.call("GET", "/audit")).status).toBe(400);
  });

  it("an unknown route is a 404 that points at the help", async () => {
    const r = rig();
    const out = await r.call("GET", "/nothing");
    expect(out.status).toBe(404);
  });
});
