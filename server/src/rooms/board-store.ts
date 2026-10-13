import { randomUUID } from "node:crypto";
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";

/**
 * The work board: a room's optional whiteboard of claimable items.
 *
 * A meeting sometimes puts tasks on the whiteboard and people take them; most
 * meetings never do. This store is that whiteboard for a room — items posted
 * by members, addressed to nobody, taken by whoever claims first. The one
 * property that makes it a board rather than a message is the claim: exactly
 * one member wins it, everyone else is told it is taken, and a claim that goes
 * quiet past its lease returns the item to the board.
 *
 * Design rules inherited from the rest of this tree:
 *
 *  - A claim is an atomic revision-checked KV update, never read-then-put —
 *    the same doctrine as shared/scheduler.ts's KvLease, because two members
 *    doing the same work is the failure this whole surface exists to prevent.
 *  - Lease expiry is DERIVED ON READ from `lease_expires_at`, and stored state
 *    is only rewritten when the next writer comes through (a re-claim, a
 *    withdraw). A claim whose expiry only a sweep can observe is a claim a
 *    stopped sweep silently makes permanent (rfp/rfp-store.ts learned this).
 *  - Enumeration goes through `snapshotKvBucket`, never `kv.keys()`.
 *
 * What this store deliberately does not do: membership (the rooms service's
 * `admit` gates every verb before it reaches here), events (the service
 * publishes those into the room's own namespace), and Tasks (a claim MINTS a
 * task id, but the real Task record is created by the claimer's own first
 * task update — the task manager fixes a record's parties from the verified
 * sender of its creating update, so a record this service created would name
 * the board, not the worker, as the responder).
 */

export interface BoardClaimRecord {
  by: string;
  at: string;
  outcome: "expired" | "abandoned" | "done";
}

export interface BoardItem {
  item_id: string;
  room_id: string;
  /** One line: what is wanted. */
  title: string;
  /** Optional longer statement of the work. */
  detail?: string;
  /** Optional offering hint — what kind of agent should take this. */
  offering?: string;
  posted_by: string;
  posted_at: string;
  /** How long a claim holds before the item returns to the board. */
  lease_ms: number;
  state: "open" | "claimed" | "done" | "withdrawn";
  claimed_by?: string;
  claimed_at?: string;
  lease_expires_at?: string;
  /** Minted at claim time: the id the claimer opens the real Task under, so
   *  everything downstream (updates, artifacts, audit) rides the ordinary
   *  task machinery. Re-minted on every claim — each claim is a fresh
   *  engagement. */
  task_id?: string;
  done_at?: string;
  /** The claimer's completion note — a sentence, not a deliverable. */
  result_note?: string;
  /** Refs to deliverables (room drive refs, artifact refs). Claims by the
   *  completer; this store records them and never checks them. */
  artifacts?: string[];
  /** Prior claims that ended without completing: who held it, and how it
   *  ended. Bounded; oldest dropped. */
  claims?: BoardClaimRecord[];
}

/** An item as presented to readers: lease expiry already applied, so a lapsed
 *  claim reads as the open item it effectively is. Storage is not rewritten on
 *  read — the next writer does that. */
export type BoardItemView = BoardItem & { lease_lapsed?: boolean };

export interface BoardConfig {
  /** Open (claimable) items one room may hold at once. */
  maxOpenPerRoom: number;
  maxTitleChars: number;
  maxDetailChars: number;
  defaultLeaseMs: number;
  minLeaseMs: number;
  maxLeaseMs: number;
}

export const BOARD_CONFIG: BoardConfig = {
  maxOpenPerRoom: parseInt(process.env.BOARD_MAX_OPEN_PER_ROOM ?? "50", 10),
  maxTitleChars: parseInt(process.env.BOARD_MAX_TITLE_CHARS ?? "200", 10),
  maxDetailChars: parseInt(process.env.BOARD_MAX_DETAIL_CHARS ?? "4000", 10),
  defaultLeaseMs: parseInt(process.env.BOARD_DEFAULT_LEASE_MS ?? String(60 * 60 * 1000), 10),
  minLeaseMs: parseInt(process.env.BOARD_MIN_LEASE_MS ?? String(60 * 1000), 10),
  maxLeaseMs: parseInt(process.env.BOARD_MAX_LEASE_MS ?? String(7 * 24 * 60 * 60 * 1000), 10),
};

const MAX_CLAIM_HISTORY = 20;
const MAX_ARTIFACT_REFS = 10;
/** Long enough for a signed address or a deep storage path; board.json says
 *  the same number. */
