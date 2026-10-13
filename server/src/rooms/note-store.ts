import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";

/**
 * Notes on a file (EXT-5 §8.4): short, attributed statements about the exact
 * bytes of something already on a room's drive.
 *
 * Why it exists: a room multiplies work that only needs doing once. Ten members
 * each screening the same attachment is ten paid reads of one document, and none
 * of them can see the others' answer. A note is what one member found, left
 * beside the file for the rest — prior information a reader MAY act on and MAY
 * ignore, never a substitute for its own screening.
 *
 * The rules this store exists to keep, all of them from §8.4:
 *
 *  - **Keyed by digest, never by name or ref.** A digest is computed over the
 *    bytes, so a note about `sha256:abc…` is a note about exactly those bytes,
 *    permanently. Nobody can have a harmless version screened and then serve a
 *    different one — different bytes are a different digest and the note simply
 *    does not apply. A name could be reused; a digest cannot. The digest is
 *    otherwise OPAQUE here: this store checks its shape, lowercases it, and
 *    matches it exactly. It never computes one and never dereferences one.
 *  - **Additive.** Nothing in here edits, hides or replaces the file, the room
 *    record, or any message. A note adds a row beside a file and that is all it
 *    can do; the room reads exactly as it did before.
 *  - **Append-only per digest.** Several members may each note the same file and
 *    none of them overwrites another. The atomic unit is a revision-checked
 *    `update` and a LOSER RETRIES rather than refusing — losing that race means
 *    somebody else's note landed first, and both must survive. (The board's
 *    claim does the opposite with the same primitive, because there losing the
 *    race IS the answer.)
 *  - **Attributed, not privileged.** `by` is supplied by the caller of this
 *    store, which passes the VERIFIED sender of the envelope — never a value
 *    read out of a payload. There is no screener role: any member may write one.
 *
 * The one exception to append-only, and it is deliberate: a member's second note
 * on the same digest REPLACES its own earlier note in place. It is that member's
 * current statement about those bytes (a re-screen under a newer policy is the
 * ordinary case), nobody else's note is touched, and it makes the per-digest cap
 * count DISTINCT AUTHORS — so one member cannot fill a file's 32 slots on its own
 * and lock everyone else out.
 *
 * What this store deliberately does not do: membership (the rooms service's
 * `admit` gates both verbs before anything reaches here, EXT-5 §8.2), and the
 * drive check (the service holds the artifact list, and asks it whether the room
 * actually has bytes with this digest before a note about them is stored).
 */

/** A verdict is one of exactly three words. Anything else is refused rather
 *  than stored: a reader scanning a column of verdicts must be able to rely on
 *  the vocabulary, and a free-text verdict is a `reason` wearing a hat. */
export const NOTE_VERDICTS = ["pass", "flag", "hold"] as const;
export type NoteVerdict = (typeof NOTE_VERDICTS)[number];

/** Where the verdict came from, as claimed by the writer. Stored, never
 *  checked — the same stance the drive takes on an artifact's `origin`. */
export interface NoteSource {
  id?: string;
  policy?: string;
  version?: string;
}

export interface RoomNote {
  /** The note's schema tag (EXT-5 §8.4). One version so far. */
  note: "screening/v1";
  /** `sha256:<64 lowercase hex>` — the bytes this is about. */
  digest: string;
  verdict: NoteVerdict;
  /** Free text, capped (see NOTE_CONFIG.maxReasonChars). */
  reason?: string;
  /** The writing member: the VERIFIED sender of the envelope that carried the
   *  note. Never a payload field — a note is attributed by the signature that
   *  carried it, so a caller cannot write one as somebody else. */
  by: string;
  at: string;
  source?: NoteSource;
}

/** One KV value: every note on one digest, in the order they were first said. */
interface DigestNotes {
  room_id: string;
  digest: string;
  notes: RoomNote[];
}

/** A file and what has been said about it. */
export interface NotedFile {
  digest: string;
  notes: RoomNote[];
}

export interface NoteConfig {
  /** Notes one file may carry. Counts distinct authors (see above). At the cap
   *  a further member's note is REFUSED — nothing is dropped to make room,
   *  because dropping the oldest note would be an edit and §8.4 has none. */
  maxNotesPerDigest: number;
  /** Notes one room may hold across every file on its drive. The backstop that
   *  keeps this from being a way to grow a room's storage without bound: a room
   *  at the cap refuses further notes until it is reclaimed. */
  maxNotesPerRoom: number;
  /** A note is a sentence about a file, not a report. ~3 sentences; anything
   *  longer is a document and belongs on the drive as a file of its own (the
   *  stance board-store.ts takes on an item's `detail`). */
  maxReasonChars: number;
}

export const NOTE_CONFIG: NoteConfig = {
  maxNotesPerDigest: parseInt(process.env.ROOM_NOTES_MAX_PER_DIGEST ?? "32", 10),
  maxNotesPerRoom: parseInt(process.env.ROOM_NOTES_MAX_PER_ROOM ?? "512", 10),
  maxReasonChars: parseInt(process.env.ROOM_NOTES_MAX_REASON_CHARS ?? "500", 10),
};

