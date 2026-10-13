// Agent SoW reporting (agentsow.com 0.13.0-draft §5.12), asserted against
// conformance/sow-reporting.json.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src/sow.ts to agree with the fixture — never the fixture to
// agree with the code (the fixture changes only with a spec change alongside).
// Cases are executed by ITERATING the fixture: a row added to the JSON runs
// here without this file changing.
//
// The load-bearing assertions are the shortfall SENTENCES (a responder reads
// one message whichever SDK evaluated it, so the wording is part of the
// fixture) and the canonical-bytes one: the clause sits INSIDE the signed
// bytes, so one byte of drift between the SDKs is a document that verifies in
// one and is worthless in the other.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DEFAULT_REPORTING_LEVEL,
  SOW_REPORTING_GRADE,
  SOW_REPORTING_LEVELS,
  canonicalSowJSON,
  meetsReportingLevel,
  reportingCadenceWarning,
  reportingEveryMs,
  reportingLevelRank,
  reportingShortfall,
  validateSowReporting,
  type SowReporting,
  type SowReportingLevel,
} from "../../src/sow.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../conformance/sow-reporting.json"), "utf8"),
) as {
  levels: {
    all: SowReportingLevel[];
    rank: Record<SowReportingLevel, number>;
    default: SowReportingLevel;
    grade: string;
  };
  meets: {
    cases: Array<{ offered: SowReportingLevel; required: SowReportingLevel; meets: boolean }>;
  };
  clause: {
    valid: unknown[];
    invalid: Array<{ case: string; reporting: unknown; why: string }>;
  };
  every: {
    valid: Array<{ value: string; ms: number }>;
    invalid: Array<{ value: string; why: string }>;
  };
  shortfall: {
    cases: Array<{
      name: string;
      required: SowReportingLevel;
      document: unknown;
      expected: string | null;
    }>;
  };
  cadence_warning: {
    cases: Array<{
      name: string;
      reporting: SowReporting;
      cap_remaining: number;
      spend_per_day: number;
      warns: boolean;
    }>;
  };
  signing: { document: Record<string, unknown>; canonical: string };
};

// ── §5.12 the three levels, ordered ─────────────────────────────────────────

describe("§5.12 levels — three, ordered, and the order is the point", () => {
  it("the ordered set is exactly the fixture's", () => {
    expect([...SOW_REPORTING_LEVELS]).toEqual(fixture.levels.all);
  });

  for (const [level, rank] of Object.entries(fixture.levels.rank)) {
    it(`${level} ranks ${rank} — derived from the string, never declared`, () => {
      expect(reportingLevelRank(level as SowReportingLevel)).toBe(rank);
    });
  }

  it("an absent clause offers the default, and absent is NOT unknown", () => {
    expect(DEFAULT_REPORTING_LEVEL).toBe(fixture.levels.default);
  });

  it("the clause is graded flatly, and the grade is the fixture's", () => {
    expect(SOW_REPORTING_GRADE).toBe(fixture.levels.grade);
  });
});

// ── §5.12 meets or exceeds, never equals ────────────────────────────────────

describe("§5.12 the comparison — meets or exceeds, never equals", () => {
  for (const c of fixture.meets.cases) {
    it(`${c.offered} against a requirement of ${c.required}: ${c.meets ? "meets" : "does not meet"}`, () => {
      expect(meetsReportingLevel(c.offered, c.required)).toBe(c.meets);
    });
  }
});

// ── §5.12 the clause shape ──────────────────────────────────────────────────

describe("§5.12 the clause — check_ins is the level with a calendar", () => {
  for (const clause of fixture.clause.valid) {
    it(`a valid clause passes: ${JSON.stringify(clause).slice(0, 70)}`, () => {
      expect(() => validateSowReporting(clause)).not.toThrow();
    });
  }

  for (const row of fixture.clause.invalid) {
    it(`${row.case} is refused — ${row.why}`, () => {
      expect(() => validateSowReporting(row.reporting)).toThrow();
    });
  }
});

// ── §5.12 the cadence grammar ───────────────────────────────────────────────

describe("§5.12 every — the restricted ISO 8601 grammar, with pinned milliseconds", () => {
  for (const row of fixture.every.valid) {
    it(`${row.value} is ${row.ms} ms, and there is no other answer`, () => {
      expect(reportingEveryMs(row.value)).toBe(row.ms);
    });
  }

  for (const row of fixture.every.invalid) {
    it(`${JSON.stringify(row.value)} is refused — ${row.why}`, () => {
      expect(() => reportingEveryMs(row.value)).toThrow();
    });
  }
});

// ── §5.12 the advisory shortfall ────────────────────────────────────────────

describe("§5.12 shortfall — the sentence a mandate shows, pinned to the byte", () => {
  for (const c of fixture.shortfall.cases) {
    it(`${c.name} → ${c.expected === null ? "meets" : "a shortfall"}`, () => {
      // String equality on the whole sentence: a responder reads one message
      // whichever SDK evaluated it, so the wording is part of the fixture.
      expect(reportingShortfall(c.required, c.document)).toBe(c.expected);
    });
  }
});

// ── §5.12 cadence follows the money ─────────────────────────────────────────

describe("§5.12 cadence warning — a runtime MAY warn and MUST NOT refuse", () => {
  for (const c of fixture.cadence_warning.cases) {
    it(`${c.name} → ${c.warns ? "warns" : "no warning"}`, () => {
      const warning = reportingCadenceWarning(c.reporting, c.cap_remaining, c.spend_per_day);
      // Only the boolean is pinned; the sentence is advisory prose, not
      // protocol, so its exact wording is the implementation's own.
      if (c.warns) {
        expect(warning).not.toBeNull();
        expect(typeof warning).toBe("string");
      } else {
        expect(warning).toBeNull();
      }
    });
  }
});

// ── §5.12 inside the signed bytes ───────────────────────────────────────────

describe("§5.12 signing — the bytes the Rust SDK must reproduce", () => {
  it("canonicalizes to the fixture's bytes, clause included", () => {
    expect(canonicalSowJSON(fixture.signing.document)).toBe(fixture.signing.canonical);
    // The clause is INSIDE the signed bytes, not laid over them.
    expect(fixture.signing.canonical).toContain('"reporting"');
  });
});
