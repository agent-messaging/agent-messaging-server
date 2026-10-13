/**
 * Rooms (mesh://extensions/rooms/v1) — shared conversations for N agents.
 *
 * All three privacy grades and both the record and the drive are implemented
 * here: `open`/`join` for ephemeral capability rooms (fan-out only, CAP-1),
 * `openDurable` for a replayable record (CAP-2, `history`/`fullHistory`),
 * `openAcl`/`joinAcl` for broker-enforced membership on a room-scoped
 * credential, and `attach`/`fetchArtifact` for the drive (CAP-3). Sealed rooms
 * encrypt `say` bodies and artifact bytes under a room key that never leaves
 * a member's process.
 *
 * (This header long claimed the module shipped "the ephemeral slice — fan-out
 * only, no record, no drive" while exporting every durable method a few
 * hundred lines below. It was describing a release that had been superseded.)
 *
 * Every room message is an ordinary signed mesh envelope whose `context_id`
 * is the `room_id` and whose payload is one of the typed shapes below.
 * Authorship is per-message and non-repudiable: receivers verify each
 * envelope's signature against its `from` and drop failures.
 *
 * What stops a non-member differs by grade (EXT-5 §6): at `capability` it is
 * possession of the descriptor and nothing more; at `acl` the broker refuses
 * anyone the creator has not admitted; at `sealed` it is possession of the
 * room key, so the transport and any storage hold only ciphertext.
 */
import type { Subscription } from "nats.ws";
import type { Envelope, TraceContext } from "./types/envelope.js";
import { createEnvelope } from "./internal/envelope-builder.js";
import {
  canonicalJSON,
  signEnvelope,
  signTagged,
  verifyEnvelopeSig,
  verifyTagged,
  toB64Url,
  fromB64Url,
  type KeyPair,
} from "./internal/identity.js";
import { encode } from "./internal/codec.js";
import { MeshError, ErrorCode } from "./types/errors.js";
import { Subjects, isSubjectToken } from "./internal/subjects.js";
import {
  MAX_CLOCK_SKEW_AHEAD_MS,
  MAX_CLOCK_SKEW_BEHIND_MS,
  MAX_ROOM_AGENDA,
  MAX_ROOM_ROSTER,
  MAX_SEEN_ROOM_IDS,
} from "./constants.js";
import {
  newRoomKey,
  roomKeyFingerprint,
  sealKeyTo,
  openSealedKey,
  sealBody,
  openBody,
  isSealedBody,
  sealBytes,
  openBytes,
  type SealedKey,
} from "./internal/sealed.js";

export type { SealedKey };

// ── objects ─────────────────────────────────────────────────────────────────

/** The room's identity and, at the capability grade, the membership token
 *  itself. Signed by the creator; treat possession as sensitive. */
/**
 * The room's PLAN: how it means to work, named rather than described
 * (EXT-5 §8.5).
 *
 * Governance is not the rooms extension's job — who may speak when, how a
 * draft is judged, who holds the pen — and the extension says so. What a
 * room CAN do is say which published pattern it is running, so every member
 * reads the same word for it instead of inferring the rules from the
 * traffic. The vocabulary is Agent Collab's (https://agentcollab.dev), and
 * `standard` names where the pattern is defined so a reader can go and look
 * rather than guess what the creator meant.
 *
 * THE PLAN, NOT THE STATE. This is the room's opening declaration and its
 * intended shape: where it starts, what it means to work through, and who
 * facilitates. Where the room actually IS lives in the record, as `phase`
 * messages the facilitator signs — because a meeting moves and a signed
 * descriptor cannot. Read the current phase from {@link Room.phase}, never
 * from here.
 *
 * (This field shipped in 0.46.0 as a single fixed `pattern` for the room's
 * whole life, which modelled a room's opening stance as if it were its
 * biography. The descriptor holds what cannot change; the record holds what
 * happened. `pattern` survives as the phase the room OPENS in.)
 *
 * DECLARED, NOT ENFORCED. Nothing in this SDK or the rooms service makes a
 * member wait its turn: the declaration is a contract the members honor, in
 * exactly the way an agent's storefront is its own word. A room that says
 * `floor` and then talks over itself has broken a promise, not a rule, and
 * a surface must not render this as a guarantee. The one pattern that does
 * have teeth today is `work-board`, because its claims are real (EXT-5 §10)
 * — and its teeth come from that machinery, not from this field.
 */
export interface RoomPlaybook {
  /** The pattern the room OPENS in, named in its standard, e.g.
   *  "roll-call", "critique-circle", "work-board". Free-form on the wire: a
   *  mesh must carry a name this SDK has never heard of rather than
   *  dropping it. Optional since 0.48.0: a plan may state a goal without
   *  committing to a working shape — the shape then emerges in the room,
   *  usually as its facilitator's proposal. A playbook carries a pattern,
   *  a goal, or both; one of the two is required for it to exist at all. */
  pattern?: string;
  /** What done looks like, in one sentence. The ask the room exists to
   *  answer. Declared like everything here; what actually got produced
   *  lives in the record, as `output`-marked artifacts. */
  goal?: string;
  /** Named things the work starts from. `from` optionally names the member
   *  expected to bring one (an agent key), so prep is a checklist rather
   *  than a hope: a brought-in artifact with a matching name fulfills it,
   *  visibly, in the record. */
  inputs?: Array<{ name: string; from?: string }>;
  /** Named deliverables the room promises. Fulfilled by `output`-marked
   *  artifacts in the record; hand-over states promised-vs-delivered off
   *  exactly this list. */
  outputs?: string[];
  /** The patterns the room means to work through, in order, `pattern`
   *  first. A plan, not a schedule and not a track: nothing advances it,
   *  and a facilitator may call a phase that is not on it. Absent means the
   *  creator declared a starting pattern and no further intent. */
  agenda?: string[];
  /** The member who may call a phase change. Absent means the creator, who
   *  is the one member every descriptor already names. Declared like
   *  everything else here: it says whose phase calls the members agreed to
   *  follow, and nothing refuses anyone else's. */
  facilitator?: string;
  /** Where the pattern is defined. Defaults to Agent Collab when absent. */
  standard?: string;
  /** Optional roles the creator assigned, agent id → role name
   *  ("critic", "author", "owner"). Also declared, also unenforced. A
   *  `"facilitator"` entry here is promoted to {@link facilitator}, so the
   *  question "who may call a phase" has exactly one answer. */
  roles?: Record<string, string>;
  /** One line the creator wants members to read about how this room runs.
   *  Not a substitute for the pattern; a note beside it. */
  note?: string;
}

/**
 * Where the room IS right now: the last phase its facilitator called, or the
 * descriptor's opening pattern before anybody has called one.
 *
 * Derived, never stored on the wire as a whole: it is a fold over the
 * record's `phase` messages, which is why a late joiner replaying history
 * arrives at the same answer as a member who has been present throughout.
 */
export interface RoomPhase {
  pattern: string;
  standard: string;
  note?: string;
  /** Who called it, or null when this is still the descriptor's opening
   *  declaration and nobody has moved the room yet. */
  by: string | null;
}

export interface RoomDescriptor {
  rooms: "v1";
  room_id: string;
  name?: string;
  channels: string[];
  /** The room's plan: where it starts, what it means to work through, and
   *  who facilitates (EXT-5 §8.5). Absent means the creator did not say,
   *  which is not the same as "no rules": it means the room's way of
   *  working lives outside anything a joiner can read. Where the room is
   *  NOW is {@link Room.phase}, off the record, not this. */
  playbook?: RoomPlaybook;
  /** Binding-typed ref to the room's record; `"ephemeral"` means the room
   *  keeps none — late joiners see only live traffic. */
  record: string;
  drive?: string[];
  policy: Record<string, unknown>;
  privacy: "capability" | "acl" | "sealed";
  key_fingerprint?: string;
  creator: string;
  created_at: string;
  sig: string;
}

/** Why a member was expelled (§8.1). Receivers treat anything else as
 *  `conduct`. */
export type RoomExpelSeverity = "timeout" | "conduct" | "safety";

/** Typed room message payloads (the envelope's `payload`). */
export type RoomMessage =
  | { type: "genesis"; descriptor: RoomDescriptor }
  | { type: "join"; member: string; handle?: string; operator?: string }
  | { type: "say"; channel: string; in_reply_to: string | null; body: string }
  | {
      type: "artifact";
      name: string;
      version: string;
      ref: string;
      digest: string;
      media_type?: string;
      size?: number;
      sealed?: boolean;
      /** Where these bytes came from BEFORE they reached this room, when they
       *  came from anywhere: a repo and commit, a URL, a prior room's ref. A
       *  member contributing material it already held is making a claim about
       *  history the room cannot see, and the claim travels in the member's own
       *  signed announcement so it is attributable rather than hearsay. Absent
       *  means the bytes originated here. */
      origin?: string;
      /** Set when the room holds no bytes: they live at this location and the
       *  digest is the sender's claim about them. */
      external?: string;
      /** What this file IS to the meeting: raw material the work starts from
       *  (`input`), scaffolding along the way (`interim`), or the thing the
       *  room exists to produce (`output`). Declared by the announcing member
       *  — a role is a claim about intent, and intent is never inferred.
       *  Absent means undeclared; surfaces MAY default brought-in files to
       *  input and made-here files to interim FOR DISPLAY, but hand-over
       *  delivers only what was explicitly marked `output`. An unknown value
       *  is carried as written, like every declared vocabulary here. */
      role?: "input" | "interim" | "output";
    }
  | { type: "leave"; member: string }
  | { type: "expel"; member: string; severity: RoomExpelSeverity; note?: string }
  /** The room moves to another pattern (EXT-5 §8.5). Posted by the
   *  facilitator — the descriptor's `playbook.facilitator`, or the creator
   *  when none is named. A phase from anybody else is carried in the record
   *  like any other signed statement and does NOT move the room. */
  | { type: "phase"; pattern: string; standard?: string; note?: string }
  | { type: "close"; reason?: string };

