import type { Envelope } from "../types/envelope.js";
import { validateEnvelope } from "./envelope-builder.js";
import { verifyEnvelopeSig } from "./identity.js";
import { MeshError, ErrorCode } from "../types/errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode an Envelope to UTF-8 JSON bytes. The envelope SHOULD already be
 *  signed (§4.5); signing is the caller's responsibility before publish. */
export function encode(envelope: Envelope): Uint8Array {
  return encoder.encode(JSON.stringify(envelope));
}

/** Decode bytes to an Envelope: structural validation + signature verification
 *  against `from` (§5.3). Throws IDENTITY_MISMATCH on a missing/invalid sig. */
export function decode(data: Uint8Array): Envelope {
  const json = decoder.decode(data);
  const parsed = JSON.parse(json);
  validateEnvelope(parsed);
  if (typeof (parsed as Envelope).sig !== "string" || !(parsed as Envelope).sig) {
    throw new MeshError(ErrorCode.IDENTITY_MISMATCH, "Envelope is missing a signature (`sig`)");
  }
  if (!verifyEnvelopeSig(parsed)) {
    throw new MeshError(
      ErrorCode.IDENTITY_MISMATCH,
      `Envelope signature does not verify against 'from' (${(parsed as Envelope).from})`,
    );
  }
  return parsed;
}

/** Decode with structural validation but WITHOUT signature verification.
 *  For trusted/local paths (e.g. same-node local delivery where the node has
 *  already verified identity) and for tooling. */
export function decodeUnverified(data: Uint8Array): Envelope {
  const json = decoder.decode(data);
  const parsed = JSON.parse(json);
  validateEnvelope(parsed);
  return parsed;
}

/** Decode without any validation (trusted, hot paths). */
export function decodeUnsafe(data: Uint8Array): Envelope {
  return JSON.parse(decoder.decode(data)) as Envelope;
}

/** Decode a STREAM CHUNK envelope (§11.6). Chunks are authenticated at the
 *  stream level: intermediate chunks MAY omit `sig` (authenticity rests on the
 *  signed opening/final bracket + transport authorization), so a missing sig
 *  is accepted — but a PRESENT sig must verify, and callers enforce that the
 *  final chunk is signed. `requireSig` (config.sign_chunks) demands one. */
export function decodeChunk(data: Uint8Array, requireSig: boolean): Envelope {
  const json = decoder.decode(data);
  const parsed = JSON.parse(json);
  validateEnvelope(parsed);
  const sig = (parsed as Envelope).sig;
  if (typeof sig === "string" && sig) {
    if (!verifyEnvelopeSig(parsed)) {
      throw new MeshError(
        ErrorCode.IDENTITY_MISMATCH,
        `Chunk signature does not verify against 'from' (${(parsed as Envelope).from})`,
      );
    }
  } else if (requireSig) {
    throw new MeshError(
      ErrorCode.IDENTITY_MISMATCH,
      "Stream was requested with sign_chunks but a chunk arrived unsigned",
    );
  }
  return parsed;
}
