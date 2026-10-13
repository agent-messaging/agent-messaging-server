/**
 * Trust records: the identity systems each tenant trusts (SPEC §4.14, step 10
 * of the bring-your-own-identity plan).
 *
 * A tenant that gives its agents identities in its own system lists that
 * system here, and an agent can then enroll with a proof from it instead of
 * the operator's one-time key. Two kinds:
 *
 *   oauth   an OAuth authorization server or OpenID provider, by its issuer
 *           URL and the audience its tokens must carry for this mesh. Its
 *           keys come from the `jwks_uri` its metadata names.
 *   spiffe  a SPIFFE trust domain, with its trust bundle given inline or
 *           fetched from a bundle endpoint.
 *
 * One bucket, `mesh_trust_anchors`: tenant id → { anchors: TrustRecord[] }.
 * Nothing here is secret: issuers, audiences, trust domains and public keys.
 *
 * Each issuer (with its audience) and each trust domain belongs to one tenant
 * at most, so a proof always names exactly one tenant and enrollment never
 * has to guess. A mesh with no trust records behaves exactly as before: the
 * bootstrap door then refuses every outside proof.
 */
import { createHash } from "node:crypto";
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";

export const TRUST_ANCHORS_BUCKET = "mesh_trust_anchors";

/** A public key set, as JWKS documents and SPIFFE trust bundles carry them. */
export interface JwkSet {
  keys: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface OAuthTrust {
  kind: "oauth";
  id: string;
  /** The issuer URL, exactly as tokens carry it in `iss`. */
  issuer: string;
  /** What a token must carry in `aud` to be meant for this mesh. */
  audience: string;
  /** A token must be bound to a key the caller proves it holds: DPoP
   *  (RFC 9449) or a certificate-bound token (RFC 8705). */
  require_binding: boolean;
  /** Where the issuer's keys are, when its metadata cannot be fetched. Absent:
   *  read from the issuer's metadata. */
  jwks_uri?: string;
  added_at: string;
  added_by: string;
}

export interface SpiffeTrust {
  kind: "spiffe";
  id: string;
  /** The SPIFFE trust domain, `example.com` in `spiffe://example.com/...`. */
  trust_domain: string;
  /** Where the trust bundle is published (the SPIFFE bundle endpoint, web
   *  PKI profile). One of `bundle_endpoint` and `bundle` is set. */
  bundle_endpoint?: string;
  /** The trust bundle itself: a JWKS whose keys carry `use: "jwt-svid"` or
   *  `use: "x509-svid"`. */
  bundle?: JwkSet;
  /** Only an X.509-SVID presented over mTLS enrolls; a JWT-SVID alone does not. */
  require_mtls: boolean;
  /** The audience a JWT-SVID must carry. Absent: this mesh's own
   *  (MESH_PROOF_AUDIENCE, else its public URL). */
  audience?: string;
  added_at: string;
  added_by: string;
}

export type TrustRecord = OAuthTrust | SpiffeTrust;

/** What a trust record answers a lookup with: the record and its tenant. */
export interface TrustMatch<T extends TrustRecord = TrustRecord> {
  tenant: string;
  anchor: T;
}

const TRUST_DOMAIN = /^[a-z0-9._-]{1,255}$/;

/** Whether a URL may name an issuer or a key endpoint here: https, or http
 *  on this machine or when MESH_TRUST_ALLOW_HTTP=on (tests and the examples,
 *  whose issuer runs beside the server). */
export function acceptableUrl(raw: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  if ((env.MESH_TRUST_ALLOW_HTTP ?? "").trim().toLowerCase() === "on") return true;
  return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
}

/** The id a record gets when the operator names none: its kind and a short
 *  digest of what it trusts. */
export function trustIdOf(kind: "oauth" | "spiffe", what: string): string {
  return `${kind}-${createHash("sha256").update(what).digest("hex").slice(0, 10)}`;
}

/**
 * Read a trust record from a request body. Returns the record, or a sentence
 * saying what is wrong.
 */
export function parseTrustRecord(
  body: Record<string, unknown>,
  by: string,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): { ok: true; record: TrustRecord } | { ok: false; error: string } {
  const kind = body.kind;
  const at = now.toISOString();
  const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : null;
  if (id !== null && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) return { ok: false, error: "id must be letters, digits, dots, dashes or underscores, at most 64." };
  if (kind === "oauth") {
    const issuer = typeof body.issuer === "string" ? body.issuer.trim() : "";
    const audience = typeof body.audience === "string" ? body.audience.trim() : "";
    if (!issuer || !acceptableUrl(issuer, env)) return { ok: false, error: "issuer must be the issuer's https URL, exactly as its tokens carry it in iss." };
    if (!audience) return { ok: false, error: "audience is required: the value a token must carry in aud to be meant for this mesh." };
    const jwks = body.jwks_uri;
    if (jwks !== undefined && (typeof jwks !== "string" || !acceptableUrl(jwks, env))) return { ok: false, error: "jwks_uri must be an https URL." };
    if (body.require_binding !== undefined && typeof body.require_binding !== "boolean") return { ok: false, error: "require_binding must be true or false." };
    return {
      ok: true,
      record: {
        kind: "oauth", id: id ?? trustIdOf("oauth", `${issuer}\n${audience}`), issuer, audience,
        require_binding: body.require_binding === true,
        ...(typeof jwks === "string" ? { jwks_uri: jwks } : {}),
        added_at: at, added_by: by,
      },
    };
  }
  if (kind === "spiffe") {
    const td = typeof body.trust_domain === "string" ? body.trust_domain.trim() : "";
    if (!TRUST_DOMAIN.test(td)) return { ok: false, error: "trust_domain must be a SPIFFE trust domain: lowercase letters, digits, dots, dashes and underscores." };
    const endpoint = body.bundle_endpoint;
    const bundle = body.bundle;
    if (endpoint === undefined && bundle === undefined) return { ok: false, error: "Give the trust bundle (bundle) or where it is published (bundle_endpoint)." };
    if (endpoint !== undefined && bundle !== undefined) return { ok: false, error: "Give bundle or bundle_endpoint, not both." };
    if (endpoint !== undefined && (typeof endpoint !== "string" || !acceptableUrl(endpoint, env))) return { ok: false, error: "bundle_endpoint must be an https URL." };
    if (bundle !== undefined && !isJwkSet(bundle)) return { ok: false, error: "bundle must be a SPIFFE trust bundle: a JSON object with a keys array." };
    if (body.require_mtls !== undefined && typeof body.require_mtls !== "boolean") return { ok: false, error: "require_mtls must be true or false." };
    const audience = body.audience;
    if (audience !== undefined && (typeof audience !== "string" || !audience.trim())) return { ok: false, error: "audience, when given, must be a non-empty string." };
    return {
      ok: true,
      record: {
        kind: "spiffe", id: id ?? trustIdOf("spiffe", td), trust_domain: td,
        ...(typeof endpoint === "string" ? { bundle_endpoint: endpoint } : {}),
        ...(bundle !== undefined ? { bundle: bundle as JwkSet } : {}),
        require_mtls: body.require_mtls === true,
        ...(typeof audience === "string" ? { audience: audience.trim() } : {}),
        added_at: at, added_by: by,
      },
    };
  }
  return { ok: false, error: 'kind must be "oauth" or "spiffe".' };
}

export function isJwkSet(v: unknown): v is JwkSet {
  return !!v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as { keys?: unknown }).keys)
    && (v as JwkSet).keys.every((k) => !!k && typeof k === "object" && !Array.isArray(k));
}

