#!/usr/bin/env node
// Run the conformance suite's `identity` profile (i01 to i14, bring your own
// identity) against a mesh brought up by one of the Compose setups, with the
// server allowed to fetch keys from a test issuer over http
// (MESH_TRUST_ALLOW_HTTP=on when the mesh was started).
//
//   node tools/identity-profile.mjs nats|rabbitmq [--ci]
//
// Each test runs its own OAuth issuer and SPIFFE bundle on this machine, and
// the server reaches it at host.docker.internal. An issuer belongs to one
// tenant on a mesh, and a test tenant that enrolled an agent stays behind, so
// each test gets an issuer on a port of its own (IDENTITY_ISSUER_LISTEN and
// IDENTITY_ISSUER_BASE) and the tests never share one.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [broker, ...rest] = process.argv.slice(2);
if (broker !== "nats" && broker !== "rabbitmq") {
  console.error("usage: node tools/identity-profile.mjs nats|rabbitmq [--ci]");
  process.exit(2);
}
const ci = rest.includes("--ci");
const host = process.env.IDENTITY_ISSUER_HOST ?? "host.docker.internal";
const base = Number(process.env.IDENTITY_ISSUER_PORT ?? 47100);
const tests = readdirSync(join(ROOT, "conformance", "core", "tests"))
  .map((f) => /^(i\d\d)-/.exec(f)?.[1])
  .filter((x) => !!x)
  .sort();

let failed = 0;
for (const [i, id] of tests.entries()) {
  const port = base + i;
  const r = spawnSync(process.execPath, [join(ROOT, "tools", "conformance.mjs"), broker, "--only", id], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    env: { ...process.env, IDENTITY_ISSUER_LISTEN: `0.0.0.0:${port}`, IDENTITY_ISSUER_BASE: `http://${host}:${port}` },
  });
  const lines = (r.stdout ?? "").split("\n").filter((l) => new RegExp(`^[✓✗!~-] ${id} |^    `).test(l));
  console.log(lines.join("\n"));
  if (!lines.some((l) => l.startsWith(`✓ ${id} `))) failed++;
}
console.log(`\nidentity profile on ${broker}: ${tests.length - failed} of ${tests.length} pass`);
process.exit(ci && failed ? 1 : 0);
