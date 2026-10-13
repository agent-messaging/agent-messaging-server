// The witness fold - the audit chains' durable backstop - driven over a fake
// JetStream. What these pin is the fold's judgment per delivery: a capture
// younger than the hold window goes back (nak, positive delay) so the live
// tap keeps first claim; an aged capture the tap already chained folds to
// nothing; an aged capture nobody chained becomes exactly one "witnessed"
// pair; poison bytes are dropped (acked), never redelivered forever; and a
// redelivery of an already-folded capture appends nothing.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AckPolicy, DeliverPolicy } from "nats";
import { AuditLog } from "../../src/activity/audit-log.js";
import { WitnessFold } from "../../src/activity/witness-fold.js";
import { createEnvelope, nkeys } from "../../src/sdk.js";
import { sealEnvelope } from "../../src/shared/handler.js";

const AGENT = "UAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const kp = nkeys.createUser();

/** Signed envelope bytes with a chosen age. `ts` is set BEFORE sealing, so
 *  the signature covers the backdated claim the way a real sender's would. */
function envelopeBytes(
  over: { type?: "request" | "respond"; ageMs?: number; payload?: unknown; inReplyTo?: string } = {},
) {
  const env = createEnvelope({
    type: over.type ?? "request",
    from: kp.getPublicKey(),
    to: AGENT,
    in_reply_to: over.inReplyTo,
    payload: over.payload ?? { offering: "summarize", input: { q: 1 } },
  });
  env.ts = new Date(Date.now() - (over.ageMs ?? 0)).toISOString();
  return { id: env.id, bytes: sealEnvelope(env, kp) };
}

interface FakeMsg {
  data: Uint8Array;
  acked: boolean;
  nakDelay: number | null;
  ack(): void;
  nak(ms?: number): void;
}

function fakeMsg(data: Uint8Array): FakeMsg {
  return {
    data,
    acked: false,
    nakDelay: null,
    ack() {
      this.acked = true;
    },
    nak(ms?: number) {
      this.nakDelay = ms ?? 0;
    },
  };
}

/**
 * The minimum of JetStream the fold touches: streams.list yields MESH_INBOX_
 * stream infos, consumers.info throws once so consumers.add runs, and each
 * stream's consume() replays a scripted message list. `settled` resolves when
 * every scripted message has been delivered, so tests await real completion
 * instead of sleeping.
 */
function harness(streams: Record<string, FakeMsg[]>, opts: { consumerExists?: boolean } = {}) {
  const added: Array<[string, Record<string, unknown>]> = [];
  let remaining = Object.values(streams).reduce((n, msgs) => n + msgs.length, 0);
  let settle: () => void;
  const settled = new Promise<void>((r) => (settle = r));
  if (remaining === 0) settle!();

  const jsm = {
    streams: {
      list: () =>
        (async function* () {
          for (const name of Object.keys(streams)) yield { config: { name } };
          yield { config: { name: "MESH_METERING" } }; // a non-mailbox stream must be ignored
        })(),
    },
    consumers: {
      info: async () => {
        if (opts.consumerExists) return {};
        throw new Error("consumer not found");
      },
      add: async (stream: string, cfg: Record<string, unknown>) => {
        added.push([stream, cfg]);
      },
    },
  };
  const js = {
    consumers: {
      get: async (stream: string) => ({
        consume: async () => {
          const msgs = streams[stream] ?? [];
          return {
            stopped: false,
            stop() {
              this.stopped = true;
            },
            async *[Symbol.asyncIterator]() {
              for (const m of msgs) {
                yield m;
                if (--remaining === 0) settle();
              }
            },
          };
        },
      }),
    },
  };
  const nc = { jetstreamManager: async () => jsm };
  return { nc, js, added, settled };
}

