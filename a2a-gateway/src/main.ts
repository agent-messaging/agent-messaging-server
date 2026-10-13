/**
 * AgentMesh <-> A2A bridge service entrypoint.
 *
 * Run it as ONE process, so signals reach the process that owns the port:
 *   node --import tsx src/main.ts
 * (`npx tsx src/main.ts` puts three wrappers above the listener; a SIGTERM then
 * kills the wrapper and orphans the socket holder — see boot.ts.)
 *
 * Env config:
 *   MESH_URL         the mesh's address, or several, comma-separated: ws://, wss://
 *                    or nats:// on a NATS mesh, amqp:// or amqps:// on a RabbitMQ
 *                    mesh (default ws://localhost:4443; src/mesh-address.ts)
 *   CREDS_FILE       node credential .creds file   (dev: omit for keyless local)
 *   PORT             inbound HTTP port             (default 8090)
 *   PUBLIC_BASE_URL  public URL in generated cards (default http://localhost:PORT)
 *   ATTACH           comma-separated A2A endpoints/cards to attach outbound
 *   ATTACH_FILE      JSON file: [{url, headers?, visibility?, ...}, ...]
 *   ATTACHMENTS_FILE durable attachment store (default ./data/attachments.json);
 *                    env ATTACH entries are folded into it as records
 *   API_KEYS_FILE    durable self-serve key store (default ./data/api-keys.json);
 *                    holds hashes only — raw keys exist once, in mint replies
 *   CALLER_IDS_FILE  durable inbound caller-identity records
 *                    (default ./data/caller-identities.json). Holds each hosted
 *                    caller identity's NKey SEED, so it is written 0600 in a
 *                    0700 directory; see inbound/identity-store.ts
 *   API_KEYS         comma-separated "key=label" pairs for stable inbound identities
 *   ALLOW_ANONYMOUS  admit callers with NO credentials (default OFF — fail closed)
 *   TRUSTED_PROXIES  comma-separated IPs/CIDRs (or `loopback`) whose
 *                    X-Forwarded-For may be believed (default: believe nobody)
 *   RATE_PER_MINUTE  inbound requests per minute per caller (default 30)
 *   CORE_API_URL     the server's credential doors (its mesh API), e.g.
 *                    http://server:3005: outside proofs (OAuth tokens and SPIFFE
 *                    JWT-SVIDs) are checked there, and hosted identities store
 *                    their rosters there. Unset: outside proofs are refused.
 *   BRIDGE_AUTHORIZATION_SERVERS  comma-separated authorization server URLs the
 *                    RFC 9728 metadata names for MCP clients (optional)
 *   FORWARD_ROUTES   path prefixes a front end beside the gateway answers,
 *                    "prefix=url,..." (inbound/relay.ts); admin prefixes are
 *                    forwarded only after the local-only admin gate
 */
import { readFileSync } from "node:fs";
import { Bridge } from "./bridge.js";
import { boot } from "./boot.js";
import { PortInUseError } from "./inbound/server.js";
import type { AttachConfig } from "./outbound/attach.js";
import { FileKeyStore } from "./inbound/keys.js";
import { FileCallerIdentityStore } from "./inbound/identity-store.js";
import { loadCreds } from "./creds.js";
import { parseForwardRoutes } from "./inbound/relay.js";
import { ProofGate } from "./inbound/proofs.js";

const PORT = Number(process.env.PORT ?? 8090);

function parseAttachList(): AttachConfig[] {
  const list: AttachConfig[] = [];
  if (process.env.ATTACH) {
    for (const url of process.env.ATTACH.split(",").map((s) => s.trim()).filter(Boolean)) {
      list.push({ url });
    }
  }
  if (process.env.ATTACH_FILE) {
    list.push(...(JSON.parse(readFileSync(process.env.ATTACH_FILE, "utf8")) as AttachConfig[]));
  }
  return list;
}

function parseApiKeys(): Record<string, string> | undefined {
  if (!process.env.API_KEYS) return undefined;
  const out: Record<string, string> = {};
  for (const pair of process.env.API_KEYS.split(",")) {
    const [key, label] = pair.split("=");
    if (key?.trim()) out[key.trim()] = label?.trim() ?? "unnamed";
  }
  return out;
}

/** Only an explicit, recognised affirmative turns a security flag ON. Anything
 *  else is off — a typo must fail closed, and it must say so. */
function parseBool(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return false;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (!["0", "false", "no", "off"].includes(v)) {
    console.warn(`[bridge] ${name}="${raw}" is not a recognised boolean; treating it as OFF.`);
  }
  return false;
}

function parseList(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

async function main(): Promise<void> {
  const keyStore = new FileKeyStore(process.env.API_KEYS_FILE ?? "./data/api-keys.json");
  await keyStore.load();

  // Who each hosted caller identity belongs to, written down. Loaded before the
  // listener binds: the first request after a restart must find its caller's
  // record already there, or it mints a second identity for a caller that
  // already had one.
  const callerStore = new FileCallerIdentityStore(
    process.env.CALLER_IDS_FILE ?? "./data/caller-identities.json",
  );
  await callerStore.load();

  // Outside proofs (SPEC §4.15): callers that present an OAuth token or a
  // SPIFFE JWT-SVID, checked with the server's key chain at CORE_API_URL.
  // Needs the node credential (the node key signs each question) and the
  // server naming this node in MESH_BRIDGE_NODES.
  const creds = process.env.CREDS_FILE ? loadCreds(process.env.CREDS_FILE) : undefined;
  const coreUrl = process.env.CORE_API_URL?.trim() || undefined;
  const proofs = coreUrl && creds ? new ProofGate({ coreUrl, nodeSeed: creds.seed }) : undefined;
  if (proofs) console.log(`[bridge] outside proofs are checked with the key chain at ${coreUrl} (this node: ${proofs.nodeId}; the server must name it in MESH_BRIDGE_NODES)`);

  const bridge = new Bridge({
    meshUrl: process.env.MESH_URL ?? "ws://localhost:4443",
    ...(proofs ? { proofs } : {}),
    ...(coreUrl ? { coreUrl } : {}),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`,
    port: PORT,
    creds,
    apiKeys: parseApiKeys(),
    keyStore,
    callerStore,
    allowAnonymous: parseBool("ALLOW_ANONYMOUS"),
    trustedProxies: parseList("TRUSTED_PROXIES"),
    ratePerMinute: process.env.RATE_PER_MINUTE ? Number(process.env.RATE_PER_MINUTE) : undefined,
  });

  // Path prefixes a front end beside the gateway answers (inbound/relay.ts).
  // On AgentMesh, PACT's routes go to the platform's PACT Provider
  // (BRIDGE-A2A.md §14), which reaches the mesh through the relay doors.
  const forwards = parseForwardRoutes(process.env.FORWARD_ROUTES);
  for (const f of forwards) console.log(`[bridge] ${f.prefix} is answered by ${f.target.origin}`);

  const booted = await boot(bridge, parseAttachList(), {
    storePath: process.env.ATTACHMENTS_FILE ?? "./data/attachments.json",
    forwards,
  });

  const shutdown = async () => {
    console.log("\n[bridge] shutting down...");
    await booted.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  if (err instanceof PortInUseError) {
    // Named, actionable, and terminal. The mesh was never touched.
    console.error(`[bridge] ${err.message}`);
    process.exit(1);
  }
  console.error("[bridge] fatal:", err);
  process.exit(1);
});
