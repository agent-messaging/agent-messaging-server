/**
 * The caller-identity store: the durable half of the INBOUND direction.
 *
 * The bridge mints one hosted mesh identity per external A2A caller
 * (BRIDGE-A2A.md §9) and signs that caller's traffic with it under the node's
 * vouch (§2.1 rule 1). Until this module existed, the map from caller to
 * identity lived in one `Map` and nowhere else, which had two consequences the
 * specification does not allow for:
 *
 *   - a restart or a pool eviction re-minted the identity, so the same caller
 *     appeared on the mesh as a different agent from one day to the next; and
 *   - an audit or settlement row naming a hosted identity resolved to NOBODY
 *     afterwards, because the only thing that ever knew whose identity it was
 *     had been a process that has since exited.
 *
 * Both are fixed by writing the mapping down. A record survives restarts, and
 * it survives eviction from the live pool: the pool is a cache of live
 * `AgentMesh` objects, this file is the record of who is who.
 *
 * ── What is secret here, and what is not ────────────────────────────────
 *
 * `identitySeed` is the caller identity's Ed25519 NKey seed. Anyone holding it
 * can sign mesh traffic as that caller. It is stored for exactly the reason
 * the attachment store holds its seeds (outbound/store.ts): a mesh agent id is
 * a fact other agents write down, and re-minting on every boot quietly breaks
 * them. So this file gets the same handling as that one — mode 0600 inside a
 * 0700 directory, atomic tmp+rename, and an explicit `chmod` on both, because
 * `writeFile`'s and `mkdir`'s mode arguments apply only when they CREATE.
 *
 * The caller key is NOT stored. For a self-serve `amk_` caller the key is
 * already only a digest (inbound/keys.ts) and the caller key names a record
 * id, but for an operator env-list caller the caller key literally embeds the
 * raw API key — so what is written is `sha256(callerKey)` and never the key
 * itself. Losing this file loses the mapping and the identities; it does not
 * hand anyone a credential they could present to the bridge.
 *
 * `redactCaller` is what every read leaving this module passes through: it
 * drops the seed AND the digest. The digest is not a secret, but an operator
 * key is chosen by a person and short, so publishing its digest would be
 * handing out an offline guessing oracle for no reason (same call keys.ts
 * makes about `sha256`).
 *
 * The `ref` is the piece meant to travel. It is a random id minted with the
 * record, carried in the §8.3 bridge marker on the wire and in the caller
 * identity's manifest, and it names the caller without naming its credential,
 * its account, or its address.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * How a caller was admitted (bridge.ts `authorizeCaller`).
 *
 * `operator` — an entry in the env `API_KEYS` list. The operator's own key; it
 *              stands on no account, so nothing it does can be charged.
 * `account`  — a runtime-minted `amk_` key that stands on an account.
 * `anonymous`— no credentials at all, admitted only where the operator turned
 *              `ALLOW_ANONYMOUS` on. Never persisted; see `persistable`.
 * `pact`     — a person's own agent, calling through a personal-agent platform
 *              registered with the gateway's PACT provider (BRIDGE-A2A.md
 *              §14.6). The caller key is `pact:` and the SHA-256 of the
 *              platform's issuer and the person's opaque `sub`; it stands on
 *              no account here.
 */
export type CallerKind = "operator" | "account" | "anonymous" | "pact";

export interface CallerIdentityRecord {
  /** Stable opaque reference for this caller. Safe to publish: it names the
   *  caller without naming the credential, the account or the address. This is
   *  what the §8.3 marker carries and what an investigator resolves. */
  ref: string;
  kind: CallerKind;
  /** SHA-256 hex of the caller key. The index, and the only form of the caller
   *  key that reaches disk — an operator caller key embeds the raw API key. */
  callerKeyHash: string;
  /** The `amk_` key RECORD id for account callers: a UUID, not a credential,
   *  so it is safe in a listing and it is what ties a caller back to a key
   *  someone can revoke. Null for the other kinds. */
  keyRecordId: string | null;
  /** The account behind this caller at mint time. Null for operator callers
   *  (the operator's own key stands on no account). */
  accountId: string | null;
  /** The hosted mesh identity's public key — the `from` on every envelope the
   *  bridge sends for this caller, and the id an audit row names. */
  agentId: string;
  /** Ed25519 NKey seed for that identity. SECRET; see the file header. */
  identitySeed: string;
  createdAt: string;
  lastSeenAt: string;
}

/** What leaves this module toward any API response or log: no seed, and no
 *  caller-key digest either. */
export type RedactedCallerIdentity = Omit<CallerIdentityRecord, "identitySeed" | "callerKeyHash">;

export function redactCaller(rec: CallerIdentityRecord): RedactedCallerIdentity {
  const { identitySeed: _seed, callerKeyHash: _hash, ...rest } = rec;
  return rest;
}

/** The index a caller key is stored under. Never store the caller key itself. */
export function callerKeyDigest(callerKey: string): string {
  return createHash("sha256").update(callerKey).digest("hex");
}

/** Which admission path a caller key came from (bridge.ts `authorizeCaller`
 *  builds the prefixes). */
