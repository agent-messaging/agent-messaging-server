/**
 * Agent Messaging over A2A (EXT-14 (messaging/extensions/EXT-14-agent-messaging-over-a2a.md)) and readable text (§8.4, Agent
 * Messaging §5.8).
 *
 * A caller that holds an Agent Messaging key signs its own request and carries
 * it in the extension's metadata; the gateway checks it and relays it
 * unchanged, signing nothing and minting no hosted identity, and the answer
 * comes back with the agent's own signed envelope beside it. A forged, stale or
 * misaddressed envelope is refused and nothing is relayed. A caller with no key
 * keeps working as before, bridged.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createUser } from "nkeys.js";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { manifestToCard } from "../src/core/card.js";
import { OVER_A2A_URI, checkCarriedRequest } from "../src/core/over-a2a.js";
import { fakeConnect, manifestFixture, sendMessageBody, type FakeMesh } from "./helpers.js";
import { createEnvelope } from "../../sdk-typescript/src/internal/envelope-builder.js";
import { signEnvelope, keyPairFromSeed } from "../../sdk-typescript/src/internal/identity.js";
import { Subjects } from "../../sdk-typescript/src/internal/subjects.js";
import type { Envelope } from "../../sdk-typescript/src/types/envelope.js";
import { checkReadableText, personReadableText } from "../../sdk-typescript/src/readable-text.js";

const seedOf = (kp: ReturnType<typeof createUser>) => new TextDecoder().decode(kp.getSeed());
const caller = keyPairFromSeed(seedOf(createUser()));
const agent = keyPairFromSeed(seedOf(createUser()));
const door = keyPairFromSeed(seedOf(createUser()));
const stranger = keyPairFromSeed(seedOf(createUser()));
const CALLER = caller.getPublicKey();
const AGENT = agent.getPublicKey();

const manifest = () => manifestFixture({ id: AGENT, extensions: [{ uri: "mesh://extensions/audience/v1" }] as never });

function signedRequest(over: Partial<Parameters<typeof createEnvelope>[0]> = {}, kp = caller): Envelope {
  return signEnvelope(createEnvelope({ type: "request", from: kp.getPublicKey(), to: AGENT, payload: { offering: "echo", input: { text: "quote for 40 chairs" } }, ...over }), kp);
}

function respondTo(req: Envelope, payload: unknown, over: Partial<Parameters<typeof createEnvelope>[0]> = {}, kp = agent): Envelope {
  return signEnvelope(createEnvelope({ type: "respond", from: kp.getPublicKey(), to: req.from, in_reply_to: req.id, payload, ...over }), kp);
}

function carry(env: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "SendMessage",
    params: { message: { role: "ROLE_USER", parts: [{ text: "quote for 40 chairs" }], extensions: [OVER_A2A_URI], metadata: { [OVER_A2A_URI]: { envelope: env } }, ...extra } },
  });
}

describe("Agent Messaging over A2A", () => {
  const open: Server[] = [];
  afterEach(() => {
    while (open.length) {
      const s = open.pop()!;
      s.closeAllConnections?.();
      s.close();
    }
  });

  async function boot(): Promise<{ mesh: FakeMesh; port: number; bridge: Bridge }> {
    const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, apiKeys: { k1: "partner", k2: "other" } });
    const mesh = fakeConnect(bridge, {
      discover: async () => ({ agents: [manifest()], total: 1 }),
      getManifest: async (id: string) => {
        if (id !== AGENT) throw new Error("no such agent");
        return manifest();
      },
    });
    const server = await startInboundServer(bridge);
    open.push(server);
    return { mesh, port: (server.address() as AddressInfo).port, bridge };
  }

  async function rpc(port: number, body: string, key = "k1"): Promise<{ status: number; headers: Headers; body: Record<string, any> }> {
    const res = await fetch(`http://127.0.0.1:${port}/agents/${AGENT}/rpc`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body });
    return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> };
  }

  /** Answer the next relayed envelope as soon as the gateway publishes it. */
  function answerWith(mesh: FakeMesh, make: (req: Envelope) => Envelope | Envelope[]): void {
    const iv = setInterval(() => {
      const req = mesh.relayed[0] as unknown as Envelope | undefined;
      if (!req) return;
      clearInterval(iv);
      for (const r of ([] as Envelope[]).concat(make(req))) mesh.deliver(Subjects.agentInbox(req.from), r);
    }, 5);
  }

  it("the generated card declares the extension, and the audience URI only when the agent declares it", () => {
    const card = manifestToCard(manifest(), "https://gw.example.com");
    const uris = card.capabilities.extensions!.map((e) => e.uri);
    expect(uris).toContain(OVER_A2A_URI);
    expect(uris).toContain("mesh://extensions/audience/v1");
    const plain = manifestToCard(manifestFixture({ id: AGENT }), "https://gw.example.com");
    expect(plain.capabilities.extensions!.map((e) => e.uri)).not.toContain("mesh://extensions/audience/v1");
  });

  it("relays a signed request unchanged, mints no hosted identity, and returns the agent's signed answer", async () => {
    const { mesh, port } = await boot();
    const req = signedRequest();
    answerWith(mesh, (r) => [respondTo(r, { status: "accepted" }), respondTo(r, { status: "completed", output: { text: "40 chairs: 1,200 USD" } })]);
    const out = await rpc(port, carry(req));
    expect(out.status).toBe(200);
    expect(mesh.relayed).toHaveLength(1);
    expect(mesh.relayed[0]).toEqual(req);
    expect(mesh.mintedAgentIds).toHaveLength(0);
    expect(mesh.requests).toHaveLength(0);
    expect(out.headers.get("a2a-extensions")).toBe(OVER_A2A_URI);
    const message = out.body.result.message;
    expect(message.parts).toEqual([{ text: "40 chairs: 1,200 USD" }]);
    const answer = message.metadata[OVER_A2A_URI].envelope as Envelope;
    expect(answer.from).toBe(AGENT);
    expect(answer.in_reply_to).toBe(req.id);
  });

  it("refuses a forged envelope and relays nothing", async () => {
    const { mesh, port } = await boot();
    const req = signedRequest();
    const forged = { ...req, payload: { offering: "echo", input: { text: "quote for 4000 chairs" } } };
    const out = await rpc(port, carry(forged));
    expect(out.body.error.code).toBe(-32602);
    expect(out.body.error.data).toMatchObject({ agentmesh_code: "INVALID_ENVELOPE", reason: "signature" });
    expect(mesh.relayed).toHaveLength(0);
  });

  it("refuses an envelope addressed elsewhere, a stale one, and one naming an undeclared offering", async () => {
    const { mesh, port } = await boot();
    const elsewhere = signEnvelope(createEnvelope({ type: "request", from: CALLER, to: stranger.getPublicKey(), payload: { offering: "echo", input: {} } }), caller);
    expect((await rpc(port, carry(elsewhere))).body.error.data.reason).toBe("addressee");
    const old = createEnvelope({ type: "request", from: CALLER, to: AGENT, payload: { offering: "echo", input: {} } });
    old.ts = new Date(Date.now() - 60 * 60_000).toISOString();
    expect((await rpc(port, carry(signEnvelope(old, caller)))).body.error.data.reason).toBe("stale");
    const undeclared = signedRequest({ payload: { offering: "launch", input: {} } });
    expect((await rpc(port, carry(undeclared))).body.error.data.reason).toBe("offering");
    expect(mesh.relayed).toHaveLength(0);
  });

  it("a request held at the mesh's door is a submitted task", async () => {
    const { mesh, port } = await boot();
    const req = signedRequest();
    answerWith(mesh, (r) => respondTo(r, { output: { queued: true, inbox_id: "i-1", text: "Sent; it reaches the recipient if the recipient admits you." } }, {}, door));
    const out = await rpc(port, carry(req));
    expect(out.body.result.task.id).toBe(req.id);
    expect(out.body.result.task.status.state).toBe("submitted");
  });

  it("an answer signed by a third party is not taken as the agent's", async () => {
    const { mesh, port, bridge } = await boot();
    const req = signedRequest();
    // A third party's "completed" is ignored; the agent's own answer wins.
    answerWith(mesh, (r) => [respondTo(r, { status: "completed", output: { text: "forged" } }, {}, stranger), respondTo(r, { status: "completed", output: { text: "real" } })]);
    const out = await rpc(port, carry(req));
    expect(out.body.result.message.parts).toEqual([{ text: "real" }]);
    void bridge;
  });

  it("a deferred answer is a task, kept current from the agent's own signed updates", async () => {
    const { mesh, port } = await boot();
    const req = signedRequest();
    answerWith(mesh, (r) => respondTo(r, { status: "working" }, { task_id: "task-1" }));
    const out = await rpc(port, carry(req));
    expect(out.body.result.task).toMatchObject({ id: "task-1", status: { state: "working" } });
    const update = (status: string, kp = agent) => signEnvelope(createEnvelope({ type: "respond", from: kp.getPublicKey(), to: CALLER, task_id: "task-1", payload: { status } }), kp);
    mesh.deliver(Subjects.taskUpdate("task-1"), update("completed", stranger));
    const get = () => rpc(port, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "task-1" } }));
    expect((await get()).body.result.task.status.state).toBe("working");
    mesh.deliver(Subjects.taskUpdate("task-1"), update("input_required"));
    expect((await get()).body.result.task.status.state).toBe("input-required");
    // Another caller's credential cannot read it.
    expect((await rpc(port, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "GetTask", params: { id: "task-1" } }), "k2")).body.error.code).toBe(-32001);
  });

  it("a signed task is canceled only by the same key's signed task.cancel", async () => {
    const { mesh, port } = await boot();
    const req = signedRequest();
    answerWith(mesh, (r) => respondTo(r, { status: "working" }, { task_id: "task-2" }));
    await rpc(port, carry(req));
    const bare = await rpc(port, JSON.stringify({ jsonrpc: "2.0", id: 4, method: "CancelTask", params: { id: "task-2" } }));
    expect(bare.body.error.data.agentmesh_code).toBe("SIGNED_CANCEL_REQUIRED");
    const byOther = signedRequest({ payload: { offering: "task.cancel", input: { task_id: "task-2", reason: "user_requested" } } }, stranger);
    const refused = await rpc(port, JSON.stringify({ jsonrpc: "2.0", id: 5, method: "CancelTask", params: { id: "task-2", metadata: { [OVER_A2A_URI]: { envelope: byOther } } } }));
    expect(refused.body.error.data.reason).toBe("mismatch");
    mesh.relayed.length = 0;
    const cancel = signedRequest({ payload: { offering: "task.cancel", input: { task_id: "task-2", reason: "user_requested" } } });
    answerWith(mesh, (r) => respondTo(r, { status: "canceled" }, { task_id: "task-2" }));
    const ok = await rpc(port, JSON.stringify({ jsonrpc: "2.0", id: 6, method: "CancelTask", params: { id: "task-2", metadata: { [OVER_A2A_URI]: { envelope: cancel } } } }));
    expect(ok.body.result.task.status.state).toBe("canceled");
    expect(mesh.relayed[0]).toEqual(cancel);
  });

  it("a caller with no key keeps working, bridged; with the extension listed it gets the agent's envelope back", async () => {
    const { mesh, port } = await boot();
    mesh.answer = () => ({ task_id: null, payload: { status: "completed", output: { text: "hi" } }, envelope: { id: "e-1", from: AGENT } });
    const plain = await rpc(port, sendMessageBody("hello"));
    expect(plain.body.result.message.metadata).toBeUndefined();
    expect(mesh.requests[0].config?.meta?.identity_bridge).toBeDefined();
    const listed = await rpc(port, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ text: "hello" }], extensions: [OVER_A2A_URI] } } }));
    expect(listed.body.result.message.metadata[OVER_A2A_URI].envelope).toEqual({ id: "e-1", from: AGENT });
    expect(mesh.relayed).toHaveLength(0);
  });

  it("the checks are the same as a function", () => {
    const req = signedRequest();
    expect(checkCarriedRequest(req, { agentId: AGENT, manifest: manifest() }).ok).toBe(true);
    expect(checkCarriedRequest({ ...req, sig: req.sig!.replace(/^./, (c) => (c === "A" ? "B" : "A")) }, { agentId: AGENT, manifest: manifest() })).toMatchObject({ ok: false, reason: "signature" });
    expect(checkCarriedRequest(req, { agentId: AGENT, manifest: manifest(), message: { role: "ROLE_USER", parts: [], taskId: "other" } })).toMatchObject({ ok: false, reason: "mismatch" });
  });
});

