import { describe, it, expect, vi } from "vitest";
import { nkeys } from "nats.ws";
import { MeshNode } from "../../src/node.js";
import type { Manifest } from "../../src/types/manifest.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope, verifyEnvelopeSig, verifyAttestation } from "../../src/internal/identity.js";
import { encode, decode } from "../../src/internal/codec.js";
import { createEncryptionIdentity, encryptionPublicFromSeed, sealPayloadTo, isSealedPayload, openSealedPayload } from "../../src/internal/sealed.js";
import type { ConnectionManager } from "../../src/internal/connection.js";

/**
 * Duck-typed fake ConnectionManager: records publishes/subscriptions, answers
 * requests with a plain "registered" respond envelope. No transport involved.
 *
 * The fake registry answers the way a real one does (see
 * `server/src/registry/handlers/register.ts`): one stable service key, the
 * reply signed by it (§4.5), and **bound to the request it answers** — `to` the
 * requester and `in_reply_to` the request's id (§6.2). The SDK now requires that
 * binding, because core NATS resolves a request with whatever reaches the muxed
 * inbox first, so an unbound reply is exactly what a racing third party sends.
 * A fake that omits it is not standing in for a registry.
 */
function makeFakeConn() {
  const published: Array<{ subject: string; data: Uint8Array }> = [];
  const subscriptions: Array<{ subject: string; unsubscribed: boolean }> = [];
  const registryKp = nkeys.createUser();
  const fake = {
    published,
    subscriptions,
    registryKp,
    closed: false,
    publish: vi.fn((subject: string, data: Uint8Array) => {
      published.push({ subject, data });
    }),
    request: vi.fn(async (_subject: string, data: Uint8Array) => {
      const req = decode(data);
      const resp = signEnvelope(
        createEnvelope({
          type: "respond",
          from: registryKp.getPublicKey(),
          to: req.from,
          in_reply_to: req.id,
          payload: { status: "registered" },
        }),
        registryKp,
      );
      return { data: encode(resp) };
    }),
    subscribe: vi.fn((subject: string) => {
      const record = { subject, unsubscribed: false };
      subscriptions.push(record);
      return {
        unsubscribe: () => {
          record.unsubscribed = true;
        },
        drain: async () => {
          record.unsubscribed = true;
        },
      };
    }),
    drain: vi.fn(async () => {
      fake.closed = true;
    }),
    close: vi.fn(async () => {
      fake.closed = true;
    }),
    get isClosed() {
      return fake.closed;
    },
  };
  return fake;
}

function makeNode(profile?: Parameters<typeof MeshNode.withConnection>[2]) {
  const conn = makeFakeConn();
  const nodeKp = nkeys.createUser();
  const node = MeshNode.withConnection(conn as unknown as ConnectionManager, nodeKp, profile);
  return { conn, nodeKp, node };
}

