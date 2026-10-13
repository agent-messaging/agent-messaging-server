// §8.12 at the registry boundary: the listing-model declarations validated on
// the way in and stamped on the way out.
//
// The registry validates these even though the catalog also does, and the
// reason is the whole point of this file: the storefront is the ONLY path a
// crawling directory has. A field that does not survive materialization here
// is invisible to everyone outside this mesh, and a foreign mesh's sloppy
// declaration must not become a filterable claim anywhere.

import { describe, it, expect } from "vitest";
import {
  readableAudience,
  readableCoverage,
  readableEdge,
  readableServes,
  readableOrigin,
  readableActs,
  readableParties,
  withReadableListingModel,
  LISTING_MODEL_FIELDS,
} from "../../src/registry/listing-model.js";
import type { Manifest } from "../../src/sdk.js";

const base = { id: "UA", name: "A", description: "d", version: "1", protocol_version: "0.2" };
const asManifest = (over: Record<string, unknown>) => ({ ...base, ...over }) as unknown as Manifest;

describe("§8.12 audience", () => {
  it("reads both members, and keeps `none` as the declaration it is", () => {
    expect(readableAudience({ for: "teachers", touches: "students" })).toEqual({
      for: "teachers",
      touches: "students",
    });
    // "Speaks to nobody but its operator" and "never said" are different
    // facts, and only the first is an answer.
    expect(readableAudience({ touches: "none" })).toEqual({ touches: "none" });
  });

  it("drops per member, not whole", () => {
    // Unlike data_use, where one bad member poisons the declaration because a
    // surviving privacy promise flatters the operator. Nothing here flatters.
    expect(readableAudience({ for: "teachers", touches: 42 })).toEqual({ for: "teachers" });
    expect(readableAudience({})).toBeNull();
    expect(readableAudience("teachers")).toBeNull();
  });
});

describe("§8.12 coverage", () => {
  it("poisons a list rather than shortening it", () => {
    // A silently shortened coverage list UNDERSTATES a boundary, and
    // understating a boundary is the direction that gets somebody a wrong
    // answer from an agent outside its competence.
    expect(readableCoverage({ geography: ["us", 7], language: ["en"] })).toEqual({ language: ["en"] });
  });

  it("is not processed_in", () => {
    const c = readableCoverage({ jurisdiction: ["us-ny"] })!;
    expect(c).not.toHaveProperty("processed_in");
  });
});

describe("§8.12 edge and serves", () => {
  it("never resolves an unreadable edge to declines", () => {
    // A typo must not manufacture a refusal promise.
    expect(readableEdge("declines")).toBe("declines");
    expect(readableEdge("answers")).toBe("answers");
    for (const bad of ["decline", "DECLINES", "refuses", true, null, {}]) {
      expect(readableEdge(bad)).toBeNull();
    }
  });

  it("reads the three serves tokens only", () => {
    expect(readableServes("owner")).toBe("owner");
    expect(readableServes("buyer")).toBeNull();
  });
});

describe("§8.12 origin", () => {
  it("keeps known coordinates and drops unknown tokens", () => {
    // The registry differs from the catalog here on purpose: the catalog
    // keeps an unknown token for display, but this is the document a stranger
    // will FILTER on, so a value nobody can act on does not travel.
    expect(readableOrigin({ written_by: "vendor", run_by: "consortium" })).toEqual({
      written_by: "vendor",
    });
    expect(readableOrigin({ run_by: "consortium" })).toBeNull();
  });
});

describe("§8.12 acts", () => {
  it("drops WHOLE when the mode is unreadable", () => {
    // Actions with no statement of whether the agent acts at all is not a
    // weaker claim, it is an incoherent one. The one whole-drop in this file.
    expect(readableActs({ actions: [{ action: "closes tickets" }] })).toBeNull();
    expect(readableActs({ mode: "write" })).toBeNull();
  });

  it("keeps approval only as a real boolean", () => {
    // A truthy string would silently promise a safeguard nobody declared.
    const out = readableActs({ mode: "act", actions: [{ action: "x", approval: "yes" }] })!;
    expect((out.actions as Array<Record<string, unknown>>)[0]).toEqual({ action: "x" });
  });

  it("lets the mode win over contradicting actions", () => {
    expect(readableActs({ mode: "read", actions: [{ action: "closes tickets" }] })).toEqual({
      mode: "read",
    });
  });
});

describe("§8.12 parties", () => {
  it("needs both a name and a known role", () => {
    // A company with no role says somebody is involved without saying how,
    // which is the half a reader needs. A role with no company says nothing.
    expect(readableParties([{ name: "Salesforce" }])).toBeNull();
    expect(readableParties([{ role: "platform" }])).toBeNull();
    expect(readableParties([{ name: "Acme", role: "reseller" }])).toBeNull();
    expect(readableParties([{ name: "Salesforce", role: "platform" }])).toEqual([
      { name: "Salesforce", role: "platform" },
    ]);
  });
});

describe("the manifest scrub", () => {
  it("hands back the SAME OBJECT when nothing changes", () => {
    // The manifest watch compares by identity, so returning a fresh object
    // unconditionally would make every read look like an update.
    const clean = asManifest({ audience: { for: "teachers" }, edge: "declines" });
    expect(withReadableListingModel(clean)).toBe(clean);
    const bare = asManifest({});
    expect(withReadableListingModel(bare)).toBe(bare);
  });

  it("removes an unreadable member and leaves its neighbours standing", () => {
    const m = asManifest({
      audience: { for: "teachers" },
      edge: "sometimes",
      serves: "hirer",
    });
    const out = withReadableListingModel(m) as unknown as Record<string, unknown>;
    expect(out.edge).toBeUndefined();
    expect(out.audience).toEqual({ for: "teachers" });
    expect(out.serves).toBe("hirer");
  });

  it("normalizes rather than passing extra members through", () => {
    const m = asManifest({ audience: { for: "teachers", nonsense: true } });
    const out = withReadableListingModel(m) as unknown as Record<string, unknown>;
    expect(out.audience).toEqual({ for: "teachers" });
  });

  it("covers every field the storefront stamp will read", () => {
    // The scrub and the read-time stamp share this table so they cannot fall
    // out of step by somebody adding a field to one and forgetting the other.
    expect(Object.keys(LISTING_MODEL_FIELDS).sort()).toEqual([
      "acts", "audience", "coverage", "edge", "origin", "parties", "serves",
    ]);
  });
});
