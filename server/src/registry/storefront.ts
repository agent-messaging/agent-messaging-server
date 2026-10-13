import type { AgentComplianceEntry, AgentDataUse, Manifest, PublicAccess, PublicAccessScheme, PublicOffering, Offering, OfferingReporting, SowProcessor } from "../sdk.js";
import {
  SOW_CONFIDENTIALITY_PROMISES,
  SOW_REPORTING_LEVELS,
  reportingEveryMs,
  validateSowConfidentiality,
} from "../sdk.js";

/**
 * §8.7 `public.offering_details` — the registry-side half of "declare once,
 * advertise a subset".
 *
 * ## The problem this solves
 *
 * A storefront could say an agent's name, a paragraph about it, and a list of
 * offering IDs. It could not say what any of those offerings TAKES or RETURNS. So a
 * buyer looking at a listing had no way to answer the first question anybody
 * actually has — "can I send it a file?" — and the honest answer was that
 * nothing in the mesh could tell them. Every consumer that needed the answer
 * invented one: the A2A bridge stamped `["application/json", "text/plain"]` on
 * every card it generated, whether or not it was true.
 *
 * ## Why the registry builds it rather than the operator
 *
 * The obvious fix is to let the operator write descriptors into the public
 * block. That is the wrong shape, and it is wrong in a way that only shows up
 * six months later: the manifest's `offerings` array already carries every one of
 * these fields, so an operator-written public block is a SECOND copy of facts
 * that already exist. Two copies drift. The storefront then quietly advertises
 * an interface the agent stopped having, and nothing in the system can tell
 * which copy is the lie.
 *
 * So `public.offerings` stays what §8.7 says it is — a SELECTION, a list of IDs,
 * "advertising less than you can do is a choice this spec protects" — and the
 * descriptions are derived from the offerings the agent already declared. One
 * source of truth, and the choice of what to show is preserved.
 *
 * This is generation at REGISTER time, not at request time, so §8.7's "served
 * verbatim; nothing generates it at request time" still holds exactly. It is
 * the same move the registry already makes for `owner`, `visibility`,
 * `sandbox` (§8.3) and `endpoints` (§8.2): normalize on the way in, so every
 * reader downstream sees one shape and no reader has to reconstruct anything.
 */

/** The most offerings a storefront will advertise. `describe` (§10.14) answers
 *  strangers pre-admission and unauthenticated, so its response size is
 *  attacker-influenced and wants a ceiling somewhere. An agent listing more
 *  than two dozen distinct offerings to people who have not been admitted is
 *  describing a catalogue, not a storefront. */
const MAX_ADVERTISED = 24;

/**
 * §8.5.2: the offered reporting level an offering declares, readable — or null.
 *
 * Unlike `needs`/`delivers`, which are deliberately loose prose for a model to
 * read, `reporting` is a closed vocabulary feeding an integer comparison, so it
 * is validated on the way in. An unreadable declaration is DROPPED — from the
 * stored manifest and therefore from the storefront — rather than served,
 * because a declaration that cannot be read declares nothing and must not be
 * presented as if it did. The drop is per-field: the offering itself survives.
 *
 * Unreadable means any of: not an object; a level outside §5.12's closed set;
 * `check_ins` without `every` (a calendar level advertised without a calendar
 * advertises nothing testable); `every` on a level below `check_ins`; or an
 * `every` the §5.12 duration grammar refuses.
 *
 * Returns the normalized `{ level, every? }` — anything else riding on the
 * object stays out of the stored form, since §8.5.2 defines only these two.
 */
export function readableReporting(value: unknown): OfferingReporting | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as { level?: unknown; every?: unknown };
  if (typeof r.level !== "string" || !(SOW_REPORTING_LEVELS as readonly string[]).includes(r.level)) {
    return null;
  }
  const level = r.level as OfferingReporting["level"];
  if (level === "check_ins") {
    if (typeof r.every !== "string") return null;
    try {
      reportingEveryMs(r.every);
    } catch {
      return null;
    }
    return { level, every: r.every };
  }
  // §8.5.2: `every` MUST NOT appear below check_ins — on_change is
  // change-triggered with no calendar, records_only owes only the record.
  if (r.every !== undefined) return null;
  return { level };
}

