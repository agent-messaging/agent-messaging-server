#!/usr/bin/env node
// Run the laptop purchase scenario against a mesh started by one of the
// Compose setups.
//
//   node scenarios/laptop-purchase/run.mjs nats
//   node scenarios/laptop-purchase/run.mjs rabbitmq tests/laptop-happy.test.ts
//
// Like examples/run.mjs, it copies the admin token out of the server's config
// volume (never printing it), points the tests at the server and runs them.
// The host port is the Compose files' SERVER_PORT, with the same default. The
// scenario's delays come from the environment (SHIP_DELAY_MS and the rest,
// src/config.ts), so the same command is the quick run and the overnight one.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const [broker, ...only] = process.argv.slice(2);
if (broker !== "nats" && broker !== "rabbitmq") {
  console.error("usage: node scenarios/laptop-purchase/run.mjs nats|rabbitmq [test files]");
  process.exit(2);
}
if (!existsSync(join(ROOT, "sdk-typescript", "dist", "index.js"))) {
  console.error("Build the SDK first: cd sdk-typescript && npm ci && npm run build");
  process.exit(2);
}
if (!existsSync(join(HERE, "node_modules", "vitest"))) {
  console.error("Install the scenario's packages first: cd scenarios/laptop-purchase && npm ci");
  process.exit(2);
}

const state = join(HERE, ".state");
mkdirSync(state, { recursive: true });
const tokenFile = join(state, `mesh-admin-${broker}.token`);
const kubeNamespace = process.env.MESH_KUBE_NAMESPACE;
if (kubeNamespace) {
  const bytes = execFileSync("kubectl", ["-n", kubeNamespace, "exec", "deploy/server", "--", "cat", "/config/creds/mesh-admin.token"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  writeFileSync(tokenFile, bytes, { mode: 0o600 });
} else {
  const composeFile = join(ROOT, "deploy", "compose", broker, "compose.yaml");
  execFileSync("docker", ["compose", "-f", composeFile, "cp", "server:/config/creds/mesh-admin.token", tokenFile], {
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 60_000,
  });
}

const r = spawnSync(process.execPath, [join(HERE, "node_modules", "vitest", "vitest.mjs"), "run", ...only], {
  cwd: HERE,
  stdio: "inherit",
  env: {
    ...process.env,
    BROKER: broker,
    MESH_API: `http://localhost:${process.env.SERVER_PORT ?? "3005"}`,
    MESH_ADMIN_TOKEN_FILE: tokenFile,
  },
});
process.exit(r.status ?? 1);
