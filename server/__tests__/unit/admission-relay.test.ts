// The guarded relay after the §6.4 hard cutover.
//
// A guarded agent answers the RELAY on the transport reply subject (the
// guarded delivery is one of the two reply-subject exceptions), and §6.4a
// means the first thing it says there is the accept, with the substantive
// respond following. The sender, meanwhile, ignores every byte of data on its
// own reply subject and reads answers at its inbox. So the relay's job is to
// collect the agent's reply-subject stream and move bytes to where the
// receiver contract actually reads them: the accept and the substantive
// respond republished VERBATIM to the true sender's inbox, the reaper's probe
// answer kept on the reply subject (its caller is a single-reply request), and
// the benign ack - when nothing was heard at all - delivered to BOTH places,
// because the reaper listens on one and a §6.4 sender on the other.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEnvelope, decode, nkeys, Subjects } from "../../src/sdk.js";
import { sealEnvelope } from "../../src/shared/handler.js";
import type { AdmissionService as AdmissionServiceType } from "../../src/admission/admission-service.js";

const senderKp = nkeys.createUser();
const agentKp = nkeys.createUser();
const strangerKp = nkeys.createUser();
const SENDER = senderKp.getPublicKey();
const AGENT = agentKp.getPublicKey();
const GUARDED = `mesh.agent.${AGENT}.inbox.guarded`;
const SENDER_INBOX = Subjects.agentInbox(SENDER);

function requestBytes(offering = "summarize") {
  const env = createEnvelope({
    type: "request",
    from: SENDER,
    to: AGENT,
    payload: { offering, input: { q: 1 } },
  });
  return { id: env.id, bytes: sealEnvelope(env, senderKp) };
}

function respondBytes(
  kp: ReturnType<typeof nkeys.createUser>,
  inReplyTo: string,
  payload: Record<string, unknown>,
) {
  const env = createEnvelope({
    type: "respond",
    from: kp.getPublicKey(),
    to: SENDER,
    in_reply_to: inReplyTo,
    payload,
  });
  return sealEnvelope(env, kp);
}

/** A subscription the test can feed - what the relay's reply inbox becomes. */
function pushSub() {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(data: Uint8Array) {
      queue.push(data);
      wake?.();
      wake = null;
    },
    unsubscribe() {
      closed = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) {
          yield { data: queue.shift()! };
          continue;
        }
        if (closed) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  };
}

function makeNc() {
  const subs = new Map<string, ReturnType<typeof pushSub>>();
  const published: Array<{ subject: string; data: Uint8Array; opts?: { reply?: string } }> = [];
  const nc = {
    subscribe: vi.fn((subject: string) => {
      const s = pushSub();
      subs.set(subject, s);
      return s;
    }),
    publish: vi.fn((subject: string, data: Uint8Array, opts?: { reply?: string }) => {
      published.push({ subject, data, opts });
    }),
    request: vi.fn(async () => {
      throw new Error("unexpected nc.request - the relay must not single-reply anymore");
    }),
    jetstreamManager: vi.fn(async () => ({ streams: { info: vi.fn() } })),
  };
  return { nc, subs, published };
}

/** The published copies that landed on the sender's inbox, decoded. */
function atSenderInbox(published: Array<{ subject: string; data: Uint8Array }>) {
  return published.filter((p) => p.subject === SENDER_INBOX).map((p) => decode(p.data));
}

