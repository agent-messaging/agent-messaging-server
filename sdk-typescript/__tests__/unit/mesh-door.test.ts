// The mesh's own requests on the SDK door (platform-services/*.json with
// "part": "mesh"): mesh.messages, mesh.contacts, mesh.owner, mesh.identity,
// mesh.names, mesh.feeds and mesh.registry. What matters is that each answer
// has the definition's fields, each refusal is one of the definition's codes,
// nothing over the mesh's limit is sent (or cut), and every door the
// definitions name the SDK for is here. A fake AgentMesh stands in for the
// connection, and fetch is stubbed for the platform and the naming service.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MessagesDoor, ContactsDoor, OwnerDoor, IdentityDoor, NamesDoor, FeedsDoor, RegistryDoor, MESH_TEXT_MAX, type MeshDoorContext,
} from "../../src/mesh-door.js";
import { ServiceRefusal, SDK_REQUESTS } from "../../src/services.generated.js";
import { MeshError, ErrorCode } from "../../src/types/errors.js";
import type { AgentMesh } from "../../src/mesh.js";

const ME = "U" + "A".repeat(55);
const PEER = "U" + "B".repeat(55);
const ANN = "U" + "C".repeat(55);

function fakeMesh(over: Record<string, unknown> = {}) {
  const asked: Array<{ to: string; offering: string; input: unknown; cfg: unknown }> = [];
  const published: Array<{ topic: string; data: unknown; kind: string }> = [];
  const declared = new Map<string, "state" | "stream">();
  const mesh = {
    id: ME,
    registered: false,
    asked,
    published,
    request: async (to: string, offering: string, input: unknown, cfg: unknown) => {
      asked.push({ to, offering, input, cfg });
      return { task_id: null, payload: { output: { text: "Got it." } }, envelope: { in_reply_to: "req-1" } };
    },
    discover: async () => ({ total: 1, agents: [{ id: PEER, name: "helper", description: "helps (a live session answers)", offerings: [{ id: "chat" }], availability: "online" }] }),
    signDetached: (m: string) => `sig(${m})`,
    namingStatus: () => ({ named: true, handle: "me.owner@example.com", checkedAt: 0 }),
    recheckName: async () => ({ named: true, handle: "me.owner@example.com", checkedAt: 0 }),
    declareFeed: (topic: string, kind: "state" | "stream") => { declared.set(topic, kind); },
    publishFeed: (topic: string, data: unknown, o: { kind: string }) => { published.push({ topic, data, kind: o.kind }); },
    feedValue: async (agent: string, topic: string) => (agent === ANN && topic === "announcements" ? { ts: "2026-10-05T00:00:00Z", payload: { kind: "stream", data: { title: "Maintenance tonight" } } } : null),
    trackFeed: async () => ({ snapshot: null, stop: () => {} }),
    ...over,
  };
  const ctx: MeshDoorContext = {
    mesh: mesh as unknown as AgentMesh,
    api: () => "https://api.test",
    registrar: () => "https://naming.test",
    declaredFeeds: () => [...declared.entries()].map(([topic, kind]) => ({ topic, kind })),
    retireFeed: (topic) => declared.delete(topic),
  };
  return { mesh, ctx };
}

