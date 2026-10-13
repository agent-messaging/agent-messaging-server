import { describe, it, expect, afterAll } from "vitest";
import { jwtAuthenticator } from "nats.ws";
import { AgentMesh, type Room, createEncryptionIdentity } from "../../src/index.js";

/**
 * Phase 0 of ROOMS-UI-PLAN.md: prove the parts of rooms that are IMPLEMENTED
 * BUT UNTESTED actually work against a live mesh before two client surfaces get
 * built on them.
 *
 * The twelve unit tests in `__tests__/unit/rooms.test.ts` are all
 * capability-grade and ephemeral. Durable rooms, the acl grade, the artifact
 * drive, replay, and expel-revokes-the-credential had never run end to end. The
 * SDK header even claimed for several releases that the module shipped
 * "fan-out only, no record, no drive" while exporting every durable method.
 *
 * Credentials: each agent takes a GUEST lease, because a standalone agent needs
 * a credential whose own key is the connection identity — which is exactly what
 * the pool hands back ({jwt, seed, publicKey}), and how a browser client works.
 * Node credentials are the wrong shape here: a node-hosted agent has no `servers`
 * of its own, and `openAclTransport` needs to dial a second, room-scoped
 * connection (see docs/implementation-status.md on the same limitation in Rust).
 *
 * Runs only when told to: $ROOMS_TEST_WS (local broker) or $AGENTMESH_LIVE=1. The
 * unit lane cannot reach this file at all — vitest.config.ts scopes that lane to
 * __tests__/unit — so there are two independent reasons it stays out of the fast
 * lane, which is deliberate after it spent a day running there against production.
 */

const API = process.env.AGENTMESH_API ?? "https://api.agentmesh.ai";

/** Local mode: point at an anonymous NATS with a rooms service beside it
 *  (docker nats + `--service=rooms ROOMS_REQUIRE_OPERATOR=0`). Durable rooms,
 *  replay, the drive and the sealed grade all work here. */
const LOCAL_WS = process.env.ROOMS_TEST_WS;

/** The acl grade needs a broker in OPERATOR MODE and a minting key: the service
 *  issues each member a JWT scoped to `mesh.aclroom.<id>.>` and the broker has
 *  to enforce it. An anonymous local NATS cannot, and says so at startup
 *  ("acl disabled (no minting key)"), so those cases only run where that holds. */
/** Point ROOMS_TEST_AGENTS at the `agents.json` written by
 *  server/tools/local-acl-mesh.mjs: a pool of pre-minted user credentials
 *  under that broker's account. Each test agent takes one, so its OWN key is the
 *  connection identity — which is what the rooms service scopes an acl room to.
 *  Pre-minted rather than minted here on purpose: nats-jwt is not an SDK
 *  dependency and should not become one for a test. */
const AGENTS_FILE = process.env.ROOMS_TEST_AGENTS;
const ACL = !!AGENTS_FILE || process.env.ROOMS_TEST_ACL === "1";

let agentPool: { jwt: string; seed: string }[] = [];
let poolNext = 0;

/**
 * Going live is an EXPLICIT choice, never inferred from the environment.
 *
 * This used to include `process.env.CI === "true"`, which read as "run the live
 * tests in CI" but actually meant "run them in every CI job", and the job that ran
 * them was the UNIT one — no broker, no credentials, no live mesh. Nobody saw it
 * because this file landed just after the last green run and every run after that
 * was blocked on GitHub billing, so it was never executed by a working CI at all.
 *
 * Note what setting AGENTMESH_LIVE against the PUBLIC deployment does not get you:
 * six of these ten need durable rooms, durable rooms require the creator to hold a
 * PAN handle, and a guest connection has none — they fail with exactly that message.
 * These cases are for the local rig ($ROOMS_TEST_WS, an anonymous broker with the
 * rooms service beside it and ROOMS_REQUIRE_OPERATOR=0), which is why liveness has
 * to be asked for deliberately and cannot be inferred from an ambient variable.
 */
