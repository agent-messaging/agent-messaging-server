// What a mesh offers (GET /v1/capabilities, step 5 of
// docs/agent-messaging-server-plan.md). A platform request against a mesh
// that does not offer it is refused before it is sent, with NOT_AVAILABLE and
// the same words every door uses; a mesh that says nothing, or offers it,
// gets the request as before; a core request is never refused for it.
import { describe, it, expect, vi } from "vitest";
import { platformCaller } from "../../src/service-caller.js";
import {
  CAPABILITIES_RETRY_MS, CAPABILITIES_TTL_MS, capabilitiesReader, gatedDoor, meshOffers, notAvailableRefusal, type MeshCapabilities,
} from "../../src/capabilities.js";
import { PlatformServices, REQUEST_TIERS, ServiceRefusal, SDK_REQUESTS, notAvailable } from "../../src/services.generated.js";

const API = "https://mesh.example.test";
const agent = { id: "UAGENT", sign: () => "sig" };

/** A core server's answer: the core services only. */
const CORE_ONLY: MeshCapabilities = {
  agent_messaging: "0.5.0",
  profile: "core",
  services: { messages: ["send", "inbox", "reply", "dismiss"], rooms: ["open", "join"], names: ["resolve", "claim", "confirm"] },
};

/** A mesh that answers the capabilities door with `caps` (or `status`), and
 *  the service door with an empty result, recording what was asked. */
function mesh(caps: unknown, status = 200) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(String(url).replace(API, ""));
    if (String(url).endsWith("/v1/capabilities")) return { ok: status === 200, status, json: async () => caps };
    return { ok: true, status: 200, json: async () => ({ result: { schedules: [] } }) };
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

describe("the capabilities check on the service door", () => {
  it("refuses a platform request a core server does not offer, before sending it", async () => {
    const { asked, fetchImpl } = mesh(CORE_ONLY);
    const svc = new PlatformServices(platformCaller({ api: API, agent, fetchImpl }));
    const err = await svc.schedules.list({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceRefusal);
    expect((err as ServiceRefusal).code).toBe("NOT_AVAILABLE");
    expect((err as ServiceRefusal).request).toBe("schedules.list");
    expect((err as ServiceRefusal).message).toBe(
      "schedules.list is not available on this mesh: https://mesh.example.test does not offer it. It needs the AgentMesh platform.",
    );
    expect(asked).toEqual(["/v1/capabilities"]);
  });

  it("sends a platform request the mesh offers, and reads the answer once", async () => {
    const { asked, fetchImpl } = mesh({ ...CORE_ONLY, profile: "full", services: { ...CORE_ONLY.services, schedules: ["list"] } });
    const svc = new PlatformServices(platformCaller({ api: API, agent, fetchImpl }));
    await expect(svc.schedules.list({})).resolves.toEqual({ schedules: [] });
    await expect(svc.schedules.list({})).resolves.toEqual({ schedules: [] });
    expect(asked).toEqual(["/v1/capabilities", "/v1/svc/schedules.list", "/v1/svc/schedules.list"]);
  });

  it("sends as before when the mesh says nothing: no services listed, no answer, or no door", async () => {
    for (const [caps, status] of [[{ clearing: true }, 200], [null, 200], [{ error: "Not found" }, 404]] as const) {
      const { asked, fetchImpl } = mesh(caps, status);
      const svc = new PlatformServices(platformCaller({ api: API, agent, fetchImpl }));
      await expect(svc.schedules.list({})).resolves.toEqual({ schedules: [] });
      expect(asked).toContain("/v1/svc/schedules.list");
    }
  });

  it("checks nothing when told not to", async () => {
    const { asked, fetchImpl } = mesh(CORE_ONLY);
    const svc = new PlatformServices(platformCaller({ api: API, agent, fetchImpl, capabilities: null }));
    await expect(svc.schedules.list({})).resolves.toEqual({ schedules: [] });
    expect(asked).toEqual(["/v1/svc/schedules.list"]);
  });
});

describe("what a mesh offers", () => {
  it("is read from services, request by request", () => {
    expect(meshOffers(CORE_ONLY, "messages.send")).toBe(true);
    expect(meshOffers(CORE_ONLY, "schedules.list")).toBe(false);
    expect(meshOffers({ clearing: true }, "schedules.list")).toBeUndefined();
    expect(meshOffers(null, "schedules.list")).toBeUndefined();
  });

  it("never refuses a core request, listed or not", () => {
    expect(notAvailableRefusal({ services: {} }, "messages.send", API)).toBeNull();
    expect(notAvailableRefusal({ services: {} }, "rooms.open", API)).toBeNull();
    expect(notAvailableRefusal({ services: {} }, "owner.ask", API)?.code).toBe("NOT_AVAILABLE");
  });

  it("every request the SDK carries has a tier", () => {
    for (const r of SDK_REQUESTS) {
      expect(["core", "platform"]).toContain(r.tier);
      expect(REQUEST_TIERS[r.id]).toBe(r.tier);
    }
    expect(REQUEST_TIERS["messages.send"]).toBe("core");
    expect(REQUEST_TIERS["schedules.list"]).toBe("platform");
  });

  it("says the same words as the other doors", () => {
    expect(notAvailable("owner.ask", API)).toBe(
      "owner.ask is not available on this mesh: https://mesh.example.test does not offer it. It needs the AgentMesh platform.",
    );
  });

  it("keeps an answer five minutes, and no answer thirty seconds", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) throw new Error("down");
      return { ok: true, status: 200, json: async () => CORE_ONLY };
    }) as unknown as typeof fetch;
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const read = capabilitiesReader(API, fetchImpl);
      expect(await read()).toBeNull();
      now += CAPABILITIES_RETRY_MS - 1;
      expect(await read()).toBeNull();
      now += 1;
      expect(await read()).toEqual(CORE_ONLY);
      now += CAPABILITIES_TTL_MS - 1;
      expect(await read()).toEqual(CORE_ONLY);
      expect(n).toBe(2);
      now += 1;
      await read();
      expect(n).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("a platform request done on the mesh", () => {
  it("checks the mesh before it runs, and only for its own requests", async () => {
    const ran: string[] = [];
    const door = { ask: async (x: string) => { ran.push(x); return { to: "owner" }; }, helper: () => "not a request" };
    const offered = new Set<string>();
    const gated = gatedDoor(door, "owner", async (request) => {
      if (!offered.has(request)) throw notAvailableRefusal({ services: {} }, request, API);
    });
    await expect(gated.ask("hi")).rejects.toMatchObject({ code: "NOT_AVAILABLE", request: "owner.ask" });
    expect(ran).toEqual([]);
    expect(gated.helper()).toBe("not a request");
    offered.add("owner.ask");
    await expect(gated.ask("hi")).resolves.toEqual({ to: "owner" });
    expect(ran).toEqual(["hi"]);
  });
});