export const MAX_ARTIFACT_REF_CHARS = 2000;
const MAX_NOTE_CHARS = 4000;

/** KV bucket. Key: `<room_id>.<item_id>` — both are subject tokens
 *  ([A-Za-z0-9_-]), so the dot is an unambiguous separator and a room's items
 *  share a key prefix. */
export const BOARD_BUCKET = "mesh_board_items";

export type BoardResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

const refuse = (code: string, message: string): { ok: false; code: string; message: string } => ({
  ok: false,
  code,
  message,
});

/** Lease expiry, derived on read. */
const lapsed = (item: BoardItem, now: number): boolean =>
  item.state === "claimed" &&
  !!item.lease_expires_at &&
  new Date(item.lease_expires_at).getTime() <= now;

/** The presented item: a lapsed claim reads as open. */
export function viewItem(item: BoardItem, now = Date.now()): BoardItemView {
  if (!lapsed(item, now)) return item;
  return { ...item, state: "open", lease_lapsed: true };
}

/** Whether a writer may treat this item as claimable right now. */
const claimable = (item: BoardItem, now: number): boolean =>
  item.state === "open" || lapsed(item, now);

/** Append a finished claim to the item's bounded history. */
function recordClaimEnd(item: BoardItem, outcome: BoardClaimRecord["outcome"]): void {
  if (!item.claimed_by || !item.claimed_at) return;
  if (!item.claims) item.claims = [];
  item.claims.push({ by: item.claimed_by, at: item.claimed_at, outcome });
  if (item.claims.length > MAX_CLAIM_HISTORY) {
    item.claims = item.claims.slice(-MAX_CLAIM_HISTORY);
  }
}

function clearClaim(item: BoardItem): void {
  delete item.claimed_by;
  delete item.claimed_at;
  delete item.lease_expires_at;
  delete item.task_id;
}

export class BoardStore {
  private kv: KeyedStore;

  constructor(
    js: StorageLike | undefined,
    kv: KeyedLike,
    private cfg: BoardConfig = BOARD_CONFIG,
  ) {
    this.kv = keyedOf(kv, js);
  }

  static async create(js: StorageLike, cfg: BoardConfig = BOARD_CONFIG): Promise<BoardStore> {
    return new BoardStore(undefined, await storageOf(js).keyed(BOARD_BUCKET), cfg);
  }

  /** Test seam: a fake bucket and clock-free config, no JetStream. */
  static forTest(js: StorageLike, kv: KeyedLike, cfg?: Partial<BoardConfig>): BoardStore {
    return new BoardStore(js, kv, { ...BOARD_CONFIG, ...cfg });
  }

  private key(roomId: string, itemId: string): string {
    return `${roomId}.${itemId}`;
  }

  private async read(roomId: string, itemId: string): Promise<{ item: BoardItem; revision: number } | null> {
    const entry = await this.kv.get(this.key(roomId, itemId));
    if (!entry || entry.value.length === 0) return null;
    try {
      return { item: entry.json<BoardItem>(), revision: entry.revision };
    } catch {
      return null;
    }
  }

  /** Every item on one room's board, presented (expiry applied), oldest first. */
  async list(roomId: string, now = Date.now()): Promise<BoardItemView[]> {
    const prefix = `${roomId}.`;
    const snapshot = await this.kv.list({ prefix });
    const items: BoardItemView[] = [];
    for (const [key, entry] of snapshot.entries) {
      if (!key.startsWith(prefix) || entry.length === 0) continue;
      try {
        items.push(viewItem(entry.json<BoardItem>(), now));
      } catch {
        console.warn(`[board] unparseable item record '${key}', skipped`);
      }
    }
    items.sort((a, b) => a.posted_at.localeCompare(b.posted_at));
    return items;
  }

  /** Every board in the bucket, one summary row per room that has items. */
  async summary(now = Date.now()): Promise<Map<string, { open: number; claimed: number; done: number; withdrawn: number }>> {
    const snapshot = await this.kv.list();
    const rooms = new Map<string, { open: number; claimed: number; done: number; withdrawn: number }>();
    for (const [key, entry] of snapshot.entries) {
      if (entry.length === 0) continue;
      let item: BoardItem;
      try {
        item = entry.json<BoardItem>();
      } catch {
        console.warn(`[board] unparseable item record '${key}', skipped`);
        continue;
      }
      const row = rooms.get(item.room_id) ?? { open: 0, claimed: 0, done: 0, withdrawn: 0 };
      row[viewItem(item, now).state] += 1;
      rooms.set(item.room_id, row);
    }
    return rooms;
  }

