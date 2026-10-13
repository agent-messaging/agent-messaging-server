// Agent SoW confidentiality and retention (agentsow.com 0.14.0-draft §5.11),
// asserted against conformance/sow-data-use.json.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src/sow.ts to agree with the fixture — never the fixture to
// agree with the code (the fixture changes only with a spec change alongside).
// Cases are executed by ITERATING the fixture: a row added to the JSON runs
// here without this file changing.
//
// The load-bearing assertions are the shortfall SENTENCES (a client reads one
// message whichever SDK evaluated it, so the wording is part of the fixture)
// and the canonical-bytes one: the clause sits INSIDE the signed bytes, so
// one byte of drift between the SDKs is a document that verifies in one and
// is worthless in the other.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SOW_CONFIDENTIALITY_PROMISES,
  canonicalSowJSON,
  confidentialityOf,
  confidentialityShortfall,
  validateSowConfidentiality,
  type SowConfidentialityRequirement,
} from "../../src/sow.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../conformance/sow-data-use.json"), "utf8"),
) as {
  promises: { all: string[] };
  clause: {
    valid: unknown[];
    invalid: Array<{ case: string; confidentiality: unknown; why: string }>;
  };
  shortfall: {
    cases: Array<{
      name: string;
      required: SowConfidentialityRequirement;
      document: unknown;
      expected: string | null;
    }>;
  };
  signing: { document: Record<string, unknown>; canonical: string };
};

// ── §5.11 the promise vocabulary ────────────────────────────────────────────

describe("§5.11 promises — a closed vocabulary, spelled only by presence", () => {
  it("the vocabulary is exactly the fixture's", () => {
    expect([...SOW_CONFIDENTIALITY_PROMISES]).toEqual(fixture.promises.all);
  });
});

// ── §5.11 the clause shape ──────────────────────────────────────────────────

describe("§5.11 the clause — sub-clauses graded separately, absence carrying the weak meaning", () => {
  for (const clause of fixture.clause.valid) {
    it(`a valid clause passes: ${JSON.stringify(clause).slice(0, 70)}`, () => {
      expect(() => validateSowConfidentiality(clause)).not.toThrow();
    });
  }

  for (const row of fixture.clause.invalid) {
    it(`${row.case} is refused — ${row.why}`, () => {
      expect(() => validateSowConfidentiality(row.confidentiality)).toThrow();
    });
  }
});

// ── §5.11 the accessor ──────────────────────────────────────────────────────

describe("§5.11 confidentialityOf — the unvalidated accessor", () => {
  it("returns the declared clause, unvalidated, or null where none is declared", () => {
    expect(confidentialityOf({})).toBeNull();
    expect(confidentialityOf({ confidentiality: null })).toBeNull();
    expect(confidentialityOf({ confidentiality: "sealed" })).toBeNull();
    const clause = fixture.signing.document.confidentiality;
    expect(confidentialityOf(fixture.signing.document)).toEqual(clause);
  });
});

// ── §5.11 the deterministic pre-admission comparison ────────────────────────

describe("§5.11 shortfall — the sentence the comparison shows, pinned to the byte", () => {
  for (const c of fixture.shortfall.cases) {
    it(`${c.name} → ${c.expected === null ? "meets" : "a shortfall"}`, () => {
      // String equality on the whole sentence: a client reads one message
      // whichever SDK evaluated it, so the wording is part of the fixture.
      expect(confidentialityShortfall(c.required, c.document)).toBe(c.expected);
    });
  }
});

// ── §5.11 inside the signed bytes ───────────────────────────────────────────

describe("§5.11 signing — the bytes the Rust SDK must reproduce", () => {
  it("canonicalizes to the fixture's bytes, clause included", () => {
    expect(canonicalSowJSON(fixture.signing.document)).toBe(fixture.signing.canonical);
    // The clause is INSIDE the signed bytes, not laid over them.
    expect(fixture.signing.canonical).toContain('"confidentiality"');
  });
});
