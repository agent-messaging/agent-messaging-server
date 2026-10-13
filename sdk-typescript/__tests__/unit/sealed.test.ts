import { describe, it, expect } from "vitest";
import {
  createEncryptionIdentity,
  encryptionPublicFromSeed,
  newRoomKey,
  roomKeyFingerprint,
  sealKeyTo,
  openSealedKey,
  sealBody,
  openBody,
  isSealedBody,
  sealBytes,
  openBytes,
} from "../../src/internal/sealed.js";

describe("encryption identity", () => {
  it("derives a stable public key from the seed", () => {
    const id = createEncryptionIdentity();
    expect(encryptionPublicFromSeed(id.seed)).toBe(id.publicKey);
  });
});

describe("room key distribution", () => {
  it("seals to a recipient and only that recipient opens it", () => {
    const alice = createEncryptionIdentity();
    const eve = createEncryptionIdentity();
    const roomKey = newRoomKey();

    const sealed = sealKeyTo(roomKey, alice.publicKey);
    const opened = openSealedKey(sealed, alice.seed);
    expect(Buffer.from(opened)).toEqual(Buffer.from(roomKey));
    expect(roomKeyFingerprint(opened)).toBe(roomKeyFingerprint(roomKey));

    expect(() => openSealedKey(sealed, eve.seed)).toThrow(/did not open/);
  });
});

describe("sealed bodies", () => {
  it("round-trips and refuses the wrong key", () => {
    const key = newRoomKey();
    const wire = sealBody("the plan is confidential", key);
    expect(isSealedBody(wire)).toBe(true);
    expect(wire).not.toContain("confidential");
    expect(openBody(wire, key)).toBe("the plan is confidential");
    expect(openBody(wire, newRoomKey())).toBeNull();
  });

  it("tampered ciphertext fails to open", () => {
    const key = newRoomKey();
    const wire = sealBody("x", key);
    const tampered = wire.slice(0, -4) + (wire.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(openBody(tampered, key)).toBeNull();
  });
});

describe("sealed artifact bytes", () => {
  it("round-trips and the stored blob leaks nothing", () => {
    const key = newRoomKey();
    const data = new TextEncoder().encode("quarterly numbers: 42");
    const blob = sealBytes(data, key);
    expect(new TextDecoder().decode(blob)).not.toContain("quarterly");
    expect(Buffer.from(openBytes(blob, key)!)).toEqual(Buffer.from(data));
    expect(openBytes(blob, newRoomKey())).toBeNull();
  });
});
