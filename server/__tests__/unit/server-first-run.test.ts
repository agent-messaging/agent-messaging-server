/**
 * First-run setup (setup/first-run.ts and setup/nats-setup.ts, step 7 of
 * docs/agent-messaging-server-plan.md): what it makes, that the key chain it
 * makes hangs together the way the broker and the key chain read it, that it
 * runs once and never replaces a file, and that nothing it prints or writes
 * where others can read holds a secret.
 *
 * That the broker accepts the result, and that the core comes up on it and
 * passes the core conformance profile, is proven against a real broker by the
 * release workflow's smoke test (.github/workflows/release-images.yml) and in
 * the plan's notes for step 7.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nkeys } from "nats";
import { decode } from "nats-jwt";
import { firstRun, summary, SetupRefused, type FirstRunOutcome } from "../../src/setup/first-run.js";
import { loadServerEnv, parseSettingsFile } from "../../src/setup/server-env.js";
import { liveRevokeConfig } from "../../src/keychain/live-revoke.js";
import { customerMintSeed, customerSigningKey, splitKeysAgree } from "../../src/keychain/split-keys.js";
import { identityFromEnv } from "../../src/shared/seed.js";
import { coreCapabilities } from "../../src/shared/capabilities.js";

/** Anything shaped like an nkey seed: a whole token of exactly 58 base32
 *  characters, "S" and the key type first (SO, SA, SU, SN, SC, SX). A public key
 *  is 56 characters and starts O, A or U, so it can never match. The pattern
 *  used to be unanchored (/S[OAU][A-Z2-7]{50,}/), and about one public key in
 *  130 holds "SO", "SA" or "SU" early enough to match inside it, which failed
 *  this file at random against first-run.json (CI, 2026-10-12). */
const SEED = /(?<![A-Z2-7])S[OAUNCX][A-Z2-7]{56}(?![A-Z2-7])/;

type Claims = { iss: string; sub: string; name: string; nats: Record<string, any> };
const jwtOf = (path: string): Claims => decode(readFileSync(path, "utf8").trim()) as unknown as Claims;
const credsJwt = (path: string): Claims => {
  const m = readFileSync(path, "utf8").match(/BEGIN NATS USER JWT-----\r?\n(.+)\r?\n/);
  return decode(m![1]!.trim()) as unknown as Claims;
};
/** Settings files write paths with forward slashes (setup/server-env.ts). */
const slash = (p: string) => p.replace(/\\/g, "/");
const pub = (seedFile: string) => nkeys.fromSeed(new TextEncoder().encode(readFileSync(seedFile, "utf8").trim())).getPublicKey();

