/**
 * Who may open a durable room, and what its limits count against (decided by
 * the owner on 2026-10-12, docs/agent-messaging-server-plan.md step 4):
 *
 *  - any agent an account owns in the ownership record may open one, and the
 *    room counts against that account;
 *  - an agent no account owns may still open one through its PAN name (the
 *    room-creator key the conformance suite and platform services use), and
 *    the room counts against that operator, as before;
 *  - an agent with neither is refused with its own error, not a quota error;
 *  - rooms opened before the change are counted against their creator's
 *    account by reading the record, and their stored records are not
 *    rewritten.
 *
 * Driven through the real handlers with real signed descriptors and envelopes.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { RoomsService, NO_OWNER_WORDS } from "../../src/rooms/rooms-service.js";
import { MemoryAgentOwners, roomAccountOf, roomQuotaHolder, type AgentOwnerRecord } from "../../src/keychain/agent-owners.js";
import { createEnvelope, signEnvelope, nkeys } from "../../src/sdk.js";
import type { Envelope, RoomDescriptor } from "../../src/sdk.js";
import { signDescriptor } from "../../../sdk-typescript/src/rooms.js";
import { storageOf } from "../../src/storage/index.js";

type Kp = ReturnType<typeof nkeys.createUser>;

const rec = (key: string, over: Partial<AgentOwnerRecord>): AgentOwnerRecord => ({
  key, account: null, org: null, home_org: null, person: null, category: null,
  listed: true, label: null, custody: null, payer: null, updated_at: "2026-10-12T00:00:00.000Z", ...over,
});

let n = 0;
function descriptorFor(kp: Kp, over: Partial<RoomDescriptor> = {}): RoomDescriptor {
  const roomId = `RoomByAccount0000${String(++n).padStart(4, "0")}`;
  return signDescriptor(
    {
      rooms: "v1",
      room_id: roomId,
      name: `room ${n}`,
      channels: ["main"],
      record: `mesh:rooms:${roomId}`,
      policy: {},
      privacy: "capability",
      creator: kp.getPublicKey(),
      created_at: new Date(0).toISOString(),
      ...over,
    } as Omit<RoomDescriptor, "sig">,
    kp as never,
  );
}

function signed(kp: Kp, payload: unknown): Envelope {
  return signEnvelope(createEnvelope({ type: "request", from: kp.getPublicKey(), payload }), kp as never);
}

interface Handlers {
  handleProvision(env: Envelope): Promise<Envelope>;
  handleUsage(env: Envelope): Promise<Envelope>;
  handleStatus(env: Envelope): Promise<Envelope>;
  rooms: Map<string, Record<string, unknown>>;
}

/** The rooms service with its handlers reachable over an in-memory record,
 *  a stubbed stream manager and a KV that remembers what was written. */
function service(owners: MemoryAgentOwners) {
  const puts: string[] = [];
  const svc = Object.create(RoomsService.prototype) as Handlers;
  Object.assign(svc, {
    kp: nkeys.createUser(),
    rooms: new Map(),
    operatorCache: new Map(),
    accountCache: new Map(),
    owners,
    hostedOperatorOf: async () => null,
    // The stream manager stubbed under the storage layer's room records.
    records: storageOf({ jetstreamManager: async () => ({ streams: { add: vi.fn(async () => ({})), info: vi.fn(async () => { throw new Error("no stream"); }) } }) } as never).streams("rooms_<room>"),
    kv: { put: vi.fn(async (k: string) => { puts.push(k); return 1; }) },
  });
  return { svc, puts };
}

/** The registrar knows `named` (a PAN handle for ann@example.com) and nobody else. */
function registrarKnows(named: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const id = new URL(url).searchParams.get("agent_id") ?? "";
    if (!named.includes(id)) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ card: { operator: { email: "ann@example.com" }, handle: "petrel.ann@example.com" } }) };
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the answers the record gives rooms", () => {
  it("the owning account is the account holding the agent, else the account a hosted seat is held for", () => {
    expect(roomAccountOf(rec("U1", { account: "acct_ann" }))).toBe("acct_ann");
    expect(roomAccountOf(rec("U1", { custody: { account: "acct_bob", email: "bob@example.com" } }))).toBe("acct_bob");
    expect(roomAccountOf(rec("U1", { payer: "acct_ann" }))).toBeNull();
    expect(roomAccountOf(null)).toBeNull();
  });

  it("a room counts against its account, else its operator", () => {
    expect(roomQuotaHolder("acct_ann", "ann@example.com")).toBe("account:acct_ann");
    expect(roomQuotaHolder(null, "ann@example.com")).toBe("ann@example.com");
    expect(roomQuotaHolder(undefined, null)).toBeNull();
  });
});

