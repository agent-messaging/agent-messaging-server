// Durable feed subscriptions (SPEC §18.6 Feed Consumer).
//
// subscribeFeed(agent, topic, handler, { durable }) adds the feed to the
// agent's ONE consumer on MESH_FEED, `mesh_feed_{agent_id}`. The name is a
// cross-SDK contract and the credential template grants exactly it, so it is
// pinned here. Against a fake JetStream, like durable-subscribe.test.ts.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys, AckPolicy, DeliverPolicy } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode, MeshError } from "../../src/types/errors.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import type { Envelope } from "../../src/types/envelope.js";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

type JsMsgLike = { data: Uint8Array; subject?: string; ack: () => void; nak?: (ms?: number) => void };

function makeMessages() {
  const pending: JsMsgLike[] = [];
  let notify: (() => void) | null = null;
  let stopped = false;
  return {
    stopCalls: 0,
    push(m: JsMsgLike) {
      pending.push(m);
      notify?.();
    },
    stop() {
      this.stopCalls++;
      stopped = true;
      notify?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (pending.length) yield pending.shift()!;
        if (stopped) return;
        await new Promise<void>((r) => {
          notify = r;
        });
        notify = null;
      }
    },
  };
}

function makeConn(opts?: { existingFilters?: string[]; jetstreamBroken?: boolean }) {
  const messages = makeMessages();
  const added: Array<{ stream: string; config: Record<string, unknown> }> = [];
  const updated: Array<{ stream: string; durable: string; config: Record<string, unknown> }> = [];
  const gets: Array<{ stream: string; durable: string }> = [];
  let filters: string[] | null = opts?.existingFilters ? [...opts.existingFilters] : null;
  const jsm = {
    consumers: {
      info: vi.fn(async () => {
        if (filters === null) throw new Error("consumer not found");
        return { config: { filter_subjects: [...filters] } };
      }),
      add: vi.fn(async (stream: string, config: Record<string, unknown>) => {
        added.push({ stream, config });
        filters = [...((config.filter_subjects as string[]) ?? [])];
        return {};
      }),
      update: vi.fn(async (stream: string, durable: string, config: Record<string, unknown>) => {
        updated.push({ stream, durable, config });
        filters = [...((config.filter_subjects as string[]) ?? [])];
        return {};
      }),
      delete: vi.fn(async () => true),
    },
  };
  const consumer = { consume: vi.fn(async () => messages) };
  const raw = {
    jetstreamManager: vi.fn(async () => {
      if (opts?.jetstreamBroken) throw new Error("Permissions Violation for Publish to $JS.API.CONSUMER.INFO");
      return jsm;
    }),
    jetstream: vi.fn(() => ({
      consumers: {
        get: vi.fn(async (stream: string, durable: string) => {
          gets.push({ stream, durable });
          return consumer;
        }),
      },
    })),
    publish: vi.fn(() => {}),
  };
  return {
    messages,
    added,
    updated,
    gets,
    jsm,
    raw,
    consumer,
    publish: vi.fn(() => {}),
    request: vi.fn(async () => {
      throw new Error("no requests in this fake");
    }),
    subscribe: vi.fn(() => ({ unsubscribe: () => {}, drain: async () => {} })),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    get isClosed() {
      return false;
    },
  };
}
type Conn = ReturnType<typeof makeConn>;

function agentOn(conn: Conn) {
  const agent = AgentMesh.withConnection(conn as unknown as ConnectionManager, nkeys.createUser(), nkeys.createUser(), {
    fenceInbound: false,
  });
  openAgents.push(agent);
  return agent;
}

