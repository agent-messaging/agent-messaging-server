/**
 * Call receipts (EXT-15, `mesh://extensions/receipts/v1`): the platform's
 * signed record of one call, what it cost and what ran.
 *
 * A caller asks for one on the request, `payload.config.receipt`:
 * `"none"`, `"summary"` or `"full"` (`RequestConfig.receipt`). The agent's
 * answer goes out exactly as it would have; the receipt follows it, once the
 * charge settles, as its own signed message to the caller's inbox, linked by
 * `request_id`. Agents never write receipts: the answer is the agent's word,
 * and the charge is the platform's fact, so the platform signs the receipt.
 *
 * The receipt is a record in the Common Agent record convention (Common Agent
 * §8.1): a `signatures` array whose entry signs the ASCII tag
 * `agent-call-receipt-v1`, one newline, and the JCS canonical JSON of the
 * document with `signatures` removed. `verifyCallReceipt` checks that, the
 * format, the tier and the shape; who the issuer is worth is the reader's
 * judgment, so pass the issuer key you trust to pin it.
 *
 * Amounts are integers in micro-units of `currency` (Agent Messaging §19.3);
 * XCR is the platform credit, one credit per micro-unit.
 */

import {
  canonicalJSON,
  signTagged,
  verifyTagged,
  fromB64Url,
  keyPairFromSeed,
  type KeyPair,
} from "./internal/identity.js";

/** The extension's URI. */
export const RECEIPTS_EXTENSION_URI = "mesh://extensions/receipts/v1";

/** The record tag the issuer signs under (Common Agent §8.1). */
export const CALL_RECEIPT_TAG = "agent-call-receipt-v1";

/** The one value `format` may hold. */
export const CALL_RECEIPT_FORMAT = "agent-call-receipt-v1";

/** What a request asks for, in `payload.config.receipt`. Absent means the
 *  caller's standing default, which is `none` unless the caller's account set
 *  another. */
export type ReceiptLevel = "none" | "summary" | "full";

export const RECEIPT_LEVELS: readonly ReceiptLevel[] = ["none", "summary", "full"];

/** Whether the charge behind a receipt has settled: `settled` (final),
 *  `provisional` (the amount is known and the ledger has not settled it yet;
 *  a settled receipt with the same `receipt_id` follows), or
 *  `pending_upstream` (part of the cost is an upstream provider's that has not
 *  reported yet). */
export type ReceiptSettlement = "settled" | "provisional" | "pending_upstream";

/** A record-convention signature entry (Common Agent §8.1). */
export interface RecordSignature {
  tag: string;
  by: string;
  sig: string;
  alg: "ed25519";
}

/** The summary tier: every receipt carries these. */
export interface CallReceiptSummary {
  format: typeof CALL_RECEIPT_FORMAT;
  tier: "summary" | "full";
  receipt_id: string;
  request_id: string | null;
  task_id: string | null;
  context_id: string | null;
  /** The job the call opened or revised, where the platform keeps one. */
  job: string | null;
  provider: { key: string; handle: string | null };
  offering: string;
  requested_at: string;
  delivered_at: string | null;
  elapsed_ms: number | null;
  /** What the caller paid, in micro-units of `currency`, net of refunds. */
  total: number;
  currency: string;
  /** How the price was set: `free`, `per_call`, `per_job`, `metered`,
   *  `fixed_fee` or `time_and_materials`. */
  arrangement: string;
  settled: ReceiptSettlement;
  agent_version: string | null;
  /** The task's end state: `completed`, `failed`, `canceled`,
   *  `input_required`, or `working` while it is still open. */
  status: string;
  error_code: string | null;
  issued_at: string;
  /** The issuing platform: its key, which is the signature's `by`, and its
   *  name. */
  issuer: { key: string; name: string };
}

/** One meter line of the cost (Agent SoW §5.5.2's shape). */
export interface ReceiptLine {
  meter: string;
  count: number | null;
  unit: string | null;
  rate: number | null;
  amount: number;
  capped: boolean;
  pass_through: number;
  upstream_receipt: string | null;
}

/** One step of multi-step work (a solution run, a build). */
export interface ReceiptStep {
  step: string;
  provider: { key: string; handle: string | null } | null;
  offering: string | null;
  job: string | null;
  status: string;
  requested_at: string | null;
  delivered_at: string | null;
  elapsed_ms: number | null;
  total: number;
  agent_version: string | null;
  lines: ReceiptLine[];
  ledger_refs: string[];
}

/** The full tier adds the timing breakdown, the cost breakdown and what ran. */
export interface CallReceiptFull extends CallReceiptSummary {
  tier: "full";
  trace_id: string | null;
  asked_by: string | null;
  paid_by: string | null;
  queued_ms: number | null;
  working_ms: number | null;
  waiting_on_you_ms: number | null;
  waiting_on_person_ms: number | null;
  rounds: number;
  price_source: { kind: string; id: string | null; version: number | null; digest: string | null } | null;
  lines: ReceiptLine[];
  ceiling: number | null;
  absorbed: number;
  refunds: Array<{ txn_id: string; amount: number; at: string | null; reason: string | null }>;
  ledger_refs: string[];
  package_digest: string | null;
  descriptor_digest: string | null;
  run_config: { name: string | null; digest: string | null } | null;
  manifest_verified: boolean | null;
  reused: { pieces: number; of: number } | null;
  artifacts: { count: number; bytes: number };
  steps?: ReceiptStep[];
}

export type CallReceiptDocument = CallReceiptSummary | CallReceiptFull;

export type SignedCallReceipt<T extends CallReceiptDocument = CallReceiptDocument> = T & { signatures: RecordSignature[] };

