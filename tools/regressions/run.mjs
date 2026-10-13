#!/usr/bin/env node
// Run the regression checks against a mesh started by one of the Compose
// setups, the way examples/run.mjs runs the examples.
//
//   node tools/regressions/run.mjs nats          every check, on the NATS setup
//   node tools/regressions/run.mjs rabbitmq      every check, on the RabbitMQ setup
//
// Each check is a bug that once reached a release, written so it fails on the
// release that had it (named at the top of each file). The host ports are the
// Compose files' settings (SERVER_PORT, GATEWAY_PORT), with the same defaults.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const [broker] = process.argv.slice(2);
if (broker !== "nats" && broker !== "rabbitmq") {
  console.error("usage: node tools/regressions/run.mjs nats|rabbitmq");
  process.exit(2);
}
const composeFile = join(ROOT, "deploy", "compose", broker, "compose.yaml");
const state = join(ROOT, ".state", `regressions-${broker}`);
mkdirSync(state, { recursive: true });
const tokenFile = join(state, "mesh-admin.token");
execFileSync("docker", ["compose", "-f", composeFile, "cp", "server:/config/creds/mesh-admin.token", tokenFile], {
  env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  stdio: ["ignore", "ignore", "pipe"],
  timeout: 60_000,
});
const env = {
  ...process.env,
  MSYS_NO_PATHCONV: "1",
  MESH_API: `http://localhost:${process.env.SERVER_PORT ?? "3005"}`,
  MESH_ADMIN_TOKEN_FILE: tokenFile,
};
const checks = readdirSync(HERE).filter((f) => f.endsWith(".mjs") && f !== "run.mjs").sort();
const results = [];
for (const c of checks) {
  console.log(`\n=== ${c} on ${broker} ===`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(HERE, c)], { env, stdio: "inherit", timeout: 300_000 });
  results.push({ c, ok: r.status === 0, s: ((Date.now() - started) / 1000).toFixed(1) });
}
console.log(`\nRegression checks on ${broker}:`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.c}  (${r.s} s)`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