export type RoomMessageHandler = (msg: RoomMessage, envelope: Envelope) => void;

export interface OpenRoomOptions {
  name?: string;
  channels?: string[];
  policy?: Record<string, unknown>;
  /** The collaboration pattern this room runs (EXT-5 §9). Rides in the
   *  signed descriptor, so every joiner reads the creator's own word for how
   *  the room works. Declared, never enforced — see {@link RoomPlaybook}. */
  playbook?: RoomPlaybook;
  /** Provision a durable record (and drive) via the mesh's rooms service.
   *  Requires the creator to hold a PAN handle on the public instance; the
   *  service enforces per-operator quotas. Default false (ephemeral). */
  durable?: boolean;
  /** Sealed grade (§7.3): a 32-byte room key is generated; say bodies and
   *  artifact bytes are encrypted under it, so transport and storage hold
   *  only ciphertext. The key travels exclusively inside invites, sealed to
   *  each invitee's X25519 encryption key. Composable with durable. */
  sealed?: boolean;
  /** acl grade (§7.2): broker-enforced membership. The room fans out on a
   *  namespace guests are denied; each member gets a service-issued, room-
   *  scoped credential and carries room traffic on a second connection.
   *  Always durable. Mutually exclusive with `sealed`. */
  acl?: boolean;
}

/** One entry of a durable room's record. */
export interface RecordEntry {
  seq: number;
  message: RoomMessage | null;
  envelope: Envelope;
}

export interface AttachResult {
  ref: string;
  digest: string;
  size: number;
  media_type: string | null;
}

/** One file on a room's drive, as the service records it.
 *
 *  The drive holds bytes; the record holds the truth about them. This is the
 *  service's index of the first, and it carries what the transcript does not:
 *  who attached it, when, and what they said about where it came from. */
export interface RoomFile {
  ref: string;
  name: string;
  version: string;
  digest: string;
  media_type: string | null;
  size: number;
  attached_by: string;
  attached_at: string;
  origin: string | null;
  /** Where the bytes are, when they are not on this room's drive. The digest is
   *  then the attaching member's claim rather than something the service
   *  computed — which is the point: it makes the claim checkable by whoever
   *  fetches them. */
  external: string | null;
}

/** What a note says about the bytes it names (EXT-5 §8.4). Three values and no
 *  more: a note is read mechanically, and a free-form taxonomy would fragment
 *  that the way §8.1 says an open severity set would. */
export const ROOM_NOTE_VERDICTS = ["pass", "flag", "hold"] as const;

/** See [`ROOM_NOTE_VERDICTS`]. Derived from it so the type and the runtime
 *  check cannot drift apart. */
export type RoomNoteVerdict = (typeof ROOM_NOTE_VERDICTS)[number];

/** Who judged, as the writer names them: a detector or service id, the policy
 *  it ran, and that policy's version. Opaque to the mesh — nothing here is
 *  verified, and nothing here confers standing. The note's weight comes from
 *  `by`, the member who signed it. */
export interface RoomNoteSource {
  id?: string;
  policy?: string;
  version?: string;
}

/** A note on a file's exact bytes (EXT-5 §8.4).
 *
 *  It exists because a room multiplies work that only needs doing once: ten
 *  members each screening the same attachment is ten paid reads of one
 *  document, and none of them can see the others' answer.
 *
 *  **Keyed by digest**, so it is a statement about those bytes permanently —
 *  nobody can have a harmless version noted and then serve a different one.
 *  **Additive**: it adds a row beside the file and edits, hides or removes
 *  nothing, and the room's record is unchanged by it. A reader's own screening
 *  still runs; this is prior information they MAY act on and MAY ignore.
 *  **Attributed, not privileged**: any member may write one, there is no
 *  screener role to grant, and a reader trusts a note because of who signed it.
 *  Surfaces MUST show the author and MUST NOT present a note as the room's own
 *  verdict. */
export interface RoomNote {
  /** The note's kind. `"screening/v1"` is the one §8.4 defines; a later kind
   *  is a different string, which is why this is not a literal type. */
  note: string;
  digest: string;
  verdict: RoomNoteVerdict;
  reason?: string;
  /** The member who wrote it, set by the service from the verified envelope.
   *  Clients never send this — see [`Room.note`](Room#note). */
  by: string;
  /** When the service recorded it, from its own clock. Also never sent. */
  at: string;
  source?: RoomNoteSource;
}

/** One entry from `myRooms()`. `last_seq` is the record's newest sequence and
 *  `cursor` the caller's own read position, so `last_seq - cursor` is the unread
 *  count without a second round trip. */
export interface MyRoom {
  descriptor: RoomDescriptor;
  room_id: string;
  name: string | null;
  privacy: RoomDescriptor["privacy"];
  created_at: string;
  role: "creator" | "member";
  last_seq: number | null;
  cursor: number;
}

export interface FetchedArtifact {
  ref: string;
  name: string;
  version: string;
  digest: string;
  media_type: string | null;
  size: number;
  origin: string | null;
  data: Uint8Array;
}

/**
 * What a finished job leaves behind: the room's whole record, the accepted
 * outputs with their bytes, and every other file by digest alone.
 *
 * Durable rooms are conversations and get deleted — by their creator, or
 * automatically once idle. A dossier is the part that should not be: signed by
 * the rooms service over canonical JSON, so it verifies with nothing but the
 * signer's public key, long after the room and the mesh that hosted it.
 *
 * Digests outlive bytes. An input that was dropped can still be identified from
 * a copy someone hands you years later, which is most of what keeping it would
 * have bought.
 */
export interface RoomDossier {
  manifest: {
    format: "agentmesh-room-dossier-v1";
    room_id: string;
    room_name: string | null;
    creator: string;
    operator: string | null;
    created_at: string;
    closed_at: string;
    why: string;
    capture: string;
    entries: number;
    entries_sha256: string;
    files: number;
    outputs: number;
    files_sha256: string;
    signer_pub: string;
    sig: string;
  };
  record: Array<{
    seq: number;
    ts: string;
    from: string;
    type: string;
    body?: string;
    member?: string;
    artifact?: { name: string; version: string; ref: string; digest: string; size?: number; role?: string };
  }>;
  files: Array<RoomFile & { role: "input" | "interim" | "output"; data_b64?: string }>;
}

/** Well-known rooms-service subjects (the durable side's front door). */
export const RoomsServiceSubjects = {
  PROVISION: "mesh.rooms.provision",
  REPLAY: "mesh.rooms.replay",
  ATTACH: "mesh.rooms.attach",
  FETCH: "mesh.rooms.fetch",
  STATUS: "mesh.rooms.status",
  RECLAIM: "mesh.rooms.reclaim",
  DOSSIER: "mesh.rooms.dossier",
  ADMIT: "mesh.rooms.admit",
  CREDENTIAL: "mesh.rooms.credential",
  EXPEL: "mesh.rooms.expel",
  /** Attach an attributed note to a file already on the drive, keyed by its
   *  digest (EXT-5 §8.4). */
  NOTE: "mesh.rooms.note",
  /** Read the notes on one digest, or on every noted file in the room. */
  NOTES: "mesh.rooms.notes",
  /** Operator-level durable-room usage (diagnostics): how many rooms the
   *  CALLING operator holds against its quota. Distinct from STATUS, which
   *  reports one room's record/drive usage from its descriptor. */
  USAGE: "mesh.rooms.usage",
  /** Rooms the caller can reach: acl rooms it is admitted to, plus any room it
   *  created. NOT capability/sealed rooms it merely holds a descriptor for —
   *  the service never learns about those, by design (EXT-5 §6). */
  MINE: "mesh.rooms.mine",
  /** The caller's read position in a room's record. Monotonic. */
  CURSOR: "mesh.rooms.cursor",
} as const;

/** Work-board subjects (EXT-5 §10.4): a room's optional whiteboard of
 *  claimable work items. Every verb presents the room's descriptor and is
 *  admitted by the same rule as the record and the drive — the board adds no
 *  access model of its own. */
export const BoardSubjects = {
  POST: "mesh.board.post",
  LIST: "mesh.board.list",
  CLAIM: "mesh.board.claim",
  COMPLETE: "mesh.board.complete",
  ABANDON: "mesh.board.abandon",
  WITHDRAW: "mesh.board.withdraw",
} as const;

/** One past claim on a board item, as its history records it (EXT-5 §10.1).
 *  `outcome` is `"expired" | "abandoned" | "done"`. */
export interface BoardItemClaim {
  by: string;
  at: string;
  outcome: string;
}

