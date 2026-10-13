/**
 * PACT 1.0's rules as pure functions (https://openpactprotocol.org/spec.md):
 * the personal-agent JWT's claims (section 3.2), the delegation token's
 * (sections 5.4 and 5.5), and receipts (section 5.6). The fixtures
 * conformance/pact-identity.json and conformance/pact-delegated.json are the
 * authority for every check here.
 */
import { decodeJwt, decodeJws, signJws, verifyJws, verifyWithJwks, candidateKeys, type DecodedJwt, type Jwk, type Jwks } from "./jose.js";

// ─── protocol constants ─────────────────────────────────────────────

export const PACT_VERSION = "1.0";
export const DELEGATION_HEADER = "X-A2A-User-Delegation";
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const REFRESH_TOKEN_GRANT_TYPE = "refresh_token";
export const PACT_METADATA = {
  missingScopes: "pact.missingScopes",
  verificationUriComplete: "pact.verificationUriComplete",
  receipt: "pact.receipt",
} as const;
/** The `WWW-Authenticate` value on every authentication failure (section 3.4). */
export const PA_CHALLENGE = 'Bearer realm="a2a"';
/** And on a bad delegation token (section 5.5). */
export const DELEGATION_CHALLENGE = 'Bearer realm="a2a", error="invalid_token"';
/** Clock skew a Provider allows, and the longest a PA JWT may live (3.2). */
export const MAX_SKEW_S = 30;
export const MAX_PA_JWT_LIFE_S = 300;
/** What AgentMesh's personal agent signs for: the reference signer's 120 s. */
export const PA_JWT_LIFE_S = 120;
/** A delegation token's longest life (section 5.4: SHOULD be at most 1 h). */
export const MAX_DELEGATION_LIFE_S = 3600;

// ─── the personal-agent JWT (section 3.2) ───────────────────────────

/** Why a personal-agent JWT was refused, for the Provider's own log. The
 *  caller always sees the same plain 401. */
export type PaRefusal =
  | "no_token"
  | "malformed"
  | "alg"
  | "iss"
  | "unknown_platform"
  | "disabled_platform"
  | "signature"
  | "aud"
  | "sub"
  | "iat"
  | "exp";

export interface PaClaimRules {
  /** The Provider's audience: one string. */
  audience: string;
  /** Seconds since the epoch. */
  now: number;
  skew?: number;
}

/**
 * Section 3.2's claim checks, after the signature: `aud` is the audience as
 * one string; `sub` is a non-empty string; `iat` is present and at most 30 s
 * ahead; `exp` is present, at most 300 s after `iat`, and not more than 30 s
 * past. `iss` is matched by the caller against its registrations, before the
 * signature. Null means the claims pass.
 */
export function checkPaClaims(claims: Record<string, unknown>, rules: PaClaimRules): PaRefusal | null {
  const skew = rules.skew ?? MAX_SKEW_S;
  if (typeof claims.aud !== "string" || claims.aud !== rules.audience) return "aud";
  if (typeof claims.sub !== "string" || claims.sub.length === 0) return "sub";
  if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) return "iat";
  if (claims.iat > rules.now + skew) return "iat";
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return "exp";
  if (claims.exp - claims.iat > MAX_PA_JWT_LIFE_S) return "exp";
  if (claims.exp < rules.now - skew) return "exp";
  return null;
}

/** A registered personal-agent platform as a Provider sees it (3.1). */
export interface PaRegistration {
  issuer: string;
  jwksUri: string;
  enabled: boolean;
  name?: string;
}

export interface VerifiedPa {
  iss: string;
  sub: string;
  registration: PaRegistration;
  claims: Record<string, unknown>;
}

/**
 * The whole of section 3.2 for one bearer token: decode, `alg`, the issuer's
 * registration, the signature against its JWKS (refetched once on a miss),
 * then the claims. `{ok}` or `{refused}` with the reason.
 */
