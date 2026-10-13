// A throwaway nats-server with JetStream, for the tests that need a real one.
//
// Uses NATS_SERVER_BIN when it is set, else the checked-in Windows binary
// (nats-bin/, which is not in git). When neither is there the caller skips
// cleanly, the same rule the other live-server tests follow.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type NatsConnection } from "nats";

const SERVICES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WINDOWS_BIN = resolve(SERVICES_DIR, "../nats-bin/nats-server-v2.10.24-windows-amd64/nats-server.exe");

export interface TestServer {
  url: string;
  nc: NatsConnection;
  stop(): Promise<void>;
}

export function natsServerBinary(): string | null {
  const fromEnv = process.env.NATS_SERVER_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return existsSync(WINDOWS_BIN) ? WINDOWS_BIN : null;
}

/** Start a server on a scratch port with a fresh store, or null when there is
 *  no binary. */
export async function startNatsServer(label: string): Promise<TestServer | null> {
  const bin = natsServerBinary();
  if (!bin) {
    console.warn(`[${label}] no nats-server binary (set NATS_SERVER_BIN), skipping`);
    return null;
  }
  const port = 43000 + Math.floor(Math.random() * 1000);
  const url = `nats://127.0.0.1:${port}`;
  const storeDir = mkdtempSync(join(tmpdir(), `${label}-`));
  const server: ChildProcess = spawn(bin, ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", storeDir]);
  let nc: NatsConnection | null = null;
  const deadline = Date.now() + 15_000;
  while (!nc) {
    try {
      nc = await connect({ servers: url, timeout: 500, maxReconnectAttempts: 0 });
    } catch {
      if (Date.now() > deadline) {
        server.kill();
        throw new Error(`[${label}] nats-server did not accept connections on ${url}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    url,
    nc,
    async stop() {
      await nc?.close().catch(() => {});
      server.kill();
      // Windows holds the store's files for a moment after the process ends.
      await new Promise((r) => setTimeout(r, 500));
      rmSync(storeDir, { recursive: true, force: true });
    },
  };
}
