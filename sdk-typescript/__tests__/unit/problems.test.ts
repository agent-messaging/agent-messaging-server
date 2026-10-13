/**
 * Input problem reports (§6.5): the shape is validated loudly at the raising
 * end and read tolerantly at the receiving end, because a malformed report
 * should fail the author, never the reader.
 */
import { describe, it, expect } from "vitest";
import {
  INPUT_PROBLEM_CODES,
  InputProblemsError,
  checkInputProblem,
  inputProblemsOf,
} from "../../src/problems.js";
import type { Envelope } from "../../src/types/envelope.js";

const good = {
  input: "bank-statement",
  problem: "wrong_format" as const,
  description: "Arrived as .xlsx; the engagement names text/csv.",
  expected: "text/csv",
};

describe("checkInputProblem", () => {
  it("accepts every code with a description", () => {
    for (const problem of INPUT_PROBLEM_CODES) {
      expect(checkInputProblem({ ...good, problem })).toEqual([]);
    }
  });

  it("requires a description on every code, including other", () => {
    expect(checkInputProblem({ input: "x", problem: "other" }).join(" ")).toMatch(/description/);
    expect(checkInputProblem({ input: "x", problem: "missing", description: "  " }).join(" ")).toMatch(/description/);
  });

  it("refuses unknown codes, missing input names, and non-objects", () => {
    expect(checkInputProblem({ ...good, problem: "corrupt" })).not.toEqual([]);
    expect(checkInputProblem({ ...good, input: "" })).not.toEqual([]);
    expect(checkInputProblem("wrong_format")).toEqual(["a problem report must be an object"]);
  });
});

describe("InputProblemsError", () => {
  it("carries the reports and defaults its message from them", () => {
    const err = new InputProblemsError(good);
    expect(err.problems).toEqual([good]);
    expect(err.message).toContain("bank-statement");
    expect(new InputProblemsError([good], "custom").message).toBe("custom");
  });

  it("throws loudly on a malformed report instead of sending it", () => {
    expect(() => new InputProblemsError({ ...good, description: "" })).toThrow(/description/);
    expect(() => new InputProblemsError([])).toThrow(/at least one/);
  });
});

describe("inputProblemsOf", () => {
  const env = (payload: unknown): Envelope =>
    ({ v: "0.1.0", id: "e1", type: "respond", ts: "", from: "U1",
       trace: { trace_id: "t", span_id: "s" }, payload }) as unknown as Envelope;

  it("returns reports exactly as sent and [] when none", () => {
    expect(inputProblemsOf(env({ status: "input_required", problems: [good] }))).toEqual([good]);
    expect(inputProblemsOf(env({ status: "input_required" }))).toEqual([]);
    expect(inputProblemsOf(env(undefined))).toEqual([]);
  });

  it("drops malformed entries rather than repairing them", () => {
    const kept = inputProblemsOf(
      env({ problems: [good, { input: "x", problem: "corrupt", description: "d" }, "noise"] }),
    );
    expect(kept).toEqual([good]);
  });
});
