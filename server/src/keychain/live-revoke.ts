/**
 * Live credential revocation (SPEC §4.8, docs/live-revocation-plan.md items 1-3).
 *
 * WHAT THIS DOES
 *
 * A NATS user credential is revoked by listing its public key in the ACCOUNT
 * JWT's `revocations` map, with the instant of revocation: every user JWT for
 * that key issued at or before that instant stops authenticating. A broker on
 * the full resolver (`resolver: { type: full, ... }`) accepts an updated
 * account JWT at runtime on `$SYS.REQ.CLAIMS.UPDATE`, stores it in its resolver
 * directory, and closes every live connection the update revoked. So the whole
 * revocation is: read the live account JWT, add the key, re-sign, push, and
 * watch the connection go. Nobody restarts anything.
 *
 * Re-signing needs a key the broker trusts to sign account JWTs. That is an
 * OPERATOR SIGNING KEY, listed in the operator JWT's `signing_keys`, never the
 * operator root identity, which stays offline (docs/nsc-keystore-restore.md).
 * The signing key lives on the platform server and is replaceable: drop it
 * from the operator's signing keys and issue another.
 *
 * WHAT IT NEEDS, READ BY EXACT NAME
 *
 *   MESH_OPERATOR_SIGNING_KEY_FILE  path to the operator signing seed (`SO…`)
 *   MESH_SYS_CREDS_FILE             path to a SYSTEM-account user credential,
 *                                   the only kind the broker takes claim
 *                                   updates and connection lists from
 *   ROOMS_MINT_ISSUER_ACCOUNT       the account every platform credential is
 *                                   minted under, whose JWT carries the
 *                                   revocations
 *   NATS_URL                        where the broker is
 *
 * Any of them missing or unreadable means the push path is not configured, and
 * the caller falls back to refusal to renew and says so (cred-revocation.ts).
 * Nothing here ever prints a seed or a credential: errors name the setting and
 * the path, never the contents.
 *
 * WHY READ-MODIFY-WRITE FROM THE BROKER, NOT FROM A FILE
 *
 * The live account JWT is the one that matters. A copy on disk goes stale the
 * moment anyone else re-signs the account (nsc on the workstation, a signing
 * key rotation), and pushing a stale copy with one revocation added would
 * quietly undo whatever the other change did. Reading it from the broker at the
 * moment of revocation means this code only ever adds to what is live.
 * The reverse hazard is real too, and it is documented rather than solved
 * here: an operator who edits the account with nsc must pull the live JWT
 * first, or their push drops the revocations made here (docs/our-instance.md
 * §6.4).
 */
import { connect, credsAuthenticator, nkeys, type NatsConnection } from "nats";
import { decode as decodeJwt, encode as encodeJwt, Algorithms } from "nats-jwt";
import { readFileSync } from "node:fs";

/** The exact setting names. Exported so the runbook test and the operator's
 *  error messages cannot drift from what the code reads. */
export const SIGNING_KEY_SETTING = "MESH_OPERATOR_SIGNING_KEY_FILE";
export const SYS_CREDS_SETTING = "MESH_SYS_CREDS_FILE";
export const ACCOUNT_SETTING = "ROOMS_MINT_ISSUER_ACCOUNT";

const USER_KEY = /^U[A-Z2-7]{55}$/;
const ACCOUNT_KEY = /^A[A-Z2-7]{55}$/;

export interface LiveRevokeConfig {
  signingSeed: string;
  sysCreds: Uint8Array;
  accountId: string;
  natsUrl: string;
  /** Set on the RabbitMQ binding (MESH_BROKER=rabbitmq), whose resolver is a
   *  Postgres row and whose connections are closed through RabbitMQ's
   *  management API (storage/rabbitmq/broker-admin.ts). `sysCreds` and
   *  `natsUrl` are then unused. */
  rabbitmq?: { env: NodeJS.ProcessEnv };
}

