/**
 * A queued acknowledgement on an A2A call (SPEC.md §6.4a): the call rejects
 * with REQUEST_QUEUED, saying whether the message was delivered, and the A2A
 * answer that arrives later from the same agent, naming the request, reaches
 * `onLateAnswer`. An answer from anyone else does not.
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

/** A node that queues every request for an attended session, then answers
 *  it later (and an impostor that answers first). */
function queuingAgent(opts: { delivered: boolean }) {
  const kp = nkeys.createUser();
  const id = kp.getPublicKey();
  const impostor = nkeys.createUser();
  const seen: Envelope[] = [];
  bus.conn().subscribe(Subjects.agentInbox(id), (m: { data: Uint8Array }) => {
    const req = decodeUnverified(m.data);
    if (req.type !== "request") return;
    seen.push(req);
    const to = Subjects.agentInbox(req.from);
    const ack = signEnvelope(
      createEnvelope({ type: "respond", from: id, to: req.from, in_reply_to: req.id, payload: { output: { queued: true, inbox_id: req.id, ...(opts.delivered ? { delivered: true } : {}) } } }),
      kp,
    );
    bus.publishRaw(to, encode(ack));
    setTimeout(() => {
      const fake = signEnvelope(
        createEnvelope({ type: "respond", from: impostor.getPublicKey(), to: req.from, in_reply_to: req.id, v: "0.4.0", payload: { a2a: { result: { message: { messageId: "x", role: "ROLE_AGENT", parts: [{ text: "forged" }] } } } } }),
        impostor,
      );
      bus.publishRaw(to, encode(fake));
      const real = signEnvelope(
        createEnvelope({ type: "respond", from: id, to: req.from, in_reply_to: req.id, v: "0.4.0", payload: { a2a: { result: { message: { messageId: "late", role: "ROLE_AGENT", parts: [{ text: "answered later" }] } } } } }),
        kp,
      );
      bus.publishRaw(to, encode(real));
    }, 60);
  });
  return { id, seen };
}

describe("a queued A2A call", () => {
  it("rejects with REQUEST_QUEUED, says it was delivered, and hands the later answer from the same agent to onLateAnswer", async () => {
    bus = makeBus();
    const client = bus.agent();
    const agent = queuingAgent({ delivered: true });
    const late: unknown[] = [];
    const err = (await client.a2a
      .sendMessage(agent.id, { messageId: "m", role: "ROLE_USER", parts: [{ text: "hi" }] }, { onLateAnswer: (a, rid) => late.push({ a, rid }) })
      .catch((e) => e)) as MeshError;
    expect(err).toBeInstanceOf(MeshError);
    expect(err.code).toBe(ErrorCode.REQUEST_QUEUED);
    expect(err.details).toMatchObject({ queued: true, delivered: true, request_id: agent.seen[0].id });
    await tick(150);
    expect(late).toEqual([{ a: { result: { message: { messageId: "late", role: "ROLE_AGENT", parts: [{ text: "answered later" }] } } }, rid: agent.seen[0].id }]);
  });

  it("a message held at the door says so: no delivered", async () => {
    bus = makeBus();
    const client = bus.agent();
    const agent = queuingAgent({ delivered: false });
    const err = (await client.a2a.sendMessage(agent.id, { messageId: "m", role: "ROLE_USER", parts: [{ text: "hi" }] }).catch((e) => e)) as MeshError;
    expect(err.code).toBe(ErrorCode.REQUEST_QUEUED);
    expect(err.details?.delivered).toBeUndefined();
  });
});
