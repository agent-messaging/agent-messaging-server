// One-shot regeneration of the conformance fixtures for the skill→offering
// rename (§8.5). Blanket-renames the vocabulary (the same rule the tests were
// renamed under), then repairs everything cryptographic: envelope signatures,
// canonical strings, SKU digests, and the agreement vector. Sanity-checks the
// OLD crypto reproduces before touching anything, so a tooling drift cannot
// masquerade as a successful regeneration.
import { readFileSync, writeFileSync } from "fs";
import {
  canonicalEnvelopeBytes,
  keyPairFromSeed,
  signEnvelope,
  canonicalJSON,
  signTagged,
  toB64Url,
} from "./src/internal/identity.js";
import { skuDigest, type Sku } from "./src/sku.js";
import { AGREEMENT_SIG_PREFIX } from "./src/agreement.js";
import type { Envelope } from "./src/types/envelope.js";

const DIR = "../conformance/";
const dec = new TextDecoder();

function load(name: string): any {
  return JSON.parse(readFileSync(DIR + name, "utf8"));
}
function save(name: string, data: unknown): void {
  writeFileSync(DIR + name, JSON.stringify(data, null, 2) + "\n");
}
/** The same blanket rule the SDK tests were renamed under. */
function renameText(s: string): string {
  return s
    .replaceAll("SKILL", "OFFERING")
    .replaceAll("Skill", "Offering")
    .replaceAll("skill", "offering")
    .replace(/\ba offering/g, "an offering")
    .replace(/\bA offering/g, "An offering");
}
function renameDeep(v: any): any {
  if (typeof v === "string") return renameText(v);
  if (Array.isArray(v)) return v.map(renameDeep);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) out[renameText(k)] = renameDeep(val);
    return out;
  }
  return v;
}
function resign(env: Envelope, seed: string): Envelope {
  delete (env as { sig?: string }).sig;
  return signEnvelope(env, keyPairFromSeed(seed));
}
function assertEq(actual: string, expected: string, what: string): void {
  if (actual !== expected) {
    throw new Error(`pre-check failed — ${what}\n  expected ${expected}\n  got      ${actual}`);
  }
}

// ── sanity: the OLD commerce crypto must reproduce before we regenerate ─────
{
  const c = load("commerce.json");
  assertEq(canonicalJSON(c.digest.sku), c.digest.canonical, "old sku canonical");
  assertEq(await skuDigest(c.digest.sku as Sku), c.digest.sku_digest, "old sku digest");
  const moved = JSON.parse(JSON.stringify(c.digest.sku));
  moved.price.amount_micro += 1;
  assertEq(await skuDigest(moved as Sku), c.digest.one_micro_unit_moved.sku_digest, "old moved digest");
  const unsigned = { ...c.agreement.signed };
  delete unsigned.sig;
  assertEq(canonicalJSON(unsigned), c.agreement.canonical, "old agreement canonical");
}
// ── sanity: the OLD cancel envelope canonical must reproduce ────────────────
{
  const c = load("cancel.json");
  assertEq(dec.decode(canonicalEnvelopeBytes(c.envelope.signed)), c.envelope.canonical, "old cancel canonical");
}
console.log("pre-checks pass — tooling reproduces the old crypto");

// ── cancel.json / budget.json: one signed envelope each ─────────────────────
for (const name of ["cancel.json", "budget.json"]) {
  const d = renameDeep(load(name));
  const seed = d.identities.sender_seed as string;
  d.envelope.signed = resign(d.envelope.signed as Envelope, seed);
  if ("canonical" in d.envelope) {
    d.envelope.canonical = dec.decode(canonicalEnvelopeBytes(d.envelope.signed as Envelope));
  }
  save(name, d);
  console.log("regenerated", name);
}

// ── inbound-protections.json: six signed envelopes ──────────────────────────
{
  const d = renameDeep(load("inbound-protections.json"));
  const seed = d.identities.sender_seed as string;
  const sender = d.identities.sender as string;
  for (const [key, entry] of Object.entries<any>(d.envelopes)) {
    if (!entry?.envelope?.sig) continue;
    if (entry.envelope.from !== sender) throw new Error(`unexpected signer on ${key}`);
    entry.envelope = resign(entry.envelope as Envelope, seed);
  }
  save("inbound-protections.json", d);
  console.log("regenerated inbound-protections.json");
}

// ── metering.json: rename only (the signed respond carries no offering) ─────
{
  const d = renameDeep(load("metering.json"));
  const r = d.receipt.signed_envelope;
  assertEq(dec.decode(canonicalEnvelopeBytes(r.signed as Envelope)), r.canonical, "metering canonical unchanged");
  save("metering.json", d);
  console.log("regenerated metering.json (rename only, signature untouched)");
}

// ── commerce.json: digests + agreement re-signed over the new vocabulary ────
{
  const d = renameDeep(load("commerce.json"));
  d.digest.canonical = canonicalJSON(d.digest.sku);
  d.digest.sku_digest = await skuDigest(d.digest.sku as Sku);
  const moved = JSON.parse(JSON.stringify(d.digest.sku));
  moved.price.amount_micro += 1;
  d.digest.one_micro_unit_moved.sku_digest = await skuDigest(moved as Sku);

  const a = d.agreement;
  a.signed.sku_digest = d.digest.sku_digest;
  const unsigned = { ...a.signed };
  delete unsigned.sig;
  a.canonical = canonicalJSON(unsigned);
  a.signed.sig = toB64Url(
    signTagged(keyPairFromSeed(d.identities.sender_seed), AGREEMENT_SIG_PREFIX, a.canonical),
  );
  a.stale_digest_case.holds_agreement_for = d.digest.sku_digest;
  a.stale_digest_case.sku_current_digest = d.digest.one_micro_unit_moved.sku_digest;
  d.enforcement.refusal.details.sku_digest = d.digest.sku_digest;
  save("commerce.json", d);
  console.log("regenerated commerce.json");
}

// ── rename-only fixtures ────────────────────────────────────────────────────
for (const name of ["sender-preflight.json", "manifest-signing.json"]) {
  save(name, renameDeep(load(name)));
  console.log("regenerated", name, "(rename only)");
}
console.log("done");