/**
 * Scrub unreadable §8.5.2 reporting declarations from a manifest's own
 * `offerings`, so the STORED manifest never serves one (the storefront copy in
 * `publicFormOf` re-checks independently, covering manifests stored before
 * this rule existed). Same contract as `withStorefront`: nothing to drop hands
 * back the SAME OBJECT.
 */
export function withReadableReporting<M extends Manifest>(manifest: M): M {
  const offerings = Array.isArray(manifest.offerings) ? manifest.offerings : [];
  if (!offerings.some((o) => o?.reporting !== undefined && readableReporting(o.reporting) === null)) {
    return manifest;
  }
  const next = offerings.map((o) => {
    if (o?.reporting === undefined || readableReporting(o.reporting) !== null) return o;
    const { reporting: _dropped, ...survives } = o;
    return survives as Offering;
  });
  return { ...manifest, offerings: next };
}

/**
 * §8.10: the card-level data-use declaration, readable — or null.
 *
 * Same validated-on-the-way-in doctrine as `readableReporting`, with one rule
 * DELIBERATELY different: the drop is WHOLE, never per-field. Reporting is an
 * advertisement whose unreadable half is a nothing; `data_use` is a privacy
 * claim, and a partially readable privacy claim misleads more than none at
 * all — a page showing "does not train" while silently dropping the malformed
 * retention half shows a cleaner posture than was declared. So one unreadable
 * member poisons the declaration and the agent is served as having said
 * nothing, which §8.10 defines as exactly that: has not said.
 *
 * Unreadable means any of: not a plain object; a promise spelled `false` (or
 * anything but the literal `true` — false is spelled by omission, §5.11); a
 * promise name outside the closed §5.11 vocabulary; `retention.max_days` not
 * a positive safe integer; or `processors` failing §5.11's entry rules —
 * which are NOT re-implemented here: the processors sub-clause is the one
 * §8.10 member whose advert shape IS the clause shape (no grade rides on the
 * list), so it is handed to the SDK's `validateSowConfidentiality` as a
 * clause carrying only `processors`. The other two members can't reuse the
 * clause validator directly because the clause grades them (§5.11) and the
 * advert deliberately does not, so their checks live here.
 *
 * A readable declaration is normalized to exactly the §8.10 members —
 * promises carrying only `true` entries, retention as `{ max_days }`,
 * processors as `{ service, domain?, purpose? }` — so nothing else rides into
 * storage. An EMPTY processors array is VALID and preserved: it is itself a
 * statement (content leaves the operator for nowhere), unlike an omitted one,
 * which states nothing.
 */
