import { messagingOf, type MessagingLike } from "../storage/index.js";
import type { BusSubscription, Messaging, StorageLike } from "../storage/index.js";
import { storageOf, type KeyedStore, type StreamFamily, type StreamSpec, type StreamState } from "../storage/index.js";
import { createHash } from "node:crypto";
import { encodeUser } from "nats-jwt";
import type { Envelope, RoomDescriptor } from "../sdk.js";
import { createEnvelope, childSpan, ErrorCode, nkeys, verifyDescriptor, verifyEnvelopeSig } from "../sdk.js";
import { EVENTS_STREAM, EVENTS_MIGRATION_TOOL } from "../shared/events-stream.js";
import { identityFromEnv, seedFileFromEnv } from "../shared/seed.js";
import { subscribeWithHandler, idOf, sealEnvelope } from "../shared/handler.js";
import { serviceQueue } from "../shared/queue-groups.js";
import { createDriveBackend, type DriveBackend } from "./drive.js";
import { BoardStore, viewItem, type BoardItem } from "./board-store.js";
import { NoteStore, normalizeDigest } from "./note-store.js";
import { metrics } from "../shared/ops-events.js";
import { buildDossier, type DossierEntry, type RoomDossier } from "./dossier.js";
import { AgentStatusStore } from "../shared/agent-status.js";
import { AgentOwnerStore, roomAccountOf, roomOperatorOf, roomQuotaHolder } from "../keychain/agent-owners.js";
import { tenantLimitCache } from "../keychain/tenant-limits.js";
import { namingUrl } from "../shared/settings.js";

/**
 * Rooms service (mesh://extensions/rooms/v1, durable slice).
 *
 * The operator-run member-service that provisions and gates the durable side
 * of a room: the RECORD (an ordered, replayable log of the room's messages)
 * and the DRIVE (a content-addressed blob store for artifacts). Ephemeral
 * rooms never touch this service — fan-out needs no provisioning. Durable
 * rooms do, because storage is the operator's cost, so this service is where
 * the public instance's caps live.
 *
 * Access model (capability grade): possession of the signed descriptor IS
 * membership, so every read/write request must carry the descriptor and it
 * must match what was provisioned. Provisioning additionally requires the
 * creator to be owned by someone identifiable, because durable storage is
 * counted against somebody. Two ways count (decided 2026-10-12): an account
 * owns the creator in the core's ownership record (keychain/agent-owners.ts),
 * and the room counts against that account; or, for an agent no account owns,
 * the creator reverse-resolves to a PAN-registered operator (an email-verified
 * human; the conformance suite's room-creator key is one), and the room counts
 * against that operator. Limits aggregate per account (else per operator), not
 * per agent: many agents, one owner.
 *
 * Refs are binding-decoupled: the record ref is `mesh:rooms:<room_id>`,
 * meaning "replay via this mesh's rooms service"; artifact refs are
 * `mesh:rooms:<room_id>/drive/<id>`. That the storage happens to be
 * JetStream is invisible to members.
 */

const SUBJECTS = {
  PROVISION: "mesh.rooms.provision",
  REPLAY: "mesh.rooms.replay",
  ATTACH: "mesh.rooms.attach",
  FETCH: "mesh.rooms.fetch",
  STATUS: "mesh.rooms.status",
  /** Usage vs quota (diagnostics; AGENTMESH_DIAGNOSTICS.md §4), for whatever
   *  the caller's rooms count against: its account, else its operator. Answers
   *  ONLY for the caller — no account or operator parameter. */
  USAGE: "mesh.rooms.usage",
  RECLAIM: "mesh.rooms.reclaim",
  DOSSIER: "mesh.rooms.dossier",
  /** Rooms the CALLER can reach, so a client is not amnesiac about its own
   *  rooms. Deliberately narrow — see handleMine on why the capability grade
   *  cannot be answered here. */
  MINE: "mesh.rooms.mine",
  /** Per-member read position in a room's record: the high-water mark a client
   *  needs to show "unread" without inventing its own storage. */
  CURSOR: "mesh.rooms.cursor",
  // acl grade (broker-enforced membership):
  ADMIT: "mesh.rooms.admit",
  CREDENTIAL: "mesh.rooms.credential",
  EXPEL: "mesh.rooms.expel",
  /** A member takes itself off the admit list (EXT-5 §8.3). */
  LEAVE: "mesh.rooms.leave",
  // Notes on a file (EXT-5 §8.4): a member's short, attributed statement about
  // the exact bytes of something on the drive, keyed by digest. Member-only
  // both ways, like everything else here; additive, so neither verb touches the
  // room record, the drive, or any message.
  /** Write a note about one digest. */
  NOTE: "mesh.rooms.note",
  /** Read notes: for one digest, or for every noted file on the drive. */
  NOTES: "mesh.rooms.notes",
  // The work board (EXT-5 §10): a room's optional whiteboard of claimable
  // items. Handled here rather than by a separate service because every verb
  // is gated on room membership, and membership lives in this process.
  BOARD_POST: "mesh.board.post",
  BOARD_LIST: "mesh.board.list",
  BOARD_CLAIM: "mesh.board.claim",
  BOARD_COMPLETE: "mesh.board.complete",
  BOARD_ABANDON: "mesh.board.abandon",
  BOARD_WITHDRAW: "mesh.board.withdraw",
} as const;

/** Minting key for acl scoped credentials. Prefer a DEDICATED account signing
 *  key (revocable, scoped to signing users) over the account identity key; when
 *  a signing key is used, `ROOMS_MINT_ISSUER_ACCOUNT` must name the account so
 *  the broker maps minted users to it. Read from a file so it never lands in
 *  committed config. Absent → acl minting disabled; set but unreadable/invalid
 *  → refuse to boot (shared/seed.ts) — a bare catch here once turned root-owned
 *  seed files into a silently mint-less deployment. */
const MINT_SEED: string | null = seedFileFromEnv("ROOMS_MINT_SEED_FILE", {
  expectPublicPrefix: "A",
  expectedKind: "an ACCOUNT key (A…) that can sign user JWTs",
});
/** The account a signing-key-minted credential belongs to. Required when
 *  MINT_SEED is a signing key (not the account identity key). */
const MINT_ISSUER_ACCOUNT: string | undefined = process.env.ROOMS_MINT_ISSUER_ACCOUNT || undefined;
/** Short TTL on scoped acl credentials — a departed member's access lapses. */
const ACL_CRED_TTL_SEC = parseInt(process.env.ROOMS_ACL_CRED_TTL_SEC ?? "3600", 10);

interface RoomsConfig {
  /** Concurrent durable rooms one account may hold (one operator, for an
   *  agent no account owns). The setting keeps its old name. */
  maxRoomsPerOperator: number;
  /** Total drive bytes one account (else operator) may hold, across all its rooms. */
  maxDriveBytesPerOperator: number;
  /** Largest single artifact (raw bytes; transport carries it base64 in one message). */
  maxArtifactBytes: number;
  /** Record limits applied to each room's stream. */
  maxRecordMsgs: number;
  maxRecordBytes: number;
  /** A durable room idle this long is reclaimed (record + drive deleted). */
  idleExpiryMs: number;
  sweepIntervalMs: number;
  /** PAN registrar used to reverse-resolve creator → operator; none on a
   *  server with no naming service, where the custody record decides alone. */
  registrar: string | undefined;
  /** Require an owning account or a PAN-registered operator to provision
   *  (a core server without either can turn it off). */
  requireOperator: boolean;
}

const CONFIG: RoomsConfig = {
  maxRoomsPerOperator: parseInt(process.env.ROOMS_MAX_PER_OPERATOR ?? "10", 10),
  maxDriveBytesPerOperator: parseInt(process.env.ROOMS_DRIVE_BYTES_PER_OPERATOR ?? String(100 * 1024 * 1024), 10),
  maxArtifactBytes: parseInt(process.env.ROOMS_ARTIFACT_MAX_BYTES ?? String(512 * 1024), 10),
  maxRecordMsgs: parseInt(process.env.ROOMS_RECORD_MAX_MSGS ?? "10000", 10),
  maxRecordBytes: parseInt(process.env.ROOMS_RECORD_MAX_BYTES ?? String(8 * 1024 * 1024), 10),
  // 3 days (was 14): durable rooms are conversations, not archives — a room
  // idle for days is almost always a leak (a crashed host, an unreclaimed
  // meetup), and leaks eat the per-account cap. Long-lived rooms stay alive
  // by being used; anything needing longer sets ROOMS_IDLE_EXPIRY_MS.
  idleExpiryMs: parseInt(process.env.ROOMS_IDLE_EXPIRY_MS ?? String(3 * 24 * 60 * 60 * 1000), 10),
  sweepIntervalMs: parseInt(process.env.ROOMS_SWEEP_INTERVAL_MS ?? String(60 * 60 * 1000), 10),
  registrar: process.env.PAN_REGISTRAR ?? namingUrl(),
  requireOperator: process.env.ROOMS_REQUIRE_OPERATOR !== "0",
};

interface ArtifactMeta {
  ref: string;
  name: string;
  version: string;
  digest: string;
  media_type: string | null;
  size: number;
  attached_by: string;
  attached_at: string;
  /** What the attaching member said about where these bytes came from before
   *  they reached this room, or null when they originated here. The service
   *  stores the claim and never checks it: it is the member's statement about
   *  history outside this room, which is exactly the sort of thing a record
   *  should carry attributably and never adjudicate. */
  origin: string | null;
  /** Where the bytes live when they do not live here: a URL, a bucket
   *  reference, whatever the operator uses for material too big for a room
   *  drive (the per-artifact cap is 512 KB, so anything media-shaped qualifies).
   *
   *  The digest of an external artifact is a CLAIM BY THE MEMBER, not something
   *  this service computed — it never sees the bytes. That is the whole trade
   *  and it is not a weakness so long as it is stated: the room guarantees that
   *  a named party asserted these bytes hash to this value, which is exactly
   *  what makes the assertion checkable later by anyone who fetches them. */
  external: string | null;
}

