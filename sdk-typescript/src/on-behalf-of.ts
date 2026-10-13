/**
 * Acting for a person (Agent Messaging 0.8, §4.16): evidence that a request
 * is made on someone's behalf, carried in the envelope's `meta.on_behalf_of`
 * under the envelope's signature.
 *
 *   await mesh.request(to, "order", input, {
 *     on_behalf_of: { kind: "token-exchange", token, issuer: "https://login.example.com" },
 *   });
 *
 *   mesh.onRequest("order", async (input, ctx) => {
 *     const r = await verifyOnBehalfOf(ctx.envelope, { audience: mesh.agentId, trustedIssuers });
 *     if (r !== "verified") throw new RejectedError("I act only for people your identity provider vouches for.");
 *   });
 *
 * The answer is one of three, and never more than the token supports:
 *
 *   verified       the token is from an issuer the receiver trusts, signed by
 *                  one of the keys it was given for that issuer, unexpired,
 *                  and for this receiver (`aud`)
 *   refused        it is for another audience, expired, signed with a key the
 *                  trusted issuer did not give, or its `iss` is not the issuer
 *                  the member names
 *   unverifiable   there is none, it is malformed, or the issuer is not one the
 *                  receiver trusts: nothing here says it is false, and nothing
 *                  says it is true
 *
 * Nothing is fetched: the receiver hands over each trusted issuer's key set.
 * The mesh records the evidence and never issues it. The token is never part
 * of the text a model reads: the SDK's inbound frame carries the input only.
 */
import { decodeJwt, verifyWithJwks, type Jwks } from "./pact/jose.js";

export type OnBehalfOfKind = "token-exchange" | "id-jag" | "transaction-token" | "ciba" | "pact";

/** The `meta.on_behalf_of` member (§4.16). */
export interface OnBehalfOf {
  kind: OnBehalfOfKind;
  /** The JWT that is the evidence. */
  token: string;
  /** Its issuer, as the token's `iss` says. */
  issuer: string;
}

export type OnBehalfOfResult = "verified" | "refused" | "unverifiable";

export interface VerifyOnBehalfOfOptions {
  /** This receiver: what the token's `aud` must name (its agent id, or the
   *  resource identifier it declared). One or several. */
  audience: string | string[];
  /** The issuers this receiver trusts, each with its key set. */
  trustedIssuers: Array<{ issuer: string; jwks: Jwks }>;
  /** How far a clock may be off, in seconds. Default 60. */
  clockSkewSeconds?: number;
  now?: number;
}

const KINDS = new Set<OnBehalfOfKind>(["token-exchange", "id-jag", "transaction-token", "ciba", "pact"]);

/** Read `meta.on_behalf_of` off an envelope, or null when it has none of the right shape. */
export function onBehalfOfOf(envelope: { meta?: Record<string, unknown> | null } | null | undefined): OnBehalfOf | null {
  const m = envelope?.meta?.on_behalf_of as Partial<OnBehalfOf> | undefined;
  if (!m || typeof m !== "object" || typeof m.token !== "string" || typeof m.issuer !== "string" || !KINDS.has(m.kind as OnBehalfOfKind)) return null;
  return m as OnBehalfOf;
}

/** Check the evidence an envelope carries that it acts for a person (§4.16). */
export async function verifyOnBehalfOf(
  envelope: { meta?: Record<string, unknown> | null } | null | undefined,
  opts: VerifyOnBehalfOfOptions,
): Promise<OnBehalfOfResult> {
  const member = onBehalfOfOf(envelope);
  if (!member) return "unverifiable";
  const trusted = opts.trustedIssuers.find((t) => t.issuer === member.issuer);
  if (!trusted) return "unverifiable";
  const jwt = decodeJwt(member.token);
  if (!jwt) return "unverifiable";
  const alg = jwt.header.alg;
  if (alg === "none" || (typeof alg === "string" && alg.startsWith("HS"))) return "refused";
  if (alg !== "ES256" && alg !== "RS256") return "unverifiable";
  if (jwt.claims.iss !== member.issuer) return "refused";
  if (!(await verifyWithJwks(jwt, trusted.jwks))) return "refused";
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const skew = opts.clockSkewSeconds ?? 60;
  const exp = jwt.claims.exp;
  if (typeof exp !== "number" || exp + skew < now) return "refused";
  const nbf = jwt.claims.nbf;
  if (typeof nbf === "number" && nbf - skew > now) return "refused";
  const want = Array.isArray(opts.audience) ? opts.audience : [opts.audience];
  const aud = jwt.claims.aud;
  const auds = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud.filter((x): x is string => typeof x === "string") : [];
  if (!auds.some((a) => want.includes(a))) return "refused";
  return "verified";
}
