// Agreements (§19.5), asserted against conformance/commerce.json.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src/agreement.ts to agree with the fixture — never the
// fixture to agree with the code.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nkeys } from "nats.ws";
import {
  AGREEMENT_SIG_PREFIX,
  agreementCovers,
  agreementRequired,
  canonicalAgreementJSON,
  loadAgreement,
  signAgreement,
  validateAgreement,
  verifyAgreementSignature,
  type AgreementDocument,
} from "../../src/agreement.js";
import { ErrorCode } from "../../src/types/errors.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../conformance/commerce.json"), "utf8"),
) as {
  agreement: {
    signed_bytes_prefix: string;
    canonical: string;
    signed: AgreementDocument;
    invalid: Array<{ case: string; document: unknown | null; why: string }>;
    stale_digest_case: { holds_agreement_for: string; sku_current_digest: string; expect: string };
  };
  enforcement: {
    refusal: { error_code: string; details: { sku: string; sku_digest: string; approval_url: string } };
  };
  digest: { sku: { sku: string }; sku_digest: string };
};

describe("§19.5 the signed agreement", () => {
  const vec = fixture.agreement;

  it("reproduces the fixture's canonical bytes from the signed document", () => {
    expect(vec.signed_bytes_prefix).toBe(AGREEMENT_SIG_PREFIX);
    expect(canonicalAgreementJSON(vec.signed)).toBe(vec.canonical);
  });

  it("the fixture's vector verifies and loads", () => {
    expect(verifyAgreementSignature(vec.signed)).toBe(true);
    expect(() => loadAgreement(vec.signed)).not.toThrow();
  });

  it("one flipped byte of sku_digest fails verification — terms cannot be swapped", () => {
    const tampered = { ...vec.signed, sku_digest: `${vec.signed.sku_digest.slice(0, -1)}X` };
    expect(verifyAgreementSignature(tampered)).toBe(false);
    expect(() => loadAgreement(tampered)).toThrow(/IDENTITY_MISMATCH|does not verify/);
  });

  it("refuses the fixture's malformed shapes", () => {
    for (const row of vec.invalid) {
      if (row.document === null) continue; // prose-only rows (see the fixture's `why`)
      expect(() => validateAgreement(row.document), `${row.case}: ${row.why}`).toThrow();
    }
  });

  it("round-trips a freshly signed agreement, filling consumer_owner from the signer", () => {
    const kp = nkeys.createUser();
    const doc = signAgreement(
      {
        v: 1,
        seller_agent: fixture.agreement.signed.seller_agent,
        sku: "caselaw-metered",
        sku_digest: fixture.digest.sku_digest,
        agreed_at: "2026-08-02T15:00:00Z",
      },
      kp,
    );
    expect(doc.consumer_owner).toBe(kp.getPublicKey());
    expect(loadAgreement(doc)).toEqual(doc);
  });
});

describe("§19.5 the matching rule", () => {
  const vec = fixture.agreement.signed;
  const want = {
    consumerOwner: vec.consumer_owner,
    sellerAgent: vec.seller_agent,
    sku: vec.sku,
    skuDigest: vec.sku_digest,
  };

  it("covers the exact account, seller, sku and digest", () => {
    expect(agreementCovers(vec, want)).toBe(true);
  });

  it("a moved digest is a MISSING agreement — the fixture's stale case", () => {
    expect(fixture.agreement.stale_digest_case.holds_agreement_for).toBe(vec.sku_digest);
    expect(
      agreementCovers(vec, {
        ...want,
        skuDigest: fixture.agreement.stale_digest_case.sku_current_digest,
      }),
    ).toBe(false);
  });

  it("does not cover a different account, seller, or sku", () => {
    expect(agreementCovers(vec, { ...want, consumerOwner: "UOTHER" })).toBe(false);
    expect(agreementCovers(vec, { ...want, sellerAgent: "UOTHER" })).toBe(false);
    expect(agreementCovers(vec, { ...want, sku: "something-else" })).toBe(false);
  });

  it("an expired agreement covers nothing, and an undatable expiry reads as expired", () => {
    const expiring = { ...vec, expires_at: "2026-08-03T00:00:00Z" };
    expect(agreementCovers(expiring, { ...want, now: Date.parse("2026-08-02T23:59:00Z") })).toBe(true);
    expect(agreementCovers(expiring, { ...want, now: Date.parse("2026-08-03T00:00:01Z") })).toBe(false);
    expect(agreementCovers({ ...vec, expires_at: "not-a-time" } as AgreementDocument, want)).toBe(false);
  });
});

describe("§12.2 the AGREEMENT_REQUIRED refusal", () => {
  it("carries the fixture's detail field names", () => {
    const r = fixture.enforcement.refusal;
    const err = agreementRequired(r.details);
    expect(err.code).toBe(ErrorCode.AGREEMENT_REQUIRED);
    expect(err.code).toBe(r.error_code);
    expect(err.toErrorObject().details).toEqual(r.details);
    expect(err.toErrorObject().retryable).toBe(false);
  });

  it("names where to approve — a refusal a buyer cannot act on is a dead end", () => {
    const err = agreementRequired(fixture.enforcement.refusal.details);
    expect(err.message).toContain(fixture.enforcement.refusal.details.approval_url);
  });
});
