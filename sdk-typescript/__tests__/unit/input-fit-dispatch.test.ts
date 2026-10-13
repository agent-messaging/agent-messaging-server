// The input-fit layer in the SDK's dispatch (§12.2 INPUT_NOT_UNDERSTOOD,
// Common Agent §4.7.1): a help question on chat is answered from the card, a
// plain message to an agent with no chat handler gets the standard reply, and
// a structured input missing a required member is refused before the handler.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { RespondPayload } from "../../src/types/primitives.js";

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
        data: encode(signEnvelope(createEnvelope({
          type: "respond", from: registryKp.getPublicKey(), to: req.from, in_reply_to: req.id,
          payload: { status: "registered" },
        }), registryKp)),
      };
    }),
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
      subs.set(subject, cb);
      return { unsubscribe: () => subs.delete(subject), drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    raw: { publish: () => {} },
    get isClosed() { return false; },
  };
}
type Conn = ReturnType<typeof makeConn>;

const OFFERINGS = [
  {
    id: "read-site",
    name: "Read a site",
    description: "Reads a site into its pages' words.",
    input_schema: { type: "object", properties: { url: { type: "string", format: "uri" }, max_pages: { type: "string" } }, required: ["url"] },
  },
];

async function makeAgent(opts: { chat?: boolean; ran?: string[] } = {}) {
  const conn = makeConn();
  const agent = AgentMesh.withConnection(conn as unknown as ConnectionManager, nkeys.createUser(), nkeys.createUser());
  openAgents.push(agent);
  agent.onRequest("read-site", (input) => { opts.ran?.push("read-site"); return { ok: true, input }; });
  if (opts.chat) agent.onRequest("chat", () => { opts.ran?.push("chat"); return { text: "from the handler" }; });
  await agent.register({ name: "site-reader", description: "Reads sites.", offerings: OFFERINGS } as never);
  return { conn, agent };
}

function deliver(conn: Conn, agentId: string, senderKp: KeyPair, payload: unknown): Uint8Array[] {
  const env = createEnvelope({ type: "request", from: senderKp.getPublicKey(), to: agentId, payload });
  const signed = signEnvelope(env, senderKp);
  const replies: Uint8Array[] = [];
  const cb = conn.subs.get(Subjects.agentInbox(agentId));
  if (!cb) throw new Error("agent is not listening on its inbox");
  conn.subs.set(Subjects.agentInbox(senderKp.getPublicKey()), (m) => { replies.push((m as { data: Uint8Array }).data); });
  cb({ subject: Subjects.agentInbox(agentId), data: encode(signed), reply: "_INBOX.fit", respond: () => true });
  return replies;
}

const answer = (replies: Uint8Array[]): Envelope =>
  replies.map((d) => decode(d)).find((e) => (e.payload as RespondPayload | undefined)?.status !== "accepted")!;

describe("the input-fit layer in dispatch", () => {
  it("a help question on chat is answered from the card, without the chat handler", async () => {
    const ran: string[] = [];
    const { conn, agent } = await makeAgent({ chat: true, ran });
    const replies = deliver(conn, agent.id, nkeys.createUser(), { offering: "chat", input: "What can you do?" });
    await vi.waitFor(() => expect(answer(replies)).toBeTruthy());
    const e = answer(replies);
    const out = (e.payload as RespondPayload).output as { text: string; grade: string };
    expect((e.payload as RespondPayload).status).toBe("completed");
    expect(out.grade).toBe("declared");
    expect(out.text).toContain("Read a site (read-site)");
    expect(out.text).toContain("It takes: url (a web address, required)");
    expect(ran).toEqual([]);
  });

  it("a plain message to an agent with no chat handler gets the standard reply", async () => {
    const { conn, agent } = await makeAgent();
    const replies = deliver(conn, agent.id, nkeys.createUser(), { offering: "chat", input: "please read the acme site" });
    await vi.waitFor(() => expect(answer(replies)).toBeTruthy());
    const e = answer(replies);
    expect(e.error?.code).toBe("INPUT_NOT_UNDERSTOOD");
    expect(e.error?.message).toContain("site-reader could not use this message");
    expect((e.error?.details as { missing?: string[] }).missing).toEqual(["url"]);
    expect(((e.payload as RespondPayload).output as { text: string }).text).toBe(e.error?.message);
  });

  it("a structured input missing a required member is refused before the handler runs", async () => {
    const ran: string[] = [];
    const { conn, agent } = await makeAgent({ ran });
    const replies = deliver(conn, agent.id, nkeys.createUser(), { offering: "read-site", input: { max_pages: "3" } });
    await vi.waitFor(() => expect(answer(replies)).toBeTruthy());
    const e = answer(replies);
    expect(e.error?.code).toBe("INPUT_NOT_UNDERSTOOD");
    expect((e.error?.details as { reason: string; offering: string }).offering).toBe("read-site");
    expect(ran).toEqual([]);
  });

  it("a structured input that fits reaches the handler; and the layer can be turned off", async () => {
    const ran: string[] = [];
    const { conn, agent } = await makeAgent({ ran, chat: true });
    const r1 = deliver(conn, agent.id, nkeys.createUser(), { offering: "read-site", input: { url: "https://a.example" } });
    await vi.waitFor(() => expect(answer(r1)).toBeTruthy());
    expect((answer(r1).payload as RespondPayload).status).toBe("completed");
    agent.setInputFit({ enabled: false });
    const r2 = deliver(conn, agent.id, nkeys.createUser(), { offering: "chat", input: "help" });
    await vi.waitFor(() => expect(answer(r2)).toBeTruthy());
    expect(((answer(r2).payload as RespondPayload).output as { text: string }).text).toBe("from the handler");
    expect(ran).toEqual(["read-site", "chat"]);
  });
});
