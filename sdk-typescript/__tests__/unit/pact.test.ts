// PACT 1.0 in the SDK (src/pact/), asserted case by case against
// conformance/pact-identity.json and conformance/pact-delegated.json. Like the
// other conformance suites, this file ITERATES the fixtures instead of
// restating them: a case added to a fixture is tested without editing this
// file, and the fixture is the authority.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  b64urlEncode,
  decodeJwt,
  generateEs256,
  jwkThumbprint,
  publicJwk,
  signJws,
  verifyPaJwt,
  verifyDelegationToken,
  signReceipt,
  verifyReceipt,
  signPaJwt,
  checkPaClaims,
  interfaceUrlOf,
  delegationSchemeOf,
  parseScope,
  type Jwk,
  type Jwks,
  type PaRegistration,
} from "../../src/pact/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const identity = JSON.parse(readFileSync(join(here, "..", "..", "..", "conformance", "pact-identity.json"), "utf8"));
const delegated = JSON.parse(readFileSync(join(here, "..", "..", "..", "conformance", "pact-delegated.json"), "utf8"));

type Case = { case: string; sign?: string; header?: Record<string, unknown>; claims?: Record<string, unknown>; tamper?: string; raw?: string };

/** The base header and claims with a case's overrides; a null override deletes. */
function merged(base: Record<string, unknown>, over: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

async function hs256(signingInput: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("not-an-allowed-key"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput))));
}

