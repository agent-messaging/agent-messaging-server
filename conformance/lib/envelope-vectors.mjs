// Envelope signing and verification for the suite's offline fixture checks,
// with node's own crypto and nothing installed.
//
// The fixtures in conformance/*.json carry really-signed envelopes, and a
// fixture that nothing verifies is decoration. The SDKs verify them in their
// own unit tests; this file lets a fixture be checked here, before any SDK has
// caught up with it, by the same rules SPEC.md §5.3 states:
//
//   signed bytes = "agentmesh-envelope-v1" + LF + canonical JSON of the
//                  envelope without `sig` (RFC 8785, absent members omitted)
//   sig          = Ed25519 over those bytes, base64url without padding
//
// It is test code for vectors. It canonicalizes the JSON the fixtures use
// (objects, arrays, strings, integers, booleans, null) and checks itself
// against conformance/accept-signal.json's signed accept before it is trusted
// with anything else (check-audience-fixture.mjs does that first).
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";

export const ENVELOPE_PREFIX = "agentmesh-envelope-v1\n";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Uint8Array.from(out);
}

function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function checked(raw, what) {
  const body = raw.subarray(0, raw.length - 2);
  const want = raw[raw.length - 2] | (raw[raw.length - 1] << 8);
  if (crc16(body) !== want) throw new Error(`${what} fails its checksum`);
  return body;
}

/** The Ed25519 private key inside an nkey seed (`S...`). */
export function privateKeyFromSeed(seed) {
  const raw = base32Decode(String(seed).trim());
  if (raw.length !== 36) throw new Error("an nkey seed decodes to 36 bytes");
  const body = checked(raw, "seed");
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(body.subarray(2))]);
  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

/** The Ed25519 public key named by an agent ID (`U...`). */
export function publicKeyFromId(id) {
  const raw = base32Decode(String(id).trim());
  if (raw.length !== 35) throw new Error("an nkey public key decodes to 35 bytes");
  const body = checked(raw, "public key");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(body.subarray(1))]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

/** The agent ID (`U...`) for a seed, so a fixture's identities can be checked against each other. */
export function idFromSeed(seed) {
  const pub = createPublicKey(privateKeyFromSeed(seed)).export({ format: "der", type: "spki" }).subarray(12);
  const prefix = 20 << 3; // 'U', the user (agent) key prefix
  const body = Buffer.concat([Buffer.from([prefix]), pub]);
  const crc = crc16(body);
  const raw = Buffer.concat([body, Buffer.from([crc & 0xff, crc >> 8])]);
  let bits = 0, value = 0, out = "";
  for (const b of raw) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 8785 canonical JSON for the value shapes the fixtures use. */
export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("NaN and Infinity are not JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  throw new Error(`cannot canonicalize a ${typeof value}`);
}

/** The canonical envelope without `sig`, which is what the signature covers after the prefix. */
export function canonicalEnvelope(envelope) {
  const { sig: _sig, ...rest } = envelope;
  return canonical(rest);
}

const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** A copy of `envelope` signed with `seed`. Used to generate vectors, never by a check. */
export function signEnvelope(envelope, seed) {
  const bytes = Buffer.from(ENVELOPE_PREFIX + canonicalEnvelope(envelope), "utf8");
  return { ...envelope, sig: b64url(edSign(null, bytes, privateKeyFromSeed(seed))) };
}

/** Whether `envelope.sig` verifies against `envelope.from` over the tagged canonical bytes. */
export function verifyEnvelope(envelope) {
  if (!envelope || typeof envelope.sig !== "string" || typeof envelope.from !== "string") return false;
  try {
    const bytes = Buffer.from(ENVELOPE_PREFIX + canonicalEnvelope(envelope), "utf8");
    return edVerify(null, bytes, publicKeyFromId(envelope.from), unb64url(envelope.sig));
  } catch {
    return false;
  }
}
