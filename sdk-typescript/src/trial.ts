/**
 * Trials (Common Agent §7.7): an offering's `trial` declaration, the
 * `trial: true` request marker, and admission at the node.
 *
 * Everything here is pure: no clock but the one handed in, no store, no
 * network. A node keeps its own counts (in memory, a file, a database) and
 * hands them to `trialAdmission`; a host (the platform that lists agents) runs
 * the same function over the counts it can see. Both refuse with the same
 * `TRIAL_REFUSED` shape, so a requester reads one answer whoever refused.
 *
 * The order is the specification's: a budget on a trial request first (a
 * requester who owes nothing has nothing to offer), then
 *   1. the offering declares `trial`            (not_offered)
 *   2. the requester qualifies under `who`      (not_eligible)
 *   3. every input fits the shape's limit       (input)
 *   4. no count in `limits` is reached          (requester_day, day, requester_ever)
 *   5. the trial ceiling of the allowance has room (funds)
 * and the first failure is the answer. A refused trial is not counted; the
 * caller counts a trial only once it is admitted, and a trial that fails
 * after admission stays counted, because the publisher paid for it.
 */
import { ErrorCode, MeshError } from "./types/errors.js";

export const TRIAL_WHO = ["anyone", "signed_in", "verified"] as const;
export type TrialWho = (typeof TRIAL_WHO)[number];

/** How tight a trial's input is. A node checks what it can measure before
 *  any work (characters and bytes of what was sent); a limit only the work
 *  can measure (pages read from an address, seconds of a recording, items in
 *  a list behind a link) is handed to the work as its cap. */
export interface TrialInputLimitValue {
  max_chars?: number;
  max_bytes?: number;
  max_pages?: number;
  max_seconds?: number;
  max_items?: number;
}
export const TRIAL_LIMIT_KEYS = ["max_chars", "max_bytes", "max_pages", "max_seconds", "max_items"] as const;
/** The limits a node can check at admission, before anything is fetched. */
export const ADMISSION_LIMIT_KEYS = ["max_chars", "max_bytes"] as const;

export interface TrialInputLimit {
  name: string;
  limit: TrialInputLimitValue;
}

export interface TrialShape {
  inputs?: TrialInputLimit[];
  omits?: string[];
  live_seconds?: number;
  keeps_days?: number;
  marked?: boolean;
}

export interface TrialLimits {
  per_requester_per_day?: number;
  per_day?: number;
  per_requester_ever?: number;
}

export interface TrialDeclaration {
  who: TrialWho;
  shape?: TrialShape;
  limits: TrialLimits;
}

export const TRIAL_REASONS = [
  "budget",
  "not_offered",
  "not_eligible",
  "input",
  "requester_day",
  "day",
  "requester_ever",
  "funds",
] as const;
export type TrialReason = (typeof TRIAL_REASONS)[number];

const LIMIT_KEYS = ["per_requester_per_day", "per_day", "per_requester_ever"] as const;

const wholeNonNegative = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Why a trial declaration is not acceptable, or null when it is. The registry
 * MUST refuse a trial with no count (§7.7): a trial nothing bounds is not a
 * declaration a counterparty can rely on. `offering`, when given, is the
 * offering the trial sits on, so a shape naming an input or an output the
 * offering does not declare is refused rather than silently ignored.
 */
