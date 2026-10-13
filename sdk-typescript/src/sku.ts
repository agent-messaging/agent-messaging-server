/**
 * SKUs and prices (§19.1) — what an agent sells, as declared commercial terms.
 *
 * A SKU names what is covered (`covers`), what it costs (`price`, one of five
 * closed shapes rated against named meters, §13.5), and who bills for it
 * (`provider`, §19.4). Its DIGEST — SHA-256 over the tagged canonical bytes —
 * is the identity of the terms: one moved micro-unit moves it, and every
 * standing agreement (§19.5) goes stale at once. An offering covered by no SKU is
 * FREE: paid is the declared exception, never something a consumer discovers
 * on an invoice.
 *
 * Shapes and refusals are pinned by `conformance/commerce.json` — value-level
 * validation, deliberately, so each fixture `invalid` row is refused for
 * exactly its stated reason.
 */

import { MeshError, ErrorCode } from "./types/errors.js";
import { canonicalJSON } from "./internal/identity.js";

/** The domain tag inside a SKU digest's hashed bytes (§19.1). Never appears in
 *  the SKU itself. */
export const SKU_DIGEST_PREFIX = "agentmesh-sku-v1";

export type SkuPeriod = "day" | "month";

export interface SkuIncluded {
  quantity: number;
  period: SkuPeriod;
}

export interface SkuTier {
  /** Absent on the LAST tier only: the unbounded tail. */
  up_to?: number;
  amount_micro: number;
}

/** One of five closed shapes (§19.1). Fields not named by a shape are
 *  forbidden on it — a price that says more than its model does is malformed,
 *  not generous. */
export interface SkuPrice {
  model: "free" | "flat" | "per_unit" | "package" | "tiered";
  currency?: string;
  amount_micro?: number;
  meter?: string;
  per?: number;
  size?: number;
  period?: SkuPeriod;
  tiers?: SkuTier[];
  included?: SkuIncluded;
}

export type SkuCovers =
  | { agent: true }
  | { offerings: string[] }
  /** @deprecated Pre-rename wire shape (§8.5); read-tolerated, never emitted. */
  | { skills: string[] };

export interface SkuProvider {
  /** `"internal"` (the deployment's own clearing) or an external commerce
   *  provider's name (§19.4). */
  id: string;
  terms_url?: string;
  checkout_url?: string;
  account_ref?: string;
}

export interface Sku {
  sku: string;
  covers: SkuCovers;
  price: SkuPrice;
  provider: SkuProvider;
}

/** The storefront's advertisement of a SKU (§8.7): id, price, and the digest
 *  an agreement would bind to — price as pre-admission data. */
export interface PublicSku {
  sku: string;
  price: SkuPrice;
  digest: string;
}