export function readableDataUse(value: unknown): AgentDataUse | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const d = value as { promises?: unknown; retention?: unknown; processors?: unknown; processed_in?: unknown };
  const out: AgentDataUse = {};

  if (d.promises !== undefined) {
    if (typeof d.promises !== "object" || d.promises === null || Array.isArray(d.promises)) return null;
    const p = d.promises as Record<string, unknown>;
    const vocabulary = SOW_CONFIDENTIALITY_PROMISES as readonly string[];
    for (const name of Object.keys(p)) {
      // An unknown promise name is not a promise this vocabulary can carry,
      // and a promise spelled anything but the literal `true` (false, "yes",
      // 1) is a spelling §5.11 refuses: false is spelled by omission.
      if (!vocabulary.includes(name) || p[name] !== true) return null;
    }
    const promises: NonNullable<AgentDataUse["promises"]> = {};
    for (const name of SOW_CONFIDENTIALITY_PROMISES) {
      if (p[name] === true) promises[name] = true;
    }
    out.promises = promises;
  }

  if (d.retention !== undefined) {
    if (typeof d.retention !== "object" || d.retention === null || Array.isArray(d.retention)) return null;
    const maxDays = (d.retention as { max_days?: unknown }).max_days;
    if (typeof maxDays !== "number" || !Number.isSafeInteger(maxDays) || maxDays <= 0) return null;
    out.retention = { max_days: maxDays };
  }

  if (d.processors !== undefined) {
    try {
      // Reuse, not re-implementation: a clause carrying only `processors` is
      // valid §5.11 input, so the entry rules (service required and bounded,
      // domain/purpose bounded when present, no duplicate service+domain
      // pair, [] allowed and meaningful, length ceiling) stay in one place.
      validateSowConfidentiality({ processors: d.processors });
    } catch {
      return null;
    }
    out.processors = (d.processors as SowProcessor[]).map((p) => ({
      service: p.service,
      ...(p.domain !== undefined ? { domain: p.domain } : {}),
      ...(p.purpose !== undefined ? { purpose: p.purpose } : {}),
    }));
  }

  if (d.processed_in !== undefined) {
    if (!Array.isArray(d.processed_in)) return null;
    // §8.10: an EMPTY processed_in is REFUSED as unreadable, deliberately.
    // The member names the jurisdictions content may touch; content that
    // touches NO jurisdiction is not a thing, so `[]` cannot be a true
    // declaration — it is a second spelling of silence that would read as a
    // STRONGER claim than silence (it would pass every buyer's subset test),
    // where §8.10 says absence fails any jurisdiction requirement. One
    // spelling of "has not said" is the spelling: absent.
    if (d.processed_in.length === 0) return null;
    const codes: string[] = [];
    for (const code of d.processed_in) {
      // Exactly two lowercase ASCII letters (lowercase ISO 3166-1 alpha-2).
      // "US", "usa", "u1": unreadable — and per the whole-drop rule above,
      // one unreadable code poisons the entire declaration.
      if (typeof code !== "string" || !/^[a-z]{2}$/.test(code)) return null;
      if (!codes.includes(code)) codes.push(code);
    }
    out.processed_in = codes;
  }

  // #148: an empty declaration object — `{}` with no members — drops to
  // absent rather than storing as `{}`. Both spell "has not said"; keeping
  // two spellings of the same silence in storage makes every downstream
  // reader distinguish them for no information gained.
  if (Object.keys(out).length === 0) return null;

  return out;
}

/**
 * Scrub an unreadable §8.10 `data_use` declaration from the manifest — whole,
 * per the rule above — and normalize a readable one to exactly the §8.10
 * members. Same contract as `withReadableReporting`: nothing to change hands
 * back the SAME OBJECT (the manifest watch compares identity). The
 * storefront read path re-validates independently (api-service stamps
 * card-level facts on read), covering manifests stored before this rule
 * existed.
 */
export function withReadableDataUse<M extends Manifest>(manifest: M): M {
  if (manifest.data_use === undefined) return manifest;
  const readable = readableDataUse(manifest.data_use);
  if (readable === null) {
    const { data_use: _dropped, ...survives } = manifest;
    return survives as unknown as M;
  }
  // Already in normalized form: hand back the same object so an unchanged
  // registration is not reported as a change.
  if (JSON.stringify(readable) === JSON.stringify(manifest.data_use)) return manifest;
  return { ...manifest, data_use: readable };
}

/** §8.11's open-but-shaped standard token: lowercase, digits, hyphens, 2–32
 *  chars, starting alphanumeric. Open vocabulary (`soc2`, `iso27001`, `gdpr`,
 *  `hipaa`, `pci-dss`, and whatever proliferates next), exact-equality
 *  comparison — the shape check buys index/filterability, not a closed set. */
const COMPLIANCE_STANDARD = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** The most compliance postures one card may claim. Same pre-admission size
 *  discipline as MAX_ADVERTISED: an agent claiming more than sixteen distinct
 *  standards to strangers is writing marketing, not a declaration. */
const MAX_COMPLIANCE_ENTRIES = 16;

