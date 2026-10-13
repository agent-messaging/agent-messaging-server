// The naming rule on the sending side (naming-gate.ts), against
// conformance/naming-gate.json: the owner's words, the handle shape, the
// proposals and the cache. Then the gate itself on a stand-in lookup and
// clock, the registrar lookup against a stand-in naming service that signs its
// cards, and end to end: an agent that connected with requireNamed refuses
// every send it originates, publishes nothing while it does, and sends once
// it is named.
//
// THE FIXTURE IS THE AUTHORITY. The Rust SDK (sdk-rust/tests/naming_gate.rs)
// and the reference adapter (mesh-adapter/test/naming-gate.mjs) read the same
// file.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope, canonicalJSON } from "../../src/internal/identity.js";
import { encode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode, MeshError } from "../../src/types/errors.js";
import {
  NAMING_STANDARD_WORDS,
  NAMED_TTL_MS,
  UNNAMED_TTL_MS,
  isStandardHandle,
  proposeHandle,
  notNamedError,
  registrarNameLookup,
  NamingGate,
  type NameCheck,
} from "../../src/naming-gate.js";

const here = dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(readFileSync(join(here, "..", "..", "..", "conformance", "naming-gate.json"), "utf8"));

describe("the naming rule's words, shape and proposals (conformance/naming-gate.json)", () => {
  it("says the owner's words, exactly, with no em dash", () => {
    expect(NAMING_STANDARD_WORDS).toBe(F.words);
    expect(F.words).toBe(`${F.naming_standard} This agent does not have one yet, so nothing was sent.`);
    expect(ErrorCode.NOT_NAMED).toBe(F.code);
    expect(F.outage).toBe("send");
    expect(/—/.test(F.words)).toBe(false);
  });
  it("keeps answers as long as the fixture says", () => {
    expect(NAMED_TTL_MS).toBe(F.cache.named_ttl_ms);
    expect(UNNAMED_TTL_MS).toBe(F.cache.unnamed_ttl_ms);
  });
  for (const h of F.standard as string[]) it(`${h} follows the standard`, () => expect(isStandardHandle(h)).toBe(true));
  for (const h of F.not_standard as string[]) it(`${JSON.stringify(h)} does not`, () => expect(isStandardHandle(h)).toBe(false));
  for (const p of F.proposals as { name: string | null; email: string | null; proposed_name: string | null; handle: string }[]) {
    it(`proposes ${p.handle} from ${JSON.stringify(p.name)} and ${JSON.stringify(p.email)}`, () => {
      const got = proposeHandle(p.name, p.email);
      expect(got.handle).toBe(p.handle);
      expect(got.name).toBe(p.proposed_name);
    });
  }
  it("the refusal opens with the words, then the proposal and how to name", () => {
    const e = notNamedError({ name: "Genesis", email: "stephen@example.com" });
    expect(e.code).toBe(ErrorCode.NOT_NAMED);
    expect(e.retryable).toBe(false);
    expect(e.message.startsWith(F.words)).toBe(true);
    expect(e.message).toContain("The proposed name is genesis.stephen@example.com, and stephen@example.com confirms it with a code we email.");
    expect(e.message).toContain('completeNaming with the code and the name "genesis"');
    expect(e.details?.proposed_handle).toBe("genesis.stephen@example.com");
  });
});

