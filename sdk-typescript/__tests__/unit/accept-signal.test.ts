// The accept signal (SPEC.md §6.4a; reconciled wording in §6.4/§6.5/§7.0),
// asserted case by case against conformance/accept-signal.json.
//
// Like the other conformance suites, this file ITERATES the fixture instead of
// restating its cases: the fixture pins the wire shape of the accept — the
// non-terminal respond a responder's SDK MUST emit the moment a live handler
// admits a request, before the handler runs — and the node-level queued
// acknowledgement it must never be confused with. The ordering cases are each
// driven through a real dispatch, and an ordering case this file does not know
// how to drive FAILS the suite rather than being skipped.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src to agree with the fixture — never the fixture to agree
// with the code (the fixture changes only with a spec change alongside).
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nkeys } from "nats.ws";
import type { KeyPair, Msg } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import {
  signEnvelope,
  canonicalEnvelopeBytes,
  signedEnvelopeBytes,
  fromB64Url,
  ENVELOPE_SIG_PREFIX,
} from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode, MeshError } from "../../src/types/errors.js";
import { budgetInsufficient } from "../../src/budget.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { RespondPayload, QueuedAck } from "../../src/types/primitives.js";

// ── the fixture ─────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(here, "..", "..", "..", "conformance", "accept-signal.json");

interface OrderingCase {
  id: string;
  scenario: string;
  accept_sent: boolean;
  first_reply: string;
  then?: string;
}

interface Fixture {
  version: number;
  spec: string;
  identities: { sender_seed: string; responder: string; requester: string };
  accept: {
    required: {
      type: string;
      payload_status: string;
      in_reply_to: string;
      task_id: string;
      terminal: boolean;
      emitted_before_handler: boolean;
    };
    envelope: { signed_bytes_prefix: string; canonical: string; signed: Envelope };
  };
  ordering: { cases: OrderingCase[] };
  queued_ack: {
    shape: { queued: boolean; inbox_id: string; text: string };
    pinned: string[];
    disjointness: string;
  };
  caller_semantics: Record<string, string>;
}

const F: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

// ── the fixture's really-signed accept ──────────────────────────────────────

describe("§6.4a accept envelope — the pinned wire shape", () => {
  const signed = F.accept.envelope.signed;

  it("reproduces the fixture's canonical bytes exactly", () => {
    const canonical = new TextDecoder().decode(canonicalEnvelopeBytes(signed));
    expect(canonical).toBe(F.accept.envelope.canonical);
  });

  it("the signature verifies via decode()", () => {
    expect(() => decode(encode(signed))).not.toThrow();
  });

  it("the signature covers signed_bytes_prefix + canonical, strictly tagged (§5.3)", () => {
    expect(F.accept.envelope.signed_bytes_prefix).toBe(ENVELOPE_SIG_PREFIX);
    expect(
      nkeys
        .fromPublic(signed.from)
        .verify(signedEnvelopeBytes(signed), fromB64Url(signed.sig!)),
    ).toBe(true);
  });

  it("has the required shape: respond, status accepted, in_reply_to set, task_id absent on the wire", () => {
    expect(signed.type).toBe(F.accept.required.type);
    expect((signed.payload as RespondPayload).status).toBe(F.accept.required.payload_status);
    expect(typeof signed.in_reply_to).toBe("string");
    expect("task_id" in signed).toBe(false); // §5.3 absent-members rule
    expect(signed.error ?? undefined).toBeUndefined();
  });

  it("the fixture's roles are flipped as documented: the published seed is the RESPONDER", () => {
    const kp = nkeys.fromSeed(new TextEncoder().encode(F.identities.sender_seed));
    expect(kp.getPublicKey()).toBe(F.identities.responder);
    expect(signed.from).toBe(F.identities.responder);
    expect(signed.to).toBe(F.identities.requester);
  });
});

// ── responder-side harness ──────────────────────────────────────────────────

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

function makeConn() {
  const subs = new Map<string, (msg: unknown) => void>();
  const registryKp = nkeys.createUser();
  const published: { subject: string; data: Uint8Array }[] = [];
  return {
    subs,
    published,
    // Loop back to a matching subscription, the way the broker would: since
    // the §6.4 cutover, responds travel by publish to the sender's inbox.
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
}
type Conn = ReturnType<typeof makeConn>;

async function makeAgent(opts: {
  conn?: Conn;
  interaction?: "service" | "interactive";
  maxInboundChars?: number;
  handler?: (input: unknown) => unknown;
  admit?: () => void;
  offering?: string;
  onHandlerStart?: () => void;
}) {
  const conn = opts.conn ?? makeConn();
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
    { maxInboundChars: opts.maxInboundChars },
  );
  openAgents.push(agent);
  if (opts.handler) {
    agent.onRequest(
      opts.offering ?? "chat",
      (input) => {
        opts.onHandlerStart?.();
        return opts.handler!(input);
      },
      opts.admit ? { admit: opts.admit } : undefined,
    );
  }
  await agent.register({ name: "accept-signal", interaction: opts.interaction });
  return { conn, agent };
}

