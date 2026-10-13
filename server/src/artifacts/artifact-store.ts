import { createHash, randomBytes } from "node:crypto";
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";
import {
  openBlobStore,
  blobKey,
  canCopy,
  canLink,
  measureBlob,
  type BlobStore,
  type DownloadLinkOptions,
  type SignedLink,
} from "../storage/index.js";
import { safeFilename, safeMediaType } from "./safe-names.js";

/**
 * The mesh-wide artifact store (SPEC §7.5).
 *
 * `mesh_artifacts` has been in the spec's storage table since 0.1 and had never
 * been created by any code. What existed instead was the rooms drive, which
 * works but is room-shaped: every object belongs to a room, and reclaim happens
 * when the room expires. Artifacts produced by an ordinary task have no room,
 * so there was nowhere to put a file an agent wanted to return.
 *
 * ## The part that is not "lift the rooms drive"
 *
 * The rooms drive never needed a lifecycle model, because the room WAS the
 * lifecycle. Lifting it verbatim would have produced unbounded blob storage
 * that any agent may write to and nothing ever deletes — an abuse vector and a
 * cost hole wearing a feature's clothes. So three rules bound it, and they are
 * deliberately the same shape as the registration rules of §9.2 —
 * **ephemerality is the default, durability is declared**:
 *
 *  - **Attribution.** A write is refused unless it can be attributed to an
 *    agent AND an owner. Nothing is ever stored anonymously.
 *  - **Quota.** Per owner, on both bytes and object count, refused with a
 *    named limit rather than dropped silently or billed indefinitely.
 *  - **Retention.** The default lifetime is the task retention window plus a
 *    grace period. A longer life is something an owner ASKS for at write time,
 *    capped. Work nobody kept produces litter, and the party wanting permanence
 *    is the party that should have to say so.
 *
 * ## Reclaiming does not rewrite history
 *
 * An expired object's bytes go; its index record stays, marked gone. A fetch
 * then answers GONE rather than NOT FOUND, which are different facts about a
 * deliverable — "this expired" and "this never existed" get collapsed by most
 * stores and the collapse is exactly what makes an old task record unreadable.
 * The reference in the task, the dossier or a signed export is left alone and
 * stays truthful: `size` and `digest` still describe the bytes that were there.
 *
 * ## Two places for bytes, and the broker carrying only pointers
 *
 * Until 2026-09-23 every byte went through the broker: `put` carried the file
 * base64 in one NATS message and `fetch` answered with it the same way, so
 * nothing over roughly 750 KB could be stored or read (§18.9, the live broker
 * takes 1 MB). The animation renderer's 3.6 MB video was dropped at delivery.
 *
 * Now a store whose backend can sign (GCS in production) takes a large file in
 * two steps. `begin` does every check `put` does, writes a PENDING record that
 * already counts against the owner's quota, and hands back a URL good for one
 * PUT of exactly those bytes. The agent sends them straight to storage, then
 * `commit` has the store read the object back, check its size and hash
 * against what `begin` declared, and only then make it live. Reads go the same
 * way: a large file is answered with a short-lived signed GET rather than its
 * bytes. Small files keep travelling inline, so the older SDKs keep working.
 *
 * Records written before the switch keep their bytes in the broker's object
 * store and say nothing about where they are, so a record with no `store` is
 * read from there, and every new record names the backend that holds it.
 *
 * ## Keeping a file somebody else stored
 *
 * `keep` is how a pointer becomes a deliverable of one's own. A holder of a
 * ref (possession is the read capability, §7.5.4) asks for its own copy under
 * its own owner, with its own retention and counted against its own quota.
 * The copy is made inside the storage, so the bytes never pass through the
 * broker or this process; that is what lets the platform take a 3 MB video
 * from a runner as a ref rather than as a base64 body. A file whose bytes sit
 * where no such copy can be made (the broker's own store) is not copied at
 * all: the caller is told so and keeps the original ref as it is.
 *
 * ## Holding a file while a page shows it
 *
 * The retention cap is right for work nobody looks at again and wrong for a
 * video a published page plays: at ninety days the page would go on showing a
 * title over a file that is gone. So an owner may `hold` a file of its own.
 * A hold is a lease, not a flag: it keeps the file past the sweep for
 * `holdMs` from the moment it is asked for, and the owner renews it for as
 * long as the page is up. `release` ends it early when the page goes. A
 * holder that stops renewing (an account that closed, a page removed without
 * a release) lets the file fall back to ordinary retention by itself, which
 * keeps the rule this store was built on: nothing is kept for ever unless
 * somebody keeps saying so.
 */

// ── configuration ───────────────────────────────────────────────────────────

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const DAY_MS = 86_400_000;

const MIB = 1024 * 1024;

