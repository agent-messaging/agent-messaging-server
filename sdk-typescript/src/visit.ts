/**
 * A visit (Agent Messaging §21.14 to §21.20): reaching an agent whose home is
 * another public mesh by connecting there, briefly and on that mesh's terms.
 *
 * `requestVisitPass` asks the recipient's home mesh for a pass: it signs the
 * visit statement, which names the mesh it asks so the request cannot be
 * replayed to another, and the standing statement its own home mesh answers
 * on, and posts both with its handle. `AgentMesh.visit` (mesh.ts) asks for the
 * pass and connects under it as a visitor: it listens on its own inbox and
 * drains its mailbox there, so an answer that came after an earlier visit
 * arrives now, and it never registers. `homeMeshOf` reads where an agent lives
 * from its resolved card (rule 14): a sender MUST visit a recipient whose home
 * mesh is not the one it is connected to.
 */
import { nkeys } from "./internal/nkeys.js";

/** What the visitor signs for the mesh it asks (§21.15). */
export function visitStatement(ts: number, key: string, meshUrl: string): string {
  return `mesh-visit-v1:${ts}:${key}:${meshUrl}`;
}

/** What the visitor signs for its own home mesh's standing door, which the
 *  visited mesh carries there (§21.16). */
export function keyStandingStatement(ts: number, key: string): string {
  return `mesh-key-standing-v1:${ts}:${key}`;
}

/** A control plane URL reduced to its origin, or null for anything that is
 *  not an http(s) URL. Two spellings of one mesh compare equal. */
export function meshOrigin(u: unknown): string | null {
  if (typeof u !== "string" || !u.trim()) return null;
  try {
    const url = new URL(u.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The home mesh a resolved card names on its agentmesh endpoint for `agentId`
 *  (SPEC-NAMING §5.1), as an origin, or null when it names none. */
export function homeMeshOf(card: unknown, agentId?: string): string | null {
  const eps = (card as { endpoints?: Array<{ protocol?: unknown; agent_id?: unknown; mesh?: unknown }> } | null)?.endpoints;
  if (!Array.isArray(eps)) return null;
  const ep = eps.find((e) => e?.protocol === "agentmesh" && (agentId === undefined || e.agent_id === agentId));
  return ep ? meshOrigin(ep.mesh) : null;
}

export interface VisitPass {
  jwt: string;
  agent_key: string;
  handle: string;
  /** The visitor's own home mesh, as the visited mesh checked it. */
  home_mesh: string;
  expires_at: string;
  /** Where to connect: the `mesh` object of §18.10. */
  mesh: { name?: string; endpoints?: string[]; nats_endpoints?: string[] };
}

/** A refusal from the pass door, with its machine-readable code (§21.16). */
export class VisitRefused extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) {
    super(message);
    this.name = "VisitRefused";
  }
}

export interface VisitPassRequest {
  /** The visited mesh's control plane: the recipient's card's `mesh`. */
  mesh: string;
  /** The visitor's own agent seed. */
  nkeySeed: string | Uint8Array;
  /** The visitor's own handle, which the visited mesh resolves. */
  handle: string;
  /** The naming service to resolve the visitor's handle at, when the visited
   *  mesh trusts more than its own. */
  registrar?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Ask a mesh for a visitor's pass. Throws VisitRefused with the door's words
 *  and code when it refuses. */
export async function requestVisitPass(req: VisitPassRequest): Promise<VisitPass> {
  const mesh = meshOrigin(req.mesh);
  if (!mesh) throw new VisitRefused(0, null, `not a mesh address: ${String(req.mesh)}`);
  const kp = nkeys.fromSeed(typeof req.nkeySeed === "string" ? new TextEncoder().encode(req.nkeySeed) : req.nkeySeed);
  const key = kp.getPublicKey();
  const ts = Math.floor((req.now ?? Date.now)() / 1000);
  const sign = (s: string) => btoa(String.fromCharCode(...kp.sign(new TextEncoder().encode(s))));
  const body = {
    handle: req.handle,
    agent_key: key,
    ts,
    sig: sign(visitStatement(ts, key, mesh)),
    standing_sig: sign(keyStandingStatement(ts, key)),
    ...(req.registrar ? { registrar: req.registrar } : {}),
  };
  const r = await (req.fetch ?? fetch)(`${mesh}/v1/visit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const doc = (await r.json().catch(() => null)) as (Record<string, unknown> & Partial<VisitPass>) | null;
  if (r.status !== 200 || !doc || typeof doc.jwt !== "string") {
    throw new VisitRefused(r.status, typeof doc?.code === "string" ? doc.code : null, typeof doc?.error === "string" ? doc.error : `${mesh} answered ${r.status}`);
  }
  return doc as VisitPass;
}
