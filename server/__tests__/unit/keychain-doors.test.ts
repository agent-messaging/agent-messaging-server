/**
 * The core's credential doors (keychain/doors.ts, step 3 C2 of
 * docs/agent-messaging-server-plan.md): enrollment, renewal, revocation and
 * the key check, answered from the core's stores, with the platform's steps as
 * optional hooks in the same order as before, and carried over loopback when
 * the doors run in the core's own process (keychain/platform-steps.ts).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nkeys } from "nats";
import { memKv } from "../helpers/fake-kv.js";
import { credentialDoors, keyStandingStatement, type DoorDeps, type PlatformSteps } from "../../src/keychain/doors.js";
import { BootTokens } from "../../src/keychain/boot-tokens.js";
import { MemoryAgentOwners, type AgentOwnerRecord } from "../../src/keychain/agent-owners.js";
import { MemoryStopStore } from "../../src/keychain/stop-store.js";
import { MemoryAgentStatus } from "../../src/shared/agent-status.js";
import { keychainStep, loopbackPlatformSteps } from "../../src/keychain/platform-steps.js";

let dir = "";
const env: NodeJS.ProcessEnv = {};
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "doors-"));
  const seedFile = join(dir, "mint.seed");
  writeFileSync(seedFile, new TextDecoder().decode(nkeys.createAccount().getSeed()));
  env.ROOMS_MINT_SEED_FILE = seedFile;
  env.MESH_NAME = "test.mesh";
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rec = (key: string, over: Partial<AgentOwnerRecord>): AgentOwnerRecord => ({
  key, account: null, org: null, home_org: null, person: null, category: "account",
  listed: true, label: null, custody: null, payer: null, updated_at: "x", ...over,
});

function rig(platform: PlatformSteps = {}) {
  const owners = new MemoryAgentOwners();
  const tokens = new BootTokens(memKv("mesh_boot_tokens").kv as never);
  const tombstones = new Map<string, { at: string; reason: string; by: string }>();
  const keyRevs = new Map<string, { at: string; reason: string; by: string; replaced_by?: string }>();
  const mints: Array<Record<string, unknown>> = [];
  const stops = new MemoryStopStore();
  const status = new MemoryAgentStatus();
  const revoked: unknown[] = [];
  const deps: DoorDeps = {
    owners,
    bootTokens: tokens,
    tombstones: {
      get: async (k: string) => tombstones.get(k) ?? null,
      clear: async (k: string) => tombstones.delete(k),
      revoke: async (k: string, reason: string, by: string) => { const r = { at: "now", reason, by }; tombstones.set(k, r); return r; },
    } as never,
    keyRevocations: {
      get: async (k: string) => keyRevs.get(k) ?? null,
      revoke: async (k: string, r: { reason: string; by: string }) => { const x = { at: "now", ...r }; keyRevs.set(k, x); return x; },
    } as never,
    agentStatus: status,
    stops,
    mintLog: { recordMint: async (m: Record<string, unknown>) => { mints.push(m); }, all: async () => mints.map((m) => ({ key: m.key, agents: m.agents, issuedAt: "x", expiresAt: null, renewals: 0 })), cutAt: async () => null } as never,
    revokeCredential: async (input) => { revoked.push(input); return { ok: true, revoked: true, mode: "fallback", note: "n", user_keys: input.userKeys ?? [] } as never; },
    platform,
    baseUrl: "https://api.test/",
    env,
  };
  return { doors: credentialDoors(deps), owners, tokens, tombstones, keyRevs, mints, stops, status, revoked };
}

const sign = (kp: ReturnType<typeof nkeys.createUser>, s: string) => Buffer.from(kp.sign(new TextEncoder().encode(s))).toString("base64");
function renewal(agent: ReturnType<typeof nkeys.createUser>) {
  const node = nkeys.createUser();
  const nodeId = node.getPublicKey();
  const ts = Math.floor(Date.now() / 1000);
  const key = agent.getPublicKey();
  return { node_id: nodeId, ts, node_sig: sign(node, `mesh-node-cred-v1:${ts}:${nodeId}:${key}`), agents: [{ id: key, sig: sign(agent, `mesh-node-agent-v1:${ts}:${nodeId}:${key}`) }] };
}

describe("bootstrap", () => {
  it("with no platform: enrolls a tenant's key, records the agent, clears an old tombstone and logs the mint", async () => {
    const r = rig();
    await r.owners.putTenant({ id: "acct", disabled: false, home_org: "org_h", owner_key: null, updated_at: "x" });
    await r.tokens.put("am_t1", "acct", "laptop");
    const agent = nkeys.createUser().getPublicKey();
    r.tombstones.set(agent, { at: "x", reason: "retired by owner", by: "acct" });
    const out = await r.doors.bootstrap({ token: "am_t1", agent_id: agent });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, label: "laptop", handle: null, account_email: null, renew_url: "https://api.test/v1/node-credential", mesh: { name: "test.mesh" } });
    expect(String(out.body.creds)).toContain("NATS USER JWT");
    expect(out.body.mesh).toMatchObject({ protocol: "0.3" });
    expect(r.owners.agents.get(agent)).toMatchObject({ account: "acct", home_org: "org_h", payer: "acct" });
    expect(r.tombstones.has(agent)).toBe(false);
    expect(r.mints[0]).toMatchObject({ door: "bootstrap", account: "acct", org: "org_h" });
    // Single use.
    expect((await r.doors.bootstrap({ token: "am_t1", agent_id: agent })).status).toBe(400);
  });

  it("answers with the §18.10 mesh object on both bindings: endpoints always, nats_endpoints too on NATS", async () => {
    env.MESH_NATS_ENDPOINTS = "nats://m:4222,wss://m";
    try {
      const r = rig();
      await r.owners.putTenant({ id: "acct", disabled: false, home_org: null, owner_key: null, updated_at: "x" });
      await r.tokens.put("am_n", "acct", "laptop");
      const nats = await r.doors.bootstrap({ token: "am_n", agent_id: nkeys.createUser().getPublicKey() });
      expect(nats.body.mesh).toEqual({ name: "test.mesh", protocol: "0.3", endpoints: ["nats://m:4222", "wss://m"], nats_endpoints: ["nats://m:4222", "wss://m"] });
      env.MESH_BROKER = "rabbitmq";
      env.MESH_AMQP_ENDPOINTS = "amqp://rabbit:5672/mesh";
      await r.tokens.put("am_r", "acct", "laptop");
      const amqp = await r.doors.bootstrap({ token: "am_r", agent_id: nkeys.createUser().getPublicKey() });
      expect(amqp.body.mesh).toEqual({ name: "test.mesh", protocol: "0.3", endpoints: ["amqp://rabbit:5672/mesh"], nats_endpoints: [] });
    } finally {
      delete env.MESH_NATS_ENDPOINTS;
      delete env.MESH_BROKER;
      delete env.MESH_AMQP_ENDPOINTS;
    }
  });

  it("refuses an unknown tenant, a disabled one, and a key another tenant holds (keeping the token)", async () => {
    const r = rig();
    const agent = nkeys.createUser().getPublicKey();
    await r.tokens.put("am_a", "nobody", "x");
    expect((await r.doors.bootstrap({ token: "am_a", agent_id: agent })).status).toBe(404);
    await r.owners.putTenant({ id: "off", disabled: true, home_org: null, owner_key: null, updated_at: "x" });
    await r.tokens.put("am_b", "off", "x");
    expect((await r.doors.bootstrap({ token: "am_b", agent_id: agent })).status).toBe(403);
    await r.owners.putTenant({ id: "acct", disabled: false, home_org: null, owner_key: null, updated_at: "x" });
    await r.owners.putTenant({ id: "other", disabled: false, home_org: null, owner_key: null, updated_at: "x" });
    await r.owners.putAgent(rec(agent, { account: "other" }));
    await r.tokens.put("am_c", "acct", "x");
    const out = await r.doors.bootstrap({ token: "am_c", agent_id: agent });
    expect(out.status).toBe(409);
    expect(await r.tokens.take("am_c")).toMatchObject({ accountId: "acct" });
  });

  it("asks the platform at the same points: the cap before the mint keeps the token; linking and naming after", async () => {
    const enrolled = vi.fn(async () => ({ handle: "laptop.ann@example.com", naming: null, accountEmail: "ann@example.com" }));
    let cap = true;
    const r = rig({
      enrollCheck: async () => (cap ? { found: true, capBlocked: { error: "plan full" } } : { found: true, homeOrg: "org_ann" }),
      enrolled,
    });
    const agent = nkeys.createUser().getPublicKey();
    await r.tokens.put("am_p", "ann", "laptop", "laptop");
    expect(await r.doors.bootstrap({ token: "am_p", agent_id: agent })).toMatchObject({ status: 403, body: { error: "plan full" } });
    expect(enrolled).not.toHaveBeenCalled();
    cap = false;
    const out = await r.doors.bootstrap({ token: "am_p", agent_id: agent });
    expect(out.body).toMatchObject({ handle: "laptop.ann@example.com", account_email: "ann@example.com" });
    expect(enrolled).toHaveBeenCalledWith({ accountId: "ann", agentId: agent, label: "laptop", name: "laptop", org: undefined, deferName: undefined });
    // With a platform, the platform writes the record (through its account store), not the doors.
    expect(r.owners.agents.has(agent)).toBe(false);
  });

  it("a platform that does not answer refuses with 503 and keeps the token", async () => {
    const r = rig({ enrollCheck: async () => { throw new Error("down"); } });
    const agent = nkeys.createUser().getPublicKey();
    await r.tokens.put("am_d", "ann", "x");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await r.doors.bootstrap({ token: "am_d", agent_id: agent })).status).toBe(503);
    expect(await r.tokens.take("am_d")).toBeTruthy();
  });

  it("refuses a stopped agent and a revoked signing key, keeping the token", async () => {
    const r = rig();
    await r.owners.putTenant({ id: "acct", disabled: false, home_org: null, owner_key: null, updated_at: "x" });
    const agent = nkeys.createUser().getPublicKey();
    r.keyRevs.set(agent, { at: "x", reason: "leaked", by: "holder" });
    await r.tokens.put("am_k", "acct", "x");
    expect((await r.doors.bootstrap({ token: "am_k", agent_id: agent })).status).toBe(403);
    const other = nkeys.createUser().getPublicKey();
    await r.stops.put({ id: "stp_1", scope: "person", target: "acct", action: "pause", at: "2026-10-11T00:00:00Z", by: { authority: "owner" }, why: "x" } as never);
    await r.tokens.put("am_s", "acct", "x");
    expect(await r.doors.bootstrap({ token: "am_s", agent_id: other })).toMatchObject({ status: 403, body: { code: "agent_paused" } });
  });
});

describe("node-credential", () => {
  it("renews for a key its tenant holds, refuses a disabled tenant, and leaves a stopped agent off", async () => {
    const r = rig();
    await r.owners.putTenant({ id: "acct", disabled: false, home_org: null, owner_key: null, updated_at: "x" });
    const agent = nkeys.createUser();
    await r.owners.putAgent(rec(agent.getPublicKey(), { account: "acct", person: "acct" }));
    const ok = await r.doors.nodeCredential(renewal(agent), "198.51.100.4", () => ({ name: "m" }));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, agents: [agent.getPublicKey()], mesh: { name: "m" } });
    expect(r.mints.at(-1)).toMatchObject({ door: "renewal", account: "acct" });
    await r.owners.putTenant({ id: "acct", disabled: true, home_org: null, owner_key: null, updated_at: "x" });
    expect((await r.doors.nodeCredential(renewal(agent), "ip", () => ({}))).status).toBe(403);
    await r.owners.putTenant({ id: "acct", disabled: false, home_org: null, owner_key: null, updated_at: "x" });
    await r.stops.put({ id: "stp_2", scope: "person", target: "acct", action: "terminate", at: "2026-10-11T00:00:00Z", by: { authority: "owner" }, why: "x" } as never);
    expect(await r.doors.nodeCredential(renewal(agent), "ip", () => ({}))).toMatchObject({ status: 403, body: { code: "agent_terminated" } });
  });

  it("asks the platform's fallback when the record has no owner", async () => {
    const holderFallback = vi.fn(async () => ({ id: "acct", disabled: true }));
    const r = rig({ holderFallback });
    const agent = nkeys.createUser();
    expect((await r.doors.nodeCredential(renewal(agent), "ip", () => ({}))).status).toBe(403);
    expect(holderFallback).toHaveBeenCalledWith(agent.getPublicKey());
  });

  it("refuses a key no account holds, with names off, and mints nothing (c19)", async () => {
    const r = rig();
    const stranger = nkeys.createUser();
    const out = await r.doors.nodeCredential(renewal(stranger), "ip", () => ({}));
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ code: "no_owner_on_record" });
    expect(String(out.body.error)).toMatch(/^No account on this mesh holds this agent, so no credential was issued\./);
    expect(out.body.jwt).toBeUndefined();
    expect(r.mints).toHaveLength(0);
  });

  it("leaves an agent no account holds off a node's credential, and mints for the rest", async () => {
    const r = rig();
    await r.owners.putTenant({ id: "acct", disabled: false, home_org: null, owner_key: null, updated_at: "x" });
    const mine = nkeys.createUser();
    const stranger = nkeys.createUser();
    await r.owners.putAgent(rec(mine.getPublicKey(), { account: "acct", person: "acct" }));
    const node = nkeys.createUser();
    const nodeId = node.getPublicKey();
    const ts = Math.floor(Date.now() / 1000);
    const roster = [mine.getPublicKey(), stranger.getPublicKey()].sort();
    const out = await r.doors.nodeCredential({
      node_id: nodeId, ts, node_sig: sign(node, `mesh-node-cred-v1:${ts}:${nodeId}:${roster.join(",")}`),
      agents: [mine, stranger].map((a) => ({ id: a.getPublicKey(), sig: sign(a, `mesh-node-agent-v1:${ts}:${nodeId}:${a.getPublicKey()}`) })),
    }, "ip", () => ({}));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ agents: [mine.getPublicKey()], unowned: [stranger.getPublicKey()] });
    expect(r.mints.at(-1)).toMatchObject({ agents: [mine.getPublicKey()], account: "acct" });
  });

  it("mints for a key the platform's fallback says an account holds", async () => {
    const r = rig({ holderFallback: async () => ({ id: "acct" }) });
    const agent = nkeys.createUser();
    const out = await r.doors.nodeCredential(renewal(agent), "ip", () => ({}));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ agents: [agent.getPublicKey()] });
    expect(out.body.unowned).toBeUndefined();
  });

  it("refuses a bad signature before anything is read", async () => {
    const r = rig({ holderFallback: async () => { throw new Error("must not be asked"); } });
    const agent = nkeys.createUser();
    const req = renewal(agent);
    req.agents[0]!.sig = sign(nkeys.createUser(), "nope");
    expect((await r.doors.nodeCredential(req, "ip", () => ({}))).status).toBe(401);
  });
});

describe("the key-standing door", () => {
  const ask = (kp: ReturnType<typeof nkeys.createUser>, over: Record<string, unknown> = {}) => {
    const ts = Math.floor(Date.now() / 1000);
    const key = kp.getPublicKey();
    return { agent_key: key, ts, sig: sign(kp, keyStandingStatement(ts, key)), ...over };
  };

  it("says whether an account holds the caller's own key, and only to its holder", async () => {
    const r = rig();
    await r.owners.putTenant({ id: "acct", disabled: false, home_org: null, owner_key: null, updated_at: "x" });
    const mine = nkeys.createUser();
    await r.owners.putAgent(rec(mine.getPublicKey(), { account: "acct" }));
    expect(await r.doors.keyStanding(ask(mine), "ip")).toMatchObject({ status: 200, body: { enrolled: true } });
    const stranger = nkeys.createUser();
    expect(await r.doors.keyStanding(ask(stranger), "ip")).toMatchObject({ status: 200, body: { enrolled: false } });
    // Signed by another key: refused before anything is read.
    expect((await r.doors.keyStanding(ask(stranger, { agent_key: mine.getPublicKey() }), "ip")).status).toBe(401);
    expect((await r.doors.keyStanding(ask(mine, { ts: Math.floor(Date.now() / 1000) - 3600 }), "ip")).status).toBe(401);
    expect((await r.doors.keyStanding({ agent_key: "nope" }, "ip")).status).toBe(400);
  });

  it("a disabled account does not count as holding it", async () => {
    const r = rig();
    await r.owners.putTenant({ id: "off", disabled: true, home_org: null, owner_key: null, updated_at: "x" });
    const kp = nkeys.createUser();
    await r.owners.putAgent(rec(kp.getPublicKey(), { account: "off" }));
    expect(await r.doors.keyStanding(ask(kp), "ip")).toMatchObject({ status: 200, body: { enrolled: false, account_disabled: true } });
  });
});

describe("revocation and the key check", () => {
  it("revoke-own refuses a key the mesh never issued, and revokes one it did", async () => {
    const r = rig();
    const user = nkeys.createUser();
    const ts = Math.floor(Date.now() / 1000);
    const body = { user_key: user.getPublicKey(), ts, sig: sign(user, `mesh-cred-revoke-v1:${ts}:${user.getPublicKey()}`) };
    expect((await r.doors.revokeOwnCredential(body)).status).toBe(404);
    r.mints.push({ key: user.getPublicKey(), agents: ["UX"] });
    expect((await r.doors.revokeOwnCredential(body)).status).toBe(200);
    expect(r.revoked).toEqual([{ userKeys: [user.getPublicKey()], reason: "revoked by its holder", by: "holder", refuseRenewal: false, deregister: false }]);
  });

  it("revoke-own for an agent key records it and the key check says so, with the platform's advisory", async () => {
    const r = rig({ advisory: async () => ({ tier: "provider", severity: "high", id: "adv1", title: "t" }) });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const agent = nkeys.createUser();
    const key = agent.getPublicKey();
    expect(await r.doors.keyCheck(key)).toMatchObject({ status: 200, body: { revoked: false, advisory: { id: "adv1" } } });
    const ts = Math.floor(Date.now() / 1000);
    const { revokeOwnStatement } = await import("../../src/keychain/agent-key-rotate.js");
    const out = await r.doors.revokeOwnAgentKey({ agent_key: key, ts, sig: sign(agent, revokeOwnStatement(ts, key)) }, "ip");
    expect(out.status).toBe(200);
    await r.status.set(key, { status: "paused", since: "2026-10-11T00:00:00Z" } as never);
    expect(await r.doors.keyCheck(key)).toMatchObject({ status: 200, headers: { "cache-control": "public, max-age=15" }, body: { revoked: true, stopped: "paused" } });
    expect((await r.doors.keyCheck("nope")).status).toBe(400);
  });
});

describe("the platform's steps over loopback", () => {
  it("each step goes to /internal/keychain/<step> and comes back the same", async () => {
    const steps: PlatformSteps = {
      enrollCheck: async (a, k) => ({ found: true, email: `${a}:${k}` }),
      enrolled: async (i) => ({ handle: i.name ?? null, naming: null, accountEmail: i.accountId }),
      namingRefusal: async () => ({ status: 403, body: { code: "x" } }),
      advisory: async () => null,
      systemKeys: async () => ["US"],
      holderFallback: async (k) => ({ id: k }),
      placeFallback: async (keys) => keys.map((k) => ({ key: k, person: "p", org: null })),
      capabilities: async () => ({ profile: "full", services: { schedules: ["list"] } }),
    };
    const fetchImpl = vi.fn(async (url: string, init: { body: string }) => {
      const step = url.split("/internal/keychain/")[1]!;
      const r = await keychainStep(steps, step, JSON.parse(init.body));
      return new Response(JSON.stringify(r.body), { status: r.status });
    });
    const remote = loopbackPlatformSteps("http://127.0.0.1:3001/", fetchImpl as never);
    expect(await remote.enrollCheck!("a", "k")).toEqual({ found: true, email: "a:k" });
    expect(await remote.enrolled!({ accountId: "a", agentId: "k", label: "l", name: "n" })).toEqual({ handle: "n", naming: null, accountEmail: "a" });
    expect(await remote.namingRefusal!("a", "k")).toEqual({ status: 403, body: { code: "x" } });
    expect(await remote.advisory!("k")).toBeNull();
    expect(await remote.systemKeys!()).toEqual(["US"]);
    expect(await remote.holderFallback!("k")).toEqual({ id: "k" });
    expect(await remote.placeFallback!(["k"])).toEqual([{ key: "k", person: "p", org: null }]);
    expect(await remote.capabilities!()).toEqual({ profile: "full", services: { schedules: ["list"] } });
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://127.0.0.1:3001/internal/keychain/enroll-check");
  });

  it("a step the platform cannot answer is an error, never a no", async () => {
    const remote = loopbackPlatformSteps("http://127.0.0.1:1", (async () => new Response("{}", { status: 503 })) as never);
    await expect(remote.holderFallback!("k")).rejects.toThrow(/did not answer holder/);
    expect((await keychainStep({}, "holder", { key: "k" })).status).toBe(404);
  });
});