export async function verifyPaJwt(
  token: string | undefined,
  deps: {
    audience: string;
    now: number;
    registrationFor(issuer: string): PaRegistration | undefined | Promise<PaRegistration | undefined>;
    /** The platform's JWKS; `fresh` asks for a refetch past the cache. */
    jwksFor(registration: PaRegistration, fresh: boolean): Promise<Jwks | null>;
  },
): Promise<{ ok: VerifiedPa } | { refused: PaRefusal }> {
  if (!token) return { refused: "no_token" };
  const jwt = decodeJwt(token);
  if (!jwt) return { refused: "malformed" };
  if (jwt.header.alg !== "ES256" && jwt.header.alg !== "RS256") return { refused: "alg" };
  const iss = jwt.claims.iss;
  if (typeof iss !== "string" || !iss) return { refused: "iss" };
  const registration = await deps.registrationFor(iss);
  if (!registration) return { refused: "unknown_platform" };
  if (!registration.enabled) return { refused: "disabled_platform" };
  if (!(await signatureVerifies(jwt, registration, deps.jwksFor))) return { refused: "signature" };
  const bad = checkPaClaims(jwt.claims, { audience: deps.audience, now: deps.now });
  if (bad) return { refused: bad };
  return { ok: { iss, sub: jwt.claims.sub as string, registration, claims: jwt.claims } };
}

async function signatureVerifies(
  jwt: DecodedJwt,
  registration: PaRegistration,
  jwksFor: (r: PaRegistration, fresh: boolean) => Promise<Jwks | null>,
): Promise<boolean> {
  const cached = await jwksFor(registration, false);
  if (cached && candidateKeys(cached, jwt.header).length && (await verifyWithJwks(jwt, cached))) return true;
  // An unknown kid (or no key of the right type) may be a rotation: fetch once more.
  if (cached && candidateKeys(cached, jwt.header).length) return false;
  const fresh = await jwksFor(registration, true);
  return !!fresh && (await verifyWithJwks(jwt, fresh));
}

/** Sign a personal-agent JWT (the PA side of 3.2): `iss`, `sub`, `aud`,
 *  `iat`, `exp` (120 s by default, never more than 300). */
export async function signPaJwt(
  privateJwk: Jwk,
  claims: { iss: string; sub: string; aud: string; now?: number; lifeSeconds?: number; jti?: string },
): Promise<string> {
  const iat = Math.floor(claims.now ?? Date.now() / 1000);
  const life = Math.min(claims.lifeSeconds ?? PA_JWT_LIFE_S, MAX_PA_JWT_LIFE_S);
  return signJws(
    JSON.stringify({ iss: claims.iss, sub: claims.sub, aud: claims.aud, iat, exp: iat + life, ...(claims.jti ? { jti: claims.jti } : {}) }),
    privateJwk,
    { typ: "JWT" },
  );
}

// ─── the delegation token (sections 5.4, 5.5) ───────────────────────

export interface DelegationClaims {
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: string;
  grant_id: string;
  iat: number;
  exp: number;
}

export type DelegationRefusal = "malformed" | "alg" | "signature" | "iss" | "aud" | "exp" | "client_id" | "claims" | "grant";

/**
 * Section 5.5 (2) for one delegation token: the signature against the
 * Provider's keys, `iss`, `aud` (one Brand's interface URL), `exp`, and
 * `client_id` equal to the personal-agent JWT's `iss`. Whether the grant is
 * live is the caller's (`grantLive`), because only the Provider holds grants.
 */
