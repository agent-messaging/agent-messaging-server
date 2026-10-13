// Agent SoW pricing arrangements (agentsow.com 0.9.0-draft §5.5), asserted
// against conformance/sow-pricing.json.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src/sow.ts to agree with the fixture — never the fixture to
// agree with the code (the fixture changes only with a spec change alongside).
// Cases are executed by ITERATING the fixture: a row added to the JSON runs
// here without this file changing, and the same rows run in Rust against
// sdk-rust/tests/sow_pricing_conformance.rs.
//
// The load-bearing assertion is the canonical-bytes one. The §6.2
// organization/mandate fields and the whole §5.5 price clause sit INSIDE the
// signed bytes, so one byte of drift between the SDKs is a document that
// verifies in one and is worthless in the other.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  APPROVAL_AUTHORITIES,
  CHECKABLE_QUALIFICATION_KINDS,
  DEFAULT_AMENDMENT_AUTHORITY,
  DEFAULT_FORMATION_AUTHORITY,
  OPERATOR_FEE_BASIS_GRADE,
  PRICING_ARRANGEMENTS,
  SOW_END_STATES,
  SOW_QUALIFICATION_KINDS,
  SOW_SIG_PREFIX,
  admitSettlement,
  admitsWork,
  canonicalSowJSON,
  checkOperatorFee,
  checkSettlement,
  committedPrice,
  directedOfferRefusal,
  divisorOf,
  isDirectedProposal,
  isScoredOutcome,
  mandateVerified,
  maxRatedTotalUnderCap,
  noChargePrice,
  operatorFee,
  operatorFeeAmount,
  operatorFeeGrade,
  passThroughLines,
  providerNet,
  qualificationGradeCeiling,
  qualificationRefusal,
  quoteWithOperatorFee,
  rateLine,
  rateUsage,
  refuseFurtherWorkUnderOperator,
  requiredAssertions,
  reservationReleaseAt,
  reservationWithinTerm,
  settlementTotal,
  settlementWithOperatorFee,
  settles,
  signSow,
  sowAgreed,
  sowSignedBytes,
  timeAndMaterialsPrice,
  validateOperatorFee,
  validateSettlementLine,
  validateSowApproval,
  validateSowOfferedTo,
  validateSowParty,
  validateSowPrice,
  validateSowQualification,
  validateSowQualifications,
  verifySowSignature,
  type SowApprovalRecord,
  type SowDocumentState,
  type SowGrade,
  type SowMeteredCount,
  type SowOperatorFee,
  type SowOperatorFeeBasis,
  type SowPrice,
  type SowQualificationFacts,
  type SowQuote,
  type SowSettlementRecord,
  type SowSignature,
  type SowTimeAndMaterialsPrice,
} from "../../src/sow.js";
import { createAgentIdentity, keyPairFromSeed } from "../../src/internal/identity.js";
import { TERMINAL_STATES, VALID_TRANSITIONS, isValidTransition } from "../../src/types/task.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../conformance/sow-pricing.json"), "utf8"),
) as {
  identities: { sender_seed: string; sender: string; recipient: string };
  arrangement: { values: string[] };
  price: { valid: unknown[]; invalid: Array<{ case: string; price: unknown; why: string }> };
  rating: {
    cases: Array<{
      case: string;
      price: SowTimeAndMaterialsPrice;
      already_billed: number;
      usage: SowMeteredCount[];
      receipts?: Record<string, string>;
      /** §5.5.8's cut, where one is in the path. Absent is the peer-to-peer
       *  case, where every number below means what it always meant. */
      operator_fee_basis?: SowOperatorFeeBasis;
      operator?: string;
      expect: {
        total: number;
        client_total: number;
        cap_remaining: number;
        exhausted: boolean;
        unbilled: number;
        operator_fee?: SowOperatorFee;
        lines: unknown[];
      };
      why: string;
    }>;
    refuses: Array<{
      case: string;
      price: SowTimeAndMaterialsPrice;
      usage: SowMeteredCount[];
      why: string;
    }>;
  };
  settlement_line: {
    valid: unknown[];
    invalid: Array<{ case: string; line: unknown; why: string }>;
  };
  no_charge: {
    clause: { arrangement: "no_charge"; grade: string };
    settles: boolean;
    committed_price: number;
    refuses_rating: { usage: SowMeteredCount[]; why: string };
    refuses_settlement_record: { record: { lines: unknown[] }; why: string };
    document: Record<string, unknown>;
    canonical: string;
    signed: Record<string, unknown> & { signatures: SowSignature[] };
  };
  reservation: {
    cases: Array<{
      window_days: number;
      starts_at: string;
      ends_at: string;
      release_at: string;
      within_term: boolean;
    }>;
  };
  document_states: {
    all: SowDocumentState[];
    end_states: SowDocumentState[];
    admits_work: SowDocumentState[];
    unscored: SowDocumentState[];
  };
  task_state: {
    state: string;
    terminal: boolean;
    is_failure: boolean;
    reachable_from: string[];
  };
  party: { valid: unknown[]; invalid: Array<{ case: string; party: unknown; why: string }> };
  directed: {
    clause: { valid: unknown[]; invalid: Array<{ case: string; offered_to: unknown; why: string }> };
    listing: {
      cases: Array<{ case: string; parties: unknown; directed: boolean; public_listing: boolean }>;
    };
    formation: {
      cases: Array<{
        case: string;
        offered_to: unknown;
        client_agent: string;
        now: string;
        forms: boolean;
        why: string;
      }>;
    };
    signing: { document: Record<string, unknown>; canonical: string };
  };
  qualifications: {
    kinds: {
      all: string[];
      checkable: string[];
      grade_ceiling: Record<string, string>;
    };
    clause: { valid: unknown[]; invalid: Array<{ case: string; qualification: unknown; why: string }> };
    list: { valid: unknown[][]; invalid: Array<{ case: string; qualifications: unknown; why: string }> };
    formation: {
      cases: Array<{
        case: string;
        qualifications: unknown;
        client_agent: string;
        asserted: string[];
        facts: (SowQualificationFacts & Record<string, unknown>) | null;
        forms: boolean;
        why: string;
      }>;
    };
    signing: { document: Record<string, unknown>; canonical: string };
  };
  approval: {
    authorities: string[];
    defaults: { formation: string; amendment: string };
    valid: unknown[];
    invalid: Array<{ case: string; approval: unknown; why: string }>;
    mandate_verified: {
      cases: Array<{ mandate: string | null; checks_performed: boolean; expect: boolean }>;
    };
  };
  signing: {
    signed_bytes_prefix: string;
    document: Record<string, unknown>;
    canonical: string;
    signed: Record<string, unknown> & { signatures: SowSignature[] };
    tamper: { fields: string[] };
  };
  operator_fee: {
    valid: Array<{ case: string; fee: SowOperatorFee; why: string }>;
    invalid: Array<{ case: string; fee: unknown; why: string }>;
    arithmetic: { cases: Array<{ case: string; fee: SowOperatorFee; closes: boolean }> };
    computed: {
      cases: Array<{ basis: SowOperatorFeeBasis; base: number; amount: number }>;
    };
    cap: {
      rule: string;
      cases: Array<{
        case: string;
        cap_remaining: number;
        basis: SowOperatorFeeBasis | null;
        max_rated_total: number;
        fee: number;
        client_total: number;
        why: string;
      }>;
    };
    grade: {
      basis: SowGrade;
      cases: Array<{ operator_built_quote: boolean; operator_settled: boolean; grade: SowGrade }>;
    };
    settlement: {
      cases: Array<{
        case: string;
        quote: SowQuote;
        record: SowSettlementRecord;
        settled: boolean;
        reason?: string;
        provider_net?: number;
      }>;
      refuse_further_work_after: number;
    };
    no_charge: { carries_a_line: boolean };
  };
};

