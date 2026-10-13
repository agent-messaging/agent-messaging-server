import type { CostCeiling, Envelope } from "./types/envelope.js";
import type { RequestPayload } from "./types/primitives.js";
import { MeshError, ErrorCode } from "./types/errors.js";
import {
  canonicalJSON,
  signTagged,
  verifyTagged,
  toB64Url,
  fromB64Url,
  type KeyPair,
} from "./internal/identity.js";

// The owner allowance (extensions/EXT-8-allowance.md): a signed, node-held
// spending policy an owner sets on their OWN agent — the owner-side complement
// to the core budget (§7.7). A budget is what you'll pay someone else; an
// allowance is what you'll let your own agent burn. It crosses no trust
// boundary, so it never rides the wire: this module is the document handling
// (shape, tagged signature, fail-closed verification), the metering arithmetic
// (floor, pinned by conformance/allowance.json), the smallest-remaining
// ceiling precedence, and the ledger. Enforcement — the admission refusal, the
// ask-owner hold, the spend report on the terminal respond — lives on
// AgentMesh, because it happens inside the inbound dispatch.
//
// A design constraint the extension anticipates: an SDK cannot see its host's
// model bill. The HOST supplies usage (`ctx.reportUsage` / `mesh.reportUsage`);
// the SDK meters it against the owner's declared cost model, enforces the
// ceilings, refuses with a price, and reports the spend.

/** The domain tag inside an allowance document's signed bytes (EXT-8 §1):
 *  `sig` covers this prefix + the canonical JSON of the document excluding
 *  `sig`. The prefix exists only inside the signed bytes — it never appears in
 *  the document itself. Pinned by conformance/allowance.json. */
export const ALLOWANCE_SIG_PREFIX = "agentmesh-allowance-v1\n";

/** Ceiling scopes (EXT-8 §1) — a CLOSED enum. A consumer MUST reject an
 *  unknown scope rather than ignore the ceiling: an ignored ceiling is an
 *  unenforced one. `trial` (Common Agent 7.5, 7.7) is a ceiling on what trial
 *  work may cost per UTC day: trial spend counts against it AND every wider
 *  ceiling, and ordinary work never counts against it. */
export type AllowanceScope = "task" | "context" | "day" | "trial";

const ALLOWANCE_SCOPES: ReadonlySet<string> = new Set<AllowanceScope>([
  "task",
  "context",
  "day",
  "trial",
]);

/** One ceiling. Optional `task_id` / `context_id` narrow it to that one task
 *  or context; absent, a `task` ceiling applies to each Task and a `context`
 *  ceiling to each context individually. `day` means the UTC calendar day of
 *  the metering instant. */
export interface AllowanceCeiling {
  scope: AllowanceScope;
  /** Integer micro-units of the document's currency. 0 is legal — a ceiling
   *  pinned shut — and -1 is not (§19.3: non-negative, never a float). */
  amount_micro: number;
  task_id?: string;
  context_id?: string;
}

/** The owner's DECLARED conversion from the agent's tokens to money. The node
 *  cannot learn the model's price; the owner states it. A token rate is
 *  legitimate here where §7.7 forbids it on the wire: tokens are the
 *  responder's private units, and inside one household the owner knows exactly
 *  whose units they are. */
export interface AllowanceCostModel {
  /** Integer micro-units of `currency` per 1,000 tokens. */
  per_1k_tokens_micro: number;
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
}

export type AllowanceOnExhausted = "refuse" | "ask_owner";

/** The allowance document (EXT-8 §1): one signed JSON document per agent,
 *  signed by the owner key, held at the agent's node. */
export interface AllowanceDocument {
  /** The document format version, the integer 1. */
  v: 1;
  /** The agent key this allowance governs. */
  agent: string;
  /** The signer. A node MUST verify `sig` against this key before enforcing. */
  owner_key: string;
  cost_model: AllowanceCostModel;
  ceilings: AllowanceCeiling[];
  on_exhausted: AllowanceOnExhausted;
  /** RFC-3339. The document is replaced whole; the latest `updated_at` under a
   *  valid signature is the policy. */
  updated_at: string;
  /** base64url Ed25519 signature over ALLOWANCE_SIG_PREFIX + the canonical
   *  JSON of the document excluding `sig`. */
  sig: string;
}

