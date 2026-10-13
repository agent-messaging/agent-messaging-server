/**
 * The admin API's credential issuing routes (step 10a of
 * docs/agent-messaging-server-plan.md): a credential for a key the caller
 * already holds, signed here with the mesh's account signing keys, so a
 * platform running beside the core never holds them. The caller sends only
 * the PUBLIC key the credential binds to; the seed stays with whoever made it,
 * and the credential is useless without it.
 *
 *   POST /admin/v1/credentials/issue  {
 *          kind:   "agent"    an in-process agent's durable credential (durableAgentPermissions)
 *                  "job"      one job's worker credential for `agent` (jobWorkerPermissions, `sends`)
 *                  "node"     a node credential covering `agents` (nodePermissions)
 *                  "console"  the operator console's read-and-watch credential
 *          key,            the public key the credential binds to
 *          agent?, agents?, sends?,
 *          ttl_s?,         seconds; null (node only) for no expiry; defaults per kind
 *          name_prefix?,   the connection name's prefix
 *          signer?,        "platform" (the platform's own services and agents) or "customer" (a
 *                          customer's node, job or app, which the mesh pause reaches); defaults per kind
 *          record?         { label?, door?, account?, org? }: written to the mint log (node only)
 *        } -> { jwt, exp_sec, expires_at, subject, mesh }   `mesh` is SPEC §18.10's object, which
 *                                                         every credential-issuing answer carries
 *   GET  /admin/v1/credentials/signers   { platform, customer }: the signing keys' public halves
 *
 * Every claim is built from the core's templates and checked with their
 * assertions before it is signed, as at every other mint door. Nothing here
 * prints or returns a seed.
 */
import { readFileSync } from "node:fs";
import { encodeUser } from "nats-jwt";
import { nkeys } from "nats";
import type { DoorAnswer } from "../keychain/doors.js";
import type { AdminRequest } from "./admin-api.js";
import type { CredMintLog } from "../keychain/cred-mint-log.js";
import {
  assertConsoleReader,
  assertJobWorkerNarrow,
  assertNarrow,
  consoleReaderPermissions,
  durableAgentPermissions,
  jobWorkerPermissions,
  NODE_CREDENTIAL_MAX_AGENTS,
} from "../keychain/cred-template.js";
import { mintNodeCredential } from "../keychain/node-mint.js";
import { mintAfterCut } from "../keychain/kill-switch-cut.js";
import { customerMintSeed } from "../keychain/split-keys.js";
import { meshInfo } from "../keychain/mesh-object.js";

const NKEY = /^U[A-Z2-7]{55}$/;
const PREFIX = /^[a-z][a-z0-9-]{0,31}$/;
/** The longest lifetime a caller may ask for: a node credential's own default is days, never a year. */
const MAX_TTL_S = 90 * 24 * 3600;

const ok = (body: Record<string, unknown>, status = 200): DoorAnswer => ({ status, body });
const no = (status: number, error: string): DoorAnswer => ({ status, body: { error } });

type Signer = "platform" | "customer";

export interface AdminCredentialDeps {
  env: NodeJS.ProcessEnv;
  mintLog: CredMintLog | null;
  read?: (path: string) => string;
  /** The clock, for tests. */
  now?: () => number;
}