// ── §5.5 the arrangement ────────────────────────────────────────────────────

describe("§5.5 arrangement — every engagement declares one, and there is no default", () => {
  it("the closed set is exactly the fixture's", () => {
    expect([...PRICING_ARRANGEMENTS].sort()).toEqual([...fixture.arrangement.values].sort());
  });

  for (const price of fixture.price.valid) {
    const p = price as SowPrice;
    it(`${p.arrangement} clause validates`, () => {
      expect(() => validateSowPrice(price)).not.toThrow();
    });
  }

  for (const row of fixture.price.invalid) {
    it(`${row.case} is refused — ${row.why}`, () => {
      expect(() => validateSowPrice(row.price)).toThrow();
    });
  }
});

describe("§5.5.3 the cap — an uncapped time and materials price is unrepresentable", () => {
  it("omitting `cap` is a compile error, so the only way to build one is to lie to the compiler", () => {
    // The typed builder takes `cap` as a required field of its init object. The
    // cast is what a caller would have to write to get around that, and it is
    // still refused at construction — the runtime check backs the type up for
    // untyped JavaScript callers and for JSON off the wire.
    const escapeHatch = timeAndMaterialsPrice as unknown as (
      init: Record<string, unknown>,
    ) => unknown;
    expect(() =>
      escapeHatch({
        currency: "XCR",
        schedule: [{ meter: "tokens_out", unit: "1000 tokens", per_unit: 1500 }],
        grade: "enforced",
      }),
    ).toThrow(/not-to-exceed cap/);
  });

  it("omitting `reservation` is refused the same way — §5.5.4 makes it mandatory too", () => {
    const escapeHatch = timeAndMaterialsPrice as unknown as (
      init: Record<string, unknown>,
    ) => unknown;
    expect(() =>
      escapeHatch({
        currency: "XCR",
        schedule: [{ meter: "tokens_out", unit: "1000 tokens", per: 1000, per_unit: 1500 }],
        cap: { amount: 40000000 },
        grade: "enforced",
      }),
    ).toThrow(/no defined settlement behaviour/);
  });

  it("a cap of zero is refused — it is a refusal written as a price", () => {
    expect(() =>
      validateSowPrice({
        arrangement: "time_and_materials",
        currency: "XCR",
        schedule: [{ meter: "tokens_out", unit: "1000 tokens", per_unit: 1500 }],
        cap: { amount: 0 },
        grade: "enforced",
      }),
    ).toThrow(/positive integer/);
  });

  it("the committed price of a time and materials engagement IS the cap", () => {
    for (const price of fixture.price.valid as SowPrice[]) {
      if (price.arrangement === "time_and_materials") {
        expect(committedPrice(price)).toBe(price.cap.amount);
      } else if (price.arrangement === "no_charge") {
        // §5.5.7: zero, and any ceiling covers it. Not null — a no-charge
        // engagement commits to a figure, and the figure is nothing.
        expect(committedPrice(price)).toBe(0);
      } else {
        expect(committedPrice(price)).toBe(price.ceiling?.amount ?? null);
      }
    }
  });
});

// ── §5.5.7 no charge ────────────────────────────────────────────────────────

