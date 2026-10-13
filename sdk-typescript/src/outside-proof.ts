/**
 * Enrolling with an identity your company already gave the agent (Agent
 * Messaging 0.8, §4.14): an OAuth access token from an issuer the mesh's
 * tenant trusts, or a SPIFFE JWT-SVID, in place of the operator's one-time
 * enrollment key.
 *
 *   const dpop = await generateDpopKey();            // when the issuer binds tokens to a key
 *   const token = await myIdentityProvider.token();   // its cnf.jkt is dpop.jkt
 *   const me = createAgentIdentity();
 *   const creds = await exchangeOutsideProof("https://mesh.example.com", me.publicKey,
 *     { kind: "oauth", token, dpopKey: dpop.privateJwk });
 *
 * The agent still makes its own key and signs every message with it; the
 * outside proof only decides which tenant it joins. Renewing a credential
 * enrolled this way needs a fresh proof of the same identity: pass
 * `credentialRenewal.proof` to `AgentMesh.connect`, or `proof` on a
 * `RenewalAgent`, and the SDK sends it with each renewal.
 *
 * A token never goes into anything the SDK hands a model: it travels only in
 * these HTTPS calls.
 */
import { jwkThumbprint, publicJwk, signJws, b64urlEncode, generateEs256, type Jwk } from "./pact/jose.js";
import type { BootstrapResult } from "./bootstrap.js";
import type { IdentitySource } from "./types/manifest.js";

/** An outside proof of the agent's identity. */
export interface OutsideProof {
  kind: "oauth" | "jwt-svid";
  /** The access token or JWT-SVID. */
  token: string;
  /** The private key the token is bound to (its `cnf.jkt`), as an ES256 JWK.
   *  When given, each request carries a DPoP proof made with it (RFC 9449). */
  dpopKey?: Jwk;
}

/** A source of fresh proofs, asked once per enrollment or renewal. */
export type OutsideProofSource = () => OutsideProof | Promise<OutsideProof>;

/** A key for DPoP: the private JWK to keep, the public JWK, and its RFC 7638
 *  thumbprint, which is what an issuer puts in a bound token's `cnf.jkt`. */
export async function generateDpopKey(): Promise<{ privateJwk: Jwk; publicJwk: Jwk; jkt: string }> {
  const { privateJwk, publicJwk: pub } = await generateEs256();
  return { privateJwk, publicJwk: pub, jkt: await jwkThumbprint(publicJwk(pub)) };
}

/** base64url(SHA-256(token)), the DPoP proof's `ath`. */
async function tokenHash(token: string): Promise<string> {
  const digest = await (globalThis.crypto as unknown as { subtle: { digest(a: string, d: Uint8Array): Promise<ArrayBuffer> } }).subtle
    .digest("SHA-256", new TextEncoder().encode(token));
  return b64urlEncode(new Uint8Array(digest));
}

/**
 * A DPoP proof (RFC 9449 §4.2) for one request: signed with `privateJwk`,
 * naming the method and URL, fresh, with a new `jti`, and carrying the hash of
 * the token it goes with. Make a new one for every request.
 */
export async function createDpopProof(opts: { method: string; url: string; accessToken?: string; privateJwk: Jwk; now?: number }): Promise<string> {
  const { kid: _kid, alg: _alg, use: _use, ...key } = opts.privateJwk;
  const { kid: _k2, alg: _a2, use: _u2, ...jwk } = publicJwk(opts.privateJwk);
  const u = new URL(opts.url);
  const claims = {
    jti: crypto.randomUUID(),
    htm: opts.method.toUpperCase(),
    htu: `${u.protocol}//${u.host}${u.pathname}`,
    iat: Math.floor((opts.now ?? Date.now()) / 1000),
    ...(opts.accessToken !== undefined ? { ath: await tokenHash(opts.accessToken) } : {}),
  };
  return signJws(JSON.stringify(claims), key as Jwk, { typ: "dpop+jwt", jwk });
}

/** What the bootstrap door answers an enrollment by outside proof. */
export interface OutsideProofResult extends BootstrapResult {
  /** Where the agent's identity came from, as the mesh recorded it (§9.7). */
  identity_source: IdentitySource;
  /** The agent key that held this outside identity before, now revoked
   *  (one outside identity, one agent). */
  replaced?: string;
}

/** The mesh refused an outside proof: `code` says why (proof_wrong_audience,
 *  proof_expired, dpop_required, proof_issuer_untrusted, and the rest). */
export class ProofRefusedError extends Error {
  /** `reason` is the specification's word for it (§4.14): issuer_not_trusted,
   *  proof_invalid, proof_expired, audience_mismatch, algorithm_refused,
   *  binding_required or binding_mismatch. */
  constructor(message: string, readonly status: number, readonly code: string | null, readonly reason: string | null = null) {
    super(message);
    this.name = "ProofRefusedError";
  }
}

/** The request body members a proof adds: `proof`, and `dpop` when bound. */
export async function proofMembers(p: OutsideProof, method: string, url: string): Promise<{ proof: { kind: string; token: string }; dpop?: string }> {
  return {
    proof: { kind: p.kind, token: p.token },
    ...(p.dpopKey ? { dpop: await createDpopProof({ method, url, accessToken: p.token, privateJwk: p.dpopKey }) } : {}),
  };
}

/**
 * Enroll an agent with an outside proof (`POST /v1/bootstrap` with `proof`).
 * `apiBase` is the mesh's address, the one its operator gives out. Persist the
 * answer as you would an enrollment key's. Throws ProofRefusedError when the
 * mesh refuses the proof.
 */
export async function exchangeOutsideProof(
  apiBase: string,
  agentPublicKey: string,
  proof: OutsideProof,
  fetchImpl: typeof fetch = fetch,
): Promise<OutsideProofResult> {
  const url = `${apiBase.replace(/\/$/, "")}/v1/bootstrap`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: agentPublicKey, ...(await proofMembers(proof, "POST", url)) }),
  });
  const data = (await res.json().catch(() => ({}))) as OutsideProofResult & { error?: string; code?: string; details?: { reason?: string } };
  if (!res.ok) {
    throw new ProofRefusedError(data.error ?? `enrollment failed: HTTP ${res.status}`, res.status, typeof data.code === "string" ? data.code : null, typeof data.details?.reason === "string" ? data.details.reason : null);
  }
  return data;
}
