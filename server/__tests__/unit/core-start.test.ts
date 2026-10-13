/**
 * The core's startup path (core-start.ts) loads with no environment file and
 * none of the platform's hooks, while the platform's own settings reader
 * stays as strict as it was (the Agent Messaging Server, step 2).
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const SERVICES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NO_FILE = { ...process.env, AGENTMESH_ENV_FILE: join(SERVICES, "no-such-env-file.json") };

function load(module: string): { status: number | null; out: string } {
  const url = pathToFileURL(join(SERVICES, module)).href;
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(url)}); console.log("loaded");`],
    { cwd: SERVICES, env: NO_FILE, encoding: "utf8", timeout: 90_000 },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("the core's startup path without an environment file", () => {
  it("loads core-start.ts and every core service it starts", () => {
    const r = load("src/core-start.ts");
    expect(r.out).toContain("loaded");
    expect(r.status).toBe(0);
  }, 120_000);

  // The platform's settings reader is not in the server's own repository
  // (tools/server-repo.mjs), where this case has nothing to load.
  it.skipIf(!existsSync(join(SERVICES, "src", "platform-shared", "am-env.ts")))("leaves AgentMesh's own settings reader stopping the process, as before", () => {
    const r = load("src/platform-shared/am-env.ts");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/not found; looked in/);
  }, 120_000);
});