describe("§5.5.7 no charge — a clause carrying any price field is unrepresentable", () => {
  const nc = fixture.no_charge;

  it("the clause the fixture pins is exactly what the builder produces", () => {
    expect(noChargePrice()).toEqual(nc.clause);
    expect(noChargePrice({ grade: "evidence" })).toEqual({
      arrangement: "no_charge",
      grade: "evidence",
    });
  });

  it("every price field the section names is refused by name", () => {
    // The type-level half of this lives in src/sow.ts, as a compile-time proof
    // `tsc --noEmit` checks on every build: `tsconfig.json` excludes __tests__
    // and vitest does not typecheck, so a `@ts-expect-error` written here would
    // assert nothing. What runs here is the runtime half, which is what backs
    // the type up for untyped JavaScript callers and for JSON off the wire.
    for (const field of ["currency", "rates", "schedule", "cap", "reservation", "ceiling"]) {
      const clause = { arrangement: "no_charge", grade: "enforced", [field]: {} } as unknown;
      expect(() => validateSowPrice(clause)).toThrow(new RegExp(`MUST NOT carry '${field}'`));
    }
    // "or any other price field": a member the section never names is refused
    // for the same reason the six are.
    expect(() =>
      validateSowPrice({ arrangement: "no_charge", grade: "enforced", minimum: { amount: 1 } }),
    ).toThrow(/MUST NOT carry 'minimum'/);
  });

  it("the builder has no slot for a price at all", () => {
    // Not a runtime assertion about behaviour — an assertion about the shape
    // of the door. `noChargePrice` takes a grade and nothing else, so there is
    // no call that supplies a currency, a rate, a cap or a ceiling by mistake.
    expect(Object.keys(noChargePrice())).toEqual(["arrangement", "grade"]);
  });

  it("nothing settles: rating is refused rather than rated to zero", () => {
    expect(() =>
      rateUsage(nc.clause as unknown as SowTimeAndMaterialsPrice, nc.refuses_rating.usage),
    ).toThrow(/MUST NOT rate work under it/);
    expect(settles(nc.clause as SowPrice)).toBe(nc.settles);
    for (const price of fixture.price.valid as SowPrice[]) {
      expect(settles(price)).toBe(price.arrangement !== "no_charge");
    }
  });

  it("a client node refuses a settlement record that cites a no-charge engagement", () => {
    // The record is well formed line by line — that is the point. §5.5.7's
    // refusal is about the ENGAGEMENT it cites, not about the record's shape,
    // and a total of zero is exactly the record the prohibition keeps out of
    // the books.
    for (const line of nc.refuses_settlement_record.record.lines) {
      expect(() => validateSettlementLine(line)).not.toThrow();
    }
    expect(() => admitSettlement(nc.clause as SowPrice, "file a settlement record for")).toThrow(
      /file a settlement record for it/,
    );
    // The other two arrangements admit one.
    for (const price of fixture.price.valid as SowPrice[]) {
      if (price.arrangement === "no_charge") continue;
      expect(() => admitSettlement(price)).not.toThrow();
    }
  });

  it("commits zero, so any Agent Mandate ceiling covers it (§5.5.7)", () => {
    expect(committedPrice(nc.clause as SowPrice)).toBe(nc.committed_price);
  });

  it("carries no pass-through lines, because it carries no schedule", () => {
    expect(passThroughLines(nc.clause as unknown as SowTimeAndMaterialsPrice)).toEqual([]);
  });

  it("is otherwise an ordinary document: the pinned bytes sign and verify", () => {
    // The cross-SDK byte test, over a document priced no_charge. The price
    // clause is inside the signed bytes, so an SDK that writes a currency into
    // one produces a document the other will not verify.
    expect(canonicalSowJSON(nc.document)).toBe(nc.canonical);
    expect(canonicalSowJSON(nc.signed)).toBe(nc.canonical);
    const [sig] = nc.signed.signatures;
    expect(verifySowSignature(nc.signed, sig)).toBe(true);
    const kp = keyPairFromSeed(fixture.identities.sender_seed);
    expect(signSow(nc.document, kp, "client", sig.signed_at).signatures[0].sig).toBe(sig.sig);
  });
});

// ── §5.5.2 / §5.5.3 rating ──────────────────────────────────────────────────

describe("§5.5.2 rating against the schedule, §5.5.3 stopping at the cap", () => {
  for (const row of fixture.rating.cases) {
    it(`${row.case} — ${row.why}`, () => {
      const rated = rateUsage(row.price, row.usage, {
        alreadyBilled: row.already_billed,
        receipts: row.receipts,
        ...(row.operator_fee_basis ? { operatorFeeBasis: row.operator_fee_basis } : {}),
        ...(row.operator ? { operator: row.operator } : {}),
      });
      expect(rated.total).toBe(row.expect.total);
      expect(rated.client_total).toBe(row.expect.client_total);
      expect(rated.cap_remaining).toBe(row.expect.cap_remaining);
      expect(rated.exhausted).toBe(row.expect.exhausted);
      expect(rated.unbilled).toBe(row.expect.unbilled);
      expect(rated.lines).toEqual(row.expect.lines);
      expect(rated.currency).toBe(row.price.currency);
      // §5.5.8: the fee line the rating took, and its absence where none was
      // taken. Absence is an assertion, so it is asserted rather than skipped.
      expect(rated.operator_fee).toEqual(row.expect.operator_fee);
      // The invariant every one of these rows has to satisfy, whether or not an
      // operator stands in the path: what the client pays over the engagement
      // never exceeds the cap (§5.5.3).
      expect(row.already_billed + rated.client_total).toBeLessThanOrEqual(row.price.cap.amount);
      expect(rated.client_total).toBe(rated.total + (rated.operator_fee?.amount ?? 0));
      expect(rated.cap_remaining).toBe(
        row.price.cap.amount - row.already_billed - rated.client_total,
      );
    });
  }

  for (const row of fixture.rating.refuses) {
    it(`${row.case} is refused — ${row.why}`, () => {
      expect(() => rateUsage(row.price, row.usage)).toThrow();
    });
  }

  it("what the cap clamps away is the provider's to bear, never re-billed later", () => {
    const price = fixture.rating.cases[2].price;
    const first = rateUsage(price, [{ meter: "tool_calls", count: 8 }]);
    expect(first.exhausted).toBe(true);
    const second = rateUsage(price, [{ meter: "tool_calls", count: 8 }], {
      alreadyBilled: first.total,
    });
    expect(second.total).toBe(0);
    expect(second.unbilled).toBe(8000);
  });
});

// ── §5.5.2 the divisor ──────────────────────────────────────────────────────

describe("§5.5.2 the divisor — the metered unit a machine can convert", () => {
  it("floors, and the floor favours the buyer", () => {
    const line = { meter: "tokens_out", unit: "1000 tokens", per: 1000, per_unit: 1500 };
    expect(rateLine(line, 2000)).toBe(3000); // exactly two units
    expect(rateLine(line, 2999)).toBe(4498); // 4498.5 floors: the half unit is free
    expect(rateLine(line, 999)).toBe(1498);
    expect(rateLine(line, 0)).toBe(0);
  });

  it("a line naming no divisor rates one raw count at a time", () => {
    const line = { meter: "tool_calls", unit: "call", per_unit: 2000 };
    expect(divisorOf(line)).toBe(1);
    expect(rateLine(line, 3)).toBe(6000);
  });

  it("the unit label is never parsed — a label contradicting `per` changes nothing", () => {
    const lying = { meter: "tokens_out", unit: "1 token", per: 1000, per_unit: 1500 };
    expect(rateLine(lying, 1000)).toBe(1500);
  });

  it("rating widens past a double so a large count does not lose precision", () => {
    const line = { meter: "tokens_out", unit: "1000 tokens", per: 1000, per_unit: 1_000_000 };
    // count × per_unit here is ~4.6e18, far past 2^53.
    expect(rateLine(line, 4_600_000_000_000)).toBe(4_600_000_000_000_000);
  });

  it("a settlement record carries what the buyer needs to recompute it", () => {
    const rated = fixture.rating.cases[0].expect.lines as Array<{
      count: number;
      per: number;
      per_unit: number;
      amount: number;
    }>;
    for (const line of rated) {
      expect(Math.floor((line.count * line.per_unit) / line.per)).toBe(line.amount);
    }
  });
});

