/**
 * Outside proofs (SPEC §4.14, step 11 of the bring-your-own-identity plan):
 * checking a proof of identity that another system issued, so an agent can
 * enroll with it instead of the operator's one-time key.
 *
 * The proofs, and what is checked for each:
 *
 *   oauth      a JWT access token (RFC 9068) or other signed JWT from an
 *              issuer a tenant trusts: the signature against the issuer's
 *              published keys, `iss`, `aud` (the record's audience), `exp`,
 *              `nbf` and `iat`, `typ` where it is set, and the binding below.
 *   jwt-svid   a SPIFFE JWT-SVID: the signature against the trust domain's
 *              bundle, `sub` a SPIFFE ID inside a trusted trust domain, `aud`
 *              (the record's audience, else this mesh's), `exp`.
 *   x509-svid  a SPIFFE X.509-SVID the caller presented over mTLS: the chain
 *              to one of the bundle's X.509 authorities, the dates, and one
 *              SPIFFE ID in the leaf's URI SAN.
 *
 * Binding (proof of possession). A token whose `cnf` carries `jkt` is
 * DPoP-bound (RFC 9449): the request must carry a DPoP proof signed by that
 * key, for this method and URL, fresh, never seen before, and naming the
 * token's hash in `ath`. A token whose `cnf` carries `x5t#S256` is bound to a
 * client certificate (RFC 8705): the request must have come over mTLS with
 * that certificate. A record with `require_binding` refuses an unbound token.
 *
 * Only asymmetric algorithms are accepted: RS, PS and ES at 256, 384 and 512
 * bits, and EdDSA. `none` and every HMAC algorithm are refused, because a
 * key set an issuer publishes must never be read as a shared secret.
 *
 * Every refusal has a code a client can act on and a sentence a person can
 * read. Nothing here writes anything: the doors decide what a proof that
 * passed becomes (doors.ts).
 */
import { createHash, X509Certificate } from "node:crypto";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  EmbeddedJWK,
  errors,
  jwtVerify,
  type JWTPayload,
} from "jose";
import type { IdentitySource } from "../sdk.js";
import { KeysUnavailable, type ProofKeySource } from "./proof-keys.js";
import { oauthTrustFor, spiffeTrustFor, type JwkSet, type OAuthTrust, type SpiffeTrust, type TrustRecord } from "./trust-anchors.js";

/** The algorithms an outside proof or a DPoP proof may use. */
export const PROOF_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"] as const;
const ALGS = new Set<string>(PROOF_ALGORITHMS);

/** The `typ` values an access token or JWT-SVID may carry. Anything else (a
 *  DPoP proof, a security event, an ID-JAG) is a different kind of JWT and is
 *  refused, so one cannot be passed off as another. */
const TOKEN_TYPS = new Set(["jwt", "at+jwt", "application/at+jwt", "jose"]);

/** How far a clock may be off, in seconds. */
const SKEW_S = 60;
/** How old a DPoP proof may be. */
const DPOP_MAX_AGE_S = 300;

export type ProofKind = "oauth" | "jwt-svid" | "x509-svid";

export interface ProofInput {
  kind: string;
  token?: string;
}

/** Where a proof was presented: what a DPoP proof and an mTLS binding are checked against. */
export interface ProofRequest {
  /** The request's method. */
  method: string;
  /** The URLs the request may be said to have reached (the door's public
   *  address and any others this mesh answers on). A DPoP proof's `htu` must
   *  be one of them. */
  urls: string[];
  /** The DPoP proof, from the `DPoP` header or the body's `dpop`. */
  dpop?: string;
  /** The client certificate chain, leaf first, when the request came over mTLS. */
  clientCerts?: X509Certificate[];
  /** A binding a bridge already checked on the caller's own request (an
   *  identity bridge, §4.15): the DPoP key's thumbprint or the certificate's
   *  hash. Accepted in place of a DPoP proof or a client certificate here,
   *  and only from a node this mesh names as a bridge. */
  verifiedBinding?: { jkt?: string; x5t?: string };
}

/** A proof that passed, and what it says. */
export interface VerifiedProof {
  kind: ProofKind;
  tenant: string;
  anchor: TrustRecord;
  /** The WIMSE identifier: the SPIFFE ID, or for OAuth the token's
   *  `client_id`, else `azp`, else `sub`. */
  workload_id: string;
  /** The token's subject: for OAuth `sub`, for SPIFFE the SPIFFE ID. */
  subject: string;
  issuer?: string;
  trust_domain?: string;
  /** How the proof was bound to the caller's key, when it was. */
  binding: { kind: "dpop"; jkt: string } | { kind: "mtls"; x5t: string } | null;
  /** When the proof stops being good, ISO-8601. */
  expires_at: string | null;
}

