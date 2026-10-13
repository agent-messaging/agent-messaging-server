/**
 * mesh.board: a durable room's work board on the SDK door
 * (platform-services/board.json; docs/platform-services-plan.md).
 *
 * The names, the fields, the answers and the refusals are the definition's,
 * through the generated `BoardRequests` interface and refusal types, so this
 * file cannot add a field or a refusal the definition does not have. The
 * work is done on the live rooms the rooms door holds (rooms-door.ts), with
 * the Room's own board methods (postWork, claimWork and the rest), which
 * stay on Room unchanged.
 */
import type { RoomsDoor } from "./rooms-door.js";
import type { BoardItem } from "./rooms.js";
import {
  ServiceRefusal,
  type BoardRequests,
  type BoardListInput, type BoardListResult, type BoardListRefusal,
  type BoardPostInput, type BoardPostResult, type BoardPostRefusal,
  type BoardClaimInput, type BoardClaimResult, type BoardClaimRefusal,
  type BoardDoneInput, type BoardDoneResult, type BoardDoneRefusal,
  type BoardAbandonInput, type BoardAbandonResult, type BoardAbandonRefusal,
  type BoardWithdrawInput, type BoardWithdrawResult, type BoardWithdrawRefusal,
} from "./services.generated.js";

type Refuse<C extends string> = (code: C, words?: string) => never;
function refusal<C extends string>(request: string): Refuse<C> {
  return (code, words) => {
    throw new ServiceRefusal(`board.${request}`, code, words ?? code);
  };
}

type Item = BoardPostResult["item"];

/** A board item as the definition carries it. */
function itemOut(i: BoardItem): Item {
  return {
    item_id: i.item_id, room_id: i.room_id, title: i.title,
    ...(i.detail ? { detail: i.detail } : {}),
    ...(i.offering ? { offering: i.offering } : {}),
    posted_by: i.posted_by, posted_at: i.posted_at, lease_ms: i.lease_ms, state: i.state,
    ...(i.claimed_by ? { claimed_by: i.claimed_by } : {}),
    ...(i.claimed_at ? { claimed_at: i.claimed_at } : {}),
    ...(i.lease_expires_at ? { lease_expires_at: i.lease_expires_at } : {}),
    ...(i.task_id ? { task_id: i.task_id } : {}),
    ...(i.done_at ? { done_at: i.done_at } : {}),
    ...(i.result_note ? { result_note: i.result_note } : {}),
    ...(i.artifacts?.length ? { artifacts: i.artifacts } : {}),
    ...(i.claims?.length ? { claims: i.claims.map((c) => ({ by: c.by, at: c.at, outcome: c.outcome as "expired" | "abandoned" | "done" })) } : {}),
    ...(i.lease_lapsed ? { lease_lapsed: true } : {}),
  };
}

/** The rooms service's board codes as the definition's refusals. A code this
 *  request does not name is not renamed: it is thrown as it came. */
const CODES: Record<string, string> = {
  BOARD_ITEM_TAKEN: "TAKEN",
  IDENTITY_MISMATCH: "NOT_YOURS",
  NOT_FOUND: "NOT_FOUND",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  INVALID_ENVELOPE: "INPUT_INVALID",
};
async function asked<C extends string, T>(no: Refuse<C>, named: readonly string[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const code = CODES[String((e as { code?: unknown })?.code ?? "")];
    if (code && named.includes(code)) return no(code as C, e instanceof Error ? e.message : String(e));
    throw e;
  }
}
async function act<C extends string>(no: Refuse<C>, named: readonly string[], fn: () => Promise<BoardItem>): Promise<{ item: Item }> {
  return { item: itemOut(await asked(no, named, fn)) };
}

export class BoardDoor implements BoardRequests {
  constructor(private readonly rooms: RoomsDoor) {}

  async list(input: BoardListInput): Promise<BoardListResult> {
    const no = refusal<BoardListRefusal>("list");
    const room = await this.rooms.roomOf(no, input.room);
    if (!room.durable) return no("NOT_DURABLE", "That room is not durable, so it has no work board.");
    const b = await asked(no, ["NOT_YOURS"], () => room.boardItems());
    return { room_id: room.id, items: b.items.map(itemOut), open: b.open, claimed: b.claimed, done: b.done };
  }

  async post(input: BoardPostInput): Promise<BoardPostResult> {
    const no = refusal<BoardPostRefusal>("post");
    const room = await this.rooms.roomOf(no, input.room);
    if (!room.durable) return no("NOT_DURABLE", "That room is not durable, so it has no work board.");
    return act(no, ["QUOTA_EXCEEDED", "INPUT_INVALID", "NOT_NAMED", "NOT_YOURS"], () =>
      room.postWork({ title: input.title, detail: input.detail, offering: input.offering, lease_ms: input.lease_ms }));
  }

  async claim(input: BoardClaimInput): Promise<BoardClaimResult> {
    const no = refusal<BoardClaimRefusal>("claim");
    const room = await this.rooms.roomOf(no, input.room);
    if (!room.durable) return no("NOT_DURABLE", "That room is not durable, so it has no work board.");
    return act(no, ["NOT_FOUND", "TAKEN", "INPUT_INVALID", "NOT_YOURS"], () => room.claimWork(input.item_id, input.lease_ms));
  }

  async done(input: BoardDoneInput): Promise<BoardDoneResult> {
    const no = refusal<BoardDoneRefusal>("done");
    const room = await this.rooms.roomOf(no, input.room);
    if (!room.durable) return no("NOT_DURABLE", "That room is not durable, so it has no work board.");
    return act(no, ["NOT_FOUND", "NOT_YOURS", "TAKEN", "INPUT_INVALID"], () =>
      room.completeWork(input.item_id, { note: input.note, artifacts: input.artifacts }));
  }

  async abandon(input: BoardAbandonInput): Promise<BoardAbandonResult> {
    const no = refusal<BoardAbandonRefusal>("abandon");
    const room = await this.rooms.roomOf(no, input.room);
    if (!room.durable) return no("NOT_DURABLE", "That room is not durable, so it has no work board.");
    return act(no, ["NOT_FOUND", "NOT_YOURS", "TAKEN"], () => room.abandonWork(input.item_id));
  }

  async withdraw(input: BoardWithdrawInput): Promise<BoardWithdrawResult> {
    const no = refusal<BoardWithdrawRefusal>("withdraw");
    const room = await this.rooms.roomOf(no, input.room);
    if (!room.durable) return no("NOT_DURABLE", "That room is not durable, so it has no work board.");
    return act(no, ["NOT_FOUND", "NOT_YOURS", "TAKEN"], () => room.withdrawWork(input.item_id));
  }
}
