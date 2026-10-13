/**
 * Sealed-grade cryptography for rooms (mesh://extensions/rooms/v1, §7.3).
 *
 * The agent's ENCRYPTION identity is an X25519 keypair, distinct from its
 * Ed25519 signing keypair (core §4.3): signing proves who wrote a thing,
 * the encryption key lets others seal things TO the agent. The public half
 * travels in the manifest (`encryption_key`) and on the PAN card.
 *
 * The ROOM KEY is 32 random bytes. Possession of it IS membership at the
 * sealed grade: message bodies and drive bytes are encrypted under it
 * (XSalsa20-Poly1305), so the transport and the storage hold only
 * ciphertext. The key is distributed exactly one way — sealed to a member's
 * X25519 public key with an ephemeral-sender box — and it never enters the
 * record.
 *
 * No separate AAD construction: every room message is an Ed25519-signed
 * envelope, and the signature already binds the ciphertext to the room
 * (context_id), channel (subject + payload), author, and message id.
 * Tampering with any of those breaks the signature before decryption is
 * even attempted.
 */
import nacl from "tweetnacl";
import { toB64Url, fromB64Url } from "./identity.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Create an agent encryption identity. Persist the seed (secret key);
 *  publish the public key in the manifest / on the card. */
export function createEncryptionIdentity(): { publicKey: string; seed: string } {
  const kp = nacl.box.keyPair();
  return { publicKey: toB64Url(kp.publicKey), seed: toB64Url(kp.secretKey) };
}

export function encryptionPublicFromSeed(seed: string): string {
  return toB64Url(nacl.box.keyPair.fromSecretKey(fromB64Url(seed)).publicKey);
}

/** New 32-byte room key. */
export function newRoomKey(): Uint8Array {
  return nacl.randomBytes(32);
}

/** Room-key fingerprint (descriptor `key_fingerprint`): first 16 bytes of
 *  SHA-512(key), base64url. Confirms two members hold the same key without
 *  revealing it. */
export function roomKeyFingerprint(key: Uint8Array): string {
  return toB64Url(nacl.hash(key).subarray(0, 16));
}

/** A room key sealed to one member's X25519 public key (invite payload). */
export interface SealedKey {
  v: "sealedkey.v1";
  /** Ephemeral sender public key. */
  epk: string;
  nonce: string;
  ct: string;
}

export function sealKeyTo(roomKey: Uint8Array, recipientPublicB64: string): SealedKey {
  const ekp = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(roomKey, nonce, fromB64Url(recipientPublicB64), ekp.secretKey);
  return { v: "sealedkey.v1", epk: toB64Url(ekp.publicKey), nonce: toB64Url(nonce), ct: toB64Url(ct) };
}

export function openSealedKey(sealed: SealedKey, recipientSeed: string): Uint8Array {
  if (sealed?.v !== "sealedkey.v1") throw new Error("unrecognized sealed-key format");
  const sk = nacl.box.keyPair.fromSecretKey(fromB64Url(recipientSeed)).secretKey;
  const key = nacl.box.open(fromB64Url(sealed.ct), fromB64Url(sealed.nonce), fromB64Url(sealed.epk), sk);
  if (!key) throw new Error("sealed room key did not open (wrong recipient key?)");
  return key;
}

const BODY_PREFIX = "sealed:";

/** Encrypt a `say` body (or any text) under the room key. Wire form:
 *  `sealed:<nonce-b64url>:<ct-b64url>`. */
export function sealBody(body: string, roomKey: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(enc.encode(body), nonce, roomKey);
  return `${BODY_PREFIX}${toB64Url(nonce)}:${toB64Url(ct)}`;
}

export function isSealedBody(body: string): boolean {
  return typeof body === "string" && body.startsWith(BODY_PREFIX);
}

/** Decrypt a sealed body. Returns null on any failure (wrong key, garbage). */
export function openBody(body: string, roomKey: Uint8Array): string | null {
  if (!isSealedBody(body)) return null;
  const parts = body.slice(BODY_PREFIX.length).split(":");
  if (parts.length !== 2) return null;
  try {
    const pt = nacl.secretbox.open(fromB64Url(parts[1]!), fromB64Url(parts[0]!), roomKey);
    return pt ? dec.decode(pt) : null;
  } catch {
    return null;
  }
}

