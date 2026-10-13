/**
 * Admission on the agent's own side (EXT-6): who may reach this agent, the
 * senders waiting at its door, and an inbox the agent reads in its own time.
 *
 * EXT-6 §7 puts the authority with the recipient's own client: it keeps the
 * roster, signed by the owner key, applies `allow`, `hold` and `block`, and
 * runs the review of held senders. The mesh's admission service (a guarded
 * inbox) enforces only a projection of the roster: it drops what the roster
 * blocks before delivery. Before 0.60.0 the SDK had none of the client's part,
 * so a program could knock on other agents but could not be knocked on, see
 * who was waiting, or let anyone in. This module is that part, held to the
 * same rules as the reference adapter:
 *
 *  - A knock (§9.3) carries no words. It puts the sender on the waiting list,
 *    once per sender per day and at most 50 a day, and every knock gets the
 *    same answer, so a sender cannot tell "waiting" from "blocked".
 *  - A message from a sender the roster does not cover meets the `registered`
 *    default, `hold` unless the owner chose otherwise. A held message waits
 *    beside its sender's entry on the waiting list and is answered with the
 *    §6.4a queued acknowledgement, the same words whatever happens to it.
 *  - `admit` writes an `allow` entry, re-signs the roster, and moves what the
 *    sender already sent into the inbox. `block` writes a `block` entry and
 *    drops it.
 *  - A message answering one this agent sent (to an agent it wrote to) is
 *    solicited and goes through, as the adapter does it.
 *  - Every change to the roster is signed here and, when the server offers it,
 *    stored on the mesh (PUT /v1/rosters/:owner), so a guarded inbox drops a
 *    blocked sender's mail before it arrives.
 *
 * Nothing here calls a model. The state is small JSON: keep it with
 * `fileAdmissionStore`, or any `AdmissionStore` of your own.
 */
import { ADMISSION_ROSTER_SIG_PREFIX, canonicalJSON, signTagged, verifyTagged, type KeyPair } from "./internal/identity.js";

/** What the roster says to do with a sender (EXT-6 §5). */
export type AdmissionStance = "allow" | "hold" | "block";

/** One sender the roster names, by agent id (or handle). */
export interface AdmissionRosterEntry {
  subject: string;
  stance: AdmissionStance;
  note?: string;
  updated_at: string;
  [extra: string]: unknown;
}

/** The admission roster (EXT-6 §3): the owner's policy, signed by the owner key. */
export interface AdmissionRoster {
  admission: "v1";
  owner_key: string;
  /** Per tier: `registered` (a verified agent unknown to you) and `anonymous`. */
  defaults: Record<string, AdmissionStance>;
  limits?: { per_sender_per_hour?: number; inbound_model_budget_per_day?: number };
  entries: AdmissionRosterEntry[];
  updated_at: string;
  /** Standard base64 of the owner key's signature over the tagged canonical document. */
  sig?: string;
}

/** A sender waiting at this agent's door: what `contacts.waiting()` lists. */
export interface WaitingSender {
  /** The sender's handle, or its agent id when it has none. admit and block take it. */
  name: string;
  agent_id: string;
  first_asked: string;
  last_asked: string;
  times: number;
  /** The first line of what they sent; absent for a knock, which carries no words. */
  said?: string;
  /** What they said about how they found this agent. It is their claim. */
  found_you_by?: string;
  /** What a knock asked to be allowed to do, from the enumerated grants. */
  grants?: string[];
  /** Why it is held. */
  why_held?: string;
}

/** A message in this agent's inbox: what `messages.inbox()` lists. */
export interface InboxMessage {
  /** The message's id: the id of the request that carried it. reply and dismiss take it. */
  id: string;
  /** The sender's agent id. */
  from: string;
  handle?: string;
  /** What the sender wrote: the input's text, or the input itself as JSON. */
  text: string;
  received_at: string;
  /** "message", or "reply" for an answer to a message this agent sent. */
  kind: "message" | "reply";
  /** The offering it was sent to. */
  offering: string;
  /** The input exactly as it arrived, for a program that reads structured input. */
  input?: unknown;
  /** For a reply: the id of this agent's message it answers. */
  in_reply_to?: string;
  task_id?: string;
  context_id?: string;
  /** Set once messages.reply answered it. */
  replied_at?: string;
}

