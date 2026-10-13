/**
 * Agent SoW pricing arrangements (Agent SoW spec 0.9.0-draft, §5.5).
 *
 * An Agent SoW engagement declares exactly one **pricing arrangement**: work is
 * priced per task at a published rate (`fixed_fee`, §5.5.1), as a rate schedule
 * over declared meters (`time_and_materials`, §5.5.2), or not at all
 * (`no_charge`, §5.5.7). There is no undeclared default — a price clause naming
 * no arrangement is a validation error, and a runtime MUST refuse a proposal
 * that carries one.
 *
 * `no_charge` exists so that free work has an arrangement it can declare
 * honestly. The alternative, a fixed fee of zero, puts the decision in a magic
 * value a reader cannot tell apart from a price nobody filled in. The clause
 * carries the arrangement and its grade and NO price field of any kind:
 * {@link SowNoChargePrice} types `currency`, `rates`, `schedule`, `cap`,
 * `reservation` and `ceiling` as `never`, so a clause carrying one does not
 * compile, and {@link validateSowPrice} refuses one arriving off the wire.
 * Nothing settles under it either — {@link rateUsage} refuses to rate it and
 * {@link admitSettlement} is the client node's refusal of a settlement record
 * that cites one.
 *
 * Four properties carry the time-and-materials design:
 *
 *  - **The cap and the reservation are not optional.** §5.5.3: there is no
 *    uncapped time and materials engagement, and §5.5.4: no unreserved one
 *    either. `SowTimeAndMaterialsPrice.cap` and `.reservation` are both required
 *    fields, so a clause missing either does not typecheck, and
 *    `validateSowPrice` refuses one arriving off the wire. The cap is a
 *    not-to-exceed number, not a forecast: units the provider incurs past it are
 *    the provider's to bear. The reservation is what makes the arrangement a
 *    purchase order rather than an open account.
 *  - **The metered unit is machine-readable.** §5.5.2: a schedule line carries
 *    `per`, the divisor turning raw meter counts into billable units, and `unit`
 *    is only a label. Rating happens on raw counts, so the buyer hands in the
 *    token count it reads off its own records.
 *  - **Reaching the cap is not a failure.** §5.5.5: the engagement moves to
 *    `exhausted`, a task in flight ends `exhausted` with its artifacts
 *    attached, and a runtime MUST NOT record either as failed. `exhausted` sits
 *    beside `lapsed` and `terminated` in §7.1 as a way an engagement ends.
 *  - **Materials are billed at cost, with proof.** §5.5.6: a resold line is
 *    marked `pass_through` and every settlement record for it references the
 *    upstream receipt. A pass-through line MUST NOT be priced above the
 *    upstream cost; a provider wanting margin prices its own metered line.
 *  - **The cap bounds what the CLIENT pays, fee included.** §5.5.3 and §5.5.8:
 *    an operator fee is not charged on top of the cap, so the provider's rated
 *    work runs to the cap less the fee taken on it and reaching that limit
 *    concludes the engagement `exhausted` in the ordinary way. {@link rateUsage}
 *    takes the fee's basis and clamps on the client's exposure;
 *    {@link maxRatedTotalUnderCap} is where the boundary rule is pinned.
 *
 * Money is computed ONE way here: by flooring. §5.5.2 floors a rated line and
 * §5.5.8 floors an operator fee, so two implementations doing integer
 * arithmetic cannot disagree by one and the fee check is exact rather than
 * tolerant.
 *
 * The two §6.2 organizational-authority fields live here too: `organization` on
 * a party and `mandate` on an approval record. Both sit INSIDE the signed
 * bytes, so neither can be added, removed or altered after signing without
 * breaking the signature, and both are additive — a document that omits them is
 * conformant. A runtime that does not perform the Agent Mandate §7 checks MUST
 * NOT present a document carrying them as mandate-verified.
 *
 * Shapes pinned by `conformance/sow-pricing.json`, which the Rust SDK reads
 * from the same file. The canonical bytes are the contract between them.
 *
 * @see https://agentsow.com — the specification this module implements.
 */

import { MeshError, ErrorCode } from "./types/errors.js";
import {
  canonicalJSON,
  signTagged,
  verifyTagged,
  toB64Url,
  fromB64Url,
  type KeyPair,
} from "./internal/identity.js";

/** The domain tag inside an Agent SoW document's signed bytes (§6): each `sig`
 *  covers this prefix + the JCS canonical JSON of the document with the
 *  `signatures` array removed. The prefix exists only inside the signed bytes —
 *  it never appears in the document itself. */
export const SOW_SIG_PREFIX = "agent-sow-v1\n";

// ── §2 / §5.5: the pricing arrangement ──────────────────────────────────────

/** The basis on which an engagement prices work (§2, §5.5). Every engagement
 *  declares one; there is no undeclared default. */
export type PricingArrangement = "fixed_fee" | "time_and_materials" | "no_charge";

/** The closed set. A price clause naming anything else is a validation error. */
export const PRICING_ARRANGEMENTS: ReadonlySet<string> = new Set<PricingArrangement>([
  "fixed_fee",
  "time_and_materials",
  "no_charge",
]);

/** The enforcement gradient (§3). Every clause object carries one (§4.2). */
export type SowGrade = "enforced" | "evidence" | "recorded";

const SOW_GRADES: ReadonlySet<string> = new Set<SowGrade>(["enforced", "evidence", "recorded"]);

/** The window a spend ceiling is measured over (§5.5.1). */
export type SowPeriod = "month";

// ── §5.5.1: fixed fee ───────────────────────────────────────────────────────

/** One published rate: this offering costs this much per task. Money is an
 *  integer in the smallest unit of the clause's `currency` — never a float. */
export interface SowFixedFeeRate {
  offering: string;
  per_task: number;
}

/** An optional spend ceiling per period (§5.5.1). Work beyond it is refused
 *  with a quote rather than performed and billed. */
export interface SowCeiling {
  amount: number;
  period: SowPeriod;
}

/** §5.5.1 — rates per offering, the settlement currency, an optional ceiling.
 *  The price of a task is known before the task runs. */
export interface SowFixedFeePrice {
  arrangement: "fixed_fee";
  currency: string;
  rates: SowFixedFeeRate[];
  ceiling?: SowCeiling;
  grade: SowGrade;
}

// ── §5.5.2: time and materials ──────────────────────────────────────────────

/**
 * One line of a rate schedule (§5.5.2): a meter, the divisor that turns its
 * raw counts into billable units, the price of one unit, and a label a person
 * reads.
 *
 * `per` is the divisor — how many raw meter counts make one billable unit. A
 * positive integer, defaulting to 1. `unit` is a LABEL FOR PEOPLE and carries
 * no arithmetic: a runtime MUST rate on `per` and MUST NOT parse `unit`.
 *
 * That split is the buyer's protection, not decoration. Time and materials has
 * no deliverable to accept (§5.5.5), so all the buyer has is a meter it can
 * check independently — and a unit of "1000 tokens" that only a human can
 * convert defeats exactly that. The divisor puts the conversion inside the
 * signed bytes, where both parties compute the same charge from the same
 * counts.
 *
 * `pass_through` marks a line the provider bought elsewhere (§5.5.6). It is
 * billed at cost against an upstream receipt, never above it.
 */
export interface SowScheduleLine {
  meter: string;
  unit: string;
  /** The divisor (§5.5.2). Positive integer; defaults to 1 when absent. */
  per?: number;
  per_unit: number;
  pass_through?: boolean;
}

/** The divisor a line rates by: its `per`, or 1 when it names none (§5.5.2). */
export function divisorOf(line: SowScheduleLine): number {
  return line.per ?? 1;
}

/**
 * What one line charges for a raw meter count: `floor(count × per_unit / per)`
 * (§5.5.2).
 *
 * The floor is deliberate and it favours the buyer — a partial unit never
 * charges a partial unit's money. The arithmetic runs in BigInt because
 * `count × per_unit` overflows a double long before either factor does, and
 * two SDKs that disagree by one micro-unit are two SDKs that disagree about
 * the bill.
 */
export function rateLine(line: SowScheduleLine, count: number): number {
  if (!isNonNegInt(count)) invalid(`the count for '${line.meter}' must be a non-negative integer`);
  const amount =
    (BigInt(count) * BigInt(line.per_unit)) / BigInt(divisorOf(line));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid(`rating '${line.meter}' overflows an exact integer — split the settlement`);
  }
  return Number(amount);
}

/** The not-to-exceed cap (§5.5.3). Mandatory on every time and materials
 *  engagement: there is no uncapped one, and this is the single number an Agent
 *  Mandate ceiling check tests before formation. */
export interface SowCap {
  amount: number;
}

/** The reservation window (§5.5.4). Funds are reserved for the cap amount when
 *  the engagement forms and the unused remainder is released at the end of the
 *  window. The window MUST NOT extend beyond `ends_at`. */
export interface SowReservation {
  window_days: number;
}

/** §5.5.2 — a rate schedule over declared meters, with the mandatory §5.5.3
 *  cap and the mandatory §5.5.4 reservation. Both are REQUIRED: a time and
 *  materials price missing either does not typecheck and does not validate.
 *  The arrangement is a purchase order, and a purchase order that commits no
 *  funds and names no period has no defined settlement behaviour. */
export interface SowTimeAndMaterialsPrice {
  arrangement: "time_and_materials";
  currency: string;
  schedule: SowScheduleLine[];
  /** REQUIRED (§5.5.3). Never make this optional. */
  cap: SowCap;
  /** REQUIRED (§5.5.4). Never make this optional. */
  reservation: SowReservation;
  grade: SowGrade;
}

// ── §5.5.7: no charge ───────────────────────────────────────────────────────

/**
 * §5.5.7 — the provider charges nothing for the work.
 *
 * The clause carries the arrangement and its grade and nothing else. Every
 * price field §5.5 defines is typed `never` here, so a clause carrying one does
 * not compile: there is no rate to state, no ceiling to test, and no cap to
 * reserve against. The list is exhaustive on purpose — §5.5.7 refuses
 * `currency`, `rates`, `schedule`, `cap`, `reservation`, `ceiling` "or any
 * other price field", and {@link validateSowPrice} enforces that wider rule for
 * untyped callers by refusing any member beyond `arrangement` and `grade`.
 *
 * Everything else about the engagement is ordinary. It forms, amends,
 * terminates and lapses like any other, produces the same task and evidence
 * records, and may be reviewed under §15 — so an agent that works for nothing
 * still earns a reputation from the work.
 */
export interface SowNoChargePrice {
  arrangement: "no_charge";
  grade: SowGrade;
  /** §5.5.7: there is no settlement currency, because nothing settles. */
  currency?: never;
  /** §5.5.7: there is no rate to state. */
  rates?: never;
  /** §5.5.7: there is no schedule to meter. */
  schedule?: never;
  /** §5.5.7: there is no cap to reserve against. */
  cap?: never;
  /** §5.5.7: nothing is reserved, because nothing is drawn. */
  reservation?: never;
  /** §5.5.7: there is no ceiling to test. */
  ceiling?: never;
}

/** The price clause (§5.5), discriminated on `arrangement`. */
export type SowPrice = SowFixedFeePrice | SowTimeAndMaterialsPrice | SowNoChargePrice;

// A compile-time proof of §5.5.7's refusal, checked by `tsc --noEmit` on every
// build. The test suite cannot make this assertion — `tsconfig.json` excludes
// `__tests__` and vitest does not typecheck — so the guard lives here, beside
// the type it guards. Delete the `never` fields from SowNoChargePrice and this
// stops compiling, which is the point: a clause carrying a price field must not
// be a SowPrice at all, not merely something the validator catches later.
type _Assert<T extends true> = T;
type _NotAssignable<A, B> = [A] extends [B] ? false : true;
type _NoChargeRejectsACurrency = _Assert<
  _NotAssignable<{ arrangement: "no_charge"; currency: string; grade: SowGrade }, SowPrice>
>;
type _NoChargeRejectsACap = _Assert<
  _NotAssignable<{ arrangement: "no_charge"; cap: SowCap; grade: SowGrade }, SowPrice>
>;
type _NoChargeRejectsRates = _Assert<
  _NotAssignable<{ arrangement: "no_charge"; rates: SowFixedFeeRate[]; grade: SowGrade }, SowPrice>
>;
type _NoChargeRejectsASchedule = _Assert<
  _NotAssignable<{ arrangement: "no_charge"; schedule: SowScheduleLine[]; grade: SowGrade }, SowPrice>
>;
type _NoChargeRejectsAReservation = _Assert<
  _NotAssignable<{ arrangement: "no_charge"; reservation: SowReservation; grade: SowGrade }, SowPrice>
>;
type _NoChargeRejectsACeiling = _Assert<
  _NotAssignable<{ arrangement: "no_charge"; ceiling: SowCeiling; grade: SowGrade }, SowPrice>
>;
/** The clause the specification writes IS assignable, which is the other half:
 *  the proofs above must fail for carrying a price, not for being no-charge. */
type _NoChargeItselfIsAPrice = _Assert<
  [{ arrangement: "no_charge"; grade: SowGrade }] extends [SowPrice] ? true : false
>;

export function isTimeAndMaterials(price: SowPrice): price is SowTimeAndMaterialsPrice {
  return price.arrangement === "time_and_materials";
}

export function isFixedFee(price: SowPrice): price is SowFixedFeePrice {
  return price.arrangement === "fixed_fee";
}

export function isNoCharge(price: SowPrice): price is SowNoChargePrice {
  return price.arrangement === "no_charge";
}

// ── construction ────────────────────────────────────────────────────────────

function invalid(message: string): never {
  throw new MeshError(ErrorCode.INVALID_ENVELOPE, `sow price: ${message} (§5.5)`);
}

const CURRENCY_RE = /^[A-Z]{3}$/;
const METER_NAME_RE = /^[a-z0-9_]{1,64}$/;
/** §6.2 — the Agent Mandate reference forms. */
const ORGANIZATION_REF_RE = /^org_[A-Za-z0-9_-]{1,64}$/;
const MANDATE_REF_RE = /^mnd_[A-Za-z0-9_-]{1,64}$/;

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/**
 * Build a `fixed_fee` price clause (§5.5.1).
 *
 * The arrangement is stamped here, so a caller that already constructed a fixed
 * fee price before 0.4.0 introduced the field does not have to learn about it —
 * pass what you always passed and get a conformant 0.4.0 clause back. What is
 * NOT offered is a reader that infers `fixed_fee` from a clause that names no
 * arrangement: §5.5 makes that a validation error a runtime MUST refuse, and a
 * silent upgrade at admission would be exactly the defaulting the spec forbids.
 */
export function fixedFeePrice(init: {
  currency: string;
  rates: readonly SowFixedFeeRate[];
  ceiling?: SowCeiling;
  grade?: SowGrade;
}): SowFixedFeePrice {
  const price: SowFixedFeePrice = {
    arrangement: "fixed_fee",
    currency: init.currency,
    rates: init.rates.map((r) => ({ offering: r.offering, per_task: r.per_task })),
    ...(init.ceiling !== undefined ? { ceiling: { ...init.ceiling } } : {}),
    grade: init.grade ?? "enforced",
  };
  validateSowPrice(price);
  return price;
}

/**
 * Build a `time_and_materials` price clause (§5.5.2).
 *
 * `cap` and `reservation` are required parameters, not options with defaults.
 * §5.5.3 says there is no uncapped time and materials engagement and §5.5.4
 * says there is no unreserved one, so there is no call shape here that produces
 * either. Omitting one is a compile error, and one arriving as `undefined` from
 * untyped JavaScript is refused at construction.
 */
export function timeAndMaterialsPrice(init: {
  currency: string;
  schedule: readonly SowScheduleLine[];
  cap: SowCap;
  reservation: SowReservation;
  grade?: SowGrade;
}): SowTimeAndMaterialsPrice {
  if (init.cap === undefined || init.cap === null) {
    invalid(
      "a time and materials engagement MUST carry a not-to-exceed cap — there is no uncapped " +
        "time and materials engagement (§5.5.3)",
    );
  }
  if (init.reservation === undefined || init.reservation === null) {
    invalid(
      "a time and materials engagement MUST carry a reservation with a stated window — an " +
        "arrangement that commits no funds and names no period has no defined settlement " +
        "behaviour (§5.5.4)",
    );
  }
  const price: SowTimeAndMaterialsPrice = {
    arrangement: "time_and_materials",
    currency: init.currency,
    schedule: init.schedule.map((l) => ({
      meter: l.meter,
      unit: l.unit,
      ...(l.per !== undefined ? { per: l.per } : {}),
      per_unit: l.per_unit,
      ...(l.pass_through === true ? { pass_through: true } : {}),
    })),
    cap: { amount: init.cap.amount },
    reservation: { window_days: init.reservation.window_days },
    grade: init.grade ?? "enforced",
  };
  validateSowPrice(price);
  return price;
}

/**
 * Build a `no_charge` price clause (§5.5.7).
 *
 * There is nothing to pass but the grade, and that is the whole design. The
 * init object has no slot for a currency, a rate, a schedule, a cap, a
 * reservation or a ceiling, so a caller cannot supply one by accident, and a
 * caller who casts around the type is refused by `validateSowPrice` on the way
 * out.
 */
export function noChargePrice(init: { grade?: SowGrade } = {}): SowNoChargePrice {
  const price: SowNoChargePrice = {
    arrangement: "no_charge",
    grade: init.grade ?? "enforced",
  };
  validateSowPrice(price);
  return price;
}

// ── validation ──────────────────────────────────────────────────────────────

/** The two members a `no_charge` clause may carry, and nothing else (§5.5.7). */
const NO_CHARGE_MEMBERS: ReadonlySet<string> = new Set(["arrangement", "grade"]);

/**
 * Shape check for a price clause (§5.5), per `conformance/sow-pricing.json`.
 *
 * The three refusals that matter most: a clause naming no arrangement (§5.5), a
 * time and materials clause with no cap (§5.5.3), and a no-charge clause
 * carrying a price field (§5.5.7). All three are the spec's own MUSTs and all
 * three fail closed — a proposal carrying any of them is refused rather than
 * repaired.
 */
export function validateSowPrice(v: unknown): asserts v is SowPrice {
  if (typeof v !== "object" || v === null || Array.isArray(v)) invalid("must be an object");
  const p = v as Record<string, unknown>;

  if (p.arrangement === undefined) {
    invalid("every engagement declares an arrangement — there is no undeclared default");
  }
  if (typeof p.arrangement !== "string" || !PRICING_ARRANGEMENTS.has(p.arrangement)) {
    invalid("arrangement is 'fixed_fee', 'time_and_materials' or 'no_charge'");
  }
  if (typeof p.grade !== "string" || !SOW_GRADES.has(p.grade)) {
    invalid("grade is 'enforced', 'evidence' or 'recorded' (§4.2)");
  }

  if (p.arrangement === "no_charge") {
    // §5.5.7 refuses a named list and then everything else, so this is a
    // membership check rather than six field checks: a clause carrying any
    // member beyond the arrangement and its grade is malformed.
    for (const member of Object.keys(p)) {
      if (NO_CHARGE_MEMBERS.has(member)) continue;
      invalid(
        `a no_charge clause carries the arrangement and its grade and nothing else, so it ` +
          `MUST NOT carry '${member}'. There is no rate to state, no ceiling to test, and no ` +
          "cap to reserve against (§5.5.7)",
      );
    }
    return;
  }

  if (typeof p.currency !== "string" || !CURRENCY_RE.test(p.currency)) {
    invalid("currency is a three-letter uppercase code");
  }

  if (p.arrangement === "fixed_fee") {
    if (!Array.isArray(p.rates) || p.rates.length === 0) {
      invalid("fixed_fee prices work per offering — rates must be a non-empty array");
    }
    const seen = new Set<string>();
    for (const r of p.rates as unknown[]) {
      if (typeof r !== "object" || r === null) invalid("each rate is an object");
      const rate = r as Record<string, unknown>;
      if (typeof rate.offering !== "string" || rate.offering === "") {
        invalid("each rate names an offering");
      }
      if (seen.has(rate.offering)) invalid(`two rates for offering '${rate.offering}'`);
      seen.add(rate.offering);
      if (!isNonNegInt(rate.per_task)) {
        invalid("per_task is a non-negative integer in the smallest unit of currency");
      }
    }
    if (p.ceiling !== undefined) validateCeiling(p.ceiling);
    if (p.schedule !== undefined) invalid("a fixed_fee clause carries no schedule");
    if (p.cap !== undefined) invalid("a fixed_fee clause carries no cap — it carries a ceiling");
    return;
  }

  // time_and_materials
  if (!Array.isArray(p.schedule) || p.schedule.length === 0) {
    invalid("time_and_materials is a rate schedule — schedule must be a non-empty array");
  }
  const meters = new Set<string>();
  for (const l of p.schedule as unknown[]) {
    if (typeof l !== "object" || l === null) invalid("each schedule line is an object");
    const line = l as Record<string, unknown>;
    if (typeof line.meter !== "string" || !METER_NAME_RE.test(line.meter)) {
      invalid("each schedule line names a meter matching ^[a-z0-9_]{1,64}$");
    }
    if (meters.has(line.meter)) invalid(`the schedule prices '${line.meter}' twice`);
    meters.add(line.meter);
    if (typeof line.unit !== "string" || line.unit === "") {
      invalid("each schedule line carries a unit label for the people reading it");
    }
    if (line.per !== undefined && !isPosInt(line.per)) {
      invalid(
        "per is the divisor — how many raw meter counts make one billable unit — and is a " +
          "positive integer, defaulting to 1 when absent (§5.5.2)",
      );
    }
    if (!isNonNegInt(line.per_unit)) {
      invalid("per_unit is a non-negative integer in the smallest unit of currency");
    }
    if (line.pass_through !== undefined && line.pass_through !== true) {
      invalid("pass_through, when present, is the literal true (§5.5.6)");
    }
  }

  if (p.cap === undefined) {
    invalid(
      "a time and materials engagement MUST carry a not-to-exceed cap — there is no uncapped " +
        "time and materials engagement (§5.5.3)",
    );
  }
  if (typeof p.cap !== "object" || p.cap === null || Array.isArray(p.cap)) {
    invalid("cap is an object carrying an amount (§5.5.3)");
  }
  if (!isPosInt((p.cap as Record<string, unknown>).amount)) {
    invalid("cap.amount is a positive integer — a zero cap admits no work at all (§5.5.3)");
  }

  if (p.reservation === undefined) {
    invalid(
      "a time and materials engagement MUST carry a reservation with a stated window — the " +
        "arrangement is a purchase order, and one that commits no funds and names no period " +
        "has no defined settlement behaviour (§5.5.4)",
    );
  }
  const r = p.reservation as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null || Array.isArray(r)) {
    invalid("reservation is an object carrying window_days (§5.5.4)");
  }
  if (!isPosInt(r.window_days)) invalid("reservation.window_days is a positive integer (§5.5.4)");

  if (p.rates !== undefined) invalid("a time_and_materials clause carries no rates");
  if (p.ceiling !== undefined) {
    invalid("a time_and_materials clause carries a cap, not a per-period ceiling (§5.5.3)");
  }
}