describe("the witness fold", () => {
  let dir: string;
  let log: AuditLog;
  let fold: WitnessFold;

  function fresh(): AuditLog {
    dir = mkdtempSync(join(tmpdir(), "witness-"));
    log = new AuditLog(join(dir, "audit.db"));
    return log;
  }

  async function drive(streams: Record<string, FakeMsg[]>, opts: { consumerExists?: boolean } = {}) {
    const h = harness(streams, opts);
    fold = new WitnessFold(h.nc as never, h.js as never, fresh());
    await fold.start();
    await h.settled;
    return h;
  }

  afterEach(() => {
    fold?.stop();
    log?.close();
    // Windows holds SQLite WAL files briefly even after close; a failed tmp
    // cleanup is not a failed test.
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leaked tmpdir on Windows - harmless */
    }
  });

  it("ensures the durable consumer on each mailbox stream, and only there", async () => {
    const m = fakeMsg(envelopeBytes({ ageMs: 0 }).bytes);
    const h = await drive({ [`MESH_INBOX_${AGENT}`]: [m] });
    expect(h.added).toHaveLength(1);
    expect(h.added[0][0]).toBe(`MESH_INBOX_${AGENT}`);
    expect(h.added[0][1]).toMatchObject({
      durable_name: "audit_witness",
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
    });
  });

  it("does not re-add a consumer that already exists", async () => {
    const m = fakeMsg(envelopeBytes({ ageMs: 20 * 60_000 }).bytes);
    const h = await drive({ [`MESH_INBOX_${AGENT}`]: [m] }, { consumerExists: true });
    expect(h.added).toHaveLength(0);
    expect(m.acked).toBe(true);
  });

  it("naks a young capture with a positive delay and appends nothing", async () => {
    const m = fakeMsg(envelopeBytes({ ageMs: 0 }).bytes);
    await drive({ [`MESH_INBOX_${AGENT}`]: [m] });
    expect(m.acked).toBe(false);
    expect(m.nakDelay).toBeGreaterThan(0);
    expect(m.nakDelay).toBeLessThanOrEqual(10 * 60_000);
    expect(log.list([AGENT], 10)).toHaveLength(0);
  });

  it("acks an aged capture the tap already chained, without appending", async () => {
    const { id, bytes } = envelopeBytes({ ageMs: 20 * 60_000 });
    const audit = fresh();
    audit.appendExchange({
      from: kp.getPublicKey(),
      to: AGENT,
      skill: "summarize",
      requestId: id,
      status: "completed",
    });
    const before = audit.list([AGENT], 10).length;
    const m = fakeMsg(bytes);
    const h = harness({ [`MESH_INBOX_${AGENT}`]: [m] });
    fold = new WitnessFold(h.nc as never, h.js as never, audit);
    await fold.start();
    await h.settled;
    expect(m.acked).toBe(true);
    expect(m.nakDelay).toBeNull();
    expect(audit.list([AGENT], 10)).toHaveLength(before);
  });

  it("an unknown aged request produces exactly the witnessed pair, then acks", async () => {
    const { id, bytes } = envelopeBytes({ ageMs: 20 * 60_000 });
    const m = fakeMsg(bytes);
    await drive({ [`MESH_INBOX_${AGENT}`]: [m] });
    expect(m.acked).toBe(true);
    const served = log.list([AGENT], 10);
    const requested = log.list([kp.getPublicKey()], 10);
    expect(served).toHaveLength(1);
    expect(requested).toHaveLength(1);
    expect(served[0]).toMatchObject({
      role: "served",
      status: "witnessed",
      request_id: id,
      skill: "summarize",
      counterparty: kp.getPublicKey(),
      duration_ms: null,
    });
    expect(served[0].input_sha256).toBeTruthy();
    expect(log.verifyChain(AGENT)).toEqual({ ok: true, count: 1 });
    expect(log.verifyChain(kp.getPublicKey())).toEqual({ ok: true, count: 1 });
  });

  it("acks undecodable bytes without appending (poison policy)", async () => {
    const garbage = fakeMsg(new TextEncoder().encode("not an envelope"));
    // Structurally fine but unsigned: decode must reject it the same way.
    const unsigned = createEnvelope({ type: "request", from: kp.getPublicKey(), to: AGENT, payload: {} });
    unsigned.ts = new Date(Date.now() - 20 * 60_000).toISOString();
    const unsignedMsg = fakeMsg(new TextEncoder().encode(JSON.stringify(unsigned)));
    await drive({ [`MESH_INBOX_${AGENT}`]: [garbage, unsignedMsg] });
    expect(garbage.acked).toBe(true);
    expect(unsignedMsg.acked).toBe(true);
    expect(log.list([AGENT], 10)).toHaveLength(0);
  });

  it("acks a capture claiming to be older than the mailbox window, without appending", async () => {
    const m = fakeMsg(envelopeBytes({ ageMs: 8 * 24 * 3600_000 }).bytes);
    await drive({ [`MESH_INBOX_${AGENT}`]: [m] });
    expect(m.acked).toBe(true);
    expect(log.list([AGENT], 10)).toHaveLength(0);
  });

  it("a second delivery of the same capture does not double-append", async () => {
    const { bytes } = envelopeBytes({ ageMs: 20 * 60_000 });
    const first = fakeMsg(bytes);
    const again = fakeMsg(bytes);
    await drive({ [`MESH_INBOX_${AGENT}`]: [first, again] });
    expect(first.acked).toBe(true);
    expect(again.acked).toBe(true);
    expect(log.list([AGENT], 10)).toHaveLength(1);
    expect(log.verifyChain(AGENT)).toEqual({ ok: true, count: 1 });
  });

  it("skips envelope types that are not request or respond", async () => {
    const env = createEnvelope({ type: "emit", from: kp.getPublicKey(), to: AGENT, payload: {} });
    env.ts = new Date(Date.now() - 20 * 60_000).toISOString();
    const m = fakeMsg(sealEnvelope(env, kp));
    await drive({ [`MESH_INBOX_${AGENT}`]: [m] });
    expect(m.acked).toBe(true);
    expect(log.list([AGENT], 10)).toHaveLength(0);
  });

  // ── Responds in a requester's mailbox (the §6.4 reply channel) ───────────

  it("folds §6.4a signals to nothing - an accept or a queued ack is not an exchange", async () => {
    const reqId = "0198c000-0000-7000-8000-00000000c001";
    const accept = fakeMsg(
      envelopeBytes({ type: "respond", ageMs: 20 * 60_000, inReplyTo: reqId, payload: { status: "accepted" } }).bytes,
    );
    const queuedAck = fakeMsg(
      envelopeBytes({
        type: "respond",
        ageMs: 20 * 60_000,
        inReplyTo: reqId,
        payload: { output: { queued: true, inbox_id: "mb-1", text: "Delivered." } },
      }).bytes,
    );
    await drive({ [`MESH_INBOX_${AGENT}`]: [accept, queuedAck] });
    expect(accept.acked).toBe(true);
    expect(queuedAck.acked).toBe(true);
    expect(log.list([AGENT, kp.getPublicKey()], 10)).toHaveLength(0);
  });

  it("a respond nobody chained witnesses its EXCHANGE - keyed by the request's id, direction read in reverse", async () => {
    const reqId = "0198c000-0000-7000-8000-00000000c002";
    const { bytes } = envelopeBytes({
      type: "respond",
      ageMs: 20 * 60_000,
      inReplyTo: reqId,
      payload: { status: "completed", output: { a: 1 } },
    });
    // The same capture twice: the redelivery must find the exchange under the
    // request's id and fold to nothing.
    const first = fakeMsg(bytes);
    const again = fakeMsg(bytes);
    await drive({ [`MESH_INBOX_${AGENT}`]: [first, again] });
    expect(first.acked).toBe(true);
    expect(again.acked).toBe(true);

    // One pair. On a respond, the envelope's `from` is the agent that SERVED
    // and its `to` the one that ASKED - the request's direction, reversed.
    const served = log.list([kp.getPublicKey()], 10);
    const requested = log.list([AGENT], 10);
    expect(served).toHaveLength(1);
    expect(requested).toHaveLength(1);
    expect(served[0]).toMatchObject({
      role: "served",
      status: "witnessed",
      request_id: reqId,
      counterparty: AGENT,
    });
    expect(requested[0]).toMatchObject({
      role: "requested",
      status: "witnessed",
      request_id: reqId,
      counterparty: kp.getPublicKey(),
    });
  });

  it("a respond whose exchange the tap already chained appends nothing", async () => {
    const reqId = "0198c000-0000-7000-8000-00000000c003";
    const audit = fresh();
    audit.appendExchange({
      from: AGENT,
      to: kp.getPublicKey(),
      skill: "summarize",
      requestId: reqId,
      status: "completed",
    });
    const before = audit.list([AGENT, kp.getPublicKey()], 10).length;
    const m = fakeMsg(
      envelopeBytes({
        type: "respond",
        ageMs: 20 * 60_000,
        inReplyTo: reqId,
        payload: { status: "completed", output: {} },
      }).bytes,
    );
    const h = harness({ [`MESH_INBOX_${AGENT}`]: [m] });
    fold = new WitnessFold(h.nc as never, h.js as never, audit);
    await fold.start();
    await h.settled;
    expect(m.acked).toBe(true);
    expect(audit.list([AGENT, kp.getPublicKey()], 10)).toHaveLength(before);
  });
});