interface RoomMeta {
  descriptor: RoomDescriptor;
  /** The label of whoever the room was opened for: the creator's PAN operator
   *  (an email), a hosted seat's email, or `account:<id>`. Shown to the creator
   *  and on the operator's screens. */
  operator: string | null;
  /** The account that owned the creator when the room was opened, from the
   *  ownership record; the room's limits count against it. Absent on rooms
   *  opened before 2026-10-12, and null when no account owned the creator. For
   *  those the creator's account is read from the record when counting, and
   *  never written back (holderOf). */
  account?: string | null;
  created_at: string;
  drive_bytes: number;
  artifacts: ArtifactMeta[];
  /** Whether the one idle-expiry warning has been emitted. Held per room rather
   *  than per sweep, so a service restart does not re-warn every room it is
   *  holding. Cleared when the room speaks again — going quiet a second time
   *  deserves telling a second time. */
  expiry_warned?: boolean;
  /** agent id → its read position in this room's record. Monotonic: a cursor
   *  only ever moves forward, so a client with two windows open cannot mark a
   *  room unread by being slower. Kept per member, so it says nothing about
   *  what anyone else has read. */
  cursors?: Record<string, { seq: number; at: string }>;
  /** acl grade only: agent ids admitted to the room (may request a scoped
   *  credential). The creator is admitted at provision. */
  acl_members?: string[];
  /** acl grade only: members the creator expelled (EXT-5 §8.1). A denied
   *  member is refused credential renewal — its room connection lapses within
   *  the credential TTL. Severity is recorded as signed, not judged; a later
   *  admit from the creator lifts the denial (an expel is not forever unless
   *  the creator never re-admits). */
  acl_denied?: Record<string, { severity: string; at: string }>;
}

const streamName = (roomId: string) => `rooms_${roomId}`;
const recordRef = (roomId: string) => `mesh:rooms:${roomId}`;
/** Non-acl rooms fan out on the open event namespace (guests allow-all). */
const roomSubjects = (roomId: string) => `mesh.event.room.${roomId}.>`;
/** acl rooms fan out on a namespace guests are denied; only service-issued
 *  scoped credentials may pub/sub it, so the broker enforces membership. */
const aclSubjects = (roomId: string) => `mesh.aclroom.${roomId}.>`;
const isAcl = (d: RoomDescriptor) => d.privacy === "acl";

/** The refusal for a creator nobody owns (UNAUTHORIZED, details.reason
 *  `no_owner_on_record`). Kept apart from QUOTA_EXCEEDED: closing a room frees
 *  a quota, and nothing frees this until an account owns the agent. */
export const NO_OWNER_WORDS =
  "This agent cannot open a durable room, because no account on this mesh owns it. " +
  "A durable room's storage is counted against the account that owns the agent opening it. " +
  "Add the agent to an account, or give it a name with an Agent Naming registrar, then try again. " +
  "Ephemeral rooms need neither.";

/** A quota holder as words: "account <id>" or "operator <email>". */
function holderWords(holder: string): string {
  return holder.startsWith("account:") ? `account ${holder.slice("account:".length)}` : `operator ${holder}`;
}

/**
 * The record stream for one durable room, as the storage layer is asked to
 * make it (family `rooms_<room>`).
 *
 * Split out of `handleProvision` so the settings applied to real rooms are the
 * ones a test can read, rather than literals buried behind descriptor
 * verification and an operator lookup. A full record stops recording; it never
 * rolls off its own genesis. A room's record is its only durable copy of what
 * was said in it (`mesh.rooms.replay` reads nothing else), which is why on
 * JetStream it is replicated by MESH_JS_REPLICAS like every other stream.
 *
 * acl rooms record on the enforced `mesh.aclroom.*` namespace so the stream
 * captures the same traffic members exchange. Open-namespace rooms record
 * `mesh.event.room.<id>.>`. On JetStream that space belongs to MESH_EVENTS, so
 * the binding makes the record a stream SOURCING the room's slice of it, and an
 * acl room's record binds its subjects itself (storage/jetstream/streams.ts,
 * `roomRecordConfig`).
 */
export function roomRecordSpec(d: RoomDescriptor): StreamSpec {
  return {
    subjects: [isAcl(d) ? aclSubjects(d.room_id) : roomSubjects(d.room_id)],
    maxMsgs: CONFIG.maxRecordMsgs,
    maxBytes: CONFIG.maxRecordBytes,
    discard: "new",
  };
}

export class RoomsService {
  /** Signing identity (§4.5). Stable if ROOMS_SEED is set; a set-but-unusable
   *  seed refuses to boot rather than falling back (shared/seed.ts). */
  private readonly kp = identityFromEnv("ROOMS_SEED");
  private subs: BusSubscription[] = [];
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** All provisioned rooms, seeded from KV at startup. */
  private rooms = new Map<string, RoomMeta>();
  /** creator agent id → operator email (reverse-resolution cache). */
  private operatorCache = new Map<string, { at: number; operator: string | null }>();
  /** The kill switch's per-agent status (shared/agent-status.ts), opened on
   *  first use by the credential handler. */
  private statusStore: AgentStatusStore | null = null;

  private constructor(
    private nc: Messaging,
    private js: StorageLike,
    /** Every durable room's record (storage layer, family `rooms_<room>`). */
    private records: StreamFamily,
    private kv: KeyedStore,
    private drive: DriveBackend,
    private board: BoardStore,
    private notes: NoteStore,
  ) {}

  /** What a room's record holds now. Throws when the room has no record, so
   *  each caller's "stream gone" branch runs as it always did. */
  private async recordInfo(roomId: string): Promise<StreamState> {
    const info = await this.records.member(roomId).info();
    if (!info) throw new Error(`stream not found: ${streamName(roomId)}`);
    return info;
  }

  static async create(nc: MessagingLike, js: StorageLike): Promise<RoomsService> {
    const storage = storageOf(js, nc);
    // The record streams of open-namespace rooms hold a slice of the events
    // stream (on JetStream they SOURCE from MESH_EVENTS), so it must exist
    // before any room stream is provisioned. Fail-soft: on a pre-migration
    // deployment this logs the 10065 refusal (storage/jetstream/events-stream.ts)
    // and the existing subject-bound records keep capturing on their own.
    await storage.stream("MESH_EVENTS").ensure();
    const kv = await storage.keyed("mesh_rooms");
    const drive = await createDriveBackend(js);
    const board = await BoardStore.create(js);
    const notes = await NoteStore.create(js);
    const svc = new RoomsService(messagingOf(nc), js, storage.streams("rooms_<room>"), kv, drive, board, notes);
    // The core's ownership record (keychain/agent-owners.ts) answers who a
    // hosted seat's rooms count against. Never fatal: without it, a creator
    // with no name and no record is refused, as one the record has no
    // answer for is.
    try {
      svc.owners = await AgentOwnerStore.create(js);
    } catch (err) {
      console.warn(`[rooms] the ownership record is not available: ${(err as Error).message}`);
    }

    // A short read here is not a smaller room list, it is rooms that exist on
    // the broker and that this service will not admit anyone to, will not
    // reclaim, and will not count against their operator's quota — so the next
    // provision request sees free quota that is not free. `snapshotKvBucket`
    // throws rather than returning a subset (shared/kv.ts explains why
    // `kv.keys()` could not).
    try {
      const snapshot = await kv.list();
      for (const [key, entry] of snapshot.entries) {
        if (entry.length === 0) continue;
        try {
          svc.rooms.set(key, entry.json<RoomMeta>());
        } catch { /* skip corrupt */ }
      }
      console.log(
        `[rooms] loaded ${svc.rooms.size} durable room(s) from KV ` +
          `(${snapshot.subjects} subject(s), ${snapshot.tombstoned.length} tombstoned)`,
      );
      // Transition detection, detection ONLY: a record stream still binding
      // `mesh.event.room.<id>.>` itself predates the MESH_EVENTS migration. It
      // keeps recording, but while any such stream exists MESH_EVENTS cannot
      // be created (10065): the fix is the migration tool's copy dance, run
      // once with full-permission credentials, never a boot-time delete of a
      // room's only transcript. The layout is JetStream's, so the check runs on
      // that binding only: elsewhere a record that holds its subjects itself is
      // simply what a record is.
      let subjectBound = 0;
      for (const [roomId, meta] of storage.binding === "jetstream" ? svc.rooms : new Map<string, RoomMeta>()) {
        if (isAcl(meta.descriptor)) continue; // acl records stay subject-bound by design
        try {
          const info = await svc.recordInfo(roomId);
          if (info.subjects.length > 0) subjectBound++;
        } catch { /* no stream to inspect; provision will recreate it */ }
      }
      if (subjectBound > 0) {
        console.error(
          `[rooms] ${subjectBound} room record stream(s) are still SUBJECT-BOUND ` +
            `(pre-MESH_EVENTS layout). Recording continues, but ${EVENTS_STREAM} cannot ` +
            `exist alongside them. Run ${EVENTS_MIGRATION_TOOL} to convert them; ` +
            `not auto-migrating at boot.`,
        );
      }
    } catch (err) {
      // An empty bucket snapshots successfully with zero entries, so reaching
      // here means the read itself failed and the room list is NOT known to be
      // empty. Say so; quota accounting below is built on this map.
      console.error(
        "[rooms] KV room load FAILED — existing durable rooms are not loaded, so " +
          "they cannot be admitted to or reclaimed and do not count against quota:",
        err instanceof Error ? err.message : err,
      );
    }
    return svc;
  }

