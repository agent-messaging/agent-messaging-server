// §16.4: the bounded drain is RE-RUN — on reconnect, and periodically.
//
// The bound (offline-drain-bound.test.ts) closed a race and opened a different
// hole. A pass stops at the stream's last sequence, so everything the mailbox
// captures after that — which is every live message, because the mailbox stream
// captures the very subject the live subscription is on — stays on the durable
// consumer undelivered and unacked. The cursor stops where the pass left it, the
// tail grows for the life of the process, and the next restart binds, sees the
// whole tail as backlog, and dispatches it: handlers re-run, answers go to
// senders' inboxes, and the fresh process's §22.2 memory cannot suppress any of
// it, because that memory does not survive a restart.
//
// So the fix is not a bigger bound, it is more passes. What these pin:
//
//  - a re-drain ACKS what the live path already handled instead of dispatching
//    it again (the §22.2 memory is what makes that possible, and the interval is
//    chosen so the tail stays inside it — see DEFAULT_MAILBOX_DRAIN_INTERVAL_MS);
//  - a re-drain DISPATCHES what the live path missed, which is the reconnect-gap
//    case the reconnect trigger exists for;
//  - each pass reads a FRESH last sequence, so repeating the drain does not
//    weaken the bound;
//  - two triggers landing together do not run two passes over one consumer.
//
// Against a fake JetStream — no broker — because what needs pinning is the
// decision each pass makes, not the transport.
import { describe, it, expect, vi } from "vitest";
import { nkeys } from "nats.ws";
import { MeshNode } from "../../src/node.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { MIN_MAILBOX_DRAIN_INTERVAL_MS } from "../../src/constants.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { Msg } from "nats.ws";
import type { ConnectionManager } from "../../src/internal/connection.js";

type Kp = ReturnType<typeof nkeys.createUser>;

/** One message as the mailbox consumer hands it over. */
type Held = { seq: number; env: Envelope };

/** What one drain PASS finds: the stream's last sequence at that moment, what
 *  the consumer says it still owes, and the batches it hands over. Passes are
 *  consumed in order; a pass beyond the script finds a caught-up mailbox. */
type Pass = {
  bound: number;
  numPending?: number;
  numAckPending?: number;
  batches: Held[][];
  /** Held before the batch yields anything, to keep a pass suspended. */
  hold?: Promise<void>;
};

