/**
 * Naming: claim a handle for an SDK agent and bind it to the agent's key,
 * so a custom agent (like a service built on this SDK) can name itself at
 * setup instead of staying an anonymous key. Mirrors what `mesh-adapter
 * join` does, in code.
 *
 * The email step is the human's: `startNaming` sends a six-digit code to the
 * owner's inbox; the human reads it back; `completeNaming` verifies it,
 * claims the name, and binds it — running both halves of the SPEC-NAMING
 * §4.1 pairing ceremony locally, because this process holds the agent key.
 */

import { nkeys } from "./internal/nkeys.js";
import { AM_URL_NAMING } from "./am-env.generated.js";

const DEFAULT_REGISTRAR = AM_URL_NAMING;

/** Standard base64 without Buffer — this module ships to browsers too. */
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface NamingSession {
  registrar: string;
  token: string;
  email: string;
}

async function post(url: string, body: unknown, token?: string): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Send a verification code to the owner's email. Returns nothing useful to
 *  the caller — the code goes to the inbox; the human reads it back. */
export async function startNaming(email: string, opts: { registrar?: string } = {}): Promise<void> {
  const registrar = opts.registrar ?? DEFAULT_REGISTRAR;
  await post(`${registrar}/api/handles/start`, { email });
}

/** Verify the emailed code and return a naming session (an 8h PAN session). */
export async function verifyNaming(email: string, code: string, opts: { registrar?: string } = {}): Promise<NamingSession> {
  const registrar = opts.registrar ?? DEFAULT_REGISTRAR;
  const { token } = await post(`${registrar}/api/handles/verify`, { email, code });
  if (!token) throw new Error("verification did not return a session");
  return { registrar, token, email };
}

/** Claim `name` under the verified email and bind it to this agent's key.
 *  `agentSeed` is the agent's nkey seed (the same identity it connects with);
 *  its public key becomes the handle's binding. `operatorName` is required
 *  the first time an email claims anything. Returns the full handle. */
export async function completeNaming(
  session: NamingSession,
  name: string,
  agentSeed: string,
  opts: { operatorName?: string } = {},
): Promise<string> {
  const { registrar, token } = session;
  const kp = nkeys.fromSeed(new TextEncoder().encode(agentSeed));
  const agentId = kp.getPublicKey();

  const claim = await post(`${registrar}/api/handles/claim`,
    { name, ...(opts.operatorName ? { operator_name: opts.operatorName } : {}) }, token);
  const handle: string = claim.handle;

  const pair = await post(`${registrar}/api/pair/start`, { handle }, token);
  const canonical = `pan-pair-v1:${String(pair.code).toUpperCase()}:${agentId}`;
  const signature = bytesToB64(kp.sign(new TextEncoder().encode(canonical)));
  await post(`${registrar}/api/pair/complete`, { code: pair.code, agent_id: agentId, signature });
  return handle;
}