const LIVE = !!LOCAL_WS || process.env.AGENTMESH_LIVE === "1";

const open: AgentMesh[] = [];
const rooms: Room[] = [];

afterAll(async () => {
  for (const r of rooms) {
    try { r.close(); } catch { /* already closed */ }
  }
  for (const m of open) {
    try { await m.close(); } catch { /* already closed */ }
  }
});

/** A standalone agent on a fresh guest lease, plus an encryption identity so it
 *  can be sealed to (SPEC §4.3). */
async function guestAgent(label: string): Promise<AgentMesh> {
  if (LOCAL_WS) {
    const enc = createEncryptionIdentity();
    let mesh: AgentMesh;
    if (AGENTS_FILE) {
      if (!agentPool.length) {
        const { readFile } = await import("node:fs/promises");
        agentPool = JSON.parse(await readFile(AGENTS_FILE, "utf8"));
      }
      const cred = agentPool[poolNext++];
      if (!cred) throw new Error("ran out of pre-minted agent credentials");
      mesh = await AgentMesh.connect(LOCAL_WS, {
        requireNamed: false, // test agents; the naming rule is on by default since 2026-09-27
        jwt: cred.jwt,
        nkeySeed: cred.seed,
        encryptionSeed: enc.seed,
      });
    } else {
      // Anonymous local broker: AgentMesh.connect mints its own keypair, which
      // is the agent identity. Nothing is enforcing a credential.
      mesh = await AgentMesh.connect(LOCAL_WS, { encryptionSeed: enc.seed, requireNamed: false });
    }
    open.push(mesh);
    // NOT swallowed: a sealed invite resolves the invitee's encryption key from
    // its registered manifest (§8.3), so a failed register surfaces later as a
    // confusing "published no verifiable encryption key" and hides the cause.
    await mesh.register({ name: label, capabilities: [], offerings: [] });
    return mesh;
  }
  // The public deployment's no-signup door (POST /v1/guest) closed on
  // 2026-09-27. Against a real deployment these now run on a credential issued
  // to a (test) account: MESH_CREDS_FILE, a standard .creds file, with a fresh
  // agent key per test agent on that connection.
  const credsFile = process.env.MESH_CREDS_FILE;
  if (!credsFile) {
    throw new Error(
      "no credential: the no-signup guest door is closed. Set MESH_CREDS_FILE to a test account's " +
        "credential, or use the local rig ($ROOMS_TEST_WS).",
    );
  }
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(credsFile, "utf8");
  const jwt = text.match(/-----BEGIN NATS USER JWT-----\r?\n([\s\S]*?)\r?\n------END NATS USER JWT------/)?.[1]?.trim();
  const seed = text.match(/-----BEGIN USER NKEY SEED-----\r?\n([\s\S]*?)\r?\n------END USER NKEY SEED------/)?.[1]?.trim();
  if (!jwt || !seed) throw new Error(`MESH_CREDS_FILE is not a .creds file: ${credsFile}`);
  const ws = process.env.AGENTMESH_WS ?? "wss://mesh.agentmesh.ai";
  void API;

  const enc = createEncryptionIdentity();
  const mesh = await AgentMesh.connect(ws, {
    requireNamed: false, // test agents; the naming rule is on by default since 2026-09-27
    authenticator: jwtAuthenticator(jwt, new TextEncoder().encode(seed)),
    nodeSeed: seed,
    encryptionSeed: enc.seed,
  });
  open.push(mesh);
  // Register so peers can resolve the encryption key when sealing to us.
  // NOT swallowed: a sealed invite resolves the invitee's encryption key from
  // its registered manifest (§8.3), so a failed register would surface later as
  // the confusing "published no verifiable encryption key" and hide the cause.
  await mesh.register({ name: label, capabilities: [], offerings: [] });
  return mesh;
}

