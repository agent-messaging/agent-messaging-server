import { describe, it, expect } from "vitest";
import { nkeys } from "nats.ws";
import type { Subscription } from "nats.ws";
import {
  Room,
  RoomsServiceSubjects,
  BoardSubjects,
  ROOM_DESCRIPTOR_SIG_PREFIX,
  signDescriptor,
  verifyDescriptor,
  descriptorToToken,
  descriptorFromToken,
  ROOM_NOTE_VERDICTS,
  type BoardItem,
  type RoomDescriptor,
  type RoomHost,
  type RoomMessage,
  type RoomNote,
} from "../../src/rooms.js";
import { MeshError, ErrorCode } from "../../src/types/errors.js";
import { canonicalJSON, toB64Url, fromB64Url } from "../../src/internal/identity.js";
import type { Envelope } from "../../src/types/envelope.js";
import { decode } from "../../src/internal/codec.js";

function makeDescriptor(kp = nkeys.createUser()): RoomDescriptor {
  return signDescriptor(
    {
      rooms: "v1",
      room_id: "test-room-0123456789abcdef",
      name: "test",
      channels: ["main"],
      record: "ephemeral",
      policy: {},
      privacy: "capability",
      creator: kp.getPublicKey(),
      created_at: new Date().toISOString(),
    },
    kp,
  );
}

/** An in-memory bus standing in for the transport: every host publishes into
 *  it and every subscription with a matching room pattern hears it. */
function makeBus() {
  const subs: Array<{ pattern: string; cb: (env: Envelope) => void }> = [];
  const matches = (pattern: string, subject: string) => {
    const p = pattern.split(".");
    const s = subject.split(".");
    if (p.length !== s.length) return false;
    return p.every((part, i) => part === "*" || part === s[i]);
  };
  const makeHost = (kp = nkeys.createUser()): RoomHost => ({
    agentId: kp.getPublicKey(),
    keyPair: kp,
    publish(subject, data) {
      // Like the real transport: deliver bytes; each receiver decodes (which
      // verifies the signature) and drops failures. Snapshot the list so a
      // handler unsubscribing mid-delivery doesn't skip other receivers.
      for (const s of [...subs]) {
        if (!matches(s.pattern, subject)) continue;
        try {
          s.cb(decode(data));
        } catch {
          // dropped, as on the wire
        }
      }
    },
    subscribe(subject, onEnvelope) {
      const entry = { pattern: subject, cb: onEnvelope };
      subs.push(entry);
      return {
        unsubscribe() {
          const i = subs.indexOf(entry);
          if (i >= 0) subs.splice(i, 1);
        },
      } as unknown as Subscription;
    },
    request: async () => ({}),
    serviceRequest: async () => ({}),
    getEncryptionKey: async () => null,
  });
  return { makeHost };
}

describe("room descriptor", () => {
  it("signs and verifies", () => {
    const d = makeDescriptor();
    expect(verifyDescriptor(d)).toBe(true);
  });

  it("rejects tampering", () => {
    const d = makeDescriptor();
    expect(verifyDescriptor({ ...d, name: "renamed" })).toBe(false);
    expect(verifyDescriptor({ ...d, creator: nkeys.createUser().getPublicKey() })).toBe(false);
  });

  it("round-trips through the token form", () => {
    const d = makeDescriptor();
    const back = descriptorFromToken(descriptorToToken(d));
    expect(back).toEqual(d);
    expect(verifyDescriptor(back)).toBe(true);
  });

  it("signs the tagged form: sig covers ROOM_DESCRIPTOR_SIG_PREFIX + canonical JSON (EXT-5 §2)", () => {
    expect(ROOM_DESCRIPTOR_SIG_PREFIX).toBe("agentmesh-room-descriptor-v1\n");
    const kp = nkeys.createUser();
    const d = makeDescriptor(kp);
    const { sig, ...rest } = d;
    const enc = new TextEncoder();
    // The signature covers prefix + canonical, never the bare form.
    expect(kp.verify(enc.encode(ROOM_DESCRIPTOR_SIG_PREFIX + canonicalJSON(rest)), fromB64Url(sig))).toBe(true);
    expect(kp.verify(enc.encode(canonicalJSON(rest)), fromB64Url(sig))).toBe(false);
  });

  it("refuses a legacy untagged descriptor (the 0.2 dual-accept closed at 0.3)", () => {
    const kp = nkeys.createUser();
    const d = makeDescriptor(kp);
    const { sig: _drop, ...rest } = d;
    const legacy = { ...d, sig: toB64Url(kp.sign(new TextEncoder().encode(canonicalJSON(rest)))) };
    expect(verifyDescriptor(legacy)).toBe(false);
  });
});