  async post(
    roomId: string,
    from: string,
    input: { title?: unknown; detail?: unknown; offering?: unknown; lease_ms?: unknown },
    now = Date.now(),
  ): Promise<BoardResult<BoardItem>> {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) return refuse("INVALID_ENVELOPE", "an item needs a title — one line saying what is wanted");
    if (title.length > this.cfg.maxTitleChars) {
      return refuse("INVALID_ENVELOPE", `title exceeds ${this.cfg.maxTitleChars} characters`);
    }
    const detail = typeof input.detail === "string" ? input.detail : undefined;
    if (detail && detail.length > this.cfg.maxDetailChars) {
      return refuse("INVALID_ENVELOPE", `detail exceeds ${this.cfg.maxDetailChars} characters`);
    }
    const offering = typeof input.offering === "string" && input.offering ? input.offering : undefined;
    const lease = this.leaseOf(input.lease_ms);
    if (typeof lease === "string") return refuse("INVALID_ENVELOPE", lease);

    // The cap counts what is claimable NOW (open + lapsed), not what was ever
    // posted — a board full of finished work should not refuse new work.
    const items = await this.list(roomId, now);
    const open = items.filter((i) => i.state === "open").length;
    if (open >= this.cfg.maxOpenPerRoom) {
      return refuse(
        "QUOTA_EXCEEDED",
        `this board already holds ${open} open item(s) (cap ${this.cfg.maxOpenPerRoom})`,
      );
    }