function validateCeiling(v: unknown): void {
  if (typeof v !== "object" || v === null || Array.isArray(v)) invalid("ceiling is an object");
  const c = v as Record<string, unknown>;
  if (!isPosInt(c.amount)) invalid("ceiling.amount is a positive integer");
  if (c.period !== "month") invalid("ceiling.period is 'month'");
}

/** Shape, then the arrangement's own rules. Throws rather than returning a
 *  verdict, so a caller that forgets to check cannot proceed on a bad clause. */
export function loadSowPrice(v: unknown): SowPrice {
  validateSowPrice(v);
  return v;
}

/**
 * §5.5.2 — a schedule MUST NOT price a meter the offering does not declare.
 *
 * The other half of that sentence (a runtime MUST NOT bill a meter the schedule
 * does not price) is enforced by {@link rateUsage}, which refuses an unpriced
 * meter rather than dropping it.
 */
export function validateScheduleAgainstMeters(
  price: SowTimeAndMaterialsPrice,
  declaredMeters: readonly string[],
): void {
  const declared = new Set(declaredMeters);
  for (const line of price.schedule) {
    if (!declared.has(line.meter)) {
      invalid(
        `the schedule prices '${line.meter}', which the offering does not declare — ` +
          "this is a validation error, not a default to be filled in (§5.5.2)",
      );
    }
  }
}

// ── §5.5.4: the reservation window ──────────────────────────────────────────

const DAY_MS = 86_400_000;

/** When the reservation releases: `window_days` after the engagement forms.
 *  The unused remainder of the cap returns to the client at this instant. */
export function reservationReleaseAt(reservation: SowReservation, startsAt: string): string {
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) invalid("starts_at must be an RFC-3339 instant (§5.5.4)");
  return new Date(start + reservation.window_days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * §5.5.4 — the window MUST NOT extend beyond `ends_at`.
 *
 * An engagement whose term outlasts its window needs a new reservation before
 * more work runs; an engagement whose window outlasts its term is holding the
 * client's money past the point any work can consume it.
 */
export function reservationWithinTerm(
  reservation: SowReservation,
  startsAt: string,
  endsAt: string,
): boolean {
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return false;
  return Date.parse(reservationReleaseAt(reservation, startsAt)) <= end;
}

// ── rating, the cap, and §5.5.5 exhaustion ──────────────────────────────────

/** A RAW meter count, in the meter's own natural grain (§5.5.2). Raw, not
 *  pre-divided: the schedule's `per` does the conversion, inside the signed
 *  bytes, so the buyer's own token count is the number it hands in. */
export interface SowMeteredCount {
  meter: string;
  count: number;
}

/** One line of a settlement record (§5.5, §5.5.6).
 *
 *  It carries everything the charge was computed from — the raw `count`, the
 *  `per` divisor and the `per_unit` price — so a buyer can recompute `amount`
 *  from its own records without holding the engagement. That is the whole
 *  point of §5.5.2's machine-readable divisor. */
export interface SowSettlementLine {
  meter: string;
  /** The human label the schedule carried. Never parsed. */
  unit: string;
  count: number;
  /** The divisor actually applied, written out even when it is 1. */
  per: number;
  per_unit: number;
  amount: number;
  /** Present and `true` only on a line the provider bought elsewhere. */
  pass_through?: true;
  /** REQUIRED on a pass-through line (§5.5.6): the upstream receipt that
   *  evidences the cost. The proof is usually free — the upstream engagement
   *  settled and issued its own record. */
  upstream_receipt?: string;
  /** OPTIONAL evidence of what the upstream actually charged. When present it
   *  is checked: a pass-through line MUST NOT be priced above the upstream
   *  cost (§5.5.6). */
  upstream_amount?: number;
}

/** What rating a batch of metered units produced (§5.5.2, §5.5.3, §5.5.5). */
export interface SowRating {
  currency: string;
  lines: SowSettlementLine[];
  /** The sum of `lines`: the PROVIDER's rated total, already clamped so that it
   *  plus the operator fee taken on it never exceeds the cap (§5.5.3). */
  total: number;
  /** The operator fee taken on `total` (§5.5.8). Present only where a basis was
   *  supplied AND something was rated: a fee is a cut out of what the client
   *  pays, so where nothing was billed nothing was taken. */
  operator_fee?: SowOperatorFee;
  /** What the CLIENT pays for this rating: `total` plus the fee inside it. Equal
   *  to `total` where no operator stands in the path. */
  client_total: number;
  /** How much of the cap remains after this rating, measured as REMAINING
   *  CLIENT EXPOSURE — cap less everything the client has been billed, fees
   *  included (§5.5.3). Where no fee is in play this is the same number it has
   *  always been. */
  cap_remaining: number;
  /** True when the cap has been reached: admission stops and the engagement
   *  moves to `exhausted` (§5.5.5). "Reached" means no further rated work fits
   *  under the remaining exposure once the fee on it is counted. */
  exhausted: boolean;
  /** What the schedule would have charged before the cap clamped it. The
   *  difference is the provider's to bear (§5.5.3). */
  unbilled: number;
}

/**
 * Rate raw meter counts against a time and materials schedule, honouring the
 * cap.
 *
 * Counts are RAW, in each meter's natural grain: the schedule's `per` divisor
 * does the conversion (§5.5.2), so the buyer hands in the same token count it
 * can read off its own records and gets back the same charge either side
 * computes.
 *
 * Three MUSTs are enforced here. A meter the schedule does not price is refused
 * rather than billed (§5.5.2). Metered usage is not billed past the cap
 * (§5.5.3) — the total clamps, `unbilled` records what the provider absorbed,
 * and `exhausted` says the work is concluded. And **the cap bounds what the
 * CLIENT pays, fee included** (§5.5.3, §5.5.8): where `operatorFeeBasis` names
 * an operator's cut, the provider's rated work runs to the cap LESS the fee
 * taken on it, and reaching that limit reaches the cap in the ordinary way. A
 * runtime MUST NOT bill the client a sum of provider lines and operator fees
 * greater than the cap.
 *
 * `alreadyBilled` is what the CLIENT has been billed under this engagement so
 * far, INCLUDING any operator fees inside those charges, so the cap is measured
 * over the engagement rather than over one batch and measures the client's real
 * exposure. Callers that take no fee are unaffected: with no basis every number
 * here means exactly what it meant before.
 */
export function rateUsage(
  price: SowTimeAndMaterialsPrice,
  usage: readonly SowMeteredCount[],
  opts: {
    alreadyBilled?: number;
    receipts?: Readonly<Record<string, string>>;
    /** §5.5.8 — the operator's cut on this rating, as the basis it is computed
     *  from. A basis rather than a built line, because the amount follows from
     *  the rated total and the rated total is what this function decides. */
    operatorFeeBasis?: SowOperatorFeeBasis;
    /** Who takes the cut, written onto the line this rating produces. */
    operator?: string;
  } = {},
): SowRating {
  // §5.5.7's first prohibition, backing the type up for untyped callers: a
  // runtime MUST NOT rate work under a no-charge engagement. Rating it would
  // produce a zero-valued settlement record for every task, which is the
  // design §5.5.7 exists to rule out.
  const clause = price as unknown as SowPrice;
  if (clause?.arrangement === "no_charge") {
    invalid(
      "this engagement is priced no_charge, so a runtime MUST NOT rate work under it and there " +
        "is no settlement record to hold (§5.5.7)",
    );
  }
  if (clause?.arrangement !== "time_and_materials") {
    invalid("rating a schedule requires a time_and_materials clause (§5.5.2)");
  }
  const byMeter = new Map(price.schedule.map((l) => [l.meter, l]));
  const alreadyBilled = opts.alreadyBilled ?? 0;
  if (!isNonNegInt(alreadyBilled)) invalid("alreadyBilled is a non-negative integer");
  const basis = opts.operatorFeeBasis;
  if (basis !== undefined) validateOperatorFeeBasis(basis);

  // §5.5.3: the cap bounds what the client pays, fee included. What is left of
  // the client's exposure is the cap less everything already billed to it; what
  // is left for the PROVIDER is that, less the fee this rating will take on it.
  const exposure = Math.max(0, price.cap.amount - alreadyBilled);
  let budget = maxRatedTotalUnderCap(exposure, basis);
  let total = 0;
  let unbilled = 0;
  const lines: SowSettlementLine[] = [];

  for (const u of usage) {
    const line = byMeter.get(u.meter);
    if (line === undefined) {
      invalid(
        `a runtime MUST NOT bill '${u.meter}' — the schedule does not price it (§5.5.2)`,
      );
    }

    const gross = rateLine(line, u.count);
    const billed = Math.min(gross, budget);
    budget -= billed;
    total += billed;
    unbilled += gross - billed;

    const settled: SowSettlementLine = {
      meter: line.meter,
      unit: line.unit,
      count: u.count,
      per: divisorOf(line),
      per_unit: line.per_unit,
      amount: billed,
    };
    if (line.pass_through === true) {
      settled.pass_through = true;
      const receipt = opts.receipts?.[line.meter];
      if (receipt !== undefined) settled.upstream_receipt = receipt;
    }
    validateSettlementLine(settled);
    lines.push(settled);
  }

  // The fee follows the rated total, and a fee is a cut out of what the client
  // pays: where nothing was rated nothing was charged, so nothing was taken and
  // no line is written. Under a fixed basis that is load-bearing rather than
  // tidy — a fixed charge is `basis.fixed` whatever the base, so a line on a
  // zero total would bill the client for work it did not receive.
  const fee =
    basis === undefined || total === 0
      ? undefined
      : operatorFee({
          ...(opts.operator !== undefined ? { operator: opts.operator } : {}),
          basis,
          base: total,
        });
  const clientTotal = total + (fee?.amount ?? 0);
  const capRemaining = exposure - clientTotal;

  return {
    currency: price.currency,
    lines,
    total,
    ...(fee !== undefined ? { operator_fee: fee } : {}),
    client_total: clientTotal,
    cap_remaining: capRemaining,
    // §5.5.5 — reaching the cap concludes the work. "Reached" is the point at
    // which no further rated work fits under what is left once the fee on it is
    // counted, which with no fee is exactly the old `cap_remaining === 0`.
    exhausted: maxRatedTotalUnderCap(capRemaining, basis) === 0,
    unbilled,
  };
}

/**
 * §5.5.6 — every settlement record for a pass-through line MUST reference the
 * upstream receipt, and MUST NOT be priced above the upstream cost.
 *
 * A pass-through line with no receipt is a bare assertion that a cost was
 * incurred, which is the thing "at cost, with proof" exists to rule out.
 */
export function validateSettlementLine(line: unknown): asserts line is SowSettlementLine {
  if (typeof line !== "object" || line === null) invalid("a settlement line is an object");
  const l = line as Record<string, unknown>;
  if (typeof l.meter !== "string" || !METER_NAME_RE.test(l.meter)) invalid("line.meter is a meter name");
  if (typeof l.unit !== "string" || l.unit === "") invalid("line.unit is required");
  if (!isNonNegInt(l.count)) invalid("line.count is a non-negative integer");
  if (!isPosInt(l.per)) {
    invalid("line.per is the divisor actually applied, written out even when it is 1 (§5.5.2)");
  }
  if (!isNonNegInt(l.per_unit)) invalid("line.per_unit is a non-negative integer");
  if (!isNonNegInt(l.amount)) invalid("line.amount is a non-negative integer");
  if (l.pass_through === undefined) {
    if (l.upstream_receipt !== undefined) {
      invalid("upstream_receipt belongs to a pass_through line (§5.5.6)");
    }
    return;
  }
  if (l.pass_through !== true) invalid("pass_through, when present, is the literal true (§5.5.6)");
  if (typeof l.upstream_receipt !== "string" || l.upstream_receipt === "") {
    invalid(
      "a pass-through settlement record MUST reference the upstream receipt that evidences " +
        "the cost (§5.5.6)",
    );
  }
  if (l.upstream_amount !== undefined) {
    if (!isNonNegInt(l.upstream_amount)) invalid("upstream_amount is a non-negative integer");
    if ((l.amount as number) > l.upstream_amount) {
      invalid(
        "a pass-through line MUST NOT be priced above the upstream cost — price resold work " +
          "as your own metered line if you want a margin (§5.5.6)",
      );
    }
  }
}

/** The pass-through lines of a schedule (§5.5.6): what this provider resells
 *  rather than performs, and therefore what it owes receipts for. */
export function passThroughLines(price: SowTimeAndMaterialsPrice): SowScheduleLine[] {
  return (price.schedule ?? []).filter((l) => l.pass_through === true);
}

// ── §5.5.7: nothing settles ─────────────────────────────────────────────────

/**
 * Whether an engagement priced this way settles at all (§5.5).
 *
 * True under `fixed_fee` and `time_and_materials`, where every billable unit of
 * work is rated at the engagement's price and produces a settlement record both
 * parties hold. False under `no_charge`, which has no billable units: §5.5.7
 * says a runtime MUST NOT rate the work, MUST NOT draw from the client's
 * balance, MUST NOT produce a settlement record, and MUST NOT call clearing.
 */
export function settles(price: SowPrice): boolean {
  return price.arrangement !== "no_charge";
}

/**
 * §5.5.7 — the refusal a client node owes a settlement record that cites a
 * no-charge engagement, and the same refusal on the way in for a runtime about
 * to rate one.
 *
 * Written as a prohibition rather than left to implementations because the
 * alternative design produces a settlement record of zero for every task, and
 * those records carry no information while sitting in both accounts' books
 * beside the records that do.
 *
 * `act` names what was attempted, so the sentence reads as what happened rather
 * than as a category. Throws; a caller that forgets to check cannot file the
 * record.
 */
export function admitSettlement(price: SowPrice, act = "settle"): asserts price is Exclude<SowPrice, SowNoChargePrice> {
  if (price?.arrangement === "no_charge") {
    invalid(
      `this engagement is priced no_charge, so a runtime MUST NOT ${act} it and there is no ` +
        "settlement record to hold. Nothing was billed and nothing is owed (§5.5.7)",
    );
  }
}

/**
 * The committed price of an engagement — the single number an Agent Mandate
 * ceiling check tests before formation (§5.5.3, §5.5.7).
 *
 * For time and materials it is the cap, which is the whole point of requiring
 * one. For no charge it is zero, and any ceiling covers it. For fixed fee it is
 * the ceiling when the clause states one; a fixed fee clause with no ceiling
 * commits no bounded total, and `null` says so rather than inventing a number.
 */
export function committedPrice(price: SowPrice): number | null {
  if (isTimeAndMaterials(price)) return price.cap.amount;
  if (isNoCharge(price)) return 0;
  return price.ceiling?.amount ?? null;
}

// ── §5.5.8: the operator fee ────────────────────────────────────────────────

/**
 * The basis an operator fee was computed from (§5.5.8): a percentage, or a
 * fixed charge.
 *
 * `percent` is a NON-NEGATIVE INTEGER. §5.5.8 does not say whether a fractional
 * percentage is permitted, and this SDK does not accept one: a fraction inside
 * the signed bytes is a float two implementations must print identically
 * forever, and the arithmetic rule below ("`amount` MUST equal the basis
 * applied to `base`") stops being exact the moment one appears. Nothing is
 * lost. An operator wanting two and a half percent of 2500000 states the
 * fixed charge it computed, `{ kind: "fixed", fixed: 62500 }`, against the
 * same `base` — which discloses strictly more than a rate the buyer would have
 * had to multiply out itself.
 */
export type SowOperatorFeeBasis =
  | { kind: "percent"; percent: number }
  | { kind: "fixed"; fixed: number };

/**
 * §5.5.8 — the operator's own cut, disclosed on its own line.
 *
 * An **operator** is a party that stands between the client and the provider
 * when money moves: it hosts one or both agents, builds the quote, settles the
 * charge, or does more than one of those. Its fee is not the provider's price
 * and it is not a §5.5.6 pass-through, which is a cost bought elsewhere and
 * billed at cost. This is a margin, and it is the operator's to charge — what
 * it is not is invisible.
 *
 * Three members are required. `amount` is the cut in the settlement currency.
 * `basis` is what it was computed from. `base` is what that basis was applied
 * to, and it is not decoration: ten percent of the provider's price and ten
 * percent of the total the buyer pays are different numbers from the same
 * percentage, so a client node MUST NOT infer the base. `operator` is optional
 * and names who took it.
 *
 * Disclosure binds at two moments and both are required (§5.5.8): in the quote,
 * before the client commits, and in the settlement record afterwards. A quote or
 * record carrying no line asserts that no operator fee is inside its total —
 * see {@link checkSettlement}, which is the client node's side of that.
 *
 * Disclosing the cut reveals the provider's net, because the total minus the
 * cut IS the provider's net. §5.5.8 accepts that trade deliberately and says
 * so; a provider unwilling to have its net readable by its clients cannot sell
 * through an operator that takes a disclosed fee. The remedy is to change the
 * arrangement, not to omit the line.
 */
export interface SowOperatorFee {
  /** OPTIONAL (§5.5.8). Who took the cut. */
  operator?: string;
  basis: SowOperatorFeeBasis;
  /** REQUIRED. A percentage is uncheckable without the number it was taken
   *  from, and a client node MUST NOT infer it. */
  base: number;
  amount: number;
}

/** The exact fee a basis applied to a base produces, before flooring, as a
 *  numerator over 100. Kept rational so the check below never compares floats. */
function feeNumerator(basis: SowOperatorFeeBasis, base: number): bigint {
  return basis.kind === "percent"
    ? BigInt(basis.percent) * BigInt(base)
    : BigInt(basis.fixed) * 100n;
}

/**
 * The whole-unit fee a basis applied to a base produces (§5.5.8).
 *
 * There is ONE rule and it takes no argument. Under a percentage basis the
 * amount is `floor(base × percent / 100)`; under a fixed basis nothing is
 * rounded and the amount is `basis.fixed`, whatever the base is. Flooring is
 * the direction §5.5.2 already applies to usage rating, so money is computed
 * one way throughout the specification, and the floor favours the buyer.
 *
 * There is no rounding parameter and there was one until 0.9.0-draft. It
 * existed because §5.5.8 defined no field for a rounding rule, so no rule was
 * ever stated, so a reader had to accept several answers to the same line. The
 * specification now states the rule, so the choice is gone and the check
 * {@link checkOperatorFee} performs is exact.
 *
 * A percentage of a base too small to produce one whole unit produces NOTHING.
 * An operator that intends to charge a whole unit there states a fixed basis of
 * one unit, which discloses the charge as the charge it is.
 */
export function operatorFeeAmount(basis: SowOperatorFeeBasis, base: number): number {
  validateOperatorFeeBasis(basis);
  if (!isNonNegInt(base)) invalid("operator_fee.base is a non-negative integer (§5.5.8)");
  if (basis.kind === "fixed") return basis.fixed;
  const amount = feeNumerator(basis, base) / 100n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid("the operator fee overflows an exact integer — split the settlement (§5.5.8)");
  }
  return Number(amount);
}