describe("ephemeral room", () => {
  it("delivers says between members and tracks the roster", () => {
    const { makeHost } = makeBus();
    const alice = makeHost();
    const bob = makeHost();

    const room = Room.open(alice, { name: "standup" });
    const seenByAlice: RoomMessage[] = [];
    room.onMessage((m) => seenByAlice.push(m));

    const bobsRoom = Room.join(bob, room.token, { handle: "bob.test" });
    const seenByBob: Array<{ msg: RoomMessage; from: string }> = [];
    bobsRoom.onMessage((m, env) => seenByBob.push({ msg: m, from: env.from }));

    room.say("hello bob");
    bobsRoom.say("hello alice");

    // Alice saw bob's join and his say; bob saw alice's say (not his own).
    expect(seenByAlice.map((m) => m.type)).toEqual(["join", "say"]);
    expect(seenByBob.map((e) => e.msg.type)).toEqual(["say"]);
    expect(seenByBob[0]!.from).toBe(alice.agentId);
    expect(new Set(room.members)).toEqual(new Set([alice.agentId, bob.agentId]));

    bobsRoom.leave();
    expect(room.members).toEqual([alice.agentId]);
  });

  it("drops unsigned and forged traffic", () => {
    const { makeHost } = makeBus();
    const alice = makeHost();
    const room = Room.open(alice, { includeSelf: false });
    const seen: RoomMessage[] = [];
    room.onMessage((m) => seen.push(m));

    // A forger publishes a say claiming to be from a member, with a bad sig.
    const forger = makeHost();
    forger.publish(
      `mesh.event.room.${room.id}.main`,
      new TextEncoder().encode(
        JSON.stringify({
          v: "0.2",
          id: "forged",
          type: "emit",
          ts: new Date().toISOString(),
          from: alice.agentId,
          trace: { trace_id: "0".repeat(32), span_id: "0".repeat(16) },
          context_id: room.id,
          payload: { type: "say", channel: "main", in_reply_to: null, body: "forged" },
          sig: "AAAA",
        }),
      ),
    );
    expect(seen).toEqual([]);
  });

  it("expel folds the member out and the expelled member detaches", () => {
    const { makeHost } = makeBus();
    const alice = makeHost();
    const bob = makeHost();
    const carol = makeHost();
    const room = Room.open(alice);
    const bobsRoom = Room.join(bob, room.token);
    const carolsRoom = Room.join(carol, room.token);

    // Only the creator can expel; a member's attempt fails fast locally.
    expect(() => bobsRoom.expel(carol.agentId, { severity: "conduct" })).toThrow(/creator/);

    const seenByBob: RoomMessage[] = [];
    bobsRoom.onMessage((m) => seenByBob.push(m));

    room.expel(bob.agentId, { severity: "timeout", note: "cool off" });

    // Bob heard the expel (severity and note intact) before detaching.
    expect(seenByBob).toEqual([
      { type: "expel", member: bob.agentId, severity: "timeout", note: "cool off" },
    ]);
    expect(bobsRoom.closed).toBe(true);

    // Every remaining view folded bob out, exactly like a leave.
    expect(new Set(room.members)).toEqual(new Set([alice.agentId, carol.agentId]));
    expect(new Set(carolsRoom.members)).toEqual(new Set([alice.agentId, carol.agentId]));
    expect(carolsRoom.closed).toBe(false);
  });

  it("normalizes an unknown expel severity to conduct on receipt", () => {
    const { makeHost } = makeBus();
    const alice = makeHost();
    const bob = makeHost();
    const room = Room.open(alice);
    const bobsRoom = Room.join(bob, room.token);
    const seenByBob: RoomMessage[] = [];
    bobsRoom.onMessage((m) => seenByBob.push(m));

    // A future/unknown severity arrives over the wire (bypass the typed API).
    room.expel(bob.agentId, { severity: "banished" as never });

    expect(seenByBob).toEqual([
      { type: "expel", member: bob.agentId, severity: "conduct" },
    ]);
    expect(bobsRoom.closed).toBe(true);
  });

  it("expel on an acl room also asks the service to revoke the credential", async () => {
    const { makeHost } = makeBus();
    const alice = makeHost();
    // Record every service call; the credential response shape is what
    // openAclTransport consumes.
    const calls: Array<{ subject: string; payload: unknown }> = [];
    alice.serviceRequest = async (subject, payload) => {
      calls.push({ subject, payload });
      return subject === RoomsServiceSubjects.CREDENTIAL ? { jwt: "jwt", seed: "seed" } : {};
    };
    // The acl second connection, backed by the same in-memory bus.
    alice.openAclTransport = async () => ({
      publish: (s, d) => alice.publish(s, d),
      subscribe: (s, cb) => alice.subscribe(s, cb),
      close: async () => {},
    });

    const room = await Room.openAcl(alice, { name: "gated", includeSelf: true });
    const seen: RoomMessage[] = [];
    room.onMessage((m) => seen.push(m));
    const bob = nkeys.createUser().getPublicKey();

    await room.expel(bob, { severity: "conduct", note: "rules" });

    // The control message posted AND the service was told to revoke (§8.1).
    expect(seen).toEqual([
      { type: "expel", member: bob, severity: "conduct", note: "rules" },
    ]);
    const expelCall = calls.find((c) => c.subject === RoomsServiceSubjects.EXPEL);
    expect(expelCall?.payload).toEqual({
      descriptor: room.descriptor,
      member: bob,
      severity: "conduct",
    });
  });

  it("a service error does not stop the acl expel control message", async () => {
    const { makeHost } = makeBus();
    const alice = makeHost();
    alice.serviceRequest = async (subject) => {
      if (subject === RoomsServiceSubjects.EXPEL) throw new Error("service down");
      return subject === RoomsServiceSubjects.CREDENTIAL ? { jwt: "jwt", seed: "seed" } : {};
    };
    alice.openAclTransport = async () => ({
      publish: (s, d) => alice.publish(s, d),
      subscribe: (s, cb) => alice.subscribe(s, cb),
      close: async () => {},
    });

    const room = await Room.openAcl(alice, { includeSelf: true });
    const seen: RoomMessage[] = [];
    room.onMessage((m) => seen.push(m));
    const bob = nkeys.createUser().getPublicKey();

    // The service error propagates (like invite's admit), but the expel had
    // already posted — best-effort ordering, message first.
    await expect(room.expel(bob, { severity: "safety" })).rejects.toThrow(/service down/);
    expect(seen).toEqual([{ type: "expel", member: bob, severity: "safety" }]);
  });

  it("only the creator can close; members detach on close", () => {
    const { makeHost } = makeBus();
    const alice = makeHost();
    const bob = makeHost();
    const room = Room.open(alice);
    const bobsRoom = Room.join(bob, room.token);

    expect(() => bobsRoom.close()).toThrow(/creator/);
    room.close("done");
    expect(bobsRoom.closed).toBe(true);
    expect(() => bobsRoom.say("too late")).toThrow(/closed/);
  });
});

