/**
 * Split signing keys and the mesh pause (docs/kill-switch-plan.md item 8).
 *
 * WHY
 *
 * Everything on this mesh runs in ONE NATS account. Disabling that account
 * would stop the platform too: the API, the console's connection, the
 * registry, the Mesh System Agents. So the account's user credentials are
 * signed by two different ACCOUNT SIGNING KEYS:
 *
 *   - the platform key (`ROOMS_MINT_SEED_FILE`, as today), for the platform's
 *     own services and in-process agents;
 *   - the customer key (`MESH_CUSTOMER_MINT_SEED_FILE`), for every credential a
 *     customer's node or job is issued (bootstrap, node-credential,
 *     job-credential, app).
 *
 * Taking the customer key's PUBLIC half out of the account JWT's
 * `signing_keys` and pushing the account on the full resolver makes the broker
 * close every connection whose credential that key signed, and refuse them at
 * the door until the key is put back. The platform key stays, so the platform
 * stays up. That is the mesh pause. Putting the key back is the resume: the
 * credentials in hand work again, nothing has to be re-minted.
 * (Proven against nats-server 2.10 in Docker:
 * __tests__/integration/kill-switch-broker.test.ts.)
 *
 * SETTINGS, READ BY EXACT NAME
 *
 *   MESH_CUSTOMER_MINT_SEED_FILE   the customer signing seed (`SA...`), read
 *                                  by the customer mint doors
 *   MESH_CUSTOMER_SIGNING_KEY      its public key (`A...`), what the mesh
 *                                  pause removes and the resume puts back
 *   MESH_ACCOUNT_JWT_HISTORY_DIR   where the account JWT is saved before
 *                                  each change, for the break-glass script
 *                                  (server/tools/break-glass-account.mjs)
 *
 * With the first two unset, the customer doors sign with the platform key as
 * before and the mesh pause falls back to cutting each covered connection one
 * by one (kill-switch-cut.ts), and says so.
 *
 * Nothing here prints a seed. Errors name the setting and the path only.
 */
import { decode as decodeJwt, encode as encodeJwt, Algorithms } from "nats-jwt";
import { nkeys } from "nats";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrokerAdmin } from "./live-revoke.js";

export const CUSTOMER_SEED_SETTING = "MESH_CUSTOMER_MINT_SEED_FILE";
export const CUSTOMER_KEY_SETTING = "MESH_CUSTOMER_SIGNING_KEY";
export const JWT_HISTORY_SETTING = "MESH_ACCOUNT_JWT_HISTORY_DIR";

const ACCOUNT_KEY = /^A[A-Z2-7]{55}$/;

/**
 * The seed a CUSTOMER mint door signs with: the customer key when it is set
 * up, otherwise the platform key, exactly as before the split. Returns the
 * seed or a sentence naming the setting that is wrong; never the contents.
 */
export function customerMintSeed(
  env: NodeJS.ProcessEnv = process.env,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): { ok: true; seed: string; split: boolean } | { ok: false; status: number; error: string } {
  const split = env[CUSTOMER_SEED_SETTING]?.trim();
  const path = split || env.ROOMS_MINT_SEED_FILE?.trim();
  if (!path) return { ok: false, status: 501, error: "credential minting is not configured on this instance" };
  try {
    const seed = read(path).trim();
    if (!seed) throw new Error("empty");
    return { ok: true, seed, split: !!split };
  } catch {
    return { ok: false, status: 501, error: "credential minting key unavailable" };
  }
}

/** The customer key's public half, when the split is set up. */
export function customerSigningKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = env[CUSTOMER_KEY_SETTING]?.trim();
  return k && ACCOUNT_KEY.test(k) ? k : null;
}

/** Check the customer seed and public key belong together, so a mesh pause
 *  never removes a key the doors are not signing with. */
export function splitKeysAgree(seed: string, publicKey: string): boolean {
  try {
    return nkeys.fromSeed(new TextEncoder().encode(seed)).getPublicKey() === publicKey;
  } catch {
    return false;
  }
}

type SigningKeyEntry = string | { key?: string; [k: string]: unknown };

interface AccountClaims {
  sub?: string;
  iat?: number;
  jti?: string;
  iss?: string;
  nats?: { type?: string; signing_keys?: SigningKeyEntry[]; [k: string]: unknown };
  [k: string]: unknown;
}

