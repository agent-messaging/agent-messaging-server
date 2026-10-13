import type { Manifest, DiscoverQuery, Availability, NodeProfile, TrustTier, IdentitySource } from "../sdk.js";
import { identitySourceMatches } from "./identity-source-view.js";

/** Trust tier ordering for the `trust_tier` minimum-standing filter (§9.7). */
const TRUST_TIER_RANK: Record<TrustTier, number> = { sandbox: 0, standard: 1, verified: 2 };

/**
 * Apply discovery query filters (AgentMesh 0.2 §9.3). All filters use AND
 * semantics. Manifest filters are served from the registry; the `availability`
 * filter is joined from the presence store via `statusOf` (§9.6), and the
 * node-profile filters are joined via `profileOf` (§9.7). Cost-based filtering
 * moved to the Economics extension and is not applied here.
 */
export function applyDiscoveryFilters(
  manifests: Manifest[],
  query: DiscoverQuery,
  statusOf: (m: Manifest) => Availability = () => "online",
  profileOf: (m: Manifest) => NodeProfile | undefined = () => undefined,
  sourceOf: (m: Manifest) => IdentitySource | undefined = () => undefined,
): Manifest[] {
  let results = manifests;

  // capabilities: agent must have ALL specified capabilities
  if (query.capabilities?.length) {
    results = results.filter((m) =>
      query.capabilities!.every((cap) => m.capabilities.includes(cap)),
    );
  }

  // offering_id: agent must offer this specific offering
  if (query.offering_id) {
    results = results.filter((m) => m.offerings.some((s) => s.id === query.offering_id));
  }

  // tags: agent must have at least one matching tag (OR across all offerings)
  if (query.tags?.length) {
    results = results.filter((m) =>
      m.offerings.some((s) => s.tags?.some((t) => query.tags!.includes(t))),
    );
  }

  // node: restrict to agents hosted by a specific node
  if (query.node) {
    results = results.filter((m) => m.node?.id === query.node);
  }

  // owner: restrict to agents grouped under a specific owner key (§8.6) —
  // the roster lookup. Visibility scoping happens BEFORE these filters run
  // (handleDiscover), so a non-owner asking for someone's roster sees only
  // what that owner exposes.
  if (query.owner) {
    results = results.filter((m) => m.owner === query.owner);
  }

  // availability: joined from current presence (NOT the manifest)
  if (query.availability) {
    results = results.filter((m) => statusOf(m) === query.availability);
  }

  // node-profile filters (§9.7), joined from the node profile store.
  // A node with no known profile is excluded whenever a profile filter is set.
  if (query.trust_tier) {
    const floor = TRUST_TIER_RANK[query.trust_tier];
    results = results.filter((m) => {
      const t = profileOf(m)?.trust_tier;
      return t !== undefined && TRUST_TIER_RANK[t] >= floor;
    });
  }

  if (query.availability_class) {
    results = results.filter((m) => profileOf(m)?.availability_class === query.availability_class);
  }

  if (query.reachability) {
    results = results.filter((m) => profileOf(m)?.reachability === query.reachability);
  }

  // identity_source (§9.7): where the agent's identity came from, joined from
  // the key chain's record. Every member given must match; an agent with no
  // record is excluded whenever the filter is set.
  if (query.identity_source) {
    const want = query.identity_source;
    results = results.filter((m) => identitySourceMatches(sourceOf(m), want));
  }

  return results;
}
