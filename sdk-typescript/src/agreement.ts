/**
 * Agreements (§19.5) — proof the buyer accepted the terms.
 *
 * A declared price and a signed usage receipt are two legs of a stool. The
 * third is this: without it, a receipt is an invoice nobody agreed to pay. An
 * agreement binds a consumer ACCOUNT (the owner key, §8.6) to a SKU at a
 * specific digest, and rating (§19.6) charges nothing where no matching
 * agreement existed.
 *
 * Three properties carry the design:
 *
 *  - **Account-level, never per-agent.** An agent cannot click through a terms
 *    page; its human operator approves once and every agent under that owner
 *    is covered. Same reasoning as the allowance being owner-signed: it is a
 *    human's money.
 *  - **A digest mismatch is a missing agreement.** When the seller changes
 *    price or terms the digest moves and every standing agreement goes stale
 *    at once. There is no grandfathering rule because there is nothing to
 *    grandfather — re-approval IS the rule, and that is what stops a seller
 *    re-pricing under a standing acceptance.
 *  - **Revocation is prospective.** Usage already metered under a live
 *    agreement stays rated; revoking ends future authority, it does not
 *    unwind the past.
 *
 * This module is the document handling (shape, tagged signature, the matching
 * rule) and the typed refusal. Enforcement — checking at admission, before any
 * work — lives on AgentMesh, because it happens inside the inbound dispatch.
 * Shapes pinned by `conformance/commerce.json`.
 */

import { MeshError, ErrorCode } from "./types/errors.js";
import {
  canonicalJSON,
  signTagged,
  verifyTagged,
  toB64Url,
  fromB64Url,
  type KeyPair,
} from "./internal/identity.js";

/** The domain tag inside an agreement's signed bytes (§19.5): `sig` covers
 *  this prefix + the canonical JSON of the document excluding `sig`. The
 *  prefix exists only inside the signed bytes — it never appears in the
 *  document itself. Pinned by conformance/commerce.json. */
export const AGREEMENT_SIG_PREFIX = "agentmesh-agreement-v1\n";

/** Provider-side confirmation backing an agreement (§19.4/§19.5): a checkout
 *  session, a mandate id. Informative to the mesh; authoritative on the
 *  provider's own rail. */
export interface AgreementEvidence {
  provider: string;
  ref?: string;
}

export interface AgreementDocument {
  /** The document format version, the integer 1. */
  v: number;
  /** The consumer's OWNER key (§8.6) — the signer, and the account this
   *  agreement covers. Never an agent key. */
  consumer_owner: string;
  /** The agent whose SKU this accepts. */
  seller_agent: string;
  sku: string;
  /** The terms accepted: the SKU's tagged SHA-256 digest (§19.1). */
  sku_digest: string;
  agreed_at: string;
  /** OPTIONAL. Absent means the agreement stands until revoked or the digest
   *  moves — both of which are ordinary, so an expiry is a convenience, not a
   *  safety mechanism. */
  expires_at?: string;
  evidence?: AgreementEvidence;
  /** base64url Ed25519 over AGREEMENT_SIG_PREFIX + the canonical document
   *  excluding `sig`, by `consumer_owner`. */
  sig: string;
}

const NKEY_RE = /^U[A-Z2-7]{55}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function invalid(message: string): never {
  throw new MeshError(ErrorCode.INVALID_ENVELOPE, `agreement: ${message} (§19.5)`);
}

/** Shape check, per conformance/commerce.json `agreement.invalid`. Signature
 *  is `verifyAgreementSignature`'s job; this is the shape alone. */
export function validateAgreement(doc: unknown): asserts doc is AgreementDocument {
  if (typeof doc !== "object" || doc === null) invalid("must be an object");
  const d = doc as Record<string, unknown>;
  if (d.v !== 1) invalid("v is the integer 1");
  if (typeof d.consumer_owner !== "string" || !NKEY_RE.test(d.consumer_owner)) {
    invalid("consumer_owner must be an owner nkey — the ACCOUNT, never an agent key");
  }
  if (typeof d.seller_agent !== "string" || !NKEY_RE.test(d.seller_agent)) {
    invalid("seller_agent must be an agent nkey");
  }
  if (typeof d.sku !== "string" || d.sku === "") invalid("sku is required");
  if (typeof d.sku_digest !== "string" || d.sku_digest === "") {
    invalid("an agreement without a digest agrees to nothing");
  }
  if (typeof d.agreed_at !== "string" || !RFC3339.test(d.agreed_at)) {
    invalid("agreed_at must be an RFC-3339 instant");
  }
  if (d.expires_at !== undefined && (typeof d.expires_at !== "string" || !RFC3339.test(d.expires_at))) {
    invalid("expires_at, when present, must be an RFC-3339 instant");
  }
  if (d.evidence !== undefined) {
    const e = d.evidence as Record<string, unknown> | null;
    if (typeof e !== "object" || e === null || typeof e.provider !== "string" || e.provider === "") {
      invalid("evidence names the provider that confirmed it");
    }
    if (e.ref !== undefined && typeof e.ref !== "string") invalid("evidence.ref must be a string");
  }
  if (typeof d.sig !== "string" || d.sig === "") invalid("sig is required");
}

