// Agent SoW disputes (agentsow.com 0.15.0-draft §5.10) and the arbiter's
// verdict (agentroles.ai/arbiter.html §4), asserted against
// conformance/sow-disputes.json.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src/sow.ts to agree with the fixture — never the fixture to
// agree with the code (the fixture changes only with a spec change alongside).
// Cases are executed by ITERATING the fixture: a row added to the JSON runs
// here without this file changing.
//
// The load-bearing assertions are the exact-sum boundary rows (both off-by-one
// directions), the clause-side expectation check, and the signing ones: the
// clause sits INSIDE the engagement's signed bytes, and the verdict is its own
// signed document under its own tag — one byte of canonical drift between the
// SDKs is a verdict that moves money in one and is worthless in the other.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ARBITER_VERDICT_SIG_PREFIX,
  ROLE_ARBITER,
  SOW_ARBITER_FEES,
  SOW_DISPUTES_POSTURES,
  arbiterVerdictSignedBytes,
  canonicalSowJSON,
  disputesOf,
  signArbiterVerdict,
  validateArbiterVerdict,
  validateSowDisputes,
  verifyArbiterVerdictSignature,
  type ArbiterVerdictExpectation,
  type SowArbiterVerdictSignature,
} from "../../src/sow.js";
import { keyPairFromSeed } from "../../src/internal/identity.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../conformance/sow-disputes.json"), "utf8"),
) as {
  identities: { sender_seed: string; sender: string; recipient: string };
  postures: { all: string[]; fees: string[]; role: string; grade: string };
  clause: {
    valid: unknown[];
    invalid: Array<{ case: string; disputes: unknown; why: string }>;
  };
  verdict: {
    valid: Array<{ name: string; verdict: unknown; expected?: ArbiterVerdictExpectation }>;
    invalid: Array<{
      case: string;
      verdict: unknown;
      expected?: ArbiterVerdictExpectation;
      why: string;
    }>;
  };
  signing: {
    verdict_signed_bytes_prefix: string;
    document: Record<string, unknown>;
    canonical: string;
    verdict: Record<string, unknown> & { signatures: SowArbiterVerdictSignature[] };
    verdict_canonical: string;
    tamper: { fields: string[] };
  };
};

// ── §5.10 the closed sets ───────────────────────────────────────────────────

describe("§5.10 postures — exactly one, from a closed set", () => {
  it("the posture set is exactly the fixture's, in the fixture's order", () => {
    expect([...SOW_DISPUTES_POSTURES]).toEqual(fixture.postures.all);
  });

  it("the fee set is exactly the fixture's", () => {
    expect([...SOW_ARBITER_FEES]).toEqual(fixture.postures.fees);
  });

  it("the standard role name is the fixture's — a name offered, not a pin", () => {
    expect(ROLE_ARBITER).toBe(fixture.postures.role);
  });

  it("an absent clause has NO default posture: absent means the document has not said", () => {
    expect(disputesOf({})).toBeNull();
    expect(disputesOf({ disputes: null })).toBeNull();
    expect(disputesOf(undefined)).toBeNull();
  });
});

// ── §5.10 the clause shape ──────────────────────────────────────────────────

describe("§5.10 the clause — the arbiter binding required where it names the forum", () => {
  for (const clause of fixture.clause.valid) {
    it(`a valid clause passes: ${JSON.stringify(clause).slice(0, 70)}`, () => {
      expect(() => validateSowDisputes(clause)).not.toThrow();
      // The accessor hands back what a document carrying it declares.
      expect(disputesOf({ disputes: clause })).toEqual(clause);
    });
  }

  for (const row of fixture.clause.invalid) {
    it(`${row.case} is refused — ${row.why}`, () => {
      expect(() => validateSowDisputes(row.disputes)).toThrow();
    });
  }
});

// ── arbiter.html §4 the verdict ─────────────────────────────────────────────

describe("arbiter.html §4 the verdict — the split sums exactly, or it is not a verdict", () => {
  for (const row of fixture.verdict.valid) {
    it(`${row.name}`, () => {
      expect(() => validateArbiterVerdict(row.verdict, row.expected)).not.toThrow();
      // A verdict valid against an expectation is valid on its own shape too.
      expect(() => validateArbiterVerdict(row.verdict)).not.toThrow();
    });
  }

  for (const row of fixture.verdict.invalid) {
    it(`${row.case} is refused — ${row.why}`, () => {
      expect(() => validateArbiterVerdict(row.verdict, row.expected)).toThrow();
    });
  }
});

// ── the two byte contracts ──────────────────────────────────────────────────

describe("signing — the clause inside the engagement's bytes, the verdict under its own tag", () => {
  it("the verdict prefix is the fixture's", () => {
    expect(ARBITER_VERDICT_SIG_PREFIX).toBe(fixture.signing.verdict_signed_bytes_prefix);
  });

  it("a document carrying an arbiter clause canonicalizes to the fixture's bytes", () => {
    expect(canonicalSowJSON(fixture.signing.document)).toBe(fixture.signing.canonical);
    expect(fixture.signing.canonical).toContain('"disputes"');
  });

  it("the verdict canonicalizes to the fixture's bytes, signatures removed", () => {
    expect(canonicalSowJSON(fixture.signing.verdict)).toBe(fixture.signing.verdict_canonical);
    const bytes = arbiterVerdictSignedBytes(fixture.signing.verdict);
    expect(new TextDecoder().decode(bytes)).toBe(
      ARBITER_VERDICT_SIG_PREFIX + fixture.signing.verdict_canonical,
    );
  });

  it("the really-signed verdict verifies, and re-signing reproduces the pinned signature", () => {
    const sig = fixture.signing.verdict.signatures[0];
    expect(verifyArbiterVerdictSignature(fixture.signing.verdict, sig)).toBe(true);
    expect(sig.key).toBe(fixture.identities.sender);
    // Ed25519 is deterministic: signing the same bytes with the published
    // seed must reproduce the pinned base64url signature exactly.
    const kp = keyPairFromSeed(fixture.identities.sender_seed);
    const { signatures: _omit, ...unsigned } = fixture.signing.verdict;
    const resigned = signArbiterVerdict(unsigned, kp, sig.signed_at);
    expect(resigned.signatures[0]).toEqual(sig);
    // And the signed verdict is a valid verdict.
    expect(() => validateArbiterVerdict(fixture.signing.verdict)).not.toThrow();
  });

  for (const path of fixture.signing.tamper.fields) {
    it(`tampering with ${path} breaks the signature — no re-signing, no repair`, () => {
      const doc = JSON.parse(JSON.stringify(fixture.signing.verdict)) as typeof fixture.signing.verdict;
      const parts = path.split(".");
      let cursor: Record<string, unknown> = doc;
      for (const p of parts.slice(0, -1)) cursor = cursor[p] as Record<string, unknown>;
      const leaf = parts[parts.length - 1];
      const prior = cursor[leaf];
      cursor[leaf] = typeof prior === "number" ? prior + 1 : `${prior}x`;
      expect(verifyArbiterVerdictSignature(doc, doc.signatures[0])).toBe(false);
    });
  }
});