function invalid(message: string): MeshError {
  // Same code the malformed-budget refusal uses (validateBudget): the document
  // is a §19.3-money-bearing shape that failed its shape contract. Local —
  // an allowance never rides the wire.
  return new MeshError(ErrorCode.INVALID_ENVELOPE, `Invalid allowance (EXT-8 §1): ${message}`, {
    retryable: false,
  });
}

/**
 * Validate an allowance document's SHAPE (EXT-8 §1) — everything except the
 * signature's cryptographic verification, though an absent/malformed `sig` is
 * itself a shape fault: a node MUST NOT enforce an unsigned document.
 *
 * Throws `INVALID_ENVELOPE` naming the single fault. conformance/allowance.json
 * pins the invalid cases: every one except `missing_sig` carries a GENUINE
 * owner signature, so shape rejection never depends on a signature failure.
 */
export function validateAllowance(doc: unknown): asserts doc is AllowanceDocument {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw invalid("the document must be a non-null object");
  }
  const d = doc as Record<string, unknown>;

  if (d.v !== 1) throw invalid("'v' must be the integer 1");
  if (typeof d.agent !== "string" || d.agent === "") {
    throw invalid("'agent' (the governed agent key) is required");
  }
  if (typeof d.owner_key !== "string" || d.owner_key === "") {
    throw invalid("'owner_key' (the signer) is required");
  }

  // cost_model is REQUIRED: a ceiling without a declared conversion cannot be
  // metered against, and a document that cannot be metered against enforces
  // nothing.
  const cm = d.cost_model;
  if (typeof cm !== "object" || cm === null || Array.isArray(cm)) {
    throw invalid("'cost_model' is required — a document that cannot be metered against enforces nothing");
  }
  const cmr = cm as Record<string, unknown>;
  if (!Number.isSafeInteger(cmr.per_1k_tokens_micro) || (cmr.per_1k_tokens_micro as number) < 0) {
    throw invalid(
      "'cost_model.per_1k_tokens_micro' must be a non-negative integer of micro-units — never a float (§19.3)",
    );
  }
  if (typeof cmr.currency !== "string" || !/^[A-Z]{3}$/.test(cmr.currency)) {
    throw invalid("'cost_model.currency' must be an ISO 4217 code (e.g. \"USD\")");
  }

  if (!Array.isArray(d.ceilings) || d.ceilings.length === 0) {
    throw invalid("'ceilings' must be a non-empty array");
  }
  for (const c of d.ceilings as unknown[]) {
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      throw invalid("each ceiling must be an object");
    }
    const cr = c as Record<string, unknown>;
    if (typeof cr.scope !== "string" || !ALLOWANCE_SCOPES.has(cr.scope)) {
      throw invalid(
        `ceiling scope '${String(cr.scope)}' is not one of the closed enum task | context | day | trial: ` +
          "an unknown scope MUST be rejected rather than ignored (an ignored ceiling is an unenforced one)",
      );
    }
    if (!Number.isSafeInteger(cr.amount_micro)) {
      throw invalid("'amount_micro' must be an integer of micro-units — never a float (§19.3)");
    }
    if ((cr.amount_micro as number) < 0) {
      throw invalid("'amount_micro' must be non-negative (a pinned-shut ceiling is 0, never -1)");
    }
    if (cr.task_id !== undefined && typeof cr.task_id !== "string") {
      throw invalid("'task_id', when present, must be a string");
    }
    if (cr.context_id !== undefined && typeof cr.context_id !== "string") {
      throw invalid("'context_id', when present, must be a string");
    }
  }

  if (d.on_exhausted !== "refuse" && d.on_exhausted !== "ask_owner") {
    throw invalid("'on_exhausted' must be \"refuse\" or \"ask_owner\"");
  }
  if (typeof d.updated_at !== "string" || d.updated_at === "") {
    throw invalid("'updated_at' must be an RFC-3339 instant");
  }
  if (typeof d.sig !== "string" || d.sig === "") {
    throw invalid(
      "the document is unsigned — a node MUST NOT enforce an unsigned allowance, and MUST NOT treat it as absent (it fails closed)",
    );
  }
}