/**
 * Build an operator fee line (§5.5.8), computing `amount` from the basis and
 * the base.
 *
 * Pass `amount` only to state a cut this SDK did not compute — a fee taken by
 * some other implementation, being written down as it stands. It is checked
 * against the basis before it is returned, so a line that does not close is
 * refused here rather than at the counterparty. Since 0.9.0-draft that check is
 * exact, so a line an operator rounded any way but down is refused at
 * construction.
 */
export function operatorFee(init: {
  operator?: string;
  basis: SowOperatorFeeBasis;
  base: number;
  amount?: number;
}): SowOperatorFee {
  const fee: SowOperatorFee = {
    ...(init.operator !== undefined ? { operator: init.operator } : {}),
    basis:
      init.basis?.kind === "fixed"
        ? { kind: "fixed", fixed: init.basis.fixed }
        : { kind: "percent", percent: (init.basis as { percent: number })?.percent },
    base: init.base,
    amount: init.amount ?? operatorFeeAmount(init.basis, init.base),
  };
  validateOperatorFee(fee);
  const verdict = checkOperatorFee(fee);
  if (!verdict.ok) invalid(verdict.why);
  return fee;
}

function validateOperatorFeeBasis(v: unknown): asserts v is SowOperatorFeeBasis {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("operator_fee.basis is an object — a percentage or a fixed charge (§5.5.8)");
  }
  const b = v as Record<string, unknown>;
  if (b.kind === "percent") {
    if (!isNonNegInt(b.percent)) {
      invalid(
        "operator_fee.basis.percent is a non-negative integer — a fractional percentage would " +
          "put a float inside the signed bytes and would make the arithmetic check inexact; " +
          "state the charge you computed as a fixed basis instead (§5.5.8)",
      );
    }
    if (b.fixed !== undefined) invalid("a percent basis carries no fixed charge (§5.5.8)");
    return;
  }
  if (b.kind === "fixed") {
    if (!isNonNegInt(b.fixed)) {
      invalid("operator_fee.basis.fixed is a non-negative integer in the settlement currency (§5.5.8)");
    }
    if (b.percent !== undefined) invalid("a fixed basis carries no percentage (§5.5.8)");
    return;
  }
  invalid("operator_fee.basis.kind is 'percent' or 'fixed' — a basis is one or the other (§5.5.8)");
}

/**
 * Shape check for an operator fee line (§5.5.8). Arithmetic is
 * {@link checkOperatorFee}: a line can be well formed and still not close, and
 * those are different failures to a client node reading a settlement record.
 */
export function validateOperatorFee(v: unknown): asserts v is SowOperatorFee {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("an operator fee line is an object carrying amount, basis and base (§5.5.8)");
  }
  const f = v as Record<string, unknown>;
  if (f.operator !== undefined && (typeof f.operator !== "string" || f.operator === "")) {
    invalid("operator_fee.operator, when present, names the operator that took the cut (§5.5.8)");
  }
  validateOperatorFeeBasis(f.basis);
  if (f.base === undefined) {
    invalid(
      "operator_fee.base is REQUIRED — a percentage is not checkable until the buyer knows what " +
        "it was applied to, and a client node MUST NOT infer the base (§5.5.8)",
    );
  }
  if (!isNonNegInt(f.base)) invalid("operator_fee.base is a non-negative integer (§5.5.8)");
  if (!isNonNegInt(f.amount)) {
    invalid("operator_fee.amount is a non-negative integer in the settlement currency (§5.5.8)");
  }
}

/**
 * §5.5.8 — does the disclosed amount follow from the disclosed basis and base?
 *
 * EXACT, both kinds. `amount` MUST equal the basis applied to `base`, computed
 * by flooring: `floor(base × percent / 100)` under a percentage, and
 * `basis.fixed` under a fixed charge. There is no tolerance for a difference of
 * one unit or of any other size.
 *
 * The one-whole-unit tolerance this function applied until 0.9.0-draft is
 * WITHDRAWN. It existed because the subsection defined no field for a rounding
 * rule, so no rule was ever stated, so the fallback always applied and an
 * arithmetic check called `enforced` accepted several answers to the same line
 * forever. With one rule the check is exact, which is the point of stating it.
 *
 * This check is the `enforced` half of §5.5.8. It runs on bytes the client
 * already holds, so a violation produces a mechanical refusal rather than a
 * grievance. What it does NOT establish is that the disclosed basis is the rate
 * the operator actually agreed with the provider — the client is not party to
 * that agreement, so the basis itself grades `evidence`
 * ({@link OPERATOR_FEE_BASIS_GRADE}).
 */
export function checkOperatorFee(fee: SowOperatorFee): { ok: true } | { ok: false; why: string } {
  validateOperatorFee(fee);
  if (fee.basis.kind === "fixed") {
    return fee.amount === fee.basis.fixed
      ? { ok: true }
      : {
          ok: false,
          why:
            `the operator fee states ${fee.amount} against a fixed basis of ${fee.basis.fixed} — ` +
            "a fixed charge is rounded by nothing, so amount MUST equal it exactly (§5.5.8)",
        };
  }
  const floored = feeNumerator(fee.basis, fee.base) / 100n;
  if (BigInt(fee.amount) === floored) return { ok: true };
  return {
    ok: false,
    why:
      `the operator fee states ${fee.amount}, and ${fee.basis.percent}% of ${fee.base} floors to ` +
      `${floored}. A client node MUST reject an amount that is not the floored figure, and there ` +
      "is no tolerance of one unit or of any other size. An operator whose rate is finer than a " +
      "whole percent states the charge that rate produced as a fixed basis against the same base " +
      "(§5.5.8)",
  };
}

/**
 * The largest rated total that fits under `capRemaining` once the operator fee
 * taken on it is counted (§5.5.3, §5.5.8) — **the maximal fit rule**.
 *
 * §5.5.8 says the cap bounds what the client pays, fee included, so the
 * provider's rated work runs to the cap less the fee taken on it. Turning that
 * sentence into a number needs one decision the specification does not force,
 * and this is where it is made.
 *
 * The obvious closed form, `floor(cap × 100 / (100 + percent))`, is WRONG, or
 * rather it is merely conservative: it assumes the fee scales continuously, and
 * the fee floors. At a cap of 100 with a ten percent fee it gives 90, but 91
 * also fits, because ten percent of 91 floors to 9 and 91 + 9 is exactly 100.
 * Both answers satisfy §5.5.8 and a client reading either record cannot tell
 * them apart, so this is not a specification defect. But two implementations
 * that pick differently disagree by a unit at every boundary, and they disagree
 * inside signed bytes. So the rule is pinned rather than left to taste:
 *
 * > **the largest rated total whose sum with its own fee is within the cap.**
 *
 * `conformance/sow-pricing.json` carries the cap-100-at-ten-percent case as an
 * explicit fixture so a third implementation cannot get it wrong. The loop
 * below runs at most once — a floored fee can only ever hide one whole unit of
 * headroom — but it is written as a loop because the bound is a proof and the
 * loop is the rule.
 *
 * With no basis the answer is the whole remaining cap, which is what every
 * peer-to-peer caller gets and why nothing changes for them.
 */
export function maxRatedTotalUnderCap(
  capRemaining: number,
  basis?: SowOperatorFeeBasis,
): number {
  if (!isNonNegInt(capRemaining)) {
    invalid("the remaining cap is a non-negative integer (§5.5.3)");
  }
  if (basis === undefined) return capRemaining;
  validateOperatorFeeBasis(basis);
  if (basis.kind === "fixed") {
    // A fixed charge is taken whole, whatever the base (§5.5.8), so it comes
    // off the top. Where it does not fit at all, nothing does.
    return capRemaining >= basis.fixed ? capRemaining - basis.fixed : 0;
  }
  const cap = BigInt(capRemaining);
  const percent = BigInt(basis.percent);
  let fit = (cap * 100n) / (100n + percent);
  while (fit + 1n + ((fit + 1n) * percent) / 100n <= cap) fit += 1n;
  return Number(fit);
}

/** §5.5.8 — the basis itself grades `evidence`, always. A client node can check
 *  that the disclosed percentage was applied to the disclosed base; it cannot
 *  check that the disclosed percentage is the rate the operator agreed with the
 *  provider, because it is not party to that agreement. */
export const OPERATOR_FEE_BASIS_GRADE: SowGrade = "evidence";

/**
 * The grade §5.5.8 earns on a given money path. Never guess upward.
 *
 * `enforced` requires BOTH: the operator built the quote and the operator
 * settled the charge. Presence and arithmetic are then mechanically checkable
 * against two records the client holds.
 *
 * Anything less is `recorded`. Where no operator constructed the quote there is
 * no second record to test the quote's assertion against, so a client node can
 * check a disclosed line's arithmetic — and MUST — but cannot detect a line
 * that was never written. §5.5.8 names the both-ends case and the neither-end
 * case and is silent on the mixed one; this returns `recorded` for it, because
 * an omission at the end nobody operates is exactly the omission nothing can
 * refuse, and grading it `enforced` would be the laundering of trust as
 * enforcement §8.2 forbids.
 */
export function operatorFeeGrade(path: {
  operatorBuiltQuote: boolean;
  operatorSettled: boolean;
}): SowGrade {
  return path.operatorBuiltQuote && path.operatorSettled ? "enforced" : "recorded";
}

/** A quote: a total offered before commitment, and the operator fee inside it.
 *  §5.5.8 defines the LINE, not the envelope carrying it, so this is the
 *  minimum a client node needs to hold in order to test the settlement record
 *  that follows. Implementations carry whatever else they carry. */
export interface SowQuote {
  total: number;
  currency?: string;
  /** Absent asserts that no operator fee is inside `total` (§5.5.8). */
  operator_fee?: SowOperatorFee;
}

/** A settlement record: what was actually charged, line by line. `total` is
 *  what the client pays, and the operator fee is one of the lines that total
 *  MUST account for — the fee is inside the total, and the total minus the fee
 *  is the provider's net (§5.5.8). */
export interface SowSettlementRecord {
  total: number;
  lines: SowSettlementLine[];
  currency?: string;
  /** Absent asserts that no operator fee is inside `total` (§5.5.8). */
  operator_fee?: SowOperatorFee;
}

/** What a record's own lines account for: the rated lines plus the operator's
 *  cut. §5.5.8 gives the fee the shape of a §5.5.6 pass-through line, and a
 *  pass-through line is part of the total, so this one is too. */
export function settlementTotal(record: {
  lines: readonly SowSettlementLine[];
  operator_fee?: SowOperatorFee;
}): number {
  const lines = record.lines.reduce((sum, l) => sum + l.amount, 0);
  return lines + (record.operator_fee?.amount ?? 0);
}

/** What the provider receives: the total minus the operator's cut (§5.5.8).
 *  This is the number disclosure reveals, and the specification says so rather
 *  than leaving an implementer to discover it. */
export function providerNet(x: { total: number; operator_fee?: SowOperatorFee }): number {
  return x.total - (x.operator_fee?.amount ?? 0);
}

/** §5.5.3, §5.5.8 — the refusal a total owes a cap it exceeds. The cap bounds
 *  what the CLIENT pays, and the fee is inside that total, so a quote or a
 *  record stating more than the cap states a charge the engagement forbids. */
function withinCap(total: number, cap: number | undefined, what: string): void {
  if (cap === undefined) return;
  if (!isNonNegInt(cap)) invalid("the cap is a non-negative integer (§5.5.3)");
  if (total > cap) {
    invalid(
      `this ${what} states a total of ${total} against a not-to-exceed cap of ${cap}. The cap ` +
        "bounds what the client pays, operator fee included, so the provider's rated work runs " +
        "to the cap less the fee taken on it and a runtime MUST NOT bill past it (§5.5.3, §5.5.8)",
    );
  }
}

/** Build the quote §5.5.8 requires: the provider's total, the operator's cut
 *  beside it, and a total that is the sum of the two. A quote built with no fee
 *  asserts there is none inside it, which is an assertion §5.10 tests if it
 *  later proves false.
 *
 *  Pass `cap` where one is in play (§5.5.3) and the resulting total is asserted
 *  against it, fee included — a quote whose total exceeds the cap is a quote for
 *  work the engagement will not admit. */
export function quoteWithOperatorFee(init: {
  providerTotal: number;
  fee?: SowOperatorFee;
  currency?: string;
  cap?: number;
}): SowQuote {
  if (!isNonNegInt(init.providerTotal)) invalid("the provider's total is a non-negative integer");
  if (init.fee !== undefined) {
    validateOperatorFee(init.fee);
    const verdict = checkOperatorFee(init.fee);
    if (!verdict.ok) invalid(verdict.why);
  }
  const total = init.providerTotal + (init.fee?.amount ?? 0);
  withinCap(total, init.cap, "quote");
  return {
    total,
    ...(init.currency !== undefined ? { currency: init.currency } : {}),
    ...(init.fee !== undefined ? { operator_fee: init.fee } : {}),
  };
}

/** Build the settlement record §5.5.8 requires from a {@link rateUsage} result:
 *  the same lines, the same fee line the quote carried, and a total its own
 *  lines account for. Rating is not re-done here and no arithmetic of the
 *  schedule is repeated — the rating is the authority for what the work cost.
 *
 *  `fee` defaults to the line the rating already took, so a caller that rated
 *  against an operator basis cannot forget to disclose the cut that rating
 *  clamped the work for. Pass `cap` to assert the record's total against the
 *  not-to-exceed cap (§5.5.3), fee included. */
export function settlementWithOperatorFee(init: {
  rating: SowRating;
  fee?: SowOperatorFee;
  cap?: number;
}): SowSettlementRecord {
  const fee = init.fee ?? init.rating.operator_fee;
  if (fee !== undefined) {
    validateOperatorFee(fee);
    const verdict = checkOperatorFee(fee);
    if (!verdict.ok) invalid(verdict.why);
  }
  const total = init.rating.total + (fee?.amount ?? 0);
  withinCap(total, init.cap, "settlement record");
  const record: SowSettlementRecord = {
    total,
    lines: init.rating.lines,
    currency: init.rating.currency,
    ...(fee !== undefined ? { operator_fee: fee } : {}),
  };
  return record;
}

/** Why a settlement is disputed (§5.5.8). The first three are the three checks
 *  §5.5.8 requires a client node to make. The fourth is the mirror of the
 *  first: a record disclosing a fee where the quote disclosed none contradicts
 *  the quote's own assertion that no operator fee was inside that total, which
 *  §5.5.8 states as an assertion without naming the check that catches it. */
export type SowDisputeReason =
  | "operator_fee_missing"
  | "operator_fee_arithmetic"
  | "total_unaccounted"
  | "operator_fee_undisclosed";

/**
 * A disputed settlement (§5.5.8), holding both documents exactly as they were
 * compared.
 *
 * `quote` and `record` are DEEP FROZEN. §5.5.8 says a client node MUST NOT
 * repair the record by supplying the missing line or recomputing the total,
 * because a record the client rewrote is no longer evidence of what the
 * operator claimed. This module offers no repair function, and the copies it
 * hands back refuse the write.
 */
export interface SowDisputedSettlement {
  reason: SowDisputeReason;
  detail: string;
  quote: Readonly<SowQuote>;
  record: Readonly<SowSettlementRecord>;
}

/** The verdict of {@link checkSettlement}. On a dispute the charge is NOT
 *  settled in the client's evidence chain: the discrepancy is what gets
 *  recorded (§5.5.8). */
export type SowSettlementVerdict =
  | { settled: true }
  | { settled: false; disputed: SowDisputedSettlement };

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const member of Object.values(v as Record<string, unknown>)) deepFreeze(member);
  }
  return v;
}

/**
 * The client node's read of a settlement record against the quote it holds
 * (§5.5.8).
 *
 * Three checks, in the specification's own order: that an operator fee line is
 * present where the quote carried one, that the line's `amount` follows from
 * its `basis` and `base`, and that the record's total accounts for every line
 * the record carries. A record failing any of them is a **disputed
 * settlement**, and on one the client node MUST NOT record the charge as
 * settled, MUST record the discrepancy instead holding both documents, MUST
 * raise it under the engagement's dispute clause (§5.10) where it counts as a
 * failed obligation for §5.9 and §5.10, and MUST NOT repair the record.
 *
 * It MAY continue to admit work — one discrepancy is not by itself grounds to
 * stop — and SHOULD refuse further work under the same operator after a second
 * one ({@link refuseFurtherWorkUnderOperator}).
 *
 * Nothing is mutated and nothing is repaired. The returned dispute holds frozen
 * copies of exactly what was compared.
 */
export function checkSettlement(quote: SowQuote, record: SowSettlementRecord): SowSettlementVerdict {
  const dispute = (reason: SowDisputeReason, detail: string): SowSettlementVerdict => ({
    settled: false,
    disputed: deepFreeze({
      reason,
      detail,
      // A JSON round trip, not a structured clone: these are JSON documents by
      // definition (the canonical bytes are the contract), and a clone that
      // THREW on an unexpected member would fail the one path whose whole job
      // is to record what arrived.
      quote: JSON.parse(JSON.stringify(quote)) as SowQuote,
      record: JSON.parse(JSON.stringify(record)) as SowSettlementRecord,
    }),
  });

  if (quote.operator_fee !== undefined && record.operator_fee === undefined) {
    return dispute(
      "operator_fee_missing",
      "the quote disclosed an operator fee and the settlement record carries no operator fee " +
        "line. Every settlement record for a charge that carried an operator fee MUST carry the " +
        "same line, with the amount actually taken (§5.5.8)",
    );
  }
  if (quote.operator_fee === undefined && record.operator_fee !== undefined) {
    return dispute(
      "operator_fee_undisclosed",
      "the settlement record discloses an operator fee the quote did not. A quote that states a " +
        "total and carries no operator fee line asserts that no operator fee is inside that " +
        "total, and this record contradicts that assertion (§5.5.8)",
    );
  }
  if (record.operator_fee !== undefined) {
    const verdict = checkOperatorFee(record.operator_fee);
    if (!verdict.ok) return dispute("operator_fee_arithmetic", verdict.why);
  }
  const accounted = settlementTotal(record);
  if (record.total !== accounted) {
    return dispute(
      "total_unaccounted",
      `the settlement record states a total of ${record.total} and its own lines account for ` +
        `${accounted}. A settlement record MUST NOT state a total that its own lines do not ` +
        "account for (§5.5.8)",
    );
  }
  return { settled: true };
}

/** §5.5.8 — a client node SHOULD refuse further work under the same operator
 *  after a SECOND disputed settlement. One discrepancy is not by itself grounds
 *  to stop the work. */
export function refuseFurtherWorkUnderOperator(priorDisputes: number): boolean {
  return priorDisputes >= 2;
}

// ── §5.10: disputes ─────────────────────────────────────────────────────────

/**
 * The closed posture vocabulary (§5.10). Exactly one per clause:
 *
 *  - `none`: settlements are final; disagreement ends the engagement at most.
 *  - `refund_on_failed_task`: a task that fails, including failure by the
 *    deliverable-form rule of §5.4, is refunded in full through clearing. The
 *    machine's completion check decides; no quality argument is required.
 *  - `escalate_to_owners`: the owners read the signed record together and
 *    settle it as people.
 *  - `arbiter`: both parties bind, in this document, an independent agent
 *    holding the published arbiter role contract whose verdict on the
 *    disputed amount both commit in advance to accept (§5.10.1).
 */
export type SowDisputesPosture =
  | "none"
  | "refund_on_failed_task"
  | "escalate_to_owners"
  | "arbiter";

export const SOW_DISPUTES_POSTURES: readonly SowDisputesPosture[] = [
  "none",
  "refund_on_failed_task",
  "escalate_to_owners",
  "arbiter",
];

/** Who bears the arbiter's price (§5.10.1): `split` — the parties bear it
 *  equally — or `follows_finding` — each party bears it in proportion to the
 *  split found against them. The arbiter's price is its own business,
 *  declared like any offering's. */
export type SowArbiterFee = "split" | "follows_finding";

export const SOW_ARBITER_FEES: readonly SowArbiterFee[] = ["split", "follows_finding"];

/**
 * The standard role name for the published arbiter contract
 * (https://agentroles.ai/arbiter.html). The clause's `role` member is
 * validated as a non-empty string, NOT pinned to this constant: the role is
 * referenced abstractly because it is a published contract any conforming
 * agent can hold, and a deployment may publish its own role registry. This
 * constant is the name the standard registry publishes, offered so callers
 * spell it once.
 */
export const ROLE_ARBITER = "role-arbiter";

