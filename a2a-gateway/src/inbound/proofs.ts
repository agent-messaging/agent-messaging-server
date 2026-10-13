/**
 * Outside proofs at the bridge (SPEC §4.15, step 13 of the
 * bring-your-own-identity plan): a caller that holds no mesh key presents the
 * identity its company gave it, an OAuth access token or a SPIFFE JWT-SVID,
 * on every call, and the bridge speaks for it on the mesh with one lasting
 * hosted identity.
 *
 *   Authorization: Bearer <token>             an unbound token or a JWT-SVID
 *   Authorization: DPoP <token>  + DPoP: …    a DPoP-bound token (RFC 9449)
 *
 * Two checks, split by who can make them:
 *
 *   - The DPoP proof is checked here, on every request, because it names this
 *     request's method and URL. Its key's thumbprint goes to the key chain.
 *   - The token itself is checked by the key chain (POST /v1/bridged-callers on
 *     the server, keychain/doors.ts), against the trust records only it holds,
 *     together with the thumbprint. The answer names the tenant, the caller's
 *     kind and its stable `caller_ref`, and is kept until the token expires or
 *     a minute passes, whichever is first, so a stop or a removed trust record
 *     reaches a bridged caller within a minute.
 *
 * A token never reaches a model: the MCP front takes it from the HTTP request
 * the MCP client makes, never as a tool argument.
 */
import { createHash } from "node:crypto";
import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader, EmbeddedJWK, jwtVerify } from "jose";
import { fromSeed } from "nkeys.js";

/** How a request presented its credential. */
export type PresentedCredential =
  | { type: "proof"; kind: "oauth" | "jwt-svid"; token: string; scheme: "Bearer" | "DPoP" }
  | { type: "key"; key: string }
  | { type: "none" };

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Read the Authorization header. A bearer value shaped like a JWT is an
 *  outside proof; anything else is an API key, as before. */
export function presentedCredential(authorization: string | undefined): PresentedCredential {
  if (!authorization) return { type: "none" };
  const m = /^(Bearer|DPoP)\s+(\S+)$/i.exec(authorization.trim());
  if (!m) return { type: "none" };
  const scheme = m[1]!.toLowerCase() === "dpop" ? "DPoP" : "Bearer";
  const value = m[2]!;
  if (scheme === "DPoP" || JWT.test(value)) {
    let sub = "";
    try { sub = String(decodeJwt(value).sub ?? ""); } catch { /* checked by the key chain */ }
    return { type: "proof", kind: sub.startsWith("spiffe://") ? "jwt-svid" : "oauth", token: value, scheme };
  }
  return { type: "key", key: value };
}

/** What the key chain answered about a caller. */
export interface BridgedCaller {
  tenant: string;
  caller_kind: "oauth" | "spiffe";
  caller_ref: string;
  workload_id: string;
  issuer?: string;
  trust_domain?: string;
  identity_source?: Record<string, unknown>;
  /** The DPoP key the token is bound to, when it is. */
  jkt: string | null;
  expires_at: string | null;
}

export class ProofRefused extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "ProofRefused";
  }
}

const DPOP_MAX_AGE_S = 300;
const SKEW_S = 60;
const ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];
const RECHECK_MS = 60_000;

/** base64url(SHA-256(text)). */
const sha256b64url = (s: string) => createHash("sha256").update(s).digest("base64url");

/** Check a DPoP proof for one request (RFC 9449 §4.3). Returns its key's thumbprint. */
export async function checkDpop(
  proof: string | undefined,
  req: { method: string; url: string; accessToken: string },
  seen: Map<string, number>,
  now = Date.now(),
): Promise<string> {
  const no = (why: string): never => { throw new ProofRefused(why, 401, "dpop_invalid"); };
  if (!proof) throw new ProofRefused("This token is bound to a key, so the request must carry a DPoP proof made with it (the DPoP header).", 401, "dpop_required");
  let header: ReturnType<typeof decodeProtectedHeader>;
  try { header = decodeProtectedHeader(proof); } catch { return no("The DPoP proof is not a JWT."); }
  if (header.typ !== "dpop+jwt" || typeof header.alg !== "string" || !ALGS.includes(header.alg)) return no('The DPoP proof must have typ "dpop+jwt" and an asymmetric algorithm.');
  const jwk = header.jwk as Record<string, unknown> | undefined;
  if (!jwk || ["d", "p", "q", "dp", "dq", "qi", "k"].some((k) => k in jwk)) return no("The DPoP proof must carry its public key, and only that, in jwk.");
  let payload: Record<string, unknown>;
  try { ({ payload } = await jwtVerify(proof, EmbeddedJWK, { typ: "dpop+jwt", algorithms: ALGS, currentDate: new Date(now) })); } catch {
    return no("The DPoP proof's signature does not verify with the key it carries.");
  }
  const u = new URL(req.url);
  const want = `${u.protocol}//${u.host}${u.pathname}`;
  let htu = "";
  try { const h = new URL(String(payload.htu)); htu = `${h.protocol}//${h.host}${h.pathname}`; } catch { /* refused below */ }
  if (payload.htm !== req.method || htu !== want) return no("The DPoP proof is for another method or address.");
  const iat = payload.iat;
  const nowS = Math.floor(now / 1000);
  if (typeof iat !== "number" || iat > nowS + SKEW_S || iat < nowS - DPOP_MAX_AGE_S) return no("The DPoP proof is too old, or dated in the future.");
  if (payload.ath !== sha256b64url(req.accessToken)) return no("The DPoP proof's ath is not the hash of the token it was sent with.");
  const jti = payload.jti;
  if (typeof jti !== "string" || !jti || jti.length > 256) return no("The DPoP proof needs a jti.");
  const jkt = await calculateJwkThumbprint(jwk as never, "sha256");
  const id = `${jkt}\n${jti}`;
  for (const [k, exp] of seen) { if (exp <= now) seen.delete(k); else break; }
  if (seen.has(id)) return no("This DPoP proof was used before. Make a fresh one for each request.");
  if (seen.size > 50_000) seen.delete(seen.keys().next().value!);
  seen.set(id, (iat + DPOP_MAX_AGE_S + SKEW_S) * 1000);
  return jkt;
}

