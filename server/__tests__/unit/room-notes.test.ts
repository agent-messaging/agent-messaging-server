/**
 * Notes on a file (EXT-5 §8.4).
 *
 * A room multiplies work that only needs doing once: ten members each screening
 * the same attachment is ten paid reads of one document, and none of them can
 * see the others' answer. A note is one member's short, attributed statement
 * about exactly those bytes, left where the rest can see it.
 *
 * The properties pinned here are the ones whose failure would be QUIET —
 *
 *  - an append that overwrites means the second screener's verdict silently
 *    erases the first, and the room believes the wrong one;
 *  - `by` taken from the payload rather than the envelope means anybody who can
 *    reach the subject can put a "pass" on a hostile file over a name the room
 *    trusts, which is the entire attack this feature would otherwise create;
 *  - a membership check on one verb but not the other means an expelled member
 *    keeps reading the room's screening history, or writing into it;
 *  - an uncapped note is a way to grow a room's storage without bound through a
 *    verb nobody thinks of as a write.
 *
 * The service half is driven through the real handlers with real signed
 * envelopes and a real (signed) descriptor, because the whole of `by` is the
 * signature and a hand-rolled shortcut would test the shortcut.
 */
import { describe, it, expect } from "vitest";
import { RoomsService } from "../../src/rooms/rooms-service.js";
import { NoteStore, NOTES_BUCKET, normalizeDigest, type RoomNote } from "../../src/rooms/note-store.js";
import { createEnvelope, signEnvelope, nkeys } from "../../src/sdk.js";
import type { Envelope, RoomDescriptor } from "../../src/sdk.js";
import { signDescriptor } from "../../../sdk-typescript/src/rooms.js";
import { fakeJs, memKv } from "../helpers/fake-kv.js";

const ROOM = "room-notes-fixture-1";
const DIGEST = `sha256:${"ab".repeat(32)}`;
const OTHER_DIGEST = `sha256:${"cd".repeat(32)}`;
const SCREENER = "USCREENERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const READER = "UREADERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const THIRD = "UTHIRDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function storeFixture(cfg?: Parameters<typeof NoteStore.forTest>[2]) {
  const h = fakeJs();
  const m = memKv(NOTES_BUCKET, h);
  return { store: NoteStore.forTest(h.js as never, m.kv as never, cfg), m };
}

// ── the store ─────────────────────────────────────────────────────────