/** The canonical JSON an allowance's `sig` covers (with the prefix): the
 *  document excluding `sig`, SPEC §5.3 canonicalization. */
export function canonicalAllowanceJSON(doc: object): string {
  const { sig: _omit, ...rest } = doc as { sig?: string };
  return canonicalJSON(rest);
}

/** Verify an allowance document's `sig` against its own `owner_key` (EXT-8 §1):
 *  base64url Ed25519 over ALLOWANCE_SIG_PREFIX + the canonical JSON excluding
 *  `sig`. Signature only — shape is `validateAllowance`'s job. */
export function verifyAllowanceSignature(doc: unknown): boolean {
  if (typeof doc !== "object" || doc === null) return false;
  const d = doc as Record<string, unknown>;
  if (typeof d.owner_key !== "string" || typeof d.sig !== "string" || d.sig === "") return false;
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromB64Url(d.sig);
  } catch {
    return false;
  }
  return verifyTagged(d.owner_key, ALLOWANCE_SIG_PREFIX, canonicalAllowanceJSON(d), sigBytes);
}

/**
 * Sign an allowance document with the owner key (owner tooling, EXT-8 §1).
 * Sets `owner_key` to the signing key's public key — the signer IS the
 * owner_key by definition, and filling it here makes a mismatch impossible —
 * and `sig` to the base64url signature over the tagged signed bytes. Returns a
 * new document; the input is not mutated.
 */
export function signAllowance(
  doc: Omit<AllowanceDocument, "sig" | "owner_key"> & { owner_key?: string; sig?: string },
  ownerKp: KeyPair,
): AllowanceDocument {
  const { sig: _drop, ...rest } = doc;
  const unsigned = { ...rest, owner_key: ownerKp.getPublicKey() };
  const sig = toB64Url(signTagged(ownerKp, ALLOWANCE_SIG_PREFIX, canonicalJSON(unsigned)));
  const signed = { ...unsigned, sig } as AllowanceDocument;
  validateAllowance(signed);
  return signed;
}

/**
 * Load an allowance document: shape (EXT-8 §1), then signature against
 * `owner_key`. Throws `INVALID_ENVELOPE` on a shape fault, `IDENTITY_MISMATCH`
 * on a signature that does not verify.
 *
 * Callers enforcing a document MUST fail closed on a throw — every ceiling
 * exhausted, never "no allowance" (`AgentMesh.setAllowance` does this).
 * Failing open here is failing open on the owner's money.
 */
export function loadAllowance(doc: unknown): AllowanceDocument {
  validateAllowance(doc);
  if (!verifyAllowanceSignature(doc)) {
    throw new MeshError(
      ErrorCode.IDENTITY_MISMATCH,
      "Allowance signature does not verify against owner_key (EXT-8 §1) — the document fails closed",
      { retryable: false },
    );
  }
  return doc;
}

// ── metering (EXT-8 §2) ─────────────────────────────────────────────────────

/**
 * The metering arithmetic, pinned by conformance/allowance.json:
 * `cost_micro = floor(tokens × per_1k_tokens_micro / 1000)`, integer
 * arithmetic throughout (BigInt, so no float ever touches money and no
 * product overflows). FLOOR, deliberately: rounding toward zero means the
 * node never charges a partial micro-unit against the owner's ceiling, and
 * any two nodes that meter the same invocation agree to the micro-unit.
 */
