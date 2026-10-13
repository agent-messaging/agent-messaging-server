// The §6.4 hard cutover of the bare-mode reply path.
//
// A respond to a bare-mode request is PUBLISHED TO THE REQUESTER'S INBOX
// subject, correlated by in_reply_to; response data is never published to the
// transport reply subject. The reply subject still exists, but it is
// liveness-only: it carries the server's no-responders verdict and nothing the
// requester reads. Two exceptions answer on the transport reply subject: the
// registry reaper's `__registry_probe__` (cheap liveness, no inbox round
// trip), and a request DELIVERED ON THE GUARDED INBOX SUBJECT (EXT-6: the
// requester of record there is the admission guard relay, which forwards the
// answer itself).
//
// The drained-respond destination (unchanged: the sender's inbox) is pinned by
// offline-drain-redrain.test.ts and the buffered cases of
// inbound-fence.test.ts; task-mode flows are pinned by budget.test.ts,
// cancel.test.ts and task-tracker.test.ts.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode, MeshError } from "../../src/types/errors.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { RespondPayload } from "../../src/types/primitives.js";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

function makeConn() {
  const subs = new Map<string, (msg: unknown) => void>();
  const registryKp = nkeys.createUser();
  const published: { subject: string; data: Uint8Array }[] = [];
  const conn = {
    subs,
    published,
    // Loop back to a matching subscription, the way the broker would.
    publish: vi.fn((subject: string, data: Uint8Array) => {
      published.push({ subject, data });
      subs.get(subject)?.({ subject, data, reply: undefined, respond: () => true });
    }),
    request: vi.fn(async (_subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
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
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
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
  return conn;
}
type Conn = ReturnType<typeof makeConn>;

async function makeResponder(conn: Conn, offering = "work") {
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
    { fenceInbound: false },
  );
  openAgents.push(agent);
  agent.onRequest(offering, (input) => ({ echoed: input }));
  await agent.register({ name: "cutover-responder" });
  return agent;
}

function requestEnvelope(senderKp: KeyPair, to: string, offering: string, input: unknown): Envelope {
  return signEnvelope(
    createEnvelope({
      type: "request",
      from: senderKp.getPublicKey(),
      to,
      payload: { offering, input },
    }),
    senderKp,
  );
}

/** Deliver one request on the named subject and report both channels: what the
 *  transport reply subject saw (`replyData`) and what reached the sender's
 *  inbox (`inboxData`). */
async function deliverOn(
  conn: Conn,
  deliverySubject: string,
  handlerSubject: string,
  env: Envelope,
): Promise<{ replyData: Uint8Array[]; inboxData: Envelope[] }> {
  const replyData: Uint8Array[] = [];
  const inboxData: Envelope[] = [];
  conn.subs.set(Subjects.agentInbox(env.from), (m) => {
    inboxData.push(decode((m as { data: Uint8Array }).data));
  });
  const cb = conn.subs.get(handlerSubject);
  if (!cb) throw new Error("agent is not listening on its inbox");
  cb({
    subject: deliverySubject,
    data: encode(env),
    reply: "_INBOX.cutover-test",
    respond: (d: Uint8Array) => {
      replyData.push(d);
      return true;
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  return { replyData, inboxData };
}

describe("§6.4 responder side: the inbox is the reply channel", () => {
  it("publishes the bare respond to the requester's inbox; NOTHING is published to the reply subject", async () => {
    const conn = makeConn();
    const agent = await makeResponder(conn);
    const senderKp = nkeys.createUser();
    const env = requestEnvelope(senderKp, agent.id, "work", { q: 1 });

    const { replyData, inboxData } = await deliverOn(
      conn,
      Subjects.agentInbox(agent.id),
      Subjects.agentInbox(agent.id),
      env,
    );

    // The reply subject carried no data at all: not the accept, not the answer.
    expect(replyData).toEqual([]);

    // The sender's inbox got the §6.4a accept and then the terminal respond,
    // each correlated to the request by in_reply_to.
    expect(inboxData.length).toBe(2);
    expect((inboxData[0].payload as RespondPayload).status).toBe("accepted");
    const terminal = inboxData[1];
    expect((terminal.payload as RespondPayload).status).toBe("completed");
    expect((terminal.payload as RespondPayload).output).toEqual({ echoed: { q: 1 } });
    expect(terminal.in_reply_to).toBe(env.id);
    expect(terminal.to).toBe(senderKp.getPublicKey());
    // Bare mode: no task on the wire.
    expect(terminal.task_id ?? null).toBeNull();
  });

  it("answers a request that arrived with NO reply subject at all: the destination never depended on one", async () => {
    const conn = makeConn();
    const agent = await makeResponder(conn);
    const senderKp = nkeys.createUser();
    const env = requestEnvelope(senderKp, agent.id, "work", { q: 2 });

    const inboxData: Envelope[] = [];
    conn.subs.set(Subjects.agentInbox(senderKp.getPublicKey()), (m) => {
      inboxData.push(decode((m as { data: Uint8Array }).data));
    });
    conn.subs.get(Subjects.agentInbox(agent.id))!({
      subject: Subjects.agentInbox(agent.id),
      data: encode(env),
      reply: undefined,
      respond: () => true,
    });
    await new Promise((r) => setTimeout(r, 10));
    const terminal = inboxData.find((e) => (e.payload as RespondPayload).status !== "accepted");
    expect(terminal).toBeDefined();
    expect((terminal!.payload as RespondPayload).output).toEqual({ echoed: { q: 2 } });
  });
});

describe("the §6.4a queued-ack exception: an attended node's ack rides the transport reply subject", () => {
  it("sends the queued ack on the reply subject, carries nothing of the answer, and leaves the sender's inbox silent", async () => {
    const conn = makeConn();
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
      { fenceInbound: false },
    );
    openAgents.push(agent);
    agent.onRequest("chat", () => ({ queued: true, inbox_id: "inbox-c13", text: "held for a live session" }));
    await agent.register({ name: "cutover-attended", interaction: "interactive" });
    const senderKp = nkeys.createUser();
    const env = requestEnvelope(senderKp, agent.id, "chat", { text: "hi" });

    const { replyData, inboxData } = await deliverOn(
      conn,
      Subjects.agentInbox(agent.id),
      Subjects.agentInbox(agent.id),
      env,
    );

    // Interactive agents never send the accept (§6.4a: nothing is about to
    // run), so the ONE thing on the reply subject is the queued ack itself.
    expect(replyData.length).toBe(1);
    const ack = decode(replyData[0]);
    expect(ack.in_reply_to).toBe(env.id);
    const out = (ack.payload as RespondPayload).output as { queued?: boolean; inbox_id?: string };
    expect(out.queued).toBe(true);
    expect(out.inbox_id).toBe("inbox-c13");
    // The ack is the node speaking about delivery, not the agent answering:
    // the sender's inbox sees nothing until a live session really replies.
    expect(inboxData).toEqual([]);
  });

  it("the shape alone is not the signal: a service agent returning {queued, inbox_id} still answers at the sender's inbox", async () => {
    const conn = makeConn();
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
      { fenceInbound: false },
    );
    openAgents.push(agent);
    agent.onRequest("chat", () => ({ queued: true, inbox_id: "not-an-attended-node" }));
    await agent.register({ name: "cutover-service" });
    const senderKp = nkeys.createUser();
    const env = requestEnvelope(senderKp, agent.id, "chat", { text: "hi" });

    const { replyData, inboxData } = await deliverOn(
      conn,
      Subjects.agentInbox(agent.id),
      Subjects.agentInbox(agent.id),
      env,
    );

    // Ordinary service flow: reply subject data-free, accept then the result
    // at the sender's inbox — the §6.4a carve-out is gated on the DECLARED
    // interaction, not on what a handler happens to return.
    expect(replyData).toEqual([]);
    expect(inboxData.length).toBe(2);
    expect((inboxData[0].payload as RespondPayload).status).toBe("accepted");
    expect(((inboxData[1].payload as RespondPayload).output as { queued?: boolean }).queued).toBe(true);
  });
});

describe("§11.3 stream mode: the OPENING respond is not an exception", () => {
  it("publishes the initial working respond to the requester's inbox; chunks keep the task stream subject", async () => {
    const conn = makeConn();
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
      { fenceInbound: false },
    );
    openAgents.push(agent);
    agent.onStreamRequest("work", (_input, _ctx, writer) => {
      writer.write({ part: 1 });
      writer.end();
    });
    await agent.register({ name: "cutover-streamer" });

    const senderKp = nkeys.createUser();
    const env = signEnvelope(
      createEnvelope({
        type: "request",
        from: senderKp.getPublicKey(),
        to: agent.id,
        task_id: "stream-task-1",
        payload: { offering: "work", input: "go", config: { stream: true } },
      }),
      senderKp,
    );
    const { replyData, inboxData } = await deliverOn(
      conn,
      Subjects.agentInbox(agent.id),
      Subjects.agentInbox(agent.id),
      env,
    );

    // Nothing on the reply subject, opening respond included.
    expect(replyData).toEqual([]);
    // The sender's inbox got the accept and the §11.3 opening "working"
    // respond, task_id and all, correlated by in_reply_to.
    const opening = inboxData.find((e) => (e.payload as RespondPayload).status === "working");
    expect(opening).toBeDefined();
    expect(opening!.task_id).toBe("stream-task-1");
    expect(opening!.in_reply_to).toBe(env.id);
    // Chunks stayed on the task's own stream subject, unchanged. (Not decoded
    // here: §11.6 signs the FINAL chunk, and intermediate chunks are unsigned
    // unless the requester asked.)
    const chunks = conn.published.filter((p) => p.subject === Subjects.taskStream("stream-task-1"));
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("the __registry_probe__ exception: cheap, on the reply subject, no accept in front", () => {
  it("answers the probe on the transport reply subject and sends nothing to the sender's inbox", async () => {
    const conn = makeConn();
    const agent = await makeResponder(conn, "__registry_probe__");
    const senderKp = nkeys.createUser();
    const env = requestEnvelope(senderKp, agent.id, "__registry_probe__", null);

    const { replyData, inboxData } = await deliverOn(
      conn,
      Subjects.agentInbox(agent.id),
      Subjects.agentInbox(agent.id),
      env,
    );

    // Exactly ONE reply on the reply subject: the answer, with no accept in
    // front of it: the reaper reads a single reply.
    expect(replyData.length).toBe(1);
    const reply = decode(replyData[0]);
    expect((reply.payload as RespondPayload).output).toEqual({ echoed: null });
    expect((reply.payload as RespondPayload).status).toBe("completed");
    expect(reply.in_reply_to).toBe(env.id);

    // And no inbox round trip.
    expect(inboxData).toEqual([]);
  });

  it("refuses to reflect: a probe whose reply subject is not transport-minted is answered nowhere", async () => {
    const conn = makeConn();
    const agent = await makeResponder(conn, "__registry_probe__");
    const senderKp = nkeys.createUser();
    const env = requestEnvelope(senderKp, agent.id, "__registry_probe__", null);

    const replyData: Uint8Array[] = [];
    conn.subs.get(Subjects.agentInbox(agent.id))!({
      subject: Subjects.agentInbox(agent.id),
      data: encode(env),
      reply: "mesh.somebody.elses.subject", // publisher-chosen, not _INBOX.
      respond: (d: Uint8Array) => {
        replyData.push(d);
        return true;
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(replyData).toEqual([]);
    expect(conn.published.filter((p) => p.subject === "mesh.somebody.elses.subject")).toEqual([]);
  });
});

describe("the guarded-inbox exception: the admission relay's reply subject is the destination", () => {
  it("a request DELIVERED on .inbox.guarded is answered on its reply subject; the same shape on the plain inbox goes to the sender's inbox", async () => {
    const conn = makeConn();
    const agent = await makeResponder(conn);
    const senderKp = nkeys.createUser();

    // Guarded delivery: the admission guard relayed it, and the guard's
    // request-reply is how the answer travels back to the true sender.
    const guardedEnv = requestEnvelope(senderKp, agent.id, "work", { via: "guard" });
    const guarded = await deliverOn(
      conn,
      Subjects.agentInboxGuarded(agent.id),
      Subjects.agentInbox(agent.id),
      guardedEnv,
    );
    // Accept + terminal, BOTH on the relay's reply subject; nothing bypasses
    // the guard by going to the sender's inbox directly.
    expect(guarded.replyData.length).toBe(2);
    const guardedTerminal = decode(guarded.replyData[1]);
    expect((guardedTerminal.payload as RespondPayload).status).toBe("completed");
    expect(guardedTerminal.in_reply_to).toBe(guardedEnv.id);
    expect(guarded.inboxData).toEqual([]);

    // Plain delivery of a fresh request follows the inbox rule unconditionally.
    const plainEnv = requestEnvelope(senderKp, agent.id, "work", { via: "plain" });
    const plain = await deliverOn(
      conn,
      Subjects.agentInbox(agent.id),
      Subjects.agentInbox(agent.id),
      plainEnv,
    );
    expect(plain.replyData).toEqual([]);
    expect(
      plain.inboxData.some(
        (e) => (e.payload as RespondPayload).status === "completed" && e.in_reply_to === plainEnv.id,
      ),
    ).toBe(true);
  });
});

describe("§6.4 requester side: the pending request resolves from the inbox", () => {
  it("resolves a bare request from a respond delivered at its own inbox", async () => {
    const conn = makeConn();
    const responderKp = nkeys.createUser();
    conn.request.mockImplementation(async (subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      if (subject.endsWith(".inbox")) {
        const bytes = encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: responderKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload: { status: "completed", output: { answer: 42 } },
            }),
            responderKp,
          ),
        );
        conn.subs.get(Subjects.agentInbox(req.from))?.({
          subject: Subjects.agentInbox(req.from),
          data: bytes,
          reply: undefined,
          respond: () => true,
        });
        // The reply subject stays silent, like the wire will.
        return await new Promise<never>(() => {});
      }
      throw new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "not a subject this test answers");
    });
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);

    const result = await caller.request(responderKp.getPublicKey(), "work", "go");
    expect((result.payload as RespondPayload).output).toEqual({ answer: 42 });
    expect(result.task_id).toBeNull();
    // Making the request is what subscribed the caller's inbox.
    expect(conn.subs.has(Subjects.agentInbox(caller.id))).toBe(true);
  });

  it("ignores DATA arriving on the reply subject: a reply-subject answer resolves nothing", async () => {
    const conn = makeConn();
    const responderKp = nkeys.createUser();
    // The connection resolves the request() with a well-formed, correctly
    // signed and correlated respond: exactly what the OLD contract accepted.
    // Nothing is delivered to the inbox.
    conn.request.mockImplementation(async (_subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      return {
        data: encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: responderKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload: { status: "completed", output: { stolen: true } },
            }),
            responderKp,
          ),
        ),
      };
    });
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);

    // The wait ends on ITS OWN timeout, wrapped in the §16.4 mailbox story,
    // never on the reply-subject data.
    await expect(
      caller.request(responderKp.getPublicKey(), "work", "go", { timeout_ms: 80 }),
    ).rejects.toMatchObject({ code: ErrorCode.AGENT_UNAVAILABLE });
  });

  it("keeps fast offline detection: no-responders still rejects immediately", async () => {
    const conn = makeConn();
    conn.request.mockImplementation(async (subject: string) => {
      throw new MeshError(
        ErrorCode.TRANSPORT_NO_RESPONDERS,
        `No responders on subject '${subject}'`,
      );
    });
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);

    // Wrapped exactly as before (§16.4: offline-with-a-mailbox story), with a
    // generous timeout that proves the rejection did not wait for it.
    const t0 = Date.now();
    await expect(
      caller.request(nkeys.createUser().getPublicKey(), "work", "go", { timeout_ms: 30_000 }),
    ).rejects.toMatchObject({ code: ErrorCode.AGENT_UNAVAILABLE });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("still honors the node's queued ack ON THE REPLY SUBJECT: REQUEST_QUEUED, not a timeout", async () => {
    // The EXT-6 admission service answers a held/dropped delivery with the
    // benign queued ack on the sender's reply subject, synchronously. That is
    // the one delivery-status signal the reply subject still carries, and it
    // must keep producing the REQUEST_QUEUED story rather than degrading into
    // "may just be offline".
    const conn = makeConn();
    const guardKp = nkeys.createUser(); // the admission service's key
    const inboxId = "held-0001";
    conn.request.mockImplementation(async (_subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      return {
        data: encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: guardKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload: { output: { queued: true, inbox_id: inboxId, text: "Delivered to the recipient's inbox." } },
            }),
            guardKp,
          ),
        ),
      };
    });
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);
    const queued: unknown[] = [];
    let thrown: MeshError | undefined;
    try {
      await caller.request(nkeys.createUser().getPublicKey(), "chat", "hi", {
        timeout_ms: 5_000,
        onQueued: (ack) => queued.push(ack),
      });
    } catch (err) {
      thrown = err as MeshError;
    }
    expect(thrown?.code).toBe(ErrorCode.REQUEST_QUEUED);
    expect(thrown?.details).toMatchObject({ queued: true, inbox_id: inboxId });
    expect(queued).toHaveLength(1);
  });

  it("resolves a still-open wait from an inbox-mode answer: a fresh request threading in_reply_to", async () => {
    const conn = makeConn();
    const responderKp = nkeys.createUser();
    conn.request.mockImplementation(async (subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      if (subject.endsWith(".inbox")) {
        // The node's answer arrives as a FRESH REQUEST to the requester's
        // inbox, in_reply_to naming the original request (the adapter shape).
        const answer = signEnvelope(
          createEnvelope({
            type: "request",
            from: responderKp.getPublicKey(),
            to: req.from,
            in_reply_to: req.id,
            payload: { offering: "chat", input: { text: "the real answer" } },
          }),
          responderKp,
        );
        conn.subs.get(Subjects.agentInbox(req.from))?.({
          subject: Subjects.agentInbox(req.from),
          data: encode(answer),
          reply: undefined,
          respond: () => true,
        });
        return await new Promise<never>(() => {});
      }
      throw new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "not a subject this test answers");
    });
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
      { fenceInbound: false },
    );
    openAgents.push(caller);
    // No handler registered for "chat": if the answer were DISPATCHED instead
    // of correlated, it would earn an OFFERING_NOT_FOUND reply, asserted absent
    // below.
    const result = await caller.request(responderKp.getPublicKey(), "chat", "hi");
    expect((result.envelope.payload as { input?: unknown }).input).toEqual({
      text: "the real answer",
    });
    expect(result.task_id).toBeNull();
    expect(
      conn.published.filter((p) => p.subject === Subjects.agentInbox(responderKp.getPublicKey())),
    ).toEqual([]);
  });

  it("a third party threading a stolen in_reply_to resolves nothing", async () => {
    const conn = makeConn();
    const responderKp = nkeys.createUser();
    const thiefKp = nkeys.createUser();
    conn.request.mockImplementation(async (subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      if (subject.endsWith(".inbox")) {
        const forged = signEnvelope(
          createEnvelope({
            type: "request",
            from: thiefKp.getPublicKey(), // not the addressed agent
            to: req.from,
            in_reply_to: req.id,
            payload: { offering: "chat", input: { text: "gotcha" } },
          }),
          thiefKp,
        );
        conn.subs.get(Subjects.agentInbox(req.from))?.({
          subject: Subjects.agentInbox(req.from),
          data: encode(forged),
          reply: undefined,
          respond: () => true,
        });
        return await new Promise<never>(() => {});
      }
      throw new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "not a subject this test answers");
    });
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
      { fenceInbound: false },
    );
    openAgents.push(caller);
    // The forged answer does not resolve the wait; it times out into the
    // §16.4 mailbox story instead.
    await expect(
      caller.request(responderKp.getPublicKey(), "chat", "hi", { timeout_ms: 80 }),
    ).rejects.toMatchObject({ code: ErrorCode.AGENT_UNAVAILABLE });
  });

  it("a respond correlating to nothing pending is dropped in silence", async () => {
    const conn = makeConn();
    const responderKp = nkeys.createUser();
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);
    await caller.register({ name: "cutover-caller" });

    const stray = signEnvelope(
      createEnvelope({
        type: "respond",
        from: responderKp.getPublicKey(),
        to: caller.id,
        in_reply_to: "01890000-0000-7000-8000-000000000000",
        payload: { status: "completed", output: { late: true } },
      }),
      responderKp,
    );
    expect(() =>
      conn.subs.get(Subjects.agentInbox(caller.id))!({
        subject: Subjects.agentInbox(caller.id),
        data: encode(stray),
        reply: undefined,
        respond: () => true,
      }),
    ).not.toThrow();
    // Nothing was published in reaction to it.
    expect(conn.published.filter((p) => p.subject.includes(responderKp.getPublicKey()))).toEqual([]);
  });
});