describe("the work board (EXT-5 §10)", () => {
  /** A durable room whose host records every service call and answers each
   *  board verb with a canned reply, the way the rooms service shapes them:
   *  `{item}` for the writes, `{items, open, claimed, done}` for list. */
  async function makeBoardRoom(replies?: Partial<Record<string, unknown>>) {
    const { makeHost } = makeBus();
    const host = makeHost();
    const calls: Array<{ subject: string; payload: Record<string, unknown> }> = [];
    const item = (over?: Partial<BoardItem>): BoardItem => ({
      item_id: "item-1",
      room_id: "r",
      title: "summarize the meeting",
      posted_by: host.agentId,
      posted_at: new Date().toISOString(),
      lease_ms: 3_600_000,
      state: "open",
      ...over,
    });
    host.serviceRequest = async (subject, payload) => {
      calls.push({ subject, payload: payload as Record<string, unknown> });
      if (subject === RoomsServiceSubjects.PROVISION) return {};
      if (replies && subject in replies) {
        const r = replies[subject];
        if (r instanceof Error) throw r;
        return r;
      }
      if (subject === BoardSubjects.LIST) {
        return { items: [item()], open: 1, claimed: 0, done: 0 };
      }
      return { item: item() };
    };
    const room = await Room.openDurable(host);
    return { room, host, calls, item };
  }

  it("each verb goes to its mesh.board subject with the descriptor riding along", async () => {
    const { room, calls } = await makeBoardRoom();

    await room.postWork({ title: "summarize", detail: "the whole meeting", offering: "summarizer", lease_ms: 60_000 });
    await room.boardItems();
    await room.claimWork("item-1", 120_000);
    await room.completeWork("item-1", { note: "done", artifacts: ["mesh:rooms:r/drive/a"] });
    await room.abandonWork("item-1");
    await room.withdrawWork("item-1");

    const board = calls.filter((c) => c.subject.startsWith("mesh.board."));
    expect(board.map((c) => c.subject)).toEqual([
      BoardSubjects.POST,
      BoardSubjects.LIST,
      BoardSubjects.CLAIM,
      BoardSubjects.COMPLETE,
      BoardSubjects.ABANDON,
      BoardSubjects.WITHDRAW,
    ]);
    // Membership is decided from the presented descriptor (same as
    // status/cursor), so EVERY verb must carry it.
    for (const c of board) {
      expect(c.payload.descriptor).toEqual(room.descriptor);
    }
    expect(board[0]!.payload).toMatchObject({
      title: "summarize",
      detail: "the whole meeting",
      offering: "summarizer",
      lease_ms: 60_000,
    });
    expect(board[2]!.payload).toMatchObject({ item_id: "item-1", lease_ms: 120_000 });
    expect(board[3]!.payload).toMatchObject({
      item_id: "item-1",
      note: "done",
      artifacts: ["mesh:rooms:r/drive/a"],
    });
    expect(board[4]!.payload).toMatchObject({ item_id: "item-1" });
    expect(board[5]!.payload).toMatchObject({ item_id: "item-1" });
  });

  it("a post carries the item's fields only: a `from` or `posted_by` passed in never rides (debt 359)", async () => {
    const { room, calls } = await makeBoardRoom();
    const other = nkeys.createUser().getPublicKey();
    await room.postWork({ title: "summarize", from: other, posted_by: other, descriptor: null } as unknown as { title: string });
    const post = calls.find((c) => c.subject === BoardSubjects.POST)!;
    expect(Object.keys(post.payload).sort()).toEqual(["descriptor", "detail", "lease_ms", "offering", "title"]);
    expect(post.payload.descriptor).toEqual(room.descriptor);
  });

  it("claim hands back the item with its minted task_id (§10.2)", async () => {
    const claimedItem: BoardItem = {
      item_id: "item-1",
      room_id: "r",
      title: "summarize the meeting",
      posted_by: "UPOSTER",
      posted_at: new Date().toISOString(),
      lease_ms: 60_000,
      state: "claimed",
      claimed_by: "UWORKER",
      claimed_at: new Date().toISOString(),
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      task_id: "task-abc",
    };
    const { room } = await makeBoardRoom({
      [BoardSubjects.CLAIM]: { item: claimedItem },
    });
    const claimed = await room.claimWork("item-1");
    expect(claimed.state).toBe("claimed");
    // The graft: the claimer opens the real Task under this id, naming the
    // poster as requester — the board never opens it.
    expect(claimed.task_id).toBe("task-abc");
  });

  it("a losing claimant's BOARD_ITEM_TAKEN refusal stays distinguishable", async () => {
    const { room } = await makeBoardRoom({
      [BoardSubjects.CLAIM]: new MeshError(
        ErrorCode.BOARD_ITEM_TAKEN,
        "this item cannot be claimed — it is claimed by UWORKER until later",
      ),
    });
    const err = await room.claimWork("item-1").catch((e) => e);
    expect(err).toBeInstanceOf(MeshError);
    expect((err as MeshError).code).toBe(ErrorCode.BOARD_ITEM_TAKEN);
    expect((err as MeshError).retryable).toBe(false);
  });

  it("board list returns items with the per-state counts", async () => {
    const { room } = await makeBoardRoom();
    const list = await room.boardItems();
    expect(list.items).toHaveLength(1);
    expect(list.open).toBe(1);
    expect(list.claimed).toBe(0);
    expect(list.done).toBe(0);
  });

  it("an ephemeral room refuses board verbs before any service call", async () => {
    const { makeHost } = makeBus();
    const alice = makeHost();
    let called = false;
    alice.serviceRequest = async () => {
      called = true;
      return {};
    };
    const room = Room.open(alice);
    await expect(room.postWork({ title: "x" })).rejects.toThrow(/ephemeral/);
    await expect(room.boardItems()).rejects.toThrow(/ephemeral/);
    expect(called).toBe(false);
  });
});

