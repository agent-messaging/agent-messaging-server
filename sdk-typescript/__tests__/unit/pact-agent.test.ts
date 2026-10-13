// The helpers for an agent that serves a business under PACT Delegated
// (src/pact/agent.ts; BRIDGE-A2A.md 14.6, 14.8), and for anyone who is their
// own personal-agent platform. Exported as `pact` from the package.
import { describe, it, expect } from "vitest";
import { pact } from "../../src/index.js";

const IFACE = "https://a2a.agentmesh.ai/a2a/UBRAND";
const PA = "https://pa.example/pact";

async function setup() {
  const { privateJwk, publicJwk } = await pact.generateEs256();
  const now = Math.floor(Date.now() / 1000);
  const token = (over: Record<string, unknown> = {}, header: Record<string, unknown> = {}) =>
    pact.signJwt({ iss: `${IFACE}/oauth`, aud: IFACE, sub: "person-1", client_id: PA, scope: "orders:read", grant_id: "pactgrant_1", iat: now, exp: now + 3600, ...over }, privateJwk, { typ: "at+jwt", ...header });
  return { keys: { keys: [publicJwk] }, token };
}

describe("checkDelegation", () => {
  it("accepts a token from an AgentMesh gateway for this personal agent, and names the person and scopes", async () => {
    const { keys, token } = await setup();
    const fetched: string[] = [];
    const fetchImpl = (async (u: string) => (fetched.push(String(u)), new Response(JSON.stringify(keys), { status: 200 }))) as typeof fetch;
    expect(await pact.checkDelegation(await token(), { paIssuer: PA, fetchImpl })).toMatchObject({ person: "person-1", scopes: ["orders:read"], grantId: "pactgrant_1", interfaceUrl: IFACE });
    expect(fetched).toEqual([`${IFACE}/oauth/jwks.json`]);
  });

  it("refuses another gateway, another interface, another personal agent, an expired token, a plain JWT, and another key", async () => {
    const { keys, token } = await setup();
    const other = await pact.generateEs256();
    const now = Math.floor(Date.now() / 1000);
    for (const [why, t, opts] of [
      ["another gateway", await token({ aud: "https://evil.example/a2a/X", iss: "https://evil.example/a2a/X/oauth" }), {}],
      ["another interface", await token(), { interfaceUrl: "https://a2a.agentmesh.ai/a2a/UOTHER" }],
      ["another personal agent", await token({ client_id: "https://other.example" }), {}],
      ["expired", await token({ exp: now - 120 }), {}],
      ["not an access token", await token({}, { typ: "JWT" }), {}],
      ["another key", await pact.signJwt({ iss: `${IFACE}/oauth`, aud: IFACE, sub: "p", client_id: PA, scope: "x", iat: now, exp: now + 60 }, other.privateJwk, { typ: "at+jwt" }), {}],
    ] as const) {
      expect(await pact.checkDelegation(t, { paIssuer: PA, keys, ...opts }), why).toBeNull();
    }
  });

  it("reads the turn from meta and from a job's bag", async () => {
    const turn = { pa: PA, user: "u", context: "c" };
    expect(pact.pactTurnFromMeta({ pact: turn })).toEqual(turn);
    expect(pact.pactTurnFromMeta({})).toBeNull();
    const bag = { entries: [{ schema: pact.PACT_TURN_SCHEMA, file: "bag/1.json" }] };
    expect(await pact.pactTurnFromBag(bag, () => JSON.stringify(turn))).toEqual(turn);
    expect(await pact.pactTurnFromBag({ entries: [{ schema: pact.PACT_TURN_SCHEMA, file: "../x" }] }, () => "{}")).toBeNull();
  });
});

describe("what the agent reports", () => {
  it("builds the receipt's report, the step-up, the JSON text, and argsHash", async () => {
    expect(pact.missingScopes({ scopes: ["orders:read"] }, ["orders:read", "orders:cancel"])).toEqual(["orders:cancel"]);
    expect(pact.missingScopes(null, ["orders:read"])).toEqual(["orders:read"]);
    expect(pact.pactReport("Done.", ["orders:read", "orders:read"], [{ tool: "lookup_orders" }])).toEqual({ text: "Done.", pact: { scopes_used: ["orders:read"], actions: [{ tool: "lookup_orders" }] } });
    expect(pact.pactNeedsPermission("I need your OK.", ["orders:cancel"])).toEqual({ text: "I need your OK.", pact: { missing_scopes: ["orders:cancel"] } });
    expect(JSON.parse(pact.reportText(pact.pactReport("x", [])))).toEqual({ text: "x", pact: { scopes_used: [], actions: [] } });
    // The same arguments in any key order give the same hash; a string hashes as itself.
    expect(await pact.argsHash({ b: 1, a: 2 })).toBe(await pact.argsHash({ a: 2, b: 1 }));
    expect(await pact.argsHash("LG-1043")).toBe("xvttFnAwuRxJPlfxED4tNNBMBIE6v7Gx0TN8efVwsjo");
  });

  it("signs personal-agent JWTs for a person at a Provider", async () => {
    const { privateJwk, publicJwk } = await pact.generateEs256();
    const t = await pact.paSigner({ issuer: PA, privateJwk }).tokenFor("person-1", "https://p.example/a2a")();
    const ok = await pact.verifyPaJwt(t, { audience: "https://p.example/a2a", now: Math.floor(Date.now() / 1000), registrationFor: () => ({ issuer: PA, jwksUri: "x", enabled: true }), jwksFor: async () => ({ keys: [publicJwk] }) });
    expect("ok" in ok && ok.ok.sub).toBe("person-1");
  });
});
