import type { StoredManifest } from "./endpoints.js";

/**
 * §8.8 `works_with` and §8.5.1's `credential` need — the two declarations a
 * third-party wrapper makes about somebody else's service.
 *
 * Both are read by strangers before admission and both are entirely
 * self-reported, so the registry's job here is narrow and worth stating
 * exactly: refuse a shape that cannot be rendered honestly, and check nothing
 * else. There is no domain verification, no affiliation check, no allow-list of
 * services. A registrant may say it works with anything, and the spec is
 * explicit that saying so proves nothing.
 *
 * What is refused is malformed rather than untrue:
 *
 *  - a `works_with` entry with no service NAME is a badge with no subject; a
 *    renderer given one either drops it silently or prints an empty chip, and
 *    both are worse than refusing the registration where the operator can see
 *    the refusal;
 *  - a `credential` need with no service name is the dangerous version of the
 *    same thing. §8.5.1 exists so a person can be told WHICH service they are
 *    about to hand a sign-in to, and "this agent will ask you for credentials
 *    to (blank)" is not that. A declaration that cannot be read is
 *    indistinguishable from no declaration, which is abuse under the operator's
 *    listing policy.
 *
 * Sizes are capped because these ride pre-admission documents (`describe`, the
 * `/a/` storefront) that anyone may fetch unauthenticated.
 */

/** The most integrations one manifest may claim. Past this it is not a
 *  description of what an agent connects to, it is keyword stuffing aimed at a
 *  directory. */
const MAX_WORKS_WITH = 24;
/** Per-string ceiling. These are names and one-line descriptions, not prose. */
const MAX_FIELD_CHARS = 400;
/**
 * Tighter ceiling for a service NAME, because it is the one field here that
 * reaches the catalog's search index.
 *
 * A service name is a proper noun. Four hundred characters is a paragraph, and
 * a paragraph in the one indexed field is where keyword stuffing would live —
 * an agent could name "Salesforce" once and then spend the rest of the budget
 * on every other popular product it has never touched. Eighty is generous for
 * a real name and useless for that.
 *
 * The count of entries is a separate lever and a blunt one in both directions:
 * an honest aggregator legitimately connects to dozens, and two dozen
 * well-chosen nouns is all the stuffing anybody needs. So the cap on entries
 * is a rendering budget, and this is the one aimed at the index.
 */
const MAX_SERVICE_NAME_CHARS = 80;

function badString(v: unknown, field: string, required: boolean, max = MAX_FIELD_CHARS): string | null {
  if (v === undefined || v === null) {
    return required ? `${field} is required` : null;
  }
  if (typeof v !== "string") return `${field} must be a string`;
  if (required && v.trim().length === 0) return `${field} must not be empty`;
  if (v.length > max) return `${field} must be at most ${max} characters`;
  return null;
}

/** The §8.9 postures. Anything else is a value no reader can act on, and a
 *  storefront that renders it would be inventing a meaning for it. */
const SEALING_POSTURES = new Set(["required", "preferred"]);

/**
 * §8.9 `sealing`: whether callers should seal what they send this agent, and
 * whether an unsealed request gets read at all.
 *
 * Two refusals, and both are about a promise the agent could not keep:
 *
 *  - an unrecognised value. A buyer reads this field to decide whether to hand
 *    over a customer record, so "some string the registrant typed" is the one
 *    thing it must not be. Refusing here is also what keeps the absent case
 *    unambiguous: silence means "has not said", and it cannot be allowed to
 *    share a bucket with "said something nobody understood".
 *  - a posture with no `encryption_key`. §8.9 makes this a MUST: a posture is a
 *    promise about READING sealed content, and an agent that published no key
 *    cannot read any. Stored, it would advertise confidentiality that fails on
 *    the first message, which is worse than advertising none.
 *
 * Nothing else is checked, and in particular nothing checks that the agent's
 * handler really opens sealed payloads. That is unknowable from a manifest.
 */
