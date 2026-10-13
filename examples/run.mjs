#!/usr/bin/env node
// Run the examples against a mesh started by one of the Compose setups.
//
//   node examples/run.mjs nats                 every example, on the NATS setup
//   node examples/run.mjs rabbitmq 01 04       two of them, on the RabbitMQ setup
//
// It copies the admin token out of the server's config volume (never printing
// it), points the examples at the server, runs each in turn and says which
// passed. The host ports are the Compose files' settings (SERVER_PORT,
// GATEWAY_PORT), with the same defaults.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const [broker, ...only] = process.argv.slice(2);
if (broker !== "nats" && broker !== "rabbitmq") {
  console.error("usage: node examples/run.mjs nats|rabbitmq [01 02 ...]");
  process.exit(2);
}
if (!existsSync(join(ROOT, "sdk-typescript", "dist", "index.js"))) {
  console.error("Build the SDK first: cd sdk-typescript && npm ci && npm run build");
  process.exit(2);
}
if (!existsSync(join(HERE, "node_modules", "@langchain", "core"))) {
  console.error("Install the examples' packages first: cd examples && npm ci");
  process.exit(2);
}

const composeFile = join(ROOT, "deploy", "compose", broker, "compose.yaml");
const state = join(ROOT, ".state", `examples-${broker}`);
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
  GATEWAY_URL: `http://localhost:${process.env.GATEWAY_PORT ?? "8090"}`,
  MESH_ADMIN_TOKEN_FILE: tokenFile,
  COMPOSE_FILE_PATH: composeFile,
};

const examples = readdirSync(HERE).filter((d) => /^\d\d-/.test(d)).sort().filter((d) => !only.length || only.some((o) => d.startsWith(o)));
const results = [];
for (const ex of examples) {
  console.log(`\n=== ${ex} on ${broker} ===`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(HERE, ex, "run.mjs")], { env, stdio: "inherit", timeout: 180_000 });
  results.push({ ex, ok: r.status === 0, s: ((Date.now() - started) / 1000).toFixed(1) });
}
console.log(`\nExamples on ${broker}:`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.ex}  (${r.s} s)`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
