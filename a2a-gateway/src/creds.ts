/**
 * Load a NATS .creds file (JWT + NKey seed). The bridge connects with a
 * dedicated node credential in production — it must NOT consume guest-pool
 * credentials, which are sandbox-attested and reaped.
 */
import { readFileSync } from "node:fs";

export interface Creds {
  jwt: string;
  seed: string;
}

export function loadCreds(path: string): Creds {
  const content = readFileSync(path, "utf-8");
  const jwt = content.match(
    /-----BEGIN NATS USER JWT-----\r?\n([\s\S]*?)\r?\n------END NATS USER JWT------/,
  )?.[1];
  const seed = content.match(
    /-----BEGIN USER NKEY SEED-----\r?\n([\s\S]*?)\r?\n------END USER NKEY SEED------/,
  )?.[1];
  if (!jwt || !seed) throw new Error(`Malformed creds file: ${path}`);
  return { jwt: jwt.trim(), seed: seed.trim() };
}
