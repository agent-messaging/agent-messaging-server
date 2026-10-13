import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter } from "../../src/shared/rate-limiter.js";
import { wrapHandler, type HandlerFn } from "../../src/shared/handler.js";
import { createEnvelope, encode, decode, ErrorCode, nkeys, signEnvelope } from "../../src/sdk.js";
import { newTraceContext } from "../../src/sdk.js";

// ─── RateLimiter Unit Tests ─────────────────────────────────────

describe("RateLimiter", () => {
  it("allows requests within limit", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("rejects requests exceeding limit", () => {
    const limiter = new RateLimiter(2, 60_000);
    limiter.check("a");
    limiter.check("a");
    const result = limiter.check("a");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks keys independently", () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(false);
  });

  it("resets after window expires", () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(1, 100);
      expect(limiter.check("a").allowed).toBe(true);
      expect(limiter.check("a").allowed).toBe(false);

      vi.advanceTimersByTime(101);

      expect(limiter.check("a").allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps expired entries", () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(10, 100);
      limiter.check("a");
      limiter.check("b");
      expect(limiter.size).toBe(2);

      vi.advanceTimersByTime(101);

      // Sweep happens on next check
      limiter.check("c");
      expect(limiter.size).toBe(1); // only "c" remains
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns retryAfterMs close to remaining window time", () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(1, 1000);
      limiter.check("a"); // uses up the quota

      vi.advanceTimersByTime(300);

      const result = limiter.check("a");
      expect(result.allowed).toBe(false);
      // Window started 300ms ago, 1000ms total → ~700ms remaining
      expect(result.retryAfterMs).toBeLessThanOrEqual(700);
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(699);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Handler Rate Limiting Integration ──────────────────────────

describe("wrapHandler rate limiting", () => {
  // 0.2: incoming envelopes must be signed (decode verifies), and the service
  // signs its replies, so we use a service keypair + per-sender keypairs.
  const svcKp = nkeys.createUser();
  const svcId = svcKp.getPublicKey();
  const senderKps = new Map<string, ReturnType<typeof nkeys.createUser>>();
  const kpFor = (name: string) => {
    let kp = senderKps.get(name);
    if (!kp) { kp = nkeys.createUser(); senderKps.set(name, kp); }
    return kp;
  };

  function signedRequest(fromName: string) {
    const kp = kpFor(fromName);
    const env = createEnvelope({ type: "request", from: kp.getPublicKey(), trace: newTraceContext(), payload: {} });
    signEnvelope(env, kp);
    return env;
  }

  function createMockMsg(env: object, hasReply = true) {
    const responses: Uint8Array[] = [];
    return {
      data: encode(env as any),
      reply: hasReply ? "_INBOX.test" : undefined,
      respond: vi.fn((data: Uint8Array) => { responses.push(data); }),
      responses,
    };
  }

  const okHandler = (): HandlerFn =>
    vi.fn(async (env) => createEnvelope({ type: "respond", from: svcId, to: env.from, payload: { ok: true } }));

  it("allows requests within limit", async () => {
    const limiter = new RateLimiter(5, 60_000);
    const handler = okHandler();
    const wrapped = wrapHandler(svcKp, handler, limiter);
    const msg = createMockMsg(signedRequest("agent-1"));
    await wrapped(msg as any);
    expect(handler).toHaveBeenCalledOnce();
    expect(decode(msg.responses[0]).error).toBeUndefined();
  });

  it("returns RATE_LIMITED when sender exceeds limit", async () => {
    const limiter = new RateLimiter(2, 60_000);
    const handler = okHandler();
    const wrapped = wrapHandler(svcKp, handler, limiter);
    const makeMsg = () => createMockMsg(signedRequest("agent-1"));

    await wrapped(makeMsg() as any);
    await wrapped(makeMsg() as any);
    expect(handler).toHaveBeenCalledTimes(2);

    const msg3 = makeMsg();
    await wrapped(msg3 as any);
    expect(handler).toHaveBeenCalledTimes(2); // handler NOT called

    const resp = decode(msg3.responses[0]);
    expect(resp.error!.code).toBe(ErrorCode.RATE_LIMITED);
    expect(resp.error!.retryable).toBe(true);
    expect((resp.error as any).retry_after_ms).toBeGreaterThan(0);
  });

  it("rate limits per sender independently", async () => {
    const limiter = new RateLimiter(1, 60_000);
    const handler = okHandler();
    const wrapped = wrapHandler(svcKp, handler, limiter);
    const makeMsg = (from: string) => createMockMsg(signedRequest(from));

    await wrapped(makeMsg("agent-1") as any);
    expect(handler).toHaveBeenCalledTimes(1);

    await wrapped(makeMsg("agent-2") as any);
    expect(handler).toHaveBeenCalledTimes(2);

    const msg3 = makeMsg("agent-1");
    await wrapped(msg3 as any);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(decode(msg3.responses[0]).error!.code).toBe(ErrorCode.RATE_LIMITED);
  });
});

// A door that should only charge for failures needs to ask the limiter a
// question without paying for the answer. Before `peek` existed the operator
// login used `check` as its gate, so five CORRECT sign-ins spent the whole
// budget and locked the operator out of their own console for fifteen minutes.
describe("peek: reading the limit without spending it", () => {
  it("never consumes, however many times it is asked", () => {
    const limiter = new RateLimiter(2, 60_000);
    for (let i = 0; i < 50; i++) expect(limiter.peek("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.peek("ip").allowed).toBe(false);
  });

  it("agrees with check about when the window is spent, and says how long is left", () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.peek("ip").allowed).toBe(true);
    limiter.check("ip");
    const peeked = limiter.peek("ip");
    expect(peeked.allowed).toBe(false);
    expect(peeked.retryAfterMs).toBeGreaterThan(0);
    expect(peeked.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(limiter.check("ip").allowed).toBe(false);
  });

  it("says yes for a key it has never seen, without creating a window for it", () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.peek("stranger").allowed).toBe(true);
    expect(limiter.size).toBe(0);
  });
});
