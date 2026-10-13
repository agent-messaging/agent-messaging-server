/**
 * Connections between two people's agents (the owner, 2026-10-01): the grant
 * names, the four presets, the narrowing rule, and what a message needs.
 *
 * A connection is mutual, scoped admission that two people agree to. Each
 * side's roster carries an entry for the other side's agent with `grants`
 * (EXT-6 next version) and an `expires_at`. The grants are enumerated names,
 * never prose, so a door can check them for free before any model runs.
 *
 *   messages    plain messages (text, no files)
 *   scheduling  scheduling asks only: proposing or answering a time
 *   share       files and documents riding a message
 *   errands     orders: a request to do something that may spend money,
 *               each one held for the receiving owner's OK, and refused
 *               outright above the connection's spend limit
 *
 * Pure: nothing here reads a store or the network, so every rule is tested on
 * its own (connections-grants.test.ts).
 */

export const GRANT_NAMES = ["messages", "scheduling", "share", "errands"] as const;
export type GrantName = (typeof GRANT_NAMES)[number];

export const PRESET_NAMES = ["messages", "scheduling", "share", "errands"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

/** What each preset grants. Share and Errands include plain messages,
 *  because a file or an order with no way to say a word about it is not
 *  something people use. Scheduling does not: it is the narrow one. */
export const PRESETS: Readonly<Record<PresetName, readonly GrantName[]>> = Object.freeze({
  messages: ["messages"],
  scheduling: ["scheduling"],
  share: ["messages", "share"],
  errands: ["messages", "errands"],
});

/** The preset's name as a person reads it. */
export const PRESET_LABELS: Readonly<Record<PresetName, string>> = Object.freeze({
  messages: "Messages",
  scheduling: "Scheduling",
  share: "Share",
  errands: "Errands",
});

/** The spend limit an Errands connection starts with, in US cents, when the
 *  inviter names none: $25. */
export const DEFAULT_SPEND_LIMIT_CENTS = 2500;
/** The highest spend limit a connection may carry: $500. Above that is a
 *  purchase, which goes through a proper agreement, not a connection. */
export const MAX_SPEND_LIMIT_CENTS = 50_000;

export function isGrantName(x: unknown): x is GrantName {
  return typeof x === "string" && (GRANT_NAMES as readonly string[]).includes(x);
}

export function isPresetName(x: unknown): x is PresetName {
  return typeof x === "string" && (PRESET_NAMES as readonly string[]).includes(x);
}

/**
 * Read a list of grant names. Null when anything in it is not one of the
 * enumerated names, or it is not a list: a door that met an unknown name and
 * dropped it would quietly change what the other side asked for. The result
 * is de-duplicated and in the canonical order, so two equal scopes compare
 * equal as strings.
 */
export function readGrants(raw: unknown): GrantName[] | null {
  if (!Array.isArray(raw) || raw.length > GRANT_NAMES.length * 2) return null;
  if (!raw.every(isGrantName)) return null;
  const set = new Set(raw as GrantName[]);
  return GRANT_NAMES.filter((g) => set.has(g));
}

/** A spend limit in cents: a whole number from 0 to the maximum, or null. */
export function readSpendLimit(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_SPEND_LIMIT_CENTS) return null;
  return raw;
}

/** What a connection allows, as both rosters carry it. */
export interface Scope {
  grants: GrantName[];
  /** Errands only: the most one order may ask for, in US cents. */
  spend_limit_cents?: number;
  /** When the connection ends by itself; null or absent means until revoked. */
  expires_at?: string | null;
  /** Two-way: both agents may reach each other. One-way: only the person who
   *  accepted reaches the inviter's agent; the inviter's agent does not get
   *  an entry on the acceptor's roster. */
  two_way: boolean;
}

/** The scope a preset offers. */
export function presetScope(preset: PresetName, opts: { two_way?: boolean; spend_limit_cents?: number; expires_at?: string | null } = {}): Scope {
  const grants = [...PRESETS[preset]];
  return {
    grants,
    ...(grants.includes("errands") ? { spend_limit_cents: opts.spend_limit_cents ?? DEFAULT_SPEND_LIMIT_CENTS } : {}),
    expires_at: opts.expires_at ?? null,
    two_way: opts.two_way ?? true,
  };
}

/**
 * The narrowing rule: the acceptor (and later either side) may narrow a
 * scope, never widen it. Narrower means every grant is one the offer had, a
 * spend limit no higher, an end no later (an offer that ends cannot be made
 * open-ended), and one-way where the offer was one-way.
 *
 * Returns why not, in a sentence, or null when `chosen` is within `offered`.
 */