export function validateTrial(
  trial: unknown,
  offering?: { inputs?: ReadonlyArray<{ name?: unknown }>; outputs?: ReadonlyArray<{ name?: unknown }> } | null,
): string | null {
  if (!isRecord(trial)) return "trial must be an object with who, limits and, optionally, shape.";
  if (typeof trial.who !== "string" || !(TRIAL_WHO as readonly string[]).includes(trial.who)) {
    return `trial.who must be one of ${TRIAL_WHO.join(", ")}.`;
  }
  const limits = trial.limits;
  if (!isRecord(limits)) return "trial.limits is required: a trial with no count is not bounded.";
  let counted = 0;
  for (const k of LIMIT_KEYS) {
    if (limits[k] === undefined) continue;
    if (!wholeNonNegative(limits[k])) return `trial.limits.${k} must be a whole number of trial tasks.`;
    counted++;
  }
  for (const k of Object.keys(limits)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(k)) return `trial.limits.${k} is not a count this specification defines; limits are counts, never money.`;
  }
  if (counted === 0) return "trial.limits must carry at least one of per_requester_per_day, per_day and per_requester_ever: a trial with no count is not bounded.";
  if (trial.shape !== undefined) {
    const shape = trial.shape;
    if (!isRecord(shape)) return "trial.shape must be an object.";
    const inputNames = new Set((offering?.inputs ?? []).map((i) => i?.name).filter((n): n is string => typeof n === "string"));
    const outputNames = new Set((offering?.outputs ?? []).map((o) => o?.name).filter((n): n is string => typeof n === "string"));
    if (shape.inputs !== undefined) {
      if (!Array.isArray(shape.inputs)) return "trial.shape.inputs must be a list.";
      for (const entry of shape.inputs) {
        if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name) return "each trial.shape.inputs entry needs the name of a declared input.";
        if (offering && !inputNames.has(entry.name)) return `trial.shape.inputs names "${entry.name}", which the offering does not declare.`;
        if (!isRecord(entry.limit)) return `trial.shape.inputs "${entry.name}" needs a limit.`;
        let any = 0;
        for (const [k, v] of Object.entries(entry.limit)) {
          if (!(TRIAL_LIMIT_KEYS as readonly string[]).includes(k)) return `trial.shape.inputs "${entry.name}" limit ${k} is not one of ${TRIAL_LIMIT_KEYS.join(", ")}.`;
          if (!wholeNonNegative(v) || v === 0) return `trial.shape.inputs "${entry.name}" limit ${k} must be a whole number above zero.`;
          any++;
        }
        if (!any) return `trial.shape.inputs "${entry.name}" names no limit.`;
      }
    }
    if (shape.omits !== undefined) {
      if (!Array.isArray(shape.omits) || shape.omits.some((n) => typeof n !== "string" || !n)) return "trial.shape.omits must be a list of output names.";
      if (offering) {
        for (const n of shape.omits as string[]) if (!outputNames.has(n)) return `trial.shape.omits names "${n}", which the offering does not declare as an output.`;
      }
    }
    for (const k of ["live_seconds", "keeps_days"] as const) {
      if (shape[k] !== undefined && !wholeNonNegative(shape[k])) return `trial.shape.${k} must be a whole number.`;
    }
    if (shape.marked !== undefined && typeof shape.marked !== "boolean") return "trial.shape.marked must be true or false.";
  }
  return null;
}

/**
 * Every offering's trial in a Descriptor, checked. The first problem, named
 * with its offering, or null. A Descriptor with no trial anywhere passes.
 */
