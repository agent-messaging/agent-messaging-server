// Presence (SPEC.md §9.6): a consumer tracking liveness MUST subscribe to the
// presence transition stream BEFORE reading the presence snapshot — the
// transition that fires between a snapshot read and a later subscription lands
// in the gap and is simply never seen. trackPresence is the SDK's presence
// surface, and these tests pin that order (and the trust rule on transitions:
// the subject token names the node, and only the node's own signature counts).
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import type { Msg } from "nats.ws";
import { AgentMesh, type PresenceTransition } from "../../src/mesh.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

function makeConn(snapshot: unknown = { nodes: [] }) {
  const serviceKp = nkeys.createUser();
  /** Every transport operation, in the order it happened — the observable
   *  §9.6 cares about. */
  const ops: { op: "subscribe" | "request" | "publish"; subject: string }[] = [];
  const subs = new Map<string, (msg: Msg) => void>();
  return {
    ops,
    subs,
    publish: vi.fn((subject: string) => ops.push({ op: "publish", subject })),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      ops.push({ op: "request", subject });
      const req = decodeUnverified(data);
      return {
        data: encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: serviceKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload: subject === Subjects.PRESENCE_GET ? snapshot : { status: "registered" },
            }),
            serviceKp,
          ),
        ),
      };
    }),
    subscribe: vi.fn((subject: string, cb: (msg: Msg) => void) => {
      ops.push({ op: "subscribe", subject });
      subs.set(subject, cb);
      return { unsubscribe: () => subs.delete(subject), drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    raw: { publish: () => {} },
    get isClosed() {
      return false;
    },
  };
}

function heartbeat(nodeKp: ReturnType<typeof nkeys.createUser>, availability?: string) {
  return signEnvelope(
    createEnvelope({
      type: "emit",
      from: nodeKp.getPublicKey(),
      payload: { node: nodeKp.getPublicKey(), availability: availability ?? "online" },
    }),
    nodeKp,
  );
}

describe("§9.6 subscribe-before-snapshot — trackPresence", () => {
  it("subscribes to the transition stream BEFORE requesting the snapshot", async () => {
    const snapshot = { nodes: [{ node: "N1", availability: "online" }] };
    const conn = makeConn(snapshot);
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(agent);

    const watch = await agent.trackPresence(() => {});
    const subIdx = conn.ops.findIndex(
      (o) => o.op === "subscribe" && o.subject === "mesh.heartbeat.>",
    );
    const getIdx = conn.ops.findIndex(
      (o) => o.op === "request" && o.subject === Subjects.PRESENCE_GET,
    );
    expect(subIdx).toBeGreaterThanOrEqual(0);
    expect(getIdx).toBeGreaterThanOrEqual(0);
    expect(subIdx).toBeLessThan(getIdx); // §9.6: the MUST this file exists for
    expect(watch.snapshot).toEqual(snapshot);
    watch.stop();
  });

  it("narrows to one node's heartbeat subject when asked", async () => {
    const conn = makeConn();
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(agent);
    const nodeKp = nkeys.createUser();
    const watch = await agent.trackPresence(() => {}, { node: nodeKp.getPublicKey() });
    expect(
      conn.ops.some(
        (o) => o.op === "subscribe" && o.subject === Subjects.heartbeat(nodeKp.getPublicKey()),
      ),
    ).toBe(true);
    watch.stop();
  });

  it("surfaces transitions signed by the node the subject names, and drops impostors", async () => {
    const conn = makeConn();
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(agent);
    const nodeKp = nkeys.createUser();
    const impostorKp = nkeys.createUser();
    const seen: PresenceTransition[] = [];
    const watch = await agent.trackPresence((t) => seen.push(t));

    const subject = Subjects.heartbeat(nodeKp.getPublicKey());
    const cb = conn.subs.get("mesh.heartbeat.>")!;
    // The node's own heartbeat: surfaced.
    cb({ subject, data: encode(heartbeat(nodeKp, "busy")) } as unknown as Msg);
    // An impostor publishing on the node's subject, signed with its OWN key:
    // decodes fine, but the subject token names a node it cannot sign for.
    cb({ subject, data: encode(heartbeat(impostorKp, "offline")) } as unknown as Msg);

    expect(seen).toHaveLength(1);
    expect(seen[0].node).toBe(nodeKp.getPublicKey());
    expect(seen[0].availability).toBe("busy");
    watch.stop();
  });

  it("a mesh without a presence service still yields transitions: snapshot is null, nothing throws", async () => {
    const conn = makeConn();
    conn.request.mockImplementation(async (subject: string) => {
      conn.ops.push({ op: "request", subject });
      throw new Error("no responders");
    });
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(agent);
    const watch = await agent.trackPresence(() => {});
    expect(watch.snapshot).toBeNull();
    // The subscription was still established first.
    expect(conn.ops[0]).toEqual({ op: "subscribe", subject: "mesh.heartbeat.>" });
    watch.stop();
  });
});
