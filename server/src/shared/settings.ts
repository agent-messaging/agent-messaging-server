/**
 * The core's settings: the few values the core server reads from the
 * environment file, with defaults for a deployment that has none.
 *
 * The platform reads env/<AGENTMESH_ENV>.json through platform-shared/am-env.ts,
 * which loads the file at import and stops the process when it is missing.
 * That is right for AgentMesh, where a missing file means a broken deploy. The
 * core server (the Agent Messaging Server, docs/agent-messaging-server-plan.md)
 * must also start where nobody wrote such a file, so core code reads through
 * here instead:
 *
 *   - when the file is there, a value is read exactly as am-env reads it, and
 *     a missing or null value throws exactly as it does there, so AgentMesh's
 *     own deployments get the same values and the same errors as before;
 *   - when no file is found, the value is the default below, and a value with
 *     no default is undefined, so the core leaves out what it would have said
 *     (a link to AgentMesh's app in an error message, for instance).
 *
 * A file that is there and broken still throws, at the first read.
 */
import { findEnvFile as find, envFileGet as get } from "./env-file.js";

/** What the core uses when the deployment has no environment file. Nothing:
 *  a server alone offers no naming service (its capabilities say
 *  `naming: false`) and names none, so it never asks another network's
 *  naming service about its own agents. PAN_URL or PAN_REGISTRAR names one. */
const DEFAULTS: Readonly<Record<string, string>> = {};

/** Whether this process found an environment file. */
export function hasEnvFile(): boolean {
  return find() !== null;
}

/**
 * A string value at a dotted path, e.g. coreSetting("urls.naming"). With an
 * environment file it is read as am-env reads it (and throws as it throws);
 * without one it is the default, or undefined when there is none.
 */
export function coreSetting(dotted: string): string | undefined {
  if (find() === null) return DEFAULTS[dotted];
  const v = get<unknown>(dotted);
  if (typeof v !== "string") throw new Error(`env value ${dotted} is not a string`);
  return v;
}

/** A public URL of this environment, e.g. coreUrl("app"), or undefined when the deployment names none. */
export function coreUrl(key: string): string | undefined {
  return coreSetting(`urls.${key}`);
}

/** The naming service the core resolves handles at: the environment's, or
 *  none (then the core resolves no handles). */
export function namingUrl(): string | undefined {
  return coreUrl("naming") ?? (process.env.AGENTMESH_NAMING_URL?.trim() || undefined);
}