export interface ProofGateConfig {
  /** The server's credential doors (its mesh API), e.g. http://server:3005. */
  coreUrl: string;
  /** The bridge node's seed: the node key that signs each question. */
  nodeSeed: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * The bridge's side of outside proofs: the DPoP check, the key chain's answer,
 * and how long that answer is kept.
 */
export class ProofGate {
  private seen = new Map<string, number>();
  private answers = new Map<string, { caller: BridgedCaller; until: number; callerId: string }>();
  private readonly node: ReturnType<typeof fromSeed>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private config: ProofGateConfig) {
    this.node = fromSeed(new TextEncoder().encode(config.nodeSeed));
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
  }

  get nodeId(): string {
    return this.node.getPublicKey();
  }

  /** The caller key a token stands for in the bridge's identity pool: the
   *  caller's lasting identity, one per issuer and subject or per SPIFFE ID.
   *  Read before the token is checked only to find the hosted key to ask
   *  about; nothing is kept for a token the key chain refuses. */
  callerKeyOf(p: { kind: "oauth" | "jwt-svid"; token: string }): string {
    let claims: Record<string, unknown> = {};
    try { claims = decodeJwt(p.token) as Record<string, unknown>; } catch { /* the key chain refuses it */ }
    if (p.kind === "jwt-svid") return `spiffe:${String(claims.sub ?? "")}`;
    return `oauth:${createHash("sha256").update(`${String(claims.iss ?? "")}\n${String(claims.sub ?? "")}`).digest("hex")}`;
  }

  /**
   * Check a presented proof for one request. `sign` signs with the caller's
   * hosted identity, which the bridge holds; `callerId` is its public key.
   * Throws ProofRefused with the key chain's reason.
   */
  async check(
    p: { kind: "oauth" | "jwt-svid"; token: string; scheme: "Bearer" | "DPoP" },
    req: { method: string; url: string; dpop?: string },
    callerId: string,
    sign: (message: string) => string,
  ): Promise<BridgedCaller> {
    let cnfJkt: string | null = null;
    try {
      const c = decodeJwt(p.token) as { cnf?: { jkt?: unknown } };
      cnfJkt = typeof c.cnf?.jkt === "string" ? c.cnf.jkt : null;
    } catch {
      throw new ProofRefused("The token is not a JWT.", 401, "proof_malformed");
    }
    // DPoP, on every request: the proof names this request.
    let jkt: string | null = null;
    if (cnfJkt || p.scheme === "DPoP" || req.dpop) {
      jkt = await checkDpop(req.dpop, { method: req.method, url: req.url, accessToken: p.token }, this.seen, this.now());
      if (cnfJkt && jkt !== cnfJkt) throw new ProofRefused("The DPoP proof was made with a different key from the one the token is bound to.", 401, "dpop_key_mismatch");
    }
    const tokenKey = createHash("sha256").update(p.token).digest("hex");
    const kept = this.answers.get(tokenKey);
    const now = this.now();
    if (kept && kept.until > now && kept.callerId === callerId) {
      if (kept.caller.jkt !== jkt) throw new ProofRefused("The DPoP proof was made with a different key from the one the token is bound to.", 401, "dpop_key_mismatch");
      return kept.caller;
    }
    const ts = Math.floor(now / 1000);
    const nodeId = this.node.getPublicKey();
    const body = {
      node_id: nodeId,
      ts,
      node_sig: Buffer.from(this.node.sign(new TextEncoder().encode(`mesh-bridge-caller-v1:${ts}:${nodeId}:${callerId}`))).toString("base64"),
      caller_id: callerId,
      caller_sig: sign(`mesh-bridge-hosted-v1:${ts}:${nodeId}:${callerId}`),
      proof: { kind: p.kind, token: p.token },
      ...(jkt ? { binding: { jkt } } : {}),
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.coreUrl.replace(/\/$/, "")}/v1/bridged-callers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new ProofRefused(`The mesh could not check this token right now: ${(err as Error).message}`, 503, "proof_unchecked");
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      this.answers.delete(tokenKey);
      throw new ProofRefused(String(data.error ?? `The mesh refused this token (HTTP ${res.status}).`), res.status === 503 ? 503 : res.status >= 500 ? 502 : res.status, String(data.code ?? "proof_refused"));
    }
    const caller: BridgedCaller = {
      tenant: String(data.tenant),
      caller_kind: data.caller_kind === "spiffe" ? "spiffe" : "oauth",
      caller_ref: String(data.caller_ref),
      workload_id: String(data.workload_id),
      ...(typeof data.issuer === "string" ? { issuer: data.issuer } : {}),
      ...(typeof data.trust_domain === "string" ? { trust_domain: data.trust_domain } : {}),
      ...(data.identity_source && typeof data.identity_source === "object" ? { identity_source: data.identity_source as Record<string, unknown> } : {}),
      jkt,
      expires_at: typeof data.expires_at === "string" ? data.expires_at : null,
    };
    const exp = caller.expires_at ? Date.parse(caller.expires_at) : now + RECHECK_MS;
    if (this.answers.size > 10_000) this.answers.delete(this.answers.keys().next().value!);
    this.answers.set(tokenKey, { caller, until: Math.min(exp, now + RECHECK_MS), callerId });
    return caller;
  }
}
