/**
 * The JOSE pieces PACT 1.0 needs (https://openpactprotocol.org/spec.md):
 * compact JWS and JWT over ES256 and RS256, JWK import, JWKS key choice and
 * RFC 7638 thumbprints. WebCrypto only (`globalThis.crypto.subtle`), so it
 * runs unchanged in Node 22, in a browser and in a worker; nothing here
 * imports a `node:` module or a library.
 *
 * A JWT or JWS that reaches these functions is untrusted bytes. Every reader
 * returns null rather than throwing on malformed input, so a caller decides
 * what a malformed token means (PACT: always 401).
 */

export type JwsAlg = "ES256" | "RS256";
export const PACT_ALGS: readonly JwsAlg[] = ["ES256", "RS256"];

/** A JSON Web Key, public or private. Only the members PACT uses are named. */
export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  d?: string;
  [k: string]: unknown;
}

export interface Jwks {
  keys: Jwk[];
}

// ─── base64url ──────────────────────────────────────────────────────

export function b64urlEncode(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null for anything that is not base64url. */
export function b64urlDecode(s: string): Uint8Array | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : s.length % 4 === 0 ? "" : null;
  if (pad === null) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function jsonPart(s: string): Record<string, unknown> | null {
  const bytes = b64urlDecode(s);
  if (!bytes) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ─── keys ───────────────────────────────────────────────────────────

/** The few WebCrypto calls used here, typed locally so this file compiles
 *  in a package whose TypeScript has no DOM library (the services). */
type Key = object;
interface Subtle {
  importKey(format: "jwk", key: object, alg: object, extractable: boolean, usages: string[]): Promise<Key>;
  sign(alg: object, key: Key, data: Uint8Array): Promise<ArrayBuffer>;
  verify(alg: object, key: Key, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
  digest(alg: string, data: Uint8Array): Promise<ArrayBuffer>;
  generateKey(alg: object, extractable: boolean, usages: string[]): Promise<{ privateKey: Key; publicKey: Key }>;
  exportKey(format: "jwk", key: Key): Promise<object>;
}

const subtle = (): Subtle => {
  const s = (globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) is not available here");
  return s as Subtle;
};

function algParams(alg: JwsAlg): { importAlg: object; signAlg: object } {
  if (alg === "ES256") return { importAlg: { name: "ECDSA", namedCurve: "P-256" }, signAlg: { name: "ECDSA", hash: "SHA-256" } };
  return { importAlg: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, signAlg: { name: "RSASSA-PKCS1-v1_5" } };
}

/** The algorithm a key is for: its `alg`, else what its type implies. */
export function algOfJwk(jwk: Jwk): JwsAlg | null {
  if (jwk.alg === "ES256" || jwk.alg === "RS256") return jwk.alg;
  if (jwk.alg !== undefined) return null;
  if (jwk.kty === "EC" && jwk.crv === "P-256") return "ES256";
  if (jwk.kty === "RSA") return "RS256";
  return null;
}

/** The public half of a key: every private member removed. */
export function publicJwk(jwk: Jwk): Jwk {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, oth: _oth, k: _k, key_ops: _ops, ext: _ext, ...pub } = jwk as Jwk & Record<string, unknown>;
  return pub as Jwk;
}

/** RFC 7638 thumbprint (SHA-256, base64url): the `kid` PACT keys use. */
export async function jwkThumbprint(jwk: Jwk): Promise<string> {
  let members: Record<string, unknown>;
  if (jwk.kty === "EC") members = { crv: jwk.crv, kty: "EC", x: jwk.x, y: jwk.y };
  else if (jwk.kty === "RSA") members = { e: jwk.e, kty: "RSA", n: jwk.n };
  else throw new Error(`no thumbprint rule for key type ${jwk.kty}`);
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(JSON.stringify(members)));
  return b64urlEncode(new Uint8Array(digest));
}

async function importKey(jwk: Jwk, alg: JwsAlg, usage: "sign" | "verify"): Promise<Key> {
  const { importAlg } = algParams(alg);
  const material = usage === "verify" ? publicJwk(jwk) : jwk;
  // WebCrypto rejects a JWK whose `alg` or `use` disagree with the import;
  // only the key material decides here.
  const { alg: _a, use: _u, kid: _k, ...bare } = material;
  return subtle().importKey("jwk", bare, importAlg, false, [usage]);
}

// ─── compact JWS ────────────────────────────────────────────────────

export interface DecodedJws {
  header: Record<string, unknown>;
  /** The payload's bytes, decoded from base64url. */
  payload: Uint8Array;
  signingInput: string;
  signature: Uint8Array;
}

/** A compact JWS in three parts, decoded. Null for anything else. */
export function decodeJws(token: string): DecodedJws | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = jsonPart(parts[0]);
  const payload = b64urlDecode(parts[1]);
  const signature = b64urlDecode(parts[2]);
  if (!header || !payload || !signature) return null;
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature };
}

