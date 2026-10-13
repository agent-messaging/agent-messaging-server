/**
 * Where the gateway dials the mesh (src/mesh-address.ts): the transport is
 * chosen by the address's scheme, as the SDK's transportFromMesh chooses it.
 */
import { describe, expect, it } from "vitest";
import { meshAddress } from "../src/mesh-address.js";

describe("the gateway's mesh address", () => {
  it("dials NATS for a WebSocket or NATS address, as it always has", () => {
    expect(meshAddress("ws://nats:4443")).toEqual({ binding: "nats", servers: ["ws://nats:4443"] });
    expect(meshAddress(undefined)).toEqual({ binding: "nats", servers: ["ws://localhost:4443"] });
    expect(meshAddress("")).toEqual({ binding: "nats", servers: ["ws://localhost:4443"] });
  });

  it("dials RabbitMQ for an AMQP address", () => {
    expect(meshAddress("amqp://rabbitmq:5672/mesh")).toEqual({ binding: "amqp", servers: ["amqp://rabbitmq:5672/mesh"] });
    expect(meshAddress("amqps://a:5671/mesh, amqps://b:5671/mesh")).toEqual({ binding: "amqp", servers: ["amqps://a:5671/mesh", "amqps://b:5671/mesh"] });
  });

  it("keeps the first binding's addresses only, and refuses an address it cannot dial", () => {
    expect(meshAddress("amqp://r:5672/mesh,ws://n:4443")).toEqual({ binding: "amqp", servers: ["amqp://r:5672/mesh"] });
    expect(() => meshAddress("http://example.com")).toThrow(/MESH_URL/);
  });
});
