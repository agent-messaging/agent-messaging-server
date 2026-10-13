import { describe, it, expect, afterEach } from "vitest";
import { nkeys } from "nats";
import { decode, type User } from "nats-jwt";
import { mintNodeCredential, credTtlSeconds, credExpiryMode, DEFAULT_CRED_TTL_DAYS } from "../../src/keychain/node-mint.js";
import { durableAgentPermissions, nodePermissions } from "../../src/keychain/cred-template.js";

// The §4.8 credential lifecycle, at the layer under the HTTP handler.
//
// The violation this pins shut: `POST /v1/bootstrap` minted with `{}` as
// nats-jwt's options argument, which writes no `exp` claim, so every credential
// a real user holds was valid forever. SPEC §4.8: "Node credentials MUST have a
// finite expiration." The compliant thirty-day route existed beside it and had
// zero callers. There is now one mint and this is its contract.

const acct = nkeys.createAccount();
const mintSeed = new TextDecoder().decode(acct.getSeed());
const userKey = () => nkeys.createUser().getPublicKey();

const savedEnv = { ...process.env };
afterEach(() => {
  process.env.MESH_CRED_EXPIRY = savedEnv.MESH_CRED_EXPIRY;
  process.env.MESH_CRED_TTL_DAYS = savedEnv.MESH_CRED_TTL_DAYS;
  if (savedEnv.MESH_CRED_EXPIRY === undefined) delete process.env.MESH_CRED_EXPIRY;
  if (savedEnv.MESH_CRED_TTL_DAYS === undefined) delete process.env.MESH_CRED_TTL_DAYS;
});

describe("credential expiry policy", () => {
  it("expires by default, at seven days", () => {
    delete process.env.MESH_CRED_EXPIRY;
    delete process.env.MESH_CRED_TTL_DAYS;
    expect(credExpiryMode()).toBe("on");
    expect(DEFAULT_CRED_TTL_DAYS).toBe(7);
    expect(credTtlSeconds()).toBe(7 * 24 * 3600);
  });

  it("honours a configured lifetime, and ignores a nonsensical one", () => {
    process.env.MESH_CRED_TTL_DAYS = "30";
    expect(credTtlSeconds()).toBe(30 * 24 * 3600);
    // A typo must not mint something absurd (or, worse, already expired).
    process.env.MESH_CRED_TTL_DAYS = "not-a-number";
    expect(credTtlSeconds()).toBe(DEFAULT_CRED_TTL_DAYS * 24 * 3600);
    process.env.MESH_CRED_TTL_DAYS = "-1";
    expect(credTtlSeconds()).toBe(DEFAULT_CRED_TTL_DAYS * 24 * 3600);
  });

  it("MESH_CRED_EXPIRY=off is the documented rollback, and only that", () => {
    process.env.MESH_CRED_EXPIRY = "off";
    expect(credExpiryMode()).toBe("off");
    expect(credTtlSeconds()).toBeNull();
    // Any other value means on — the switch fails toward the compliant state.
    process.env.MESH_CRED_EXPIRY = "yes-please";
    expect(credExpiryMode()).toBe("on");
  });
});