// ── §5.5.6 pass-through ─────────────────────────────────────────────────────

describe("§5.5.6 pass-through lines — at cost, with proof", () => {
  for (const line of fixture.settlement_line.valid) {
    it(`a valid settlement line passes: ${JSON.stringify(line).slice(0, 60)}`, () => {
      expect(() => validateSettlementLine(line)).not.toThrow();
    });
  }
  for (const row of fixture.settlement_line.invalid) {
    it(`${row.case} is refused — ${row.why}`, () => {
      expect(() => validateSettlementLine(row.line)).toThrow();
    });
  }
});

// ── §5.5.4 the reservation window ───────────────────────────────────────────

describe("§5.5.4 reservation — the window, and releasing what was not spent", () => {
  for (const c of fixture.reservation.cases) {
    it(`${c.window_days}d from ${c.starts_at} releases at ${c.release_at}`, () => {
      expect(reservationReleaseAt({ window_days: c.window_days }, c.starts_at)).toBe(c.release_at);
    });
    it(`${c.window_days}d from ${c.starts_at} within a term ending ${c.ends_at}: ${c.within_term}`, () => {
      expect(
        reservationWithinTerm({ window_days: c.window_days }, c.starts_at, c.ends_at),
      ).toBe(c.within_term);
    });
  }
});

// ── §7.1 document states, §5.5.5 exhausted ──────────────────────────────────

describe("§7.1 / §5.5.5 — exhausted is how an engagement ends, not how it fails", () => {
  it("the end states are exactly the fixture's", () => {
    expect([...SOW_END_STATES].sort()).toEqual([...fixture.document_states.end_states].sort());
  });

  for (const state of fixture.document_states.all) {
    const admits = fixture.document_states.admits_work.includes(state);
    it(`${state} ${admits ? "admits" : "refuses"} work`, () => {
      expect(admitsWork(state)).toBe(admits);
    });
  }

  for (const state of fixture.document_states.all) {
    const scored = !fixture.document_states.unscored.includes(state);
    it(`${state} is ${scored ? "" : "not "}a scored outcome`, () => {
      expect(isScoredOutcome(state)).toBe(scored);
    });
  }

  it("lapse, exhaustion and termination are identical at the gate", () => {
    for (const state of fixture.document_states.end_states) expect(admitsWork(state)).toBe(false);
  });

  it("a document state round-trips through JSON as the wire string", () => {
    const doc = { state: "exhausted" as SowDocumentState };
    const back = JSON.parse(JSON.stringify(doc)) as { state: SowDocumentState };
    expect(back.state).toBe("exhausted");
    expect(SOW_END_STATES.has(back.state)).toBe(true);
  });
});

describe("§5.5.5 — `exhausted` as a Task state (SPEC.md §7.3)", () => {
  const t = fixture.task_state;

  it("is terminal", () => {
    expect(TERMINAL_STATES.has(t.state as never)).toBe(t.terminal);
    expect(VALID_TRANSITIONS[t.state as never]).toEqual([]);
  });

  it("is not a failure — it is not `failed`, and `failed` cannot become it", () => {
    expect(t.is_failure).toBe(false);
    expect(isValidTransition("failed", "exhausted")).toBe(false);
    expect(isValidTransition("exhausted", "failed")).toBe(false);
  });

  for (const from of t.reachable_from) {
    it(`${from} → exhausted is a valid transition (the cap is reached when it is reached)`, () => {
      expect(isValidTransition(from as never, "exhausted")).toBe(true);
    });
  }

  it("cannot be reached from another terminal state", () => {
    for (const from of ["completed", "failed", "canceled", "rejected"] as const) {
      expect(isValidTransition(from, "exhausted")).toBe(false);
    }
  });

  it("round-trips through a task record", () => {
    const record = { id: "t1", state: "exhausted" as const, artifacts: [{ id: "a1" }] };
    const back = JSON.parse(JSON.stringify(record));
    expect(back.state).toBe("exhausted");
    // §5.5.5: "with whatever artifacts exist attached".
    expect(back.artifacts).toHaveLength(1);
  });
});

// ── §5.1 + §6.1 + §6.2 ──────────────────────────────────────────────────────

describe("§5.1/§6.2 parties — the optional organization reference", () => {
  for (const party of fixture.party.valid) {
    it(`a valid party passes: ${JSON.stringify(party).slice(0, 60)}`, () => {
      expect(() => validateSowParty(party)).not.toThrow();
    });
  }
  for (const row of fixture.party.invalid) {
    it(`${row.case} is refused — ${row.why}`, () => {
      expect(() => validateSowParty(row.party)).toThrow();
    });
  }
});

// ── §12.1.1 ─────────────────────────────────────────────────────────────────

describe("§12.1.1 the named counterparty — the clause", () => {
  for (const clause of fixture.directed.clause.valid) {
    it(`a valid offered_to passes: ${JSON.stringify(clause).slice(0, 70)}`, () => {
      expect(() => validateSowOfferedTo(clause)).not.toThrow();
    });
  }
  for (const row of fixture.directed.clause.invalid) {
    it(`${row.case} is refused — ${row.why}`, () => {
      expect(() => validateSowOfferedTo(row.offered_to)).toThrow();
    });
  }
});

describe("§12.1.1 the named counterparty — no public listing is derived from it", () => {
  for (const c of fixture.directed.listing.cases) {
    it(`${c.case}: directed=${c.directed}, listed=${c.public_listing}`, () => {
      const doc = { parties: c.parties };
      expect(isDirectedProposal(doc)).toBe(c.directed);
      // The listing rule is the predicate's whole purpose: a directed document
      // yields no public listing, and the surface reads that off the offer
      // rather than interpreting prose.
      expect(!isDirectedProposal(doc)).toBe(c.public_listing);
    });
  }
});