/**
 * What the parties choose about the arbiter forum (§5.10.1), bound in the
 * signed document.
 *
 * `agent` is OPTIONAL: bound at formation, both parties signed over the
 * specific judge; absent, the parties appoint one when a dispute opens, both
 * countersigning the appointment, and failing to appoint within
 * `deadline_days` the `fallback` governs. `independence_days` is the window
 * for the role's independence rule — no shared owner, no engagement with
 * either party inside it — both facts a runtime checks, at binding and again
 * at verdict. A verdict not produced inside `deadline_days` is a refusal by
 * silence, and a late verdict is void: the role's own contract says a late
 * verdict is not a verdict.
 *
 * `fallback` is one of the OTHER three postures, never `arbiter`: an arbiter
 * can decline, conflict out, or fall silent, and a dispute with no working
 * forum must land somewhere the parties already agreed to — which cannot be
 * the forum that just died.
 */
export interface SowArbiterBinding {
  role: string;
  agent?: string;
  independence_days: number;
  deadline_days: number;
  fee: SowArbiterFee;
  fallback: Exclude<SowDisputesPosture, "arbiter">;
}

/**
 * The disputes clause (§5.10). Shapes pinned by `conformance/sow-disputes.json`.
 *
 * Graded `evidence`, flatly: the enforced parts of §5.10 are ACTIONS clearing
 * takes — the refund where reversal is supported (§8.2), the freeze on the
 * disputed amount, the split moving on a verdict's signature — never the
 * clause's own grade. Quality judgment is out of scope for the runtime and
 * always will be: no machine here judges whether work was good. The `arbiter`
 * posture does not change that; it names who judges, and what the machinery
 * enforces is only what is mechanical about the naming and the outcome.
 */
export interface SowDisputes {
  posture: SowDisputesPosture;
  /** REQUIRED when `posture` is `"arbiter"` — an arbiter posture naming no
   *  arbiter terms names no forum — and REFUSED on every other posture. */
  arbiter?: SowArbiterBinding;
  grade: "evidence";
}

/** Backstops, not policy — the same ceiling every name-shaped string in this
 *  file gets. */
const ARBITER_ROLE_MAX = 64;
const ARBITER_AGENT_MAX = 64;

const SOW_DISPUTES_POSTURE_SET: ReadonlySet<string> = new Set(SOW_DISPUTES_POSTURES);
const SOW_ARBITER_FEE_SET: ReadonlySet<string> = new Set(SOW_ARBITER_FEES);

export function validateSowDisputes(v: unknown): asserts v is SowDisputes {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("a disputes clause is an object carrying posture and grade (§5.10)");
  }
  const d = v as Record<string, unknown>;
  if (typeof d.posture !== "string" || !SOW_DISPUTES_POSTURE_SET.has(d.posture)) {
    invalid(
      "a disputes clause's posture is 'none', 'refund_on_failed_task', 'escalate_to_owners' or 'arbiter' — exactly one, from a closed set (§5.10)",
    );
  }
  if (d.grade !== "evidence") {
    invalid(
      "a disputes clause is graded 'evidence', flatly: the signed record a dispute is read against is exportable, and what is enforced under §5.10 is the actions clearing takes — the refund, the freeze, the split — never the clause's own grade. " +
        "Not 'enforced' — no machine here judges whether work was good — and not 'recorded', because the record a dispute rests on is more than a record of the clause (§5.10, §4.2)",
    );
  }
  if (d.posture === "arbiter") {
    if (d.arbiter === undefined) {
      invalid(
        "an arbiter posture naming no arbiter terms names no forum: the arbiter member — role, independence_days, deadline_days, fee, fallback — is required when the posture is 'arbiter' (§5.10.1)",
      );
    }
  } else if (d.arbiter !== undefined) {
    invalid(
      "only the arbiter posture carries the arbiter member: a clause naming a judge under a posture that never convenes one is two clauses disagreeing about which it is (§5.10, §5.10.1)",
    );
  }
  if (d.arbiter === undefined) return;
  if (typeof d.arbiter !== "object" || d.arbiter === null || Array.isArray(d.arbiter)) {
    invalid(
      "the arbiter member is an object carrying role, independence_days, deadline_days, fee and fallback (§5.10.1)",
    );
  }
  const a = d.arbiter as Record<string, unknown>;
  if (typeof a.role !== "string" || !a.role.trim() || a.role.length > ARBITER_ROLE_MAX) {
    invalid(
      `the arbiter's role names the published role contract the serving agent must hold — '${ROLE_ARBITER}' is the standard registry's — up to ${ARBITER_ROLE_MAX} characters, and not blank (§5.10.1)`,
    );
  }
  if (
    a.agent !== undefined &&
    (typeof a.agent !== "string" || !a.agent.trim() || a.agent.length > ARBITER_AGENT_MAX)
  ) {
    invalid(
      `the arbiter's agent, when bound at formation, is the judge's public key as a non-empty string up to ${ARBITER_AGENT_MAX} characters — shape only: whether the key is real is the platform's problem (§5.10.1)`,
    );
  }
  if (!isPosInt(a.independence_days)) {
    invalid(
      "independence_days is a positive whole number of days: the window inside which the arbiter must share no owner with either party and have held no engagement with either (§5.10.1)",
    );
  }
  if (!isPosInt(a.deadline_days)) {
    invalid(
      "deadline_days is a positive whole number of days, running from the dispute's opening; a verdict not produced inside it is a refusal by silence, and a late verdict is void (§5.10.1)",
    );
  }
  if (typeof a.fee !== "string" || !SOW_ARBITER_FEE_SET.has(a.fee)) {
    invalid(
      "the arbiter's fee is 'split' — the parties bear it equally — or 'follows_finding' — each bears it in proportion to the split found against them (§5.10.1)",
    );
  }
  if (typeof a.fallback !== "string" || !SOW_DISPUTES_POSTURE_SET.has(a.fallback) || a.fallback === "arbiter") {
    invalid(
      "every arbiter clause states where a dead forum lands, and it cannot land on itself: fallback is one of the OTHER three postures — 'none', 'refund_on_failed_task' or 'escalate_to_owners', never 'arbiter' (§5.10.1)",
    );
  }
}

/**
 * The clause a document declares, unvalidated, or null where it declares
 * none. Same contract as {@link reportingOf}.
 *
 * There is deliberately NO default posture for an absent clause: absent means
 * the document has not said, and a reader MUST NOT invent a posture on its
 * behalf — unlike reporting, where an absent clause honestly offers the
 * mechanical record, an unstated dispute posture is not any particular one of
 * the four.
 */
export function disputesOf(doc: unknown): SowDisputes | null {
  if (typeof doc !== "object" || doc === null) return null;
  const d = (doc as { disputes?: unknown }).disputes;
  return typeof d === "object" && d !== null && !Array.isArray(d) ? (d as SowDisputes) : null;
}

// ── §5.10.1: the arbiter's verdict ──────────────────────────────────────────

/** The domain tag inside an arbiter verdict's signed bytes
 *  (agentroles.ai/arbiter.html §4): the ASCII tag, one newline, then the JCS
 *  canonical JSON of the verdict with `signatures` removed — the family
 *  convention, under the verdict's own tag. The prefix exists only inside the
 *  signed bytes; it never appears in the document itself. */
export const ARBITER_VERDICT_SIG_PREFIX = "agent-arbiter-verdict-v1\n";

/** One record a verdict excluded from its basis, with the reason — anything
 *  that failed verification is excluded and NAMED as excluded, because a
 *  verdict resting on unverified evidence does not conform
 *  (arbiter.html §3.1). */
export interface SowArbiterExclusion {
  id: string;
  why: string;
}

/** The signature on a verdict. One signer — the arbiter, whose key the
 *  verdict's `by` names — so unlike {@link SowSignature} there is no role
 *  member to carry. */
export interface SowArbiterVerdictSignature {
  key: string;
  signed_at: string;
  sig: string;
}

/**
 * The document an arbiter produces (agentroles.ai/arbiter.html §4) — the
 * answer to the role's one question: given this signed engagement and this
 * evidence, how does the disputed amount divide between the parties?
 *
 * The operative parts are `split` and `attribution`. Machines read those;
 * people read `reasons`, and a runtime that settles from the reasons instead
 * of the split does not conform. `basis` commits the verdict to the exact
 * record set it ruled from, by hash, so either party can recompute what was
 * before the judge; the verdict carries record ids and reasons, never record
 * contents. `heard` says whether each party's submission was received —
 * silence from a party is recorded, never punished by inference.
 */
export interface SowArbiterVerdict {
  verdict: "v1";
  role: "arbiter";
  engagement: string;
  dispute: string;
  disputed: { currency: string; amount: number };
  split: { provider: number; client: number };
  /** From the Agent SoW failure vocabulary, so a dispute that ends in a
   *  finding becomes the same kind of evidence as a failure recorded honestly
   *  in the first place. Validated as a non-empty name, NOT as a closed set
   *  here: the vocabulary lives with the failure clauses, and pinning a copy
   *  of it in the verdict validator is how two lists drift. */
  attribution: string;
  basis: {
    count: number;
    /** sha256 over the JCS array of the record ids, sorted — the same
     *  convention as the bookkeeper's statement. 64 lowercase hex. */
    ids_sha256: string;
    excluded?: SowArbiterExclusion[];
  };
  heard: { provider: boolean; client: boolean };
  reasons: string;
  produced_at: string;
  /** The arbiter agent's public key. */
  by: string;
  signatures: SowArbiterVerdictSignature[];
}

/** What the CLAUSE side already knows when it receives a verdict: the amount
 *  the dispute was opened against, in the engagement's currency. Handing it
 *  to {@link validateArbiterVerdict} makes the verdict-vs-dispute match part
 *  of the shape check. */
export interface ArbiterVerdictExpectation {
  disputed_amount?: number;
  currency?: string;
}

const ARBITER_NAME_MAX = 64;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Shape rules for a verdict (arbiter.html §4), plus — when `expected` is
 * given — the clause side of the check: the verdict must be about the amount
 * and currency the dispute was opened against.
 *
 * The load-bearing rule is rule 1: `split.provider + split.client` MUST equal
 * `disputed.amount` exactly, in whole units. Money divides one way in this
 * family: by integers, with nothing left over and nothing invented — the same
 * safe-integer discipline as the price validators, so two SDKs cannot
 * disagree by one at the boundary.
 */
export function validateArbiterVerdict(
  v: unknown,
  expected?: ArbiterVerdictExpectation,
): asserts v is SowArbiterVerdict {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("an arbiter verdict is an object — the role's signed document (arbiter.html §4)");
  }
  const w = v as Record<string, unknown>;
  if (w.verdict !== "v1") invalid("verdict is 'v1' (arbiter.html §4)");
  if (w.role !== "arbiter") invalid("a verdict's role is 'arbiter' (arbiter.html §4)");
  if (typeof w.engagement !== "string" || !w.engagement.trim() || w.engagement.length > ARBITER_NAME_MAX) {
    invalid("a verdict names the engagement it was handed, and nothing outside it is in the grant (arbiter.html §4)");
  }
  if (typeof w.dispute !== "string" || !w.dispute.trim() || w.dispute.length > ARBITER_NAME_MAX) {
    invalid("a verdict names the dispute it concludes (arbiter.html §4)");
  }
  if (typeof w.disputed !== "object" || w.disputed === null || Array.isArray(w.disputed)) {
    invalid("disputed is an object carrying currency and amount — the money the parties' signatures granted authority over (arbiter.html §4)");
  }
  const disputed = w.disputed as Record<string, unknown>;
  if (typeof disputed.currency !== "string" || !CURRENCY_RE.test(disputed.currency)) {
    invalid("disputed.currency is a three-letter uppercase code");
  }
  if (!isNonNegInt(disputed.amount)) {
    invalid("disputed.amount is a non-negative integer in the smallest unit of the currency — never a float");
  }
  if (typeof w.split !== "object" || w.split === null || Array.isArray(w.split)) {
    invalid("split is an object carrying provider and client — the one operative division of the disputed amount (arbiter.html §4)");
  }
  const split = w.split as Record<string, unknown>;
  if (!isNonNegInt(split.provider) || !isNonNegInt(split.client)) {
    invalid(
      "split.provider and split.client are non-negative integers: the answer runs from full release to full refund, in whole units, and a negative share is authority nobody granted (arbiter.html §4)",
    );
  }
  if ((split.provider as number) + (split.client as number) !== disputed.amount) {
    invalid(
      "split.provider + split.client must equal disputed.amount exactly, in whole units: money divides one way in this family — by integers, with nothing left over and nothing invented (arbiter.html §4 rule 1)",
    );
  }
  if (expected !== undefined) {
    if (expected.disputed_amount !== undefined && disputed.amount !== expected.disputed_amount) {
      invalid(
        "the verdict's disputed.amount is not the amount this dispute was opened against; the parties' signatures granted authority over that amount and nothing else (§5.10.2, arbiter.html §4)",
      );
    }
    if (expected.currency !== undefined && disputed.currency !== expected.currency) {
      invalid(
        "the verdict's currency is not the engagement's; a split in some other money divides nothing this clause froze (§5.10.2, arbiter.html §4)",
      );
    }
  }
  if (typeof w.attribution !== "string" || !w.attribution.trim() || w.attribution.length > ARBITER_NAME_MAX) {
    invalid(
      "attribution names a failure from the Agent SoW failure vocabulary, so the finding becomes the same kind of evidence as a failure recorded honestly in the first place — a non-empty name (arbiter.html §4 rule 2)",
    );
  }
  if (typeof w.basis !== "object" || w.basis === null || Array.isArray(w.basis)) {
    invalid("basis is an object carrying count and ids_sha256 — no cited basis, no conforming verdict (arbiter.html §3.5)");
  }
  const basis = w.basis as Record<string, unknown>;
  if (!isNonNegInt(basis.count)) {
    invalid("basis.count is a non-negative integer: how many records were before the judge");
  }
  if (typeof basis.ids_sha256 !== "string" || !SHA256_HEX_RE.test(basis.ids_sha256)) {
    invalid(
      "basis.ids_sha256 is exactly 64 lowercase hex characters — sha256 over the JCS array of the record ids, sorted, so a verifier holding the records recomputes and compares (arbiter.html §4 rule 3)",
    );
  }
  if (basis.excluded !== undefined) {
    if (!Array.isArray(basis.excluded)) {
      invalid("excluded is a list of the records that failed verification, each named with the reason (arbiter.html §3.1)");
    }
    if (basis.excluded.length === 0) {
      invalid(
        "an empty excluded list declares nothing, which OMITTING the member already means; two spellings of one state is how implementations come to disagree about which is which",
      );
    }
    for (const e of basis.excluded) {
      if (typeof e !== "object" || e === null || Array.isArray(e)) {
        invalid("each exclusion is an object carrying id and why");
      }
      const x = e as Record<string, unknown>;
      if (typeof x.id !== "string" || !x.id.trim() || x.id.length > ARBITER_NAME_MAX) {
        invalid("an exclusion names the record it excludes");
      }
      if (typeof x.why !== "string" || !x.why.trim()) {
        invalid(
          "an exclusion carries the reason the record fell out of the basis; excluded and unexplained is indistinguishable from suppressed (arbiter.html §3.1)",
        );
      }
    }
  }
  if (typeof w.heard !== "object" || w.heard === null || Array.isArray(w.heard)) {
    invalid("heard is an object saying whether each party's submission was received (arbiter.html §3.6)");
  }
  const heard = w.heard as Record<string, unknown>;
  if (typeof heard.provider !== "boolean" || typeof heard.client !== "boolean") {
    invalid(
      "heard carries BOTH booleans, provider and client: the verdict must say whether each was received, and silence from a party is recorded, never punished by inference (arbiter.html §3.6)",
    );
  }
  if (typeof w.reasons !== "string" || !w.reasons.trim()) {
    invalid("reasons is the prose a person reads; machines read the split and the attribution (arbiter.html §4 rule 5)");
  }
  if (typeof w.produced_at !== "string" || !RFC3339.test(w.produced_at)) {
    invalid("produced_at must be an RFC-3339 instant — a late verdict is not a verdict, so when it was produced is load-bearing (arbiter.html §3.8)");
  }
  if (typeof w.by !== "string" || !w.by.trim() || w.by.length > ARBITER_NAME_MAX) {
    invalid("by is the arbiter agent's public key (arbiter.html §4)");
  }
  if (w.signatures !== undefined && !Array.isArray(w.signatures)) {
    invalid("signatures is the list the arbiter's signature is appended to (arbiter.html §4)");
  }
}

/** The exact bytes an arbiter signs: {@link ARBITER_VERDICT_SIG_PREFIX} + the
 *  JCS canonical JSON of the verdict with `signatures` removed. The
 *  canonicalization is {@link canonicalSowJSON}'s — document minus
 *  `signatures`, canonicalized — deliberately reused rather than re-implemented,
 *  under the verdict's own tag. */
export function arbiterVerdictSignedBytes(verdict: object): Uint8Array {
  return new TextEncoder().encode(ARBITER_VERDICT_SIG_PREFIX + canonicalSowJSON(verdict));
}

/**
 * Sign a verdict as the arbiter, appending to `signatures` — the borrowed
 * authority the parties' signatures granted is spent the moment this record
 * is appended (arbiter.html §3.3).
 */
export function signArbiterVerdict<T extends object>(
  verdict: T,
  kp: KeyPair,
  signedAt?: string,
): T & { signatures: SowArbiterVerdictSignature[] } {
  const existing = ((verdict as { signatures?: SowArbiterVerdictSignature[] }).signatures ?? []).filter(
    (s) => s.key !== kp.getPublicKey(),
  );
  const sig = toB64Url(signTagged(kp, ARBITER_VERDICT_SIG_PREFIX, canonicalSowJSON(verdict)));
  return {
    ...verdict,
    signatures: [
      ...existing,
      {
        key: kp.getPublicKey(),
        signed_at: signedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        sig,
      },
    ],
  };
}

/** Verify one signature record against the verdict's canonical bytes. Where
 *  clearing honors the clause, this verification is what money moves on:
 *  verifying the arbiter's signature is arithmetic even though its judgment
 *  is not. */
export function verifyArbiterVerdictSignature(
  verdict: object,
  signature: SowArbiterVerdictSignature,
): boolean {
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromB64Url(signature.sig);
  } catch {
    return false;
  }
  return verifyTagged(signature.key, ARBITER_VERDICT_SIG_PREFIX, canonicalSowJSON(verdict), sigBytes);
}

// ── §5.11: confidentiality and retention ────────────────────────────────────

/**
 * The closed promise vocabulary (§5.11), and the only spelling a promise has:
 * presence, as the literal `true`. Absence carries the weak meaning
 * throughout — a promise left out is a promise not made, and a reader MUST
 * NOT infer it. There is no `false`: it is spelled by omission.
 */
export type SowConfidentialityPromise =
  | "no_training"
  | "no_third_party_sharing"
  | "no_human_reading";

export const SOW_CONFIDENTIALITY_PROMISES: readonly SowConfidentialityPromise[] = [
  "no_training",
  "no_third_party_sharing",
  "no_human_reading",
];

/** One service a client's content passes through so the work can happen
 *  (§5.11): the model API behind the agent, a transcription service, any host
 *  that can read what it holds. `service` is the one REQUIRED member — the
 *  client is owed the name so it can go read that service's terms. `domain`
 *  says which service of that name is meant; `purpose` is the narrowest true
 *  statement of what it is used for. Declaring a processor is neither
 *  endorsement nor a transfer of obligation. */
export interface SowProcessor {
  service: string;
  domain?: string;
  purpose?: string;
}

/** The promises a provider makes about what happens inside its own walls
 *  (§5.11). Only `true` is ever stored: a promise left out is a promise not
 *  made — `false` is not a value, it is omission. `no_third_party_sharing`
 *  quantifies over everything EXCEPT the declared processors: it is the
 *  promise that content goes nowhere beyond that list, not the fiction that
 *  it goes nowhere at all. */
export interface SowConfidentialityPromises {
  no_training?: true;
  no_third_party_sharing?: true;
  no_human_reading?: true;
}

/**
 * The canonical split clause (§5.11). Sub-clauses are graded separately and
 * MUST NOT be merged: sealed transport and retention windows are
 * runtime-checkable and graded `enforced`; what a party does with data inside
 * its own walls is checkable by nobody, so the promises are `recorded`, and a
 * conforming renderer MUST NOT present them as enforced.
 *
 * Absence carries the weak meaning throughout. An EMPTY `processors` list is
 * itself a statement — content leaves the provider for nowhere — while
 * omitting the member entirely states nothing, and a reader MUST NOT mistake
 * silence for either answer. Shapes pinned by `conformance/sow-data-use.json`.
 */
export interface SowConfidentiality {
  transport?: { sealed: boolean; grade: "enforced" };
  retention?: { max_days: number; grade: "enforced" };
  processors?: SowProcessor[];
  promises?: SowConfidentialityPromises & { grade: "recorded" };
}