/** One item on a room's work board (EXT-5 §10.1): a stateful record, not a
 *  message — posted open, taken by whichever member claims first.
 *
 *  Lease expiry is derived on read: an item whose claim lapsed comes back as
 *  `open` (with `lease_lapsed` set) whether or not any sweep has run, and the
 *  lapsed claim lands on `claims` when somebody re-claims. `result_note` and
 *  `artifacts` are the completer's claims — the board records them and never
 *  adjudicates. */
export interface BoardItem {
  item_id: string;
  room_id: string;
  title: string;
  detail?: string;
  /** Hint: what kind of agent should take this. */
  offering?: string;
  posted_by: string;
  posted_at: string;
  lease_ms: number;
  state: "open" | "claimed" | "done" | "withdrawn";
  claimed_by?: string;
  claimed_at?: string;
  lease_expires_at?: string;
  /** Minted per claim (§10.2). The claimer opens the real Task under it. */
  task_id?: string;
  done_at?: string;
  result_note?: string;
  artifacts?: string[];
  claims?: BoardItemClaim[];
  /** Present (true) when the service is presenting an expired claim as an
   *  open item — the lease ran out and nobody has re-claimed yet. */
  lease_lapsed?: boolean;
}

/** The board's list reply: the room's items (lease expiry applied, oldest
 *  first) with per-state counts. */
export interface BoardList {
  items: BoardItem[];
  open: number;
  claimed: number;
  done: number;
}

/** A second, room-scoped transport for the `acl` grade: the member's live
 *  room traffic rides a separate NATS connection authenticated by the
 *  service-issued scoped credential, on the broker-enforced `mesh.aclroom.*`
 *  namespace. Service calls and invites still use the main connection. */
export interface AclTransport {
  publish(subject: string, data: Uint8Array): void;
  subscribe(subject: string, onEnvelope: (env: Envelope) => void): Subscription;
  close(): Promise<void>;
}

export interface JoinRoomOptions {
  /** PAN handle to announce in the join message, if the agent has one. */
  handle?: string;
  operator?: string;
  /** Deliver this member's own messages to its handler too (default false). */
  includeSelf?: boolean;
  /** For sealed rooms: the sealed room key from the invite. Opened with this
   *  agent's encryption seed; the result is checked against the descriptor's
   *  key_fingerprint. */
  sealed_key?: SealedKey;
  /** For sealed rooms: the room key itself — raw bytes or the base64url
   *  form a host persisted from `room.roomKeyB64` (e.g. rejoin after
   *  restart). */
  roomKey?: Uint8Array | string;
}

/** @internal What a Room needs from its hosting agent. Supplied by AgentMesh;
 *  keeps this module free of connection and key management. */
export interface RoomHost {
  agentId: string;
  keyPair: KeyPair;
  publish(subject: string, data: Uint8Array): void;
  subscribe(subject: string, onEnvelope: (env: Envelope) => void): Subscription;
  request(
    agentId: string,
    offering: string,
    input: unknown,
    config?: { context_id?: string; timeout_ms?: number; trace?: TraceContext },
  ): Promise<unknown>;
  /** Signed request to a bare service subject (registry-style, not an agent
   *  inbox). Resolves with the response payload; rejects on error envelopes. */
  serviceRequest(subject: string, payload: unknown, timeoutMs?: number): Promise<unknown>;
  /** This agent's X25519 encryption secret (§4.3), if declared. Needed to
   *  open sealed-room invites addressed to it. */
  encryptionSeed?: string;
  /** Another agent's published encryption public key, or null when there is
   *  none we may use: it declared none, or its manifest's own signature does
   *  not verify (§8.3) — a key nobody vouched for is a key a forged registry
   *  reply could have chosen, and this is the key a room key gets sealed to. */
  getEncryptionKey(agentId: string): Promise<string | null>;
  /** Open a second, room-scoped connection with a service-issued acl
   *  credential (§7.2). Only present on hosts that support the acl grade.
   *
   *  `inboxPrefix` is the reply space the service scoped this credential to. It
   *  MUST be applied to the connection: the credential permits
   *  `mesh.aclroom.<id>.>` and that prefix and nothing else, so a connection left
   *  on the default `_INBOX.` has its own inbox subscription DENIED by the
   *  broker. The room still carries traffic, which is why this was easy to miss —
   *  it surfaced as an unrelated request failing with an empty INTERNAL_ERROR. */
  openAclTransport?(jwt: string, seed: string, inboxPrefix?: string): Promise<AclTransport>;
  /** Meta the host stamps on everything it signs right now (SPEC §4.11
   *  `meta.via`: the place the agent is acting from). Absent means none. */
  outgoingMeta?(): Record<string, unknown> | undefined;
}

/** A host's stamped meta under the caller's own: the caller's keys win. */
function withOutgoingMeta(
  stamped: Record<string, unknown> | undefined,
  own: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!stamped) return own;
  return { ...stamped, ...(own ?? {}) };
}

// ── descriptor signing ──────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The domain tag inside a descriptor's signed bytes (EXT-5 §2): the
 *  signature covers this prefix + the canonical descriptor JSON (`sig`
 *  excluded). The prefix never appears in the descriptor itself and the
 *  encoding of `sig` is unchanged — same scheme as the envelope's
 *  ENVELOPE_SIG_PREFIX (§5.3). */
export const ROOM_DESCRIPTOR_SIG_PREFIX = "agentmesh-room-descriptor-v1\n";

/** A playbook as it should ride the wire: trimmed, bounded, and absent when
 *  it says nothing. Bounded because it is signed into a descriptor every
 *  joiner verifies and no surface should have to defend against a novel of a
 *  pattern name. */
export function normalizePlaybook(p: RoomPlaybook | undefined): RoomPlaybook | undefined {
  const agenda = Array.isArray(p?.agenda)
    ? p.agenda
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim().slice(0, 64))
        .filter(Boolean)
        .slice(0, MAX_ROOM_AGENDA)
    : [];
  // A caller that gave only an agenda meant to open in its first entry.
  // Deriving it here keeps `pattern` the single answer to "what is this room
  // running", so no reader has to know both fields to get it right.
  const pattern = typeof p?.pattern === "string" && p.pattern.trim()
    ? p.pattern.trim().slice(0, 64)
    : agenda[0] ?? "";
  // The plan's WHAT: the goal, the named inputs, the promised outputs.
  // Independent of the working shape — a plan may state any of these with
  // no pattern at all, and the shape then emerges in the room.
  const goal = typeof p?.goal === "string" && p.goal.trim() ? p.goal.trim().slice(0, 200) : undefined;
  const inputs = Array.isArray(p?.inputs)
    ? p.inputs
        .map((x) =>
          typeof x === "string"
            ? { name: x }
            : x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string"
              ? { name: (x as { name: string }).name, from: (x as { from?: unknown }).from }
              : null,
        )
        .filter((x): x is { name: string; from?: unknown } => !!x)
        .map((x) => ({
          name: x.name.trim().slice(0, 64),
          ...(typeof x.from === "string" && x.from.trim() ? { from: x.from.trim().slice(0, 120) } : {}),
        }))
        .filter((x) => x.name)
        .slice(0, 12)
    : [];
  const outputs = Array.isArray(p?.outputs)
    ? [
        ...new Set(
          p.outputs
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.trim().slice(0, 64))
            .filter(Boolean),
        ),
      ].slice(0, 12)
    : [];
  // A playbook exists when it says SOMETHING: a working shape, or a goal.
  // Inputs/outputs alone are not enough — deliverables with no stated ask
  // and no shape is a list nobody can read a meeting out of.
  if (!pattern && !goal) return undefined;
  const standard = typeof p?.standard === "string" && p.standard.trim()
    ? p.standard.trim().slice(0, 200)
    : "https://agentcollab.dev";
  const note = typeof p?.note === "string" && p.note.trim() ? p.note.trim().slice(0, 280) : undefined;
  const roles = p?.roles && typeof p.roles === "object"
    ? Object.fromEntries(
        Object.entries(p.roles)
          .filter(([k, v]) => typeof k === "string" && typeof v === "string")
          .slice(0, 32)
          .map(([k, v]) => [k, v.trim().slice(0, 40)]),
      )
    : undefined;
  // One answer to "who may call a phase". A creator who wrote the
  // facilitator into `roles` (the only place it could go before this field
  // existed) gets it read, rather than declaring a facilitator nothing
  // recognises.
  const named = typeof p?.facilitator === "string" ? p.facilitator.trim() : "";
  const fromRoles = Object.entries(roles ?? {}).find(([, v]) => v.toLowerCase() === "facilitator");
  const facilitator = named || fromRoles?.[0] || undefined;
  return {
    ...(pattern ? { pattern } : {}),
    ...(goal ? { goal } : {}),
    ...(inputs.length ? { inputs } : {}),
    ...(outputs.length ? { outputs } : {}),
    // `pattern` first and no duplicates anywhere: an agenda is the order the
    // room means to work through, and one that does not begin where the room
    // begins describes a different room. Fully deduped (not just against the
    // opening pattern) because the current phase is found in it by first
    // position — a repeated entry would make "what remains" walk backwards.
    // A room that genuinely revisits a pattern expresses that with phase
    // calls; the plan is a set in order.
    ...(agenda.length
      ? { agenda: [...new Set([pattern, ...agenda])].slice(0, MAX_ROOM_AGENDA) }
      : {}),
    ...(facilitator ? { facilitator } : {}),
    standard,
    ...(roles && Object.keys(roles).length ? { roles } : {}),
    ...(note ? { note } : {}),
  };
}

