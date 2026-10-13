/**
 * mesh.rooms: the rooms service's requests on the SDK door
 * (platform-services/rooms.json; docs/platform-services-plan.md).
 *
 * The names, the fields, the answers and the refusals are the definition's,
 * through the generated `RoomsRequests` interface and refusal types, so this
 * file cannot add a field or a refusal the definition does not have. What it
 * adds is how the SDK does each request: on the live rooms it holds
 * (openRoom, joinRoom), which stay the SDK's way to listen to a room and are
 * returned as `room`.
 *
 * A room is named by its id or its name. Rooms this door opened or joined
 * are held here; any other room the rooms service lists for this agent (acl
 * and durable rooms it created or was admitted to) is joined on first use.
 */
import type { AgentMesh } from "./mesh.js";
import { descriptorFromToken, type Room, type RoomFile } from "./rooms.js";
import { Diagnostics } from "./diagnostics.js";
import {
  ServiceRefusal,
  type RoomsRequests,
  type RoomsOpenInput, type RoomsOpenResult, type RoomsOpenRefusal,
  type RoomsJoinInput, type RoomsJoinResult, type RoomsJoinRefusal,
  type RoomsInviteInput, type RoomsInviteResult, type RoomsInviteRefusal,
  type RoomsPostInput, type RoomsPostResult, type RoomsPostRefusal,
  type RoomsHistoryInput, type RoomsHistoryResult, type RoomsHistoryRefusal,
  type RoomsPhaseInput, type RoomsPhaseResult, type RoomsPhaseRefusal,
  type RoomsListInput, type RoomsListResult, type RoomsListRefusal,
  type RoomsAttachInput, type RoomsAttachResult, type RoomsAttachRefusal,
  type RoomsFetchInput, type RoomsFetchResult, type RoomsFetchRefusal,
  type RoomsLinkInput, type RoomsLinkResult, type RoomsLinkRefusal,
  type RoomsFilesInput, type RoomsFilesResult, type RoomsFilesRefusal,
} from "./services.generated.js";

const AGENT_ID_RE = /^U[A-Z2-7]{55}$/;
/** The rooms service's limit on one file (EXT-5 §4). */
export const ROOM_FILE_MAX_BYTES = 512 * 1024;
/** The longest message a room takes, as the app's room page does (rooms-routes.ts). */
export const ROOM_POST_MAX_CHARS = 16_000;

/** A refusal for one request, typed to the codes its definition names, so a
 *  code the definition does not have fails to compile. */
type Refuse<C extends string> = (code: C, words: string) => never;
function refusal<C extends string>(request: string): Refuse<C> {
  return (code, words) => {
    throw new ServiceRefusal(`rooms.${request}`, code, words);
  };
}

const errCode = (e: unknown): string => String((e as { code?: unknown })?.code ?? "");
const errWords = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The phase as the definition carries it: the pattern, the note, and who
 *  moved the room into it (absent while it is the opening pattern). */
function phaseOf(room: Room): RoomsOpenResult["phase"] {
  const p = room.phase;
  if (!p) return undefined;
  return { pattern: p.pattern, ...(p.note ? { note: p.note } : {}), ...(p.by ? { by: p.by } : {}) };
}

export class RoomsDoor implements RoomsRequests {
  private readonly held = new Map<string, Room>();

  constructor(private readonly mesh: AgentMesh) {}

  /** Keep a live room this door made or joined, so later requests reach it. */
  private keep(room: Room): Room {
    this.held.set(room.id, room);
    return room;
  }

  /** A room by id or name: held here, or listed for this agent by the rooms
   *  service and joined now. A sealed room is only reachable once held, since
   *  its key travels in the invite. The board door (board-door.ts) reaches
   *  rooms through this too, so the two share the rooms they hold.
   *  @internal */
  async roomOf(no: Refuse<"NOT_IN_ROOM">, ref: string): Promise<Room> {
    const want = String(ref ?? "").trim();
    if (!want) return no("NOT_IN_ROOM", "Say which room: its id or its name.");
    const byId = this.held.get(want);
    if (byId && !byId.closed) return byId;
    for (const r of this.held.values()) if (!r.closed && r.descriptor.name === want) return r;
    let mine: Awaited<ReturnType<AgentMesh["myRooms"]>> = [];
    try {
      mine = await this.mesh.myRooms();
    } catch {
      /* the rooms service is away: answered as not in the room, below */
    }
    const found = mine.find((m) => m.room_id === want) ?? mine.find((m) => m.name === want);
    if (found && found.descriptor.privacy !== "sealed") {
      try {
        return this.keep(await this.mesh.joinRoom(found.descriptor));
      } catch (e) {
        return no("NOT_IN_ROOM", `This agent could not rejoin that room: ${errWords(e)}`);
      }
    }
    return no("NOT_IN_ROOM", "You are not in that room. rooms.list() shows the rooms you are in.");
  }