export function validateDescriptorTrials(doc: unknown): string | null {
  if (!isRecord(doc) || !Array.isArray(doc.offerings)) return null;
  for (const o of doc.offerings) {
    if (!isRecord(o) || o.trial === undefined) continue;
    const why = validateTrial(o.trial, o as { inputs?: Array<{ name?: unknown }>; outputs?: Array<{ name?: unknown }> });
    if (why) return `offering ${typeof o.id === "string" ? o.id : "(no id)"}: ${why}`;
  }
  if (doc.samples_ref !== undefined && (typeof doc.samples_ref !== "string" || !/^https:\/\//.test(doc.samples_ref))) {
    return "samples_ref must be an https address of the agent's samples document.";
  }
  return null;
}

/** The trial declared on one offering of a Descriptor, read leniently: a
 *  member that does not validate is no trial (§9.6: never the flattering
 *  reading), so a request for it is refused `not_offered`. */
export function trialOf(offering: unknown): TrialDeclaration | null {
  if (!isRecord(offering) || offering.trial === undefined) return null;
  return validateTrial(offering.trial, offering as { inputs?: Array<{ name?: unknown }>; outputs?: Array<{ name?: unknown }> }) === null
    ? (offering.trial as unknown as TrialDeclaration)
    : null;
}

/** Whether a request carries the trial marker. Only `true` is a trial. */
export function isTrialRequest(payload: unknown): boolean {
  return isRecord(payload) && payload.trial === true;
}

/** Who is asking, as the node or the host can tell. `id` is stable for the
 *  requester: an account id, a sender key, or a host-issued visitor id. */
export interface TrialRequester {
  id: string;
  kind: "account" | "agent" | "visitor";
  /** Holds an account where the request is made. A vouched visitor never does. */
  signed_in: boolean;
  /** The requester's owner is verified under the binding. */
  verified: boolean;
}

/** The trials already counted for this requester and offering. */
export interface TrialCounts {
  requester_day: number;
  day: number;
  requester_ever: number;
}

/** What the same work costs as an ordinary request, so a requester refused a
 *  trial is told how to have the work anyway. `amount_micro` is null only
 *  when the offering carries no price at all; `words` always says it. */
export interface TrialQuote {
  amount_micro: number | null;
  currency: string | null;
  words: string;
}

/** A price declaration (the SKU price shape) read as a quote. */
export function quoteFromPrice(price: { model?: string; amount_micro?: number; currency?: string; meter?: string; per?: number } | null | undefined): TrialQuote {
  if (!price || !price.model) return { amount_micro: null, currency: null, words: "it has no published price; ask the agent for a quote" };
  const cur = price.currency ?? "USD";
  if (price.model === "free") return { amount_micro: 0, currency: cur, words: "it is free as an ordinary request" };
  const amt = typeof price.amount_micro === "number" ? price.amount_micro : null;
  if (amt === null) return { amount_micro: null, currency: cur, words: "it has no published price; ask the agent for a quote" };
  const money = moneyWords(amt, cur);
  if (price.model === "flat") return { amount_micro: amt, currency: cur, words: `${money} as an ordinary request` };
  if (price.model === "per_unit") return { amount_micro: amt, currency: cur, words: `${money} per ${price.per ?? 1} ${price.meter ?? "units"} as an ordinary request` };
  return { amount_micro: amt, currency: cur, words: `from ${money} as an ordinary request` };
}

/** Integer micro-units as words a person reads: "$5.00", "12 XCR". */
export function moneyWords(amountMicro: number, currency: string): string {
  if (currency === "USD") {
    const cents = Math.round(amountMicro / 10_000);
    return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  }
  return `${(amountMicro / 1_000_000).toString()} ${currency}`;
}

/** The next UTC midnight after `now`: when a per-day count resets. */
export function nextUtcMidnight(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return d.toISOString();
}

/** The UTC day a trial is counted under. */
export const trialDayOf = (now: Date): string => now.toISOString().slice(0, 10);

export interface TrialRefusalDetails {
  reason: TrialReason;
  limit?: number;
  resets_at?: string;
  quote: TrialQuote;
  /** For `input`: which input, and its trial limit. */
  input?: string;
  max?: TrialInputLimitValue;
}

export interface TrialRefusal {
  code: typeof ErrorCode.TRIAL_REFUSED;
  /** The passage for a person. */
  message: string;
  retryable: false;
  details: TrialRefusalDetails;
}

/** One measured input over its trial limit, or null. */
export function inputOverLimit(
  shape: TrialShape | undefined,
  inputs: Record<string, unknown>,
): { input: string; max: TrialInputLimitValue } | null {
  for (const entry of shape?.inputs ?? []) {
    const value = inputs[entry.name];
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value : null;
    const bytes = text !== null ? new TextEncoder().encode(text).length
      : isRecord(value) && typeof value.size === "number" ? value.size
      : null;
    if (entry.limit.max_chars !== undefined && text !== null && [...text].length > entry.limit.max_chars) return { input: entry.name, max: entry.limit };
    if (entry.limit.max_bytes !== undefined && bytes !== null && bytes > entry.limit.max_bytes) return { input: entry.name, max: entry.limit };
  }
  return null;
}

/** What the work is told it may do, for a limit only the work can measure. */
export function workCaps(shape: TrialShape | undefined): Array<{ input: string; limit: TrialInputLimitValue }> {
  const out: Array<{ input: string; limit: TrialInputLimitValue }> = [];
  for (const entry of shape?.inputs ?? []) {
    const rest: TrialInputLimitValue = {};
    for (const k of ["max_pages", "max_seconds", "max_items"] as const) if (entry.limit[k] !== undefined) rest[k] = entry.limit[k];
    if (Object.keys(rest).length) out.push({ input: entry.name, limit: rest });
  }
  return out;
}

function limitWords(max: TrialInputLimitValue): string {
  if (max.max_chars !== undefined) return `${max.max_chars} characters`;
  if (max.max_bytes !== undefined) return `${max.max_bytes} bytes`;
  if (max.max_pages !== undefined) return `${max.max_pages} pages`;
  if (max.max_seconds !== undefined) return `${max.max_seconds} seconds`;
  return `${max.max_items ?? 0} items`;
}

const tries = (n: number): string => (n === 1 ? "1 try" : `${n} tries`);

/** The passage for a person, one per reason. Plain, and always ends with how
 *  to have the work anyway. */
export function trialRefusalWords(d: Omit<TrialRefusalDetails, "quote"> & { quote: TrialQuote }, agentName = "this agent", who?: TrialWho): string {
  const anyway = d.quote.amount_micro === null ? ` You can still ask for the full work: ${d.quote.words}.` : ` You can still have the full work: ${d.quote.words}.`;
  switch (d.reason) {
    case "budget":
      return `A trial is free, so it carries no budget. Send it without a budget to try ${agentName}, or send an ordinary request with your budget.${anyway}`;
    case "not_offered":
      return `${cap(agentName)} does not offer a trial of this work.${anyway}`;
    case "not_eligible":
      return who === "verified"
        ? `This trial is open only to people whose account is verified.${anyway}`
        : `This trial is open only to people who are signed in. Sign in, then try again.${anyway}`;
    case "input":
      return `A trial takes at most ${d.max ? limitWords(d.max) : "less"} of ${d.input ?? "this input"}. Send a shorter one to try it.${anyway}`;
    case "requester_day":
      return `You have used today's ${tries(d.limit ?? 0)} of ${agentName}. You can try it again after midnight UTC.${anyway}`;
    case "day":
      return `Today's trials of ${agentName} are used up for everyone. They start again after midnight UTC.${anyway}`;
    case "requester_ever":
      return `You have used all ${tries(d.limit ?? 0)} of ${agentName} there are.${anyway}`;
    case "funds":
      return `${cap(agentName)} has no room left for trials today. Trials start again after midnight UTC.${anyway}`;
  }
}

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function trialRefusal(details: TrialRefusalDetails, agentName?: string, who?: TrialWho): TrialRefusal {
  const clean: TrialRefusalDetails = { reason: details.reason, quote: details.quote };
  if (details.limit !== undefined) clean.limit = details.limit;
  if (details.resets_at !== undefined) clean.resets_at = details.resets_at;
  if (details.input !== undefined) clean.input = details.input;
  if (details.max !== undefined) clean.max = details.max;
  return { code: ErrorCode.TRIAL_REFUSED, message: trialRefusalWords(clean, agentName, who), retryable: false, details: clean };
}

/** The refusal as a MeshError, for a node that answers by throwing. */
export function trialRefused(details: TrialRefusalDetails, agentName?: string): MeshError {
  const r = trialRefusal(details, agentName);
  return new MeshError(ErrorCode.TRIAL_REFUSED, r.message, { retryable: false, details: r.details as unknown as Record<string, unknown> });
}

/**
 * The trial ceiling's answer. `none`: the owner set no trial ceiling, so the
 * node refuses on funds rather than spend unbounded (§7.5, §7.7). `room`:
 * the estimate fits under the trial ceiling and every wider one. `full`: it
 * does not.
 */
export type TrialFunds = { state: "room" } | { state: "full" } | { state: "none" };

export type TrialAdmission = { ok: true } | { ok: false; refusal: TrialRefusal };

/**
 * Admission of one trial request, in the specification's order. The caller
 * reads the counts before and records one only on `ok`.
 */
export function trialAdmission(args: {
  trial: TrialDeclaration | null | undefined;
  hasBudget: boolean;
  requester: TrialRequester;
  inputs: Record<string, unknown>;
  counts: TrialCounts;
  funds: TrialFunds;
  quote: TrialQuote;
  now: Date;
  agentName?: string;
}): TrialAdmission {
  const { trial, quote, now } = args;
  const no = (d: Omit<TrialRefusalDetails, "quote">): TrialAdmission => ({ ok: false, refusal: trialRefusal({ ...d, quote }, args.agentName, trial?.who) });
  if (args.hasBudget) return no({ reason: "budget" });
  if (!trial) return no({ reason: "not_offered" });
  const who = trial.who;
  const r = args.requester;
  const eligible = who === "anyone" ? true
    : who === "signed_in" ? r.kind !== "visitor" && r.signed_in
    : r.kind !== "visitor" && r.verified;
  if (!eligible) return no({ reason: "not_eligible" });
  const over = inputOverLimit(trial.shape, args.inputs);
  if (over) return no({ reason: "input", input: over.input, max: over.max });
  const l = trial.limits;
  const midnight = nextUtcMidnight(now);
  if (l.per_requester_per_day !== undefined && args.counts.requester_day >= l.per_requester_per_day) {
    return no({ reason: "requester_day", limit: l.per_requester_per_day, resets_at: midnight });
  }
  if (l.per_day !== undefined && args.counts.day >= l.per_day) {
    return no({ reason: "day", limit: l.per_day, resets_at: midnight });
  }
  if (l.per_requester_ever !== undefined && args.counts.requester_ever >= l.per_requester_ever) {
    return no({ reason: "requester_ever", limit: l.per_requester_ever });
  }
  if (args.funds.state !== "room") return no({ reason: "funds", resets_at: midnight });
  return { ok: true };
}

/**
 * Trial counts held in memory: the reference ledger for a node with no
 * store, and the shape a persistent one follows. Keys are the requester id
 * and the offering id; days are UTC.
 */
export class MemoryTrialLedger {
  private readonly perRequesterDay = new Map<string, number>();
  private readonly perDay = new Map<string, number>();
  private readonly ever = new Map<string, number>();

  counts(requester: string, offering: string, now: Date): TrialCounts {
    const day = trialDayOf(now);
    return {
      requester_day: this.perRequesterDay.get(`${day}|${offering}|${requester}`) ?? 0,
      day: this.perDay.get(`${day}|${offering}`) ?? 0,
      requester_ever: this.ever.get(`${offering}|${requester}`) ?? 0,
    };
  }

  /** Count one admitted trial. Never undone: a trial that fails after
   *  admission stays counted. */
  record(requester: string, offering: string, now: Date): void {
    const day = trialDayOf(now);
    const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };
    bump(this.perRequesterDay, `${day}|${offering}|${requester}`);
    bump(this.perDay, `${day}|${offering}`);
    bump(this.ever, `${offering}|${requester}`);
  }
}

