/**
 * The admin API's operator views (step 10a of docs/agent-messaging-server-plan.md):
 * what the core holds about rooms, files, work boards, tasks and mailboxes,
 * for the mesh's operator. AgentMesh's operator console, obligations page and
 * engagement ledger read these rather than opening the core's stores; a
 * self-hosted operator reads the same with the CLI.
 *
 *   GET    /admin/v1/rooms                          every durable room: its stored meta, the account it
 *                                                   counts against, its record's size and last activity
 *   DELETE /admin/v1/rooms/:id                      reclaim a room: its record stream and its meta
 *   GET    /admin/v1/files                          every file's index record (metadata, never bytes)
 *   GET    /admin/v1/boards[?room=]                 every work board item, lease expiry applied
 *   GET    /admin/v1/tasks[?updated_after=]         every stored task record, with when it was written
 *   GET    /admin/v1/tasks/:id                      one stored task record
 *   GET    /admin/v1/mailboxes                      every mailbox: agent, messages, first_seq, last_seq
 *   GET    /admin/v1/mailboxes/:agent               { pending, last_arrival }
 *   GET    /admin/v1/mailboxes/:agent/senders?from=&to=   each envelope's from and ts in that range, never a payload (500 at most)
 *   GET    /admin/v1/mailboxes/:agent/arrivals?since=   { count } of messages that arrived since
 *   POST   /admin/v1/mailboxes/:agent/discard {since}   { discarded }: mail that arrived since, thrown away
 *
 * Each answer is { status, body } and never throws. A store is opened through
 * the storage layer, with the core's own settings for it, so a read never
 * makes one with the wrong ones.
 */
import type { DoorAnswer } from "../keychain/doors.js";
import type { AdminRequest } from "./admin-api.js";
import type { KeyedStore, Storage, StreamFamily } from "../storage/index.js";
import { roomAccountOf, type AgentOwnerRecord } from "../keychain/agent-owners.js";
import { viewItem, type BoardItem } from "../rooms/board-store.js";