/**
 * What a client requires of a counterparty's confidentiality clause — the
 * requirement side of §5.11's pre-admission shadow, compared by
 * {@link confidentialityShortfall}. Every required promise must be declared,
 * and a declared retention window must be no longer than the required
 * ceiling.
 *
 * Processor ACCEPTABILITY is deliberately not here in v1: which processors a
 * client will tolerate is a policy question with its own machinery, and
 * tracker #145 owns it. The list is still validated and still signed — it is
 * only the comparison that does not read it yet.
 */
export interface SowConfidentialityRequirement {
  promises?: SowConfidentialityPromise[];
  retention_max_days?: number;
  /**
   * The jurisdictions content may be processed in. The document's declared
   * `processed_in` must be stated and a subset of this list: the same test
   * §5.15 applies going down a subcontract chain, applied here between a
   * requirement and the document answering it, and for the same reason.
   * Silence fails rather than passing, because an unstated jurisdiction may
   * be any jurisdiction.
   *
   * An EMPTY list asks nothing, exactly as an empty `promises` list does. A
   * requirement allowing no jurisdiction at all would forbid the work rather
   * than confine it, and is not a thing anybody means.
   */
  processed_in?: string[];
}

/** Backstops, not policy. A clause naming dozens of processors is a data-flow
 *  inventory wearing a clause's clothes. */
const CONFIDENTIALITY_PROCESSORS_MAX = 16;
const PROCESSOR_SERVICE_MAX = 120;
const PROCESSOR_DOMAIN_MAX = 120;
const PROCESSOR_PURPOSE_MAX = 300;

export function validateSowConfidentiality(v: unknown): asserts v is SowConfidentiality {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid(
      "a confidentiality clause is an object of separately graded sub-clauses — transport, retention, processors, promises (§5.11)",
    );
  }
  const c = v as Record<string, unknown>;
  if (c.transport !== undefined) {
    if (typeof c.transport !== "object" || c.transport === null || Array.isArray(c.transport)) {
      invalid("transport is an object carrying sealed and grade (§5.11)");
    }
    const t = c.transport as Record<string, unknown>;
    if (typeof t.sealed !== "boolean") {
      invalid("transport.sealed is a boolean: the channel either is sealed or it is not (§5.11)");
    }
    if (t.grade !== "enforced") {
      invalid(
        "transport is graded 'enforced': whether the channel is sealed is runtime-checkable, and a clause claiming less understates what ships (§5.11, §4.2)",
      );
    }
  }
  if (c.retention !== undefined) {
    if (typeof c.retention !== "object" || c.retention === null || Array.isArray(c.retention)) {
      invalid("retention is an object carrying max_days and grade (§5.11)");
    }
    const r = c.retention as Record<string, unknown>;
    if (!isPosInt(r.max_days)) {
      invalid(
        "retention.max_days is a positive whole number of days; a fractional ceiling invites two implementations to round differently (§5.11)",
      );
    }
    if (r.grade !== "enforced") {
      invalid(
        "retention is graded 'enforced': a retention window is runtime-checkable, and a clause claiming less understates what ships (§5.11, §4.2)",
      );
    }
  }
  if (c.processors !== undefined) {
    if (!Array.isArray(c.processors)) {
      invalid(
        "processors is a list of the services content passes through, even with one entry — and an empty list is itself a statement: content leaves the provider for nowhere (§5.11)",
      );
    }
    // NO minimum: [] is valid and meaningful (§5.11's absence paragraph —
    // empty states "nowhere", omission states nothing). This deliberately
    // differs from additions/rests_on, where empty is a second spelling of
    // omission and refused for it.
    if (c.processors.length > CONFIDENTIALITY_PROCESSORS_MAX) {
      invalid(
        `a confidentiality clause names at most ${CONFIDENTIALITY_PROCESSORS_MAX} processors; a clause naming dozens is a data-flow inventory wearing a clause's clothes (§5.11)`,
      );
    }
    const seen = new Set<string>();
    for (const p of c.processors) {
      if (typeof p !== "object" || p === null || Array.isArray(p)) {
        invalid("each processor is an object carrying service, and optionally domain and purpose (§5.11)");
      }
      const pr = p as Record<string, unknown>;
      if (typeof pr.service !== "string" || !pr.service.trim() || pr.service.length > PROCESSOR_SERVICE_MAX) {
        invalid(
          `a processor's service is the one required member — the client is owed the name so it can go read that service's terms — up to ${PROCESSOR_SERVICE_MAX} characters, and not blank (§5.11)`,
        );
      }
      if (
        pr.domain !== undefined &&
        (typeof pr.domain !== "string" || !pr.domain.trim() || pr.domain.length > PROCESSOR_DOMAIN_MAX)
      ) {
        invalid(
          `a processor's domain says which service of that name is meant, up to ${PROCESSOR_DOMAIN_MAX} characters, and not blank (§5.11)`,
        );
      }
      if (
        pr.purpose !== undefined &&
        (typeof pr.purpose !== "string" || !pr.purpose.trim() || pr.purpose.length > PROCESSOR_PURPOSE_MAX)
      ) {
        invalid(
          `a processor's purpose is the narrowest true statement of what it is used for, up to ${PROCESSOR_PURPOSE_MAX} characters, and not blank (§5.11)`,
        );
      }
      const key = `${pr.service}\n${typeof pr.domain === "string" ? pr.domain : ""}`;
      if (seen.has(key)) {
        invalid(
          "the same service and domain pair twice states nothing new; a reader cannot tell whether the second entry is a mistake or a different service (§5.11)",
        );
      }
      seen.add(key);
    }
  }
  if (c.promises !== undefined) {
    if (typeof c.promises !== "object" || c.promises === null || Array.isArray(c.promises)) {
      invalid("promises is an object of the promises made, each spelled as the literal true, plus its grade (§5.11)");
    }
    const p = c.promises as Record<string, unknown>;
    for (const name of SOW_CONFIDENTIALITY_PROMISES) {
      if (p[name] !== undefined && p[name] !== true) {
        invalid(
          `a promise is spelled by presence: ${name} is either the literal true or absent — false is not a value, it is spelled by omission, because a promise left out is a promise not made (§5.11)`,
        );
      }
    }
    if (p.grade !== "recorded") {
      invalid(
        "promises are graded 'recorded': what a party does with data inside its own walls is checkable by nobody, and a conforming renderer MUST NOT present these as enforced (§5.11, §4.2)",
      );
    }
  }
}

/** The clause a document declares, unvalidated, or null where it declares
 *  none. Same contract as {@link reportingOf}. */
export function confidentialityOf(doc: unknown): SowConfidentiality | null {
  if (typeof doc !== "object" || doc === null) return null;
  const c = (doc as { confidentiality?: unknown }).confidentiality;
  return typeof c === "object" && c !== null && !Array.isArray(c) ? (c as SowConfidentiality) : null;
}

/**
 * The deterministic comparison §5.11's pre-admission shadow rests on: does
 * this document meet `required`? Null where it meets — including a retention
 * ceiling met exactly, because the test is a ceiling, and including any
 * document at all against an empty requirement, which asks nothing.
 *
 * A shortfall is a SENTENCE, not a refusal — same contract as
 * {@link reportingShortfall}, and the wording is pinned by the fixture for
 * the same reason: a client reads one message whichever SDK evaluated it.
 * Three facts get three kinds of sentence — declared nothing, declared
 * something unreadable, and declared less than was required — checked in that
 * order, with required promises compared in the REQUIREMENT'S declared order
 * (the first missing one is reported), then retention, then jurisdictions.
 *
 * The jurisdiction test is §5.15's, applied between a requirement and the
 * document answering it rather than between a prime and its subcontract: the
 * declared set must be stated and a subset of the required one, and silence
 * fails because an unstated jurisdiction may be any jurisdiction. It reads
 * `processed_in` as declared structure, which is the posture
 * `subcontractConformance` already takes and the reason there is one
 * implementation of this rule rather than two.
 *
 * Unlike reporting, absence here is NOT a level that meets a floor: a
 * document declaring no clause against a requirement that states terms is
 * counted as not meeting rather than read charitably — silence is not an
 * answer (§5.11).
 *
 * Processor acceptability is deliberately not compared in v1 — tracker #145
 * owns it. See {@link SowConfidentialityRequirement}.
 */
export function confidentialityShortfall(
  required: SowConfidentialityRequirement,
  doc: unknown,
): string | null {
  const wantedPromises = required.promises ?? [];
  const wantedIn = required.processed_in ?? [];
  const wantsAnything =
    wantedPromises.length > 0 || required.retention_max_days !== undefined || wantedIn.length > 0;
  if (!wantsAnything) return null;
  const raw =
    typeof doc === "object" && doc !== null ? (doc as { confidentiality?: unknown }).confidentiality : undefined;
  if (raw === undefined || raw === null) {
    return (
      "the requirement states confidentiality terms and this document declares none; " +
      "silence is not an answer, and it is counted as not meeting rather than read charitably (§5.11)"
    );
  }
  try {
    validateSowConfidentiality(raw);
  } catch {
    return (
      "the requirement states confidentiality terms and this document's confidentiality clause is in a shape that cannot be read, " +
      "so what it promises cannot be established; it is counted as not meeting rather than passed unread (§5.11)"
    );
  }
  const clause = raw as SowConfidentiality;
  for (const name of wantedPromises) {
    if (clause.promises?.[name] !== true) {
      return `the requirement includes the promise ${name} and this document does not make it; a promise left out is a promise not made (§5.11)`;
    }
  }
  if (required.retention_max_days !== undefined) {
    const n = required.retention_max_days;
    if (clause.retention === undefined) {
      return `the requirement caps retention at ${n} days and this document states no retention ceiling; an unstated ceiling does not meet a stated one (§5.11)`;
    }
    const m = clause.retention.max_days;
    if (m > n) {
      return `the requirement caps retention at ${n} days and this document keeps content up to ${m} days; the test is a ceiling, and it is not met (§5.11)`;
    }
  }
  if (wantedIn.length > 0) {
    const list = wantedIn.join(", ");
    const declared = statedJurisdictions(raw as Record<string, unknown>);
    if (declared === null) {
      return `the requirement confines processing to ${list} and this document states no jurisdictions; an unstated jurisdiction may be any jurisdiction, and it is counted as not meeting rather than read charitably (§5.11)`;
    }
    const allowed = new Set(wantedIn);
    for (const j of declared) {
      if (!allowed.has(j)) {
        return `the requirement confines processing to ${list} and this document processes in ${j}; a party may touch no jurisdiction the requirement allowed (§5.11)`;
      }
    }
  }
  return null;
}

// ── §5.12: reporting ────────────────────────────────────────────────────────

/**
 * What arrives while there is still time to act (§5.12).
 *
 * Everything else in the specification reports at the end of something — a
 * task completes or fails, an engagement lapses, a review is written — and all
 * of it arrives when it is already too late to act. The reporting clause says
 * what arrives DURING the work. Three levels, ordered, and the order is the
 * point: two parties compare as integers, and the test is meets or exceeds,
 * never equals — offering more than was asked is not a violation.
 *
 * `check_ins` exists because of the failure `on_change` cannot see: an agent
 * that is quietly stuck reports nothing under a change-triggered rule, because
 * from where it stands nothing has changed — its expectation is stable and
 * wrong. Hence the calendar, and hence the rule that a check-in is not a ping:
 * it MUST carry what was completed, what remains and what it waits on, so a
 * stuck provider cannot emit "on track" forever. Risk is contents of
 * `check_ins`, not a fourth level, and an open risk MUST name what would
 * dissolve it. A missed report rides §5.4's interim-deliverable machinery —
 * no parallel mechanism.
 */
export type SowReportingLevel = "records_only" | "on_change" | "check_ins";

/** Ascending: position IS the rank. The rank is derived from the level string
 *  and never declared, or the two could drift. */
export const SOW_REPORTING_LEVELS: readonly SowReportingLevel[] = [
  "records_only",
  "on_change",
  "check_ins",
];

/** What an absent clause offers: the mechanical record — task states,
 *  deliveries, spend — and nothing else. The honest default for short or
 *  cheap work. Absent is NOT unknown. */
export const DEFAULT_REPORTING_LEVEL: SowReportingLevel = "records_only";

/** §5.12 grades this clause flatly. Not `enforced`: no runtime can make a
 *  provider look honestly at its own work, and a report's content is a claim
 *  like any other. Not `recorded`: detecting the report that did not arrive
 *  is a MUST of both runtimes, which is more than a record of the clause.
 *  What is mechanical is whether it arrived. */
export const SOW_REPORTING_GRADE: SowGrade = "evidence";

export function reportingLevelRank(level: SowReportingLevel): number {
  return SOW_REPORTING_LEVELS.indexOf(level);
}

/** The §5.12 test: meets or exceeds, never equals. A provider offering
 *  `check_ins` against a requirement of `on_change` has exceeded it, not
 *  violated it. */
export function meetsReportingLevel(offered: SowReportingLevel, required: SowReportingLevel): boolean {
  return reportingLevelRank(offered) >= reportingLevelRank(required);
}

/** The clause (§5.12). Shapes pinned by `conformance/sow-reporting.json`. */
export interface SowReporting {
  level: SowReportingLevel;
  /** The cadence, an ISO 8601 duration like `P1W`. `check_ins` only, and
   *  required there: without it, the report that did not arrive cannot be
   *  detected, and §5.12's miss machinery has nothing to measure against. */
  every?: string;
  /** What arrives beyond the level's floor, in words a person reads. */
  additions?: string[];
  /** Always `evidence` — see {@link SOW_REPORTING_GRADE}. */
  grade: "evidence";
}

const REPORTING_ADDITION_MAX = 300;
/** A backstop, not a policy — mirrors §12.1's. A clause stating dozens of
 *  additions is a reporting regime wearing a clause's clothes. */
const REPORTING_ADDITIONS_MAX = 10;

const MS_PER_DAY = 86400000;

/**
 * The cadence in milliseconds, or a refusal (§5.12).
 *
 * ISO 8601 durations restricted to spans of FIXED length: weeks, days, hours,
 * minutes, seconds, in whole units of at most six digits per component, with
 * ISO's own rule that a week term stands alone. Months and years are refused
 * by name: a calendar month is not a fixed span of time, and a cadence two
 * runtimes measure differently is a missed-report detector that disagrees
 * with itself. The millisecond values are pinned by the fixture so both SDKs
 * derive the same deadline from the same document.
 */
export function reportingEveryMs(every: string): number {
  const shape = (): never =>
    invalid("every is an ISO 8601 duration in whole weeks, days, hours, minutes or seconds — P1W, P3D, PT12H (§5.12)");
  if (typeof every !== "string" || every[0] !== "P") shape();
  let i = 1;
  let inTime = false;
  let sawWeeks = false;
  let sawAny = false;
  let sawTimeComponent = false;
  // Order within each part: D before T; then H, M, S once each, in order.
  let last = 0;
  let total = 0;
  while (i < every.length) {
    if (every[i] === "T") {
      if (inTime || sawWeeks) shape();
      inTime = true;
      i += 1;
      continue;
    }
    let j = i;
    while (j < every.length && every[j] >= "0" && every[j] <= "9") j += 1;
    if (j === i || j - i > 6 || j >= every.length) shape();
    const n = Number(every.slice(i, j));
    const unit = every[j];
    if (!inTime) {
      if (unit === "W") {
        if (sawAny) invalid("an ISO 8601 week term stands alone: state the cadence as weeks or as days and time, not both (§5.12)");
        sawWeeks = true;
        total += n * 604800000;
      } else if (unit === "D") {
        if (sawWeeks || last > 0) shape();
        last = 1;
        total += n * MS_PER_DAY;
      } else if (unit === "M" || unit === "Y") {
        invalid(
          "a calendar month or year is not a fixed span of time, so a cadence stated in one is not computable the same way twice; state every in weeks, days or hours (§5.12)",
        );
      } else {
        shape();
      }
    } else {
      const order = unit === "H" ? 2 : unit === "M" ? 3 : unit === "S" ? 4 : shape();
      if (order <= last) shape();
      last = order;
      total += n * (unit === "H" ? 3600000 : unit === "M" ? 60000 : 1000);
      sawTimeComponent = true;
    }
    sawAny = true;
    i = j + 1;
  }
  if (!sawAny) shape();
  if (inTime && !sawTimeComponent) shape();
  if (total === 0) invalid("a cadence of zero is no cadence at all (§5.12)");
  return total;
}

export function validateSowReporting(v: unknown): asserts v is SowReporting {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("a reporting clause is an object carrying level and grade (§5.12)");
  }
  const r = v as Record<string, unknown>;
  if (typeof r.level !== "string" || !SOW_REPORTING_LEVELS.includes(r.level as SowReportingLevel)) {
    invalid(
      "a reporting clause's level is 'records_only', 'on_change' or 'check_ins', in ascending order of what the provider owes (§5.12)",
    );
  }
  const level = r.level as SowReportingLevel;
  if (r.grade !== SOW_REPORTING_GRADE) {
    invalid(
      "a reporting clause is graded 'evidence', flatly: the cadence and contents are in the signed document, reports are exportable, and a miss is recorded. " +
        "Not 'enforced' — no runtime can make a provider look honestly at its own work — and not 'recorded', because detecting the report that did not arrive is a MUST (§5.12, §4.2)",
    );
  }
  if (level === "check_ins") {
    if (typeof r.every !== "string") {
      invalid(
        "check_ins is the level with a calendar: without every, the report that did not arrive cannot be detected, and §5.12's miss machinery has nothing to measure against",
      );
    }
    reportingEveryMs(r.every);
  } else if (r.every !== undefined) {
    invalid(
      "only check_ins carries every: on_change is change-triggered with no calendar, and records_only owes nothing beyond the mechanical record (§5.12)",
    );
  }
  if (r.additions !== undefined) {
    if (!Array.isArray(r.additions)) {
      invalid("additions is a list of what arrives beyond the level's floor, in words (§5.12)");
    }
    if (r.additions.length === 0) {
      invalid(
        "an empty additions list declares nothing, which OMITTING the member already means; two spellings of one state is how implementations come to disagree about which is which (§5.12)",
      );
    }
    if (r.additions.length > REPORTING_ADDITIONS_MAX) {
      invalid(
        `a reporting clause states at most ${REPORTING_ADDITIONS_MAX} additions; a clause stating dozens is a reporting regime wearing a clause's clothes (§5.12)`,
      );
    }
    for (const a of r.additions) {
      if (typeof a !== "string" || !a.trim() || a.length > REPORTING_ADDITION_MAX) {
        invalid(`each addition is a sentence a person reads, up to ${REPORTING_ADDITION_MAX} characters (§5.12)`);
      }
    }
  }
}

/** The clause a document declares, unvalidated, or null where it declares
 *  none. Same contract as {@link qualificationsOf}. */
export function reportingOf(doc: unknown): SowReporting | null {
  if (typeof doc !== "object" || doc === null) return null;
  const r = (doc as { reporting?: unknown }).reporting;
  return typeof r === "object" && r !== null && !Array.isArray(r) ? (r as SowReporting) : null;
}

/**
 * The advisory comparison a mandate uses: does what this document offers meet
 * `required`? Null where it meets — including everything against a
 * requirement of `records_only`, which is the floor every document meets.
 *
 * A shortfall is a SENTENCE, not a refusal: an advisory mandate marks the
 * document non-conforming and shows the sentence, and whoever stated the
 * requirement decides what to do about it. Three facts get three different
 * sentences — declared lower, declared nothing, declared something
 * unreadable — because "you offered less" and "what you offered cannot be
 * established" are different statements, and only one of them is about the
 * responder's choice. The exact wording is pinned by the fixture: a responder
 * reads one message whichever SDK evaluated it.
 *
 * The comparison is over two DECLARED fields (§5.12: the declaring party owns
 * its own structure) — nothing here reads anyone's prose.
 */
export function reportingShortfall(required: SowReportingLevel, doc: unknown): string | null {
  if (required === DEFAULT_REPORTING_LEVEL) return null;
  const raw = typeof doc === "object" && doc !== null ? (doc as { reporting?: unknown }).reporting : undefined;
  if (raw === undefined || raw === null) {
    return (
      `the required reporting level is ${required} and this document declares no reporting clause, ` +
      "which offers records_only, the mechanical record only; the test is meets or exceeds, and it does not meet (§5.12)"
    );
  }
  try {
    validateSowReporting(raw);
  } catch {
    return (
      `the required reporting level is ${required} and this document's reporting clause is in a shape that cannot be read, ` +
      "so what it offers cannot be established; it is counted as not meeting rather than passed unread (§5.12)"
    );
  }
  const offered = (raw as SowReporting).level;
  if (meetsReportingLevel(offered, required)) return null;
  return `the required reporting level is ${required} and this document offers ${offered}; the test is meets or exceeds, and it does not meet (§5.12)`;
}

