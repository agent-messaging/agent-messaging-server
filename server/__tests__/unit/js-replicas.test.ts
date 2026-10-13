// MESH_JS_REPLICAS — one knob, three creation sites, default 1.
//
// The 3-replica NATS StatefulSet in the deploy repo gave the mesh connection
// failover and no redundancy: `shared/kv.ts` defaulted `replicas` to 1 and no
// caller passed it, while `registry/inbox-buffer.ts` and `rooms/rooms-service.ts`
// each hardcoded `num_replicas: 1`. So the registry, accounts, rosters, guard
// state, offline mail and room records all lived on one node with no copy, and
// failover moved the connection to a node that did not have the data.
import { describe, it, expect, vi, afterEach } from "vitest";
import { jsReplicas, ensureKvBucket, REPLICAS_ENV, isReplicaError } from "../../src/storage/jetstream/kv.js";
import { InboxBuffer, inboxStreamName } from "../../src/registry/inbox-buffer.js";
import { roomRecordSpec } from "../../src/rooms/rooms-service.js";
import { roomRecordConfig } from "../../src/storage/jetstream/streams.js";
import type { RoomDescriptor } from "../../src/sdk.js";

/** The JetStream config the storage layer makes a room's record with, from
 *  the spec the rooms service asks for (storage/jetstream/streams.ts). */
const roomRecordStreamConfig = (d: RoomDescriptor) => roomRecordConfig(`rooms_${d.room_id}`, roomRecordSpec(d));

const AGENT = "UAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

afterEach(() => {
  delete process.env[REPLICAS_ENV];
  vi.restoreAllMocks();
});

describe("jsReplicas", () => {
  it("defaults to 1 so a single-node deployment is unchanged", () => {
    expect(jsReplicas({})).toBe(1);
    expect(jsReplicas({ [REPLICAS_ENV]: "" })).toBe(1);
    // And from the real environment, unset.
    expect(jsReplicas()).toBe(1);
  });

  it("reads the cluster size when one is given", () => {
    expect(jsReplicas({ [REPLICAS_ENV]: "3" })).toBe(3);
    expect(jsReplicas({ [REPLICAS_ENV]: "5" })).toBe(5);
  });

  it("throws on a value that cannot be a replica count", () => {
    // Visible at boot, never coerced: coercing is how you end up believing a
    // cluster is replicated when it is not. 5 is JetStream's ceiling.
    for (const bad of ["0", "-1", "6", "abc", "2.5", "1e1", " "]) {
      expect(() => jsReplicas({ [REPLICAS_ENV]: bad })).toThrow(
        new RegExp(`${REPLICAS_ENV}="${bad}" is not a usable replica count`),
      );
    }
  });
});

describe("site 1 of 3 — KV buckets", () => {
  /** `cluster` omitted = a single-node server, which is what `nc.info` looks
   *  like there: the field is set iff the server is in a cluster. */
  function fakeJs(existingReplicas: number, cluster?: string) {
    const views = { kv: vi.fn(async () => ({ status: async () => ({ replicas: existingReplicas }) })) };
    return { views, nc: { info: { cluster } } };
  }

  it("asks for 1 replica by default", async () => {
    const js = fakeJs(1);
    await ensureKvBucket(js as never, "mesh_registry", { history: 5 });
    expect(js.views.kv).toHaveBeenCalledWith("mesh_registry", {
      history: 5,
      ttl: undefined,
      replicas: 1,
    });
  });

  it("threads the env var through to the bucket", async () => {
    process.env[REPLICAS_ENV] = "3";
    const js = fakeJs(3, "mesh-cluster");
    await ensureKvBucket(js as never, "mesh_accounts", { history: 5 });
    expect((js.views.kv.mock.calls[0][1] as { replicas: number }).replicas).toBe(3);
  });

  it("still lets an explicit option win", async () => {
    process.env[REPLICAS_ENV] = "3";
    const js = fakeJs(1);
    await ensureKvBucket(js as never, "mesh_scratch", { history: 1, replicas: 1 });
    expect((js.views.kv.mock.calls[0][1] as { replicas: number }).replicas).toBe(1);
  });

  it("refuses replicas > 1 against a server that is not clustered", async () => {
    // The server would reject this anyway ("replicas > 1 not supported in
    // non-clustered mode"), but that error surfaces from whichever creation
    // happens to run first and several of ours are inside best-effort catches.
    process.env[REPLICAS_ENV] = "3";
    const js = fakeJs(1); // single-node
    await expect(ensureKvBucket(js as never, "mesh_registry", {})).rejects.toThrow(
      /MESH_JS_REPLICAS=3 but this server is not clustered/,
    );
    expect(js.views.kv).not.toHaveBeenCalled();
  });

  it("says so loudly when an existing bucket kept a lower replica count", async () => {
    // JetStream does not re-replicate on reopen: asking for 3 replicas of a
    // bucket created with 1 returns success and leaves it at 1. Not fatal —
    // refusing to boot would turn under-replicated data into an outage, and the
    // remedy moves data between nodes — but it must not pass silently.
    process.env[REPLICAS_ENV] = "3";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const js = fakeJs(1, "mesh-cluster");
    await ensureKvBucket(js as never, "mesh_rooms", { history: 1 });
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/has 1 replica\(s\), not the 3/));
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/nats stream update KV_mesh_rooms --replicas=3/));
    err.mockRestore();
  });

  it("recognises the server's own replica rejection", () => {
    // So callers that swallow creation failures on purpose can let this one
    // through — a bad replica count is an operator error to fix at boot.
    expect(isReplicaError(new Error("replicas > 1 not supported in non-clustered mode"))).toBe(true);
    expect(isReplicaError(new Error("insufficient replicas"))).toBe(true);
    expect(isReplicaError(new Error("stream not found"))).toBe(false);
  });
});