/** Read the receipt level a request asked for, or null when it asked for
 *  none in particular (the caller's standing default applies). A value
 *  outside the three is null too: a receiver never guesses.
 *
 *  Both wire forms: `payload.config.receipt` on a 0.3.0 request, and on a
 *  0.4.0 frame `{"receipt": level}` under this extension's URI in the
 *  starting Message's `metadata` (EXT-15 §8.3, A2A binding §12.10). */
export function receiptLevelOf(payload: unknown): ReceiptLevel | null {
  const p = payload as { config?: { receipt?: unknown }; a2a?: { params?: { message?: { metadata?: Record<string, unknown> } } } } | null;
  const asked = p?.a2a?.params?.message?.metadata?.[RECEIPTS_EXTENSION_URI] as { receipt?: unknown } | undefined;
  const v = p?.config?.receipt ?? (asked && typeof asked === "object" ? asked.receipt : undefined);
  return typeof v === "string" && (RECEIPT_LEVELS as readonly string[]).includes(v) ? (v as ReceiptLevel) : null;
}

/** The summary tier of a full receipt: the summary members only, `tier`
 *  set to `summary`. Unsigned; the issuer signs each tier it sends. */
export function summaryOfReceipt(doc: CallReceiptDocument): CallReceiptSummary {
  const out: Record<string, unknown> = {};
  for (const k of SUMMARY_MEMBERS) out[k] = (doc as unknown as Record<string, unknown>)[k];
  out.tier = "summary";
  return out as unknown as CallReceiptSummary;
}

const SUMMARY_MEMBERS = [
  "format", "tier", "receipt_id", "request_id", "task_id", "context_id", "job", "provider", "offering",
  "requested_at", "delivered_at", "elapsed_ms", "total", "currency", "arrangement", "settled",
  "agent_version", "status", "error_code", "issued_at", "issuer",
] as const;

/** Members that may never appear in a receipt: the model behind an agent and
 *  the caller's balance are not the receipt's to say. */
const NEVER = ["model", "balance", "available"] as const;

/** The signed bytes' canonical part: the document without `signatures`. */
export function canonicalCallReceiptJSON(doc: object): string {
  const { signatures: _omit, ...rest } = doc as Record<string, unknown>;
  return canonicalJSON(rest);
}

/** Sign a receipt as its issuer. `issuer.key` must be the signing key. */
export function signCallReceipt<T extends CallReceiptDocument>(doc: T, issuer: KeyPair | string): SignedCallReceipt<T> {
  const kp = typeof issuer === "string" ? keyPairFromSeed(issuer) : issuer;
  const by = kp.getPublicKey();
  if (doc.issuer?.key !== by) throw new Error(`the receipt names issuer ${doc.issuer?.key} but is signed by ${by}`);
  const sig = signTagged(kp, `${CALL_RECEIPT_TAG}\n`, canonicalCallReceiptJSON(doc));
  return { ...doc, signatures: [{ tag: CALL_RECEIPT_TAG, by, sig: toB64(sig), alg: "ed25519" }] };
}

export type CallReceiptVerdict = { ok: true; receipt: SignedCallReceipt } | { ok: false; reason: string };

/**
 * Check a receipt: the format and tier, the summary members' presence and
 * types, no member it may never carry, and a signature under
 * `agent-call-receipt-v1` by the key `issuer.key` names. With `issuerKey`,
 * the issuer must also be that key.
 */
export function verifyCallReceipt(doc: unknown, issuerKey?: string): CallReceiptVerdict {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, reason: "a receipt is a JSON object" };
  const d = doc as Record<string, unknown>;
  if (d.format !== CALL_RECEIPT_FORMAT) return { ok: false, reason: `format must be ${CALL_RECEIPT_FORMAT}` };
  if (d.tier !== "summary" && d.tier !== "full") return { ok: false, reason: "tier must be summary or full" };
  for (const k of SUMMARY_MEMBERS) if (!(k in d)) return { ok: false, reason: `the receipt has no ${k}` };
  for (const k of NEVER) if (k in d) return { ok: false, reason: `a receipt never carries ${k}` };
  if (typeof d.receipt_id !== "string" || !d.receipt_id) return { ok: false, reason: "receipt_id must be a string" };
  if (!Number.isSafeInteger(d.total) || (d.total as number) < 0) return { ok: false, reason: "total must be a whole number of micro-units, not negative" };
  if (typeof d.currency !== "string" || !/^[A-Z]{3}$/.test(d.currency)) return { ok: false, reason: "currency must be a three-letter code" };
  if (!["settled", "provisional", "pending_upstream"].includes(String(d.settled))) return { ok: false, reason: "settled must be settled, provisional or pending_upstream" };
  const issuer = d.issuer as { key?: unknown } | null;
  if (!issuer || typeof issuer.key !== "string") return { ok: false, reason: "issuer.key must be the issuer's key" };
  if (issuerKey && issuer.key !== issuerKey) return { ok: false, reason: "the receipt was issued by another key" };
  const sigs = Array.isArray(d.signatures) ? (d.signatures as RecordSignature[]) : [];
  const entry = sigs.find((s) => s && s.tag === CALL_RECEIPT_TAG && s.by === issuer.key);
  if (!entry || typeof entry.sig !== "string") return { ok: false, reason: `no ${CALL_RECEIPT_TAG} signature by the issuer` };
  let raw: Uint8Array;
  try { raw = fromB64Url(entry.sig.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")); } catch { return { ok: false, reason: "the signature is not base64" }; }
  if (!verifyTagged(issuer.key, `${CALL_RECEIPT_TAG}\n`, canonicalCallReceiptJSON(d), raw)) return { ok: false, reason: "the signature does not verify" };
  return { ok: true, receipt: d as unknown as SignedCallReceipt };
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
