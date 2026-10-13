// The three newly domain-tagged canonical-JSON signatures (SPEC.md §4.4 vouch,
// EXT-5 §2 room descriptor, EXT-6 §3 admission roster), asserted against
// conformance/signature-tags.json.
//
// Like budget-conformance.test.ts, this file holds the SDK to pinned bytes the
// TWO implementations (and services' roster verifier) must agree on: the
// prefix string itself, the canonical JSON the signature covers, and a real
// Ed25519 signature over prefix + canonical. THE FIXTURE IS THE AUTHORITY:
// when something here fails, fix src/ to agree with the fixture — never the
// fixture to agree with the code.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  canonicalJSON,
  verifyAttestation,
  verifyTagged,
  fromB64Url,
  keyPairFromSeed,
  VOUCH_SIG_PREFIX,
  ADMISSION_ROSTER_SIG_PREFIX,
} from "../../src/internal/identity.js";
import {
  verifyDescriptor,
  ROOM_DESCRIPTOR_SIG_PREFIX,
  type RoomDescriptor,
} from "../../src/rooms.js";
import type { AgentAttestation } from "../../src/types/manifest.js";
import { nkeys } from "nats.ws";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(here, "..", "..", "..", "conformance", "signature-tags.json");

interface Block {
  signed_bytes_prefix: string;
  canonical: string;
  signed: Record<string, unknown> & { sig: string };
}
interface Fixture {
  identities: { sender_seed: string; sender: string; recipient: string };
  vouch: Block;
  room_descriptor: Block;
  admission_roster: Block;
}
const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

/** Assert the block's invariants that are common to all three signatures:
 *  canonical reproduces from signed minus sig, and the signature covers
 *  STRICTLY prefix + canonical (the bare form must not verify — an untagged
 *  signature would still pass the dual-accept, so this is what holds the
 *  fixture to the new scheme). */
function assertTaggedBlock(block: Block, expectedPrefix: string, sigBytes: Uint8Array) {
  expect(block.signed_bytes_prefix).toBe(expectedPrefix);
  const { sig: _omit, ...rest } = block.signed;
  expect(canonicalJSON(rest)).toBe(block.canonical);
  const enc = new TextEncoder();
  const vpub = nkeys.fromPublic(fixture.identities.sender);
  expect(vpub.verify(enc.encode(block.signed_bytes_prefix + block.canonical), sigBytes)).toBe(true);
  expect(vpub.verify(enc.encode(block.canonical), sigBytes)).toBe(false);
}

describe("§4.4 vouch — the pinned attestation", () => {
  const block = fixture.vouch;
  it("pins the prefix, reproduces the canonical bytes, and the sig covers prefix + canonical only", () => {
    assertTaggedBlock(block, VOUCH_SIG_PREFIX, fromB64Url(block.signed.sig));
  });
  it("verifies through verifyAttestation, bound to the pinned agent", () => {
    const att = block.signed as unknown as AgentAttestation;
    expect(verifyAttestation(att)).toBe(true);
    expect(verifyAttestation(att, fixture.identities.recipient)).toBe(true);
    expect(verifyAttestation({ ...att, agent: fixture.identities.sender })).toBe(false);
  });
  it("the SDK signer reproduces the pinned signature exactly (deterministic Ed25519)", async () => {
    const { createAttestation } = await import("../../src/internal/identity.js");
    const kp = keyPairFromSeed(fixture.identities.sender_seed);
    const att = createAttestation(
      kp,
      fixture.identities.recipient,
      24 * 60 * 60 * 1000,
      new Date("2026-07-27T15:00:00.000Z"),
    );
    expect(att).toEqual(block.signed);
  });
});

describe("EXT-5 §2 room descriptor — the pinned descriptor", () => {
  const block = fixture.room_descriptor;
  it("pins the prefix, reproduces the canonical bytes, and the sig covers prefix + canonical only", () => {
    assertTaggedBlock(block, ROOM_DESCRIPTOR_SIG_PREFIX, fromB64Url(block.signed.sig));
  });
  it("verifies through verifyDescriptor, and not after tampering", () => {
    const d = block.signed as unknown as RoomDescriptor;
    expect(verifyDescriptor(d)).toBe(true);
    expect(verifyDescriptor({ ...d, name: "renamed" })).toBe(false);
  });
});

describe("EXT-6 §3 admission roster — the pinned roster", () => {
  const block = fixture.admission_roster;
  it("pins the prefix, reproduces the canonical bytes, and the sig covers prefix + canonical only", () => {
    // Roster sigs are standard base64 (the signer's historical encoding).
    const sigBytes = new Uint8Array(Buffer.from(block.signed.sig, "base64"));
    assertTaggedBlock(block, ADMISSION_ROSTER_SIG_PREFIX, sigBytes);
  });
  it("verifies through the shared verifyTagged path against owner_key", () => {
    const { sig, ...body } = block.signed;
    expect(
      verifyTagged(
        block.signed.owner_key as string,
        ADMISSION_ROSTER_SIG_PREFIX,
        canonicalJSON(body),
        new Uint8Array(Buffer.from(sig, "base64")),
      ),
    ).toBe(true);
  });
});