describe("who may open a durable room", () => {
  it("an agent an account owns opens one with no name, and the room carries the account", async () => {
    registrarKnows([]);
    const owners = new MemoryAgentOwners();
    const kp = nkeys.createUser();
    await owners.putAgent(rec(kp.getPublicKey(), { account: "acct_ann" }));
    const { svc } = service(owners);
    const d = descriptorFor(kp);
    const res = await svc.handleProvision(signed(kp, { descriptor: d }));
    expect(res.error).toBeUndefined();
    expect(res.payload).toMatchObject({ provisioned: true });
    expect(svc.rooms.get(d.room_id)).toMatchObject({ account: "acct_ann", operator: "account:acct_ann" });
  });

  it("an agent with a name and no account still opens one, counted against its operator", async () => {
    const kp = nkeys.createUser();
    registrarKnows([kp.getPublicKey()]);
    const { svc } = service(new MemoryAgentOwners());
    const d = descriptorFor(kp);
    const res = await svc.handleProvision(signed(kp, { descriptor: d }));
    expect(res.error).toBeUndefined();
    expect(svc.rooms.get(d.room_id)).toMatchObject({ account: null, operator: "ann@example.com" });
  });

  it("an agent nobody owns is refused with its own error, not a quota error", async () => {
    registrarKnows([]);
    const kp = nkeys.createUser();
    const { svc } = service(new MemoryAgentOwners());
    const res = await svc.handleProvision(signed(kp, { descriptor: descriptorFor(kp) }));
    expect(res.error?.code).toBe("UNAUTHORIZED");
    expect(res.error?.message).toBe(NO_OWNER_WORDS);
    expect((res.error as { details?: Record<string, unknown> }).details).toEqual({ reason: "no_owner_on_record" });
    expect(svc.rooms.size).toBe(0);
  });

  it("an agent added to an account a moment after a refusal is not kept waiting by the cache", async () => {
    registrarKnows([]);
    const owners = new MemoryAgentOwners();
    const kp = nkeys.createUser();
    const { svc } = service(owners);
    expect((await svc.handleProvision(signed(kp, { descriptor: descriptorFor(kp) }))).error?.code).toBe("UNAUTHORIZED");
    await owners.putAgent(rec(kp.getPublicKey(), { account: "acct_ann" }));
    expect((await svc.handleProvision(signed(kp, { descriptor: descriptorFor(kp) }))).error).toBeUndefined();
  });
});

describe("the limit is counted per account", () => {
  it("rooms opened before the change count against the creator's account, read from the record and never rewritten", async () => {
    registrarKnows([]);
    const owners = new MemoryAgentOwners();
    const older = nkeys.createUser();
    const newer = nkeys.createUser();
    // Two different agents of one account: the older one opened nine rooms
    // before 2026-10-12, recorded against Ann's email with no account on them.
    await owners.putAgent(rec(older.getPublicKey(), { account: "acct_ann" }));
    await owners.putAgent(rec(newer.getPublicKey(), { account: "acct_ann" }));
    const { svc, puts } = service(owners);
    const legacy: Record<string, unknown>[] = [];
    for (let i = 0; i < 9; i++) {
      const d = descriptorFor(older);
      const meta = { descriptor: d, operator: "ann@example.com", created_at: new Date(0).toISOString(), drive_bytes: 0, artifacts: [] };
      legacy.push(meta);
      svc.rooms.set(d.room_id, meta);
    }
    const before = JSON.stringify(legacy);

    // The tenth room fits, opened by the other agent of the same account.
    expect((await svc.handleProvision(signed(newer, { descriptor: descriptorFor(newer) }))).error).toBeUndefined();
    // The eleventh does not, whichever of the account's agents asks.
    const refused = await svc.handleProvision(signed(newer, { descriptor: descriptorFor(newer) }));
    expect(refused.error?.code).toBe("QUOTA_EXCEEDED");
    expect(refused.error?.message).toContain("account acct_ann already holds 10/10 durable rooms");

    // The older rooms were counted without being written: the only write is the new room.
    expect(JSON.stringify(legacy)).toBe(before);
    expect(puts).toHaveLength(1);

    // Another account is not affected.
    const other = nkeys.createUser();
    await owners.putAgent(rec(other.getPublicKey(), { account: "acct_bob" }));
    expect((await svc.handleProvision(signed(other, { descriptor: descriptorFor(other) }))).error).toBeUndefined();
  });

  it("usage answers for the caller's account, with the account's rooms whichever agent opened them", async () => {
    registrarKnows([]);
    const owners = new MemoryAgentOwners();
    const a = nkeys.createUser();
    const b = nkeys.createUser();
    await owners.putAgent(rec(a.getPublicKey(), { account: "acct_ann" }));
    await owners.putAgent(rec(b.getPublicKey(), { custody: { account: "acct_ann", email: "ann@example.com" } }));
    const { svc } = service(owners);
    const old = descriptorFor(b);
    svc.rooms.set(old.room_id, { descriptor: old, operator: "ann@example.com", created_at: new Date(0).toISOString(), drive_bytes: 2048, artifacts: [] });
    await svc.handleProvision(signed(a, { descriptor: descriptorFor(a) }));
    const res = await svc.handleUsage(signed(a, {}));
    expect(res.error).toBeUndefined();
    expect(res.payload).toMatchObject({ operator: "account:acct_ann", account: "acct_ann", rooms: 2, cap: 10, overCap: false, drive_bytes: 2048 });

    const stranger = nkeys.createUser();
    const none = await svc.handleUsage(signed(stranger, {}));
    expect(none.error?.code).toBe("NOT_FOUND");
  });

  it("status shows the operator and the account to the creator only", async () => {
    registrarKnows([]);
    const owners = new MemoryAgentOwners();
    const creator = nkeys.createUser();
    const member = nkeys.createUser();
    await owners.putAgent(rec(creator.getPublicKey(), { account: "acct_ann" }));
    const { svc } = service(owners);
    const d = descriptorFor(creator);
    await svc.handleProvision(signed(creator, { descriptor: d }));
    const mine = await svc.handleStatus(signed(creator, { descriptor: d }));
    expect(mine.payload).toMatchObject({ operator: "account:acct_ann", account: "acct_ann" });
    expect((mine.payload as { limits: Record<string, number> }).limits).toMatchObject({ max_rooms_per_account: 10, max_drive_bytes_per_account: 100 * 1024 * 1024 });
    const theirs = await svc.handleStatus(signed(member, { descriptor: d }));
    expect(theirs.payload).toMatchObject({ operator: null, account: null });
  });
});