/** Deliver a signed request on the live inbox; return the replies made. */
function deliver(
  conn: Conn,
  agentId: string,
  senderKp: KeyPair,
  payload: unknown,
  over: Partial<Envelope> = {},
  /** Dispatch runs synchronously up to the handler, so a caller that needs to
   *  observe replies FROM INSIDE the handler must own the array up front. */
  sink?: Uint8Array[],
  /** What the transport reply subject saw — empty for every flow except the
   *  §6.4a queued ack, the one respond that rides it (attended_inbox). */
  replySink?: Uint8Array[],
): Uint8Array[] {
  const env = createEnvelope({
    type: "request",
    from: senderKp.getPublicKey(),
    to: agentId,
    payload,
  });
  Object.assign(env, over);
  const signed = signEnvelope(env, senderKp);
  const replies: Uint8Array[] = sink ?? [];
  const cb = conn.subs.get(Subjects.agentInbox(agentId));
  if (!cb) throw new Error("agent is not listening on its inbox");
  // §6.4 cutover: replies land on the SENDER's inbox (via the fake's publish
  // loopback), not on the reply subject.
  conn.subs.set(Subjects.agentInbox(senderKp.getPublicKey()), (m) => {
    replies.push((m as { data: Uint8Array }).data);
  });
  cb({
    subject: Subjects.agentInbox(agentId),
    data: encode(signed),
    reply: "_INBOX.accept-signal",
    respond: (d: Uint8Array) => {
      replySink?.push(d);
      return true;
    },
  });
  return replies;
}

const decoded = (replies: Uint8Array[]) => replies.map((d) => decode(d));
const isAccept = (e: Envelope) => (e.payload as RespondPayload | undefined)?.status === "accepted";

// ── ordering cases, each driven through a real dispatch ─────────────────────