export const ARTIFACT_CONFIG = {
  /** Largest single object when the backend cannot make links (nats, fs).
   *  Every byte then travels through a NATS request/reply, so the broker's
   *  message size (§18.9) is the real ceiling and this sits above it only as
   *  a backstop. */
  maxBytes: envInt("ARTIFACTS_MAX_BYTES", 8 * MIB),
  /** Per-owner ceiling on total live bytes, for the same backends. */
  maxBytesPerOwner: envInt("ARTIFACTS_MAX_BYTES_PER_OWNER", 256 * MIB),
  /** Largest single object when the backend can make links (gcs). The bytes
   *  never touch the broker or this process on the way in, so the limit is a
   *  decision about what one file may cost rather than about a message size.
   *  The same variable overrides both, because an operator who sets it means
   *  one number. */
  linkedMaxBytes: envInt("ARTIFACTS_MAX_BYTES", 1024 * MIB),
  /** Per-owner live bytes when the backend can make links. */
  linkedMaxBytesPerOwner: envInt("ARTIFACTS_MAX_BYTES_PER_OWNER", 20 * 1024 * MIB),
  /** Per-owner ceiling on live object count, so a million tiny files is also
   *  refused — a bytes-only quota is trivially defeated by small writes. */
  maxObjectsPerOwner: envInt("ARTIFACTS_MAX_OBJECTS_PER_OWNER", 5_000),
  /** Default lifetime: the §18.4 task retention (7d) plus the §7.5.2 grace
   *  window (7d). An artifact outlives the work that produced it, and not much
   *  longer unless someone says so. */
  defaultRetentionMs: envInt("ARTIFACTS_RETENTION_DAYS", 14) * DAY_MS,
  /** The longest an owner may declare. A cap that can be raised by asking is
   *  not a cap. */
  maxRetentionMs: envInt("ARTIFACTS_MAX_RETENTION_DAYS", 90) * DAY_MS,
  /** How long one `hold` keeps a file past the sweep. A hold is a lease the
   *  holder renews while the reason for it lasts (a published page showing
   *  the file), so a holder that stops renewing, or an account that closes,
   *  gives the file back to ordinary retention on its own. */
  holdMs: envInt("ARTIFACTS_HOLD_DAYS", 90) * DAY_MS,
  /** How often the reclaim sweep runs. */
  sweepIntervalMs: envInt("ARTIFACTS_SWEEP_INTERVAL_MS", 60 * 60 * 1000),
  /** How long an upload link works. Long enough for a gigabyte on an ordinary
   *  line to START (storage checks the signature when the request begins, not
   *  when it ends), short enough that a leaked one is worth little. */
  uploadLinkMs: 15 * 60 * 1000,
  /** How long a download link works. The same reasoning: it only has to get
   *  one request started. */
  downloadLinkMs: 15 * 60 * 1000,
  /** A pending upload nobody committed within this is dropped by the sweep,
   *  bytes and record, and stops counting against the owner's quota. */
  pendingMs: 60 * 60 * 1000,
} as const;

/** The limits one store enforces, which depend on whether its backend makes
 *  links: a store that carries every byte through the broker cannot usefully
 *  promise more than the broker carries. */
export interface ArtifactLimits {
  maxBytes: number;
  maxBytesPerOwner: number;
  maxObjectsPerOwner: number;
}

export function limitsFor(linked: boolean): ArtifactLimits {
  return {
    maxBytes: linked ? ARTIFACT_CONFIG.linkedMaxBytes : ARTIFACT_CONFIG.maxBytes,
    maxBytesPerOwner: linked ? ARTIFACT_CONFIG.linkedMaxBytesPerOwner : ARTIFACT_CONFIG.maxBytesPerOwner,
    maxObjectsPerOwner: ARTIFACT_CONFIG.maxObjectsPerOwner,
  };
}

// ── refs ────────────────────────────────────────────────────────────────────

/** §18.5: `mesh:artifacts:{object_id}`. The owner is deliberately NOT in the
 *  ref even though it is in the storage key — possession of a ref is the read
 *  capability (§7.5.4), and a ref gets forwarded, so anything encoded in it is
 *  disclosed to everyone it reaches. */
const REF_PREFIX = "mesh:artifacts:";

/** 128 bits, base64url. Unguessable is load-bearing here rather than tidy: a
 *  predictable object id turns "possession of the ref" into "possession of a
 *  counter", which is a public store with extra steps. */
export function mintObjectId(): string {
  return randomBytes(16).toString("base64url");
}

export const refFor = (objectId: string): string => `${REF_PREFIX}${objectId}`;

const OBJECT_ID = /^[A-Za-z0-9_-]{16,128}$/;

/** The object id inside a ref, or null if this is not one of ours. Refuses
 *  anything that is not a plain base64url token: the id reaches a storage key,
 *  and a `/` or `..` from the wire must never become a path. */
