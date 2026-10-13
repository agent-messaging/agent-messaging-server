// Trials (Common Agent 7.7, with 7.5's trial allowance scope), asserted case
// by case against conformance/trial.json. Like the other conformance suites
// this file ITERATES the fixture instead of restating it.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix src/ to agree
// with the fixture, never the fixture to agree with the code.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nkeys } from "nats.ws";
import {
  MemoryTrialLedger,
  TRIAL_REASONS,
  quoteFromPrice,
  trialAdmission,
  validateTrial,
  type TrialDeclaration,
  type TrialFunds,
  type TrialRequester,
} from "../../src/trial.js";
import { AllowanceEngine, signAllowance, type AllowanceCeiling } from "../../src/allowance.js";
import { ErrorCode } from "../../src/types/errors.js";

const here = dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(readFileSync(join(here, "..", "..", "..", "conformance", "trial.json"), "utf8"));
const A = JSON.parse(readFileSync(join(here, "..", "..", "..", "conformance", "allowance.json"), "utf8"));

const explainer = F.declarations.valid.find((d: { case: string }) => d.case === "explainer").trial as TrialDeclaration;
const now = new Date(F.admission.now);
const quote = quoteFromPrice({ model: "flat", amount_micro: F.admission.quote.amount_micro, currency: F.admission.quote.currency });

/** The fixture's "500+1" stands for a string of 501 characters. */
function expand(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const m = /^(\d+)\+(\d+)$/.exec(v);
  return m ? "x".repeat(Number(m[1]) + Number(m[2])) : v;
}

describe("conformance/trial.json", () => {
  it("names the code and the closed reasons the SDK uses", () => {
    expect(F.code).toBe(ErrorCode.TRIAL_REFUSED);
    expect([...TRIAL_REASONS]).toEqual(F.reasons);
  });

  describe("declarations", () => {
    for (const d of F.declarations.valid) {
      it(`valid: ${d.case}`, () => expect(validateTrial(d.trial, F.offering)).toBeNull());
    }
    for (const d of F.declarations.invalid) {
      it(`invalid: ${d.case} (${d.why})`, () => expect(validateTrial(d.trial, F.offering)).not.toBeNull());
    }
  });

  describe("admission", () => {
    for (const c of F.admission.cases) {
      it(c.case, () => {
        const trial = c.trial === null ? null : explainer;
        const requester: TrialRequester = { id: "req-1", ...c.requester };
        const inputs: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(c.inputs as Record<string, unknown>)) inputs[k] = expand(v);
        const [requester_day, day, requester_ever] = c.counts as number[];
        const r = trialAdmission({
          trial,
          hasBudget: c.has_budget === true,
          requester,
          inputs,
          counts: { requester_day: requester_day!, day: day!, requester_ever: requester_ever! },
          funds: { state: c.funds } as TrialFunds,
          quote,
          now,
        });
        if (c.expect.ok) {
          expect(r.ok).toBe(true);
          return;
        }
        expect(r.ok).toBe(false);
        if (r.ok) return;
        const d = r.refusal.details;
        expect(r.refusal.code).toBe(F.code);
        expect(d.reason).toBe(c.expect.reason);
        if (c.expect.limit !== undefined) expect(d.limit).toBe(c.expect.limit);
        if (c.expect.resets_at !== undefined) expect(d.resets_at).toBe(c.expect.resets_at);
        else expect(d.resets_at).toBeUndefined();
        if (c.expect.input !== undefined) expect(d.input).toBe(c.expect.input);
        expect(d.quote.amount_micro).toBe(F.admission.quote.amount_micro);
        expect(d.quote.currency).toBe(F.admission.quote.currency);
        expect(r.refusal.message.length).toBeGreaterThan(0);
      });
    }
  });

  it("counting: only admitted trials are counted, and the day resets", () => {
    const ledger = new MemoryTrialLedger();
    const requester: TrialRequester = { id: "req-1", kind: "account", signed_in: true, verified: false };
    const limited: TrialDeclaration = { ...explainer, limits: { ...explainer.limits, per_requester_per_day: 2 } };
    let admitted = 0;
    for (let i = 0; i < F.counting.requests; i++) {
      const r = trialAdmission({
        trial: limited, hasBudget: false, requester, inputs: {},
        counts: ledger.counts(requester.id, F.offering.id, now),
        funds: { state: "room" }, quote, now,
      });
      if (r.ok) { ledger.record(requester.id, F.offering.id, now); admitted++; }
      else expect(r.refusal.details.reason).toBe("requester_day");
    }
    expect(admitted).toBe(F.counting.admitted);
    const c = ledger.counts(requester.id, F.offering.id, now);
    expect([c.requester_day, c.day, c.requester_ever]).toEqual(F.counting.counts_after);
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
    const n = ledger.counts(requester.id, F.offering.id, tomorrow);
    expect(n.requester_day).toBe(F.counting.next_day_requester_day);
    expect(n.requester_ever).toBe(F.counting.counts_after[2]);
  });

  describe("allowance: the trial scope", () => {
    const owner = nkeys.fromSeed(new TextEncoder().encode(A.identities.sender_seed));
    const engineWith = (ceilings: AllowanceCeiling[]) =>
      new AllowanceEngine(
        signAllowance(
          {
            v: 1,
            agent: A.identities.recipient,
            cost_model: { per_1k_tokens_micro: 1500, currency: "USD" },
            ceilings,
            on_exhausted: "refuse",
            updated_at: "2026-10-04T15:00:00.000Z",
          },
          owner as never,
        ),
      );

    it("the closed enum is the fixture's", () => {
      for (const scope of F.allowance.scopes) {
        expect(() => engineWith([{ scope, amount_micro: 1 }])).not.toThrow();
      }
      expect(engineWith([{ scope: "trial", amount_micro: 1 }]).valid).toBe(true);
    });

    it("walks the steps: trial spend counts against the trial ceiling and the day, ordinary work only against the day", () => {
      const e = engineWith(F.allowance.ceilings);
      let task = 0;
      for (const s of F.allowance.steps) {
        const id = `t${task++}`;
        if (s.spend_micro !== undefined) {
          e.record(id, undefined, { cost_micro: s.spend_micro }, now, { trial: s.trial });
          const view = e.ledgerView();
          const day = now.toISOString().slice(0, 10);
          const trialCeil = F.allowance.ceilings.find((c: { scope: string }) => c.scope === "trial").amount_micro;
          const dayCeil = F.allowance.ceilings.find((c: { scope: string }) => c.scope === "day").amount_micro;
          expect(trialCeil - (view.by_trial_day[day] ?? 0)).toBe(s.then.trial_remaining);
          expect(dayCeil - (view.by_day[day] ?? 0)).toBe(s.then.day_remaining);
        } else {
          const fits = s.trial
            ? e.trialFunds(id, undefined, s.estimate_micro, now).state === "room"
            : e.decide(id, undefined, s.estimate_micro, now).fits;
          expect(fits ? "room" : "full").toBe(s.expect);
        }
      }
    });

    it("no trial ceiling answers none", () => {
      const e = engineWith(F.allowance.no_trial_ceiling.ceilings);
      expect(e.trialFunds("t", undefined, 1, now).state).toBe(F.allowance.no_trial_ceiling.trial_answer);
    });

    it("a configured document that fails verification answers full (fail closed)", () => {
      const e = new AllowanceEngine({ v: 1, ceilings: [{ scope: "trial", amount_micro: 5 }] });
      expect(e.trialFunds("t", undefined, 1, now).state).toBe("full");
    });
  });
});