describe("§12.1.1 the named counterparty — who may form, and until when", () => {
  for (const c of fixture.directed.formation.cases) {
    it(`${c.case} → ${c.forms ? "forms" : "refused"} — ${c.why}`, () => {
      const doc = { parties: { provider: {}, client: null, offered_to: c.offered_to } };
      const refusal = directedOfferRefusal(doc, c.client_agent, Date.parse(c.now));
      expect(refusal === null).toBe(c.forms);
      // A refusal names the restriction rather than shrugging: the
      // counterparty acted on a document it was handed.
      if (!c.forms) expect(refusal).toContain("§12.1.1");
    });
  }
});

describe("§12.1.1 the named counterparty — inside the signed bytes", () => {
  it("canonicalizes to the fixture's bytes, seat still blank", () => {
    expect(canonicalSowJSON(fixture.directed.signing.document)).toBe(fixture.directed.signing.canonical);
    // Naming a counterparty does not fill the client seat. Formation stays
    // the two-step gate: a countersign is a request to form.
    expect(fixture.directed.signing.canonical).toContain('"client":null');
    expect(fixture.directed.signing.canonical).toContain('"starts_at":null');
    // And the restriction is INSIDE those bytes, not laid over them.
    expect(fixture.directed.signing.canonical).toContain('"offered_to"');
  });
});

// ── §12.1 qualifications ────────────────────────────────────────────────────

describe("§12.1 qualifications — the closed vocabulary and what each kind can claim", () => {
  it("the kinds are exactly the fixture's, and so is the checkable half", () => {
    expect([...SOW_QUALIFICATION_KINDS].sort()).toEqual([...fixture.qualifications.kinds.all].sort());
    expect([...CHECKABLE_QUALIFICATION_KINDS].sort()).toEqual([...fixture.qualifications.kinds.checkable].sort());
  });

  for (const [kind, ceiling] of Object.entries(fixture.qualifications.kinds.grade_ceiling)) {
    it(`${kind} can honestly claim at most ${ceiling}`, () => {
      expect(qualificationGradeCeiling(kind as never)).toBe(ceiling);
    });
  }
});

describe("§12.1 qualifications — one condition", () => {
  for (const q of fixture.qualifications.clause.valid) {
    it(`a valid condition passes: ${JSON.stringify(q).slice(0, 70)}`, () => {
      expect(() => validateSowQualification(q)).not.toThrow();
    });
  }
  for (const row of fixture.qualifications.clause.invalid) {
    it(`${row.case} is refused — ${row.why}`, () => {
      expect(() => validateSowQualification(row.qualification)).toThrow();
    });
  }
});

describe("§12.1 qualifications — the clause as a whole", () => {
  for (const list of fixture.qualifications.list.valid) {
    it(`a valid list of ${list.length} passes`, () => {
      expect(() => validateSowQualifications(list)).not.toThrow();
    });
  }
  for (const row of fixture.qualifications.list.invalid) {
    it(`${row.case} is refused — ${row.why}`, () => {
      expect(() => validateSowQualifications(row.qualifications)).toThrow();
    });
  }
});

describe("§12.1 qualifications — the formation gate", () => {
  for (const c of fixture.qualifications.formation.cases) {
    it(`${c.case} → ${c.forms ? "forms" : "refused"} — ${c.why}`, () => {
      const doc = c.qualifications === null ? {} : { qualifications: c.qualifications };
      const refusal = qualificationRefusal(doc, c.client_agent, c.asserted, c.facts ?? undefined);
      expect(refusal === null).toBe(c.forms);
      // Rule 2: the refusal NAMES the unmet condition. A counterparty that
      // read a published offer and acted on it is owed the reason.
      if (!c.forms) expect(refusal).toContain("§12.1");
    });
  }

  it("names the condition it refused on, by id and in the seller's own words", () => {
    const doc = {
      qualifications: [
        {
          id: "salesforce-licence",
          kind: "asserted",
          statement: "You hold a current Salesforce licence covering the org this work touches.",
          grade: "evidence",
        },
      ],
    };
    const refusal = qualificationRefusal(doc, "UAAA", [], undefined);
    expect(refusal).toContain("salesforce-licence");
    expect(refusal).toContain("Salesforce licence covering the org");
    // And it says plainly that nothing here verified the statement.
    expect(refusal).toContain("verifies");
  });

  it("lists the assertions a countersign must carry, sorted", () => {
    expect(requiredAssertions(fixture.qualifications.signing.document)).toEqual(["salesforce-licence"]);
    expect(requiredAssertions({})).toEqual([]);
  });
});

describe("§12.1 qualifications — inside the signed bytes", () => {
  it("canonicalizes to the fixture's bytes, conditions included", () => {
    expect(canonicalSowJSON(fixture.qualifications.signing.document)).toBe(
      fixture.qualifications.signing.canonical,
    );
    // The whole of rule 1: the conditions are in the document the buyer reads
    // and the seller signed, not in a policy laid over it afterwards.
    expect(fixture.qualifications.signing.canonical).toContain('"qualifications"');
    // Both grades in one clause, singly graded (§4.2).
    expect(fixture.qualifications.signing.canonical).toContain('"grade":"enforced","id":"mesh-registered"');
    expect(fixture.qualifications.signing.canonical).toContain('"grade":"evidence","id":"salesforce-licence"');
  });
});

describe("§6.1/§6.2 approvals — authority, and the mandate a person acted under", () => {
  it("the authority set and the defaults are exactly the fixture's", () => {
    expect([...APPROVAL_AUTHORITIES].sort()).toEqual([...fixture.approval.authorities].sort());
    expect(DEFAULT_FORMATION_AUTHORITY).toBe(fixture.approval.defaults.formation);
    expect(DEFAULT_AMENDMENT_AUTHORITY).toBe(fixture.approval.defaults.amendment);
  });

  for (const approval of fixture.approval.valid) {
    it(`a valid approval passes: ${JSON.stringify(approval).slice(0, 70)}`, () => {
      expect(() => validateSowApproval(approval)).not.toThrow();
    });
  }
  for (const row of fixture.approval.invalid) {
    it(`${row.case} is refused — ${row.why}`, () => {
      expect(() => validateSowApproval(row.approval)).toThrow();
    });
  }

  for (const c of fixture.approval.mandate_verified.cases) {
    it(`mandate=${c.mandate ?? "none"} checks=${c.checks_performed} → ${c.expect}`, () => {
      const approval = {
        act: "amendment",
        authority: "person",
        key: fixture.identities.sender,
        approved_at: "2026-08-06T09:14:02Z",
        ...(c.mandate !== null ? { mandate: c.mandate } : {}),
      } as SowApprovalRecord;
      expect(mandateVerified(approval, { checksPerformed: c.checks_performed })).toBe(c.expect);
    });
  }
});