function makeConn(holder: { passes: Pass[] }) {
  const registryKp = nkeys.createUser();
  const published: { subject: string; data: Uint8Array }[] = [];
  const subscribed: string[] = [];
  /** Live inbox handlers, by subject, so a test can deliver a live message. */
  const liveHandlers = new Map<string, (msg: Msg) => void>();
  /** Reconnect callbacks the SDK registered on the transport. */
  const reconnectCbs: (() => void)[] = [];
  const acked: number[] = [];
  const fetches: number[] = [];

  let passIndex = -1;
  let queue: Held[][] = [];
  const current = (): Pass =>
    holder.passes[passIndex] ?? {
      // A caught-up mailbox: the head is wherever the last scripted pass left
      // it, and there is nothing pending, so no pull is issued at all.
      bound: holder.passes[holder.passes.length - 1]?.bound ?? 0,
      numPending: 0,
      numAckPending: 0,
      batches: [],
    };
  const counts = () => {
    const p = current();
    const scripted = p.batches.reduce((n, b) => n + b.length, 0);
    return {
      num_pending: p.numPending ?? scripted,
      num_ack_pending: p.numAckPending ?? 0,
    };
  };

  const jsm = {
    streams: {
      // The first call of every pass, and therefore where a pass begins: it
      // advances the script and republishes that pass's bound.
      info: vi.fn(async () => {
        passIndex++;
        const p = current();
        queue = [...p.batches];
        return { state: { last_seq: p.bound } };
      }),
    },
    consumers: { info: vi.fn(async () => counts()), add: vi.fn(async () => counts()) },
  };
  const consumer = {
    fetch: vi.fn(async (opts: { max_messages: number }) => {
      fetches.push(opts.max_messages);
      const hold = current().hold;
      const batch = (queue.shift() ?? []).slice(0, opts.max_messages);
      return {
        stop: () => {},
        async *[Symbol.asyncIterator]() {
          if (hold) await hold;
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
    liveHandlers,
    reconnectCbs,
    acked,
    fetches,
    jsm,
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
    subscribe: vi.fn((subject: string, handler: (msg: Msg) => void) => {
      subscribed.push(subject);
      liveHandlers.set(subject, handler);
      return { unsubscribe: () => {}, drain: async () => {} };
    }),
    onReconnect: vi.fn((cb: () => void) => {
      reconnectCbs.push(cb);
      return () => {
        const i = reconnectCbs.indexOf(cb);
        if (i >= 0) reconnectCbs.splice(i, 1);
      };
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

/** Whether encoded reply bytes are the §6.4a accept signal. On the LIVE path
 *  it precedes every admitted dispatch; on the DRAIN path it must never
 *  appear at all — §6.4a makes the accept a live-delivery signal only. */
function isAccept(data: Uint8Array): boolean {
  try {
    const env = JSON.parse(new TextDecoder().decode(data)) as Envelope;
    return (env.payload as { status?: string } | undefined)?.status === "accepted";
  } catch {
    return false;
  }
}

/** Passes are started without being awaited, so give them room. Every fake
 *  promise resolves immediately; this is slack, not a timing dependency. */
async function settled(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 5));
}

/** One registered agent over a scripted mailbox, plus the handles a test needs
 *  to drive the live path and the triggers. */
async function agentOn(
  script: (agentId: string, senderKp: Kp) => Pass[],
  opts?: { mailboxDrainIntervalMs?: number },
) {
  const senderKp = nkeys.createUser();
  const holder = { passes: [] as Pass[] };
  const conn = makeConn(holder);
  const node = MeshNode.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    undefined,
    { mailboxDrainIntervalMs: opts?.mailboxDrainIntervalMs },
  );
  const agent = node.addAgent();
  holder.passes = script(agent.id, senderKp);
  const handled: unknown[] = [];
  agent.onRequest("echo", (input) => {
    handled.push(input);
    return { ok: true };
  });
  await agent.register({ name: "redrainer" });
  await settled();

  /** Deliver one envelope on the LIVE inbox subscription, as the transport
   *  would. §6.4 cutover: the live path's answers no longer ride the reply
   *  subject either; they are published to the sender's inbox, so tests read
   *  them from `answersTo`. */
  const deliverLive = async (env: Envelope): Promise<void> => {
    const handler = conn.liveHandlers.get(Subjects.agentInbox(agent.id));
    if (!handler) throw new Error("the agent is not listening on its inbox");
    handler({
      data: encode(env),
      reply: "_INBOX.live-requester",
      respond: () => true,
    } as unknown as Msg);
    await settled(4);
  };
  /** Fire the transport's reconnect event, which is what the SDK subscribed to. */
  const reconnect = async (): Promise<void> => {
    for (const cb of [...conn.reconnectCbs]) cb();
    await settled();
  };
  /** Everything this agent published into one sender's inbox: the single
   *  destination every answer goes to since the §6.4 cutover, live and
   *  drained alike. */
  const answersTo = (senderPub: string) =>
    conn.published.filter((p) => p.subject === Subjects.agentInbox(senderPub));
  /** Answers to the scripted BUFFERED sender's inbox. */
  const drainAnswers = () => answersTo(senderKp.getPublicKey());
  /** Accept-shaped traffic to the buffered sender's inbox. MUST stay empty
   *  (§6.4a: "a mailbox-drain dispatch MUST NOT emit an accept"). */
  const drainAccepts = () => drainAnswers().filter((p) => isAccept(p.data));

  return {
    agent,
    conn,
    handled,
    senderKp,
    deliverLive,
    reconnect,
    answersTo,
    drainAnswers,
    drainAccepts,
  };
}

describe("the §16.4 drain is re-run, and each re-run is bounded afresh", () => {
  it("registers for the transport's reconnect event rather than polling", async () => {
    const { conn } = await agentOn(() => [{ bound: 0, numPending: 0, batches: [] }]);
    // nats.ws reports a reconnect on its status iterator; the SDK subscribes to
    // that. A poll of connection state would learn "connected" long after the
    // gap it is supposed to react to.
    expect(conn.onReconnect).toHaveBeenCalledTimes(1);
    expect(conn.reconnectCbs.length).toBe(1);
  });

  it("acks — without re-dispatching — what the live path already handled", async () => {
    // Pass 1 drains the one genuinely buffered message (seq 1). Then a live
    // message arrives and the live subscription answers it at ITS sender's
    // inbox (§6.4 cutover: the same destination the drain uses). The mailbox
    // captured that message too (seq 2), unacked, above pass 1's bound. The
    // re-drain must clear it from the consumer WITHOUT running the handler a
    // second time and WITHOUT answering it a second time; §22.2 dedup is what
    // keeps the redundant copy from becoming a duplicate answer.
    const kp = nkeys.createUser();
    let live: Envelope | null = null;
    const h = await agentOn((agentId, senderKp) => {
      live = request(kp, agentId, { live: true });
      return [
        { bound: 1, numPending: 1, batches: [[{ seq: 1, env: request(senderKp, agentId, { buffered: true }) }]] },
        { bound: 2, numPending: 1, batches: [[{ seq: 2, env: live! }]] },
      ];
    });

    expect(h.handled).toEqual([{ buffered: true }]);
    await h.deliverLive(live!);
    expect(h.handled).toEqual([{ buffered: true }, { live: true }]);
    // The live path answered at the live sender's inbox: one §6.4a accept
    // plus one substantive answer.
    expect(h.answersTo(kp.getPublicKey()).length).toBe(2);
    expect(h.answersTo(kp.getPublicKey()).filter((p) => isAccept(p.data)).length).toBe(1);

    await h.reconnect();

    // Handled once, by the live path. Acked twice, so the cursor is at the head.
    expect(h.handled).toEqual([{ buffered: true }, { live: true }]);
    expect(h.conn.acked).toEqual([1, 2]);
    // Nothing more reached the live sender's inbox: the re-drain acked the
    // redundant copy without answering it again.
    expect(h.answersTo(kp.getPublicKey()).length).toBe(2);
    // And exactly one answer went to the buffered sender's inbox.
    expect(h.drainAnswers().length).toBe(1);
    // §6.4a: the accept is a live-delivery signal only — the drained dispatch
    // ran a live handler, and still MUST NOT have emitted one.
    expect(h.drainAccepts()).toEqual([]);
  });

  it("dispatches what the live path missed during a reconnect gap", async () => {
    // Same shape, minus the live delivery: the message landed while the live
    // subscription was down, so nothing dispatched it and nothing is in the
    // §22.2 memory to suppress it. Without the re-drain this sat in the mailbox
    // until the next restart.
    const kp = nkeys.createUser();
    const h = await agentOn((agentId, senderKp) => [
      { bound: 1, numPending: 1, batches: [[{ seq: 1, env: request(senderKp, agentId, { buffered: true }) }]] },
      { bound: 2, numPending: 1, batches: [[{ seq: 2, env: request(kp, agentId, { missed: true }) }]] },
    ]);

    expect(h.handled).toEqual([{ buffered: true }]);
    await h.reconnect();

    expect(h.handled).toEqual([{ buffered: true }, { missed: true }]);
    expect(h.conn.acked).toEqual([1, 2]);
    // Answered at the sender's inbox, which is where §16.4 puts the answer to a
    // message whose live reply subject is gone — and answered WITHOUT an
    // accept: a drain dispatch never emits one (§6.4a, live-delivery only).
    const missedSenderInbox = Subjects.agentInbox(kp.getPublicKey());
    const toMissedSender = h.conn.published.filter((p) => p.subject === missedSenderInbox);
    expect(toMissedSender.length).toBeGreaterThan(0);
    expect(toMissedSender.every((p) => !isAccept(p.data))).toBe(true);
    expect(h.drainAccepts()).toEqual([]);
  });

  it("reads a fresh last sequence on every pass, and still stops at it", async () => {
    // Pass 2's bound is 2. Under pass 1's stale bound (1) seq 2 would not have
    // been dispatched at all; with no bound seq 3 would have been. Exactly one of
    // the two moves.
    const h = await agentOn((agentId, senderKp) => [
      { bound: 1, numPending: 1, batches: [[{ seq: 1, env: request(senderKp, agentId, { n: 1 }) }]] },
      {
        bound: 2,
        numPending: 2,
        batches: [
          [
            { seq: 2, env: request(senderKp, agentId, { n: 2 }) },
            { seq: 3, env: request(senderKp, agentId, { n: 3 }) },
          ],
        ],
      },
    ]);

    await h.reconnect();

    expect(h.conn.jsm.streams.info).toHaveBeenCalledTimes(2);
    expect(h.handled).toEqual([{ n: 1 }, { n: 2 }]);
    // seq 3 arrived after pass 2 bound: not dispatched, and not acked either —
    // acking it would be this path claiming a message it never handled.
    expect(h.conn.acked).toEqual([1, 2]);
  });

  it("runs one pass at a time, however many triggers land together", async () => {
    // Pass 1 is suspended mid-batch. Three reconnects arrive while it is. None of
    // them may open a second pass over the same durable consumer: two passes
    // would each take their own bound and each dispatch from the same cursor.
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const h = await agentOn((agentId, senderKp) => [
      { bound: 1, numPending: 1, hold, batches: [[{ seq: 1, env: request(senderKp, agentId, { n: 1 }) }]] },
      { bound: 2, numPending: 1, batches: [[{ seq: 2, env: request(senderKp, agentId, { n: 2 }) }]] },
    ]);

    // Still suspended: one pass started, nothing dispatched yet.
    expect(h.conn.jsm.streams.info).toHaveBeenCalledTimes(1);
    expect(h.handled).toEqual([]);

    await h.reconnect();
    await h.reconnect();
    await h.reconnect();
    expect(h.conn.jsm.streams.info).toHaveBeenCalledTimes(1);
    expect(h.conn.fetches.length).toBe(1);

    release();
    await settled();
    expect(h.handled).toEqual([{ n: 1 }]);

    // The mutex was released with the pass, not left held: the next trigger runs.
    await h.reconnect();
    expect(h.conn.jsm.streams.info).toHaveBeenCalledTimes(2);
    expect(h.handled).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("re-drains on the interval with no reconnect at all", async () => {
    // The backstop trigger. Configured at the floor so the test can wait for it;
    // the default is DEFAULT_MAILBOX_DRAIN_INTERVAL_MS (60s), sized against the
    // §22.2 memory rather than against a test's patience.
    const h = await agentOn(
      (agentId, senderKp) => [
        { bound: 1, numPending: 1, batches: [[{ seq: 1, env: request(senderKp, agentId, { n: 1 }) }]] },
        { bound: 2, numPending: 1, batches: [[{ seq: 2, env: request(senderKp, agentId, { n: 2 }) }]] },
      ],
      { mailboxDrainIntervalMs: MIN_MAILBOX_DRAIN_INTERVAL_MS },
    );

    expect(h.handled).toEqual([{ n: 1 }]);
    await new Promise((r) => setTimeout(r, MIN_MAILBOX_DRAIN_INTERVAL_MS + 400));
    expect(h.handled).toEqual([{ n: 1 }, { n: 2 }]);
    expect(h.conn.acked).toEqual([1, 2]);
  }, 10_000);

  it("keeps re-draining after a pass fails outright", async () => {
    // A JetStream blip must not disarm the triggers: the mailbox is reachable
    // again later, and the tail keeps growing in the meantime.
    // Three scripted passes: the buffered one, the pass that dies, and the pass
    // after it — which finds the same message still there, because a failed pass
    // acks nothing.
    const h = await agentOn((agentId, senderKp) => [
      { bound: 1, numPending: 1, batches: [[{ seq: 1, env: request(senderKp, agentId, { n: 1 }) }]] },
      { bound: 2, numPending: 1, batches: [[{ seq: 2, env: request(senderKp, agentId, { n: 2 }) }]] },
      { bound: 2, numPending: 1, batches: [[{ seq: 2, env: request(senderKp, agentId, { n: 2 }) }]] },
    ]);
    expect(h.handled).toEqual([{ n: 1 }]);

    const good = h.conn.raw.jetstream;
    h.conn.raw.jetstream = vi.fn(() => {
      throw new Error("JetStream API unreachable");
    }) as unknown as typeof h.conn.raw.jetstream;
    await h.reconnect();
    expect(h.handled).toEqual([{ n: 1 }]);

    // …and the pass after it works, from the bound it finds then.
    h.conn.raw.jetstream = good;
    await h.reconnect();
    expect(h.handled).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("stops re-draining once the agent is closed", async () => {
    const h = await agentOn((agentId, senderKp) => [
      { bound: 1, numPending: 1, batches: [[{ seq: 1, env: request(senderKp, agentId, { n: 1 }) }]] },
      { bound: 2, numPending: 1, batches: [[{ seq: 2, env: request(senderKp, agentId, { n: 2 }) }]] },
    ]);
    await h.agent.close();
    // The reconnect callback was dropped, so nothing is left to fire; and even a
    // retained one would find the subsystem disarmed.
    expect(h.conn.reconnectCbs.length).toBe(0);
    await h.reconnect();
    expect(h.handled).toEqual([{ n: 1 }]);
    expect(h.conn.jsm.streams.info).toHaveBeenCalledTimes(1);
  });
});
