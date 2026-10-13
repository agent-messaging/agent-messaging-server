import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nkeys, keyPairFromSeed } from "../sdk.js";

type KeyPair = ReturnType<typeof nkeys.createUser>;

/**
 * Seed and secret resolution for service startup — the ONE place the
 * "configured vs not configured" line is drawn.
 *
 * The contract, precisely:
 *
 *  - NOT CONFIGURED (the env var is absent) is a documented degradation: the
 *    service runs with an ephemeral identity, or the feature stays disabled.
 *    That is legitimate for a local/dev mesh, so it warns and proceeds.
 *
 *  - CONFIGURED BUT UNUSABLE (the var is set, but the value is empty, the file
 *    is missing or unreadable, or the content is not a valid nkey seed of the
 *    expected type) is FATAL. An operator who sets a variable has stated an
 *    intent, and silently doing something else is the failure mode that hides.
 *    A secret file the service cannot read is indistinguishable from no secret
 *    at all — this is not theoretical: the service seed files were once
 *    installed root-owned while pm2 ran the services as an unprivileged user,
 *    every read failed, every service booted with a fresh ephemeral key, and
 *    nothing complained until a generated key failed to match an expected one.
 *    So these helpers refuse to boot instead of guessing.
 *
 * Every service resolves its signing identity through here rather than with a
 * per-service `env ? fromSeed : createUser()` ternary, because the ternary is
 * exactly the shape that silently falls through.
 */

/** Refuse to boot over a configured-but-unusable secret. Logs the variable and
 *  the precise reason, then exits non-zero — deliberately not a throw, because
 *  a throw can be caught upstream and turned back into the silent fallback
 *  this module exists to kill. */
export function refuseToBoot(varName: string, detail: string): never {
  console.error(`[seed] FATAL: ${detail}`);
  console.error(
    `[seed] ${varName} is configured, so this deployment asked for that secret to be used; ` +
    `falling back silently (ephemeral identity / feature off) would hide the fault. ` +
    `Fix the value it names, or unset ${varName} entirely to run degraded on purpose. Exiting.`,
  );
  process.exit(1);
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Resolve a service signing identity from an env var holding an nkey seed
 * VALUE (e.g. REGISTRY_SEED), or, when that is not set, from the file named
 * by the same name with `_FILE` added (REGISTRY_SEED_FILE), which is how
 * first-run setup hands the core services their identities without putting a
 * seed in a settings file. Neither set → ephemeral keypair for this run, with
 * a warning; set but empty/invalid/unreadable → refuse to boot.
 */
export function identityFromEnv(varName: string): KeyPair {
  const raw = process.env[varName];
  if (raw === undefined && process.env[`${varName}_FILE`] !== undefined) {
    const fileVar = `${varName}_FILE`;
    const seed = seedFileFromEnv(fileVar, { expectPublicPrefix: "U", expectedKind: "a user (U) key" });
    if (seed === null) refuseToBoot(fileVar, `${fileVar} is set but empty.`);
    return keyPairFromSeed(seed);
  }
  if (raw === undefined) {
    console.warn(
      `[seed] ${varName} not set — using an ephemeral identity for this run ` +
      `(fine for a local/dev mesh; set ${varName} for a stable identity)`,
    );
    return nkeys.createUser();
  }
  const seed = raw.trim();
  if (seed === "") {
    refuseToBoot(varName, `${varName} is set but empty (or whitespace-only).`);
  }
  try {
    return keyPairFromSeed(seed);
  } catch (e) {
    refuseToBoot(varName, `${varName} is set but is not a valid nkey seed: ${reason(e)}.`);
  }
}

/**
 * Resolve an nkey seed from a FILE named by an env var (e.g.
 * ROOMS_MINT_SEED_FILE). Absent → null, and the caller degrades the feature it
 * gates; set but missing/unreadable/empty/invalid → refuse to boot, with the
 * resolved path and the underlying errno in the message so `chmod 000` on the
 * file produces an explanation, not a mystery.
 *
 * `expectPublicPrefix` pins the key TYPE (e.g. "A" for an account key that can
 * sign user JWTs) — a well-formed seed of the wrong kind would only fail later,
 * at the broker, where nothing points back at this file.
 */
export function seedFileFromEnv(
  varName: string,
  opts: { expectPublicPrefix?: string; expectedKind?: string } = {},
): string | null {
  const file = process.env[varName];
  if (!file) return null;
  const path = resolve(file);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    refuseToBoot(varName, `${varName} (${path}) could not be read${code ? ` (${code})` : ""}: ${reason(e)}.`);
  }
  const seed = raw.trim();
  if (seed === "") {
    refuseToBoot(varName, `${varName} (${path}) is empty (or whitespace-only).`);
  }
  let kp: KeyPair;
  try {
    kp = nkeys.fromSeed(new TextEncoder().encode(seed));
  } catch (e) {
    refuseToBoot(varName, `${varName} (${path}) does not contain a valid nkey seed: ${reason(e)}.`);
  }
  if (opts.expectPublicPrefix && !kp.getPublicKey().startsWith(opts.expectPublicPrefix)) {
    refuseToBoot(
      varName,
      `${varName} (${path}) holds a ${kp.getPublicKey()[0]}-type key; ` +
      `${opts.expectedKind ?? `a ${opts.expectPublicPrefix}-type key`} is required.`,
    );
  }
  return seed;
}