describe("appending notes", () => {
  it("keeps every member's note on one digest — none overwrites another", async () => {
    const { store } = storeFixture();
    await store.add(ROOM, DIGEST, SCREENER, { verdict: "flag", reason: "instruction-shaped text on page 4" });
    await store.add(ROOM, DIGEST, READER, { verdict: "pass", reason: "read it, it is a quote" });
    const notes = await store.forDigest(ROOM, DIGEST);
    expect(notes.map((n) => [n.by, n.verdict])).toEqual([
      [SCREENER, "flag"],
      [READER, "pass"],
    ]);
  });

  it("keeps both when two members note the same file at the same moment", async () => {
    // The revision race, which for a claim means one winner and for a note must
    // mean two survivors: the loser re-reads and appends rather than refusing.
    const { store } = storeFixture();
    await Promise.all([
      store.add(ROOM, DIGEST, SCREENER, { verdict: "pass" }),
      store.add(ROOM, DIGEST, READER, { verdict: "hold" }),
    ]);
    const notes = await store.forDigest(ROOM, DIGEST);
    expect(notes).toHaveLength(2);
    expect(new Set(notes.map((n) => n.by))).toEqual(new Set([SCREENER, READER]));
  });

  it("records the verdict, the reason, the author, and the claimed source", async () => {
    const { store } = storeFixture();
    const r = await store.add(ROOM, DIGEST, SCREENER, {
      verdict: "pass",
      reason: "  No instruction-shaped content found.  ",
      source: { id: "model-armor", policy: "proj_7d2f", version: "2026-08-01" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.note).toMatchObject({
      note: "screening/v1",
      digest: DIGEST,
      verdict: "pass",
      reason: "No instruction-shaped content found.",
      by: SCREENER,
      source: { id: "model-armor", policy: "proj_7d2f", version: "2026-08-01" },
    });
    expect(Date.parse(r.value.note.at)).toBeGreaterThan(0);
  });

  it("lets a member replace its OWN note, and nobody else's", async () => {
    // A re-screen under a newer policy is the ordinary case, and it is why the
    // per-digest cap counts authors: one member cannot fill a file's slots.
    const { store } = storeFixture();
    await store.add(ROOM, DIGEST, SCREENER, { verdict: "hold", reason: "waiting on the policy bump" });
    await store.add(ROOM, DIGEST, READER, { verdict: "flag" });
    const again = await store.add(ROOM, DIGEST, SCREENER, { verdict: "pass", reason: "cleared under 2026-08-01" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.replaced).toBe(true);

    const notes = await store.forDigest(ROOM, DIGEST);
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.by === SCREENER)?.verdict).toBe("pass");
    expect(notes.find((n) => n.by === READER)?.verdict).toBe("flag");
  });
});

describe("what a note may say", () => {
  it("refuses a verdict outside pass | flag | hold", async () => {
    const { store } = storeFixture();
    for (const verdict of ["approved", "PASS", "", 1, undefined]) {
      const r = await store.add(ROOM, DIGEST, SCREENER, { verdict });
      expect(r.ok, `verdict ${JSON.stringify(verdict)} must be refused`).toBe(false);
      if (r.ok) continue;
      expect(r.code).toBe("INVALID_ENVELOPE");
      expect(r.message).toContain("pass, flag, hold");
    }
    expect(await store.forDigest(ROOM, DIGEST)).toEqual([]);
  });

  it("refuses a digest that is not the shape the drive uses", async () => {
    const { store } = storeFixture();
    for (const digest of ["report.pdf", "sha256:nothex", `sha1:${"ab".repeat(20)}`, "ab".repeat(32), 7, null]) {
      const r = await store.add(ROOM, digest, SCREENER, { verdict: "pass" });
      expect(r.ok, `digest ${JSON.stringify(digest)} must be refused`).toBe(false);
      if (r.ok) continue;
      expect(r.code).toBe("INVALID_ENVELOPE");
    }
  });

  it("matches a digest exactly, case-folded to the drive's own lowercase", async () => {
    const { store } = storeFixture();
    const r = await store.add(ROOM, DIGEST.toUpperCase().replace("SHA256", "sha256"), SCREENER, { verdict: "pass" });
    expect(r.ok).toBe(true);
    expect((await store.forDigest(ROOM, DIGEST)).map((n) => n.by)).toEqual([SCREENER]);
    // A different digest is a different file — the note does not follow it.
    expect(await store.forDigest(ROOM, OTHER_DIGEST)).toEqual([]);
  });

  it("caps the reason and the source fields", async () => {
    const { store } = storeFixture({ maxReasonChars: 20 });
    const long = await store.add(ROOM, DIGEST, SCREENER, { verdict: "flag", reason: "x".repeat(21) });
    expect(long.ok).toBe(false);
    if (long.ok) return;
    expect(long.code).toBe("INVALID_ENVELOPE");
    expect(long.message).toContain("20 characters");

    const source = await store.add(ROOM, DIGEST, SCREENER, { verdict: "flag", source: { id: "y".repeat(200) } });
    expect(source.ok).toBe(false);
  });
});

describe("caps", () => {
  it("refuses past the per-digest cap and drops nothing to make room", async () => {
    const { store } = storeFixture({ maxNotesPerDigest: 2 });
    await store.add(ROOM, DIGEST, SCREENER, { verdict: "pass" });
    await store.add(ROOM, DIGEST, READER, { verdict: "flag" });
    const third = await store.add(ROOM, DIGEST, THIRD, { verdict: "hold" });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.code).toBe("QUOTA_EXCEEDED");
    expect(third.message).toContain("append-only");

    const notes = await store.forDigest(ROOM, DIGEST);
    expect(notes.map((n) => n.by)).toEqual([SCREENER, READER]);

    // A member already on the file can still say something new: a replacement
    // adds no row, so the cap does not turn into a lock.
    const again = await store.add(ROOM, DIGEST, SCREENER, { verdict: "hold" });
    expect(again.ok).toBe(true);
  });

  it("refuses past the per-room cap, counted across every noted file", async () => {
    const { store } = storeFixture({ maxNotesPerRoom: 2 });
    expect((await store.add(ROOM, DIGEST, SCREENER, { verdict: "pass" })).ok).toBe(true);
    expect((await store.add(ROOM, OTHER_DIGEST, SCREENER, { verdict: "pass" })).ok).toBe(true);
    const over = await store.add(ROOM, DIGEST, READER, { verdict: "flag" });
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.code).toBe("QUOTA_EXCEEDED");
    expect(over.message).toContain("across its files");

    // Another room is unaffected: the cap is per room, like the drive's.
    expect((await store.add("other-room", DIGEST, READER, { verdict: "flag" })).ok).toBe(true);
  });
});