/**
 * §8.11: the card-level compliance declarations, readable — or null.
 *
 * `data_use`'s family rule, applied to the sibling member: these are claims a
 * buyer in a regulated industry acts on, so an unreadable entry poisons the
 * WHOLE `compliance` member — a partially readable claims list misleads more
 * than none at all (a page showing "soc2" while silently dropping a malformed
 * "hipaa" entry shows a posture nobody declared). Absent means the operator
 * has not said, and a stated requirement treats silence as not meeting it.
 *
 * Unreadable means any of: not an array; an EMPTY array (a second spelling of
 * silence — absent is the one spelling of "has not said", exactly the #148
 * rule `data_use` applies to `{}`); more than 16 entries; an entry that is
 * not a plain object; a `standard` that is not a lowercase token; two entries
 * claiming the same standard (comparison is exact token equality, so a
 * duplicate is a contradiction waiting to happen); a blank or over-long
 * `scope`; or an `attestation` whose members are not what they say — `by` a
 * non-blank string ≤120, `url` an http(s) URL ≤300, `expires_at` a parseable
 * date.
 *
 * A readable declaration is normalized to exactly the §8.11 members —
 * `standard`, `scope?`, `attestation?.{by,url,expires_at}` — so nothing else
 * rides into storage, and an attestation with no members (a pointer at
 * nobody) is dropped to absent rather than stored as `{}`.
 */
export function readableCompliance(value: unknown): AgentComplianceEntry[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0 || value.length > MAX_COMPLIANCE_ENTRIES) return null;
  const seen = new Set<string>();
  const out: AgentComplianceEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const e = raw as { standard?: unknown; scope?: unknown; attestation?: unknown };
    if (typeof e.standard !== "string" || !COMPLIANCE_STANDARD.test(e.standard)) return null;
    if (seen.has(e.standard)) return null;
    seen.add(e.standard);
    const entry: AgentComplianceEntry = { standard: e.standard };

    if (e.scope !== undefined) {
      if (typeof e.scope !== "string" || !e.scope.trim() || e.scope.length > 300) return null;
      entry.scope = e.scope;
    }

    if (e.attestation !== undefined) {
      if (typeof e.attestation !== "object" || e.attestation === null || Array.isArray(e.attestation)) return null;
      const a = e.attestation as { by?: unknown; url?: unknown; expires_at?: unknown };
      const attestation: NonNullable<AgentComplianceEntry["attestation"]> = {};
      if (a.by !== undefined) {
        if (typeof a.by !== "string" || !a.by.trim() || a.by.length > 120) return null;
        attestation.by = a.by;
      }
      if (a.url !== undefined) {
        // http(s) only: the attestation is a pointer a READER follows, and a
        // javascript: or data: scheme served on the /a/ page is an injection
        // surface, not a statement.
        if (typeof a.url !== "string" || a.url.length > 300 || !/^https?:\/\/./.test(a.url)) return null;
        attestation.url = a.url;
      }
      if (a.expires_at !== undefined) {
        if (typeof a.expires_at !== "string" || Number.isNaN(Date.parse(a.expires_at))) return null;
        attestation.expires_at = a.expires_at;
      }
      if (Object.keys(attestation).length > 0) entry.attestation = attestation;
    }

    out.push(entry);
  }
  return out;
}

/**
 * Scrub an unreadable §8.11 `compliance` member from the manifest — whole,
 * per the family rule — and normalize a readable one to exactly the §8.11
 * members. Same contract as `withReadableDataUse`: nothing to change hands
 * back the SAME OBJECT (the manifest watch compares identity), and the
 * storefront read path re-validates independently for manifests stored
 * before this rule existed.
 */
export function withReadableCompliance<M extends Manifest>(manifest: M): M {
  if (manifest.compliance === undefined) return manifest;
  const readable = readableCompliance(manifest.compliance);
  if (readable === null) {
    const { compliance: _dropped, ...survives } = manifest;
    return survives as unknown as M;
  }
  // Already in normalized form: hand back the same object so an unchanged
  // registration is not reported as a change.
  if (JSON.stringify(readable) === JSON.stringify(manifest.compliance)) return manifest;
  return { ...manifest, compliance: readable };
}