export function meterAllowanceCost(tokens: number, per1kTokensMicro: number): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw invalid("'tokens' must be a non-negative integer");
  }
  if (!Number.isSafeInteger(per1kTokensMicro) || per1kTokensMicro < 0) {
    throw invalid("'per_1k_tokens_micro' must be a non-negative integer");
  }
  // BigInt division truncates toward zero, which for non-negative operands IS
  // the pinned floor.
  return Number((BigInt(tokens) * BigInt(per1kTokensMicro)) / 1000n);
}

/** The UTC calendar day of an instant, as "YYYY-MM-DD" (EXT-8 §1: `day` means
 *  the UTC calendar day of the metering instant). */
export function allowanceDayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// ── usage, ledger, decisions ────────────────────────────────────────────────

/** What the host reports for a task: its own token count (converted via the
 *  document's cost_model) or money directly (micro-units of the document's
 *  currency). When both are present, `cost_micro` wins — explicit money is the
 *  more direct claim. */
export interface AllowanceUsage {
  tokens?: number;
  cost_micro?: number;
}

/** One metered invocation, as the ledger keeps it. Spend is accounted to the
 *  Task, to the Task's context, and to the UTC day — all three at once. */
export interface AllowanceLedgerEntry {
  task_id: string;
  context_id?: string;
  /** The UTC calendar day of the metering instant, "YYYY-MM-DD". */
  day: string;
  /** The reported token count, when usage arrived as tokens. */
  tokens?: number;
  /** The metered spend, floor-rounded micro-units. */
  cost_micro: number;
  /** The metering instant, RFC-3339. */
  at: string;
  /** Present and true when the spend was trial work (Common Agent 7.7): it
   *  counts against the `trial` ceiling as well as every wider one. */
  trial?: true;
}

/** The queryable ledger: every entry plus the per-scope rollups the ceilings
 *  are enforced against. */
export interface AllowanceLedgerView {
  /** The document's currency, or null when no valid document is armed. */
  currency: string | null;
  entries: AllowanceLedgerEntry[];
  total_micro: number;
  by_task: Record<string, number>;
  by_context: Record<string, number>;
  by_day: Record<string, number>;
  /** Trial spend per UTC day: what the `trial` ceiling is enforced against. */
  by_trial_day: Record<string, number>;
}

/** The ceiling that binds an admission decision: whichever APPLICABLE ceiling
 *  has the smallest REMAINING amount (amount_micro minus the spend already
 *  accounted to that ceiling's scope). Specificity decides what a ceiling
 *  covers, never which one wins. */
export interface AllowanceBinding {
  scope: AllowanceScope;
  amount_micro: number;
  spent_micro: number;
  remaining_micro: number;
  task_id?: string;
  context_id?: string;
}

export interface AllowanceDecision {
  /** True when the estimate fits under every applicable ceiling. */
  fits: boolean;
  /** The smallest-remaining applicable ceiling; null when none applies (or the
   *  document fails closed, where no arithmetic is trustworthy). */
  binding: AllowanceBinding | null;
  /** The estimate the decision judged, micro-units. */
  estimate_micro: number;
}

/** The armed allowance as the host observes it. `valid: false` is the
 *  fail-closed state (EXT-8 §1): the document did not verify, every ceiling is
 *  treated as exhausted, and `error` says why — the error state the host can
 *  observe and repair with a valid replacement. */
export interface AllowanceStatus {
  valid: boolean;
  error?: string;
  on_exhausted: AllowanceOnExhausted;
  /** The verified document, or null in the fail-closed state. */
  document: AllowanceDocument | null;
}

/** The question surfaced when `on_exhausted` is "ask_owner": the node holds
 *  the work unstarted and asks the HOST — the SDK has no owner channel of its
 *  own — whether to proceed. Resolve `true` after the owner raised the ceiling
 *  (a new `setAllowance`); the SDK then re-checks admission against the
 *  replacement. Resolve `false` (or throw) and the SDK refuses with the same
 *  BUDGET_INSUFFICIENT shape a `refuse` document answers with. */
