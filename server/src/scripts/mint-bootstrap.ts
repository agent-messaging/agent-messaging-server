/**
 * mint-bootstrap — the self-host bundle's credential mint.
 *
 * Runs inside the services image as a one-shot (`docker compose` runs it as
 * the `mint` service; the entrypoint dispatches here before the platform
 * starts). It mints the credentials the bundle needs — services, node-1,
 * bridge, and the guest pool — from the SAME templates the hosted mesh
 * trusts, signed by the account key the bundle's bootstrap minted.
 *
 * WHY THIS EXISTS. The bundle's bootstrap.sh used to mint every one of these
 * with plain `nsc add user`, no permission flags — and in NATS an empty
 * permissions block does not mean "no access", it means "inherit the
 * account's defaults", which this account never sets. So every credential,
 * the guest pool included, could read every agent's mail, drive JetStream,
 * and read the KV bucket whose keys are session bearer tokens. That is the
 * empty-block bug made at a third site (after the pool and /v1/bootstrap),
 * and the fix is the same as the other two: no permissions literal here —
 * the template lives in cred-template.ts, this file only calls it.
 *
 * Idempotent PER FILE, deliberately: a credential that exists is never
 * touched, and a credential that is missing is minted — so an existing
 * deployment that upgrades gains whatever the bundle has learned to mint
 * since (bridge.creds once crash-looped for exactly this reason), and
 * re-minting a wide pool is "delete creds/pool/*.creds, run again".
 *
 * What each credential gets, and why:
 *
 *   - `services.creds` — explicit allow-everything. The services ARE the
 *     platform: they own the KV buckets, the JetStream streams, and every
 *     mesh.* plane. Writing `>` down is a decision; inheriting it was the bug.
 *   - `node-1.creds`, `bridge.creds` — allow-everything MINUS the fence: the
 *     session-token bucket, server monitoring, the federation plane and the
 *     acl traffic plane are denied outright. They cannot be narrower yet: a
 *     node credential scopes subjects to the agent keys it hosts, and both of
 *     these are minted before any agent identity exists. The narrow path for
 *     real agents is the console's agent key redeemed through /v1/bootstrap,
 *     which this mint also enables (it installs the signing key the services
 *     need to answer that door).
 *   - `pool/guest-N.creds` — the sandbox template, asserted narrow before
 *     signing. This is the one handed to strangers, and the reason this file
 *     exists.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nkeys } from "nats";
import { encodeUser } from "nats-jwt";
import { sandboxPermissions, assertNarrowSandbox, fencedNodePermissions, type CredPermissions } from "../keychain/cred-template.js";
import { credsFileText } from "../shared/creds-file.js";

const DATA = process.env.MINT_DATA_DIR ?? "/data";
const CREDS = join(DATA, "creds");
const POOL_DIR = join(CREDS, "pool");
const SIGNING_FILE = process.env.MINT_SIGNING_SEED_FILE ?? join(CREDS, "mint-signing.nk");

const rawPool = Number(process.env.SANDBOX_POOL_SIZE);
const POOL_SIZE = Number.isFinite(rawPool) && rawPool > 0 ? Math.floor(rawPool) : 5;

/** The fence for operator-held credentials that cannot be key-scoped yet:
 *  everything, minus the subjects nothing on a mesh node has business with
 *  (keychain/cred-template.ts, shared with first-run setup). Deny wins in
 *  NATS, so these hold even against the `>` beside them. */
function fencedNodeWidth(): CredPermissions {
  return fencedNodePermissions();
}

type KeyPair = ReturnType<typeof nkeys.fromSeed>;

function readAccountKp(): KeyPair {
  let text: string;
  try {
    text = readFileSync(SIGNING_FILE, "utf8").trim();
  } catch {
    throw new Error(
      `no signing key at ${SIGNING_FILE} — bootstrap.sh writes it after minting the account. ` +
      `Run the bundle's bootstrap first; this mint only signs, it does not create the account.`,
    );
  }
  const kp = nkeys.fromSeed(new TextEncoder().encode(text));
  const pub = kp.getPublicKey();
  if (!pub.startsWith("A")) {
    throw new Error(`the signing key at ${SIGNING_FILE} is ${pub.slice(0, 1)}…, not an account key — user JWTs must be signed by the account`);
  }
  return kp;
}

interface MintSpec {
  file: string;
  name: string;
  claim: (ownKey: string) => Record<string, unknown>;
}

async function mintMissing(spec: MintSpec, acctKp: KeyPair): Promise<"minted" | "kept"> {
  if (existsSync(spec.file)) return "kept";
  const kp = nkeys.createUser();
  const seed = new TextDecoder().decode(kp.getSeed());
  const claim = spec.claim(kp.getPublicKey());
  const jwt = await encodeUser(spec.name, kp as never, acctKp, claim as never, {});
  writeFileSync(spec.file, credsFileText(jwt, seed), { mode: 0o644 });
  return "minted";
}

async function main(): Promise<void> {
  const acctKp = readAccountKp();
  mkdirSync(POOL_DIR, { recursive: true });

  const specs: MintSpec[] = [
    {
      file: join(CREDS, "services.creds"),
      name: "services",
      // The platform's own credential. Explicit, not inherited: see header.
      claim: () => ({ pub: { allow: [">"], deny: [] }, sub: { allow: [">"], deny: [] } }),
    },
    {
      file: join(CREDS, "node-1.creds"),
      name: "node-1",
      claim: () => ({ ...fencedNodeWidth() }),
    },
    {
      file: join(CREDS, "bridge.creds"),
      name: "bridge",
      claim: () => ({ ...fencedNodeWidth() }),
    },
    ...Array.from({ length: POOL_SIZE }, (_, i) => ({
      file: join(POOL_DIR, `guest-${i + 1}.creds`),
      name: `guest-${i + 1}`,
      claim: (ownKey: string) => {
        const perms = sandboxPermissions(ownKey);
        // The mint fails loudly rather than issuing something broad. This is
        // the assertion that makes "delete the pool, run again" safe advice.
        assertNarrowSandbox(perms, ownKey);
        return { ...perms };
      },
    })),
  ];

  let minted = 0;
  for (const spec of specs) {
    const what = await mintMissing(spec, acctKp);
    if (what === "minted") minted++;
    console.log(`[mint] ${spec.name}: ${what === "minted" ? "minted" : "exists, untouched"}`);
  }
  console.log(
    minted === 0
      ? "[mint] nothing to do — every credential already exists. To re-mint one, delete its file and run again."
      : `[mint] ${minted} credential(s) minted. The pool is the sandbox template; node-1 and bridge are fenced; services is the platform.`,
  );
}

main().catch((e) => {
  console.error(`[mint] FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
});