/** One §8.7 `uis` entry as stored and served: a web surface a person can open
 *  for this agent. `url` and `label` are REQUIRED; everything else optional.
 *  `audience`/`access` are labels, never access control (the door itself
 *  enforces), and every entry is an untrusted link — renderers show it plain,
 *  never embed it, and flag a cross-origin one. */
export interface PublicUiEntry {
  url: string;
  label: string;
  purpose?: string;
  audience?: "public" | "client" | "operator";
  access?: "open" | "authenticated";
  kind?: string;
  offering?: string;
}

/** The most web surfaces one storefront may list. Same pre-admission size
 *  discipline as MAX_ADVERTISED, smaller because each entry is a link a
 *  PERSON is invited to click: an agent pointing strangers at more than eight
 *  pages is writing a sitemap, not a storefront. */
const MAX_UIS = 8;

/** §8.7 `uis` string ceilings, in the spirit of the §8.11 caps: `label` is a
 *  link's text (60, the size of `by`'s half), `purpose` is one sentence (200),
 *  `kind` is a token-ish word (30), `url` matches the attestation-url cap. */
const UI_LABEL_MAX = 60;
const UI_PURPOSE_MAX = 200;
const UI_KIND_MAX = 30;
const UI_URL_MAX = 300;

/** §8.7's closed label sets. Closed on purpose where `kind` is open: a
 *  renderer groups by audience and phrases access, so a value outside the set
 *  is a value no renderer can place — and per the drop rule below it takes
 *  its ENTRY with it, never the manifest. */
const UI_AUDIENCES = ["public", "client", "operator"] as const;
const UI_ACCESS = ["open", "authenticated"] as const;

/**
 * §8.7 `uis`, readable — the entries a storefront will serve, or `[]`.
 *
 * The reporting family rule, not the data_use one: each entry is an
 * advertisement whose unreadable form is a nothing, so the drop is PER ENTRY
 * (and, for the optional prose fields, per field) — registration never fails
 * over a storefront link, exactly as a stale advertised offering id is
 * dropped rather than invented. What drops an ENTRY: not a plain object; a
 * `url` that is not https (http refused, not coerced), does not parse,
 * carries credentials (`https://user:pw@…` served on a public page is a
 * phishing shape, not an address), or exceeds the cap; a missing, blank, or
 * over-long `label`; an `audience` or `access` outside its closed set (a
 * label no renderer can place placed nowhere). What drops a FIELD, the entry
 * surviving: an unreadable `purpose` or `kind` (blank, over-cap, or not a
 * string), and an `offering` naming no declared offering id — dropped rather
 * than invented, the §8.7 rule verbatim. Entries beyond the cap are dropped
 * from the tail. A readable entry is normalized to exactly the §8.7 members,
 * so nothing else rides into storage, and what is stored is what is served.
 */
export function readablePublicUis(value: unknown, declaredOfferingIds: ReadonlySet<string>): PublicUiEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PublicUiEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const e = raw as {
      url?: unknown; label?: unknown; purpose?: unknown;
      audience?: unknown; access?: unknown; kind?: unknown; offering?: unknown;
    };

    if (typeof e.url !== "string" || e.url.length > UI_URL_MAX) continue;
    let parsed: URL;
    try { parsed = new URL(e.url); } catch { continue; }
    if (parsed.protocol !== "https:") continue;
    if (parsed.username || parsed.password) continue;

    if (typeof e.label !== "string" || !e.label.trim() || e.label.length > UI_LABEL_MAX) continue;

    if (e.audience !== undefined && !(UI_AUDIENCES as readonly unknown[]).includes(e.audience)) continue;
    if (e.access !== undefined && !(UI_ACCESS as readonly unknown[]).includes(e.access)) continue;

    const entry: PublicUiEntry = { url: e.url, label: e.label };
    if (typeof e.purpose === "string" && e.purpose.trim() && e.purpose.length <= UI_PURPOSE_MAX) {
      entry.purpose = e.purpose;
    }
    if (e.audience !== undefined) entry.audience = e.audience as PublicUiEntry["audience"];
    if (e.access !== undefined) entry.access = e.access as PublicUiEntry["access"];
    if (typeof e.kind === "string" && e.kind.trim() && e.kind.length <= UI_KIND_MAX) {
      entry.kind = e.kind;
    }
    if (typeof e.offering === "string" && declaredOfferingIds.has(e.offering)) {
      entry.offering = e.offering;
    }

    out.push(entry);
    if (out.length >= MAX_UIS) break;
  }
  return out;
}