describe("messages for the person carry readable text generated from the signed message", () => {
  const open: Server[] = [];
  afterEach(() => {
    while (open.length) open.pop()!.close();
  });

  it("an A2A caller's message for the person goes marked, and the person's reply completes the task with checkable text", async () => {
    const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, apiKeys: { k1: "partner" } });
    const mesh = fakeConnect(bridge, { discover: async () => ({ agents: [manifest()], total: 1 }), getManifest: async () => manifest() });
    const server = await startInboundServer(bridge);
    open.push(server);
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: { message: { role: "ROLE_USER", parts: [{ text: "Can we meet Tuesday?" }], extensions: ["mesh://extensions/audience/v1"], metadata: { "agentmesh.audience": "person" } } },
    });
    const res = await fetch(`http://127.0.0.1:${port}/agents/${AGENT}/rpc`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer k1" }, body });
    const out = (await res.json()) as Record<string, any>;
    expect(out.result.task.status.state).toBe("submitted");
    expect(mesh.personSends).toEqual([expect.objectContaining({ to: AGENT, text: "Can we meet Tuesday?" })]);
    expect(mesh.requests).toHaveLength(0);

    // The person answers; the agent's SDK signs the digest of the readable text.
    const hosted = mesh.mintedAgentIds[0];
    const replyText = "Tuesday at 10 works.";
    const { readableTextMeta } = await import("../../sdk-typescript/src/readable-text.js");
    const reply = signEnvelope(
      createEnvelope({ type: "respond", from: AGENT, to: hosted, in_reply_to: out.result.task.id, payload: { status: "completed", text: replyText }, meta: { audience: "person", readable_text: await readableTextMeta(personReadableText({ sender: AGENT, text: replyText })) } }),
      agent,
    );
    mesh.personHandlers.get(hosted)!({ from: AGENT, inReplyTo: out.result.task.id, envelope: reply });
    const got = (await (await fetch(`http://127.0.0.1:${port}/agents/${AGENT}/rpc`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer k1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: out.result.task.id } }) })).json()) as Record<string, any>;
    const status = got.result.task.status;
    expect(status.state).toBe("completed");
    const part = status.message.parts[0];
    expect(part.metadata[OVER_A2A_URI].readable_text).toBe(true);
    const env = status.message.metadata[OVER_A2A_URI].envelope as Envelope;
    expect(await checkReadableText(env, part.text)).toEqual({ ok: true });
    // Text that differs from the signed message fails the check.
    expect((await checkReadableText(env, part.text.replace("10", "11"))).ok).toBe(false);
  });

  it("a mark that is not a string is refused", async () => {
    const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, apiKeys: { k1: "partner" } });
    fakeConnect(bridge, { discover: async () => ({ agents: [manifest()], total: 1 }), getManifest: async () => manifest() });
    const server = await startInboundServer(bridge);
    open.push(server);
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ text: "x" }], extensions: ["mesh://extensions/audience/v1"], metadata: { "agentmesh.audience": 1 } } } });
    const out = (await (await fetch(`http://127.0.0.1:${port}/agents/${AGENT}/rpc`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer k1" }, body })).json()) as Record<string, any>;
    expect(out.error.code).toBe(-32602);
  });
});
