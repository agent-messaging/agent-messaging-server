import { connect, credsAuthenticator, type Authenticator, type NatsConnection, type JetStreamClient } from "nats";
import { readFile } from "node:fs/promises";

export interface ServiceNatsClient {
  nc: NatsConnection;
  js: JetStreamClient;
}

/**
 * How the first connection is tried again. A broker that is restarting or busy
 * (on every deploy, 2026-10-12) answered a service's first connect with a
 * timeout, the service exited with "Fatal error: NatsError: TIMEOUT", and pm2
 * started it again. Now the first connect is tried again, a bounded number of
 * times with a growing wait, each try said in the log; after the last one the
 * error is fatal as before. Later drops are the client's own reconnect
 * (`maxReconnectAttempts: -1` below), unchanged.
 */
export interface FirstConnectRetry {
  /** Tries in all, the first included. Default 8: about a minute and a half of waiting. */
  attempts?: number;
  /** The wait after the first failed try. Default 1000 ms; it doubles each time. */
  firstDelayMs?: number;
  /** The longest wait. Default 15000 ms. */
  maxDelayMs?: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Whether the broker answered and refused the credential: not busy, so a
 *  retry would only delay the error. */
export function isCredentialRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const text = `${typeof e?.code === "string" ? e.code : ""} ${typeof e?.message === "string" ? e.message : String(err ?? "")}`;
  return /AUTHORIZATION_VIOLATION|AUTHENTICATION_EXPIRED|AUTHENTICATION_REVOKED|authori[sz]ation violation|authentication (expired|revoked)|user authentication|permissions? violation/i.test(text);
}

/** A broker address without any user and password in it, for a log line. */
export function addressForLog(servers: string): string {
  return servers.split(",").map((s) => s.trim().replace(/\/\/[^@/]*@/, "//")).join(",");
}

/** Run `dial` until it connects, the credential is refused, or the tries run out. */
export async function connectWithRetry<T>(dial: () => Promise<T>, what: string, opts: FirstConnectRetry = {}): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 8));
  const first = Math.max(0, opts.firstDelayMs ?? 1000);
  const max = Math.max(first, opts.maxDelayMs ?? 15_000);
  const log = opts.log ?? ((l: string) => console.log(l));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const out = await dial();
      if (attempt > 1) log(`[nats] connected to ${what} on try ${attempt} of ${attempts}`);
      return out;
    } catch (err) {
      const reason = (err as { code?: string; message?: string })?.code ?? (err as Error)?.message ?? String(err);
      if (isCredentialRefusal(err)) throw err;
      if (attempt >= attempts) {
        const secs = Math.round((Date.now() - started) / 1000);
        throw new Error(`could not connect to the broker at ${what} after ${attempts} tries over ${secs} seconds (last: ${reason})`, { cause: err });
      }
      const wait = Math.min(max, first * 2 ** (attempt - 1));
      log(`[nats] could not connect to ${what} (try ${attempt} of ${attempts}: ${reason}); trying again in ${Math.round(wait / 100) / 10} s`);
      await sleep(wait);
    }
  }
}

export async function createNatsClient(
  servers: string = "localhost:4222",
  credsFile?: string,
  retry?: FirstConnectRetry,
): Promise<ServiceNatsClient> {
  let authenticator: Authenticator | undefined;
  if (credsFile) {
    const credsContent = await readFile(credsFile);
    authenticator = credsAuthenticator(credsContent);
  }

  const nc = await connectWithRetry(() => connect({
    servers,
    name: "agentmesh-services",
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
    authenticator,
  }), addressForLog(servers), retry);

  console.log(`[nats] connected to ${addressForLog(servers)}${credsFile ? " (authenticated)" : ""}`);

  const js = nc.jetstream();

  return { nc, js };
}