export async function verifyDelegationToken(
  token: string | undefined,
  rules: {
    keys: Jwks;
    issuer: string;
    audience: string;
    paIssuer: string;
    now: number;
    skew?: number;
    grantLive?(grantId: string, claims: DelegationClaims): boolean | Promise<boolean>;
  },
): Promise<{ ok: DelegationClaims } | { refused: DelegationRefusal }> {
  if (!token) return { refused: "malformed" };
  const jwt = decodeJwt(token);
  if (!jwt) return { refused: "malformed" };
  if (jwt.header.alg !== "ES256" && jwt.header.alg !== "RS256") return { refused: "alg" };
  if (!(await verifyWithJwks(jwt, rules.keys))) return { refused: "signature" };
  const c = jwt.claims;
  const skew = rules.skew ?? MAX_SKEW_S;
  if (c.iss !== rules.issuer) return { refused: "iss" };
  if (typeof c.aud !== "string" || c.aud !== rules.audience) return { refused: "aud" };
  if (typeof c.exp !== "number" || c.exp < rules.now - skew) return { refused: "exp" };
  if (c.client_id !== rules.paIssuer) return { refused: "client_id" };
  if (typeof c.sub !== "string" || !c.sub || typeof c.scope !== "string" || typeof c.grant_id !== "string" || !c.grant_id || typeof c.iat !== "number") {
    return { refused: "claims" };
  }
  const claims = c as unknown as DelegationClaims;
  if (rules.grantLive && !(await rules.grantLive(claims.grant_id, claims))) return { refused: "grant" };
  return { ok: claims };
}

/** Space-separated scope ids, as a list without blanks or repeats. */
export function parseScope(scope: string | undefined | null): string[] {
  return [...new Set(String(scope ?? "").split(/\s+/).filter(Boolean))];
}

export function formatScope(scopes: readonly string[]): string {
  return [...new Set(scopes)].join(" ");
}

// ─── receipts (section 5.6) ─────────────────────────────────────────

export interface ReceiptAction {
  tool: string;
  argsHash?: string;
}

export interface ReceiptClaims {
  grantId: string;
  user: string;
  pa: string;
  brand: string;
  scopesUsed: string[];
  actions: ReceiptAction[];
  ts: string;
}

export interface Receipt {
  jws: string;
  claims: ReceiptClaims;
}

/** Sign a receipt: `jws` is the compact JWS of `claims`. */
export async function signReceipt(claims: ReceiptClaims, privateJwk: Jwk): Promise<Receipt> {
  const clean: ReceiptClaims = {
    grantId: claims.grantId,
    user: claims.user,
    pa: claims.pa,
    brand: claims.brand,
    scopesUsed: [...claims.scopesUsed],
    actions: claims.actions.map((a) => ({ tool: a.tool, ...(a.argsHash ? { argsHash: a.argsHash } : {}) })),
    ts: claims.ts,
  };
  return { jws: await signJws(JSON.stringify(clean), privateJwk, { typ: "pact-receipt+jws" }), claims: clean };
}

/** Same JSON value, whatever the key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export type ReceiptCheck = { ok: ReceiptClaims } | { refused: "malformed" | "signature" | "claims_differ" | "expected" };

/**
 * A personal agent's check of a receipt (5.6, SHOULD): the JWS verifies
 * against the Brand's keys, its payload equals `claims`, and any `expected`
 * values match.
 */
export async function verifyReceipt(
  receipt: Receipt | undefined | null,
  keys: Jwks,
  expected: Partial<Pick<ReceiptClaims, "grantId" | "user" | "pa" | "brand">> = {},
): Promise<ReceiptCheck> {
  if (!receipt || typeof receipt.jws !== "string" || !receipt.claims) return { refused: "malformed" };
  const jws = decodeJws(receipt.jws);
  if (!jws) return { refused: "malformed" };
  if (!(await verifyWithJwks(jws, keys))) return { refused: "signature" };
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(jws.payload));
  } catch {
    return { refused: "malformed" };
  }
  if (!sameJson(payload, receipt.claims)) return { refused: "claims_differ" };
  for (const [k, v] of Object.entries(expected)) {
    if (v !== undefined && (receipt.claims as unknown as Record<string, unknown>)[k] !== v) return { refused: "expected" };
  }
  return { ok: receipt.claims };
}

export { verifyJws };
