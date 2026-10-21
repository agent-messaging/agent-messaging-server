// The Task record's `origin` and `canceled_by` (conformance/task-origin.json):
// the fixture's shapes read back whole through the SDK's strict readers, and
// anything short of the shape read as no origin at all.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src to agree with the fixture.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { taskOriginOf, taskCanceledByOf, taskContestsOf, type TaskOrigin, type TaskCanceledBy } from "../../src/types/task.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../../../conformance/task-origin.json"), "utf8")) as {
  fields: {
    origin: { required: string[]; optional: string[]; bound_by: Record<string, string> };
    canceled_by: {
      required: string[];
      optional: string[];
      party: Record<string, string>;
      requester_request: { required: string[]; via: Record<string, string> };
      unverified: { required: string[]; optional: string[]; absent: string[]; unverified_reason: Record<string, string> };
    };
    record_contested_by: { optional: string[]; origin_mismatch: { required: string[] } };
  };
  shapes: Record<string, unknown>;
};

describe("origin", () => {
  const shape = fixture.shapes.origin as TaskOrigin;

  it("reads the fixture's shape back whole", () => {
    expect(taskOriginOf({ origin: shape })).toEqual(shape);
    expect(Object.keys(shape).sort()).toEqual([...fixture.fields.origin.required].sort());
  });

  it("knows exactly the fixture's bound_by values", () => {
    for (const v of Object.keys(fixture.fields.origin.bound_by)) {
      expect(taskOriginOf({ origin: { ...shape, bound_by: v } })?.bound_by).toBe(v);
    }
    expect(taskOriginOf({ origin: { ...shape, bound_by: "claimed" } })).toBeNull();
  });

  it("reads a record without one, or with any required field missing, as none", () => {
    expect(taskOriginOf({})).toBeNull();
    expect(taskOriginOf(null)).toBeNull();
    for (const f of fixture.fields.origin.required) {
      const partial: Record<string, unknown> = { ...shape };
      delete partial[f];
      expect(taskOriginOf({ origin: partial })).toBeNull();
    }
  });

  it("reads the contested shape back whole, and refuses a malformed contest list", () => {
    const contested = fixture.shapes.origin_contested as TaskOrigin;
    expect(taskOriginOf({ origin: contested })).toEqual(contested);
    for (const k of Object.keys(contested)) {
      expect([...fixture.fields.origin.required, ...fixture.fields.origin.optional]).toContain(k);
    }
    // A malformed contest field is dropped on its own; the origin stands.
    expect(taskOriginOf({ origin: { ...shape, contested_by: "r2" } })).toEqual(shape);
    expect(taskOriginOf({ origin: { ...shape, contested_by: [""] } })).toEqual(shape);
    expect(taskOriginOf({ origin: { ...shape, contested_overflow: -1 } })).toEqual(shape);
    expect(taskOriginOf({ origin: { ...shape, contested_overflow_since: "not a time" } })).toEqual(shape);
    expect(taskOriginOf({ origin: { ...shape, contested_by: ["r2"], contested_overflow: -1 } })).toEqual({ ...shape, contested_by: ["r2"] });
    expect(taskOriginOf({ origin: { ...shape, contested_overflow: 1, contested_overflow_since: "2026-10-20T09:00:00.000Z" } })).toEqual({
      ...shape, contested_overflow: 1, contested_overflow_since: "2026-10-20T09:00:00.000Z",
    });
    expect(taskOriginOf({ origin: { ...shape, contested_by: ["r2"], contested_overflow: 3 } })).toEqual({
      ...shape, contested_by: ["r2"], contested_overflow: 3,
    });
  });

  it("keeps nothing beyond the shape", () => {
    expect(taskOriginOf({ origin: { ...shape, extra: 1 } })).toEqual(shape);
  });
});

