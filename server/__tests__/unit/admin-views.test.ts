/**
 * The admin API's operator views (admin/admin-views.ts, step 10a): what the
 * core holds about rooms, files, boards, tasks and mailboxes, answered from
 * its stores through the storage layer, never a payload of a mailbox.
 */
import { describe, expect, it } from "vitest";
import { adminViews } from "../../src/admin/admin-views.js";
import type { KeyedEntry, KeyedStore, Storage, StreamFamily, StreamState, StreamStore } from "../../src/storage/index.js";

const AGENT = `U${"A".repeat(55)}`;
const OWNER_ACCOUNT = "acct-9";

function entry(key: string, value: unknown, created = new Date("2026-10-12T10:00:00.000Z")): KeyedEntry {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  return { key, value: bytes, revision: 1, created, operation: "PUT", length: bytes.length, json: <T>() => JSON.parse(text) as T, string: () => text };
}

function keyedOf(rows: Map<string, KeyedEntry>): KeyedStore {
  return {
    get: async (k: string) => rows.get(k) ?? null,
    list: async () => ({ keys: [...rows.keys()], entries: rows }),
    delete: async (k: string) => { rows.delete(k); },
  } as unknown as KeyedStore;
}

const state = (over: Partial<StreamState>): StreamState => ({ messages: 0, bytes: 0, firstSeq: 0, lastSeq: 0, firstTime: null, lastAt: null, created: null, subjects: [], repairs: [], ...over });

function world() {
  const stores: Record<string, Map<string, KeyedEntry>> = {
    mesh_rooms: new Map([
      ["room1", entry("room1", { descriptor: { name: "Planning", creator: AGENT }, created_at: "2026-10-01T00:00:00Z" })],
      ["room2", entry("room2", { descriptor: { name: "Ops" }, account: "acct-2" })],
    ]),
    mesh_artifacts_index: new Map([["f1", entry("f1", { owner: AGENT, size: 12, name: "a.txt" })]]),
    mesh_board_items: new Map([
      ["room1.i1", entry("room1.i1", { item_id: "i1", room_id: "room1", title: "do it", posted_by: AGENT, posted_at: "2026-10-01T00:00:00Z", lease_ms: 1000, state: "claimed", claimed_by: AGENT, lease_expires_at: "2020-01-01T00:00:00Z" })],
      ["room2.i2", entry("room2.i2", { item_id: "i2", room_id: "room2", title: "other", posted_by: AGENT, posted_at: "2026-10-01T00:00:00Z", lease_ms: 1000, state: "open" })],
    ]),
    mesh_tasks: new Map([
      ["t-old", entry("t-old", { id: "t-old", state: "completed" }, new Date("2026-10-12T09:00:00.000Z"))],
      ["t-new", entry("t-new", { id: "t-new", state: "working" }, new Date("2026-10-12T11:00:00.000Z"))],
      ["t-bad", entry("t-bad", "{not json", new Date("2026-10-12T11:00:00.000Z"))],
    ]),
  };
  const destroyed: string[] = [];
  const mailbox = new Map<number, string>([
    [3, JSON.stringify({ from: "UREG", ts: "2026-10-12T10:00:00Z", payload: { secret: "never shown" } })],
    [5, JSON.stringify({ from: "UFRIEND", ts: "2026-10-12T10:05:00Z", payload: { secret: "never shown" } })],
  ]);
  const member = (family: string, id: string): StreamStore => ({
    name: `${family}${id}`,
    info: async () => (family === "rooms_" && id === "room1" ? state({ messages: 4, bytes: 400, lastAt: "2026-10-12T09:30:00Z" })
      : family === "MESH_INBOX_" && id === AGENT ? state({ messages: 2, firstSeq: 3, lastSeq: 5, lastAt: "2026-10-12T10:05:00Z" }) : null),
    destroy: async () => { destroyed.push(`${family}${id}`); },
    read: async (seq: number) => {
      const t = mailbox.get(seq);
      if (!t) throw new Error("no message");
      return { subject: "x", data: new TextEncoder().encode(t), seq, time: new Date() };
    },
  }) as unknown as StreamStore;
  const families: Record<string, StreamFamily> = {
    "rooms_<room>": { member: (id: string) => member("rooms_", id), list: async function* () {} } as unknown as StreamFamily,
    "MESH_INBOX_<agent>": {
      member: (id: string) => member("MESH_INBOX_", id),
      list: async function* () { yield { name: `MESH_INBOX_${AGENT}`, id: AGENT, state: state({ messages: 2, firstSeq: 3, lastSeq: 5 }) }; },
    } as unknown as StreamFamily,
  };
  const storage = {
    keyed: async (name: string) => keyedOf(stores[name] ?? new Map()),
    streams: (name: string) => families[name]!,
  } as unknown as Storage;
  const discards: Array<[string, number]> = [];
  const views = adminViews({
    storage,
    ownerOf: async (k) => (k === AGENT ? ({ account: OWNER_ACCOUNT } as never) : null),
    mailboxes: {
      pending: async () => 2,
      countSince: async () => 1,
      discard: async (a, since) => { discards.push([a, since]); return 1; },
    },
  });
  const ask = (method: string, path: string, body: Record<string, unknown> | null = null) => {
    const url = new URL(`http://core${path}`);
    return views.handle({ method, path: url.pathname, query: url.searchParams, body, caller: "t" });
  };
  return { ask, stores, destroyed, discards };
}

