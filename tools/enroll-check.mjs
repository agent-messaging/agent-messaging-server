#!/usr/bin/env node
// Enroll one agent the way an operator's documentation says, and prove it is
// on the mesh. The nightly proof runs it on each setup.
//
//   node tools/enroll-check.mjs <enrollment key file>
//
// The key comes from `mesh-admin tenants key <tenant> --label <label> --out
// <file>`. The agent makes its own key pair, redeems the enrollment key at the
// server's /v1/bootstrap with the SDK's exchangeBootstrapToken, connects to
// the broker the credential answer names, registers, sends itself a request,
// and leaves. It prints the agent's public key on the last line, and never the
// enrollment key, the credential or the seed.
//
// Settings: MESH_API, the server's address (default http://localhost:3005).
// It uses this repository's SDK (sdk-typescript, built with npm run build).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keyFile = process.argv[2];
if (!keyFile) {
  console.error("usage: node tools/enroll-check.mjs <enrollment key file>");
  process.exit(2);
}
const { AgentMesh, createAgentIdentity, exchangeBootstrapToken, jwtAuthenticator, transportFromMesh } = await import(
  pathToFileURL(join(ROOT, "sdk-typescript", "dist", "index.js")).href
);
const MESH_API = (process.env.MESH_API ?? "http://localhost:3005").replace(/\/+$/, "");

const key = readFileSync(keyFile, "utf8").trim();
const me = createAgentIdentity();
const creds = await exchangeBootstrapToken(MESH_API, key, me.publicKey);
const where = transportFromMesh(creds.mesh);
if (!where) throw new Error(`the credential answer names no broker this SDK speaks: ${JSON.stringify(creds.mesh)}`);
console.log(`Enrolled: the credential answer names ${where.binding} at ${[].concat(where.servers).join(", ")}.`);

// requireNamed: false, because this mesh offers no naming service (its
// capabilities answer says naming: false); the tenant that holds the key is
// what the credential doors check.
const mesh = await AgentMesh.connect(where.servers, {
  nkeySeed: me.seed,
  authenticator: jwtAuthenticator(creds.jwt, new TextEncoder().encode(creds.seed)),
  requireNamed: false,
});
mesh.onRequest("add", (input) => ({ sum: Number(input?.a) + Number(input?.b) }));
await mesh.register({
  name: "nightly-enroll-check",
  description: "Proves an agent enrolled with an enrollment key can connect and be reached.",
  visibility: "unlisted",
  offerings: [{ id: "add", name: "Add", description: "Adds two numbers." }],
});
const answer = await mesh.request(me.publicKey, "add", { a: 2, b: 3 }, { timeout_ms: 15_000 });
if (answer.payload?.output?.sum !== 5) throw new Error(`the agent did not answer its own request: ${JSON.stringify(answer.payload)}`);
console.log("Connected, registered, and answered a request sent to itself.");
await mesh.close();
console.log(me.publicKey);
process.exit(0);
