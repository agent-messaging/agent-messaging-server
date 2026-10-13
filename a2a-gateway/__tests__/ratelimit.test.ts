/**
 * The shared token bucket. Used by the inbound guest tier (BRIDGE-A2A.md §9)
 * and, from this change on, by the outbound forward path (§10.2) — which had no
 * limit at all, so any mesh agent could drive unbounded HTTP at a third party's
 * endpoint under the bridge's vouch.
 */
import { describe, it, expect } from "vitest";
import { BucketPool, TokenBucket } from "../src/core/ratelimit.js";

describe("TokenBucket", () => {
  it("starts full and empties", () => {
    const b = new TokenBucket(3, 0);
    expect([b.take(0), b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true, false]);
  });

  it("refills linearly", () => {
    const b = new TokenBucket(60, 0);
    for (let i = 0; i < 60; i++) b.take(0);
    expect(b.take(0)).toBe(false);
    expect(b.take(1_000)).toBe(true); // one second at 60/min = one token
  });

  it("never over-fills", () => {
    const b = new TokenBucket(2, 0);
    b.take(0);
    expect([b.take(3_600_000), b.take(3_600_000), b.take(3_600_000)]).toEqual([true, true, false]);
  });

  it("a zero limit refuses rather than allows", () => {
    expect(new TokenBucket(0, 0).take(60_000)).toBe(false);
  });
});

describe("BucketPool", () => {
  it("keeps callers independent", () => {
    const pool = new BucketPool(1, 10);
    expect(pool.take("a", 0)).toBe(true);
    expect(pool.take("a", 0)).toBe(false);
    expect(pool.take("b", 0)).toBe(true);
  });

  it("is bounded, so a caller varying the key is not a memory leak", () => {
    const pool = new BucketPool(5, 3);
    for (let i = 0; i < 50; i++) pool.take(`caller-${i}`, i);
    expect(pool.size).toBe(3);
  });

  it("forgets a key on request", () => {
    const pool = new BucketPool(1, 10);
    pool.take("a", 0);
    expect(pool.take("a", 0)).toBe(false);
    pool.forget("a");
    expect(pool.take("a", 0)).toBe(true);
  });
});
