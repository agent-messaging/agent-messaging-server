import { nkeys } from "nats.ws";
import { createEnvelope, type EnvelopeParams } from "../src/internal/envelope-builder.js";
import { signEnvelope } from "../src/internal/identity.js";
import type { Envelope } from "../src/types/envelope.js";

/**
 * Test helpers for AgentMesh 0.2 — envelopes are always signed (§4.5), so
 * `from` must be a real nkey public key and carry a valid signature. These
 * helpers map a logical name (e.g. "responder-1") to a stable test keypair and
 * produce properly-signed envelopes.
 */

const _kps = new Map<string, ReturnType<typeof nkeys.createUser>>();

export function testKeyPair(name = "default"): ReturnType<typeof nkeys.createUser> {
  let kp = _kps.get(name);
  if (!kp) {
    kp = nkeys.createUser();
    _kps.set(name, kp);
  }
  return kp;
}

export function testPub(name = "default"): string {
  return testKeyPair(name).getPublicKey();
}

/** Build a signed envelope for tests. The `from` value is treated as a logical
 *  name: it's mapped to a stable keypair whose public key becomes the actual
 *  `from`, and the envelope is signed with that key so `decode` verifies. */
export function makeSigned(
  params: Omit<EnvelopeParams, "from"> & { from?: string },
): Envelope {
  const kp = testKeyPair(params.from ?? "default");
  const env = createEnvelope({ ...params, from: kp.getPublicKey() } as EnvelopeParams);
  return signEnvelope(env, kp);
}