/** A message held at the door until its sender is let in or blocked. */
export interface HeldMessage {
  id: string;
  from: string;
  received_at: string;
  offering: string;
  input: unknown;
  task_id?: string;
  context_id?: string;
}

interface WaitingRecord {
  agent_id: string;
  handle?: string;
  first_asked: string;
  last_asked: string;
  times: number;
  said?: string;
  found_you_by?: string;
  grants?: string[];
  why_held?: string;
}

/** Everything admission keeps. */
export interface AdmissionState {
  roster: AdmissionRoster;
  waiting: WaitingRecord[];
  held: HeldMessage[];
  inbox: InboxMessage[];
  /** Knocks counted today: day (YYYY-MM-DD) and the senders that knocked. */
  knocks?: { day: string; from: string[] };
}

/** Where admission keeps its state between runs. */
export interface AdmissionStore {
  load(): Promise<AdmissionState | null> | AdmissionState | null;
  save(state: AdmissionState): Promise<void> | void;
}

/** What `mesh.admission.start()` takes. */
export interface AdmissionOptions {
  /** Where the roster, the waiting list and the inbox are kept. Default: memory only. */
  store?: AdmissionStore;
  /** What a sender the roster does not cover gets. Default: `hold`. */
  registered?: AdmissionStance;
  /** Put messages that arrive for an offering with no handler in the inbox,
   *  answered with the §6.4a queued acknowledgement, instead of refusing them
   *  with OFFERING_NOT_FOUND. Default false. Released held messages always go
   *  to the inbox. */
  inbox?: boolean;
  /** Called when a new sender starts waiting, so the owner can be told. */
  onWaiting?: (sender: WaitingSender) => void;
  /** Store the signed roster on the mesh after each change, so a guarded
   *  inbox enforces it (PUT /v1/rosters/:owner). Default true; a server
   *  without the route is skipped quietly. */
  syncRoster?: boolean;
}

/** `mesh.admission`: turning admission on, and reading where it stands. */
export interface AdmissionControl {
  /** Turn admission on for this agent (or again, with new options). */
  start(opts?: AdmissionOptions): Promise<void>;
  /** Whether it is on. */
  running(): boolean;
  /** The signed roster, or null while admission is off. */
  roster(): AdmissionRoster | null;
  /** Wait until every change has been written to the store. */
  flush(): Promise<void>;
}

/** What `mesh.describe()` answers (§10.14): the agent's public card. */
export interface DescribeDocument {
  agent_id: string;
  /** The agent's name card as its naming service signed it, when it has one. */
  card?: Record<string, unknown>;
  /** The manifest's `public` block, verbatim: the storefront (§8.7). */
  public?: Record<string, unknown>;
  name?: string;
  owner?: string;
  interaction?: string;
  sealing?: string;
  data_use?: unknown;
  compliance?: unknown;
  /** false when a private agent declined to describe itself. */
  described?: false;
  visibility?: string;
  reason?: string;
  [extra: string]: unknown;
}

/** The enumerated grants a knock may ask for (EXT-6 §6.1). */
export const KNOCK_GRANT_NAMES = ["messages", "scheduling", "share", "errands"] as const;

const HELD_PER_SENDER = 20;
const HELD_MAX = 500;
const WAITING_MAX = 200;
const INBOX_MAX = 1000;
const KNOCKS_PER_DAY = 50;
const TEXT_MAX = 64 * 1024;
const AGENT_ID_RE = /^U[A-Z2-7]{55}$/;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Sign a roster with the owner key: standard base64 over
 *  `agentmesh-admission-roster-v1` + LF + the canonical document, `sig`
 *  excluded (EXT-6 §3). Returns a new object. */
export function signAdmissionRoster(roster: AdmissionRoster, ownerKey: KeyPair): AdmissionRoster {
  const { sig: _old, ...body } = roster;
  const signature = signTagged(ownerKey, ADMISSION_ROSTER_SIG_PREFIX, canonicalJSON(body));
  return { ...body, sig: toBase64(signature) } as AdmissionRoster;
}

/** Whether a roster is signed by the owner key it names. */
export function verifyAdmissionRoster(roster: unknown): roster is AdmissionRoster {
  const r = roster as Partial<AdmissionRoster> | null;
  if (!r || typeof r !== "object" || typeof r.sig !== "string" || typeof r.owner_key !== "string") return false;
  const { sig, ...body } = r;
  try {
    return verifyTagged(r.owner_key, ADMISSION_ROSTER_SIG_PREFIX, canonicalJSON(body), fromBase64(sig));
  } catch {
    return false;
  }
}