/** Sign `payload` as a compact JWS. The header gets `alg` and, when the key
 *  has one, `kid`; `extraHeader` adds `typ` and the like. */
export async function signJws(payload: string | Uint8Array, privateJwk: Jwk, extraHeader: Record<string, unknown> = {}): Promise<string> {
  const alg = algOfJwk(privateJwk);
  if (!alg) throw new Error("the signing key is not ES256 or RS256");
  const header = { alg, ...(privateJwk.kid ? { kid: privateJwk.kid } : {}), ...extraHeader };
  const signingInput = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(payload)}`;
  const key = await importKey(privateJwk, alg, "sign");
  const sig = await subtle().sign(algParams(alg).signAlg, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Whether a decoded JWS verifies under `jwk`. The header's `alg` must be
 *  ES256 or RS256 and must be the key's; anything else is false. */
export async function verifyJws(jws: DecodedJws, jwk: Jwk): Promise<boolean> {
  const alg = jws.header.alg;
  if (alg !== "ES256" && alg !== "RS256") return false;
  if (algOfJwk(jwk) !== alg) return false;
  try {
    const key = await importKey(jwk, alg, "verify");
    // slice() gives a copy backed by a plain ArrayBuffer, which is what
    // WebCrypto's types ask for.
    return await subtle().verify(algParams(alg).signAlg, key, jws.signature.slice(), new TextEncoder().encode(jws.signingInput));
  } catch {
    return false;
  }
}

/** The keys in a JWKS a JWS could be signed by: the one named by `kid`, or,
 *  with no `kid`, every key of the header's algorithm. */
export function candidateKeys(jwks: Jwks, header: Record<string, unknown>): Jwk[] {
  const alg = header.alg;
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const usable = keys.filter((k) => k && typeof k === "object" && (k.use === undefined || k.use === "sig") && algOfJwk(k) === alg);
  if (typeof header.kid === "string") return usable.filter((k) => k.kid === header.kid);
  return usable;
}

/** Whether a JWS verifies against any candidate key in a JWKS. */
export async function verifyWithJwks(jws: DecodedJws, jwks: Jwks): Promise<boolean> {
  for (const key of candidateKeys(jwks, jws.header)) {
    if (await verifyJws(jws, key)) return true;
  }
  return false;
}

// ─── JWT ────────────────────────────────────────────────────────────

export interface DecodedJwt extends DecodedJws {
  claims: Record<string, unknown>;
}

/** A JWT (a JWS whose payload is a JSON object), decoded. Null otherwise. */
export function decodeJwt(token: string): DecodedJwt | null {
  const jws = decodeJws(token);
  if (!jws) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(jws.payload));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  return { ...jws, claims: claims as Record<string, unknown> };
}

/** Sign a JWT. `typ` defaults to JWT. */
export async function signJwt(claims: Record<string, unknown>, privateJwk: Jwk, extraHeader: Record<string, unknown> = {}): Promise<string> {
  return signJws(JSON.stringify(claims), privateJwk, { typ: "JWT", ...extraHeader });
}

// ─── key generation (for tests and for making a platform's key once) ─

/** A fresh ES256 key pair as JWKs, the public half with `kid` (its RFC 7638
 *  thumbprint), `alg` and `use` set. The private half carries the same. */
export async function generateEs256(): Promise<{ privateJwk: Jwk; publicJwk: Jwk }> {
  const pair = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const priv = (await subtle().exportKey("jwk", pair.privateKey)) as Jwk;
  const pub = publicJwk(priv);
  const kid = await jwkThumbprint(pub);
  const meta = { kid, alg: "ES256", use: "sig" };
  const { key_ops: _o, ext: _e, ...privBare } = priv as Jwk & Record<string, unknown>;
  return { privateJwk: { ...(privBare as Jwk), ...meta }, publicJwk: { ...pub, ...meta } };
}
