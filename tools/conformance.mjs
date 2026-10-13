#!/usr/bin/env node
// Run the core conformance profile against a mesh brought up by one of the
// Compose setups in deploy/compose/.
//
//   node tools/conformance.mjs install                 once: the suite's and the reference adapter's packages
//   node tools/conformance.mjs nats     [--ci] [--only c20]
//   node tools/conformance.mjs rabbitmq [--ci] [--only c20]
//
// What it does, against the running Compose project of that broker:
//   1. copies the admin token and the A2A gateway's node credential out of the
//      server's config volume into .state/conformance-<broker>/ (never printed);
//   2. makes the suite's own identity and puts it on record under the tenant
//      `suite` with mesh-admin, as the mesh's operator does;
//   3. runs conformance/run.mjs with the mesh's addresses, this repository's
//      SDK as the SDK under test, and a home folder of its own, so nothing in
//      your own ~/.agentmesh is read.
//
// The host ports are the Compose files' settings (SERVER_PORT, NATS_WS_PORT,
// AMQP_PORT), with the same defaults.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [what, ...rest] = process.argv.slice(2);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" && cmd.endsWith(".cmd"), ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status ?? r.error}`);
}

/** Where the reference adapter is installed, and its entry point. */
const ADAPTER_HOME = join(ROOT, ".state", "reference-adapter");
const ADAPTER_MJS = join(ADAPTER_HOME, "node_modules", "mesh-adapter", "mesh-adapter.mjs");

/** The released reference adapter (conformance/reference-adapter.json), checked
 *  by its SHA-256, installed with this repository's SDK as its `agentmesh`. */
async function installAdapter() {
  const pin = JSON.parse(readFileSync(join(ROOT, "conformance", "reference-adapter.json"), "utf8"));
  const res = await fetch(pin.url);
  if (!res.ok) throw new Error(`could not fetch the reference adapter ${pin.url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== pin.sha256) throw new Error(`the reference adapter ${pin.url} is not the pinned one (sha256 ${got}, want ${pin.sha256})`);
  rmSync(ADAPTER_HOME, { recursive: true, force: true });
  mkdirSync(ADAPTER_HOME, { recursive: true });
  const tgz = join(ADAPTER_HOME, `mesh-adapter-${pin.version}.tgz`);
  writeFileSync(tgz, bytes);
  writeFileSync(join(ADAPTER_HOME, "package.json"), JSON.stringify({ name: "reference-adapter-install", private: true }));
  run(npm, ["install", "--no-audit", "--no-fund", tgz], { cwd: ADAPTER_HOME });
  // The SDK under test is this repository's, for the adapter too.
  const link = join(ADAPTER_HOME, "node_modules", "agentmesh");
  let isLink = false;
  try { isLink = lstatSync(link).isSymbolicLink(); } catch { /* not there */ }
  if (isLink) unlinkSync(link);
  else rmSync(link, { recursive: true, force: true });
  symlinkSync(join(ROOT, "sdk-typescript"), link, process.platform === "win32" ? "junction" : "dir");
  return pin.version;
}

if (what === "install") {
  run(npm, ["install", "--no-audit", "--no-fund"], { cwd: join(ROOT, "conformance", "peering") });
  const version = await installAdapter();
  if (!existsSync(join(ROOT, "sdk-typescript", "dist", "index.js"))) {
    console.log("The SDK has no build yet: run npm ci and npm run build in sdk-typescript.");
  }
  console.log(`The conformance suite and the reference adapter ${version} are installed; the adapter runs this repository's SDK.`);
  process.exit(0);
}

if (what !== "nats" && what !== "rabbitmq") {
  console.error("usage: node tools/conformance.mjs install | nats | rabbitmq [run.mjs options]");
  process.exit(2);
}

const compose = ["compose", "-f", join(ROOT, "deploy", "compose", what, "compose.yaml")];
const state = join(ROOT, ".state", `conformance-${what}`);
rmSync(state, { recursive: true, force: true });
mkdirSync(join(state, "home"), { recursive: true });

const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
for (const [from, to] of [["/config/creds/mesh-admin.token", "mesh-admin.token"], ["/config/creds/a2a-gateway.creds", "suite.creds"]]) {
  execFileSync("docker", [...compose, "cp", `server:${from}`, join(state, to)], { env, stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 });
}

const serverPort = process.env.SERVER_PORT ?? "3005";
const adminUrl = `http://127.0.0.1:${serverPort}`;
const meshUrl = what === "nats"
  ? `ws://127.0.0.1:${process.env.NATS_WS_PORT ?? "4443"}`
  : `amqp://127.0.0.1:${process.env.AMQP_PORT ?? "5672"}/mesh`;

// The suite's identity, enrolled under the tenant `suite`.
const { nkeys } = createRequire(join(ROOT, "server", "package.json"))("nats");
const kp = nkeys.createUser();
const identityFile = join(state, "suite-identity.json");
writeFileSync(identityFile, JSON.stringify({ public_key: kp.getPublicKey(), seed: new TextDecoder().decode(kp.getSeed()), created_at: new Date().toISOString() }), { mode: 0o600 });
const adminEnv = { ...env, MESH_ADMIN_URL: adminUrl, MESH_ADMIN_TOKEN_FILE: join(state, "mesh-admin.token") };
const admin = (...args) => spawnSync(process.execPath, [join(ROOT, "server", "tools", "mesh-admin.mjs"), ...args], { env: adminEnv, encoding: "utf8" });
admin("tenants", "create", "suite"); // already there on a second run, which is fine
const enrolled = admin("agents", "enroll", kp.getPublicKey(), "--tenant", "suite", "--label", "conformance suite");
if (enrolled.status !== 0) {
  console.error(`could not enroll the suite's identity: ${(enrolled.stderr || enrolled.stdout).trim()}`);
  process.exit(1);
}

const home = join(state, "home");
const r = spawnSync(process.execPath, [join(ROOT, "conformance", "run.mjs"), ...rest], {
  cwd: join(ROOT, "conformance"),
  stdio: "inherit",
  env: {
    ...adminEnv,
    HOME: home,
    USERPROFILE: home,
    MESH_WS_URL: meshUrl,
    MESH_CREDS_FILE: join(state, "suite.creds"),
    MESH_IDENTITY_FILE: identityFile,
    STOREFRONT_BASE: adminUrl,
    AGENTMESH_SDK: join(ROOT, "sdk-typescript"),
    RESOLVER_MJS: ADAPTER_MJS,
  },
});
process.exit(r.status ?? 1);