/**
 * §5.12's "cadence follows the money", as the warning a runtime MAY show and
 * the refusal it MUST NOT make.
 *
 * Where the engagement has a cap, `every` SHOULD be shorter than the time in
 * which the provider could spend what remains of it — weekly check-ins on an
 * engagement whose whole cap can burn in a day are decoration. The derivation
 * rests on a spend rate neither party knows exactly in advance, so
 * `spendPerDay` is whatever the caller measured (a metering platform has an
 * observed rate; a client node may only have an estimate), and no answer here
 * refuses anything. Zero cap or zero spend is no derivation at all: null.
 *
 * Money is floored on the way in — the one way this file computes money — and
 * the boundary is exact: warn when `everyMs * spendPerDay >=
 * capRemaining * msPerDay`, cross-multiplied in BigInt so two implementations
 * cannot disagree by one at the boundary. "Not shorter" includes "equal": an
 * interval that exactly covers the burn still lets the money be gone when the
 * report arrives.
 */
export function reportingCadenceWarning(
  reporting: SowReporting,
  capRemaining: number,
  spendPerDay: number,
): string | null {
  if (reporting.level !== "check_ins" || typeof reporting.every !== "string") return null;
  const cap = Math.floor(capRemaining);
  const spend = Math.floor(spendPerDay);
  if (cap <= 0 || spend <= 0) return null;
  const everyMs = reportingEveryMs(reporting.every);
  if (BigInt(everyMs) * BigInt(spend) < BigInt(cap) * BigInt(MS_PER_DAY)) return null;
  return (
    `at ${spend} per day, the remaining cap of ${cap} can be spent within one reporting interval of ${reporting.every}; ` +
    "the money can be gone before the next check-in arrives (§5.12: cadence follows the money). " +
    "A runtime MAY warn on this and MUST NOT refuse the engagement over it"
  );
}

// ── §5.13: liability ────────────────────────────────────────────────────────

/**
 * The liability clause (§5.13). Shapes pinned by `conformance/sow-terms.json`.
 *
 * Everything else in the specification bounds what the CLIENT can lose: the
 * cap, the reservation, the ceiling. Nothing bounds what the PROVIDER can
 * lose, and that asymmetry prices honest sellers out of exactly the work
 * worth selling. This clause is where the parties bound it, mutually, in the
 * signed bytes.
 *
 * `cap` is MUTUAL — it bounds each party's total liability to the other — and
 * is stated in exactly ONE form: a multiple of fees actually paid or payable,
 * or an absolute figure in a stated currency. `carve_outs` and
 * `indemnification` are PROSE, deliberately: nothing here refuses or gates on
 * a carve-out, so a closed vocabulary would buy determinism nothing needs,
 * and the sentence a judge reads is the operative artifact.
 *
 * Graded `recorded`, and this is the clause the grade vocabulary exists for:
 * no runtime enforces a liability cap, measures damages, or holds anyone
 * harmless — courts do, reading the signed document. A conforming renderer
 * MUST NOT present any part of this clause as enforced, and a runtime MUST
 * NOT refuse or gate anything on it. What the machinery provides is exactly
 * what it can: the clause sits inside the signed bytes, so neither party can
 * later dispute what was agreed.
 */
export interface SowLiability {
  /** Exactly one form — both or neither is refused. */
  cap: { multiple_of_fees: number } | { amount: number; currency: string };
  /** What the cap does NOT cover, in words a court reads. */
  carve_outs?: string[];
  /** Each party's hold-harmless statements, prose again, same reasoning. */
  indemnification?: { by_provider?: string[]; by_client?: string[] };
  /** Always `recorded` — see the validator's refusal for why nothing else is
   *  an honest grade here. */
  grade: "recorded";
}

/** The same backstops the §5.12 additions list carries — a backstop, not a
 *  policy. A clause stating dozens of carve-outs is a liability regime
 *  wearing a clause's clothes. */
const LIABILITY_PROSE_MAX = 300;
const LIABILITY_PROSE_ENTRIES_MAX = 10;

function checkLiabilityProse(v: unknown, name: string): void {
  if (!Array.isArray(v)) {
    invalid(`${name} is a list of prose statements a court reads, even with one entry (§5.13)`);
  }
  if (v.length === 0) {
    invalid(
      `an empty ${name} list declares nothing, which OMITTING the member already means; two spellings of one state is how implementations come to disagree about which is which (§5.13)`,
    );
  }
  if (v.length > LIABILITY_PROSE_ENTRIES_MAX) {
    invalid(
      `a liability clause states at most ${LIABILITY_PROSE_ENTRIES_MAX} ${name} entries; a clause stating dozens is a liability regime wearing a clause's clothes (§5.13)`,
    );
  }
  for (const e of v) {
    if (typeof e !== "string" || !e.trim() || e.length > LIABILITY_PROSE_MAX) {
      invalid(`each ${name} entry is a sentence a court reads, up to ${LIABILITY_PROSE_MAX} characters, and not blank (§5.13)`);
    }
  }
}

export function validateSowLiability(v: unknown): asserts v is SowLiability {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("a liability clause is an object carrying cap and grade (§5.13)");
  }
  const l = v as Record<string, unknown>;
  if (typeof l.cap !== "object" || l.cap === null || Array.isArray(l.cap)) {
    invalid(
      "the cap is required, and it is an object: a liability clause exists to bound each party's exposure, and one that names no bound states nothing a court can read a number from (§5.13)",
    );
  }
  const cap = l.cap as Record<string, unknown>;
  const asMultiple = "multiple_of_fees" in cap;
  const asAmount = "amount" in cap || "currency" in cap;
  if (asMultiple && asAmount) {
    invalid(
      "the cap is stated in exactly ONE form — a multiple of fees, or an absolute amount with its currency, never both: two bounds in one cap is two clauses disagreeing about the number (§5.13)",
    );
  }
  if (!asMultiple && !asAmount) {
    invalid(
      "the cap is stated in exactly ONE form — multiple_of_fees, or amount with currency; a cap naming neither bounds nothing (§5.13)",
    );
  }
  if (asMultiple) {
    if (!isPosInt(cap.multiple_of_fees)) {
      invalid(
        "multiple_of_fees is a positive whole number, applied to fees actually paid or payable; a zero multiple caps at nothing, and a fractional one invites two implementations to round differently (§5.13)",
      );
    }
  } else {
    if (!isPosInt(cap.amount)) {
      invalid("cap.amount is a positive integer in the smallest unit of its currency — never a float, never zero (§5.13)");
    }
    if (typeof cap.currency !== "string" || !CURRENCY_RE.test(cap.currency)) {
      invalid("cap.currency is a three-letter uppercase code (§5.13)");
    }
  }
  if (l.carve_outs !== undefined) checkLiabilityProse(l.carve_outs, "carve_outs");
  if (l.indemnification !== undefined) {
    if (typeof l.indemnification !== "object" || l.indemnification === null || Array.isArray(l.indemnification)) {
      invalid("indemnification is an object carrying by_provider and/or by_client (§5.13)");
    }
    const ind = l.indemnification as Record<string, unknown>;
    if (ind.by_provider === undefined && ind.by_client === undefined) {
      invalid(
        "an indemnification member naming neither party's statements declares nothing, which OMITTING the member already means (§5.13)",
      );
    }
    if (ind.by_provider !== undefined) checkLiabilityProse(ind.by_provider, "indemnification.by_provider");
    if (ind.by_client !== undefined) checkLiabilityProse(ind.by_client, "indemnification.by_client");
  }
  if (l.grade !== "recorded") {
    invalid(
      "a liability clause is graded 'recorded', and this is the clause the grade vocabulary exists for: no runtime enforces a liability cap, measures damages, or holds anyone harmless — courts do, reading the signed document. " +
        "Not 'enforced' — a conforming renderer MUST NOT present any part of this clause as enforced, and a runtime MUST NOT refuse or gate anything on it — and not 'evidence', because what the machinery provides is exactly the record of what was agreed, nothing more (§5.13, §4.2)",
    );
  }
}

/**
 * The clause a document declares, unvalidated, or null where it declares
 * none. Same contract as {@link disputesOf}.
 *
 * ABSENCE STATES NOTHING (§5.13). A document without a liability clause
 * leaves the parties wherever the law leaves them, which for the provider
 * usually means unbounded. There is deliberately no default cap: silence is
 * not a number, and a party that wants a bound writes one — so null here is
 * null, never a synthesized clause.
 */
export function liabilityOf(doc: unknown): SowLiability | null {
  if (typeof doc !== "object" || doc === null) return null;
  const l = (doc as { liability?: unknown }).liability;
  return typeof l === "object" && l !== null && !Array.isArray(l) ? (l as SowLiability) : null;
}

// ── §5.14: service floors ───────────────────────────────────────────────────

/**
 * One floor (§5.14): a bound over facts BOTH parties' records already hold.
 *
 * One kind in this revision — `each_task_within`, the span from a task's
 * request arriving to its terminal response, in the §5.12 duration grammar
 * ({@link reportingEveryMs} is the ONE duration reading in the system). The
 * vocabulary is closed and deliberately small, and it grows only where a
 * record exists to measure against: a floor written over something neither
 * party's records can check is not a floor, it is decoration. Uptime
 * percentages and latency percentiles are exactly that here.
 */
export interface SowServiceFloor {
  /** 1-40 lowercase letters, digits and dashes — the qualification-id shape,
   *  and what a recorded miss names. */
  id: string;
  each_task_within: string;
}

/**
 * The stated consequence (§5.14): after `misses` floor misses inside
 * `within`, the client MAY terminate for cause (§5.9), citing the recorded
 * misses. MAY, deliberately — the machinery counts and records, and the
 * client decides. Nothing terminates anyone automatically, because a floor
 * miss can have a cause the parties want to talk about first, and a remedy
 * exercised by a machine is a remedy nobody can waive.
 */
export interface SowServiceFloorsBreach {
  misses: number;
  within: string;
  remedy: "terminate_for_cause";
}

/** The closed remedy set — one member, deliberately, and it grows only with
 *  the spec: a remedy is what §5.9's existing machinery can carry, and a
 *  remedy invented here would promise an enforcement no runtime performs. */
export const SOW_FLOOR_REMEDIES: readonly ["terminate_for_cause"] = ["terminate_for_cause"];

/**
 * The service floors clause (§5.14). Shapes pinned by
 * `conformance/sow-terms.json`.
 *
 * The reporting clause (§5.12) catches the agent that is silently stuck;
 * this one catches the agent that is honestly, measurably slow. A miss is a
 * RECORDED OBLIGATION FAILURE, not a money movement: a task that ran past
 * its floor is recorded on the engagement the way a failed deliverable-form
 * check is (§5.4), from timestamps, with no new machinery. A refused task
 * misses no floor — refusal is its own record; floors bind work the provider
 * took.
 */
export interface SowServiceFloors {
  floors: SowServiceFloor[];
  /** REQUIRED: a floor without a stated consequence is decoration. */
  breach: SowServiceFloorsBreach;
  /** Always `evidence` — see the validator's refusal. */
  grade: "evidence";
}

/** A backstop, not a policy — the qualifications ceiling, for the same
 *  reason: a clause stating dozens of floors is an SLA wearing a clause's
 *  clothes. */
const SERVICE_FLOORS_MAX = 10;

export function validateSowServiceFloors(v: unknown): asserts v is SowServiceFloors {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("a service floors clause is an object carrying floors, breach and grade (§5.14)");
  }
  const s = v as Record<string, unknown>;
  if (!Array.isArray(s.floors) || s.floors.length === 0) {
    invalid("floors is a non-empty list: a service floors clause that names no floor bounds nothing (§5.14)");
  }
  if (s.floors.length > SERVICE_FLOORS_MAX) {
    invalid(
      `a service floors clause states at most ${SERVICE_FLOORS_MAX} floors; a clause stating dozens is an SLA wearing a clause's clothes (§5.14)`,
    );
  }
  const seen = new Set<string>();
  for (const raw of s.floors) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      invalid("each floor is an object carrying id and each_task_within (§5.14)");
    }
    const f = raw as Record<string, unknown>;
    if (typeof f.id !== "string" || !QUALIFICATION_ID_RE.test(f.id)) {
      invalid("a floor's id is 1-40 lowercase letters, digits and dashes — it is what a recorded miss names (§5.14)");
    }
    if (seen.has(f.id)) {
      invalid(`two floors share the id "${f.id}", and a recorded miss has to name one of them (§5.14)`);
    }
    seen.add(f.id);
    if (typeof f.each_task_within !== "string") {
      invalid(
        "each_task_within is the span from a task's request arriving to its terminal response, in the §5.12 duration grammar (§5.14)",
      );
    }
    // The §5.12 grammar, reused — ONE duration reading in the system. Its own
    // refusals ride along: a calendar month is refused by name here exactly as
    // it is on a reporting cadence.
    reportingEveryMs(f.each_task_within);
  }
  if (typeof s.breach !== "object" || s.breach === null || Array.isArray(s.breach)) {
    invalid(
      "breach — misses, within, remedy — is required: a floor without a stated consequence is decoration (§5.14)",
    );
  }
  const b = s.breach as Record<string, unknown>;
  if (!isPosInt(b.misses)) {
    invalid("breach.misses is a positive whole number of floor misses (§5.14)");
  }
  if (typeof b.within !== "string") {
    invalid("breach.within is the window the misses are counted inside, in the §5.12 duration grammar (§5.14)");
  }
  reportingEveryMs(b.within);
  if (b.remedy !== "terminate_for_cause") {
    invalid(
      "the remedy vocabulary is closed, and in this revision it has one member: 'terminate_for_cause' — §5.9's existing machinery carrying a stated cause. It grows only with the spec; a remedy invented here would promise an enforcement no runtime performs (§5.14)",
    );
  }
  if (s.grade !== "evidence") {
    invalid(
      "a service floors clause is graded 'evidence', flatly: the timestamps are in the records, the misses are recorded, and the termination-for-cause path is §5.9's existing machinery carrying a stated cause. " +
        "Not 'enforced' — nothing here pauses a slow task or makes a fast one, and a conforming renderer presents floors as agreed bounds with a record, never as a guarantee — and not 'recorded', because detecting the task that ran past its floor is a mechanical MUST, which is more than a record of the clause (§5.14, §4.2)",
    );
  }
}

/**
 * The clause a document declares, unvalidated, or null where it declares
 * none. Same contract as {@link liabilityOf}.
 *
 * ABSENCE STATES NOTHING (§5.14): no floors were agreed, and no speed is
 * implied either way — null here is null, never a default bound.
 */
export function serviceFloorsOf(doc: unknown): SowServiceFloors | null {
  if (typeof doc !== "object" || doc === null) return null;
  const s = (doc as { service_floors?: unknown }).service_floors;
  return typeof s === "object" && s !== null && !Array.isArray(s) ? (s as SowServiceFloors) : null;
}

// ── §5.15: subcontracting ───────────────────────────────────────────────────

/**
 * The closed posture vocabulary (§5.15). Exactly one per clause:
 *
 *  - `none`: the provider performs the work itself. On a mesh where
 *    delegation forms engagements, this is not merely a promise: the platform
 *    holds the engagement records, so on-mesh delegation under a `none`
 *    posture is discoverable evidence, not an argument.
 *  - `disclosed`: delegation is permitted, and every subcontractor is named
 *    in `subcontractors` before its work begins, each entry carrying who and
 *    the narrowest true statement of what is delegated.
 *  - `approved`: as `disclosed`, and each subcontractor additionally requires
 *    the client's countersigned approval before its work begins, riding the
 *    same two-seat machinery amendments use.
 *
 * Whatever the posture, the first principle is the one everything else hangs
 * from: THE BUYER'S CONTRACT IS WITH THE PRIME, FULL STOP. Delegation never
 * dilutes accountability — a subcontractor's failure surfaces to the client
 * as the provider's failure with its cause named, every remedy runs against
 * the provider, and a subcontractor answers to the provider, who is its
 * client in a separate engagement under this same specification.
 */
export type SowSubcontractingPosture = "none" | "disclosed" | "approved";

export const SOW_SUBCONTRACTING_POSTURES: readonly SowSubcontractingPosture[] = [
  "none",
  "disclosed",
  "approved",
];

/**
 * One named delegate (§5.15): a mesh agent by key or handle, or a published
 * role a conforming agent holds — at least one of the three — plus `scope`,
 * the narrowest true statement of what is delegated.
 *
 * **An entry names a party on the mesh, and the vocabulary offers no other
 * kind.** There is deliberately no free-text field for an off-mesh
 * organisation, for the same reason the qualification vocabulary (§12.1) has
 * no probe kind a runtime cannot check: a vocabulary must not express what
 * nothing can verify, and a disclosure nobody can look up, vouch, rate, or
 * hold to account is decoration wearing disclosure's clothes. Under any
 * stated posture, delegating work to a party this clause cannot name is
 * undisclosed subcontracting, which is breach. The parties remain free to
 * arrange anything they like outside this clause and outside this machinery;
 * what the vocabulary refuses to do is bless it.
 *
 * A subcontractor does WORK; a processor supplies a CAPABILITY. A party that
 * produces part of the deliverable or exercises judgment over the work
 * belongs here; a metered service under the provider's own direction (the
 * model API behind the agent) belongs in §5.11's processor list, where
 * off-mesh services are permitted because they are the provider's tools, not
 * its delegates.
 */
export interface SowSubcontractorEntry {
  /** The delegate's agent public key. Shape only: whether the key is real is
   *  the platform's problem. */
  agent?: string;
  /** The delegate's mesh handle. */
  handle?: string;
  /** A published role contract a conforming agent holds. */
  role?: string;
  /** REQUIRED: the narrowest true statement of what is delegated. */
  scope: string;
  /**
   * The §4.1 identifier of the countersigned engagement between this provider
   * and this delegate — the PIN.
   *
   * WHAT IT FIXES. Without it an entry names WHO but not UNDER WHAT, so chain
   * conformance can only be computed against whatever that delegate happens
   * to be offering when somebody asks. A chain that conformed at signature
   * drifts the moment a delegate reprices, loosens its retention or adds a
   * jurisdiction, and nothing in the document records that it moved. The
   * prime is then in breach of terms it never agreed to change.
   *
   * With it, {@link subcontractConformance} compares against a document that
   * cannot move: the engagement both parties signed. The subcontract changes
   * only by amendment, which §6.1 already puts a person in front of.
   *
   * This is what makes a SOLUTION signable. A composing organisation offering
   * several agents as one product can only promise terms it controls, and it
   * controls a delegate's terms exactly when it holds a countersigned
   * engagement with that delegate. Pinning each part at signature is the
   * difference between a product and a wiring diagram.
   *
   * Optional, because §5.15 also serves plain disclosure: naming who you
   * delegate to, with no engagement of your own to point at, is a true and
   * useful statement. A runtime that REQUIRES pins says so itself (the
   * `require_pins` option below); the vocabulary does not decide that for it.
   */
  engagement?: string;
}

/**
 * The subcontracting clause (§5.15). Shapes pinned by
 * `conformance/sow-subcontracting.json`.
 *
 * Graded `evidence`, flatly: the named chain and the on-mesh engagement
 * records are checkable and exportable, while the claim that nothing was
 * delegated off-mesh is `recorded` like every statement about conduct beyond
 * the mesh's sight — breach is its consequence, not detection its guarantee.
 *
 * The chain composes by the same rules, all the way down: disclosure
 * flattens upward, and terms only narrow going down — the deterministic
 * comparison {@link subcontractConformance} computes.
 */
export interface SowSubcontracting {
  posture: SowSubcontractingPosture;
  /** REFUSED when `posture` is `"none"` — a none clause naming delegates
   *  contradicts itself. Optional under the other postures: a disclosing
   *  clause with nobody named yet omits the member. */
  subcontractors?: SowSubcontractorEntry[];
  grade: "evidence";
}

const SOW_SUBCONTRACTING_POSTURE_SET: ReadonlySet<string> = new Set(SOW_SUBCONTRACTING_POSTURES);

/** Backstops, not policy — the same ceilings this file's other name-shaped
 *  strings get. */
const SUBCONTRACTORS_MAX = 16;
const SUBCONTRACTOR_AGENT_MAX = 64;
const SUBCONTRACTOR_HANDLE_MAX = 120;
const SUBCONTRACTOR_ROLE_MAX = 64;
const SUBCONTRACTOR_SCOPE_MAX = 300;
const SUBCONTRACTOR_ENGAGEMENT_MAX = 128;

