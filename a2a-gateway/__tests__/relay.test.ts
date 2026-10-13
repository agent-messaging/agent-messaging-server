/**
 * The relay doors and forwarding (src/inbound/relay.ts): what the gateway does
 * for a protocol front end beside it. On AgentMesh that is the platform's PACT
 * Provider (server/src/pact-provider/, tested there with a stand-in relay);
 * here is the gateway's half of a turn: the hosted identity per caller, the
 * attribution marker, the late reply of a queued request, and the admin gate.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { parseForwardRoutes } from "../src/inbound/relay.js";
import { MeshError, ErrorCode } from "../../sdk-typescript/src/types/errors.js";
import { BRIDGE_EXTENSION_URI } from "../src/core/card.js";
import { fakeConnect, manifestFixture, type FakeMesh } from "./helpers.js";

const BRAND = "B".repeat(56);
const ATTACHED = "A".repeat(56);
const HIDDEN = "H".repeat(56);

const open: Server[] = [];
afterEach(() => {
  while (open.length) {
    const s = open.pop()!;
    s.closeAllConnections?.();
    s.close();
  }
});

async function rig(forwardsRaw?: string): Promise<{ base: string; mesh: FakeMesh }> {
  const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "https://a2a.test.invalid", port: 0 });
  const manifests: Record<string, ReturnType<typeof manifestFixture>> = {
    [BRAND]: manifestFixture({ id: BRAND, name: "Larkspur Goods", offerings: [{ id: "chat", name: "Chat", description: "x" }] }),
    [ATTACHED]: manifestFixture({ id: ATTACHED, extensions: [{ uri: BRIDGE_EXTENSION_URI, description: "x" }] as never }),
    [HIDDEN]: manifestFixture({ id: HIDDEN, visibility: "private" } as never),
  };
  const mesh = fakeConnect(bridge, {
    discover: async () => ({ agents: Object.values(manifests), total: 3 }),
    getManifest: async (id: string) => {
      const m = manifests[id];
      if (!m) throw new Error("no such agent");
      return m;
    },
  });
  const server = await startInboundServer(bridge, undefined, parseForwardRoutes(forwardsRaw));
  open.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, mesh };
}

const turn = (base: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base}/admin/relay/turn`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

const T = { caller_key: "pact:abc", responder: BRAND, offering: "chat", input: { text: "hello" }, context_id: "ctx-1", meta: { pact: { pa: "iss", user: "u" } }, binding: "pact" };

describe("the relay doors", () => {
  it("answers what it knows of an agent under the exposure policy", async () => {
    const { base } = await rig();
    const a = (await (await fetch(`${base}/admin/relay/agents/${BRAND}`)).json()) as Record<string, any>;
    expect(a).toMatchObject({ exposed: true, priced: false, descriptor: null });
    expect(a.manifest.name).toBe("Larkspur Goods");
    expect(((await (await fetch(`${base}/admin/relay/agents/${HIDDEN}`)).json()) as Record<string, unknown>).manifest).toBeNull();
    expect((await fetch(`${base}/admin/relay/agents/not-an-agent`)).status).toBe(400);
  });

  it("sends a turn as the caller's hosted identity, with the attribution marker and the front end's meta", async () => {
    const { base, mesh } = await rig();
    mesh.answer = () => ({ task_id: null, payload: { status: "completed", output: { text: "hi back" } }, envelope: { id: "e" } });
    const res = (await (await turn(base, T)).json()) as Record<string, unknown>;
    expect(res).toEqual({ kind: "done", status: "completed", output: { text: "hi back" } });
    const q = mesh.requests[0]!;
    expect(q).toMatchObject({ to: BRAND, offering: "chat", input: { text: "hello" } });
    expect(q.config?.context_id).toBe("ctx-1");
    expect(q.config?.meta?.pact).toEqual({ pa: "iss", user: "u" });
    expect(q.config?.meta?.a2a_bridge).toMatchObject({ direction: "inbound" });
    await turn(base, T);
    expect(mesh.requests[1]!.from).toBe(q.from);
  });

  it("holds a queued request open for its late reply, from the agent it went to only", async () => {
    const { base, mesh } = await rig();
    mesh.answer = () => {
      throw new MeshError(ErrorCode.REQUEST_QUEUED, "queued", { details: { request_id: "req-43" } });
    };
    const pending = turn(base, T);
    await new Promise((res) => setTimeout(res, 100));
    const handler = mesh.defaultHandlers.get(mesh.requests[0]!.from)!;
    expect(() => handler({}, { envelope: { from: "USTRANGER", payload: { input: { in_reply_to: "req-43", text: "forged" } } } })).toThrow();
    handler({}, { envelope: { from: BRAND, payload: { input: { in_reply_to: "req-43", text: "LG-1042 shipped on Monday." } } } });
    expect(await (await pending).json()).toEqual({ kind: "done", status: "completed", output: { text: "LG-1042 shipped on Monday." } });
  });

  it("says a turn failed with the mesh's code, and refuses a malformed one", async () => {
    const { base, mesh } = await rig();
    mesh.answer = () => {
      throw new MeshError(ErrorCode.TRANSPORT_NO_RESPONDERS, "nobody");
    };
    expect(await (await turn(base, T)).json()).toEqual({ kind: "failed", code: ErrorCode.TRANSPORT_NO_RESPONDERS });
    expect((await turn(base, { ...T, responder: "nope" })).status).toBe(400);
  });

  it("answers only local, unproxied callers", async () => {
    const { base } = await rig();
    expect((await turn(base, T, { "X-Forwarded-For": "198.51.100.7" })).status).toBe(403);
  });
});

describe("forwarding to a front end beside the gateway", () => {
  it("passes /a2a/ and an admin prefix through whole, and /a2a/ is unknown without a forward", async () => {
    const seen: Array<{ method?: string; url?: string; body: string; auth?: string }> = [];
    const front = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
        res.writeHead(201, { "Content-Type": "application/a2a+json", "X-Front": "yes" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", () => r()));
    open.push(front);
    const f = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
    const { base } = await rig(`/a2a/=${f},/admin/pact=${f}`);
    const a = await fetch(`${base}/a2a/${BRAND}/message:send?x=1`, { method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: "{\"m\":1}" });
    expect(a.status).toBe(201);
    expect(a.headers.get("x-front")).toBe("yes");
    expect(seen[0]).toEqual({ method: "POST", url: `/a2a/${BRAND}/message:send?x=1`, body: "{\"m\":1}", auth: "Bearer t" });
    expect((await fetch(`${base}/admin/pact/platforms`)).status).toBe(201);
    expect((await fetch(`${base}/admin/pact/platforms`, { headers: { "X-Forwarded-For": "198.51.100.7" } })).status).toBe(403);
    expect(seen).toHaveLength(2);

    const { base: plain } = await rig();
    const none = await fetch(`${plain}/a2a/${BRAND}/.well-known/agent-card.json`);
    expect(none.status).toBe(404);
    expect(await none.text()).toBe("");
  });
});