export interface AllowanceQuestion {
  envelope: Envelope;
  taskId: string;
  offering: string;
  /** The node's price for the held work (§19.3 quote), when priceable. */
  estimate: CostCeiling | null;
  binding: AllowanceBinding | null;
}

export type AllowanceAskOwnerHandler = (
  question: AllowanceQuestion,
) => boolean | Promise<boolean>;

/** Host-supplied estimator for incoming work, in TOKENS (converted through the
 *  document's cost_model). Default when absent: tokens ≈ ceil(sender-text
 *  chars / 4). */
export type AllowanceEstimator = (envelope: Envelope, payload: RequestPayload) => number;

// ── the engine ──────────────────────────────────────────────────────────────

interface Ledger {
  entries: AllowanceLedgerEntry[];
  byTask: Map<string, number>;
  byContext: Map<string, number>;
  byDay: Map<string, number>;
  byTrialDay: Map<string, number>;
  total: number;
}

function newLedger(): Ledger {
  return { entries: [], byTask: new Map(), byContext: new Map(), byDay: new Map(), byTrialDay: new Map(), total: 0 };
}

/**
 * The node-side allowance machinery (EXT-8 §2), embedded by `AgentMesh` when
 * an allowance is armed: holds the (verified or fail-closed) document and the
 * ledger, meters reported usage, and answers admission decisions under
 * smallest-remaining precedence.
 *
 * Construction NEVER throws: a document that fails verification arms the
 * engine in the fail-closed state — every ceiling exhausted, `status().error`
 * set — because treating a broken policy as absent would fail open on the
 * owner's money.
 */
export class AllowanceEngine {
  private readonly doc: AllowanceDocument | null;
  private readonly error: string | null;
  private readonly fallbackOnExhausted: AllowanceOnExhausted;
  private readonly fallbackCostModel: AllowanceCostModel | null;
  private readonly ledger: Ledger;

