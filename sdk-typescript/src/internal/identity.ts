/**
 * Agent identity and per-envelope signing (AgentMesh 0.2, §4–5).
 *
 * In 0.2 a node connects once and serves many agents, so the transport
 * connection identity is the *node*, not the sending agent. Per-agent identity
 * is therefore established in the envelope: every envelope carries a `sig` — an
 * Ed25519 signature over the tagged signed bytes (`agentmesh-envelope-v1` + LF +
 * the canonical envelope, all fields except `sig`; §5.3) by the
 * sending agent's key. Receivers verify `sig` against `from`. This is what makes
 * `from` trustworthy in a multiplexed world (§5.3), and it is non-repudiable and
 * transport-independent.
 *
 * Keys are NATS nkeys (Ed25519): an agent's public nkey is its agent ID.
 */
import { nkeys } from "./nkeys.js";
import { DEFAULT_VOUCH_TTL_MS } from "../constants.js";
import type { Envelope } from "../types/envelope.js";
import type { AgentAttestation, TrustAttestation } from "../types/manifest.js";

/** An nkey keypair (the concrete type nats.ws returns). */
export type KeyPair = ReturnType<typeof nkeys.createUser>;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── base64url ──────────────────────────────────────────────────────────────

export function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── canonical JSON (deterministic, for signing) ─────────────────────────────

/** Deterministic JSON: object keys sorted recursively, no insignificant space.
 *  Used for envelope signatures (§5.3) and for the attestation objects (§4.4,
 *  §9.7). Deliberately NOT used by the manifest key claim (§8.3) — that claim is
 *  a newline-joined string precisely so there is no canonicalization to diverge
 *  on between SDKs. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
}

/** Canonical bytes of an envelope — the canonical JSON excluding `sig`. NOT the
 *  signed bytes on their own: the signature covers ENVELOPE_SIG_PREFIX + these
 *  bytes (§5.3). Kept separate because fixtures pin the canonical JSON and the
 *  prefix independently. */
export function canonicalEnvelopeBytes(env: Envelope): Uint8Array {
  const { sig: _omit, ...rest } = env as Envelope & { sig?: string };
  return enc.encode(canonicalJSON(rest));
}

/**
 * The domain tag inside the envelope's signed bytes (§5.3). A signature over
 * bare canonical JSON cannot say what it is — it can be replayed into any
 * other context that signs the same shape — so the signed bytes carry a
 * versioned prefix, exactly as the §8.3 key claim
 * (`agentmesh-manifest-key-v1`) and the §9.7 trust attestation
 * (`agentmesh-trust-attestation-v1`) already do. The prefix never appears in
 * the envelope itself and the `sig` encoding is unchanged. The vouch, the
 * room descriptor and the admission roster carry sibling prefixes through the
 * shared signTagged/verifyTagged machinery below.
 */
export const ENVELOPE_SIG_PREFIX = "agentmesh-envelope-v1\n";

/** The bytes an envelope's `sig` covers (§5.3): ENVELOPE_SIG_PREFIX + the
 *  canonical envelope JSON (all fields except `sig`). */
export function signedEnvelopeBytes(env: Envelope): Uint8Array {
  const { sig: _omit, ...rest } = env as Envelope & { sig?: string };
  return enc.encode(ENVELOPE_SIG_PREFIX + canonicalJSON(rest));
}

// ── tagged canonical-JSON signatures (shared machinery) ─────────────────────
//
// Every canonical-JSON signature in the system covers `<prefix>` + the
// canonical JSON of the object excluding `sig`, where the prefix is a
// versioned ASCII domain tag ending in one newline (0x0A). The prefix exists
// only inside the signed bytes — never in the signed object — and the
// signature's encoding is whatever it already was. One sign path and one
// verify path, parameterized by prefix, so the envelope, the vouch, the room
// descriptor and the admission roster cannot drift apart in how they apply
// the tag. (The 0.2 draft window's dual-accept of untagged legacy signatures
// lived in the verify path; it closed at protocol 0.3.)

