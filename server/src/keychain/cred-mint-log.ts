/**
 * The mint log: which connection keys hold a platform-minted credential, and
 * what its lease is.
 *
 * Until this existed, a mint left no durable record at all — the JWT went out,
 * a line hit the console log, and the platform kept nothing it could later ask
 * "should this have been renewed by now?" of. The renewal watcher
 * (cred-renewal-watch-job.ts) is that question, and this is its memory.
 *
 * One KV entry per connection key, latest mint only — the same
 * one-key-per-fact shape as the revocation tombstones next door
 * (cred-revocation.ts), and keyed differently for the same reason in reverse:
 * a renewal is a re-mint on the SAME connection key, so the connection key is
 * the stable identity here, and the covered agent keys ride along as data.
 *
 * What gets recorded, and why:
 *
 *   - A bootstrap mint, only when it carries an expiry. A non-expiring
 *     credential (the MESH_CRED_EXPIRY=off rollback mode) is never due, so
 *     tracking it would be tracking nothing.
 *   - EVERY mint through the renewal door, expiry or not. A re-mint on a
 *     caller-held key is evidence the renewal path works — which is exactly
 *     what the watcher exists to observe — even when the switch is off and
 *     the credential it hands back has no expiry. A key first seen at its own
 *     renewal (minted before this log existed) starts its record here, with
 *     the renewal already counted.
 *
 * Recording NEVER throws: a mint that cannot be remembered must still be
 * handed to the caller, so failures are logged and swallowed. Reading for the
 * watcher DOES throw on an incomplete enumeration — a short list would read
 * as credentials that no longer exist, and every conclusion drawn from it
 * would be wrong (see shared/kv.ts on why kv.keys() cannot be trusted).
 */
import { metrics } from "../shared/ops-events.js";
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";
import type { TrackedCred } from "./cred-renewal-watch.js";

const BUCKET = "mesh_cred_mints";

export class CredMintLog {
  private kv: KeyedStore;

  constructor(kv: KeyedLike, js?: StorageLike) {
    this.kv = keyedOf(kv, js);
  }

  static async create(js: StorageLike): Promise<CredMintLog> {
    // History 1 (storage/catalog.ts): the latest mint per key is the whole answer.
    return new CredMintLog(await storageOf(js).keyed(BUCKET));
  }

  /**
   * Record one mint. `door` says which endpoint minted it: "bootstrap" is
   * always a first mint on a fresh server-generated key; "renewal" is
   * `POST /v1/node-credential`, a re-mint on a key the caller already holds;
   * "admin" is the admin API minting a credential on a fresh key, always
   * recorded so a revoke can find it.
   *
   * Never throws — see the module note.
   */
  async recordMint(m: {
    /** The connection key the JWT is bound to (`minted.subject`). */
    key: string;
    agents: string[];
    label?: string;
    /** `minted.expiresAt`: ISO-8601, or null for a no-expiry mint. */
    expiresAt: string | null;
    door: "bootstrap" | "renewal" | "admin";
    /** Whose agents these are, when the door knew (kill switch item 1). */
    account?: string | null;
    org?: string | null;
  }): Promise<void> {
    // A non-expiring bootstrap mint is never due; nothing to watch.
    if (m.door === "bootstrap" && m.expiresAt === null) return;

    try {
      let prior: TrackedCred | null = null;
      if (m.door === "renewal") {
        try {
          const entry = await this.kv.get(m.key);
          if (entry?.value.length) prior = entry.json<TrackedCred>();
        } catch {
          prior = null; // an unreadable prior record still leaves a recordable renewal
        }
      }

      const record: TrackedCred = {
        key: m.key,
        agents: m.agents,
        ...(m.label?.trim() || prior?.label ? { label: m.label?.trim() || prior?.label } : {}),
        issuedAt: new Date().toISOString(),
        expiresAt: m.expiresAt,
        renewals: m.door === "renewal" ? (prior?.renewals ?? 0) + 1 : 0,
        ...((m.account ?? prior?.account) ? { account: (m.account ?? prior?.account)! } : {}),
        ...((m.org ?? prior?.org) ? { org: (m.org ?? prior?.org)! } : {}),
      };
      await this.kv.put(m.key, JSON.stringify(record));

      // The digest's count of renewals rides on the recorder like every other
      // daily number (daily-stats.ts). Recorded even if the KV write above
      // had failed — the renewal happened either way.
      if (m.door === "renewal") {
        metrics.event({
          kind: "credential_renewed",
          actor: m.agents[0] ?? m.key,
          meta: {
            key: m.key.slice(0, 12),
            agents: m.agents.length,
            expires_at: m.expiresAt,
            // True for a credential this log had never seen minted — the
            // cold-start case, where the renewal IS the first record.
            first_seen: prior === null,
          },
        });
      }
    } catch (err) {
      // A mint that cannot be remembered is still a valid mint. The watcher
      // just cannot watch this one; worth a log line, never a failed request.
      console.warn(`[cred-watch] could not record a ${m.door} mint for ${m.key.slice(0, 12)}…: ${(err as Error).message}`);
    }
  }

  /** Every tracked credential. Throws when the bucket cannot be enumerated
   *  COMPLETELY — a partial list is worse than none. */
  async all(): Promise<TrackedCred[]> {
    const snap = await this.kv.list();
    const out: TrackedCred[] = [];
    for (const [key, entry] of snap.entries) {
      try {
        const r = entry.json<TrackedCred>();
        if (r && typeof r.issuedAt === "string" && Array.isArray(r.agents)) out.push({ ...r, key });
      } catch {
        console.warn(`[cred-watch] unparseable mint record for ${key.slice(0, 12)}… — skipped`);
      }
    }
    return out;
  }

  /** Note the second these connection keys were cut, on their records, so a
   *  mint door in another process can wait past it (kill-switch-cut.ts).
   *  Keys with no record are skipped. Never throws. */
  async noteCut(keys: string[], sec: number): Promise<void> {
    for (const k of keys) {
      try {
        const entry = await this.kv.get(k);
        if (!entry?.value.length) continue;
        await this.kv.put(k, JSON.stringify({ ...entry.json<TrackedCred>(), cutAt: sec }));
      } catch (err) {
        console.warn(`[cred-watch] could not note a cut on ${k.slice(0, 12)}…: ${(err as Error).message}`);
      }
    }
  }

  /** The second this connection key was last cut, when its record says so. */
  async cutAt(key: string): Promise<number | null> {
    try {
      const entry = await this.kv.get(key);
      const at = entry?.value.length ? entry.json<TrackedCred>().cutAt : undefined;
      return typeof at === "number" ? at : null;
    } catch {
      return null;
    }
  }

  /** Drop a record the watcher has decided is superseded. Best-effort. */
  async purge(key: string): Promise<void> {
    try {
      await this.kv.purge(key);
    } catch (err) {
      console.warn(`[cred-watch] could not purge superseded record ${key.slice(0, 12)}…: ${(err as Error).message}`);
    }
  }
}
