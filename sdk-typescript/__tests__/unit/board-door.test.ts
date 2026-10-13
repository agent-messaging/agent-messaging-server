// mesh.board (platform-services/board.json): a durable room's work board on
// the SDK door, done on the rooms the rooms door holds. Each answer has the
// definition's fields; the rooms service's codes become the definition's
// refusals (a lost claim is TAKEN, not a bare error).
import { describe, it, expect } from "vitest";
import { RoomsDoor } from "../../src/rooms-door.js";
import { BoardDoor } from "../../src/board-door.js";
import { ServiceRefusal, SDK_REQUESTS } from "../../src/services.generated.js";
import { MeshError } from "../../src/types/errors.js";
import type { AgentMesh } from "../../src/mesh.js";

const item = (over: Record<string, unknown> = {}) => ({
  item_id: "itm_1", room_id: "room-1", title: "Check the table", posted_by: "UME", posted_at: "2026-10-05T18:00:00Z",
  lease_ms: 3_600_000, state: "open", ...over,
});

function door(durable = true): BoardDoor {
  const room = {
    id: "room-1", descriptor: { name: "launch", creator: "UME", privacy: "capability" }, durable, closed: false,
    boardItems: async () => ({ items: [item()], open: 1, claimed: 0, done: 0 }),
    postWork: async (i: { title: string }) => item({ title: i.title }),
    claimWork: async (id: string) => {
      if (id === "itm_taken") throw new MeshError("BOARD_ITEM_TAKEN", "item itm_taken is claimed by someone else");
      return item({ item_id: id, state: "claimed", claimed_by: "UME", task_id: "tsk_1", claims: [{ by: "UOLD", at: "2026-10-05T17:00:00Z", outcome: "expired" }] });
    },
    completeWork: async (id: string) => {
      throw new MeshError("IDENTITY_MISMATCH", `only the agent holding ${id}'s claim can finish it`);
    },
    abandonWork: async (id: string) => item({ item_id: id }),
    withdrawWork: async (id: string) => item({ item_id: id, state: "withdrawn" }),
  };
  const mesh = { id: "UME", myRooms: async () => [{ room_id: "room-1", name: "launch", descriptor: room.descriptor }], joinRoom: async () => room } as unknown as AgentMesh;
  return new BoardDoor(new RoomsDoor(mesh));
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

describe("mesh.board", () => {
  it("carries every board request its definition puts on the SDK", () => {
    const d = door() as unknown as Record<string, unknown>;
    for (const r of SDK_REQUESTS.filter((x) => x.service === "board")) expect(typeof d[r.request]).toBe("function");
  });

  it("lists and claims in the definition's fields, reaching the room by its name", async () => {
    const d = door();
    expect(await d.list({ room: "launch" })).toEqual({ room_id: "room-1", items: [item()], open: 1, claimed: 0, done: 0 });
    const c = await d.claim({ room: "launch", item_id: "itm_1" });
    expect(c.item).toMatchObject({ item_id: "itm_1", state: "claimed", claimed_by: "UME", task_id: "tsk_1" });
    expect(c.item.claims).toEqual([{ by: "UOLD", at: "2026-10-05T17:00:00Z", outcome: "expired" }]);
  });

  it("turns the rooms service's codes into the definition's refusals", async () => {
    const d = door();
    expect((await refusalOf(d.claim({ room: "launch", item_id: "itm_taken" }))).code).toBe("TAKEN");
    expect((await refusalOf(d.done({ room: "launch", item_id: "itm_1" }))).code).toBe("NOT_YOURS");
    expect((await refusalOf(d.list({ room: "elsewhere" }))).code).toBe("NOT_IN_ROOM");
    expect((await refusalOf(door(false).post({ room: "launch", title: "x" }))).code).toBe("NOT_DURABLE");
  });

  it("acts only as this agent: a `from` in the input never reaches the room, and a forged envelope is NOT_YOURS on every request (debt 359)", async () => {
    // The rooms service answers IDENTITY_MISMATCH to an envelope whose
    // signature does not verify against the sender it names, and to a done,
    // give-back or withdraw by anyone but the holder or poster.
    const forged = () => { throw new MeshError("IDENTITY_MISMATCH", "Envelope signature does not verify against 'from'"); };
    const seen: unknown[][] = [];
    const room = {
      id: "room-1", descriptor: { name: "launch", creator: "UME", privacy: "capability" }, durable: true, closed: false,
      boardItems: async (...a: unknown[]) => { seen.push(a); return forged(); },
      postWork: async (...a: unknown[]) => { seen.push(a); return forged(); },
      claimWork: async (...a: unknown[]) => { seen.push(a); return forged(); },
      completeWork: async (...a: unknown[]) => { seen.push(a); return forged(); },
      abandonWork: async (...a: unknown[]) => { seen.push(a); return forged(); },
      withdrawWork: async (...a: unknown[]) => { seen.push(a); return forged(); },
    };
    const mesh = { id: "UME", myRooms: async () => [{ room_id: "room-1", name: "launch", descriptor: room.descriptor }], joinRoom: async () => room } as unknown as AgentMesh;
    const d = new BoardDoor(new RoomsDoor(mesh));
    const as = { room: "launch", from: "UOTHER", posted_by: "UOTHER", claimed_by: "UOTHER" } as { room: string };
    const codes = [
      (await refusalOf(d.list(as))).code,
      (await refusalOf(d.post({ ...as, title: "x" }))).code,
      (await refusalOf(d.claim({ ...as, item_id: "itm_1" }))).code,
      (await refusalOf(d.done({ ...as, item_id: "itm_1" }))).code,
      (await refusalOf(d.abandon({ ...as, item_id: "itm_1" }))).code,
      (await refusalOf(d.withdraw({ ...as, item_id: "itm_1" }))).code,
    ];
    expect(codes).toEqual(Array(6).fill("NOT_YOURS"));
    expect(JSON.stringify(seen)).not.toContain("UOTHER");
  });
});