export function wideningProblem(offered: Scope, chosen: Scope): string | null {
  const extra = chosen.grants.filter((g) => !offered.grants.includes(g));
  if (extra.length) return `The offer does not include ${extra.join(" or ")}. You can remove what is offered, not add to it.`;
  if (!chosen.grants.length) return "Keep at least one thing the connection allows, or decline it instead.";
  if (chosen.grants.includes("errands")) {
    const o = offered.spend_limit_cents ?? 0;
    const c = chosen.spend_limit_cents ?? o;
    if (c > o) return `The spend limit can go down from $${(o / 100).toFixed(2)}, not up.`;
  }
  if (offered.expires_at) {
    if (!chosen.expires_at) return "The offer ends on a date; it cannot be made to last until revoked.";
    if (Date.parse(chosen.expires_at) > Date.parse(offered.expires_at)) return "The connection can end sooner than offered, not later.";
  }
  if (!offered.two_way && chosen.two_way) return "The offer is one-way; it cannot be made two-way.";
  return null;
}

/** Build the narrowed scope from what a person sent: absent fields keep the
 *  offer's value. Null with a sentence when a field is malformed. */
export function narrowedScope(offered: Scope, raw: { grants?: unknown; spend_limit_cents?: unknown; expires_at?: unknown; two_way?: unknown }): { scope: Scope } | { error: string } {
  const grants = raw.grants === undefined ? offered.grants : readGrants(raw.grants);
  if (!grants) return { error: `Grants are names from this list: ${GRANT_NAMES.join(", ")}.` };
  let spend = offered.spend_limit_cents;
  if (raw.spend_limit_cents !== undefined) {
    const s = readSpendLimit(raw.spend_limit_cents);
    if (s === null) return { error: `A spend limit is a whole number of cents from 0 to ${MAX_SPEND_LIMIT_CENTS}.` };
    spend = s;
  }
  let expires = offered.expires_at ?? null;
  if (raw.expires_at !== undefined) {
    if (raw.expires_at === null) expires = null;
    else if (typeof raw.expires_at !== "string" || !Number.isFinite(Date.parse(raw.expires_at))) return { error: "An end date is an ISO date and time." };
    else expires = new Date(Date.parse(raw.expires_at)).toISOString();
  }
  const twoWay = raw.two_way === undefined ? offered.two_way : raw.two_way === true;
  const scope: Scope = {
    grants,
    ...(grants.includes("errands") ? { spend_limit_cents: spend ?? 0 } : {}),
    expires_at: expires,
    two_way: twoWay,
  };
  const problem = wideningProblem(offered, scope);
  return problem ? { error: problem } : { scope };
}

/** What one inbound message would do, read off its request payload. */
export type Act =
  | { kind: "message" }
  | { kind: "scheduling" }
  | { kind: "file"; files: number }
  | { kind: "order"; amount_cents: number | null }
  | { kind: "knock" }
  | { kind: "unknown" };

/**
 * Classify an inbound request from what it carries, never from what its words
 * say: files ride as references (§7.5), an order as an `order` object, a
 * scheduling ask as `purpose: "scheduling"` or the
 * `schedule` offering. A sealed input (EXT-7) cannot be read by anyone but the
 * recipient, so an upstream door sees `unknown` and leaves the call to the
 * recipient's own client, which can read it.
 */
export function actOf(payload: unknown): Act {
  const p = payload && typeof payload === "object" ? (payload as { offering?: unknown; skill?: unknown; input?: unknown }) : {};
  const offering = typeof p.offering === "string" ? p.offering : typeof p.skill === "string" ? p.skill : "";
  if (offering === "knock") return { kind: "knock" };
  const input = p.input;
  if (input === undefined || input === null) return { kind: "message" };
  if (typeof input !== "object" || Array.isArray(input)) return typeof input === "string" ? { kind: "unknown" } : { kind: "message" };
  return actOfInput(input as Record<string, unknown>, offering);
}

/** The same reading, from the input alone (the hosted door is handed it). */
export function actOfInput(input: Record<string, unknown>, offering = "chat"): Act {
  if (typeof input.sealed === "string" || typeof input.ciphertext === "string") return { kind: "unknown" };
  // An order is said, never guessed: an `order` object. A job manifest
  // (§5.7) is a delivery of work already agreed, not a new order, and is
  // read by what rides it (files or words) like any other message.
  if (input.order !== undefined) {
    const order = input.order && typeof input.order === "object" ? (input.order as { amount_cents?: unknown }) : {};
    const raw = order.amount_cents;
    return { kind: "order", amount_cents: typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.ceil(raw) : null };
  }
  const files = Array.isArray(input.files) ? input.files.length : 0;
  if (files > 0) return { kind: "file", files };
  if (input.purpose === "scheduling" || offering === "schedule" || offering === "scheduling") return { kind: "scheduling" };
  return { kind: "message" };
}