/** The canonical JSON an agreement's `sig` covers (without the prefix). */
export function canonicalAgreementJSON(doc: object): string {
  const { sig: _omit, ...rest } = doc as { sig?: string };
  return canonicalJSON(rest);
}

/** Verify `sig` against the document's own `consumer_owner` (§19.5). Signature
 *  only — shape is `validateAgreement`'s job. */
export function verifyAgreementSignature(doc: unknown): boolean {
  if (typeof doc !== "object" || doc === null) return false;
  const d = doc as Record<string, unknown>;
  if (typeof d.consumer_owner !== "string" || typeof d.sig !== "string" || d.sig === "") return false;
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromB64Url(d.sig);
  } catch {
    return false;
  }
  return verifyTagged(d.consumer_owner, AGREEMENT_SIG_PREFIX, canonicalAgreementJSON(d), sigBytes);
}

/**
 * Sign an agreement with the consumer's OWNER key. Sets `consumer_owner` to
 * the signing key's public key — the signer IS the account by definition, and
 * filling it here makes a mismatch impossible.
 */
export function signAgreement(
  doc: Omit<AgreementDocument, "sig" | "consumer_owner"> & { consumer_owner?: string; sig?: string },
  ownerKp: KeyPair,
): AgreementDocument {
  const { sig: _drop, ...rest } = doc;
  const unsigned = { ...rest, consumer_owner: ownerKp.getPublicKey() };
  const sig = toB64Url(signTagged(ownerKp, AGREEMENT_SIG_PREFIX, canonicalJSON(unsigned)));
  const signed = { ...unsigned, sig } as AgreementDocument;
  validateAgreement(signed);
  return signed;
}

/** Load an agreement: shape, then signature. Throws `INVALID_ENVELOPE` on a
 *  shape fault, `IDENTITY_MISMATCH` on a signature that does not verify.
 *  Callers enforcing MUST fail closed on a throw — an unverifiable agreement
 *  is no agreement, which is the safe direction here (it refuses work rather
 *  than authorising it). */
export function loadAgreement(doc: unknown): AgreementDocument {
  validateAgreement(doc);
  if (!verifyAgreementSignature(doc)) {
    throw new MeshError(
      ErrorCode.IDENTITY_MISMATCH,
      "Agreement signature does not verify against consumer_owner (§19.5) — treated as absent",
      { retryable: false },
    );
  }
  return doc;
}

/**
 * Does this agreement authorise this work, right now?
 *
 * Every clause is a MUST, and the digest one is the load-bearing clause: an
 * agreement to yesterday's price does not cover today's. Expiry is compared
 * without a skew tolerance deliberately — unlike a §7.7 deadline, nothing
 * races here: the consumer re-approves, and a second either side of an expiry
 * changes nothing anyone can observe.
 */
export function agreementCovers(
  doc: AgreementDocument,
  want: { consumerOwner: string; sellerAgent: string; sku: string; skuDigest: string; now?: number },
): boolean {
  if (doc.consumer_owner !== want.consumerOwner) return false;
  if (doc.seller_agent !== want.sellerAgent) return false;
  if (doc.sku !== want.sku) return false;
  if (doc.sku_digest !== want.skuDigest) return false;
  if (doc.expires_at !== undefined) {
    const at = Date.parse(doc.expires_at);
    if (!Number.isFinite(at)) return false; // an undatable expiry is expired
    if ((want.now ?? Date.now()) >= at) return false;
  }
  return true;
}

/** What the refusal's `details` carries (§19.5 / conformance/commerce.json).
 *  The field names are the protocol between implementations. */
export interface AgreementRequiredDetails {
  sku: string;
  sku_digest: string;
  approval_url: string;
}

/**
 * Admission refusal: the requested work is covered by a paid SKU and the
 * consumer's account holds no agreement at its current digest (§19.5, §12.2).
 * Refused BEFORE any work — §1.3's "payment required", typed.
 *
 * `approval_url` is where a human goes to accept: the provider's checkout URL,
 * or the deployment's own approval surface for the `internal` provider. A
 * refusal without one is a dead end, so it is required rather than optional.
 */
export function agreementRequired(
  details: AgreementRequiredDetails,
  message?: string,
): MeshError {
  return new MeshError(
    ErrorCode.AGREEMENT_REQUIRED,
    message ??
      `Refused at admission: '${details.sku}' is a paid offering and this account holds no ` +
        `agreement for its current terms (§19.5). Approve at ${details.approval_url}`,
    { retryable: false, details: { ...details } },
  );
}