export function validateSowSubcontracting(v: unknown): asserts v is SowSubcontracting {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    invalid("a subcontracting clause is an object carrying posture and grade (§5.15)");
  }
  const s = v as Record<string, unknown>;
  if (typeof s.posture !== "string" || !SOW_SUBCONTRACTING_POSTURE_SET.has(s.posture)) {
    invalid(
      "a subcontracting clause's posture is 'none', 'disclosed' or 'approved' — exactly one, from a closed set (§5.15)",
    );
  }
  if (s.grade !== "evidence") {
    invalid(
      "a subcontracting clause is graded 'evidence', flatly: the named chain and the on-mesh engagement records are checkable and exportable. " +
        "Not 'enforced' — the claim that nothing was delegated off-mesh is beyond the mesh's sight, with breach as its consequence rather than detection as its guarantee — and not 'recorded', because on this mesh delegation forms engagements the platform holds, which is more than a record of the clause (§5.15, §4.2)",
    );
  }
  if (s.subcontractors === undefined) return;
  if (s.posture === "none") {
    invalid(
      "only a disclosing posture names delegates: a 'none' clause naming subcontractors is two clauses disagreeing about whether the provider delegates at all (§5.15)",
    );
  }
  if (!Array.isArray(s.subcontractors)) {
    invalid("subcontractors is a list of the named delegates, even with one entry (§5.15)");
  }
  if (s.subcontractors.length === 0) {
    invalid(
      "an empty subcontractors list declares nothing, which OMITTING the member already means — a disclosing clause with nobody named yet omits it; two spellings of one state is how implementations come to disagree about which is which (§5.15)",
    );
  }
  if (s.subcontractors.length > SUBCONTRACTORS_MAX) {
    invalid(
      `a subcontracting clause names at most ${SUBCONTRACTORS_MAX} subcontractors; a clause naming dozens is an org chart wearing a clause's clothes (§5.15)`,
    );
  }
  const seenAgents = new Set<string>();
  const seenHandles = new Set<string>();
  for (const raw of s.subcontractors) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      invalid("each subcontractor entry is an object carrying who — agent, handle or role — and the scope delegated (§5.15)");
    }
    const e = raw as Record<string, unknown>;
    if (
      e.agent !== undefined &&
      (typeof e.agent !== "string" || !e.agent.trim() || e.agent.length > SUBCONTRACTOR_AGENT_MAX)
    ) {
      invalid(
        `a subcontractor's agent is the delegate's public key as a non-empty string up to ${SUBCONTRACTOR_AGENT_MAX} characters — shape only: whether the key is real is the platform's problem (§5.15)`,
      );
    }
    if (
      e.handle !== undefined &&
      (typeof e.handle !== "string" || !e.handle.trim() || e.handle.length > SUBCONTRACTOR_HANDLE_MAX)
    ) {
      invalid(
        `a subcontractor's handle names the delegate's mesh handle, up to ${SUBCONTRACTOR_HANDLE_MAX} characters, and not blank (§5.15)`,
      );
    }
    if (
      e.role !== undefined &&
      (typeof e.role !== "string" || !e.role.trim() || e.role.length > SUBCONTRACTOR_ROLE_MAX)
    ) {
      invalid(
        `a subcontractor's role names the published role contract the delegate holds, up to ${SUBCONTRACTOR_ROLE_MAX} characters, and not blank (§5.15)`,
      );
    }
    if (e.agent === undefined && e.handle === undefined && e.role === undefined) {
      invalid(
        "a subcontractor entry names a party on the mesh — an agent by key or handle, or a published role a conforming agent holds — and this one names nobody; a disclosure nobody can look up, vouch, rate, or hold to account is decoration wearing disclosure's clothes (§5.15, §12.1)",
      );
    }
    if (typeof e.scope !== "string" || !e.scope.trim() || e.scope.length > SUBCONTRACTOR_SCOPE_MAX) {
      invalid(
        `a subcontractor's scope is the narrowest true statement of what is delegated, up to ${SUBCONTRACTOR_SCOPE_MAX} characters, and not blank — an entry that names who without what has disclosed nothing (§5.15)`,
      );
    }
    if (
      e.engagement !== undefined &&
      (typeof e.engagement !== "string" || !e.engagement.trim() || e.engagement.length > SUBCONTRACTOR_ENGAGEMENT_MAX)
    ) {
      invalid(
        `a subcontractor's engagement is the §4.1 identifier of the countersigned engagement this delegation runs under, up to ${SUBCONTRACTOR_ENGAGEMENT_MAX} characters, and not blank — the pin is what stops a delegate's terms moving under the party that promised them (§5.15)`,
      );
    }
    if (typeof e.agent === "string") {
      if (seenAgents.has(e.agent)) {
        invalid(
          "two subcontractor entries name the same agent; a reader cannot tell whether the second is a mistake or a second delegation — state the whole delegated scope on one entry (§5.15)",
        );
      }
      seenAgents.add(e.agent);
    }
    if (typeof e.handle === "string") {
      if (seenHandles.has(e.handle)) {
        invalid(
          "two subcontractor entries name the same handle; a reader cannot tell whether the second is a mistake or a second delegation — state the whole delegated scope on one entry (§5.15)",
        );
      }
      seenHandles.add(e.handle);
    }
  }
}

/**
 * The clause a document declares, unvalidated, or null where it declares
 * none. Same contract as {@link disputesOf}, and the same discipline about
 * silence: ABSENCE STATES NOTHING (§5.15). A document without this clause
 * has said nothing about delegation either way, and a reader MUST NOT infer
 * a posture.
 */
export function subcontractingOf(doc: unknown): SowSubcontracting | null {
  if (typeof doc !== "object" || doc === null) return null;
  const s = (doc as { subcontracting?: unknown }).subcontracting;
  return typeof s === "object" && s !== null && !Array.isArray(s) ? (s as SowSubcontracting) : null;
}

// The structural reads the flow-down comparison rests on. DECLARED structure
// only: whether a clause validates is the validators' question, answered at
// document validation, not smuggled into a comparison that was asked
// something else — a member that does not read structurally is a member the
// document has not stated.
function confidentialityClauseOf(doc: unknown): Record<string, unknown> | null {
  if (typeof doc !== "object" || doc === null) return null;
  const c = (doc as { confidentiality?: unknown }).confidentiality;
  return typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
}

function statedPromises(clause: Record<string, unknown> | null): Set<SowConfidentialityPromise> {
  const out = new Set<SowConfidentialityPromise>();
  const p = clause?.promises;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return out;
  for (const name of SOW_CONFIDENTIALITY_PROMISES) {
    if ((p as Record<string, unknown>)[name] === true) out.add(name);
  }
  return out;
}

function statedRetentionDays(clause: Record<string, unknown> | null): number | null {
  const r = clause?.retention;
  if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
  const days = (r as Record<string, unknown>).max_days;
  return isPosInt(days) ? days : null;
}

function statedJurisdictions(clause: Record<string, unknown> | null): string[] | null {
  const j = clause?.processed_in;
  if (!Array.isArray(j)) return null;
  if (!j.every((v): v is string => typeof v === "string" && v.trim() !== "")) return null;
  return j;
}

function statedReportingLevel(doc: unknown): SowReportingLevel | null {
  if (typeof doc !== "object" || doc === null) return null;
  const r = (doc as { reporting?: unknown }).reporting;
  if (typeof r === "object" && r !== null && !Array.isArray(r)) {
    const level = (r as Record<string, unknown>).level;
    if (typeof level === "string" && SOW_REPORTING_LEVELS.includes(level as SowReportingLevel)) {
      return level as SowReportingLevel;
    }
  }
  return null;
}

function statedTimeAndMaterialsCap(doc: unknown): number | null {
  if (typeof doc !== "object" || doc === null) return null;
  const price = (doc as { price?: unknown }).price;
  if (typeof price !== "object" || price === null || Array.isArray(price)) return null;
  const p = price as Record<string, unknown>;
  if (p.arrangement !== "time_and_materials") return null;
  const cap = p.cap;
  if (typeof cap !== "object" || cap === null || Array.isArray(cap)) return null;
  const amount = (cap as Record<string, unknown>).amount;
  return isPosInt(amount) ? amount : null;
}

/**
 * §5.15's chain rule as the computation it claims to be: does `subDoc` (the
 * delegate's engagement with the provider) narrow every checkable term of
 * `primeDoc` (the provider's engagement with its own client)? EMPTY where it
 * does — including terms met exactly, because narrowing includes staying
 * put — else one pinned sentence per violation, in a pinned order.
 *
 * Each term is checked ONLY where the prime states it: a prime that says
 * nothing constrains nothing. What "states" means is structural — the member
 * reads as its declared shape — because whether a clause validates is the
 * validators' question at document validation, and a comparison that
 * silently re-validated would answer a question nobody asked it. The v1
 * checks, in the order violations are reported:
 *
 *  (a) confidentiality promises: every promise the prime's clause makes must
 *      be made by the sub's — a sub that may train on content the prime
 *      promised never trains on breaks the chain. Compared in the closed
 *      vocabulary's declared order.
 *  (b) retention: the sub's ceiling is stated and no longer than the
 *      prime's; a sub silent while the prime states is a violation, because
 *      an unstated ceiling narrows nothing.
 *  (c) jurisdiction: the sub's `processed_in` is stated and a subset of the
 *      prime's; silent-while-stated violates for the same reason, and each
 *      jurisdiction outside the prime's set is its own sentence, in the
 *      sub's declared order.
 *  (d) reporting: the sub's level meets or exceeds the prime's. Silence here
 *      is §5.12's honest default — records_only — so it violates exactly
 *      where that floor does not meet the prime's level: the link above
 *      cannot meet its own reporting over a silent delegate.
 *  (e) the cap: where the caller supplies `prime_cap_remaining` (only the
 *      platform holding the money knows it) and the sub is time and
 *      materials, the sub's cap fits inside the remainder. Money is floored
 *      on the way in, the one way this file computes money.
 *
 * The sentences are pinned by `conformance/sow-subcontracting.json`,
 * byte-identical across SDKs: a provider refused a subcontract reads one
 * message whichever runtime computed the chain. A runtime MAY use a
 * violation to refuse forming a subcontract that could put the provider in
 * breach of the engagement above it; nothing in this function refuses
 * anything itself.
 */
export function subcontractConformance(
  primeDoc: unknown,
  subDoc: unknown,
  opts?: {
    prime_cap_remaining?: number;
    /**
     * The caller requires every named delegate to be PINNED to a
     * countersigned engagement, and reports violation (f) for any that is
     * not.
     *
     * OFF BY DEFAULT, and the default is the decision. §5.15 also serves
     * plain disclosure — naming who you delegate to, with no engagement of
     * your own to point at, is a true statement and this function must not
     * call it a breach. What requires pins is a particular kind of offer: a
     * solution, where one organisation promises terms for parts it does not
     * own and can only keep that promise for parts it has already contracted.
     * That is a policy of the runtime publishing the offer, not a property of
     * the vocabulary, so the runtime says it here rather than the document
     * carrying a flag about it.
     */
    require_pins?: boolean;
  },
): string[] {
  const violations: string[] = [];

  // (f) The pin, when the caller requires one. Reported FIRST because it is
  // the finding that invalidates the others: every check below compares the
  // prime against a sub document, and without a pin nothing says that this
  // document is the one the delegation actually runs under. A chain that
  // conforms against today's offer and was signed against last month's has
  // not been checked, it has been guessed at.
  if (opts?.require_pins) {
    const clause = subcontractingOf(primeDoc);
    for (const e of clause?.subcontractors ?? []) {
      if (typeof e.engagement === "string" && e.engagement.trim()) continue;
      const who = e.handle ?? e.agent ?? e.role ?? "a delegate";
      violations.push(
        `${who} is named as a delegate with no engagement pinned to it; terms that are not pinned can change after this is signed, and a party cannot promise terms it does not hold (§5.15)`,
      );
    }
  }
  const primeConf = confidentialityClauseOf(primeDoc);
  const subConf = confidentialityClauseOf(subDoc);

  // (a) The promises the prime made, in the closed vocabulary's order.
  const primeMakes = statedPromises(primeConf);
  const subMakes = statedPromises(subConf);
  for (const name of SOW_CONFIDENTIALITY_PROMISES) {
    if (!primeMakes.has(name)) continue;
    if (!subMakes.has(name)) {
      violations.push(
        `the prime promises ${name} and this subcontract does not; a delegate may not be freer with the content than the party that took it (§5.15)`,
      );
    }
  }

  // (b) Retention: a ceiling, and silence narrows nothing.
  const primeDays = statedRetentionDays(primeConf);
  if (primeDays !== null) {
    const subDays = statedRetentionDays(subConf);
    if (subDays === null) {
      violations.push(
        `the prime caps retention at ${primeDays} days and this subcontract states no retention ceiling; an unstated ceiling narrows nothing, and terms only narrow going down (§5.15)`,
      );
    } else if (subDays > primeDays) {
      violations.push(
        `the prime caps retention at ${primeDays} days and this subcontract keeps content up to ${subDays} days; a delegate may retain no longer than the party that took the content (§5.15)`,
      );
    }
  }

  // (c) Jurisdiction: a set, and the test is subset.
  const primeIn = statedJurisdictions(primeConf);
  if (primeIn !== null) {
    const subIn = statedJurisdictions(subConf);
    const list = primeIn.join(", ");
    if (subIn === null) {
      violations.push(
        `the prime confines processing to ${list} and this subcontract states no jurisdictions; an unstated jurisdiction may be any jurisdiction, and terms only narrow going down (§5.15)`,
      );
    } else {
      const allowed = new Set(primeIn);
      for (const j of subIn) {
        if (!allowed.has(j)) {
          violations.push(
            `the prime confines processing to ${list} and this subcontract processes in ${j}; a delegate may touch no jurisdiction the party above it did not (§5.15)`,
          );
        }
      }
    }
  }

  // (d) Reporting: ordinal, silence is the §5.12 floor, and the test is
  // meets or exceeds.
  const primeLevel = statedReportingLevel(primeDoc);
  if (primeLevel !== null) {
    const subLevel = statedReportingLevel(subDoc);
    if (subLevel === null) {
      if (!meetsReportingLevel(DEFAULT_REPORTING_LEVEL, primeLevel)) {
        violations.push(
          `the prime owes ${primeLevel} reporting and this subcontract declares none, which offers records_only; a delegate's reporting must be sufficient for the link above to meet its own (§5.15)`,
        );
      }
    } else if (!meetsReportingLevel(subLevel, primeLevel)) {
      violations.push(
        `the prime owes ${primeLevel} reporting and this subcontract offers ${subLevel}; a delegate's reporting must be sufficient for the link above to meet its own (§5.15)`,
      );
    }
  }

  // (e) The cap, where the caller knows the remainder. Floored on the way
  // in — the one way this file computes money.
  if (opts?.prime_cap_remaining !== undefined && Number.isFinite(opts.prime_cap_remaining)) {
    const remaining = Math.max(0, Math.floor(opts.prime_cap_remaining));
    const subCap = statedTimeAndMaterialsCap(subDoc);
    if (subCap !== null && subCap > remaining) {
      violations.push(
        `the subcontract's cap of ${subCap} is larger than what remains of the cap above it (${remaining}); at every link the cap fits inside the remainder of the cap above (§5.15)`,
      );
    }
  }

  return violations;
}

// ── §7.1: document states, including `exhausted` ────────────────────────────

/**
 * The document states of §7.1, by signature count and time.
 *
 * `exhausted` is not a failure. `lapsed` means the term ran out; `exhausted`
 * means the cap ran out (§5.5.5). A runtime MUST NOT record an exhausted
 * engagement as failed, and MUST treat lapse, exhaustion and termination
 * identically at the gate: the counterparty reverts to general admission
 * policy.
 */
export type SowDocumentState =
  | "template"
  | "standing_proposal"
  | "agreed"
  | "active"
  | "amendment_proposed"
  | "amended"
  | "exhausted"
  | "lapsed"
  | "terminated";

/** The three ways an engagement ends (§7.1). Identical at the gate. */
export const SOW_END_STATES: ReadonlySet<SowDocumentState> = new Set<SowDocumentState>([
  "exhausted",
  "lapsed",
  "terminated",
]);

/** §7.1 — lapse, exhaustion and termination are the same answer at admission:
 *  no. Nothing breaks and nothing lingers. */
export function admitsWork(state: SowDocumentState): boolean {
  return state === "active";
}

/** §5.5.5 — an engagement that ends `exhausted` is recorded as a fact and is
 *  not scored, the same way terminations are recorded unscored. */
export function isScoredOutcome(state: SowDocumentState): boolean {
  return state !== "exhausted" && state !== "terminated";
}

// ── §5.1 + §6.2: parties and organizational authority ───────────────────────

/** A seat in the engagement (§5.1). `organization` is the §6.2 addition: the
 *  organization on whose behalf this seat engages. Optional and additive — a
 *  document that omits it is conformant. */
export interface SowParty {
  agent: string;
  handle?: string;
  owner: string;
  organization?: string;
}

export function validateSowParty(v: unknown): asserts v is SowParty {
  if (typeof v !== "object" || v === null) invalid("a party is an object");
  const p = v as Record<string, unknown>;
  if (typeof p.agent !== "string" || p.agent === "") invalid("a party names its agent's public key");
  if (typeof p.owner !== "string" || p.owner === "") invalid("a party names its owner");
  if (p.handle !== undefined && typeof p.handle !== "string") invalid("handle is a string");
  if (p.organization !== undefined) {
    if (typeof p.organization !== "string" || !ORGANIZATION_REF_RE.test(p.organization)) {
      invalid("organization is an Agent Mandate org reference, 'org_...' (§6.2)");
    }
  }
}

// ── §12.1.1: the standing proposal that names its counterparty ──────────────

/**
 * The one party a standing proposal is offered to (§12.1.1).
 *
 * A proposal carrying this clause is a DIRECTED standing proposal: an offer to
 * that party, not to the market. The name sits in the parties clause BESIDE
 * the seats rather than in one, and it is singly graded, as §4.2 requires of a
 * clause that splits across grades from the seats it sits next to.
 *
 * It is INSIDE THE SIGNED BYTES, because the signed bytes are the canonical
 * document less `signatures` (§6). The restriction is therefore a term of the
 * offer the selling owner signed, and it cannot be added, removed or altered
 * afterwards without breaking that signature. A platform that wants the
 * restriction MUST put it in the bytes before the provider signs; one that
 * lays it over a document that does not carry it has produced a document whose
 * signature does not verify.
 *
 * Naming a counterparty does not fill the client seat. The seat stays blank,
 * `starts_at` stays null, and formation remains the two-step gate of §12.1: a
 * countersign is a REQUEST to form, and the provider's runtime completes
 * formation with a fresh signature over the completed bytes.
 *
 * `expires_at` is the lapse §12.1.1 requires. A directed offer does not
 * outlive its occasion, and one bounded by neither an expiry nor a named
 * occasion is a validation error — an offer to one party with no end is an
 * open account of a different kind, held for months and countersigned at a
 * price set for a market that has moved.
 */
export interface SowOfferedTo extends SowParty {
  /** The instant the offer lapses (§12.1.1). */
  expires_at?: string;
  /** §4.2: `enforced` only where one platform both puts this clause inside the
   *  bytes it signs AND checks the countersigning party at formation. Both
   *  ends, or the restriction is evidence a dispute is read from. */
  grade?: SowGrade;
}

/**
 * The §12.1.1 clause: exactly one party, optionally bounded.
 *
 * A LIST is the shape refused loudest. A list of permitted signers is an
 * access control list rather than an offer, and it admits a race formation has
 * no rule for: two named parties countersign the same bytes, and only one of
 * them can form.
 */
export function validateSowOfferedTo(v: unknown): asserts v is SowOfferedTo {
  if (Array.isArray(v)) {
    invalid(v.length === 1
      ? "offered_to names its one party directly, not as a list of one (§12.1.1)"
      : "offered_to names exactly one party — a list of permitted signers is an access control list rather than an offer, and two named parties countersigning the same bytes is a race formation has no rule for (§12.1.1)");
  }
  // Read the extra fields off the value BEFORE the seat assertion narrows it
  // to SowParty, which has no index signature.
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  validateSowParty(v);
  if (o.expires_at !== undefined && (typeof o.expires_at !== "string" || !RFC3339.test(o.expires_at))) {
    invalid("offered_to.expires_at must be an RFC-3339 instant (§12.1.1)");
  }
  if (o.grade !== undefined && (typeof o.grade !== "string" || !SOW_GRADES.has(o.grade))) {
    invalid("offered_to carries its own grade: 'enforced', 'evidence' or 'recorded' (§4.2)");
  }
}

/** The offered_to clause of a document, unvalidated, or null where the
 *  document offers to the market. */
function offeredToClause(doc: unknown): unknown {
  if (typeof doc !== "object" || doc === null) return null;
  const parties = (doc as { parties?: unknown }).parties;
  if (typeof parties !== "object" || parties === null) return null;
  const o = (parties as { offered_to?: unknown }).offered_to;
  return o === undefined || o === null ? null : o;
}

/**
 * §12.1.1: does this document name its counterparty?
 *
 * The listing surfaces are the caller. A catalog, marketplace, directory or
 * board MUST NOT derive a public listing from a directed standing proposal and
 * MUST NOT contribute its scope examples to a public index — §12.2 makes those
 * examples the listing's representative queries, and a document only one party
 * may form has no business answering the market's searches.
 *
 * Directedness is a FACT ABOUT THE OFFER, not a qualification about a
 * counterparty, exactly so that a surface deciding whether it may list a
 * document can read it without interpreting prose.
 */
export function isDirectedProposal(doc: unknown): boolean {
  return offeredToClause(doc) !== null;
}

