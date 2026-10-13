/**
 * The server's settings file, `server.env` in the folder first-run setup
 * fills (first-run.ts). It holds the settings the core server reads, by their
 * exact names: paths to the credentials and keys first-run made, public keys,
 * and the mesh's name and addresses. It never holds a secret, only where one
 * is.
 *
 * The core server (server-main.ts) reads it at start. A setting already in the
 * environment wins, so a container or a service manager can override any line.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The setting that names the folder first-run fills. */
export const CONFIG_DIR_SETTING = "MESH_CONFIG_DIR";
/** The folder used when MESH_CONFIG_DIR is not set, relative to the working directory. */
export const DEFAULT_CONFIG_DIR = "mesh-config";
/** The settings file's name inside that folder. */
export const SERVER_ENV_FILE = "server.env";

/** The folder first-run fills and the server reads: MESH_CONFIG_DIR, else ./mesh-config. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env[CONFIG_DIR_SETTING]?.trim() || DEFAULT_CONFIG_DIR);
}

/** One setting: its exact name, its value, and a line saying what it is. */
export interface Setting {
  name: string;
  value: string;
  about: string;
}

const NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * The file's text: a header, then each setting under a comment. Values are
 * paths, public keys, names and addresses; a Windows path is written with
 * forward slashes, which Node reads the same, so a shell or `docker
 * --env-file` can read the file too.
 */
export function settingsFileText(header: string[], settings: Setting[]): string {
  const lines = header.map((h) => `# ${h}`.trimEnd());
  for (const s of settings) {
    if (!NAME.test(s.name)) throw new Error(`not a setting name: ${s.name}`);
    if (/[\r\n]/.test(s.value)) throw new Error(`the value of ${s.name} has a line break`);
    lines.push("", `# ${s.about}`, `${s.name}=${s.value.replace(/\\/g, "/")}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Write a settings file. Readable by others on the host: it holds no secret. */
export function writeSettingsFile(path: string, header: string[], settings: Setting[]): void {
  writeFileSync(path, settingsFileText(header, settings), { mode: 0o644 });
}

/** Read a settings file's lines into name → value. Comments and blank lines are skipped. */
export function parseSettingsFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    if (!NAME.test(name)) continue;
    out.set(name, line.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Put the settings from `<dir>/server.env` into `env`, leaving every setting
 * that is already set as it is. Returns the file read, or null when there is
 * none (a server run on its environment alone, as AgentMesh's own processes
 * are).
 */
export function loadServerEnv(env: NodeJS.ProcessEnv = process.env): { file: string; applied: string[] } | null {
  const file = join(configDir(env), SERVER_ENV_FILE);
  if (!existsSync(file)) return null;
  const applied: string[] = [];
  for (const [name, value] of parseSettingsFile(readFileSync(file, "utf8"))) {
    if (env[name] === undefined) {
      env[name] = value;
      applied.push(name);
    }
  }
  return { file, applied };
}