describe("reading and purging", () => {
  it("answers a file nobody noted with an empty list, not an error", async () => {
    const { store } = storeFixture();
    expect(await store.forDigest(ROOM, DIGEST)).toEqual([]);
    expect(await store.listRoom(ROOM)).toEqual([]);
  });

  it("lists one room's noted files only", async () => {
    const { store } = storeFixture();
    await store.add(ROOM, DIGEST, SCREENER, { verdict: "pass" }, 1_000);
    await store.add(ROOM, OTHER_DIGEST, READER, { verdict: "flag" }, 2_000);
    await store.add("other-room", DIGEST, THIRD, { verdict: "hold" }, 1_500);

    const files = await store.listRoom(ROOM);
    expect(files.map((f) => f.digest)).toEqual([DIGEST, OTHER_DIGEST]);
    expect(await store.countRoom(ROOM)).toBe(2);
  });

  it("takes a room's notes with the room and leaves other rooms alone", async () => {
    const { store } = storeFixture();
    await store.add(ROOM, DIGEST, SCREENER, { verdict: "pass" });
    await store.add(ROOM, DIGEST, READER, { verdict: "flag" });
    await store.add("other-room", DIGEST, THIRD, { verdict: "hold" });
    expect(await store.purgeRoom(ROOM)).toBe(2);
    expect(await store.listRoom(ROOM)).toEqual([]);
    expect(await store.countRoom("other-room")).toBe(1);
  });
});

describe("normalizeDigest", () => {
  it("accepts only sha256:<64 hex> and lowercases it", () => {
    expect(normalizeDigest(` SHA256:${"AB".repeat(32)} `)).toBe(DIGEST);
    expect(normalizeDigest(`sha256:${"ab".repeat(31)}`)).toBeNull();
    expect(normalizeDigest("sha256:")).toBeNull();
    expect(normalizeDigest(undefined)).toBeNull();
  });
});

// ── the service: mesh.rooms.note / mesh.rooms.notes ──────────────────

const creatorKp = nkeys.createUser();
const memberKp = nkeys.createUser();
const strangerKp = nkeys.createUser();
const serviceKp = nkeys.createUser();

/** An acl room, so membership is a list the service holds rather than
 *  possession of the descriptor — which is the only grade at which "a
 *  non-member" is a thing the service can recognise (EXT-5 §6, §8.2). */
function aclDescriptor(): RoomDescriptor {
  return signDescriptor(
    {
      rooms: "v1",
      room_id: "Rm0Notes0Fixture0Aa",
      name: "screening room",
      channels: ["main"],
      record: "mesh:rooms:Rm0Notes0Fixture0Aa",
      policy: {},
      privacy: "acl",
      creator: creatorKp.getPublicKey(),
      created_at: new Date(0).toISOString(),
    },
    creatorKp as never,
  );
}

interface NoteHandlers {
  handleNote(env: Envelope): Promise<Envelope>;
  handleNotes(env: Envelope): Promise<Envelope>;
}

/**
 * The rooms service with the two note handlers reachable, and nothing else
 * stood up: the handlers touch `admit` (a real descriptor check against a real
 * room record), the note store, and the reply builders.
 */