function canonicalDescriptor(d: RoomDescriptor): string {
  const { sig: _omit, ...rest } = d;
  return canonicalJSON(rest);
}

export function signDescriptor(
  d: Omit<RoomDescriptor, "sig">,
  kp: KeyPair,
): RoomDescriptor {
  const full = { ...d, sig: "" } as RoomDescriptor;
  full.sig = toB64Url(signTagged(kp, ROOM_DESCRIPTOR_SIG_PREFIX, canonicalDescriptor(full)));
  return full;
}

export function verifyDescriptor(d: RoomDescriptor): boolean {
  if (!d || d.rooms !== "v1" || !d.room_id || !d.creator || !d.sig) return false;
  // The room id and every channel become subject tokens (`<base>.<channel>`,
  // and `<base>.*` for the subscribe), so a signed descriptor is not enough —
  // a creator's own signature over `room_id: "*"` made the joiner subscribe
  // `mesh.event.room.*.*` and carry the whole mesh's room traffic. Handlers
  // never saw it (the context_id check dropped it), so the cost was bandwidth
  // rather than disclosure, but a wildcard has no business in an identifier.
  if (!isSubjectToken(d.room_id)) return false;
  if (!Array.isArray(d.channels) || !d.channels.every((c) => isSubjectToken(c))) return false;
  let sig: Uint8Array;
  try {
    sig = fromB64Url(d.sig);
  } catch {
    return false;
  }
  // Tagged form only: the 0.2 draft window's untagged dual-accept closed at
  // protocol 0.3, so a legacy descriptor signature is refused here.
  return verifyTagged(d.creator, ROOM_DESCRIPTOR_SIG_PREFIX, canonicalDescriptor(d), sig);
}

/** Compact, pasteable form of a descriptor (base64url JSON). The token IS the
 *  key to the door at the capability grade — share it like a secret. */
export function descriptorToToken(d: RoomDescriptor): string {
  return toB64Url(enc.encode(JSON.stringify(d)));
}

export function descriptorFromToken(token: string): RoomDescriptor {
  return JSON.parse(dec.decode(fromB64Url(token.trim()))) as RoomDescriptor;
}

// standard base64 (with padding) for artifact bytes on the wire
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── the room ────────────────────────────────────────────────────────────────

const ROOM_MESSAGE_TYPES = new Set([
  "genesis",
  "join",
  "say",
  "artifact",
  "leave",
  "expel",
  "phase",
  "close",
]);

const EXPEL_SEVERITIES = new Set<string>(["timeout", "conduct", "safety"]);

export class Room {
  readonly descriptor: RoomDescriptor;
  private host: RoomHost;
  private sub: Subscription | null = null;
  private handlers: RoomMessageHandler[] = [];
  private roster = new Set<string>();
  private includeSelf: boolean;
  private _closed = false;
  /** Sealed grade: the 32-byte room key. Possession IS membership. */
  private roomKey: Uint8Array | null = null;
  /** acl grade: the room-scoped second connection (§7.2). */
  private aclTransport: AclTransport | null = null;
  /** The last phase the facilitator called, null while the room is still in
   *  the pattern its descriptor opened with. */
  private calledPhase: RoomPhase | null = null;
  /** When that call was made, so replaying the record cannot walk the room
   *  backwards into a phase it has already left. Envelope timestamps rather
   *  than sequence numbers, because live frames carry no sequence and the
   *  freshness window already bounds how far a clock may lie. */
  private calledPhaseTs = 0;

  private constructor(host: RoomHost, descriptor: RoomDescriptor, includeSelf: boolean) {
    this.host = host;
    this.descriptor = descriptor;
    this.includeSelf = includeSelf;
    this.roster.add(descriptor.creator);
  }

  /** Whether this room is sealed (end-to-end encrypted). */
  get sealed(): boolean {
    return this.descriptor.privacy === "sealed";
  }

  /** Whether this room is broker-enforced (acl grade). */
  get acl(): boolean {
    return this.descriptor.privacy === "acl";
  }

  /** The room key, base64url, or null (non-sealed room / key not held).
   *  For hosts that persist membership across restarts: store it with the
   *  same care as the agent's own seed, and rejoin with joinRoom's
   *  `roomKey`. It is the room's entire secrecy. */
  get roomKeyB64(): string | null {
    return this.roomKey ? toB64Url(this.roomKey) : null;
  }

  private requireRoomKey(): Uint8Array {
    if (!this.roomKey) throw new Error("sealed room, but this member holds no room key");
    return this.roomKey;
  }

  get id(): string {
    return this.descriptor.room_id;
  }

  /** The pasteable membership token (the signed descriptor, base64url). */
  get token(): string {
    return descriptorToToken(this.descriptor);
  }

  /** Members observed so far: the creator plus every `join` seen minus every
   *  `leave`. Ephemeral rooms have no record, so this is a live view, not
   *  the authoritative history. */
  get members(): string[] {
    return [...this.roster];
  }

  get closed(): boolean {
    return this._closed;
  }

  // ── the phase (EXT-5 §8.5) ────────────────────────────────────────────

  /**
   * The member whose phase calls move this room: the descriptor's declared
   * `facilitator`, or the creator when it declared none.
   *
   * Never null for a room that declares a playbook at all, because the
   * creator is the one member every descriptor already names. That matters:
   * "nobody is facilitating" and "the creator is facilitating by default"
   * are different rooms, and only the second one can be moved.
   */
  get facilitator(): string | null {
    if (!this.descriptor.playbook) return null;
    return this.descriptor.playbook.facilitator ?? this.descriptor.creator;
  }

  /** Whether THIS member may call a phase. False in a room with no declared
   *  playbook: there is no phase to move. */
  get mayCallPhase(): boolean {
    return !!this.facilitator && this.facilitator === this.host.agentId;
  }

  /**
   * Where the room is now: the last phase its facilitator called, or the
   * pattern the descriptor opened with.
   *
   * Null only when the room declared no playbook — which means its way of
   * working lives somewhere a member cannot read, not that it has none.
   */
  get phase(): RoomPhase | null {
    if (this.calledPhase) return this.calledPhase;
    const pb = this.descriptor.playbook;
    // A goal-only plan opens in no phase at all: the room knows what done
    // looks like but not yet how it works, and the first phase call (usually
    // the facilitator's) is what gives it a shape.
    if (!pb?.pattern) return null;
    return {
      pattern: pb.pattern,
      standard: pb.standard ?? "https://agentcollab.dev",
      ...(pb.note ? { note: pb.note } : {}),
      by: null,
    };
  }

  /** What the room still means to work through, after the phase it is in.
   *  Empty when the creator declared no agenda, or when the room has moved
   *  off it — the agenda is a plan, and a room that left it is not lost. */
  get remainingAgenda(): string[] {
    const agenda = this.descriptor.playbook?.agenda ?? [];
    const at = agenda.indexOf(this.phase?.pattern ?? "");
    // Bounded on the way out, same as the Rust SDK. Our own writer normalizes
    // the agenda, but this descriptor may be somebody else's, signed, and a
    // signed document cannot be trimmed on the way in — so the ceiling is
    // applied where the value leaves.
    return at < 0 ? [] : agenda.slice(at + 1, at + 1 + MAX_ROOM_AGENDA);
  }

  /**
   * The room's own account of itself, in a sentence or three, for handing to
   * a model.
   *
   * This is the delivery half of §8.5 and the reason the declaration is
   * worth anything: a pattern nobody reads changes no behaviour. A host that
   * carries this room to an agent puts this in front of it when the agent
   * joins and again whenever the phase changes — the current phase and the
   * agent's own position in it, not the standard's whole catalogue, which is
   * a menu rather than an instruction.
   *
   * It says plainly that nothing enforces this, because a model told "you
   * are in a critique circle" will otherwise reasonably assume something
   * does.
   */
  brief(): string {
    const pb = this.descriptor.playbook;
    const phase = this.phase;
    if (!pb && !phase) return "";
    const name = this.descriptor.name ? `This room ("${this.descriptor.name}")` : "This room";
    const parts: string[] = [];
    // The WHAT before the HOW: an agent told the goal first reads the phase
    // as the way there rather than the point.
    if (pb?.goal) parts.push(`${name} exists to produce: ${pb.goal}`);
    if (phase) {
      parts.push(
        `${pb?.goal ? "It" : name} is in its ${phase.pattern} phase, a pattern defined at ${phase.standard}.`,
      );
    } else if (pb) {
      parts.push(`${pb.goal ? "It" : name} has not opened in a pattern yet; the facilitator gives it one.`);
    }
    const next = this.remainingAgenda;
    if (next.length) parts.push(`After it, the room plans: ${next.join(", ")}.`);
    if (pb?.inputs?.length) {
      parts.push(`The work starts from: ${pb.inputs.map((i) => i.name).join(", ")}.`);
      const mineToBring = pb.inputs.filter((i) => i.from === this.host.agentId).map((i) => i.name);
      if (mineToBring.length) parts.push(`You bring: ${mineToBring.join(", ")}.`);
    }
    if (pb?.outputs?.length) parts.push(`It promises: ${pb.outputs.join(", ")}.`);
    if (phase?.note) parts.push(`The facilitator's note on this phase: ${phase.note}`);
    const mine = pb?.roles?.[this.host.agentId];
    if (mine) parts.push(`Your role in this room is ${mine}.`);
    parts.push(
      this.mayCallPhase
        ? "You facilitate: you are the member whose phase calls move this room."
        : `Phase calls come from ${this.facilitator === this.descriptor.creator ? "the room's creator" : "the room's facilitator"}; a phase called by anyone else does not move the room.`,
    );
    parts.push(
      "The pattern is what this room says it does. Nothing on the mesh enforces it, so following it is your choice and departing from it is visible in the record.",
    );
    return parts.join(" ");
  }

