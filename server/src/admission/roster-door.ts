/**
 * The admission roster's own door (EXT-6 §7): an agent's client keeps its
 * signed roster on the mesh, so the admission service can drop what the roster
 * blocks before it is delivered.
 *
 *   PUT /v1/rosters/:owner   the whole roster, stored only when it is validly
 *                            signed by the owner key it is stored under. No
 *                            login: the signature is the authority, and the
 *                            operator cannot forge one.
 *   GET /v1/rosters/:owner   the stored roster, as signed. Public: a roster is
 *                            signed policy, and a reader verifies it again.
 *
 * Before this door the core kept rosters only through its admin API, so an
 * agent on a server with no platform beside it had no way to put its roster
 * where the mesh enforces it. AgentMesh's platform serves the same two routes
 * for its own network.
 *
 * Each answer is { status, body } and never throws.
 */
import type { DoorAnswer } from "../keychain/doors.js";
import type { AdmissionStore } from "./admission-store.js";

const NKEY = /^U[A-Z2-7]{55}$/;
/** Room for a roster with a few thousand entries. Past it, a roster is not a
 *  list of contacts any more, and every guarded delivery would read it. */
const MAX_ROSTER_BYTES = 128 * 1024;
/** Writes per owner key per minute. A client writes when its owner decides
 *  something, which is not many times a minute. */
const WRITES_PER_MINUTE = 20;

export type RosterDoor = (method: string, path: string, body: () => Promise<unknown>) => Promise<DoorAnswer | null>;

export function rosterDoor(store: Pick<AdmissionStore, "get" | "put">): RosterDoor {
  const writes = new Map<string, number[]>();
  const overRate = (owner: string): boolean => {
    const now = Date.now();
    const hits = (writes.get(owner) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= WRITES_PER_MINUTE) { writes.set(owner, hits); return true; }
    hits.push(now);
    writes.set(owner, hits);
    if (writes.size > 10_000) writes.delete(writes.keys().next().value!);
    return false;
  };

  return async (method, path, body) => {
    const m = /^\/v1\/rosters\/([^/]+)$/.exec(path);
    if (!m) return null;
    const owner = decodeURIComponent(m[1]!);
    if (!NKEY.test(owner)) return { status: 400, body: { error: "The address names an owner key: a U followed by 55 letters and digits." } };
    if (method === "GET") {
      const roster = await store.get(owner);
      return roster ? { status: 200, body: roster } : { status: 404, body: { error: "No roster is stored for that key." } };
    }
    if (method !== "PUT") return { status: 405, body: { error: "A roster is read with GET and stored with PUT." } };
    if (overRate(owner)) return { status: 429, body: { error: "Too many roster writes for that key. Try again in a minute." } };
    const roster = await body();
    if (!roster || typeof roster !== "object" || Array.isArray(roster)) return { status: 400, body: { error: "The body is the whole signed roster document." } };
    if (JSON.stringify(roster).length > MAX_ROSTER_BYTES) return { status: 413, body: { error: `A roster is at most ${MAX_ROSTER_BYTES} bytes.` } };
    const stored = await store.put(owner, roster as Record<string, unknown>);
    return stored
      ? { status: 200, body: { stored: true } }
      : { status: 400, body: { error: "The roster's owner_key is not that key, or its signature does not verify for it." } };
  };
}
