import { describe, it, expect } from "vitest";
import { nkeys } from "nats";
import { decode, encodeAccount } from "nats-jwt";
import { revokeCredential, type CredentialRevokeDeps } from "../../src/keychain/credential-revoke.js";
import type { BrokerAdmin } from "../../src/keychain/live-revoke.js";
import type { TrackedCred } from "../../src/keychain/cred-renewal-watch.js";

const td = new TextDecoder();
const signer = nkeys.createOperator();
const account = nkeys.createAccount();
const accountId = account.getPublicKey();
const agent = nkeys.createUser().getPublicKey();
const neighbour = nkeys.createUser().getPublicKey();
const nodeKey = nkeys.createUser().getPublicKey();
const otherNode = nkeys.createUser().getPublicKey();

async function accountJwt() {
  return encodeAccount("agentmesh", account as never, {}, { signer: signer as never });
}

function setup(opts: { configured?: boolean; refuse?: boolean } = {}) {
  const calls: string[] = [];
  const purged: string[] = [];
  const open = new Set([nodeKey, otherNode]);
  let pushed: string | null = null;
  let live: string | null = null;
  const tracked: TrackedCred[] = [
    { key: nodeKey, agents: [agent, neighbour], issuedAt: "2026-09-26T00:00:00Z", expiresAt: "2026-10-03T00:00:00Z", renewals: 0 },
    { key: otherNode, agents: [neighbour], issuedAt: "2026-09-26T00:00:00Z", expiresAt: "2026-10-03T00:00:00Z", renewals: 0 },
  ];
  const admin: BrokerAdmin = {
    async lookupAccount() { calls.push("lookup"); return live ??= await accountJwt(); },
    async pushAccount(jwt) {
      calls.push("push");
      if (opts.refuse) throw new Error("not trusted");
      pushed = jwt;
    },
    async stillConnected(_a, keys) {
      calls.push("verify");
      const rev = pushed ? (decode(pushed) as unknown as { nats: { revocations?: Record<string, number> } }).nats.revocations ?? {} : {};
      for (const k of Object.keys(rev)) open.delete(k);
      return keys.filter((k) => open.has(k));
    },
    async close() { calls.push("close"); },
  };
  const deps: CredentialRevokeDeps = {
    tombstone: { async revoke() { calls.push("record"); return { at: "2026-09-27T00:00:00.000Z" }; } },
    mintLog: { async all() { return tracked; }, async purge(k) { purged.push(k); } },
    config: () => opts.configured === false
      ? { ok: false, reason: "MESH_OPERATOR_SIGNING_KEY_FILE is not set" }
      : { ok: true, config: { signingSeed: td.decode(signer.getSeed()), sysCreds: new Uint8Array(), accountId, natsUrl: "x" } },
    connectAdmin: async () => { calls.push("connect"); return admin; },
    deregister: async () => { calls.push("deregister"); },
    now: () => Date.parse("2026-09-27T00:00:00Z"),
    sleep: async () => {},
  };
  return { deps, calls, purged, open };
}

describe("revokeCredential", () => {
  it("records, pushes, deregisters, then verifies, in that order, and names who shared the connection", async () => {
    const s = setup();
    const r = await revokeCredential(s.deps, { agentKey: agent, reason: "leaked", by: "operator" });
    expect(s.calls).toEqual(["record", "connect", "lookup", "push", "deregister", "verify", "close"]);
    expect(r.mode).toBe("live");
    expect(r.disconnected).toBe(true);
    expect(r.user_keys.sort()).toEqual([nodeKey, agent].sort());
    // The other node, carrying only the neighbour, stays connected.
    expect(s.open.has(otherNode)).toBe(true);
    expect(r.also_disconnected_agents).toEqual([neighbour]);
    expect(r.deregistered).toBe(true);
    expect(r.note).toMatch(/^Revoked on the broker\. The connection closed within/);
    expect(r.note).not.toContain("—");
    expect(s.purged).toEqual([nodeKey]);
  });

  it("falls back to refusal to renew when the push path is not configured, and says so with the window", async () => {
    const s = setup({ configured: false });
    const r = await revokeCredential(s.deps, { agentKey: agent, reason: "leaked", by: "operator" });
    expect(s.calls).toEqual(["record", "deregister"]);
    expect(r.mode).toBe("fallback");
    expect(r.fallback_reason).toBe("MESH_OPERATOR_SIGNING_KEY_FILE is not set");
    expect(r.window).toContain("2026-10-03T00:00:00.000Z");
    expect(r.note).toContain("will not be issued another credential");
    expect(r.note).not.toContain("—");
  });

  it("falls back when the broker refuses the push, with the broker's words", async () => {
    const s = setup({ refuse: true });
    const r = await revokeCredential(s.deps, { agentKey: agent, reason: "leaked", by: "operator" });
    expect(r.mode).toBe("fallback");
    expect(r.fallback_reason).toContain("not trusted");
    expect(s.calls).toContain("close");
  });

  it("a holder revoking one connection key leaves the agent in good standing", async () => {
    const s = setup();
    const r = await revokeCredential(s.deps, { userKeys: [otherNode], reason: "holder", by: "holder", refuseRenewal: false, deregister: false });
    expect(s.calls).not.toContain("record");
    expect(s.calls).not.toContain("deregister");
    expect(r.mode).toBe("live");
    expect(r.user_keys).toEqual([otherNode]);
    expect(s.open.has(otherNode)).toBe(false);
    expect(s.open.has(nodeKey)).toBe(true);
  });
});
