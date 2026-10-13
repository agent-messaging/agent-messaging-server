// Feeds (SPEC §6.6a, §18.3): the behavioural half the conformance fixture
// deliberately does not pin bytes for.
//
//  - trackFeed subscribes BEFORE it reads the snapshot (§9.6
//    subscribe-before-snapshot, applied to feeds by §18.3);
//  - subscribeFeed dispatches through the shared §22 event pipeline (full
//    {topic, kind, data} payload through; a duplicate id refused);
//  - feedValue degrades to null when no feed-state service answers;
//  - declareFeed lands the feed subjects in the manifest `emits` at register.
//
// Against a fake ConnectionManager, like the durable-subscribe suite: what
// needs pinning is the call order, the dispatch discipline and the manifest,
// not the transport.
import { describe, it, expect, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { Subjects } from "../../src/internal/subjects.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decodeUnverified } from "../../src/internal/codec.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import type { Envelope } from "../../src/types/envelope.js";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

/** A fake ConnectionManager recording every subscribe and request IN ORDER,
 *  answering requests with a properly signed respond. `raw` throws, like a
 *  credential without JetStream access: register()'s offline drain must
 *  degrade silently around it. */
function makeConn(respondWith?: (subject: string, req: Envelope) => unknown) {
  const registryKp = nkeys.createUser();
  const calls: string[] = [];
  const published: Array<{ subject: string; data: Uint8Array }> = [];
  const requests: Array<{ subject: string; env: Envelope }> = [];
  const subs = new Map<string, (msg: unknown) => void>();
  const conn = {
    calls,
    published,
    requests,
    subs,
    publish: (subject: string, data: Uint8Array) => {
      published.push({ subject, data });
    },
    request: async (subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      calls.push(`request:${subject}`);
      requests.push({ subject, env: req });
      const payload = respondWith ? respondWith(subject, req) : { status: "ok" };
      if (payload instanceof Error) throw payload;
      return {
        data: encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: registryKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload,
            }),
            registryKp,
          ),
        ),
      };
    },
    subscribe: (subject: string, cb: (msg: unknown) => void) => {
      calls.push(`subscribe:${subject}`);
      subs.set(subject, cb);
      return { unsubscribe: () => subs.delete(subject), drain: async () => {} };
    },
    drain: async () => {},
    close: async () => {},
    get isClosed() {
      return false;
    },
    raw: {
      jetstreamManager: async () => {
        throw new Error("no JetStream in this fake");
      },
      jetstream: () => {
        throw new Error("no JetStream in this fake");
      },
      publish: () => {},
    },
  };
  return conn;
}
type Conn = ReturnType<typeof makeConn>;

function agentOn(conn: Conn): AgentMesh {
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
    { fenceInbound: false },
  );
  openAgents.push(agent);
  return agent;
}

function feedEnvelope(
  ownerKp: KeyPair,
  topic: string,
  data: unknown,
  id?: string,
): Envelope {
  const env = createEnvelope({
    type: "emit",
    from: ownerKp.getPublicKey(),
    payload: { topic, kind: "state", data },
  });
  if (id) env.id = id;
  return signEnvelope(env, ownerKp);
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("trackFeed (§9.6 order, applied to feeds by §18.3)", () => {
  it("subscribes BEFORE it requests the snapshot", async () => {
    const ownerKp = nkeys.createUser();
    const owner = ownerKp.getPublicKey();
    const stored = feedEnvelope(ownerKp, "status", { level: "ok" });
    const conn = makeConn((subject) =>
      subject === Subjects.FEED_GET ? { found: true, envelope: stored } : { status: "ok" },
    );
    const agent = agentOn(conn);
    const watch = await agent.trackFeed(owner, "status", () => {});
    // The order IS the contract: a publish that fires between a snapshot read
    // and a later subscription is never seen at all, while this order's worst
    // case is one publish seen twice.
    expect(conn.calls).toEqual([
      `subscribe:${Subjects.feed(owner, "status")}`,
      `request:${Subjects.FEED_GET}`,
    ]);
    expect(watch.snapshot?.id).toBe(stored.id);
    watch.stop();
    expect(conn.subs.has(Subjects.feed(owner, "status"))).toBe(false);
  });

  it("degrades the snapshot to null when no feed-state service answers; deliveries still flow", async () => {
    const conn = makeConn((subject) =>
      subject === Subjects.FEED_GET ? new Error("no responders") : { status: "ok" },
    );
    const agent = agentOn(conn);
    const ownerKp = nkeys.createUser();
    const seen: unknown[] = [];
    const watch = await agent.trackFeed(ownerKp.getPublicKey(), "status", (p) => seen.push(p));
    expect(watch.snapshot).toBeNull();
    conn.subs.get(Subjects.feed(ownerKp.getPublicKey(), "status"))!({
      subject: Subjects.feed(ownerKp.getPublicKey(), "status"),
      data: encode(feedEnvelope(ownerKp, "status", { level: "ok" })),
    });
    await settle();
    expect(seen).toHaveLength(1);
    watch.stop();
  });

  it('refuses a "*" topic: a current value is a per-feed fact', async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    await expect(agent.trackFeed(nkeys.createUser().getPublicKey(), "*", () => {})).rejects.toThrow();
    expect(conn.calls).toEqual([]); // refused before anything went live
  });
});

