/**
 * The A2A gateway against a real mesh, on either binding (plan step 9,
 * "Fixes before release"). Skips unless these name a running Agent Messaging
 * Server:
 *
 *   GATEWAY_TEST_MESH_URL          ws://… or wss:// (NATS), amqp://… (RabbitMQ)
 *   GATEWAY_TEST_CREDS_FILE        the gateway's node credential (first-run's
 *                                  creds/a2a-gateway.creds)
 *   GATEWAY_TEST_AGENT_CREDS_FILE  a node credential for the agent the test
 *                                  puts on the mesh (fenced, or covering any key)
 *
 * It connects the gateway the way main.ts does, puts an echo agent open to the
 * gateway on the mesh, and sends it an A2A message through the gateway's
 * JSON-RPC door: the gateway hosts the caller's identity, makes the mesh
 * request and hands back the agent's answer.
 */
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { MeshNode } from "../../sdk-typescript/src/node.js";
import { Bridge } from "../src/bridge.js";
import { boot, type BootResult } from "../src/boot.js";
import { loadCreds } from "../src/creds.js";
import { meshAddress } from "../src/mesh-address.js";

const URL_ = process.env.GATEWAY_TEST_MESH_URL?.trim();
const GW_CREDS = process.env.GATEWAY_TEST_CREDS_FILE?.trim();
const AGENT_CREDS = process.env.GATEWAY_TEST_AGENT_CREDS_FILE?.trim();
const live = URL_ && GW_CREDS && AGENT_CREDS ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

live("the A2A gateway on a live mesh", () => {
  let booted: BootResult | null = null;
  let node: MeshNode | null = null;

  afterAll(async () => {
    await booted?.shutdown().catch(() => undefined);
    await node?.drain().catch(() => undefined);
  });

  it("connects through the address's transport and carries an A2A message to a mesh agent and back", async () => {
    const binding = meshAddress(URL_).binding;

    // The agent the gateway opens to the outside.
    const agentCreds = loadCreds(AGENT_CREDS!);
    node = await MeshNode.connect(meshAddress(URL_).servers, { jwt: agentCreds.jwt, nodeSeed: agentCreds.seed });
    node.startHeartbeat();
    const echo = node.addAgent();
    echo.onRequest("echo", (input) => input);
    await echo.register({
      name: "gateway-live-echo",
      description: "Echoes what it is sent (the gateway's live test).",
      // A registration that says nothing is private (the registry's rule), and
      // the gateway shows no private agent.
      visibility: "public",
      offerings: [{ id: "echo", name: "echo", description: "Echoes the input." }],
      public: { access: { schemes: [{ id: "a2a-gateway", transport: "http", type: "apiKey", in: "header", name: "Authorization" }] } } as never,
    });

    // The gateway, as main.ts starts it.
    const bridge = new Bridge({
      meshUrl: URL_!,
      publicBaseUrl: "http://127.0.0.1",
      port: 0,
      creds: loadCreds(GW_CREDS!),
      allowAnonymous: true,
    });
    booted = await boot(bridge, []);
    const base = `http://127.0.0.1:${(booted.server.address() as AddressInfo).port}`;
    const health = (await (await fetch(`${base}/healthz`)).json()) as { ready?: boolean };
    expect(health.ready).toBe(true);

    // The agent card names it, read from the registry over the mesh.
    let card: Response | null = null;
    for (let i = 0; i < 30; i++) {
      card = await fetch(`${base}/agents/${echo.id}/.well-known/agent-card.json`);
      if (card.status === 200) break;
      await sleep(300);
    }
    expect(card?.status, `the card on ${binding}`).toBe(200);

    const res = await fetch(`${base}/agents/${echo.id}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ text: `ping over ${binding}` }], messageId: "m-1" } } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    expect(JSON.stringify(body.result)).toContain(`ping over ${binding}`);
  }, 60_000);
});
