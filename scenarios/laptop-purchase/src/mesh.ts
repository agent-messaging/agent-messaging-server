/**
 * Getting agents onto the mesh, as its operator and as the agents themselves.
 *
 * 1. The operator makes a tenant per company and a one-time enrollment key
 *    for each agent (the admin API, what `mesh-admin tenants key` does).
 * 2. Each agent makes its own key pair and redeems the key at /v1/bootstrap
 *    for a connection credential. Its seed never leaves it.
 * 3. The agent connects to whichever broker the credential answer names, so
 *    the same code runs on NATS and on RabbitMQ.
 *
 * The same steps as examples/lib/mesh.mjs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentMesh,
  createAgentIdentity,
  exchangeBootstrapToken,
  jwtAuthenticator,
  transportFromMesh,
} from "agent-messaging";
import { ROOT } from "./config.js";

export const MESH_API = (process.env.MESH_API ?? "http://localhost:3005").replace(/\/+$/, "");
export const BROKER = process.env.BROKER ?? "nats";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A suffix that keeps runs apart on one mesh. */
export const runId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function adminToken(): string {
  const file = process.env.MESH_ADMIN_TOKEN_FILE ?? join(ROOT, ".state", BROKER, "mesh-admin.token");
  const line = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!line) throw new Error(`${file} holds no admin token; run it through run.mjs, which copies the token out of the Compose volume`);
  return line.split(/\s+/).pop() as string;
}

export async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${MESH_API}/admin/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${adminToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

export async function tenant(id: string): Promise<string> {
  const r = await admin("POST", "/tenants", { id });
  if (![200, 201, 409].includes(r.status)) throw new Error(`could not make tenant ${id}: ${r.status} ${JSON.stringify(r.json)}`);
  return id;
}

/** An enrolled agent: its identity, and the credential to connect with. */
export interface Enrolled {
  label: string;
  tenant: string;
  id: string;
  seed: string;
  jwt: string;
  credentialSeed: string;
  mesh: unknown;
}

export async function enroll(tenantId: string, label: string): Promise<Enrolled> {
  const me = createAgentIdentity();
  const key = await admin("POST", `/tenants/${encodeURIComponent(tenantId)}/enroll-keys`, { label });
  if (key.status !== 201) throw new Error(`no enrollment key for ${label}: ${key.status} ${JSON.stringify(key.json)}`);
  const creds = await exchangeBootstrapToken(MESH_API, key.json.key, me.publicKey);
  return { label, tenant: tenantId, id: me.publicKey, seed: me.seed, jwt: creds.jwt, credentialSeed: creds.seed, mesh: creds.mesh };
}

export async function connect(agent: Enrolled): Promise<AgentMesh> {
  const where = transportFromMesh(agent.mesh as any);
  if (!where) throw new Error(`the credential answer names no broker this SDK speaks: ${JSON.stringify(agent.mesh)}`);
  return AgentMesh.connect(where.servers, {
    nkeySeed: agent.seed,
    authenticator: jwtAuthenticator(agent.jwt, new TextEncoder().encode(agent.credentialSeed)),
    platformApi: MESH_API,
  });
}

/** Wait until `cond` holds, or fail with `what` after `ms`. */
export async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${ms} ms waiting for: ${what}`);
}
