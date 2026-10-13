import { describe, it, expect } from "vitest";
import { isValidTransition, TERMINAL_STATES, VALID_TRANSITIONS } from "../../src/types/task.js";
import { RejectedError } from "../../src/types/errors.js";

describe("Task state machine — rejected (§7.2)", () => {
  it("rejected is a terminal state", () => {
    expect(TERMINAL_STATES.has("rejected")).toBe(true);
    expect(VALID_TRANSITIONS.rejected).toEqual([]);
  });

  it("allows submitted -> rejected (responder declines before processing)", () => {
    expect(isValidTransition("submitted", "rejected")).toBe(true);
  });

  it("does not allow working -> rejected (a decline mid-execution is failed, not rejected)", () => {
    expect(isValidTransition("working", "rejected")).toBe(false);
  });

  it("does not allow transitions out of rejected", () => {
    expect(isValidTransition("rejected", "working")).toBe(false);
    expect(isValidTransition("rejected", "completed")).toBe(false);
  });
});

describe("RejectedError", () => {
  it("is a named Error carrying the decline reason", () => {
    const e = new RejectedError("not my domain");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RejectedError");
    expect(e.message).toBe("not my domain");
  });

  it("defaults to a generic decline message", () => {
    expect(new RejectedError().message).toMatch(/rejected/i);
  });
});