async function refusedWith(p: Promise<unknown>): Promise<ServiceRefusal> {
  try { await p; } catch (e) { if (e instanceof ServiceRefusal) return e; throw e; }
  throw new Error("expected a refusal");
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("every SDK door the definitions name", () => {
  it("has a door: messages.send, contacts.knock and presence, owner.ask, identity.me, names, feeds, registry.list", () => {
    const mesh = SDK_REQUESTS.filter((r) => ["messages", "contacts", "owner", "identity", "names", "feeds", "registry"].includes(r.service)).map((r) => r.id).sort();
    expect(mesh).toEqual([
      "contacts.knock", "contacts.presence", "feeds.declare", "feeds.follow", "feeds.list", "feeds.publish", "feeds.read", "feeds.retire", "feeds.unfollow",
      "identity.me", "messages.send", "names.claim", "names.confirm", "names.resolve", "owner.ask", "registry.list",
    ]);
  });
});

describe("mesh.messages", () => {
  it("sends to an agent id, with the context, and answers with the reply", async () => {
    const { mesh, ctx } = fakeMesh();
    const out = await new MessagesDoor(ctx).send({ to: PEER, text: "hello", context: "c-1" });
    expect(out).toEqual({ delivered: true, reply: "Got it.", request_id: "req-1" });
    expect(mesh.asked[0]).toMatchObject({ to: PEER, offering: "chat", input: { text: "hello" }, cfg: { context_id: "c-1" } });
  });

  it("a queued message is delivered: false with the request id, not an error", async () => {
    const { ctx } = fakeMesh({ request: async () => { throw new MeshError(ErrorCode.REQUEST_QUEUED, "queued", { details: { queued: true, request_id: "req-9" } }); } });
    const out = await new MessagesDoor(ctx).send({ to: PEER, text: "hello" });
    expect(out).toMatchObject({ delivered: false, request_id: "req-9" });
  });

  it("refuses over the mesh's limit before anything is sent, and never cuts", async () => {
    const { mesh, ctx } = fakeMesh();
    const r = await refusedWith(new MessagesDoor(ctx).send({ to: PEER, text: "x".repeat(MESH_TEXT_MAX + 1) }));
    expect(r.code).toBe("TOO_BIG");
    expect(mesh.asked).toHaveLength(0);
  });

  it("an unnamed agent's send is NOT_NAMED, in the naming rule's words", async () => {
    const { ctx } = fakeMesh({ request: async () => { const e = new MeshError("NOT_NAMED" as never, "AgentMesh uses one global standard for agent names."); throw e; } });
    const r = await refusedWith(new MessagesDoor(ctx).send({ to: PEER, text: "hello" }));
    expect(r.code).toBe("NOT_NAMED");
    expect(r.message).toContain("one global standard");
  });
});

describe("mesh.contacts", () => {
  it("a knock carries via and grants; a grant off the list is refused; a refused knock is REFUSED", async () => {
    const { mesh, ctx } = fakeMesh();
    const door = new ContactsDoor(ctx);
    expect(await door.knock({ to: PEER, via: "the catalog", grants: ["messages"] })).toMatchObject({ to: PEER });
    expect(mesh.asked[0]).toMatchObject({ offering: "knock", input: { via: "the catalog", grants: ["messages"] } });
    expect((await refusedWith(door.knock({ to: PEER, grants: ["everything"] }))).code).toBe("INPUT_INVALID");
    const refusing = new ContactsDoor(fakeMesh({ request: async () => ({ payload: { refused: true, code: "REGISTER_FIRST", error: "register first" }, envelope: {} }) }).ctx);
    const r = await refusedWith(refusing.knock({ to: PEER }));
    expect(r.code).toBe("REFUSED");
    expect(r.message).toContain("REGISTER_FIRST");
  });

  it("presence names who is around, in the adapter's words, and nobody when nobody is named", async () => {
    const { ctx } = fakeMesh();
    const out = await new ContactsDoor(ctx).presence({ who: [PEER] });
    expect(out.contacts).toEqual([{ name: PEER, agent_id: PEER, state: "online", attended: true, line: "online · a live session may answer" }]);
    expect(await new ContactsDoor(ctx).presence({})).toEqual({ contacts: [] });
  });
});

describe("mesh.owner", () => {
  it("asks the owner's own agent, signed; an unlinked agent is NOT_LINKED", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ hosted: { agent_id: PEER, handle: "owner.owner@example.com" } }), { status: 200 });
    });
    const { mesh, ctx } = fakeMesh();
    const out = await new OwnerDoor(ctx).ask({ text: "May I spend $20?", choices: ["yes", "no"] });
    expect(out).toEqual({ to: "owner.owner@example.com", held: false, request_id: "req-1" });
    expect(calls[0].url).toBe("https://api.test/v1/agent/owner");
    expect((calls[0].body as { sig: string }).sig).toMatch(/^sig\(owner-agent-v1:U/);
    expect(mesh.asked[0]).toMatchObject({ to: PEER, input: { text: "May I spend $20?", ask: { kind: "question", choices: ["yes", "no"] } } });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    expect((await refusedWith(new OwnerDoor(ctx).ask({ text: "?" }))).code).toBe("NOT_LINKED");
  });
});