describe("§6.4a ordering — refusals of admission instead of an accept, work failures after one", () => {
  const drivers: Record<string, (c: OrderingCase) => Promise<void>> = {
    async admitted_live(c) {
      let acceptedBeforeHandler = false;
      const replies: Uint8Array[] = [];
      const { conn, agent } = await makeAgent({
        handler: () => ({ ok: true }),
        onHandlerStart: () => {
          // §6.4a: emitted BEFORE the handler is invoked.
          acceptedBeforeHandler =
            replies.length > 0 && isAccept(decode(replies[0]));
        },
      });
      deliver(conn, agent.id, nkeys.createUser(), { offering: "chat", input: "hi" }, {}, replies);
      await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(2));
      const [first, second] = decoded(replies);
      expect(c.accept_sent).toBe(true);
      expect(isAccept(first)).toBe(true);
      expect(acceptedBeforeHandler).toBe(true);
      // The accept: non-terminal, in_reply_to, task_id absent on the wire.
      expect(typeof first.in_reply_to).toBe("string");
      expect("task_id" in (JSON.parse(new TextDecoder().decode(replies[0])) as object)).toBe(
        false,
      );
      // Then the first SUBSTANTIVE respond — here a bare terminal — which is
      // what tells the requester the mode (§7.0).
      expect((second.payload as RespondPayload).status).toBe("completed");
      expect(second.task_id ?? null).toBeNull();
    },

    async budget_refused_at_admission(c) {
      const estimate = { amount_micro: 9_000_000, currency: "USD" };
      const { conn, agent } = await makeAgent({
        handler: () => ({ ok: true }),
        admit: () => {
          throw budgetInsufficient(estimate);
        },
      });
      const replies = deliver(conn, agent.id, nkeys.createUser(), {
        offering: "chat",
        input: "hi",
      });
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
      const all = decoded(replies);
      expect(c.accept_sent).toBe(false);
      expect(all.some(isAccept)).toBe(false);
      expect(all[0].error).toMatchObject({
        code: ErrorCode.BUDGET_INSUFFICIENT,
        details: { estimate },
      });
    },

    async oversize_refused(c) {
      const { conn, agent } = await makeAgent({
        handler: () => ({ ok: true }),
        maxInboundChars: 8,
      });
      const replies = deliver(conn, agent.id, nkeys.createUser(), {
        offering: "chat",
        input: "well over eight units",
      });
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
      const all = decoded(replies);
      expect(c.accept_sent).toBe(false);
      expect(all.some(isAccept)).toBe(false);
      expect(all[0].error).toMatchObject({
        code: ErrorCode.CONTEXT_TOO_LARGE,
        retryable: false,
      });
    },

    async stale_or_misaddressed(c) {
      const { conn, agent } = await makeAgent({ handler: () => ({ ok: true }) });
      // Stale: ts outside the §22.3 live window.
      const stale = deliver(
        conn,
        agent.id,
        nkeys.createUser(),
        { offering: "chat", input: "hi" },
        { ts: new Date(Date.now() - 11 * 60_000).toISOString() },
      );
      // Misaddressed: `to` names somebody else.
      const misaddressed = deliver(
        conn,
        agent.id,
        nkeys.createUser(),
        { offering: "chat", input: "hi" },
        { to: nkeys.createUser().getPublicKey() },
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(c.accept_sent).toBe(false);
      expect(stale.length).toBe(0); // silent by design (§22.7)
      expect(misaddressed.length).toBe(0);
    },

    async attended_inbox(c) {
      // The reference-adapter shape: an `interactive` agent's handler queues
      // the message and answers the §6.4a queued ack. The SDK MUST NOT put an
      // accept in front of it — nothing is about to run — and the ack rides
      // the TRANSPORT REPLY SUBJECT (§6.4a, §18.7): it is the node speaking
      // about delivery, not the agent answering, so the sender's inbox stays
      // silent until a live session really replies.
      const inboxId = "0198c001-0000-7000-8000-0000000000ff";
      const { conn, agent } = await makeAgent({
        interaction: "interactive",
        handler: () => ({ queued: true, inbox_id: inboxId, text: "delivered to inbox" }),
      });
      const inboxReplies: Uint8Array[] = [];
      const ackReplies: Uint8Array[] = [];
      deliver(
        conn,
        agent.id,
        nkeys.createUser(),
        { offering: "chat", input: "hi" },
        {},
        inboxReplies,
        ackReplies,
      );
      await vi.waitFor(() => expect(ackReplies.length).toBeGreaterThan(0));
      const all = decoded(ackReplies);
      expect(c.accept_sent).toBe(false);
      expect(all.some(isAccept)).toBe(false); // disjointness: never both
      const out = (all[0].payload as { output?: QueuedAck }).output;
      expect(out?.queued).toBe(true);
      expect(out?.inbox_id).toBe(inboxId);
      expect(inboxReplies).toEqual([]); // nothing of the answer at the inbox
    },

    async work_fails_after_accept(c) {
      // Dispatch failure: no handler registered for the offering at all —
      // OFFERING_NOT_FOUND is a failure of the WORK discovered at dispatch, and
      // it legally follows the accept.
      const { conn, agent } = await makeAgent({ handler: () => ({ ok: true }) });
      const replies = deliver(conn, agent.id, nkeys.createUser(), {
        offering: "no-such-offering",
        input: "hi",
      });
      await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(2));
      const [first, second] = decoded(replies);
      expect(c.accept_sent).toBe(true);
      expect(isAccept(first)).toBe(true);
      expect(second.error).toMatchObject({ code: ErrorCode.OFFERING_NOT_FOUND });
    },
  };

  for (const c of F.ordering.cases) {
    it(`${c.id}: ${c.scenario}`, async () => {
      const driver = drivers[c.id];
      // An ordering case this suite cannot drive is a failure, not a skip.
      expect(driver, `no driver for ordering case '${c.id}'`).toBeDefined();
      await driver(c);
    });
  }
});

// ── queued ack shape (pinned) ───────────────────────────────────────────────

describe("§6.4a queued ack — the pinned shape and its recognition", () => {
  it("the fixture pins queued as boolean true and a non-empty inbox_id", () => {
    expect(F.queued_ack.shape.queued).toBe(true);
    expect(typeof F.queued_ack.shape.inbox_id).toBe("string");
  });
});

// ── caller semantics, against scripted inbox-delivered responds ─────────────

/** A fake connection that delivers scripted reply envelopes to the CALLER's
 *  own inbox subscription, the §6.4 hard cutover shape: the reply subject is
 *  liveness-only, and the SDK resolves a request from responds arriving at
 *  its inbox, running its accept/queued/dedup classification there. The
 *  liveness wait itself is left pending, exactly like a broker that heard the
 *  publish and has nothing to report. (The reply-subject timer mechanics are
 *  tested against the REAL ConnectionManager.requestMulti below.) */
