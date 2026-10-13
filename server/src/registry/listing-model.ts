/**
 * §8.12, the Agent Listing Model's card-level declarations: audience,
 * coverage, edge behaviour, whose interest the agent serves, where it came
 * from, what it does with what it can reach, and the other companies behind it.
 *
 * Siblings of `data_use` (§8.10) and `compliance` (§8.11) in `storefront.ts`,
 * and this file follows their contract exactly: a readable declaration is
 * normalized to precisely the spec's members, an unreadable one becomes null,
 * and the `with*` wrapper hands back the SAME OBJECT when nothing changes so
 * the manifest watch does not report an unchanged registration as a change.
 *
 * One rule differs from §8.10, deliberately. `data_use` drops WHOLE on a single
 * unreadable member, because a surviving privacy promise flatters the operator
 * when its neighbour is silently lost. These fields do not have that property:
 * audience, coverage and origin are independent statements, and losing one
 * leaves the others exactly as true as they were, with no direction in which a
 * survivor flatters. So they drop per member.
 *
 * The exception inside the exception is `acts`, which DOES drop whole when its
 * mode is unreadable: a list of actions with no statement of whether the agent
 * acts at all is not a weaker claim, it is an incoherent one.
 *
 * Why the registry validates when the catalog also does: this is what makes a
 * declaration survive materialization into the storefront, which is the only
 * path a crawling directory has. A foreign mesh's sloppy declaration must not
 * become a filterable claim anywhere, and these two validators sit at the two
 * boundaries where sloppiness can enter.
 */

import type { Manifest } from "../../../sdk-typescript/src/types/manifest.js";

const MAX_LIST = 32;
const MAX_TEXT = 400;
const MAX_ACTIONS = 32;
const MAX_PARTIES = 16;

const ORIGIN_VALUES: Record<string, readonly string[]> = {
  written_by: ["developer", "buyer_or_implementer", "vendor"],
  run_by: ["builder", "vendor_platform", "managed_runtime", "not_running"],
  open_to: ["builder", "team", "company", "anyone"],
  acquired_by: ["clone", "subscription", "channel", "call"],
};

const PARTY_ROLES = ["platform", "implementer", "operator", "data_source"];

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() && v.trim().length <= MAX_TEXT ? v.trim() : undefined;

/** A list of non-empty strings, or undefined. One bad member poisons the list
 *  rather than shortening it: a silently shortened COVERAGE list understates a
 *  boundary, and understating a boundary is the direction that gets somebody a
 *  wrong answer from an agent outside its competence. */
const strList = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v) || v.length > MAX_LIST) return undefined;
  const out: string[] = [];
  for (const raw of v) {
    const s = str(raw);
    if (!s) return undefined;
    if (!out.includes(s)) out.push(s);
  }
  return out.length ? out : undefined;
};

const pick = <T extends Record<string, unknown>>(o: T): T | null =>
  Object.keys(o).length ? o : null;

/** §8.12 `audience`, readable — or null. */
export function readableAudience(value: unknown): Record<string, string> | null {
  const a = obj(value);
  if (!a) return null;
  return pick({
    ...(str(a.for) ? { for: str(a.for)! } : {}),
    ...(str(a.touches) ? { touches: str(a.touches)! } : {}),
  });
}

/** §8.12 `coverage`, readable — or null. Never confuse with
 *  `data_use.processed_in`: that is where bytes go, this is where answers hold. */
export function readableCoverage(value: unknown): Record<string, unknown> | null {
  const c = obj(value);
  if (!c) return null;
  const geography = strList(c.geography);
  const jurisdiction = strList(c.jurisdiction);
  const language = strList(c.language);
  const note = str(c.note);
  return pick({
    ...(geography ? { geography } : {}),
    ...(jurisdiction ? { jurisdiction } : {}),
    ...(language ? { language } : {}),
    ...(note ? { note } : {}),
  });
}

/** §8.12 `edge`. Anything but the two tokens is unreadable, which becomes
 *  has-not-said — never `declines`, because a typo must not manufacture a
 *  refusal promise. */