describe("subscribeFeed dispatch (§22 pipeline, shared verbatim)", () => {
  it("hands the handler the full {topic, kind, data} payload with the verified envelope", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const ownerKp = nkeys.createUser();
    const owner = ownerKp.getPublicKey();
    const seen: Array<{ payload: unknown; env: Envelope }> = [];
    agent.subscribeFeed(owner, "status", (p, env) => seen.push({ payload: p, env }));
    const env = feedEnvelope(ownerKp, "status", { level: "ok", note: "all quiet" });
    conn.subs.get(Subjects.feed(owner, "status"))!({
      subject: Subjects.feed(owner, "status"),
      data: encode(env),
    });
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({
      topic: "status",
      kind: "state",
      data: { level: "ok", note: "all quiet" },
    });
    expect(seen[0].env.id).toBe(env.id);
    expect(seen[0].env.from).toBe(owner);
  });

  it("drops a duplicate envelope id (§22.2, scoped to this subscription)", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const ownerKp = nkeys.createUser();
    const owner = ownerKp.getPublicKey();
    const seen: unknown[] = [];
    agent.subscribeFeed(owner, "status", (p) => seen.push(p));
    const env = feedEnvelope(ownerKp, "status", { level: "ok" });
    const delivery = { subject: Subjects.feed(owner, "status"), data: encode(env) };
    conn.subs.get(Subjects.feed(owner, "status"))!(delivery);
    conn.subs.get(Subjects.feed(owner, "status"))!(delivery);
    await settle();
    expect(seen).toHaveLength(1);
  });

  it('topic "*" subscribes the whole-owner pattern and delivers any of that agent\'s feeds', async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const ownerKp = nkeys.createUser();
    const owner = ownerKp.getPublicKey();
    const seen: unknown[] = [];
    agent.subscribeFeed(owner, "*", (p) => seen.push(p));
    expect(conn.subs.has(`mesh.feed.${owner}.*`)).toBe(true);
    conn.subs.get(`mesh.feed.${owner}.*`)!({
      subject: Subjects.feed(owner, "status"),
      data: encode(feedEnvelope(ownerKp, "status", { level: "ok" })),
    });
    await settle();
    expect(seen).toHaveLength(1);
  });

  it("teardown reaps feed subscriptions like every other event subscription", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const owner = nkeys.createUser().getPublicKey();
    agent.subscribeFeed(owner, "status", () => {});
    agent.subscribe("billing.*", () => {});
    expect(conn.subs.size).toBe(2);
    // The detach path (a node-hosted agent's close) is the one that reaps
    // sub-by-sub — an owned connection just closes whole. Force that branch:
    // what is under test is that subscribeFeed lands in the same eventSubs
    // list subscribe() uses, so no teardown path can forget it.
    (agent as unknown as { ownsConnection: boolean }).ownsConnection = false;
    await agent.close();
    expect(conn.subs.size).toBe(0);
  });
});

describe("feedValue degradation", () => {
  it("returns null when the lookup times out or errors (like trackPresence's snapshot)", async () => {
    const conn = makeConn(() => new Error("timeout"));
    const agent = agentOn(conn);
    await expect(agent.feedValue(nkeys.createUser().getPublicKey(), "status")).resolves.toBeNull();
  });

  it("returns null on {found: false, envelope: null}: the feed has never published", async () => {
    const conn = makeConn((subject) =>
      subject === Subjects.FEED_GET ? { found: false, envelope: null } : { status: "ok" },
    );
    const agent = agentOn(conn);
    await expect(agent.feedValue(nkeys.createUser().getPublicKey(), "status")).resolves.toBeNull();
  });
});

describe("declareFeed → manifest emits (§6.6a / §8.2)", () => {
  it("register() carries the declared feed subjects, sorted", async () => {
    const conn = makeConn((subject) =>
      subject === Subjects.REGISTRY_REGISTER ? { status: "registered" } : { status: "ok" },
    );
    const agent = agentOn(conn);
    agent.declareFeed("status", "state");
    agent.declareFeed("changes", "stream");
    await agent.register({ name: "feeder" });
    const reg = conn.requests.find((r) => r.subject === Subjects.REGISTRY_REGISTER);
    expect(reg).toBeDefined();
    const manifest = reg!.env.payload as { emits?: string[] };
    expect(manifest.emits).toEqual(
      [Subjects.feed(agent.id, "changes"), Subjects.feed(agent.id, "status")].sort(),
    );
  });

  it("an agent that declared nothing registers with no emits field at all", async () => {
    const conn = makeConn((subject) =>
      subject === Subjects.REGISTRY_REGISTER ? { status: "registered" } : { status: "ok" },
    );
    const agent = agentOn(conn);
    await agent.register({ name: "quiet" });
    const reg = conn.requests.find((r) => r.subject === Subjects.REGISTRY_REGISTER);
    expect(reg).toBeDefined();
    expect("emits" in (reg!.env.payload as Record<string, unknown>)).toBe(false);
  });

  it("declareFeed validates like publishFeed: dotted topics and invented kinds refuse", () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    expect(() => agent.declareFeed("a.b", "state")).toThrow();
    expect(() => agent.declareFeed("status", "latest" as "state")).toThrow();
  });
});