/** The domain tag inside a node→agent vouch attestation's signed bytes
 *  (§4.4). Same argument as ENVELOPE_SIG_PREFIX: a signature over bare
 *  canonical JSON cannot say what it is. */
export const VOUCH_SIG_PREFIX = "agentmesh-vouch-v1\n";

/** The domain tag inside an EXT-6 admission roster's signed bytes. Defined
 *  here (not in services) because the SIGNER is the owner's client — the
 *  reference adapter's `signRoster` — and the verifier is the mesh's
 *  admission store; both must agree on these exact bytes. */
export const ADMISSION_ROSTER_SIG_PREFIX = "agentmesh-admission-roster-v1\n";

/** Sign `prefix + canonical` with `kp`. Returns the raw signature bytes so
 *  the caller keeps its historical encoding (base64url for SDK objects,
 *  standard base64 for the admission roster). */
export function signTagged(kp: KeyPair, prefix: string, canonical: string): Uint8Array {
  return kp.sign(enc.encode(prefix + canonical));
}

/** Verify a tagged canonical-JSON signature against a public key.
 *
 *  Tagged form ONLY (`prefix + canonical`). The 0.2 draft window carried a
 *  dual-accept fallback to the legacy untagged form here; §5.3's migration
 *  clause made verifiers refuse that form from protocol 0.3, and this release
 *  is 0.3, so the window is closed and the fallback path is gone. Accepting
 *  untagged bytes would throw away the only thing the prefix buys: domain
 *  separation. Without it, a signature the same key produced over some other
 *  canonical document can be presented as a signature over this one, whenever
 *  an attacker can arrange for the two canonicalizations to coincide. */
export function verifyTagged(
  publicKey: string,
  prefix: string,
  canonical: string,
  sig: Uint8Array,
): boolean {
  let vpub: KeyPair;
  try {
    vpub = nkeys.fromPublic(publicKey);
  } catch {
    return false;
  }
  try {
    return vpub.verify(enc.encode(prefix + canonical), sig);
  } catch {
    return false;
  }
}

// ── keypairs ────────────────────────────────────────────────────────────────

/** Create a fresh agent identity. Returns the public nkey (agent ID) and the
 *  seed string to persist. Keep the seed secret; it is the agent's private key. */
export function createAgentIdentity(): { publicKey: string; seed: string } {
  const kp = nkeys.createUser();
  const publicKey = kp.getPublicKey();
  const seed = dec.decode(kp.getSeed());
  kp.clear();
  return { publicKey, seed };
}

/** Reconstruct a keypair from a persisted seed string. */
export function keyPairFromSeed(seed: string): KeyPair {
  return nkeys.fromSeed(enc.encode(seed));
}

// ── envelope signing / verification ─────────────────────────────────────────

/** Sign an envelope in place with the agent keypair, setting `sig`. Returns it.
 *  Signs the tagged form (ENVELOPE_SIG_PREFIX + canonical JSON, §5.3). */
export function signEnvelope(env: Envelope, kp: KeyPair): Envelope {
  const sig = kp.sign(signedEnvelopeBytes(env));
  env.sig = toB64Url(sig);
  return env;
}

/** Verify an envelope's `sig` against its `from` agent public key.
 *
 *  Tagged form only (§5.3). The 0.2 draft window's dual-accept of the legacy
 *  untagged form closed at protocol 0.3, which this release is: an untagged
 *  signature is refused. */
export function verifyEnvelopeSig(env: Envelope): boolean {
  if (!env.sig || !env.from) return false;
  let sig: Uint8Array;
  try {
    sig = fromB64Url(env.sig);
  } catch {
    return false;
  }
  const { sig: _omit, ...rest } = env as Envelope & { sig?: string };
  return verifyTagged(env.from, ENVELOPE_SIG_PREFIX, canonicalJSON(rest), sig);
}

