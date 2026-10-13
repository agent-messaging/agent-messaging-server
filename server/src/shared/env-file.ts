/**
 * The deployment's settings file, when it has one: `env/<name>.json`, read the
 * way AgentMesh's environment loader (env/load.cjs) reads it, so AgentMesh's
 * own core processes see the same values and the same errors as before.
 *
 * The core's own copy (step 10a of docs/agent-messaging-server-plan.md): the
 * loader beside the environment files is the platform's, and the server keeps
 * this much of it. A server with no such file runs on its defaults
 * (shared/settings.ts).
 *
 * WHICH FILE. AGENTMESH_ENV names the environment (default "prod");
 * AGENTMESH_ENV_FILE names a file directly and wins; AGENTMESH_ENV_DIR adds a
 * folder to look in first. Then `env/` at the top of the source tree, then
 * /opt/agentmesh/env and /opt/fleet/env. A file that is there and broken (not
 * JSON, or naming another environment) throws. A null is not a value.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** `env/` at the top of the source tree: server/src/shared → ../../../env. */
const TREE_ENV_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "env");

export function envName(env: NodeJS.ProcessEnv = process.env): string {
  const n = String(env.AGENTMESH_ENV || "prod").trim();
  if (!NAME_RE.test(n)) throw new Error(`AGENTMESH_ENV="${n}" is not an environment name`);
  return n;
}

function candidates(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.AGENTMESH_ENV_FILE) return [env.AGENTMESH_ENV_FILE];
  const list = [join(TREE_ENV_DIR, `${name}.json`)];
  if (env.AGENTMESH_ENV_DIR) list.unshift(join(env.AGENTMESH_ENV_DIR, `${name}.json`));
  list.push(`/opt/agentmesh/env/${name}.json`, `/opt/fleet/env/${name}.json`);
  return [...new Set(list)];
}

const cache = new Map<string, Record<string, unknown> | null>();

/** The environment's file, or null when there is none in any place looked. */
export function findEnvFile(name: string = envName()): Record<string, unknown> | null {
  const key = `${name}|${process.env.AGENTMESH_ENV_FILE || ""}|${process.env.AGENTMESH_ENV_DIR || ""}`;
  if (cache.has(key)) return cache.get(key)!;
  for (const file of candidates(name)) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    let doc: Record<string, unknown>;
    try { doc = JSON.parse(text) as Record<string, unknown>; } catch (e) { throw new Error(`${file} is not valid JSON: ${(e as Error).message}`); }
    if (!process.env.AGENTMESH_ENV_FILE && doc.name !== name) {
      throw new Error(`${file} says it is environment "${String(doc.name)}", not "${name}"`);
    }
    cache.set(key, doc);
    return doc;
  }
  cache.set(key, null);
  return null;
}

function lookup(doc: unknown, dotted: string): unknown {
  let v = doc;
  for (const part of dotted.split(".")) {
    if (v === null || typeof v !== "object" || !(part in (v as Record<string, unknown>))) return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

/** The value at a dotted path. Throws when there is no file, or the path is missing or null in it. */
export function envFileGet<T = unknown>(dotted: string, name: string = envName()): T {
  const doc = findEnvFile(name);
  if (!doc) throw new Error(`environment "${name}" not found; looked in ${candidates(name).join(", ")}`);
  const v = lookup(doc, dotted);
  if (v === undefined) throw new Error(`env/${String(doc.name)}.json has no ${dotted}`);
  if (v === null) throw new Error(`${dotted} is not set for environment "${String(doc.name)}" (null in env/${String(doc.name)}.json)`);
  return v as T;
}
