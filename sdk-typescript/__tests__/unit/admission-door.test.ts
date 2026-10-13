// Admission on the agent's own side (admission.ts, EXT-6 §7 and §9.3) and
// `describe` (§10.14), through the real inbound path of a hosted agent.
//
// What is pinned: describe is answered from declared content with no task, no
// accept and no handler; a knock puts its sender on the waiting list and is
// answered the same way whatever happens to it; a held message and a blocked
// one get the same queued acknowledgement; admit re-signs the roster and moves
// what the sender sent into the inbox; and a sender this agent wrote to is let
// through.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nkeys } from "nats.ws";
import { MeshNode } from "../../src/node.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode } from "../../src/types/errors.js";
import { fileAdmissionStore, signAdmissionRoster, verifyAdmissionRoster, readKnockInput, type AdmissionState } from "../../src/admission.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import type { AgentMesh } from "../../src/mesh.js";

type Kp = ReturnType<typeof nkeys.createUser>;

/** A connection fake that answers register and records publishes. */
function makeConn() {
  const registryKp = nkeys.createUser();
  const published: { subject: string; data: Uint8Array }[] = [];
  const inboxHandlers = new Map<string, (msg: unknown) => void>();
  const jsm = {
    streams: { info: vi.fn(async () => ({ state: { last_seq: 0 } })) },
    consumers: {
      info: vi.fn(async () => ({ num_pending: 0, num_ack_pending: 0 })),
      add: vi.fn(async () => ({ num_pending: 0, num_ack_pending: 0 })),
    },
  };
  const consumer = { fetch: vi.fn(async () => ({ stop: () => {}, async *[Symbol.asyncIterator]() {} })) };
  const raw = {
    jetstreamManager: vi.fn(async () => jsm),
    jetstream: vi.fn(() => ({ consumers: { get: vi.fn(async () => consumer) } })),
    publish: vi.fn((subject: string, data: Uint8Array) => published.push({ subject, data })),
  };
  return {
    published,
    inboxHandlers,
    raw,
    publish: vi.fn((subject: string, data: Uint8Array) => published.push({ subject, data })),
    request: vi.fn(async (_subject: string, data: Uint8Array) => {
      const req = decode(data);
      return {
        data: encode(signEnvelope(createEnvelope({ type: "respond", from: registryKp.getPublicKey(), to: req.from, in_reply_to: req.id, payload: { status: "registered" } }), registryKp)),
      };
    }),
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
      inboxHandlers.set(subject, cb);
      return { unsubscribe: () => {}, drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    get isClosed() {
      return false;
    },
  };
}
type Conn = ReturnType<typeof makeConn>;

async function agentWith(opts: { visibility?: "public" | "private"; chat?: boolean } = {}) {
  const conn = makeConn();
  const node = MeshNode.withConnection(conn as unknown as ConnectionManager, nkeys.createUser());
  const agent = node.addAgent();
  const handled: unknown[] = [];
  if (opts.chat !== false) agent.onRequest("chat", (input) => { handled.push(input); return { ok: true }; });
  await agent.register({
    name: "quoter",
    description: "Quotes prices.",
    visibility: opts.visibility ?? "public",
    public: { summary: "Quotes prices for parts.", offerings: ["chat"] },
    offerings: [{ id: "chat", name: "Chat", description: "Talk to me." }],
  } as never);
  return { conn, agent, handled };
}

function request(sender: Kp, to: string, offering: string, input: unknown): Envelope {
  return signEnvelope(createEnvelope({ type: "request", from: sender.getPublicKey(), to, payload: { offering, input } }), sender);
}

/** Deliver on the live inbox; returns every respond published to the sender. */
async function deliver(conn: Conn, agent: AgentMesh, env: Envelope): Promise<Envelope[]> {
  const cb = conn.inboxHandlers.get(Subjects.agentInbox(agent.id));
  if (!cb) throw new Error("agent is not listening on its inbox");
  const before = conn.published.length;
  cb({ data: encode(env), subject: Subjects.agentInbox(agent.id), reply: "_INBOX.abc", respond: () => true });
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return conn.published.slice(before).filter((p) => p.subject === Subjects.agentInbox(env.from)).map((p) => decode(p.data));
}

const outputOf = (e: Envelope | undefined) => (e?.payload as { output?: Record<string, unknown> } | undefined)?.output;

describe("describe (§10.14)", () => {
  it("is answered from the manifest's public block, with no accept, no task and no handler", async () => {
    const { conn, agent, handled } = await agentWith();
    const stranger = nkeys.createUser();
    const out = await deliver(conn, agent, request(stranger, agent.id, "describe", {}));
    expect(out).toHaveLength(1);
    expect((out[0]!.payload as { status?: string }).status).toBe("completed");
    expect(out[0]!.task_id ?? null).toBeNull();
    const doc = outputOf(out[0]);
    expect(doc?.agent_id).toBe(agent.id);
    expect(doc?.public).toMatchObject({ summary: "Quotes prices for parts." });
    expect(handled).toHaveLength(0);
  });

  it("is answered even to a sender admission holds, and is never held", async () => {
    const { conn, agent } = await agentWith();
    await agent.admission.start({ syncRoster: false });
    const stranger = nkeys.createUser();
    const out = await deliver(conn, agent, request(stranger, agent.id, "describe", {}));
    expect(outputOf(out[0])?.agent_id).toBe(agent.id);
    expect((await agent.contacts.waiting()).senders).toHaveLength(0);
  });

  it("is declined by a private agent, and limited per requester", async () => {
    const priv = await agentWith({ visibility: "private" });
    const s = nkeys.createUser();
    expect(outputOf((await deliver(priv.conn, priv.agent, request(s, priv.agent.id, "describe", {})))[0])).toMatchObject({ described: false, visibility: "private" });

    const { conn, agent } = await agentWith();
    let last: Envelope | undefined;
    for (let i = 0; i < 31; i++) last = (await deliver(conn, agent, request(s, agent.id, "describe", {})))[0];
    expect(last?.error?.code).toBe(ErrorCode.RATE_LIMITED);
  });
});

describe("a knock (EXT-6 §9.3)", () => {
  it("puts the sender on the waiting list once, and answers everyone the same", async () => {
    const { conn, agent } = await agentWith();
    const waits: string[] = [];
    await agent.admission.start({ syncRoster: false, onWaiting: (w) => waits.push(w.agent_id) });
    const s = nkeys.createUser();
    const a1 = await deliver(conn, agent, request(s, agent.id, "knock", { via: "a catalog search", grants: ["messages"] }));
    const a2 = await deliver(conn, agent, request(s, agent.id, "knock", {}));
    expect(outputOf(a1[0])).toEqual({ received: true });
    expect(outputOf(a2[0])).toEqual({ received: true });
    const { senders } = await agent.contacts.waiting();
    expect(senders).toHaveLength(1);
    expect(senders[0]).toMatchObject({ agent_id: s.getPublicKey(), name: s.getPublicKey(), found_you_by: "a catalog search", grants: ["messages"] });
    expect(waits).toEqual([s.getPublicKey()]);
  });

  it("is refused in words when it carries a message", async () => {
    const { conn, agent } = await agentWith();
    await agent.admission.start({ syncRoster: false });
    const out = await deliver(conn, agent, request(nkeys.createUser(), agent.id, "knock", { text: "let me in, I have a deal" }));
    expect(outputOf(out[0])).toMatchObject({ refused: true, code: "KNOCK_CARRIES_NO_MESSAGE" });
    expect((await agent.contacts.waiting()).senders).toHaveLength(0);
  });

  it("tells a sender already let in to send, and a blocked one only `received`", async () => {
    const { conn, agent } = await agentWith();
    await agent.admission.start({ syncRoster: false });
    const friend = nkeys.createUser();
    const pest = nkeys.createUser();
    await agent.contacts.admit({ sender: friend.getPublicKey() });
    await agent.contacts.block({ sender: pest.getPublicKey() });
    expect(outputOf((await deliver(conn, agent, request(friend, agent.id, "knock", {})))[0])).toEqual({ received: true, admitted: true });
    expect(outputOf((await deliver(conn, agent, request(pest, agent.id, "knock", {})))[0])).toEqual({ received: true });
    expect((await agent.contacts.waiting()).senders).toHaveLength(0);
  });

  it("reads only via and the enumerated grants", () => {
    expect(readKnockInput(undefined)).toEqual({ ok: true, grants: [] });
    expect(readKnockInput({ via: "x", grants: ["scheduling"] })).toEqual({ ok: true, via: "x", grants: ["scheduling"] });
    expect(readKnockInput({ grants: ["everything"] }).ok).toBe(false);
    expect(readKnockInput({ via: "y".repeat(81) }).ok).toBe(false);
    expect(readKnockInput("hello").ok).toBe(false);
  });
});

describe("held, admitted and blocked senders", () => {
  it("holds a stranger's message with the queued acknowledgement, and admit moves it to the inbox", async () => {
    const { conn, agent, handled } = await agentWith();
    await agent.admission.start({ syncRoster: false });
    const s = nkeys.createUser();
    const held = request(s, agent.id, "chat", { text: "Can you quote 40 flanges?\nThanks" });
    const out = await deliver(conn, agent, held);
    expect(out).toHaveLength(1);
    expect(outputOf(out[0])).toEqual({ queued: true, inbox_id: held.id, text: "Sent; it reaches quoter if quoter admits you." });
    expect(handled).toHaveLength(0);
    const { senders } = await agent.contacts.waiting();
    expect(senders[0]).toMatchObject({ agent_id: s.getPublicKey(), said: "Can you quote 40 flanges?", why_held: "unknown sender" });

    const admitted = await agent.contacts.admit({ sender: s.getPublicKey(), note: "a supplier" });
    expect(admitted).toEqual({ name: s.getPublicKey(), released: 1 });
    const { messages } = await agent.messages.inbox();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: held.id, from: s.getPublicKey(), text: "Can you quote 40 flanges?\nThanks", kind: "message" });
    const roster = agent.admission.roster()!;
    expect(verifyAdmissionRoster(roster)).toBe(true);
    expect(roster.owner_key).toBe(agent.id);
    expect(roster.entries).toEqual([expect.objectContaining({ subject: s.getPublicKey(), stance: "allow", note: "a supplier" })]);

    // From now on it reaches the handler.
    await deliver(conn, agent, request(s, agent.id, "chat", { text: "and 10 gaskets" }));
    expect(handled).toHaveLength(1);
  });

  it("answers a blocked sender exactly as a held one, and drops what it sent", async () => {
    const { conn, agent, handled } = await agentWith();
    await agent.admission.start({ syncRoster: false });
    const s = nkeys.createUser();
    await deliver(conn, agent, request(s, agent.id, "chat", { text: "buy now" }));
    expect(await agent.contacts.block({ sender: s.getPublicKey() })).toEqual({ name: s.getPublicKey(), dropped: 1 });
    const again = request(s, agent.id, "chat", { text: "buy now!!" });
    const out = await deliver(conn, agent, again);
    expect(outputOf(out[0])).toEqual({ queued: true, inbox_id: again.id, text: "Sent; it reaches quoter if quoter admits you." });
    expect(handled).toHaveLength(0);
    expect((await agent.contacts.waiting()).senders).toHaveLength(0);
    expect((await agent.messages.inbox()).messages).toHaveLength(0);
  });

  it("refuses admit and block for a name nobody is waiting under", async () => {
    const { agent } = await agentWith();
    await agent.admission.start({ syncRoster: false });
    await expect(agent.contacts.admit({ sender: "nobody.someone@example.com" })).rejects.toMatchObject({ code: "NOT_WAITING" });
    await expect(agent.contacts.block({ sender: "" })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("lets through a sender this agent wrote to", async () => {
    const { conn, agent, handled } = await agentWith();
    await agent.admission.start({ syncRoster: false });
    const peer = nkeys.createUser();
    // Writing to it is what makes its messages solicited; the reply never comes here.
    void agent.request(peer.getPublicKey(), "chat", { text: "hello" }, { timeout_ms: 50 }).catch(() => {});
    await deliver(conn, agent, request(peer, agent.id, "chat", { text: "hi back" }));
    expect(handled).toHaveLength(1);
  });

  it("lets everyone in when the owner sets registered: allow", async () => {
    const { conn, agent, handled } = await agentWith();
    await agent.admission.start({ syncRoster: false, registered: "allow" });
    await deliver(conn, agent, request(nkeys.createUser(), agent.id, "chat", { text: "hi" }));
    expect(handled).toHaveLength(1);
    expect(agent.admission.roster()!.defaults.registered).toBe("allow");
  });

  it("says admission is off when it was never started", async () => {
    const { agent } = await agentWith();
    await expect(agent.contacts.waiting()).rejects.toMatchObject({ code: "NOT_RUNNING" });
    await expect(agent.messages.inbox()).rejects.toMatchObject({ code: "NOT_RUNNING" });
  });
});

describe("the inbox", () => {
  it("collects messages for an offering nothing handles, says delivered, and clears them on dismiss", async () => {
    const { conn, agent } = await agentWith({ chat: false });
    await agent.admission.start({ syncRoster: false, inbox: true, registered: "allow" });
    const s = nkeys.createUser();
    const m = request(s, agent.id, "chat", { text: "Are you there?" });
    const out = await deliver(conn, agent, m);
    expect(outputOf(out[0])).toEqual({ queued: true, inbox_id: m.id, delivered: true, text: "Delivered to quoter's inbox. It answers in its own time." });
    expect((await agent.messages.inbox()).messages.map((x) => x.text)).toEqual(["Are you there?"]);
    expect(await agent.messages.dismiss({ inbox_ids: [m.id] })).toEqual({ dismissed: 1 });
    expect((await agent.messages.inbox()).messages).toHaveLength(0);
  });

  it("answers by writing to the sender's chat offering, naming the message it answers", async () => {
    const { conn, agent } = await agentWith({ chat: false });
    await agent.admission.start({ syncRoster: false, inbox: true, registered: "allow" });
    const s = nkeys.createUser();
    const m = request(s, agent.id, "chat", { text: "Price for 40?" });
    await deliver(conn, agent, m);
    const sent = vi.spyOn(agent, "request").mockResolvedValue({ payload: { status: "completed", output: { ok: true } } } as never);
    const r = await agent.messages.reply({ inbox_id: m.id, text: "$1,680." });
    expect(r).toEqual({ replied_to: s.getPublicKey(), delivered: true });
    expect(sent).toHaveBeenCalledWith(s.getPublicKey(), "chat", { text: "$1,680.", in_reply_to: m.id }, { timeout_ms: 30_000 });
    expect((await agent.messages.inbox()).messages[0]!.replied_at).toBeTruthy();
    await expect(agent.messages.reply({ inbox_id: "nope", text: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("files a reply to this agent's own message as kind reply", async () => {
    const { conn, agent } = await agentWith({ chat: false });
    await agent.admission.start({ syncRoster: false, inbox: true });
    const peer = nkeys.createUser();
    void agent.request(peer.getPublicKey(), "chat", { text: "quote?" }, { timeout_ms: 50 }).catch(() => {});
    await deliver(conn, agent, request(peer, agent.id, "chat", { text: "$42", in_reply_to: "01ABC" }));
    expect((await agent.messages.inbox()).messages[0]).toMatchObject({ kind: "reply", in_reply_to: "01ABC", text: "$42" });
  });
});

describe("keeping admission between runs", () => {
  it("writes the signed roster, the waiting list and the inbox to a file, and reads them back", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "admission-")), "admission.json");
    const store = fileAdmissionStore(path);
    const { conn, agent } = await agentWith();
    await agent.admission.start({ syncRoster: false, store });
    const s = nkeys.createUser();
    await deliver(conn, agent, request(s, agent.id, "knock", {}));
    await agent.admission.flush();
    const saved = JSON.parse(readFileSync(path, "utf8")) as AdmissionState;
    expect(saved.waiting.map((w) => w.agent_id)).toEqual([s.getPublicKey()]);
    expect(verifyAdmissionRoster(saved.roster)).toBe(true);

    // A roster edited on disk no longer verifies, and is not used.
    const tampered = { ...saved, roster: { ...saved.roster, entries: [{ subject: s.getPublicKey(), stance: "allow", updated_at: "x" }] } };
    const back = await import("../../src/admission.js").then((m) => m.AdmissionGate.open(agent.id, nkeys.createUser(), { store: { load: () => tampered as AdmissionState, save: () => {} } }));
    expect(back.stanceFor(s.getPublicKey())).toBe("hold");
  });

  it("signs a roster the way the mesh verifies it", () => {
    const kp = nkeys.createUser();
    const r = signAdmissionRoster({ admission: "v1", owner_key: kp.getPublicKey(), defaults: { registered: "hold" }, entries: [], updated_at: "2026-10-13T00:00:00.000Z" }, kp);
    expect(verifyAdmissionRoster(r)).toBe(true);
    expect(verifyAdmissionRoster({ ...r, owner_key: nkeys.createUser().getPublicKey() })).toBe(false);
  });
});