    const item: BoardItem = {
      item_id: randomUUID(),
      room_id: roomId,
      title,
      ...(detail ? { detail } : {}),
      ...(offering ? { offering } : {}),
      posted_by: from,
      posted_at: new Date(now).toISOString(),
      lease_ms: lease,
      state: "open",
    };
    // `create`, not `put`: the id is fresh, so a collision is a bug worth
    // throwing on, not overwriting through.
    await this.kv.create(this.key(roomId, item.item_id), JSON.stringify(item));
    return { ok: true, value: item };
  }

  /**
   * Take an item off the board. Atomic: the revision-checked update makes one
   * winner and tells everyone else the item is taken. A lapsed claim is
   * claimable — the takeover records the prior holder's claim as expired.
   */
  async claim(
    roomId: string,
    itemId: string,
    from: string,
    leaseMs?: unknown,
    now = Date.now(),
  ): Promise<BoardResult<BoardItem>> {
    const found = await this.read(roomId, itemId);
    if (!found) return refuse("NOT_FOUND", "no such item on this board");
    const { item, revision } = found;
    if (!claimable(item, now)) {
      const why =
        item.state === "claimed"
          ? `it is claimed by ${item.claimed_by?.slice(0, 12)}… until ${item.lease_expires_at}`
          : `it is ${item.state}`;
      return refuse("BOARD_ITEM_TAKEN", `this item cannot be claimed — ${why}`);
    }
    const lease = leaseMs === undefined ? item.lease_ms : this.leaseOf(leaseMs);
    if (typeof lease === "string") return refuse("INVALID_ENVELOPE", lease);

    if (lapsed(item, now)) recordClaimEnd(item, "expired");
    item.state = "claimed";
    item.claimed_by = from;
    item.claimed_at = new Date(now).toISOString();
    item.lease_expires_at = new Date(now + lease).toISOString();
    // A fresh task id per claim: each claim is a fresh engagement, and the
    // prior claimer may still hold the old id.
    item.task_id = randomUUID();

    try {
      await this.kv.update(this.key(roomId, itemId), JSON.stringify(item), revision);
    } catch {
      // Somebody else's write landed between our read and this update — which
      // means somebody else claimed it (or the poster withdrew it). Losing
      // this race IS the mutual exclusion working.
      return refuse("BOARD_ITEM_TAKEN", "another member claimed this item first");
    }
    return { ok: true, value: item };
  }

  /** The current claimer reports the work done. Tolerated past the lease so
   *  long as nobody re-claimed — the same stance the task manager takes on
   *  late completions (§7.7: accepted, recorded late). */
  async complete(
    roomId: string,
    itemId: string,
    from: string,
    input: { note?: unknown; artifacts?: unknown } = {},
    now = Date.now(),
  ): Promise<BoardResult<BoardItem>> {
    const note = typeof input.note === "string" ? input.note : undefined;
    if (note && note.length > MAX_NOTE_CHARS) {
      return refuse("INVALID_ENVELOPE", `note exceeds ${MAX_NOTE_CHARS} characters`);
    }
    // Every ref is kept whole or the item is refused with the limit: a ref
    // dropped without a word is a delivery the poster never sees.
    if (input.artifacts !== undefined && input.artifacts !== null && !Array.isArray(input.artifacts)) {
      return refuse("INVALID_ENVELOPE", "artifacts must be a list of refs");
    }
    const artifacts = Array.isArray(input.artifacts) ? input.artifacts : undefined;
    if (artifacts && artifacts.length > MAX_ARTIFACT_REFS) {
      return refuse("INVALID_ENVELOPE", `at most ${MAX_ARTIFACT_REFS} artifact refs`);
    }
    for (const [i, a] of (artifacts ?? []).entries()) {
      if (typeof a !== "string" || !a) {
        return refuse("INVALID_ENVELOPE", `artifact ref ${i + 1} is not a ref: each one is a string`);
      }
      if (a.length > MAX_ARTIFACT_REF_CHARS) {
        return refuse(
          "INVALID_ENVELOPE",
          `artifact ref ${i + 1} is ${a.length} characters; a ref may be at most ${MAX_ARTIFACT_REF_CHARS}`,
        );
      }
    }

    return this.endClaim(roomId, itemId, from, (item) => {
      recordClaimEnd(item, "done");
      item.state = "done";
      item.done_at = new Date(now).toISOString();
      if (note) item.result_note = note;
      if (artifacts?.length) item.artifacts = artifacts;
    });
  }

  /** The current claimer puts the item back. */
  async abandon(roomId: string, itemId: string, from: string): Promise<BoardResult<BoardItem>> {
    return this.endClaim(roomId, itemId, from, (item) => {
      recordClaimEnd(item, "abandoned");
      clearClaim(item);
      item.state = "open";
    });
  }

  /** The poster takes an unclaimed item down. A claimed item cannot be pulled
   *  out from under its worker — the poster waits for the lease. */
  async withdraw(roomId: string, itemId: string, from: string, now = Date.now()): Promise<BoardResult<BoardItem>> {
    const found = await this.read(roomId, itemId);
    if (!found) return refuse("NOT_FOUND", "no such item on this board");
    const { item, revision } = found;
    if (item.posted_by !== from) {
      return refuse("IDENTITY_MISMATCH", "only the member who posted an item may withdraw it");
    }
    if (!claimable(item, now)) {
      return refuse(
        "BOARD_ITEM_TAKEN",
        item.state === "claimed"
          ? `it is claimed until ${item.lease_expires_at}; withdraw after the lease lapses`
          : `it is already ${item.state}`,
      );
    }
    if (lapsed(item, now)) recordClaimEnd(item, "expired");
    clearClaim(item);
    item.state = "withdrawn";
    try {
      await this.kv.update(this.key(roomId, itemId), JSON.stringify(item), revision);
    } catch {
      return refuse("BOARD_ITEM_TAKEN", "another member claimed this item first");
    }
    return { ok: true, value: item };
  }

  /** Room gone → board gone. Returns how many items went with it. */
  async purgeRoom(roomId: string): Promise<number> {
    const snapshot = await this.kv.list();
    const prefix = `${roomId}.`;
    let purged = 0;
    for (const [key] of snapshot.entries) {
      if (!key.startsWith(prefix)) continue;
      try {
        await this.kv.delete(key);
        purged += 1;
      } catch { /* best-effort — the bucket has no other writer for this room */ }
    }
    return purged;
  }

  /** Shared gate for complete/abandon: current claimer only, atomic write. */
  private async endClaim(
    roomId: string,
    itemId: string,
    from: string,
    apply: (item: BoardItem) => void,
  ): Promise<BoardResult<BoardItem>> {
    const found = await this.read(roomId, itemId);
    if (!found) return refuse("NOT_FOUND", "no such item on this board");
    const { item, revision } = found;
    if (item.state !== "claimed" || item.claimed_by !== from) {
      return refuse(
        "IDENTITY_MISMATCH",
        item.state === "claimed"
          ? "this item is claimed by someone else"
          : `this item is ${item.state}, not claimed by you`,
      );
    }
    apply(item);
    try {
      await this.kv.update(this.key(roomId, itemId), JSON.stringify(item), revision);
    } catch {
      return refuse("BOARD_ITEM_TAKEN", "the item changed hands before this write landed");
    }
    return { ok: true, value: item };
  }

  private leaseOf(raw: unknown): number | string {
    if (raw === undefined || raw === null) return this.cfg.defaultLeaseMs;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      return "lease_ms must be a positive number of milliseconds";
    }
    return Math.min(Math.max(Math.round(raw), this.cfg.minLeaseMs), this.cfg.maxLeaseMs);
  }
}