// ── manifest key claim (§8.3) ───────────────────────────────────────────────

/**
 * The domain tag for the manifest's signed claim. Same convention as every
 * other signature in the system (`pan-pair-v1`, `pan-rehome-v1`,
 * `agentmesh-trust-attestation-v1`): the signed bytes say what they ARE, so a
 * verifier rejects a format it does not know instead of misreading it, and a v2
 * can cover more without invalidating a single v1 signature already issued.
 */
const MANIFEST_KEY_CLAIM_TYPE = "agentmesh-manifest-key-v1" as const;

/**
 * The canonical bytes of a v1 manifest key claim — UTF-8, newline-joined, no
 * trailing newline:
 *
 *     agentmesh-manifest-key-v1\n<issued_at>\n<id>\n<encryption_key>
 *
 * WHAT IT COVERS, and why it is this small. The signature is load-bearing for
 * exactly one thing: key substitution when sealing (§7.3). An attacker who can
 * answer `mesh.registry.get.<id>` puts its own X25519 key in the reply and the
 * room key is sealed to it — it reads every `say` and artifact in a room it was
 * never admitted to, and neither party sees an error. What has to be authentic
 * to stop that is the BINDING between an agent id and its encryption key.
 * Nothing else in a manifest has that property.
 *
 * An earlier version of this signed a long list of agent-declared manifest
 * fields. It worked, but it made every future manifest field a compatibility
 * decision and required the TS and Rust SDKs to agree byte-for-byte forever or
 * sealing breaks silently between them. Narrow beats broad here: this claim has
 * three inputs, all with constrained charsets, and it will not grow by accident.
 *
 * WHAT IT DOES NOT COVER, deliberately:
 * - `owner`, `visibility`, `sandbox` — the registry REWRITES these server-side
 *   after the agent signs (server/src/registry/handlers/register.ts), which is
 *   why §8.3's old "sign the whole manifest" could never verify for any reader.
 * - `interaction` — §8.3a is explicit that it is not a security boundary: an
 *   agent that misdeclares itself inconveniences callers rather than gaining
 *   privilege, and a signature cannot tell an honest declaration from a lie
 *   since the agent signs whatever it says. It also already fails safe: absent
 *   or unverified reads as `interactive`, the cautious answer (§8.3a). Compare
 *   `encryption_key`, which has no safe default — you either seal to an
 *   unverified key or refuse. A v2 claim MAY cover it if tamper-evidence on the
 *   field ever earns its keep.
 * - every other descriptive field (`name`, `offerings`, `cost`, …). A forged reply
 *   can still mislead a caller about those; that is a registry-authenticity
 *   problem (assessment 2.3/6.2), solved by binding the response to the
 *   registry's key, not by widening this claim.
 *
 * A NEWLINE-JOINED STRING, not canonical JSON: JSON brings key ordering, string
 * escaping, number formatting and absent-vs-null to a claim made of three
 * strings — four ways for two SDKs to drift, for no benefit. `pan-checkin-v3`
 * already uses this shape for exactly this cross-implementation problem, and it
 * is the one canonicalization in the repo with a fixture pinning it
 * (`conformance/naming.json`). This claim gets the same treatment:
 * `conformance/manifest-signing.json`.
 *
 * The encoding is unambiguous because only the LAST field is unbounded: `id` is
 * a fixed-length nkey and `issued_at` is an RFC 3339 instant, so no two distinct
 * claims share a byte string. Components carrying a newline are refused outright
 * rather than allowed to shift the framing.
 *
 * `issued_at` is inside the signed bytes AND published as `trust.issued_at`, so
 * a verifier can rebuild exactly what was signed. An absent `encryption_key`
 * signs as the empty string — the claim then says "this agent declares no
 * encryption key", and an attacker who adds one has to break the signature.
 */