export interface ProofRefusal {
  status: number;
  code: string;
  error: string;
}

export type ProofResult = { ok: true; proof: VerifiedProof } | ({ ok: false } & ProofRefusal);

export interface ProofDeps {
  /** Every tenant's trust records. */
  anchors(): Promise<Map<string, TrustRecord[]>>;
  keys: ProofKeySource;
  /** The audience a JWT-SVID must carry when its record names none. */
  defaultAudience: string;
  replay: ReplayCache;
  now?: () => number;
}

const refuse = (status: number, code: string, error: string): ProofResult => ({ ok: false, status, code, error });

/** DPoP proof ids already seen, kept for as long as a proof could be accepted. */
export class ReplayCache {
  private seen = new Map<string, number>();
  constructor(private max = 50_000) {}
  /** True the first time `id` is seen before `expiresAtMs`, false after. */
  firstUse(id: string, expiresAtMs: number, now = Date.now()): boolean {
    if (this.seen.size >= this.max) {
      for (const [k, exp] of this.seen) { if (exp <= now) this.seen.delete(k); }
      if (this.seen.size >= this.max) {
        const oldest = this.seen.keys().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
    }
    const have = this.seen.get(id);
    if (have !== undefined && have > now) return false;
    this.seen.set(id, expiresAtMs);
    return true;
  }
}

/** base64url(SHA-256(text)), as `ath` and `x5t#S256` carry it. */
export function sha256b64url(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("base64url");
}

/** A URL as `htu` is compared (RFC 9449 §4.3): no query or fragment, scheme
 *  and host in lower case, the default port dropped. */
export function normalizeHtu(raw: string): string | null {
  try {
    const u = new URL(raw);
    // URL already writes the scheme and host in lower case and drops a default port.
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"];

/**
 * Check a DPoP proof (RFC 9449 §4.3) for one request. Returns the thumbprint
 * of the key that signed it (`jkt`), or a refusal.
 */
export async function verifyDpopProof(
  proof: string,
  req: { method: string; urls: string[]; accessToken?: string },
  replay: ReplayCache,
  now = Date.now(),
): Promise<{ ok: true; jkt: string } | ({ ok: false } & ProofRefusal)> {
  const bad = (error: string) => ({ ok: false as const, status: 401, code: "dpop_invalid", error });
  let header: ReturnType<typeof decodeProtectedHeader>;
  try { header = decodeProtectedHeader(proof); } catch { return bad("The DPoP proof is not a JWT."); }
  if (header.typ !== "dpop+jwt") return bad('The DPoP proof must have typ "dpop+jwt".');
  if (typeof header.alg !== "string" || !ALGS.has(header.alg)) return bad("The DPoP proof's algorithm is not accepted. Use an asymmetric algorithm such as ES256 or EdDSA.");
  const jwk = header.jwk as Record<string, unknown> | undefined;
  if (!jwk || typeof jwk !== "object") return bad("The DPoP proof must carry its public key in jwk.");
  if (PRIVATE_JWK_MEMBERS.some((m) => m in jwk)) return bad("The DPoP proof's jwk holds private key material. Send the public key only.");
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(proof, EmbeddedJWK, { typ: "dpop+jwt", algorithms: [...ALGS], currentDate: new Date(now) }));
  } catch {
    return bad("The DPoP proof's signature does not verify with the key it carries.");
  }
  const jti = payload.jti;
  if (typeof jti !== "string" || !jti || jti.length > 256) return bad("The DPoP proof needs a jti.");
  if (payload.htm !== req.method) return bad(`The DPoP proof is for ${String(payload.htm)}, and this request is ${req.method}.`);
  const htu = typeof payload.htu === "string" ? normalizeHtu(payload.htu) : null;
  const allowed = req.urls.map(normalizeHtu).filter((x): x is string => !!x);
  if (!htu || !allowed.includes(htu)) return bad("The DPoP proof's htu is not the address this request was sent to.");
  const iat = payload.iat;
  const nowS = Math.floor(now / 1000);
  if (typeof iat !== "number" || iat > nowS + SKEW_S || iat < nowS - DPOP_MAX_AGE_S) return bad("The DPoP proof is too old, or dated in the future. Make a fresh one for each request.");
  if (req.accessToken !== undefined && payload.ath !== sha256b64url(req.accessToken)) return bad("The DPoP proof's ath is not the hash of the token it was sent with.");
  let jkt: string;
  try { jkt = await calculateJwkThumbprint(jwk as never, "sha256"); } catch { return bad("The DPoP proof's key could not be read."); }
  if (!replay.firstUse(`${jkt}\n${jti}`, (iat + DPOP_MAX_AGE_S + SKEW_S) * 1000, now)) return bad("This DPoP proof was used before. Make a fresh one for each request.");
  return { ok: true, jkt };
}

/** The SPIFFE ID's trust domain, or null when it is not a well-formed SPIFFE ID. */
export function spiffeTrustDomain(id: string): string | null {
  const m = /^spiffe:\/\/([a-z0-9._-]{1,255})(\/[A-Za-z0-9._\-/]*)?$/.exec(id);
  if (!m) return null;
  const path = m[2] ?? "";
  if (path.endsWith("/") || path.includes("//") || /\/\.\.?(\/|$)/.test(path)) return null;
  return m[1]!;
}

function audienceOf(p: JWTPayload): string[] {
  return typeof p.aud === "string" ? [p.aud] : Array.isArray(p.aud) ? p.aud.filter((x): x is string => typeof x === "string") : [];
}

function expiresAt(p: JWTPayload): string | null {
  return typeof p.exp === "number" ? new Date(p.exp * 1000).toISOString() : null;
}

/** Verify a JWT against a key set, fetching the set again once when the
 *  token names a key id the set does not hold (a rotation). */
async function verifyAgainst(
  token: string,
  loadKeys: (refresh: boolean) => Promise<JwkSet>,
  opts: { issuer?: string; audience: string; now: number },
): Promise<{ ok: true; payload: JWTPayload } | { ok: false; reason: "keys" | "nokey" | "claims" | "signature"; detail: string }> {
  for (const refresh of [false, true]) {
    let set: JwkSet;
    try { set = await loadKeys(refresh); } catch (err) { return { ok: false, reason: "keys", detail: (err as Error).message }; }
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(set as never), {
        algorithms: [...ALGS],
        ...(opts.issuer ? { issuer: opts.issuer } : {}),
        audience: opts.audience,
        requiredClaims: ["exp"],
        clockTolerance: SKEW_S,
        currentDate: new Date(opts.now),
      });
      return { ok: true, payload };
    } catch (err) {
      if (err instanceof errors.JWKSNoMatchingKey || err instanceof errors.JWKSMultipleMatchingKeys) {
        if (!refresh) continue;
        return { ok: false, reason: "nokey", detail: "no published key matches the token's key id" };
      }
      if (err instanceof errors.JWTClaimValidationFailed || err instanceof errors.JWTExpired) {
        return { ok: false, reason: "claims", detail: err.message };
      }
      return { ok: false, reason: "signature", detail: (err as Error).message };
    }
  }
  return { ok: false, reason: "nokey", detail: "no published key matches the token's key id" };
}

