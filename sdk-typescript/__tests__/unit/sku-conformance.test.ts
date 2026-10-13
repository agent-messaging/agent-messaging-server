// SKUs and prices (§19.1), asserted against conformance/commerce.json.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src/sku.ts to agree with the fixture — never the fixture to
// agree with the code (the fixture changes only with a spec change alongside).
// Cases are executed by ITERATING the fixture: a row added to the JSON runs
// here without this file changing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  publicSkuOf,
  skuDigest,
  skuFor,
  validateSku,
  validateSkuPrice,
  validateSkus,
  type Sku,
} from "../../src/sku.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../conformance/commerce.json"), "utf8"),
) as {
  sku: {
    valid: unknown[];
    invalid: Array<{ case: string; sku: unknown; why: string }>;
  };
  price: {
    valid: unknown[];
    invalid: Array<{ case: string; price: unknown; why: string }>;
  };
  digest: {
    digest_bytes_prefix: string;
    sku: Sku;
    canonical: string;
    sku_digest: string;
    one_micro_unit_moved: { sku_digest: string };
  };
};

describe("§19.1 SKU shapes", () => {
  it("every valid fixture SKU validates", () => {
    expect(fixture.sku.valid.length).toBeGreaterThan(0);
    for (const s of fixture.sku.valid) {
      expect(() => validateSku(s), JSON.stringify(s)).not.toThrow();
    }
    // And together as a manifest's skus array (unique ids).
    expect(() => validateSkus(fixture.sku.valid)).not.toThrow();
  });

  it("every invalid fixture SKU is refused", () => {
    expect(fixture.sku.invalid.length).toBeGreaterThan(0);
    for (const row of fixture.sku.invalid) {
      expect(() => validateSku(row.sku), `${row.case}: ${row.why}`).toThrow();
    }
  });

  it("duplicate sku ids are refused across the array", () => {
    const one = fixture.sku.valid[0] as Sku;
    expect(() => validateSkus([one, one])).toThrow(/duplicate/);
  });
});

describe("§19.1 price shapes", () => {
  it("every valid fixture price validates", () => {
    expect(fixture.price.valid.length).toBeGreaterThan(0);
    for (const p of fixture.price.valid) {
      expect(() => validateSkuPrice(p), JSON.stringify(p)).not.toThrow();
    }
  });

  it("every invalid fixture price is refused", () => {
    expect(fixture.price.invalid.length).toBeGreaterThan(0);
    for (const row of fixture.price.invalid) {
      expect(() => validateSkuPrice(row.price), `${row.case}: ${row.why}`).toThrow();
    }
  });
});

describe("§19.1 the digest pins the terms", () => {
  it("reproduces the fixture's digest from the tagged canonical bytes", async () => {
    expect(fixture.digest.digest_bytes_prefix).toBe("agentmesh-sku-v1\n");
    expect(await skuDigest(fixture.digest.sku)).toBe(fixture.digest.sku_digest);
  });

  it("one moved micro-unit moves the digest — no re-pricing under standing agreements", async () => {
    const bumped = JSON.parse(JSON.stringify(fixture.digest.sku)) as Sku;
    (bumped.price as { amount_micro: number }).amount_micro += 1;
    expect(await skuDigest(bumped)).toBe(fixture.digest.one_micro_unit_moved.sku_digest);
  });

  it("the storefront advertisement carries id, price, and that digest", async () => {
    const pub = await publicSkuOf(fixture.digest.sku);
    expect(pub.sku).toBe(fixture.digest.sku.sku);
    expect(pub.price).toEqual(fixture.digest.sku.price);
    expect(pub.digest).toBe(fixture.digest.sku_digest);
  });
});

describe("§19.1 covers: most specific wins, absence is free", () => {
  const named = fixture.digest.sku; // covers caselaw-summary + caselaw-cite-check
  const agentWide: Sku = {
    sku: "everything-flat",
    covers: { agent: true },
    price: { model: "flat", currency: "USD", amount_micro: 20000 },
    provider: { id: "internal" },
  };

  it("an offering named explicitly is covered by that SKU, not the agent-wide one", () => {
    expect(skuFor([agentWide, named], "caselaw-summary")?.sku).toBe(named.sku);
  });

  it("an unnamed offering falls to the agent-wide SKU", () => {
    expect(skuFor([agentWide, named], "something-else")?.sku).toBe(agentWide.sku);
  });

  it("with no covering SKU the offering is free", () => {
    expect(skuFor([named], "something-else")).toBeNull();
    expect(skuFor(undefined, "anything")).toBeNull();
    expect(skuFor([], "anything")).toBeNull();
  });
});
