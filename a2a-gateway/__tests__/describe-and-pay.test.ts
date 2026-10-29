/**
 * Describe and pay over A2A (EXT-14 §10, §11, MAPPING.md §8.1).
 *
 * The card for an agent that published a Descriptor is generated from the
 * Descriptor itself; the extension's params carry each offering's inputs and
 * outputs and a link to the Descriptor with its digest, and the gateway
 * serves those exact bytes. A caller's budget rides the request and the agent
 * applies it; a malformed one is refused before anything is sent.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createUser } from "nkeys.js";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { OVER_A2A_URI } from "../src/core/over-a2a.js";
import { descriptorDigest } from "../src/core/descriptor-card.js";
import { fakeConnect, manifestFixture, type FakeMesh } from "./helpers.js";
import { createEnvelope } from "../../sdk-typescript/src/internal/envelope-builder.js";
import { signEnvelope, keyPairFromSeed } from "../../sdk-typescript/src/internal/identity.js";
import { Subjects } from "../../sdk-typescript/src/internal/subjects.js";
import { MeshError, ErrorCode } from "../../sdk-typescript/src/types/errors.js";
import type { Envelope } from "../../sdk-typescript/src/types/envelope.js";

const kp = () => keyPairFromSeed(new TextDecoder().decode(createUser().getSeed()));
const agent = kp();
const caller = kp();
const AGENT = agent.getPublicKey();
const manifest = () =>
  manifestFixture({
    id: AGENT,
    name: "Quotes",
    description: "the manifest's copy",
    version: "1.0.0",
    offerings: [
      { id: "quote", name: "quote", description: "manifest words", input_schema: { type: "object", required: ["item"] } } as never,
      { id: "internal", name: "internal", description: "not described" },
    ],
  });
const DESCRIPTOR = {
  format: "agent-descriptor-v1",
  agent_version: "2.3.0",
  subject: { id: AGENT },
  does: "Quotes furniture for events, delivered.",
  offerings: [
    { id: "quote", name: "Quote", does: "A delivered price for folding furniture.", inputs: [{ name: "item", kind: "text", required: true }, { name: "floor plan", kind: "application/pdf", required: false }], outputs: [{ name: "quote", kind: "application/pdf", when: "per_task" }] },
    { id: "ghost", name: "Ghost", does: "Described but not declared." },
  ],
  interaction: "service",
};
const BYTES = new TextEncoder().encode(JSON.stringify(DESCRIPTOR));

describe("describe and pay", () => {
  const open: Server[] = [];
  afterEach(() => {
    while (open.length) {
      const s = open.pop()!;
      s.closeAllConnections?.();
      s.close();
    }
  });

  async function boot(withDescriptor = true): Promise<{ mesh: FakeMesh; port: number }> {
    const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "https://gw.example.com", port: 0, apiKeys: { k1: "partner" } });
    const mesh = fakeConnect(bridge, {
      discover: async () => ({ agents: [manifest()], total: 1 }),
      getManifest: async () => manifest(),
      serviceRequest: async (subject: string) => {
        if (subject === `mesh.registry.descriptor.get.${AGENT}` && withDescriptor) return { descriptor: Buffer.from(BYTES).toString("base64") };
        return {};
      },
    } as never);
    const server = await startInboundServer(bridge);
    open.push(server);
    return { mesh, port: (server.address() as AddressInfo).port };
  }

  const get = async (port: number, path: string) => fetch(`http://127.0.0.1:${port}/agents/${AGENT}/${path}`, { headers: { Authorization: "Bearer k1" } });
  async function send(port: number, params: unknown): Promise<Record<string, any>> {
    const res = await fetch(`http://127.0.0.1:${port}/agents/${AGENT}/rpc`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer k1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params }) });
    return (await res.json()) as Record<string, any>;
  }

  it("the card says what the Descriptor says, and lists only skills the agent describes and declares", async () => {
    const { port } = await boot();
    const card = (await (await get(port, ".well-known/agent-card.json")).json()) as Record<string, any>;
    expect(card.description).toBe("Quotes furniture for events, delivered.");
    expect(card.version).toBe("2.3.0");
    expect(card.skills.map((s: { id: string }) => s.id)).toEqual(["quote"]);
    expect(card.skills[0]).toMatchObject({ name: "Quote", description: "A delivered price for folding furniture." });
    expect(card.skills[0].inputModes).toContain("application/pdf");
    expect(card.skills[0].outputModes).toContain("application/pdf");
  });

  it("the extension carries inputs, outputs and schemas, and the Descriptor's link and digest", async () => {
    const { port } = await boot();
    const card = (await (await get(port, ".well-known/agent-card.json")).json()) as Record<string, any>;
    const ext = card.capabilities.extensions.find((e: { uri: string }) => e.uri === OVER_A2A_URI);
    expect(ext.params.descriptor).toEqual({ url: `https://gw.example.com/agents/${AGENT}/descriptor.json`, digest: descriptorDigest(BYTES) });
    expect(ext.params.offerings.quote.inputs).toEqual(DESCRIPTOR.offerings[0].inputs);
    expect(ext.params.offerings.quote.outputs).toEqual(DESCRIPTOR.offerings[0].outputs);
    expect(ext.params.offerings.quote.input_schema).toEqual({ type: "object", required: ["item"] });
    expect(ext.params.budget).toBe(true);
  });

  it("the gateway serves the Descriptor byte for byte, and its digest matches the card's", async () => {
    const { port } = await boot();
    const res = await get(port, "descriptor.json");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(body).equals(Buffer.from(BYTES))).toBe(true);
    expect(`sha256:${createHash("sha256").update(body).digest("hex")}`).toBe(descriptorDigest(BYTES));
  });

  it("without a Descriptor the card is the manifest's, and there is nothing to serve", async () => {
    const { port } = await boot(false);
    const card = (await (await get(port, ".well-known/agent-card.json")).json()) as Record<string, any>;
    expect(card.description).toBe("the manifest's copy");
    expect((await get(port, "descriptor.json")).status).toBe(404);
  });

  it("a caller's budget rides the request; a malformed one is refused before anything is sent", async () => {
    const { mesh, port } = await boot();
    const budget = { revision: 0, deadline: new Date(Date.now() + 3600_000).toISOString(), cost_ceiling: { amount_micro: 5_000_000, currency: "USD" } };
    const ok = await send(port, { message: { role: "ROLE_USER", parts: [{ data: { item: "chair" } }], extensions: [OVER_A2A_URI], metadata: { "agentmesh.offering": "quote", [OVER_A2A_URI]: { budget } } } });
    expect(ok.result).toBeDefined();
    expect(mesh.requests[0].config).toMatchObject({ budget });
    const bad = await send(port, { message: { role: "ROLE_USER", parts: [{ data: {} }], extensions: [OVER_A2A_URI], metadata: { "agentmesh.offering": "quote", [OVER_A2A_URI]: { budget: { revision: 0, cost_ceiling: { amount_micro: -1, currency: "USD" } } } } } });
    expect(bad.error.data.agentmesh_code).toBe("INVALID_BUDGET");
    const revised = await send(port, { message: { role: "ROLE_USER", parts: [{ data: {} }], extensions: [OVER_A2A_URI], metadata: { "agentmesh.offering": "quote", [OVER_A2A_URI]: { budget: { revision: 2 } } } } });
    expect(revised.error.data.agentmesh_code).toBe("INVALID_BUDGET");
    expect(mesh.requests).toHaveLength(1);
  });

  it("the agent's budget refusal reaches the caller with its estimate", async () => {
    const { mesh, port } = await boot();
    mesh.answer = () => {
      throw new MeshError(ErrorCode.BUDGET_INSUFFICIENT, "This will cost more than the ceiling", { details: { estimate: { amount_micro: 9_000_000, currency: "USD" } } });
    };
    const out = await send(port, { message: { role: "ROLE_USER", parts: [{ data: { item: "chair" } }], extensions: [OVER_A2A_URI], metadata: { "agentmesh.offering": "quote", [OVER_A2A_URI]: { budget: { revision: 0, cost_ceiling: { amount_micro: 1_000_000, currency: "USD" } } } } } });
    expect(out.error.data).toMatchObject({ agentmesh_code: "BUDGET_INSUFFICIENT", details: { estimate: { amount_micro: 9_000_000 } } });
  });

  it("a signed caller's budget travels in its own envelope, unchanged", async () => {
    const { mesh, port } = await boot();
    const req = signEnvelope(createEnvelope({ type: "request", from: caller.getPublicKey(), to: AGENT, budget: { revision: 0, cost_ceiling: { amount_micro: 5_000_000, currency: "USD" } }, payload: { offering: "quote", input: { item: "chair" } } }), caller);
    const iv = setInterval(() => {
      if (!mesh.relayed[0]) return;
      clearInterval(iv);
      mesh.deliver(Subjects.agentInbox(caller.getPublicKey()), signEnvelope(createEnvelope({ type: "respond", from: AGENT, to: caller.getPublicKey(), in_reply_to: req.id, payload: { status: "completed", output: { text: "ok" } } }), agent));
    }, 5);
    await send(port, { message: { role: "ROLE_USER", parts: [], extensions: [OVER_A2A_URI], metadata: { [OVER_A2A_URI]: { envelope: req } } } });
    expect((mesh.relayed[0] as unknown as Envelope).budget).toEqual(req.budget);
  });
});
