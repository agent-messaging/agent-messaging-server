/**
 * Bring your own identity on the SDK's side (Agent Messaging 0.8): checking
 * evidence of acting for a person (§4.16), the roster's provenance rules
 * (EXT-6 0.5.0), and a DPoP proof (RFC 9449).
 */
import { describe, it, expect } from "vitest";
import { generateEs256, signJwt, decodeJws, jwkThumbprint, publicJwk } from "../../src/pact/jose.js";
import { verifyOnBehalfOf } from "../../src/on-behalf-of.js";
import { rosterStance, parseRosterSource } from "../../src/admission.js";
import { createDpopProof, generateDpopKey } from "../../src/outside-proof.js";

const RECEIVER = "UCONFORMANCERECEIVER";
const now = () => Math.floor(Date.now() / 1000);

describe("verifyOnBehalfOf (§4.16)", () => {
  it("is verified for this receiver from a trusted issuer, refused for another audience or an expired token, unverifiable from a stranger", async () => {
    const trusted = await generateEs256();
    const stranger = await generateEs256();
    const opts = { audience: RECEIVER, trustedIssuers: [{ issuer: "https://idp.example", jwks: { keys: [trusted.publicJwk] } }] };
    const token = (key: typeof trusted, iss: string, claims: Record<string, unknown> = {}) =>
      signJwt({ iss, sub: "person", aud: RECEIVER, iat: now(), exp: now() + 300, ...claims }, key.privateJwk, { typ: "at+jwt" });
    const env = (tok: string, issuer: string) => ({ meta: { on_behalf_of: { kind: "token-exchange", token: tok, issuer } } });
    expect(await verifyOnBehalfOf(env(await token(trusted, "https://idp.example"), "https://idp.example"), opts)).toBe("verified");
    expect(await verifyOnBehalfOf(env(await token(trusted, "https://idp.example", { aud: "someone-else" }), "https://idp.example"), opts)).toBe("refused");
    expect(await verifyOnBehalfOf(env(await token(trusted, "https://idp.example", { exp: now() - 600 }), "https://idp.example"), opts)).toBe("refused");
    expect(await verifyOnBehalfOf(env(await token(stranger, "https://idp.example"), "https://idp.example"), opts)).toBe("refused");
    expect(await verifyOnBehalfOf(env(await token(stranger, "https://other.example"), "https://other.example"), opts)).toBe("unverifiable");
    expect(await verifyOnBehalfOf({ meta: {} }, opts)).toBe("unverifiable");
  });
});

describe("the roster's provenance rules (EXT-6 0.5.0)", () => {
  const facts = (over: Record<string, unknown> = {}) => ({ registered: true, bridged: false, ...over });
  it("a sender entry beats a source entry, which beats the tier; bridged holds by default", () => {
    const roster = {
      defaults: { registered: "allow", anonymous: "block" },
      entries: [
        { subject: "UALICE", stance: "allow" },
        { source: "oauth:https://idp.example", stance: "block" },
      ],
    };
    expect(rosterStance(roster, "UALICE", facts({ source: { kind: "oauth", issuer: "https://idp.example" } }))).toBe("allow");
    expect(rosterStance(roster, "UBOB", facts({ source: { kind: "oauth", issuer: "https://idp.example" } }))).toBe("block");
    expect(rosterStance(roster, "UCAROL", facts())).toBe("allow");
    expect(rosterStance(roster, "UDAVE", facts({ bridged: true }))).toBe("hold");
    expect(rosterStance({ ...roster, defaults: { ...roster.defaults, bridged: "block" } }, "UDAVE", facts({ bridged: true }))).toBe("block");
    expect(rosterStance(roster, "UEVE", facts({ registered: false }))).toBe("block");
  });

  it("matches a SPIFFE trust domain, and a roster with a source nobody can read fails closed", () => {
    expect(rosterStance({ entries: [{ source: "spiffe://example.org", stance: "allow" }] }, "U1", facts({ source: { kind: "spiffe", trust_domain: "example.org" } }))).toBe("allow");
    expect(rosterStance({ defaults: { registered: "allow" }, entries: [{ source: "ldap:corp", stance: "allow" }] }, "U1", facts())).toBe("block");
    expect(parseRosterSource("oauth:https://idp.example")).toEqual({ issuer: "https://idp.example" });
    expect(parseRosterSource("spiffe://example.org")).toEqual({ trust_domain: "example.org" });
    expect(parseRosterSource("oauth:not a url")).toBeNull();
  });
});

describe("a DPoP proof (RFC 9449)", () => {
  it("names the method, the address without its query, the token's hash, and carries only the public key", async () => {
    const k = await generateDpopKey();
    const proof = await createDpopProof({ method: "post", url: "https://mesh.example.com/v1/bootstrap?x=1", accessToken: "tok", privateJwk: k.privateJwk });
    const jws = decodeJws(proof)!;
    const claims = JSON.parse(new TextDecoder().decode(jws.payload));
    expect(jws.header).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
    expect((jws.header.jwk as Record<string, unknown>).d).toBeUndefined();
    expect(await jwkThumbprint(publicJwk(jws.header.jwk as never))).toBe(k.jkt);
    expect(claims).toMatchObject({ htm: "POST", htu: "https://mesh.example.com/v1/bootstrap" });
    expect(typeof claims.jti).toBe("string");
    expect(claims.ath).toBeTruthy();
  });
});
