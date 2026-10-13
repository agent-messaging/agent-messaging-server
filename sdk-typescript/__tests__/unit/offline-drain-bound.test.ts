// §16.4: the mailbox drain is bounded to the backlog that existed when it bound.
//
// The mailbox stream (`MESH_INBOX_<agent>`) captures the same subject live
// messages arrive on, so a drain that keeps consuming competes with the live
// subscription for every live message. §22.2 dedup then decides which of the two
// dispatches runs — and the two answer DIFFERENT destinations: the live path
// answers the requester's transport-minted `_INBOX.` reply subject, the drain
// answers the sender's inbox, because a drained requester is assumed to be long
// gone. So an unbounded drain does not merely duplicate work; it makes the reply
// destination a race, and a requester whose message the drain won waits out its
// timeout with the answer sitting in its inbox instead.
//
// These run against a fake JetStream — no broker — because what needs pinning is
// the decision the drain makes about each sequence, not the transport.
import { describe, it, expect, vi } from "vitest";
import { nkeys } from "nats.ws";
import { MeshNode } from "../../src/node.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { MAILBOX_DRAIN_BATCH } from "../../src/constants.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { ConnectionManager } from "../../src/internal/connection.js";

type Kp = ReturnType<typeof nkeys.createUser>;

/** One message as the mailbox consumer hands it over: a STREAM sequence and the
 *  envelope it carries. */
type Held = { seq: number; env: Envelope };

/** What the fake JetStream is holding for one agent. */
type Mailbox = {
  /** The stream's last sequence at bind time — what the drain takes as its bound. */
  bound: number;
  /** What consumer info reports it still owes. Defaults to the scripted count. */
  numPending?: number;
  numAckPending?: number;
  /** Successive `fetch` results, in order. */
  batches: Held[][];
};

/** A connection fake whose JetStream side is a bound plus a script of successive
 *  `fetch` results, so a test can say exactly what the consumer hands over and
 *  when. Read through a holder because the envelopes are addressed to an agent
 *  id that does not exist until the node has made one. */
