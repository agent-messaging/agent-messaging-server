#!/usr/bin/env node
/**
 * Offline verification of an AgentMesh audit bundle.
 *
 *   node tools/verify-audit.mjs <bundle.json> [expected-signer-pubkey]
 *
 * Checks, in order:
 *   1. every per-agent hash chain: each row's entry_hash is the SHA-256 of
 *      its own canonical JSON (minus entry_hash), and each prev_hash is the
 *      hash before it, back to "genesis";
 *   2. the manifest's entries_sha256 matches the shipped rows, in order;
 *   3. the manifest's Ed25519 signature (over "agentmesh-audit-bundle-v1\n"
 *      + the canonical JSON of the manifest minus `sig`) verifies against
 *      manifest.signer_pub;
 *   4. optionally, that signer_pub is the key you expected.
 *
 * Needs no network and nothing of AgentMesh's beyond this file and the
 * `nkeys.js` package (Ed25519). Exit code 0 = the bundle is intact and
 * signed by the stated key; anything else = it is not, and the output says
 * where it broke.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fromPublic } from "nkeys.js";

const PREFIX = "agentmesh-audit-bundle-v1\n";

// The exact canonicalization the platform signs (sdk internal/identity.ts):
// object keys sorted recursively, undefined dropped, no insignificant space.
function canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(value[k])).join(",") + "}";
}

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

function fromB64Url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(b64, "base64"));
}

const [, , file, expectedPub] = process.argv;
if (!file) {
  console.error("usage: node tools/verify-audit.mjs <bundle.json> [expected-signer-pubkey]");
  process.exit(2);
}

const bundle = JSON.parse(readFileSync(file, "utf8"));
const { manifest, entries } = bundle;
let failed = false;
const bad = (msg) => {
  console.error("FAIL  " + msg);
  failed = true;
};
const ok = (msg) => console.log("ok    " + msg);

// 1. Chains.
const byAgent = new Map();
for (const e of entries) {
  if (!byAgent.has(e.agent_id)) byAgent.set(e.agent_id, []);
  byAgent.get(e.agent_id).push(e);
}
for (const [agent, rows] of byAgent) {
  rows.sort((a, b) => a.seq - b.seq);
  let prev = "genesis";
  let broken = 0;
  for (const row of rows) {
    const { entry_hash, ...rest } = row;
    if (row.prev_hash !== prev || sha256hex(canonicalJSON(rest)) !== entry_hash) {
      broken = row.seq;
      break;
    }
    prev = entry_hash;
  }
  const declared = manifest.agents.find((a) => a.agent_id === agent);
  if (broken) bad(`chain ${agent.slice(0, 12)}… breaks at seq ${broken}`);
  else if (!declared) bad(`chain ${agent.slice(0, 12)}… is not declared in the manifest`);
  else if (declared.count !== rows.length || declared.head_hash !== prev) {
    bad(`chain ${agent.slice(0, 12)}… disagrees with the manifest (count/head)`);
  } else ok(`chain ${agent.slice(0, 12)}… intact (${rows.length} entries)`);
}
for (const a of manifest.agents) {
  if (!byAgent.has(a.agent_id)) bad(`manifest declares ${a.agent_id.slice(0, 12)}… but no rows shipped`);
}

// 2. The entries digest, over the SHIPPED order.
const digest = sha256hex(entries.map((e) => canonicalJSON(e)).join("\n"));
if (digest !== manifest.entries_sha256) bad("entries_sha256 does not match the shipped rows");
else ok("entries digest matches");

// 3. The signature.
const { sig, ...unsigned } = manifest;
try {
  const kp = fromPublic(manifest.signer_pub);
  const bytes = new TextEncoder().encode(PREFIX + canonicalJSON(unsigned));
  if (kp.verify(bytes, fromB64Url(sig))) ok(`signature verifies against ${manifest.signer_pub.slice(0, 12)}…`);
  else bad("signature does NOT verify");
} catch (e) {
  bad(`signature check errored: ${e.message}`);
}

// 4. The expected signer, when given.
if (expectedPub) {
  if (expectedPub.trim() === manifest.signer_pub) ok("signer is the expected key");
  else bad(`signer is ${manifest.signer_pub}, expected ${expectedPub}`);
}

console.log(failed ? "\nBUNDLE FAILED VERIFICATION" : `\nbundle intact: account ${manifest.account_id}, ${entries.length} entries, exported ${manifest.exported_at}`);
process.exit(failed ? 1 : 0);
