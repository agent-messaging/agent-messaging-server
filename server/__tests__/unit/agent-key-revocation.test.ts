// Agent SIGNING key revocation (SPEC §5.3, docs/live-revocation-plan.md item 5):
// the registry's record, the registry's get and register doors, the renewal
// door, and the owner's rotation.
import { describe, it, expect, vi } from "vitest";
import { handleRegister } from "../../src/registry/handlers/register.js";
import { handleGet } from "../../src/registry/handlers/get.js";
import { createEnvelope, ErrorCode, nkeys, createAttestation } from "../../src/sdk.js";
import type { Manifest } from "../../src/sdk.js";
import { PresenceStore } from "../../src/registry/presence-store.js";
import { NodeProfileStore } from "../../src/registry/node-profile-store.js";
import {
  AgentKeyRevocationStore,
  AGENT_KEY_REVOKED,
  type AgentKeyRevocation,
} from "../../src/shared/agent-key-revocations.js";
import { decideRenewal } from "../../src/keychain/cred-revocation.js";
import { revokeAgentKey, rotateAgentKey, rotateStatement, revokeOwnStatement, type RotateDeps } from "../../src/keychain/agent-key-rotate.js";
import type { CredentialRevokeResult } from "../../src/keychain/credential-revoke.js";

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      put: vi.fn(async (k: string, v: string) => { store.set(k, v); return 1; }),
      get: vi.fn(async (k: string) => {
        const v = store.get(k);
        return v === undefined ? null : { operation: "PUT", value: new TextEncoder().encode(v), json: () => JSON.parse(v) };
      }),
    },
  };
}

const key = () => nkeys.createUser().getPublicKey();

describe("AgentKeyRevocationStore", () => {
  it("records a revocation, keeps the first record, and adds a replacement key later", async () => {
    const { kv } = fakeKv();
    const s = new AgentKeyRevocationStore(kv as never);
    const k = key();
    expect(await s.get(k)).toBeNull();
    const first = await s.revoke(k, { reason: "leaked", by: "holder" });
    const next = key();
    const again = await s.revoke(k, { reason: "leaked again", by: "owner:acct", replaced_by: next });
    expect(again.at).toBe(first.at);
    expect(again.reason).toBe("leaked");
    expect(again.replaced_by).toBe(next);
    expect((await s.get(k))?.replaced_by).toBe(next);
  });

  it("sees a revocation another process made once the short negative answer runs out", async () => {
    const { kv } = fakeKv();
    let t = 1_000_000;
    const reader = new AgentKeyRevocationStore(kv as never, () => t);
    const writer = new AgentKeyRevocationStore(kv as never, () => t);
    const k = key();
    expect(await reader.get(k)).toBeNull();
    await writer.revoke(k, { reason: "leaked", by: "holder" });
    t += AgentKeyRevocationStore.NEGATIVE_MS + 1;
    expect(await reader.get(k)).not.toBeNull();
  });
});

function vouchedManifest(): { id: string; manifest: Manifest } {
  const kp = nkeys.createUser();
  const id = kp.getPublicKey();
  const manifest = {
    id, name: "A", description: "a", version: "1.0.0", protocol_version: "0.2.0",
    endpoint: `mesh.agent.${id}.inbox`,
    node: { id, attestation: createAttestation(kp, id) },
    capabilities: ["chat"], offerings: [{ id: "echo", name: "Echo", description: "Echo" }],
  } as unknown as Manifest;
  return { id, manifest };
}

const revokedLookup = (keys: Record<string, AgentKeyRevocation>) => ({ get: async (k: string) => keys[k] ?? null });

