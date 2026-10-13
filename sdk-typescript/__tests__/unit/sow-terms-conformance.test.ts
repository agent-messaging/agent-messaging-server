// Agent SoW liability and service floors (agentsow.com 0.16.0-draft §5.13,
// §5.14), asserted against conformance/sow-terms.json.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src/sow.ts to agree with the fixture — never the fixture to
// agree with the code (the fixture changes only with a spec change alongside).
// Cases are executed by ITERATING the fixture: a row added to the JSON runs
// here without this file changing.
//
// The load-bearing assertion is the canonical-bytes one: both clauses sit
// INSIDE the signed bytes, so one byte of drift between the SDKs is a
// document that verifies in one and is worthless in the other.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SOW_FLOOR_REMEDIES,
  canonicalSowJSON,
  liabilityOf,
  serviceFloorsOf,
  validateSowLiability,
  validateSowServiceFloors,
} from "../../src/sow.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../conformance/sow-terms.json"), "utf8"),
) as {
  liability: {
    valid: unknown[];
    invalid: Array<{ case: string; liability: unknown; why: string }>;
  };
  service_floors: {
    remedies: string[];
    valid: unknown[];
    invalid: Array<{ case: string; service_floors: unknown; why: string }>;
  };
  signing: { document: Record<string, unknown>; canonical: string };
};

// ── §5.13 the liability clause ──────────────────────────────────────────────

describe("§5.13 liability — the cap is mutual, one form, and courts enforce it", () => {
  for (const clause of fixture.liability.valid) {
    it(`a valid clause passes: ${JSON.stringify(clause).slice(0, 70)}`, () => {
      expect(() => validateSowLiability(clause)).not.toThrow();
    });
  }

  for (const row of fixture.liability.invalid) {
    it(`${row.case} is refused — ${row.why.slice(0, 90)}`, () => {
      expect(() => validateSowLiability(row.liability)).toThrow();
    });
  }
});

// ── §5.14 the service floors clause ─────────────────────────────────────────

describe("§5.14 service floors — a floor without a consequence is decoration", () => {
  it("the remedy set is closed, with the fixture's one member", () => {
    expect([...SOW_FLOOR_REMEDIES]).toEqual(fixture.service_floors.remedies);
  });

  for (const clause of fixture.service_floors.valid) {
    it(`a valid clause passes: ${JSON.stringify(clause).slice(0, 70)}`, () => {
      expect(() => validateSowServiceFloors(clause)).not.toThrow();
    });
  }

  for (const row of fixture.service_floors.invalid) {
    it(`${row.case} is refused — ${row.why.slice(0, 90)}`, () => {
      expect(() => validateSowServiceFloors(row.service_floors)).toThrow();
    });
  }
});

// ── the accessors: absence states nothing ───────────────────────────────────

describe("liabilityOf / serviceFloorsOf — unvalidated reads, null for absence", () => {
  it("reads both clauses off the signing document, unvalidated", () => {
    const doc = fixture.signing.document;
    expect(liabilityOf(doc)).toBe((doc as { liability: unknown }).liability);
    expect(serviceFloorsOf(doc)).toBe((doc as { service_floors: unknown }).service_floors);
  });

  it("absence states nothing: null, never a synthesized default", () => {
    expect(liabilityOf({})).toBeNull();
    expect(serviceFloorsOf({})).toBeNull();
    expect(liabilityOf(null)).toBeNull();
    expect(serviceFloorsOf(undefined)).toBeNull();
    // A clause in a non-object shape is not a clause this reader hands back.
    expect(liabilityOf({ liability: "capped" })).toBeNull();
    expect(serviceFloorsOf({ service_floors: ["fast"] })).toBeNull();
  });
});

// ── §5.13 + §5.14 inside the signed bytes ───────────────────────────────────

describe("signing — the bytes the Rust SDK must reproduce", () => {
  it("canonicalizes to the fixture's bytes, both clauses included", () => {
    expect(canonicalSowJSON(fixture.signing.document)).toBe(fixture.signing.canonical);
    expect(fixture.signing.canonical).toContain('"liability"');
    expect(fixture.signing.canonical).toContain('"service_floors"');
  });

  it("the signing document's clauses validate", () => {
    expect(() => validateSowLiability(liabilityOf(fixture.signing.document))).not.toThrow();
    expect(() => validateSowServiceFloors(serviceFloorsOf(fixture.signing.document))).not.toThrow();
  });
});