  /** A handle or an agent id, as the agent id, checked against the registrar. */
  private async agentIdOf<C extends string>(no: Refuse<C>, code: C, target: string): Promise<string> {
    const t = String(target ?? "").trim();
    if (AGENT_ID_RE.test(t)) return t;
    const r = await new Diagnostics(this.mesh).resolve(t).catch(() => null);
    if (!r?.resolved || !r.agentId) return no(code, `No agent answers to ${t}.`);
    return r.agentId;
  }

  async open(input: RoomsOpenInput = {}): Promise<RoomsOpenResult> {
    const no = refusal<RoomsOpenRefusal>("open");
    if (input.sealed && input.acl) no("INPUT_INVALID", "A room is either sealed or keeps a member list, not both.");
    const agenda = (input.agenda ?? []).filter((x) => typeof x === "string" && x.trim());
    let facilitator = input.facilitator?.trim() || undefined;
    if (facilitator && !AGENT_ID_RE.test(facilitator)) facilitator = await this.agentIdOf(no, "INPUT_INVALID", facilitator);
    const playbook = input.playbook || agenda.length
      ? {
          pattern: input.playbook ?? "",
          ...(agenda.length ? { agenda } : {}),
          ...(facilitator ? { facilitator } : {}),
          ...(input.playbook_note ? { note: input.playbook_note } : {}),
        }
      : undefined;
    const name = input.name?.trim() || undefined;
    let room: Room;
    try {
      if (input.acl) room = await this.mesh.openRoom({ name, playbook, acl: true });
      else if (input.durable) room = await this.mesh.openRoom({ name, playbook, sealed: !!input.sealed, durable: true });
      else room = this.mesh.openRoom({ name, playbook, sealed: !!input.sealed });
    } catch (e) {
      const code = errCode(e);
      if (code === "NOT_NAMED") return no("NOT_NAMED", errWords(e));
      if (code === "QUOTA_EXCEEDED") return no("QUOTA_EXCEEDED", errWords(e));
      if (code === "TRANSPORT_TIMEOUT" || code === "TRANSPORT_NO_RESPONDERS") return no("UNAVAILABLE", errWords(e));
      if (code === "INPUT_INVALID") return no("INPUT_INVALID", errWords(e));
      throw e;
    }
    this.keep(room);
    const brief = room.brief();
    const phase = phaseOf(room);
    return {
      room_id: room.id,
      ...(room.descriptor.name ? { name: room.descriptor.name } : {}),
      durable: room.durable,
      sealed: room.sealed,
      acl: room.acl,
      token: room.token,
      ...(phase ? { phase } : {}),
      ...(brief ? { brief } : {}),
      room,
    };
  }

  async join(input: RoomsJoinInput): Promise<RoomsJoinResult> {
    const no = refusal<RoomsJoinRefusal>("join");
    const token = String(input?.invite_or_token ?? "").trim();
    try {
      descriptorFromToken(token);
    } catch {
      no("INPUT_INVALID", "That is not a room token. The SDK joins by token; an invite reaches your program as a rooms.invite request carrying it.");
    }
    let room: Room;
    try {
      room = await this.mesh.joinRoom(token);
    } catch (e) {
      const code = errCode(e);
      if (code === "NOT_NAMED") return no("NOT_NAMED", errWords(e));
      if (code === "UNAUTHORIZED" || /not admitted|expelled/i.test(errWords(e))) return no("NOT_ADMITTED", errWords(e));
      throw e;
    }
    this.keep(room);
    const brief = room.brief();
    const phase = phaseOf(room);
    return {
      room_id: room.id,
      ...(room.descriptor.name ? { name: room.descriptor.name } : {}),
      members: room.members,
      ...(phase ? { phase } : {}),
      ...(brief ? { brief } : {}),
      room,
    };
  }