/** Build the token a vector case describes. */
async function tokenFor(c: Case, base: { header: Record<string, unknown>; claims: Record<string, unknown> }, keys: { main: Jwk; rsa: Jwk; other: Jwk }): Promise<string> {
  if (c.raw) return c.raw;
  const header = merged(base.header, c.header);
  const claims = merged(base.claims, c.claims);
  if (c.sign === "hs256" || c.sign === "none") {
    const si = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(claims))}`;
    return `${si}.${c.sign === "none" ? "" : await hs256(si)}`;
  }
  const key = c.sign === "rs256" ? keys.rsa : c.sign === "other_key" ? keys.other : keys.main;
  // signJws writes alg and kid from the key, then the case's header on top.
  const { alg: _alg, ...rest } = header;
  let token = await signJws(JSON.stringify(claims), key, rest);
  if (c.tamper === "flip_last_signature_byte") {
    const [h, p, s] = token.split(".");
    const last = s.slice(-2, -1) === "A" ? "B" : "A";
    token = `${h}.${p}.${s.slice(0, -2)}${last}${s.slice(-1)}`;
  }
  return token;
}

describe("PACT Identity claim vectors (conformance/pact-identity.json jwt_vectors)", () => {
  const v = identity.jwt_vectors;
  let keys: { main: Jwk; rsa: Jwk; other: Jwk };
  let jwks: Jwks;
  const registration: PaRegistration = { issuer: identity.test_key.issuer, jwksUri: "https://pa.test.invalid/.well-known/jwks.json", enabled: true };

  beforeAll(async () => {
    const rsaPair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const rsa = { ...((await crypto.subtle.exportKey("jwk", rsaPair.privateKey)) as Jwk), kid: "pact-test-rsa", alg: "RS256", use: "sig" };
    const other = (await generateEs256()).privateJwk;
    keys = { main: identity.test_key.private_jwk, rsa, other: { ...other, kid: "not-published" } };
    jwks = { keys: [publicJwk(keys.main), publicJwk(rsa)] };
  });

  const deps = () => ({
    audience: identity.test_key.audience,
    now: v.now,
    registrationFor: (iss: string) => (iss === registration.issuer ? registration : undefined),
    jwksFor: async () => jwks,
  });

  for (const c of v.accept as Case[]) {
    it(`accepts ${c.case}`, async () => {
      const out = await verifyPaJwt(await tokenFor(c, v.base, keys), deps());
      expect(out).toHaveProperty("ok");
    });
  }
  for (const c of v.refuse as Case[]) {
    it(`refuses ${c.case}`, async () => {
      const out = await verifyPaJwt(await tokenFor(c, v.base, keys), deps());
      expect(out).toHaveProperty("refused");
    });
  }

  it("refuses a disabled platform (PI-R2)", async () => {
    const off = { ...registration, enabled: false };
    const out = await verifyPaJwt(await tokenFor({ case: "x" }, v.base, keys), { ...deps(), registrationFor: () => off });
    expect(out).toEqual({ refused: "disabled_platform" });
  });

  it("refetches the JWKS once on an unknown kid, so a rotated key works (PI-J10)", async () => {
    let fetches = 0;
    const rotated = (await generateEs256()).privateJwk;
    const token = await signJws(JSON.stringify(merged(v.base.claims, {})), rotated, { typ: "JWT" });
    const out = await verifyPaJwt(token, {
      ...deps(),
      jwksFor: async (_r, fresh) => {
        fetches++;
        return fresh ? { keys: [...jwks.keys, publicJwk(rotated)] } : jwks;
      },
    });
    expect(out).toHaveProperty("ok");
    expect(fetches).toBe(2);
  });
});

describe("the personal agent's own tokens (PI-J3, PI-J5, PI-J8)", () => {
  it("signs ES256 with a kid that is the key's thumbprint, lives at most 300 s, and passes the Provider's checks", async () => {
    const { privateJwk, publicJwk: pub } = await generateEs256();
    expect(privateJwk.kid).toBe(await jwkThumbprint(pub));
    const now = 1791000000;
    const token = await signPaJwt(privateJwk, { iss: "https://pa.test.invalid", sub: "opaque-1", aud: "https://p/a2a", now, lifeSeconds: 900 });
    const jwt = decodeJwt(token)!;
    expect(jwt.header).toMatchObject({ alg: "ES256", kid: privateJwk.kid, typ: "JWT" });
    expect((jwt.claims.exp as number) - (jwt.claims.iat as number)).toBe(300);
    expect(checkPaClaims(jwt.claims, { audience: "https://p/a2a", now })).toBeNull();
  });
});

describe("PACT Delegated token vectors (conformance/pact-delegated.json delegation_vectors)", () => {
  const v = delegated.delegation_vectors;
  let provider: Jwk;
  let other: Jwk;
  let revoked = false;
  beforeAll(async () => {
    provider = (await generateEs256()).privateJwk;
    other = (await generateEs256()).privateJwk;
  });
  const check = async (token: string) =>
    verifyDelegationToken(token, {
      keys: { keys: [publicJwk(provider)] },
      issuer: v.issuer,
      audience: v.interface_url,
      paIssuer: "https://pa.test.invalid",
      now: v.now,
      grantLive: (id) => id === "pactgrant_test1" && !revoked,
    });
  const build = async (c: Case & { revoke_grant_first?: boolean; header_value?: string }) =>
    c.header_value ? c.header_value : tokenFor(c, v.base, { main: provider, rsa: provider, other });

  for (const c of v.accept as Case[]) {
    it(`accepts ${c.case}`, async () => {
      revoked = false;
      expect(await check(await build(c))).toHaveProperty("ok");
    });
  }
  for (const c of v.refuse as Array<Case & { revoke_grant_first?: boolean; header_value?: string }>) {
    it(`refuses ${c.case}`, async () => {
      revoked = !!c.revoke_grant_first;
      expect(await check(await build(c))).toHaveProperty("refused");
      revoked = false;
    });
  }
});

describe("receipts (PD-R1, PD-R2)", () => {
  it("signs the fixture's claims and verifies them, whatever the key order", async () => {
    const { privateJwk } = await generateEs256();
    const receipt = await signReceipt(delegated.receipt_vector.claims, privateJwk);
    const keys = { keys: [publicJwk(privateJwk)] };
    expect(await verifyReceipt(receipt, keys, { grantId: "pactgrant_test1", pa: "https://pa.test.invalid" })).toEqual({ ok: receipt.claims });
    const reordered = { ...receipt, claims: Object.fromEntries(Object.entries(receipt.claims).reverse()) as typeof receipt.claims };
    expect(await verifyReceipt(reordered, keys)).toHaveProperty("ok");
    expect(await verifyReceipt({ ...receipt, claims: { ...receipt.claims, scopesUsed: ["orders:refund"] } }, keys)).toEqual({ refused: "claims_differ" });
    expect(await verifyReceipt(receipt, keys, { user: "someone-else" })).toEqual({ refused: "expected" });
    const stranger = (await generateEs256()).privateJwk;
    expect(await verifyReceipt(receipt, { keys: [publicJwk(stranger)] })).toEqual({ refused: "signature" });
  });
});

describe("reading a card (PI-C6, PD-C1)", () => {
  it("picks the interface by binding and version, not by position", () => {
    expect(
      interfaceUrlOf({
        supportedInterfaces: [
          { url: "https://p/agents/x/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
          { url: "https://p/a2a/x/", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
        ],
      }),
    ).toBe("https://p/a2a/x");
    expect(interfaceUrlOf({ supportedInterfaces: [{ url: "https://p/old", protocolBinding: "HTTP+JSON", protocolVersion: "0.3" }] })).toBeNull();
  });

  it("finds the delegation scheme by its type, whatever it is named", () => {
    const card = {
      securitySchemes: {
        anyName: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } },
        another: {
          oauth2SecurityScheme: {
            flows: { deviceCode: { deviceAuthorizationUrl: "https://p/d", tokenUrl: "https://p/t", scopes: { "orders:read": "See your orders" } } },
            oauth2MetadataUrl: "https://p/m",
          },
        },
      },
      securityRequirements: [{ schemes: { anyName: { list: [] } } }, { schemes: { anyName: { list: [] }, another: { list: [] } } }],
    };
    expect(delegationSchemeOf(card)).toEqual({
      deviceAuthorizationUrl: "https://p/d",
      tokenUrl: "https://p/t",
      refreshUrl: "https://p/t",
      metadataUrl: "https://p/m",
      scopes: [{ id: "orders:read", description: "See your orders" }],
    });
    expect(delegationSchemeOf({ ...card, securityRequirements: [card.securityRequirements[0]] })).toBeNull();
  });

  it("reads scope strings without blanks or repeats", () => {
    expect(parseScope(" a  b a ")).toEqual(["a", "b"]);
  });
});
