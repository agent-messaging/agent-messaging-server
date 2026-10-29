// Messages for the person behind an agent (SPEC.md §5.7, an optional extension
// an agent declares), asserted against conformance/audience.json.
//
// Like the other conformance suites, this file iterates the fixture instead of
// restating its cases: the readings of the mark, the really-signed envelopes
// and their tamper cases, the frame's audience line byte for byte, the
// declaration, the sender's pre-flight, and the receiver's routing table, each
// receiver case driven through a real dispatch. A receiver case this file does
// not know how to drive fails the suite.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src to agree with the fixture; the fixture changes only
// together with SPEC.md §5.7.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nkeys } from "nats.ws";
import type { KeyPair, Subscription } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope, canonicalEnvelopeBytes } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode, MeshError } from "../../src/types/errors.js";
import { budgetInsufficient } from "../../src/budget.js";
import { Room, type RoomHost, type RoomMessage } from "../../src/rooms.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { RespondPayload } from "../../src/types/primitives.js";
import { checkReadableText, personReadableText } from "../../src/readable-text.js";
import {
  AUDIENCE_DECLARATION,
  AUDIENCE_FRAME_LINE,
  audiencePreflight,
  declaresAudience,
  frameForPerson,
  readAudience,
  type PersonMessage,
} from "../../src/audience.js";

const here = dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const F: any = JSON.parse(readFileSync(join(here, "..", "..", "..", "conformance", "audience.json"), "utf8"));

// ── readings ────────────────────────────────────────────────────────────────

describe("audience.json readings: how a receiver reads meta.audience", () => {
  for (const c of F.readings.cases) {
    it(`${c.id} reads as ${c.reading}`, () => {
      expect(readAudience(c.meta === null ? undefined : c.meta)).toBe(c.reading);
    });
  }
});

// ── the signed envelopes and the tamper cases ───────────────────────────────

describe("audience.json envelopes: really signed, the mark under the signature", () => {
  for (const [id, e] of Object.entries(F.envelopes).filter(([k]) => k !== "comment")) {
    const { canonical, signed } = e as { canonical: string; signed: Envelope };
    it(`${id}: canonical bytes rebuild and the signature verifies`, () => {
      expect(new TextDecoder().decode(canonicalEnvelopeBytes(signed))).toBe(canonical);
      expect(() => decode(encode(signed))).not.toThrow();
    });
  }

  for (const c of F.tamper.cases) {
    it(`tamper ${c.id}: ${c.verifies ? "verifies" : "fails verification"}`, () => {
      const env = structuredClone(F.envelopes[c.from].signed) as Record<string, unknown>;
      if (c.op !== "none") {
        const [head, tail] = c.path.split(".");
        if (c.op === "delete") {
          if (tail === undefined) delete env[head];
          else delete (env[head] as Record<string, unknown>)[tail];
        } else {
          env[head] = { ...((env[head] as Record<string, unknown>) ?? {}), [tail]: c.value };
        }
      }
      const run = () => decode(encode(env as unknown as Envelope));
      if (c.verifies) expect(run).not.toThrow();
      else expect(run).toThrow();
    });
  }
});

// ── the frame line ──────────────────────────────────────────────────────────

describe("audience.json frame: §22.6's frame with the audience line, byte for byte", () => {
  it("the line is the pinned one", () => {
    expect(AUDIENCE_FRAME_LINE).toBe(F.frame.audience_line);
  });
  for (const c of F.frame.cases) {
    it(c.id, () => {
      const got = frameForPerson(c.text, {
        from: c.provenance.from,
        receivedAt: new Date(c.provenance.received_at),
        ...(c.provenance.trace ? { trace: c.provenance.trace } : {}),
      });
      expect(got).toBe(c.expected);
    });
  }
});

// ── the declaration and the sender's pre-flight ─────────────────────────────

describe("audience.json field.declaration and sender.preflight", () => {
  it("the declaration is the pinned manifest entry", () => {
    expect(AUDIENCE_DECLARATION).toEqual(F.field.declaration.entry);
    expect(declaresAudience({ extensions: [AUDIENCE_DECLARATION] })).toBe(true);
    expect(declaresAudience({ extensions: [] })).toBe(false);
    expect(declaresAudience(null)).toBe(false);
  });
  for (const c of F.sender.preflight) {
    it(`${c.id} → ${c.result}`, () => {
      const v = audiencePreflight(c.receivers, { sendAnyway: c.send_anyway, audience: c.audience ?? "person" });
      if (c.result === "send") expect(v).toEqual({ send: true });
      else expect(v).toEqual({ send: false, receivers: c.details_receivers });
    });
  }
});