function validateSealing(manifest: StoredManifest): string | null {
  const sealing: unknown = (manifest as { sealing?: unknown }).sealing;
  if (sealing === undefined || sealing === null) return null;
  if (typeof sealing !== "string" || !SEALING_POSTURES.has(sealing)) {
    return `sealing must be "required" or "preferred" (§8.9), or absent to say nothing`;
  }
  const key: unknown = (manifest as { encryption_key?: unknown }).encryption_key;
  if (typeof key !== "string" || key.trim().length === 0) {
    return (
      `sealing: "${sealing}" requires an encryption_key (§8.9): a sealing posture is a promise ` +
      `to read sealed content, and an agent that published no key cannot keep it`
    );
  }
  return null;
}

/**
 * Validate the §8.8 / §8.5.1 / §8.9 declarations on a registering manifest.
 * Returns a message for the registrant, or null when there is nothing to
 * refuse. Absent fields are always fine: none of these is required, and an
 * agent that integrates with nothing has nothing to say.
 */
export function validateDeclarations(manifest: StoredManifest): string | null {
  const sealingProblem = validateSealing(manifest);
  if (sealingProblem) return sealingProblem;

  const worksWith: unknown = (manifest as { works_with?: unknown }).works_with;
  if (worksWith !== undefined) {
    if (!Array.isArray(worksWith)) return "works_with must be an array";
    if (worksWith.length > MAX_WORKS_WITH) {
      return `works_with must name at most ${MAX_WORKS_WITH} services`;
    }
    for (const [i, raw] of worksWith.entries()) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return `works_with[${i}] must be an object`;
      }
      const e = raw as Record<string, unknown>;
      const problem =
        badString(e.service, `works_with[${i}].service`, true, MAX_SERVICE_NAME_CHARS) ??
        badString(e.domain, `works_with[${i}].domain`, false) ??
        badString(e.description, `works_with[${i}].description`, false);
      if (problem) return problem;
    }
  }

  const offerings = Array.isArray(manifest.offerings) ? manifest.offerings : [];
  for (const offering of offerings) {
    const needs: unknown = (offering as { needs?: unknown })?.needs;
    if (needs === undefined) continue;
    if (!Array.isArray(needs)) return `offering ${offering?.id ?? "?"}: needs must be an array`;
    for (const [i, raw] of needs.entries()) {
      if (typeof raw !== "object" || raw === null) continue;
      const e = raw as Record<string, unknown>;
      // Only the credential kind is checked. The other three are deliberately
      // loose (§8.5.1: "must read well to a model, not validate well in a
      // parser"), and this one is the exception because a reader can be harmed
      // by misreading it.
      if (!("credential" in e)) continue;
      const where = `offering ${offering?.id ?? "?"}: needs[${i}]`;
      const problem =
        badString(e.credential, `${where}.credential`, true) ??
        badString(e.scope, `${where}.scope`, false) ??
        badString(e.description, `${where}.description`, false);
      if (problem) return problem;
    }
  }

  return null;
}

/** Every distinct credential a manifest's offerings will ask a caller for
 *  (§8.5.1). Deduplicated by service name, because the same sign-in asked for
 *  by four offerings is still one thing a person is being asked to hand over.
 *  Order follows the manifest, so the rendering is stable. */
export function credentialNeedsOf(
  offerings: StoredManifest["offerings"] | undefined,
): Array<{ service: string; scope?: string; description?: string }> {
  const out: Array<{ service: string; scope?: string; description?: string }> = [];
  const seen = new Set<string>();
  for (const offering of Array.isArray(offerings) ? offerings : []) {
    for (const need of Array.isArray(offering?.needs) ? offering.needs : []) {
      const service = typeof need?.credential === "string" ? need.credential.trim() : "";
      if (!service || seen.has(service)) continue;
      seen.add(service);
      out.push({
        service,
        ...(typeof need.scope === "string" && need.scope.trim() ? { scope: need.scope } : {}),
        ...(typeof need.description === "string" && need.description.trim()
          ? { description: need.description }
          : {}),
      });
    }
  }
  return out;
}