/** The RabbitMQ binding's settings for live revocation, read by exact name. */
function rabbitMqRevokeConfig(
  env: NodeJS.ProcessEnv,
  read: (path: string) => Buffer,
): { ok: true; config: LiveRevokeConfig } | { ok: false; reason: string } {
  const keyPath = env[SIGNING_KEY_SETTING]?.trim();
  const accountId = env[ACCOUNT_SETTING]?.trim();
  const needed = [SIGNING_KEY_SETTING, ACCOUNT_SETTING, "MESH_OPERATOR_JWT_FILE", "MESH_RABBITMQ_MANAGEMENT_URL", "MESH_POSTGRES_URL"];
  const missing = needed.filter((n) => !env[n]?.trim());
  if (missing.length) return { ok: false, reason: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set` };
  if (!ACCOUNT_KEY.test(accountId!)) return { ok: false, reason: `${ACCOUNT_SETTING} is not an account public key` };
  let signingSeed: string;
  try {
    signingSeed = read(keyPath!).toString("utf8").trim();
    nkeys.fromSeed(new TextEncoder().encode(signingSeed));
  } catch {
    return { ok: false, reason: `${SIGNING_KEY_SETTING} (${keyPath}) does not hold a readable seed` };
  }
  if (!signingSeed.startsWith("SO")) return { ok: false, reason: `${SIGNING_KEY_SETTING} (${keyPath}) does not hold an operator signing seed` };
  return { ok: true, config: { signingSeed, sysCreds: new Uint8Array(0), accountId: accountId!, natsUrl: "", rabbitmq: { env } } };
}

/**
 * Read the push path's configuration. `{ ok: false }` carries a sentence for
 * the operator saying which setting is missing or unreadable, by name and
 * path, and never what a file contained.
 */
export function liveRevokeConfig(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => Buffer = (p) => readFileSync(p),
): { ok: true; config: LiveRevokeConfig } | { ok: false; reason: string } {
  if (env.MESH_BROKER?.trim().toLowerCase() === "rabbitmq") return rabbitMqRevokeConfig(env, read);
  const keyPath = env[SIGNING_KEY_SETTING]?.trim();
  const credsPath = env[SYS_CREDS_SETTING]?.trim();
  const accountId = env[ACCOUNT_SETTING]?.trim();
  const missing = [
    !keyPath ? SIGNING_KEY_SETTING : null,
    !credsPath ? SYS_CREDS_SETTING : null,
    !accountId ? ACCOUNT_SETTING : null,
  ].filter(Boolean);
  if (missing.length) return { ok: false, reason: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set` };
  if (!ACCOUNT_KEY.test(accountId!)) return { ok: false, reason: `${ACCOUNT_SETTING} is not an account public key` };

  let signingSeed: string;
  try {
    signingSeed = read(keyPath!).toString("utf8").trim();
  } catch {
    return { ok: false, reason: `${SIGNING_KEY_SETTING} points at ${keyPath}, which cannot be read` };
  }
  // An operator signing seed starts "SO". Anything else is the wrong key in
  // the right place, and signing with it would be refused by the broker after
  // a round trip, so say so here instead.
  if (!signingSeed.startsWith("SO")) {
    return { ok: false, reason: `${SIGNING_KEY_SETTING} (${keyPath}) does not hold an operator signing seed` };
  }
  try {
    nkeys.fromSeed(new TextEncoder().encode(signingSeed));
  } catch {
    return { ok: false, reason: `${SIGNING_KEY_SETTING} (${keyPath}) does not hold a valid seed` };
  }

  let sysCreds: Uint8Array;
  try {
    sysCreds = new Uint8Array(read(credsPath!));
  } catch {
    return { ok: false, reason: `${SYS_CREDS_SETTING} points at ${credsPath}, which cannot be read` };
  }
  if (!/BEGIN NATS USER JWT/.test(new TextDecoder().decode(sysCreds))) {
    return { ok: false, reason: `${SYS_CREDS_SETTING} (${credsPath}) is not a NATS credentials file` };
  }

  return {
    ok: true,
    config: { signingSeed, sysCreds, accountId: accountId!, natsUrl: env.NATS_URL ?? "localhost:4222" },
  };
}

