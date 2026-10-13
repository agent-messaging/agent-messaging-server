// Manifest key claim (§8.3) — the signed binding between an agent id and the
// encryption_key secrets get sealed to.
//
// The exact-bytes tests below exist because a drift between the TS and Rust SDKs
// does NOT throw: it makes one SDK refuse to seal to agents registered by the
// other, silently, at the moment a room key is being handed out. The shared
// fixture (conformance/manifest-signing.json) is asserted from both sides, so a
// divergence fails a test here or in sdk-rust/tests/manifest_signing.rs instead
// of turning up in production as "invites mysteriously stopped working".
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nkeys } from "nats.ws";
import { signManifest, verifyManifestSignature } from "../../src/internal/identity.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "..", "..", "..", "conformance", "manifest-signing.json"), "utf8"),
) as {
  key_claim_v1: {
    type: string;
    agent_seed: string;
    id: string;
    encryption_key: string;
    issued_at: string;
    canonical: string;
    signature: string;
    trust: { issued_at: string; signature: string };
  };
  key_claim_v1_no_encryption_key: {
    agent_seed: string;
    id: string;
    encryption_key: string;
    issued_at: string;
    canonical: string;
    signature: string;
  };
};

const enc = new TextEncoder();
const te = enc;

/** A minimal manifest shape — the claim reads exactly three fields, so the rest
 *  of §8.1 is deliberately not modelled here. */
type Signable = { id: string; encryption_key?: string; trust?: Record<string, unknown> };

describe("manifest key claim — cross-SDK fixture (conformance/manifest-signing.json)", () => {
  const f = fixture.key_claim_v1;

  it("the fixture's canonical bytes are what the fixture's key signed", () => {
    // Independent of our implementation: proves the fixture itself is coherent,
    // so a later failure points at the SDK rather than at the fixture.
    const kp = nkeys.fromSeed(te.encode(f.agent_seed));
    expect(kp.getPublicKey()).toBe(f.id);
    const sig = Uint8Array.from(
      atob(f.signature.replace(/-/g, "+").replace(/_/g, "/") + "=="),
      (c) => c.charCodeAt(0),
    );
    expect(kp.verify(enc.encode(f.canonical), sig)).toBe(true);
  });

  it("signManifest reproduces the fixture signature byte for byte", () => {
    const kp = nkeys.fromSeed(te.encode(f.agent_seed));
    const m: Signable = { id: f.id, encryption_key: f.encryption_key };
    signManifest(m, kp, new Date(f.issued_at));
    expect(m.trust?.issued_at).toBe(fixture.key_claim_v1.trust.issued_at);
    expect(m.trust?.signature).toBe(fixture.key_claim_v1.trust.signature);
  });

  it("reproduces the no-encryption-key case too", () => {
    const n = fixture.key_claim_v1_no_encryption_key;
    const kp = nkeys.fromSeed(te.encode(n.agent_seed));
    const m: Signable = { id: n.id };
    signManifest(m, kp, new Date(n.issued_at));
    expect(m.trust?.signature).toBe(n.signature);
    // ...and the same claim verifies with the field absent, since an absent key
    // signs as the empty string.
    expect(verifyManifestSignature(m)).toBe(true);
  });

  it("verifies the fixture claim as published", () => {
    expect(
      verifyManifestSignature({
        id: f.id,
        encryption_key: f.encryption_key,
        trust: { issued_at: f.issued_at, signature: f.signature },
      }),
    ).toBe(true);
  });
});

describe("manifest key claim — what it refuses", () => {
  const kp = nkeys.createUser();
  const id = kp.getPublicKey();
  const key = "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw";
  const signed = () => signManifest({ id, encryption_key: key } as Signable, kp);

  it("refuses a substituted encryption key — the whole point (assessment 6.5)", () => {
    const m = signed();
    m.encryption_key = "ATTACKERSOWNX25519PUBLICKEYAAAAAAAAAAAAAAAAA";
    expect(verifyManifestSignature(m)).toBe(false);
  });

  it("refuses a claim signed by a key other than the manifest's id", () => {
    const impostor = nkeys.createUser();
    const m = signManifest({ id, encryption_key: key } as Signable, impostor);
    expect(verifyManifestSignature(m)).toBe(false);
  });

  it("refuses a claim replayed under another agent's id", () => {
    // A signed manifest for B must not be servable as the answer for A. The
    // claim covers `id`, so relabelling it breaks the signature; mesh.ts checks
    // manifest.id === agentId as well, belt and braces.
    const m = signed();
    m.id = nkeys.createUser().getPublicKey();
    expect(verifyManifestSignature(m)).toBe(false);
  });

  it("refuses a moved issued_at", () => {
    const m = signed();
    (m.trust as Record<string, unknown>).issued_at = "2020-01-01T00:00:00.000Z";
    expect(verifyManifestSignature(m)).toBe(false);
  });

  it("refuses an absent or empty trust block — no claim means no sealing", () => {
    expect(verifyManifestSignature({ id, encryption_key: key })).toBe(false);
    expect(verifyManifestSignature({ id, encryption_key: key, trust: {} })).toBe(false);
    expect(verifyManifestSignature({ id, encryption_key: key, trust: { issued_at: "x" } })).toBe(false);
    expect(verifyManifestSignature(null)).toBe(false);
  });

  it("refuses a manifest whose id is not an nkey", () => {
    const m = signed();
    m.id = "not-an-nkey";
    expect(verifyManifestSignature(m)).toBe(false);
  });

  it("refuses newline-bearing components rather than letting them shift the framing", () => {
    expect(() => signManifest({ id, encryption_key: "a\nb" } as Signable, kp)).toThrow(/newline/);
    // On the read side that is a refusal, not a throw — an attacker must not be
    // able to make a verifier crash by putting a newline in a manifest.
    const m = signed();
    m.encryption_key = "a\nb";
    expect(verifyManifestSignature(m)).toBe(false);
  });
});

describe("manifest key claim — versioning and preserved fields", () => {
  const kp = nkeys.createUser();
  const id = kp.getPublicKey();

  it("keeps other trust fields (e.g. tenant) and replaces a stale claim", () => {
    const m: Signable = { id, trust: { tenant: "acme", signature: "stale", issued_at: "stale" } };
    signManifest(m, kp, new Date("2026-01-01T00:00:00.000Z"));
    expect(m.trust?.tenant).toBe("acme");
    expect(m.trust?.issued_at).toBe("2026-01-01T00:00:00.000Z");
    expect(verifyManifestSignature(m)).toBe(true);
  });

  it("is domain-separated, so a v2 claim cannot be read as a v1 one", () => {
    // The tag is inside the signed bytes. A v2 that covers more fields signs
    // different bytes under a different tag, so every v1 signature already
    // issued keeps verifying and no v1 verifier can misread a v2 claim.
    const m = signManifest({ id, encryption_key: "K" } as Signable, kp, new Date(0));
    const v1Bytes = ["agentmesh-manifest-key-v1", new Date(0).toISOString(), id, "K"].join("\n");
    const sig = Uint8Array.from(
      atob(String(m.trust?.signature).replace(/-/g, "+").replace(/_/g, "/") + "=="),
      (c) => c.charCodeAt(0),
    );
    expect(kp.verify(new TextEncoder().encode(v1Bytes), sig)).toBe(true);
    const v2Bytes = v1Bytes.replace("-v1", "-v2");
    expect(kp.verify(new TextEncoder().encode(v2Bytes), sig)).toBe(false);
  });
});
