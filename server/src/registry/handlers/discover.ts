import type { Envelope, Manifest, DiscoverQuery, DiscoverResult } from "../../sdk.js";
import { createEnvelope, childSpan } from "../../sdk.js";
import { applyDiscoveryFilters } from "../discovery-filter.js";
import { withEndpoints } from "../endpoints.js";
import type { PresenceStore } from "../presence-store.js";
import type { NodeProfileStore } from "../node-profile-store.js";
import { unlistedKeys } from "../unlisted.js";

export async function handleDiscover(
  env: Envelope,
  serviceId: string,
  cache: Map<string, Manifest>,
  presence: PresenceStore,
  profiles: NodeProfileStore,
): Promise<Envelope> {
  const query = (env.payload as DiscoverQuery) ?? {};
  // §8.5 deprecation window: pre-rename SDKs filter by `skill_id`.
  if (query.offering_id === undefined) {
    const legacy = (env.payload as { skill_id?: unknown } | undefined)?.skill_id;
    if (typeof legacy === "string") query.offering_id = legacy;
  }

  // Owner-scoped visibility (§8.6). The discover envelope is signed, so `from`
  // is the verified caller. Everyone sees public agents; a caller additionally
  // sees unlisted/private agents they own (owner resolved from the caller's own
  // registered manifest — undefined for an unregistered/anonymous caller).
  //
  // There is deliberately NO roster-disclosure clause here. An earlier version
  // listed an owner's unlisted agents to any caller that supplied a matching
  // `query.owner`, treating knowledge of the owner key as the grant — but
  // discovery itself publishes owner keys on every public manifest, so one
  // unfiltered discover harvested every owner key and replaying it per key
  // enumerated everybody's unlisted agents. Knowledge of an identifier is not
  // consent, and core has no consent record to consult: §8.6 puts disclosure of
  // non-public rosters to chosen parties in the contacts extension
  // (`mesh://extensions/contacts/v1`), "not core". So `unlisted` here means what
  // it says — excluded from listings, reachable by id — and `private` never
  // leaves its owner.
  // `organization` is treated here exactly like `private`: the owner sees it
  // and nobody else. That is stricter than the word promises, and deliberately
  // so. Answering it properly means knowing which organization the caller
  // belongs to, and this registry holds no membership record; the paragraph
  // above is the standing rule that core does not guess at disclosure. The
  // catalog answers the organization case, because it has the account and the
  // org to hand. Until the registry does too, the safe reading of a word it
  // cannot check is the narrow one.
  const callerOwner = cache.get(env.from)?.owner;
  // `agent_ids` (§9.3): the caller names the agents it wants. Naming is not
  // browsing, so an unlisted agent and one never listed (below) are returned
  // when named; private stays with its owner. Presence checks ask this way.
  const rawIds = (query as { agent_ids?: unknown }).agent_ids;
  const named = Array.isArray(rawIds) ? new Set(rawIds.filter((x): x is string => typeof x === "string").slice(0, 200)) : null;
  // Test agents, archived agents and agents in the trash are never listed
  // (unlisted.ts); like `unlisted` visibility, they stay reachable by id.
  const never = named ? new Set<string>() : await unlistedKeys();
  const manifests = Array.from(cache.entries())
    .filter(([key]) => (named ? named.has(key) : !never.has(key)))
    .map(([, m]) => m)
    .filter((m) => {
      const vis = m.visibility ?? "public";
      if (vis === "public") return true;
      if (named && vis === "unlisted") return true;
      return callerOwner !== undefined && m.owner === callerOwner;
    });

  // Apply filters — availability joins from presence (§9.6), node-profile
  // filters join from the node profile store (§9.7), both keyed by node id.
  const filtered = applyDiscoveryFilters(
    manifests,
    query,
    (m) => presence.status(m.node?.id ?? ""),
    (m) => profiles.get(m.node?.id ?? ""),
  );
  const limit = query.limit ?? filtered.length;
  // Join presence at query time (§9.3): liveness is not stored in the manifest
  // (§8.4), so stamp each result with its node's current availability. Also
  // stamp `endpoints` on read (§8.2/§14.4): manifests stored before the field
  // existed lack it in KV, and every discovery record must carry the resolved
  // subjects so no caller falls back to constructing them.
  const results = filtered.slice(0, limit).map((m) => ({
    ...withEndpoints(m),
    availability: presence.status(m.node?.id ?? ""),
  }));

  const result: DiscoverResult = {
    agents: results,
    total: filtered.length,
  };

  console.log(`[registry] discover returned ${results.length}/${manifests.length} agents`);

  return createEnvelope({
    type: "respond",
    from: serviceId,
    to: env.from,
    in_reply_to: env.id,
    trace: childSpan(env.trace),
    payload: result,
  });
}