describe("site 2 of 3 — an agent's inbox buffer", () => {
  function fakeNc() {
    const streams = {
      info: vi.fn(async () => { throw new Error("stream not found"); }),
      add: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      purge: vi.fn(async () => ({})),
      list: vi.fn(() => ({ async *[Symbol.asyncIterator]() { /* no mailboxes yet */ } })),
    };
    return { streams, nc: { jetstreamManager: vi.fn(async () => ({ streams })) } };
  }

  it("creates mailboxes at 1 replica by default", async () => {
    const { streams, nc } = fakeNc();
    await new InboxBuffer(nc as never).ensure(AGENT);
    expect(streams.add).toHaveBeenCalledTimes(1);
    const cfg = streams.add.mock.calls[0][0] as { name: string; num_replicas: number };
    expect(cfg.name).toBe(inboxStreamName(AGENT));
    expect(cfg.num_replicas).toBe(1);
  });

  it("threads the env var through to the mailbox stream", async () => {
    process.env[REPLICAS_ENV] = "3";
    const { streams, nc } = fakeNc();
    await new InboxBuffer(nc as never).ensure(AGENT);
    expect((streams.add.mock.calls[0][0] as { num_replicas: number }).num_replicas).toBe(3);
  });

  it("rejects a bad value when the buffer is constructed, not per registration", async () => {
    // `ensure()` catches everything so a registration never fails on the buffer
    // tier — which would have turned a bad value into one swallowed line per
    // registration and a mesh where nobody has a mailbox. The field initialiser
    // runs at construction, at boot, where the throw is the point.
    process.env[REPLICAS_ENV] = "9";
    const { nc } = fakeNc();
    expect(() => new InboxBuffer(nc as never)).toThrow(/is not a usable replica count/);
  });
});

describe("site 3 of 3 — a durable room's record stream", () => {
  const descriptor = { room_id: "room-abcdef01234567", privacy: "capability" } as unknown as RoomDescriptor;

  it("records at 1 replica by default", () => {
    expect(roomRecordStreamConfig(descriptor).num_replicas).toBe(1);
  });

  it("threads the env var through to the record stream", () => {
    process.env[REPLICAS_ENV] = "3";
    expect(roomRecordStreamConfig(descriptor).num_replicas).toBe(3);
  });

  it("keeps the rest of the record config untouched", () => {
    const cfg = roomRecordStreamConfig(descriptor);
    expect(cfg.name).toBe("rooms_room-abcdef01234567");
    // Since the MESH_EVENTS cutover the record is subject-less and SOURCES the
    // room's slice from the owning stream (shared/events-stream.ts).
    expect((cfg as { subjects?: string[] }).subjects).toBeUndefined();
    expect((cfg as { sources?: unknown }).sources).toEqual([
      { name: "MESH_EVENTS", filter_subject: "mesh.event.room.room-abcdef01234567.>" },
    ]);
    expect(cfg.discard).toBe("new");
    expect(cfg.storage).toBe("file");
  });

  it("acl rooms stay subject-bound: mesh.aclroom.* is not under mesh.event.>", () => {
    // Sourcing an acl record from MESH_EVENTS would filter on a subject the
    // source never carries and record nothing, silently. No overlap exists to
    // resolve, so the enforced-namespace binding is kept as it was.
    const acl = { room_id: "room-abcdef01234567", privacy: "acl" } as unknown as RoomDescriptor;
    const cfg = roomRecordStreamConfig(acl);
    expect((cfg as { subjects?: string[] }).subjects).toEqual(["mesh.aclroom.room-abcdef01234567.>"]);
    expect((cfg as { sources?: unknown }).sources).toBeUndefined();
  });
});