function refusalFor(v: { reason: "keys" | "nokey" | "claims" | "signature"; detail: string }, what: string): ProofResult {
  if (v.reason === "keys") return refuse(503, "proof_keys_unavailable", `The keys for this ${what} could not be fetched right now, so it could not be checked. Try again shortly.`);
  if (v.reason === "nokey") return refuse(401, "proof_invalid", `The ${what} is signed with a key its issuer does not publish.`);
  if (v.reason === "claims") {
    if (/"exp"/.test(v.detail) || /expired/i.test(v.detail)) return refuse(401, "proof_expired", `The ${what} has expired. Get a fresh one.`);
    if (/"aud"/.test(v.detail)) return refuse(401, "proof_wrong_audience", `The ${what} is not meant for this mesh: its aud does not name this mesh's audience.`);
    if (/"nbf"/.test(v.detail) || /"iat"/.test(v.detail)) return refuse(401, "proof_not_yet_valid", `The ${what} is not valid yet.`);
    return refuse(401, "proof_invalid", `The ${what} was refused: ${v.detail}.`);
  }
  return refuse(401, "proof_invalid", `The ${what}'s signature does not verify.`);
}

/** The header checks every token proof gets before any key is fetched. */
function headerRefusal(token: string, what: string): ProofResult | null {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try { header = decodeProtectedHeader(token); } catch { return refuse(400, "proof_malformed", `The ${what} is not a JWT.`); }
  if (typeof header.alg !== "string" || !ALGS.has(header.alg)) {
    return refuse(401, "proof_alg_refused", `The ${what} uses ${String(header.alg)}, which this mesh does not accept. Only asymmetric algorithms are accepted; none and HMAC never are.`);
  }
  if (header.typ !== undefined && (typeof header.typ !== "string" || !TOKEN_TYPS.has(header.typ.toLowerCase()))) {
    return refuse(401, "proof_typ_refused", `The ${what} has typ ${String(header.typ)}, which is not an access token or a JWT-SVID.`);
  }
  if (header.crit !== undefined) return refuse(401, "proof_invalid", `The ${what} names critical header parameters this mesh does not understand.`);
  return null;
}