describe("the registry answers a revoked key as revoked", () => {
  it("get: UNAUTHORIZED with agent_key_revoked and where the agent went", async () => {
    const k = key();
    const next = key();
    const env = createEnvelope({ type: "discover", from: key(), payload: {} });
    const kv = { get: vi.fn(async () => null) };
    const resp = await handleGet(env, { subject: `mesh.registry.get.${k}` } as never, kv as never, "svc", new Map(),
      revokedLookup({ [k]: { at: "2026-09-27T00:00:00.000Z", reason: "leaked", by: "holder", replaced_by: next } }));
    expect(resp.error?.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(resp.error?.details).toEqual({ reason: AGENT_KEY_REVOKED, revoked_at: "2026-09-27T00:00:00.000Z", replaced_by: next });
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("get: a store that cannot be read answers as before", async () => {
    const k = key();
    const env = createEnvelope({ type: "discover", from: key(), payload: {} });
    const kv = { get: vi.fn(async () => null) };
    const resp = await handleGet(env, { subject: `mesh.registry.get.${k}` } as never, kv as never, "svc", new Map(),
      { get: async () => { throw new Error("down"); } });
    expect(resp.error?.code).toBe(ErrorCode.AGENT_UNAVAILABLE);
  });

  it("register: a revoked key cannot register again", async () => {
    const { id, manifest } = vouchedManifest();
    const env = createEnvelope({ type: "register", from: id, payload: manifest });
    const kv = { put: vi.fn(), get: vi.fn(async () => null) };
    const resp = await handleRegister(env, kv as never, { publish: vi.fn() } as never, "svc", new Map(),
      new PresenceStore(), new NodeProfileStore(), undefined, undefined, {},
      revokedLookup({ [id]: { at: "2026-09-27T00:00:00.000Z", reason: "leaked", by: "holder" } }));
    expect(resp.error?.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(resp.error?.details?.reason).toBe(AGENT_KEY_REVOKED);
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe("renewal refuses a revoked signing key, and re-linking does not lift it", () => {
  it("refuses even when a live account holds the key", async () => {
    const k = key();
    const d = await decideRenewal(
      {
        holderOf: async () => ({ id: "acct" }),
        revocationOf: async () => null,
        signingKeyRevoked: async (x) => x === k,
      },
      [k],
    );
    expect(d.allow).toBe(false);
    expect((d as { status: number }).status).toBe(403);
    expect((d as { error: string }).error).toMatch(/revoked key/);
  });
});

function credResult(): CredentialRevokeResult {
  return {
    ok: true, revoked: true, at: "t", mode: "live", user_keys: [], also_disconnected_agents: [],
    deregistered: true, disconnected: true, still_connected: [], took_ms: 10,
    note: "Revoked on the broker. The connection closed within 0.0 seconds.",
  };
}

function rotateDeps(over: Partial<RotateDeps> = {}) {
  const calls: string[] = [];
  const deps: RotateDeps = {
    markRevoked: async (k, rec) => { calls.push(`mark:${rec.replaced_by ? "replaced" : "plain"}`); return { at: "2026-09-27T00:00:00.000Z", ...rec }; },
    revokeCredentials: async () => { calls.push("credentials"); return credResult(); },
    revokedAlready: async () => false,
    heldElsewhere: async () => false,
    link: async () => { calls.push("link"); return "linked"; },
    unlink: async () => { calls.push("unlink"); return true; },
    handleOf: async () => ({ handle: "helper.ann@example.com", email: "ann@example.com" }),
    moveName: async () => { calls.push("name"); return "moved"; },
    ...over,
  };
  return { deps, calls };
}

describe("rotateAgentKey", () => {
  const base = { accountId: "acct", accountEmail: "ann@example.com", label: "helper" };

  it("revokes first, then links the new key, moves the name, and unlinks the old key", async () => {
    const { deps, calls } = rotateDeps();
    const r = await rotateAgentKey(deps, { ...base, oldKey: key(), newKey: key() });
    expect(calls).toEqual(["mark:replaced", "credentials", "link", "name", "unlink"]);
    expect(r.ok).toBe(true);
    const ok = r as Exclude<typeof r, { ok: false }>;
    expect(ok.name).toBe("moved");
    expect(ok.note).toContain("The name helper.ann@example.com now points at the new key");
    expect(ok.note).not.toContain("—");
  });

  it("refuses a destination that is revoked, taken, or the same key", async () => {
    const k = key();
    expect(await rotateAgentKey(rotateDeps().deps, { ...base, oldKey: k, newKey: k })).toMatchObject({ ok: false, status: 400 });
    expect(await rotateAgentKey(rotateDeps({ revokedAlready: async () => true }).deps, { ...base, oldKey: k, newKey: key() })).toMatchObject({ ok: false, status: 409 });
    expect(await rotateAgentKey(rotateDeps({ heldElsewhere: async () => true }).deps, { ...base, oldKey: k, newKey: key() })).toMatchObject({ ok: false, status: 409 });
  });

  it("keeps the old key listed when the new one could not be added, so the agent is not lost", async () => {
    const { deps, calls } = rotateDeps({ link: async () => "cap" });
    const r = await rotateAgentKey(deps, { ...base, oldKey: key(), newKey: key() });
    expect(calls).not.toContain("unlink");
    expect((r as { note: string }).note).toContain("the old key stays listed");
  });

  it("does not move a name anchored to someone else's email", async () => {
    const { deps, calls } = rotateDeps({ handleOf: async () => ({ handle: "x.bob@example.com", email: "bob@example.com" }) });
    const r = await rotateAgentKey(deps, { ...base, oldKey: key(), newKey: key() });
    expect(calls).not.toContain("name");
    expect((r as { name: string }).name).toMatch(/another email/);
  });
});

describe("revokeAgentKey and the signed statements", () => {
  it("still reports the key revoked when the credential half fails", async () => {
    const r = await revokeAgentKey(
      { markRevoked: async (k, rec) => ({ at: "t", ...rec }), revokeCredentials: async () => { throw new Error("no JetStream"); } },
      key(), "leaked", "holder",
    );
    expect(r.note).toMatch(/^Receivers now refuse messages signed by this key\. The credential could not be revoked: no JetStream\./);
  });

  it("pins the two statement spellings the adapter signs", () => {
    expect(revokeOwnStatement(1, "UK")).toBe("mesh-agent-key-revoke-v1:1:UK");
    expect(rotateStatement(1, "UA", "UB")).toBe("mesh-key-rotate-v1:1:UA:UB");
  });
});