// ── §6 canonicalization and signing — the cross-SDK byte contract ───────────

describe("§6 signing — the bytes the Rust SDK must reproduce", () => {
  it("the domain tag is the fixture's", () => {
    expect(SOW_SIG_PREFIX).toBe(fixture.signing.signed_bytes_prefix);
  });

  it("the canonical JSON reproduces byte for byte", () => {
    expect(canonicalSowJSON(fixture.signing.document)).toBe(fixture.signing.canonical);
  });

  it("the signatures array is outside the signed bytes", () => {
    expect(canonicalSowJSON(fixture.signing.signed)).toBe(fixture.signing.canonical);
  });

  it("the signed bytes are the prefix followed by the canonical JSON", () => {
    expect(new TextDecoder().decode(sowSignedBytes(fixture.signing.document))).toBe(
      SOW_SIG_PREFIX + fixture.signing.canonical,
    );
  });

  it("the pinned signature verifies", () => {
    const [sig] = fixture.signing.signed.signatures;
    expect(verifySowSignature(fixture.signing.signed, sig)).toBe(true);
    expect(sig.key).toBe(fixture.identities.sender);
    expect(sig.role).toBe("provider");
  });

  for (const path of fixture.signing.tamper.fields) {
    it(`tampering with ${path} breaks the signature`, () => {
      const doc = JSON.parse(JSON.stringify(fixture.signing.signed));
      const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
      let node = doc;
      for (const p of parts.slice(0, -1)) node = node[p];
      const leaf = parts[parts.length - 1];
      node[leaf] = typeof node[leaf] === "number" ? node[leaf] + 1 : `${node[leaf]}x`;
      expect(verifySowSignature(doc, doc.signatures[0])).toBe(false);
    });
  }

  it("re-signing the pinned document reproduces the pinned signature exactly", () => {
    const kp = keyPairFromSeed(fixture.identities.sender_seed);
    const resigned = signSow(
      fixture.signing.document,
      kp,
      "provider",
      fixture.signing.signed.signatures[0].signed_at,
    );
    expect(resigned.signatures[0].sig).toBe(fixture.signing.signed.signatures[0].sig);
  });

  it("agreed means BOTH roles verified over the SAME bytes", () => {
    // The second seat needs a second key, which the repository deliberately
    // does not publish, so it is generated here rather than pinned.
    const providerKp = keyPairFromSeed(fixture.identities.sender_seed);
    const clientKp = keyPairFromSeed(createAgentIdentity().seed);
    const oneSided = signSow(fixture.signing.document, providerKp, "provider");
    expect(sowAgreed(oneSided)).toBe(false);

    const both = signSow(oneSided, clientKp, "client");
    expect(sowAgreed(both)).toBe(true);

    // §6: "over the same canonical bytes" — moving the cap after the fact
    // invalidates both, because both cover the price clause.
    const moved = JSON.parse(JSON.stringify(both));
    moved.price.cap.amount += 1;
    expect(sowAgreed(moved)).toBe(false);
  });
});

// ── §5.5.8 the operator fee ─────────────────────────────────────────────────

describe("§5.5.8 operator fee — the shape", () => {
  for (const row of fixture.operator_fee.valid) {
    it(`accepts ${row.case}`, () => {
      expect(() => validateOperatorFee(row.fee)).not.toThrow();
      // Since 0.9.0-draft every line the fixture calls valid also CLOSES: the
      // check is exact, so there is no longer a conformant line whose amount is
      // near its basis rather than equal to it. A shape-valid line that does not
      // close now lives in `arithmetic` with `closes: false`.
      expect(checkOperatorFee(row.fee).ok).toBe(true);
    });
  }

  for (const row of fixture.operator_fee.invalid) {
    it(`refuses ${row.case}`, () => {
      expect(() => validateOperatorFee(row.fee)).toThrow();
    });
  }

  it("base is required, and a client node MUST NOT infer it", () => {
    // The sentence this pins is the reason the member exists: ten percent of
    // the provider's price and ten percent of the buyer's total are different
    // numbers from the same percentage.
    expect(() =>
      validateOperatorFee({ basis: { kind: "percent", percent: 10 }, amount: 250000 }),
    ).toThrow(/MUST NOT infer the base/);
  });
});

describe("§5.5.8 operator fee — the arithmetic floors, and the check is exact", () => {
  it("the specification's own worked example: ten percent of 2500000 is 250000", () => {
    const spec = fixture.operator_fee.valid[0];
    expect(spec.fee.base).toBe(2500000);
    expect(spec.fee.amount).toBe(250000);
    expect(operatorFeeAmount(spec.fee.basis, spec.fee.base)).toBe(250000);
    expect(checkOperatorFee(spec.fee)).toEqual({ ok: true });
  });

  for (const row of fixture.operator_fee.arithmetic.cases) {
    it(`${row.case}${row.closes ? "" : " (rejected)"}`, () => {
      expect(checkOperatorFee(row.fee).ok).toBe(row.closes);
    });
  }

  for (const row of fixture.operator_fee.computed.cases) {
    const label =
      row.basis.kind === "percent" ? `${row.basis.percent}% of ${row.base}` : `a fixed ${row.basis.fixed}`;
    it(`${label} is ${row.amount}, by flooring, and there is no other answer`, () => {
      expect(operatorFeeAmount(row.basis, row.base)).toBe(row.amount);
      // The one-argument signature IS the assertion: there is no rounding
      // parameter to pass, because §5.5.8 states the rule and leaves no choice.
      expect(operatorFeeAmount.length).toBe(2);
    });
  }

  it("the constructor computes the amount and refuses one that does not close", () => {
    const fee = operatorFee({
      operator: "acme-mesh.example",
      basis: { kind: "percent", percent: 10 },
      base: 2500000,
    });
    expect(fee).toEqual({
      operator: "acme-mesh.example",
      basis: { kind: "percent", percent: 10 },
      base: 2500000,
      amount: 250000,
    });
    expect(() =>
      operatorFee({ basis: { kind: "percent", percent: 10 }, base: 2500000, amount: 400000 }),
    ).toThrow(/5\.5\.8/);
  });

  it("the one-whole-unit tolerance is withdrawn: a line one unit out is now refused", () => {
    // The verdict change 0.9.0-draft makes on bytes that already exist. Both of
    // these closed under 0.8.0-draft, because the subsection defined no field
    // for a rounding rule so the fallback always applied.
    const over: SowOperatorFee = { basis: { kind: "percent", percent: 10 }, base: 2500000, amount: 250001 };
    const under: SowOperatorFee = { basis: { kind: "percent", percent: 10 }, base: 2500000, amount: 249999 };
    for (const fee of [over, under]) {
      const verdict = checkOperatorFee(fee);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.why).toMatch(/no tolerance/);
    }
  });

  it("a percentage too small to earn a whole unit earns nothing, and a fixed basis says so", () => {
    // §5.5.8's own instruction, and the change that made the platform's own
    // disclosed line restate itself: a percentage floors to nothing here, and
    // an operator that means to charge the unit states the charge.
    const floored = operatorFee({ basis: { kind: "percent", percent: 10 }, base: 5 });
    expect(floored.amount).toBe(0);
    expect(() =>
      operatorFee({ basis: { kind: "percent", percent: 10 }, base: 5, amount: 1 }),
    ).toThrow(/floors to 0/);
    const stated = operatorFee({ basis: { kind: "fixed", fixed: 1 }, base: 5 });
    expect(stated).toEqual({ basis: { kind: "fixed", fixed: 1 }, base: 5, amount: 1 });
    expect(checkOperatorFee(stated).ok).toBe(true);
  });

  it("no rounding rule is serialized, because the line has nowhere to state one", () => {
    const line = operatorFee({ basis: { kind: "percent", percent: 10 }, base: 5 });
    expect(Object.keys(line).sort()).toEqual(["amount", "base", "basis"]);
    expect(checkOperatorFee(line).ok).toBe(true);
  });
});