describe("mesh.identity", () => {
  it("says who this agent is and whether it may send", async () => {
    const named = await new IdentityDoor(fakeMesh().ctx).me();
    expect(named).toEqual({ agent_id: ME, handle: "me.owner@example.com", name: "me", can_send: true });
    const unnamed = await new IdentityDoor(fakeMesh({ namingStatus: () => ({ named: false, handle: null, checkedAt: 0 }) }).ctx).me();
    expect(unnamed).toMatchObject({ agent_id: ME, can_send: false });
    expect(unnamed.get_a_name).toContain("names.claim()");
  });
});

describe("mesh.names", () => {
  it("claims with the owner's email, and confirms with the code, binding the name to this key", async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/api/handles/verify")) return new Response(JSON.stringify({ token: "t-1" }), { status: 200 });
      if (url.endsWith("/api/operator")) return new Response(JSON.stringify({ name: "Ann Chen" }), { status: 200 });
      if (url.endsWith("/api/handles/claim")) return new Response(JSON.stringify({ handle: "little-buddy.ann@example.com" }), { status: 200 });
      if (url.endsWith("/api/pair/start")) return new Response(JSON.stringify({ code: "kx4-92f" }), { status: 200 });
      if (url.endsWith("/api/pair/complete")) return new Response(JSON.stringify({ handle: "little-buddy.ann@example.com" }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const door = new NamesDoor(fakeMesh({ namingStatus: () => ({ named: false, handle: null, checkedAt: 0 }) }).ctx);
    expect((await refusedWith(door.claim({ name: "little-buddy" }))).code).toBe("INPUT_INVALID");
    expect((await refusedWith(door.confirm({ code: "123456" }))).code).toBe("NO_CLAIM");
    expect(await door.claim({ name: "Little Buddy", email: "ann@example.com" })).toEqual({ name: "little-buddy", handle: "little-buddy.ann@example.com", code_sent_to: "ann@example.com" });
    const done = await door.confirm({ code: "123456" });
    expect(done).toEqual({ handle: "little-buddy.ann@example.com", agent_id: ME, check_at: "https://naming.test/api/resolve?handle=little-buddy.ann%40example.com" });
    expect(posts.find((p) => p.url.endsWith("/api/pair/complete"))?.body).toEqual({ code: "kx4-92f", agent_id: ME, signature: `sig(pan-pair-v1:KX4-92F:${ME})` });
    expect((await refusedWith(new NamesDoor(fakeMesh().ctx).claim({ name: "x", email: "a@b.co" }))).code).toBe("ALREADY_NAMED");
  });
});

describe("mesh.feeds", () => {
  it("declares, publishes with the declared kind, reads AgentMesh's own channel, retires", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ channels: [{ id: "announcements", topic: "announcements", agent: ANN }] }), { status: 200 }));
    const { mesh, ctx } = fakeMesh();
    const door = new FeedsDoor(ctx);
    expect((await refusedWith(door.declare({ topic: "bad.topic" }))).code).toBe("INPUT_INVALID");
    expect(await door.declare({ topic: "status", kind: "stream" })).toMatchObject({ topic: "status", kind: "stream" });
    expect(await door.publish({ topic: "status", data: "busy" })).toEqual({ topic: "status", kind: "stream" });
    expect(mesh.published[0]).toEqual({ topic: "status", data: { text: "busy" }, kind: "stream" });
    const news = await door.read({ target: "agentmesh", topic: "announcements" });
    expect(news).toMatchObject({ agent_id: ANN, topic: "announcements", current: { title: "Maintenance tonight" }, as_of: "2026-10-05T00:00:00Z", kind: "stream" });
    expect((await refusedWith(door.read({ target: "agentmesh", topic: "gossip" }))).code).toBe("NOT_FOUND");
    expect(await door.retire({ topic: "status" })).toMatchObject({ topic: "status" });
    expect((await refusedWith(door.retire({ topic: "status" }))).code).toBe("NOT_DECLARED");
  });
});

describe("mesh.registry", () => {
  it("lists the agents on the mesh in the definition's fields", async () => {
    expect(await new RegistryDoor(fakeMesh().ctx).list({ capability: "chat" })).toEqual({
      total: 1, agents: [{ agent_id: PEER, name: "helper", description: "helps (a live session answers)", offerings: ["chat"] }],
    });
  });
});