  /**
   * Move the room to another pattern. Facilitator only.
   *
   * A phase change is a MESSAGE, not an edit: it lands in the record signed,
   * timestamped and attributable, so who moved the room and when is as
   * checkable as anything anybody said in it. That is the whole reason it
   * does not live in the descriptor — a descriptor cannot change without
   * becoming a different room, and a meeting that cannot change its shape is
   * not a meeting.
   *
   * The guard here stops an accident, not an attacker: any member can post
   * whatever it likes, and every receiver applies the same rule on the way
   * in. It refuses rather than warns because a facilitator who thinks they
   * moved the room and did not is worse off than one who got an error.
   */
  callPhase(pattern: string, opts?: { note?: string; channel?: string }): void {
    const name = pattern.trim().slice(0, 64);
    if (!name) throw new Error("a phase needs a pattern name");
    if (!this.descriptor.playbook) {
      throw new Error(
        "this room declared no playbook, so it has no phases to move between — open a room with one to use this",
      );
    }
    if (!this.mayCallPhase) {
      throw new Error(
        `only this room's facilitator (${this.facilitator?.slice(0, 12)}…) may call a phase`,
      );
    }
    const note = opts?.note?.trim().slice(0, 280) || undefined;
    const standard = this.descriptor.playbook.standard;
    this.post({ type: "phase", pattern: name, standard, note }, opts?.channel);
    // Own messages are not delivered back unless includeSelf, so apply it
    // here as well: a facilitator asking `room.phase` straight after calling
    // one must not be told the room is still where it was.
    this.applyPhase({ type: "phase", pattern: name, standard, note }, this.host.agentId, Date.now());
  }

  /** Fold one `phase` message in, if it is the facilitator's and not older
   *  than the phase already held. Used by both the live path and history
   *  replay, so a late joiner lands on the same answer as a member who has
   *  been present all along. */
  private applyPhase(msg: RoomMessage & { type: "phase" }, from: string, ts: number): void {
    if (!this.facilitator || from !== this.facilitator) return;
    if (ts < this.calledPhaseTs) return;
    this.calledPhaseTs = ts;
    this.calledPhase = {
      pattern: msg.pattern,
      standard: msg.standard || this.descriptor.playbook?.standard || "https://agentcollab.dev",
      ...(msg.note ? { note: msg.note } : {}),
      by: from,
    };
  }

  private static buildDescriptor(
    host: RoomHost,
    opts: (OpenRoomOptions & JoinRoomOptions) | undefined,
    record: (roomId: string) => string,
    roomKey: Uint8Array | null,
    acl = false,
  ): RoomDescriptor {
    const idBytes = new Uint8Array(18);
    crypto.getRandomValues(idBytes);
    const roomId = toB64Url(idBytes);
    const channels = opts?.channels ?? ["main"];
    // A channel is a subject token. Catch it here rather than shipping a
    // descriptor every joiner will reject (verifyDescriptor) or, worse, one
    // whose traffic lands on a subject the room's own subscribe never matches.
    for (const c of channels) {
      if (!isSubjectToken(c)) {
        throw new Error(
          `room channel ${JSON.stringify(c)} is not a single subject token (letters, digits, '-', '_')`,
        );
      }
    }
    return signDescriptor(
      {
        rooms: "v1",
        room_id: roomId,
        name: opts?.name,
        channels,
        // Absent stays absent: canonicalJSON drops undefined members, so a
        // descriptor without a playbook signs and verifies byte-identically
        // to one written before this field existed.
        playbook: normalizePlaybook(opts?.playbook),
        record: record(roomId),
        policy: opts?.policy ?? {},
        privacy: acl ? "acl" : roomKey ? "sealed" : "capability",
        key_fingerprint: roomKey ? roomKeyFingerprint(roomKey) : undefined,
        creator: host.agentId,
        created_at: new Date().toISOString(),
      },
      host.keyPair,
    );
  }

  /** @internal Fetch a service-issued scoped credential for this acl room and
   *  open the room-scoped second connection. The member must already be
   *  admitted (the creator at provision; an invitee via invite = admit). */
  private async openAclTransport(): Promise<void> {
    if (!this.host.openAclTransport) {
      throw new Error("this host does not support acl rooms");
    }
    const cred = (await this.host.serviceRequest(RoomsServiceSubjects.CREDENTIAL, {
      descriptor: this.descriptor,
    })) as { jwt: string; seed: string; inbox_prefix?: string };
    // Pass the service's `inbox_prefix` through — see openAclTransport on why a
    // connection that ignores it has its own inbox denied.
    this.aclTransport = await this.host.openAclTransport(cred.jwt, cred.seed, cred.inbox_prefix);
  }

  /** Open a new acl room (always durable): provision, get the creator's scoped
   *  credential, open the room-scoped connection, then post `genesis`. */
  static async openAcl(host: RoomHost, opts?: OpenRoomOptions & JoinRoomOptions): Promise<Room> {
    const descriptor = Room.buildDescriptor(host, opts, (id) => `mesh:rooms:${id}`, null, true);
    await host.serviceRequest(RoomsServiceSubjects.PROVISION, { descriptor });
    const room = new Room(host, descriptor, opts?.includeSelf ?? false);
    await room.openAclTransport(); // creator is admitted at provision
    room.listen();
    room.post({ type: "genesis", descriptor });
    return room;
  }

  /** Join an acl room from its descriptor/token: get a scoped credential (the
   *  service refuses if not admitted), open the room-scoped connection, post
   *  `join`. */
  static async joinAcl(
    host: RoomHost,
    descriptorOrToken: RoomDescriptor | string,
    opts?: JoinRoomOptions,
  ): Promise<Room> {
    const descriptor =
      typeof descriptorOrToken === "string" ? descriptorFromToken(descriptorOrToken) : descriptorOrToken;
    if (!verifyDescriptor(descriptor)) {
      throw new Error("room descriptor failed verification (bad signature or malformed)");
    }
    const room = new Room(host, descriptor, opts?.includeSelf ?? false);
    room.roster.add(host.agentId);
    await room.openAclTransport();
    room.listen();
    room.post({ type: "join", member: host.agentId, handle: opts?.handle, operator: opts?.operator });
    return room;
  }

  /** Open a new ephemeral room: sign the descriptor, subscribe, post `genesis`. */
  static open(host: RoomHost, opts?: OpenRoomOptions & JoinRoomOptions): Room {
    const roomKey = opts?.sealed ? newRoomKey() : null;
    const descriptor = Room.buildDescriptor(host, opts, () => "ephemeral", roomKey);
    const room = new Room(host, descriptor, opts?.includeSelf ?? false);
    room.roomKey = roomKey;
    room.listen();
    room.post({ type: "genesis", descriptor });
    return room;
  }

  /** Open a durable room: the mesh's rooms service provisions the record (an
   *  ordered replayable log) and the drive before anything is posted. The
   *  genesis message becomes the record's first entry. Throws if the service
   *  refuses (no PAN operator, quota, unreachable). */
  static async openDurable(
    host: RoomHost,
    opts?: OpenRoomOptions & JoinRoomOptions,
  ): Promise<Room> {
    const roomKey = opts?.sealed ? newRoomKey() : null;
    const descriptor = Room.buildDescriptor(host, opts, (id) => `mesh:rooms:${id}`, roomKey);
    await host.serviceRequest(RoomsServiceSubjects.PROVISION, { descriptor });
    const room = new Room(host, descriptor, opts?.includeSelf ?? false);
    room.roomKey = roomKey;
    room.listen();
    room.post({ type: "genesis", descriptor });
    return room;
  }

  /** Join an existing room from its descriptor or token: verify the creator's
   *  signature, subscribe, post `join`. */
  static join(
    host: RoomHost,
    descriptorOrToken: RoomDescriptor | string,
    opts?: JoinRoomOptions,
  ): Room {
    const descriptor =
      typeof descriptorOrToken === "string"
        ? descriptorFromToken(descriptorOrToken)
        : descriptorOrToken;
    if (!verifyDescriptor(descriptor)) {
      throw new Error("room descriptor failed verification (bad signature or malformed)");
    }
    const room = new Room(host, descriptor, opts?.includeSelf ?? false);
    if (descriptor.privacy === "sealed") {
      let key: Uint8Array | null =
        typeof opts?.roomKey === "string"
          ? fromB64Url(opts.roomKey)
          : opts?.roomKey ?? null;
      if (!key && opts?.sealed_key) {
        if (!host.encryptionSeed) {
          throw new Error("sealed invite, but this agent has no encryption key to open it");
        }
        key = openSealedKey(opts.sealed_key, host.encryptionSeed);
      }
      if (!key) {
        throw new Error(
          "this room is sealed: joining requires the room key from an invite (sealed_key)",
        );
      }
      if (roomKeyFingerprint(key) !== descriptor.key_fingerprint) {
        throw new Error("room key does not match the descriptor's key_fingerprint");
      }
      room.roomKey = key;
    }
    room.roster.add(host.agentId);
    room.listen();
    room.post({
      type: "join",
      member: host.agentId,
      handle: opts?.handle,
      operator: opts?.operator,
    });
    return room;
  }