const SKU_ID_RE = /^[a-z0-9-]{1,64}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function bad(message: string): never {
  throw new MeshError(ErrorCode.INVALID_MANIFEST, `SKU: ${message} (§19.1)`);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** The fields each model names. Anything else present on the price refuses. */
const MODEL_FIELDS: Record<string, ReadonlySet<string>> = {
  free: new Set(["model"]),
  flat: new Set(["model", "currency", "amount_micro"]),
  per_unit: new Set(["model", "currency", "meter", "per", "amount_micro", "included"]),
  package: new Set(["model", "currency", "meter", "size", "amount_micro", "period", "included"]),
  tiered: new Set(["model", "currency", "meter", "per", "period", "tiers", "included"]),
};

function validatePeriod(v: unknown, where: string): void {
  if (v !== "day" && v !== "month") bad(`${where} period must be "day" or "month" (UTC calendar)`);
}

function validateIncluded(v: unknown): void {
  if (typeof v !== "object" || v === null) bad("included must be an object");
  const inc = v as Record<string, unknown>;
  if (!isNonNegInt(inc.quantity)) bad("included.quantity must be a non-negative integer");
  validatePeriod(inc.period, "included:"); // an allowance without a period never resets
}

/** Validate one price. Throws INVALID_MANIFEST naming the §19.1 rule. */
export function validateSkuPrice(v: unknown): asserts v is SkuPrice {
  if (typeof v !== "object" || v === null) bad("price must be an object");
  const p = v as Record<string, unknown>;
  const model = p.model;
  if (typeof model !== "string" || !(model in MODEL_FIELDS)) {
    bad("price.model is a closed five: free, flat, per_unit, package, tiered");
  }
  const allowed = MODEL_FIELDS[model];
  for (const k of Object.keys(p)) {
    if (!allowed.has(k)) {
      bad(
        model === "free"
          ? "free names no money fields"
          : model === "flat" && k === "meter"
            ? "flat rates the requests observed meter by definition; naming another is a shape error"
            : `'${k}' is not a field of the ${model} shape`,
      );
    }
  }
  if (model === "free") return;

  if (typeof p.currency !== "string" || !CURRENCY_RE.test(p.currency)) {
    bad("currency must be an ISO 4217 code (a private-use X-code is legal)");
  }
  if (model !== "tiered" && !isNonNegInt(p.amount_micro)) {
    bad("amount_micro must be a non-negative integer — no floats near money (§19.3)");
  }
  if (model === "flat") return;

  if (typeof p.meter !== "string" || p.meter === "") {
    bad(`${model} requires the meter it rates`);
  }
  if (p.per !== undefined && !isPosInt(p.per)) bad("per must be a positive integer");
  if (p.included !== undefined) validateIncluded(p.included);

  if (model === "package") {
    if (!isPosInt(p.size)) bad("package requires a positive integer size");
    // Without a period, "partial package" has no meaning.
    validatePeriod(p.period, "package");
  }
  if (model === "tiered") {
    validatePeriod(p.period, "tiered"); // tiers aggregate over a period
    const tiers = p.tiers;
    if (!Array.isArray(tiers) || tiers.length === 0) bad("tiered requires a non-empty tiers array");
    let prev = 0;
    tiers.forEach((t, i) => {
      const tier = t as Record<string, unknown>;
      if (!isNonNegInt(tier.amount_micro)) bad(`tiers[${i}].amount_micro must be a non-negative integer`);
      const last = i === tiers.length - 1;
      if (last) {
        if (tier.up_to !== undefined) {
          bad("the last tier must be unbounded — a price with a quantity ceiling is not a price, it is a refusal waiting to be discovered");
        }
      } else {
        if (!isPosInt(tier.up_to)) bad(`tiers[${i}].up_to must be a positive integer`);
        if ((tier.up_to as number) <= prev) bad("tiers up_to must strictly increase");
        prev = tier.up_to as number;
      }
    });
  }
}

/** Validate one SKU. Throws INVALID_MANIFEST naming the rule. */
export function validateSku(v: unknown): asserts v is Sku {
  if (typeof v !== "object" || v === null) bad("a SKU must be an object");
  const s = v as Record<string, unknown>;
  if (typeof s.sku !== "string" || !SKU_ID_RE.test(s.sku)) {
    bad("sku must match [a-z0-9-]{1,64}");
  }
  const covers = s.covers as Record<string, unknown> | null;
  if (typeof covers !== "object" || covers === null) bad("covers is required");
  const hasAgent = covers.agent === true;
  // Deprecation window (§8.5): SKUs written before the rename say
  // `covers.skills`. Accepted as the same list — and deliberately NOT
  // rewritten in the document, because the digest (§19.1) is over the SKU's
  // own bytes and rewriting would strand every agreement already signed.
  const coveredList = covers.offerings ?? covers.skills;
  const hasOfferings = Array.isArray(coveredList);
  if (hasAgent === hasOfferings) bad("covers is agent XOR offerings");
  if (hasOfferings) {
    const offerings = coveredList as unknown[];
    if (offerings.length === 0) bad("an empty offerings list covers nothing");
    if (!offerings.every((x) => typeof x === "string" && x !== "")) bad("covers.offerings must be offering ids");
  }
  validateSkuPrice(s.price);
  const provider = s.provider as Record<string, unknown> | null;
  if (typeof provider !== "object" || provider === null || typeof provider.id !== "string" || provider.id === "") {
    bad("every SKU names who bills for it (§19.4)");
  }
}

/** Validate a manifest's `skus` array: each SKU, plus unique ids. */
export function validateSkus(v: unknown): asserts v is Sku[] {
  if (!Array.isArray(v)) bad("skus must be an array");
  const seen = new Set<string>();
  for (const s of v) {
    validateSku(s);
    if (seen.has(s.sku)) bad(`duplicate sku id '${s.sku}' — ids are unique within the manifest`);
    seen.add(s.sku);
  }
}

/**
 * The SKU digest (§19.1): base64url (unpadded) SHA-256 over the tagged bytes —
 * `agentmesh-sku-v1` + LF + the canonical JSON (§5.3) of the SKU object. The
 * digest is what an agreement binds to, so no consumer can be rated against
 * terms they never accepted. Async because the SDK runs in browsers too, where
 * SHA-256 is SubtleCrypto's.
 */
export async function skuDigest(sku: Sku): Promise<string> {
  const bytes = new TextEncoder().encode(`${SKU_DIGEST_PREFIX}\n${canonicalJSON(sku)}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let bin = "";
  for (const b of hash) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The storefront advertisement for a SKU (§8.7): id + price + digest. */
export async function publicSkuOf(sku: Sku): Promise<PublicSku> {
  return { sku: sku.sku, price: sku.price, digest: await skuDigest(sku) };
}

/** The SKU covering an offering, under §19.1's most-specific-wins rule: an offering
 *  named explicitly beats an agent-wide SKU. Null means the offering is free. */
export function skuFor(skus: readonly Sku[] | undefined, offeringId: string): Sku | null {
  if (!skus?.length) return null;
  let agentWide: Sku | null = null;
  for (const s of skus) {
    const covered =
      "offerings" in s.covers ? s.covers.offerings : "skills" in s.covers ? s.covers.skills : null;
    if (covered?.includes(offeringId)) return s;
    if ("agent" in s.covers && agentWide === null) agentWide = s;
  }
  return agentWide;
}