function multiConn(script: (req: Envelope) => Envelope[]) {
  const base = makeConn();
  return {
    ...base,
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      if (!subject.endsWith(".inbox")) return base.request(subject, data);
      const req = decodeUnverified(data);
      for (const env of script(req)) {
        base.subs.get(Subjects.agentInbox(req.from))?.({
          subject: Subjects.agentInbox(req.from),
          data: encode(env),
          reply: undefined,
          respond: () => true,
        });
      }
      // Nothing comes back on the reply subject any more; the liveness wait
      // stays open and the inbox deliveries above decide the outcome.
      return await new Promise<never>(() => {});
    }),
  };
}

function respondWith(
  kp: KeyPair,
  req: Envelope,
  fields: Partial<Pick<Envelope, "payload" | "error" | "task_id">>,
): Envelope {
  return signEnvelope(
    createEnvelope({
      type: "respond",
      from: kp.getPublicKey(),
      to: req.from,
      in_reply_to: req.id,
      ...fields,
    }),
    kp,
  );
}

describe("§6.4a caller semantics — the accept never resolves; the queued ack never answers", () => {
  it("skips the accept, fires onAccept once, and resolves on the first substantive respond", async () => {
    const responderKp = nkeys.createUser();
    const conn = multiConn((req) => {
      const accept = respondWith(responderKp, req, { payload: { status: "accepted" } });
      return [
        accept,
        accept, // an exact duplicate: dedup on (from, id) — §22.2 — surfaces it once
        respondWith(responderKp, req, { payload: { status: "completed", output: { ok: 1 } } }),
      ];
    });
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);
    const accepts: Envelope[] = [];
    const result = await caller.request(responderKp.getPublicKey(), "work", "go", {
      onAccept: (env) => accepts.push(env),
    });
    expect(accepts.length).toBe(1); // dedup: the duplicate accept was ignored
    expect((accepts[0].payload as RespondPayload).status).toBe("accepted");
    expect((result.payload as RespondPayload).status).toBe("completed");
    // §6.4a: the accept chose nothing — no Task exists, and the bare terminal
    // reply is what told the mode.
    expect(result.task_id).toBeNull();
  });

  it("a work failure after the accept surfaces as the work's own error (§6.4a)", async () => {
    const responderKp = nkeys.createUser();
    const conn = multiConn((req) => [
      respondWith(responderKp, req, { payload: { status: "accepted" } }),
      respondWith(responderKp, req, {
        payload: { status: "failed" },
        error: {
          code: ErrorCode.OFFERING_NOT_FOUND,
          message: "no such offering",
          retryable: false,
          retry_after_ms: null,
        },
      }),
    ]);
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);
    await expect(
      caller.request(responderKp.getPublicKey(), "work", "go"),
    ).rejects.toMatchObject({ code: ErrorCode.OFFERING_NOT_FOUND });
  });

  it("rejects with REQUEST_QUEUED on the queued ack, after firing onQueued — never resolves with it", async () => {
    const responderKp = nkeys.createUser();
    const inboxId = "q-1234";
    let requestId = "";
    const conn = multiConn((req) => {
      requestId = req.id;
      return [
        respondWith(responderKp, req, {
          payload: { status: "completed", output: { queued: true, inbox_id: inboxId, text: "held" } },
        }),
      ];
    });
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);
    const queued: QueuedAck[] = [];
    let thrown: MeshError | undefined;
    try {
      await caller.request(responderKp.getPublicKey(), "chat", "hi", {
        onQueued: (ack) => queued.push(ack),
      });
    } catch (err) {
      thrown = err as MeshError;
    }
    expect(queued).toEqual([{ queued: true, inbox_id: inboxId, text: "held" }]);
    expect(thrown?.code).toBe(ErrorCode.REQUEST_QUEUED);
    expect(thrown?.details).toMatchObject({
      queued: true,
      inbox_id: inboxId,
      request_id: requestId,
    });
  });

  it("does NOT treat a string 'true' as a queued ack — the fixture pins boolean true", async () => {
    const responderKp = nkeys.createUser();
    const conn = multiConn((req) => [
      respondWith(responderKp, req, {
        payload: { status: "completed", output: { queued: "true", inbox_id: "x" } },
      }),
    ]);
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);
    const result = await caller.request(responderKp.getPublicKey(), "chat", "hi");
    expect((result.payload as RespondPayload).status).toBe("completed");
  });

  it("an accept never appears in a Task record (§7.2): a Task-mode reply after an accept starts from ITS status", async () => {
    const responderKp = nkeys.createUser();
    const conn = multiConn((req) => [
      respondWith(responderKp, req, { payload: { status: "accepted" } }),
      respondWith(responderKp, req, { task_id: "task-acc", payload: { status: "working" } }),
    ]);
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);
    const result = await caller.request(responderKp.getPublicKey(), "work", "go");
    expect(result.task_id).toBe("task-acc");
    expect(caller.getTask("task-acc")?.state).toBe("working");
    expect(caller.getTask("task-acc")?.history.every((e) => !isAccept(e))).toBe(true);
  });
});