/** Check the binding an OAuth token's `cnf` asks for. */
async function bindingOf(
  payload: JWTPayload,
  token: string,
  anchorRequires: boolean,
  req: ProofRequest,
  replay: ReplayCache,
  now: number,
): Promise<{ ok: true; binding: VerifiedProof["binding"] } | ({ ok: false } & ProofRefusal)> {
  const cnf = payload.cnf as Record<string, unknown> | undefined;
  const jkt = cnf && typeof cnf.jkt === "string" ? cnf.jkt : null;
  const x5t = cnf && typeof cnf["x5t#S256"] === "string" ? (cnf["x5t#S256"] as string) : null;
  if (jkt && req.verifiedBinding?.jkt !== undefined) {
    if (req.verifiedBinding.jkt !== jkt) return { ok: false, status: 401, code: "dpop_key_mismatch", error: "The DPoP proof the bridge checked was made with a different key from the one the token is bound to." };
    return { ok: true, binding: { kind: "dpop", jkt } };
  }
  if (x5t && req.verifiedBinding?.x5t !== undefined) {
    if (req.verifiedBinding.x5t !== x5t) return { ok: false, status: 401, code: "mtls_cert_mismatch", error: "The client certificate the bridge saw is not the one the token is bound to." };
    return { ok: true, binding: { kind: "mtls", x5t } };
  }
  if (jkt) {
    if (!req.dpop) return { ok: false, status: 401, code: "dpop_required", error: "This token is bound to a key (cnf.jkt), so the request must carry a DPoP proof made with that key." };
    const d = await verifyDpopProof(req.dpop, { method: req.method, urls: req.urls, accessToken: token }, replay, now);
    if (!d.ok) return d;
    if (d.jkt !== jkt) return { ok: false, status: 401, code: "dpop_key_mismatch", error: "The DPoP proof was made with a different key from the one the token is bound to." };
    return { ok: true, binding: { kind: "dpop", jkt } };
  }
  if (x5t) {
    const leaf = req.clientCerts?.[0];
    if (!leaf) return { ok: false, status: 401, code: "mtls_required", error: "This token is bound to a client certificate (cnf.x5t#S256), so the request must come over mTLS with that certificate." };
    const have = sha256b64url(leaf.raw);
    if (have !== x5t) return { ok: false, status: 401, code: "mtls_cert_mismatch", error: "The client certificate is not the one the token is bound to." };
    return { ok: true, binding: { kind: "mtls", x5t } };
  }
  if (anchorRequires) return { ok: false, status: 401, code: "proof_binding_required", error: "This tenant requires tokens bound to a key the caller proves it holds: DPoP (RFC 9449) or a certificate-bound token (RFC 8705)." };
  return { ok: true, binding: null };
}

async function verifyOAuth(token: string, req: ProofRequest, deps: ProofDeps, now: number): Promise<ProofResult> {
  const head = headerRefusal(token, "token");
  if (head) return head;
  let claims: JWTPayload;
  try { claims = decodeJwt(token); } catch { return refuse(400, "proof_malformed", "The token is not a JWT."); }
  if (typeof claims.iss !== "string") return refuse(401, "proof_invalid", "The token names no issuer (iss).");
  const all = await deps.anchors();
  const trusted = oauthTrustFor(all, claims.iss);
  if (!trusted.length) return refuse(401, "proof_issuer_untrusted", "No tenant on this mesh trusts the issuer of this token.");
  const aud = audienceOf(claims);
  const fits = trusted.filter((t) => aud.includes(t.anchor.audience));
  if (!fits.length) return refuse(401, "proof_wrong_audience", "The token is not meant for this mesh: its aud names none of the audiences this mesh's tenants set for its issuer.");
  if (fits.length > 1) return refuse(401, "proof_ambiguous", "The token's aud names the audiences of more than one tenant, so it cannot say which tenant the agent joins.");
  const { tenant, anchor } = fits[0]!;
  const v = await verifyAgainst(token, (refresh) => deps.keys.oauthKeys(anchor, refresh), { issuer: anchor.issuer, audience: anchor.audience, now });
  if (!v.ok) return refusalFor(v, "token");
  const p = v.payload;
  if (typeof p.iat === "number" && p.iat > Math.floor(now / 1000) + SKEW_S) return refuse(401, "proof_not_yet_valid", "The token is dated in the future.");
  if (typeof p.sub !== "string" || !p.sub) return refuse(401, "proof_invalid", "The token names no subject (sub).");
  const workload = [p.client_id, p.azp, p.sub].find((x): x is string => typeof x === "string" && x.length > 0)!;
  const b = await bindingOf(p, token, anchor.require_binding, req, deps.replay, now);
  if (!b.ok) return b;
  return {
    ok: true,
    proof: { kind: "oauth", tenant, anchor, workload_id: workload, subject: p.sub, issuer: anchor.issuer, binding: b.binding, expires_at: expiresAt(p) },
  };
}

