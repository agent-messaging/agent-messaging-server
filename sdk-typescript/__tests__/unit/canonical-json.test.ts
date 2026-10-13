// Canonical JSON (§5.3) — RFC 8785 (JCS) held to pinned bytes.
//
// canonicalJSON is under every envelope signature and both attestations, so a
// one-byte drift here is a cross-SDK signature failure that surfaces as
// IDENTITY_MISMATCH on valid traffic. The shared fixture
// (conformance/canonical-json.json) pins the cases where implementations
// actually diverge — ECMAScript number formatting (exponent thresholds,
// shortest-form picks, negative zero), minimal string escaping, UTF-16 code
// unit key order, and absent-versus-null — and is asserted from both sides
// (sdk-rust/tests/canonical_json.rs is the other). The expected bytes were
// derived from RFC 8785's rules and its Appendix B before being generated, so
// a failure means the implementation left JCS, not that the fixture drifted.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalJSON } from "../../src/internal/identity.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "..", "..", "..", "conformance", "canonical-json.json"), "utf8"),
) as {
  vectors: { name: string; input_json: string; canonical: string; note?: string }[];
  number_bits: { ieee754_hex: string; canonical: string }[];
};

describe("canonical JSON — cross-SDK fixture (conformance/canonical-json.json)", () => {
  it("covers every section the spec calls out", () => {
    // A fixture-driven suite that quietly loses a section reports a number that
    // sounds like coverage. 52 vectors and the full RFC 8785 Appendix B.
    expect(fixture.vectors.length).toBe(52);
    expect(fixture.number_bits.length).toBe(24);
  });

  for (const v of fixture.vectors) {
    it(`vector: ${v.name}`, () => {
      expect(canonicalJSON(JSON.parse(v.input_json))).toBe(v.canonical);
    });
  }

  it("RFC 8785 Appendix B: every IEEE-754 bit pattern serializes as the RFC says", () => {
    // These enter as doubles, not as JSON text, so they also pin values a lossy
    // parser could never deliver (e.g. the exact 8000000000000000 = -0).
    for (const { ieee754_hex, canonical } of fixture.number_bits) {
      const bytes = new Uint8Array(ieee754_hex.match(/../g)!.map((x) => parseInt(x, 16)));
      const f = new DataView(bytes.buffer).getFloat64(0, false);
      expect(canonicalJSON(f), `bits ${ieee754_hex}`).toBe(canonical);
    }
  });
});

describe("canonical JSON — the AgentMesh deltas (§5.3)", () => {
  it("an unset member is omitted, never serialized as null", () => {
    // Fixture vectors can only carry JSON, where "unset" cannot be written down;
    // this is the native-object side of the member_absent vector.
    expect(canonicalJSON({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJSON({ a: undefined, b: 1 })).toBe(canonicalJSON({ b: 1 }));
  });

  it("null is a value distinct from absent — different bytes, different signature", () => {
    expect(canonicalJSON({ a: null, b: 1 })).toBe('{"a":null,"b":1}');
    expect(canonicalJSON({ a: null, b: 1 })).not.toBe(canonicalJSON({ b: 1 }));
  });
});