/** The claims of an account JWT, as far as this module reads them. */
interface AccountClaims {
  sub?: string;
  iss?: string;
  iat?: number;
  jti?: string;
  name?: string;
  nats?: { type?: string; revocations?: Record<string, number>; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * Return the account JWT with `userKeys` added to its revocations at `atSec`,
 * re-signed by `signingSeed`. Pure apart from the clock `encode` reads for
 * `iat`.
 *
 * Everything else in the claim is carried over untouched: limits, exports,
 * imports, the account's own signing keys, default permissions, every earlier
 * revocation. An existing revocation for the same key keeps the LATER instant,
 * because moving it earlier would un-revoke credentials issued in between.
 */
export async function resignWithRevocations(
  accountJwt: string,
  userKeys: string[],
  atSec: number,
  signingSeed: string,
  expectAccount?: string,
): Promise<{ jwt: string; added: string[]; previousIat: number | null }> {
  const keys = [...new Set(userKeys)].filter((k) => USER_KEY.test(k));
  if (!keys.length) throw new Error("no user public keys to revoke");
  const claims = decodeJwt<Record<string, unknown>>(accountJwt) as unknown as AccountClaims;
  if (claims?.nats?.type !== "account") throw new Error("the broker answered with something that is not an account JWT");
  if (expectAccount && claims.sub !== expectAccount) {
    throw new Error(`the broker answered for account ${String(claims.sub).slice(0, 8)}…, not ${expectAccount.slice(0, 8)}…`);
  }

  const revocations: Record<string, number> = { ...(claims.nats.revocations ?? {}) };
  const added: string[] = [];
  for (const k of keys) {
    const prior = revocations[k];
    if (prior === undefined || prior < atSec) {
      revocations[k] = atSec;
      added.push(k);
    }
  }

  const next: AccountClaims = { ...claims, nats: { ...claims.nats, revocations } };
  const previousIat = typeof claims.iat === "number" ? claims.iat : null;
  // `encode` sets iss and iat afresh and computes jti over the claim as given,
  // so the old ones must not ride along into the new token's hash.
  delete next.jti;
  delete next.iat;
  delete next.iss;
  const kp = nkeys.fromSeed(new TextEncoder().encode(signingSeed));
  const jwt = await encodeJwt(Algorithms.v2, next as never, kp as never);
  return { jwt, added, previousIat };
}

/** One connection the broker reports, reduced to the user key it authenticated. */
function userKeyOf(conn: { authorized_user?: string; jwt?: string }): string | null {
  if (typeof conn.authorized_user === "string" && USER_KEY.test(conn.authorized_user)) return conn.authorized_user;
  if (typeof conn.jwt === "string") {
    try {
      const sub = (decodeJwt(conn.jwt) as { sub?: string }).sub;
      if (typeof sub === "string" && USER_KEY.test(sub)) return sub;
    } catch { /* not a JWT we can read */ }
  }
  return null;
}

/** What the revocation needs from the broker. An interface so the order of
 *  operations can be tested without one. */
export interface BrokerAdmin {
  /** The live account JWT, from the resolver. */
  lookupAccount(accountId: string): Promise<string>;
  /** Push an updated account JWT. Throws with the broker's words on refusal. */
  pushAccount(jwt: string): Promise<void>;
  /** Which of `keys` still hold an open connection in this account. */
  stillConnected(accountId: string, keys: string[]): Promise<string[]>;
  close(): Promise<void>;
}

const te = new TextEncoder();
const td = new TextDecoder();

/** The broker's side, over a SYSTEM-account connection. */
export function natsBrokerAdmin(nc: NatsConnection, timeoutMs = 5000): BrokerAdmin {
  // Measured against nats-server 2.10: on the MEMORY resolver nothing answers
  // the claims subjects, so a request comes back "no responders" (503).
  const noResolver = (err: unknown): never => {
    if ((err as { code?: string })?.code === "503") {
      throw new Error("the broker does not take account updates (it is still on the memory resolver)");
    }
    throw err;
  };
  return {
    async lookupAccount(accountId) {
      const m = await nc
        .request(`$SYS.REQ.ACCOUNT.${accountId}.CLAIMS.LOOKUP`, new Uint8Array(0), { timeout: timeoutMs })
        .catch(noResolver);
      const text = td.decode(m.data).trim();
      if (!text || !text.includes(".")) {
        throw new Error("the broker has no account JWT to give back (is it still on the memory resolver?)");
      }
      return text;
    },
    async pushAccount(jwt) {
      const m = await nc.request("$SYS.REQ.CLAIMS.UPDATE", te.encode(jwt), { timeout: timeoutMs }).catch(noResolver);
      let body: { error?: { code?: number; description?: string }; data?: { code?: number; message?: string } } = {};
      try { body = JSON.parse(td.decode(m.data)); } catch { /* an answer we cannot read is a refusal */ }
      if (body.error || !body.data) {
        throw new Error(`the broker refused the account update: ${body.error?.description ?? "no readable answer"}`);
      }
    },
    async stillConnected(accountId, keys) {
      const want = new Set(keys);
      const found = new Set<string>();
      // Paged, because a busy account has more connections than one answer
      // carries. `auth: true` is what makes the broker say which user each
      // connection authenticated as.
      for (let offset = 0; offset < 100_000; ) {
        const m = await nc.request(
          "$SYS.REQ.SERVER.PING.CONNZ",
          te.encode(JSON.stringify({ acc: accountId, auth: true, offset, limit: 1024 })),
          { timeout: timeoutMs },
        );
        const body = JSON.parse(td.decode(m.data)) as {
          data?: { connections?: Array<{ authorized_user?: string; jwt?: string }>; total?: number; limit?: number };
        };
        const conns = body.data?.connections ?? [];
        for (const c of conns) {
          const k = userKeyOf(c);
          if (k && want.has(k)) found.add(k);
        }
        offset += conns.length;
        if (!conns.length || offset >= (body.data?.total ?? 0)) break;
      }
      return [...found];
    },
    async close() {
      await nc.close().catch(() => undefined);
    },
  };
}

/** Open the SYSTEM-account connection the admin calls ride on. */
export async function connectBrokerAdmin(config: LiveRevokeConfig): Promise<BrokerAdmin> {
  if (config.rabbitmq) {
    const { rabbitMqBrokerAdminFromEnv } = await import("../storage/index.js");
    return rabbitMqBrokerAdminFromEnv(config.rabbitmq.env);
  }
  const nc = await connect({
    servers: config.natsUrl,
    name: "agentmesh-revoker",
    authenticator: credsAuthenticator(config.sysCreds),
    maxReconnectAttempts: 0,
    timeout: 5000,
  });
  return natsBrokerAdmin(nc);
}

export interface LiveRevokeResult {
  /** The account JWT now carries every key asked for. */
  pushed: true;
  /** Keys whose revocation instant this call set (the rest were already
   *  revoked at or after it). */
  added: string[];
  /** Keys still connected when the verify window closed. Empty is success. */
  stillConnected: string[];
  /** Null when the broker's connection list could not be read, so nothing is
   *  claimed either way. */
  verified: boolean | null;
  /** Milliseconds from the push to the last connection closing. */
  tookMs: number;
}

/**
 * Revoke `userKeys` on the running broker and wait for their connections to
 * close. Throws when the account JWT cannot be read, signed or pushed; the
 * caller turns that into the fallback, stated.
 *
 * Serialized process-wide: two revocations racing each other would both read
 * the same account JWT and the second push would drop the first one's key.
 */
export async function revokeLive(opts: {
  admin: BrokerAdmin;
  accountId: string;
  signingSeed: string;
  userKeys: string[];
  now?: () => number;
  verifyWithinMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Runs after the push and before the verify (the revoke action
   *  deregisters the agent here). Its failure does not undo the push. */
  afterPush?: () => Promise<void>;
}): Promise<LiveRevokeResult> {
  const run = async (): Promise<LiveRevokeResult> => {
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const current = await opts.admin.lookupAccount(opts.accountId);
    const atSec = Math.floor(now() / 1000);
    let signed = await resignWithRevocations(current, opts.userKeys, atSec, opts.signingSeed, opts.accountId);
    // The resolver keeps the newer of two JWTs by issue time. A re-sign in
    // the same second as the live one could be taken for a replay of it, so
    // make sure the new one is strictly younger.
    const newIat = (decodeJwt(signed.jwt) as { iat?: number }).iat ?? 0;
    if (signed.previousIat !== null && newIat <= signed.previousIat) {
      await sleep((signed.previousIat - newIat + 1) * 1000);
      signed = await resignWithRevocations(current, opts.userKeys, atSec, opts.signingSeed, opts.accountId);
    }
    await opts.admin.pushAccount(signed.jwt);
    const pushedAt = now();
    if (opts.afterPush) await opts.afterPush().catch(() => undefined);

    const deadline = pushedAt + (opts.verifyWithinMs ?? 10_000);
    let still: string[] = [];
    let verified: boolean | null = null;
    for (;;) {
      try {
        still = await opts.admin.stillConnected(opts.accountId, opts.userKeys);
        verified = still.length === 0;
      } catch {
        verified = null;
      }
      if (verified === true || now() >= deadline) break;
      await sleep(opts.pollMs ?? 500);
    }
    return { pushed: true, added: signed.added, stillConnected: verified === null ? [] : still, verified, tookMs: now() - pushedAt };
  };
  const next = queue.then(run, run);
  queue = next.then(() => undefined, () => undefined);
  return next;
}
let queue: Promise<void> = Promise.resolve();

/**
 * The fallback, in words: what refusal to renew means for these credentials.
 * `expiries` are the ISO expiry of each credential the mint log knows for the
 * agent (null = minted with no expiry).
 */
export function fallbackWindow(expiries: Array<string | null>, nowMs = Date.now()): string {
  if (expiries.some((e) => e === null)) {
    return "At least one credential this agent holds was minted with no expiry, so it stays valid until an operator revokes it at the broker.";
  }
  const future = expiries.map((e) => Date.parse(e as string)).filter((t) => Number.isFinite(t) && t > nowMs);
  if (!future.length) {
    return "No credential this agent holds is known to be valid past now; the one in hand, if any, may still work until its own expiry.";
  }
  const last = Math.max(...future);
  const hours = Math.ceil((last - nowMs) / 3_600_000);
  const span = hours >= 48 ? `about ${Math.round(hours / 24)} days` : `about ${hours} hours`;
  return `The credential it holds keeps working until it expires at ${new Date(last).toISOString()}, ${span} from now.`;
}