// ── the node side ───────────────────────────────────────────────────────────

/** Where a node keeps its trial counts. `MemoryTrialLedger` is the default;
 *  a node that must survive restarts hands in one backed by a file or a
 *  database. Either method may answer through a promise. */
export interface TrialLedger {
  counts(requester: string, offering: string, now: Date): TrialCounts | Promise<TrialCounts>;
  /** Count one admitted trial. Never undone. */
  record(requester: string, offering: string, now: Date): void | Promise<void>;
}

/** What a handler is told about work admitted as a trial: who asked, the
 *  shape the trial runs under, and the caps only the work can measure. */
export interface TrialContext {
  trial: true;
  requester: TrialRequester;
  shape: TrialShape | undefined;
  caps: Array<{ input: string; limit: TrialInputLimitValue }>;
}

/** How a node is configured for trials (`AgentMesh.setTrials`). */
export interface TrialNodeOptions {
  /** The Agent Descriptor this node serves (Common Agent 6.2). Each
   *  offering's `trial` and declared `inputs` are read from it. */
  descriptor?: unknown;
  /** Trial declarations by offering id, beside or instead of a descriptor.
   *  An entry here wins over the descriptor's for the same offering. */
  trials?: Record<string, TrialDeclaration>;
  /** Where counts are kept. Default: a `MemoryTrialLedger`. */
  ledger?: TrialLedger;
  /** The senders this node trusts as hosts (Common Agent 7.7, Hosts): a list
   *  of agent keys or a predicate. Only a trusted host's `trial_requester`
   *  vouch is honoured; anyone else is the requester themselves. */
  trustedHosts?: readonly string[] | ((senderKey: string) => boolean);
  /** How the node tells whether a sender agent counts as signed in and
   *  verified. Default: signed in when the registry knows the sender (its
   *  manifest resolves with an owner), and not verified. */
  describeSender?: (senderKey: string) => { signed_in: boolean; verified: boolean } | Promise<{ signed_in: boolean; verified: boolean }>;
  /** The agent's name in the passage a person reads. */
  agentName?: string;
  /**
   * Who decides a trial request: this node (`"node"`, the default), or the
   * application in front of it (`"application"`), for a node such as the
   * reference adapter that keeps its own trial ledger, allowance and hosts
   * and answers TRIAL_REFUSED itself. Under `"application"` the node makes
   * no decision of its own: it hands the request to the application's admit
   * with the trial context, still skips the agreement, the funds hold and the
   * ordinary allowance check (a trial owes nothing), and still marks the
   * task's updates `trial: true`. The application must refuse whatever 7.7
   * refuses, in 7.7's order, before any work.
   */
  gatedBy?: "node" | "application";
}

