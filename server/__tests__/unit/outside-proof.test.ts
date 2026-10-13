/**
 * Outside proofs (keychain/outside-proof.ts, SPEC §4.14): an OAuth token and a
 * JWT-SVID checked against the keys a tenant's trust record names, DPoP and
 * certificate binding, and an X.509-SVID chained to a trust bundle. Tokens are
 * minted here with locally made keys; nothing reaches a real identity provider.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, calculateJwkThumbprint, type JWK } from "jose";
import {
  ReplayCache,
  normalizeHtu,
  sha256b64url,
  spiffeTrustDomain,
  verifyDpopProof,
  verifyOutsideProof,
  type ProofDeps,
} from "../../src/keychain/outside-proof.js";
import { MemoryTrustAnchors, addRefusal, parseTrustRecord, type TrustRecord } from "../../src/keychain/trust-anchors.js";
import { HttpProofKeys, metadataUrls } from "../../src/keychain/proof-keys.js";

const ISSUER = "https://login.example.com/tenant-a/v2.0";
const AUD = "https://mesh.example.net";
const URL_BOOT = "https://mesh.example.net/v1/bootstrap";
const now = () => Date.now();

let issuerKey: CryptoKey;
let issuerJwk: JWK;
let svidKey: CryptoKey;
let svidJwk: JWK;
let otherKey: CryptoKey;

beforeAll(async () => {
  const a = await generateKeyPair("ES256");
  issuerKey = a.privateKey as CryptoKey;
  issuerJwk = { ...(await exportJWK(a.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const b = await generateKeyPair("RS256");
  svidKey = b.privateKey as CryptoKey;
  svidJwk = { ...(await exportJWK(b.publicKey)), kid: "s1", use: "jwt-svid" };
  otherKey = (await generateKeyPair("ES256")).privateKey as CryptoKey;
});

function anchorsWith(records: Array<[string, TrustRecord]>) {
  const m = new MemoryTrustAnchors();
  for (const [t, r] of records) m.map.set(t, [...(m.map.get(t) ?? []), r]);
  return m;
}

const oauth = (over: Partial<Extract<TrustRecord, { kind: "oauth" }>> = {}): TrustRecord => ({
  kind: "oauth", id: "o1", issuer: ISSUER, audience: AUD, require_binding: false, added_at: "x", added_by: "t", ...over,
});
const spiffe = (over: Partial<Extract<TrustRecord, { kind: "spiffe" }>> = {}): TrustRecord => ({
  kind: "spiffe", id: "s1", trust_domain: "example.org", bundle: { keys: [] }, require_mtls: false, added_at: "x", added_by: "t", ...over,
});

function deps(records: Array<[string, TrustRecord]>, extra: Partial<ProofDeps> = {}): ProofDeps {
  const anchors = anchorsWith(records);
  return {
    anchors: () => anchors.all(),
    keys: {
      oauthKeys: async () => ({ keys: [issuerJwk as Record<string, unknown>] }),
      spiffeBundle: async (a) => a.bundle ?? { keys: [svidJwk as Record<string, unknown>] },
    },
    defaultAudience: AUD,
    replay: new ReplayCache(),
    ...extra,
  };
}

async function token(claims: Record<string, unknown>, opts: { key?: CryptoKey; alg?: string; kid?: string; typ?: string; exp?: number } = {}) {
  const t = new SignJWT({ client_id: "buyer-agent", ...claims })
    .setProtectedHeader({ alg: opts.alg ?? "ES256", kid: opts.kid ?? "k1", ...(opts.typ ? { typ: opts.typ } : {}) })
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 600);
  return t.sign(opts.key ?? issuerKey);
}

async function dpopFor(tok: string | undefined, over: Record<string, unknown> = {}, key?: { privateKey: CryptoKey; jwk: JWK }) {
  const k = key ?? await (async () => { const p = await generateKeyPair("ES256"); return { privateKey: p.privateKey as CryptoKey, jwk: await exportJWK(p.publicKey) }; })();
  const proof = await new SignJWT({ htm: "POST", htu: URL_BOOT, jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000), ...(tok ? { ath: sha256b64url(tok) } : {}), ...over })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: k.jwk })
    .sign(k.privateKey);
  return { proof, jkt: await calculateJwkThumbprint(k.jwk, "sha256"), key: k };
}

const req = (extra: Record<string, unknown> = {}) => ({ method: "POST", urls: [URL_BOOT], ...extra });

describe("an OAuth proof", () => {
  it("enrolls into the tenant whose record trusts its issuer and audience, with the workload id from client_id", async () => {
    const t = await token({ iss: ISSUER, aud: AUD, sub: "sp-123" });
    const r = await verifyOutsideProof({ kind: "oauth", token: t }, req(), deps([["acme", oauth()]]));
    expect(r).toMatchObject({ ok: true, proof: { kind: "oauth", tenant: "acme", workload_id: "buyer-agent", subject: "sp-123", issuer: ISSUER, binding: null } });
  });

  it("falls back to azp, then sub, for the workload id", async () => {
    const t = await new SignJWT({ iss: ISSUER, aud: AUD, sub: "only-sub" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuedAt().setExpirationTime("10m").sign(issuerKey);
    const r = await verifyOutsideProof({ kind: "oauth", token: t }, req(), deps([["acme", oauth()]]));
    expect(r.ok && r.proof.workload_id).toBe("only-sub");
  });

  it("is refused with a wrong audience, an untrusted issuer, an expired token, or a key the issuer does not publish (i02, i03)", async () => {
    const d = deps([["acme", oauth()]]);
    const wrongAud = await verifyOutsideProof({ kind: "oauth", token: await token({ iss: ISSUER, aud: "https://elsewhere", sub: "s" }) }, req(), d);
    expect(wrongAud).toMatchObject({ ok: false, code: "proof_wrong_audience", status: 401 });
    const untrusted = await verifyOutsideProof({ kind: "oauth", token: await token({ iss: "https://evil.example", aud: AUD, sub: "s" }) }, req(), d);
    expect(untrusted).toMatchObject({ ok: false, code: "proof_issuer_untrusted" });
    const expired = await verifyOutsideProof({ kind: "oauth", token: await token({ iss: ISSUER, aud: AUD, sub: "s" }, { exp: Math.floor(Date.now() / 1000) - 3600 }) }, req(), d);
    expect(expired).toMatchObject({ ok: false, code: "proof_expired" });
    const forged = await verifyOutsideProof({ kind: "oauth", token: await token({ iss: ISSUER, aud: AUD, sub: "s" }, { key: otherKey }) }, req(), d);
    expect(forged).toMatchObject({ ok: false, code: "proof_invalid" });
  });

  it("refuses alg none and every HMAC algorithm before fetching any key (i04)", async () => {
    let fetched = 0;
    const d = deps([["acme", oauth()]], { keys: { oauthKeys: async () => { fetched++; return { keys: [issuerJwk as Record<string, unknown>] }; }, spiffeBundle: async () => ({ keys: [] }) } });
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const claims = { iss: ISSUER, aud: AUD, sub: "s", exp: Math.floor(Date.now() / 1000) + 600 };
    const none = `${b64({ alg: "none" })}.${b64(claims)}.`;
    expect(await verifyOutsideProof({ kind: "oauth", token: none }, req(), d)).toMatchObject({ ok: false, code: "proof_alg_refused" });
    // An HS256 token "signed" with the issuer's public key bytes: the classic confusion.
    const hs = await new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(JSON.stringify(issuerJwk)));
    expect(await verifyOutsideProof({ kind: "oauth", token: hs }, req(), d)).toMatchObject({ ok: false, code: "proof_alg_refused" });
    expect(fetched).toBe(0);
  });

  it("refuses a JWT of another type, such as a DPoP proof passed off as a token", async () => {
    const t = await token({ iss: ISSUER, aud: AUD, sub: "s" }, { typ: "dpop+jwt" });
    expect(await verifyOutsideProof({ kind: "oauth", token: t }, req(), deps([["acme", oauth()]]))).toMatchObject({ ok: false, code: "proof_typ_refused" });
  });

  it("fetches the keys again once when the token names a key id the set does not hold (a rotation)", async () => {
    let calls = 0;
    const d = deps([["acme", oauth()]], {
      keys: {
        oauthKeys: async (_a, refresh) => { calls++; return refresh ? { keys: [issuerJwk as Record<string, unknown>] } : { keys: [] }; },
        spiffeBundle: async () => ({ keys: [] }),
      },
    });
    const r = await verifyOutsideProof({ kind: "oauth", token: await token({ iss: ISSUER, aud: AUD, sub: "s" }) }, req(), d);
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("answers 503 and issues nothing when the keys cannot be fetched", async () => {
    const d = deps([["acme", oauth()]], { keys: { oauthKeys: async () => { const { KeysUnavailable } = await import("../../src/keychain/proof-keys.js"); throw new KeysUnavailable("down"); }, spiffeBundle: async () => ({ keys: [] }) } });
    expect(await verifyOutsideProof({ kind: "oauth", token: await token({ iss: ISSUER, aud: AUD, sub: "s" }) }, req(), d)).toMatchObject({ ok: false, status: 503, code: "proof_keys_unavailable" });
  });
});

describe("binding", () => {
  it("a DPoP-bound token enrolls with a DPoP proof made with its key, and is refused without one or with another key (i05, i06)", async () => {
    const k = await (async () => { const p = await generateKeyPair("ES256"); return { privateKey: p.privateKey as CryptoKey, jwk: await exportJWK(p.publicKey) }; })();
    const jkt = await calculateJwkThumbprint(k.jwk, "sha256");
    const t = await token({ iss: ISSUER, aud: AUD, sub: "s", cnf: { jkt } });
    const d = deps([["acme", oauth()]]);
    const good = await dpopFor(t, {}, k);
    expect(await verifyOutsideProof({ kind: "oauth", token: t }, req({ dpop: good.proof }), d)).toMatchObject({ ok: true, proof: { binding: { kind: "dpop", jkt } } });
    expect(await verifyOutsideProof({ kind: "oauth", token: t }, req(), d)).toMatchObject({ ok: false, code: "dpop_required" });
    const other = await dpopFor(t);
    expect(await verifyOutsideProof({ kind: "oauth", token: t }, req({ dpop: other.proof }), d)).toMatchObject({ ok: false, code: "dpop_key_mismatch" });
  });

  it("a record that requires binding refuses an unbound token", async () => {
    const t = await token({ iss: ISSUER, aud: AUD, sub: "s" });
    expect(await verifyOutsideProof({ kind: "oauth", token: t }, req(), deps([["acme", oauth({ require_binding: true })]]))).toMatchObject({ ok: false, code: "proof_binding_required" });
  });

  it("a DPoP proof is refused when replayed, for another URL or method, stale, without ath, or carrying a private key", async () => {
    const replay = new ReplayCache();
    const t = "access-token";
    const p = await dpopFor(t);
    expect((await verifyDpopProof(p.proof, { method: "POST", urls: [URL_BOOT], accessToken: t }, replay)).ok).toBe(true);
    expect(await verifyDpopProof(p.proof, { method: "POST", urls: [URL_BOOT], accessToken: t }, replay)).toMatchObject({ ok: false, code: "dpop_invalid" });
    expect((await verifyDpopProof((await dpopFor(t, { htu: "https://other.example/v1/bootstrap" })).proof, { method: "POST", urls: [URL_BOOT], accessToken: t }, replay)).ok).toBe(false);
    expect((await verifyDpopProof((await dpopFor(t, { htm: "GET" })).proof, { method: "POST", urls: [URL_BOOT], accessToken: t }, replay)).ok).toBe(false);
    expect((await verifyDpopProof((await dpopFor(t, { iat: Math.floor(Date.now() / 1000) - 3600 })).proof, { method: "POST", urls: [URL_BOOT], accessToken: t }, replay)).ok).toBe(false);
    expect((await verifyDpopProof((await dpopFor(undefined)).proof, { method: "POST", urls: [URL_BOOT], accessToken: t }, replay)).ok).toBe(false);
    const priv = await generateKeyPair("ES256", { extractable: true });
    const full = await exportJWK(priv.privateKey);
    const leaky = await new SignJWT({ htm: "POST", htu: URL_BOOT, jti: "j", iat: Math.floor(Date.now() / 1000), ath: sha256b64url(t) })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: full }).sign(priv.privateKey);
    expect(await verifyDpopProof(leaky, { method: "POST", urls: [URL_BOOT], accessToken: t }, replay)).toMatchObject({ ok: false, error: expect.stringMatching(/private key/) });
  });

  it("htu is compared without query or fragment, and with the host in lower case", () => {
    expect(normalizeHtu("HTTPS://Mesh.Example.NET:443/v1/bootstrap?x=1#y")).toBe("https://mesh.example.net/v1/bootstrap");
    expect(normalizeHtu("https://mesh.example.net/V1/Bootstrap")).toBe("https://mesh.example.net/V1/Bootstrap");
  });

  it("a certificate-bound token enrolls only over mTLS with that certificate", async () => {
    const leaf = new X509Certificate(readFileSync(join(__dirname, "../fixtures/svid-leaf.crt")));
    const ca = new X509Certificate(readFileSync(join(__dirname, "../fixtures/svid-ca.crt")));
    const t = await token({ iss: ISSUER, aud: AUD, sub: "s", cnf: { "x5t#S256": sha256b64url(leaf.raw) } });
    const d = deps([["acme", oauth()]]);
    expect(await verifyOutsideProof({ kind: "oauth", token: t }, req({ clientCerts: [leaf] }), d)).toMatchObject({ ok: true, proof: { binding: { kind: "mtls" } } });
    expect(await verifyOutsideProof({ kind: "oauth", token: t }, req(), d)).toMatchObject({ ok: false, code: "mtls_required" });
    expect(await verifyOutsideProof({ kind: "oauth", token: t }, req({ clientCerts: [ca] }), d)).toMatchObject({ ok: false, code: "mtls_cert_mismatch" });
  });
});

describe("SPIFFE", () => {
  async function svid(sub: string, aud = AUD) {
    return new SignJWT({ sub, aud }).setProtectedHeader({ alg: "RS256", kid: "s1", typ: "JWT" }).setIssuedAt().setExpirationTime("5m").sign(svidKey);
  }

  it("a JWT-SVID from a trusted trust domain enrolls, with its SPIFFE ID as the workload id (i07)", async () => {
    const r = await verifyOutsideProof({ kind: "jwt-svid", token: await svid("spiffe://example.org/agents/buyer") }, req(), deps([["acme", spiffe({ bundle: { keys: [svidJwk as Record<string, unknown>] } })]]));
    expect(r).toMatchObject({ ok: true, proof: { kind: "jwt-svid", tenant: "acme", workload_id: "spiffe://example.org/agents/buyer", trust_domain: "example.org" } });
  });

  it("a SPIFFE ID outside every trusted trust domain is refused, and so is a malformed one (i08)", async () => {
    const d = deps([["acme", spiffe({ bundle: { keys: [svidJwk as Record<string, unknown>] } })]]);
    expect(await verifyOutsideProof({ kind: "jwt-svid", token: await svid("spiffe://evil.org/agents/buyer") }, req(), d)).toMatchObject({ ok: false, code: "proof_issuer_untrusted" });
    expect(await verifyOutsideProof({ kind: "jwt-svid", token: await svid("spiffe://example.org/../x") }, req(), d)).toMatchObject({ ok: false, code: "proof_invalid" });
    expect(await verifyOutsideProof({ kind: "jwt-svid", token: await svid("spiffe://example.org/agents/buyer", "https://elsewhere") }, req(), d)).toMatchObject({ ok: false, code: "proof_wrong_audience" });
  });

  it("a trust domain that requires mTLS refuses a JWT-SVID alone", async () => {
    const d = deps([["acme", spiffe({ require_mtls: true, bundle: { keys: [svidJwk as Record<string, unknown>] } })]]);
    expect(await verifyOutsideProof({ kind: "jwt-svid", token: await svid("spiffe://example.org/agents/buyer") }, req(), d)).toMatchObject({ ok: false, code: "mtls_required" });
  });

  it("an X.509-SVID over mTLS enrolls when it chains to the bundle, and is refused against another CA", async () => {
    const leaf = new X509Certificate(readFileSync(join(__dirname, "../fixtures/svid-leaf.crt")));
    const caPem = readFileSync(join(__dirname, "../fixtures/svid-ca.crt"), "utf8");
    const otherPem = readFileSync(join(__dirname, "../fixtures/svid-other-ca.crt"), "utf8");
    const der = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const good = deps([["acme", spiffe({ bundle: { keys: [{ kty: "EC", use: "x509-svid", x5c: [der(caPem)] }] } })]]);
    expect(await verifyOutsideProof({ kind: "x509-svid" }, req({ clientCerts: [leaf] }), good)).toMatchObject({ ok: true, proof: { kind: "x509-svid", workload_id: "spiffe://example.org/agents/buyer", binding: { kind: "mtls" } } });
    const bad = deps([["acme", spiffe({ bundle: { keys: [{ kty: "EC", use: "x509-svid", x5c: [der(otherPem)] }] } })]]);
    expect(await verifyOutsideProof({ kind: "x509-svid" }, req({ clientCerts: [leaf] }), bad)).toMatchObject({ ok: false, code: "proof_invalid" });
    expect(await verifyOutsideProof({ kind: "x509-svid" }, req(), good)).toMatchObject({ ok: false, code: "mtls_required" });
  });

  it("reads SPIFFE IDs strictly", () => {
    expect(spiffeTrustDomain("spiffe://example.org/a/b")).toBe("example.org");
    expect(spiffeTrustDomain("spiffe://example.org")).toBe("example.org");
    expect(spiffeTrustDomain("spiffe://Example.org/a")).toBeNull();
    expect(spiffeTrustDomain("spiffe://example.org/a/")).toBeNull();
    expect(spiffeTrustDomain("https://example.org/a")).toBeNull();
  });
});

describe("trust records", () => {
  it("parse with their defaults, and refuse what would make a proof ambiguous", async () => {
    const env = {};
    const a = parseTrustRecord({ kind: "oauth", issuer: ISSUER, audience: AUD }, "admin", env);
    expect(a).toMatchObject({ ok: true, record: { kind: "oauth", require_binding: false, id: expect.stringMatching(/^oauth-/) } });
    expect(parseTrustRecord({ kind: "oauth", issuer: "http://login.example.com", audience: AUD }, "admin", env).ok).toBe(false);
    expect(parseTrustRecord({ kind: "oauth", issuer: "http://localhost:9000", audience: AUD }, "admin", env).ok).toBe(true);
    expect(parseTrustRecord({ kind: "spiffe", trust_domain: "Example.org", bundle: { keys: [] } }, "admin", env).ok).toBe(false);
    expect(parseTrustRecord({ kind: "spiffe", trust_domain: "example.org" }, "admin", env).ok).toBe(false);
    const m = new MemoryTrustAnchors();
    expect(await m.add("acme", oauth())).toEqual({ ok: true });
    expect(await m.add("other", oauth({ id: "o2" }))).toMatchObject({ ok: false, status: 409 });
    expect(await m.add("acme", oauth({ id: "o3", audience: "aud-2" }))).toEqual({ ok: true });
    expect(addRefusal(m.map, "acme", spiffe())).toBeNull();
  });

  it("an issuer's metadata is looked for where RFC 8414 and OpenID Discovery put it", () => {
    expect(metadataUrls(ISSUER)).toEqual([
      "https://login.example.com/tenant-a/v2.0/.well-known/openid-configuration",
      "https://login.example.com/.well-known/oauth-authorization-server/tenant-a/v2.0",
    ]);
  });

  it("keys are fetched through the issuer's metadata, refused when the metadata names another issuer, and kept between calls", async () => {
    const calls: string[] = [];
    const docs: Record<string, unknown> = {
      "https://login.example.com/tenant-a/v2.0/.well-known/openid-configuration": { issuer: ISSUER, jwks_uri: "https://login.example.com/keys" },
      "https://login.example.com/keys": { keys: [issuerJwk] },
      "https://bad.example/.well-known/openid-configuration": { issuer: "https://other.example", jwks_uri: "https://bad.example/keys" },
    };
    const fetcher = async (url: string) => {
      calls.push(url);
      const body = docs[url];
      return { ok: !!body, status: body ? 200 : 404, headers: { get: () => null }, text: async () => JSON.stringify(body ?? {}) };
    };
    const keys = new HttpProofKeys(fetcher);
    const set = await keys.oauthKeys(oauth() as never);
    expect(set.keys).toHaveLength(1);
    await keys.oauthKeys(oauth() as never);
    expect(calls).toHaveLength(2);
    await expect(keys.oauthKeys(oauth({ issuer: "https://bad.example" }) as never)).rejects.toThrow(/could not be found/);
  });
});