/** A roster entry's connection part (EXT-6 next version). */
export interface GrantedEntry {
  grants?: unknown;
  expires_at?: unknown;
  spend_limit_cents?: unknown;
}

/** Whether an entry has run out. An unreadable date counts as run out: a
 *  door that cannot tell must not admit. */
export function entryExpired(e: GrantedEntry, now = Date.now()): boolean {
  if (e.expires_at === undefined || e.expires_at === null) return false;
  if (typeof e.expires_at !== "string") return true;
  const t = Date.parse(e.expires_at);
  return !Number.isFinite(t) || t <= now;
}

/** What a door does with one message from a connected sender. */
export type GrantVerdict =
  | { ok: true }
  /** Errands: held until the receiving owner says OK to this one order. */
  | { ok: "owner_ok"; amount_cents: number | null }
  | { ok: false; code: "NOT_GRANTED" | "OVER_SPEND_LIMIT"; why: string };

/** The words a refused connected sender is told. They are connected, so
 *  they are told the truth, unlike a stranger. */
function notGranted(what: string, grants: readonly GrantName[]): GrantVerdict {
  const allows = grants.length ? grants.map((g) => g).join(", ") : "nothing";
  return { ok: false, code: "NOT_GRANTED", why: `Not delivered: this connection does not allow ${what}. It allows ${allows}.` };
}

/**
 * The grant check for one message, for an entry that carries `grants`. An
 * entry without `grants` is a plain allow from before connections, which
 * allows messages and everything else it always did; callers check
 * `hasGrants` first. An `unknown` act (sealed) passes here: only the
 * recipient's own client can read it, and it applies this same function.
 */
export function permits(entry: GrantedEntry, act: Act): GrantVerdict {
  const grants = readGrants(entry.grants) ?? [];
  switch (act.kind) {
    case "knock":
    case "unknown":
      return { ok: true };
    case "message":
      return grants.includes("messages") ? { ok: true } : notGranted("plain messages", grants);
    case "scheduling":
      return grants.includes("scheduling") || grants.includes("messages") ? { ok: true } : notGranted("scheduling", grants);
    case "file":
      return grants.includes("share") ? { ok: true } : notGranted("files", grants);
    case "order": {
      if (!grants.includes("errands")) return notGranted("orders", grants);
      const limit = typeof entry.spend_limit_cents === "number" ? entry.spend_limit_cents : 0;
      if (act.amount_cents === null) {
        return { ok: false, code: "OVER_SPEND_LIMIT", why: "Not delivered: an order on this connection must say how much it may spend (amount_cents)." };
      }
      if (act.amount_cents > limit) {
        return { ok: false, code: "OVER_SPEND_LIMIT", why: `Not delivered: this order asks for $${(act.amount_cents / 100).toFixed(2)}, over the connection's limit of $${(limit / 100).toFixed(2)}.` };
      }
      return { ok: "owner_ok", amount_cents: act.amount_cents };
    }
  }
}

/** True when an entry is a connection's (carries enumerated grants). */
export function hasGrants(e: GrantedEntry): boolean {
  return Array.isArray(e.grants);
}

/**
 * A knock's content rule (Common Agent §7.1, next version): a knock carries
 * the sender's identity and MAY carry enumerated grant names, and nothing
 * else a person or a model would read. `via` (the client's short label for
 * the place the knock came from, set by the reference adapter) is kept, as
 * it always was, capped. Any other member, or any grant name outside the
 * list, refuses the whole knock: a knock that carried prose would be a
 * message that skipped the door.
 */
export function readKnock(input: unknown): { ok: true; grants: GrantName[]; via?: string } | { ok: false; why: string } {
  if (input === undefined || input === null) return { ok: true, grants: [] };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, why: "A knock carries no message. It may name what it asks for (grants), from this list only: " + GRANT_NAMES.join(", ") + "." };
  }
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== "grants" && k !== "via") {
      return { ok: false, why: `A knock carries no message, so "${k.slice(0, 40)}" cannot ride one. It may name what it asks for (grants), from this list only: ${GRANT_NAMES.join(", ")}.` };
    }
  }
  let grants: GrantName[] = [];
  if (o.grants !== undefined) {
    const g = readGrants(o.grants);
    if (!g) return { ok: false, why: `A knock's grants are names from this list only: ${GRANT_NAMES.join(", ")}.` };
    grants = g;
  }
  if (o.via !== undefined && (typeof o.via !== "string" || o.via.length > 80)) {
    return { ok: false, why: "A knock's via is the short name of the place it came from, at most 80 characters." };
  }
  return { ok: true, grants, ...(typeof o.via === "string" && o.via.trim() ? { via: o.via.trim() } : {}) };
}
