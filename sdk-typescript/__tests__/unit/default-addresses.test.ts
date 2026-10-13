import { afterEach, describe, expect, it, vi } from "vitest";

const NAMES = ["AGENTMESH_API_URL", "AGENTMESH_NAMING_URL", "AGENTMESH_BROKER_WSS"] as const;
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

describe("the SDK's default addresses", () => {
  it("are AgentMesh's public network when nothing is set", async () => {
    for (const n of NAMES) delete process.env[n];
    const m = await load();
    expect(m.AM_URL_API).toBe("https://api.agentmesh.ai");
    expect(m.AM_URL_NAMING).toBe("https://naming.agentmesh.ai");
    expect(m.AM_BROKER_WSS).toBe("wss://mesh.agentmesh.ai");
  });

  it("come from the environment when it names them", async () => {
    process.env.AGENTMESH_API_URL = "https://api.mesh.example.com";
    process.env.AGENTMESH_NAMING_URL = " https://naming.mesh.example.com ";
    process.env.AGENTMESH_BROKER_WSS = "wss://broker.mesh.example.com";
    const m = await load();
    expect(m.AM_URL_API).toBe("https://api.mesh.example.com");
    expect(m.AM_URL_NAMING).toBe("https://naming.mesh.example.com");
    expect(m.AM_BROKER_WSS).toBe("wss://broker.mesh.example.com");
  });

  it("treat an empty value as unset", async () => {
    process.env.AGENTMESH_API_URL = "";
    process.env.AGENTMESH_NAMING_URL = "   ";
    delete process.env.AGENTMESH_BROKER_WSS;
    const m = await load();
    expect(m.AM_URL_API).toBe("https://api.agentmesh.ai");
    expect(m.AM_URL_NAMING).toBe("https://naming.agentmesh.ai");
  });

  it("reach the registrar the naming gate asks by default", async () => {
    process.env.AGENTMESH_NAMING_URL = "https://naming.mesh.example.com";
    vi.resetModules();
    const { registrarNameLookup } = await import("../../src/naming-gate.js");
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ handles: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await registrarNameLookup(undefined, fake)("AAAA").catch(() => undefined);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((u) => u.startsWith("https://naming.mesh.example.com/"))).toBe(true);
  });
});
