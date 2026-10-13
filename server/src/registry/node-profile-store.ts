import type { NodeProfile, TrustTier, NodeRole } from "../sdk.js";

const TRUST_TIERS: ReadonlySet<string> = new Set(["verified", "standard", "sandbox"]);
const NODE_ROLES: ReadonlySet<string> = new Set(["participant", "service"]);

/** Operator-attested attributes for one node (§9.7): the fields a node cannot
 *  self-declare. Sourced from operator config, not from the node. */
export interface NodeAttestedAttributes {
  trust_tier?: TrustTier;
  role?: NodeRole;
}

/**
 * Parse the operator's node-attestation config (the `NODE_ATTESTATIONS` env
 * var): a JSON object mapping node public keys to attested attributes, e.g.
 * `{"UABC…":{"trust_tier":"verified","role":"service"}}`. Unknown attribute
 * values are dropped (never guessed); malformed JSON yields an empty map.
 */
export function parseNodeAttestations(json: string | undefined): Map<string, NodeAttestedAttributes> {
  const out = new Map<string, NodeAttestedAttributes>();
  if (!json) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    console.warn("[registry] NODE_ATTESTATIONS is not valid JSON; ignoring");
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const [node, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val !== "object" || val === null) continue;
    const v = val as Record<string, unknown>;
    const attrs: NodeAttestedAttributes = {};
    if (typeof v.trust_tier === "string" && TRUST_TIERS.has(v.trust_tier)) {
      attrs.trust_tier = v.trust_tier as TrustTier;
    }
    if (typeof v.role === "string" && NODE_ROLES.has(v.role)) {
      attrs.role = v.role as NodeRole;
    }
    if (attrs.trust_tier !== undefined || attrs.role !== undefined) out.set(node, attrs);
  }
  return out;
}

/**
 * Node profile store (AgentMesh 0.2 §9.7) — durable, node-keyed metadata
 * describing the *conditions* a host runs under (trust tier, expected uptime,
 * reachability, capacity). SEPARATE from presence (which is ephemeral liveness,
 * §9.6): a node can be `always_on` in profile yet `offline` in presence right
 * now. Discovery joins manifests against this store at query time.
 *
 * `trust_tier` and `role` are operator-attested (a node cannot self-declare
 * them); the rest are node-declared hints. Population (a node declaring its
 * profile at connect, the operator attesting trust_tier/role) is the caller's
 * responsibility via `set`.
 */
export class NodeProfileStore {
  private profiles = new Map<string, NodeProfile>();

  /** Upsert a node's profile, keyed by node ID. */
  set(profile: NodeProfile): void {
    this.profiles.set(profile.node, profile);
  }

  /** Seed operator-attested attributes (trust_tier, role) from operator config.
   *  Merges over any existing profile, preserving its declared attributes. */
  seedAttested(attestations: Map<string, NodeAttestedAttributes>): void {
    for (const [node, attrs] of attestations) {
      const existing = this.profiles.get(node);
      this.profiles.set(node, {
        node,
        ...existing,
        trust_tier: attrs.trust_tier,
        role: attrs.role,
      });
    }
    if (attestations.size > 0) {
      console.log(`[registry] seeded attested profiles for ${attestations.size} node(s)`);
    }
  }

  /** Current profile for a node, or undefined if none is known. */
  get(node: string): NodeProfile | undefined {
    return this.profiles.get(node);
  }

  /** All known node profiles. */
  list(): NodeProfile[] {
    return Array.from(this.profiles.values());
  }

  delete(node: string): void {
    this.profiles.delete(node);
  }

  get size(): number {
    return this.profiles.size;
  }
}
