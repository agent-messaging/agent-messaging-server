/**
 * The transport choice and the AMQP transport's own pieces
 * (docs/agent-messaging-server-plan.md, step 10): which binding an address
 * speaks, what a credential answer's `mesh` object says to dial, how `>`
 * becomes an AMQP binding key, and the login an AMQP connection presents.
 */
import { describe, expect, it } from "vitest";
import { jwtAuthenticator, nkeyAuthenticator, nkeys } from "nats.ws";
import { bindingOfUrl, transportFromMesh } from "../../src/transport.js";
import { amqpLogin, bindingKey, cameOnSubject, subjectMatches } from "../../src/internal/amqp-connection.js";

const te = new TextEncoder();

describe("which transport", () => {
  it("reads the binding from the address's scheme", () => {
    expect(bindingOfUrl("amqp://rabbit:5672/mesh")).toBe("amqp");
    expect(bindingOfUrl("AMQPS://rabbit/mesh")).toBe("amqp");
    expect(bindingOfUrl("wss://mesh.agentmesh.ai")).toBe("nats");
    expect(bindingOfUrl("nats://127.0.0.1:4222")).toBe("nats");
    expect(bindingOfUrl("mqtt://x")).toBeNull();
    expect(bindingOfUrl("not a url")).toBeNull();
  });

  it("dials what the mesh object says: endpoints first, else the NATS addresses", () => {
    expect(transportFromMesh({ nats_endpoints: [], endpoints: ["amqp://rabbit:5672/mesh"] })).toEqual({ binding: "amqp", servers: ["amqp://rabbit:5672/mesh"] });
    expect(transportFromMesh({ nats_endpoints: ["nats://m:4222", "wss://m"] })).toEqual({ binding: "nats", servers: ["wss://m", "nats://m:4222"] });
    expect(transportFromMesh({ nats_endpoints: ["nats://m:4222", "wss://m"] }, "tcp")?.servers[0]).toBe("nats://m:4222");
    // An endpoint of a binding this SDK does not speak is passed over.
    expect(transportFromMesh({ endpoints: ["mqtt://m"], nats_endpoints: ["wss://m"] })).toEqual({ binding: "nats", servers: ["wss://m"] });
    expect(transportFromMesh({ nats_endpoints: [] })).toBeNull();
    expect(transportFromMesh(undefined)).toBeNull();
  });

  // SPEC §18.10, Agent Messaging 0.7: `endpoints` on every binding, and
  // `nats_endpoints` beside it on a NATS mesh for clients older than 0.7.
  it("prefers endpoints on a 0.7 NATS mesh, whatever nats_endpoints says", () => {
    const mesh = { name: "m", protocol: "0.3", endpoints: ["nats://new:4222", "wss://new"], nats_endpoints: ["nats://old:4222", "wss://old"] };
    expect(transportFromMesh(mesh)).toEqual({ binding: "nats", servers: ["wss://new", "nats://new:4222"] });
    expect(transportFromMesh(mesh, "tcp")).toEqual({ binding: "nats", servers: ["nats://new:4222", "wss://new"] });
  });

  it("falls back to nats_endpoints on a mesh older than 0.7, which sends no endpoints", () => {
    expect(transportFromMesh({ name: "m", protocol: "0.3", nats_endpoints: ["nats://old:4222", "ws://old:4443"] })).toEqual({ binding: "nats", servers: ["ws://old:4443", "nats://old:4222"] });
    expect(transportFromMesh({ name: "m", endpoints: [], nats_endpoints: ["wss://old"] })).toEqual({ binding: "nats", servers: ["wss://old"] });
  });

  it("dials AMQP on a RabbitMQ mesh, in the order the mesh gives, and keeps to the first address's binding", () => {
    const mesh = { name: "m", protocol: "0.3", endpoints: ["amqps://a:5671/mesh", "amqp://b:5672/mesh", "wss://elsewhere"], nats_endpoints: [] };
    expect(transportFromMesh(mesh)).toEqual({ binding: "amqp", servers: ["amqps://a:5671/mesh", "amqp://b:5672/mesh"] });
    expect(transportFromMesh({ name: "m", endpoints: ["amqp://rabbit:5672/mesh"] })).toEqual({ binding: "amqp", servers: ["amqp://rabbit:5672/mesh"] });
  });
});

describe("the AMQP transport", () => {
  it("writes `>` as one word and then any number", () => {
    expect(bindingKey("mesh.event.>")).toBe("mesh.event.*.#");
    expect(bindingKey("mesh.agent.U.inbox")).toBe("mesh.agent.U.inbox");
    expect(subjectMatches("mesh.event.>", "mesh.event")).toBe(false);
    expect(subjectMatches("mesh.event.>", "mesh.event.a.b")).toBe(true);
  });

  it("logs in with the credential and a fresh proof signed by its key", () => {
    const kp = nkeys.createUser();
    const claims = { sub: kp.getPublicKey(), jti: "abc+/=", iat: 1 };
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = `${b64({ typ: "JWT", alg: "ed25519-nkey" })}.${b64(claims)}.sig`;
    const at = 1_760_000_000_000;
    const { user, password } = amqpLogin(jwtAuthenticator(jwt, kp.getSeed()) as never, at);
    expect(user).toBe(`${kp.getPublicKey()}:abc+/=`);
    const [j, ms, sig] = password.split("~");
    expect(j).toBe(jwt);
    expect(Number(ms)).toBe(at);
    const ok = nkeys.fromPublic(kp.getPublicKey()).verify(te.encode(`amqp-connect|${user}|${at}`), Buffer.from(sig!, "base64url"));
    expect(ok).toBe(true);
  });

  it("presents a key alone when there is no credential, for the broker to refuse", () => {
    const kp = nkeys.createUser();
    expect(amqpLogin(nkeyAuthenticator(kp.getSeed()) as never)).toEqual({ user: kp.getPublicKey(), password: "no-credential" });
  });
});

describe("a delivery that came on a subject (AMQP)", () => {
  it("is one routed by the mesh exchange; one put into a queue by its name is not", () => {
    expect(cameOnSubject({ fields: { exchange: "mesh" } })).toBe(true);
    expect(cameOnSubject({ fields: { exchange: "" } })).toBe(false);
    expect(cameOnSubject({ fields: { exchange: "amq.direct" } })).toBe(false);
    expect(cameOnSubject(undefined)).toBe(false);
  });
});