/** Ed25519 user nkey, public half: `U` + 55 base32 chars. Same shape
 *  `shared/handler.ts` validates connection-bound tokens against. */
const NKEY_PUBLIC = /^U[A-Z2-7]{55}$/;

/** Where an expected-publisher key came from, so the service can SAY at boot
 *  which of the three cases it is in rather than leaving it to be discovered. */
export type ExpectedKey =
  | { key: string; source: "explicit" | "derived"; detail: string }
  | { key: null; source: "unconfigured"; detail: string };

/**
 * Resolve the public key a service should EXPECT on messages from another
 * service — the authorization half that `decode()` does not do.
 *
 * `decode()` verifies an envelope's signature against the key named in the
 * envelope's own `from`. That proves the sender holds the key it claims, and
 * nothing else: on any subject a third party may publish to, it proves only
 * "signed by somebody". Acting on such a message needs a second question — is
 * `from` the identity allowed to cause this? — and that question needs an
 * answer configured out of band, which is what this resolves.
 *
 * Two sources, in this order:
 *
 *  1. `varName` (e.g. REGISTRY_PUBLIC_KEY) holding the expected PUBLIC key.
 *     Preferred: a public key is not a secret, so it can be set on every
 *     consumer without widening anyone's authority, and it works whether the
 *     publisher runs in this process or on another machine.
 *  2. `fallbackSeedVar` (e.g. REGISTRY_SEED) — the publisher's own seed, when
 *     this process happens to hold it. This is NOT a request to distribute a
 *     signing seed to consumers; it exists because `main.ts` can run the
 *     publisher and the consumer in one process, where the seed is already in
 *     the environment by construction and requiring a second variable saying
 *     the same thing would be a configuration trap. Split deployments should
 *     set (1) and must not be given (2).
 *
 * CONTRACT, deliberately different from the seed helpers above. For a signing
 * seed, "absent" means "run with an ephemeral identity", which degrades this
 * service alone. For an expected-publisher key, "absent" means the caller
 * cannot tell a genuine message from a forged one, and the two ways to degrade
 * are refusing every such message (state goes stale) or accepting every one
 * (anyone who can reach the subject can act as the publisher). That is a
 * decision for the caller, not for this module — so absent returns
 * `{ key: null }` WITH a reason string, and the caller must state at boot which
 * way it fails and why. Set-but-unusable stays fatal, exactly as above: an
 * operator who names a key has stated an intent, and a typo that silently
 * became "unconfigured" would turn a fail-closed service into a stale one, or a
 * fail-open one into a vulnerable one, with no signal either way.
 */
export function expectedPublisherKey(
  varName: string,
  fallbackSeedVar?: string,
): ExpectedKey {
  const raw = process.env[varName];
  if (raw !== undefined) {
    const key = raw.trim();
    if (key === "") {
      refuseToBoot(varName, `${varName} is set but empty (or whitespace-only).`);
    }
    if (!NKEY_PUBLIC.test(key)) {
      refuseToBoot(
        varName,
        `${varName} is set but is not a user nkey PUBLIC key (expected "U" + 55 base32 chars, got ` +
        `${key.length} char(s) starting "${key.slice(0, 4)}"). This wants the PUBLIC half — ` +
        `a seed ("SU…") here would never match a sender and every message would be refused.`,
      );
    }
    try {
      nkeys.fromPublic(key);
    } catch (e) {
      refuseToBoot(varName, `${varName} is not a usable nkey public key: ${reason(e)}.`);
    }
    return { key, source: "explicit", detail: `${varName}` };
  }

  if (fallbackSeedVar && process.env[fallbackSeedVar] !== undefined) {
    // Reuse identityFromEnv so a set-but-invalid seed refuses to boot here for
    // the same reason, with the same message, as in the service that signs with it.
    const key = identityFromEnv(fallbackSeedVar).getPublicKey();
    return { key, source: "derived", detail: `derived from ${fallbackSeedVar}` };
  }

  return {
    key: null,
    source: "unconfigured",
    detail:
      `neither ${varName}${fallbackSeedVar ? ` nor ${fallbackSeedVar}` : ""} is set`,
  };
}

/**
 * Resolve a non-nkey secret from a FILE named by an env var (e.g.
 * MESH_OPERATOR_KEY_FILE). Same contract as seedFileFromEnv minus the seed
 * validation: absent → null (caller degrades), set but missing/unreadable/empty
 * → refuse to boot. Returns the trimmed file content.
 */
export function secretFileFromEnv(varName: string): string | null {
  const file = process.env[varName];
  if (!file) return null;
  const path = resolve(file);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    refuseToBoot(varName, `${varName} (${path}) could not be read${code ? ` (${code})` : ""}: ${reason(e)}.`);
  }
  const secret = raw.trim();
  if (secret === "") {
    refuseToBoot(varName, `${varName} (${path}) is empty (or whitespace-only).`);
  }
  return secret;
}