/** Whether `sender` is a host `trusted` names. */
export function isTrustedHost(trusted: TrialNodeOptions["trustedHosts"], sender: string): boolean {
  if (!trusted) return false;
  if (typeof trusted === "function") {
    try { return trusted(sender) === true; } catch { return false; }
  }
  return trusted.includes(sender);
}

/**
 * Who a trial request is for. A vouch (`trial_requester`) is honoured only
 * from a trusted host, and a vouched visitor is never signed in or verified.
 * Anyone else is the requester: the sender key, kind `agent`, signed in and
 * verified as the node can tell.
 */
export function trialRequesterOf(args: {
  senderKey: string;
  vouch: unknown;
  trustedHost: boolean;
  sender: { signed_in: boolean; verified: boolean };
}): TrialRequester {
  const v = args.vouch;
  if (args.trustedHost && isRecord(v) && typeof v.id === "string" && v.id && (v.kind === "account" || v.kind === "visitor")) {
    if (v.kind === "visitor") return { id: v.id, kind: "visitor", signed_in: false, verified: false };
    return { id: v.id, kind: "account", signed_in: v.signed_in === true, verified: v.verified === true };
  }
  return { id: args.senderKey, kind: "agent", signed_in: args.sender.signed_in, verified: args.sender.verified };
}

