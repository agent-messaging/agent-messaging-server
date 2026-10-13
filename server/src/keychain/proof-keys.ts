/**
 * The public keys an outside proof is checked against (SPEC §4.14): an OAuth
 * issuer's keys, read from the `jwks_uri` its metadata names, and a SPIFFE
 * trust domain's bundle, given inline or read from its bundle endpoint.
 *
 * Keys are kept for a while (10 minutes, or what the response's
 * `cache-control: max-age` says, between 1 minute and 1 hour) and fetched
 * again early when a token names a key id the set does not have, at most once
 * every 30 seconds per set, so an issuer that rotates its keys is followed
 * without a fetch per token.
 *
 * Everything fails closed. Keys that cannot be fetched, metadata whose
 * `issuer` differs from the issuer asked about, and a document that is not a
 * key set all mean "no keys", and the door refuses the proof. Keys already
 * held keep working until they expire, so an issuer that is briefly down does
 * not stop enrollment at once.
 */
import type { JwkSet, OAuthTrust, SpiffeTrust } from "./trust-anchors.js";
import { isJwkSet } from "./trust-anchors.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const REFETCH_GAP_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_DOC_BYTES = 512 * 1024;

export class KeysUnavailable extends Error {}

export type Fetcher = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

interface Held {
  keys: JwkSet;
  fetchedAt: number;
  ttlMs: number;
}

/** Where the key sets come from. An interface so the proof checks can be tested with set keys. */
export interface ProofKeySource {
  /** The issuer's current key set. `refresh`: fetch again (a key id was not
   *  found), if the last fetch is old enough. */
  oauthKeys(anchor: OAuthTrust, refresh?: boolean): Promise<JwkSet>;
  /** The trust domain's bundle. */
  spiffeBundle(anchor: SpiffeTrust, refresh?: boolean): Promise<JwkSet>;
}

function ttlOf(cacheControl: string | null): number {
  const m = cacheControl ? /max-age=(\d+)/i.exec(cacheControl) : null;
  if (!m) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(m[1]) * 1000));
}

/** The metadata documents an issuer may publish (RFC 8414 §3, OpenID
 *  Discovery §4), in the order they are tried. */
export function metadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return [
    `${u.origin}${path}/.well-known/openid-configuration`,
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
  ];
}

export class HttpProofKeys implements ProofKeySource {
  private held = new Map<string, Held>();
  private inflight = new Map<string, Promise<Held>>();
  private jwksUris = new Map<string, string>();

  constructor(private fetcher: Fetcher = (url, init) => fetch(url, init as RequestInit) as never, private now: () => number = Date.now) {}

  async oauthKeys(anchor: OAuthTrust, refresh = false): Promise<JwkSet> {
    return (await this.get(`oauth\n${anchor.issuer}\n${anchor.jwks_uri ?? ""}`, refresh, async () => {
      const jwksUri = anchor.jwks_uri ?? (await this.jwksUriOf(anchor.issuer));
      return this.fetchSet(jwksUri);
    })).keys;
  }

  async spiffeBundle(anchor: SpiffeTrust, refresh = false): Promise<JwkSet> {
    if (anchor.bundle) return anchor.bundle;
    if (!anchor.bundle_endpoint) throw new KeysUnavailable(`trust domain ${anchor.trust_domain} has no bundle and no bundle endpoint`);
    const url = anchor.bundle_endpoint;
    return (await this.get(`spiffe\n${url}`, refresh, () => this.fetchSet(url))).keys;
  }

  private async get(cacheKey: string, refresh: boolean, load: () => Promise<Held>): Promise<Held> {
    const now = this.now();
    const have = this.held.get(cacheKey);
    const fresh = have && now - have.fetchedAt < have.ttlMs;
    const mayRefetch = !have || now - have.fetchedAt >= REFETCH_GAP_MS;
    if (have && (fresh && !refresh || refresh && !mayRefetch)) return have;
    let p = this.inflight.get(cacheKey);
    if (!p) {
      p = load().finally(() => this.inflight.delete(cacheKey));
      this.inflight.set(cacheKey, p);
    }
    try {
      const got = await p;
      this.held.set(cacheKey, got);
      return got;
    } catch (err) {
      // Keys held from an earlier fetch keep working until they expire.
      if (have && fresh) return have;
      throw err instanceof KeysUnavailable ? err : new KeysUnavailable((err as Error).message);
    }
  }

  private async jwksUriOf(issuer: string): Promise<string> {
    const known = this.jwksUris.get(issuer);
    if (known) return known;
    let last = "no metadata document answered";
    for (const url of metadataUrls(issuer)) {
      try {
        const { body } = await this.fetchJson(url);
        const doc = body as { issuer?: unknown; jwks_uri?: unknown };
        if (doc.issuer !== issuer) { last = `${url} names issuer ${String(doc.issuer)}, not ${issuer}`; continue; }
        if (typeof doc.jwks_uri !== "string") { last = `${url} names no jwks_uri`; continue; }
        this.jwksUris.set(issuer, doc.jwks_uri);
        return doc.jwks_uri;
      } catch (err) {
        last = (err as Error).message;
      }
    }
    throw new KeysUnavailable(`the keys of ${issuer} could not be found: ${last}`);
  }

  private async fetchSet(url: string): Promise<Held> {
    const { body, cacheControl } = await this.fetchJson(url);
    if (!isJwkSet(body)) throw new KeysUnavailable(`${url} is not a key set`);
    return { keys: body, fetchedAt: this.now(), ttlMs: ttlOf(cacheControl) };
  }

  private async fetchJson(url: string): Promise<{ body: unknown; cacheControl: string | null }> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await this.fetcher(url, { signal: ctl.signal, headers: { accept: "application/json" } });
      if (!r.ok) throw new KeysUnavailable(`${url} answered ${r.status}`);
      const text = await r.text();
      if (text.length > MAX_DOC_BYTES) throw new KeysUnavailable(`${url} answered more than ${MAX_DOC_BYTES} bytes`);
      return { body: JSON.parse(text) as unknown, cacheControl: r.headers.get("cache-control") };
    } catch (err) {
      throw err instanceof KeysUnavailable ? err : new KeysUnavailable(`${url}: ${(err as Error).message}`);
    } finally {
      clearTimeout(t);
    }
  }
}