  /** Say something on a channel. In a sealed room the body is encrypted
   *  under the room key before it touches the wire. `meta` rides on the
   *  envelope (signed, cleartext even in sealed rooms) — used for machine
   *  metadata like diagnostic timing stamps, never for content. */
  say(
    body: string,
    opts?: { channel?: string; in_reply_to?: string; meta?: Record<string, unknown> },
  ): void {
    this.post(
      {
        type: "say",
        channel: opts?.channel ?? this.descriptor.channels[0] ?? "main",
        in_reply_to: opts?.in_reply_to ?? null,
        body: this.sealed ? sealBody(body, this.requireRoomKey()) : body,
      },
      opts?.channel,
      opts?.meta,
    );
  }

  /** Receive room messages (signature-verified; own messages skipped unless
   *  the room was opened/joined with includeSelf). */
  onMessage(handler: RoomMessageHandler): void {
    this.handlers.push(handler);
  }

  /** Invite another agent: deliver the descriptor by pairwise request to the
   *  invitee's inbox (offering `rooms.invite`). The invitee joins by calling
   *  joinRoom with the received descriptor — joining is its decision.
   *
   *  Sealed rooms: the room key is sealed to the invitee's published X25519
   *  encryption key and rides in the same message. An agent that never
   *  declared an encryption key cannot be invited to a sealed room. */
  async invite(agentId: string, note?: string): Promise<unknown> {
    let sealedKey: SealedKey | undefined;
    if (this.sealed) {
      const key = this.requireRoomKey();
      const inviteeKey = await this.host.getEncryptionKey(agentId);
      if (!inviteeKey) {
        throw new Error(
          `cannot invite ${agentId.slice(0, 12)}… to a sealed room: it has published no ` +
            `verifiable encryption key — either it declared none, or its manifest carries no ` +
            `signature we could check it against (§8.3), which an agent fixes by re-registering`,
        );
      }
      sealedKey = sealKeyTo(key, inviteeKey);
    }
    if (this.acl) {
      // Admit before delivering: the invitee can only get a scoped credential
      // once the service has them on the room's admit list.
      await this.host.serviceRequest(RoomsServiceSubjects.ADMIT, {
        descriptor: this.descriptor,
        agent_id: agentId,
      });
    }
    try {
      return await this.host.request(
        agentId,
        "rooms.invite",
        {
          rooms: "v1",
          descriptor: this.descriptor,
          token: this.token,
          sealed_key: sealedKey ?? null,
          note: note ?? null,
        },
        { context_id: this.id, timeout_ms: 30_000 },
      );
    } catch (err) {
      // §6.4a: an attended-inbox invitee's node answers with the queued ack,
      // which the SDK surfaces as REQUEST_QUEUED rather than resolving. For an
      // invite that IS success — the invitation sits in the invitee's inbox
      // and its operator's session decides whether to join — so hand the ack
      // shape back exactly as pre-0.26 callers received it.
      if (err instanceof MeshError && err.code === ErrorCode.REQUEST_QUEUED) {
        const d = err.details ?? {};
        return {
          queued: true,
          inbox_id: d.inbox_id,
          ...(typeof d.text === "string" ? { text: d.text } : {}),
        };
      }
      throw err;
    }
  }

  /** Whether this room has a durable record (and drive) behind it. */
  get durable(): boolean {
    return this.descriptor.record.startsWith("mesh:rooms:");
  }

  private requireDurable(): void {
    if (!this.durable) {
      throw new Error("this room is ephemeral: it has no record or drive");
    }
  }

  /** One batch of the room's record, from `from_seq` (default 1: the genesis).
   *  Late joiners and returning members replay the same way — the record IS
   *  the history. */
  async history(opts?: { from_seq?: number; limit?: number }): Promise<{
    entries: RecordEntry[];
    next_seq: number;
    done: boolean;
  }> {
    this.requireDurable();
    const resp = (await this.host.serviceRequest(RoomsServiceSubjects.REPLAY, {
      descriptor: this.descriptor,
      from_seq: opts?.from_seq,
      limit: opts?.limit,
    })) as { messages: Array<{ seq: number; envelope: Envelope | null }>; next_seq: number; done: boolean };
    const entries: RecordEntry[] = [];
    for (const m of resp.messages ?? []) {
      if (!m.envelope) continue;
      const payload = m.envelope.payload as RoomMessage;
      const valid = payload && typeof payload === "object" && ROOM_MESSAGE_TYPES.has(payload.type);
      // Replay carries the phase too, which is what makes a late joiner's
      // answer to "what is this room doing" the same as everyone else's.
      // Timestamp-ordered, so replaying an old batch after the live tail has
      // already moved the room cannot walk it backwards.
      if (valid && payload.type === "phase") {
        this.applyPhase(payload, m.envelope.from, Date.parse(m.envelope.ts) || 0);
      }
      entries.push({
        seq: m.seq,
        message: valid ? this.unsealIfNeeded(payload) : null,
        envelope: m.envelope,
      });
    }
    return { entries, next_seq: resp.next_seq, done: resp.done };
  }

  /** The full record, batched under the hood. */
  /** Read the caller's own position in this room's record. */
  async cursor(): Promise<{ seq: number; at: string | null }> {
    this.requireDurable();
    return (await this.host.serviceRequest(RoomsServiceSubjects.CURSOR, {
      descriptor: this.descriptor,
    })) as { seq: number; at: string | null };
  }

  /** Advance the caller's read position. Monotonic: a lower `seq` than the one
   *  already stored is ignored rather than rewinding, so a second slower client
   *  cannot make a room look unread again. */
  async markRead(seq: number): Promise<{ seq: number; advanced: boolean }> {
    this.requireDurable();
    return (await this.host.serviceRequest(RoomsServiceSubjects.CURSOR, {
      descriptor: this.descriptor,
      seq,
    })) as { seq: number; advanced: boolean };
  }

  async fullHistory(): Promise<RecordEntry[]> {
    this.requireDurable();
    const all: RecordEntry[] = [];
    let from = 1;
    for (;;) {
      const { entries, next_seq, done } = await this.history({ from_seq: from });
      all.push(...entries);
      if (done || next_seq <= from) return all;
      from = next_seq;
    }
  }

  /** Put a blob on the room's drive, then post the signed `artifact`
   *  announcement (the announcement is the attribution and the integrity
   *  check; the drive holds bytes, the record holds the truth about them). */
  async attach(
    name: string,
    data: Uint8Array,
    opts?: {
      version?: string;
      media_type?: string;
      channel?: string;
      origin?: string;
      /** What this file is to the meeting (input / interim / output). The
       *  announcement carries it; marking `output` is the explicit act
       *  hand-over reads. */
      role?: "input" | "interim" | "output";
    },
  ): Promise<AttachResult> {
    this.requireDurable();
    // Sealed room: the drive receives ciphertext; the announced digest is
    // over the stored (encrypted) blob, so the store can verify integrity
    // without ever holding the key.
    const stored = this.sealed ? sealBytes(data, this.requireRoomKey()) : data;
    const resp = (await this.host.serviceRequest(RoomsServiceSubjects.ATTACH, {
      descriptor: this.descriptor,
      name,
      version: opts?.version,
      media_type: opts?.media_type,
      origin: opts?.origin,
      data_b64: bytesToB64(stored),
    })) as AttachResult;
    this.post(
      {
        type: "artifact",
        name,
        version: opts?.version ?? "1",
        ref: resp.ref,
        digest: resp.digest,
        media_type: opts?.media_type,
        size: resp.size,
        sealed: this.sealed,
        origin: opts?.origin,
        role: opts?.role,
      },
      opts?.channel,
    );
    return resp;
  }

  /**
   * Announce a file the room does not hold.
   *
   * The per-artifact cap is 512 KB, so anything media-shaped — a video, a
   * dataset, a model — can never live on a room drive. This records WHERE it
   * lives and WHAT IT SHOULD HASH TO, which is the part that matters: the room
   * guarantees that a named member asserted these bytes have this digest, and
   * anyone who fetches them can check. Nothing on the mesh dereferences the
   * location.
   *
   * The digest is required for exactly that reason. A pointer with no digest is
   * a link, and a link is not an artifact — it says nothing about what you will
   * get when you follow it.
   */
  async link(
    name: string,
    opts: {
      location: string;
      digest: string;
      size?: number;
      version?: string;
      media_type?: string;
      origin?: string;
      channel?: string;
      role?: "input" | "interim" | "output";
    },
  ): Promise<AttachResult & { external: string }> {
    this.requireDurable();
    const resp = (await this.host.serviceRequest(RoomsServiceSubjects.ATTACH, {
      descriptor: this.descriptor,
      name,
      version: opts.version,
      media_type: opts.media_type,
      origin: opts.origin,
      location: opts.location,
      digest: opts.digest,
      size: opts.size,
    })) as AttachResult & { external: string };
    this.post(
      {
        type: "artifact",
        name,
        version: opts.version ?? "1",
        ref: resp.ref,
        digest: resp.digest,
        media_type: opts.media_type,
        size: resp.size,
        // Never sealed: the room holds no bytes to seal, and claiming otherwise
        // would tell a reader the room key protects something it does not.
        sealed: false,
        origin: opts.origin,
        external: resp.external,
        role: opts.role,
      },
      opts.channel,
    );
    return resp;
  }

