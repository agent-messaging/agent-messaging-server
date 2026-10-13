// The §13.5 usage receipt, asserted against conformance/metering.json.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src to agree with the fixture — never the fixture to agree
// with the code (the fixture changes only with a spec change alongside).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Envelope } from "../../src/types/envelope.js";
import {
  canonicalEnvelopeBytes,
  ENVELOPE_SIG_PREFIX,
} from "../../src/internal/identity.js";
import { encode, decode } from "../../src/internal/codec.js";
import {
  MeterUsageLedger,
  OBSERVED_METERS,
  validateMeterReport,
} from "../../src/internal/meter-usage.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../conformance/metering.json"), "utf8"),
) as {
  observed_meters: { meters: string[]; name_pattern: string };
  receipt: {
    supersede_case: {
      reports_in_order: Array<{ terminal: boolean; usage: Array<{ meter: string; quantity: number }> }>;
      expect_final: Record<string, number>;
    };
    signed_envelope: {
      signed_bytes_prefix: string;
      canonical: string;
      signed: Envelope;
    };
  };
};

// ── the signed receipt (the fixture's really-signed vector) ─────────────────

describe("§13.5 usage receipt — the envelope signature covers it", () => {
  const vec = fixture.receipt.signed_envelope;

  it("reproduces the fixture's canonical bytes exactly from the signed envelope", () => {
    const canonical = new TextDecoder().decode(canonicalEnvelopeBytes(vec.signed));
    expect(canonical).toBe(vec.canonical);
  });

  it("the signature verifies via decode(), under the envelope tag", () => {
    expect(vec.signed_bytes_prefix).toBe(ENVELOPE_SIG_PREFIX);
    expect(() => decode(encode(vec.signed))).not.toThrow();
  });

  it("one changed quantity fails verification — the receipt is tamper-evident", () => {
    const tampered = JSON.parse(JSON.stringify(vec.signed)) as Envelope;
    (tampered.payload as { usage: Array<{ quantity: number }> }).usage[0].quantity += 1;
    expect(() => decode(encode(tampered))).toThrow();
  });
});

// ── the declared-meter rules ────────────────────────────────────────────────

describe("§13.5 declared meter validation", () => {
  it("agrees with the fixture on the observed set and the name pattern", () => {
    expect(new Set(fixture.observed_meters.meters)).toEqual(OBSERVED_METERS);
    // Every observed name is refused as a DECLARED meter — the collision rule.
    for (const name of fixture.observed_meters.meters) {
      expect(() => validateMeterReport(name, 1)).toThrow(/OBSERVED/);
    }
  });

  it("refuses the fixture's malformed shapes at the report site", () => {
    expect(() => validateMeterReport("tokens_out", -1)).toThrow();
    expect(() => validateMeterReport("tokens_out", 1.5)).toThrow();
    expect(() => validateMeterReport("Tokens-Out", 1)).toThrow();
    expect(() => validateMeterReport("", 1)).toThrow();
    expect(() => validateMeterReport("tokens_out", 0)).not.toThrow();
  });
});

// ── the ledger: additive within a task, attach-once, deterministic order ────

describe("MeterUsageLedger", () => {
  it("accumulates additively and hands over sorted, then forgets", () => {
    const l = new MeterUsageLedger();
    l.report("t1", "tokens_out", 4000);
    l.report("t1", "tool_calls", 3);
    l.report("t1", "tokens_out", 210);
    expect(l.take("t1")).toEqual([
      { meter: "tokens_out", quantity: 4210 },
      { meter: "tool_calls", quantity: 3 },
    ]);
    expect(l.take("t1")).toBeNull(); // attach-once: a second terminal cannot double-report
  });

  it("matches the fixture's supersede expectation for the final receipt", () => {
    // The SDK reports cumulatively INTO one accumulator and attaches once at
    // the terminal respond, so the receipt it produces IS the final cumulative
    // report — the fixture's supersede rule holds by construction.
    const finalReport = fixture.receipt.supersede_case.reports_in_order.at(-1)!;
    const l = new MeterUsageLedger();
    for (const e of finalReport.usage) l.report("t", e.meter, e.quantity);
    const took = Object.fromEntries(l.take("t")!.map((e) => [e.meter, e.quantity]));
    expect(took).toEqual(fixture.receipt.supersede_case.expect_final);
  });
});
