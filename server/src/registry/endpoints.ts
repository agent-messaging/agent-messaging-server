import type { Manifest } from "../sdk.js";

/**
 * §8.1 `endpoints` / `limits` — the registry-side half of "resolve, never
 * construct" (§14.4).
 *
 * The manifest carries the agent's endpoint subjects VERBATIM so callers use
 * resolved values instead of string-building `mesh.agent.<key>.inbox` from the
 * naming convention. The block is OPTIONAL on registration and
 * registry-populated (§8.2): the registry stamps it at register time from
 * `endpoint` when the registrant did not supply one, so a manifest that
 * predates the field never lacks it once stored. Records stored BEFORE this
 * existed are covered by stamp-on-read (`withEndpoints`) at every place a
 * manifest leaves the registry.
 */

/** A manifest as the registry stores and serves it. The SDK `Manifest` type
 *  now carries `endpoints` / `limits` itself (`AgentEndpoints` /
 *  `AgentLimits`), so the local extension this alias used to add has
 *  collapsed into it, as planned when the fields were services-only. The
 *  alias name stays: "the stored shape" is a registry concept worth naming,
 *  and its call sites did not change. */
export type StoredManifest = Manifest;

/**
 * Deprecation window (§8.5): map a pre-rename document's `skills` /
 * `public.skills` / `public.skill_details` onto the new names, in place, and
 * drop the legacy keys. Applied at register (so storage holds one vocabulary)
 * AND at every KV read (so manifests stored before the rename read back
 * normalized without waiting for their agents to re-register).
 */
export function normalizeLegacyManifest<M extends StoredManifest>(manifest: M): M {
  if (!manifest || typeof manifest !== "object") return manifest;
  const legacy = manifest as M & {
    skills?: Manifest["offerings"];
    public?: NonNullable<Manifest["public"]> & { skills?: string[]; skill_details?: unknown };
  };
  if (manifest.offerings === undefined && Array.isArray(legacy.skills)) {
    manifest.offerings = legacy.skills;
  }
  delete legacy.skills;
  if (legacy.public) {
    if (legacy.public.offerings === undefined && Array.isArray(legacy.public.skills)) {
      legacy.public.offerings = legacy.public.skills;
    }
    if (
      legacy.public.offering_details === undefined &&
      Array.isArray(legacy.public.skill_details)
    ) {
      legacy.public.offering_details = legacy.public
        .skill_details as NonNullable<Manifest["public"]>["offering_details"];
    }
    delete legacy.public.skills;
    delete legacy.public.skill_details;
  }
  return manifest;
}

/** Characters a concrete subject token must not contain: whitespace and the
 *  NATS wildcards. An endpoint names ONE subject a caller publishes to, so
 *  `*` and `>` have no place in it. */
const BAD_TOKEN_CHARS = /[\s*>]/;

/**
 * A concrete, publishable NATS subject: dot-separated non-empty tokens with no
 * whitespace and no wildcards.
 */
export function isWellFormedSubject(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0) return false;
  const tokens = s.split(".");
  return tokens.every((t) => t.length > 0 && !BAD_TOKEN_CHARS.test(t));
}

/** The agent key a `mesh.agent.<key>.…` subject claims, or null for subjects
 *  outside that namespace. This is how a foreign-inbox claim is detected. */
function claimedAgentKey(subject: string): string | null {
  const tokens = subject.split(".");
  if (tokens.length >= 3 && tokens[0] === "mesh" && tokens[1] === "agent") {
    return tokens[2];
  }
  return null;
}

export type EndpointsProblem =
  | { code: "invalid"; message: string }
  | { code: "foreign"; message: string };

