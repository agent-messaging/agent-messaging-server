/**
 * The `mesh` object of SPEC §18.10 (Agent Messaging 0.7), as every door of
 * the core sends it (keychain/mesh-object.ts).
 */
import { describe, expect, it } from "vitest";
import { meshInfo } from "../../src/keychain/mesh-object.js";

describe("the mesh object", () => {
  it("on NATS: endpoints and nats_endpoints, the same addresses in the same order", () => {
    const m = meshInfo({ MESH_NAME: "test.mesh", MESH_NATS_ENDPOINTS: " nats://m:4222 , wss://m ," });
    expect(m).toEqual({ name: "test.mesh", protocol: "0.3", endpoints: ["nats://m:4222", "wss://m"], nats_endpoints: ["nats://m:4222", "wss://m"] });
  });

  it("on RabbitMQ: the broker's addresses in endpoints, and nats_endpoints empty", () => {
    const m = meshInfo({ MESH_BROKER: "RabbitMQ", MESH_AMQP_ENDPOINTS: "amqps://a:5671/mesh,amqp://b:5672/mesh" });
    expect(m).toEqual({ name: "agentmesh.ai", protocol: "0.3", endpoints: ["amqps://a:5671/mesh", "amqp://b:5672/mesh"], nats_endpoints: [] });
  });
});
