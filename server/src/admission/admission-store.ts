import { ADMISSION_ROSTER_SIG_PREFIX, canonicalJSON, verifyTagged } from "../sdk.js";
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";

/**
 * Control-plane storage for EXT-6 admission rosters.
 *
 * A roster is a signed JSON document (EXT-6 §3) describing who may reach an
 * agent's inbox. This store is the mesh-side home for it: it lets an owner sync
 * one roster across devices and gives the mesh a copy to enforce against before
 * delivery. Storage is keyed by `owner_key` — the account-level key that signs
 * the roster.
 *
 * The security model is that the SIGNATURE is the authority, not this store
 * (EXT-6 §7). So:
 *   - WRITE is authorized by the signature itself: a PUT is accepted only if the
 *     document is validly signed by the `owner_key` it is stored under. No login
 *     is needed, and the operator cannot forge a roster it could not sign.
 *   - READ is public: a roster is signed policy, not a secret, and any consumer
 *     re-verifies the signature on load, so a tampered stored copy is rejected
 *     at the edge regardless.
 */
export class AdmissionStore {
  private rosters: KeyedStore;

  constructor(rosters: KeyedLike) {
    this.rosters = keyedOf(rosters);
  }

  static async create(js: StorageLike): Promise<AdmissionStore> {
    return new AdmissionStore(await storageOf(js).keyed("mesh_admission"));
  }

  async get(ownerKey: string): Promise<Record<string, unknown> | null> {
    try {
      const entry = await this.rosters.get(this.key(ownerKey));
      if (!entry) return null;
      return JSON.parse(entry.string());
    } catch {
      return null;
    }
  }

  /** Store a roster after verifying it is validly signed by `ownerKey`. Returns
   *  false (and stores nothing) if the signature or owner does not check out. */
  async put(ownerKey: string, roster: Record<string, unknown>): Promise<boolean> {
    if (roster?.owner_key !== ownerKey) return false;
    if (!verifyRoster(roster)) return false;
    await this.rosters.put(this.key(ownerKey), JSON.stringify(roster));
    return true;
  }

  /** Store a roster that has already been authorized out of band — by an
   *  account session (core §4.9 account-session authority), not by a signature.
   *  The caller MUST have verified the session owns `ownerKey`'s account. Used
   *  by the account console; the signed path (`put`) stays for headless clients.
   *  The core's admin API stores with `authored: "admin"`: the operator's
   *  authority over its own mesh (admin/admin-api.ts). */
  async putAuthorized(ownerKey: string, roster: Record<string, unknown>, authored: "account" | "admin" = "account"): Promise<void> {
    await this.rosters.put(this.key(ownerKey), JSON.stringify({ ...roster, owner_key: ownerKey, authored }));
  }

  /** Remove one agent's roster entirely — account closure, where the agent is
   *  being deregistered and there is nothing left to gate.
   *
   *  Purge, not delete: the bucket is created with `history: 3`, and a roster
   *  lists the counterparties this owner allowed or blocked, by PAN handle. A
   *  handle contains its owner's email address (SPEC-NAMING §3), so three prior
   *  revisions of a roster is three copies of a list of other people's addresses.
   *
   *  A roster that is already gone is the desired state, so a failure here is
   *  swallowed and the caller can retry the whole closure. */
  async purge(ownerKey: string): Promise<void> {
    try {
      await this.rosters.purge(this.key(ownerKey));
    } catch {
      // already gone, or never existed
    }
  }

  /** KV keys must be token-safe; an nkey public key already is (base32), but
   *  guard against anything unexpected in the path param. */
  private key(ownerKey: string): string {
    if (!/^[A-Z2-7]{56}$/.test(ownerKey)) throw new Error("invalid owner key");
    return ownerKey;
  }
}

/** Verify a roster's Ed25519 signature against its declared owner_key.
 *
 *  The signed bytes are ADMISSION_ROSTER_SIG_PREFIX + the canonical JSON
 *  (the SDK's `canonicalJSON` — one canonicalization in the system) of the
 *  document with `sig` excluded (EXT-6 §3). Since protocol 0.3 `verifyTagged`
 *  accepts the tagged form only; the 0.2 dual-accept window that carried the
 *  reference adapter's untagged `signRoster` output is closed, and the adapter
 *  flips its signer in the same release. A roster signed by a pre-0.3 adapter
 *  is refused on WRITE; rosters already stored keep serving, so the fleet's
 *  admission stances survive the roll and only updates wait for it.
 *  The signature's encoding stays what the signer always produced: standard
 *  base64. */
export function verifyRoster(roster: Record<string, unknown>): boolean {
  const sig = roster?.sig as string | undefined;
  const ownerKey = roster?.owner_key as string | undefined;
  if (!sig || !ownerKey) return false;
  try {
    const body = { ...roster };
    delete (body as Record<string, unknown>).sig;
    return verifyTagged(
      ownerKey,
      ADMISSION_ROSTER_SIG_PREFIX,
      canonicalJSON(body),
      new Uint8Array(Buffer.from(sig, "base64")),
    );
  } catch {
    return false;
  }
}