function keyOf(e: SigningKeyEntry): string | undefined {
  return typeof e === "string" ? e : e?.key;
}

/** Whether the account JWT lists this signing key. */
export function listsSigningKey(accountJwt: string, key: string): boolean {
  const c = decodeJwt<Record<string, unknown>>(accountJwt) as unknown as AccountClaims;
  return (c.nats?.signing_keys ?? []).some((e) => keyOf(e) === key);
}

/**
 * The account JWT with `key` taken out of (present=false) or put back into
 * (present=true) its signing keys, re-signed by the operator signing key.
 * Everything else is carried over untouched, revocations included. Returns
 * null when there is nothing to change.
 *
 * A key being put back is added as a plain key. If it was a scoped signing
 * key before the pause, its scope was saved with the JWT in the history
 * directory and the break-glass script restores it; the platform never scopes
 * the customer key itself.
 */
export async function withSigningKey(
  accountJwt: string,
  key: string,
  present: boolean,
  operatorSigningSeed: string,
  expectAccount?: string,
): Promise<string | null> {
  const claims = decodeJwt<Record<string, unknown>>(accountJwt) as unknown as AccountClaims;
  if (claims?.nats?.type !== "account") throw new Error("the broker answered with something that is not an account JWT");
  if (expectAccount && claims.sub !== expectAccount) throw new Error("the broker answered for a different account");
  const keys = [...(claims.nats.signing_keys ?? [])];
  const has = keys.some((e) => keyOf(e) === key);
  if (has === present) return null;
  const next: AccountClaims = {
    ...claims,
    nats: { ...claims.nats, signing_keys: present ? [...keys, key] : keys.filter((e) => keyOf(e) !== key) },
  };
  delete next.jti;
  delete next.iat;
  delete next.iss;
  const kp = nkeys.fromSeed(new TextEncoder().encode(operatorSigningSeed));
  return encodeJwt(Algorithms.v2, next as never, kp as never);
}

/** Save the account JWT as it was before a change, for break-glass. Never
 *  throws: a failed save is reported, and the change goes ahead. */
export function saveAccountJwt(dir: string | undefined, accountId: string, jwt: string, why: string, now = Date.now()): string | null {
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${accountId}.${new Date(now).toISOString().replace(/[:.]/g, "-")}.${why}.jwt`);
    writeFileSync(file, jwt, { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

export interface MeshPauseResult {
  mode: "live" | "fallback";
  changed: boolean;
  note: string;
  still_connected?: number;
}

/**
 * Pause (present=false) or resume (present=true) every customer connection by
 * taking the customer signing key out of the account, or putting it back.
 * The account JWT is read live from the broker, as live-revoke.ts does, so
 * nothing another change added is dropped; the pre-change JWT is saved first.
 */
export async function setCustomerKeyLive(opts: {
  admin: BrokerAdmin;
  accountId: string;
  operatorSigningSeed: string;
  customerKey: string;
  present: boolean;
  historyDir?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<MeshPauseResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const live = await opts.admin.lookupAccount(opts.accountId);
  let next = await withSigningKey(live, opts.customerKey, opts.present, opts.operatorSigningSeed, opts.accountId);
  if (!next) {
    return {
      mode: "live",
      changed: false,
      note: opts.present ? "The customer signing key was already in the account." : "The customer signing key was already out of the account.",
    };
  }
  // The resolver keeps the newer JWT by issue time; make sure this one is.
  const prevIat = (decodeJwt(live) as { iat?: number }).iat ?? 0;
  const newIat = (decodeJwt(next) as { iat?: number }).iat ?? 0;
  if (newIat <= prevIat) {
    await sleep((prevIat - newIat + 1) * 1000);
    next = (await withSigningKey(live, opts.customerKey, opts.present, opts.operatorSigningSeed, opts.accountId))!;
  }
  const saved = saveAccountJwt(opts.historyDir, opts.accountId, live, opts.present ? "before-resume" : "before-pause");
  await opts.admin.pushAccount(next);
  const where = saved ? " The account as it was is saved for break-glass." : opts.historyDir ? " The account as it was could not be saved." : "";
  return {
    mode: "live",
    changed: true,
    note: opts.present
      ? `The customer signing key is back in the account; customer connections can sign in again.${where}`
      : `The customer signing key was taken out of the account; every customer connection was closed and is refused until the mesh is resumed. The platform's own connections stay up.${where}`,
  };
}