describe("§5.5.3 + §5.5.8 — the cap bounds what the client pays, fee included", () => {
  it("the boundary rule the fixture pins is maximal fit", () => {
    expect(fixture.operator_fee.cap.rule).toBe("maximal_fit");
  });

  for (const row of fixture.operator_fee.cap.cases) {
    it(`${row.case} — ${row.why}`, () => {
      const basis = row.basis ?? undefined;
      const fit = maxRatedTotalUnderCap(row.cap_remaining, basis);
      expect(fit).toBe(row.max_rated_total);
      // The fee that fit takes, and the client total it produces.
      const fee = basis === undefined || fit === 0 ? 0 : operatorFeeAmount(basis, fit);
      expect(fee).toBe(row.fee);
      expect(fit + fee).toBe(row.client_total);
      // The two halves of "maximal": it FITS, and one more unit does not.
      expect(fit + fee).toBeLessThanOrEqual(row.cap_remaining);
      if (basis !== undefined) {
        const next = fit + 1;
        expect(next + operatorFeeAmount(basis, next)).toBeGreaterThan(row.cap_remaining);
      }
    });
  }

  it("the closed form is NOT the rule: 100 at ten percent admits 91, not 90", () => {
    // Pinned as its own test as well as a fixture row, because this is the one
    // number a second implementation writing only from the specification gets
    // wrong. floor(100 * 100 / 110) is 90 and 90 is conformant; 91 is also
    // conformant and is the answer both SDKs give.
    expect(Math.floor((100 * 100) / 110)).toBe(90);
    expect(maxRatedTotalUnderCap(100, { kind: "percent", percent: 10 })).toBe(91);
    expect(91 + operatorFeeAmount({ kind: "percent", percent: 10 }, 91)).toBe(100);
    expect(92 + operatorFeeAmount({ kind: "percent", percent: 10 }, 92)).toBe(101);
  });

  it("a quote and a settlement record are asserted against the cap where one is in play", () => {
    const fee = operatorFee({ basis: { kind: "percent", percent: 10 }, base: 91 });
    expect(quoteWithOperatorFee({ providerTotal: 91, fee, cap: 100 }).total).toBe(100);
    expect(() => quoteWithOperatorFee({ providerTotal: 92, fee, cap: 100 })).toThrow(
      /not-to-exceed cap/,
    );
    const price = timeAndMaterialsPrice({
      currency: "XCR",
      schedule: [{ meter: "tool_calls", unit: "call", per_unit: 1 }],
      cap: { amount: 100 },
      reservation: { window_days: 7 },
    });
    const rating = rateUsage(price, [{ meter: "tool_calls", count: 200 }], {
      operatorFeeBasis: { kind: "percent", percent: 10 },
    });
    // The record's fee defaults to the one the rating took, so a caller cannot
    // clamp the work for a cut and then forget to disclose it.
    const record = settlementWithOperatorFee({ rating, cap: price.cap.amount });
    expect(record.total).toBe(100);
    expect(record.operator_fee).toEqual(rating.operator_fee);
    expect(settlementTotal(record)).toBe(100);
    expect(providerNet(record)).toBe(91);
  });

  it("nothing changes for a caller with no operator in the path", () => {
    // The peer-to-peer path, which is what the adapter and the services helper
    // use: `client_total` is the total, `cap_remaining` is the old number, and
    // no line appears.
    const price = timeAndMaterialsPrice({
      currency: "XCR",
      schedule: [{ meter: "tool_calls", unit: "call", per_unit: 1000 }],
      cap: { amount: 5000 },
      reservation: { window_days: 7 },
    });
    const rated = rateUsage(price, [{ meter: "tool_calls", count: 3 }]);
    expect(rated.total).toBe(3000);
    expect(rated.client_total).toBe(3000);
    expect(rated.cap_remaining).toBe(2000);
    expect(rated.exhausted).toBe(false);
    expect(rated.operator_fee).toBeUndefined();
    expect(maxRatedTotalUnderCap(2000)).toBe(2000);
  });
});

describe("§5.5.8 operator fee — the grades, never claimed upward", () => {
  it("the basis itself is evidence, always", () => {
    expect(OPERATOR_FEE_BASIS_GRADE).toBe(fixture.operator_fee.grade.basis);
    expect(OPERATOR_FEE_BASIS_GRADE).toBe("evidence");
  });

  for (const row of fixture.operator_fee.grade.cases) {
    const label = `quote built by operator: ${row.operator_built_quote}, settled by operator: ${row.operator_settled}`;
    it(`${label} → ${row.grade}`, () => {
      expect(
        operatorFeeGrade({
          operatorBuiltQuote: row.operator_built_quote,
          operatorSettled: row.operator_settled,
        }),
      ).toBe(row.grade);
    });
  }
});