export function objectIdFrom(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref.startsWith(REF_PREFIX)) return null;
  const id = ref.slice(REF_PREFIX.length);
  return OBJECT_ID.test(id) ? id : null;
}

export const digestOf = (bytes: Uint8Array): string =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** What a record says about where its bytes are. The broker's object store
 *  says nothing, so every record written before this field existed means it,
 *  and a new record written there is spelled the same way. */
function storeTagOf(blobs: BlobStore): string | undefined {
  const kind = blobs.kind.split(":")[0]!;
  if (blobs.own || kind === "nats-object-store") return undefined;
  if (kind === "filesystem") return "fs";
  return kind;
}

// ── the index record ────────────────────────────────────────────────────────

export interface ArtifactRecord {
  id: string;
  /** The owner this counts against for quota (§8.6). */
  owner: string;
  /** The agent that wrote it. Kept separate from `owner` because an owner runs
   *  several agents and "which one produced this" is the question an operator
   *  asks when something unexpected is taking up room. */
  agent: string;
  media_type: string;
  name?: string;
  size: number;
  digest: string;
  created_at: string;
  expires_at: string;
  /** Set when the bytes have been reclaimed. The record survives so a fetch can
   *  say GONE rather than NOT FOUND. */
  gone?: boolean;
  /** Which backend holds the bytes (`gcs`, `fs`). Absent means the broker's
   *  own object store, which is where every record written before this field
   *  existed keeps them. */
  store?: string;
  /** Set between `begin` and `commit`: the bytes are on their way and have not
   *  been checked. A pending record cannot be fetched, stat'ed or linked, and
   *  it counts against quota, because the storage it reserves is real. */
  pending?: boolean;
  /** Set while the owner holds the file (`hold`): the sweep leaves it alone
   *  until this passes, whatever `expires_at` says. The owner renews it while
   *  a published page shows the file, and `release` takes it off. */
  held_until?: string;
}

/** When the sweep may take a record: its own expiry, or the end of a hold
 *  that runs later. */
export function reclaimAt(r: { expires_at: string; held_until?: string | null }): string {
  return r.held_until && r.held_until > r.expires_at ? r.held_until : r.expires_at;
}

export type PutRefusal =
  | { ok: false; code: "TOO_LARGE"; message: string }
  | { ok: false; code: "QUOTA_EXCEEDED"; message: string }
  | { ok: false; code: "INVALID"; message: string }
  /** The backend cannot make links, so nothing bigger than a message can
   *  reach it. */
  | { ok: false; code: "NO_LINK"; message: string };

export type PutResult = { ok: true; record: ArtifactRecord } | PutRefusal;

export type BeginResult = { ok: true; record: ArtifactRecord; upload: SignedLink } | PutRefusal;

export type CommitResult =
  | { ok: true; record: ArtifactRecord }
  | { ok: false; code: "NOT_FOUND" | "FORBIDDEN"; message: string }
  /** What arrived is not what `begin` declared. The object and the pending
   *  record are both gone by the time this is returned. */
  | { ok: false; code: "MISMATCH"; message: string };

export type FetchResult =
  | { ok: true; record: ArtifactRecord; bytes: Uint8Array }
  /** Too big to answer inline, and the caller can follow a link. */
  | { ok: true; record: ArtifactRecord; link: SignedLink }
  | { ok: false; code: "GONE"; record: ArtifactRecord }
  | { ok: false; code: "NOT_FOUND" }
  /** Too big to travel in a message, and the caller did not say it can
   *  follow a link. */
  | { ok: false; code: "TOO_LARGE"; record: ArtifactRecord };

export type LinkResult =
  | { ok: true; record: ArtifactRecord; link: SignedLink }
  | { ok: false; code: "GONE"; record: ArtifactRecord }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "NO_LINK"; record: ArtifactRecord };

export type KeepResult =
  /** A copy under the caller's owner, made inside the storage. */
  | { ok: true; copied: true; record: ArtifactRecord; source: ArtifactRecord }
  /** No copy could be made without moving bytes, so the caller keeps the
   *  original. `record` is the source, unchanged, and `why` says so in words. */
  | { ok: true; copied: false; record: ArtifactRecord; why: string }
  | { ok: false; code: "GONE"; record: ArtifactRecord }
  | { ok: false; code: "NOT_FOUND" }
  | PutRefusal;

export type HoldResult =
  | { ok: true; record: ArtifactRecord }
  | { ok: false; code: "GONE"; record: ArtifactRecord }
  | { ok: false; code: "NOT_FOUND" }
  /** Only the owner may hold or release a file: holding is a charge on the
   *  owner's storage, and the ref is only a read capability. */
  | { ok: false; code: "FORBIDDEN" };