let root: string;
let dir: string;
let outcome: FirstRunOutcome;
let printed: string;
const env = { MESH_NAME: "test-mesh" } as NodeJS.ProcessEnv;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "first-run-"));
  dir = join(root, "config");
  outcome = await firstRun({ dir, env });
  printed = summary(outcome).join("\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("first-run setup", () => {
  it("makes the broker's keys, the server's credentials, the admin token and the settings", () => {
    expect(outcome.done).toBe("now");
    for (const f of [
      "first-run.json", "server.env", "a2a-gateway.env", "nats/nats.conf",
      "creds/core.creds", "creds/platform.creds", "creds/a2a-gateway.creds", "creds/sys.creds",
      "creds/operator-signing.nk", "creds/core-mint.nk", "creds/customer-mint.nk", "creds/mesh-admin.token",
      "creds/registry.nk", "creds/rooms.nk",
      "keystore/test-mesh/test-mesh.jwt", "keystore/test-mesh/accounts/SYS/SYS.jwt", "keystore/test-mesh/accounts/mesh/mesh.jwt",
    ]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
  });

  it("signs the chain the way the broker and the key chain read it", () => {
    const record = outcome.record as Record<string, string>;
    const op = jwtOf(join(dir, "keystore/test-mesh/test-mesh.jwt"));
    expect(op.iss).toBe(op.sub); // the operator signs itself
    expect(op.sub).toBe(record.operator);
    expect(op.nats.signing_keys).toEqual([pub(join(dir, "creds/operator-signing.nk"))]);
    expect(op.nats.system_account).toBe(record.system_account);

    const sys = jwtOf(join(dir, "keystore/test-mesh/accounts/SYS/SYS.jwt"));
    const mesh = jwtOf(join(dir, "keystore/test-mesh/accounts/mesh/mesh.jwt"));
    // Accounts are signed by the operator signing key, so the identity key stays offline.
    expect(sys.iss).toBe(record.operator_signing_key);
    expect(mesh.iss).toBe(record.operator_signing_key);
    expect(mesh.nats.limits.disk_storage).toBe(-1); // JetStream on
    expect(mesh.nats.signing_keys).toEqual([pub(join(dir, "creds/core-mint.nk")), pub(join(dir, "creds/customer-mint.nk"))]);

    for (const u of ["core", "platform", "a2a-gateway"]) {
      const c = credsJwt(join(dir, "creds", `${u}.creds`));
      expect(c.iss, u).toBe(record.server_signing_key);
      expect(c.nats.issuer_account, u).toBe(record.account);
    }
    expect(credsJwt(join(dir, "creds/sys.creds")).nats.issuer_account).toBe(record.system_account);
  });

  it("lets only the platform's user publish on mesh.admin.>", () => {
    expect(credsJwt(join(dir, "creds/core.creds")).nats.pub.deny).toContain("mesh.admin.>");
    expect(credsJwt(join(dir, "creds/a2a-gateway.creds")).nats.pub.deny).toEqual(expect.arrayContaining(["mesh.admin.>", "$KV.>", "$SYS.>"]));
    expect(credsJwt(join(dir, "creds/platform.creds")).nats.pub.deny ?? []).not.toContain("mesh.admin.>");
  });

  it("writes a broker configuration on the full resolver with both accounts preloaded", () => {
    const conf = readFileSync(join(dir, "nats/nats.conf"), "utf8");
    const record = outcome.record as Record<string, string>;
    expect(conf).toMatch(/type: full/);
    expect(conf).toContain(`system_account: ${record.system_account}`);
    expect(conf).toContain(`  ${record.system_account}: `);
    expect(conf).toContain(`  ${record.account}: `);
    expect(conf).not.toMatch(SEED);
  });

  it("gives the server settings the key chain accepts: live revocation and both mint keys", () => {
    const settings = Object.fromEntries(parseSettingsFile(readFileSync(join(dir, "server.env"), "utf8")));
    const live = liveRevokeConfig(settings);
    expect(live.ok).toBe(true);
    const seed = customerMintSeed(settings);
    expect(seed.ok && seed.split).toBe(true);
    expect(splitKeysAgree((seed as { seed: string }).seed, customerSigningKey(settings)!)).toBe(true);
    expect(settings.MESH_NAME).toBe("test-mesh");
    expect(settings.MESH_ADMIN_TOKEN_FILE).toBe(slash(join(dir, "creds", "mesh-admin.token")));
  });

  it("puts no secret in what it prints or in what others may read", () => {
    const token = readFileSync(join(dir, "creds/mesh-admin.token"), "utf8").trim().split(/\s+/).pop()!;
    expect(token.length).toBeGreaterThanOrEqual(32);
    for (const text of [printed, readFileSync(join(dir, "server.env"), "utf8"), readFileSync(join(dir, "a2a-gateway.env"), "utf8"), readFileSync(join(dir, "first-run.json"), "utf8")]) {
      expect(text).not.toMatch(SEED);
      expect(text).not.toContain(token);
      expect(text).not.toContain("BEGIN NATS USER JWT");
    }
    expect(printed).toMatch(/KEEP A COPY OF THE OPERATOR KEY/);
  });

  it.skipIf(process.platform === "win32")("writes secrets readable by their owner only", () => {
    for (const f of readdirSync(join(dir, "creds"))) {
      expect((statSync(join(dir, "creds", f)).mode & 0o077), f).toBe(0);
    }
    expect(statSync(join(dir, "keystore")).mode & 0o077).toBe(0);
  });

  it("runs once: a second run changes nothing", async () => {
    const before = readFileSync(join(dir, "creds/core.creds"), "utf8");
    const again = await firstRun({ dir, env });
    expect(again.done).toBe("already");
    expect(readFileSync(join(dir, "creds/core.creds"), "utf8")).toBe(before);
    expect(summary(again).join("\n")).toMatch(/Nothing was changed/);
  });

  it("refuses a folder that holds part of a setup", async () => {
    const half = join(root, "half");
    mkdirSync(join(half, "creds"), { recursive: true });
    await expect(firstRun({ dir: half, env })).rejects.toBeInstanceOf(SetupRefused);
    expect(readdirSync(half)).toEqual(["creds"]);
  });

  it("refuses a broker it cannot set up, by name", async () => {
    await expect(firstRun({ dir: join(root, "other"), env: { ...env, MESH_BROKER: "kafka" } })).rejects.toThrow(/MESH_BROKER is "kafka"/);
  });
});

describe("the server's settings file", () => {
  it("fills only settings the environment does not already have", () => {
    const e = { MESH_CONFIG_DIR: dir, MESH_NAME: "from-the-environment" } as NodeJS.ProcessEnv;
    const loaded = loadServerEnv(e);
    expect(loaded?.applied).toContain("NATS_CREDS");
    expect(e.MESH_NAME).toBe("from-the-environment");
    expect(e.NATS_CREDS).toBe(slash(join(dir, "creds", "core.creds")));
  });

  it("is not required", () => {
    expect(loadServerEnv({ MESH_CONFIG_DIR: join(root, "nothing-here") } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("a service identity from a file", () => {
  it("reads <NAME>_FILE when <NAME> is not set, and the value wins when it is", () => {
    const file = join(root, "svc.nk");
    const kp = nkeys.createUser();
    writeFileSync(file, new TextDecoder().decode(kp.getSeed()));
    const saved = { ...process.env };
    try {
      delete process.env.FIRST_RUN_TEST_SEED;
      process.env.FIRST_RUN_TEST_SEED_FILE = file;
      expect(identityFromEnv("FIRST_RUN_TEST_SEED").getPublicKey()).toBe(kp.getPublicKey());
      const other = nkeys.createUser();
      process.env.FIRST_RUN_TEST_SEED = new TextDecoder().decode(other.getSeed());
      expect(identityFromEnv("FIRST_RUN_TEST_SEED").getPublicKey()).toBe(other.getPublicKey());
    } finally {
      process.env = saved;
    }
  });
});

describe("the release number in the capabilities answer", () => {
  it("is there for a released image and left out for a source run", () => {
    expect(coreCapabilities({ MESH_SERVER_VERSION: "0.1.0" } as NodeJS.ProcessEnv).server).toEqual({ name: "Agent Messaging Server", version: "0.1.0" });
    expect("server" in coreCapabilities({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
