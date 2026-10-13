/**
 * Integration tests — SDK client ↔ platform services over REAL NATS (0.2).
 *
 * Boots the RegistryService + TaskManagerService against a live JetStream NATS
 * server and drives them with the high-level SDK client, exercising the full
 * wire path for the core loop:
 *
 *   register → discover (presence join + node vouch) → request → bare respond
 *
 * Requires a JetStream-enabled NATS server with a WebSocket listener: the
 * services connect over TCP ($NATS_URL) and the SDK client connects over
 * WebSocket ($NATS_WS_URL, since the SDK uses nats.ws). Locally, run
 * `nats-server` with `jetstream {}` + `websocket { port: 8080, no_tls: true }`.
 * If no server is reachable, every test skips gracefully rather than failing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, type NatsConnection, type JetStreamClient } from "nats";
import { RegistryService } from "../../src/registry/registry-service.js";
import { TaskManagerService } from "../../src/task-manager/task-manager-service.js";
import { uuid7 } from "../../src/sdk.js";
import { AgentMesh } from "../../../sdk-typescript/src/mesh.js";

const SERVERS = process.env.NATS_URL ?? "localhost:4222";
// The SDK client speaks WebSocket (nats.ws); the services speak TCP.
const WS = process.env.NATS_WS_URL ?? "ws://localhost:8080";

// Unique per-run offering so discover() only ever sees THIS run's responder, even
// though the registry KV persists across runs.
const RUN = uuid7().replace(/-/g, "").slice(0, 12);
const OFFERING = `echo-${RUN}`;

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
let registry: RegistryService | null = null;
let taskManager: TaskManagerService | null = null;
let available = false;

beforeAll(async () => {
  // Opt-in only. This test boots its OWN registry + task-manager, so it must run
  // against a DEDICATED local NATS — never a shared/production server (two
  // registries would duel). CI leaves MESH_IT unset, so it skips there.
  if (process.env.MESH_IT !== "1") {
    console.warn("[mesh-integration] set MESH_IT=1 (with a dedicated local NATS) to run");
    available = false;
    return;
  }
  try {
    // Fail fast if there's no server — don't let the client retry forever.
    nc = await connect({ servers: SERVERS, timeout: 2000, maxReconnectAttempts: 0 });
    js = nc.jetstream();
    registry = await RegistryService.create(nc, js);
    await registry.start();
    taskManager = await TaskManagerService.create(nc, js);
    await taskManager.start();
    // Probe the WebSocket endpoint the SDK client needs (separate transport).
    const probe = await AgentMesh.connect(WS, { requireNamed: false });
    await probe.close();
    available = true;
  } catch (err) {
    console.warn(`[mesh-integration] no JetStream+WS NATS (${SERVERS} / ${WS}) — skipping (${(err as Error).message})`);
    available = false;
  }
}, 15_000);

afterAll(async () => {
  await registry?.stop().catch(() => {});
  await taskManager?.stop().catch(() => {});
  await nc?.drain().catch(() => {});
});

/** Give the registry a moment to persist + seed presence after register(). */
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("SDK ↔ services over live NATS", () => {
  it("register → discover (with node vouch + online presence) → bare request/respond", async (ctx) => {
    if (!available) return ctx.skip();

    // Responder: a real agent that answers `OFFERING` bare.
    const responder = await AgentMesh.connect(WS, { requireNamed: false });
    // Handlers receive the inner input directly (same as the Rust SDK).
    responder.onRequest(OFFERING, async (input) => ({ echoed: input }));
    await responder.register({
      name: `echo-responder-${RUN}`,
      description: "integration echo responder",
      capabilities: ["demo"],
      offerings: [{ id: OFFERING, name: "Echo", description: "echoes its input" }],
    });
    await settle();

    // Requester: discovers by the unique offering, then calls it.
    const requester = await AgentMesh.connect(WS, { requireNamed: false });
    try {
      const found = await requester.discover({ offering_id: OFFERING });
      expect(found.agents.length).toBe(1);
      const m = found.agents[0];
      expect(m.id).toBe(responder.id);

      // Node vouch present + self-hosting node = agent key (default).
      expect(m.node?.attestation?.agent).toBe(responder.id);
      expect(m.node?.id).toBe(responder.id);
      // Availability joined from presence — the responder just heartbeated.
      expect(m.availability ?? "online").toBe("online");

      // Bare request/respond: no Task for synchronous work.
      const res = await requester.request(responder.id, OFFERING, { hello: "world" });
      expect(res.task_id).toBeNull();
      expect(res.payload.status).toBe("completed");
      expect(res.payload.output).toEqual({ echoed: { hello: "world" } });
    } finally {
      await requester.close();
      await responder.close();
    }
  }, 20_000);

  it("discover with no match returns empty", async (ctx) => {
    if (!available) return ctx.skip();
    const agent = await AgentMesh.connect(WS, { requireNamed: false });
    try {
      const found = await agent.discover({ offering_id: `nonexistent-${RUN}` });
      expect(found.agents.length).toBe(0);
    } finally {
      await agent.close();
    }
  }, 15_000);

  it("request to an unknown offering yields OFFERING_NOT_FOUND", async (ctx) => {
    if (!available) return ctx.skip();

    const responder = await AgentMesh.connect(WS, { requireNamed: false });
    responder.onRequest(OFFERING, async () => ({ ok: true }));
    await responder.register({
      name: `partial-responder-${RUN}`,
      description: "only knows one offering",
      offerings: [{ id: OFFERING, name: "Echo", description: "echoes" }],
    });
    await settle();

    const requester = await AgentMesh.connect(WS, { requireNamed: false });
    try {
      await expect(
        requester.request(responder.id, `missing-${RUN}`, {}),
      ).rejects.toMatchObject({ code: "OFFERING_NOT_FOUND" });
    } finally {
      await requester.close();
      await responder.close();
    }
  }, 15_000);
});
