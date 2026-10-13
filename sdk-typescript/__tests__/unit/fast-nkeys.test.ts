import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { nkeys as plain } from "nats.ws";
import { nkeys as fast } from "../../src/internal/nkeys.js";
import { accelerateKeyPair, nativeEd25519 } from "../../src/internal/fast-nkeys.js";
import { keyPairFromSeed, signEnvelope, verifyEnvelopeSig, verifyTagged, signTagged, ENVELOPE_SIG_PREFIX } from "../../src/internal/identity.js";
import type { Envelope } from "../../src/types/envelope.js";

const enc = new TextEncoder();
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

describe("native Ed25519 for nkeys", () => {
  it("is on under Node", () => {
    expect(nativeEd25519()).toBe(true);
  });

  it("signs byte for byte as tweetnacl does, for many keys and messages", () => {
    for (let i = 0; i < 25; i++) {
      const seed = plain.createUser().getSeed();
      const slow = plain.fromSeed(seed);
      const quick = fast.fromSeed(seed);
      for (const len of [0, 1, 63, 600, 5000]) {
        const msg = new Uint8Array(randomBytes(len));
        expect(eq(quick.sign(msg), slow.sign(msg))).toBe(true);
      }
    }
  });

  it("verifies what tweetnacl verifies, and refuses what it refuses", () => {
    const kp = plain.createUser();
    const msg = enc.encode("agentmesh-envelope-v1\n{\"a\":1}");
    const sig = kp.sign(msg);
    const pub = fast.fromPublic(kp.getPublicKey());
    expect(pub.verify(msg, sig)).toBe(true);

    const otherMsg = enc.encode("agentmesh-envelope-v1\n{\"a\":2}");
    expect(pub.verify(otherMsg, sig)).toBe(false);

    const flipped = new Uint8Array(sig); flipped[10] ^= 1;
    expect(pub.verify(msg, flipped)).toBe(false);
    expect(plain.fromPublic(kp.getPublicKey()).verify(msg, flipped)).toBe(false);

    const stranger = fast.fromPublic(plain.createUser().getPublicKey());
    expect(stranger.verify(msg, sig)).toBe(false);
  });

  it("refuses a signature with a non-canonical S (tweetnacl would accept it)", () => {
    // S + L is the same point equation, so a lax verifier accepts it; RFC 8032
    // says refuse. Being stricter than before is allowed; looser is not.
    const kp = plain.createUser();
    const msg = enc.encode("x");
    const sig = kp.sign(msg);
    const L = [0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10];
    const bad = new Uint8Array(sig);
    let carry = 0;
    for (let i = 0; i < 32; i++) { const v = bad[32 + i] + L[i] + carry; bad[32 + i] = v & 0xff; carry = v >> 8; }
    if (carry === 0) expect(fast.fromPublic(kp.getPublicKey()).verify(msg, bad)).toBe(false);
  });

  it("throws on the same bad input as before", () => {
    const kp = plain.createUser();
    const pub = fast.fromPublic(kp.getPublicKey());
    expect(() => pub.verify(enc.encode("x"), new Uint8Array(10))).toThrow("bad signature size");
    expect(() => fast.fromPublic("UNOTAKEY")).toThrow();
    // A changed last character breaks the checksum. It is changed for certain:
    // a key that already ended in "A" stayed the same key and did not throw,
    // which failed main one run in 32 (2026-10-12).
    const key = kp.getPublicKey();
    expect(() => fast.fromPublic(key.slice(0, -1) + (key.endsWith("A") ? "B" : "A"))).toThrow();
  });

  it("a cleared pair no longer signs natively", () => {
    const kp = fast.createUser();
    kp.sign(enc.encode("warm"));
    kp.clear();
    const slow = plain.createUser(); slow.clear();
    let fastThrew = false, slowThrew = false;
    try { kp.sign(enc.encode("x")); } catch { fastThrew = true; }
    try { slow.sign(enc.encode("x")); } catch { slowThrew = true; }
    expect(fastThrew).toBe(slowThrew);
  });

  it("remembers a seeded pair's public key, and forgets it on clear", () => {
    const seed = plain.createUser().getSeed();
    const kp = fast.fromSeed(seed);
    const slow = plain.fromSeed(seed);
    expect(kp.getPublicKey()).toBe(slow.getPublicKey());
    expect(kp.getPublicKey()).toBe(slow.getPublicKey());
    kp.clear(); slow.clear();
    let a: unknown, b: unknown;
    try { a = kp.getPublicKey(); } catch (e) { a = "threw"; }
    try { b = slow.getPublicKey(); } catch (e) { b = "threw"; }
    expect(a).toEqual(b);
  });

  it("accelerating twice is harmless", () => {
    const kp = plain.createUser();
    const a = accelerateKeyPair(kp);
    const b = accelerateKeyPair(a);
    const msg = enc.encode("twice");
    expect(eq(b.sign(msg), plain.fromSeed(kp.getSeed()).sign(msg))).toBe(true);
  });

  it("an envelope signed natively verifies under tweetnacl, and the other way round", () => {
    const seed = new TextDecoder().decode(plain.createUser().getSeed());
    const kp = keyPairFromSeed(seed);
    const env = { v: "0.3", id: "e1", type: "request", from: kp.getPublicKey(), to: "x", ts: "2026-09-28T00:00:00Z", payload: { a: 1 } } as unknown as Envelope;
    signEnvelope(env, kp);
    expect(verifyEnvelopeSig(env)).toBe(true);
    const { sig: _s, ...rest } = env as Envelope & { sig?: string };
    const slowPub = plain.fromPublic(kp.getPublicKey());
    const b64 = (env.sig as string).replace(/-/g, "+").replace(/_/g, "/");
    const raw = Uint8Array.from(atob(b64 + "===".slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0));
    expect(slowPub.verify(enc.encode(ENVELOPE_SIG_PREFIX + JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1))))), raw)).toBe(true);

    const slowKp = plain.fromSeed(enc.encode(seed));
    const sig2 = slowKp.sign(enc.encode("p\n" + "{}"));
    expect(verifyTagged(kp.getPublicKey(), "p\n", "{}", sig2)).toBe(true);
    expect(eq(signTagged(kp, "p\n", "{}"), sig2)).toBe(true);
  });
});