/** What a record looks like when it is listed: the bundle's keys counted, not printed. */
export function describeTrust(r: TrustRecord): Record<string, unknown> {
  if (r.kind === "oauth") return { ...r };
  const { bundle, ...rest } = r;
  return { ...rest, ...(bundle ? { bundle_keys: bundle.keys.length } : {}) };
}

/** Where the trust records are kept. An interface so the rules can be tested without a broker. */
export interface TrustAnchorList {
  list(tenant: string): Promise<TrustRecord[]>;
  /** Every tenant's records. Throws when the bucket cannot be read completely. */
  all(): Promise<Map<string, TrustRecord[]>>;
  /** Add one. Refuses (with the reason) a record whose issuer and audience, or
   *  trust domain, another tenant already trusts, or whose id is taken. */
  add(tenant: string, record: TrustRecord): Promise<{ ok: true } | { ok: false; error: string; status: number }>;
  /** Remove one by id; false when the tenant had no such record. */
  remove(tenant: string, id: string): Promise<boolean>;
}

/** Whether two records claim the same thing: the same issuer and audience, or the same trust domain. */
export function sameClaim(a: TrustRecord, b: TrustRecord): boolean {
  if (a.kind === "oauth" && b.kind === "oauth") return a.issuer === b.issuer && a.audience === b.audience;
  if (a.kind === "spiffe" && b.kind === "spiffe") return a.trust_domain === b.trust_domain;
  return false;
}

/** The add rule, shared by the stores: unique id within the tenant, and one
 *  tenant per issuer-and-audience or trust domain across the mesh. */