function serviceFixture() {
  const descriptor = aclDescriptor();
  const h = fakeJs();
  const m = memKv(NOTES_BUCKET, h);
  const notes = NoteStore.forTest(h.js as never, m.kv as never);
  const meta = {
    descriptor,
    operator: "someone@example.com",
    created_at: new Date(0).toISOString(),
    drive_bytes: 12,
    artifacts: [
      {
        ref: `mesh:rooms:${descriptor.room_id}/drive/abc`,
        name: "terms.pdf",
        version: "1",
        digest: DIGEST,
        media_type: "application/pdf",
        size: 12,
        attached_by: creatorKp.getPublicKey(),
        attached_at: new Date(0).toISOString(),
        origin: null,
        external: null,
      },
      {
        ref: `mesh:rooms:${descriptor.room_id}/drive/def`,
        name: "minutes.txt",
        version: "1",
        digest: OTHER_DIGEST,
        media_type: "text/plain",
        size: 9,
        attached_by: creatorKp.getPublicKey(),
        attached_at: new Date(0).toISOString(),
        origin: null,
        external: null,
      },
    ],
    acl_members: [creatorKp.getPublicKey(), memberKp.getPublicKey()],
  };
  const svc = Object.create(RoomsService.prototype) as NoteHandlers;
  Object.assign(svc, { kp: serviceKp, notes, rooms: new Map([[descriptor.room_id, meta]]) });
  return { svc, descriptor, notes, meta };
}

/** A signed request envelope, the way both SDKs send one (`serviceRequest`). */
function signed(kp: ReturnType<typeof nkeys.createUser>, payload: unknown): Envelope {
  return signEnvelope(
    createEnvelope({ type: "request", from: kp.getPublicKey(), payload }),
    kp as never,
  );
}

