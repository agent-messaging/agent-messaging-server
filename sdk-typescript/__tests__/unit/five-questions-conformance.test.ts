// The five questions (§3.3.1), asserted against conformance/five-questions.json.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src/interview.ts to agree with the fixture — never the
// fixture to agree with the code (the fixture changes only with a spec change
// alongside). Cases are executed by ITERATING the fixture: a row added to the
// JSON runs here without this file changing. The Rust suite
// (tests/five_questions_conformance.rs) asserts the same rows, and both
// compare through RFC 8785 canonicalization, so agreement is byte-exact.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  FIVE_QUESTIONS,
  REFUSAL_STATEMENT,
  describeDocumentOf,
  diffAnswers,
  interview,
  projectFiveQuestions,
  type FiveAnswers,
} from "../../src/interview.js";
import { canonicalJSON } from "../../src/internal/identity.js";
import type { Manifest } from "../../src/types/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../conformance/five-questions.json"), "utf8"),
) as {
  refusal_statement: string;
  projection: {
    cases: Array<{ name: string; why: string; describe: unknown; expected: unknown }>;
  };
  diff: {
    cases: Array<{
      name: string;
      why: string;
      declared_case: string;
      claimed?: unknown;
      claimed_case?: string;
      expected: unknown[];
    }>;
  };
};

function projectionCase(name: string) {
  const found = fixture.projection.cases.find((c) => c.name === name);
  if (!found) throw new Error(`fixture names no projection case ${name}`);
  return found;
}

describe("§3.3.1 constants", () => {
  it("the refusal statement matches the fixture bytes", () => {
    expect(REFUSAL_STATEMENT).toBe(fixture.refusal_statement);
  });

  it("the questions are the five, in the order §3.3.1 names them", () => {
    expect([...FIVE_QUESTIONS]).toEqual([
      "identity",
      "capabilities",
      "usage",
      "terms",
      "refusals",
    ]);
  });
});

describe("§3.3.1 projection", () => {
  it("has cases to assert", () => {
    expect(fixture.projection.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixture.projection.cases) {
    it(`${c.name}: projects to the pinned answers (${c.why.slice(0, 60)}…)`, () => {
      const answers = projectFiveQuestions(c.describe);
      expect(canonicalJSON(answers)).toBe(canonicalJSON(c.expected));
    });
  }

  it("every projected answer set carries exactly the five questions", () => {
    for (const c of fixture.projection.cases) {
      const answers = projectFiveQuestions(c.describe) as unknown as Record<string, unknown>;
      expect(Object.keys(answers).sort()).toEqual([...FIVE_QUESTIONS].sort());
    }
  });

  it("refuses a document that is not an object", () => {
    for (const bad of [null, undefined, 7, "describe", [1, 2]]) {
      expect(() => projectFiveQuestions(bad)).toThrow(/JSON object/);
    }
  });
});

describe("§3.3.1 consistency diff", () => {
  it("has cases to assert", () => {
    expect(fixture.diff.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixture.diff.cases) {
    it(`${c.name}: reports the pinned mismatches (${c.why.slice(0, 60)}…)`, () => {
      const declared = projectFiveQuestions(projectionCase(c.declared_case).describe);
      const claimed = c.claimed_case !== undefined ? projectionCase(c.claimed_case).expected : c.claimed;
      const mismatches = diffAnswers(declared, claimed);
      expect(canonicalJSON(mismatches)).toBe(canonicalJSON(c.expected));
    });
  }

  it("a projection diffed against itself is empty", () => {
    for (const c of fixture.projection.cases) {
      const declared = projectFiveQuestions(c.describe);
      expect(diffAnswers(declared, declared as unknown)).toEqual([]);
    }
  });

  it("refuses a claim set that is not an object", () => {
    const declared = projectFiveQuestions(projectionCase("no_public_block").describe);
    for (const bad of [null, 7, "yes", ["identity"]]) {
      expect(() => diffAnswers(declared, bad)).toThrow(/JSON object/);
    }
  });

  it("unknown question keys in a claim are ignored", () => {
    const declared = projectFiveQuestions(projectionCase("no_public_block").describe);
    expect(diffAnswers(declared, { reputation: { score: 11 } })).toEqual([]);
  });
});

describe("§3.3.1 the interview (client wrapper)", () => {
  const manifest = {
    id: "UAKQRYZBYFOC65OQZVJ3QPCIERDTRNNZPMOJUYXC3DGPRCDWSKD4HV5A",
    name: "Text Stats",
    description: "unpublished internal description",
    version: "1.0.0",
    protocol_version: "0.2",
    endpoint: "mesh.agent.UAKQ.inbox",
    node: {} as Manifest["node"],
    capabilities: [],
    offerings: [],
    owner: "UBMBH4BK6EIHQFVMHLSABFSQXB3JXUFZOXVZQTIERO33AD4HHAI3D7QP",
    interaction: "service",
    sealing: "preferred",
    public: {
      description: "Counts words.",
      offerings: ["text-stats"],
      admission: "Open.",
    },
  } as Manifest;

  it("describeDocumentOf carries the storefront fields and never the card", () => {
    const doc = describeDocumentOf(manifest);
    expect(doc).toEqual({
      agent_id: manifest.id,
      name: "Text Stats",
      owner: manifest.owner,
      interaction: "service",
      sealing: "preferred",
      public: manifest.public,
    });
    expect("card" in doc).toBe(false);
    // The internal description is not pre-admission data; only the public
    // block's description answers strangers.
    expect("description" in doc).toBe(false);
  });

  it("interview fetches, projects, and answers", async () => {
    const asked: string[] = [];
    const client = {
      async getManifest(agentId: string): Promise<Manifest> {
        asked.push(agentId);
        return manifest;
      },
    };
    const answers = await interview(client, manifest.id);
    expect(asked).toEqual([manifest.id]);
    expect(answers.identity.agent_id).toBe(manifest.id);
    expect(answers.capabilities.description).toBe("Counts words.");
    expect(answers.terms.admission).toBe("Open.");
    expect(answers.refusals).toEqual({
      boundary: ["text-stats"],
      admission: "Open.",
      statement: REFUSAL_STATEMENT,
    });
  });
});

describe("§3.3.1 behavior beyond the fixture rows", () => {
  it("an offering_details entry without an id is skipped, not invented", () => {
    const answers = projectFiveQuestions({
      agent_id: "U1",
      public: { offering_details: [{ name: "nameless" }, "not an object"] },
    });
    expect(answers.usage).toEqual({});
    // The details themselves are still capabilities data, verbatim.
    expect(answers.capabilities.offering_details).toEqual([{ name: "nameless" }, "not an object"]);
    expect(answers.refusals.boundary).toEqual([]);
  });

  it("boundary deduplicates while preserving first-seen order", () => {
    const answers = projectFiveQuestions({
      agent_id: "U1",
      public: { offerings: ["b", "a", "b", 7, ""] },
    });
    expect(answers.refusals.boundary).toEqual(["b", "a"]);
  });

  it("a differing claimed member mismatches with both values named", () => {
    const declared = projectFiveQuestions({ agent_id: "U1" }) as FiveAnswers;
    const mismatches = diffAnswers(declared, { identity: { agent_id: "U2" } });
    expect(mismatches).toEqual([
      { question: "identity", path: "identity.agent_id", declared: "U1", claimed: "U2" },
    ]);
  });
});