  constructor(doc: unknown, opts?: { expectedAgent?: string; inheritLedgerFrom?: AllowanceEngine }) {
    let loaded: AllowanceDocument | null = null;
    let error: string | null = null;
    try {
      loaded = loadAllowance(doc);
      if (opts?.expectedAgent !== undefined && loaded.agent !== opts.expectedAgent) {
        error =
          `the allowance governs agent ${loaded.agent}, not this agent (${opts.expectedAgent}) — ` +
          "one document per agent (EXT-8 §1)";
        loaded = null;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    this.doc = loaded;
    this.error = error;
    // Fail-closed fallbacks: EXT-8 §1 says a non-verifying document is treated
    // as every-ceiling-exhausted "(the on_exhausted behaviour applies)", so the
    // behaviour and the refusal's price quote are read best-effort from the
    // broken document; anything unreadable defaults to the strictest answer.
    const d = (typeof doc === "object" && doc !== null ? doc : {}) as Record<string, unknown>;
    this.fallbackOnExhausted = d.on_exhausted === "ask_owner" ? "ask_owner" : "refuse";
    const cm = d.cost_model as Record<string, unknown> | undefined;
    this.fallbackCostModel =
      cm &&
      Number.isSafeInteger(cm.per_1k_tokens_micro) &&
      (cm.per_1k_tokens_micro as number) >= 0 &&
      typeof cm.currency === "string" &&
      /^[A-Z]{3}$/.test(cm.currency)
        ? {
            per_1k_tokens_micro: cm.per_1k_tokens_micro as number,
            currency: cm.currency as string,
          }
        : null;
    // A replacement document inherits the spend already accounted — raising a
    // ceiling must not also forgive the morning's metered usage.
    this.ledger = opts?.inheritLedgerFrom ? opts.inheritLedgerFrom.ledger : newLedger();
  }

  get valid(): boolean {
    return this.doc !== null;
  }

  status(): AllowanceStatus {
    return {
      valid: this.doc !== null,
      ...(this.error !== null ? { error: this.error } : {}),
      on_exhausted: this.onExhausted(),
      document: this.doc,
    };
  }

  onExhausted(): AllowanceOnExhausted {
    return this.doc?.on_exhausted ?? this.fallbackOnExhausted;
  }

  /** The currency spend is denominated in, or null when no cost model is
   *  readable (a fail-closed document may still quote through its declared
   *  model — the quote is a price, not an enforcement). */
  currency(): string | null {
    return (this.doc?.cost_model ?? this.fallbackCostModel)?.currency ?? null;
  }

  /** Convert a token count to micro-units through the document's cost model
   *  (fixture-pinned floor). Null when no cost model is readable. */
  priceTokens(tokens: number): number | null {
    const cm = this.doc?.cost_model ?? this.fallbackCostModel;
    if (!cm) return null;
    return meterAllowanceCost(tokens, cm.per_1k_tokens_micro);
  }

  /**
   * Meter one reported usage against the cost model and account it to the
   * Task, the context, and the UTC day (EXT-8 §2).
   *
   * Bookkeeping continues in the FAIL-CLOSED state, deliberately: admission is
   * refusing everything there, but work admitted before the document broke —
   * or usage the host reports after the fact — still burned real money, and
   * the valid replacement must inherit that spend rather than find it
   * forgiven. Fail-closed closes the door on NEW spend; it never erases the
   * books. Returns the ledger entry, or null only when the usage cannot be
   * metered at all (tokens reported with no readable cost model to convert
   * them — `cost_micro` is money already and always records).
   */
  record(
    taskId: string,
    contextId: string | undefined,
    usage: AllowanceUsage,
    now: Date = new Date(),
    opts?: { trial?: boolean },
  ): AllowanceLedgerEntry | null {
    let cost: number;
    if (usage.cost_micro !== undefined) {
      if (!Number.isSafeInteger(usage.cost_micro) || usage.cost_micro < 0) {
        throw invalid("'cost_micro' must be a non-negative integer of micro-units (§19.3)");
      }
      cost = usage.cost_micro;
    } else if (usage.tokens !== undefined) {
      const cm = this.doc?.cost_model ?? this.fallbackCostModel;
      if (!cm) return null;
      cost = meterAllowanceCost(usage.tokens, cm.per_1k_tokens_micro);
    } else {
      throw invalid("usage must carry 'tokens' or 'cost_micro'");
    }
    const day = allowanceDayOf(now);
    const entry: AllowanceLedgerEntry = {
      task_id: taskId,
      ...(contextId !== undefined ? { context_id: contextId } : {}),
      day,
      ...(usage.tokens !== undefined ? { tokens: usage.tokens } : {}),
      cost_micro: cost,
      at: now.toISOString(),
      ...(opts?.trial === true ? { trial: true as const } : {}),
    };
    this.ledger.entries.push(entry);
    this.ledger.total += cost;
    bump(this.ledger.byTask, taskId, cost);
    if (contextId !== undefined) bump(this.ledger.byContext, contextId, cost);
    bump(this.ledger.byDay, day, cost);
    // Trial spend is ALSO trial spend: the trial ceiling sees it, and so does
    // every wider ceiling above (the owner's total stays the total).
    if (opts?.trial === true) bump(this.ledger.byTrialDay, day, cost);
    return entry;
  }

  /** Whether the verified document sets a `trial` ceiling. A fail-closed
   *  engine has no trustworthy document and answers false. */
  hasTrialCeiling(): boolean {
    return !!this.doc && this.doc.ceilings.some((c) => c.scope === "trial");
  }

  /**
   * The trial ceiling's answer for trial work estimated at `estimateMicro`
   * (Common Agent 7.5, 7.7): `none` when the owner set no trial ceiling (the
   * node then refuses on funds, never spends unbounded), `room` when the
   * estimate fits under the trial ceiling and every wider one, `full` when it
   * does not. A configured document that fails verification answers `full`:
   * failing closed is the rule everywhere in 7.5.
   */
  trialFunds(
    taskId: string,
    contextId: string | undefined,
    estimateMicro: number,
    now: Date = new Date(),
  ): { state: "room" } | { state: "full" } | { state: "none" } {
    if (!this.doc) return { state: "full" };
    if (!this.hasTrialCeiling()) return { state: "none" };
    return this.decide(taskId, contextId, estimateMicro, now, { trial: true }).fits
      ? { state: "room" }
      : { state: "full" };
  }

  /** Total metered spend accounted to one Task — the number the terminal
   *  respond's `cost` field reports (§19.3). */
  spentForTask(taskId: string): number {
    return this.ledger.byTask.get(taskId) ?? 0;
  }

  ledgerView(): AllowanceLedgerView {
    return {
      currency: this.currency(),
      entries: this.ledger.entries.map((e) => ({ ...e })),
      total_micro: this.ledger.total,
      by_task: Object.fromEntries(this.ledger.byTask),
      by_context: Object.fromEntries(this.ledger.byContext),
      by_day: Object.fromEntries(this.ledger.byDay),
      by_trial_day: Object.fromEntries(this.ledger.byTrialDay),
    };
  }

  /**
   * The admission decision (EXT-8 §2): every applicable ceiling applies at
   * once, and the BINDING ceiling is whichever has the smallest REMAINING
   * amount — specificity decides what a ceiling covers, never which one wins.
   * A fail-closed engine answers as if every ceiling were exhausted.
   *
   * "Would exceed" is STRICT: an estimate that exactly equals the binding
   * ceiling's remaining balance ADMITS — spending exactly what you have left
   * is within the allowance (fixture: estimate_equals_remaining).
   *
   * Applicability:
   *  - `task`   — applies to the decision's Task (narrowed `task_id` must match);
   *  - `context`— narrowed `context_id` must match the work's context; an
   *               un-narrowed context ceiling applies to each context
   *               individually, so it binds only work that HAS a context;
   *  - `day`    — always applies, against the UTC day of `now`;
   *  - `trial`  — applies only when `opts.trial` is true (trial work, Common
   *               Agent 7.7), against the day's trial spend. Ordinary work
   *               is never measured against it.
   */
  decide(
    taskId: string,
    contextId: string | undefined,
    estimateMicro: number,
    now: Date = new Date(),
    opts?: { trial?: boolean },
  ): AllowanceDecision {
    if (!this.doc) {
      // Fail closed: every ceiling exhausted (EXT-8 §1). No binding is
      // reported because no ceiling arithmetic from an unverified document is
      // trustworthy.
      return { fits: false, binding: null, estimate_micro: estimateMicro };
    }
    const day = allowanceDayOf(now);
    let binding: AllowanceBinding | null = null;
    for (const c of this.doc.ceilings) {
      let spent: number;
      if (c.scope === "task") {
        if (c.task_id !== undefined && c.task_id !== taskId) continue;
        spent = this.ledger.byTask.get(taskId) ?? 0;
      } else if (c.scope === "context") {
        if (c.context_id !== undefined) {
          if (contextId !== c.context_id) continue;
        } else if (contextId === undefined) {
          continue;
        }
        spent = this.ledger.byContext.get(contextId as string) ?? 0;
      } else if (c.scope === "trial") {
        if (opts?.trial !== true) continue;
        spent = this.ledger.byTrialDay.get(day) ?? 0;
      } else {
        spent = this.ledger.byDay.get(day) ?? 0;
      }
      const remaining = Math.max(0, c.amount_micro - spent);
      if (binding === null || remaining < binding.remaining_micro) {
        binding = {
          scope: c.scope,
          amount_micro: c.amount_micro,
          spent_micro: spent,
          remaining_micro: remaining,
          ...(c.task_id !== undefined ? { task_id: c.task_id } : {}),
          ...(c.context_id !== undefined ? { context_id: c.context_id } : {}),
        };
      }
    }
    return {
      fits: binding === null || estimateMicro <= binding.remaining_micro,
      binding,
      estimate_micro: estimateMicro,
    };
  }
}

function bump(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}