  /** The room's drive index: every file, newest last.
   *
   *  Distinct from the transcript on purpose. The record says a file was
   *  announced; this says what is actually stored and still fetchable, which
   *  are different questions once anything has been reclaimed. */
  async files(): Promise<RoomFile[]> {
    this.requireDurable();
    const s = (await this.status()) as { drive?: { artifacts?: RoomFile[] } };
    return s.drive?.artifacts ?? [];
  }

  /** Fetch an artifact's bytes by its ref (from an `artifact` announcement). */
  async fetchArtifact(ref: string): Promise<FetchedArtifact> {
    this.requireDurable();
    const resp = (await this.host.serviceRequest(RoomsServiceSubjects.FETCH, {
      descriptor: this.descriptor,
      ref,
    })) as { ref: string; name: string; version: string; digest: string; media_type: string | null; size: number; origin?: string | null; data_b64: string };
    let data = b64ToBytes(resp.data_b64);
    if (this.sealed) {
      const opened = openBytes(data, this.requireRoomKey());
      if (!opened) throw new Error(`artifact ${resp.name} did not decrypt with this room's key`);
      data = opened;
    }
    return {
      ref: resp.ref,
      name: resp.name,
      version: resp.version,
      digest: resp.digest,
      media_type: resp.media_type,
      size: resp.size,
      origin: resp.origin ?? null,
      data,
    };
  }

  // ── notes on a file (EXT-5 §8.4) ──────────────────────────────────────

  /**
   * Attach a note to a file already on this room's drive, keyed by its digest.
   *
   * A note is a short attributed statement about those exact bytes — somebody
   * already looked, and here is what they said. It adds a row beside the file:
   * nothing is edited, hidden or removed, no room message is posted, and the
   * record is unchanged. Whoever fetches the bytes still screens them if that
   * is their policy; this is prior information, not a substitute for it.
   *
   * Any member may write one — there is no screener role to grant or revoke,
   * because conferring one is exactly the invisible setting §8.4 is trying not
   * to have. `by` and `at` are the SERVICE's to set, from the verified envelope
   * and its own clock: a client that sends them is claiming an authorship it
   * cannot prove, which is why this method has no way to.
   */
  async note(
    digest: string,
    verdict: RoomNoteVerdict,
    opts?: { reason?: string; source?: RoomNoteSource },
  ): Promise<RoomNote> {
    this.requireDurable();
    if (!digest) throw new Error("a note is keyed by the file's digest, and none was given");
    // The type says this already; the check is for the JavaScript caller the
    // type cannot reach. Three values, closed on purpose (§8.4).
    if (!ROOM_NOTE_VERDICTS.includes(verdict)) {
      throw new Error(`verdict must be one of ${ROOM_NOTE_VERDICTS.join(", ")}`);
    }
    const resp = (await this.host.serviceRequest(RoomsServiceSubjects.NOTE, {
      descriptor: this.descriptor,
      digest,
      verdict,
      reason: opts?.reason,
      source: opts?.source,
    })) as { note?: RoomNote };
    // The service answers `{noted, digest, note, notes_on_file}`; a bare record
    // is accepted too, since a note is unambiguous either way.
    return resp?.note ?? (resp as unknown as RoomNote);
  }

  /**
   * The notes on one digest, or — with no digest — every noted file in the
   * room.
   *
   * Notes are ordered as the service returns them and are never merged: two
   * members who disagree about the same bytes both appear, each with its
   * author. Show the author. A note is never the room's verdict.
   */
  async notes(digest?: string): Promise<RoomNote[]> {
    this.requireDurable();
    const resp = (await this.host.serviceRequest(RoomsServiceSubjects.NOTES, {
      descriptor: this.descriptor,
      // Omitted, not null: absent asks for every noted digest in the room.
      ...(digest ? { digest } : {}),
    })) as { notes?: RoomNote[] };
    return resp?.notes ?? [];
  }

  /** Record/drive usage and limits, from the rooms service. */
  async status(): Promise<unknown> {
    this.requireDurable();
    return this.host.serviceRequest(RoomsServiceSubjects.STATUS, {
      descriptor: this.descriptor,
    });
  }

  // ── the work board (EXT-5 §10) ────────────────────────────────────────

  /** Post a work item on the room's board: one line of what is wanted, open
   *  to whichever member claims it first. The board is implicit — it exists
   *  the moment the first item is posted — but it lives with the rooms
   *  service, so like the record and the drive it needs a durable room.
   *  `lease_ms` bounds a future claimant's lease (operator-clamped, default
   *  1 hour); `offering` is a hint about what kind of agent should take it. */
  async postWork(input: {
    title: string;
    detail?: string;
    offering?: string;
    lease_ms?: number;
  }): Promise<BoardItem> {
    this.requireDurable();
    // The item's four fields and nothing else: who posts it is the key that
    // signs the request, so nothing a caller passes can name a poster.
    const resp = (await this.host.serviceRequest(BoardSubjects.POST, {
      descriptor: this.descriptor,
      title: input.title,
      detail: input.detail,
      offering: input.offering,
      lease_ms: input.lease_ms,
    })) as { item: BoardItem };
    return resp.item;
  }

  /** The room's board: every item oldest first, with lease expiry already
   *  applied — an item whose claim lapsed reads as `open` (and carries
   *  `lease_lapsed`) whether or not any sweep has run. The counts summarize
   *  by state, so "anything for me?" is one call. */
  async boardItems(): Promise<BoardList> {
    this.requireDurable();
    return (await this.host.serviceRequest(BoardSubjects.LIST, {
      descriptor: this.descriptor,
    })) as BoardList;
  }

  /** Claim one open item. Atomic: exactly one claimant wins a contested item
   *  and every other is refused with `BOARD_ITEM_TAKEN` naming the holder and
   *  the lease's end — recover by listing again, not by re-claiming in a
   *  loop. The claim mints a `task_id`: open the real Task under it via the
   *  ordinary deferred-task path, naming the poster as requester (§10.2) —
   *  the board coordinates who does the work; the Task machinery carries it. */
  async claimWork(itemId: string, leaseMs?: number): Promise<BoardItem> {
    this.requireDurable();
    const resp = (await this.host.serviceRequest(BoardSubjects.CLAIM, {
      descriptor: this.descriptor,
      item_id: itemId,
      lease_ms: leaseMs,
    })) as { item: BoardItem };
    return resp.item;
  }

  /** Current claimer only: end the item `done`, with an optional result note
   *  and artifact refs — both claims the board records and never adjudicates.
   *  A completion after the lease lapsed is accepted so long as nobody
   *  re-claimed: work that finished is work that finished. */
  async completeWork(
    itemId: string,
    opts?: { note?: string; artifacts?: string[] },
  ): Promise<BoardItem> {
    this.requireDurable();
    const resp = (await this.host.serviceRequest(BoardSubjects.COMPLETE, {
      descriptor: this.descriptor,
      item_id: itemId,
      note: opts?.note,
      artifacts: opts?.artifacts,
    })) as { item: BoardItem };
    return resp.item;
  }

  /** Current claimer only: put the item back — `claimed → open`, the
   *  abandoned claim recorded on its history. Honest surrender beats a lease
   *  quietly running out: the item is claimable again now, not at expiry. */
  async abandonWork(itemId: string): Promise<BoardItem> {
    this.requireDurable();
    const resp = (await this.host.serviceRequest(BoardSubjects.ABANDON, {
      descriptor: this.descriptor,
      item_id: itemId,
    })) as { item: BoardItem };
    return resp.item;
  }

  /** Poster only: remove an UNCLAIMED item. A live claim is never pulled out
   *  from under its worker — refused with `BOARD_ITEM_TAKEN` — so a poster
   *  who wants an item gone waits out the lease. */
  async withdrawWork(itemId: string): Promise<BoardItem> {
    this.requireDurable();
    const resp = (await this.host.serviceRequest(BoardSubjects.WITHDRAW, {
      descriptor: this.descriptor,
      item_id: itemId,
    })) as { item: BoardItem };
    return resp.item;
  }

  /** Creator only: delete the room's record and drive and free its quota.
   *  Post `close` first if members should hear a farewell. */
  async reclaim(): Promise<RoomDossier> {
    this.requireDurable();
    if (this.host.agentId !== this.descriptor.creator) {
      throw new Error("only the room's creator may reclaim it");
    }
    // Returns the dossier it just destroyed the original of. Keep it: this is
    // the last moment the record and the accepted outputs exist anywhere.
    const d = (await this.host.serviceRequest(RoomsServiceSubjects.RECLAIM, {
      descriptor: this.descriptor,
    })) as { dossier: RoomDossier };
    return d.dossier;
  }