  async invite(input: RoomsInviteInput): Promise<RoomsInviteResult> {
    const no = refusal<RoomsInviteRefusal>("invite");
    const room = await this.roomOf(no, input.room);
    const to = await this.agentIdOf(no, "NOT_FOUND", input.target);
    try {
      await room.invite(to, input.note ?? undefined);
      return { room_id: room.id, to, delivered: true };
    } catch (e) {
      const code = errCode(e);
      if (code === "NOT_NAMED") return no("NOT_NAMED", errWords(e));
      if (code === "UNAUTHORIZED" || /only the room's creator/i.test(errWords(e))) return no("NOT_PERMITTED", errWords(e));
      return {
        room_id: room.id,
        to,
        delivered: false,
        delivery: `Invite sent with no answer (${errWords(e)}). They may be offline, or their owner may be holding first contact for approval.`,
      };
    }
  }

  async post(input: RoomsPostInput): Promise<RoomsPostResult> {
    const no = refusal<RoomsPostRefusal>("post");
    const text = String(input.text ?? "");
    if (text.length > ROOM_POST_MAX_CHARS) return no("TOO_BIG", `That message is ${text.length} characters; a room takes at most ${ROOM_POST_MAX_CHARS}. In a durable room, put it on the drive with rooms.attach() and quote its ref.`);
    const room = await this.roomOf(no, input.room);
    try {
      room.say(text);
    } catch (e) {
      if (errCode(e) === "NOT_NAMED") return no("NOT_NAMED", errWords(e));
      throw e;
    }
    return { room_id: room.id };
  }

  async history(input: RoomsHistoryInput): Promise<RoomsHistoryResult> {
    const no = refusal<RoomsHistoryRefusal>("history");
    const room = await this.roomOf(no, input.room);
    if (!room.durable) return no("NOT_DURABLE", "That room keeps no record.");
    const entries = await room.fullHistory();
    return {
      room_id: room.id,
      entries: entries.map((e) => {
        const m = e.message as unknown as (Record<string, unknown> & { type?: string }) | null;
        const art = m?.type === "artifact";
        const str = (k: string): string | undefined => (m && typeof m[k] === "string" ? (m[k] as string) : undefined);
        const num = (k: string): number | undefined => (m && typeof m[k] === "number" ? (m[k] as number) : undefined);
        return {
          seq: e.seq,
          from: e.envelope.from,
          ...(e.envelope.ts ? { at: e.envelope.ts } : {}),
          type: m?.type ?? "unknown",
          ...(m?.type === "say" && str("body") !== undefined ? { body: str("body") } : {}),
          ...(art ? {
            name: str("name"), ref: str("ref"), version: str("version"),
            digest: str("digest"), size: num("size"), origin: str("origin"),
          } : {}),
          ...(str("member") !== undefined ? { member: str("member") } : {}),
        };
      }),
    };
  }

  async phase(input: RoomsPhaseInput): Promise<RoomsPhaseResult> {
    const no = refusal<RoomsPhaseRefusal>("phase");
    const room = await this.roomOf(no, input.room);
    try {
      room.callPhase(String(input.pattern), input.note ? { note: input.note } : undefined);
    } catch (e) {
      if (errCode(e) === "NOT_NAMED") return no("NOT_NAMED", errWords(e));
      return no("NOT_FACILITATOR", errWords(e));
    }
    const brief = room.brief();
    return { room_id: room.id, phase: phaseOf(room) ?? { pattern: String(input.pattern) }, ...(brief ? { brief } : {}) };
  }

  async list(_input?: RoomsListInput): Promise<RoomsListResult> {
    let mine: Awaited<ReturnType<AgentMesh["myRooms"]>> = [];
    try {
      mine = await this.mesh.myRooms();
    } catch (e) {
      // Rooms held here are still known; the service's list is not.
      if (!this.held.size) return refusal<RoomsListRefusal>("list")("UNAVAILABLE", errWords(e));
    }
    const rooms: RoomsListResult["rooms"] = [];
    const seen = new Set<string>();
    for (const m of mine) {
      seen.add(m.room_id);
      const live = this.held.get(m.room_id);
      rooms.push({
        room_id: m.room_id,
        ...(m.name ? { name: m.name } : {}),
        creator: m.descriptor.creator,
        role: m.role,
        privacy: m.privacy,
        ...(live ? { members: live.members } : {}),
        ...(m.last_seq !== null ? { unread: Math.max(0, m.last_seq - m.cursor) } : {}),
      });
    }
    for (const r of this.held.values()) {
      if (r.closed || seen.has(r.id)) continue;
      rooms.push({
        room_id: r.id,
        ...(r.descriptor.name ? { name: r.descriptor.name } : {}),
        creator: r.descriptor.creator,
        role: r.descriptor.creator === this.mesh.id ? "creator" : "member",
        privacy: r.descriptor.privacy,
        members: r.members,
      });
    }
    // The service never learns of a room held only by its token (EXT-5 §6).
    return { rooms, complete: false };
  }

  async attach(input: RoomsAttachInput): Promise<RoomsAttachResult> {
    const no = refusal<RoomsAttachRefusal>("attach");
    const room = await this.roomOf(no, input.room);
    if (!room.durable) return no("NOT_DURABLE", "That room has no drive.");
    const name = String(input.name ?? "").split(/[\\/]/).pop() ?? "";
    if (!name || name === "." || name === "..") return no("INPUT_INVALID", "name must be a plain file name.");
    const bytes = new TextEncoder().encode(String(input.content ?? ""));
    if (bytes.length > ROOM_FILE_MAX_BYTES) {
      return no("TOO_BIG", `That file is ${bytes.length} bytes; a room's drive takes at most ${ROOM_FILE_MAX_BYTES}. rooms.link() announces bytes held somewhere else.`);
    }
    const r = await room.attach(name, bytes, {
      ...(input.version ? { version: input.version } : {}),
      media_type: input.media_type ?? "text/plain",
      ...(input.origin ? { origin: input.origin } : {}),
    });
    return { ref: r.ref, digest: r.digest, size: r.size };
  }

  async fetch(input: RoomsFetchInput): Promise<RoomsFetchResult> {
    const no = refusal<RoomsFetchRefusal>("fetch");
    const room = await this.roomOf(no, input.room);
    if (!room.durable) return no("NOT_DURABLE", "That room has no drive.");
    let ref = String(input.ref ?? "").trim();
    if (!ref.startsWith("mesh:rooms:")) {
      const files: RoomFile[] = await room.files();
      const match = files.filter((f) => f.name === ref).pop();
      if (!match) return no("NOT_FOUND", "No file with that ref or name on this room's drive.");
      ref = match.ref;
    }
    let a;
    try {
      a = await room.fetchArtifact(ref);
    } catch (e) {
      if (errCode(e) === "NOT_FOUND" || errCode(e) === "ARTIFACT_GONE") return no("NOT_FOUND", errWords(e));
      throw e;
    }
    let text: string | undefined;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(a.data);
    } catch {
      text = undefined;
    }
    return {
      ref: a.ref, name: a.name, version: a.version, size: a.size, digest: a.digest,
      ...(a.media_type ? { media_type: a.media_type } : {}),
      ...(a.origin ? { origin: a.origin } : {}),
      ...(text !== undefined ? { text } : { binary: true }),
      data: a.data,
    };
  }