const MAX_ACCESS_SCHEMES = 8;
const ACCESS_ID_MAX = 60;
const ACCESS_NAME_MAX = 100;
const ACCESS_DESC_MAX = 200;
const ACCESS_URL_MAX = 300;
const ADMISSION_POLICIES = ["open", "allowlist", "screened", "negotiated"] as const;
const ACCESS_TRANSPORTS = ["mesh", "http"] as const;
const ACCESS_HTTP_TYPES = ["apiKey", "http", "oauth2", "openIdConnect", "mutualTLS"] as const;
const ACCESS_IN = ["header", "query", "cookie"] as const;

/** An https URL carrying no embedded credentials, capped. The oauth2 and
 *  openIdConnect endpoints are the only URLs §8.12 admits, and they qualify as
 *  SHAPES precisely because they are the operator's own and identical for every
 *  caller. A `user:pass@` URL is a binding wearing a shape's clothes. */
function readableAccessUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > ACCESS_URL_MAX) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return undefined; }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  return value;
}

/**
 * §8.12 `public.access`: how a caller authenticates, and who is let in.
 *
 * The defence is NORMALIZATION, not detection. An entry is rebuilt from
 * exactly the members §8.12 names, so a `"api_key": "sk-live-…"` smuggled onto
 * a scheme never reaches storage and therefore never reaches the
 * pre-admission page — the one place where a validation error that merely
 * *refuses* the write would already be too late, because the secret would have
 * been served first. What cannot be detected mechanically (a secret typed into
 * `description`) is inherent and stays the operator's own doing.
 *
 * What drops a SCHEME: a missing or over-cap `id`, an unknown `transport`, a
 * `type` that does not belong to that transport (`mesh` takes only
 * `mesh-identity`; `http` takes only OpenAPI's five), an `apiKey` with no
 * readable `name`, and a non-https or credential-bearing URL. What drops the
 * MEMBER, the block surviving: an unrecognized `admission`, read as unstated
 * rather than as `open` (§8.12 — silence must never resolve to the open door).
 *
 * Returns `undefined` when nothing readable is left, so an absent block and an
 * empty one stay distinguishable. `schemes: []` is preserved on purpose: it is
 * the agent stating there is nothing to present, which is a real answer and
 * not the same as never having said.
 */