function makeConn(holder: { mailbox: Mailbox }) {
  const registryKp = nkeys.createUser();
  const published: { subject: string; data: Uint8Array }[] = [];
  const subscribed: string[] = [];
  /** Stream sequences the drain acked, in order. */
  const acked: number[] = [];
  /** `max_messages` asked for on each pull — its length is how many pulls happened. */
  const fetches: number[] = [];
  let queue: Held[][] | null = null;

  const counts = () => {
    const scripted = holder.mailbox.batches.reduce((n, b) => n + b.length, 0);
    return {
      num_pending: holder.mailbox.numPending ?? scripted,
      num_ack_pending: holder.mailbox.numAckPending ?? 0,
    };
  };
  const jsm = {
    streams: { info: vi.fn(async () => ({ state: { last_seq: holder.mailbox.bound } })) },
    consumers: { info: vi.fn(async () => counts()), add: vi.fn(async () => counts()) },
  };
  const consumer = {
    fetch: vi.fn(async (opts: { max_messages: number }) => {
      fetches.push(opts.max_messages);
      queue ??= [...holder.mailbox.batches];
      const batch = (queue.shift() ?? []).slice(0, opts.max_messages);
      return {
        stop: () => {},
        async *[Symbol.asyncIterator]() {
          for (const m of batch) {
            yield { seq: m.seq, data: encode(m.env), ack: () => acked.push(m.seq) };
          }
        },
      };
    }),
  };
  const raw = {
    jetstreamManager: vi.fn(async () => jsm),
    jetstream: vi.fn(() => ({ consumers: { get: vi.fn(async () => consumer) } })),
    publish: vi.fn((subject: string, data: Uint8Array) => published.push({ subject, data })),
  };

  const conn = {
    published,
    subscribed,
    acked,
    fetches,
    raw,
    publish: vi.fn((subject: string, data: Uint8Array) => published.push({ subject, data })),
    request: vi.fn(async (_subject: string, data: Uint8Array) => {
      const req = decode(data);
      return {
        data: encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: registryKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload: { status: "registered" },
            }),
            registryKp,
          ),
        ),
      };
    }),
    subscribe: vi.fn((subject: string) => {
      subscribed.push(subject);
      return { unsubscribe: () => {}, drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    get isClosed() {
      return false;
    },
  };
  return conn;
}

function request(senderKp: Kp, to: string, input: unknown): Envelope {
  return signEnvelope(
    createEnvelope({
      type: "request",
      from: senderKp.getPublicKey(),
      to,
      payload: { offering: "echo", input },
    }),
    senderKp,
  );
}

/** register() starts the drain without awaiting it, so give it room to finish.
 *  Every fake promise here resolves immediately; this is slack, not a timing
 *  dependency. */
async function drainSettled(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

/** Register one agent against a scripted mailbox and report what its drain did. */
async function drainOf(script: (agentId: string, senderKp: Kp) => Mailbox) {
  const senderKp = nkeys.createUser();
  const holder = { mailbox: { bound: 0, numPending: 0, batches: [] } as Mailbox };
  const conn = makeConn(holder);
  const node = MeshNode.withConnection(conn as unknown as ConnectionManager, nkeys.createUser());
  const agent = node.addAgent();
  holder.mailbox = script(agent.id, senderKp);
  const handled: unknown[] = [];
  agent.onRequest("echo", (input) => {
    handled.push(input);
    return { ok: true };
  });
  await agent.register({ name: "drainer" });
  await drainSettled();
  return { agent, conn, handled, senderKp };
}

describe("the §16.4 drain is bounded to the backlog present when it binds", () => {
  it("drains the backlog and stops at its last message", async () => {
    // Sequences 1 and 2 were waiting when the drain bound; 3 arrived while it was
    // working and is the live subscription's to answer.
    const { conn, handled } = await drainOf((agentId, senderKp) => ({
      bound: 2,
      numPending: 3,
      batches: [
        [
          { seq: 1, env: request(senderKp, agentId, { n: 1 }) },
          { seq: 2, env: request(senderKp, agentId, { n: 2 }) },
          { seq: 3, env: request(senderKp, agentId, { n: 3 }) },
        ],
      ],
    }));

    expect(handled).toEqual([{ n: 1 }, { n: 2 }]);
    // Acked after dispatch, and only what was dispatched.
    expect(conn.acked).toEqual([1, 2]);
    // Reaching the bound ends the drain: no second pull.
    expect(conn.fetches).toEqual([3]);
  });

  it("does not dispatch a message added to the stream after the bind", async () => {
    // The race, exactly. This durable is already caught up — its bound is the
    // sequence it drained last time — and the message the consumer hands over is
    // a LIVE one that landed a moment after the bind. The old unbounded drain
    // dispatched it and published the answer to the sender's inbox, while the
    // requester sat on its reply subject until it timed out.
    const { conn, handled, senderKp } = await drainOf((agentId, kp) => ({
      bound: 1,
      numPending: 1,
      batches: [[{ seq: 2, env: request(kp, agentId, { live: true }) }]],
    }));

    expect(handled).toEqual([]);
    // Not acked either: acking would be this path claiming a message it never
    // handled, and the live path owns it.
    expect(conn.acked).toEqual([]);
    const senderInbox = Subjects.agentInbox(senderKp.getPublicKey());
    expect(conn.published.filter((p) => p.subject === senderInbox)).toEqual([]);
    // One pull, then done — the drain does not sit there waiting for more.
    expect(conn.fetches).toEqual([1]);
  });

  it("stops immediately on an empty backlog instead of waiting on a pull", async () => {
    // A registered agent that missed nothing. Opening a pull here would wait out
    // its expiry for a message that is never coming, and would still be holding
    // the consumer open when live traffic arrived.
    const { conn, handled } = await drainOf(() => ({
      bound: 12,
      numPending: 0,
      numAckPending: 0,
      batches: [],
    }));

    expect(handled).toEqual([]);
    expect(conn.fetches).toEqual([]);
  });

  it("asks for no more than one batch at a time on a large backlog", async () => {
    // A 25 MB mailbox must not be pulled into memory in one request.
    const { conn } = await drainOf((agentId, senderKp) => ({
      bound: MAILBOX_DRAIN_BATCH + 50,
      numPending: MAILBOX_DRAIN_BATCH + 50,
      batches: [[{ seq: 1, env: request(senderKp, agentId, { n: 1 }) }]],
    }));

    expect(conn.fetches[0]).toBe(MAILBOX_DRAIN_BATCH);
  });

  it("leaves the agent registered and serving when the drain itself fails", async () => {
    // A failed drain is a degraded start, not a dead agent: the live subscription
    // is established before the drain begins, so the agent is reachable whatever
    // JetStream says.
    const holder = { mailbox: { bound: 3, numPending: 1, batches: [] } as Mailbox };
    const conn = makeConn(holder);
    conn.raw.jetstream = vi.fn(() => {
      throw new Error("no JetStream for this credential");
    }) as unknown as typeof conn.raw.jetstream;
    const node = MeshNode.withConnection(conn as unknown as ConnectionManager, nkeys.createUser());
    const agent = node.addAgent();
    await agent.register({ name: "degraded" });
    await drainSettled();

    expect(agent.registered).toBe(true);
    expect(conn.subscribed).toContain(Subjects.agentInbox(agent.id));
  });
});