  async link(input: RoomsLinkInput): Promise<RoomsLinkResult> {
    const no = refusal<RoomsLinkRefusal>("link");
    const room = await this.roomOf(no, input.room);
    if (!room.durable) return no("NOT_DURABLE", "That room has no drive.");
    if (!/^sha256:[0-9a-f]{64}$/.test(String(input.digest ?? ""))) {
      return no("INPUT_INVALID", "digest must be sha256: followed by the 64 hex digits of the bytes.");
    }
    try {
      const r = await room.link(String(input.name).split(/[\\/]/).pop() ?? String(input.name), {
        location: input.location,
        digest: input.digest,
        ...(input.size !== undefined ? { size: input.size } : {}),
        ...(input.version ? { version: input.version } : {}),
        ...(input.media_type ? { media_type: input.media_type } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
      });
      return { ref: r.ref, digest: r.digest, external: r.external };
    } catch (e) {
      if (errCode(e) === "INPUT_INVALID") return no("INPUT_INVALID", errWords(e));
      throw e;
    }
  }

  async files(input: RoomsFilesInput): Promise<RoomsFilesResult> {
    const no = refusal<RoomsFilesRefusal>("files");
    const room = await this.roomOf(no, input.room);
    if (!room.durable) return no("NOT_DURABLE", "That room has no drive.");
    const files = await room.files();
    return {
      room_id: room.id,
      files: files.map((f) => ({
        ref: f.ref, name: f.name, version: f.version, size: f.size, digest: f.digest,
        ...(f.media_type ? { media_type: f.media_type } : {}),
        attached_by: f.attached_by, attached_at: f.attached_at,
        ...(f.origin ? { origin: f.origin } : {}),
        ...(f.external ? { external: f.external } : {}),
      })),
    };
  }
}