describe("the core's operator views", () => {
  it("lists rooms with the account they count against and their record's size", async () => {
    const { ask } = world();
    const r = await ask("GET", "/admin/v1/rooms");
    const rooms = (r!.body as { rooms: Array<{ room_id: string; account: string | null; record: unknown }> }).rooms;
    expect(rooms.find((x) => x.room_id === "room1")).toMatchObject({ account: OWNER_ACCOUNT, record: { messages: 4, bytes: 400, last_at: "2026-10-12T09:30:00Z" } });
    expect(rooms.find((x) => x.room_id === "room2")).toMatchObject({ account: "acct-2", record: null });
  });

  it("reclaims a room: its record stream and its meta", async () => {
    const { ask, stores, destroyed } = world();
    expect((await ask("DELETE", "/admin/v1/rooms/room1"))!.body).toMatchObject({ stream_removed: true, meta_removed: true });
    expect(destroyed).toEqual(["rooms_room1"]);
    expect(stores.mesh_rooms!.has("room1")).toBe(false);
    expect((await ask("DELETE", "/admin/v1/rooms/not a room"))!.status).toBe(400);
  });

  it("lists files and board items, lease expiry applied, by room when asked", async () => {
    const { ask } = world();
    expect((await ask("GET", "/admin/v1/files"))!.body).toEqual({ files: [{ id: "f1", record: { owner: AGENT, size: 12, name: "a.txt" } }] });
    const items = ((await ask("GET", "/admin/v1/boards?room=room1"))!.body as { items: Array<{ key: string; item: { state: string; lease_lapsed?: boolean } }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.item).toMatchObject({ state: "open", lease_lapsed: true });
  });

  it("lists task records written after a time, and answers one", async () => {
    const { ask } = world();
    const all = (await ask("GET", "/admin/v1/tasks"))!.body as { tasks: Array<{ task_id: string }>; total: number };
    expect(all.tasks.map((t) => t.task_id).sort()).toEqual(["t-new", "t-old"]);
    const since = (await ask("GET", "/admin/v1/tasks?updated_after=2026-10-12T10:00:00.000Z"))!.body as { tasks: Array<{ task_id: string; written_at: string }> };
    expect(since.tasks).toEqual([{ task_id: "t-new", written_at: "2026-10-12T11:00:00.000Z", record: { id: "t-new", state: "working" } }]);
    expect((await ask("GET", "/admin/v1/tasks/t-old"))!.body).toMatchObject({ task_id: "t-old", record: { state: "completed" } });
    expect((await ask("GET", "/admin/v1/tasks/nobody"))!.status).toBe(404);
    expect((await ask("GET", "/admin/v1/tasks?updated_after=yesterday"))!.status).toBe(400);
  });

  it("answers mailboxes: the list, one, its senders without payloads, arrivals and discard", async () => {
    const { ask, discards } = world();
    expect((await ask("GET", "/admin/v1/mailboxes"))!.body).toEqual({ mailboxes: [{ agent: AGENT, messages: 2, first_seq: 3, last_seq: 5 }] });
    expect((await ask("GET", `/admin/v1/mailboxes/${AGENT}`))!.body).toEqual({ agent: AGENT, pending: 2, last_arrival: "2026-10-12T10:05:00Z" });
    const senders = await ask("GET", `/admin/v1/mailboxes/${AGENT}/senders?from=3&to=5`);
    expect(senders!.body).toEqual({ agent: AGENT, headers: [{ seq: 3, from: "UREG", ts: "2026-10-12T10:00:00Z" }, { seq: 5, from: "UFRIEND", ts: "2026-10-12T10:05:00Z" }] });
    expect(JSON.stringify(senders!.body)).not.toContain("never shown");
    expect((await ask("GET", `/admin/v1/mailboxes/${AGENT}/senders?from=1&to=600`))!.status).toBe(400);
    expect((await ask("GET", `/admin/v1/mailboxes/${AGENT}/arrivals?since=2026-10-12T10:00:00Z`))!.body).toEqual({ agent: AGENT, count: 1 });
    expect((await ask("POST", `/admin/v1/mailboxes/${AGENT}/discard`, { since: "2026-10-12T10:00:00Z" }))!.body).toEqual({ agent: AGENT, discarded: 1 });
    expect(discards).toEqual([[AGENT, Date.parse("2026-10-12T10:00:00Z")]]);
    expect((await ask("GET", "/admin/v1/mailboxes/nobody"))!.status).toBe(400);
  });

  it("is not a route for anything else", async () => {
    const { ask } = world();
    expect(await ask("GET", "/admin/v1/elsewhere")).toBeNull();
    expect(await ask("POST", "/admin/v1/rooms")).toBeNull();
  });
});
