/**
 * The A2A card at the mesh home (registry/agent-card-http.ts; A2A binding
 * §3): found by agent id or by handle, its interface URL naming the handle
 * when the agent has one, a card for an unlisted agent (it answers when
 * addressed directly, SPEC §8.6), and nothing for agents that are private,
 * sandboxed or do not serve the binding.
 */
import { describe, it, expect } from "vitest";
import { agentCards } from "../../src/registry/agent-card-http.js";
import { memoryKv } from "../helpers/memory-kv.js";
import { nkeys } from "../../src/sdk.js";
import type { NameLookup, NameAnswer } from "../../src/shared/require-names.js";

const BINDING = "https://agentmessaging.ai/bindings/a2a/v1";
const HOME = "https://api.mesh.example.com";

function manifest(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: "Quotes",
    description: "Prices parts.",
    version: "1.2.0",
    protocol_version: "0.3.0",
    capabilities: [BINDING],
    offerings: [{ id: "quote", name: "Quote", description: "Prices a part.", tags: ["parts"] }],
    ...extra,
  };
}

async function setup(names: Record<string, string> = {}) {
  const kv = memoryKv();
  const named = nkeys.createUser().getPublicKey();
  const plain = nkeys.createUser().getPublicKey();
  const privateOne = nkeys.createUser().getPublicKey();
  const notBinding = nkeys.createUser().getPublicKey();
  const unlisted = nkeys.createUser().getPublicKey();
  await kv.put(named, JSON.stringify(manifest(named)));
  await kv.put(plain, JSON.stringify(manifest(plain)));
  await kv.put(privateOne, JSON.stringify(manifest(privateOne, { visibility: "private" })));
  await kv.put(notBinding, JSON.stringify(manifest(notBinding, { capabilities: [] })));
  await kv.put(unlisted, JSON.stringify(manifest(unlisted, { visibility: "unlisted" })));
  const handles: Record<string, string> = { [named]: "quotes.acme@example.com", ...names };
  const lookup = Object.assign(
    async (k: string): Promise<NameAnswer> => (handles[k] ? { status: "named", handle: handles[k] } : { status: "unnamed", handle: null }),
    { forget: () => undefined },
  ) as NameLookup;
  const cards = agentCards({} as never, {
    meshHome: HOME,
    registry: kv,
    names: lookup,
    resolveHandle: async (h) => Object.entries(handles).find(([, v]) => v === h)?.[0] ?? null,
  });
  return { cards, named, plain, privateOne, notBinding, unlisted };
}

const body = (a: { body: unknown }) => a.body as { supportedInterfaces: Array<{ url: string; protocolBinding: string; protocolVersion: string }>; skills: unknown[]; capabilities: { pushNotifications: boolean } };

describe("GET /agents/{handle or id}/agent-card.json", () => {
  it("serves the card by agent id, its interface naming the handle when the agent has one", async () => {
    const { cards, named, plain } = await setup();
    const a = await cards.card(named);
    expect(a.status).toBe(200);
    expect(body(a).supportedInterfaces).toEqual([{ url: `${HOME}/agents/quotes.acme@example.com`, protocolBinding: BINDING, protocolVersion: "1.0" }]);
    expect(body(a).capabilities.pushNotifications).toBe(false);
    expect(body(a).skills).toHaveLength(1);
    const b = await cards.card(plain);
    expect(body(b).supportedInterfaces[0].url).toBe(`${HOME}/agents/${plain}`);
  });

  it("serves the card of an unlisted agent, which answers when addressed directly", async () => {
    const { cards, unlisted } = await setup();
    const a = await cards.card(unlisted);
    expect(a.status).toBe(200);
    expect(body(a).supportedInterfaces[0].url).toBe(`${HOME}/agents/${unlisted}`);
  });

  it("serves the card by handle", async () => {
    const { cards } = await setup();
    const a = await cards.card(encodeURIComponent("quotes.acme@example.com"));
    expect(a.status).toBe(200);
    expect(body(a).supportedInterfaces[0].url).toBe(`${HOME}/agents/quotes.acme@example.com`);
  });

  it("finds nothing for a private agent, an agent not on the binding, an unknown handle, or a handle the reverse answer does not confirm", async () => {
    const { cards, privateOne, notBinding, plain } = await setup();
    expect((await cards.card(privateOne)).status).toBe(404);
    expect((await cards.card(notBinding)).status).toBe(404);
    expect((await cards.card("nobody@example.com")).status).toBe(404);
    const liar = agentCards({} as never, {
      meshHome: HOME,
      registry: memoryKv(),
      names: Object.assign(async (): Promise<NameAnswer> => ({ status: "unnamed", handle: null }), { forget: () => undefined }) as NameLookup,
      resolveHandle: async () => plain,
    });
    expect((await liar.card("claims@example.com")).status).toBe(404);
  });
});