export function readableEdge(value: unknown): string | null {
  return value === "declines" || value === "answers" ? value : null;
}

/** §8.12 `serves`. */
export function readableServes(value: unknown): string | null {
  return value === "hirer" || value === "owner" || value === "neutral" ? value : null;
}

/** §8.12 `origin`. A token outside the published vocabulary is dropped here
 *  rather than carried: unlike the catalog, which keeps it for display, the
 *  registry is producing the document a stranger will filter on. */
export function readableOrigin(value: unknown): Record<string, string> | null {
  const o = obj(value);
  if (!o) return null;
  const out: Record<string, string> = {};
  for (const [key, allowed] of Object.entries(ORIGIN_VALUES)) {
    const v = o[key];
    if (typeof v === "string" && allowed.includes(v)) out[key] = v;
  }
  return pick(out);
}

/** §8.12 `acts`. Drops WHOLE on an unreadable mode: actions with no statement
 *  of whether the agent acts at all is incoherent rather than partial. */
export function readableActs(value: unknown): Record<string, unknown> | null {
  const a = obj(value);
  if (!a) return null;
  if (a.mode !== "read" && a.mode !== "act") return null;

  const actions: Array<Record<string, unknown>> = [];
  if (Array.isArray(a.actions)) {
    for (const raw of a.actions.slice(0, MAX_ACTIONS)) {
      const r = obj(raw);
      const action = str(r?.action);
      if (!action || !r) continue;
      actions.push({
        action,
        // Only a real boolean survives. A truthy string here would silently
        // promise a safeguard nobody declared.
        ...(typeof r.approval === "boolean" ? { approval: r.approval } : {}),
        ...(str(r.description) ? { description: str(r.description) } : {}),
      });
    }
  }
  // A read-only agent naming actions contradicts itself; the mode is the
  // load-bearing half and wins.
  return a.mode === "act" && actions.length ? { mode: "act", actions } : { mode: a.mode };
}

/** §8.12 `parties`. An entry needs BOTH a name and a known role: a company
 *  with no role says somebody is involved without saying how, which is the
 *  half a reader needs, and a role with no company says nothing at all. */
export function readableParties(value: unknown): Array<Record<string, string>> | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PARTIES) return null;
  const out: Array<Record<string, string>> = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const r = obj(raw);
    const name = str(r?.name);
    const role = str(r?.role);
    if (!name || !role || !r || !PARTY_ROLES.includes(role)) continue;
    const key = `${role} ${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      role,
      ...(str(r.url) ? { url: str(r.url)! } : {}),
      ...(str(r.note) ? { note: str(r.note)! } : {}),
    });
  }
  return out.length ? out : null;
}

/** Every §8.12 member and its validator, so the register-time scrub and the
 *  read-time stamp cannot fall out of step by somebody adding a field to one
 *  of them and forgetting the other. */
export const LISTING_MODEL_FIELDS = {
  audience: readableAudience,
  coverage: readableCoverage,
  edge: readableEdge,
  serves: readableServes,
  origin: readableOrigin,
  acts: readableActs,
  parties: readableParties,
} as const satisfies Record<string, (v: unknown) => unknown>;

/**
 * Scrub unreadable §8.12 declarations from a manifest, per member.
 *
 * Same contract as `withReadableDataUse`: nothing to change hands back the
 * SAME OBJECT, so an unchanged registration is not reported as a change.
 */
export function withReadableListingModel<M extends Manifest>(manifest: M): M {
  let next: Record<string, unknown> | null = null;
  for (const [field, readable] of Object.entries(LISTING_MODEL_FIELDS)) {
    const declared = (manifest as unknown as Record<string, unknown>)[field];
    if (declared === undefined) continue;
    const scrubbed = readable(declared);
    if (JSON.stringify(scrubbed ?? undefined) === JSON.stringify(declared)) continue;
    next ??= { ...(manifest as unknown as Record<string, unknown>) };
    if (scrubbed === null) delete next[field];
    else next[field] = scrubbed;
  }
  return (next ?? manifest) as M;
}