/** Install the inbound side of `invite`. EXT-5 delivers a room invite as an
 *  ordinary pairwise request to the invitee's `rooms.invite` offering, so an agent
 *  with no such handler answers OFFERING_NOT_FOUND and the inviter's call throws —
 *  even though the acl admit already happened service-side. A real host
 *  implements this; the tests have to as well. Returns a getter for what
 *  arrived (the sealed room key rides here for sealed rooms). */
function acceptInvites(mesh: AgentMesh): () => { descriptor?: unknown; sealed_key?: unknown } | null {
  let got: { descriptor?: unknown; sealed_key?: unknown } | null = null;
  mesh.onRequest("rooms.invite", async (input) => {
    got = input as typeof got;
    return { ok: true };
  });
  return () => got;
}

/** Wait for a predicate, polling — rooms deliver asynchronously. */
async function until<T>(get: () => T, ok: (v: T) => boolean, ms = 12_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = get();
    if (ok(v)) return v;
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!LIVE)("rooms against a live mesh", () => {
  it("a durable room replays its record to a late joiner", async () => {
    const alice = await guestAgent("rooms-live-alice");
    const bob = await guestAgent("rooms-live-bob");

    const room = await alice.openRoom({ durable: true, name: "phase0-durable" });
    rooms.push(room);
    expect(room.durable).toBe(true);

    room.say("first");
    room.say("second");
    await new Promise((r) => setTimeout(r, 1500));

    // The late joiner sees nothing live; the record is the only source.
    const heard: string[] = [];
    const bobRoom = await bob.joinRoom(room.descriptor);
    rooms.push(bobRoom);
    bobRoom.onMessage((m) => { if (m.type === "say") heard.push(m.body as string); });

    const record = await bobRoom.fullHistory();
    const said = record
      .filter((e) => e.message?.type === "say")
      .map((e) => e.message?.body);
    expect(said).toContain("first");
    expect(said).toContain("second");
    // genesis is the record's first entry (EXT-5 §4).
    expect(record[0]?.message?.type).toBe("genesis");
  });

  it("history paginates from a sequence", async () => {
    const alice = await guestAgent("rooms-live-page");
    const room = await alice.openRoom({ durable: true, name: "phase0-paging" });
    rooms.push(room);
    for (let i = 0; i < 5; i++) room.say(`m${i}`);
    await new Promise((r) => setTimeout(r, 1800));

    const all = await room.fullHistory();
    expect(all.length).toBeGreaterThanOrEqual(6); // genesis + 5
    const tail = await room.history({ from_seq: 3, limit: 2 });
    expect(tail.entries.length).toBeLessThanOrEqual(2);
  });

  it("an artifact round-trips through the drive with its digest intact", async () => {
    const alice = await guestAgent("rooms-live-drive");
    const room = await alice.openRoom({ durable: true, name: "phase0-drive" });
    rooms.push(room);

    const bytes = new TextEncoder().encode("phase 0 artifact payload");
    const put = await room.attach("notes.txt", bytes, { mime: "text/plain" });
    expect(put.ref).toMatch(/^mesh:rooms:/);

    const got = await room.fetchArtifact(put.ref);
    expect(new TextDecoder().decode(got.data)).toBe("phase 0 artifact payload");
    expect(got.size).toBe(bytes.length);
    // The drive is content-addressed: the digest is the room's claim about
    // these bytes, so it has to match what came back.
    expect(got.digest).toBe(put.digest);
  });

  it("a read cursor advances monotonically and is per member", async () => {
    const alice = await guestAgent("rooms-live-cursor-a");
    const bob = await guestAgent("rooms-live-cursor-b");
    const room = await alice.openRoom({ durable: true, name: "phase1-cursor" });
    rooms.push(room);
    acceptInvites(bob);
    await new Promise((r) => setTimeout(r, 400));

    // Fresh room, nothing read.
    expect((await room.cursor()).seq).toBe(0);

    for (let i = 0; i < 3; i++) room.say(`c${i}`);
    await new Promise((r) => setTimeout(r, 1500));
    const last = (await room.fullHistory()).at(-1)!.seq;

    const set = await room.markRead(last);
    expect(set.seq).toBe(last);
    expect(set.advanced).toBe(true);
    expect((await room.cursor()).seq).toBe(last);

    // Monotonic: a lower seq must not rewind the mark, or a slower second
    // client could make the room look unread again.
    const back = await room.markRead(1);
    expect(back.seq).toBe(last);
    expect(back.advanced).toBe(false);

    // Per member: bob's cursor is his own, untouched by alice reading.
    const bobRoom = await bob.joinRoom(room.descriptor);
    rooms.push(bobRoom);
    expect((await bobRoom.cursor()).seq).toBe(0);
  });

  it("myRooms lists rooms the caller created, with position for unread", async () => {
    const alice = await guestAgent("rooms-live-mine");
    const room = await alice.openRoom({ durable: true, name: "phase1-mine" });
    rooms.push(room);
    room.say("one");
    await new Promise((r) => setTimeout(r, 1500));

    const mine = await alice.myRooms();
    const found = mine.find((r) => r.room_id === room.id);
    expect(found, "a room the caller created must be listed").toBeTruthy();
    expect(found!.role).toBe("creator");
    expect(found!.name).toBe("phase1-mine");
    expect(found!.cursor).toBe(0);
    expect(found!.last_seq).toBeGreaterThan(0);
    // last_seq - cursor is the unread count, in one round trip.
    expect(found!.last_seq! - found!.cursor).toBeGreaterThan(0);

    await room.markRead(found!.last_seq!);
    const after = (await alice.myRooms()).find((r) => r.room_id === room.id)!;
    expect(after.last_seq! - after.cursor).toBe(0);
  });

  it.skipIf(!ACL)("myRooms lists an acl room for an admitted member, not a stranger", async () => {
    const alice = await guestAgent("rooms-live-mine-acl");
    const bob = await guestAgent("rooms-live-mine-member");
    const eve = await guestAgent("rooms-live-mine-stranger");

    const room = await alice.openRoom({ acl: true, name: "phase1-mine-acl" });
    rooms.push(room);
    acceptInvites(bob);
    await new Promise((r) => setTimeout(r, 400));
    await room.invite(bob.agentId);

    const bobsRooms = await bob.myRooms();
    const seen = bobsRooms.find((r) => r.room_id === room.id);
    expect(seen, "an admitted member must see the room").toBeTruthy();
    expect(seen!.role).toBe("member");

    // Eve was never admitted: the room must not appear for her at all.
    const evesRooms = await eve.myRooms();
    expect(evesRooms.some((r) => r.room_id === room.id)).toBe(false);
  });

  it.skipIf(!ACL)("an acl room fans out on the broker-enforced namespace", async () => {
    const alice = await guestAgent("rooms-live-acl-creator");
    const bob = await guestAgent("rooms-live-acl-member");

    const room = await alice.openRoom({ acl: true, name: "phase0-acl" });
    rooms.push(room);
    expect(room.acl).toBe(true);
    expect(room.descriptor.privacy).toBe("acl");

    // invite = admit at the acl grade (EXT-5 §4).
    acceptInvites(bob);
    await new Promise((r) => setTimeout(r, 400));
    await room.invite(bob.agentId);
    const bobRoom = await bob.joinRoom(room.descriptor);
    rooms.push(bobRoom);

    const heard: string[] = [];
    bobRoom.onMessage((m) => { if (m.type === "say") heard.push(m.body as string); });
    await new Promise((r) => setTimeout(r, 800));
    room.say("hello over the acl namespace");

    await until(() => heard, (h) => h.length > 0);
    expect(heard).toContain("hello over the acl namespace");
  });

  it.skipIf(!ACL)("an un-admitted agent is refused an acl credential", async () => {
    const alice = await guestAgent("rooms-live-acl-owner");
    const eve = await guestAgent("rooms-live-acl-stranger");

    const room = await alice.openRoom({ acl: true, name: "phase0-acl-refuse" });
    rooms.push(room);

    // Eve holds the descriptor and is still refused: that is the whole point of
    // the grade — the broker enforces membership, not descriptor possession.
    await expect(eve.joinRoom(room.descriptor)).rejects.toThrow();
  });

  it.skipIf(!ACL)("expelling a member makes the rooms service refuse its credential renewal", async () => {
    const alice = await guestAgent("rooms-live-expel-creator");
    const bob = await guestAgent("rooms-live-expel-member");

    const room = await alice.openRoom({ acl: true, name: "phase0-expel" });
    rooms.push(room);
    acceptInvites(bob);
    await new Promise((r) => setTimeout(r, 400));
    await room.invite(bob.agentId);
    const bobRoom = await bob.joinRoom(room.descriptor);
    rooms.push(bobRoom);

    await room.expel(bob.agentId, { severity: "conduct", note: "phase 0 check" });
    await new Promise((r) => setTimeout(r, 1200));

    // Revocation IS refusal of renewal (EXT-5 §8.1): a fresh join must fail.
    await expect(bob.joinRoom(room.descriptor)).rejects.toThrow();
  });

  it("a sealed room keeps the record as ciphertext while members read plaintext", async () => {
    const alice = await guestAgent("rooms-live-sealed-creator");
    const bob = await guestAgent("rooms-live-sealed-member");

    const room = await alice.openRoom({ durable: true, name: "phase0-sealed", sealed: true });
    rooms.push(room);
    expect(room.descriptor.privacy).toBe("sealed");
    expect(room.descriptor.key_fingerprint).toBeTruthy();

    // The real distribution path: `invite` delivers the descriptor to the
    // invitee's inbox as a `rooms.invite` request, with the room key sealed to
    // the invitee's published X25519 key riding along. Bob handles that request
    // the way a host would, and opens the key with his own encryption seed.
    const inbox = acceptInvites(bob);
    await new Promise((r) => setTimeout(r, 500));

    await room.invite(bob.agentId);
    await until(inbox, (d) => d !== null);
    const delivered = inbox();
    expect(delivered, "invite never reached the invitee's inbox").not.toBeNull();
    expect(delivered!.sealed_key, "sealed room invite carried no sealed_key").toBeTruthy();

    const heard: string[] = [];
    const bobRoom = await bob.joinRoom(room.descriptor, {
      sealed_key: delivered!.sealed_key as never,
    });
    rooms.push(bobRoom);
    bobRoom.onMessage((m) => { if (m.type === "say") heard.push(m.body as string); });
    await new Promise((r) => setTimeout(r, 800));

    room.say("this line is encrypted on the wire");
    await until(() => heard, (h) => h.length > 0);
    expect(heard).toContain("this line is encrypted on the wire");

    // The record must hold ciphertext. Note WHICH field is checked: a
    // RecordEntry carries both `message` (parsed, and decrypted for a member
    // holding the room key — so it reads as plaintext, correctly) and
    // `envelope` (the raw signed frame as stored). The confidentiality claim is
    // about the stored bytes, so it is the envelope that has to be sealed.
    const record = await room.fullHistory();
    const raw = record
      .filter((e) => (e.envelope?.payload as { type?: string })?.type === "say")
      .map((e) => String((e.envelope?.payload as { body?: string })?.body ?? ""));
    expect(raw.length).toBeGreaterThan(0);
    for (const b of raw) {
      // `sealed:<nonce>:<ct>` per EXT-5 §6.
      expect(b.startsWith("sealed:")).toBe(true);
      expect(b).not.toContain("encrypted on the wire");
    }
    // And the member's own view of the same entries IS the plaintext.
    const parsed = record.filter((e) => e.message?.type === "say").map((e) => e.message?.body);
    expect(parsed).toContain("this line is encrypted on the wire");
  });
});
