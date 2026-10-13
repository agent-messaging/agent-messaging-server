/**
 * Sliding-window rate limiter keyed by string (sender ID, IP, etc.).
 *
 * Each key tracks a request count within a rolling window. When the
 * count exceeds `maxRequests`, `check()` returns a rejection with
 * `retryAfterMs` indicating when the window resets.
 *
 * The key space is attacker-chosen everywhere this is used (a client IP, a
 * freely-minted sender nkey), so it is also CAPPED: an unbounded Map keyed by
 * whatever the caller supplies is a memory-exhaustion primitive dressed up as
 * a defence. Past the cap the oldest windows are evicted rather than new keys
 * refused — refusing would let one attacker fill the table and lock everybody
 * else out, which is the denial of service the limiter exists to prevent.
 */

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface WindowEntry {
  count: number;
  windowStart: number;
}

/** Default ceiling on tracked keys. Generous for real traffic (a busy front
 *  sees thousands of distinct IPs an hour), trivial in memory (~50 bytes an
 *  entry), and bounded. */
const DEFAULT_MAX_KEYS = 50_000;

export class RateLimiter {
  private windows = new Map<string, WindowEntry>();
  private lastSweep = Date.now();

  constructor(
    private maxRequests: number,
    private windowMs: number,
    private maxKeys: number = DEFAULT_MAX_KEYS,
  ) {}

  /** Check whether `key` is allowed. Increments the counter if allowed. */
  /**
   * Whether the next `check()` would be allowed, spending nothing.
   *
   * For a door that should only charge for FAILURES. The operator login used
   * `check()` as its gate, which spends a slot on every attempt including the
   * correct ones, so five successful sign-ins from one address locked the
   * operator out of their own console for fifteen minutes. That is what
   * happened on 2026-09-19, doing five withholds in five tabs. Guessing is
   * made of failures, so charging only for those still bounds an attacker at
   * `maxRequests` wrong passwords per window, and knowing the password costs
   * nothing.
   *
   * Reads only: no sweep, no window reset, no count.
   */
  peek(key: string): RateLimitResult {
    const entry = this.windows.get(key);
    if (!entry) return { allowed: true, retryAfterMs: 0 };
    const now = Date.now();
    if (now - entry.windowStart >= this.windowMs) return { allowed: true, retryAfterMs: 0 };
    if (entry.count >= this.maxRequests) {
      return { allowed: false, retryAfterMs: Math.max(this.windowMs - (now - entry.windowStart), 0) };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  check(key: string): RateLimitResult {
    const now = Date.now();

    // Lazy sweep: evict expired entries every windowMs
    if (now - this.lastSweep > this.windowMs) {
      this.sweep(now);
    }

    let entry = this.windows.get(key);

    // New key or expired window — reset
    if (!entry || now - entry.windowStart >= this.windowMs) {
      if (!entry) this.makeRoom(now);
      entry = { count: 1, windowStart: now };
      this.windows.set(key, entry);
      return { allowed: true, retryAfterMs: 0 };
    }

    // Within window — check limit
    if (entry.count >= this.maxRequests) {
      const retryAfterMs = this.windowMs - (now - entry.windowStart);
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
    }

    entry.count++;
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Make room for one new key: sweep first (most entries are usually stale),
   *  then evict oldest-inserted entries if the table is still full. Map keeps
   *  insertion order, so the head is the least recently created window. */
  private makeRoom(now: number): void {
    if (this.windows.size < this.maxKeys) return;
    this.sweep(now);
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) return;
      this.windows.delete(oldest.value);
    }
  }

  /** Remove entries whose window has expired. */
  private sweep(now: number): void {
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart >= this.windowMs) {
        this.windows.delete(key);
      }
    }
    this.lastSweep = now;
  }

  /** Current number of tracked keys (for testing/monitoring). */
  get size(): number {
    return this.windows.size;
  }
}
