import { describe, it, expect } from "vitest";
import { uuid7 } from "../../src/internal/uuid.js";

describe("uuid7", () => {
  it("returns a valid UUID v7 string", () => {
    const id = uuid7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("produces unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuid7()));
    expect(ids.size).toBe(100);
  });

  it("is time-ordered (later IDs sort after earlier ones)", () => {
    const a = uuid7();
    const b = uuid7();
    // String comparison works for UUID v7 since timestamp is in the high bits
    expect(b >= a).toBe(true);
  });
});