/**
 * Validate a registrant-supplied `endpoints` block (and the `endpoint` field it
 * defaults from) against the registrant's identity.
 *
 * Two failure classes, refused with different codes by the caller:
 *  - `invalid`  — the block is not an object of well-formed concrete subjects
 *                 (→ INVALID_MANIFEST, like every other shape refusal);
 *  - `foreign`  — a subject sits in ANOTHER agent's `mesh.agent.<key>.…`
 *                 namespace. Discovery serves these values verbatim and callers
 *                 address them (§14.4), so accepting a foreign inbox claim
 *                 would let a registrant redirect other agents' traffic
 *                 (→ IDENTITY_MISMATCH: it claims an identity that isn't the
 *                 registrant's).
 *
 * Subjects OUTSIDE the `mesh.agent.` namespace only need to be well-formed:
 * the convention is not the law of what an endpoint may be (§14.4 exists so it
 * never becomes one), but the per-agent namespace does carry identity.
 */
export function validateEndpoints(manifest: StoredManifest): EndpointsProblem | null {
  // `endpoint` is stamped into `endpoints.inbox` when the block is absent
  // (§8.2), so it passes through exactly the same checks as a supplied value.
  const candidates: Array<[string, unknown]> = [["endpoint", manifest.endpoint]];

  const block = manifest.endpoints;
  if (block !== undefined) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      return { code: "invalid", message: "endpoints must be an object of subject strings" };
    }
    for (const [name, value] of Object.entries(block)) {
      candidates.push([`endpoints.${name}`, value]);
    }
  }

  for (const [field, value] of candidates) {
    if (!isWellFormedSubject(value)) {
      return {
        code: "invalid",
        message: `${field} is not a well-formed concrete NATS subject`,
      };
    }
    const claimed = claimedAgentKey(value);
    if (claimed !== null && claimed !== manifest.id) {
      return {
        code: "foreign",
        message: `${field} (${value}) claims agent ${claimed}'s subject namespace; a registrant may only publish endpoints under its own`,
      };
    }
  }
  return null;
}

/**
 * Validate a registrant-supplied `limits` block (§8.1). Unknown keys pass
 * through untouched — the block is a declaration surface, not a schema the
 * registry owns — but a malformed `max_inbound_chars` (non-integer, negative)
 * is refused: senders pre-flight against it (§6.4b), so storing garbage turns
 * into wrong refusals at every sender. `0` is legal (§22.5: explicit no-cap).
 */
export function validateLimits(manifest: StoredManifest): string | null {
  const limits: unknown = manifest.limits;
  if (limits === undefined) return null;
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
    return "limits must be an object";
  }
  const cap = (limits as { max_inbound_chars?: unknown }).max_inbound_chars;
  if (cap !== undefined && (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0)) {
    return "limits.max_inbound_chars must be a non-negative integer";
  }
  return null;
}

/**
 * Stamp the `endpoints` block per §8.2: derived from `endpoint` when absent,
 * and `inbox` filled from `endpoint` when a supplied block lacks it (§8.1: at
 * minimum `inbox`). Pure — an already-stamped manifest comes back unchanged
 * (same object), a stampable one comes back as a shallow copy, so the
 * stamp-on-read paths never mutate the shared cache entry out from under the
 * manifest watch's change comparison. Used at register time (before store) and
 * as the stamp-on-read fallback for records stored before the field existed,
 * so no reader of registry output ever sees a manifest without it and no
 * caller ever has a reason to fall back to constructing (§14.4).
 */
export function withEndpoints<M extends StoredManifest>(manifest: M): M {
  const block = manifest.endpoints;
  if (block !== undefined && typeof block.inbox === "string") return manifest;
  if (typeof manifest.endpoint !== "string" || manifest.endpoint.length === 0) {
    // Nothing to derive from — a corrupt stored record; served as-is rather
    // than invented. Register refuses this shape up front (required fields).
    return manifest;
  }
  return {
    ...manifest,
    endpoints: {
      ...(block && typeof block === "object" && !Array.isArray(block) ? block : {}),
      inbox: manifest.endpoint,
    },
  };
}
