/**
 * The work board's one load-bearing property is mutual exclusion: exactly one
 * member wins a claim, and a claim that goes quiet returns to the board. Every
 * failure these tests pin would be a QUIET one in production —
 *
 *  - two claimants both told they won ships two agents doing the same work;
 *  - a lapsed lease that nobody can re-claim makes a crashed worker permanent;
 *  - a withdraw racing a claim, resolved wrongly, rips work out from under the
 *    member who won it;
 *  - a poster cap counting finished items refuses new work on an idle board.
 *
 * The lease doctrine under test is the tree's (shared/scheduler.ts, KvLease):
 * expiry lives in the value and is derived on read; the atomic unit is a
 * revision-checked update, never read-then-put.
 */
import { describe, it, expect } from "vitest";
import { BoardStore, MAX_ARTIFACT_REF_CHARS, viewItem, type BoardItem } from "../../src/rooms/board-store.js";
import { fakeJs, memKv } from "../helpers/fake-kv.js";

const ROOM = "room-1";
const POSTER = "UPOSTERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WORKER_A = "UWORKERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WORKER_B = "UWORKERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function boardFixture(cfg?: Parameters<typeof BoardStore.forTest>[2]) {
  const h = fakeJs();
  const m = memKv("mesh_board_items", h);
  const store = BoardStore.forTest(h.js as never, m.kv as never, cfg);
  return { store, m };
}