export function readablePublicAccess(value: unknown): PublicAccess | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as { admission?: unknown; schemes?: unknown };
  const out: PublicAccess = {};

  if ((ADMISSION_POLICIES as readonly unknown[]).includes(raw.admission)) {
    out.admission = raw.admission as PublicAccess["admission"];
  }

  if (Array.isArray(raw.schemes)) {
    const schemes: PublicAccessScheme[] = [];
    const ids = new Set<string>();
    for (const item of raw.schemes) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const s = item as Record<string, unknown>;

      if (typeof s.id !== "string" || !s.id.trim() || s.id.length > ACCESS_ID_MAX) continue;
      if (ids.has(s.id)) continue;
      if (!(ACCESS_TRANSPORTS as readonly unknown[]).includes(s.transport)) continue;
      const transport = s.transport as PublicAccessScheme["transport"];

      const typeOk = transport === "mesh"
        ? s.type === "mesh-identity"
        : (ACCESS_HTTP_TYPES as readonly unknown[]).includes(s.type);
      if (!typeOk) continue;
      const type = s.type as PublicAccessScheme["type"];

      const entry: PublicAccessScheme = { id: s.id, transport, type };

      if (type === "apiKey") {
        if (!(ACCESS_IN as readonly unknown[]).includes(s.in)) continue;
        if (typeof s.name !== "string" || !s.name.trim() || s.name.length > ACCESS_NAME_MAX) continue;
        entry.in = s.in as PublicAccessScheme["in"];
        entry.name = s.name;
      }
      if (type === "http" && typeof s.scheme === "string" && s.scheme.trim()
          && s.scheme.length <= ACCESS_NAME_MAX) {
        entry.scheme = s.scheme;
        if (typeof s.bearerFormat === "string" && s.bearerFormat.trim()
            && s.bearerFormat.length <= ACCESS_NAME_MAX) {
          entry.bearerFormat = s.bearerFormat;
        }
      }
      if (type === "oauth2" && typeof s.flows === "object" && s.flows !== null
          && !Array.isArray(s.flows)) {
        entry.flows = s.flows as Record<string, unknown>;
      }
      if (type === "openIdConnect") {
        const url = readableAccessUrl(s.openIdConnectUrl);
        if (!url) continue;
        entry.openIdConnectUrl = url;
      }
      if (typeof s.description === "string" && s.description.trim()
          && s.description.length <= ACCESS_DESC_MAX) {
        entry.description = s.description;
      }

      ids.add(s.id);
      schemes.push(entry);
      if (schemes.length >= MAX_ACCESS_SCHEMES) break;
    }
    out.schemes = schemes;
  }

  if (out.admission === undefined && out.schemes === undefined) return undefined;
  return out;
}

/** Copy a declared offering into its public form. `examples` is deliberately
 *  dropped: it is the largest field on an offering and the least load-bearing for
 *  somebody deciding whether to knock. Optional fields are omitted rather than
 *  set to `undefined` so the stored JSON stays clean and byte-comparable. */
function publicFormOf(offering: Offering): PublicOffering {
  return {
    id: offering.id,
    name: offering.name,
    description: offering.description,
    ...(offering.tags?.length ? { tags: offering.tags } : {}),
    ...(offering.input_modes?.length ? { input_modes: offering.input_modes } : {}),
    ...(offering.output_modes?.length ? { output_modes: offering.output_modes } : {}),
    ...(offering.input_schema ? { input_schema: offering.input_schema } : {}),
    ...(offering.output_schema ? { output_schema: offering.output_schema } : {}),
    ...(offering.streaming !== undefined ? { streaming: offering.streaming } : {}),
    ...(typeof offering.estimated_duration_ms === "number"
      ? { estimated_duration_ms: offering.estimated_duration_ms }
      : {}),
    // §8.5.1: the engagement contract is precisely the pre-admission material —
    // "who can push to my repo, and will I see drafts?" is a stranger's question.
    ...(offering.needs?.length ? { needs: offering.needs } : {}),
    ...(offering.delivers && typeof offering.delivers === "object" ? { delivers: offering.delivers } : {}),
    // §8.5.2: validated rather than passed through — an unreadable reporting
    // declaration is dropped (the offering survives), never served.
    ...(reportingOf(offering)),
  };
}

/** The `reporting` member of a public form, or nothing — split out so the
 *  spread above stays symmetrical with its neighbours. */
function reportingOf(offering: Offering): { reporting: OfferingReporting } | Record<string, never> {
  if (offering.reporting === undefined) return {};
  const reporting = readableReporting(offering.reporting);
  return reporting ? { reporting } : {};
}

/**
 * Build `public.offering_details` and the public default modes from the manifest.
 *
 * Pure, and in the shape of `withEndpoints`: a manifest with nothing to
 * materialize comes back as the SAME OBJECT, one with work to do comes back as
 * a shallow copy. The manifest watch compares by identity to decide whether a
 * stored record changed, so returning a fresh object unconditionally would make
 * every read look like an update.
 *
 * Two rules worth stating because they are the ones a registrant might argue
 * with:
 *
 *  - Anything a registrant supplies in `offering_details` is DISCARDED. It is a
 *    derived field; accepting a registrant's version would reintroduce exactly
 *    the drift the derivation exists to prevent, and would let an agent
 *    advertise an interface it does not implement.
 *  - An advertised ID matching no declared offering is DROPPED, not invented. It
 *    means the operator's selection has gone stale against the agent's own
 *    offerings, and the truthful storefront is the smaller one.
 */