function manifestKeyClaimBytes(
  id: string,
  encryptionKey: string,
  issuedAt: string,
): Uint8Array {
  for (const part of [issuedAt, id, encryptionKey]) {
    if (part.includes("\n")) {
      throw new Error("manifest key claim components must not contain a newline (§8.3)");
    }
  }
  return enc.encode([MANIFEST_KEY_CLAIM_TYPE, issuedAt, id, encryptionKey].join("\n"));
}

/** Sign a manifest's key claim with the agent's own key (§8.3), setting
 *  `trust.issued_at` and `trust.signature`. Mutates and returns the manifest.
 *  Other `trust` fields (e.g. `tenant`) are preserved. */
export function signManifest<T extends { id: string; encryption_key?: string; trust?: object }>(
  manifest: T,
  kp: KeyPair,
  now = new Date(),
): T {
  const issuedAt = now.toISOString();
  const { signature: _drop, issued_at: _drop2, ...restTrust } = (manifest.trust ??
    {}) as Record<string, unknown>;
  const bytes = manifestKeyClaimBytes(manifest.id, manifest.encryption_key ?? "", issuedAt);
  (manifest as { trust?: Record<string, unknown> }).trust = {
    ...restTrust,
    issued_at: issuedAt,
    signature: toB64Url(kp.sign(bytes)),
  };
  return manifest;
}

/** Verify a manifest's `trust.signature` against the key named by its own `id`
 *  (§8.3). False on an absent, malformed or non-verifying signature.
 *
 *  What a true answer means, exactly: the agent whose key is `id` declared this
 *  `encryption_key` (or declared none) at `issued_at`. It says nothing about the
 *  rest of the manifest, nothing about whether the registry that served it is
 *  honest, and nothing about the fields the registry rewrites — all of that is
 *  outside the claim by construction (see manifestKeyClaimBytes). */
export function verifyManifestSignature(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== "object") return false;
  const m = manifest as Record<string, unknown>;
  const trust = m.trust as Record<string, unknown> | undefined;
  if (!trust || typeof trust !== "object") return false;
  const sig = trust.signature;
  const issuedAt = trust.issued_at;
  if (typeof sig !== "string" || !sig) return false;
  if (typeof issuedAt !== "string" || !issuedAt) return false;
  if (typeof m.id !== "string" || !m.id) return false;
  if (m.encryption_key !== undefined && typeof m.encryption_key !== "string") return false;
  try {
    const vpub = nkeys.fromPublic(m.id);
    const bytes = manifestKeyClaimBytes(m.id, (m.encryption_key as string) ?? "", issuedAt);
    return vpub.verify(bytes, fromB64Url(sig));
  } catch {
    return false;
  }
}

// ── node vouching (attestations, §4.4) ──────────────────────────────────────

/** A node vouches for a hosted agent by signing a node→agent attestation.
 *
 *  The default lifetime is a LEASE, not a fact: the registry refuses an expired
 *  attestation at register (§9.7) and reclaims a registration whose attestation
 *  lapsed, so whoever mints one is responsible for re-minting it before
 *  `expires_at`. The SDK does that automatically for agents it registered (see
 *  `AgentMesh.renewVouch` / `MeshNode.renewVouches`); a caller minting
 *  attestations by hand owns the same obligation. */
export function createAttestation(
  nodeKp: KeyPair,
  agentPublic: string,
  ttlMs = DEFAULT_VOUCH_TTL_MS,
  now = new Date(),
): AgentAttestation {
  const att: AgentAttestation = {
    node: nodeKp.getPublicKey(),
    agent: agentPublic,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    sig: "",
  };
  const { sig: _omit, ...rest } = att;
  // Tagged signed bytes (§4.4): VOUCH_SIG_PREFIX + the canonical JSON.
  att.sig = toB64Url(signTagged(nodeKp, VOUCH_SIG_PREFIX, canonicalJSON(rest)));
  return att;
}

