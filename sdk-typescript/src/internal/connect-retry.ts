/**
 * The first connection, tried again while the broker is busy.
 *
 * A broker that is restarting or busy (during a deploy, say) answers a new
 * connection with a timeout or a refusal for a few seconds. Without a retry the
 * first connect throws and a long-running process exits; its supervisor starts
 * it again, and the restart is the only thing anyone sees. `ConnectOptions.
 * connectRetry` asks the SDK to try again instead, a bounded number of times,
 * waiting longer each time, and to say so on each attempt.
 *
 * Only a broker that could not be reached is tried again. A broker that
 * answered and refused the credential (an authorization or authentication
 * error) is not busy, and trying again would only delay the error.
 *
 * Once connected, the transport's own reconnect handles every later drop, as
 * before; this covers the first connection only.
 */

/** How the first connection is tried again. */
export interface ConnectRetry {
  /** How many times to try in all, the first included. Default 8. */
  attempts?: number;
  /** The wait after the first failed try, in milliseconds. Default 1000. */
  firstDelayMs?: number;
  /** The longest wait between tries, in milliseconds. Default 15000. */
  maxDelayMs?: number;
  /** Told each failed try that will be tried again. Default: nothing is said. */
  onRetry?: (info: { attempt: number; attempts: number; delayMs: number; error: Error }) => void;
  /** For tests: how to wait. Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Whether `err` is the broker refusing the credential, which no retry fixes. */
export function isCredentialRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const text = `${typeof e?.code === "string" ? e.code : ""} ${typeof e?.message === "string" ? e.message : String(err ?? "")}`;
  return /AUTHORIZATION_VIOLATION|AUTHENTICATION_EXPIRED|AUTHENTICATION_REVOKED|authori[sz]ation violation|authentication (expired|revoked)|user authentication|permissions? violation/i.test(text);
}

/** The wait before try number `attempt + 1`: doubling from `first`, at most `max`. */
export function retryDelay(attempt: number, first: number, max: number): number {
  return Math.min(max, first * 2 ** Math.max(0, attempt - 1));
}

/**
 * Run `dial` until it succeeds, it fails with a credential refusal, or the
 * tries run out; then throw the last error. With no `retry`, one try, exactly
 * as before.
 */
export async function dialWithRetry<T>(dial: () => Promise<T>, retry?: ConnectRetry): Promise<T> {
  if (!retry) return dial();
  const attempts = Math.max(1, Math.floor(retry.attempts ?? 8));
  const first = Math.max(0, retry.firstDelayMs ?? 1000);
  const max = Math.max(first, retry.maxDelayMs ?? 15_000);
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await dial();
    } catch (err) {
      if (attempt >= attempts || isCredentialRefusal(err)) throw err;
      const delayMs = retryDelay(attempt, first, max);
      retry.onRetry?.({ attempt, attempts, delayMs, error: err instanceof Error ? err : new Error(String(err)) });
      await sleep(delayMs);
    }
  }
}
