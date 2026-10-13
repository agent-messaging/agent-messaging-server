import { describe, it, expect } from "vitest";
import { nkeys } from "nats.ws";
import {
  createAgentIdentity,
  keyPairFromSeed,
  signEnvelope,
  verifyEnvelopeSig,
  canonicalJSON,
  canonicalEnvelopeBytes,
  signedEnvelopeBytes,
  toB64Url,
  fromB64Url,
  ENVELOPE_SIG_PREFIX,
  VOUCH_SIG_PREFIX,
  createAttestation,
  verifyAttestation,
  createTrustAttestation,
  verifyTrustAttestation,
  attestationExpired,
} from "../../src/internal/identity.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { encode, decode } from "../../src/internal/codec.js";

describe("identity — canonicalization", () => {
  it("is stable regardless of key insertion order", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe(canonicalJSON({ a: 2, b: 1 }));
    expect(canonicalJSON({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });
  it("recurses into nested objects and arrays", () => {
    expect(canonicalJSON({ x: [{ z: 1, y: 2 }] })).toBe('{"x":[{"y":2,"z":1}]}');
  });
});

describe("identity — agent keys", () => {
  it("creates an agent identity whose seed round-trips to the same public key", () => {
    const { publicKey, seed } = createAgentIdentity();
    expect(publicKey.startsWith("U")).toBe(true);
    const kp = keyPairFromSeed(seed);
    expect(kp.getPublicKey()).toBe(publicKey);
  });
});

describe("identity — envelope signing", () => {
  const kp = nkeys.createUser();
  const from = kp.getPublicKey();

  it("signs and verifies an envelope", () => {
    const env = signEnvelope(createEnvelope({ type: "request", from, payload: { a: 1 } }), kp);
    expect(typeof env.sig).toBe("string");
    expect(verifyEnvelopeSig(env)).toBe(true);
  });

  it("fails verification if the payload is tampered", () => {
    const env = signEnvelope(createEnvelope({ type: "request", from, payload: { a: 1 } }), kp);
    (env.payload as { a: number }).a = 999;
    expect(verifyEnvelopeSig(env)).toBe(false);
  });

  it("fails verification if `from` doesn't match the signing key", () => {
    const other = nkeys.createUser();
    const env = createEnvelope({ type: "request", from: other.getPublicKey(), payload: {} });
    signEnvelope(env, kp); // signed by kp, but from = other
    expect(verifyEnvelopeSig(env)).toBe(false);
  });

  it("survives a full encode → decode round-trip (decode verifies the sig)", () => {
    const env = signEnvelope(
      createEnvelope({ type: "emit", from, payload: { hello: "world" } }),
      kp,
    );
    const decoded = decode(encode(env));
    expect(decoded.from).toBe(from);
    expect(decoded.payload).toEqual({ hello: "world" });
  });

  it("decode rejects an unsigned envelope", () => {
    const env = createEnvelope({ type: "emit", from, payload: {} });
    expect(() => decode(encode(env))).toThrow(/signature/i);
  });

  it("decode rejects a tampered signed envelope", () => {
    const env = signEnvelope(createEnvelope({ type: "emit", from, payload: { n: 1 } }), kp);
    (env.payload as { n: number }).n = 2;
    expect(() => decode(encode(env))).toThrow(/signature/i);
  });

  it("signs the tagged form: sig covers ENVELOPE_SIG_PREFIX + canonical JSON (§5.3)", () => {
    expect(ENVELOPE_SIG_PREFIX).toBe("agentmesh-envelope-v1\n");
    const env = signEnvelope(createEnvelope({ type: "request", from, payload: { a: 1 } }), kp);
    const signed = signedEnvelopeBytes(env);
    const canonical = canonicalEnvelopeBytes(env);
    // The signed bytes ARE prefix + canonical …
    expect(new TextDecoder().decode(signed)).toBe(
      ENVELOPE_SIG_PREFIX + new TextDecoder().decode(canonical),
    );
    // … and the emitted signature verifies over exactly them, never the bare form.
    expect(kp.verify(signed, fromB64Url(env.sig!))).toBe(true);
    expect(kp.verify(canonical, fromB64Url(env.sig!))).toBe(false);
  });

  it("refuses a legacy untagged signature (the 0.2 dual-accept closed at 0.3)", () => {
    // §5.3's migration clause: from protocol 0.3, verifiers MUST refuse a
    // signature over the bare canonical JSON. This release is 0.3.
    const env = createEnvelope({ type: "request", from, payload: { a: 1 } });
    env.sig = toB64Url(kp.sign(canonicalEnvelopeBytes(env))); // the pre-tag scheme
    expect(verifyEnvelopeSig(env)).toBe(false);
    expect(() => decode(encode(env))).toThrow(/signature/i);
  });
});

describe("identity — node vouching", () => {
  const nodeKp = nkeys.createUser();
  const agentPub = nkeys.createUser().getPublicKey();

  it("creates and verifies a node→agent attestation", () => {
    const att = createAttestation(nodeKp, agentPub);
    expect(att.node).toBe(nodeKp.getPublicKey());
    expect(att.agent).toBe(agentPub);
    expect(verifyAttestation(att)).toBe(true);
    expect(verifyAttestation(att, agentPub)).toBe(true);
  });

  it("rejects an attestation for a different agent", () => {
    const att = createAttestation(nodeKp, agentPub);
    expect(verifyAttestation(att, "UOTHERAGENT")).toBe(false);
  });

  it("rejects a tampered attestation", () => {
    const att = createAttestation(nodeKp, agentPub);
    att.agent = nkeys.createUser().getPublicKey();
    expect(verifyAttestation(att)).toBe(false);
  });

  it("reports expiry", () => {
    const past = new Date(Date.now() - 2000);
    const att = createAttestation(nodeKp, agentPub, 1000, past);
    expect(attestationExpired(att)).toBe(true);
  });

  it("signs the tagged form: sig covers VOUCH_SIG_PREFIX + canonical JSON (§4.4)", () => {
    expect(VOUCH_SIG_PREFIX).toBe("agentmesh-vouch-v1\n");
    const att = createAttestation(nodeKp, agentPub);
    const { sig, ...rest } = att;
    const enc = new TextEncoder();
    // The signature covers prefix + canonical, never the bare form.
    expect(nodeKp.verify(enc.encode(VOUCH_SIG_PREFIX + canonicalJSON(rest)), fromB64Url(sig))).toBe(true);
    expect(nodeKp.verify(enc.encode(canonicalJSON(rest)), fromB64Url(sig))).toBe(false);
  });

  it("refuses a legacy untagged attestation (the 0.2 dual-accept closed at 0.3)", () => {
    const att = createAttestation(nodeKp, agentPub);
    const { sig: _drop, ...rest } = att;
    att.sig = toB64Url(nodeKp.sign(new TextEncoder().encode(canonicalJSON(rest)))); // the pre-tag scheme
    expect(verifyAttestation(att)).toBe(false);
  });
});

describe("identity — portable trust attestations (§9.7)", () => {
  const operator = nkeys.createAccount();
  const subject = nkeys.createUser().getPublicKey();

  it("carries a type tag inside the signed bytes", () => {
    const att = createTrustAttestation(operator, subject, { trust_tier: "verified" });
    expect(att.type).toBe("agentmesh-trust-attestation-v1");
    expect(verifyTrustAttestation(att, subject)).toBe(true);
  });

  it("refuses an attestation whose type it does not know", () => {
    const att = createTrustAttestation(operator, subject, { trust_tier: "verified" });
    // A future format, or another signed object dressed as this one: a
    // verifier that cannot name the format must not act on the claim.
    const future = { ...att, type: "agentmesh-trust-attestation-v2" } as typeof att;
    expect(verifyTrustAttestation(future, subject)).toBe(false);
  });

  it("refuses to strip the type tag and still verify", () => {
    const att = createTrustAttestation(operator, subject, { trust_tier: "verified" });
    const { type: _dropped, ...untyped } = att;
    expect(verifyTrustAttestation(untyped as typeof att, subject)).toBe(false);
  });

  it("rejects an expired claim by default, and reads one only on request", () => {
    const past = new Date(Date.now() - 10_000);
    const att = createTrustAttestation(operator, subject, { trust_tier: "verified" }, 1000, past);
    expect(attestationExpired(att)).toBe(true);
    // The party checking a portable claim is the one least able to know it
    // went stale, so the default answer is no.
    expect(verifyTrustAttestation(att, subject)).toBe(false);
    expect(verifyTrustAttestation(att, subject, { allowExpired: true })).toBe(true);
  });

  it("still rejects tampering and issuer forgery", () => {
    const att = createTrustAttestation(operator, subject, { trust_tier: "verified" });
    expect(verifyTrustAttestation({ ...att, claims: { trust_tier: "standard" } }, subject)).toBe(false);
    const impostor = nkeys.createAccount();
    const forged = createTrustAttestation(impostor, subject, { trust_tier: "verified" });
    forged.issuer = att.issuer;
    expect(verifyTrustAttestation(forged, subject)).toBe(false);
  });
});
