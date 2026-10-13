// mesh.rooms (platform-services/rooms.json): the rooms requests on the SDK
// door, over the live rooms the SDK already holds. What matters is that each
// answer has the definition's fields, each refusal is one of the definition's
// codes, and a room is reached by id or by name. A fake AgentMesh stands in
// for the connection; the Room is a fake with the members the door touches.
import { describe, it, expect } from "vitest";
import { RoomsDoor, ROOM_FILE_MAX_BYTES, ROOM_POST_MAX_CHARS } from "../../src/rooms-door.js";
import { ServiceRefusal, SDK_REQUESTS } from "../../src/services.generated.js";
import type { AgentMesh } from "../../src/mesh.js";

interface FakeRoom {
  id: string;
  descriptor: { name?: string; creator: string; privacy: "capability" | "acl" | "sealed" };
  durable: boolean;
  sealed: boolean;
  acl: boolean;
  token: string;
  members: string[];
  closed: boolean;
  phase: { pattern: string; note?: string; by: string | null } | null;
  said: string[];
  brief(): string;
  say(text: string): void;
  callPhase(pattern: string): void;
  fullHistory(): Promise<unknown[]>;
  files(): Promise<unknown[]>;
  attach(name: string, bytes: Uint8Array): Promise<{ ref: string; digest: string; size: number }>;
  invite(to: string): Promise<unknown>;
}

function fakeRoom(over: Partial<FakeRoom> = {}): FakeRoom {
  const room: FakeRoom = {
    id: "room-1",
    descriptor: { name: "launch", creator: "UME", privacy: "capability" },
    durable: true,
    sealed: false,
    acl: false,
    token: "token-1",
    members: ["UME"],
    closed: false,
    phase: { pattern: "critique-circle", by: null },
    said: [],
    brief: () => "This room runs as a critique circle.",
    say(text) { room.said.push(text); },
    callPhase(pattern) { if (pattern === "refuse") throw new Error("only the room's facilitator may call a phase"); room.phase = { pattern, by: "UME" }; },
    fullHistory: async () => [
      { seq: 1, message: { type: "say", body: "hello" }, envelope: { from: "UME", ts: "2026-10-05T18:00:00Z" } },
      { seq: 2, message: { type: "artifact", name: "plan.md", ref: "mesh:rooms:x/drive/plan.md", version: "1", digest: "sha256:aa", size: 3 }, envelope: { from: "UME", ts: "2026-10-05T18:01:00Z" } },
    ],
    files: async () => [],
    attach: async (_name, bytes) => ({ ref: "mesh:rooms:x/drive/f", digest: "sha256:bb", size: bytes.length }),
    invite: async () => ({ ok: true }),
    ...over,
  };
  return room;
}

function fakeMesh(rooms: FakeRoom[] = [], mine: unknown[] = []): { mesh: AgentMesh; opened: unknown[] } {
  const opened: unknown[] = [];
  const mesh = {
    id: "UME",
    openRoom: (opts: Record<string, unknown>) => {
      opened.push(opts);
      const r = fakeRoom({ id: `room-${opened.length + 1}`, descriptor: { name: opts.name as string, creator: "UME", privacy: opts.acl ? "acl" : "capability" }, durable: !!(opts.durable || opts.acl), acl: !!opts.acl });
      rooms.push(r);
      return opts.durable || opts.acl ? Promise.resolve(r) : r;
    },
    joinRoom: async () => rooms[0],
    myRooms: async () => mine,
  } as unknown as AgentMesh;
  return { mesh, opened };
}

async function refusalOf(p: Promise<unknown>): Promise<ServiceRefusal> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceRefusal);
    return e as ServiceRefusal;
  }
  throw new Error("expected a refusal");
}

