// What a statement rested on (§5.6), asserted against conformance/rests-on.json.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src/rests-on.ts to agree with the fixture — never the fixture
// to agree with the code (the fixture changes only with a spec change
// alongside). Cases are executed by ITERATING the fixture: a row added to the
// JSON runs here without this file changing.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DIGEST_RE,
  MAX_RESTS_ON,
  checkFreshness,
  describeFreshness,
  validateRestsOn,
  type Freshness,
  type RestsOnEntry,
} from "../../src/rests-on.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../conformance/rests-on.json"), "utf8"),
) as {
  digest: { valid: string[]; invalid: Array<{ value: string; why: string }> };
  entries: {
    max_entries: number;
    valid: RestsOnEntry[];
    invalid: Array<{ case: string; rests_on: unknown; why: string }>;
  };
  freshness: {
    cases: Array<{
      name: string;
      countersigned?: boolean;
      declared: RestsOnEntry[] | null;
      observed: Record<string, string | null>;
      expected: { state: Freshness; changed: string[]; unreachable: Array<string | null> };
      observe_must_not_be_called?: boolean;
    }>;
  };
  carriage: { sites: Array<{ where: string }>; not_sites: string[] };
};

describe("§5.6 digest spelling", () => {
  it("accepts every valid form", () => {
    expect(fixture.digest.valid.length).toBeGreaterThan(0);
    for (const d of fixture.digest.valid) expect(DIGEST_RE.test(d), d).toBe(true);
  });

  it("refuses every invalid form, including uppercase hex", () => {
    for (const { value, why } of fixture.digest.invalid) {
      expect(DIGEST_RE.test(value), `${JSON.stringify(value)}: ${why}`).toBe(false);
    }
  });
});

describe("§5.6 entry shapes", () => {
  it("the cap matches the fixture", () => {
    expect(MAX_RESTS_ON).toBe(fixture.entries.max_entries);
  });

  it("every valid entry validates, alone and together", () => {
    for (const e of fixture.entries.valid) {
      expect(() => validateRestsOn([e]), JSON.stringify(e)).not.toThrow();
    }
    expect(() => validateRestsOn(fixture.entries.valid)).not.toThrow();
  });

  it("every invalid list is refused", () => {
    expect(fixture.entries.invalid.length).toBeGreaterThan(0);
    for (const { case: name, rests_on, why } of fixture.entries.invalid) {
      expect(() => validateRestsOn(rests_on), `${name}: ${why}`).toThrow();
    }
  });

  it("refuses one entry past the cap", () => {
    const entry = fixture.entries.valid[0]!;
    const many = Array.from({ length: MAX_RESTS_ON + 1 }, (_, i) => ({
      ...entry,
      ref: `mesh:artifacts:${i}`,
    }));
    expect(() => validateRestsOn(many)).toThrow(/at most/);
    expect(() => validateRestsOn(many.slice(0, MAX_RESTS_ON))).not.toThrow();
  });
});

describe("§5.6 freshness", () => {
  for (const c of fixture.freshness.cases) {
    it(c.name, () => {
      const observe = vi.fn((entry: RestsOnEntry) =>
        entry.ref ? (c.observed[entry.ref] ?? null) : null,
      );
      const r = checkFreshness(c.declared, observe, { countersigned: c.countersigned });

      expect(r.state).toBe(c.expected.state);
      expect(r.changed.map((x) => x.entry.ref ?? null)).toEqual(c.expected.changed);
      expect(r.unreachable.map((e) => e.ref ?? null)).toEqual(c.expected.unreachable);

      // The agreement exclusion is not "we ignore the answer", it is "we do
      // not look". A verifier that resolved the refs anyway would be spending
      // requests to compute a verdict §5.6 says it must discard.
      if (c.observe_must_not_be_called) expect(observe).not.toHaveBeenCalled();
    });
  }

  it("a stale verdict never throws", () => {
    // A verdict is an input to somebody's decision. A module that threw on
    // stale would be making that decision for them.
    const declared: RestsOnEntry[] = [{ digest: `sha256:${"1".repeat(64)}`, ref: "a" }];
    expect(() => checkFreshness(declared, () => `sha256:${"9".repeat(64)}`)).not.toThrow();
  });

  it("undeclared is not fresh, and an empty list reads the same as absent", () => {
    // The failure this guards: a reader that treated "declared nothing" as
    // "nothing changed" would report a clean bill of health for a statement
    // that made no claim at all.
    expect(checkFreshness(undefined, () => null).state).toBe("undeclared");
    expect(checkFreshness(null, () => null).state).toBe("undeclared");
    expect(checkFreshness([], () => null).state).toBe("undeclared");
  });

  it("names the input that moved, so a reader is not sent hunting", () => {
    const declared: RestsOnEntry[] = [
      { digest: `sha256:${"1".repeat(64)}`, ref: "a", name: "invoices-q3.zip" },
    ];
    const line = describeFreshness(checkFreshness(declared, () => `sha256:${"9".repeat(64)}`));
    expect(line).toContain("invoices-q3.zip");
  });

  it("says a good signature is still good when it could not check", () => {
    const declared: RestsOnEntry[] = [{ digest: `sha256:${"1".repeat(64)}`, ref: "a" }];
    const line = describeFreshness(checkFreshness(declared, () => null));
    expect(line).toMatch(/signature is good/i);
  });
});

describe("§5.6 carriage", () => {
  it("the artifact site the fixture names is the one the type carries", () => {
    // Guards the boundary rather than the shape: the fixture lists where
    // rests_on may ride, and `envelope.rests_on` is deliberately not one of
    // them. A third site must not appear without a spec change.
    expect(fixture.carriage.sites.map((s) => s.where)).toContain("artifact.rests_on");
    expect(fixture.carriage.not_sites).toContain("envelope.rests_on");
  });
});