// ── the receiver's routing table, through a real dispatch ──────────────────

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

function makeConn() {
  const subs = new Map<string, (msg: unknown) => void>();
  const registryKp = nkeys.createUser();
  return {
    subs,
    publish: vi.fn((subject: string, data: Uint8Array) => {
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

async function makeAgent(opts: { setting: "on" | "off"; person?: boolean }) {
  const conn = makeConn();
  const warnings: { code: string }[] = [];
  const agent = AgentMesh.withConnection(conn as unknown as ConnectionManager, nkeys.createUser(), nkeys.createUser(), {
    onSecurityWarning: (w) => warnings.push(w),
  });
  openAgents.push(agent);
  const handled: unknown[] = [];
  const admitted: unknown[] = [];
  const handler = (input: unknown) => {
    handled.push(input);
    return { ok: true };
  };
  const admit = () => {
    admitted.push(true);
    throw budgetInsufficient({ amount: 1_000_000, currency: "USD" });
  };
  agent.onRequest("chat", handler);
  agent.onRequest("summarize", handler, { admit });
  agent.onDefault(handler);
  const person: PersonMessage[] = [];
  if (opts.person !== false) agent.onPersonMessage((m) => void person.push(m));
  agent.setPersonMessages({ agentMayRead: opts.setting === "on" });
  const manifest = await agent.register({ name: "audience", personMessages: opts.person !== false });
  return { conn, agent, handled, admitted, person, warnings, manifest };
}

function deliver(conn: Conn, agentId: string, senderKp: KeyPair, fields: Partial<Envelope>): Envelope[] {
  const env = createEnvelope({ type: "request", from: senderKp.getPublicKey(), to: agentId, ...fields } as never);
  const signed = signEnvelope(env, senderKp);
  const replies: Envelope[] = [];
  conn.subs.set(Subjects.agentInbox(senderKp.getPublicKey()), (m) => {
    replies.push(decode((m as { data: Uint8Array }).data));
  });
  const cb = conn.subs.get(Subjects.agentInbox(agentId));
  if (!cb) throw new Error("agent is not listening on its inbox");
  cb({ subject: Subjects.agentInbox(agentId), data: encode(signed), reply: "_INBOX.audience", respond: () => true });
  return replies;
}

const flush = () => new Promise((r) => setTimeout(r, 20));
const statusOf = (e: Envelope) => (e.payload as RespondPayload | undefined)?.status;

describe("audience.json receiver: the routing table", () => {
  const driven = new Set<string>();
  const requestCases = F.receiver.cases.filter((c: { type: string }) => c.type === "request");

  for (const c of requestCases) {
    driven.add(c.id);
    it(`${c.id} → ${c.outcome}`, async () => {
      const a = await makeAgent({ setting: c.setting });
      const sender = nkeys.createUser();
      const meta =
        c.audience === "absent" ? undefined : { audience: c.audience };
      const payload =
        c.audience === "absent" || c.audience === "agent"
          ? { offering: "chat", input: { text: "hello" } }
          : { text: "For Rosa: pickup moves to 3:15.", ...(c.offering ? { offering: c.offering } : {}) };
      const replies = deliver(a.conn, a.agent.agentId, sender, {
        payload,
        ...(meta ? { meta } : {}),
        ...(c.budget ? { budget: { revision: 0, deadline: new Date(Date.now() + 3_600_000).toISOString() } } : {}),
      } as Partial<Envelope>);
      await flush();

      // No accept signal unless the case says the ordinary rules apply.
      const accepts = replies.filter((r) => statusOf(r) === "accepted");
      if (c.accept_signal === false) expect(accepts).toHaveLength(0);

      if (c.outcome === "handler") {
        expect(a.handled).toHaveLength(1);
        expect(a.person).toHaveLength(0);
        return;
      }
      // Every other outcome: no handler, no admit hook, no Task.
      expect(a.handled).toHaveLength(0);
      expect(a.admitted).toHaveLength(0);
      expect(replies.some((r) => r.task_id)).toBe(false);
      expect(replies.some((r) => r.error?.code === ErrorCode.BUDGET_INSUFFICIENT)).toBe(false);

      if (c.outcome === "refused") {
        expect(a.person).toHaveLength(0);
        expect(replies).toHaveLength(1);
        expect(replies[0].error?.code).toBe(ErrorCode.INVALID_ENVELOPE);
        expect(replies[0].error?.details?.reason).toBe("audience_malformed");
        expect(replies[0].meta?.audience).toBeUndefined();
        return;
      }
      // person or agent_note: surfaced, answered with the queued ack.
      expect(a.person).toHaveLength(1);
      expect(a.person[0].kind).toBe("request");
      expect(a.person[0].from).toBe(sender.getPublicKey());
      expect(a.person[0].text).toBe("For Rosa: pickup moves to 3:15.");
      expect(replies).toHaveLength(1);
      const out = (replies[0].payload as { output?: { queued?: boolean; inbox_id?: string } }).output;
      expect(out?.queued).toBe(true);
      expect(out?.inbox_id).toBeTruthy();
      expect(replies[0].meta?.audience).toBeUndefined();
      if (c.outcome === "agent_note") {
        expect(a.person[0].agentNote).toContain(AUDIENCE_FRAME_LINE);
        expect(a.person[0].agentNote).toContain("--- BEGIN SENDER MESSAGE ---\nFor Rosa: pickup moves to 3:15.\n");
      } else {
        expect(a.person[0].agentNote).toBeUndefined();
      }
    });
  }

  for (const c of F.receiver.cases.filter((x: { type: string }) => x.type === "respond")) {
    driven.add(c.id);
    it(`${c.id} → ${c.outcome}: resolves no wait, reaches the person`, async () => {
      const a = await makeAgent({ setting: c.setting });
      const other = nkeys.createUser();
      // A wait this agent holds on a request it sent to `other`.
      const request = signEnvelope(
        createEnvelope({ type: "request", from: a.agent.agentId, to: other.getPublicKey(), payload: { text: "hi" } }),
        // the request is this agent's own; its signature is not checked here
        nkeys.createUser(),
      );
      const onRespond = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (a.agent as any).pendingAgentReplies.set(request.id, { request, agentId: other.getPublicKey(), onRespond });
      const reply = signEnvelope(
        createEnvelope({
          type: "respond",
          from: other.getPublicKey(),
          to: a.agent.agentId,
          in_reply_to: request.id,
          payload: { status: "completed", text: "Thanks, I will be there." },
          meta: { audience: "person" },
        }),
        other,
      );
      a.conn.subs.get(Subjects.agentInbox(a.agent.agentId))!({
        subject: Subjects.agentInbox(a.agent.agentId),
        data: encode(reply),
        reply: undefined,
        respond: () => true,
      });
      await flush();
      expect(onRespond).not.toHaveBeenCalled();
      expect(a.person).toHaveLength(1);
      expect(a.person[0].kind).toBe("respond");
      expect(a.person[0].inReplyTo).toBe(request.id);
      expect(a.person[0].text).toBe("Thanks, I will be there.");
      if (c.outcome === "agent_note") expect(a.person[0].agentNote).toContain(AUDIENCE_FRAME_LINE);
      else expect(a.person[0].agentNote).toBeUndefined();
    });
  }

  driven.add("event_person");
  it("event_person → dropped: no handler, a local signal", async () => {
    const a = await makeAgent({ setting: "on" });
    const kp = nkeys.createUser();
    const env = signEnvelope(
      createEnvelope({
        type: "emit",
        from: kp.getPublicKey(),
        payload: { domain: "x", event_type: "y", data: { text: "hi" } },
        meta: { audience: "person" },
      }),
      kp,
    );
    const h = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = (a.agent as any).dispatchEvent(env, "mesh.event.x.y", h, false, "x.y");
    expect(ok).toBe(false);
    expect(h).not.toHaveBeenCalled();
    expect(a.person).toHaveLength(0);
    expect(a.warnings.some((w) => w.code === "audience_marked_dropped")).toBe(true);
  });

  driven.add("task_update_person");
  it("task_update_person → dropped: the Task does not move, no handler", async () => {
    const a = await makeAgent({ setting: "on" });
    const responder = nkeys.createUser();
    const taskId = "task-audience-1";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyAgent = a.agent as any;
    anyAgent.tasks.create({
      id: taskId,
      requester: a.agent.agentId,
      responder: responder.getPublicKey(),
      offering: "chat",
      state: "working",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      history: [],
      artifacts: [],
    });
    const h = vi.fn();
    a.agent.onTaskUpdate(h);
    const env = signEnvelope(
      createEnvelope({
        type: "respond",
        from: responder.getPublicKey(),
        to: a.agent.agentId,
        task_id: taskId,
        payload: { status: "completed", text: "for your person" },
        meta: { audience: "person" },
      }),
      responder,
    );
    anyAgent.handleTaskUpdate(taskId, env);
    expect(h).not.toHaveBeenCalled();
    expect(a.agent.getTask(taskId)?.state).toBe("working");
    expect(a.warnings.some((w) => w.code === "audience_marked_dropped")).toBe(true);
  });

  for (const id of ["room_say_person", "room_replay_person", "room_join_person"]) driven.add(id);
  it("room_say_person → person, room_join_person → ignored, room_replay_person → withheld from the record", async () => {
    const subs: Array<{ pattern: string; cb: (env: Envelope) => void }> = [];
    const matches = (p: string, s: string) => {
      const a = p.split(".");
      const b = s.split(".");
      return a.length === b.length && a.every((x, i) => x === "*" || x === b[i]);
    };
    const surfaced: Array<{ text?: string; roomId: string }> = [];
    const makeHost = (kp = nkeys.createUser()): RoomHost => ({
      agentId: kp.getPublicKey(),
      keyPair: kp,
      publish(subject, data) {
        for (const s of [...subs]) if (matches(s.pattern, subject)) s.cb(decode(data));
      },
      subscribe(subject, onEnvelope) {
        const entry = { pattern: subject, cb: onEnvelope };
        subs.push(entry);
        return { unsubscribe() {} } as unknown as Subscription;
      },
      request: async () => ({}),
      serviceRequest: async () => ({}),
      getEncryptionKey: async () => null,
      audienceDeclaredBy: async () => true,
      surfaceToPerson: (_env, text, roomId) => {
        surfaced.push({ text, roomId });
        return true;
      },
    });
    const alice = makeHost();
    const bob = makeHost();
    const declared = new Set([bob.agentId]);
    alice.audienceDeclaredBy = async (id) => declared.has(id);
    const room = Room.open(alice, { name: "family" });
    const bobsRoom = Room.join(bob, room.token);
    const seen: RoomMessage[] = [];
    bobsRoom.onMessage((m) => seen.push(m));
    await room.sayToPeople("For Rosa: pickup moves to 3:15.");
    room.say("for the agents");
    expect(surfaced).toEqual([{ text: "For Rosa: pickup moves to 3:15.", roomId: room.id }]);
    expect(seen.map((m) => (m.type === "say" ? m.body : m.type))).toEqual(["for the agents"]);

    // A member that does not declare the extension makes the post refuse.
    const carol = makeHost();
    Room.join(carol, room.token);
    const refused = await room.sayToPeople("again").catch((e) => e);
    expect(refused).toBeInstanceOf(MeshError);
    expect((refused as MeshError).code).toBe(ErrorCode.AUDIENCE_NOT_SUPPORTED);
    expect((refused as MeshError).details?.receivers).toEqual([carol.agentId]);
  });

  it("every receiver case in the fixture is driven", () => {
    const all = F.receiver.cases.map((c: { id: string }) => c.id);
    expect(all.filter((id: string) => !driven.has(id))).toEqual([]);
  });
});

// ── the inbox listing a harness reads ───────────────────────────────────────

describe("audience.json inbox: a held message for the person keeps its mark and its text stays out of the harness listing", () => {
  it("listing_setting_off: released to the inbox with the mark, the listing carries no text", async () => {
    const { AdmissionGate } = await import("../../src/admission.js");
    const kp = nkeys.createUser();
    const gate = await AdmissionGate.open(kp.getPublicKey(), kp);
    const from = nkeys.createUser().getPublicKey();
    gate.hold({
      id: "m1",
      from,
      received_at: new Date().toISOString(),
      offering: "",
      input: { text: "For Rosa: pickup moves to 3:15." },
      audience: "person",
    });
    gate.admit(from);
    const listing = gate.harnessListing();
    expect(listing).toHaveLength(1);
    expect(listing[0].audience).toBe("person");
    expect(listing[0].from).toBe(from);
    expect(listing[0].received_at).toBeTruthy();
    expect(JSON.stringify(listing[0])).not.toContain("Rosa");
    // The person's own view keeps the text.
    expect(gate.inbox()[0].text).toContain("Rosa");
  });

  it("a person surface takes the released message instead of the inbox", async () => {
    const { AdmissionGate } = await import("../../src/admission.js");
    const kp = nkeys.createUser();
    const gate = await AdmissionGate.open(kp.getPublicKey(), kp);
    const from = nkeys.createUser().getPublicKey();
    const taken: string[] = [];
    gate.onPersonReleased = (h) => {
      taken.push(h.id);
      return true;
    };
    gate.hold({ id: "m2", from, received_at: new Date().toISOString(), offering: "", input: { text: "x" }, audience: "person" });
    gate.admit(from);
    expect(taken).toEqual(["m2"]);
    expect(gate.inbox()).toHaveLength(0);
  });
});

// ── the sending side ────────────────────────────────────────────────────────

describe("sendToPerson and replyToPerson: refuse by default, mark the envelope", () => {
  it("refuses locally with AUDIENCE_NOT_SUPPORTED when the receiver does not declare, and publishes nothing", async () => {
    const a = await makeAgent({ setting: "off" });
    const target = nkeys.createUser().getPublicKey();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(a.agent as any, "getManifest").mockResolvedValue({ agent_id: target, extensions: [] });
    const before = a.conn.publish.mock.calls.length;
    const err = await a.agent.sendToPerson(target, "hello").catch((e) => e);
    expect(err).toBeInstanceOf(MeshError);
    expect((err as MeshError).code).toBe(ErrorCode.AUDIENCE_NOT_SUPPORTED);
    expect((err as MeshError).details?.receivers).toEqual([target]);
    expect(a.conn.publish.mock.calls.length).toBe(before);
  });

  it("an unreadable manifest refuses too", async () => {
    const a = await makeAgent({ setting: "off" });
    const target = nkeys.createUser().getPublicKey();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(a.agent as any, "getManifest").mockRejectedValue(new Error("gone"));
    const err = await a.agent.sendToPerson(target, "hello").catch((e) => e);
    expect((err as MeshError).code).toBe(ErrorCode.AUDIENCE_NOT_SUPPORTED);
  });

  it("replyToPerson sends a bare respond marked for a person, after the same pre-flight", async () => {
    const a = await makeAgent({ setting: "off" });
    const other = nkeys.createUser();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(a.agent as any, "getManifest").mockResolvedValue({ agent_id: other.getPublicKey(), extensions: [AUDIENCE_DECLARATION] });
    const seen: Envelope[] = [];
    a.conn.subs.set(Subjects.agentInbox(other.getPublicKey()), (m) => seen.push(decode((m as { data: Uint8Array }).data)));
    await a.agent.replyToPerson({ id: "0198f0a0-0000-7000-8000-0000000a0d00", from: other.getPublicKey() }, "Thanks");
    expect(seen).toHaveLength(1);
    const r = seen[0];
    expect(r.type).toBe("respond");
    expect(r.in_reply_to).toBe("0198f0a0-0000-7000-8000-0000000a0d00");
    expect(r.meta?.audience).toBe("person");
    expect(r.task_id).toBeUndefined();
    expect(r.payload).toEqual({ status: "completed", text: "Thanks" });
    // §5.8: the digest of the generated readable text rides under the signature.
    expect((await checkReadableText(r, personReadableText({ sender: a.agent.agentId, text: "Thanks" }))).ok).toBe(true);
  });

  it("send-anyway skips the check and the envelope carries the mark, no budget and no task id", async () => {
    const a = await makeAgent({ setting: "off" });
    const b = await makeAgent({ setting: "off" });
    // Route a's publishes into b's inbox, and b's answers back to a.
    const bInbox = b.conn.subs.get(Subjects.agentInbox(b.agent.agentId))!;
    a.conn.request.mockImplementation((subject: string, data: Uint8Array) => {
      if (subject === Subjects.agentInbox(b.agent.agentId)) bInbox({ subject, data, reply: undefined, respond: () => true });
      // The answer travels by publish to a's inbox (§6.4); the transport reply never comes.
      return new Promise(() => {});
    });
    b.conn.publish.mockImplementation((subject: string, data: Uint8Array) => {
      const cb = a.conn.subs.get(subject);
      cb?.({ subject, data, reply: undefined, respond: () => true });
    });
    const out = await a.agent.sendToPerson(b.agent.agentId, "For Rosa", { sendAnyway: true, timeout_ms: 2000 });
    expect(out.outcome).toBe("queued");
    expect(b.person).toHaveLength(1);
    const env = b.person[0].envelope;
    expect(env.meta?.audience).toBe("person");
    expect(env.budget).toBeUndefined();
    expect(env.task_id).toBeUndefined();
    expect(env.payload).toEqual({ text: "For Rosa" });
    expect((await checkReadableText(env, personReadableText({ sender: a.agent.agentId, text: "For Rosa" }))).ok).toBe(true);
    expect(b.handled).toHaveLength(0);
  });

  it("register declares the extension only with a person surface", async () => {
    const a = await makeAgent({ setting: "off" });
    expect(declaresAudience(a.manifest)).toBe(true);
    const b = await makeAgent({ setting: "off", person: false });
    expect(declaresAudience(b.manifest)).toBe(false);
    const err = await b.agent.register({ name: "audience", personMessages: true }).catch((e) => e);
    expect((err as MeshError).code).toBe(ErrorCode.INVALID_MANIFEST);
  });
});
