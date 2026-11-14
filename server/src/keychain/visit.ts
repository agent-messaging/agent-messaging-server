/**
 * A visit (SPEC §21.14 to §21.20): an agent whose home is another public mesh
 * asks this one for a short pass, connects here under it, and talks to this
 * mesh's agents at their own doors.
 *
 *   POST /v1/visit   { handle, agent_key, ts, sig, standing_sig, registrar? }
 *
 * `sig` is the agent key's signature over the visit statement,
 * `mesh-visit-v1:<ts>:<agent_key>:<this mesh's control plane URL>`, so a pass
 * request made for one mesh cannot be replayed to another. `standing_sig` is
 * its signature over its own home mesh's standing statement
 * (`mesh-key-standing-v1:<ts>:<agent_key>`, doors.ts keyStanding), which this
 * door carries there: the home answers only the key's holder.
 *
 * Before it issues anything the door (§21.16):
 *   1. resolves the handle at a naming service this mesh trusts and verifies
 *      the card's registrar signature; the card must bind the presented key
 *      and name a home mesh that is not this one;
 *   2. refuses a home its operator barred;
 *   3. asks the home whether an account holds the key, and whether the key is
 *      revoked or its agent stopped;
 *   4. asks this mesh's own records the same two questions, because every
 *      door that issues a credential asks them (§4.8).
 * A check that fails refuses with its own code; one that cannot be answered
 * refuses with `visitor_check_unavailable`. Only then is a pass minted: a
 * credential for the one visiting key with visitorPermissions (cred-template.ts),
 * an hour by default, never renewed. The visitor's mailbox is made so answers
 * that come after it leaves wait for its next visit (§21.19), and the visitor
 * is recorded in `mesh_visitors`, which the registry reads to answer a lookup
 * of the key as a visitor (registry/handlers/get.ts) and the sweep reads to
 * remove a mailbox nobody will come back for.
 *
 * Off unless MESH_VISITS=on. Settings, read by exact name: MESH_PUBLIC_URL, else
 * API_BASE_URL (this mesh's control plane, the URL a card's `mesh` names), MESH_VISIT_PASS_SECONDS
 * (3600), MESH_VISIT_REGISTRARS (naming services trusted to resolve a
 * visitor's handle, comma-separated; default this mesh's own, PAN_URL),
 * MESH_VISIT_BARRED (home hosts refused, comma-separated), MESH_VISITORS_MAX
 * (200 visitors on record at once).
 */
import { encodeUser } from "nats-jwt";
import { canonicalJSON, nkeys } from "../sdk.js";
import { verifyAgentSig } from "../admission/held-store.js";
import { RateLimiter } from "../shared/rate-limiter.js";
import { metrics } from "../shared/ops-events.js";
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";
import { assertNarrowVisitor, visitorPermissions } from "./cred-template.js";
import type { DoorAnswer } from "./doors.js";

export const VISITORS_BUCKET = "mesh_visitors";
const NKEY = /^U[A-Z2-7]{55}$/;
/** How long a visitor's mailbox and record outlive its last pass (§21.19). */
export const VISITOR_GRACE_MS = 24 * 3600_000;
/** A mailbox with mail in it is kept at most this long after the last pass:
 *  the mailbox's own retention (registry/inbox-buffer.ts), seven days. */
export const VISITOR_MAX_KEEP_MS = 7 * 24 * 3600_000;

export interface VisitorRecord {
  key: string;
  handle: string;
  /** The home mesh's control plane, as the visitor's card names it. */
  home_mesh: string;
  first_at: string;
  last_at: string;
  pass_expires_at: string;
  passes: number;
}

export interface VisitorList {
  get(key: string): Promise<VisitorRecord | null>;
  put(rec: VisitorRecord): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every visitor on record. Throws when the bucket cannot be read. */
  all(): Promise<VisitorRecord[]>;
}