/** Verify a node→agent attestation's signature (and, optionally, that it binds
 *  the expected agent). Does NOT check expiry — callers decide freshness.
 *
 *  Accepts the tagged form only (§4.4: VOUCH_SIG_PREFIX + canonical JSON).
 *  The 0.2 dual-accept of untagged vouches closed at protocol 0.3. */
export function verifyAttestation(att: AgentAttestation, expectedAgent?: string): boolean {
  if (!att || !att.node || !att.agent || !att.sig) return false;
  if (expectedAgent && att.agent !== expectedAgent) return false;
  const { sig, ...rest } = att;
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromB64Url(sig);
  } catch {
    return false;
  }
  return verifyTagged(att.node, VOUCH_SIG_PREFIX, canonicalJSON(rest), sigBytes);
}

/** True if an attestation's `expires_at` is in the past. Accepts either kind
 *  of attestation — the node vouch and the portable trust claim both carry the
 *  field, and a caller holding one should not have to know which helper to
 *  reach for. */
export function attestationExpired(
  att: { expires_at?: string },
  now = new Date(),
): boolean {
  return !!att.expires_at && new Date(att.expires_at).getTime() < now.getTime();
}

/** The type tag inside a trust attestation's signed bytes. Bump the suffix to
 *  change the format; verifiers reject tags they do not know, so an old holder
 *  refuses a new-format claim rather than misreading it. */
const TRUST_ATTESTATION_TYPE = "agentmesh-trust-attestation-v1" as const;

/** Mint a portable trust attestation (§9.7): the operator key signs a claim
 *  about a subject. Same canonical-JSON-over-fields + Ed25519 sig shape as the
 *  node vouch, but self-describing (it names its own issuer and its own type)
 *  so it verifies anywhere, off any mesh. */
export function createTrustAttestation(
  operatorKp: KeyPair,
  subject: string,
  claims: TrustAttestation["claims"],
  ttlMs = 90 * 24 * 60 * 60 * 1000,
  now = new Date(),
): TrustAttestation {
  const att: TrustAttestation = {
    type: TRUST_ATTESTATION_TYPE,
    issuer: operatorKp.getPublicKey(),
    subject,
    claims,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    sig: "",
  };
  const { sig: _omit, ...rest } = att;
  att.sig = toB64Url(operatorKp.sign(enc.encode(canonicalJSON(rest))));
  return att;
}

/** Verify a portable trust attestation OFFLINE against its own named issuer —
 *  no mesh, no registry consulted. Returns false on a bad/absent signature, a
 *  subject mismatch, an unknown `type`, or an attestation whose `expires_at`
 *  has passed. Whether the issuer is TRUSTED is the caller's local policy;
 *  this only proves the operator said it, that no one tampered, and that the
 *  claim is still in date.
 *
 *  Expiry is checked HERE rather than left to the caller: an attestation is
 *  minted to travel, so the party checking it is by definition the party
 *  furthest from the issuer and least able to know the claim went stale.
 *  `allowExpired` is for auditing an archive, not for the hot path. */
export function verifyTrustAttestation(
  att: TrustAttestation,
  expectedSubject?: string,
  opts: { now?: Date; allowExpired?: boolean } = {},
): boolean {
  if (!att || !att.issuer || !att.subject || !att.sig) return false;
  if (att.type !== TRUST_ATTESTATION_TYPE) return false;
  if (expectedSubject && att.subject !== expectedSubject) return false;
  if (!opts.allowExpired && attestationExpired(att, opts.now ?? new Date())) return false;
  let vpub: KeyPair;
  try {
    vpub = nkeys.fromPublic(att.issuer);
  } catch {
    return false;
  }
  const { sig, ...rest } = att;
  try {
    return vpub.verify(enc.encode(canonicalJSON(rest)), fromB64Url(sig));
  } catch {
    return false;
  }
}
