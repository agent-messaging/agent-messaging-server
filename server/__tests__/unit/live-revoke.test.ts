import { describe, it, expect } from "vitest";
import { nkeys } from "nats";
import { decode, encodeAccount } from "nats-jwt";
import {
  liveRevokeConfig,
  resignWithRevocations,
  revokeLive,
  fallbackWindow,
  SIGNING_KEY_SETTING,
  SYS_CREDS_SETTING,
  ACCOUNT_SETTING,
  type BrokerAdmin,
} from "../../src/keychain/live-revoke.js";

const td = new TextDecoder();
const operatorSigner = nkeys.createOperator();
const signerSeed = td.decode(operatorSigner.getSeed());
const account = nkeys.createAccount();
const accountId = account.getPublicKey();
const userA = nkeys.createUser().getPublicKey();
const userB = nkeys.createUser().getPublicKey();
const earlier = nkeys.createUser().getPublicKey();

async function liveAccountJwt(): Promise<string> {
  return encodeAccount(
    "agentmesh",
    account as never,
    {
      limits: { subs: -1, conn: -1, leaf: -1, imports: -1, exports: -1, data: -1, payload: -1, wildcards: true, mem_storage: -1, disk_storage: -1, streams: -1, consumer: -1 } as never,
      default_permissions: { pub: { deny: ["mesh.peer.>"] }, sub: { deny: ["mesh.peer.>"] } } as never,
      signing_keys: [nkeys.createAccount().getPublicKey()] as never,
      revocations: { [earlier]: 1_700_000_000 },
    },
    { signer: operatorSigner as never },
  );
}

describe("resignWithRevocations", () => {
  it("adds the keys, keeps every other claim, and is signed by the operator signing key", async () => {
    const live = await liveAccountJwt();
    const out = await resignWithRevocations(live, [userA, userB, "not-a-key"], 1_800_000_000, signerSeed, accountId);
    const c = decode<Record<string, unknown>>(out.jwt) as unknown as {
      sub: string; iss: string; name: string;
      nats: { type: string; revocations: Record<string, number>; default_permissions: unknown; signing_keys: unknown; limits: unknown };
    };
    expect(c.sub).toBe(accountId);
    expect(c.iss).toBe(operatorSigner.getPublicKey());
    expect(c.name).toBe("agentmesh");
    expect(c.nats.type).toBe("account");
    expect(c.nats.revocations[userA]).toBe(1_800_000_000);
    expect(c.nats.revocations[userB]).toBe(1_800_000_000);
    // An earlier revocation survives: the update only ever adds.
    expect(c.nats.revocations[earlier]).toBe(1_700_000_000);
    const before = decode<Record<string, unknown>>(live) as unknown as { nats: Record<string, unknown> };
    expect(c.nats.default_permissions).toEqual(before.nats.default_permissions);
    expect(c.nats.signing_keys).toEqual(before.nats.signing_keys);
    expect(c.nats.limits).toEqual(before.nats.limits);
    expect(out.added.sort()).toEqual([userA, userB].sort());
  });

  it("never moves a revocation earlier, which would un-revoke credentials issued in between", async () => {
    const live = await liveAccountJwt();
    const out = await resignWithRevocations(live, [earlier], 1_600_000_000, signerSeed);
    const c = decode(out.jwt) as unknown as { nats: { revocations: Record<string, number> } };
    expect(c.nats.revocations[earlier]).toBe(1_700_000_000);
    expect(out.added).toEqual([]);
  });

  it("refuses an answer about a different account", async () => {
    const live = await liveAccountJwt();
    const other = nkeys.createAccount().getPublicKey();
    await expect(resignWithRevocations(live, [userA], 1, signerSeed, other)).rejects.toThrow(/not/);
  });

  it("refuses when there is nothing to revoke", async () => {
    const live = await liveAccountJwt();
    await expect(resignWithRevocations(live, ["nope"], 1, signerSeed)).rejects.toThrow(/no user public keys/);
  });
});

describe("liveRevokeConfig", () => {
  const files: Record<string, string> = {
    "/c/op.nk": signerSeed,
    // A fake creds file. The marker is assembled, not written out, so the
    // repository's secret scan does not read this fixture as a real one.
    "/c/sys.creds": `${"-----BEGIN"} NATS USER JWT-----\nx.y.z\n------END NATS USER JWT------\n`,
    "/c/account.nk": td.decode(account.getSeed()),
  };
  const read = (p: string) => {
    if (!(p in files)) throw new Error("ENOENT");
    return Buffer.from(files[p]);
  };
  const env = (over: Record<string, string | undefined> = {}) => ({
    [SIGNING_KEY_SETTING]: "/c/op.nk",
    [SYS_CREDS_SETTING]: "/c/sys.creds",
    [ACCOUNT_SETTING]: accountId,
    NATS_URL: "localhost:4222",
    ...over,
  }) as NodeJS.ProcessEnv;

  it("is configured when all three settings are present and readable", () => {
    const r = liveRevokeConfig(env(), read);
    expect(r.ok).toBe(true);
  });

  it("names the missing setting", () => {
    const r = liveRevokeConfig(env({ [SIGNING_KEY_SETTING]: undefined }), read);
    expect(r).toEqual({ ok: false, reason: `${SIGNING_KEY_SETTING} is not set` });
  });

  it("names the unreadable file by path and never quotes a seed", () => {
    const r = liveRevokeConfig(env({ [SYS_CREDS_SETTING]: "/c/missing.creds" }), read);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("/c/missing.creds");
    // The account seed is not an operator signing seed; the refusal says so
    // without printing it.
    const wrong = liveRevokeConfig(env({ [SIGNING_KEY_SETTING]: "/c/account.nk" }), read);
    expect(wrong.ok).toBe(false);
    expect((wrong as { reason: string }).reason).not.toContain(files["/c/account.nk"]);
    expect((wrong as { reason: string }).reason).toContain("operator signing seed");
  });
});

