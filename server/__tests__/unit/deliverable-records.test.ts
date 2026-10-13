// EXT-9 records, against the cross-surface fixture.
//
// This side decides which files a dossier keeps the BYTES of. `app/src/files.ts`
// decides what a room's files panel shows under Accepted. They live in different
// build targets with no shared module, so nothing but the fixture stops them
// drifting — and a file the panel calls Accepted while the dossier calls it
// interim would mean the thing on screen is not the thing that was kept.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { recognizeRecord, roleOf } from "../../src/rooms/dossier.js";

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../conformance/deliverable-records.json"), "utf8"),
) as {
  recognition: { cases: Array<{ name: string; body: string; expected: Record<string, unknown> }> };
  roles: {
    cases: Array<{
      name: string;
      record: string[];
      files: Array<{ ref: string; name: string; version: string }>;
      expected: Record<string, string>;
      expected_claimed_as?: Record<string, string>;
    }>;
  };
};

describe("EXT-9 recognition", () => {
  for (const c of fixture.recognition.cases) {
    it(c.name, () => {
      const got = recognizeRecord(c.body);
      if (c.expected.record === null) {
        expect(got).toBeNull();
        return;
      }
      expect(got).not.toBeNull();
      // Only the keys the fixture states, so a case can pin what it cares about
      // without every case having to spell out every field.
      for (const [k, v] of Object.entries(c.expected)) {
        expect({ key: k, value: (got as Record<string, unknown>)[k] }).toEqual({ key: k, value: v });
      }
    });
  }

  it("the fixture exercises every record type and the not-a-record cases", () => {
    // A fixture whose cases all pass because they all parse would pin nothing
    // about the half that matters: what must NOT be recognized.
    const kinds = new Set(fixture.recognition.cases.map((c) => c.expected.record));
    expect(kinds).toEqual(new Set(["DELIVERABLE", "ACCEPTED", "REJECTED", null]));
  });
});

describe("EXT-9 roles", () => {
  for (const c of fixture.roles.cases) {
    it(c.name, () => {
      const record = c.record.map((body) => ({ type: "say", body }));
      const roles = roleOf(c.files, record);
      for (const [ref, role] of Object.entries(c.expected)) {
        expect({ ref, role: roles.get(ref) }).toEqual({ ref, role });
      }
    });
  }
});