/** A request/response payload sealed to one agent's X25519 public key —
 *  the pairwise profile of mesh://extensions/e2e-encryption/v1. The outer
 *  keypair is ephemeral (sender unlinkability at the crypto layer; the
 *  envelope signature already names the sender where it should be named).
 *  `reply_key` is the key the responder SHOULD seal its answer to. */
export interface SealedPayload {
  v: "sealedpayload.v1";
  /** Ephemeral sender public key for this box. */
  epk: string;
  nonce: string;
  ct: string;
  /** Where to seal the reply (the sender's durable encryption key). */
  reply_key?: string;
}

export function sealPayloadTo(payload: unknown, recipientPublicB64: string, replyKeyB64?: string): SealedPayload {
  const ekp = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(enc.encode(JSON.stringify(payload ?? null)), nonce, fromB64Url(recipientPublicB64), ekp.secretKey);
  const out: SealedPayload = { v: "sealedpayload.v1", epk: toB64Url(ekp.publicKey), nonce: toB64Url(nonce), ct: toB64Url(ct) };
  if (replyKeyB64) out.reply_key = replyKeyB64;
  return out;
}

export function isSealedPayload(p: unknown): p is SealedPayload {
  return !!p && typeof p === "object" && (p as SealedPayload).v === "sealedpayload.v1";
}

/** Open a sealed payload with the recipient's encryption seed. Returns null
 *  on any failure (wrong key, tampered box, garbage). */
export function openSealedPayload(p: SealedPayload, recipientSeed: string): { payload: unknown; reply_key?: string } | null {
  if (!isSealedPayload(p)) return null;
  try {
    const sk = nacl.box.keyPair.fromSecretKey(fromB64Url(recipientSeed)).secretKey;
    const pt = nacl.box.open(fromB64Url(p.ct), fromB64Url(p.nonce), fromB64Url(p.epk), sk);
    if (!pt) return null;
    return { payload: JSON.parse(dec.decode(pt)), reply_key: p.reply_key };
  } catch {
    return null;
  }
}

/**
 * The key a reply may be sealed to, given what the requester ASKED for
 * (`reply_key`, from the opened payload) and what the sender has PUBLISHED
 * (its manifest's verified `encryption_key`). Returns null to mean "do not
 * seal": answer in the clear, or refuse, but do not encrypt to this key.
 *
 * `reply_key` rides outside the box as a sibling of `ct`. On SDK paths the
 * envelope signature covers it, so it cannot be altered in flight — but it was
 * never compared to anything, which left the requester free to name any key at
 * all as the one its answer should be encrypted under, with the choice
 * completely decoupled from the identity the envelope proves. Resolving it
 * against the sender's published key re-couples the two: seal to the key the
 * sender's signed manifest declares, and treat a `reply_key` that disagrees as
 * a refusal rather than quietly honouring it.
 */
export function resolveReplyKey(
  claimed: string | undefined,
  declared: string | null | undefined,
): string | null {
  if (!declared) return null; // nothing verified to seal to
  if (claimed !== undefined && claimed !== declared) return null; // disagreement: refuse
  return declared;
}

/** Encrypt artifact bytes: the stored blob is nonce(24) || secretbox(bytes).
 *  Digests are taken over the STORED (encrypted) blob so anyone — including
 *  the store — can verify integrity without holding the key. */
export function sealBytes(data: Uint8Array, roomKey: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(data, nonce, roomKey);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

export function openBytes(blob: Uint8Array, roomKey: Uint8Array): Uint8Array | null {
  if (blob.length <= nacl.secretbox.nonceLength) return null;
  const nonce = blob.subarray(0, nacl.secretbox.nonceLength);
  const ct = blob.subarray(nacl.secretbox.nonceLength);
  return nacl.secretbox.open(ct, nonce, roomKey);
}