async function verifyJwtSvid(token: string, req: ProofRequest, deps: ProofDeps, now: number): Promise<ProofResult> {
  const head = headerRefusal(token, "JWT-SVID");
  if (head) return head;
  let claims: JWTPayload;
  try { claims = decodeJwt(token); } catch { return refuse(400, "proof_malformed", "The JWT-SVID is not a JWT."); }
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const td = spiffeTrustDomain(sub);
  if (!td) return refuse(401, "proof_invalid", "The JWT-SVID's sub is not a SPIFFE ID.");
  const match = spiffeTrustFor(await deps.anchors(), td);
  if (!match) return refuse(401, "proof_issuer_untrusted", `No tenant on this mesh trusts the SPIFFE trust domain ${td}.`);
  const { tenant, anchor } = match;
  if (anchor.require_mtls && !req.clientCerts?.length) return refuse(401, "mtls_required", `The trust domain ${td} enrolls only with an X.509-SVID presented over mTLS.`);
  const audience = anchor.audience ?? deps.defaultAudience;
  const v = await verifyAgainst(token, async (refresh) => jwtSvidKeys(await deps.keys.spiffeBundle(anchor, refresh)), { audience, now });
  if (!v.ok) return refusalFor(v, "JWT-SVID");
  return {
    ok: true,
    proof: { kind: "jwt-svid", tenant, anchor, workload_id: sub, subject: sub, trust_domain: td, binding: null, expires_at: expiresAt(v.payload) },
  };
}

/** The bundle's keys a JWT-SVID may be signed with: those marked for it, and those marked for nothing. */
export function jwtSvidKeys(bundle: JwkSet): JwkSet {
  // A JWKS reader takes only keys whose `use` is "sig" or unset, and a SPIFFE
  // bundle marks its keys "jwt-svid", so the mark is dropped once it has chosen them.
  return {
    keys: bundle.keys
      .filter((k) => k.use === undefined || k.use === "jwt-svid")
      .map((k) => { const { use: _use, ...rest } = k; return rest; }),
  };
}

/** The bundle's X.509 authorities. */
export function x509Authorities(bundle: JwkSet): X509Certificate[] {
  const out: X509Certificate[] = [];
  for (const k of bundle.keys) {
    if (k.use !== "x509-svid" || !Array.isArray(k.x5c)) continue;
    const der = k.x5c[0];
    if (typeof der !== "string") continue;
    try { out.push(new X509Certificate(Buffer.from(der, "base64"))); } catch { /* not a certificate */ }
  }
  return out;
}

/** The SPIFFE IDs in a certificate's URI SANs. */
export function spiffeIdsOf(cert: X509Certificate): string[] {
  const san = cert.subjectAltName ?? "";
  return san.split(/,\s*/).filter((s) => s.startsWith("URI:spiffe://")).map((s) => s.slice(4));
}

function inDate(cert: X509Certificate, now: number): boolean {
  return Date.parse(cert.validFrom) <= now + SKEW_S * 1000 && Date.parse(cert.validTo) >= now - SKEW_S * 1000;
}

