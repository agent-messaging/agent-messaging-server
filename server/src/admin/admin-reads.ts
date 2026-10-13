/**
 * The admin API's read routes (step 10a of docs/agent-messaging-server-plan.md):
 * what the core holds, for its operator. A platform running beside the server
 * (AgentMesh's) reads the core through these rather than opening the core's
 * stores itself; a self-hosted operator reads the same things with the CLI.
 *
 *   GET /admin/v1/registrations?after=&limit=   every stored registration, by key, in pages
 *   GET /admin/v1/registrations/:key             one stored registration
 *   GET /admin/v1/descriptors                    every agent key with a current descriptor
 *   GET /admin/v1/feeds/:agent                   the topics an agent's feeds hold a current value for
 *   GET /admin/v1/feeds/:agent/:topic            one feed's current value, the envelope as published
 *   DELETE /admin/v1/feeds/:agent                forget every current value an agent's feeds hold
 *                                                (the one write here: an account closing)
 *   GET /admin/v1/naming/would-refuse            the agents this process's doors would refuse if
 *                                                MESH_REQUIRE_NAMES were on (names and key prefixes)
 *
 * A registration is the manifest the registry stored, private ones included:
 * this is the operator's view, not discovery's. Each is { key, revision,
 * written_at (when the store last wrote it, ISO, or null), manifest }. Each
 * answer is { status, body } and never throws.
 */
import type { KeyedEntry, KeyedStore } from "../storage/index.js";
import type { WouldRefuse } from "../shared/require-names.js";
import type { DoorAnswer } from "../keychain/doors.js";
import type { AdminRequest } from "./admin-api.js";

const NKEY = /^U[A-Z2-7]{55}$/;
const PAGE = 200;
const MAX_PAGE = 1000;

export interface AdminReadDeps {
  /** The registry's store of registrations (mesh_registry). */
  registrations: () => Promise<KeyedStore>;
  /** The state feeds' current values (mesh_feed_state, shared/feed-state.ts). */
  feeds?: () => Promise<KeyedStore>;
  /** The current descriptors (mesh_descriptors), for the list of who has one. */
  descriptors?: () => Promise<KeyedStore>;
  /** The would-be refusals the doors in this process noted (shared/require-names.ts). */
  wouldRefuse?: () => WouldRefuse[];
}

const TOPIC = /^[A-Za-z0-9_-]{1,128}$/;

const ok = (body: Record<string, unknown>, status = 200): DoorAnswer => ({ status, body });
const no = (status: number, error: string): DoorAnswer => ({ status, body: { error } });

function registrationView(e: KeyedEntry): Record<string, unknown> | null {
  if (e.operation !== "PUT" || !e.value.length) return null;
  try {
    const written = e.created instanceof Date && !Number.isNaN(e.created.getTime()) ? e.created.toISOString() : null;
    return { key: e.key, revision: e.revision, written_at: written, manifest: e.json<Record<string, unknown>>() };
  } catch {
    return null;
  }
}

export function adminReads(deps: AdminReadDeps) {
  async function listRegistrations(q: URLSearchParams): Promise<DoorAnswer> {
    const after = q.get("after") ?? "";
    const limit = Math.max(1, Math.min(Number(q.get("limit") ?? PAGE) || PAGE, MAX_PAGE));
    const snap = await (await deps.registrations()).list();
    const keys = [...snap.entries.keys()].filter((k) => k > after).sort();
    const page = keys.slice(0, limit);
    const registrations = page.map((k) => registrationView(snap.entries.get(k)!)).filter((r): r is Record<string, unknown> => r !== null);
    return ok({ registrations, next: keys.length > limit ? page[page.length - 1] : null, total: snap.entries.size });
  }

  async function getRegistration(key: string): Promise<DoorAnswer> {
    const e = await (await deps.registrations()).get(key);
    const view = e ? registrationView(e) : null;
    return view ? ok(view) : no(404, "No registration is stored for that key.");
  }

  /** The topics an agent holds a current value for. */
  async function feedTopics(agent: string): Promise<DoorAnswer> {
    const prefix = `${agent}.`;
    const keys = (await (await deps.feeds!()).list()).keys;
    return ok({ agent, topics: keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort() });
  }

  /** One feed's current value: the stored envelope as it was published, so
   *  the reader verifies its signature itself. */
  async function feedCurrent(agent: string, topic: string): Promise<DoorAnswer> {
    const e = await (await deps.feeds!()).get(`${agent}.${topic}`);
    if (!e || e.operation !== "PUT" || !e.value.length) return ok({ found: false, envelope: null });
    try {
      return ok({ found: true, envelope: e.json<Record<string, unknown>>() });
    } catch {
      return ok({ found: false, envelope: null });
    }
  }

  /** Forget every current value an agent's feeds hold (its account closed). */
  async function forgetFeeds(agent: string): Promise<DoorAnswer> {
    const store = await deps.feeds!();
    const prefix = `${agent}.`;
    let forgotten = 0;
    for (const k of (await store.list()).keys) {
      if (!k.startsWith(prefix)) continue;
      await store.purge(k);
      forgotten++;
    }
    return ok({ agent, forgotten });
  }

  const notKey = () => no(400, "That is not an agent public key (U followed by 55 characters).");

  /** The answer for a read route, or null when the path is not one. */
  async function handle(req: AdminRequest): Promise<DoorAnswer | null> {
    const seg = req.path.replace(/^\/admin\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    if (seg[0] === "descriptors" && seg.length === 1 && req.method === "GET" && deps.descriptors) {
      const keys = (await (await deps.descriptors()).list()).keys.filter((k) => NKEY.test(k)).sort();
      return ok({ keys });
    }
    if (seg[0] === "naming" && seg[1] === "would-refuse" && seg.length === 2 && req.method === "GET" && deps.wouldRefuse) {
      return ok({ would_refuse: deps.wouldRefuse() });
    }
    if (seg[0] === "registrations" && req.method === "GET") {
      if (seg.length === 1) return listRegistrations(req.query);
      if (seg.length === 2) return NKEY.test(seg[1]!) ? getRegistration(seg[1]!) : notKey();
    }
    if (seg[0] === "feeds" && deps.feeds && seg.length >= 2) {
      if (!NKEY.test(seg[1]!)) return notKey();
      if (seg.length === 2 && req.method === "GET") return feedTopics(seg[1]!);
      if (seg.length === 2 && req.method === "DELETE") return forgetFeeds(seg[1]!);
      if (seg.length === 3 && req.method === "GET") return TOPIC.test(seg[2]!) ? feedCurrent(seg[1]!, seg[2]!) : no(400, "A feed topic is one token of letters, digits, - and _.");
    }
    return null;
  }

  return { handle };
}

export type AdminReads = ReturnType<typeof adminReads>;