describe("notes on a file (EXT-5 §8.4)", () => {
  const DIGEST = "sha256:1a2b3c4d5e6f";

  /** A note as the service stores it: the caller's fields plus the `by` and
   *  `at` only the service may set. */
  const stored = (over?: Partial<RoomNote>): RoomNote => ({
    note: "screening/v1",
    digest: DIGEST,
    verdict: "pass",
    by: "UAUTHOR",
    at: "2026-08-13T14:10:00Z",
    ...over,
  });

  /** A durable room whose host records every service call and answers the two
   *  note verbs the way the rooms service shapes them: `{note}` for the write,
   *  `{notes}` for the read. */
  async function makeNotedRoom(replies?: Partial<Record<string, unknown>>) {
    const { makeHost } = makeBus();
    const host = makeHost();
    const calls: Array<{ subject: string; payload: Record<string, unknown> }> = [];
    host.serviceRequest = async (subject, payload) => {
      calls.push({ subject, payload: payload as Record<string, unknown> });
      if (subject === RoomsServiceSubjects.PROVISION) return {};
      if (replies && subject in replies) {
        const r = replies[subject];
        if (r instanceof Error) throw r;
        return r;
      }
      if (subject === RoomsServiceSubjects.NOTES) return { notes: [stored({ by: host.agentId })] };
      return { note: stored({ by: host.agentId }) };
    };
    const room = await Room.openDurable(host);
    return { room, host, calls };
  }

  it("writes to mesh.rooms.note with the digest, the verdict and the source", async () => {
    const { room, calls } = await makeNotedRoom();

    await room.note(DIGEST, "flag", {
      reason: "Instruction-shaped content in the footer.",
      source: { id: "model-armor", policy: "proj_7d2f", version: "2026-08-01" },
    });

    const write = calls.find((c) => c.subject === RoomsServiceSubjects.NOTE);
    expect(write?.subject).toBe("mesh.rooms.note");
    expect(write?.payload).toMatchObject({
      descriptor: room.descriptor,
      digest: DIGEST,
      verdict: "flag",
      reason: "Instruction-shaped content in the footer.",
      source: { id: "model-armor", policy: "proj_7d2f", version: "2026-08-01" },
    });
  });

  it("never sends `by`: authorship is the service's to set from the envelope", async () => {
    const { room, calls } = await makeNotedRoom();
    await room.note(DIGEST, "pass");
    const write = calls.find((c) => c.subject === RoomsServiceSubjects.NOTE)!;
    // The bug §8.4 warns about: a client that names the author is claiming an
    // authorship it cannot prove. The service takes both from the verified
    // envelope and its own clock.
    expect(write.payload).not.toHaveProperty("by");
    expect(write.payload).not.toHaveProperty("at");
  });

  it("keeps the verdict closed — a free string never reaches the wire", async () => {
    const { room, calls } = await makeNotedRoom();
    expect(ROOM_NOTE_VERDICTS).toEqual(["pass", "flag", "hold"]);
    for (const v of ROOM_NOTE_VERDICTS) {
      await expect(room.note(DIGEST, v)).resolves.toBeTruthy();
    }
    // The type stops a TypeScript caller; this is the JavaScript one it cannot
    // reach. Rejected locally, so nothing is written.
    await expect(room.note(DIGEST, "looks-fine" as never)).rejects.toThrow(/pass, flag, hold/);
    // A note with no digest is a note about nothing — refused the same way.
    await expect(room.note("", "pass")).rejects.toThrow(/digest/);
    expect(calls.filter((c) => c.subject === RoomsServiceSubjects.NOTE)).toHaveLength(3);
  });

  it("parses the stored note back, author and source intact", async () => {
    const { room, host } = await makeNotedRoom();
    const written = await room.note(DIGEST, "pass");
    expect(written.note).toBe("screening/v1");
    expect(written.digest).toBe(DIGEST);
    expect(written.verdict).toBe("pass");
    // Implementations MUST expose the author (§8.4).
    expect(written.by).toBe(host.agentId);
    expect(written.at).toBe("2026-08-13T14:10:00Z");
  });

  it("reads one digest's notes, or every noted digest when none is given", async () => {
    const { room, calls } = await makeNotedRoom({
      [RoomsServiceSubjects.NOTES]: {
        notes: [
          stored({ verdict: "pass", by: "UONE" }),
          stored({ digest: "sha256:ffff", verdict: "hold", by: "UTWO", reason: "unreadable" }),
        ],
      },
    });

    const forOne = await room.notes(DIGEST);
    const all = await room.notes();

    const reads = calls.filter((c) => c.subject === RoomsServiceSubjects.NOTES);
    expect(reads[0]!.payload).toEqual({ descriptor: room.descriptor, digest: DIGEST });
    // Omitting the digest asks for the whole room — omitted, not null.
    expect(reads[1]!.payload).toEqual({ descriptor: room.descriptor });
    expect(reads[1]!.payload).not.toHaveProperty("digest");

    // Two members disagreeing about the same bytes both survive, each with its
    // own author — notes are never merged into one answer.
    expect(all).toHaveLength(2);
    expect(all.map((n) => [n.by, n.verdict])).toEqual([
      ["UONE", "pass"],
      ["UTWO", "hold"],
    ]);
    expect(forOne).toHaveLength(2);
  });

  it("a room with no notes reads as an empty list, not a failure", async () => {
    const { room } = await makeNotedRoom({ [RoomsServiceSubjects.NOTES]: {} });
    await expect(room.notes()).resolves.toEqual([]);
  });

  it("adds a row beside the file and posts nothing into the record", async () => {
    const { makeHost } = makeBus();
    const host = makeHost();
    host.serviceRequest = async (subject) =>
      subject === RoomsServiceSubjects.NOTES ? { notes: [] } : { note: {} };
    const room = await Room.openDurable(host, { includeSelf: true });
    const seen: RoomMessage[] = [];
    room.onMessage((m) => seen.push(m));

    await room.note(DIGEST, "hold", { reason: "could not read it" });
    await room.notes();

    // A note edits, hides and replaces nothing, and the room's record is
    // unchanged by it — so no room message is posted at all (§8.4).
    expect(seen).toEqual([]);
  });

  it("an ephemeral room refuses both verbs before any service call", async () => {
    const { makeHost } = makeBus();
    const alice = makeHost();
    let called = false;
    alice.serviceRequest = async () => {
      called = true;
      return {};
    };
    // Notes live on the drive, and only a durable room has one.
    const room = Room.open(alice);
    await expect(room.note(DIGEST, "pass")).rejects.toThrow(/ephemeral/);
    await expect(room.notes()).rejects.toThrow(/ephemeral/);
    expect(called).toBe(false);
  });
});
