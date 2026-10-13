import { afterEach, describe, expect, it, vi } from "vitest";

const NAMES = ["AGENTMESH_API_URL", "AGENTMESH_NAMING_URL"] as const;
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));

async function load() {
  vi.resetModules();
  return import("../../src/am-env.generated.js");
}

afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  vi.resetModules();
});

describe("the SDK's addresses", () => {
  it("are none when nothing names them: the SDK has no built-in network", async () => {
    for (const n of NAMES) delete process.env[n];
    const m = await load();
    expect(m.AM_URL_API).toBeUndefined();
    expect(m.AM_URL_NAMING).toBeUndefined();
    expect("AM_BROKER_WSS" in m).toBe(false);
  });

  it("come from the environment when it names them", async () => {
    process.env.AGENTMESH_API_URL = "https://api.mesh.example.com";
    process.env.AGENTMESH_NAMING_URL = " https://naming.mesh.example.com ";
    const m = await load();
    expect(m.AM_URL_API).toBe("https://api.mesh.example.com");
    expect(m.AM_URL_NAMING).toBe("https://naming.mesh.example.com");
  });

  it("treat an empty value as unset", async () => {
    process.env.AGENTMESH_API_URL = "";
    process.env.AGENTMESH_NAMING_URL = "   ";
    const m = await load();
    expect(m.AM_URL_API).toBeUndefined();
    expect(m.AM_URL_NAMING).toBeUndefined();
  });

  it("follow a broker at mesh.<domain> to api.<domain> and naming.<domain>", async () => {
    const { addressesFromBroker } = await load();
    expect(addressesFromBroker("wss://mesh.agentmesh.ai")).toEqual({ api: "https://api.agentmesh.ai", naming: "https://naming.agentmesh.ai" });
    expect(addressesFromBroker(["nats://mesh.dev.example.com:4222"])).toEqual({ api: "https://api.dev.example.com", naming: "https://naming.dev.example.com" });
    expect(addressesFromBroker("mesh.example.org:4222")).toEqual({ api: "https://api.example.org", naming: "https://naming.example.org" });
    expect(addressesFromBroker(["nats://localhost:4222", "amqp://mesh.acme.io"])).toEqual({ api: "https://api.acme.io", naming: "https://naming.acme.io" });
  });

  it("imply nothing for a broker of another shape", async () => {
    const { addressesFromBroker } = await load();
    expect(addressesFromBroker("nats://localhost:4222")).toEqual({});
    expect(addressesFromBroker("nats://10.30.0.4:4222")).toEqual({});
    expect(addressesFromBroker("wss://broker.example.com")).toEqual({});
    expect(addressesFromBroker(undefined)).toEqual({});
  });

  it("say how to give the server's address when a request needs one and none is known", async () => {
    const { requireApi } = await load();
    expect(() => requireApi(undefined)).toThrow(/pass platformApi/);
    expect(requireApi("http://localhost:3005/")).toBe("http://localhost:3005");
  });

  it("make the naming gate refuse to start with nowhere to ask", async () => {
    for (const n of NAMES) delete process.env[n];
    vi.resetModules();
    const { namingGateFor } = await import("../../src/naming-gate.js");
    const id = "U" + "A".repeat(55);
    expect(() => namingGateFor(id, true)).toThrow(/requireNamed needs the naming service's address/);
    expect(namingGateFor(id, true, "https://naming.example.com")).not.toBeNull();
    expect(namingGateFor(id, false, "https://naming.example.com")).toBeNull();
  });

  it("reach the registrar the naming gate is given", async () => {
    vi.resetModules();
    const { registrarNameLookup } = await import("../../src/naming-gate.js");
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ handles: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await registrarNameLookup("https://naming.mesh.example.com", fake)("AAAA").catch(() => undefined);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((u) => u.startsWith("https://naming.mesh.example.com/"))).toBe(true);
  });
});
