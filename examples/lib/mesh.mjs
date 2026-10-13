// What every example needs: the mesh's operator making tenants and enrollment
// keys, and agents enrolling with a key and connecting on whichever broker the
// mesh runs.
//
// Settings (environment):
//   MESH_API               the server's address (default http://localhost:3005)
//   MESH_ADMIN_TOKEN_FILE  the admin token, which only the mesh's operator has.
//                          examples/run.mjs copies it out of the Compose volume.
//
// The examples use this repository's SDK (sdk-typescript, built with
// `npm run build`). An agent of your own would install it as a package.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const sdk = await import(pathToFileURL(join(HERE, "..", "..", "sdk-typescript", "dist", "index.js")).href);
const { AgentMesh, createAgentIdentity, exchangeBootstrapToken, jwtAuthenticator, transportFromMesh } = sdk;

export const MESH_API = (process.env.MESH_API ?? "http://localhost:3005").replace(/\/+$/, "");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const say = (line) => console.log(line);

function adminToken() {
  const file = process.env.MESH_ADMIN_TOKEN_FILE;
  if (!file) throw new Error("Set MESH_ADMIN_TOKEN_FILE to the mesh's admin token (examples/run.mjs does it for the Compose setups).");
  // One token per line, optionally after a name ("ops-laptop <token>").
  const line = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!line) throw new Error(`${file} holds no admin token`);
  return line.split(/\s+/).pop();
}

/** One call to the server's admin API, as the mesh's operator. */
export async function admin(method, path, body) {
  const res = await fetch(`${MESH_API}/admin/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${adminToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** A tenant: one company, or one team, whose agents the mesh keeps apart. */
export async function tenant(id) {
  const r = await admin("POST", "/tenants", { id });
  if (r.status !== 201 && r.status !== 200 && r.status !== 409) throw new Error(`could not make tenant ${id}: ${r.status} ${JSON.stringify(r.json)}`);
  return id;
}

/**
 * A new agent in a tenant. The operator makes a one-time enrollment key; the
 * agent makes its own key pair and redeems the enrollment key for a
 * connection credential (POST /v1/bootstrap). The agent's seed never leaves it.
 */
export async function enroll(tenantId, label, me = createAgentIdentity()) {
  const key = await admin("POST", `/tenants/${encodeURIComponent(tenantId)}/enroll-keys`, { label });
  if (key.status !== 201) throw new Error(`no enrollment key for ${label}: ${key.status} ${JSON.stringify(key.json)}`);
  const creds = await exchangeBootstrapToken(MESH_API, key.json.key, me.publicKey);
  return { label, id: me.publicKey, seed: me.seed, jwt: creds.jwt, credentialSeed: creds.seed, mesh: creds.mesh };
}

/**
 * Connect an enrolled agent. The credential answer's `mesh` object says which
 * broker the mesh runs and where (transportFromMesh), so the same code works
 * on NATS and on RabbitMQ.
 *
 * requireNamed: false, because this mesh offers no naming service (its
 * capabilities answer says `naming: false`): agents here are known by their
 * keys and by the tenant that holds them, which the credential doors check.
 */
export async function connect(agent, opts = {}) {
  const where = transportFromMesh(agent.mesh);
  if (!where) throw new Error(`the credential answer names no broker this SDK speaks: ${JSON.stringify(agent.mesh)}`);
  return AgentMesh.connect(where.servers, {
    nkeySeed: agent.seed,
    authenticator: jwtAuthenticator(agent.jwt, new TextEncoder().encode(agent.credentialSeed)),
    requireNamed: false,
    ...opts,
  });
}

/** Which broker the mesh runs, from its capabilities answer. */
export async function binding() {
  const caps = await (await fetch(`${MESH_API}/v1/capabilities`)).json();
  return caps.binding ?? "nats";
}

/** A unique suffix, so an example can run again on the same mesh. */
export const run = Date.now().toString(36);

/** Fail with a sentence: it throws, so an example's clean-up still runs, and
 *  the process ends with a non-zero code. */
export function check(cond, what) {
  if (!cond) {
    process.exitCode = 1;
    throw new Error(`FAILED: ${what}`);
  }
  say(`  ok: ${what}`);
}
