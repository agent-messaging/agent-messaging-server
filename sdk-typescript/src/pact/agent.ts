/**
 * Helpers for an agent that serves a business under PACT Delegated on
 * AgentMesh (BRIDGE-A2A.md 14.6 and 14.8), and for anyone who is their own
 * personal-agent platform.
 *
 * A business's agent is handed each PACT turn in two places: `meta.pact` on
 * the envelope, and a context bag entry (docs/context-bag.md) with schema
 * PACT_TURN_SCHEMA, which a packaged agent's job finds in bag.json. Under a
 * person's permission the turn carries a delegation token. Check it with
 * `checkDelegation` before acting on anybody's account: what the turn says
 * about the person is only as good as the token's signature.
 *
 * What the agent did goes back in its output's `pact` member, which the
 * gateway signs into the receipt; what it lacked goes back as
 * `missing_scopes`, which the gateway turns into the step-up task. A packaged
 * agent whose reply is text sends the same object as JSON text
 * (`reportText`).
 *
 * WebCrypto and fetch only.
 */
import { b64urlEncode, decodeJwt, verifyWithJwks, type Jwk, type Jwks } from "./jose.js";
import { MAX_SKEW_S, parseScope, signPaJwt } from "./rules.js";

/** The context bag schema of a PACT turn. */
export const PACT_TURN_SCHEMA = "https://schemas.agentmesh.ai/pact-delegation/v1";

/** AgentMesh's A2A gateways, production and dev: the issuers a token is trusted from by default. */
export const AGENTMESH_GATEWAYS: readonly string[] = ["https://a2a.agentmesh.ai", "https://a2a.dev.agentmesh.ai"];

/** A PACT turn as the gateway hands it to the business's agent (BRIDGE-A2A.md 14.6). */
export interface PactTurn {
  /** The personal-agent platform's issuer. */
  pa: string;
  /** The person's id at that platform (pairwise; names nobody). */
  user: string;
  /** The conversation. */
  context: string;
  /** Only under the person's permission. Not to be trusted before checkDelegation. */
  delegation?: { grant_id: string; user: string; scopes: string[]; token: string };
}

function asTurn(v: unknown): PactTurn | null {
  const t = v as PactTurn | null;
  return t && typeof t === "object" && typeof t.pa === "string" && typeof t.user === "string" ? t : null;
}

/** The PACT turn on an envelope's meta, or null for a message that did not come through the gateway. */
export function pactTurnFromMeta(meta: Record<string, unknown> | null | undefined): PactTurn | null {
  return asTurn(meta?.pact);
}

/**
 * The PACT turn in a job's context bag: `bag` is bag.json as the adapter
 * wrote it, `read` reads one of its files (relative to the job folder).
 */
export async function pactTurnFromBag(
  bag: { entries?: Array<{ schema?: string; file?: string; why?: string }> } | null | undefined,
  read: (file: string) => Promise<string> | string,
): Promise<PactTurn | null> {
  const entry = (bag?.entries ?? []).find((e) => e?.schema === PACT_TURN_SCHEMA && typeof e.file === "string" && !e.why);
  if (!entry?.file || entry.file.includes("..")) return null;
  try {
    return asTurn(JSON.parse(String(await read(entry.file))));
  } catch {
    return null;
  }
}

/** A delegation the agent checked: who the person is at the business, and what they allowed. */
export interface CheckedDelegation {
  person: string;
  scopes: string[];
  grantId: string | null;
  interfaceUrl: string;
  expiresAt: number;
}

/**
 * Check a delegation token before acting on anybody's account (PACT 5.4,
 * 5.5): an access token (`typ: at+jwt`) whose audience is this Brand's
 * interface (exactly `interfaceUrl` when given, else an interface on one of
 * `gateways`), issued by that interface's authorization server, for the
 * personal agent that sent the turn (`client_id`), not expired, and signed by
 * a key at `{audience}/oauth/jwks.json` (or `keys` when the caller holds them).
 * Null when anything fails; nothing is thrown.
 */