function feedEnvelope(ownerKp: KeyPair, topic: string, data: unknown): Envelope {
  return signEnvelope(
    createEnvelope({ type: "emit", from: ownerKp.getPublicKey(), payload: { topic, kind: "stream", data } }),
    ownerKp,
  );
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("§18.6 Feed Consumer: the name and the config", () => {
  it("binds ONE consumer named for the agent, mesh_feed_{agent_id}, created with the pinned config", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const owner = nkeys.createUser().getPublicKey();
    const sub = await agent.subscribeFeed(owner, "ring-round", () => {}, { durable: true });
    expect(sub.durable).toBe(`mesh_feed_${agent.id}`);
    expect(sub.subject).toBe(`mesh.feed.${owner}.ring-round`);
    expect(conn.added).toEqual([
      {
        stream: "MESH_FEED",
        config: {
          durable_name: `mesh_feed_${agent.id}`,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.New,
          ack_wait: 30_000_000_000,
          max_deliver: 5,
          filter_subjects: [`mesh.feed.${owner}.ring-round`],
        },
      },
    ]);
    expect(conn.gets).toEqual([{ stream: "MESH_FEED", durable: `mesh_feed_${agent.id}` }]);
    await sub.stop();
  });

  it("an existing consumer that already follows the feed is bound as it stands: no add, no update", async () => {
    const owner = nkeys.createUser().getPublicKey();
    const conn = makeConn({ existingFilters: [`mesh.feed.${owner}.ring-round`] });
    const agent = agentOn(conn);
    const sub = await agent.subscribeFeed(owner, "ring-round", () => {}, { durable: true });
    expect(conn.added).toEqual([]);
    expect(conn.updated).toEqual([]);
    await sub.stop();
  });

  it("a second feed is added to the same consumer's filters, and one consume loop serves both", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const a = nkeys.createUser().getPublicKey();
    const b = nkeys.createUser().getPublicKey();
    const [s1, s2] = await Promise.all([
      agent.subscribeFeed(a, "one", () => {}, { durable: true }),
      agent.subscribeFeed(b, "*", () => {}, { durable: true }),
    ]);
    expect(conn.added).toHaveLength(1);
    expect(conn.updated).toHaveLength(1);
    expect(conn.updated[0].config.filter_subjects).toEqual([`mesh.feed.${a}.one`, `mesh.feed.${b}.*`]);
    expect(conn.consumer.consume).toHaveBeenCalledTimes(1);
    await s1.stop();
    expect(conn.messages.stopCalls).toBe(0); // the other subscription still reads
    await s2.stop();
    expect(conn.messages.stopCalls).toBe(1);
    expect(conn.jsm.consumers.delete).not.toHaveBeenCalled(); // never deleted: it is the cursor
  });

  it("refuses loudly, never degrading to a live subscription, when JetStream refuses", async () => {
    const conn = makeConn({ jetstreamBroken: true });
    const agent = agentOn(conn);
    const owner = nkeys.createUser().getPublicKey();
    const err = await agent.subscribeFeed(owner, "ring-round", () => {}, { durable: true }).catch((e) => e);
    expect(err).toBeInstanceOf(MeshError);
    expect((err as MeshError).code).toBe(ErrorCode.DEPENDENCY_FAILED);
    expect(String((err as MeshError).message)).toMatch(/renewed/);
    expect(conn.subscribe).not.toHaveBeenCalled();
  });

  it("refuses a topic that is not one subject token", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const owner = nkeys.createUser().getPublicKey();
    expect(() => agent.subscribeFeed(owner, "ring.round", () => {}, { durable: true })).toThrow();
  });
});

describe("the durable feed loop", () => {
  it("dispatches a delivery (even an old one) to the matching handler and acks after it returns", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const ownerKp = nkeys.createUser();
    const owner = ownerKp.getPublicKey();
    const order: string[] = [];
    const seen: unknown[] = [];
    const sub = await agent.subscribeFeed(
      owner,
      "ring-round",
      (payload) => {
        order.push("handler");
        seen.push((payload as { data?: unknown }).data);
      },
      { durable: true },
    );
    const env = feedEnvelope(ownerKp, "ring-round", { lap_id: "L1" });
    env.ts = new Date(Date.now() - 20 * 60_000).toISOString(); // published while this agent was away
    const signed = signEnvelope({ ...env, sig: undefined } as unknown as Envelope, ownerKp);
    conn.messages.push({ data: encode(signed), subject: Subjects.feed(owner, "ring-round"), ack: () => order.push("ack") });
    await settle();
    expect(order).toEqual(["handler", "ack"]);
    expect(seen).toEqual([{ lap_id: "L1" }]);
    await sub.stop();
  });

  it("leaves a delivery unacked when the handler throws, so it is redelivered", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const ownerKp = nkeys.createUser();
    const owner = ownerKp.getPublicKey();
    const acks: string[] = [];
    const sub = await agent.subscribeFeed(owner, "ring-round", () => {
      throw new Error("handler broke");
    }, { durable: true });
    conn.messages.push({ data: encode(feedEnvelope(ownerKp, "ring-round", 1)), subject: Subjects.feed(owner, "ring-round"), ack: () => acks.push("ack") });
    await settle();
    expect(acks).toEqual([]);
    await sub.stop();
  });

  it("hands back a delivery for a feed no handler here follows yet, and acks undecodable bytes", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const ownerKp = nkeys.createUser();
    const owner = ownerKp.getPublicKey();
    const other = nkeys.createUser();
    const sub = await agent.subscribeFeed(owner, "ring-round", () => {}, { durable: true });
    const naks: Array<number | undefined> = [];
    const acks: string[] = [];
    conn.messages.push({
      data: encode(feedEnvelope(other, "news", 1)),
      subject: Subjects.feed(other.getPublicKey(), "news"),
      ack: () => acks.push("unclaimed"),
      nak: (ms) => naks.push(ms),
    });
    conn.messages.push({ data: new TextEncoder().encode("not json"), subject: Subjects.feed(owner, "ring-round"), ack: () => acks.push("junk") });
    await settle();
    expect(naks).toEqual([5_000]);
    expect(acks).toEqual(["junk"]);
    await sub.stop();
  });

  it("a `*` subscription claims every topic of that one owner and nobody else's", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    const ownerKp = nkeys.createUser();
    const owner = ownerKp.getPublicKey();
    const got: string[] = [];
    const sub = await agent.subscribeFeed(owner, "*", (p) => got.push(String((p as { topic?: string }).topic)), { durable: true });
    conn.messages.push({ data: encode(feedEnvelope(ownerKp, "a", 1)), subject: Subjects.feed(owner, "a"), ack: () => {} });
    conn.messages.push({ data: encode(feedEnvelope(ownerKp, "b", 2)), subject: Subjects.feed(owner, "b"), ack: () => {} });
    await settle();
    expect(got).toEqual(["a", "b"]);
    await sub.stop();
  });
});