export function adminCredentials(deps: AdminCredentialDeps) {
  const read = deps.read ?? ((p: string) => readFileSync(p, "utf8"));

  /** The seed for a signer, or why there is none. Never the seed in an error. */
  function seedOf(signer: Signer): { ok: true; seed: string } | { ok: false; error: string } {
    if (signer === "customer") {
      const r = customerMintSeed(deps.env, read);
      return r.ok ? { ok: true, seed: r.seed } : { ok: false, error: r.error };
    }
    const path = deps.env.ROOMS_MINT_SEED_FILE?.trim();
    if (!path) return { ok: false, error: "credential minting is not configured on this instance" };
    try {
      const seed = read(path).trim();
      if (!seed) throw new Error("empty");
      return { ok: true, seed };
    } catch {
      return { ok: false, error: "credential minting key unavailable" };
    }
  }

  async function issue(b: Record<string, unknown>): Promise<DoorAnswer> {
    const kind = b.kind;
    const key = typeof b.key === "string" ? b.key : "";
    if (!NKEY.test(key)) return no(400, "key is the public key the credential binds to (U followed by 55 characters).");
    const prefix = b.name_prefix === undefined ? null : typeof b.name_prefix === "string" && PREFIX.test(b.name_prefix) ? b.name_prefix : undefined;
    if (prefix === undefined) return no(400, "name_prefix is lowercase letters, digits and dashes, 32 at most.");
    const ttlRaw = b.ttl_s;
    if (ttlRaw !== undefined && ttlRaw !== null && (typeof ttlRaw !== "number" || !Number.isInteger(ttlRaw) || ttlRaw < 60 || ttlRaw > MAX_TTL_S)) {
      return no(400, `ttl_s is whole seconds from 60 to ${MAX_TTL_S}.`);
    }
    const defaultSigner: Signer = kind === "agent" || kind === "console" ? "platform" : "customer";
    const signer: Signer = b.signer === "platform" || b.signer === "customer" ? b.signer : defaultSigner;
    const seed = seedOf(signer);
    if (!seed.ok) return no(501, seed.error);
    const issuer = deps.env.ROOMS_MINT_ISSUER_ACCOUNT?.trim() || undefined;
    // A key the kill switch cut in this second would have the new credential
    // refused by the same revocation (the broker revokes by issue time): wait
    // past it, as every mint door does (kill-switch-cut.ts).
    if (!deps.now) await mintAfterCut(key, Date.now, undefined, deps.mintLog ? (k) => deps.mintLog!.cutAt(k) : undefined);
    const now = (deps.now ?? Date.now)();

    const signUser = async (claimPerms: object, name: string, ttl: number) => {
      const claim: Record<string, unknown> = { ...claimPerms };
      if (issuer) claim.issuer_account = issuer;
      const expSec = Math.floor(now / 1000) + ttl;
      const acctKp = nkeys.fromSeed(new TextEncoder().encode(seed.seed));
      const jwt = await encodeUser(name, key, acctKp, claim as never, { exp: expSec });
      return ok({ jwt, exp_sec: expSec, expires_at: new Date(expSec * 1000).toISOString(), subject: key, mesh: meshInfo(deps.env) });
    };

    if (kind === "agent") {
      const perms = durableAgentPermissions(key);
      assertNarrow(perms, key);
      return signUser(perms, `${prefix ?? "agent"}-${key.slice(0, 8)}`, typeof ttlRaw === "number" ? ttlRaw : 24 * 3600);
    }
    if (kind === "console") {
      const perms = consoleReaderPermissions(key);
      assertConsoleReader(perms, key);
      return signUser(perms, `${prefix ?? "console"}-${key.slice(0, 8)}`, typeof ttlRaw === "number" ? ttlRaw : 4 * 3600);
    }
    if (kind === "job") {
      const agent = typeof b.agent === "string" ? b.agent : "";
      if (!NKEY.test(agent)) return no(400, "agent is the agent the job runs for.");
      if (agent === key) return no(400, "a job credential binds to an ephemeral worker key, never to the agent's own key.");
      if (typeof ttlRaw !== "number") return no(400, "ttl_s is required for a job credential: the job's own length and its margins.");
      const sends = b.sends === true;
      const perms = jobWorkerPermissions(agent, { sends });
      assertJobWorkerNarrow(perms, agent, { sends });
      return signUser(perms, `${prefix ?? "job"}-${agent.slice(0, 8)}-${key.slice(0, 8)}`, ttlRaw);
    }
    if (kind === "node") {
      const agents = Array.isArray(b.agents) ? b.agents : null;
      if (!agents || !agents.length || agents.length > NODE_CREDENTIAL_MAX_AGENTS || !agents.every((a) => typeof a === "string" && NKEY.test(a))) {
        return no(400, `agents is a list of 1 to ${NODE_CREDENTIAL_MAX_AGENTS} agent public keys.`);
      }
      const minted = await mintNodeCredential({
        subject: key,
        agentIds: agents as string[],
        mintSeed: seed.seed,
        issuerAccount: issuer,
        namePrefix: prefix ?? "node",
        ...(ttlRaw !== undefined ? { ttlSec: ttlRaw as number | null } : {}),
        now,
      });
      const rec = b.record as { label?: unknown; door?: unknown; account?: unknown; org?: unknown } | undefined;
      if (rec && deps.mintLog) {
        const door = rec.door === "bootstrap" || rec.door === "renewal" || rec.door === "admin" ? rec.door : "admin";
        await deps.mintLog.recordMint({
          key: minted.subject,
          agents: agents as string[],
          ...(typeof rec.label === "string" ? { label: rec.label } : {}),
          expiresAt: minted.expiresAt,
          door,
          account: typeof rec.account === "string" ? rec.account : null,
          org: typeof rec.org === "string" ? rec.org : null,
        }).catch((err) => console.warn(`[admin] a node credential was minted and could not be written to the mint log: ${(err as Error).message}`));
      }
      return ok({ jwt: minted.jwt, exp_sec: minted.expSec, expires_at: minted.expiresAt, subject: minted.subject, mesh: meshInfo(deps.env) });
    }
    return no(400, 'kind is "agent", "job", "node" or "console".');
  }

  function signers(): DoorAnswer {
    const pub = (s: Signer) => {
      const r = seedOf(s);
      if (!r.ok) return null;
      try { return nkeys.fromSeed(new TextEncoder().encode(r.seed)).getPublicKey(); } catch { return null; }
    };
    return ok({ platform: pub("platform"), customer: pub("customer") });
  }

  async function handle(req: AdminRequest): Promise<DoorAnswer | null> {
    const seg = req.path.replace(/^\/admin\/v1\/?/, "").split("/").filter(Boolean);
    if (seg[0] !== "credentials" || seg.length !== 2) return null;
    try {
      if (seg[1] === "issue" && req.method === "POST") return await issue(req.body ?? {});
      if (seg[1] === "signers" && req.method === "GET") return signers();
    } catch (err) {
      // A template's assertion refusing its own claim: our failure to describe, logged, never a seed.
      console.error(`[admin] a credential could not be issued: ${(err as Error).message}`);
      return no(500, "the credential could not be minted");
    }
    return null;
  }

  return { handle };
}

export type AdminCredentials = ReturnType<typeof adminCredentials>;
