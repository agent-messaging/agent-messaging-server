import { nkeys } from "../sdk.js";
import { isKeyedStore, keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";

/** How often the whole bucket is read again. Every enumeration used to read
 *  all of mesh_held, and the counts route read it once per agent the account
 *  has (2026-09-28: 520 reads a second, core pinned at full CPU, the api
 *  down). Sharing one read for 5 seconds still cost one get per entry every 5
 *  seconds, because agents poll all the time: 594 entries made 119 reads a
 *  second.
 *
 *  So the store keeps a parsed copy and applies its own writes to it as it
 *  makes them. The api service is the only writer of mesh_held (adapters
 *  report through it), so the copy is exact; the periodic re-read is a
 *  backstop for anything written elsewhere, which shows within this window. */
const MIRROR_REFRESH_MS = 60_000;

/**
 * Held-attempt ledger: the metadata behind the console's "Waiting" list.
 *
 * When an adapter holds a first-contact message (EXT-6 stance "hold"), the
 * message body stays in the agent's local inbox — the mesh never stores it.
 * What the adapter reports here is metadata only: who knocked (sender key,
 * resolved handle/operator), when, and how often. The console shows it; the
 * owner decides; the decision is fetched by the agent, applied to its own
 * signed roster, and acked back — at which point the entry is deleted.
 *
 * Authority model mirrors the roster store: writes about agent X are
 * authorized by X's own Ed25519 signature (report/ack), reads and decisions
 * for the owning account go through the account session (core §4.9).
 *
 * Lifecycle: waiting → decided (console) → deleted (agent ack), or
 *            waiting → deleted (agent resolved it locally), or
 *            waiting → expired (TTL, senders who gave up).
 */

export interface HeldAttempt {
  agent: string;
  sender: string;
  handle: string | null;
  operator: string | null;
  first_at: string;
  last_at: string;
  count: number;
  /** Why this is waiting, when the door itself knows — a screening hold's
   *  reason (EXT-10 §6.1: the reason MUST be a sentence an owner can act
   *  on). Absent for an ordinary admission knock. */
  note?: string;
  /** The first line of the held message, at most 140 characters, the
   *  sender's own words as the adapter fenced them; absent for a knock,
   *  which carries none. Since 2026-09-14: the one deliberate narrowing of
   *  "who knocked, never what they said", because a key and a count are
   *  nothing a person can decide on. The body never reaches the mesh. */
  line?: string;
  /** How many files rode with the held message. */
  files?: number;
  /** What the sender said about how it found the agent, at most 80
   *  characters; a claim, shown as one. */
  via?: string;
  /** What a knock asked for, as enumerated grant names (Common Agent §7.1,
   *  next version; admission/grants.ts). Never prose. */
  grants?: string[];
  decision?: { stance: "allow" | "block"; decided_at: string };
}

export interface KnockFacts { line?: string; files?: number; via?: string; grants?: string[] }

const TTL_MS = 30 * 24 * 3600_000; // waiting entries expire after 30 days

/** Entries leave the store as copies, so a caller changing one cannot change
 *  the store's copy of the bucket. */
function copyOf(e: HeldAttempt): HeldAttempt {
  return { ...e, ...(e.decision ? { decision: { ...e.decision } } : {}) };
}

export class HeldStore {
  private kv: KeyedStore;
  /** Whether the store can be listed (`entriesFor`). A JetStream bucket
   *  handed in alone cannot: listing reads the backing stream's subject list
   *  and so needs the client it was opened on. The keyed get/put/purge paths
   *  need nothing more. */
  private listable: boolean;

  constructor(kv: KeyedLike, js: StorageLike | null = null) {
    this.kv = keyedOf(kv, js ?? undefined);
    this.listable = js !== null || isKeyedStore(kv);
  }

  /** The parsed bucket: a complete read plus every write made here since. */
  private mirror: Map<string, HeldAttempt> | null = null;
  private mirrorAt = 0;
  private loading: Promise<Map<string, HeldAttempt>> | null = null;
  /** Writes made while a read was in flight, which that read may not hold. */
  private seq = 0;
  private recent = new Map<string, { seq: number; value: HeldAttempt | null }>();

  /**
   * The bucket as this store knows it. The first call waits for a complete
   * read (and throws if the bucket cannot be read whole). After that the copy
   * is served at once, and a re-read starts in the background when the copy
   * is older than MIRROR_REFRESH_MS; a re-read that fails keeps the copy it
   * had. `fresh` waits for a new complete read instead, for callers whose
   * answer must not rest on a copy (account closure).
   */
  private view(opts: { fresh?: boolean } = {}): Promise<Map<string, HeldAttempt>> {
    if (!this.listable) {
      return Promise.reject(new Error(
        "HeldStore enumeration needs a JetStream client to read mesh_held; this store was constructed without one",
      ));
    }
    const stale = !this.mirror || Date.now() - this.mirrorAt >= MIRROR_REFRESH_MS;
    if ((stale || opts.fresh) && !this.loading) {
      const startSeq = this.seq;
      const load = this.kv.list().then((snap) => {
        const m = new Map<string, HeldAttempt>();
        for (const [k, entry] of snap.entries) {
          try {
            if (entry.length === 0) continue;
            m.set(k, JSON.parse(entry.string()) as HeldAttempt);
          } catch { /* skip malformed */ }
        }
        // A write made after this read began may be missing from it.
        for (const [k, w] of this.recent) {
          if (w.seq <= startSeq) continue;
          if (w.value) m.set(k, copyOf(w.value)); else m.delete(k);
        }
        this.recent.clear();
        this.mirror = m;
        this.mirrorAt = Date.now();
        return m;
      });
      this.loading = load;
      load.then(() => { this.loading = null; }, () => { this.loading = null; });
    }
    if (this.mirror && !opts.fresh) return Promise.resolve(this.mirror);
    return this.loading!;
  }

  /** Apply one of this store's own writes to the copy. */
  private wrote(key: string, value: HeldAttempt | null): void {
    this.seq++;
    if (this.loading) this.recent.set(key, { seq: this.seq, value });
    if (!this.mirror) return;
    if (value) this.mirror.set(key, copyOf(value)); else this.mirror.delete(key);
  }

  static async create(js: StorageLike): Promise<HeldStore> {
    return new HeldStore(await storageOf(js).keyed("mesh_held"), js);
  }

  /** Upsert a waiting entry: first knock creates it, repeats bump count/last_at.
   *  A repeat knock does not clear an existing console decision. */
  async report(agent: string, sender: string, handle: string | null, operator: string | null, note?: string, facts: KnockFacts = {}): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.get(agent, sender);
    // The newest words win: a repeat knock that says something replaces what
    // the last one said, and one that says nothing keeps the earlier line.
    const said = {
      ...(facts.line ? { line: facts.line, files: facts.files ?? 0 } : {}),
      ...(facts.via ? { via: facts.via } : {}),
      ...(facts.grants?.length ? { grants: facts.grants.slice(0, 8) } : {}),
    };
    const entry: HeldAttempt = existing
      ? { ...existing, handle: handle ?? existing.handle, operator: operator ?? existing.operator, last_at: now, count: existing.count + 1, ...(note ? { note } : {}), ...said }
      : { agent, sender, handle, operator, first_at: now, last_at: now, count: 1, ...(note ? { note } : {}), ...said };
    await this.kv.put(this.key(agent, sender), JSON.stringify(entry)); this.wrote(this.key(agent, sender), entry);
  }

  /** Entries still waiting on the owner (no decision yet), TTL-pruned. */
  async listWaiting(agent: string): Promise<HeldAttempt[]> {
    return (await this.list(agent)).filter((e) => !e.decision);
  }

  /**
   * Every entry still waiting on an owner, at every agent's door. For the
   * pass at start that lets the platform's own agents go (api-service.ts,
   * releasePlatformHolds). Read-only: an entry past the TTL is skipped here
   * and left for `list` to purge. THROWS when the bucket cannot be read
   * whole, like every enumeration here: a partial read would report a clean
   * pass over entries it never saw.
   */
  async allWaiting(): Promise<HeldAttempt[]> {
    const cutoff = Date.now() - TTL_MS;
    const out: HeldAttempt[] = [];
    for (const [, e] of await this.view()) {
      if (e.decision || Date.parse(e.last_at) < cutoff) continue;
      out.push(copyOf(e));
    }
    return out;
  }

  /** Record a console decision. Returns the entry, or null if nobody by that
   *  sender is waiting (decisions exist only for real knocks). Re-deciding
   *  before the agent acks simply overwrites — the owner changed their mind. */
  async decide(agent: string, sender: string, stance: "allow" | "block"): Promise<HeldAttempt | null> {
    const entry = await this.get(agent, sender);
    if (!entry) return null;
    entry.decision = { stance, decided_at: new Date().toISOString() };
    await this.kv.put(this.key(agent, sender), JSON.stringify(entry)); this.wrote(this.key(agent, sender), entry);
    return entry;
  }

  /** Decisions the agent has not yet applied and acked. */
  async decisions(agent: string): Promise<HeldAttempt[]> {
    return (await this.list(agent)).filter((e) => !!e.decision);
  }

  /** Remove an entry: agent acked a decision, or resolved the sender locally.
   *
   *  Purge, not delete. An entry names a third party — sender key, resolved PAN
   *  handle (which contains their email address), operator name — so leaving it
   *  as history keeps a record of who knocked on an agent after the owner
   *  resolved it. */
  async resolve(agent: string, sender: string): Promise<void> {
    try { await this.kv.purge(this.key(agent, sender)); } catch { /* already gone */ } this.wrote(this.key(agent, sender), null);
  }

  /**
   * Every held entry for one agent, purged — account closure.
   *
   * Keys are `<agent>.<sender>`, so this takes the agent's own prefix and nobody
   * else's. Returns how many were removed.
   *
   * THROWS if the bucket cannot be enumerated completely. It used to return 0,
   * which closure recorded as "nothing to purge" — and an entry left behind names
   * a THIRD PARTY: the sender's key, their resolved PAN handle (which contains
   * their email address) and their operator, retained after the account they
   * knocked on was closed. That is a retention failure reported as a clean
   * closure, so it has to be an error the closure can surface.
   */
  async purgeAgent(agent: string): Promise<number> {
    this.check(agent);
    let purged = 0;
    for (const [k] of await this.entriesFor(agent, { fresh: true })) {
      try { await this.kv.purge(k); purged++; } catch { /* already gone */ } this.wrote(k, null);
    }
    return purged;
  }

  private async get(agent: string, sender: string): Promise<HeldAttempt | null> {
    try {
      const entry = await this.kv.get(this.key(agent, sender));
      if (!entry || entry.length === 0) return null;
      return JSON.parse(entry.string()) as HeldAttempt;
    } catch { return null; }
  }

  /**
   * The live entries whose key begins `<agent>.`, already read.
   *
   * `snapshotKvBucket` enumerates a WHOLE bucket, so the agent's prefix is
   * selected here rather than pushed down to the server as `kv.keys(<agent>.>)`
   * used to do. That is a real cost: one `get()` per entry in `mesh_held`, not per
   * entry for this agent. Taken deliberately —
   *
   *   - the alternative is one more open-coded `streams.info(subjects_filter)`
   *     read, and collapsing those onto the helper is the whole point of this
   *     change; if the cost ever bites, a `subjectFilter` option on
   *     `snapshotKvBucket` is where the fix belongs, not here.
   *   - the bucket is small and self-limiting: one entry per (guarded agent,
   *     stranger who knocked) pair, expiring after 30 days, and the obligations
   *     collector already reads all of it on every refresh.
   *
   * The filtered `kv.keys()` this replaced was NOT safe for being filtered. It
   * awaited a `get()` per key inside the iteration, which is the slow-caller shape
   * that measured 1 key of 500 (shared/kv.ts), and both callers invert on a short
   * read: `listWaiting` hides a stranger from the owner's decision list, and
   * `decisions` hides a decision the owner already made, so the agent never
   * applies it and the console shows a knock the owner has already answered.
   */
  private async entriesFor(agent: string, opts: { fresh?: boolean } = {}): Promise<Array<[string, HeldAttempt]>> {
    this.check(agent);
    const prefix = `${agent}.`;
    const out: Array<[string, HeldAttempt]> = [];
    for (const [k, e] of await this.view(opts)) if (k.startsWith(prefix)) out.push([k, e]);
    return out;
  }

  private async list(agent: string): Promise<HeldAttempt[]> {
    const out: HeldAttempt[] = [];
    const cutoff = Date.now() - TTL_MS;
    for (const [k, e] of await this.entriesFor(agent)) {
      // Purge on expiry too: an entry that aged out is one nobody acted on,
      // and it names the sender who gave up. Deleting it left that name in
      // history for as long as the bucket keeps history.
      if (Date.parse(e.last_at) < cutoff) { await this.kv.purge(k); this.wrote(k, null); continue; }
      out.push(copyOf(e));
    }
    return out.sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
  }

  private key(agent: string, sender: string): string {
    this.check(agent); this.check(sender);
    return `${agent}.${sender}`;
  }
  private check(k: string): void {
    if (!/^[A-Z2-7]{56}$/.test(k)) throw new Error("invalid key");
  }
}

/** Verify an adapter's detached signature over a canonical string. Same
 *  Ed25519/nkeys scheme as pairing (`pan-pair-v1`) and rosters. */
export function verifyAgentSig(agentKey: string, canonical: string, sigB64: string): boolean {
  try {
    const kp = nkeys.fromPublic(agentKey);
    return kp.verify(new TextEncoder().encode(canonical), new Uint8Array(Buffer.from(sigB64, "base64")));
  } catch { return false; }
}