async function verifyX509Svid(req: ProofRequest, deps: ProofDeps, now: number): Promise<ProofResult> {
  const chain = req.clientCerts ?? [];
  const leaf = chain[0];
  if (!leaf) return refuse(401, "mtls_required", "An X.509-SVID proof needs the request to come over mTLS with the SVID as the client certificate.");
  const ids = spiffeIdsOf(leaf);
  if (ids.length !== 1) return refuse(401, "proof_invalid", "The client certificate must carry exactly one SPIFFE ID in its URI SAN.");
  const id = ids[0]!;
  const td = spiffeTrustDomain(id);
  if (!td) return refuse(401, "proof_invalid", "The client certificate's SPIFFE ID is not well formed.");
  if (leaf.ca) return refuse(401, "proof_invalid", "The client certificate is a certificate authority, not an X.509-SVID.");
  const match = spiffeTrustFor(await deps.anchors(), td);
  if (!match) return refuse(401, "proof_issuer_untrusted", `No tenant on this mesh trusts the SPIFFE trust domain ${td}.`);
  let roots: X509Certificate[];
  try { roots = x509Authorities(await deps.keys.spiffeBundle(match.anchor)); } catch (err) {
    if (err instanceof KeysUnavailable) return refuse(503, "proof_keys_unavailable", "The trust domain's bundle could not be fetched right now, so the certificate could not be checked. Try again shortly.");
    throw err;
  }
  if (!roots.length) return refuse(401, "proof_invalid", `The trust bundle for ${td} has no X.509 authorities.`);
  // Walk from the leaf through the intermediates the client sent until a
  // certificate is issued by one of the bundle's authorities.
  let cur = leaf;
  const rest = chain.slice(1);
  for (let depth = 0; depth < 8; depth++) {
    if (!inDate(cur, now)) return refuse(401, "proof_expired", "A certificate in the client's chain is out of date.");
    const root = roots.find((r) => cur.checkIssued(r) && cur.verify(r.publicKey));
    if (root) {
      if (!inDate(root, now)) return refuse(401, "proof_expired", "The trust bundle's authority is out of date.");
      return {
        ok: true,
        proof: {
          kind: "x509-svid", tenant: match.tenant, anchor: match.anchor, workload_id: id, subject: id, trust_domain: td,
          binding: { kind: "mtls", x5t: sha256b64url(leaf.raw) }, expires_at: new Date(Date.parse(leaf.validTo)).toISOString(),
        },
      };
    }
    const next = rest.find((c) => c.ca && cur.checkIssued(c) && cur.verify(c.publicKey));
    if (!next) break;
    cur = next;
  }
  return refuse(401, "proof_invalid", `The client certificate does not chain to the trust bundle of ${td}.`);
}

/**
 * Check an outside proof. `input` is the request's `proof` member; an
 * X.509-SVID is read from the connection, so its `kind` is "x509-svid" and
 * it has no token.
 */
export async function verifyOutsideProof(input: ProofInput, req: ProofRequest, deps: ProofDeps): Promise<ProofResult> {
  const now = (deps.now ?? Date.now)();
  try {
    if (input.kind === "x509-svid") return await verifyX509Svid(req, deps, now);
    if (typeof input.token !== "string" || !input.token) return refuse(400, "proof_malformed", "proof.token is required.");
    if (input.token.length > 16_384) return refuse(400, "proof_malformed", "proof.token is too long.");
    if (input.kind === "oauth") return await verifyOAuth(input.token, req, deps, now);
    if (input.kind === "jwt-svid") return await verifyJwtSvid(input.token, req, deps, now);
    return refuse(400, "proof_kind_unknown", 'proof.kind must be "oauth", "jwt-svid" or "x509-svid".');
  } catch (err) {
    if (err instanceof KeysUnavailable) return refuse(503, "proof_keys_unavailable", "The keys for this proof could not be fetched right now, so it could not be checked. Try again shortly.");
    console.error(`[keychain] an outside proof could not be checked: ${(err as Error).message}`);
    return refuse(503, "proof_unchecked", "This proof could not be checked right now. Try again shortly.");
  }
}

export type { IdentitySource };

/** The identity source a verified proof gives an agent that enrolled with it. */
export function identitySourceOf(p: VerifiedProof, since: string, bridge?: string): IdentitySource {
  return {
    kind: bridge ? "bridged" : p.kind === "oauth" ? "oauth" : "spiffe",
    ...(p.issuer ? { issuer: p.issuer } : {}),
    ...(p.trust_domain ? { trust_domain: p.trust_domain } : {}),
    workload_id: p.workload_id,
    ...(bridge ? { bridge } : {}),
    since,
  };
}

/** The anchor's kind, for messages. */
export function anchorWhat(a: OAuthTrust | SpiffeTrust): string {
  return a.kind === "oauth" ? `issuer ${a.issuer}` : `trust domain ${a.trust_domain}`;
}