describe("§5.5.8 operator fee — disclosure binds at both moments", () => {
  const providerPrice = timeAndMaterialsPrice({
    currency: "XCR",
    schedule: [{ meter: "items", unit: "invoice", per: 1, per_unit: 2500000 }],
    cap: { amount: 40000000 },
    reservation: { window_days: 30 },
  });

  it("the quote carries the line beside the total, before commitment", () => {
    const fee = operatorFee({
      operator: "acme-mesh.example",
      basis: { kind: "percent", percent: 10 },
      base: 2500000,
    });
    const quote = quoteWithOperatorFee({ providerTotal: 2500000, fee, currency: "XCR" });
    expect(quote).toEqual({ total: 2750000, currency: "XCR", operator_fee: fee });
    // What disclosure reveals, stated rather than discovered.
    expect(providerNet(quote)).toBe(2500000);
  });

  it("the fee survives rating and lands in the settlement record", () => {
    const rating = rateUsage(providerPrice, [{ meter: "items", count: 1 }]);
    expect(rating.total).toBe(2500000);
    const fee = operatorFee({ basis: { kind: "percent", percent: 10 }, base: rating.total });
    const record = settlementWithOperatorFee({ rating, fee });

    expect(record.operator_fee).toEqual(fee);
    expect(record.total).toBe(2750000);
    // The record's own lines account for its total: the rated work plus the
    // operator's cut, which is the shape §5.5.6 gives a pass-through line.
    expect(settlementTotal(record)).toBe(record.total);
    expect(providerNet(record)).toBe(rating.total);

    // And the quote it was made against accepts it.
    const quote = quoteWithOperatorFee({ providerTotal: rating.total, fee, currency: "XCR" });
    expect(checkSettlement(quote, record)).toEqual({ settled: true });
  });

  it("a quote with no fee produces a record with no fee, and both are well formed", () => {
    const rating = rateUsage(providerPrice, [{ meter: "items", count: 1 }]);
    const quote = quoteWithOperatorFee({ providerTotal: rating.total, currency: "XCR" });
    const record = settlementWithOperatorFee({ rating });
    expect(quote.operator_fee).toBeUndefined();
    expect(record.operator_fee).toBeUndefined();
    expect(checkSettlement(quote, record)).toEqual({ settled: true });
  });
});

describe("§5.5.8 operator fee — the client node's read of a settlement record", () => {
  for (const row of fixture.operator_fee.settlement.cases) {
    it(`${row.case} → ${row.settled ? "settled" : row.reason}`, () => {
      const verdict = checkSettlement(row.quote, row.record);
      expect(verdict.settled).toBe(row.settled);
      if (verdict.settled) {
        expect(providerNet(row.record)).toBe(row.provider_net);
      } else {
        expect(verdict.disputed.reason).toBe(row.reason);
      }
    });
  }

  it("a disputed settlement holds BOTH documents, exactly as they were compared", () => {
    const row = fixture.operator_fee.settlement.cases.filter((c) => !c.settled)[0];
    const verdict = checkSettlement(row.quote, row.record);
    expect(verdict.settled).toBe(false);
    if (verdict.settled) return;
    expect(verdict.disputed.quote).toEqual(row.quote);
    expect(verdict.disputed.record).toEqual(row.record);
    expect(verdict.disputed.detail).toContain("5.5.8");
  });

  it("the client node MUST NOT repair the record", () => {
    const row = fixture.operator_fee.settlement.cases.filter(
      (c) => c.reason === "operator_fee_missing",
    )[0];
    const verdict = checkSettlement(row.quote, row.record);
    expect(verdict.settled).toBe(false);
    if (verdict.settled) return;
    const held = verdict.disputed.record as SowSettlementRecord;
    // Supplying the missing line is exactly the repair §5.5.8 forbids: a
    // record the client rewrote is no longer evidence of what the operator
    // claimed. The held copy refuses the write rather than trusting that
    // nobody tries it.
    expect(Object.isFrozen(held)).toBe(true);
    expect(() => {
      (held as { operator_fee?: SowOperatorFee }).operator_fee = row.quote.operator_fee;
    }).toThrow(TypeError);
    // Recomputing the total is the other half of the same prohibition.
    expect(() => {
      (held as { total: number }).total = 0;
    }).toThrow(TypeError);
    expect(held.operator_fee).toBeUndefined();
    expect(Object.isFrozen(held.lines)).toBe(true);
    expect(Object.isFrozen(verdict.disputed.quote.operator_fee)).toBe(true);
    // No repair function is exported. The module offers exactly one verdict.
  });

  it("mutating the caller's own copies afterwards does not change the held evidence", () => {
    const quote: SowQuote = {
      total: 2750000,
      currency: "XCR",
      operator_fee: { basis: { kind: "percent", percent: 10 }, base: 2500000, amount: 250000 },
    };
    const record: SowSettlementRecord = {
      total: 2750000,
      currency: "XCR",
      lines: [{ meter: "items", unit: "invoice", count: 1, per: 1, per_unit: 2500000, amount: 2500000 }],
    };
    const verdict = checkSettlement(quote, record);
    expect(verdict.settled).toBe(false);
    if (verdict.settled) return;
    record.total = 1;
    expect(verdict.disputed.record.total).toBe(2750000);
  });

  it("one discrepancy is not grounds to stop; a second one is", () => {
    expect(refuseFurtherWorkUnderOperator(0)).toBe(false);
    expect(refuseFurtherWorkUnderOperator(1)).toBe(false);
    expect(
      refuseFurtherWorkUnderOperator(fixture.operator_fee.settlement.refuse_further_work_after),
    ).toBe(true);
    expect(refuseFurtherWorkUnderOperator(5)).toBe(true);
  });

  it("a no_charge engagement has no total for a fee to sit inside", () => {
    expect(fixture.operator_fee.no_charge.carries_a_line).toBe(false);
    const free = noChargePrice();
    expect(settles(free)).toBe(false);
    // Nothing rates, so there is no rating to build a record from, so there is
    // nowhere a fee line could be attached in the first place.
    expect(() => rateUsage(free as unknown as SowTimeAndMaterialsPrice, [])).toThrow(/no_charge/);
  });
});