export function withStorefront<M extends Manifest>(manifest: M): M {
  const block = manifest.public;
  if (!block || typeof block !== "object") return manifest;

  const declared = Array.isArray(manifest.offerings) ? manifest.offerings : [];
  const byId = new Map<string, Offering>();
  for (const s of declared) {
    if (s && typeof s.id === "string" && !byId.has(s.id)) byId.set(s.id, s);
  }

  const wanted = Array.isArray(block.offerings) ? block.offerings : [];
  const details: PublicOffering[] = [];
  const seen = new Set<string>();
  for (const id of wanted) {
    if (typeof id !== "string" || seen.has(id)) continue;
    const offering = byId.get(id);
    if (!offering) continue;
    seen.add(id);
    details.push(publicFormOf(offering));
    if (details.length >= MAX_ADVERTISED) break;
  }

  const inModes = manifest.default_input_modes;
  const outModes = manifest.default_output_modes;

  // §8.7 `uis` (tracker #171): validated per entry rather than derived — this
  // member is genuinely the operator's to write (the registry cannot know
  // where a dashboard lives) — but under the same "dropped rather than
  // invented" doctrine as the advertised ids above, and normalized here so
  // what is stored is served verbatim, exactly like the rest of the block.
  const uis = readablePublicUis((block as PublicBlockLike).uis, new Set(byId.keys()));

  // §8.12 `public.access`: normalized on the way in for the same reason `uis`
  // is — the operator writes it, the registry decides what is servable — with
  // one sharper stake. This block is served pre-admission, so an unreadable
  // member is not merely noise: it is the member most likely to be carrying
  // something that should never have been published.
  const access = readablePublicAccess((block as PublicBlockLike).access);

  const next: PublicBlockLike = { ...block };
  if (details.length) next.offering_details = details;
  else delete next.offering_details;
  if (Array.isArray(inModes) && inModes.length) next.default_input_modes = inModes;
  else delete next.default_input_modes;
  if (Array.isArray(outModes) && outModes.length) next.default_output_modes = outModes;
  else delete next.default_output_modes;
  if (uis.length) next.uis = uis;
  else delete next.uis;
  if (access) next.access = access;
  else delete next.access;

  // Nothing to say and nothing stale to clear: hand back the original so the
  // watch's change comparison stays honest.
  if (sameStorefront(block, next)) return manifest;
  return { ...manifest, public: next };
}

/** The public block plus the §8.7 `uis` member the services validate ahead of
 *  the SDK type carrying it — `uis` rides the wire as part of the block and is
 *  normalized to {@link PublicUiEntry} on the way in. */
type PublicBlockLike = NonNullable<Manifest["public"]> & { uis?: unknown };

/** Whether the materialized fields already match, so an unchanged registration
 *  is not reported as a change. Compared by serialized value because these are
 *  small derived structures rebuilt from scratch on every pass — never the same
 *  object identity even when identical. */
function sameStorefront(a: PublicBlockLike, b: PublicBlockLike): boolean {
  return (
    JSON.stringify(a.offering_details ?? null) === JSON.stringify(b.offering_details ?? null) &&
    JSON.stringify(a.default_input_modes ?? null) === JSON.stringify(b.default_input_modes ?? null) &&
    JSON.stringify(a.default_output_modes ?? null) === JSON.stringify(b.default_output_modes ?? null) &&
    JSON.stringify(a.uis ?? null) === JSON.stringify(b.uis ?? null) &&
    JSON.stringify(a.access ?? null) === JSON.stringify(b.access ?? null)
  );
}