describe("NamingGate: the one check and its cache", () => {
  const gateWith = (answers: NameCheck[], extra: { lastVerified?: string } = {}) => {
    let t = 1_000_000;
    const lookup = vi.fn(async () => answers.length > 1 ? answers.shift()! : answers[0]!);
    const gate = new NamingGate({ agentId: "UAGENT", lookup, name: "Genesis", ownerEmail: "stephen@example.com", now: () => t, ...extra });
    return { gate, lookup, advance: (ms: number) => { t += ms; } };
  };

  it("a named agent passes, and the answer is kept for the named TTL", async () => {
    const { gate, lookup, advance } = gateWith([{ status: "named", handle: "genesis.stephen@example.com" }]);
    await gate.require();
    advance(NAMED_TTL_MS - 1);
    await gate.require();
    expect(lookup).toHaveBeenCalledTimes(1);
    advance(2);
    await gate.require();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("an unnamed agent is refused with the words; the answer is kept only briefly", async () => {
    const { gate, lookup, advance } = gateWith([{ status: "unnamed", handle: null }, { status: "named", handle: "genesis.stephen@example.com" }]);
    await expect(gate.require()).rejects.toMatchObject({ code: ErrorCode.NOT_NAMED });
    await expect(gate.require()).rejects.toMatchObject({ code: ErrorCode.NOT_NAMED });
    expect(lookup).toHaveBeenCalledTimes(1);
    advance(UNNAMED_TTL_MS);
    await gate.require(); // named a moment ago: it sends at once
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("a handle not in the standard shape is not a name", async () => {
    const { gate } = gateWith([{ status: "named", handle: "genesis" }]);
    await expect(gate.require()).rejects.toMatchObject({ code: ErrorCode.NOT_NAMED });
  });

  it("an unreachable naming service lets the send through, and is asked again soon", async () => {
    const withLast = gateWith([{ status: "unreachable" }], { lastVerified: "genesis.stephen@example.com" });
    await withLast.gate.require();
    expect(withLast.gate.current()).toMatchObject({ named: true, unchecked: true, handle: "genesis.stephen@example.com" });
    const { gate, lookup, advance } = gateWith([{ status: "unreachable" }, { status: "unnamed" }]);
    await gate.require(); // an outage is not evidence of no name
    advance(UNNAMED_TTL_MS);
    await expect(gate.require()).rejects.toMatchObject({ code: ErrorCode.NOT_NAMED });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("requireCached goes on the last answer, and does not refuse before there is one", async () => {
    const { gate } = gateWith([{ status: "unnamed" }]);
    expect(() => gate.requireCached()).not.toThrow();
    await gate.check();
    expect(() => gate.requireCached()).toThrow(MeshError);
  });

  it("forget() makes the next send ask again", async () => {
    const { gate, lookup } = gateWith([{ status: "unnamed" }, { status: "named", handle: "genesis.stephen@example.com" }]);
    await expect(gate.require()).rejects.toMatchObject({ code: ErrorCode.NOT_NAMED });
    gate.forget();
    await gate.require();
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe("registrarNameLookup: the naming service's verified reverse lookup", () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise((r) => server!.close(() => r(null))); server = null; });

  const serve = async (answer: (agentId: string) => { status: number; body?: unknown }) => {
    const kp = nkeys.createAccount();
    server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (u.pathname === "/api/registrar-key") return json(200, { keys: [kp.getPublicKey()] });
      const a = answer(u.searchParams.get("agent_id") ?? "");
      return json(a.status, a.body ?? {});
    });
    await new Promise((r) => server!.listen(0, "127.0.0.1", () => r(null)));
    const url = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const signed = (card: Record<string, unknown>, by = kp) => ({
      ok: true, card, registrar_key: kp.getPublicKey(),
      registrar_sig: Buffer.from(by.sign(new TextEncoder().encode(canonicalJSON(card)))).toString("base64"),
    });
    return { url, signed };
  };
  const cardFor = (agentId: string, handle: string) => ({ handle, operator: { name: "T" }, endpoints: [{ protocol: "agentmesh", agent_id: agentId }] });

  it("named, unnamed, unreachable, and a card that does not verify or bind", async () => {
    const other = nkeys.createAccount();
    let mode = "named";
    const { url, signed } = await serve((id) => {
      if (mode === "named") return { status: 200, body: signed(cardFor(id, "genesis.stephen@example.com")) };
      if (mode === "shape") return { status: 200, body: signed(cardFor(id, "genesis")) };
      if (mode === "404") return { status: 404, body: { ok: false } };
      if (mode === "forged") return { status: 200, body: signed(cardFor(id, "genesis.stephen@example.com"), other) };
      if (mode === "unbound") return { status: 200, body: signed(cardFor("USOMEONEELSE", "genesis.stephen@example.com")) };
      return { status: 503 };
    });
    const lookup = registrarNameLookup(url);
    expect(await lookup("UAGENT")).toEqual({ status: "named", handle: "genesis.stephen@example.com" });
    mode = "shape"; expect(await lookup("UAGENT")).toEqual({ status: "unnamed", handle: "genesis" });
    mode = "404"; expect(await lookup("UAGENT")).toEqual({ status: "unnamed", handle: null });
    mode = "forged"; expect((await lookup("UAGENT")).status).toBe("unreachable");
    mode = "unbound"; expect((await lookup("UAGENT")).status).toBe("unreachable");
    mode = "down"; expect((await lookup("UAGENT")).status).toBe("unreachable");
    expect((await registrarNameLookup("http://127.0.0.1:9")("UAGENT")).status).toBe("unreachable");
  });
});

describe("an agent that connected with requireNamed", () => {
  const open: AgentMesh[] = [];
  afterEach(async () => { for (const a of open.splice(0)) await a.close(); });

  function makeConn() {
    const peer = nkeys.createUser();
    const sentTo: string[] = [];
    const subs = new Map<string, (msg: unknown) => void>();
    const conn = {
      sentTo,
      publish: vi.fn((subject: string) => { sentTo.push(subject); }),
      request: vi.fn(async (subject: string, data: Uint8Array) => {
        sentTo.push(subject);
        const req = decodeUnverified(data);
        const bytes = encode(signEnvelope(createEnvelope({ type: "respond", from: peer.getPublicKey(), to: req.from, in_reply_to: req.id, payload: { output: { text: "ok" } } }), peer));
        const inbox = Subjects.agentInbox(req.from);
        subs.get(inbox)?.({ subject: inbox, data: bytes, reply: undefined, respond: () => true });
        return { data: bytes };
      }),
      subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => { subs.set(subject, cb); return { unsubscribe: () => subs.delete(subject), drain: async () => {} }; }),
      drain: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      raw: { publish: () => {} },
      get isClosed() { return false; },
    };
    return { conn, peer };
  }

  it("refuses every send it originates, publishes nothing, and sends once named", async () => {
    let answer: NameCheck = { status: "unnamed", handle: null };
    const lookup = vi.fn(async () => answer);
    const { conn, peer } = makeConn();
    const mesh = AgentMesh.withConnection(conn as unknown as ConnectionManager, nkeys.createUser(), undefined, {
      requireNamed: { lookup, name: "Genesis", ownerEmail: "stephen@example.com" },
    });
    open.push(mesh);
    let thrown: MeshError | undefined;
    try { await mesh.request(peer.getPublicKey(), "chat", { text: "hi" }); } catch (e) { thrown = e as MeshError; }
    expect(thrown?.code).toBe(ErrorCode.NOT_NAMED);
    expect(thrown?.message.startsWith(F.words)).toBe(true);
    expect(thrown?.details?.proposed_handle).toBe("genesis.stephen@example.com");
    await expect(mesh.requestStream(peer.getPublicKey(), "chat", { prompt: "hi" })).rejects.toMatchObject({ code: ErrorCode.NOT_NAMED });
    expect(() => mesh.emit("build.done", {})).toThrow(/AgentMesh uses one global standard/);
    expect(() => mesh.publishFeed("status", { up: true })).toThrow(/AgentMesh uses one global standard/);
    expect(() => mesh.openRoom({ name: "r" })).toThrow(/AgentMesh uses one global standard/);
    expect(conn.sentTo).toEqual([]); // nothing published, so nothing signed
    expect(mesh.namingStatus()).toMatchObject({ named: false });

    answer = { status: "named", handle: "genesis.stephen@example.com" };
    expect(await mesh.recheckName()).toMatchObject({ named: true, handle: "genesis.stephen@example.com" });
    await mesh.request(peer.getPublicKey(), "chat", { text: "hi" });
    expect(conn.sentTo.length).toBeGreaterThan(0);
    expect(() => mesh.emit("build.done", {})).not.toThrow();
  });

  it("an agent that did not ask for the rule is untouched by it", async () => {
    const { conn, peer } = makeConn();
    const mesh = AgentMesh.withConnection(conn as unknown as ConnectionManager, nkeys.createUser());
    open.push(mesh);
    await mesh.request(peer.getPublicKey(), "chat", { text: "hi" });
    expect(mesh.namingStatus()).toBeNull();
  });
});

// 2026-09-27, no anonymous agents: AgentMesh.connect() turns the rule on
// unless the caller says `requireNamed: false` (tests only). connect() needs a
// live transport, so the default is pinned on the source and on the builder
// the default feeds.
describe("the rule is on by default for connect()", () => {
  it("connect() builds the gate from `requireNamed ?? true`", () => {
    const src = readFileSync(join(here, "..", "..", "src", "mesh.ts"), "utf8");
    expect(src).toMatch(/mesh\.namingGate = namingGateFor\(agentId, opts\?\.requireNamed \?\? true\);/);
  });

  it("true builds a gate, false builds none", async () => {
    const { namingGateFor } = await import("../../src/naming-gate.js");
    const id = nkeys.createUser().getPublicKey();
    expect(namingGateFor(id, undefined ?? true)).not.toBeNull();
    expect(namingGateFor(id, false)).toBeNull();
  });
});
