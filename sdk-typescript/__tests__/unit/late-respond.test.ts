/**
 * onLateRespond: a respond that names a request this agent no longer waits
 * on (its wait ended in a queued acknowledgement, or timed out) reaches the
 * listener once, so a sender can learn its message was picked up later. A
 * late answer to a call made with onLateAnswer still goes there, not to the
 * listener.
 */
import { describe, it, expect, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { makeBus, tick, type Bus } from "./a2a-bus.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { decodeUnverified, encode } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { MeshError, ErrorCode } from "../../src/types/errors.js";
import type { Envelope } from "../../src/types/envelope.js";

let bus: Bus;
afterEach(async () => {
  await bus.close();
});

/** A node that queues each request at once, then sends a second
 *  acknowledgement (the pickup) and, when asked, an answer. */
function laterAgent(opts: { answer: boolean }) {
  const kp = nkeys.createUser();
  const id = kp.getPublicKey();
  const seen: Envelope[] = [];
  bus.conn().subscribe(Subjects.agentInbox(id), (m: { data: Uint8Array }) => {
    const req = decodeUnverified(m.data);
    if (req.type !== "request") return;
    seen.push(req);
    const to = Subjects.agentInbox(req.from);
    const queued = () => signEnvelope(
      createEnvelope({ type: "respond", from: id, to: req.from, in_reply_to: req.id, payload: { output: { queued: true, inbox_id: req.id } } }),
      kp,
    );
    bus.publishRaw(to, encode(queued()));
    setTimeout(() => {
      bus.publishRaw(to, encode(queued()));
      if (opts.answer) {
        const real = signEnvelope(
          createEnvelope({ type: "respond", from: id, to: req.from, in_reply_to: req.id, v: "0.4.0", payload: { a2a: { result: { message: { messageId: "late", role: "ROLE_AGENT", parts: [{ text: "answered later" }] } } } } }),
          kp,
        );
        bus.publishRaw(to, encode(real));
      }
    }, 60);
  });
  return { id, seen };
}

describe("onLateRespond", () => {
  it("hands the later acknowledgement of a request nobody waits on to the listener, once, naming the request and the sender", async () => {
    bus = makeBus();
    const client = bus.agent();
    const agent = laterAgent({ answer: false });
    const got: Envelope[] = [];
    client.onLateRespond((env) => got.push(env));
    const err = (await client.a2a.sendMessage(agent.id, { messageId: "m", role: "ROLE_USER", parts: [{ text: "hi" }] }).catch((e) => e)) as MeshError;
    expect(err.code).toBe(ErrorCode.REQUEST_QUEUED);
    await tick(150);
    expect(got.length).toBe(1);
    expect(got[0].in_reply_to).toBe(agent.seen[0].id);
    expect(got[0].from).toBe(agent.id);
  });

  it("a late answer to a call with onLateAnswer goes there; only the acknowledgement reaches the listener", async () => {
    bus = makeBus();
    const client = bus.agent();
    const agent = laterAgent({ answer: true });
    const got: Envelope[] = [];
    const late: unknown[] = [];
    client.onLateRespond((env) => got.push(env));
    await client.a2a
      .sendMessage(agent.id, { messageId: "m", role: "ROLE_USER", parts: [{ text: "hi" }] }, { onLateAnswer: (a) => late.push(a) })
      .catch(() => null);
    await tick(150);
    expect(late.length).toBe(1);
    expect(got.length).toBe(1);
    expect((got[0].payload as { output?: { queued?: boolean } }).output?.queued).toBe(true);
  });

  it("stops when the listener is removed", async () => {
    bus = makeBus();
    const client = bus.agent();
    const agent = laterAgent({ answer: false });
    const got: Envelope[] = [];
    const stop = client.onLateRespond((env) => got.push(env));
    stop();
    await client.a2a.sendMessage(agent.id, { messageId: "m", role: "ROLE_USER", parts: [{ text: "hi" }] }).catch(() => null);
    await tick(150);
    expect(got).toEqual([]);
  });
});