// ── the timer half: the REAL requestMulti resets the timeout on an accept ───

function cmOver(fakeNc: unknown): ConnectionManager {
  const cm = Object.create(ConnectionManager.prototype) as ConnectionManager;
  (cm as unknown as { nc: unknown }).nc = fakeNc;
  return cm;
}

function fakeNc() {
  const subs = new Map<string, (err: unknown, msg: unknown) => void>();
  const published: { subject: string; reply?: string }[] = [];
  return {
    subs,
    published,
    subscribe(subject: string, opts: { callback: (err: unknown, msg: unknown) => void }) {
      subs.set(subject, opts.callback);
      return {
        unsubscribe: () => {
          subs.delete(subject);
        },
      };
    },
    publish(subject: string, _data: Uint8Array, opts?: { reply?: string }) {
      published.push({ subject, reply: opts?.reply });
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("§6.4a timeout reset — ConnectionManager.requestMulti", () => {
  it("an accept ('reset') re-arms the full timeout from its arrival; the substantive reply then resolves", async () => {
    const nc = fakeNc();
    const cm = cmOver(nc);
    let sawAccept = false;
    const p = cm.requestMulti("mesh.agent.X.inbox", new Uint8Array([1]), {
      timeout: 400,
      classify: (m: Msg) => {
        if (!sawAccept) {
          sawAccept = true;
          return "reset";
        }
        return "resolve";
      },
    });
    const settled: string[] = [];
    p.then(
      () => settled.push("resolved"),
      () => settled.push("rejected"),
    );
    const reply = nc.published[0].reply!;
    const send = () => nc.subs.get(reply)?.(null, { data: new Uint8Array([2]) });

    await sleep(250);
    send(); // the accept, at ~250ms — resets the deadline to ~650ms
    await sleep(300); // ~550ms: past the ORIGINAL 400ms deadline
    expect(settled).toEqual([]); // §6.4a: the wait is no longer blind — still pending
    send(); // the substantive reply
    await p;
    expect(settled).toEqual(["resolved"]);
  });

  it("without an accept, the original timeout stands", async () => {
    const nc = fakeNc();
    const cm = cmOver(nc);
    await expect(
      cm.requestMulti("mesh.agent.X.inbox", new Uint8Array([1]), {
        timeout: 120,
        classify: () => "resolve",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.TRANSPORT_TIMEOUT });
  });

  it("after a reset, the RE-ARMED timeout still fires if nothing substantive arrives", async () => {
    const nc = fakeNc();
    const cm = cmOver(nc);
    const p = cm.requestMulti("mesh.agent.X.inbox", new Uint8Array([1]), {
      timeout: 150,
      classify: () => "reset", // everything is an accept; nothing resolves
    });
    const rejection = expect(p).rejects.toMatchObject({ code: ErrorCode.TRANSPORT_TIMEOUT });
    const reply = nc.published[0].reply!;
    await sleep(80);
    nc.subs.get(reply)?.(null, { data: new Uint8Array([2]) }); // accept at ~80ms
    await rejection; // fires at ~230ms, not never
  });

  it("maps the server's 503 to TRANSPORT_NO_RESPONDERS, like request()", async () => {
    const nc = fakeNc();
    const cm = cmOver(nc);
    const p = cm.requestMulti("mesh.agent.X.inbox", new Uint8Array([1]), {
      timeout: 500,
      classify: () => "resolve",
    });
    const reply = nc.published[0].reply!;
    nc.subs.get(reply)?.(null, { data: new Uint8Array(0), headers: { code: 503 } });
    await expect(p).rejects.toMatchObject({ code: ErrorCode.TRANSPORT_NO_RESPONDERS });
  });

  it("ignored messages leave the wait (and the deadline) untouched", async () => {
    const nc = fakeNc();
    const cm = cmOver(nc);
    let calls = 0;
    const p = cm.requestMulti("mesh.agent.X.inbox", new Uint8Array([1]), {
      timeout: 400,
      classify: () => {
        calls++;
        return calls < 3 ? "ignore" : "resolve";
      },
    });
    const reply = nc.published[0].reply!;
    const send = () => nc.subs.get(reply)?.(null, { data: new Uint8Array([2]) });
    send();
    send();
    send();
    await p;
    expect(calls).toBe(3);
  });
});
