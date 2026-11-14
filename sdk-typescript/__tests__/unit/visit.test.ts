/**
 * A visit, the client's half (src/visit.ts, Agent Messaging §21.14 to §21.16):
 * the pass request carries two fresh signatures by the visitor's own key, one
 * naming the mesh it asks, and a refusal comes back with the door's code.
 */
import { describe, it, expect } from "vitest";
import { nkeys } from "nats.ws";
import { homeMeshOf, keyStandingStatement, requestVisitPass, visitStatement, VisitRefused } from "../../src/visit.js";

const verify = (key: string, s: string, sig: string) =>
  nkeys.fromPublic(key).verify(new TextEncoder().encode(s), Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)));

describe("requestVisitPass", () => {
  it("asks the mesh's own door, with signatures that verify against the visitor's key", async () => {
    const kp = nkeys.createUser();
    const seed = new TextDecoder().decode(kp.getSeed());
    let url = "";
    let body: Record<string, any> = {};
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      url = u;
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, jwt: "j", agent_key: kp.getPublicKey(), handle: "a.b@c.d", home_mesh: "https://a", expires_at: "x", mesh: { endpoints: ["nats://b:4222"] } }), { status: 200 });
    }) as typeof fetch;
    const pass = await requestVisitPass({ mesh: "https://mesh-b.example/", nkeySeed: seed, handle: "a.b@c.d", fetch: fetchImpl });
    expect(url).toBe("https://mesh-b.example/v1/visit");
    expect(body.agent_key).toBe(kp.getPublicKey());
    expect(verify(kp.getPublicKey(), visitStatement(body.ts, body.agent_key, "https://mesh-b.example"), body.sig)).toBe(true);
    expect(verify(kp.getPublicKey(), keyStandingStatement(body.ts, body.agent_key), body.standing_sig)).toBe(true);
    // The visit signature names this mesh, so it does not verify for another.
    expect(verify(kp.getPublicKey(), visitStatement(body.ts, body.agent_key, "https://mesh-c.example"), body.sig)).toBe(false);
    expect(pass.mesh.endpoints).toEqual(["nats://b:4222"]);
  });

  it("throws the door's refusal with its code", async () => {
    const seed = new TextDecoder().decode(nkeys.createUser().getSeed());
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "Its home mesh holds no account for this key.", code: "visitor_not_in_standing" }), { status: 403 })) as unknown as typeof fetch;
    const err = await requestVisitPass({ mesh: "https://mesh-b.example", nkeySeed: seed, handle: "a.b@c.d", fetch: fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(VisitRefused);
    expect(err.code).toBe("visitor_not_in_standing");
    expect(err.status).toBe(403);
  });
});

describe("homeMeshOf (§21.14)", () => {
  it("reads the home mesh off the agent's own endpoint, as an origin", () => {
    const card = { endpoints: [{ protocol: "agentmesh", agent_id: "UA", mesh: "https://api.mesh-a.example/" }, { protocol: "a2a", url: "x" }] };
    expect(homeMeshOf(card, "UA")).toBe("https://api.mesh-a.example");
    expect(homeMeshOf(card, "UB")).toBeNull();
    expect(homeMeshOf({ endpoints: [{ protocol: "agentmesh", agent_id: "UA", mesh: null }] }, "UA")).toBeNull();
  });
});