describe("canceled_by", () => {
  const cases = ["canceled_by_requester", "canceled_by_responder_unasked", "canceled_by_responder_after_cancel_request"];

  for (const name of cases) {
    it(`reads ${name} back whole`, () => {
      const shape = fixture.shapes[name] as TaskCanceledBy;
      expect(taskCanceledByOf({ canceled_by: shape })).toEqual(shape);
      const f = fixture.fields.canceled_by;
      for (const k of f.required) expect(shape).toHaveProperty(k);
      for (const k of Object.keys(shape)) expect([...f.required, ...f.optional]).toContain(k);
      expect(Object.keys(fixture.fields.canceled_by.party)).toContain(shape.party);
      if (shape.requester_request) {
        expect(Object.keys(shape.requester_request).sort()).toEqual(
          [...fixture.fields.canceled_by.requester_request.required].sort(),
        );
        expect(Object.keys(fixture.fields.canceled_by.requester_request.via)).toContain(shape.requester_request.via);
      }
    });
  }

  it("refuses an unknown party or via, and a missing requester_request", () => {
    const shape = fixture.shapes.canceled_by_requester as TaskCanceledBy;
    expect(taskCanceledByOf({ canceled_by: { ...shape, party: "operator" } })).toBeNull();
    expect(taskCanceledByOf({ canceled_by: { ...shape, requester_request: { ...shape.requester_request, via: "said_so" } } })).toBeNull();
    const { requester_request: _omit, ...noRequest } = shape;
    expect(taskCanceledByOf({ canceled_by: noRequest })).toBeNull();
  });

  for (const name of ["canceled_by_unverified", "canceled_by_settling", "canceled_by_expired"]) {
    it(`reads ${name} back whole, with no requester_request`, () => {
      const shape = fixture.shapes[name] as TaskCanceledBy;
      const u = fixture.fields.canceled_by.unverified;
      expect(taskCanceledByOf({ canceled_by: shape })).toEqual(shape);
      for (const k of u.required) expect(shape).toHaveProperty(k);
      for (const k of Object.keys(shape)) expect([...u.required, ...u.optional]).toContain(k);
      for (const k of u.absent) expect(shape).not.toHaveProperty(k);
      expect(Object.keys(u.unverified_reason)).toContain(shape.unverified_reason);
    });
  }

  it("a verified null always carries resolved_at: the server never writes it at the transition", () => {
    const shape = fixture.shapes.canceled_by_responder_unasked as TaskCanceledBy;
    expect(shape.requester_request).toBeNull();
    expect(shape).toHaveProperty("resolved_at");
  });

  it("reads the settled shape back whole", () => {
    const shape = fixture.shapes.canceled_by_settled as TaskCanceledBy;
    expect(taskCanceledByOf({ canceled_by: shape })).toEqual(shape);
    const f = fixture.fields.canceled_by;
    expect(Object.keys(shape).sort()).toEqual([...f.required, ...f.optional].sort());
  });

  it("fails toward unknown: any unverified marker wins over a requester_request", () => {
    const { resolved_at: _r, ...unasked } = fixture.shapes.canceled_by_responder_unasked as TaskCanceledBy & { resolved_at?: string };
    const c = taskCanceledByOf({ canceled_by: { ...unasked, unverified: true, unverified_reason: "read_timed_out" } });
    expect(c).toEqual({ party: "responder", at: unasked.at, unverified: true, unverified_reason: "read_timed_out" });
    expect(c).not.toHaveProperty("requester_request");
    expect(taskCanceledByOf({ canceled_by: { ...unasked, unverified: "yes" } })).toMatchObject({ unverified: true });
    expect(taskCanceledByOf({ canceled_by: { ...unasked, unverified: true, unverified_reason: "disk_on_fire" } })).toMatchObject({
      unverified: true, unverified_reason: "disk_on_fire",
    });
    expect(taskCanceledByOf({ canceled_by: { ...unasked, unverified: false } })).toEqual(unasked);
  });
});

describe("record-level contests", () => {
  const shape = fixture.shapes.record_contests_mismatch as Record<string, unknown>;

  it("reads the fixture's mismatch shape back whole", () => {
    expect(taskContestsOf(shape)).toEqual(shape);
    for (const k of Object.keys(shape)) expect(fixture.fields.record_contested_by.optional).toContain(k);
    for (const k of fixture.fields.record_contested_by.origin_mismatch.required) {
      expect(shape.origin_mismatch).toHaveProperty(k);
    }
  });

  it("reads the overflow fields, and drops each malformed field on its own", () => {
    expect(taskContestsOf({ contested_by: ["a"], contested_overflow: 2, contested_overflow_since: "2026-10-20T09:00:00.000Z" })).toEqual({
      contested_by: ["a"], contested_overflow: 2, contested_overflow_since: "2026-10-20T09:00:00.000Z",
    });
    expect(taskContestsOf({ contested_by: [1], origin_mismatch: { requester: "U1" } })).toEqual({ origin_mismatch: { requester: "U1" } });
    expect(taskContestsOf({ contested_by: ["a"], origin_mismatch: { requester: "" } })).toEqual({ contested_by: ["a"] });
  });

  it("keeps each asker's list apart, and drops a malformed asker entry on its own", () => {
    expect(taskContestsOf({
      contested_by_asker: { U1: { contested_by: ["a"] }, U2: { contested_by: "bad" }, U3: { contested_by: ["b"], contested_overflow: 2 } },
    })).toEqual({ contested_by_asker: { U1: { contested_by: ["a"] }, U3: { contested_by: ["b"], contested_overflow: 2 } } });
  });

  it("reads the asker overflow, and drops a malformed one on its own", () => {
    expect(taskContestsOf({ askers_overflow: 3, askers_overflow_since: "2026-10-20T09:00:00.000Z" })).toEqual({
      askers_overflow: 3, askers_overflow_since: "2026-10-20T09:00:00.000Z",
    });
    expect(taskContestsOf({ askers_overflow: -1, contested_by: ["a"] })).toEqual({ contested_by: ["a"] });
  });

  it("is null for a record with none", () => {
    expect(taskContestsOf({})).toBeNull();
    expect(taskContestsOf(null)).toBeNull();
    expect(taskContestsOf({ contested_by: "x" })).toBeNull();
  });
});