async function postOne(store: BoardStore, title = "summarise the minutes"): Promise<BoardItem> {
  const r = await store.post(ROOM, POSTER, { title });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

describe("posting", () => {
  it("stores the item open, with the poster and a bounded lease", async () => {
    const { store } = boardFixture();
    const r = await store.post(ROOM, POSTER, { title: "  summarise the minutes  ", lease_ms: 5_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("open");
    expect(r.value.title).toBe("summarise the minutes");
    expect(r.value.posted_by).toBe(POSTER);
    // 5s asked, 60s floor: a lease shorter than a slow network round trip
    // would expire mid-claim.
    expect(r.value.lease_ms).toBe(60_000);
  });

  it("refuses an item with no title — a board of unlabeled work helps nobody", async () => {
    const { store } = boardFixture();
    const r = await store.post(ROOM, POSTER, { title: "   " });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_ENVELOPE");
  });

  it("caps OPEN items only — finished work does not block new work", async () => {
    const { store } = boardFixture({ maxOpenPerRoom: 2 });
    const a = await postOne(store, "one");
    await postOne(store, "two");
    const refused = await store.post(ROOM, POSTER, { title: "three" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("QUOTA_EXCEEDED");

    // Complete one; the board has room again.
    const c = await store.claim(ROOM, a.item_id, WORKER_A);
    expect(c.ok).toBe(true);
    await store.complete(ROOM, a.item_id, WORKER_A);
    const again = await store.post(ROOM, POSTER, { title: "three" });
    expect(again.ok).toBe(true);
  });
});

describe("claiming", () => {
  it("gives a contested item to exactly one of two claimants", async () => {
    const { store } = boardFixture();
    const item = await postOne(store);
    const [a, b] = await Promise.all([
      store.claim(ROOM, item.item_id, WORKER_A),
      store.claim(ROOM, item.item_id, WORKER_B),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok);
    if (!loser || loser.ok) return;
    expect(loser.code).toBe("BOARD_ITEM_TAKEN");
  });

  it("tells a late claimant who holds the item and until when", async () => {
    const { store } = boardFixture();
    const item = await postOne(store);
    await store.claim(ROOM, item.item_id, WORKER_A);
    const late = await store.claim(ROOM, item.item_id, WORKER_B);
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.code).toBe("BOARD_ITEM_TAKEN");
    expect(late.message).toContain(WORKER_A.slice(0, 12));
  });

  it("mints a fresh task id on every claim — the prior claimer may still hold the old one", async () => {
    const { store } = boardFixture();
    const item = await postOne(store);
    const t0 = Date.now();
    const first = await store.claim(ROOM, item.item_id, WORKER_A, 60_000, t0);
    if (!first.ok) throw new Error("first claim should win");
    const taskA = first.value.task_id;
    expect(taskA).toBeTruthy();

    // Lease lapses; B takes over.
    const past = t0 + 61_000;
    const second = await store.claim(ROOM, item.item_id, WORKER_B, undefined, past);
    if (!second.ok) throw new Error("takeover of a lapsed claim should win");
    expect(second.value.task_id).toBeTruthy();
    expect(second.value.task_id).not.toBe(taskA);
  });

  it("lets a lapsed claim be taken over, and records how the old one ended", async () => {
    const { store } = boardFixture();
    const item = await postOne(store);
    const t0 = Date.now();
    await store.claim(ROOM, item.item_id, WORKER_A, 60_000, t0);

    // Before expiry: refused. After: claimable, with the expiry on the record.
    const early = await store.claim(ROOM, item.item_id, WORKER_B, undefined, t0 + 30_000);
    expect(early.ok).toBe(false);
    const takeover = await store.claim(ROOM, item.item_id, WORKER_B, undefined, t0 + 61_000);
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) return;
    expect(takeover.value.claimed_by).toBe(WORKER_B);
    expect(takeover.value.claims).toEqual([
      expect.objectContaining({ by: WORKER_A, outcome: "expired" }),
    ]);
  });

  it("presents a lapsed claim as open on read without rewriting storage", async () => {
    const { store, m } = boardFixture();
    const item = await postOne(store);
    const t0 = Date.now();
    await store.claim(ROOM, item.item_id, WORKER_A, 60_000, t0);

    const listed = await store.list(ROOM, t0 + 61_000);
    expect(listed[0]!.state).toBe("open");
    expect(listed[0]!.lease_lapsed).toBe(true);
    // Storage still says claimed — the next WRITER resolves it. A read that
    // rewrites is a read that races.
    const stored = JSON.parse(new TextDecoder().decode(m.store.get(`${ROOM}.${item.item_id}`)!.value)) as BoardItem;
    expect(stored.state).toBe("claimed");
  });
});

describe("completing and abandoning", () => {
  it("lets only the current claimer complete, and keeps the note and refs", async () => {
    const { store } = boardFixture();
    const item = await postOne(store);
    await store.claim(ROOM, item.item_id, WORKER_A);

    const stranger = await store.complete(ROOM, item.item_id, WORKER_B);
    expect(stranger.ok).toBe(false);
    if (stranger.ok) return;
    expect(stranger.code).toBe("IDENTITY_MISMATCH");

    const done = await store.complete(ROOM, item.item_id, WORKER_A, {
      note: "minutes summarised",
      artifacts: ["mesh:rooms:room-1/drive/abc"],
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.state).toBe("done");
    expect(done.value.result_note).toBe("minutes summarised");
    expect(done.value.artifacts).toEqual(["mesh:rooms:room-1/drive/abc"]);
    expect(done.value.claims?.at(-1)).toEqual(expect.objectContaining({ by: WORKER_A, outcome: "done" }));
  });

  it("keeps a long ref whole, and refuses one over the limit instead of dropping it", async () => {
    // Debt 360: a ref over the old 300 characters was dropped from the item
    // while the answer said done. A signed address is longer than that.
    const { store } = boardFixture();
    const item = await postOne(store);
    await store.claim(ROOM, item.item_id, WORKER_A);
    const signed = `https://storage.example/bucket/report.pdf?X-Sig=${"a".repeat(900)}`;
    const tooLong = `https://storage.example/${"b".repeat(MAX_ARTIFACT_REF_CHARS)}`;

    const refused = await store.complete(ROOM, item.item_id, WORKER_A, { artifacts: ["mesh:rooms:room-1/drive/abc", tooLong] });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("INVALID_ENVELOPE");
    expect(refused.message).toContain(`at most ${MAX_ARTIFACT_REF_CHARS}`);
    expect(refused.message).toContain("artifact ref 2");
    expect((await store.list(ROOM))[0].state).toBe("claimed");

    const notRef = await store.complete(ROOM, item.item_id, WORKER_A, { artifacts: [42] });
    expect(notRef.ok).toBe(false);

    const done = await store.complete(ROOM, item.item_id, WORKER_A, { artifacts: [signed] });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.artifacts).toEqual([signed]);
  });

  it("accepts a completion after the lease lapsed, so long as nobody re-claimed", async () => {
    // The task manager's stance on late completions (§7.7): accepted and
    // recorded, never discarded — work that finished is work that finished.
    const { store } = boardFixture();
    const item = await postOne(store);
    const t0 = Date.now();
    await store.claim(ROOM, item.item_id, WORKER_A, 60_000, t0);
    const late = await store.complete(ROOM, item.item_id, WORKER_A, {}, t0 + 120_000);
    expect(late.ok).toBe(true);
  });

  it("returns an abandoned item to the board with its history intact", async () => {
    const { store } = boardFixture();
    const item = await postOne(store);
    await store.claim(ROOM, item.item_id, WORKER_A);
    const back = await store.abandon(ROOM, item.item_id, WORKER_A);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.state).toBe("open");
    expect(back.value.claimed_by).toBeUndefined();
    expect(back.value.task_id).toBeUndefined();
    expect(back.value.claims).toEqual([expect.objectContaining({ by: WORKER_A, outcome: "abandoned" })]);

    const reclaimed = await store.claim(ROOM, item.item_id, WORKER_B);
    expect(reclaimed.ok).toBe(true);
  });
});

describe("withdrawing", () => {
  it("lets the poster take an unclaimed item down, and nobody else", async () => {
    const { store } = boardFixture();
    const item = await postOne(store);
    const stranger = await store.withdraw(ROOM, item.item_id, WORKER_A);
    expect(stranger.ok).toBe(false);
    if (stranger.ok) return;
    expect(stranger.code).toBe("IDENTITY_MISMATCH");

    const gone = await store.withdraw(ROOM, item.item_id, POSTER);
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    expect(gone.value.state).toBe("withdrawn");
  });

  it("refuses to pull a live claim out from under its worker", async () => {
    const { store } = boardFixture();
    const item = await postOne(store);
    await store.claim(ROOM, item.item_id, WORKER_A);
    const r = await store.withdraw(ROOM, item.item_id, POSTER);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("BOARD_ITEM_TAKEN");
    expect(r.message).toContain("lease");
  });
});

describe("listing and purging", () => {
  it("lists one room's items only, oldest first", async () => {
    const { store } = boardFixture();
    const r1 = await store.post(ROOM, POSTER, { title: "first" }, 1_000);
    const r2 = await store.post(ROOM, POSTER, { title: "second" }, 2_000);
    await store.post("room-2", POSTER, { title: "other room" }, 1_500);
    expect(r1.ok && r2.ok).toBe(true);

    const items = await store.list(ROOM);
    expect(items.map((i) => i.title)).toEqual(["first", "second"]);
  });

  it("summarises boards per room with derived states", async () => {
    const { store } = boardFixture();
    const t0 = Date.now();
    const a = await store.post(ROOM, POSTER, { title: "a" }, t0);
    await store.post(ROOM, POSTER, { title: "b" }, t0);
    if (!a.ok) return;
    await store.claim(ROOM, a.value.item_id, WORKER_A, 60_000, t0);

    const now = await store.summary(t0 + 1_000);
    expect(now.get(ROOM)).toEqual({ open: 1, claimed: 1, done: 0, withdrawn: 0 });
    // After the lease lapses the same storage summarises as two open.
    const later = await store.summary(t0 + 61_000);
    expect(later.get(ROOM)).toEqual({ open: 2, claimed: 0, done: 0, withdrawn: 0 });
  });

  it("purges a room's items and leaves other boards alone", async () => {
    const { store } = boardFixture();
    await postOne(store, "goes");
    await postOne(store, "goes too");
    await store.post("room-2", POSTER, { title: "stays" });
    const purged = await store.purgeRoom(ROOM);
    expect(purged).toBe(2);
    expect(await store.list(ROOM)).toHaveLength(0);
    expect(await store.list("room-2")).toHaveLength(1);
  });
});

describe("viewItem", () => {
  it("only rewrites the presented state, never the source object", () => {
    const item: BoardItem = {
      item_id: "i",
      room_id: ROOM,
      title: "t",
      posted_by: POSTER,
      posted_at: new Date(0).toISOString(),
      lease_ms: 60_000,
      state: "claimed",
      claimed_by: WORKER_A,
      claimed_at: new Date(0).toISOString(),
      lease_expires_at: new Date(60_000).toISOString(),
    };
    const v = viewItem(item, 120_000);
    expect(v.state).toBe("open");
    expect(v.lease_lapsed).toBe(true);
    expect(item.state).toBe("claimed");
  });
});