export async function checkDelegation(
  token: string | null | undefined,
  opts: { paIssuer: string; interfaceUrl?: string; gateways?: readonly string[]; keys?: Jwks; fetchImpl?: typeof fetch; now?: number },
): Promise<CheckedDelegation | null> {
  const jwt = token ? decodeJwt(token) : null;
  if (!jwt) return null;
  if ((jwt.header.alg !== "ES256" && jwt.header.alg !== "RS256") || jwt.header.typ !== "at+jwt") return null;
  const c = jwt.claims;
  let aud: URL;
  try {
    aud = new URL(String(c.aud));
  } catch {
    return null;
  }
  const iface = `${aud.origin}${aud.pathname}`.replace(/\/+$/, "");
  if (opts.interfaceUrl) {
    if (iface !== opts.interfaceUrl.replace(/\/+$/, "")) return null;
  } else if (!(opts.gateways ?? AGENTMESH_GATEWAYS).includes(aud.origin) || !/^\/a2a\/[^/]+$/.test(aud.pathname)) {
    return null;
  }
  if (c.iss !== `${iface}/oauth` || c.client_id !== opts.paIssuer) return null;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof c.exp !== "number" || c.exp < now - MAX_SKEW_S) return null;
  if (typeof c.sub !== "string" || !c.sub || typeof c.scope !== "string") return null;
  let keys = opts.keys;
  if (!keys) {
    try {
      const res = await (opts.fetchImpl ?? fetch)(`${iface}/oauth/jwks.json`, { headers: { Accept: "application/json" }, redirect: "error" });
      if (!res.ok) return null;
      keys = (await res.json()) as Jwks;
    } catch {
      return null;
    }
  }
  if (!keys || !Array.isArray(keys.keys) || !(await verifyWithJwks(jwt, keys))) return null;
  return { person: c.sub, scopes: parseScope(c.scope), grantId: typeof c.grant_id === "string" ? c.grant_id : null, interfaceUrl: iface, expiresAt: c.exp };
}

/** The scopes a turn needs and the person has not allowed. */
export function missingScopes(held: Pick<CheckedDelegation, "scopes"> | null | undefined, needed: readonly string[]): string[] {
  const have = new Set(held?.scopes ?? []);
  return [...new Set(needed)].filter((s) => !have.has(s));
}

/** One thing the agent did, for the receipt. */
export interface ReportedAction {
  tool: string;
  argsHash?: string;
}

/** The output of a turn done on the person's account: the words, and what the receipt needs. */
export function pactReport(text: string, scopesUsed: readonly string[], actions: readonly ReportedAction[] = []): { text: string; pact: { scopes_used: string[]; actions: ReportedAction[] } } {
  return { text, pact: { scopes_used: [...new Set(scopesUsed)], actions: actions.map((a) => ({ tool: a.tool, ...(a.argsHash ? { argsHash: a.argsHash } : {}) })) } };
}

/** The output of a turn that needs more permission: the gateway answers it with the step-up task. */
export function pactNeedsPermission(text: string, missing: readonly string[]): { text: string; pact: { missing_scopes: string[] } } {
  return { text, pact: { missing_scopes: [...new Set(missing)] } };
}

/** The same object as JSON text, for an agent whose reply is text (a packaged agent). */
export function reportText(report: { text: string; pact: object }): string {
  return JSON.stringify(report);
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

/** A receipt's `argsHash`: base64url SHA-256 of the arguments as canonical JSON (a string as itself). */
export async function argsHash(args: unknown): Promise<string> {
  const text = typeof args === "string" ? args : canonical(args);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return b64urlEncode(new Uint8Array(digest));
}

/**
 * A signer for anyone who is their own personal-agent platform (PACT 3): a
 * fresh personal-agent JWT per request, for one person at one Provider.
 * Pass its `getToken` to sendPactMessage or the device flow helpers.
 */
export function paSigner(opts: { issuer: string; privateJwk: Jwk }): { tokenFor(sub: string, audience: string): () => Promise<string> } {
  return {
    tokenFor: (sub, audience) => () => signPaJwt(opts.privateJwk, { iss: opts.issuer, sub, aud: audience, now: Math.floor(Date.now() / 1000) }),
  };
}