const NKEY = /^U[A-Z2-7]{55}$/;
const ROOM_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A task id as the task manager stores it under (a UUID, or a caller's own id of the same charset). */
/** The most envelope headers one senders call reads. */
const MAX_HEADERS = 500;
const TASK_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export interface AdminViewDeps {
  storage: Storage;
  /** The ownership record's agent lookup (a room opened before 2026-10-12
   *  counts against its creator's account). */
  ownerOf?: (agent: string) => Promise<AgentOwnerRecord | null>;
  /** The mailboxes (registry/inbox-buffer.ts). */
  mailboxes?: {
    pending(agent: string): Promise<number | null>;
    countSince(agent: string, since: number): Promise<number>;
    discard(agent: string, since: number): Promise<number>;
  };
}

const ok = (body: Record<string, unknown>, status = 200): DoorAnswer => ({ status, body });
const no = (status: number, error: string): DoorAnswer => ({ status, body: { error } });

type Json = Record<string, unknown>;

export function adminViews(deps: AdminViewDeps) {
  const { storage } = deps;
  const keyed = (name: Parameters<Storage["keyed"]>[0]): Promise<KeyedStore> => storage.keyed(name);
  const family = (name: "MESH_INBOX_<agent>" | "rooms_<room>"): StreamFamily => storage.streams(name);

  /** Every entry of a keyed store, or none when the store is not there. */
  async function entries(name: Parameters<Storage["keyed"]>[0]) {
    const store = await keyed(name);
    return (await store.list()).entries;
  }

  async function rooms(): Promise<DoorAnswer> {
    const out: Json[] = [];
    const records = family("rooms_<room>");
    for (const [id, entry] of await entries("mesh_rooms")) {
      if (entry.operation !== "PUT" || !entry.value.length) continue;
      let meta: Json;
      try { meta = entry.json<Json>(); } catch { continue; }
      let account = typeof meta.account === "string" ? meta.account : null;
      const creator = (meta.descriptor as { creator?: unknown } | undefined)?.creator;
      if (!account && typeof creator === "string" && deps.ownerOf) {
        try { account = roomAccountOf(await deps.ownerOf(creator)); } catch { /* listed without an account */ }
      }
      let record: Json | null = null;
      try {
        const st = await records.member(id).info();
        if (st) record = { messages: st.messages, bytes: st.bytes, last_at: st.lastAt && !st.lastAt.startsWith("0001") ? st.lastAt : null };
      } catch { /* an unknown size reads as unknown */ }
      out.push({ room_id: id, meta, account, record });
    }
    return ok({ rooms: out });
  }

  async function reclaimRoom(id: string): Promise<DoorAnswer> {
    let stream = false;
    let meta = false;
    try { await family("rooms_<room>").member(id).destroy(); stream = true; } catch { /* already gone */ }
    try { await (await keyed("mesh_rooms")).delete(id); meta = true; } catch { /* already gone */ }
    return ok({ room_id: id, stream_removed: stream, meta_removed: meta });
  }

  async function files(): Promise<DoorAnswer> {
    const out: Json[] = [];
    for (const [id, entry] of await entries("mesh_artifacts_index")) {
      if (entry.operation !== "PUT" || !entry.value.length) continue;
      try { out.push({ id, record: entry.json<Json>() }); } catch { /* not a record */ }
    }
    return ok({ files: out });
  }

  async function boards(q: URLSearchParams): Promise<DoorAnswer> {
    const room = q.get("room");
    if (room !== null && !ROOM_ID.test(room)) return no(400, "That is not a room id.");
    const now = Date.now();
    const out: Json[] = [];
    for (const [key, entry] of await entries("mesh_board_items")) {
      if (room !== null && !key.startsWith(`${room}.`)) continue;
      if (entry.operation !== "PUT" || !entry.value.length) continue;
      try { out.push({ key, item: viewItem(entry.json<BoardItem>(), now) }); } catch { /* unparseable, skipped */ }
    }
    return ok({ items: out });
  }

  async function tasks(q: URLSearchParams): Promise<DoorAnswer> {
    const after = q.get("updated_after");
    const since = after ? Date.parse(after) : null;
    if (after && !Number.isFinite(since)) return no(400, "updated_after is an ISO time.");
    const out: Json[] = [];
    let total = 0;
    for (const [id, entry] of await entries("mesh_tasks")) {
      if (entry.operation !== "PUT" || !entry.value.length) continue;
      total++;
      const written = entry.created instanceof Date && !Number.isNaN(entry.created.getTime()) ? entry.created : null;
      if (since !== null && written && written.getTime() <= since) continue;
      try { out.push({ task_id: id, written_at: written ? written.toISOString() : null, record: entry.json<Json>() }); } catch { /* not a record */ }
    }
    return ok({ tasks: out, total });
  }

  async function task(id: string): Promise<DoorAnswer> {
    const entry = await (await keyed("mesh_tasks")).get(id);
    if (!entry || entry.operation !== "PUT" || !entry.value.length) return no(404, "No task record is stored under that id.");
    const written = entry.created instanceof Date && !Number.isNaN(entry.created.getTime()) ? entry.created.toISOString() : null;
    try {
      return ok({ task_id: id, written_at: written, record: entry.json<Json>() });
    } catch {
      return no(404, "The stored task record is not readable.");
    }
  }

  /** Every mailbox that exists: its agent, how many messages it holds, and
   *  its first and last sequence. */
  async function mailboxList(): Promise<DoorAnswer> {
    const out: Json[] = [];
    for await (const s of family("MESH_INBOX_<agent>").list()) {
      out.push({ agent: s.id, messages: s.state.messages, first_seq: s.state.firstSeq, last_seq: s.state.lastSeq });
    }
    return ok({ mailboxes: out });
  }

  /** Who sent the messages in a range of a mailbox, and when: each
   *  envelope's `from` and `ts`, never its payload. At most MAX_HEADERS per
   *  call; a sequence the mailbox no longer holds is left out. */
  async function senders(agent: string, q: URLSearchParams): Promise<DoorAnswer> {
    const from = Number(q.get("from"));
    const to = Number(q.get("to"));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return no(400, "from and to are sequence numbers, from <= to.");
    if (to - from + 1 > MAX_HEADERS) return no(400, `At most ${MAX_HEADERS} messages per call.`);
    const box = family("MESH_INBOX_<agent>").member(agent);
    const out: Json[] = [];
    for (let seq = from; seq <= to; seq++) {
      try {
        const m = await box.read(seq);
        const env = JSON.parse(new TextDecoder().decode(m.data)) as { from?: unknown; ts?: unknown };
        out.push({ seq, from: typeof env.from === "string" ? env.from : null, ts: typeof env.ts === "string" ? env.ts : null });
      } catch { /* a hole in the sequence: purged, expired, or never there */ }
    }
    return ok({ agent, headers: out });
  }

  async function mailbox(agent: string): Promise<DoorAnswer> {
    if (!deps.mailboxes) return no(503, "This server keeps no mailboxes.");
    const pending = await deps.mailboxes.pending(agent);
    let last: string | null = null;
    try {
      const st = await family("MESH_INBOX_<agent>").member(agent).info();
      last = st?.lastAt && !st.lastAt.startsWith("0001") ? st.lastAt : null;
    } catch { /* unknown */ }
    return ok({ agent, pending, last_arrival: last });
  }

  function sinceOf(v: unknown): number | null {
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : null;
  }

  async function arrivals(agent: string, q: URLSearchParams): Promise<DoorAnswer> {
    if (!deps.mailboxes) return no(503, "This server keeps no mailboxes.");
    const since = sinceOf(q.get("since"));
    if (since === null) return no(400, "since is an ISO time.");
    try {
      return ok({ agent, count: await deps.mailboxes.countSince(agent, since) });
    } catch (err) {
      return no(503, `The mailbox could not be read: ${(err as Error).message}`);
    }
  }

  async function discard(agent: string, body: Json | null): Promise<DoorAnswer> {
    if (!deps.mailboxes) return no(503, "This server keeps no mailboxes.");
    const since = sinceOf(body?.since);
    if (since === null) return no(400, "since is an ISO time.");
    try {
      return ok({ agent, discarded: await deps.mailboxes.discard(agent, since) });
    } catch (err) {
      return no(503, `The mailbox could not be reached: ${(err as Error).message}`);
    }
  }

  /** The answer for a view route, or null when the path is not one. */
  async function handle(req: AdminRequest): Promise<DoorAnswer | null> {
    const seg = req.path.replace(/^\/admin\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const m = req.method;
    try {
      if (seg[0] === "rooms") {
        if (seg.length === 1 && m === "GET") return await rooms();
        if (seg.length === 2 && m === "DELETE") return ROOM_ID.test(seg[1]!) ? await reclaimRoom(seg[1]!) : no(400, "That is not a room id.");
      }
      if (seg[0] === "files" && seg.length === 1 && m === "GET") return await files();
      if (seg[0] === "boards" && seg.length === 1 && m === "GET") return await boards(req.query);
      if (seg[0] === "tasks" && seg.length === 1 && m === "GET") return await tasks(req.query);
      if (seg[0] === "tasks" && seg.length === 2 && m === "GET") return TASK_ID.test(seg[1]!) ? await task(seg[1]!) : no(400, "That is not a task id.");
      if (seg[0] === "mailboxes" && seg.length === 1 && m === "GET") return await mailboxList();
      if (seg[0] === "mailboxes" && seg.length >= 2) {
        if (!NKEY.test(seg[1]!)) return no(400, "That is not an agent public key (U followed by 55 characters).");
        if (seg.length === 2 && m === "GET") return await mailbox(seg[1]!);
        if (seg.length === 3 && seg[2] === "senders" && m === "GET") return await senders(seg[1]!, req.query);
        if (seg.length === 3 && seg[2] === "arrivals" && m === "GET") return await arrivals(seg[1]!, req.query);
        if (seg.length === 3 && seg[2] === "discard" && m === "POST") return await discard(seg[1]!, req.body);
      }
    } catch (err) {
      return no(503, `The core could not read that: ${(err as Error).message}`);
    }
    return null;
  }

  return { handle };
}

export type AdminViews = ReturnType<typeof adminViews>;