/** Each of `source.id` / `.policy` / `.version` is an identifier, not prose. */
const MAX_SOURCE_FIELD_CHARS = 128;

/** How many times an append re-reads and re-writes after losing the revision
 *  race. Each loss means another member's note landed in between, so a retry is
 *  the correct response; the bound is only there so a pathological writer
 *  cannot spin. */
const APPEND_ATTEMPTS = 5;

/**
 * KV bucket. Key: `<room_id>.sha256-<hex>`.
 *
 * Two reads have to be cheap and this layout is what makes both so: ONE DIGEST
 * is a single `kv.get` of a single key (a reader opening a file does not scan
 * anything), and A ROOM is the key prefix `<room_id>.` over a bucket snapshot
 * (the same enumeration the board uses). Room ids are subject tokens
 * (`[A-Za-z0-9_-]`), so the dot is an unambiguous separator.
 *
 * The digest's `:` becomes `-` because a NATS KV key may not contain a colon;
 * the algorithm stays in the key rather than being stripped, so a future
 * `sha512-…` cannot collide with a `sha256-…` of the same hex.
 */
export const NOTES_BUCKET = "mesh_room_notes";

export type NoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; retryable?: boolean };

const refuse = (
  code: string,
  message: string,
  retryable = false,
): { ok: false; code: string; message: string; retryable: boolean } => ({
  ok: false,
  code,
  message,
  retryable,
});

/**
 * The one digest shape this mesh's drive uses (`rooms-service.ts` computes
 * `sha256:<hex>` on attach and requires it on a link), normalized to lowercase
 * so a note and the file it is about compare equal. Returns null for anything
 * else — a note about a digest nobody could have produced is a note about
 * nothing.
 */
export function normalizeDigest(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return /^sha256:[0-9a-f]{64}$/i.test(s) ? s.toLowerCase() : null;
}

/** The KV key for one room's notes on one digest. `digest` must already have
 *  been through `normalizeDigest`. */
function keyFor(roomId: string, digest: string): string {
  return `${roomId}.${digest.replace(":", "-")}`;
}

export class NoteStore {
  private kv: KeyedStore;

  constructor(
    js: StorageLike | undefined,
    kv: KeyedLike,
    private cfg: NoteConfig = NOTE_CONFIG,
  ) {
    this.kv = keyedOf(kv, js);
  }

  static async create(js: StorageLike, cfg: NoteConfig = NOTE_CONFIG): Promise<NoteStore> {
    return new NoteStore(undefined, await storageOf(js).keyed(NOTES_BUCKET), cfg);
  }

  /** Test seam: a fake bucket, no JetStream. */
  static forTest(js: StorageLike, kv: KeyedLike, cfg?: Partial<NoteConfig>): NoteStore {
    return new NoteStore(js, kv, { ...NOTE_CONFIG, ...cfg });
  }

  private async read(
    roomId: string,
    digest: string,
  ): Promise<{ record: DigestNotes; revision: number } | null> {
    const entry = await this.kv.get(keyFor(roomId, digest));
    if (!entry || entry.value.length === 0) return null;
    try {
      return { record: entry.json<DigestNotes>(), revision: entry.revision };
    } catch {
      return null;
    }
  }

  /** What this room's members have said about one digest. An unnoted file
   *  answers with an empty list, not an error: "nobody has looked at this yet"
   *  is an ordinary, useful answer and the commonest one. */
  async forDigest(roomId: string, rawDigest: unknown): Promise<RoomNote[]> {
    const digest = normalizeDigest(rawDigest);
    if (!digest) return [];
    const found = await this.read(roomId, digest);
    return found?.record.notes ?? [];
  }

  /** Every noted file in one room, earliest-noted first. */
  async listRoom(roomId: string): Promise<NotedFile[]> {
    const snapshot = await this.kv.list();
    const files: NotedFile[] = [];
    const prefix = `${roomId}.`;
    for (const [key, entry] of snapshot.entries) {
      if (!key.startsWith(prefix) || entry.length === 0) continue;
      try {
        const record = entry.json<DigestNotes>();
        if (record.notes?.length) files.push({ digest: record.digest, notes: record.notes });
      } catch {
        console.warn(`[rooms] unparseable note record '${key}', skipped`);
      }
    }
    files.sort(
      (a, b) =>
        (a.notes[0]?.at ?? "").localeCompare(b.notes[0]?.at ?? "") ||
        a.digest.localeCompare(b.digest),
    );
    return files;
  }

  /** Notes this room holds across every file. */
  async countRoom(roomId: string): Promise<number> {
    return (await this.listRoom(roomId)).reduce((n, f) => n + f.notes.length, 0);
  }