/** A file one holds a ref to, to be kept under one's own owner. */
export interface KeepInput {
  owner: string;
  agent: string;
  /** How long the new owner wants it kept, in days. Clamped (§7.5.2). */
  retain_days?: number;
  /** The kept copy's own name and type; the source's when not given. */
  name?: string;
  media_type?: string;
}

/** How a fetch is to be answered. Both are the caller's knowledge, not the
 *  store's: whether the asker can follow a link, and what the broker carries. */
export interface FetchOptions {
  /** Answer anything larger than this with a link, where the backend holding
   *  it can make one. Absent means the asker cannot follow a link. */
  linkOver?: number;
  /** The largest object that can travel inline. Anything bigger that is not
   *  answered by link is refused as TOO_LARGE rather than read, because a
   *  reply the broker will not carry is a timeout at the far end. */
  inlineCeiling?: number;
}

/** Live bytes and objects for one owner. Exported for the quota check and for
 *  the usage reply, which are the same arithmetic asked by different callers.
 *  A pending upload counts: it holds a place in storage from the moment its
 *  link is handed out, and not counting it would let an owner reserve any
 *  amount by beginning uploads and never finishing them. */
export function usageOf(records: Iterable<ArtifactRecord>, owner: string): { bytes: number; objects: number } {
  let bytes = 0;
  let objects = 0;
  for (const r of records) {
    if (r.owner !== owner || r.gone) continue;
    bytes += r.size;
    objects += 1;
  }
  return { bytes, objects };
}

/** What an owner asked for, clamped to what they may have. A declaration
 *  beyond the cap is honoured up to the cap rather than refused: the write is
 *  legitimate and the caller learns the real expiry in the reply. */
export function retentionFor(requestedDays: unknown, now: number): string {
  const asked = typeof requestedDays === "number" && Number.isFinite(requestedDays) && requestedDays > 0
    ? requestedDays * DAY_MS
    : ARTIFACT_CONFIG.defaultRetentionMs;
  const ms = Math.min(asked, ARTIFACT_CONFIG.maxRetentionMs);
  return new Date(now + ms).toISOString();
}

// ── the store ───────────────────────────────────────────────────────────────

export interface PutInput {
  owner: string;
  agent: string;
  bytes: Uint8Array;
  media_type?: string;
  name?: string;
  /** How long the owner wants it kept, in days. Clamped (§7.5.2). */
  retain_days?: number;
}

/** A large file, declared before its bytes are sent: everything `put` knows
 *  except the bytes themselves, which arrive by link. */
export interface BeginInput {
  owner: string;
  agent: string;
  size: unknown;
  /** `sha256:<hex>` over the bytes the agent is about to send. */
  digest: unknown;
  media_type?: string;
  name?: string;
  retain_days?: number;
}

export class ArtifactStore {
  /** Every record, seeded from KV at boot and written through on change. In
   *  memory because the quota check runs on every write and a full bucket
   *  enumeration per write is not a thing a store can do. Same pattern the
   *  rooms service uses for its room list, and for the same reason. */
  private records = new Map<string, ArtifactRecord>();

  /** What this store enforces; bigger when its backend makes links. */
  readonly limits: ArtifactLimits;
  /** Whether new large files can come in, and large reads go out, by link. */
  readonly links: boolean;
  /** What a new record says in `store`; nothing when the backend is the
   *  broker's object store, which is what nothing has always meant. */
  private readonly tag: string | undefined;

  private constructor(
    private kv: KeyedStore,
    /** Where new bytes go: ARTIFACTS_BACKEND. */
    private blobs: BlobStore,
    /** The broker's object store, where records with no `store` keep their
     *  bytes. The same object as `blobs` when that is the backend in use. */
    private legacy: BlobStore = blobs,
  ) {
    this.links = canLink(blobs);
    this.limits = limitsFor(this.links);
    this.tag = storeTagOf(blobs);
  }

  static async create(js: StorageLike): Promise<ArtifactStore> {
    const storage = storageOf(js);
    const kv = await storage.keyed("mesh_artifacts_index");
    const blobs = await openBlobStore(storage, "mesh_artifacts", {
      backend: process.env.ARTIFACTS_BACKEND,
      fsDir: process.env.ARTIFACTS_FS_DIR ?? "/opt/agentmesh/artifacts",
      gcsBucket: process.env.ARTIFACTS_GCS_BUCKET,
      label: "artifacts",
    });
    // Opened whatever the backend, because the index holds records from
    // before the switch and their bytes did not move. Opening a bucket that
    // exists costs nothing, and one that does not is created empty.
    const legacy = storeTagOf(blobs) === undefined
      ? blobs
      : await storage.blobs("mesh_artifacts");
    const store = new ArtifactStore(kv, blobs, legacy);

    // A short read here is not a smaller index, it is objects that exist on the
    // broker and that this service will not count against quota — so the next
    // write sees free space that is not free. `snapshotKvBucket` throws rather
    // than returning a subset; `kv.keys()` could not be trusted to.
    try {
      const snapshot = await kv.list();
      for (const [key, entry] of snapshot.entries) {
        if (entry.length === 0) continue;
        try {
          store.records.set(key, entry.json<ArtifactRecord>());
        } catch {
          /* skip corrupt */
        }
      }
      console.log(
        `[artifacts] loaded ${store.records.size} record(s) · store: ${blobs.kind}` +
          (legacy === blobs ? "" : ` · older records read from ${legacy.kind}`) +
          (store.links ? " · large files by signed link" : " · no links, so a file travels only inside a message"),
      );
    } catch (err) {
      console.error(
        "[artifacts] index load FAILED — existing objects are not counted against quota " +
          "and will not be reclaimed:",
        err instanceof Error ? err.message : err,
      );
    }
    return store;
  }