describe("mesh.rooms.note / mesh.rooms.notes", () => {
  it("a member writes and another member reads it back", async () => {
    const { svc, descriptor } = serviceFixture();
    const wrote = await svc.handleNote(
      signed(memberKp, {
        descriptor,
        digest: DIGEST,
        verdict: "flag",
        reason: "instruction-shaped text on page 4",
        source: { id: "model-armor" },
      }),
    );
    expect(wrote.error).toBeUndefined();
    expect(wrote.payload).toMatchObject({ noted: true, digest: DIGEST, notes_on_file: 1, replaced: false });

    const read = await svc.handleNotes(signed(creatorKp, { descriptor, digest: DIGEST }));
    expect(read.error).toBeUndefined();
    const { notes } = read.payload as { notes: RoomNote[] };
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      by: memberKp.getPublicKey(),
      verdict: "flag",
      reason: "instruction-shaped text on page 4",
      digest: DIGEST,
    });
  });

  it("attributes the note to the SIGNER, never to a `by` in the payload", async () => {
    // The whole value of a note is who signed it. A caller that could name
    // somebody else could put a "pass" on a hostile file over a trusted name.
    const { svc, descriptor } = serviceFixture();
    await svc.handleNote(
      signed(memberKp, {
        descriptor,
        digest: DIGEST,
        verdict: "pass",
        by: creatorKp.getPublicKey(),
        note: { by: creatorKp.getPublicKey(), verdict: "pass" },
      }),
    );
    const read = await svc.handleNotes(signed(memberKp, { descriptor, digest: DIGEST }));
    const { notes } = read.payload as { notes: RoomNote[] };
    expect(notes).toHaveLength(1);
    expect(notes[0].by).toBe(memberKp.getPublicKey());
    expect(notes[0].by).not.toBe(creatorKp.getPublicKey());
  });

  it("refuses an unsigned note — an unsigned one attributes to nobody", async () => {
    const { svc, descriptor } = serviceFixture();
    const unsigned = createEnvelope({
      type: "request",
      from: memberKp.getPublicKey(),
      payload: { descriptor, digest: DIGEST, verdict: "pass" },
    });
    const resp = await svc.handleNote(unsigned);
    expect(resp.error?.code).toBe("UNAUTHORIZED");
    const read = await svc.handleNotes(signed(memberKp, { descriptor, digest: DIGEST }));
    expect((read.payload as { notes: RoomNote[] }).notes).toEqual([]);
  });

  it("refuses a NON-MEMBER on both verbs", async () => {
    // §8.2: membership is checked service-side, every time. A stranger holding
    // the descriptor is still a stranger at the acl grade — and the read matters
    // as much as the write, because the notes are the room's screening history.
    const { svc, descriptor } = serviceFixture();
    await svc.handleNote(signed(memberKp, { descriptor, digest: DIGEST, verdict: "pass" }));

    const write = await svc.handleNote(signed(strangerKp, { descriptor, digest: DIGEST, verdict: "pass" }));
    expect(write.error?.code).toBe("NOT_FOUND");
    const read = await svc.handleNotes(signed(strangerKp, { descriptor, digest: DIGEST }));
    expect(read.error?.code).toBe("NOT_FOUND");
    expect(read.payload).toBeUndefined();

    // …and the member's note is untouched by either attempt.
    const mine = await svc.handleNotes(signed(memberKp, { descriptor, digest: DIGEST }));
    expect((mine.payload as { notes: RoomNote[] }).notes).toHaveLength(1);
  });

  it("refuses a bad verdict, a malformed digest, and an over-cap write", async () => {
    const { svc, descriptor, notes } = serviceFixture();
    const bad = await svc.handleNote(signed(memberKp, { descriptor, digest: DIGEST, verdict: "approved" }));
    expect(bad.error?.code).toBe("INVALID_ENVELOPE");

    const malformed = await svc.handleNote(signed(memberKp, { descriptor, digest: "terms.pdf", verdict: "pass" }));
    expect(malformed.error?.code).toBe("INVALID_ENVELOPE");
    expect(malformed.error?.message).toContain("sha256:");

    // Fill the file to its cap with other members' notes, then try to add one.
    const store = notes as unknown as { cfg: { maxNotesPerDigest: number } };
    const cap = store.cfg.maxNotesPerDigest;
    for (let i = 0; i < cap; i++) {
      const r = await notes.add(descriptor.room_id, DIGEST, `Ufiller${i}`.padEnd(56, "A"), { verdict: "pass" });
      expect(r.ok).toBe(true);
    }
    const over = await svc.handleNote(signed(memberKp, { descriptor, digest: DIGEST, verdict: "pass" }));
    expect(over.error?.code).toBe("QUOTA_EXCEEDED");
    expect(over.error?.message).toContain(String(cap));
  });

  it("refuses a note about bytes that are not on this room's drive", async () => {
    const { svc, descriptor } = serviceFixture();
    const resp = await svc.handleNote(
      signed(memberKp, { descriptor, digest: `sha256:${"ef".repeat(32)}`, verdict: "pass" }),
    );
    expect(resp.error?.code).toBe("NOT_FOUND");
    expect(resp.error?.message).toContain("drive");
  });

  it("answers a file nobody noted with an empty list rather than an error", async () => {
    const { svc, descriptor } = serviceFixture();
    const resp = await svc.handleNotes(signed(memberKp, { descriptor, digest: OTHER_DIGEST }));
    expect(resp.error).toBeUndefined();
    expect(resp.payload).toEqual({ digest: OTHER_DIGEST, notes: [] });
  });

  it("reads every noted file on the drive when no digest is given", async () => {
    const { svc, descriptor } = serviceFixture();
    await svc.handleNote(signed(memberKp, { descriptor, digest: DIGEST, verdict: "flag" }));
    await svc.handleNote(signed(creatorKp, { descriptor, digest: DIGEST, verdict: "hold" }));
    await svc.handleNote(signed(memberKp, { descriptor, digest: OTHER_DIGEST, verdict: "pass" }));

    const resp = await svc.handleNotes(signed(creatorKp, { descriptor }));
    const { files, notes } = resp.payload as {
      files: { digest: string; notes: RoomNote[] }[];
      notes: RoomNote[];
    };
    expect(files.map((f) => [f.digest, f.notes.length])).toEqual([
      [DIGEST, 2],
      [OTHER_DIGEST, 1],
    ]);
    // The flat form holds exactly the same notes: a client that asked for all of
    // them and a client that asked file by file must not see different rooms.
    expect(notes).toHaveLength(3);
    expect(notes).toEqual(files.flatMap((f) => f.notes));
  });

  it("leaves the room record and the drive exactly as they were", async () => {
    // Additive, never a substitute (§8.4): a note adds a row beside a file. If
    // this ever starts touching the artifact list or the room meta, a note has
    // become an edit to the room and the record no longer says what happened.
    const { svc, descriptor, meta } = serviceFixture();
    const before = JSON.stringify(meta);
    await svc.handleNote(signed(memberKp, { descriptor, digest: DIGEST, verdict: "hold", reason: "checking" }));
    expect(JSON.stringify(meta)).toBe(before);
  });
});
