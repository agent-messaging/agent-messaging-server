import { describe, it, expect } from "vitest";
import { nkeys } from "nats";
import { decode, encodeUser, type User } from "nats-jwt";
import { verifyAgentSig } from "../../src/admission/held-store.js";
import { nodePermissions, assertNarrowNode, NODE_CREDENTIAL_MAX_AGENTS } from "../../src/keychain/cred-template.js";

// The node-credential contract (`POST /v1/node-credential`), exercised at the
// layer under the HTTP handler: the signature scheme the Egg Gateway's
// `bootstrap_node` produces, verified by the same function the endpoint calls,
// and the JWT minted the same way the endpoint mints it. The full-server suite
// is quarantined (see api-service.test.ts), so this pins the crypto and the
// claim shape — the two halves that would fail silently across the
// Rust-signs / TypeScript-verifies boundary.

function userKeys() {
  const kp = nkeys.createUser();
  return { kp, pub: kp.getPublicKey() };
}

function sign(kp: ReturnType<typeof nkeys.createUser>, msg: string): string {
  return Buffer.from(kp.sign(new TextEncoder().encode(msg))).toString("base64");
}

describe("node credential signing contract", () => {
  const ts = Math.floor(Date.now() / 1000);

  it("verifies the node's roster signature exactly as the Gateway signs it", () => {
    const node = userKeys();
    const a1 = userKeys();
    const a2 = userKeys();
    const roster = [a1.pub, a2.pub].sort().join(",");
    const canonical = `mesh-node-cred-v1:${ts}:${node.pub}:${roster}`;

    expect(verifyAgentSig(node.pub, canonical, sign(node.kp, canonical))).toBe(true);
    // A different roster does not verify — the signature binds the exact set.
    const other = `mesh-node-cred-v1:${ts}:${node.pub}:${a1.pub}`;
    expect(verifyAgentSig(node.pub, other, sign(node.kp, canonical))).toBe(false);
  });

  it("verifies each agent's consent signature, and refuses a swap", () => {
    const node = userKeys();
    const agent = userKeys();
    const stranger = userKeys();
    const canonical = `mesh-node-agent-v1:${ts}:${node.pub}:${agent.pub}`;

    expect(verifyAgentSig(agent.pub, canonical, sign(agent.kp, canonical))).toBe(true);
    // A signature by any other key does not consent for this agent.
    expect(verifyAgentSig(agent.pub, canonical, sign(stranger.kp, canonical))).toBe(false);
    // An agent's consent to node A is not consent to node B.
    const nodeB = userKeys();
    const forB = `mesh-node-agent-v1:${ts}:${nodeB.pub}:${agent.pub}`;
    expect(verifyAgentSig(agent.pub, forB, sign(agent.kp, canonical))).toBe(false);
  });

  it("mints a JWT bound to the node's own key with the enumerated subjects", async () => {
    const node = userKeys();
    const a1 = userKeys();
    const a2 = userKeys();
    const acct = nkeys.createAccount();

    const perms = nodePermissions(node.pub, [a1.pub, a2.pub]);
    assertNarrowNode(perms, [a1.pub, a2.pub]);
    const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    const jwt = await encodeUser(`node-${node.pub.slice(0, 8)}`, node.pub, acct, perms as never, { exp });

    const claim = decode<User>(jwt);
    const n = claim.nats as Partial<User>;
    // Bound to the node key: only the holder of the node seed can use it.
    expect(claim.sub).toBe(node.pub);
    expect(claim.exp).toBe(exp);
    // Every hosted agent's inbox is subscribable; nobody else's is.
    for (const k of [a1.pub, a2.pub]) {
      expect(n.sub?.allow).toContain(`mesh.agent.${k}.inbox`);
      expect(n.pub?.allow).toContain(`$JS.API.STREAM.INFO.MESH_INBOX_${k}`);
    }
    expect(n.sub?.allow).not.toContain("mesh.agent.*.inbox");
    expect(n.sub?.deny).toContain("$KV.>");
  });

  // The adapter node (docs/adapter-node-spec.md section 3) puts hundreds of
  // agents on one credential. The route refuses a roster over the cap, so the
  // cap has to admit the node's design target, and a roster that size has to
  // mint with every agent's inbox enumerated and nothing widened to a
  // wildcard to fit.
  it("admits a roster the size of the adapter node's design target, still enumerated", async () => {
    expect(NODE_CREDENTIAL_MAX_AGENTS).toBeGreaterThanOrEqual(512);
    const node = userKeys();
    const agents = Array.from({ length: NODE_CREDENTIAL_MAX_AGENTS }, () => userKeys().pub);
    const perms = nodePermissions(node.pub, agents);
    assertNarrowNode(perms, agents);
    const acct = nkeys.createAccount();
    const jwt = await encodeUser(`node-${node.pub.slice(0, 8)}`, node.pub, acct, perms as never, {
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const n = decode<User>(jwt).nats as Partial<User>;
    for (const k of [agents[0], agents[agents.length - 1]]) {
      expect(n.sub?.allow).toContain(`mesh.agent.${k}.inbox`);
    }
    expect(n.sub?.allow).not.toContain("mesh.agent.*.inbox");
  });
});