  /** Store bytes. Attribution is the caller's job (the service verifies the
   *  envelope signature); this refuses an unattributed write anyway, because a
   *  store that CAN write anonymously eventually does. */
  async put(input: PutInput): Promise<PutResult> {
    const size = input.bytes.byteLength;
    const refused = this.admit(input.owner, input.agent, size);
    if (refused) return refused;

    const record = this.recordFor(input, size, digestOf(input.bytes));

    // Bytes first: an index entry with no object behind it is a reference that
    // resolves to nothing, which is worse than a write that failed cleanly.
    await this.blobs.put(blobKey(record.owner, record.id), input.bytes);
    await this.write(record);
    return { ok: true, record };
  }

  /**
   * The first half of a large write: every check `put` makes, a pending
   * record, and a link that takes exactly the declared bytes.
   *
   * The order is the point. The record is written BEFORE the link is handed
   * out, so from the moment anyone can send bytes there is an index entry
   * that counts them against the owner and that the sweep will clear if
   * nobody commits. The other order leaves a window where storage is being
   * written that nothing is accounting for.
   */
  async begin(input: BeginInput): Promise<BeginResult> {
    if (!canLink(this.blobs)) {
      return {
        ok: false,
        code: "NO_LINK",
        message:
          "this mesh keeps its files where no upload link can be made, so a file travels only inside a " +
          "message, and a file this size is too big for one",
      };
    }
    const size = input.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      return { ok: false, code: "INVALID", message: "size must be the file's length in bytes, a whole number" };
    }
    if (typeof input.digest !== "string" || !DIGEST.test(input.digest)) {
      return { ok: false, code: "INVALID", message: "digest must be sha256: followed by 64 lowercase hex digits" };
    }
    const refused = this.admit(input.owner, input.agent, size);
    if (refused) return refused;