describe("mintNodeCredential", () => {
  it("BOOTSTRAP-SHAPED MINT CARRIES AN EXPIRY (the §4.8 violation, closed)", async () => {
    // Exactly what handleBootstrap does: a fresh server-generated connection
    // keypair, one agent, no explicit ttl.
    delete process.env.MESH_CRED_EXPIRY;
    delete process.env.MESH_CRED_TTL_DAYS;
    const ukp = nkeys.createUser();
    const agent = userKey();
    const before = Math.floor(Date.now() / 1000);

    const minted = await mintNodeCredential({
      subject: ukp,
      agentIds: [agent],
      mintSeed,
      namePrefix: "agent",
    });

    const claim = decode<User>(minted.jwt);
    expect(claim.exp).toBeTypeOf("number");
    expect(claim.exp).toBeGreaterThan(before);
    // Seven days (the default since 2026-09-27), within a second of now.
    expect(claim.exp! - before).toBeGreaterThanOrEqual(7 * 24 * 3600 - 2);
    expect(claim.exp! - before).toBeLessThanOrEqual(7 * 24 * 3600 + 2);
    // Bound to the generated connection key, whose seed the caller is handed.
    expect(claim.sub).toBe(ukp.getPublicKey());
    // And reported, so a client need not decode the JWT to schedule renewal.
    expect(minted.expSec).toBe(claim.exp);
    expect(minted.expiresAt).toBe(new Date(claim.exp! * 1000).toISOString());
  });

  it("node-shaped mint binds to a caller-held key and returns no seed", async () => {
    const node = userKey();
    const a1 = userKey();
    const a2 = userKey();
    const minted = await mintNodeCredential({ subject: node, agentIds: [a1, a2], mintSeed });
    const claim = decode<User>(minted.jwt);
    expect(claim.sub).toBe(node);
    const n = claim.nats as Partial<User>;
    for (const k of [a1, a2]) {
      expect(n.sub?.allow).toContain(`mesh.agent.${k}.inbox`);
      expect(n.pub?.allow).toContain(`$JS.API.STREAM.INFO.MESH_INBOX_${k}`);
    }
    expect(n.sub?.allow).not.toContain("mesh.agent.*.inbox");
  });

  it("mints without an expiry ONLY under the rollback switch", async () => {
    process.env.MESH_CRED_EXPIRY = "off";
    const minted = await mintNodeCredential({ subject: userKey(), agentIds: [userKey()], mintSeed });
    expect(minted.expSec).toBeNull();
    expect(minted.expiresAt).toBeNull();
    expect(decode<User>(minted.jwt).exp).toBeUndefined();
  });

  it("refuses a mint with no agents rather than issuing something broad", async () => {
    await expect(mintNodeCredential({ subject: userKey(), agentIds: [], mintSeed })).rejects.toThrow(
      /at least one agent/,
    );
  });

  it("deduplicates the roster", async () => {
    const a = userKey();
    const minted = await mintNodeCredential({ subject: userKey(), agentIds: [a, a, a], mintSeed });
    const n = decode<User>(minted.jwt).nats as Partial<User>;
    expect(n.sub?.allow?.filter((s) => s === `mesh.agent.${a}.inbox`)).toHaveLength(1);
  });

  it("carries issuer_account when the signing key is a scoped signer", async () => {
    const minted = await mintNodeCredential({
      subject: userKey(),
      agentIds: [userKey()],
      mintSeed,
      issuerAccount: "AXXXX",
    });
    expect((decode<User>(minted.jwt) as { nats?: Record<string, unknown> }).nats?.issuer_account).toBe("AXXXX");
  });
});

describe("bootstrap's move onto the node template changes no authority", () => {
  // The load-bearing claim behind step 2 of this change. Bootstrap used to mint
  // `durableAgentPermissions(agent)`; it now mints `nodePermissions(connKey,
  // [agent])`. If those two ever stop agreeing, bootstrap silently starts
  // granting something different — which is exactly the class of drift the
  // single mint exists to prevent. Sets, not order: the templates build the
  // same subjects in a different sequence.
  it("nodePermissions(k, [a]) is set-equal to durableAgentPermissions(a)", () => {
    const conn = userKey();
    const agent = userKey();
    const node = nodePermissions(conn, [agent]);
    const durable = durableAgentPermissions(agent);
    const set = (xs: string[]) => [...new Set(xs)].sort();

    expect(set(node.pub.allow)).toEqual(set(durable.pub.allow));
    expect(set(node.pub.deny)).toEqual(set(durable.pub.deny));
    expect(set(node.sub.allow)).toEqual(set(durable.sub.allow));
    expect(set(node.sub.deny)).toEqual(set(durable.sub.deny));
  });

  it("and the connection key grants nothing on its own", () => {
    // nodePermissions never reads its nodeKey argument — the subjects come from
    // the agent roster alone. Pinned because bootstrap's connection key is NOT
    // the agent key, so a template that started scoping to it would hand the
    // connection key an inbox nobody owns.
    const agent = userKey();
    const one = nodePermissions(userKey(), [agent]);
    const two = nodePermissions(userKey(), [agent]);
    expect(one).toEqual(two);
  });
});
