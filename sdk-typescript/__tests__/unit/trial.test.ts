import { describe, expect, it } from "vitest";
import {
  MemoryTrialLedger,
  quoteFromPrice,
  trialAdmission,
  validateDescriptorTrials,
  validateTrial,
  workCaps,
  type TrialDeclaration,
  type TrialRequester,
} from "../../src/trial.js";
import { ErrorCode } from "../../src/types/errors.js";

const offering = {
  id: "make-an-explainer",
  inputs: [{ name: "focus" }, { name: "customer web address" }, { name: "brief" }],
  outputs: [{ name: "explainer page" }, { name: "thumbnail" }],
};

const trial: TrialDeclaration = {
  who: "signed_in",
  shape: {
    inputs: [
      { name: "focus", limit: { max_chars: 500 } },
      { name: "customer web address", limit: { max_pages: 10 } },
    ],
    live_seconds: 180,
    keeps_days: 7,
    marked: true,
  },
  limits: { per_requester_per_day: 2, per_day: 50, per_requester_ever: 5 },
};

const person: TrialRequester = { id: "account:a1", kind: "account", signed_in: true, verified: false };
const visitor: TrialRequester = { id: "visitor:vis_1", kind: "visitor", signed_in: false, verified: false };
const quote = quoteFromPrice({ model: "flat", amount_micro: 5_000_000, currency: "USD" });
const now = new Date("2026-10-05T03:00:00Z");
const zero = { requester_day: 0, day: 0, requester_ever: 0 };

const admit = (over: Partial<Parameters<typeof trialAdmission>[0]> = {}) =>
  trialAdmission({ trial, hasBudget: false, requester: person, inputs: { brief: "x" }, counts: zero, funds: { state: "room" }, quote, now, ...over });

describe("the trial declaration", () => {
  it("accepts the explainer's declaration", () => {
    expect(validateTrial(trial, offering)).toBeNull();
  });
  it("refuses a trial with no count", () => {
    expect(validateTrial({ who: "anyone", limits: {} }, offering)).toMatch(/no count/);
    expect(validateTrial({ who: "anyone" }, offering)).toMatch(/limits is required/);
  });
  it("refuses money in limits, an unknown who, and a shape naming an undeclared input", () => {
    expect(validateTrial({ who: "anyone", limits: { per_day: 3, usd_per_day: 5 } }, offering)).toMatch(/never money/);
    expect(validateTrial({ who: "friends", limits: { per_day: 3 } }, offering)).toMatch(/who/);
    expect(validateTrial({ who: "anyone", limits: { per_day: 3 }, shape: { inputs: [{ name: "nope", limit: { max_chars: 5 } }] } }, offering)).toMatch(/does not declare/);
  });
  it("names the offering whose trial fails in a Descriptor", () => {
    expect(validateDescriptorTrials({ offerings: [{ ...offering, trial: { who: "anyone", limits: {} } }] })).toMatch(/^offering make-an-explainer/);
    expect(validateDescriptorTrials({ offerings: [{ ...offering, trial }], samples_ref: "https://x.example/s.json" })).toBeNull();
  });
  it("hands limits only the work can measure to the work", () => {
    expect(workCaps(trial.shape)).toEqual([{ input: "customer web address", limit: { max_pages: 10 } }]);
  });
});

describe("admission, in the specification's order", () => {
  it("admits a fitting trial", () => {
    expect(admit()).toEqual({ ok: true });
  });
  it("refuses a trial carrying a budget first, with a quote", () => {
    const r = admit({ hasBudget: true, trial: null });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.code).toBe(ErrorCode.TRIAL_REFUSED);
      expect(r.refusal.details.reason).toBe("budget");
      expect(r.refusal.details.quote.amount_micro).toBe(5_000_000);
    }
  });
  it("refuses an offering with no trial, then a visitor under signed_in, then an input over its limit", () => {
    const a = admit({ trial: null });
    expect(!a.ok && a.refusal.details.reason).toBe("not_offered");
    const b = admit({ requester: visitor });
    expect(!b.ok && b.refusal.details.reason).toBe("not_eligible");
    const c = admit({ inputs: { focus: "x".repeat(501) } });
    expect(!c.ok && c.refusal.details).toMatchObject({ reason: "input", input: "focus", max: { max_chars: 500 } });
  });
  it("refuses past each count with its limit, and a reset where waiting helps", () => {
    const a = admit({ counts: { requester_day: 2, day: 2, requester_ever: 2 } });
    expect(!a.ok && a.refusal.details).toMatchObject({ reason: "requester_day", limit: 2, resets_at: "2026-10-06T00:00:00.000Z" });
    const b = admit({ counts: { requester_day: 0, day: 50, requester_ever: 0 } });
    expect(!b.ok && b.refusal.details).toMatchObject({ reason: "day", limit: 50 });
    const c = admit({ counts: { requester_day: 0, day: 0, requester_ever: 5 } });
    expect(!c.ok && c.refusal.details.reason).toBe("requester_ever");
    expect(!c.ok && c.refusal.details.resets_at).toBeUndefined();
  });
  it("refuses on funds when no trial ceiling is set, never spending unbounded", () => {
    const r = admit({ funds: { state: "none" } });
    expect(!r.ok && r.refusal.details.reason).toBe("funds");
    expect(!r.ok && r.refusal.message).toMatch(/\$5\.00/);
  });
  it("counts only what is admitted, per requester per UTC day", () => {
    const ledger = new MemoryTrialLedger();
    for (let i = 0; i < 3; i++) {
      const r = admit({ counts: ledger.counts(person.id, offering.id, now) });
      if (r.ok) ledger.record(person.id, offering.id, now);
    }
    expect(ledger.counts(person.id, offering.id, now)).toEqual({ requester_day: 2, day: 2, requester_ever: 2 });
    expect(ledger.counts(person.id, offering.id, new Date("2026-10-06T01:00:00Z")).requester_day).toBe(0);
  });
});