describe("MeshNode — one connection, N hosted agents (§4.1)", () => {
  it("hosts multiple agents with distinct keypairs over one shared connection", () => {
    const { node } = makeNode();
    const a = node.addAgent();
    const b = node.addAgent();

    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(node.id); // agents are NOT the node
    expect(node.agentCount).toBe(2);
    expect(node.getAgent(a.id)).toBe(a);
  });

  it("registers a hosted agent with a valid node vouch (§4.4)", async () => {
    const { conn, node } = makeNode();
    const agent = node.addAgent();
    await agent.register({ name: "Hosted Agent" });

    // The register envelope went out over the SHARED connection.
    const req = conn.request.mock.calls[0];
    const env = decode(req[1] as Uint8Array);
    const manifest = env.payload as Manifest;

    expect(manifest.node.id).toBe(node.id); // vouched by the node key
    expect(manifest.node.attestation.agent).toBe(agent.id);
    expect(verifyAttestation(manifest.node.attestation, agent.id)).toBe(true);
    // The envelope itself is signed by the AGENT key (§4.5).
    expect(env.from).toBe(agent.id);
    expect(verifyEnvelopeSig(env)).toBe(true);
  });

  it("carries a hosted agent's encryptionSeed into its manifest, and only that agent opens what is sealed to it (§4.3, §8.9)", async () => {
    const { conn, node } = makeNode();
    const encA = createEncryptionIdentity();
    const encB = createEncryptionIdentity();
    const a = node.addAgent({ encryptionSeed: encA.seed });
    const b = node.addAgent({ encryptionSeed: encB.seed });
    const c = node.addAgent();
    await a.register({ name: "A" });
    await b.register({ name: "B" });
    await c.register({ name: "C" });

    const manifests = conn.request.mock.calls.map((call) => decode(call[1] as Uint8Array).payload as Manifest);
    const byId = new Map(manifests.map((m) => [m.id, m]));
    // The manifest publishes the key derived from the seed the node handed over.
    expect(byId.get(a.id)?.encryption_key).toBe(encryptionPublicFromSeed(encA.seed));
    expect(byId.get(b.id)?.encryption_key).toBe(encryptionPublicFromSeed(encB.seed));
    // An agent added without one publishes none, as before this option existed.
    expect(byId.get(c.id)?.encryption_key).toBeUndefined();

    // A payload sealed to B opens with B's seed and with no other agent's.
    const sealed = sealPayloadTo({ text: "for B only" }, encryptionPublicFromSeed(encB.seed));
    expect(isSealedPayload(sealed)).toBe(true);
    expect(openSealedPayload(sealed, encB.seed)?.payload).toEqual({ text: "for B only" });
    expect(openSealedPayload(sealed, encA.seed)).toBeNull();
  });

  it("refuses a registry reply that does not answer the request (§6.2)", async () => {
    const { conn, node } = makeNode();
    const agent = node.addAgent();
    // Properly signed by a real key — and unbound: no `in_reply_to`. That is
    // the shape of a reply raced into the muxed inbox by somebody who is not
    // the registry, so registering MUST fail rather than report success.
    conn.request.mockImplementationOnce(async () => {
      const stranger = nkeys.createUser();
      const resp = signEnvelope(
        createEnvelope({
          type: "respond",
          from: stranger.getPublicKey(),
          payload: { status: "registered" },
        }),
        stranger,
      );
      return { data: encode(resp) };
    });

    await expect(agent.register({ name: "Raced" })).rejects.toThrow(
      /not bound to this request/,
    );
    expect(agent.registered).toBe(false);
  });

  it("attaches the node's declared profile to hosted registrations (§9.7)", async () => {
    const { conn, node } = makeNode({ availability_class: "always_on", reachability: "direct" });
    const agent = node.addAgent();
    await agent.register({ name: "Profiled Agent" });

    const env = decode(conn.request.mock.calls[0][1] as Uint8Array);
    const manifest = env.payload as Manifest;
    expect(manifest.node.profile).toEqual({ availability_class: "always_on", reachability: "direct" });
  });

  it("an explicit register nodeProfile overrides the node default", async () => {
    const { conn, node } = makeNode({ availability_class: "always_on" });
    const agent = node.addAgent();
    await agent.register({ name: "A", nodeProfile: { availability_class: "intermittent" } });

    const env = decode(conn.request.mock.calls[0][1] as Uint8Array);
    expect((env.payload as Manifest).node.profile?.availability_class).toBe("intermittent");
  });

  it("hosted agents do not heartbeat individually; the node heartbeat covers them (§9.6)", async () => {
    const { conn, node } = makeNode();
    const agent = node.addAgent();
    await agent.register({ name: "Quiet Agent" });

    // No per-agent heartbeat auto-started on register.
    expect(conn.published.filter((p) => p.subject.startsWith("mesh.heartbeat."))).toHaveLength(0);

    // One node heartbeat, from the NODE id, signed by the NODE key.
    node.sendHeartbeat("online");
    const hb = conn.published.filter((p) => p.subject.startsWith("mesh.heartbeat."));
    expect(hb).toHaveLength(1);
    expect(hb[0].subject).toBe(`mesh.heartbeat.${node.id}`);
    const hbEnv = decode(hb[0].data);
    expect(hbEnv.from).toBe(node.id);
    expect(verifyEnvelopeSig(hbEnv)).toBe(true);

    await agent.close();
  });

  it("closing a hosted agent detaches it without closing the shared connection", async () => {
    const { conn, node } = makeNode();
    const a = node.addAgent();
    const b = node.addAgent();
    await a.register({ name: "A" });
    await b.register({ name: "B" });

    await a.close();

    expect(a.isClosed).toBe(true);
    expect(conn.close).not.toHaveBeenCalled(); // shared connection untouched
    expect(conn.drain).not.toHaveBeenCalled();
    // A's inbox is unsubscribed; B's is still live.
    const inboxes = conn.subscriptions.filter((s) => s.subject.startsWith("mesh.agent."));
    expect(inboxes.find((s) => s.subject.includes(a.id))!.unsubscribed).toBe(true);
    expect(inboxes.find((s) => s.subject.includes(b.id))!.unsubscribed).toBe(false);
  });

  it("removeAgent detaches and forgets the agent", async () => {
    const { conn, node } = makeNode();
    const a = node.addAgent();
    await a.register({ name: "A" });

    expect(await node.removeAgent(a.id)).toBe(true);
    expect(node.agentCount).toBe(0);
    expect(node.getAgent(a.id)).toBeUndefined();
    expect(conn.close).not.toHaveBeenCalled();
    expect(await node.removeAgent(a.id)).toBe(false); // idempotent
  });

  it("node.close() detaches all agents and closes the connection once", async () => {
    const { conn, node } = makeNode();
    node.addAgent();
    node.addAgent();

    await node.close();

    expect(node.isClosed).toBe(true);
    expect(node.agentCount).toBe(0);
    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(() => node.addAgent()).toThrow(/closed/);
  });
});

describe("heartbeat timers on a closed connection", () => {
  // 2026-09-28: the kill switch's lift cuts a hosted agent's connection so it
  // re-mints; the agent's heartbeat timer then published on the closed
  // connection, threw from the timer, and ended the platform's process.
  const closedError = () => Object.assign(new Error("CONNECTION_CLOSED"), { code: "CONNECTION_CLOSED" });

  it("the node's timer drops a beat on a closed connection and stops, without throwing", () => {
    vi.useFakeTimers();
    try {
      const { conn, node } = makeNode();
      node.startHeartbeat(1000);
      conn.publish.mockImplementation(() => { throw closedError(); });
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      const calls = conn.publish.mock.calls.length;
      vi.advanceTimersByTime(5000);
      expect(conn.publish.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an agent's timer does the same", async () => {
    const { conn, node } = makeNode();
    const agent = node.addAgent();
    await agent.register({ name: "Beating Agent" });
    vi.useFakeTimers();
    try {
      agent.startHeartbeat(1000);
      conn.publish.mockImplementation(() => { throw closedError(); });
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      const calls = conn.publish.mock.calls.length;
      vi.advanceTimersByTime(5000);
      expect(conn.publish.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
