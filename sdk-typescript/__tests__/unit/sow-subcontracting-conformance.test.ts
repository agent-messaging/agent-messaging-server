// Agent SoW subcontracting (agentsow.com 0.18.0-draft §5.15), asserted
// against conformance/sow-subcontracting.json.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src/sow.ts to agree with the fixture — never the fixture to
// agree with the code (the fixture changes only with a spec change alongside).
// Cases are executed by ITERATING the fixture: a row added to the JSON runs
// here without this file changing.
//
// The load-bearing assertions are the flow-down VIOLATION SENTENCES (a
// provider refused a subcontract reads one message whichever SDK computed the
// chain, so the wording — and the order violations arrive in — is part of the
// fixture) and the canonical-bytes one: the clause sits INSIDE the signed
// bytes, so one byte of drift between the SDKs is a document that verifies in
// one and is worthless in the other.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SOW_SUBCONTRACTING_POSTURES,
  canonicalSowJSON,
  subcontractConformance,
  subcontractingOf,
  validateSowSubcontracting,
  type SowSubcontractingPosture,
} from "../../src/sow.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../conformance/sow-subcontracting.json"), "utf8"),
) as {
  postures: { all: SowSubcontractingPosture[]; grade: string };
  clause: {
    subcontractors_max: number;
    scope_chars_max: number;
    valid: unknown[];
    invalid: Array<{ case: string; subcontracting: unknown; why: string }>;
  };
  conformance: {
    cases: Array<{
      name: string;
      prime: unknown;
      sub: unknown;
      opts?: { prime_cap_remaining?: number; require_pins?: boolean };
      violations: string[];
    }>;
  };
  signing: { document: Record<string, unknown>; canonical: string };
};

// ── §5.15 the three postures, a closed set ──────────────────────────────────

describe("§5.15 postures — three, a closed set", () => {
  it("the posture set is exactly the fixture's", () => {
    expect([...SOW_SUBCONTRACTING_POSTURES]).toEqual(fixture.postures.all);
  });

  it("absence states nothing: a document without the clause yields null, never a posture", () => {
    expect(subcontractingOf({})).toBeNull();
    expect(subcontractingOf(null)).toBeNull();
    expect(subcontractingOf({ subcontracting: null })).toBeNull();
  });

  it("the accessor hands back the declared clause, unvalidated", () => {
    const clause = { posture: "disclosed", grade: "evidence" };
    expect(subcontractingOf({ subcontracting: clause })).toBe(clause);
  });
});

// ── §5.15 the clause shape ──────────────────────────────────────────────────

describe("§5.15 the clause — an entry names a party on the mesh, and nothing else", () => {
  for (const clause of fixture.clause.valid) {
    it(`a valid clause passes: ${JSON.stringify(clause).slice(0, 70)}`, () => {
      expect(() => validateSowSubcontracting(clause)).not.toThrow();
    });
  }

  for (const row of fixture.clause.invalid) {
    it(`${row.case} is refused — ${row.why}`, () => {
      expect(() => validateSowSubcontracting(row.subcontracting)).toThrow();
    });
  }
});

// ── §5.15 the flow-down comparison ──────────────────────────────────────────

describe("§5.15 flow-down — terms only narrow going down, computed", () => {
  for (const c of fixture.conformance.cases) {
    it(`${c.name} → ${c.violations.length === 0 ? "the chain narrows" : `${c.violations.length} violation(s)`}`, () => {
      // Array equality on the whole sentences, order included: a provider
      // reads one message whichever SDK computed the chain, so the wording
      // and the order are part of the fixture.
      expect(subcontractConformance(c.prime, c.sub, c.opts)).toEqual(c.violations);
    });
  }
});

// ── §5.15 inside the signed bytes ───────────────────────────────────────────

describe("§5.15 signing — the bytes the Rust SDK must reproduce", () => {
  it("canonicalizes to the fixture's bytes, clause included", () => {
    expect(canonicalSowJSON(fixture.signing.document)).toBe(fixture.signing.canonical);
    // The clause is INSIDE the signed bytes, not laid over them.
    expect(fixture.signing.canonical).toContain('"subcontracting"');
  });
});