export function callerKindOf(callerKey: string): CallerKind {
  if (callerKey.startsWith("acctkey:")) return "account";
  if (callerKey.startsWith("key:")) return "operator";
  if (callerKey.startsWith("pact:")) return "pact";
  return "anonymous";
}

/**
 * Anonymous callers are deliberately NOT written down.
 *
 * Their caller key is a client address, they are evicted on an idle TTL by
 * design, and the account behind them is nobody — so a record would add churn
 * and a file full of hashed IP addresses while answering none of the questions
 * this store exists to answer. Attribution is about who made a call; an
 * anonymous caller has no who. They still get a `ref` and the §8.3 marker on
 * the wire for the run they are alive in.
 */
export function persistable(callerKey: string): boolean {
  return callerKindOf(callerKey) !== "anonymous";
}

export interface CallerIdentityStore {
  load(): Promise<void>;
  byCallerKey(callerKey: string): CallerIdentityRecord | undefined;
  byAgentId(agentId: string): CallerIdentityRecord | undefined;
  byRef(ref: string): CallerIdentityRecord | undefined;
  put(rec: CallerIdentityRecord): Promise<void>;
  /** Mark a caller as seen now. Cheap and lossy on purpose: it runs on every
   *  request, so it only writes when the stored timestamp has actually gone
   *  stale. */
  touch(callerKey: string, now?: number): void;
  list(accountId?: string | null): CallerIdentityRecord[];
}

/** How stale `lastSeenAt` may get before a touch costs a write. */
const TOUCH_WRITE_INTERVAL_MS = 60_000;

/** Build a record for a caller the bridge has just minted an identity for. */
export function newCallerRecord(fields: {
  callerKey: string;
  keyRecordId?: string | null;
  accountId?: string | null;
  agentId: string;
  identitySeed: string;
}): CallerIdentityRecord {
  const now = new Date().toISOString();
  return {
    ref: randomUUID(),
    kind: callerKindOf(fields.callerKey),
    callerKeyHash: callerKeyDigest(fields.callerKey),
    keyRecordId: fields.keyRecordId ?? null,
    accountId: fields.accountId ?? null,
    agentId: fields.agentId,
    identitySeed: fields.identitySeed,
    createdAt: now,
    lastSeenAt: now,
  };
}

export class FileCallerIdentityStore implements CallerIdentityStore {
  /** callerKeyHash -> record. */
  private byHash = new Map<string, CallerIdentityRecord>();
  /** agentId -> record. The reverse lookup an audit row needs. */
  private byAgent = new Map<string, CallerIdentityRecord>();
  private byRefIndex = new Map<string, CallerIdentityRecord>();
  private loaded = false;
  /** Writes are chained so two flushes cannot interleave their tmp/rename. */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      for (const rec of JSON.parse(raw) as CallerIdentityRecord[]) this.index(rec);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // No file yet is a normal first boot, not an error.
    }
    this.loaded = true;
  }

  byCallerKey(callerKey: string): CallerIdentityRecord | undefined {
    return this.byHash.get(callerKeyDigest(callerKey));
  }

  byAgentId(agentId: string): CallerIdentityRecord | undefined {
    return this.byAgent.get(agentId);
  }

  byRef(ref: string): CallerIdentityRecord | undefined {
    return this.byRefIndex.get(ref);
  }

  async put(rec: CallerIdentityRecord): Promise<void> {
    await this.load();
    this.index(rec);
    this.writing = this.writing.then(() => this.flush());
    await this.writing;
  }

  touch(callerKey: string, now = Date.now()): void {
    const rec = this.byHash.get(callerKeyDigest(callerKey));
    if (!rec) return;
    if (now - Date.parse(rec.lastSeenAt) < TOUCH_WRITE_INTERVAL_MS) return;
    rec.lastSeenAt = new Date(now).toISOString();
    this.writing = this.writing.then(() => this.flush());
    // Fire and forget: a last-seen stamp must never fail or delay a request.
    void this.writing.catch((err) => console.error("[bridge:callers] flush failed:", err));
  }

  list(accountId?: string | null): CallerIdentityRecord[] {
    const all = [...this.byHash.values()];
    return accountId === undefined ? all : all.filter((r) => r.accountId === accountId);
  }

  private index(rec: CallerIdentityRecord): void {
    const previous = this.byHash.get(rec.callerKeyHash);
    // A re-minted identity for the same caller replaces the old agent id in
    // the forward index, but the REVERSE index keeps the old one: an audit row
    // written under the previous identity must still resolve to this caller.
    if (previous && previous.agentId !== rec.agentId) this.byAgent.set(previous.agentId, previous);
    this.byHash.set(rec.callerKeyHash, rec);
    this.byAgent.set(rec.agentId, rec);
    this.byRefIndex.set(rec.ref, rec);
  }

  private async flush(): Promise<void> {
    const body = JSON.stringify([...this.byHash.values()], null, 2);
    // Every record holds a signing seed for a mesh identity: owner-only, at
    // every step. `mkdir`'s mode applies only when it CREATES the directory
    // and `writeFile`'s only when it creates the file, so an already-existing
    // data dir (every deployed bridge has one) or a tmp file left by a crashed
    // earlier write would keep whatever bits it had. The explicit chmods close
    // both holes before the rename makes the tmp file the real one.
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}