/**
 * The key a requester is counted under. Account ids and agent keys are the
 * same wherever the request comes from; a visitor id is issued by one host,
 * so it is counted under that host, and two hosts' visitors never share a
 * count.
 */
export function trialLedgerKey(requester: TrialRequester, senderKey: string): string {
  if (requester.kind === "visitor") return `visitor:${senderKey}:${requester.id}`;
  return `${requester.kind}:${requester.id}`;
}

const TEXT_INPUT_KINDS = new Set(["text", "document", "identifier"]);

/**
 * The inputs a trial request carries, by declared input name, for the shape's
 * limits: each member of a structured request by its name; then the members
 * of an `inputs` object, when the request carries one (how a host sends a
 * person's answers); then a "<name>: value" line in the words, for a declared
 * input not given otherwise; and, only when the request carried no `inputs`
 * object, free text (a string request, or its `text` or `prompt` member)
 * counted against every declared text input still not given. An input
 * declared with no kind is read as text, the default kind. The reference
 * adapter reads inputs by the same rule (mesh-adapter trialInputsOf).
 */
export function trialInputsOf(
  input: unknown,
  declared: ReadonlyArray<{ name?: unknown; kind?: unknown }> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const obj = isRecord(input) ? input : null;
  if (obj) for (const [k, v] of Object.entries(obj)) out[k] = v;
  const given = obj && isRecord(obj.inputs) ? obj.inputs : null;
  if (given) for (const [k, v] of Object.entries(given)) out[k] = v;
  const text = typeof input === "string" ? input
    : typeof obj?.text === "string" ? obj.text
    : typeof obj?.prompt === "string" ? obj.prompt
    : null;
  if (text === null) return out;
  const names = (declared ?? []).filter((d): d is { name: string; kind?: unknown } => typeof d?.name === "string" && !!d.name);
  for (const d of names) {
    if (out[d.name] !== undefined) continue;
    const esc = d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`^[ \\t]*${esc}[ \\t]*:[ \\t]*(.*)$`, "im").exec(text);
    if (m) out[d.name] = m[1];
  }
  if (given) return out;
  for (const d of names) {
    const kind = typeof d.kind === "string" && d.kind ? d.kind : "text";
    if (TEXT_INPUT_KINDS.has(kind) && out[d.name] === undefined) out[d.name] = text;
  }
  return out;
}

/** One offering of a Descriptor, raw: its declared inputs and its trial. */
export function descriptorOffering(doc: unknown, offeringId: string): Record<string, unknown> | null {
  if (!isRecord(doc) || !Array.isArray(doc.offerings)) return null;
  for (const o of doc.offerings) if (isRecord(o) && o.id === offeringId) return o;
  return null;
}
