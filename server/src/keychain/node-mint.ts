/**
 * The one place a durable connection credential is minted (SPEC §4.8).
 *
 * WHY THIS FILE EXISTS
 *
 * There were two mints. `POST /v1/node-credential` did it right — the node's
 * own key, the enumerated node permission template, and `{ exp: now + 30d }` —
 * and had zero callers. `POST /v1/bootstrap`, the door every real agent walks
 * through, did it with `{}` as the options argument, which writes no `exp`
 * claim at all. `nats-jwt`'s `initClaim` reads `exp`, `nbf` and `aud` off that
 * argument and nothing else sets one, so every credential the platform ever
 * handed a customer is valid forever. SPEC §4.8: "Node credentials MUST have a
 * finite expiration."
 *
 * Two mints that were supposed to agree, one of them wrong, and the wrong one
 * carrying all the traffic. So there is now one mint, and the expiry lives in
 * it rather than at each call site. This is the same argument `cred-template.ts`
 * makes about permissions, one field over.
 *
 * WHAT THE TWO DOORS STILL DIFFER ON, LEGITIMATELY
 *
 * Only the key. `/v1/bootstrap` generates the connection keypair server-side and
 * returns the seed, because the whole point of bootstrap is that the caller does
 * not have a credential yet. `/v1/node-credential` binds to a key the caller
 * already holds and returns no seed. Everything downstream of "which key" —
 * permissions, assertions, expiry, claim shape — is this module.
 *
 * WHY THE PERMISSION SHAPES CAN SAFELY CONVERGE
 *
 * `nodePermissions(k, [a])` and `durableAgentPermissions(a)` produce the same
 * subject SETS: `nodePermissions` never reads its `nodeKey` argument, and its
 * per-agent loop emits exactly what the durable template emits for one agent.
 * Bootstrap moving onto the node template therefore changes no agent's
 * authority, only its expiry. `cred-template.test.ts` pins that equality so a
 * future edit to one template cannot silently change what bootstrap grants.
 */
import { nkeys } from "../sdk.js";
import { encodeUser } from "nats-jwt";
import { nodePermissions, assertNarrowNode } from "./cred-template.js";

/** Default lifetime of a node credential, in days. Seven since 2026-09-27
 *  (docs/live-revocation-plan.md item 4), down from thirty. The client renews
 *  at two thirds of the credential's OWN lifetime, so a healthy node re-mints a
 *  little before day five and checks hourly after that, with more than two
 *  days in hand before the edge. The shorter lease bounds the fallback
 *  revocation window (refuse-renewal, cred-revocation.ts) to a week wherever
 *  live revocation is not available. Credentials already minted for thirty
 *  days keep working until they renew, and renew onto this lifetime. */
export const DEFAULT_CRED_TTL_DAYS = 7;

/**
 * How the flip is sequenced (`MESH_CRED_EXPIRY`).
 *
 * `on` (default) — every mint carries an `exp`. This is what §4.8 requires and
 *   what a fresh deployment should run.
 *
 * `off` — mint with no `exp`, the pre-2026-08 behaviour. It does two jobs, and
 *   the deployed mesh is currently using the first:
 *
 *   - **Sequencer.** This code shipped ahead of a fleet that could renew, so
 *     `ecosystem.config.cjs` sets it off. Fusing credentials against adapters
 *     that cannot renew would kill every newly bootstrapped agent thirty days
 *     later with nothing in the logs to explain it.
 *   - **Rollback.** Once it is deleted, putting it back stops issuing fused
 *     credentials within one restart if the renewal path turns out to be
 *     broken, instead of discovering the problem twenty days later when the
 *     first lease comes due.
 *
 *   Anything already minted with an expiry keeps it, and anything minted
 *   without one never comes due — this switch governs issuance, never what is
 *   already in the field. See docs/credential-expiry-migration.md.
 *
 * Deliberately NOT a per-account or per-request option. An expiry a caller can
 * decline is not an expiry.
 */
export type CredExpiryMode = "on" | "off";

export function credExpiryMode(env: NodeJS.ProcessEnv = process.env): CredExpiryMode {
  return env.MESH_CRED_EXPIRY === "off" ? "off" : "on";
}

/** Configured credential lifetime in seconds, or `null` when issuance is in the
 *  no-expiry rollback mode. A non-numeric or non-positive `MESH_CRED_TTL_DAYS`
 *  falls back to the default rather than minting something absurd. */
export function credTtlSeconds(env: NodeJS.ProcessEnv = process.env): number | null {
  if (credExpiryMode(env) === "off") return null;
  const raw = Number(env.MESH_CRED_TTL_DAYS);
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CRED_TTL_DAYS;
  return Math.floor(days * 24 * 3600);
}

export interface NodeMintRequest {
  /** The key the credential is bound to: a public nkey string (bind to a key
   *  the caller already holds) or a keypair (a fresh server-generated
   *  connection key, whose seed the caller will be handed). */
  subject: string | ReturnType<typeof nkeys.createUser>;
  /** Every agent this credential's permissions cover. At least one. */
  agentIds: string[];
  /** The account signing seed (`ROOMS_MINT_SEED_FILE`'s contents). */
  mintSeed: string;
  /** `ROOMS_MINT_ISSUER_ACCOUNT`, when the signing key is a scoped signer. */
  issuerAccount?: string;
  /** Override the configured lifetime, in seconds. For tests and for a
   *  deliberately short-lived mint; `null` means no expiry. */
  ttlSec?: number | null;
  /** Name prefix in the JWT, for operator legibility. */
  namePrefix?: string;
  now?: number;
}

export interface NodeMintResult {
  jwt: string;
  /** Unix seconds, or `null` when minted without an expiry. */
  expSec: number | null;
  /** ISO-8601, or `null`. What a client stores to schedule its own renewal. */
  expiresAt: string | null;
  /** The public key the JWT is bound to. */
  subject: string;
}

/**
 * Mint one durable connection credential.
 *
 * Throws if the permissions do not pass `assertNarrowNode` — the mint fails
 * loudly rather than issuing something broad, which is the lesson of the
 * 2026-07-26 empty-permissions incident restated here so that adding a third
 * door cannot repeat it.
 */
export async function mintNodeCredential(req: NodeMintRequest): Promise<NodeMintResult> {
  const ids = [...new Set(req.agentIds)];
  if (!ids.length) throw new Error("a node credential must cover at least one agent");

  const subjectKey = typeof req.subject === "string" ? req.subject : req.subject.getPublicKey();
  const perms = nodePermissions(subjectKey, ids);
  assertNarrowNode(perms, ids);

  const claim: Record<string, unknown> = { ...perms };
  if (req.issuerAccount) claim.issuer_account = req.issuerAccount;

  const ttl = req.ttlSec === undefined ? credTtlSeconds() : req.ttlSec;
  const now = req.now ?? Date.now();
  const expSec = ttl === null ? null : Math.floor(now / 1000) + ttl;

  const acctKp = nkeys.fromSeed(new TextEncoder().encode(req.mintSeed));
  const name = `${req.namePrefix ?? "node"}-${subjectKey.slice(0, 8)}`;
  const jwt = await encodeUser(
    name,
    req.subject as never,
    acctKp,
    claim as never,
    expSec === null ? {} : { exp: expSec },
  );

  return {
    jwt,
    expSec,
    expiresAt: expSec === null ? null : new Date(expSec * 1000).toISOString(),
    subject: subjectKey,
  };
}