    const record: ArtifactRecord = { ...this.recordFor(input, size, input.digest), pending: true };
    await this.write(record);
    const upload = await this.blobs.signedUploadUrl(blobKey(record.owner, record.id), {
      contentType: record.media_type,
      size,
      expiresInMs: ARTIFACT_CONFIG.uploadLinkMs,
    });
    return { ok: true, record, upload };
  }

  /**
   * The second half: read back what arrived, and make it live only if it is
   * what `begin` declared.
   *
   * The store does its own reading rather than trusting the uploader's word
   * or the storage's metadata, because the digest in the reply is the thing
   * every later reader verifies against (§7.5.1). Anything that does not
   * match is deleted, object and record, so a failed upload leaves nothing
   * behind to count against quota or to be fetched by mistake.
   */
  async commit(objectId: unknown, owner: string): Promise<CommitResult> {
    const id = typeof objectId === "string" && OBJECT_ID.test(objectId) ? objectId : null;
    const record = id ? this.records.get(id) : undefined;
    if (!id || !record || record.gone) {
      return { ok: false, code: "NOT_FOUND", message: "no upload is waiting under that object id" };
    }
    if (record.owner !== owner) {
      return { ok: false, code: "FORBIDDEN", message: "that upload was begun for another owner" };
    }
    // Committed already: a retry after a lost reply gets the answer the first
    // commit gave rather than a refusal it cannot explain.
    if (!record.pending) return { ok: true, record };

    const home = this.homeOf(record)[0];
    const key = blobKey(record.owner, id);
    const seen = home ? await measureBlob(home, key) : null;
    const wrong = !seen
      ? "nothing was uploaded for it"
      : seen.size !== record.size
        ? `the upload is ${seen.size} bytes and begin declared ${record.size}`
        : seen.digest !== record.digest
          ? `the upload hashes to ${seen.digest} and begin declared ${record.digest}`
          : null;
    if (wrong) {
      if (home) await home.del(key);
      await this.drop(record);
      return { ok: false, code: "MISMATCH", message: `the file was not stored: ${wrong}. Begin again.` };
    }
    const live: ArtifactRecord = { ...record };
    delete live.pending;
    await this.write(live);
    return { ok: true, record: live };
  }

  async fetch(ref: unknown, opts: FetchOptions = {}): Promise<FetchResult> {
    const id = objectIdFrom(ref);
    if (!id) return { ok: false, code: "NOT_FOUND" };
    const record = this.records.get(id);
    if (!record || record.pending) return { ok: false, code: "NOT_FOUND" };
    if (record.gone) return { ok: false, code: "GONE", record };
    const key = blobKey(record.owner, id);

    const signer = this.signerOf(record);
    if (signer && opts.linkOver !== undefined && record.size > opts.linkOver) {
      return { ok: true, record, link: await signer.signedDownloadUrl(key, this.downloadOpts(record)) };
    }
    if (opts.inlineCeiling !== undefined && record.size > opts.inlineCeiling) {
      return { ok: false, code: "TOO_LARGE", record };
    }

    let bytes: Uint8Array | null = null;
    for (const home of this.homeOf(record)) {
      bytes = await home.get(key);
      if (bytes) break;
    }
    if (!bytes) {
      // Index says live, store says absent. The index is the thing that is
      // wrong, so it is corrected rather than left to fail this way forever.
      await this.markGone(record);
      return { ok: false, code: "GONE", record: { ...record, gone: true } };
    }
    return { ok: true, record, bytes };
  }

  /** A download link for a live artifact, for any holder of its ref (§7.5.4:
   *  possession of the reference is the read capability, and a link is that
   *  same capability in a form a browser can use). `filename` names the
   *  download; the record's own name stands in when none is given. The
   *  storage answers with the record's media type, and `inline` has it shown
   *  in place rather than saved. */
  async link(ref: unknown, filename?: unknown, opts: { inline?: boolean } = {}): Promise<LinkResult> {
    const id = objectIdFrom(ref);
    const record = id ? this.records.get(id) : undefined;
    if (!id || !record || record.pending) return { ok: false, code: "NOT_FOUND" };
    if (record.gone) return { ok: false, code: "GONE", record };
    const signer = this.signerOf(record);
    if (!signer) return { ok: false, code: "NO_LINK", record };
    const asked = typeof filename === "string" && filename.trim() ? filename : undefined;
    const link = await signer.signedDownloadUrl(blobKey(record.owner, id), this.downloadOpts(record, asked, opts.inline === true));
    return { ok: true, record, link };
  }

  /**
   * Keep a live artifact under the caller's owner, from its ref alone.
   *
   * The new record is a deliverable like any other: a fresh object id, the
   * caller's owner and agent, the caller's retention (clamped), counted
   * against the caller's quota, with the size and digest of the source,
   * which the store checked when the source went live. Its bytes are a copy
   * made inside the storage. Nothing is downloaded or re-sent, and the
   * source is left exactly as it was, still its writer's to keep or delete.
   *
   * When the source's bytes are where no such copy can be made (the broker's
   * own store, which is where every file from before 2026-09-23 lives), no
   * copy is made and the answer says so: the caller records the original
   * ref, which still reads, and which expires when its writer's copy does.
   */
  async keep(ref: unknown, input: KeepInput): Promise<KeepResult> {
    const id = objectIdFrom(ref);
    const source = id ? this.records.get(id) : undefined;
    if (!id || !source || source.pending) return { ok: false, code: "NOT_FOUND" };
    if (source.gone) return { ok: false, code: "GONE", record: source };
    const copier = this.copierOf(source);
    if (!copier) {
      return {
        ok: true,
        copied: false,
        record: source,
        why:
          (source.store === undefined
            ? "this file is kept in the broker's own store, where no copy can be made without carrying its bytes"
            : `this file is kept in the "${source.store}" store, which cannot copy it`) +
          `, so the original reference was kept as it is. It stays its writer's, and it expires on ${source.expires_at}.`,
      };
    }
    const refused = this.admit(input.owner, input.agent, source.size);
    if (refused) return refused;

    const record = this.recordFor(
      {
        owner: input.owner,
        agent: input.agent,
        media_type: input.media_type?.trim() || source.media_type,
        name: input.name?.trim() || source.name,
        retain_days: input.retain_days,
      },
      source.size,
      source.digest,
    );
    // Bytes first, as in `put`: an index entry with nothing behind it is a
    // reference that resolves to nothing.
    if (!(await copier.copy(blobKey(source.owner, id), blobKey(record.owner, record.id)))) {
      // The index said live and the storage has nothing: the index is what is
      // wrong, corrected exactly as a fetch corrects it.
      await this.markGone(source);
      return { ok: false, code: "GONE", record: { ...source, gone: true } };
    }
    await this.write(record);
    return { ok: true, copied: true, record, source };
  }

  /**
   * Hold a file past the sweep, or let it go (`release`).
   *
   * Only the owner may, because a hold keeps bytes on the owner's storage
   * that would otherwise go, and a ref is only the right to read. A hold is a
   * lease of `holdMs` from now: the owner renews it while the reason lasts
   * (a published page showing the file), and a hold nobody renews runs out
   * by itself, so a page that goes without a release, or an account that
   * closes, never keeps a file for ever.
   *
   * Release takes the hold off and puts the file back on its own expiry. A
   * file whose own date has passed while it was held, or comes within the
   * default retention, is given the default retention from now, so letting
   * go of a file never deletes it on the spot.
   */
  async hold(ref: unknown, owner: string, on: boolean, now = Date.now()): Promise<HoldResult> {
    const id = objectIdFrom(ref);
    const record = id ? this.records.get(id) : undefined;
    if (!id || !record || record.pending) return { ok: false, code: "NOT_FOUND" };
    if (record.owner !== owner) return { ok: false, code: "FORBIDDEN" };
    if (record.gone) return { ok: false, code: "GONE", record };
    const next: ArtifactRecord = { ...record };
    if (on) {
      next.held_until = new Date(now + ARTIFACT_CONFIG.holdMs).toISOString();
    } else {
      if (next.held_until === undefined) return { ok: true, record };
      delete next.held_until;
      const floor = new Date(now + ARTIFACT_CONFIG.defaultRetentionMs).toISOString();
      if (next.expires_at < floor) next.expires_at = floor;
    }
    await this.write(next);
    return { ok: true, record: next };
  }

  stat(ref: unknown): ArtifactRecord | null {
    const id = objectIdFrom(ref);
    const record = id ? this.records.get(id) : undefined;
    return record && !record.pending ? record : null;
  }

  usage(owner: string): { bytes: number; objects: number; max_bytes: number; max_objects: number } {
    const used = usageOf(this.records.values(), owner);
    return {
      ...used,
      max_bytes: this.limits.maxBytesPerOwner,
      max_objects: this.limits.maxObjectsPerOwner,
    };
  }

  /** Delete on the owner's say-so. Only the owner may: an artifact is a
   *  deliverable, and letting a holder of the ref delete it would mean anybody
   *  it was forwarded to could destroy the original. A pending upload is
   *  dropped outright, which is how an uploader that failed gives its quota
   *  back without waiting for the sweep. */
  async remove(ref: unknown, owner: string): Promise<"removed" | "not_found" | "forbidden"> {
    const id = objectIdFrom(ref);
    const record = id ? this.records.get(id) : undefined;
    if (!id || !record) return "not_found";
    if (record.owner !== owner) return "forbidden";
    if (record.gone) return "removed";
    await this.deleteBytes(record);
    if (record.pending) await this.drop(record);
    else await this.markGone(record);
    return "removed";
  }

  /** Reclaim everything past its expiry (§7.5.2), and drop every upload that
   *  was begun and not committed within the hour. A file its owner holds is
   *  left until the hold runs out. Returns how many went. */
  async sweep(now = Date.now()): Promise<number> {
    let reclaimed = 0;
    let dropped = 0;
    for (const record of [...this.records.values()]) {
      if (record.gone) continue;
      try {
        if (record.pending) {
          if (Date.parse(record.created_at) + ARTIFACT_CONFIG.pendingMs > now) continue;
          await this.deleteBytes(record);
          await this.drop(record);
          dropped += 1;
          continue;
        }
        // A held file waits for the end of its hold, whatever its own date says.
        if (Date.parse(reclaimAt(record)) > now) continue;
        await this.deleteBytes(record);
        await this.markGone(record);
        reclaimed += 1;
      } catch (err) {
        console.error(`[artifacts] could not reclaim ${record.id}:`, err instanceof Error ? err.message : err);
      }
    }
    if (reclaimed) console.log(`[artifacts] reclaimed ${reclaimed} expired artifact(s)`);
    if (dropped) console.log(`[artifacts] dropped ${dropped} upload(s) begun and never committed`);
    return reclaimed + dropped;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** The checks every write makes before anything is stored: attribution,
   *  size, and the owner's two quotas. Null when the write may go ahead. */
  private admit(owner: string, agent: string, size: number): PutRefusal | null {
    if (!owner || !agent) {
      return { ok: false, code: "INVALID", message: "an artifact must be attributable to an agent and an owner" };
    }
    if (size === 0) {
      return { ok: false, code: "INVALID", message: "refusing to store zero bytes" };
    }
    if (size > this.limits.maxBytes) {
      return {
        ok: false,
        code: "TOO_LARGE",
        message: `artifact is ${size} bytes; this mesh stores at most ${this.limits.maxBytes}`,
      };
    }
    const used = usageOf(this.records.values(), owner);
    if (used.bytes + size > this.limits.maxBytesPerOwner) {
      return {
        ok: false,
        code: "QUOTA_EXCEEDED",
        message:
          `storing this would take you to ${used.bytes + size} bytes; your limit is ` +
          `${this.limits.maxBytesPerOwner}. Delete something, or let expired artifacts age out.`,
      };
    }
    if (used.objects + 1 > this.limits.maxObjectsPerOwner) {
      return {
        ok: false,
        code: "QUOTA_EXCEEDED",
        message: `you hold ${used.objects} artifacts; the limit is ${this.limits.maxObjectsPerOwner}`,
      };
    }
    return null;
  }

  private recordFor(
    input: { owner: string; agent: string; media_type?: string; name?: string; retain_days?: number },
    size: number,
    digest: string,
  ): ArtifactRecord {
    const now = Date.now();
    return {
      id: mintObjectId(),
      owner: input.owner,
      agent: input.agent,
      media_type: input.media_type?.trim() || "application/octet-stream",
      ...(input.name?.trim() ? { name: input.name.trim().slice(0, 256) } : {}),
      size,
      digest,
      created_at: new Date(now).toISOString(),
      expires_at: retentionFor(input.retain_days, now),
      ...(this.tag ? { store: this.tag } : {}),
    };
  }

  /**
   * Where a record's bytes may be, in the order to look.
   *
   * A record that names its store is read from that store and nowhere else.
   * One that names none predates the field: its bytes are in the broker's
   * object store if this deployment ever ran the default, which ours did.
   * The configured backend is tried after it, because a self-hosted mesh that
   * always ran the filesystem backend wrote records with no `store` too, and
   * looking only in the broker would find nothing and mark every one of its
   * files gone on first read.
   *
   * Empty when a record names a backend this service is not configured for.
   * That is an operator who changed backends with records still in the old
   * one, and it is answered as an error rather than as GONE, since the bytes
   * are probably fine where they are.
   */
  private homeOf(record: ArtifactRecord): BlobStore[] {
    if (record.store === undefined) return this.legacy === this.blobs ? [this.legacy] : [this.legacy, this.blobs];
    if (record.store === this.tag) return [this.blobs];
    throw new Error(
      `artifact ${record.id} is kept in the "${record.store}" store, which this service is not configured to read`,
    );
  }

  /** The backend that can sign for this record, or null. Only a record that
   *  names a signing store has one: a record with no `store` lives in the
   *  broker, which makes no links. */
  private signerOf(record: ArtifactRecord) {
    return record.store !== undefined && record.store === this.tag && canLink(this.blobs) ? this.blobs : null;
  }

  /** The backend that can copy this record's bytes inside itself, or null.
   *  The same rule as `signerOf`: only a record that names the configured
   *  store, and only when that store can copy. */
  private copierOf(record: ArtifactRecord) {
    return record.store !== undefined && record.store === this.tag && canCopy(this.blobs) ? this.blobs : null;
  }

  private downloadOpts(record: ArtifactRecord, filename?: string, inline = false): DownloadLinkOptions {
    // Made safe here, once, for every link: the name and the type came from
    // whoever stored the file and they are about to become response headers.
    return {
      expiresInMs: ARTIFACT_CONFIG.downloadLinkMs,
      filename: safeFilename(filename ?? record.name, record.id),
      contentType: safeMediaType(record.media_type),
      ...(inline ? { inline: true } : {}),
    };
  }

  /** Delete a record's bytes from wherever they may be. Deletes are no-ops on
   *  a backend that never held them, so a record with no `store` is simply
   *  deleted from both of its possible homes. */
  private async deleteBytes(record: ArtifactRecord): Promise<void> {
    for (const home of this.homeOf(record)) await home.del(blobKey(record.owner, record.id));
  }

  private async write(record: ArtifactRecord): Promise<void> {
    await this.kv.put(record.id, new TextEncoder().encode(JSON.stringify(record)));
    this.records.set(record.id, record);
  }

  private async markGone(record: ArtifactRecord): Promise<void> {
    await this.write({ ...record, gone: true });
  }

  /** Forget a record entirely. Only for a pending upload: it was never a
   *  deliverable, nobody holds a reference to it, and so there is no history
   *  for a GONE answer to keep truthful. */
  private async drop(record: ArtifactRecord): Promise<void> {
    await this.kv.delete(record.id);
    this.records.delete(record.id);
  }

  /** @internal for tests: build the store without a broker, optionally with a
   *  separate legacy backend and records already in the index. */
  static forTest(kv: KeyedLike, blobs: BlobStore, legacy?: BlobStore, records: ArtifactRecord[] = []): ArtifactStore {
    const store = new ArtifactStore(keyedOf(kv), blobs, legacy ?? blobs);
    for (const r of records) store.records.set(r.id, r);
    return store;
  }
}
