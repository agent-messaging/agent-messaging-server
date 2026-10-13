import { describe, expect, it } from "vitest";
import {
  EVAL_RECORD_MAX_BYTES,
  evalRecordDigest,
  validateEvalRecord,
} from "../../src/registry/eval-record-store.js";
import { canonicalJSON, nkeys } from "../../src/sdk.js";

// A synthetic evaluator signing a record in the exact shape eval-run.py
// produces. The validate gate is pure, so no broker is needed; the signing
// here mirrors eval-run.py's TAG + "\n" + canonical(doc minus signatures).
const evaluator = nkeys.createUser();
const EVALUATOR = evaluator.getPublicKey();
const SUBJECT = "UDQSJEYPO7XZI3L2A233DXNI7OXUOAU43GJB7ITZRAWTRG5NJATRTQS5";

function record(mutate?: (doc: Record<string, unknown>) => void): Uint8Array {
  const doc: Record<string, unknown> = {
    record: "v1",
    role: "agent-evaluator",
    act: "evaluate",
    subject: { agent_key: SUBJECT, handle: "someagent.example@example.com" },
    package: { name: "questionnaire-responder", tree_sha256: "0".repeat(64) },
    cases: [],
    summary: { pass: 1, fail: 0, inconclusive: 0, flagged_for_review: 0 },
    conforms: true,
    produced_at: "2026-08-31T00:00:00Z",
    by: EVALUATOR,
    signatures: [],
  };
  const { signatures: _s, ...body } = doc;
  const message = `agent-eval-record-v1\n${canonicalJSON(body)}`;
  const sig = Buffer.from(evaluator.sign(new TextEncoder().encode(message))).toString("base64");
  doc.signatures = [{ tag: "agent-eval-record-v1", by: EVALUATOR, sig, alg: "ed25519" }];
  mutate?.(doc);
  return new TextEncoder().encode(JSON.stringify(doc));
}

describe("validateEvalRecord", () => {
  it("accepts a signed record from the evaluator's own key, keyed by its subject", () => {
    expect(validateEvalRecord(record(), EVALUATOR)).toEqual({ ok: true, subject: SUBJECT });
  });

  it("refuses a submission from a key other than the signer — sender is the evaluator, never the subject", () => {
    const out = validateEvalRecord(record(), SUBJECT);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/own key/);
  });

  it("refuses an UNSIGNED record: a verdict about a third party needs its signature", () => {
    const out = validateEvalRecord(record((d) => delete d.signatures), EVALUATOR);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/signatures/);
  });

  it("refuses a tampered record whose signature no longer verifies", () => {
    const out = validateEvalRecord(record((d) => (d.conforms = false)), EVALUATOR);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/signature/);
  });

  it("refuses a record that names no subject", () => {
    const out = validateEvalRecord(record((d) => delete d.subject), EVALUATOR);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/agent_key/);
  });

  it("refuses an oversized document", () => {
    const big = new TextEncoder().encode(JSON.stringify({ pad: "x".repeat(EVAL_RECORD_MAX_BYTES) }));
    const out = validateEvalRecord(big, EVALUATOR);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/bytes/);
  });

  it("refuses bytes that are not JSON", () => {
    const out = validateEvalRecord(new TextEncoder().encode("not json"), EVALUATOR);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/JSON/);
  });

  it("digests over the exact bytes", () => {
    const bytes = record();
    expect(evalRecordDigest(bytes)).toMatch(/^[0-9a-f]{64}$/);
    expect(evalRecordDigest(bytes)).not.toBe(evalRecordDigest(record((d) => (d.conforms = false))));
  });
});