describe("the guarded relay (§6.4 cutover)", () => {
  let onInbox: (recipientId: string, guardedSubject: string, msg: unknown) => Promise<void>;
  let serviceId: string;
  let h: ReturnType<typeof makeNc>;

  beforeEach(async () => {
    // RELAY_TIMEOUT_MS is read at module load, so the short deadline the
    // timeout tests need has to be in place before the import.
    vi.stubEnv("ADMISSION_RELAY_TIMEOUT_MS", "250");
    vi.resetModules();
    const mod = await import("../../src/admission/admission-service.js");
    h = makeNc();
    const kvFake = {
      get: async () => null,
      put: async () => 1,
      delete: async () => undefined,
      purge: async () => undefined,
    };
    const js = { views: { kv: vi.fn(async () => kvFake) } };
    const svc = (await mod.AdmissionService.create(
      h.nc as never,
      js as never,
    )) as AdmissionServiceType;
    const priv = svc as unknown as {
      decide(recipientId: string, from: string): Promise<"relay" | "drop">;
      onInbox(recipientId: string, guardedSubject: string, msg: unknown): Promise<void>;
      kp: { getPublicKey(): string };
    };
    priv.decide = async () => "relay";
    onInbox = priv.onInbox.bind(svc);
    serviceId = priv.kp.getPublicKey();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Feed the relay's reply inbox as soon as the relay opens it. */
  function scriptAgentReplies(replies: Uint8Array[]) {
    h.nc.publish.mockImplementation((subject: string, data: Uint8Array, opts?: { reply?: string }) => {
      h.published.push({ subject, data, opts });
      if (subject === GUARDED && opts?.reply) {
        const relayInbox = h.subs.get(opts.reply);
        expect(relayInbox).toBeTruthy();
        for (const r of replies) relayInbox!.push(r);
      }
    });
  }

  it("republishes the accept and the substantive respond verbatim to the true sender's inbox", async () => {
    const { id, bytes } = requestBytes();
    const accept = respondBytes(agentKp, id, { status: "accepted" });
    const answer = respondBytes(agentKp, id, { status: "completed", output: { a: 42 } });
    scriptAgentReplies([accept, answer]);
    const respond = vi.fn();
    await onInbox(AGENT, GUARDED, { data: bytes, reply: "_INBOX.origcaller", respond });

    // The relayed delivery itself, with the relay's own reply inbox.
    const relayed = h.published.find((p) => p.subject === GUARDED);
    expect(relayed?.data).toBe(bytes);
    expect(relayed?.opts?.reply).toMatch(/^_INBOX\./);

    // Both the accept and the answer, at the sender's inbox, byte-identical -
    // the relay moves bytes, it never re-signs.
    const inboxCopies = h.published.filter((p) => p.subject === SENDER_INBOX);
    expect(inboxCopies.map((p) => p.data)).toEqual([accept, answer]);
    const decoded = atSenderInbox(h.published);
    expect(decoded.map((e) => (e.payload as { status?: string }).status)).toEqual([
      "accepted",
      "completed",
    ]);
    expect(decoded.every((e) => e.from === AGENT && e.in_reply_to === id)).toBe(true);

    // Nothing substantive on the sender's reply subject - and no benign ack,
    // because the exchange was answered.
    expect(respond).not.toHaveBeenCalled();
  });

  it("keeps a __registry_probe__ answer on the transport reply subject (the reaper's contract)", async () => {
    const { id, bytes } = requestBytes("__registry_probe__");
    const answer = respondBytes(agentKp, id, { status: "completed", output: { ok: true } });
    scriptAgentReplies([answer]);
    const respond = vi.fn();
    await onInbox(AGENT, GUARDED, { data: bytes, reply: "_INBOX.reaper", respond });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(answer);
    // The probe answer must NOT be re-routed to an inbox the reaper never reads.
    expect(h.published.filter((p) => p.subject === SENDER_INBOX)).toHaveLength(0);
  });

  it("answers nothing heard with the benign ack, on the reply subject AND at the sender's inbox", async () => {
    const { id, bytes } = requestBytes();
    scriptAgentReplies([]); // the agent never takes the delivery
    const respond = vi.fn();
    await onInbox(AGENT, GUARDED, { data: bytes, reply: "_INBOX.origcaller", respond });

    // Reply-subject copy: delivery status for single-reply callers.
    expect(respond).toHaveBeenCalledTimes(1);
    const replyAck = decode(respond.mock.calls[0][0] as Uint8Array);
    const ackOut = (replyAck.payload as { output?: { queued?: boolean; inbox_id?: string } }).output;
    expect(ackOut?.queued).toBe(true);
    expect(ackOut?.inbox_id).toBeTruthy();
    expect(replyAck.from).toBe(serviceId);
    expect(replyAck.in_reply_to).toBe(id);

    // Inbox copy: the one a §6.4 sender actually hears (its SDK ignores all
    // data on the reply subject), same signed bytes.
    const inboxCopies = h.published.filter((p) => p.subject === SENDER_INBOX);
    expect(inboxCopies).toHaveLength(1);
    expect(inboxCopies[0].data).toEqual(respond.mock.calls[0][0]);
  });

  it("sends no benign ack after an accept - silence then is the sender's own §6.4a story", async () => {
    const { id, bytes } = requestBytes();
    const accept = respondBytes(agentKp, id, { status: "accepted" });
    scriptAgentReplies([accept]); // admitted, then nothing before the deadline
    const respond = vi.fn();
    await onInbox(AGENT, GUARDED, { data: bytes, reply: "_INBOX.origcaller", respond });

    expect(respond).not.toHaveBeenCalled();
    const decoded = atSenderInbox(h.published);
    expect(decoded).toHaveLength(1);
    expect((decoded[0].payload as { status?: string }).status).toBe("accepted");
  });

  it("refuses to move bytes not signed by the guarded agent", async () => {
    const { id, bytes } = requestBytes();
    const forged = respondBytes(strangerKp, id, { status: "completed", output: { a: "forged" } });
    const answer = respondBytes(agentKp, id, { status: "completed", output: { a: "real" } });
    scriptAgentReplies([forged, answer]);
    const respond = vi.fn();
    await onInbox(AGENT, GUARDED, { data: bytes, reply: "_INBOX.origcaller", respond });

    const inboxCopies = h.published.filter((p) => p.subject === SENDER_INBOX);
    expect(inboxCopies).toHaveLength(1);
    expect(inboxCopies[0].data).toBe(answer);
  });

  it("passes a relayed RESPOND straight through - no reply collection, no benign ack", async () => {
    // §6.4 routes responds through the requester's inbox, so a guarded agent's
    // incoming ANSWERS traverse this relay too. An answer opens no exchange:
    // waiting a reply window for one would stall the guard's serial loop, and
    // acking it would drop junk in the responder's inbox.
    const env = createEnvelope({
      type: "respond",
      from: SENDER,
      to: AGENT,
      in_reply_to: "0198c000-0000-7000-8000-000000000000",
      payload: { status: "completed", output: {} },
    });
    const bytes = sealEnvelope(env, senderKp);
    const respond = vi.fn();
    await onInbox(AGENT, GUARDED, { data: bytes, respond });

    const relayed = h.published.filter((p) => p.subject === GUARDED);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].data).toBe(bytes);
    expect(relayed[0].opts?.reply).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
    expect(h.published.filter((p) => p.subject !== GUARDED)).toHaveLength(0);
  });
});