  /**
   * Attach one member's note to one digest.
   *
   * `by` is the caller's verified key, passed in by the service — this store
   * never reads an author out of `input`, so a payload that names somebody else
   * is simply ignored rather than believed.
   */
  async add(
    roomId: string,
    rawDigest: unknown,
    by: string,
    input: { verdict?: unknown; reason?: unknown; source?: unknown },
    now = Date.now(),
  ): Promise<NoteResult<{ note: RoomNote; notes: RoomNote[]; replaced: boolean }>> {
    const digest = normalizeDigest(rawDigest);
    if (!digest) {
      return refuse(
        "INVALID_ENVELOPE",
        "a note needs the file's digest as sha256:<64 hex> — the same digest the drive gave the file, " +
          "because a note is about exactly those bytes and nothing else",
      );
    }
    const verdict = input.verdict;
    if (typeof verdict !== "string" || !(NOTE_VERDICTS as readonly string[]).includes(verdict)) {
      return refuse(
        "INVALID_ENVELOPE",
        `verdict must be one of ${NOTE_VERDICTS.join(", ")} — got ${
          typeof verdict === "string" ? `"${verdict.slice(0, 32)}"` : typeof verdict
        }`,
      );
    }
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (reason.length > this.cfg.maxReasonChars) {
      return refuse(
        "INVALID_ENVELOPE",
        `reason exceeds ${this.cfg.maxReasonChars} characters — a note is a sentence about a file; ` +
          `anything longer belongs on the drive as a file of its own`,
      );
    }
    const source = sourceOf(input.source);
    if (source === "invalid") {
      return refuse(
        "INVALID_ENVELOPE",
        `source fields (id, policy, version) must be strings of at most ${MAX_SOURCE_FIELD_CHARS} characters`,
      );
    }

    const note: RoomNote = {
      note: "screening/v1",
      digest,
      verdict: verdict as NoteVerdict,
      ...(reason ? { reason } : {}),
      by,
      at: new Date(now).toISOString(),
      ...(source ? { source } : {}),
    };

    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
      const found = await this.read(roomId, digest);
      const notes = found ? [...found.record.notes] : [];
      const mine = notes.findIndex((n) => n.by === by);
      const replaced = mine >= 0;

      if (!replaced) {
        if (notes.length >= this.cfg.maxNotesPerDigest) {
          return refuse(
            "QUOTA_EXCEEDED",
            `this file already carries ${notes.length} notes (the cap is ${this.cfg.maxNotesPerDigest}). ` +
              `Notes are append-only, so none is dropped to make room — this one was NOT stored. ` +
              `A member who already noted this file may replace its own note.`,
          );
        }
        // Only a note that ADDS one needs the room counted, and counting means
        // enumerating the bucket — so a re-screen by a member who already noted
        // the file costs one get and one put.
        const roomTotal = await this.countRoom(roomId);
        if (roomTotal >= this.cfg.maxNotesPerRoom) {
          return refuse(
            "QUOTA_EXCEEDED",
            `this room already holds ${roomTotal} notes across its files (the cap is ${this.cfg.maxNotesPerRoom}). ` +
              `Nothing was stored and nothing was dropped; the notes go when the room does.`,
          );
        }
      }

      if (replaced) notes[mine] = note;
      else notes.push(note);
      const record: DigestNotes = { room_id: roomId, digest, notes };
      const body = JSON.stringify(record);

      try {
        // Revision-checked, never read-then-put: two members noting the same
        // file at the same moment must both end up on it, and a blind put would
        // silently drop whichever landed first.
        if (found) await this.kv.update(keyFor(roomId, digest), body, found.revision);
        else await this.kv.create(keyFor(roomId, digest), body);
        return { ok: true, value: { note, notes, replaced } };
      } catch {
        // Somebody else's note landed between the read and the write. Unlike a
        // board claim, losing here is not an answer — re-read and append again.
        continue;
      }
    }
    return refuse(
      "INTERNAL_ERROR",
      `could not append the note after ${APPEND_ATTEMPTS} attempts — other members are writing notes on ` +
        `this file right now; nothing was stored, so retry`,
      true,
    );
  }

  /** Room gone → its notes go with it. Returns how many notes went. Notes are
   *  per-room records with no life of their own, and leaving them would hand a
   *  reprovisioned room id somebody else's screening history. */
  async purgeRoom(roomId: string): Promise<number> {
    const snapshot = await this.kv.list();
    const prefix = `${roomId}.`;
    let purged = 0;
    for (const [key, entry] of snapshot.entries) {
      if (!key.startsWith(prefix)) continue;
      let count = 1;
      try {
        count = entry.json<DigestNotes>().notes?.length ?? 0;
      } catch { /* unparseable: delete it anyway, count it as one */ }
      try {
        await this.kv.delete(key);
        purged += count;
      } catch { /* best-effort — the bucket has no other writer for this room */ }
    }
    return purged;
  }
}

/** The writer's provenance claim, trimmed to the three fields §8.4 names.
 *  `"invalid"` (rather than a silent drop) when a field is present but not a
 *  short string: a source that was misunderstood is worse than none. */
function sourceOf(raw: unknown): NoteSource | undefined | "invalid" {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") return "invalid";
  const out: NoteSource = {};
  for (const field of ["id", "policy", "version"] as const) {
    const v = (raw as Record<string, unknown>)[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || v.length > MAX_SOURCE_FIELD_CHARS) return "invalid";
    const trimmed = v.trim();
    if (trimmed) out[field] = trimmed;
  }
  return Object.keys(out).length ? out : undefined;
}
