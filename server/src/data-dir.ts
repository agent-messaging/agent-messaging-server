/**
 * Where the SQLite stores live.
 *
 * Every store used to default independently to `./data/<name>.db`, which is a
 * path relative to the process's working directory. On the VM that resolves
 * into a directory the service user owns, so nobody noticed the assumption.
 * In the container image the working directory is root-owned image content,
 * so the first store a service constructed at boot (the audit log, new in
 * 0.2.1) died on mkdir and took the whole mesh bundle down with it. A
 * self-hosted operator hit this in the field; the smoke test had only ever
 * started the registry, which constructs no store.
 *
 * One rule now, applied by every store:
 *
 *   1. the store's own env var (AUDIT_DB_PATH, LEDGER_DB_PATH, ...) wins;
 *   2. else MESH_DATA_DIR names the directory for all of them;
 *   3. else the directory of USAGE_DB_PATH, because a deployment that
 *      redirected one database onto a mounted volume meant them all;
 *   4. else `./data`, the historical default, unchanged so the VM moves
 *      nothing.
 */
import { dirname, join } from "node:path";

export function dataDbPath(envVar: string, filename: string): string {
  const explicit = process.env[envVar];
  if (explicit) return explicit;
  const dir =
    process.env.MESH_DATA_DIR ??
    (process.env.USAGE_DB_PATH ? dirname(process.env.USAGE_DB_PATH) : "./data");
  return join(dir, filename);
}