/** Admission state in a JSON file (Node.js only). Written whole, through a
 *  temporary file, so a crash mid-write leaves the last good copy. */
export function fileAdmissionStore(path: string): AdmissionStore {
  return {
    async load() {
      const fs = await import("node:fs/promises");
      try {
        return JSON.parse(await fs.readFile(path, "utf8")) as AdmissionState;
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") return null;
        throw err;
      }
    },
    async save(state) {
      const fs = await import("node:fs/promises");
      const tmp = `${path}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      await fs.rename(tmp, path);
    },
  };
}

/** The text of an input, for the inbox and the waiting list. */
export function textOfInput(input: unknown): string {
  if (typeof input === "string") return input.slice(0, TEXT_MAX);
  const t = (input as { text?: unknown } | null)?.text;
  if (typeof t === "string") return t.slice(0, TEXT_MAX);
  try {
    return JSON.stringify(input ?? null).slice(0, TEXT_MAX);
  } catch {
    return "";
  }
}

function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => l.trim())?.trim();
  return line ? line.slice(0, 200) : undefined;
}

/** What a knock's input may carry: `via` (at most 80 characters) and `grants`
 *  (names from KNOCK_GRANT_NAMES), nothing else (EXT-6 §9.3). */
export function readKnockInput(input: unknown): { ok: true; via?: string; grants: string[] } | { ok: false; why: string } {
  if (input === undefined || input === null) return { ok: true, grants: [] };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, why: "A knock carries no message: its input is empty, or only via and grants." };
  const o = input as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "via" && k !== "grants");
  if (extra.length) return { ok: false, why: `A knock carries no message: ${extra.join(", ")} cannot ride on one. Say it after you are let in.` };
  if (o.via !== undefined && (typeof o.via !== "string" || o.via.length > 80)) return { ok: false, why: "via is a few words, at most 80 characters." };
  const grants = o.grants === undefined ? [] : Array.isArray(o.grants) ? o.grants : [o.grants];
  if (grants.some((g) => typeof g !== "string" || !(KNOCK_GRANT_NAMES as readonly string[]).includes(g))) {
    return { ok: false, why: `grants are names from this list only: ${KNOCK_GRANT_NAMES.join(", ")}.` };
  }
  return { ok: true, ...(typeof o.via === "string" && o.via ? { via: o.via } : {}), grants: grants as string[] };
}

const now = (): string => new Date().toISOString();
const today = (): string => now().slice(0, 10);

/**
 * The client's part of admission for one agent: the roster, the waiting list,
 * the held messages and the inbox. It decides and remembers; the AgentMesh
 * that holds it does the sending.
 */
export class AdmissionGate {
  private state: AdmissionState;
  private saving: Promise<void> = Promise.resolve();
  /** Agents this agent wrote to, and when: their answers are solicited. */
  private addressed = new Map<string, number>();

  private constructor(
    private readonly agentId: string,
    private readonly key: KeyPair,
    private readonly opts: AdmissionOptions,
    state: AdmissionState,
  ) {
    this.state = state;
  }

  /** Load (or begin) the state for one agent. A stored roster that does not
   *  verify against this agent's key is not used: the defaults apply, as
   *  EXT-6 §3 says a consumer must do with an invalid roster. */
  static async open(agentId: string, key: KeyPair, opts: AdmissionOptions = {}): Promise<AdmissionGate> {
    const loaded = opts.store ? await opts.store.load() : null;
    const fresh = (): AdmissionRoster =>
      signAdmissionRoster(
        { admission: "v1", owner_key: agentId, defaults: { registered: opts.registered ?? "hold", anonymous: "block" }, entries: [], updated_at: now() },
        key,
      );
    const roster = loaded?.roster && loaded.roster.owner_key === agentId && verifyAdmissionRoster(loaded.roster) ? loaded.roster : fresh();
    const gate = new AdmissionGate(agentId, key, opts, {
      roster,
      waiting: Array.isArray(loaded?.waiting) ? loaded.waiting : [],
      held: Array.isArray(loaded?.held) ? loaded.held : [],
      inbox: Array.isArray(loaded?.inbox) ? loaded.inbox : [],
      ...(loaded?.knocks ? { knocks: loaded.knocks } : {}),
    });
    // A default the caller asked for that the stored roster does not have.
    if (opts.registered && roster.defaults.registered !== opts.registered) {
      gate.setRoster({ ...roster, defaults: { ...roster.defaults, registered: opts.registered } });
    }
    return gate;
  }

  /** Whether messages for an offering with no handler go to the inbox. */
  get collectsUnhandled(): boolean {
    return this.opts.inbox === true;
  }

  /** The signed roster, as it is now. */
  roster(): AdmissionRoster {
    return this.state.roster;
  }

  /** Remember that this agent wrote to `agentId`, so its answers get through. */
  noteAddressed(agentId: string): void {
    this.addressed.set(agentId, Date.now());
    if (this.addressed.size > 5000) this.addressed.delete(this.addressed.keys().next().value!);
  }

  private entryFor(sender: string): AdmissionRosterEntry | undefined {
    return this.state.roster.entries.find((e) => e.subject === sender);
  }

  /** What to do with a message from `from` (EXT-6 §4, §5). */
  stanceFor(from: string): AdmissionStance {
    const entry = this.entryFor(from);
    if (entry) return entry.stance;
    const at = this.addressed.get(from);
    if (at !== undefined && Date.now() - at < 30 * 24 * 3600_000) return "allow";
    return this.state.roster.defaults.registered ?? "hold";
  }

  /**
   * A knock from `from`. Returns what the knocker is told: the same
   * `{ received: true }` whether it is now waiting, was waiting already, or is
   * blocked, and `admitted: true` only for a sender already let in, so it
   * sends instead of waiting.
   */
  knock(from: string, input: { via?: string; grants: string[] }, handle?: string): { received: true; admitted?: true } {
    const entry = this.entryFor(from);
    if (entry?.stance === "allow") return { received: true, admitted: true };
    if (entry?.stance === "block") return { received: true };
    const day = today();
    const k = this.state.knocks?.day === day ? this.state.knocks : { day, from: [] as string[] };
    if (k.from.includes(from) || k.from.length >= KNOCKS_PER_DAY) return { received: true };
    k.from.push(from);
    this.state.knocks = k;
    this.noteWaiting(from, { handle, via: input.via, grants: input.grants });
    return { received: true };
  }

  /** Hold one message from a sender the roster does not let in yet. */
  hold(msg: HeldMessage, handle?: string): void {
    if (this.entryFor(msg.from)?.stance === "block") return;
    const mine = this.state.held.filter((h) => h.from === msg.from);
    if (mine.length >= HELD_PER_SENDER) return;
    this.state.held.push(msg);
    while (this.state.held.length > HELD_MAX) this.state.held.shift();
    this.noteWaiting(msg.from, { handle, said: firstLine(textOfInput(msg.input)), why: "unknown sender" });
  }

  private noteWaiting(from: string, o: { handle?: string; via?: string; grants?: string[]; said?: string; why?: string }): void {
    const at = now();
    let w = this.state.waiting.find((x) => x.agent_id === from);
    const isNew = !w;
    if (!w) {
      w = { agent_id: from, first_asked: at, last_asked: at, times: 0 };
      this.state.waiting.push(w);
      while (this.state.waiting.length > WAITING_MAX) this.state.waiting.shift();
    }
    w.last_asked = at;
    w.times += 1;
    if (o.handle) w.handle = o.handle;
    if (o.via && !w.found_you_by) w.found_you_by = o.via;
    if (o.grants?.length) w.grants = o.grants;
    if (o.said && !w.said) w.said = o.said;
    if (o.why && !w.why_held) w.why_held = o.why;
    this.persist();
    if (isNew) {
      try { this.opts.onWaiting?.(this.view(w)); } catch { /* the host's callback */ }
    }
  }

  private view(w: WaitingRecord): WaitingSender {
    return {
      name: w.handle ?? w.agent_id,
      agent_id: w.agent_id,
      first_asked: w.first_asked,
      last_asked: w.last_asked,
      times: w.times,
      ...(w.said ? { said: w.said } : {}),
      ...(w.found_you_by ? { found_you_by: w.found_you_by } : {}),
      ...(w.grants?.length ? { grants: w.grants } : {}),
      ...(w.why_held ? { why_held: w.why_held } : {}),
    };
  }

  /** Who is waiting, longest first. */
  waiting(): WaitingSender[] {
    return [...this.state.waiting].sort((a, b) => a.first_asked.localeCompare(b.first_asked)).map((w) => this.view(w));
  }

  /** The agent id a name refers to: an agent id as itself, or a waiting
   *  sender's handle. Null when nobody by that name is known here. */
  resolve(sender: string): string | null {
    const s = sender.trim();
    if (AGENT_ID_RE.test(s)) return s;
    const w = this.state.waiting.find((x) => x.handle && x.handle.toLowerCase() === s.toLowerCase());
    return w?.agent_id ?? null;
  }

  private setStance(agentId: string, stance: AdmissionStance, note?: string): void {
    const r = this.state.roster;
    const entries = r.entries.filter((e) => e.subject !== agentId);
    entries.push({ subject: agentId, stance, ...(note ? { note } : {}), updated_at: now() });
    this.setRoster({ ...r, entries });
  }

  private setRoster(next: AdmissionRoster): void {
    this.state.roster = signAdmissionRoster({ ...next, updated_at: now() }, this.key);
    this.persist();
  }

  /** Let a sender in. Its held messages move to the inbox, which is returned
   *  in the count. */
  admit(agentId: string, note?: string): { name: string; released: number } {
    const w = this.state.waiting.find((x) => x.agent_id === agentId);
    this.setStance(agentId, "allow", note);
    const mine = this.state.held.filter((h) => h.from === agentId);
    this.state.held = this.state.held.filter((h) => h.from !== agentId);
    for (const h of mine) {
      this.file({
        id: h.id, from: h.from, ...(w?.handle ? { handle: w.handle } : {}), text: textOfInput(h.input), received_at: h.received_at,
        kind: "message", offering: h.offering, input: h.input,
        ...(h.task_id ? { task_id: h.task_id } : {}), ...(h.context_id ? { context_id: h.context_id } : {}),
      });
    }
    this.state.waiting = this.state.waiting.filter((x) => x.agent_id !== agentId);
    this.persist();
    return { name: w?.handle ?? agentId, released: mine.length };
  }

  /** Keep a sender out. What it already sent is dropped. */
  block(agentId: string, note?: string): { name: string; dropped: number } {
    const w = this.state.waiting.find((x) => x.agent_id === agentId);
    this.setStance(agentId, "block", note);
    const dropped = this.state.held.filter((h) => h.from === agentId).length;
    this.state.held = this.state.held.filter((h) => h.from !== agentId);
    this.state.waiting = this.state.waiting.filter((x) => x.agent_id !== agentId);
    this.persist();
    return { name: w?.handle ?? agentId, dropped };
  }

  /** Put a message in the inbox. A message already there is not filed twice. */
  file(m: InboxMessage): void {
    if (this.state.inbox.some((x) => x.id === m.id && x.from === m.from)) return;
    this.state.inbox.push(m);
    while (this.state.inbox.length > INBOX_MAX) {
      const i = this.state.inbox.findIndex((x) => x.replied_at);
      this.state.inbox.splice(i >= 0 ? i : 0, 1);
    }
    this.persist();
  }

  /** The messages waiting in the inbox, oldest first. */
  inbox(): InboxMessage[] {
    return this.state.inbox.map((m) => ({ ...m }));
  }

  /** One inbox message, by id. */
  message(id: string): InboxMessage | undefined {
    return this.state.inbox.find((m) => m.id === id);
  }

  /** Note that a message was answered. It stays until it is dismissed. */
  markReplied(id: string): void {
    const m = this.state.inbox.find((x) => x.id === id);
    if (m) { m.replied_at = now(); this.persist(); }
  }

  /** Clear messages out of the inbox. Returns how many were there. */
  dismiss(ids: string[]): number {
    const drop = new Set(ids);
    const before = this.state.inbox.length;
    this.state.inbox = this.state.inbox.filter((m) => !drop.has(m.id));
    const n = before - this.state.inbox.length;
    if (n) this.persist();
    return n;
  }

  /** Writes are queued one after another, so the last one written is the last state. */
  private persist(): void {
    const store = this.opts.store;
    if (!store) return;
    const snapshot = JSON.parse(JSON.stringify(this.state)) as AdmissionState;
    this.saving = this.saving.then(() => store.save(snapshot)).catch(() => {});
  }

  /** Wait for every queued write. */
  async flush(): Promise<void> {
    await this.saving;
  }
}