export function addRefusal(all: Map<string, TrustRecord[]>, tenant: string, record: TrustRecord): { error: string; status: number } | null {
  for (const [t, list] of all) {
    for (const r of list) {
      if (t === tenant && r.id === record.id) return { status: 409, error: `This tenant already has a trust record with the id ${record.id}.` };
      if (sameClaim(r, record)) {
        return t === tenant
          ? { status: 409, error: `This tenant already trusts that ${record.kind === "oauth" ? "issuer and audience" : "trust domain"} (record ${r.id}).` }
          : { status: 409, error: `Another tenant already trusts that ${record.kind === "oauth" ? "issuer and audience" : "trust domain"}. A proof has to name one tenant, so each can be trusted by one tenant only.` };
      }
    }
  }
  return null;
}

export class TrustAnchorStore implements TrustAnchorList {
  private kv: KeyedStore;

  constructor(kv: KeyedLike, js?: StorageLike) {
    this.kv = keyedOf(kv, js);
  }

  static async create(js: StorageLike): Promise<TrustAnchorStore> {
    // History 1: the current list is the whole answer. The name is written
    // out because closure-registry.test.ts finds buckets by reading these calls.
    return new TrustAnchorStore(await storageOf(js).keyed("mesh_trust_anchors"));
  }

  async list(tenant: string): Promise<TrustRecord[]> {
    const e = await this.kv.get(tenant);
    if (!e?.value.length) return [];
    return e.json<{ anchors?: TrustRecord[] }>().anchors ?? [];
  }

  async all(): Promise<Map<string, TrustRecord[]>> {
    const snap = await this.kv.list();
    const out = new Map<string, TrustRecord[]>();
    for (const [k, e] of snap.entries) {
      try { out.set(k, e.json<{ anchors?: TrustRecord[] }>().anchors ?? []); } catch { console.warn(`[trust] an unreadable trust record was skipped (${k})`); }
    }
    return out;
  }

  async add(tenant: string, record: TrustRecord): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
    // Read, check and write at the revision read, so two adds at once cannot
    // both pass the one-tenant rule for the same tenant's list.
    const all = await this.all();
    const refusal = addRefusal(all, tenant, record);
    if (refusal) return { ok: false, ...refusal };
    const e = await this.kv.get(tenant);
    const next = JSON.stringify({ anchors: [...(all.get(tenant) ?? []), record] });
    try {
      if (e?.value.length) await this.kv.update(tenant, next, e.revision);
      else await this.kv.create(tenant, next);
    } catch {
      return { ok: false, status: 409, error: "The tenant's trust records changed while this was being added. Try again." };
    }
    return { ok: true };
  }

  async remove(tenant: string, id: string): Promise<boolean> {
    const e = await this.kv.get(tenant);
    if (!e?.value.length) return false;
    const list = e.json<{ anchors?: TrustRecord[] }>().anchors ?? [];
    const left = list.filter((r) => r.id !== id);
    if (left.length === list.length) return false;
    if (left.length) await this.kv.update(tenant, JSON.stringify({ anchors: left }), e.revision);
    else await this.kv.purge(tenant);
    return true;
  }
}

/** The same in memory, for tests. */
export class MemoryTrustAnchors implements TrustAnchorList {
  readonly map = new Map<string, TrustRecord[]>();
  async list(t: string) { return [...(this.map.get(t) ?? [])]; }
  async all() { return new Map([...this.map].map(([k, v]) => [k, [...v]])); }
  async add(t: string, r: TrustRecord) {
    const refusal = addRefusal(this.map, t, r);
    if (refusal) return { ok: false as const, ...refusal };
    this.map.set(t, [...(this.map.get(t) ?? []), r]);
    return { ok: true as const };
  }
  async remove(t: string, id: string) {
    const list = this.map.get(t) ?? [];
    const left = list.filter((r) => r.id !== id);
    if (left.length === list.length) return false;
    if (left.length) this.map.set(t, left); else this.map.delete(t);
    return true;
  }
}

/** The OAuth records that trust an issuer, with their tenants. */
export function oauthTrustFor(all: Map<string, TrustRecord[]>, issuer: string): TrustMatch<OAuthTrust>[] {
  const out: TrustMatch<OAuthTrust>[] = [];
  for (const [tenant, list] of all) for (const r of list) if (r.kind === "oauth" && r.issuer === issuer) out.push({ tenant, anchor: r });
  return out;
}

/** The SPIFFE record for a trust domain, with its tenant, or null. */
export function spiffeTrustFor(all: Map<string, TrustRecord[]>, trustDomain: string): TrustMatch<SpiffeTrust> | null {
  for (const [tenant, list] of all) for (const r of list) if (r.kind === "spiffe" && r.trust_domain === trustDomain) return { tenant, anchor: r };
  return null;
}