/**
 * The §12.1.1 formation gate: may this party form under this document, now?
 *
 * Returns null where nothing in the document stands in the way, and a refusal
 * naming the restriction otherwise — the counterparty acted on a document it
 * was handed and deserves a reason, not a shrug.
 *
 * Four things end a directed offer, and this reads the two that live in the
 * bytes: the expiry it states, and the party it names. Withdrawal is the
 * provider's act and being spent by the formation it completes is the
 * runtime's own record; neither is readable from a document alone.
 *
 * A directed offer whose expiry this reader cannot find is REFUSED rather than
 * read as unbounded. §12.1.1 allows the lapse to be a named occasion defined
 * outside the specification, and says in the same breath that a runtime which
 * does not understand the occasion a document names MUST refuse formation.
 * This reader understands no occasion vocabulary, so an offer stating no
 * `expires_at` is exactly that case.
 */
export function directedOfferRefusal(
  doc: unknown,
  clientAgent: string,
  now: number = Date.now(),
): string | null {
  const raw = offeredToClause(doc);
  if (raw === null) return null;
  try {
    validateSowOfferedTo(raw);
  } catch (err) {
    return `this document names a counterparty in a shape that cannot be read, so who may form under it cannot be established: ${(err as Error).message}`;
  }
  const o = raw as SowOfferedTo;
  if (o.expires_at === undefined) {
    return "this offer names one counterparty and states no expiry, so nothing in it says when it ends; a runtime that cannot tell when a directed offer lapses refuses formation rather than reading the offer as unbounded (§12.1.1)";
  }
  if (now >= Date.parse(o.expires_at)) {
    return `this offer was made to one named party and lapsed at ${o.expires_at}; a lapsed offer stays readable, but nothing forms under it (§12.1.1)`;
  }
  // The match is on the agent key. `handle` and `owner` are labels for people,
  // and a handle pointed at a new key names a different party (§5.1).
  if (clientAgent !== o.agent) {
    return `this offer names ${o.handle ?? o.owner} as the one party entitled to countersign it, and the client seat names a different agent key — only the named party may form under a directed standing proposal (§12.1.1)`;
  }
  return null;
}

// ── §12.1: qualifications, the conditions a counterparty must meet ──────────

/**
 * What a qualification tests, and therefore whether any runtime can test it.
 *
 * §12.1 rule 1 admits three families: a passed validation probe (§13), account
 * standing, and capability requirements. This vocabulary is the part of that a
 * runtime can actually establish about a counterparty, plus the honest name for
 * everything else.
 *
 * - `mesh_registration` — the countersigning agent has a current registration
 *   in the mesh registry the checking runtime reads. A fact the runtime holds.
 * - `publishes_offering` — that registration publishes the named offering.
 *   §12.1's capability requirement, and the one a seller reaches for when the
 *   work only makes sense against a counterparty that can do something back.
 * - `platform_account` — the countersigning agent is attached to an account on
 *   the platform completing formation. The weakest true reading of §12.1's
 *   "account standing", and deliberately named for what it checks rather than
 *   for what "standing" might be taken to imply: it says an account exists, and
 *   it says nothing about that account's conduct, funding, or screening.
 * - `asserted` — a statement the counterparty makes about itself that no
 *   runtime here can check. A current third-party licence is the case this
 *   exists for.
 *
 * There is deliberately NO probe kind. §13's qualification is checkable
 * because the probe left a signed outcome, and a runtime that holds no probe
 * records would either invent one or publish a condition nothing can ever
 * satisfy. §13 forbids the first and §12.1 rule 2 makes the second a published
 * offer that refuses every counterparty. A deployment that records probes adds
 * the kind with the records.
 */
export type SowQualificationKind =
  | "mesh_registration"
  | "publishes_offering"
  | "platform_account"
  | "asserted";

export const SOW_QUALIFICATION_KINDS: ReadonlySet<string> = new Set<SowQualificationKind>([
  "mesh_registration",
  "publishes_offering",
  "platform_account",
  "asserted",
]);

/**
 * The kinds a runtime tests against a fact it holds, as opposed to the one it
 * can only hold a signed statement about.
 *
 * The split IS the enforcement gradient (§3) applied to this clause, and it is
 * why the vocabulary is closed rather than free text. A condition written as
 * prose can be graded anything a seller likes; a condition written as a kind
 * is graded by what the kind can be tested against.
 */
export const CHECKABLE_QUALIFICATION_KINDS: ReadonlySet<string> = new Set<SowQualificationKind>([
  "mesh_registration",
  "publishes_offering",
  "platform_account",
]);

/**
 * The highest grade a kind can honestly carry (§3 rule 1).
 *
 * A checkable kind reaches `enforced` in a deployment that actually performs
 * the refusal, which for a standing proposal is the deployment that both
 * publishes the document and completes formation under it. `asserted` tops out
 * at `evidence` and §12.1 rule 4 says so in as many words: the record is
 * evidence that the party asserted the thing, not proof that the thing is
 * true. A seller who grades a licence condition `enforced` has made the false
 * enforcement claim the whole gradient exists to prevent, so the validator
 * below refuses it rather than trusting the seller's own reading.
 */
export function qualificationGradeCeiling(kind: SowQualificationKind): SowGrade {
  return CHECKABLE_QUALIFICATION_KINDS.has(kind) ? "enforced" : "evidence";
}

/**
 * One condition a counterparty must meet for its countersign to be accepted
 * (§12.1 rule 1).
 *
 * Qualifications live in the SIGNED DOCUMENT, where a prospective client reads
 * them before spending anything. That is not decoration: a condition a buyer
 * cannot see before committing is a trap, and a condition outside the signed
 * bytes is one the seller can change after the buyer has read it.
 */
export interface SowQualification {
  /** Stable within the document, and what a refusal names. */
  id: string;
  kind: SowQualificationKind;
  /** The sentence a person reads. Required on every kind, including the
   *  checkable ones, because the buyer is owed the condition in words rather
   *  than a vocabulary term. */
  statement: string;
  /** §4.2: each qualification is singly graded, because this clause splits
   *  across grades by construction. */
  grade: SowGrade;
  /** `publishes_offering` only: the offering the counterparty must publish. */
  offering?: string;
}

const QUALIFICATION_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const QUALIFICATION_STATEMENT_MAX = 300;
/** A backstop, not a policy. A document stating dozens of conditions is an
 *  admission process wearing an offer's clothes. */
const QUALIFICATIONS_MAX = 10;

export function validateSowQualification(v: unknown): asserts v is SowQualification {
  if (typeof v !== "object" || v === null || Array.isArray(v)) invalid("a qualification is an object (§12.1)");
  const q = v as Record<string, unknown>;
  if (typeof q.id !== "string" || !QUALIFICATION_ID_RE.test(q.id)) {
    invalid("a qualification needs an id of 1-40 lowercase letters, digits and dashes — it is what a refusal names (§12.1)");
  }
  if (typeof q.kind !== "string" || !SOW_QUALIFICATION_KINDS.has(q.kind)) {
    invalid(
      `a qualification's kind is one of ${[...SOW_QUALIFICATION_KINDS].sort().join(", ")}. ` +
        "A condition written as prose can be graded anything a seller likes; a condition written as a kind is graded by what the kind can be tested against (§12.1)",
    );
  }
  const kind = q.kind as SowQualificationKind;
  if (typeof q.statement !== "string" || !q.statement.trim() || q.statement.length > QUALIFICATION_STATEMENT_MAX) {
    invalid(`a qualification states its condition in words a person reads, up to ${QUALIFICATION_STATEMENT_MAX} characters (§12.1)`);
  }
  if (typeof q.grade !== "string" || !SOW_GRADES.has(q.grade)) {
    invalid("a qualification is singly graded: 'enforced', 'evidence' or 'recorded' (§4.2)");
  }
  if (q.grade === "enforced" && kind === "asserted") {
    invalid(
      "a condition the counterparty asserts about itself, and that no runtime can check, MUST NOT be graded enforced. " +
        "The record is evidence that the party asserted the thing, not proof that the thing is true (§12.1 rule 4, §3 rule 1)",
    );
  }
  if (kind === "publishes_offering") {
    if (typeof q.offering !== "string" || !q.offering.trim() || q.offering.length > 60) {
      invalid("a publishes_offering qualification names the offering the counterparty must publish (§12.1)");
    }
  } else if (q.offering !== undefined) {
    invalid("only a publishes_offering qualification carries an offering (§12.1)");
  }
}

/** The clause: a list of singly-graded conditions with distinct ids. */
export function validateSowQualifications(v: unknown): asserts v is SowQualification[] {
  if (!Array.isArray(v)) invalid("qualifications is a list of conditions (§12.1)");
  if (v.length > QUALIFICATIONS_MAX) {
    invalid(`a standing proposal states at most ${QUALIFICATIONS_MAX} qualifications (§12.1)`);
  }
  const seen = new Set<string>();
  for (const q of v) {
    validateSowQualification(q);
    if (seen.has(q.id)) invalid(`two qualifications share the id "${q.id}", and a refusal has to name one of them (§12.1)`);
    seen.add(q.id);
  }
}

/** The conditions a document states, unvalidated, or [] where it states none.
 *  Both a standing proposal and a countersigned instance carry the clause in
 *  the same place, because the instance is the proposal plus the seat. */
export function qualificationsOf(doc: unknown): SowQualification[] {
  if (typeof doc !== "object" || doc === null) return [];
  const q = (doc as { qualifications?: unknown }).qualifications;
  return Array.isArray(q) ? (q as SowQualification[]) : [];
}

/**
 * The ids a countersign of this document MUST assert, sorted.
 *
 * Sorted because the list rides inside the client's signed bytes: two clients
 * accepting the same offer produce the same bytes, and a runtime rebuilding
 * what the instance must be has one answer rather than a permutation of them.
 */
export function requiredAssertions(doc: unknown): string[] {
  return qualificationsOf(doc)
    .filter((q) => q?.kind === "asserted" && typeof q?.id === "string")
    .map((q) => q.id)
    .sort();
}

/**
 * What a runtime established about the counterparty, for the checkable kinds.
 *
 * A field left `undefined` is a fact the runtime did NOT establish, which is
 * not the same as a fact it established as false, and the gate treats it as a
 * refusal rather than a pass. A registry that could not be read is a condition
 * that was not checked, and §12.1 rule 2 makes completing formation the thing
 * a runtime does for a counterparty that MEETS the conditions.
 */
export interface SowQualificationFacts {
  /** The agent key these facts describe. Checked against the client seat, so
   *  a runtime cannot gather facts about one party and admit another. */
  subject: string;
  /** Does the counterparty hold a current registration in the mesh registry? */
  registered?: boolean;
  /** The offerings that registration publishes. */
  offerings?: readonly string[];
  /** Is the counterparty's agent attached to an account on this platform? */
  account?: boolean;
}

/**
 * The §12.1 formation gate: does this counterparty meet the conditions this
 * offer states, and has it made the assertions the offer requires?
 *
 * Returns null where every stated condition is met, and a refusal NAMING THE
 * UNMET CONDITION otherwise — rule 2 says the refusal names it, and a
 * counterparty that read a published offer and acted on it is owed the reason
 * rather than a shrug.
 *
 * One function rather than two on purpose. The assertion half needs nothing
 * but the document, the fact half needs lookups, and a runtime that called
 * only the cheap one would have a gate that passes every unverifiable
 * condition in silence.
 *
 * What this is NOT: a screen. §12.1 is explicit that where an operator is
 * merchant of record, sanctions screening, customer identification and tax
 * status are that operator's obligations to the authorities that impose them;
 * a seller cannot discharge them by stating a condition and a buyer cannot
 * discharge them by asserting it is met. Those belong at account admission and
 * at settlement. Nothing here may be read as having performed one.
 */
export function qualificationRefusal(
  doc: unknown,
  clientAgent: string,
  asserted: readonly string[] | undefined,
  facts?: SowQualificationFacts,
): string | null {
  const raw = (typeof doc === "object" && doc !== null ? (doc as { qualifications?: unknown }).qualifications : undefined);
  if (raw === undefined || raw === null) return null;
  try {
    validateSowQualifications(raw);
  } catch (err) {
    return `this offer states conditions in a shape that cannot be read, so whether you meet them cannot be established: ${(err as Error).message}`;
  }
  const quals = raw as SowQualification[];
  if (!quals.length) return null;

  // The assertions the countersign carries, held to the offer's own list
  // BEFORE anything else: an unknown id means the two sides are reading
  // different documents, and that is worth saying plainly.
  const required = requiredAssertions({ qualifications: quals });
  const claimed = asserted ?? [];
  let previous: string | null = null;
  for (const id of claimed) {
    if (typeof id !== "string") return "each asserted condition is named by its id (§12.1)";
    if (previous !== null && previous >= id) {
      return "the asserted conditions are listed once each, in sorted order, because the list rides inside the bytes both parties sign (§12.1)";
    }
    previous = id;
    const q = quals.find((x) => x.id === id);
    if (!q) return `this offer states no condition called "${id}", and a countersign asserts only the conditions the offer states (§12.1)`;
    if (q.kind !== "asserted") {
      return `"${id}" is a condition this runtime checks rather than one you state, so a countersign does not assert it (§12.1)`;
    }
  }
  for (const id of required) {
    if (!claimed.includes(id)) {
      const q = quals.find((x) => x.id === id)!;
      return `this offer requires the countersigning party to state that it meets "${id}": ${q.statement} The countersign carries no such statement, so it is refused. Nothing here verifies the statement; what is held afterwards is evidence that you made it (§12.1)`;
    }
  }

  // The checkable half.
  const checkable = quals.filter((q) => q.kind !== "asserted");
  if (!checkable.length) return null;
  if (!facts) {
    return `this offer states conditions on who may countersign it, and this runtime checked none of them; an unchecked condition refuses formation rather than passing it (§12.1)`;
  }
  if (facts.subject !== clientAgent) {
    return "the conditions were checked against a different party than the one filling the client seat, so nothing has been established about the countersigning agent (§12.1)";
  }
  const unchecked = (q: SowQualification) =>
    `this offer states the condition "${q.id}": ${q.statement} This runtime could not check it just now, and an unchecked condition refuses formation rather than passing it (§12.1)`;
  const unmet = (q: SowQualification, because: string) =>
    `this offer states a condition the countersigning party does not meet, "${q.id}": ${q.statement} ${because} (§12.1)`;
  for (const q of checkable) {
    switch (q.kind) {
      case "mesh_registration":
        if (facts.registered === undefined) return unchecked(q);
        if (!facts.registered) return unmet(q, "That agent holds no current registration on this mesh.");
        break;
      case "publishes_offering":
        if (facts.offerings === undefined) return unchecked(q);
        if (!facts.offerings.includes(q.offering!)) {
          return unmet(q, `That agent's published manifest does not offer "${q.offering}".`);
        }
        break;
      case "platform_account":
        if (facts.account === undefined) return unchecked(q);
        if (!facts.account) return unmet(q, "That agent is not attached to an account on this platform.");
        break;
      default:
        // A kind this reader does not know is a condition it cannot test, and
        // reading it as met is how a document's own terms get waived by the
        // runtime that could not parse them.
        return `this offer states a condition of a kind this runtime does not understand, "${(q as SowQualification).kind}", so it cannot tell whether you meet it; formation is refused rather than completed unchecked (§12.1)`;
    }
  }
  return null;
}

// ── §6.1 + §6.2: approval authority and the mandate reference ───────────────

/** What kind of actor may bind an act (§6.1). */
export type ApprovalAuthority = "agent" | "person" | "agent_then_person";

export const APPROVAL_AUTHORITIES: ReadonlySet<string> = new Set<ApprovalAuthority>([
  "agent",
  "person",
  "agent_then_person",
]);

/** §6.1 defaults when unstated: formation is `agent`, amendments are
 *  `person`. */
export const DEFAULT_FORMATION_AUTHORITY: ApprovalAuthority = "agent";
export const DEFAULT_AMENDMENT_AUTHORITY: ApprovalAuthority = "person";

/** Which act an approval record covers (§6.1). */
export type SowApprovalAct = "formation" | "amendment";

/**
 * An approval record (§6.1), optionally carrying the §6.2 mandate reference.
 *
 * `mandate` names the mandate under which the approving person acted. It sits
 * inside the signed bytes and is additive. A runtime that does not perform the
 * Agent Mandate §7 checks MUST NOT present a document carrying it as
 * mandate-verified: the reference is then `evidence` that a mandate was cited,
 * not `enforced` authority.
 */
export interface SowApprovalRecord {
  act: SowApprovalAct;
  authority: ApprovalAuthority;
  key: string;
  approved_at: string;
  mandate?: string;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function validateSowApproval(v: unknown): asserts v is SowApprovalRecord {
  if (typeof v !== "object" || v === null) invalid("an approval record is an object");
  const a = v as Record<string, unknown>;
  if (a.act !== "formation" && a.act !== "amendment") invalid("act is 'formation' or 'amendment'");
  if (typeof a.authority !== "string" || !APPROVAL_AUTHORITIES.has(a.authority)) {
    invalid("authority is 'agent', 'person' or 'agent_then_person' (§6.1)");
  }
  if (typeof a.key !== "string" || a.key === "") invalid("an approval names the approving key");
  if (typeof a.approved_at !== "string" || !RFC3339.test(a.approved_at)) {
    invalid("approved_at must be an RFC-3339 instant");
  }
  if (a.mandate !== undefined) {
    if (typeof a.mandate !== "string" || !MANDATE_REF_RE.test(a.mandate)) {
      invalid("mandate is an Agent Mandate reference, 'mnd_...' (§6.2)");
    }
    if (a.authority === "agent") {
      invalid(
        "a mandate names the mandate under which the approving PERSON acted (§6.2) — an " +
          "agent-authority approval has no person to hold one",
      );
    }
  }
}

/**
 * §6.2 — whether a runtime may present this approval as mandate-verified.
 *
 * Only where the deployment actually performs the Agent Mandate §7 checks. The
 * honest default is `false`: the reference is then evidence a mandate was
 * cited, and a runtime MUST NOT present it as a legal opinion either way.
 */
export function mandateVerified(
  approval: SowApprovalRecord,
  opts: { checksPerformed: boolean },
): boolean {
  return opts.checksPerformed && typeof approval.mandate === "string";
}

// ── §6: canonicalization and signing ────────────────────────────────────────

/** One owner's signature over the document (§6). Owners sign, not agents. */
export interface SowSignature {
  role: "provider" | "client";
  key: string;
  signed_at: string;
  sig: string;
}

/**
 * The canonical JSON an Agent SoW signature covers (§6): the JCS canonical
 * JSON of the document with the `signatures` array removed.
 *
 * The Rust SDK produces the same string for the same document; that byte
 * equality is what `conformance/sow-pricing.json` pins.
 */
export function canonicalSowJSON(doc: object): string {
  const { signatures: _omit, ...rest } = doc as { signatures?: unknown };
  return canonicalJSON(rest);
}

/** The exact bytes a signer signs: `SOW_SIG_PREFIX` + the canonical JSON. */
export function sowSignedBytes(doc: object): Uint8Array {
  return new TextEncoder().encode(SOW_SIG_PREFIX + canonicalSowJSON(doc));
}

/**
 * Sign a document as one role, appending to `signatures` (§6).
 *
 * Formation always ends with a fresh provider signature over the COMPLETED
 * document: a standing proposal's provider signature covers the template bytes,
 * and the moment a client countersigns, the client seat and start instant fill
 * in and the bytes change. A pre-signature authenticates the offer; it does not
 * pre-authorize every formation (§6, §12.1). This function therefore always
 * signs the document as it stands now.
 */
export function signSow<T extends object>(
  doc: T,
  kp: KeyPair,
  role: "provider" | "client",
  signedAt?: string,
): T & { signatures: SowSignature[] } {
  const existing = ((doc as { signatures?: SowSignature[] }).signatures ?? []).filter(
    (s) => s.role !== role,
  );
  const sig = toB64Url(signTagged(kp, SOW_SIG_PREFIX, canonicalSowJSON(doc)));
  return {
    ...doc,
    signatures: [
      ...existing,
      {
        role,
        key: kp.getPublicKey(),
        signed_at: signedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        sig,
      },
    ],
  };
}

/** Verify one signature record against the document's canonical bytes (§6). */
export function verifySowSignature(doc: object, signature: SowSignature): boolean {
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromB64Url(signature.sig);
  } catch {
    return false;
  }
  return verifyTagged(signature.key, SOW_SIG_PREFIX, canonicalSowJSON(doc), sigBytes);
}

/**
 * §6 — a document is **agreed** when both roles have valid signatures over the
 * same canonical bytes. Not "both roles signed something"; both signatures must
 * verify against the bytes the document has right now.
 */
export function sowAgreed(doc: object): boolean {
  const signatures = (doc as { signatures?: SowSignature[] }).signatures ?? [];
  const roles = new Set<string>();
  for (const s of signatures) {
    if (!verifySowSignature(doc, s)) return false;
    roles.add(s.role);
  }
  return roles.has("provider") && roles.has("client");
}
