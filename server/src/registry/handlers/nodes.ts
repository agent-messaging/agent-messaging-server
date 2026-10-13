import type { Envelope, Manifest, NodeDeclaredProfile } from "../../sdk.js";
import { createEnvelope, childSpan } from "../../sdk.js";
import type { PresenceStore } from "../presence-store.js";
import type { NodeProfileStore } from "../node-profile-store.js";

/** One row of the operator node inventory: durable profile (§9.7) joined with
 *  ephemeral presence (§9.6) and a live agent count derived from the registry. */
export interface NodeRecord {
  node: string;
  trust_tier?: string;
  role?: string;
  availability_class?: string;
  reachability?: string;
  /** EXT-1 device-profile declared keys. */
  platform?: string;
  os_version?: string;
  client?: string;
  device_class?: string;
  status: string;            // current presence (staleness-adjusted)
  last_seen: number | null;
  agent_count: number;       // agents currently vouched by this node
  /** The DISCOVERABLE agents this node vouches (id + name, capped) — what
   *  relates a node to a person: resolve an agent, get its operator. Sandbox
   *  agents are counted, never named (discovery hides them on purpose). */
  agents: Array<{ id: string; name: string }>;
  sandbox_agents: number;
}

export interface NodesResult {
  nodes: NodeRecord[];
  total: number;
}

/**
 * `mesh.registry.nodes.list` — operator node inventory. Unions every node id
 * known from the profile store, the presence store, and the manifests it
 * vouches, then joins profile + presence + agent count per node. Read-only.
 */
export async function handleNodesList(
  env: Envelope,
  serviceId: string,
  cache: Map<string, Manifest>,
  presence: PresenceStore,
  profiles: NodeProfileStore,
): Promise<Envelope> {
  const ids = new Set<string>();
  for (const p of profiles.list()) ids.add(p.node);
  for (const pr of presence.list()) ids.add(pr.node);

  const agentsByNode = new Map<string, Array<{ id: string; name: string }>>();
  const sandboxByNode = new Map<string, number>();
  // The profile store is in-memory and empties on every service restart; the
  // persisted manifests carry the same declared profile (§9.7 rides in the
  // node vouch), so they are the durable fallback — without it, the Client
  // column blanks out for every node until it happens to re-register.
  const declaredByNode = new Map<string, NodeDeclaredProfile>();
  for (const m of cache.values()) {
    const id = m.node?.id;
    if (!id) continue;
    ids.add(id);
    if (m.sandbox) {
      sandboxByNode.set(id, (sandboxByNode.get(id) ?? 0) + 1);
    } else {
      const list = agentsByNode.get(id) ?? [];
      if (list.length < 12) list.push({ id: m.id, name: m.name });
      agentsByNode.set(id, list);
    }
    if (m.node?.profile && !declaredByNode.has(id)) declaredByNode.set(id, m.node.profile);
  }

  const nodes: NodeRecord[] = Array.from(ids).map((id) => {
    const prof = profiles.get(id);
    const dec = declaredByNode.get(id);
    const pres = presence.get(id);
    const named = agentsByNode.get(id) ?? [];
    const sandbox = sandboxByNode.get(id) ?? 0;
    return {
      node: id,
      trust_tier: prof?.trust_tier,
      role: prof?.role,
      availability_class: prof?.availability_class ?? dec?.availability_class,
      reachability: prof?.reachability ?? dec?.reachability,
      platform: prof?.platform ?? dec?.platform,
      os_version: prof?.os_version ?? dec?.os_version,
      client: prof?.client ?? dec?.client,
      device_class: prof?.device_class ?? dec?.device_class,
      status: presence.status(id),
      last_seen: pres?.last_seen ?? null,
      agent_count: named.length + sandbox,
      agents: named,
      sandbox_agents: sandbox,
    };
  });

  // Online first, then by agents hosted — the operator's likely priority order.
  nodes.sort((a, b) => {
    const ao = a.status === "offline" ? 0 : 1;
    const bo = b.status === "offline" ? 0 : 1;
    return bo - ao || b.agent_count - a.agent_count;
  });

  console.log(`[registry] nodes.list returned ${nodes.length} node(s)`);

  const result: NodesResult = { nodes, total: nodes.length };
  return createEnvelope({
    type: "respond",
    from: serviceId,
    to: env.from,
    in_reply_to: env.id,
    trace: childSpan(env.trace),
    payload: result,
  });
}