  /** The room's dossier as it stands: the whole record, the accepted outputs
   *  with their bytes, and every other file by digest alone.
   *
   *  Any member may ask. A durable room is deleted after an idle window and the
   *  record goes with it, so this is how a job outlives the conversation that
   *  produced it — and taking one does not close anything. */
  async dossier(): Promise<RoomDossier> {
    this.requireDurable();
    return (await this.host.serviceRequest(RoomsServiceSubjects.DOSSIER, {
      descriptor: this.descriptor,
    })) as RoomDossier;
  }

  /** Post a signed `leave` and unsubscribe. */
  leave(): void {
    if (this._closed) return;
    this.post({ type: "leave", member: this.host.agentId });
    this.detach();
  }

  /** Creator only: post `expel` (§8.1) — remove a member from the room.
   *  Every receiver folds the member out of its roster, and the well-behaved
   *  member detaches on hearing it (after its handlers run). The severity is
   *  part of the wire shape: `timeout` (cool off), `conduct`, or `safety`.
   *
   *  acl rooms: the rooms service is additionally told to revoke the member's
   *  room-scoped credential (§8.1, acl = enforced) — renewal is refused and
   *  the member's room connection lapses within the credential's short TTL,
   *  so the broker itself stops carrying them. The control message always
   *  posts first; a service error then propagates, like invite's admit. */
  expel(member: string, opts: { severity: RoomExpelSeverity; note?: string }): Promise<void> {
    if (this.host.agentId !== this.descriptor.creator) {
      throw new Error("only the room's creator can expel");
    }
    this.post({ type: "expel", member, severity: opts.severity, note: opts.note });
    if (this.acl) {
      // Enforcement lives with the service: it drops the member from the
      // admit list and refuses future credential requests until the creator
      // re-admits. Re-admission stays possible — an expel is not forever
      // unless the creator never invites again.
      return this.host
        .serviceRequest(RoomsServiceSubjects.EXPEL, {
          descriptor: this.descriptor,
          member,
          severity: opts.severity,
        })
        .then(() => undefined);
    }
    return Promise.resolve();
  }

  /**
   * Detach LOCALLY: unsubscribe and drop the room-scoped connection, posting
   * nothing.
   *
   * This is what a host wants when it is shutting down, evicting an idle
   * connection, or restarting — none of which are departures, and none of which
   * any other member should be told about. The Rust SDK has had `stop()` for
   * exactly this; TypeScript had only `leave()` (posts `leave`) and `close()`
   * (creator-only, posts `close` and ENDS THE ROOM FOR EVERYONE), so a host
   * reaching for the nearest-sounding method could close a room it merely wanted
   * to stop listening to. Two callers did.
   *
   * Idempotent. Safe for any member, creator or not.
   */
  stop(): void {
    if (this._closed) return;
    this.detach();
  }

  /** Creator only: post `close` and unsubscribe. Members seeing `close` are
   *  detached automatically.
   *
   *  This ENDS THE ROOM for every member. To stop listening without saying
   *  anything, use [`stop`](Room.stop); to leave as a member, `leave`. */
  close(reason?: string): void {
    if (this._closed) return;
    if (this.host.agentId !== this.descriptor.creator) {
      throw new Error("only the room's creator may close it");
    }
    this.post({ type: "close", reason });
    this.detach();
  }

  // ── internal ──────────────────────────────────────────────────────────

  /** The room's live-traffic subject prefix. acl rooms use the broker-enforced
   *  `mesh.aclroom.<id>` namespace; other grades use the open event namespace. */
  private get subjectBase(): string {
    return this.acl
      ? `mesh.aclroom.${this.descriptor.room_id}`
      : Subjects.event(`room.${this.descriptor.room_id}`);
  }

  private subjectFor(channel: string): string {
    return `${this.subjectBase}.${channel}`;
  }

  /** Publish/subscribe go through the acl transport when present, else the
   *  agent's main connection. */
  private pub(subject: string, data: Uint8Array): void {
    if (this.aclTransport) this.aclTransport.publish(subject, data);
    else this.host.publish(subject, data);
  }

  private post(msg: RoomMessage, channel?: string, meta?: Record<string, unknown>): void {
    if (this._closed) throw new Error("room is closed");
    const env = signEnvelope(
      createEnvelope({
        type: "emit",
        from: this.host.agentId,
        context_id: this.descriptor.room_id,
        payload: msg,
        meta: withOutgoingMeta(this.host.outgoingMeta?.(), meta),
      }),
      this.host.keyPair,
    );
    this.pub(
      this.subjectFor(channel ?? this.descriptor.channels[0] ?? "main"),
      encode(env),
    );
  }

  private listen(): void {
    const subject = `${this.subjectBase}.*`;
    const onEnv = (env: Envelope) => this.onEnvelope(env);
    this.sub = this.aclTransport
      ? this.aclTransport.subscribe(subject, onEnv)
      : this.host.subscribe(subject, onEnv);
  }

  /** Bounded per-room seen-id memory, mirroring the inbox path's
   *  rememberInboxId. Room messages had neither dedup nor a freshness bound, so
   *  anyone who once held the room token could replay a captured `say`, artifact
   *  announcement, or the creator's `expel` months later and every member's
   *  handler fired again on a perfectly valid signature. */
  private seenIds = new Set<string>();
  private seenOrder: string[] = [];
  private remember(from: string, id: string): boolean {
    // `|` appears in neither an nkey nor a UUID, so the pair is unambiguous.
    const key = `${from}|${id}`;
    if (this.seenIds.has(key)) return false;
    this.seenIds.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > MAX_SEEN_ROOM_IDS) {
      const drop = this.seenOrder.shift();
      if (drop) this.seenIds.delete(drop);
    }
    return true;
  }

  /** Room traffic is live fan-out — a durable room's history is replayed
   *  through `history()`, never through here — so the window is the live one.
   *  It is what makes the bounded seen-id memory above sufficient. */
  private fresh(env: Envelope): boolean {
    const ts = Date.parse(env.ts);
    if (Number.isNaN(ts)) return false;
    const drift = Date.now() - ts;
    return drift >= -MAX_CLOCK_SKEW_AHEAD_MS && drift <= MAX_CLOCK_SKEW_BEHIND_MS;
  }

  private onEnvelope(env: Envelope): void {
    if (env.context_id !== this.descriptor.room_id) return;
    const msg = env.payload as RoomMessage;
    if (!msg || typeof msg !== "object" || !ROOM_MESSAGE_TYPES.has(msg.type)) return;
    // Per-message authorship: verify the author's signature, drop failures.
    if (!verifyEnvelopeSig(env)) return;
    if (!this.fresh(env)) return;
    if (!this.remember(env.from, env.id)) return;
    // Lifecycle authority: genesis, expel, and close are the creator's alone.
    if (
      (msg.type === "genesis" || msg.type === "expel" || msg.type === "close") &&
      env.from !== this.descriptor.creator
    )
      return;

    // Membership is FIRST-PERSON: an agent joins and leaves for itself. The
    // roster used to take `msg.member` on trust, so anyone who knew the room id
    // could post `{type:"leave", member: Alice}` and erase Alice from every
    // member's view, or flood `join`s with random member strings until the Set
    // ate the process. Expel is deliberately NOT first-person — it names
    // someone else by design — which is why it carries the creator gate above.
    if (msg.type === "join" || msg.type === "leave") {
      if (msg.member !== env.from) return;
    }
    if (msg.type === "join" && this.roster.size < MAX_ROOM_ROSTER) this.roster.add(msg.member);
    // An expelled member leaves the fold exactly like a leave (§8.1).
    if (msg.type === "leave" || msg.type === "expel") this.roster.delete(msg.member);
    // A phase from anyone but the facilitator is DELIVERED and does not move
    // the room (§8.5). Dropping it would hide a signed statement a member
    // made; obeying it would make the declared facilitator meaningless.
    if (msg.type === "phase") this.applyPhase(msg, env.from, Date.parse(env.ts) || Date.now());

    let delivered = this.unsealIfNeeded(msg);
    // Receivers MUST treat an unknown expel severity as `conduct` (§8.1).
    if (delivered.type === "expel" && !EXPEL_SEVERITIES.has(delivered.severity)) {
      delivered = { ...delivered, severity: "conduct" };
    }

    const own = env.from === this.host.agentId;
    if (!own || this.includeSelf) {
      for (const h of this.handlers) {
        try {
          h(delivered, env);
        } catch {
          // Handler errors are non-fatal for room delivery.
        }
      }
    }

    // Well-behaved by default: an expel naming this member detaches like a
    // close. Handlers already ran, so a caller that wants to observe the
    // expulsion (severity, note) has seen it before the room goes quiet.
    if (msg.type === "close" || (msg.type === "expel" && msg.member === this.host.agentId)) {
      this.detach();
    }
  }

  /** Decrypt a say's body for delivery when this member holds the room key.
   *  A body that fails to open is delivered as-is (visibly sealed) rather
   *  than dropped — the signature already proved who sent it. */
  private unsealIfNeeded(msg: RoomMessage): RoomMessage {
    if (msg.type !== "say" || !this.roomKey || !isSealedBody(msg.body)) return msg;
    const opened = openBody(msg.body, this.roomKey);
    return opened === null ? msg : { ...msg, body: opened };
  }

  private detach(): void {
    this.sub?.unsubscribe();
    this.sub = null;
    if (this.aclTransport) {
      void this.aclTransport.close();
      this.aclTransport = null;
    }
    this._closed = true;
  }
}