export class VisitorStore implements VisitorList {
  private kv: KeyedStore;
  constructor(kv: KeyedLike, js?: StorageLike) {
    this.kv = keyedOf(kv, js);
  }
  static async create(js: StorageLike): Promise<VisitorStore> {
    return new VisitorStore(await storageOf(js).keyed("mesh_visitors"));
  }
  async get(key: string): Promise<VisitorRecord | null> {
    const e = await this.kv.get(key);
    if (!e || e.operation === "DEL" || e.operation === "PURGE" || !e.value?.length) return null;
    return e.json<VisitorRecord>();
  }
  async put(rec: VisitorRecord): Promise<void> {
    await this.kv.put(rec.key, JSON.stringify(rec));
  }
  async remove(key: string): Promise<void> {
    await this.kv.purge(key);
  }
  async all(): Promise<VisitorRecord[]> {
    const snap = await this.kv.list();
    const out: VisitorRecord[] = [];
    for (const [, e] of snap.entries) {
      try { out.push(e.json<VisitorRecord>()); } catch { /* an unreadable record is skipped */ }
    }
    return out;
  }
}

/** The same in memory, for tests. */
export class MemoryVisitors implements VisitorList {
  readonly map = new Map<string, VisitorRecord>();
  async get(k: string) { return this.map.get(k) ?? null; }
  async put(r: VisitorRecord) { this.map.set(r.key, { ...r }); }
  async remove(k: string) { this.map.delete(k); }
  async all() { return [...this.map.values()]; }
}

/** Whether a visitor record still answers for its key: its pass has not been
 *  over for longer than the grace (§21.19). */
export function visitorCurrent(rec: VisitorRecord | null, now = Date.now()): boolean {
  return !!rec && Date.parse(rec.pass_expires_at) + VISITOR_GRACE_MS > now;
}

/** What a visitor signs to ask this mesh for a pass (§21.15). */
export function visitStatement(ts: number, key: string, meshUrl: string): string {
  return `mesh-visit-v1:${ts}:${key}:${meshUrl}`;
}

/** A control plane URL reduced to its origin, so `https://x/` and `https://x`
 *  are one mesh. Null for anything that is not an http(s) URL. */
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

