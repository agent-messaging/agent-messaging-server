/**
 * The first connection, tried again while the broker cannot be reached
 * (internal/connect-retry.ts, ConnectOptions.connectRetry): a busy broker at a
 * process's start no longer ends the process, a refused credential is not
 * tried again, the tries are bounded, and without the option nothing changes.
 */
import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { dialWithRetry, isCredentialRefusal, retryDelay } from "../../src/internal/connect-retry.js";
import { ConnectionManager } from "../../src/internal/connection.js";
import { ErrorCode } from "../../src/types/errors.js";

const timeout = () => Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });

describe("dialWithRetry", () => {
  it("tries again after a broker that timed out, and returns the connection", async () => {
    let calls = 0;
    const waits: number[] = [];
    const said: string[] = [];
    const out = await dialWithRetry(async () => {
      calls++;
      if (calls < 3) throw timeout();
      return "connected";
    }, { attempts: 5, firstDelayMs: 1000, maxDelayMs: 15_000, sleep: async (ms) => { waits.push(ms); }, onRetry: (i) => said.push(`${i.attempt}/${i.attempts} ${i.delayMs} ${i.error.message}`) });
    expect(out).toBe("connected");
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
    expect(said).toEqual(["1/5 1000 TIMEOUT", "2/5 2000 TIMEOUT"]);
  });

  it("gives up after the last try with the broker's own error", async () => {
    let calls = 0;
    const waits: number[] = [];
    await expect(dialWithRetry(async () => { calls++; throw timeout(); }, { attempts: 4, firstDelayMs: 1000, maxDelayMs: 3000, sleep: async (ms) => { waits.push(ms); } }))
      .rejects.toThrow("TIMEOUT");
    expect(calls).toBe(4);
    expect(waits).toEqual([1000, 2000, 3000]); // doubling, held at the most
  });

  it("does not try again when the broker refused the credential", async () => {
    let calls = 0;
    const refusal = Object.assign(new Error("'Authorization Violation'"), { code: "AUTHORIZATION_VIOLATION" });
    await expect(dialWithRetry(async () => { calls++; throw refusal; }, { attempts: 5, sleep: async () => {} })).rejects.toBe(refusal);
    expect(calls).toBe(1);
  });

  it("tries once, as before, without the option", async () => {
    let calls = 0;
    await expect(dialWithRetry(async () => { calls++; throw timeout(); })).rejects.toThrow("TIMEOUT");
    expect(calls).toBe(1);
  });

  it("tells a refused credential from a broker it could not reach", () => {
    expect(isCredentialRefusal({ code: "AUTHORIZATION_VIOLATION", message: "x" })).toBe(true);
    expect(isCredentialRefusal(new Error("Authentication Expired"))).toBe(true);
    expect(isCredentialRefusal(new Error("user authentication revoked"))).toBe(true);
    expect(isCredentialRefusal(timeout())).toBe(false);
    expect(isCredentialRefusal(Object.assign(new Error("connection refused"), { code: "CONNECTION_REFUSED" }))).toBe(false);
    expect(retryDelay(1, 1000, 15_000)).toBe(1000);
    expect(retryDelay(5, 1000, 15_000)).toBe(15_000);
  });
});

describe("ConnectionManager.connect with connectRetry", () => {
  it("tries a broker it cannot reach the number of times asked, then says it failed", async () => {
    // A port nothing listens on: taken, then let go.
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
    });
    const tries: number[] = [];
    const err = await ConnectionManager.connect({
      servers: `ws://127.0.0.1:${port}`,
      reconnect: false,
      connectRetry: { attempts: 3, firstDelayMs: 1, sleep: async () => {}, onRetry: (i) => tries.push(i.attempt) },
    }).catch((e) => e);
    expect(tries).toEqual([1, 2]);
    expect(err?.code).toBe(ErrorCode.TRANSPORT_TIMEOUT);
    expect(String(err?.message)).toMatch(/^Failed to connect to NATS: /);
  });
});
