/**
 * Token buckets. Pure time math, no I/O, so the inbound guest tier
 * (BRIDGE-A2A.md §9) and the outbound forward path (§10.2) share one
 * implementation and one set of tests.
 *
 * A bucket starts full and refills linearly. `perMinute <= 0` therefore refuses
 * everything rather than allowing everything: a limit that was meant to be set
 * and was left at zero should close, not open.
 */

export class TokenBucket {
  private tokens: number;
  private refilledAt: number;
  /** Last time `take` was called — the eviction key for BucketPool. */
  lastUsed: number;

  constructor(
    readonly perWindow: number,
    now: number = Date.now(),
    /** Refill window. Default one minute — the historical unit; an hourly
     *  bucket (a signed volume clause) passes 3_600_000. */
    readonly windowMs: number = 60_000,
  ) {
    this.tokens = Math.max(0, perWindow);
    this.refilledAt = now;
    this.lastUsed = now;
  }

  /** The historical name; per-minute buckets still read naturally. */
  get perMinute(): number {
    return this.perWindow;
  }

  /** Consume one token. False means the caller is over budget. */
  take(now: number = Date.now()): boolean {
    this.lastUsed = now;
    const elapsed = Math.max(0, now - this.refilledAt);
    this.tokens = Math.min(this.perWindow, this.tokens + (elapsed / this.windowMs) * this.perWindow);
    this.refilledAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Whole seconds until one token is back, at least 1: what a refusal puts
   *  in `Retry-After`. Reads the bucket as it stood at its last `take`. */
  secondsUntilToken(now: number = Date.now()): number {
    if (this.perWindow <= 0) return Math.ceil(this.windowMs / 1000);
    const elapsed = Math.max(0, now - this.refilledAt);
    const tokens = Math.min(this.perWindow, this.tokens + (elapsed / this.windowMs) * this.perWindow);
    if (tokens >= 1) return 1;
    const msPerToken = this.windowMs / this.perWindow;
    return Math.max(1, Math.ceil(((1 - tokens) * msPerToken) / 1000));
  }
}

/**
 * A bounded map of per-key buckets. Bounded because the key is caller-chosen
 * (a client address, a mesh agent id): without a cap, a caller that varies the
 * key is a memory leak. When the cap is hit the least recently used bucket is
 * dropped, which is the entry whose budget has had the longest to refill —
 * dropping it is closest to a no-op.
 */
export class BucketPool {
  private buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly perWindow: number,
    private readonly max: number,
    private readonly windowMs: number = 60_000,
  ) {}

  take(key: string, now: number = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.max) this.evictOldest();
      bucket = new TokenBucket(this.perWindow, now, this.windowMs);
      this.buckets.set(key, bucket);
    }
    return bucket.take(now);
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }

  /** Seconds until `key` may take again; 1 for a key with no bucket. */
  retryAfterSeconds(key: string, now: number = Date.now()): number {
    return this.buckets.get(key)?.secondsUntilToken(now) ?? 1;
  }

  get size(): number {
    return this.buckets.size;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastUsed < oldestAt) {
        oldestAt = bucket.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.buckets.delete(oldestKey);
  }
}