const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export interface VisitDeps {
  /** This mesh's control plane URL (MESH_PUBLIC_URL). */
  self: string;
  visitors: VisitorList;
  mintSeed: () => { ok: true; seed: string } | { ok: false; status: number; error: string };
  issuerAccount?: string;
  /** The `mesh` object a credential comes back with (mesh-object.ts). */
  meshInfo: () => Record<string, unknown>;
  /** The visitor's mailbox (registry/inbox-buffer.ts). Null: live-only. */
  mailbox: { ensure(key: string): Promise<void>; pending(key: string): Promise<number | null>; remove(key: string): Promise<void> } | null;
  /** This mesh's own answer about the key: a refusal when it is revoked or
   *  its agent stopped here, null when neither. Throws when it cannot say. */
  localRefusal: (key: string) => Promise<{ status: number; code: string; error: string } | null>;
  /** Naming services trusted to resolve a visitor's handle, own first. */
  registrars: string[];
  /** Home hosts this mesh's operator refuses. */
  barred: string[];
  passSeconds: number;
  maxVisitors: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** The door's settings from the environment, by exact name. Null when the
 *  door is off (MESH_VISITS is not `on`) or this mesh has no public address. */
export function visitSettings(env: NodeJS.ProcessEnv): Pick<VisitDeps, "self" | "registrars" | "barred" | "passSeconds" | "maxVisitors"> | null {
  if (env.MESH_VISITS?.trim().toLowerCase() !== "on") return null;
  // The same public address the rest of the mesh API uses (mesh-api.ts).
  const self = meshOrigin(env.MESH_PUBLIC_URL ?? env.API_BASE_URL);
  if (!self) return null;
  const own = env.PAN_URL?.trim() || env.AGENTMESH_NAMING_URL?.trim();
  const registrars = [...new Set([...list(env.MESH_VISIT_REGISTRARS), ...(own ? [own] : [])].map(meshOrigin).filter((x): x is string => !!x))];
  const pass = Number(env.MESH_VISIT_PASS_SECONDS);
  const max = Number(env.MESH_VISITORS_MAX);
  return {
    self,
    registrars,
    barred: list(env.MESH_VISIT_BARRED).map((h) => h.toLowerCase()),
    passSeconds: Number.isFinite(pass) && pass > 0 ? Math.min(Math.floor(pass), 3600) : 3600,
    maxVisitors: Number.isFinite(max) && max > 0 ? Math.floor(max) : 200,
  };
}

type Refusal = { status: number; code: string; error: string };
const refuse = (status: number, code: string, error: string): Refusal => ({ status, code, error });

export function visitDoor(deps: VisitDeps) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = () => (deps.now ?? Date.now)();
  const perAddress = new RateLimiter(30, 3600_000);
  const perKey = new RateLimiter(12, 3600_000);
  const registrarKeys = new Map<string, { at: number; keys: string[] }>();

  async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(6000) });
    const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: r.status, body };
  }

  /** The naming service's card-signing keys, kept an hour. `fresh` reads them
   *  again: a key not in the kept list may be one the service rotated to. */
  async function signingKeys(registrar: string, fresh = false): Promise<string[]> {
    const hit = registrarKeys.get(registrar);
    if (!fresh && hit && now() - hit.at < 3600_000) return hit.keys;
    const { status, body } = await getJson(`${registrar}/api/registrar-key`);
    if (status !== 200 || !body) throw new Error("the registrar's keys could not be read");
    const keys = [
      ...(Array.isArray(body.keys) ? body.keys : []),
      ...(Array.isArray(body.key_set) ? (body.key_set as Array<{ key?: unknown }>).map((k) => k?.key) : []),
    ].filter((k): k is string => typeof k === "string" && k.length > 0);
    if (!keys.length) throw new Error("the registrar named no keys");
    registrarKeys.set(registrar, { at: now(), keys });
    return keys;
  }

  /** Check 1: the card. Returns the home mesh, or a refusal. Throws when the
   *  naming service cannot be asked. */
  async function checkCard(handle: string, key: string, registrar: string): Promise<{ home: string } | Refusal> {
    const { status, body } = await getJson(`${registrar}/api/resolve?handle=${encodeURIComponent(handle)}`);
    if (status === 404) return refuse(403, "visitor_card_invalid", `The naming service at ${registrar} has no card for ${handle}.`);
    if (status !== 200 || !body) throw new Error(`the naming service answered ${status}`);
    const card = body.card as { handle?: unknown; expires_at?: unknown; endpoints?: Array<{ protocol?: unknown; agent_id?: unknown; mesh?: unknown }> } | undefined;
    const rkey = typeof body.registrar_key === "string" ? body.registrar_key : "";
    const rsig = typeof body.registrar_sig === "string" ? body.registrar_sig : "";
    if (!card || !rkey || !rsig) return refuse(403, "visitor_card_invalid", `The card for ${handle} is not signed.`);
    if (!(await signingKeys(registrar)).includes(rkey) && !(await signingKeys(registrar, true)).includes(rkey)) return refuse(403, "visitor_card_invalid", `The card for ${handle} is signed by a key its naming service does not list.`);
    let ok = false;
    try {
      ok = nkeys.fromPublic(rkey).verify(new TextEncoder().encode(canonicalJSON(card)), new Uint8Array(Buffer.from(rsig, "base64")));
    } catch { ok = false; }
    if (!ok) return refuse(403, "visitor_card_invalid", `The card for ${handle} does not verify against its naming service's signature.`);
    if (card.handle !== handle) return refuse(403, "visitor_card_invalid", `The card answered for ${handle} names ${String(card.handle)}.`);
    if (typeof card.expires_at === "string" && Date.parse(card.expires_at) < now()) return refuse(403, "visitor_card_invalid", `The card for ${handle} has expired.`);
    const ep = (card.endpoints ?? []).find((e) => e?.protocol === "agentmesh" && e.agent_id === key);
    if (!ep) return refuse(403, "visitor_card_invalid", `The card for ${handle} does not carry this agent key.`);
    const home = meshOrigin(ep.mesh);
    if (!home) return refuse(403, "visitor_card_invalid", `The card for ${handle} names no home mesh, so there is nowhere to ask whether it stands behind this key.`);
    if (home === deps.self) return refuse(409, "visitor_card_invalid", `${handle} lives on this mesh. It connects here as one of this mesh's agents, not as a visitor.`);
    return { home };
  }

  /** Check 3: the home mesh's answer. Throws when it cannot be asked. */
  async function checkHome(home: string, key: string, ts: number, standingSig: string): Promise<Refusal | null> {
    const standing = await getJson(`${home}/v1/key-standing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_key: key, ts, sig: standingSig }),
    });
    if (standing.status === 400 || standing.status === 401) {
      return refuse(403, "visitor_not_in_standing", `Its home mesh would not answer for this key: ${String(standing.body?.error ?? standing.status)}.`);
    }
    if (standing.status !== 200 || !standing.body) throw new Error(`the home mesh's standing door answered ${standing.status}`);
    if (standing.body.enrolled !== true) return refuse(403, "visitor_not_in_standing", "Its home mesh holds no account for this key.");
    const check = await getJson(`${home}/v1/key-check/${encodeURIComponent(key)}`);
    if (check.status !== 200 || !check.body) throw new Error(`the home mesh's key check answered ${check.status}`);
    if (check.body.revoked === true) return refuse(403, "visitor_key_revoked", "Its home mesh says this key has been revoked.");
    if (typeof check.body.stopped === "string") return refuse(403, "visitor_key_revoked", `Its home mesh says this agent is ${check.body.stopped}.`);
    return null;
  }

  async function mintPass(key: string, seed: string, expSec: number): Promise<string> {
    const perms = visitorPermissions(key);
    assertNarrowVisitor(perms, key);
    const claim: Record<string, unknown> = { ...perms };
    if (deps.issuerAccount) claim.issuer_account = deps.issuerAccount;
    const acctKp = nkeys.fromSeed(new TextEncoder().encode(seed));
    return encodeUser(`visitor-${key.slice(0, 8)}`, key as never, acctKp, claim as never, { exp: expSec });
  }

  async function visit(b: Record<string, unknown> | null, ip: string): Promise<DoorAnswer> {
    const reply = (status: number, body: Record<string, unknown>): DoorAnswer => ({ status, body });
    const refused = (r: Refusal, key = ""): DoorAnswer => {
      metrics.event({ kind: "visit_refused", actor: key, meta: { reason: r.code } });
      return reply(r.status, { error: r.error, code: r.code });
    };
    const unavailable = (what: string, key: string): DoorAnswer =>
      refused(refuse(503, "visitor_check_unavailable", `Could not ${what} right now, so no pass was issued. Try again shortly.`), key);

    if (!perAddress.check(ip).allowed) return reply(429, { error: "Too many visits asked for from this address. Try again later." });
    const handle = typeof b?.handle === "string" ? b.handle.trim().toLowerCase() : "";
    const key = typeof b?.agent_key === "string" ? b.agent_key : "";
    const ts = typeof b?.ts === "number" ? b.ts : NaN;
    const sig = typeof b?.sig === "string" ? b.sig : "";
    const standingSig = typeof b?.standing_sig === "string" ? b.standing_sig : "";
    if (!handle || !NKEY.test(key) || !Number.isFinite(ts) || !sig || !standingSig) {
      return reply(400, { error: "handle, agent_key (U...), ts (unix seconds), sig and standing_sig are required" });
    }
    if (!perKey.check(key).allowed) return reply(429, { error: "Too many visits asked for by this agent. Try again later." });
    if (Math.abs(now() / 1000 - ts) > 600) return reply(401, { error: "stale timestamp, re-sign with the current time" });
    if (!verifyAgentSig(key, visitStatement(ts, key, deps.self), sig)) {
      return reply(401, { error: `sig does not verify against agent_key over ${visitStatement(ts, key, deps.self).replace(String(ts), "<ts>")}` });
    }

    const registrar = b?.registrar === undefined ? deps.registrars[0] : meshOrigin(b.registrar);
    if (!registrar) return refused(refuse(501, "visitor_card_invalid", "This mesh trusts no naming service to resolve a visitor's name, so it takes no visitors."), key);
    if (!deps.registrars.includes(registrar)) return refused(refuse(403, "visitor_card_invalid", `This mesh does not resolve names at ${registrar}. It trusts: ${deps.registrars.join(", ")}.`), key);

    let card: { home: string } | Refusal;
    try { card = await checkCard(handle, key, registrar); } catch { return unavailable("read the visitor's card at its naming service", key); }
    if ("code" in card) return refused(card, key);
    const home = card.home;
    if (deps.barred.includes(new URL(home).host.toLowerCase())) return refused(refuse(403, "visitor_home_barred", `This mesh's operator takes no visitors from ${new URL(home).host}.`), key);

    let homeRefusal: Refusal | null;
    try { homeRefusal = await checkHome(home, key, ts, standingSig); } catch { return unavailable(`ask ${home} about this key`, key); }
    if (homeRefusal) return refused(homeRefusal, key);

    let local: Refusal | null;
    try { local = await deps.localRefusal(key); } catch { return unavailable("check this mesh's own records for this key", key); }
    if (local) return refused(local, key);

    let prior: VisitorRecord | null;
    let count: number;
    try {
      prior = await deps.visitors.get(key);
      count = prior ? 0 : (await deps.visitors.all()).length;
    } catch { return unavailable("read this mesh's visitor records", key); }
    if (!prior && count >= deps.maxVisitors) return refused(refuse(503, "visitor_capacity", "This mesh has as many visitors as it takes right now. Try again later."), key);

    const seedRead = deps.mintSeed();
    if (!seedRead.ok) return reply(seedRead.status, { error: seedRead.error });
    const expSec = Math.floor(now() / 1000) + deps.passSeconds;
    let jwt: string;
    try { jwt = await mintPass(key, seedRead.seed, expSec); } catch (err) {
      console.error(`[visit] the pass for ${key.slice(0, 12)}… could not be minted: ${(err as Error).message}`);
      return reply(500, { error: "The pass could not be minted." });
    }
    const at = new Date(now()).toISOString();
    const expiresAt = new Date(expSec * 1000).toISOString();
    try {
      await deps.visitors.put({
        key, handle, home_mesh: home,
        first_at: prior?.first_at ?? at, last_at: at, pass_expires_at: expiresAt,
        passes: (prior?.passes ?? 0) + 1,
      });
    } catch { return unavailable("record this visit", key); }
    // The mailbox (§21.19). Never fails a visit: without it the visit is live-only.
    await deps.mailbox?.ensure(key).catch(() => undefined);
    metrics.event({ kind: "visit", actor: key, meta: { home, handle } });
    console.log(`[visit] ${handle} (${key.slice(0, 12)}…) from ${home} visits, pass until ${expiresAt}`);
    return reply(200, {
      ok: true,
      jwt,
      agent_key: key,
      handle,
      home_mesh: home,
      expires_at: expiresAt,
      mesh: deps.meshInfo(),
    });
  }

  /** Remove the mailbox and record of every visitor whose grace has run out:
   *  at once when its mailbox is empty, else when the mailbox's own retention
   *  would have dropped what is in it. Returns how many were removed. */
  async function sweep(): Promise<number> {
    let all: VisitorRecord[];
    try { all = await deps.visitors.all(); } catch { return 0; }
    let removed = 0;
    for (const rec of all) {
      const over = Date.parse(rec.pass_expires_at);
      if (!(over + VISITOR_GRACE_MS < now())) continue;
      const waiting = deps.mailbox ? await deps.mailbox.pending(rec.key).catch(() => null) : 0;
      if (waiting !== 0 && over + VISITOR_MAX_KEEP_MS > now()) continue;
      await deps.mailbox?.remove(rec.key).catch(() => undefined);
      await deps.visitors.remove(rec.key).catch(() => undefined);
      removed++;
    }
    if (removed) console.log(`[visit] the sweep removed ${removed} visitor${removed === 1 ? "" : "s"} whose visits ended`);
    return removed;
  }

  return { visit, sweep };
}

export type VisitDoor = ReturnType<typeof visitDoor>;
