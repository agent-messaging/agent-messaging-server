/**
 * A revision in A2A's own vocabulary (Common Agent spec §5.7): the message's
 * contextId is the mesh context, its first referenceTaskId is the prior task,
 * and the job's manifest reference and the steps to redo ride the metadata.
 * The mesh side must see the same request a mesh caller would send.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { fakeConnect, manifestFixture } from "./helpers.js";

describe("a revision through the gateway", () => {
  const open: Server[] = [];
  afterEach(() => {
    while (open.length) {
      const s = open.pop()!;
      try {
        s.closeAllConnections?.();
      } catch {
        /* older node */
      }
      s.close();
    }
  });

  it("maps contextId, referenceTaskIds and the job metadata onto the mesh request", async () => {
    const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, apiKeys: { k1: "partner" } });
    const mesh = fakeConnect(bridge, {
      discover: async () => ({ agents: [manifestFixture()], total: 1 }),
      getManifest: async (id: string) => {
        if (id !== "UAGENTPUBKEY") throw new Error("no such agent");
        return manifestFixture();
      },
    });
    const server = await startInboundServer(bridge);
    open.push(server);
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/agents/UAGENTPUBKEY/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer k1" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: {
            role: "ROLE_USER",
            parts: [{ text: "Make step three's narration shorter." }],
            contextId: "ctx-kathy-1",
            referenceTaskIds: ["task-prior-9"],
            metadata: { "agentmesh.job": "mesh:artifacts:MANIFEST1", "agentmesh.steps": ["record-the-narration", 7] },
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(mesh.requests).toHaveLength(1);
    const sent = mesh.requests[0];
    expect(sent.input).toEqual({
      text: "Make step three's narration shorter.",
      revises: "task-prior-9",
      job: { manifest: "mesh:artifacts:MANIFEST1" },
      steps: ["record-the-narration"],
    });
    expect(sent.config?.context_id).toBe("ctx-kathy-1");
  });

  it("sends an ordinary message untouched when the A2A message names no prior task", async () => {
    const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, apiKeys: { k1: "partner" } });
    const mesh = fakeConnect(bridge, {
      discover: async () => ({ agents: [manifestFixture()], total: 1 }),
      getManifest: async () => manifestFixture(),
    });
    const server = await startInboundServer(bridge);
    open.push(server);
    const port = (server.address() as AddressInfo).port;
    await fetch(`http://127.0.0.1:${port}/agents/UAGENTPUBKEY/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer k1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ text: "hello" }] } } }),
    });
    expect(mesh.requests[0].input).toEqual({ text: "hello" });
    expect(mesh.requests[0].config?.context_id).toBeUndefined();
  });
});