describe("mesh.rooms", () => {
  it("carries every rooms request its definition puts on the SDK", () => {
    const door = new RoomsDoor(fakeMesh().mesh) as unknown as Record<string, unknown>;
    for (const r of SDK_REQUESTS.filter((x) => x.service === "rooms")) expect(typeof door[r.request]).toBe("function");
  });

  it("opens a room and answers with the definition's fields and the live room", async () => {
    const { mesh, opened } = fakeMesh();
    const out = await new RoomsDoor(mesh).open({ name: "launch", durable: true, playbook: "critique-circle" });
    expect(opened[0]).toMatchObject({ name: "launch", durable: true, playbook: { pattern: "critique-circle" } });
    expect(out).toMatchObject({ room_id: "room-2", name: "launch", durable: true, sealed: false, acl: false, token: "token-1", phase: { pattern: "critique-circle" }, brief: "This room runs as a critique circle." });
    expect(out.room).toBeDefined();
  });

  it("refuses a room that is both sealed and keeps a member list", async () => {
    const e = await refusalOf(new RoomsDoor(fakeMesh().mesh).open({ sealed: true, acl: true }));
    expect(e.code).toBe("INPUT_INVALID");
  });

  it("reaches a room it opened by its name, and refuses one it is not in", async () => {
    const { mesh } = fakeMesh();
    const door = new RoomsDoor(mesh);
    const opened = await door.open({ name: "launch", durable: true });
    expect(await door.post({ room: "launch", text: "kickoff" })).toEqual({ room_id: opened.room_id });
    const e = await refusalOf(door.post({ room: "elsewhere", text: "hi" }));
    expect(e.code).toBe("NOT_IN_ROOM");
    expect(e.request).toBe("rooms.post");
  });

  it("joins a room the rooms service lists for this agent on first use", async () => {
    const r = fakeRoom({ id: "room-acl", descriptor: { name: "board", creator: "UOTHER", privacy: "acl" } });
    const { mesh } = fakeMesh([r], [{ room_id: "room-acl", name: "board", descriptor: r.descriptor, privacy: "acl", role: "member", last_seq: 5, cursor: 2, created_at: "" }]);
    const door = new RoomsDoor(mesh);
    await door.post({ room: "board", text: "hi" });
    expect(r.said).toEqual(["hi"]);
    const listed = await door.list();
    expect(listed.complete).toBe(false);
    expect(listed.rooms[0]).toMatchObject({ room_id: "room-acl", name: "board", role: "member", privacy: "acl", unread: 3 });
  });

  it("replays a durable room's record in the definition's fields, and refuses a room that keeps none", async () => {
    const { mesh } = fakeMesh();
    const door = new RoomsDoor(mesh);
    await door.open({ name: "launch", durable: true });
    const h = await door.history({ room: "launch" });
    expect(h.entries[0]).toEqual({ seq: 1, from: "UME", at: "2026-10-05T18:00:00Z", type: "say", body: "hello" });
    expect(h.entries[1]).toMatchObject({ type: "artifact", name: "plan.md", digest: "sha256:aa", size: 3 });
    await door.open({ name: "chat" });
    const rooms = (door as unknown as { held: Map<string, FakeRoom> }).held;
    for (const r of rooms.values()) if (r.descriptor.name === "chat") r.durable = false;
    expect((await refusalOf(door.history({ room: "chat" }))).code).toBe("NOT_DURABLE");
  });

  it("refuses a file over the drive's limit before sending it", async () => {
    const { mesh } = fakeMesh();
    const door = new RoomsDoor(mesh);
    await door.open({ name: "launch", durable: true });
    const e = await refusalOf(door.attach({ room: "launch", name: "big.txt", content: "x".repeat(ROOM_FILE_MAX_BYTES + 1) }));
    expect(e.code).toBe("TOO_BIG");
    expect(await door.attach({ room: "launch", name: "small.txt", content: "abc" })).toEqual({ ref: "mesh:rooms:x/drive/f", digest: "sha256:bb", size: 3 });
  });

  it("refuses a message over a room's limit before sending it", async () => {
    const { mesh } = fakeMesh();
    const door = new RoomsDoor(mesh);
    await door.open({ name: "launch" });
    const e = await refusalOf(door.post({ room: "launch", text: "x".repeat(ROOM_POST_MAX_CHARS + 1) }));
    expect(e.code).toBe("TOO_BIG");
    expect((await door.post({ room: "launch", text: "x".repeat(ROOM_POST_MAX_CHARS) })).room_id).toBeTruthy();
  });

  it("says when only the facilitator may move a room on", async () => {
    const { mesh } = fakeMesh();
    const door = new RoomsDoor(mesh);
    await door.open({ name: "launch", durable: true });
    expect((await refusalOf(door.phase({ room: "launch", pattern: "refuse" }))).code).toBe("NOT_FACILITATOR");
    expect(await door.phase({ room: "launch", pattern: "relay" })).toMatchObject({ phase: { pattern: "relay", by: "UME" } });
  });

  it("refuses to join from something that is not a token", async () => {
    expect((await refusalOf(new RoomsDoor(fakeMesh().mesh).join({ invite_or_token: "not a token" }))).code).toBe("INPUT_INVALID");
  });
});