/** A broker stand-in that records calls and drops connections after the push. */
function fakeBroker(opts: { liveJwt: string; connected: Set<string>; dropAfterPolls?: number; refuse?: string }) {
  const calls: string[] = [];
  let pushed: string | null = null;
  let polls = 0;
  const admin: BrokerAdmin = {
    async lookupAccount(id) {
      calls.push(`lookup:${id.slice(0, 4)}`);
      return pushed ?? opts.liveJwt;
    },
    async pushAccount(jwt) {
      calls.push("push");
      if (opts.refuse) throw new Error(opts.refuse);
      pushed = jwt;
    },
    async stillConnected(_id, keys) {
      calls.push("connz");
      polls++;
      if (pushed && polls >= (opts.dropAfterPolls ?? 1)) {
        const revoked = (decode(pushed) as unknown as { nats: { revocations: Record<string, number> } }).nats.revocations;
        for (const k of keys) if (revoked[k] !== undefined) opts.connected.delete(k);
      }
      return keys.filter((k) => opts.connected.has(k));
    },
    async close() { calls.push("close"); },
  };
  return { admin, calls, pushedJwt: () => pushed };
}

describe("revokeLive", () => {
  it("reads, re-signs, pushes, then verifies the connection is gone while another stays", async () => {
    const connected = new Set([userA, userB]);
    const b = fakeBroker({ liveJwt: await liveAccountJwt(), connected, dropAfterPolls: 2 });
    let t = 1_900_000_000_000;
    const r = await revokeLive({
      admin: b.admin, accountId, signingSeed: signerSeed, userKeys: [userA],
      now: () => t, sleep: async (ms) => { t += ms; },
    });
    expect(b.calls.slice(0, 2)).toEqual([`lookup:${accountId.slice(0, 4)}`, "push"]);
    expect(r.verified).toBe(true);
    expect(r.stillConnected).toEqual([]);
    expect(connected.has(userB)).toBe(true);
  });

  it("reports a connection that outlived the window instead of claiming success", async () => {
    const connected = new Set([userA]);
    const b = fakeBroker({ liveJwt: await liveAccountJwt(), connected, dropAfterPolls: 10_000 });
    let t = 1_900_000_000_000;
    const r = await revokeLive({
      admin: b.admin, accountId, signingSeed: signerSeed, userKeys: [userA],
      now: () => t, sleep: async (ms) => { t += ms; }, verifyWithinMs: 2000,
    });
    expect(r.verified).toBe(false);
    expect(r.stillConnected).toEqual([userA]);
  });

  it("throws when the broker refuses the update, so the caller can fall back and say so", async () => {
    const b = fakeBroker({ liveJwt: await liveAccountJwt(), connected: new Set(), refuse: "the broker refused the account update: not trusted" });
    await expect(revokeLive({ admin: b.admin, accountId, signingSeed: signerSeed, userKeys: [userA] })).rejects.toThrow(/not trusted/);
  });

  it("serializes: two revocations in flight both end up in the live JWT", async () => {
    const connected = new Set<string>();
    const b = fakeBroker({ liveJwt: await liveAccountJwt(), connected });
    await Promise.all([
      revokeLive({ admin: b.admin, accountId, signingSeed: signerSeed, userKeys: [userA], sleep: async () => {} }),
      revokeLive({ admin: b.admin, accountId, signingSeed: signerSeed, userKeys: [userB], sleep: async () => {} }),
    ]);
    const rev = (decode(b.pushedJwt()!) as unknown as { nats: { revocations: Record<string, number> } }).nats.revocations;
    expect(rev[userA]).toBeTypeOf("number");
    expect(rev[userB]).toBeTypeOf("number");
  });
});

describe("fallbackWindow", () => {
  const now = Date.parse("2026-09-27T00:00:00Z");
  it("states the latest expiry and the span", () => {
    const s = fallbackWindow(["2026-09-29T00:00:00Z", "2026-10-03T00:00:00Z"], now);
    expect(s).toContain("2026-10-03T00:00:00.000Z");
    expect(s).toContain("about 6 days");
  });
  it("says so when a credential never expires", () => {
    expect(fallbackWindow([null], now)).toMatch(/no expiry/);
  });
});