  async start(): Promise<void> {
    const handlers: Array<[string, (env: Envelope) => Promise<Envelope>]> = [
      [SUBJECTS.PROVISION, (e) => this.handleProvision(e)],
      [SUBJECTS.REPLAY, (e) => this.handleReplay(e)],
      [SUBJECTS.ATTACH, (e) => this.handleAttach(e)],
      [SUBJECTS.FETCH, (e) => this.handleFetch(e)],
      [SUBJECTS.STATUS, (e) => this.handleStatus(e)],
      [SUBJECTS.USAGE, (e) => this.handleUsage(e)],
      [SUBJECTS.RECLAIM, (e) => this.handleReclaim(e)],
      [SUBJECTS.DOSSIER, (e) => this.handleDossier(e)],
      [SUBJECTS.ADMIT, (e) => this.handleAdmit(e)],
      [SUBJECTS.CREDENTIAL, (e) => this.handleCredential(e)],
      [SUBJECTS.EXPEL, (e) => this.handleExpel(e)],
      [SUBJECTS.LEAVE, (e) => this.handleLeave(e)],
      [SUBJECTS.NOTE, (e) => this.handleNote(e)],
      [SUBJECTS.NOTES, (e) => this.handleNotes(e)],
      [SUBJECTS.MINE, (e) => this.handleMine(e)],
      [SUBJECTS.CURSOR, (e) => this.handleCursor(e)],
      [SUBJECTS.BOARD_POST, (e) => this.handleBoard(e, "post")],
      [SUBJECTS.BOARD_LIST, (e) => this.handleBoard(e, "list")],
      [SUBJECTS.BOARD_CLAIM, (e) => this.handleBoard(e, "claim")],
      [SUBJECTS.BOARD_COMPLETE, (e) => this.handleBoard(e, "complete")],
      [SUBJECTS.BOARD_ABANDON, (e) => this.handleBoard(e, "abandon")],
      [SUBJECTS.BOARD_WITHDRAW, (e) => this.handleBoard(e, "withdraw")],
    ];
    // All of them join a queue group (shared/queue-groups.ts), so exactly one
    // rooms instance answers each request. Seven of them write, and two writes
    // are expensive to do twice: `provision` creates a stream and charges the
    // operator's room quota, and `credential` MINTS a scoped NATS user — a
    // second instance answering the same request would mint a second credential
    // that is handed to nobody, never used, and never revoked, while the reply
    // the caller kept refers to the other one.
    for (const [subject, fn] of handlers) {
      this.subs.push(
        subscribeWithHandler(
          this.nc,
          subject,
          this.kp,
          (env) => fn(env),
          undefined,
          undefined,
          serviceQueue(subject),
        ),
      );
    }
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((err) => console.error("[rooms] sweep error:", err));
    }, CONFIG.sweepIntervalMs);
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
    console.log(
      `[rooms] service up (${idOf(this.kp).slice(0, 12)}…) · drive: ${this.drive.kind} · caps: ` +
        `${CONFIG.maxRoomsPerOperator} rooms/account, ` +
        `${Math.round(CONFIG.maxDriveBytesPerOperator / 1024 / 1024)}MB drive/account, ` +
        `${Math.round(CONFIG.maxArtifactBytes / 1024)}KB/artifact, ` +
        `idle expiry ${Math.round(CONFIG.idleExpiryMs / 86_400_000)}d` +
        ` · acl ${MINT_SEED ? "ENABLED" : "disabled (no minting key)"}` +
        (CONFIG.requireOperator ? "" : " · OPERATOR CHECK DISABLED"),
    );
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const s of this.subs) s.unsubscribe();
  }

  // ── replies ───────────────────────────────────────────────────────────

  private ok(req: Envelope, payload: unknown): Envelope {
    return createEnvelope({
      type: "respond",
      from: idOf(this.kp),
      to: req.from,
      in_reply_to: req.id,
      trace: childSpan(req.trace),
      payload,
    });
  }

  private err(req: Envelope, code: string, message: string, retryable = false, details?: Record<string, unknown>): Envelope {
    return createEnvelope({
      type: "respond",
      from: idOf(this.kp),
      to: req.from,
      in_reply_to: req.id,
      trace: childSpan(req.trace),
      error: { code: code as ErrorCode, message, retryable, ...(details ? { details } : {}) },
    });
  }

  // ── membership: possession of the provisioned descriptor ─────────────

  /**
   * Returns the stored room iff the presented descriptor verifies and matches
   * what was provisioned (creator-signature equality is the match) — and, at the
   * `acl` grade, iff the verified caller is a current member.
   *
   * Descriptor possession IS membership at the `capability` and `sealed` grades;
   * that is what those grades mean. At the `acl` grade it is not. EXT-5 §8.1
   * promises that an expelled member loses access, and the broker keeps that
   * promise for LIVE traffic by refusing to renew the scoped credential — but
   * this service is a second door onto the same room, and it has to consult the
   * same list. Without this an expelled member still held the descriptor and
   * could replay the whole record from sequence 1 (including everything posted
   * after the expulsion), fetch every artifact, and attach against the creator's
   * quota.
   *
   * `allowNonMember` exists for handleCredential alone, which must distinguish
   * "never admitted" from "expelled" in its reply.
   */
  private admit(
    payload: { descriptor?: RoomDescriptor },
    from: string,
    allowNonMember = false,
  ): RoomMeta | null {
    const d = payload?.descriptor;
    if (!d || !verifyDescriptor(d)) return null;
    const meta = this.rooms.get(d.room_id);
    if (!meta || meta.descriptor.sig !== d.sig) return null;
    if (meta.acl_members && !allowNonMember) {
      if (meta.acl_denied?.[from]) return null;
      if (!meta.acl_members.includes(from)) return null;
    }
    return meta;
  }

  // ── operator resolution (PAN reverse lookup, cached 5 min) ────────────

  private async resolveOperator(agentId: string): Promise<string | null> {
    const hit = this.operatorCache.get(agentId);
    if (hit && Date.now() - hit.at < 300_000) return hit.operator;
    let operator: string | null = null;
    if (CONFIG.registrar) try {
      const res = await fetch(
        `${CONFIG.registrar}/api/resolve?agent_id=${encodeURIComponent(agentId)}`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (res.ok) {
        const body = (await res.json()) as { card?: { operator?: { email?: string; name?: string }; handle?: string } };
        operator = body?.card?.operator?.email ?? body?.card?.handle?.split(".").slice(1).join(".") ?? null;
      }
    } catch { /* registrar unreachable → treat as unresolved */ }
    // Second authority: the platform's own custody record. A hosted web
    // agent (the account app's rooms surface) is deliberately anonymous at
    // PAN, but its seed is held by this platform FOR an email-verified
    // account — which is exactly the "identifiable operator" the durable
    // check exists to name. Without this, every room the account app tried
    // to create was refused with "claim a PAN handle" (found live,
    // 2026-08-12). Same 5-minute cache, quota attributed to the same email
    // string a registrar resolution would have produced.
    if (!operator) operator = await this.custodyOperatorOf(agentId);
    this.operatorCache.set(agentId, { at: Date.now(), operator });
    return operator;
  }

  /** The hosted seat's custody, from the ownership record. The platform's
   *  own lookup stood behind it for one release (step 3, phase B) and never
   *  answered where the record did not; step 10a took it out. */
  private async custodyOperatorOf(agentId: string): Promise<string | null> {
    if (!this.owners) return null;
    try {
      return roomOperatorOf(await this.owners.agent(agentId));
    } catch (err) {
      console.warn(`[rooms] the ownership record could not be read for ${agentId.slice(0, 12)}…: ${(err as Error).message}`);
      return null;
    }
  }

  /** The core's ownership record, when this deployment has one. */
  private owners: AgentOwnerStore | null = null;

  /** creator agent id → the account that owns it (ownership record cache). */
  private accountCache = new Map<string, { at: number; account: string | null }>();

  /** The account that owns an agent, from the ownership record: any agent
   *  with one may open a durable room, and the room counts against it. Kept
   *  five minutes, a miss thirty seconds (an agent just added to an account
   *  should not wait five minutes to open a room); `fresh` skips the cache.
   *  Null when the record has no account for it or cannot be read. */
  private async ownerAccountOf(agentId: string, fresh = false): Promise<string | null> {
    if (!this.owners) return null;
    const hit = this.accountCache.get(agentId);
    if (!fresh && hit && Date.now() - hit.at < (hit.account ? 300_000 : 30_000)) return hit.account;
    try {
      const account = roomAccountOf(await this.owners.agent(agentId));
      this.accountCache.set(agentId, { at: Date.now(), account });
      return account;
    } catch (err) {
      console.warn(`[rooms] the ownership record could not be read for ${agentId.slice(0, 12)}…: ${(err as Error).message}`);
      return hit?.account ?? null;
    }
  }

  /** What a room's limits count against: the account stored on it, else (a
   *  room opened before 2026-10-12, or by an agent no account owned) the
   *  creator's account in the record now, else the room's operator. Worked out
   *  each time it is asked and never written to the room. */
  private async holderOf(meta: RoomMeta): Promise<string | null> {
    const account = meta.account ?? (await this.ownerAccountOf(meta.descriptor.creator));
    return roomQuotaHolder(account, meta.operator);
  }

  /** The room and drive caps for one holder: an account's own limits when the
   *  admin API set them (keychain/tenant-limits.ts), else this mesh's. */
  private async capsFor(holder: string | null): Promise<{ rooms: number; driveBytes: number }> {
    const tenant = holder?.startsWith("account:") ? holder.slice("account:".length) : null;
    const own = tenant ? (await tenantLimitCache())?.limitsFor(tenant) ?? null : null;
    return {
      rooms: own?.max_rooms ?? CONFIG.maxRoomsPerOperator,
      driveBytes: own?.max_drive_bytes ?? CONFIG.maxDriveBytesPerOperator,
    };
  }

  /** The rooms and drive bytes held against one account or operator. */
  private async holderUsage(holder: string): Promise<{ rooms: number; driveBytes: number }> {
    let rooms = 0, driveBytes = 0;
    for (const meta of [...this.rooms.values()]) {
      if ((await this.holderOf(meta)) === holder) {
        rooms += 1;
        driveBytes += meta.drive_bytes;
      }
    }
    return { rooms, driveBytes };
  }

  private async saveMeta(meta: RoomMeta): Promise<void> {
    this.rooms.set(meta.descriptor.room_id, meta);
    await this.kv.put(meta.descriptor.room_id, JSON.stringify(meta));
  }

  // ── provision ─────────────────────────────────────────────────────────

  private async handleProvision(req: Envelope): Promise<Envelope> {
    const payload = req.payload as { descriptor?: RoomDescriptor };
    const d = payload?.descriptor;
    if (!d || !verifyDescriptor(d)) {
      return this.err(req, ErrorCode.INVALID_ENVELOPE, "descriptor missing or failed verification");
    }
    if (req.from !== d.creator) {
      return this.err(req, ErrorCode.IDENTITY_MISMATCH, "only the descriptor's creator may provision its room");
    }
    if (d.record !== recordRef(d.room_id)) {
      return this.err(req, ErrorCode.INVALID_ENVELOPE,
        `descriptor.record must be "${recordRef(d.room_id)}" to provision here`);
    }
    // capability and sealed are provisionable; sealed just means the record
    // and drive will hold ciphertext (the service can't tell and needn't).
    // acl requires broker-enforced membership, which this instance doesn't
    // configure yet.
    if (d.privacy !== "capability" && d.privacy !== "sealed" && d.privacy !== "acl") {
      return this.err(req, ErrorCode.INVALID_ENVELOPE,
        `privacy grade "${d.privacy}" is not provisionable (capability, sealed, or acl)`);
    }
    if (d.privacy === "sealed" && !d.key_fingerprint) {
      return this.err(req, ErrorCode.INVALID_ENVELOPE, "sealed descriptor missing key_fingerprint");
    }
    if (isAcl(d) && !MINT_SEED) {
      return this.err(req, ErrorCode.INTERNAL_ERROR, "acl rooms are not available on this instance (no minting key configured)");
    }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(d.room_id)) {
      return this.err(req, ErrorCode.INVALID_ENVELOPE, "room_id must be 16-64 url-safe characters");
    }
    if (this.rooms.has(d.room_id)) {
      const existing = this.rooms.get(d.room_id)!;
      if (existing.descriptor.sig === d.sig) {
        return this.ok(req, { provisioned: true, record: d.record, already: true });
      }
      return this.err(req, ErrorCode.INVALID_ENVELOPE, "room_id is already provisioned");
    }

    // Durable storage must be owned by someone identifiable. An account that
    // owns the creator in the ownership record counts (decided 2026-10-12), and
    // so does a PAN registration (an email-verified human) for an agent no
    // account owns. The limits aggregate across everything that account (else
    // that operator) holds.
    const account = await this.ownerAccountOf(d.creator, true);
    const operator = (await this.resolveOperator(d.creator)) ?? (account ? `account:${account}` : null);
    if (CONFIG.requireOperator && !account && !operator) {
      return this.err(req, ErrorCode.UNAUTHORIZED, NO_OWNER_WORDS, false, { reason: "no_owner_on_record" });
    }
    const holder = roomQuotaHolder(account, operator);
    if (holder) {
      const usage = await this.holderUsage(holder);
      const caps = await this.capsFor(holder);
      if (usage.rooms >= caps.rooms) {
        return this.err(req, ErrorCode.QUOTA_EXCEEDED,
          `${holderWords(holder)} already holds ${usage.rooms}/${caps.rooms} durable rooms; ` +
          `close one (mesh.rooms.reclaim) to open another — list yours with: mesh-adapter diag rooms`);
      }
    }

    await this.records.member(d.room_id).create(roomRecordSpec(d));

    const meta: RoomMeta = {
      descriptor: d,
      operator,
      account,
      created_at: new Date().toISOString(),
      drive_bytes: 0,
      artifacts: [],
      ...(isAcl(d) ? { acl_members: [d.creator] } : {}),
    };
    await this.saveMeta(meta);
    console.log(`[rooms] provisioned ${isAcl(d) ? "acl " : ""}${d.name ?? d.room_id} for ${holder ?? "(no owner)"} (${d.creator.slice(0, 12)}…)`);
    metrics.event({ kind: "room_provision", actor: d.creator, target: d.room_id, meta: { privacy: d.privacy, operator, account } });
    return this.ok(req, {
      provisioned: true,
      record: d.record,
      subject_prefix: isAcl(d) ? `mesh.aclroom.${d.room_id}` : `mesh.event.room.${d.room_id}`,
      limits: {
        max_record_msgs: CONFIG.maxRecordMsgs,
        max_record_bytes: CONFIG.maxRecordBytes,
        max_artifact_bytes: CONFIG.maxArtifactBytes,
        idle_expiry_ms: CONFIG.idleExpiryMs,
      },
    });
  }

  // ── acl grade: admission + scoped-credential minting ──────────────────

  /** Creator admits an agent to an acl room (adds it to the admit list). */
  private async handleAdmit(req: Envelope): Promise<Envelope> {
    const payload = req.payload as { descriptor?: RoomDescriptor; agent_id?: string };
    const meta = this.admit(payload, req.from);
    if (!meta || !meta.acl_members) return this.err(req, ErrorCode.NOT_FOUND, "no such acl room for that descriptor");
    if (req.from !== meta.descriptor.creator) {
      return this.err(req, ErrorCode.IDENTITY_MISMATCH, "only the room's creator may admit members");
    }
    const agentId = payload.agent_id;
    if (!agentId || !/^U[A-Z2-7]{55}$/.test(agentId)) {
      return this.err(req, ErrorCode.INVALID_ENVELOPE, "admit needs a valid agent_id");
    }
    // A fresh admit from the creator lifts a standing expel (EXT-5 §8.1:
    // re-admission is the creator's call; the service records severity but
    // does not judge it).
    let changed = false;
    if (meta.acl_denied?.[agentId]) {
      delete meta.acl_denied[agentId];
      changed = true;
    }
    if (!meta.acl_members.includes(agentId)) {
      meta.acl_members.push(agentId);
      changed = true;
    }
    if (changed) {
      await this.saveMeta(meta);
      console.log(`[rooms] acl ${meta.descriptor.name ?? meta.descriptor.room_id}: admitted ${agentId.slice(0, 12)}…`);
    }
    return this.ok(req, { admitted: agentId, members: meta.acl_members.length });
  }

  /** An admitted member presents the descriptor and receives a short-lived
   *  credential scoped to exactly this room's subjects. Non-members (not on the
   *  admit list) are refused; guests are denied the namespace outright, so the
   *  broker enforces membership regardless of who holds the descriptor. */
  private async handleCredential(req: Envelope): Promise<Envelope> {
    const payload = req.payload as { descriptor?: RoomDescriptor };
    const meta = this.admit(payload, req.from, true);
    if (!meta || !meta.acl_members) return this.err(req, ErrorCode.NOT_FOUND, "no such acl room for that descriptor");
    // Expelled members are refused before the admit-list check: revocation is
    // refusal of renewal (EXT-5 §8.1) — the member's current credential lapses
    // within its short TTL and the broker stops carrying them.
    if (meta.acl_denied?.[req.from]) {
      return this.err(req, ErrorCode.UNAUTHORIZED, "expelled from this room; only the creator can re-admit you");
    }
    if (!meta.acl_members.includes(req.from)) {
      return this.err(req, ErrorCode.UNAUTHORIZED, "not admitted to this room; ask the creator for an invite");
    }
    // The kill switch (docs/kill-switch-plan.md item 1): a stopped agent is
    // issued no room credential. The status is the one the kill switch writes
    // out per agent (shared/agent-status.ts); an unreadable status refuses.
    try {
      this.statusStore ??= await AgentStatusStore.create(this.js);
      const st = await this.statusStore.get(req.from);
      if (st) {
        return this.err(req, ErrorCode.UNAUTHORIZED, st.status === "terminated"
          ? "agent_terminated: this agent was terminated, so it is issued no credential"
          : "agent_paused: this agent is paused, so it is issued no credential until it resumes");
      }
    } catch {
      return this.err(req, ErrorCode.INTERNAL_ERROR, "could not check whether this agent is stopped; try again shortly", true);
    }
    if (!MINT_SEED) return this.err(req, ErrorCode.INTERNAL_ERROR, "minting key unavailable");

    const roomId = meta.descriptor.room_id;
    const ukp = nkeys.createUser();
    const acctKp = nkeys.fromSeed(new TextEncoder().encode(MINT_SEED));
    const now = Math.floor(Date.now() / 1000);
    // Scope the request-reply inbox space to THIS ROOM. A blanket `_INBOX.>`
    // grant let any agent that ever joined any acl room publish onto every other
    // agent's reply inbox mesh-wide (forged responses) and subscribe to everyone
    // else's replies. Request-reply still works inside the room: the prefix is
    // room-scoped rather than per-credential, so members can answer each other
    // (the same blast radius they already have on the room's own subjects), and a
    // client that wants it points its transport's inbox prefix at `inbox_prefix`
    // below (nats.js `inboxPrefix`). Nothing needs it today — the room transport
    // publishes and subscribes and never requests — so a client that ignores it
    // is unaffected.
    const inboxPrefix = `_INBOX.aclroom.${roomId}`;
    const perms = { allow: [`mesh.aclroom.${roomId}.>`, `${inboxPrefix}.>`], deny: [] };
    const claim: Record<string, unknown> = { pub: perms, sub: perms };
    if (MINT_ISSUER_ACCOUNT) claim.issuer_account = MINT_ISSUER_ACCOUNT;
    const jwt = await encodeUser("aclroom-member", ukp, acctKp,
      claim as never, { exp: now + ACL_CRED_TTL_SEC });
    console.log(`[rooms] acl ${meta.descriptor.name ?? roomId}: issued scoped credential to ${req.from.slice(0, 12)}…`);
    return this.ok(req, {
      jwt,
      seed: new TextDecoder().decode(ukp.getSeed()),
      subject_prefix: `mesh.aclroom.${roomId}`,
      inbox_prefix: inboxPrefix,
      expires_at: new Date((now + ACL_CRED_TTL_SEC) * 1000).toISOString(),
    });
  }

  /** Creator expels a member from an acl room (EXT-5 §8.1, acl grade =
   *  enforced). The member comes off the admit list and lands in a denied
   *  set, so credential renewal is refused and its room connection lapses
   *  within the credential TTL — the broker itself stops carrying them.
   *  Severity is recorded as sent; a later admit from the creator re-admits
   *  (the service does not judge severity). */
  /** mesh.rooms.leave — a member takes ITSELF off an acl room (EXT-5 §8.3).
   *  Expel with the roles reversed, and gentler: no denied entry is written,
   *  because somebody who left in good standing may be re-admitted freely.
   *  The creator cannot leave — a room must always have somebody answerable
   *  for it — and is pointed at reclaim instead. Leaving twice is not an
   *  error: a retry after a timeout must not read as a refusal, so the
   *  already-gone case answers ok. Uses `allowNonMember` for exactly that
   *  case; the scoped credential lapses at its TTL like an expelled one —
   *  renewal is refused once off the admit list. */
  private async handleLeave(req: Envelope): Promise<Envelope> {
    const payload = req.payload as { descriptor?: RoomDescriptor };
    const meta = this.admit(payload, req.from, true);
    if (!meta || !meta.acl_members) return this.err(req, ErrorCode.NOT_FOUND, "no such acl room for that descriptor");
    if (req.from === meta.descriptor.creator) {
      return this.err(req, ErrorCode.INVALID_ENVELOPE,
        "the creator cannot leave its own room — close it instead (mesh.rooms.reclaim)");
    }
    if (!meta.acl_members.includes(req.from)) {
      return this.ok(req, { left: true, already: true, members: meta.acl_members.length });
    }
    meta.acl_members = meta.acl_members.filter((m) => m !== req.from);
    await this.saveMeta(meta);
    console.log(`[rooms] acl ${meta.descriptor.name ?? meta.descriptor.room_id}: ${req.from.slice(0, 12)}… left`);
    return this.ok(req, { left: true, members: meta.acl_members.length });
  }

  private async handleExpel(req: Envelope): Promise<Envelope> {
    const payload = req.payload as { descriptor?: RoomDescriptor; member?: string; severity?: string };
    const meta = this.admit(payload, req.from);
    if (!meta || !meta.acl_members) return this.err(req, ErrorCode.NOT_FOUND, "no such acl room for that descriptor");
    if (req.from !== meta.descriptor.creator) {
      return this.err(req, ErrorCode.IDENTITY_MISMATCH, "only the room's creator may expel members");
    }
    const member = payload.member;
    if (!member || !/^U[A-Z2-7]{55}$/.test(member)) {
      return this.err(req, ErrorCode.INVALID_ENVELOPE, "expel needs a valid member agent id");
    }
    if (member === meta.descriptor.creator) {
      return this.err(req, ErrorCode.INVALID_ENVELOPE, "the creator cannot expel itself; reclaim the room instead");
    }
    // Unknown severity is treated as `conduct` (EXT-5 §8.1).
    const severity = payload.severity === "timeout" || payload.severity === "safety"
      ? payload.severity : "conduct";
    meta.acl_members = meta.acl_members.filter((m) => m !== member);
    meta.acl_denied = { ...(meta.acl_denied ?? {}), [member]: { severity, at: new Date().toISOString() } };
    await this.saveMeta(meta);
    console.log(`[rooms] acl ${meta.descriptor.name ?? meta.descriptor.room_id}: expelled ${member.slice(0, 12)}… (${severity})`);
    return this.ok(req, { expelled: member, severity, members: meta.acl_members.length });
  }

  // ── replay ────────────────────────────────────────────────────────────

  private async handleReplay(req: Envelope): Promise<Envelope> {
    const payload = req.payload as { descriptor?: RoomDescriptor; from_seq?: number; limit?: number };
    const meta = this.admit(payload, req.from);
    if (!meta) return this.err(req, ErrorCode.NOT_FOUND, "no such durable room for that descriptor");
    const roomId = meta.descriptor.room_id;
    const fromSeq = Math.max(1, payload.from_seq ?? 1);
    const limit = Math.min(Math.max(1, payload.limit ?? 100), 200);

    const messages: Array<{ seq: number; envelope: unknown }> = [];
    let budget = 600 * 1024; // stay under one transport message
    let nextSeq = fromSeq;
    let done = false;
    try {
      const batch = this.records.member(roomId).readFrom(fromSeq, { max: limit, waitMs: 3000 });
      for await (const m of batch) {
        const text = new TextDecoder().decode(m.data);
        budget -= text.length;
        // Read by an ordered consumer, which takes no acknowledgment, so the
        // message left unread here is simply read again from `next_seq`.
        if (budget < 0 && messages.length > 0) break;
        try { messages.push({ seq: m.seq, envelope: JSON.parse(text) }); }
        catch { messages.push({ seq: m.seq, envelope: null }); }
        nextSeq = m.seq + 1;
      }
      const info = await this.recordInfo(roomId);
      done = nextSeq > info.lastSeq;
    } catch (err) {
      return this.err(req, ErrorCode.INTERNAL_ERROR,
        `replay failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    return this.ok(req, { messages, next_seq: nextSeq, done });
  }

  // ── drive: attach / fetch ─────────────────────────────────────────────

  private async handleAttach(req: Envelope): Promise<Envelope> {
    const payload = req.payload as {
      descriptor?: RoomDescriptor; name?: string; version?: string;
      media_type?: string; data_b64?: string; origin?: string;
      location?: string; digest?: string; size?: number;
    };
    const meta = this.admit(payload, req.from);
    if (!meta) return this.err(req, ErrorCode.NOT_FOUND, "no such durable room for that descriptor");
    if (!payload.name) return this.err(req, ErrorCode.INVALID_ENVELOPE, "attach needs a name");

    // A LINK rather than an upload: the bytes live somewhere else and only the
    // location and the member's digest claim are recorded. No drive object, no
    // quota, and nothing here dereferences the location — this service must
    // never be talked into fetching a URL a remote member chose.
    if (payload.location) {
      if (payload.data_b64) {
        return this.err(req, ErrorCode.INVALID_ENVELOPE, "give bytes or a location, not both");
      }
      const loc = String(payload.location).trim();
      // Schemes are allow-listed because this string is rendered as a link by
      // every surface downstream, and `javascript:` in a room message is an
      // attack on the reader rather than a storage choice.
      if (!/^(https?|s3|gs|ipfs|magnet):/i.test(loc) || loc.length > 2048) {
        return this.err(req, ErrorCode.INVALID_ENVELOPE,
          "location must be an http(s), s3, gs, ipfs or magnet reference under 2048 characters");
      }
      if (!/^sha256:[0-9a-f]{64}$/i.test(String(payload.digest ?? ""))) {
        return this.err(req, ErrorCode.INVALID_ENVELOPE,
          "a linked artifact needs a sha256:<64 hex> digest — without one the reference cannot be checked, " +
          "and an unverifiable pointer is not an artifact");
      }
      const linked: ArtifactMeta = {
        ref: `${recordRef(meta.descriptor.room_id)}/link/${createHash("sha256").update(loc).digest("hex").slice(0, 16)}`,
        name: payload.name,
        version: payload.version ?? "1",
        digest: String(payload.digest).toLowerCase(),
        media_type: payload.media_type ?? null,
        size: typeof payload.size === "number" && payload.size >= 0 ? payload.size : 0,
        attached_by: req.from,
        attached_at: new Date().toISOString(),
        origin: typeof payload.origin === "string" && payload.origin.trim()
          ? payload.origin.trim().slice(0, 512) : null,
        external: loc,
      };
      meta.artifacts.push(linked);
      await this.saveMeta(meta);
      console.log(`[rooms] link ${linked.name} → ${loc.slice(0, 60)} by ${req.from.slice(0, 12)}…`);
      return this.ok(req, { ref: linked.ref, digest: linked.digest, size: linked.size, media_type: linked.media_type, external: loc });
    }

    if (!payload.data_b64) {
      return this.err(req, ErrorCode.INVALID_ENVELOPE, "attach needs data_b64, or a location for bytes held elsewhere");
    }
    let bytes: Buffer;
    try { bytes = Buffer.from(payload.data_b64, "base64"); }
    catch { return this.err(req, ErrorCode.INVALID_ENVELOPE, "data_b64 did not decode"); }
    if (bytes.length === 0) return this.err(req, ErrorCode.INVALID_ENVELOPE, "artifact is empty");
    if (bytes.length > CONFIG.maxArtifactBytes) {
      return this.err(req, ErrorCode.QUOTA_EXCEEDED,
        `artifact is ${bytes.length} bytes; the cap is ${CONFIG.maxArtifactBytes} per artifact`);
    }
    const holder = await this.holderOf(meta);
    if (holder) {
      const usage = await this.holderUsage(holder);
      const caps = await this.capsFor(holder);
      if (usage.driveBytes + bytes.length > caps.driveBytes) {
        return this.err(req, ErrorCode.QUOTA_EXCEEDED,
          `${holderWords(holder)} drive quota: ${usage.driveBytes} + ${bytes.length} exceeds ` +
          `${caps.driveBytes} bytes total`);
      }
    }

    const roomId = meta.descriptor.room_id;
    const objectId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const objectName = `${roomId}/${objectId}`;
    const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    await this.drive.put(objectName, new Uint8Array(bytes));

    const artifact: ArtifactMeta = {
      ref: `${recordRef(roomId)}/drive/${objectId}`,
      name: payload.name,
      version: payload.version ?? "1",
      digest,
      media_type: payload.media_type ?? null,
      size: bytes.length,
      attached_by: req.from,
      attached_at: new Date().toISOString(),
      // Bounded, because it is remote text that ends up on an operator console
      // and in every dossier. A provenance claim that needs more than this is a
      // document, and a document belongs on the drive as a file of its own.
      origin: typeof payload.origin === "string" && payload.origin.trim()
        ? payload.origin.trim().slice(0, 512)
        : null,
      external: null,
    };
    meta.artifacts.push(artifact);
    meta.drive_bytes += bytes.length;
    await this.saveMeta(meta);
    console.log(`[rooms] attach ${artifact.name} (${bytes.length}B) → ${artifact.ref} by ${req.from.slice(0, 12)}…`);
    // The member posts the signed `artifact` announcement itself — the
    // announcement is the attribution, and it must be the member's, not ours.
    return this.ok(req, { ref: artifact.ref, digest, size: bytes.length, media_type: artifact.media_type });
  }

  private async handleFetch(req: Envelope): Promise<Envelope> {
    const payload = req.payload as { descriptor?: RoomDescriptor; ref?: string };
    const meta = this.admit(payload, req.from);
    if (!meta) return this.err(req, ErrorCode.NOT_FOUND, "no such durable room for that descriptor");
    const artifact = meta.artifacts.find((a) => a.ref === payload.ref);
    if (!artifact) return this.err(req, ErrorCode.NOT_FOUND, "no artifact with that ref in this room");
    if (artifact.external) {
      // The room never held these bytes and will not go and get them: fetching
      // a member-supplied URL on a caller's behalf turns this service into an
      // open proxy inside whatever network it runs in. The caller gets the
      // location and the digest to check what it retrieves.
      return this.err(req, ErrorCode.INVALID_ENVELOPE,
        `${artifact.name} is held outside this room at ${artifact.external} — fetch it there and check it against ${artifact.digest}`);
    }
    const objectId = artifact.ref.split("/drive/")[1];
    const data = await this.drive.get(`${meta.descriptor.room_id}/${objectId}`);
    if (!data) return this.err(req, ErrorCode.NOT_FOUND, "artifact bytes are gone (reclaimed?)");
    return this.ok(req, {
      ref: artifact.ref,
      name: artifact.name,
      version: artifact.version,
      digest: artifact.digest,
      media_type: artifact.media_type,
      size: artifact.size,
      origin: artifact.origin ?? null,
      data_b64: Buffer.from(data).toString("base64"),
    });
  }

  // ── status ────────────────────────────────────────────────────────────

  /** Rooms the caller can reach.
   *
   *  WHAT THIS CAN AND CANNOT ANSWER, because the difference is a protocol fact
   *  rather than an omission. At the `acl` grade the service holds the admit
   *  list, so membership is authoritative here. A room the caller CREATED is
   *  likewise known, at every grade. But at the `capability` and `sealed` grades
   *  membership IS possession of the descriptor (EXT-5 §6) — the service never
   *  learns who holds one, and building an index of "who showed me a descriptor"
   *  would quietly turn a courtesy grade into a tracked one. So a client at
   *  those grades has to remember its own descriptors; that is the grade working
   *  as designed, and it is why the Gateway persists them locally.
   *
   *  Includes each room's `last_seq` and the caller's own cursor, so "unread"
   *  needs one round trip rather than one per room. */
  private async handleMine(req: Envelope): Promise<Envelope> {
    const mine: Array<Record<string, unknown>> = [];
    for (const meta of this.rooms.values()) {
      const isCreator = meta.descriptor.creator === req.from;
      const admitted = !!meta.acl_members?.includes(req.from) && !meta.acl_denied?.[req.from];
      if (!isCreator && !admitted) continue;

      let lastSeq: number | null = null;
      try {
        const info = await this.recordInfo(meta.descriptor.room_id);
        lastSeq = info.lastSeq;
      } catch { /* stream gone; report the room without a position */ }

      mine.push({
        descriptor: meta.descriptor,
        room_id: meta.descriptor.room_id,
        name: meta.descriptor.name ?? null,
        privacy: meta.descriptor.privacy,
        created_at: meta.created_at,
        role: isCreator ? "creator" : "member",
        last_seq: lastSeq,
        cursor: meta.cursors?.[req.from]?.seq ?? 0,
      });
    }
    mine.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return this.ok(req, { rooms: mine, complete: false });
  }

  /** Get or advance the caller's read position. `seq` present = set, absent =
   *  get. Authorization is ordinary room membership (`admit`), so at the acl
   *  grade an expelled member cannot keep writing a cursor.
   *
   *  Monotonic on purpose: a cursor that could move backwards lets a second,
   *  slower client mark a room unread again, which reads as a bug to the person
   *  looking at it. A caller that genuinely wants to re-read scrolls; it does
   *  not rewind the shared mark. */
  private async handleCursor(req: Envelope): Promise<Envelope> {
    const payload = req.payload as { descriptor?: RoomDescriptor; seq?: number };
    const meta = this.admit(payload, req.from);
    if (!meta) return this.err(req, ErrorCode.NOT_FOUND, "no such durable room for that descriptor");

    if (payload.seq === undefined) {
      const cur = meta.cursors?.[req.from];
      return this.ok(req, { seq: cur?.seq ?? 0, at: cur?.at ?? null });
    }
    if (!Number.isInteger(payload.seq) || payload.seq < 0) {
      return this.err(req, ErrorCode.INVALID_ENVELOPE, "seq must be a non-negative integer");
    }
    const existing = meta.cursors?.[req.from]?.seq ?? 0;
    const seq = Math.max(existing, payload.seq);
    meta.cursors = { ...(meta.cursors ?? {}), [req.from]: { seq, at: new Date().toISOString() } };
    await this.saveMeta(meta);
    return this.ok(req, { seq, at: meta.cursors[req.from].at, advanced: seq > existing });
  }

  // ── notes on a file (EXT-5 §8.4) ──────────────────────────────────────

  /**
   * `mesh.rooms.note` — attach a short, attributed statement to a file already
   * on this room's drive, keyed by the file's digest.
   *
   * Why the room answers this at all: screening the same attachment in a room of
   * ten members is ten paid reads of one document, and none of them can see the
   * others' answer. A note is what one member found, left where the rest can see
   * it. It is prior information and never a substitute — a reader's own
   * screening still runs when its agent reads the bytes.
   *
   * Three properties are the whole design, and each is enforced here:
   *
   *  - **Attributed by the signature that carried it.** `by` is the VERIFIED
   *    sender, so the envelope must actually be signed and a `by` in the payload
   *    is ignored outright. Attribution is the only reason a note is worth
   *    anything: a reader trusts one because of who signed it, the same way it
   *    trusts anything else said in the room. A caller that could name somebody
   *    else could put a "pass" on a malicious file over a name the room trusts.
   *  - **Member-only, checked service-side, both ways** (§8.2) — `admit`, the
   *    same gate the record and the drive use.
   *  - **Additive.** Nothing below writes to the room record, the drive, the
   *    artifact list, or any message; the note lands in its own store and the
   *    room reads exactly as it did before. That is also why, unlike the board,
   *    a note is NOT announced into the room's traffic namespace: at the acl and
   *    capability grades that namespace IS the record stream, so announcing
   *    would write the note into the record §8.4 promises is unchanged.
   *
   * There is no screener role and none is invented here: any member may write.
   */
  private async handleNote(req: Envelope): Promise<Envelope> {
    const payload = (req.payload ?? {}) as {
      descriptor?: RoomDescriptor;
      digest?: unknown;
      verdict?: unknown;
      reason?: unknown;
      source?: unknown;
    };
    const meta = this.admit(payload, req.from);
    if (!meta) return this.err(req, ErrorCode.NOT_FOUND, "no such durable room for that descriptor");
    if (!verifyEnvelopeSig(req)) {
      return this.err(req, ErrorCode.UNAUTHORIZED,
        "a note must arrive on a signed envelope — it is attributed to the key that signed it, " +
        "and an unsigned one attributes to nobody");
    }
    const digest = normalizeDigest(payload.digest);
    if (!digest) {
      return this.err(req, ErrorCode.INVALID_ENVELOPE,
        "a note needs the file's digest as sha256:<64 hex> — notes are keyed by digest, never by name " +
        "or ref, so that a note about these bytes cannot follow a name onto different ones");
    }
    // The note has to be about a file this room actually holds. Otherwise the
    // notes store is an arbitrary key-value bucket that any member can grow, and
    // a note about a digest nobody in the room can produce is a note about
    // nothing. Linked artifacts count: the digest is the member's claim about
    // bytes held elsewhere, and a note beside that claim is exactly the useful
    // case (somebody screened what the link resolves to).
    if (!meta.artifacts.some((a) => a.digest.toLowerCase() === digest)) {
      return this.err(req, ErrorCode.NOT_FOUND,
        `no file with that digest is on this room's drive — attach or link it first, ` +
        `then note the digest the drive gave back`);
    }
    const result = await this.notes.add(meta.descriptor.room_id, digest, req.from, payload);
    if (!result.ok) return this.err(req, result.code, result.message, result.retryable ?? false);
    console.log(
      `[rooms] note ${result.value.note.verdict} on ${digest.slice(0, 19)}… in ` +
      `${meta.descriptor.name ?? meta.descriptor.room_id} by ${req.from.slice(0, 12)}…` +
      (result.value.replaced ? " (replacing their own)" : ""),
    );
    return this.ok(req, {
      noted: true,
      digest,
      note: result.value.note,
      // Deliberately not called `notes`: on the read verb that name is the LIST
      // of notes, and one field name meaning a list on one reply and a count on
      // another is how a client ends up rendering `3` as a note.
      notes_on_file: result.value.notes.length,
      replaced: result.value.replaced,
    });
  }

  /** `mesh.rooms.notes` — read them back: one digest with `digest`, or every
   *  noted file on the drive without it. A file nobody has noted answers with
   *  an empty list rather than an error — "nobody has looked at this yet" is
   *  the commonest and most useful answer this verb gives. Every note carries
   *  its author, because a reader judges a note by who signed it. */
  private async handleNotes(req: Envelope): Promise<Envelope> {
    const payload = (req.payload ?? {}) as { descriptor?: RoomDescriptor; digest?: unknown };
    const meta = this.admit(payload, req.from);
    if (!meta) return this.err(req, ErrorCode.NOT_FOUND, "no such durable room for that descriptor");
    const roomId = meta.descriptor.room_id;

    if (payload.digest !== undefined && payload.digest !== null) {
      const digest = normalizeDigest(payload.digest);
      if (!digest) {
        return this.err(req, ErrorCode.INVALID_ENVELOPE,
          "digest must be sha256:<64 hex>, or absent to read every noted file in the room");
      }
      const notes = await this.notes.forDigest(roomId, digest);
      return this.ok(req, { digest, notes });
    }
    // Both shapes, because both readings are useful and neither is derived
    // wrongly from the other: `files` groups by digest for a surface listing the
    // drive, and `notes` is the same notes flat, in the same order, for a caller
    // that just wants them all. A note carries its own digest, so the flat list
    // loses nothing — and it means one field named `notes` holds a list of notes
    // on BOTH forms of this read, whether or not a digest was given.
    const files = await this.notes.listRoom(roomId);
    return this.ok(req, { files, notes: files.flatMap((f) => f.notes) });
  }

  // ── the work board (EXT-5 §10) ────────────────────────────────────────

  /**
   * One dispatcher for every board verb, because they share their whole
   * doorway: the caller presents the room descriptor, `admit` decides
   * membership exactly as it does for the record and the drive, and only then
   * does the verb touch the store. The board adds no access model of its own —
   * that is the design: who can see the whiteboard is who is in the meeting.
   */
  private async handleBoard(
    req: Envelope,
    verb: "post" | "list" | "claim" | "complete" | "abandon" | "withdraw",
  ): Promise<Envelope> {
    const payload = (req.payload ?? {}) as {
      descriptor?: RoomDescriptor;
      item_id?: unknown;
      title?: unknown;
      detail?: unknown;
      offering?: unknown;
      lease_ms?: unknown;
      note?: unknown;
      artifacts?: unknown;
    };
    // The board acts only as the sender the mesh proved: the key that signed
    // the envelope. The NATS door (wrapHandler's decode) already refuses an
    // envelope whose signature does not verify against its `from`; this says
    // so again here, so the rule holds whatever path reaches the handler. No
    // field in the payload (`from`, `by`, `posted_by`, `claimed_by`) names
    // who acts: the store is handed req.from and nothing else.
    if (!verifyEnvelopeSig(req)) {
      return this.err(req, ErrorCode.IDENTITY_MISMATCH,
        "a board request is made only as the agent that signed it, and this one's signature " +
        "does not verify against the sender it names");
    }
    const meta = this.admit(payload, req.from);
    if (!meta) return this.err(req, ErrorCode.NOT_FOUND, "no such durable room for that descriptor");
    const roomId = meta.descriptor.room_id;

    if (verb === "list") {
      const items = await this.board.list(roomId);
      return this.ok(req, {
        items,
        open: items.filter((i) => i.state === "open").length,
        claimed: items.filter((i) => i.state === "claimed").length,
        done: items.filter((i) => i.state === "done").length,
      });
    }

    const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
    let result;
    switch (verb) {
      case "post":
        result = await this.board.post(roomId, req.from, payload);
        break;
      case "claim":
        result = await this.board.claim(roomId, itemId, req.from, payload.lease_ms);
        break;
      case "complete":
        result = await this.board.complete(roomId, itemId, req.from, payload);
        break;
      case "abandon":
        result = await this.board.abandon(roomId, itemId, req.from);
        break;
      case "withdraw":
        result = await this.board.withdraw(roomId, itemId, req.from);
        break;
    }
    if (!result.ok) return this.err(req, result.code, result.message);
    this.announceBoard(meta, verb, result.value, req.from);
    return this.ok(req, { item: viewItem(result.value) });
  }

  /**
   * Announce a board change into the room's own traffic namespace, so members
   * see the whiteboard move without polling and the record stream captures it
   * as part of the meeting's transcript. Fire-and-forget on purpose: the write
   * to the store already succeeded, and a full record refusing one
   * announcement must not fail the verb it announces.
   */
  private announceBoard(
    meta: RoomMeta,
    verb: "post" | "claim" | "complete" | "abandon" | "withdraw",
    item: BoardItem,
    actor: string,
  ): void {
    const events = {
      post: "posted",
      claim: "claimed",
      complete: "done",
      abandon: "abandoned",
      withdraw: "withdrawn",
    } as const;
    const event = events[verb];
    const roomId = meta.descriptor.room_id;
    const root = isAcl(meta.descriptor) ? `mesh.aclroom.${roomId}` : `mesh.event.room.${roomId}`;
    // Slim on purpose: the record's byte budget belongs to the conversation.
    // Anyone who wants the whole item lists the board.
    const env = createEnvelope({
      type: "emit",
      from: idOf(this.kp),
      payload: {
        type: "board",
        event,
        item_id: item.item_id,
        title: item.title,
        actor,
        ...(event === "claimed" && item.lease_expires_at
          ? { lease_expires_at: item.lease_expires_at, task_id: item.task_id }
          : {}),
      },
    });
    try {
      this.nc.publish(`${root}.board.${event}`, sealEnvelope(env, this.kp));
    } catch (err) {
      console.warn(`[rooms] board announcement for ${roomId} did not publish:`, err);
    }
  }

  private async handleStatus(req: Envelope): Promise<Envelope> {
    const payload = req.payload as { descriptor?: RoomDescriptor };
    const meta = this.admit(payload, req.from);
    if (!meta) return this.err(req, ErrorCode.NOT_FOUND, "no such durable room for that descriptor");
    let record: unknown = null;
    // When this room dies of its own accord if nobody speaks. A durable room is
    // deleted after an idle window — record, drive and all — and a surface that
    // cannot say WHEN turns a documented policy into an unexplained
    // disappearance. Reclaim it deliberately, or say something in it, or take
    // the dossier: all three are choices, and none of them can be made by
    // someone who was never told.
    let expiresAt: string | null = null;
    try {
      const info = await this.recordInfo(meta.descriptor.room_id);
      record = {
        msgs: info.messages,
        bytes: info.bytes,
        first_seq: info.firstSeq,
        last_seq: info.lastSeq,
        last_ts: info.lastAt,
      };
      const last = new Date(info.lastAt ?? "").getTime();
      const from = Number.isFinite(last) && last > 0 ? last : new Date(meta.created_at).getTime();
      expiresAt = new Date(from + CONFIG.idleExpiryMs).toISOString();
    } catch { /* stream gone */ }
    // The operator is usually a person's email address (from PAN, or a hosted
    // seat's account), and the account is what the room's limits count
    // against. Both are the creator's own, so the creator sees them and nobody
    // else does — at the capability and sealed grades "anybody else" is every
    // holder of a pasteable token.
    const isCreator = req.from === meta.descriptor.creator;
    const holder = isCreator ? await this.holderOf(meta) : null;
    const caps = await this.capsFor(holder);
    return this.ok(req, {
      expires_at: expiresAt,
      room_id: meta.descriptor.room_id,
      name: meta.descriptor.name ?? null,
      operator: isCreator ? meta.operator : null,
      account: holder?.startsWith("account:") ? holder.slice("account:".length) : null,
      created_at: meta.created_at,
      record,
      drive: { bytes: meta.drive_bytes, artifacts: meta.artifacts },
      limits: {
        max_record_msgs: CONFIG.maxRecordMsgs,
        max_record_bytes: CONFIG.maxRecordBytes,
        max_artifact_bytes: CONFIG.maxArtifactBytes,
        max_rooms_per_account: caps.rooms,
        max_drive_bytes_per_account: caps.driveBytes,
        // The old name, the same number: an account's cap, else an operator's.
        max_drive_bytes_per_operator: caps.driveBytes,
        idle_expiry_ms: CONFIG.idleExpiryMs,
      },
    });
  }

  // ── usage (diagnostics: the caller's own account or operator vs quota) ──

  /** Durable-room usage for whatever the caller's rooms count against
   *  (AGENTMESH_DIAGNOSTICS.md §4): its account, else its operator. The caller
   *  asks about ITSELF: no parameter — the envelope signature proves the key,
   *  and the key leads to the account (ownership record) or the operator (PAN).
   *  Room ids are capability-sensitive (a capability-grade room's traffic rides
   *  an open namespace keyed by id), so an unsigned request is refused rather
   *  than trusting a spoofable `from`. Queries about anybody else are the ops
   *  tool's (server/tools/rooms-reclaim.mjs), never the wire's.
   *
   *  `operator` keeps its name for older readers and carries the holder:
   *  `account:<id>`, or the operator's email for an agent no account owns. */
  private async handleUsage(req: Envelope): Promise<Envelope> {
    if (!verifyEnvelopeSig(req)) {
      return this.err(req, ErrorCode.UNAUTHORIZED,
        "usage requires a signed envelope — the caller asks about its own rooms");
    }
    const account = await this.ownerAccountOf(req.from);
    const holder = roomQuotaHolder(account, account ? null : await this.resolveOperator(req.from));
    if (!holder) {
      return this.err(req, ErrorCode.NOT_FOUND,
        `no account on this mesh owns agent ${req.from.slice(0, 12)}…, and it has no name, ` +
        `so no durable-room quota is counted for it`);
    }
    const now = Date.now();
    const mine: RoomMeta[] = [];
    for (const m of [...this.rooms.values()]) if ((await this.holderOf(m)) === holder) mine.push(m);
    const list = mine
      .map((m) => ({
        name: m.descriptor.name ?? null,
        roomId: m.descriptor.room_id,
        ageSec: Math.max(0, Math.round((now - new Date(m.created_at).getTime()) / 1000)),
      }))
      .sort((a, b) => a.ageSec - b.ageSec);
    const caps = await this.capsFor(holder);
    return this.ok(req, {
      operator: holder,
      account,
      rooms: list.length,
      cap: caps.rooms,
      overCap: list.length >= caps.rooms,
      drive_bytes: mine.reduce((s, m) => s + m.drive_bytes, 0),
      drive_cap: caps.driveBytes,
      list,
    });
  }

  // ── dossier ───────────────────────────────────────────────────────────

  /** Read the whole record for a dossier.
   *
   *  Unpaged, unlike `replay`, because a dossier is one document and a document
   *  assembled from pages the caller had to stitch is not one document. The
   *  record is already capped per room (maxRecordMsgs / maxRecordBytes), so
   *  "all of it" is bounded by the same limits that bound the room. */
  private async fullRecord(roomId: string): Promise<DossierEntry[]> {
    const out: DossierEntry[] = [];
    try {
      const info = await this.recordInfo(roomId);
      if (!info.messages) return out;
      const batch = this.records.member(roomId).readFrom(1, { max: CONFIG.maxRecordMsgs, waitMs: 15_000 });
      for await (const m of batch) {
        let env: { from?: string; ts?: string; payload?: Record<string, unknown> } | null = null;
        try { env = JSON.parse(new TextDecoder().decode(m.data)); } catch { /* unreadable */ }
        const p = env?.payload ?? {};
        const type = typeof p.type === "string" ? p.type : "unknown";
        const e: DossierEntry = { seq: m.seq, ts: env?.ts ?? "", from: env?.from ?? "", type };
        if (type === "say" && typeof p.body === "string") e.body = p.body;
        if (typeof p.member === "string") e.member = p.member;
        if (type === "artifact") {
          e.artifact = {
            name: String(p.name ?? ""), version: String(p.version ?? ""),
            ref: String(p.ref ?? ""), digest: String(p.digest ?? ""),
            size: typeof p.size === "number" ? p.size : undefined,
            role: typeof p.role === "string" ? p.role : undefined,
          };
        }
        out.push(e);
        if (m.seq >= info.lastSeq) break;
      }
    } catch { /* a stream that will not read yields the dossier it can */ }
    return out;
  }

  /** Assemble and sign the dossier for a room. */
  private async dossierFor(meta: RoomMeta, why: string): Promise<RoomDossier> {
    const roomId = meta.descriptor.room_id;
    return buildDossier({
      room_id: roomId,
      room_name: meta.descriptor.name ?? null,
      creator: meta.descriptor.creator,
      operator: meta.operator,
      created_at: meta.created_at,
      closed_at: new Date().toISOString(),
      why,
      record: await this.fullRecord(roomId),
      files: meta.artifacts.map((a) => ({ ...a, origin: a.origin ?? null })),
      readBytes: async (ref) => {
        const objectId = ref.split("/drive/")[1];
        return objectId ? this.drive.get(`${roomId}/${objectId}`) : null;
      },
      signer: this.kp,
    });
  }

  private async handleDossier(req: Envelope): Promise<Envelope> {
    const payload = req.payload as { descriptor?: RoomDescriptor };
    const meta = this.admit(payload, req.from);
    if (!meta) return this.err(req, ErrorCode.NOT_FOUND, "no such durable room for that descriptor");
    // Any member, not the creator only: the dossier holds what everyone in the
    // room already saw and what they contributed themselves. A record you took
    // part in is not something you should have to ask its owner for.
    return this.ok(req, await this.dossierFor(meta, "requested while open"));
  }

  // ── reclaim (creator or the sweeper) ─────────────────────────────────

  private async handleReclaim(req: Envelope): Promise<Envelope> {
    const payload = req.payload as { descriptor?: RoomDescriptor };
    const meta = this.admit(payload, req.from);
    if (!meta) return this.err(req, ErrorCode.NOT_FOUND, "no such durable room for that descriptor");
    if (req.from !== meta.descriptor.creator) {
      return this.err(req, ErrorCode.IDENTITY_MISMATCH, "only the room's creator may reclaim it");
    }
    // Built BEFORE the delete and returned WITH it, so reclaiming and walking
    // away with nothing is not a thing a creator can do by accident. The record
    // and the accepted outputs go back in the same breath that destroys them.
    const dossier = await this.dossierFor(meta, "reclaimed by creator");
    await this.deleteRoom(meta, "reclaimed by creator");
    return this.ok(req, { reclaimed: true, dossier });
  }

  private async deleteRoom(meta: RoomMeta, why: string): Promise<void> {
    const roomId = meta.descriptor.room_id;
    try { await this.records.member(roomId).destroy(); } catch { /* already gone */ }
    for (const a of meta.artifacts) {
      const objectId = a.ref.split("/drive/")[1];
      try { await this.drive.del(`${roomId}/${objectId}`); } catch { /* already gone */ }
    }
    try { await this.drive.delRoom(roomId); } catch { /* best-effort bulk cleanup */ }
    this.rooms.delete(roomId);
    try { await this.kv.delete(roomId); } catch { /* best-effort */ }
    // The whiteboard goes with the meeting. Items are per-room records with no
    // life of their own; leaving them would leak keys a reprovisioned room id
    // would inherit.
    try {
      const purged = await this.board.purgeRoom(roomId);
      if (purged) console.log(`[rooms] board of ${roomId}: ${purged} item(s) deleted with the room`);
    } catch (err) {
      console.warn(`[rooms] board purge for ${roomId} failed:`, err);
    }
    // So do the notes on its files: they are statements about bytes this room
    // held, and the bytes are going. Leaving them would hand a reprovisioned
    // room id somebody else's screening history.
    try {
      const purged = await this.notes.purgeRoom(roomId);
      if (purged) console.log(`[rooms] notes of ${roomId}: ${purged} note(s) deleted with the room`);
    } catch (err) {
      console.warn(`[rooms] note purge for ${roomId} failed:`, err);
    }
    console.log(`[rooms] deleted ${meta.descriptor.name ?? roomId}: ${why}`);
    metrics.event({ kind: "room_reclaim", actor: meta.descriptor.creator, target: roomId, meta: { why, operator: meta.operator, account: meta.account ?? null } });
  }

  // ── idle sweep ────────────────────────────────────────────────────────

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const meta of [...this.rooms.values()]) {
      let lastActivity = new Date(meta.created_at).getTime();
      try {
        const info = await this.recordInfo(meta.descriptor.room_id);
        const lastTs = new Date(info.lastAt ?? "").getTime();
        if (Number.isFinite(lastTs) && lastTs > 0) lastActivity = Math.max(lastActivity, lastTs);
      } catch {
        // Stream missing entirely → treat as expired.
        await this.deleteRoom(meta, "record missing");
        continue;
      }
      // A DECLARED end (policy.ends_at, EXT-5 §2): the creator signed a date,
      // and a room past it goes the way an idle room goes — manifest recorded
      // so the deletion says what it deleted, then gone. Activity does not
      // extend a declared end; that is the difference between a lease and a
      // lull.
      const endsAt = Date.parse(String((meta.descriptor.policy as Record<string, unknown> | undefined)?.ends_at ?? ""));
      if (Number.isFinite(endsAt) && now > endsAt) {
        try {
          const { manifest } = await this.dossierFor(meta, "declared end reached");
          metrics.event({
            kind: "room_expired",
            actor: meta.descriptor.creator,
            target: meta.descriptor.room_id,
            meta: { operator: meta.operator, account: meta.account ?? null, manifest },
          });
        } catch (err) {
          console.error(`[rooms] could not record the dossier manifest for ${meta.descriptor.room_id}:`, err);
        }
        await this.deleteRoom(meta, "declared end reached");
        continue;
      }
      const idle = now - lastActivity;
      if (idle > CONFIG.idleExpiryMs) {
        // The manifest, before the bytes go. It is small — no record entries,
        // no file contents — and it is the difference between "the room and
        // everything in it is gone" and "here is what was in it, what it
        // hashed to, and when it went". A sweep that deletes a job's only copy
        // and says nothing is indistinguishable from a bug.
        try {
          const { manifest } = await this.dossierFor(meta, `idle ${Math.round(idle / 86_400_000)}d`);
          metrics.event({
            kind: "room_expired",
            actor: meta.descriptor.creator,
            target: meta.descriptor.room_id,
            meta: { operator: meta.operator, account: meta.account ?? null, manifest },
          });
        } catch (err) {
          console.error(`[rooms] could not record the dossier manifest for ${meta.descriptor.room_id}:`, err);
        }
        await this.deleteRoom(meta, `idle ${Math.round(idle / 86_400_000)}d`);
        continue;
      }
      // Spoke again: the countdown restarted, so the warning should too.
      if (meta.expiry_warned && idle <= CONFIG.idleExpiryMs * 0.8) {
        meta.expiry_warned = false;
        await this.saveMeta(meta);
      }
      // One warning per room, in the last fifth of its life, so a room about to
      // take its record with it says so while someone can still act.
      if (!meta.expiry_warned && idle > CONFIG.idleExpiryMs * 0.8) {
        meta.expiry_warned = true;
        await this.saveMeta(meta);
        const hours = Math.round((CONFIG.idleExpiryMs - idle) / 3_600_000);
        console.log(`[rooms] ${meta.descriptor.name ?? meta.descriptor.room_id} expires in ~${hours}h if it stays idle`);
        metrics.event({
          kind: "room_expiring",
          actor: meta.descriptor.creator,
          target: meta.descriptor.room_id,
          meta: {
            operator: meta.operator,
            expires_at: new Date(lastActivity + CONFIG.idleExpiryMs).toISOString(),
            artifacts: meta.artifacts.length,
          },
        });
      }
    }
  }
}
