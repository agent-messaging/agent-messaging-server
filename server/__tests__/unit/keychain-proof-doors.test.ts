/**
 * The bootstrap and renewal doors with outside proofs (keychain/doors.ts,
 * SPEC §4.14): enrolling into the tenant a trust record names, the identity
 * source and workload binding recorded, one outside identity to one agent,
 * and the fresh-proof rule at renewal (i01, i09).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nkeys } from "nats";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { memKv } from "../helpers/fake-kv.js";
import { credentialDoors, type DoorDeps } from "../../src/keychain/doors.js";
import { BootTokens } from "../../src/keychain/boot-tokens.js";
import { MemoryAgentOwners } from "../../src/keychain/agent-owners.js";
import { MemoryStopStore } from "../../src/keychain/stop-store.js";
import { MemoryAgentStatus } from "../../src/shared/agent-status.js";
import { MemoryTrustAnchors } from "../../src/keychain/trust-anchors.js";
import { ReplayCache } from "../../src/keychain/outside-proof.js";
import { MemoryIdentitySources, MemoryWorkloadBindings } from "../../src/keychain/identity-records.js";
import { identityAttester } from "../../src/keychain/mesh-api.js";
import { verifyTrustAttestation } from "../../src/sdk.js";

const ISSUER = "https://login.example.com";
const AUD = "https://api.test";
let dir = "";
const env: NodeJS.ProcessEnv = {};
let key: CryptoKey;
let jwk: JWK;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "proof-doors-"));
  const seedFile = join(dir, "mint.seed");
  writeFileSync(seedFile, new TextDecoder().decode(nkeys.createAccount().getSeed()));
  env.ROOMS_MINT_SEED_FILE = seedFile;
  env.MESH_NAME = "test.mesh";
  const kp = await generateKeyPair("ES256");
  key = kp.privateKey as CryptoKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1" };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function rig() {
  const owners = new MemoryAgentOwners();
  await owners.putTenant({ id: "acme", disabled: false, home_org: null, owner_key: null, updated_at: "x" });
  const trust = new MemoryTrustAnchors();
  await trust.add("acme", { kind: "oauth", id: "o1", issuer: ISSUER, audience: AUD, require_binding: false, added_at: "x", added_by: "t" });
  const sources = new MemoryIdentitySources();
  const workloads = new MemoryWorkloadBindings();
  const keyRevs = new Map<string, unknown>();
  const deps: DoorDeps = {
    owners,
    bootTokens: new BootTokens(memKv("mesh_boot_tokens").kv as never),
    tombstones: { get: async () => null, clear: async () => true } as never,
    keyRevocations: {
      get: async (k: string) => keyRevs.get(k) ?? null,
      revoke: async (k: string, r: Record<string, unknown>) => { keyRevs.set(k, r); return r; },
    } as never,
    agentStatus: new MemoryAgentStatus(),
    stops: new MemoryStopStore(),
    mintLog: { recordMint: async () => undefined, all: async () => [], cutAt: async () => null } as never,
    revokeCredential: async (input) => ({ ok: true, revoked: true, mode: "fallback", note: "n", user_keys: input.userKeys ?? [] }) as never,
    platform: {},
    baseUrl: "https://api.test/",
    env,
    proofs: {
      anchors: () => trust.all(),
      keys: { oauthKeys: async () => ({ keys: [jwk as Record<string, unknown>] }), spiffeBundle: async () => ({ keys: [] }) },
      defaultAudience: AUD,
      replay: new ReplayCache(),
    },
    identitySources: sources,
    workloads,
    attest: identityAttester(env),
  };
  return { doors: credentialDoors(deps), owners, sources, workloads, keyRevs, trust };
}

const tok = (sub: string, over: Record<string, unknown> = {}) =>
  new SignJWT({ iss: ISSUER, aud: AUD, sub, ...over }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuedAt().setExpirationTime("10m").sign(key);

const sign = (kp: ReturnType<typeof nkeys.createUser>, s: string) => Buffer.from(kp.sign(new TextEncoder().encode(s))).toString("base64");
function renewal(agent: ReturnType<typeof nkeys.createUser>, extra: Record<string, unknown> = {}) {
  const node = nkeys.createUser();
  const nodeId = node.getPublicKey();
  const ts = Math.floor(Date.now() / 1000);
  const k = agent.getPublicKey();
  return { node_id: nodeId, ts, node_sig: sign(node, `mesh-node-cred-v1:${ts}:${nodeId}:${k}`), agents: [{ id: k, sig: sign(agent, `mesh-node-agent-v1:${ts}:${nodeId}:${k}`), ...extra }] };
}

describe("bootstrap with an outside proof", () => {
  it("enrolls into the trusting tenant and records a signed identity source and the workload binding (i01)", async () => {
    const r = await rig();
    const agent = nkeys.createUser().getPublicKey();
    const out = await r.doors.bootstrap({ agent_id: agent, proof: { kind: "oauth", token: await tok("buyer") } });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, label: "buyer", identity_source: { kind: "oauth", issuer: ISSUER, workload_id: "buyer" }, renew_url: "https://api.test/v1/node-credential" });
    expect(String(out.body.creds)).toContain("NATS USER JWT");
    expect(r.owners.agents.get(agent)).toMatchObject({ account: "acme", label: "buyer" });
    const rec = r.sources.map.get(agent)!;
    expect(rec).toMatchObject({ tenant: "acme", identity_source: { kind: "oauth" } });
    expect(verifyTrustAttestation(rec.attestation as never, agent)).toBe(true);
    expect([...r.workloads.map.values()][0]).toMatchObject({ agent, tenant: "acme", workload_id: "buyer" });
  });

  it("refuses a proof when the mesh offers none, and answers the proof's own refusal otherwise", async () => {
    const r = await rig();
    const agent = nkeys.createUser().getPublicKey();
    const none = credentialDoors({ owners: null, bootTokens: null, tombstones: null, keyRevocations: null, agentStatus: null, stops: null, mintLog: null, revokeCredential: async () => ({}) as never, platform: {}, baseUrl: "x", env });
    expect(await none.bootstrap({ agent_id: agent, proof: { kind: "oauth", token: "x" } })).toMatchObject({ status: 403, body: { code: "proofs_not_offered" } });
    const wrong = await r.doors.bootstrap({ agent_id: agent, proof: { kind: "oauth", token: await tok("buyer", { aud: "https://elsewhere" }) } });
    expect(wrong).toMatchObject({ status: 401, body: { code: "proof_wrong_audience" } });
    expect(r.owners.agents.has(agent)).toBe(false);
  });

  it("refuses a disabled tenant, a revoked key and a key another tenant holds", async () => {
    const r = await rig();
    const agent = nkeys.createUser().getPublicKey();
    await r.owners.putAgent({ key: agent, account: "someone-else", org: null, home_org: null, person: null, category: "account", listed: true, label: null, custody: null, payer: null, updated_at: "x" });
    await r.owners.putTenant({ id: "someone-else", disabled: false, home_org: null, owner_key: null, updated_at: "x" });
    expect(await r.doors.bootstrap({ agent_id: agent, proof: { kind: "oauth", token: await tok("buyer") } })).toMatchObject({ status: 409 });
    const revoked = nkeys.createUser().getPublicKey();
    r.keyRevs.set(revoked, { at: "x" });
    expect(await r.doors.bootstrap({ agent_id: revoked, proof: { kind: "oauth", token: await tok("buyer") } })).toMatchObject({ status: 403, body: { code: "agent_key_revoked" } });
    await r.owners.putTenant({ id: "acme", disabled: true, home_org: null, owner_key: null, updated_at: "x" });
    expect(await r.doors.bootstrap({ agent_id: nkeys.createUser().getPublicKey(), proof: { kind: "oauth", token: await tok("buyer") } })).toMatchObject({ status: 403, body: { code: "account_disabled" } });
  });

  it("one outside identity holds one agent: a new key enrolling with it replaces the old, whose key is revoked", async () => {
    const r = await rig();
    const first = nkeys.createUser().getPublicKey();
    const second = nkeys.createUser().getPublicKey();
    expect((await r.doors.bootstrap({ agent_id: first, proof: { kind: "oauth", token: await tok("buyer") } })).status).toBe(200);
    const again = await r.doors.bootstrap({ agent_id: second, proof: { kind: "oauth", token: await tok("buyer") } });
    expect(again).toMatchObject({ status: 200, body: { replaced: first } });
    expect(r.keyRevs.get(first)).toMatchObject({ replaced_by: second });
    expect([...r.workloads.map.values()][0]).toMatchObject({ agent: second });
  });

  it("the default enrollment records its identity source as the mesh's own", async () => {
    const r = await rig();
    const deps2Tokens = new BootTokens(memKv("mesh_boot_tokens").kv as never);
    const sources = new MemoryIdentitySources();
    const doors = credentialDoors({
      owners: r.owners, bootTokens: deps2Tokens, tombstones: null, keyRevocations: null, agentStatus: null, stops: null, mintLog: null,
      revokeCredential: async () => ({}) as never, platform: {}, baseUrl: "https://api.test", env, identitySources: sources,
    });
    await deps2Tokens.put("am_k", "acme", "laptop");
    const agent = nkeys.createUser().getPublicKey();
    expect((await doors.bootstrap({ token: "am_k", agent_id: agent })).status).toBe(200);
    expect(sources.map.get(agent)).toMatchObject({ tenant: "acme", identity_source: { kind: "mesh" } });
  });
});

describe("renewal of an agent that enrolled with an outside proof", () => {
  it("needs a fresh proof of the same identity (i09); one for another identity, or none, leaves it off", async () => {
    const r = await rig();
    const agent = nkeys.createUser();
    expect((await r.doors.bootstrap({ agent_id: agent.getPublicKey(), proof: { kind: "oauth", token: await tok("buyer") } })).status).toBe(200);
    const bare = await r.doors.nodeCredential(renewal(agent), "1.2.3.4", () => ({}));
    expect(bare).toMatchObject({ status: 401, body: { code: "fresh_proof_required" } });
    const other = await r.doors.nodeCredential(renewal(agent, { proof: { kind: "oauth", token: await tok("someone-else") } }), "1.2.3.4", () => ({}));
    expect(other).toMatchObject({ status: 401, body: { code: "fresh_proof_mismatch" } });
    const fresh = await r.doors.nodeCredential(renewal(agent, { proof: { kind: "oauth", token: await tok("buyer") } }), "1.2.3.4", () => ({}));
    expect(fresh).toMatchObject({ status: 200, body: { ok: true, agents: [agent.getPublicKey()] } });
  });

  it("is refused once its trust record is removed, because the fresh proof no longer checks", async () => {
    const r = await rig();
    const agent = nkeys.createUser();
    await r.doors.bootstrap({ agent_id: agent.getPublicKey(), proof: { kind: "oauth", token: await tok("buyer") } });
    await r.trust.remove("acme", "o1");
    const out = await r.doors.nodeCredential(renewal(agent, { proof: { kind: "oauth", token: await tok("buyer") } }), "1.2.3.4", () => ({}));
    expect(out).toMatchObject({ status: 401, body: { code: "proof_issuer_untrusted" } });
  });

  it("an agent enrolled with a one-time key renews as before, with no proof", async () => {
    const r = await rig();
    const agent = nkeys.createUser();
    await r.owners.putAgent({ key: agent.getPublicKey(), account: "acme", org: null, home_org: null, person: "acme", category: "account", listed: true, label: null, custody: null, payer: "acme", updated_at: "x" });
    const out = await r.doors.nodeCredential(renewal(agent), "1.2.3.4", () => ({}));
    expect(out.status).toBe(200);
  });
});
