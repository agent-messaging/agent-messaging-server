/**
 * Registry doors added when the registry left the API's process (step 3 of
 * docs/agent-messaging-server-plan.md). Before, the API reached the registry
 * in process for deregister and the feed key, and wrote the registry's bucket
 * itself to set a listing; nothing answered presence.get.
 *
 *   mesh.admin.registry.listing      who a registration is shown to
 *                                    (handleAdminListing below). PRIVILEGED.
 *
 *   mesh.admin.registry.deregister   remove a registration on its owner's
 *                                    authority (account closure, the
 *                                    operator's loopback door). PRIVILEGED:
 *                                    only the platform's NATS user may publish
 *                                    on mesh.admin.>; the core's user and every
 *                                    minted agent credential may not
 *                                    (docs/nats-users-runbook.md).
 *   mesh.registry.presence_feed      the presence feed's owner key, or null
 *                                    when the feed is off (docs/presence-feed.md).
 *   mesh.presence.get                a node's presence (§9.6), from this
 *                                    registry's presence store, which is fed by
 *                                    signed heartbeats only (§10.10). With no
 *                                    node named, every node the store knows.
 */
import type { Envelope, Manifest } from "../../sdk.js";
import { createEnvelope, childSpan, ErrorCode } from "../../sdk.js";
import type { PresenceStore } from "../presence-store.js";

export const ADMIN_DEREGISTER = "mesh.admin.registry.deregister";
export const PRESENCE_FEED_KEY = "mesh.registry.presence_feed";
export const PRESENCE_GET = "mesh.presence.get";

const NKEY = /^U[A-Z2-7]{55}$/;

function answer(env: Envelope, serviceId: string, payload: unknown): Envelope {
  return createEnvelope({
    type: "respond",
    from: serviceId,
    to: env.from,
    in_reply_to: env.id,
    trace: childSpan(env.trace),
    payload,
  });
}

function refuse(env: Envelope, serviceId: string, message: string): Envelope {
  return createEnvelope({
    type: "respond",
    from: serviceId,
    to: env.from,
    in_reply_to: env.id,
    trace: childSpan(env.trace),
    error: { code: ErrorCode.INPUT_INVALID, message, retryable: false },
  });
}

/** mesh.admin.registry.deregister: { agent_id } → { ok: true, agent_id }. Idempotent. */
export async function handleAdminDeregister(
  env: Envelope,
  serviceId: string,
  deregisterOwned: (agentId: string) => Promise<void>,
): Promise<Envelope> {
  const agentId = (env.payload as { agent_id?: unknown } | undefined)?.agent_id;
  if (typeof agentId !== "string" || !NKEY.test(agentId)) return refuse(env, serviceId, "agent_id must be an agent public key (U...)");
  await deregisterOwned(agentId);
  console.log(`[registry] ${agentId.slice(0, 12)}… deregistered on its owner's authority (asked by ${env.from.slice(0, 12)}…)`);
  return answer(env, serviceId, { ok: true, agent_id: agentId });
}

export const ADMIN_LISTING = "mesh.admin.registry.listing";
const VISIBILITIES = new Set(["public", "organization", "private", "unlisted"]);

/**
 * mesh.admin.registry.listing: { agent_id, visibility, public_offerings? } →
 * { ok: true, visibility }. Sets who a stored registration is shown to, and,
 * when given, which declared offerings its public card shows. PRIVILEGED like
 * deregister. The platform decides whether a widening is allowed (the owner's
 * audience switch, AgentMesh's own agents listed for everyone); the registry
 * only stores it, as the API used to by writing this bucket itself.
 */
export async function handleAdminListing(
  env: Envelope,
  serviceId: string,
  kv: { get(k: string): Promise<{ value: Uint8Array; json<T>(): T } | null>; put(k: string, v: Uint8Array): Promise<unknown> },
  cache: Map<string, Manifest>,
): Promise<Envelope> {
  const p = (env.payload ?? {}) as { agent_id?: unknown; visibility?: unknown; public_offerings?: unknown };
  if (typeof p.agent_id !== "string" || !NKEY.test(p.agent_id)) return refuse(env, serviceId, "agent_id must be an agent public key (U...)");
  if (typeof p.visibility !== "string" || !VISIBILITIES.has(p.visibility)) return refuse(env, serviceId, "visibility must be public, organization, private or unlisted");
  const offerings = p.public_offerings === undefined ? undefined : p.public_offerings;
  if (offerings !== undefined && (!Array.isArray(offerings) || !offerings.every((o) => typeof o === "string"))) {
    return refuse(env, serviceId, "public_offerings must be a list of offering ids");
  }
  const entry = await kv.get(p.agent_id);
  if (!entry?.value.length) return refuse(env, serviceId, "this agent has not registered");
  const manifest = entry.json<Record<string, unknown>>();
  manifest.visibility = p.visibility;
  if (offerings !== undefined) {
    const pub = manifest.public && typeof manifest.public === "object" ? (manifest.public as Record<string, unknown>) : {};
    manifest.public = { ...pub, offerings };
  }
  await kv.put(p.agent_id, new TextEncoder().encode(JSON.stringify(manifest)));
  cache.set(p.agent_id, manifest as unknown as Manifest);
  return answer(env, serviceId, { ok: true, visibility: p.visibility });
}

export const ADMIN_FORGET_DESCRIPTOR = "mesh.admin.registry.forget_descriptor";

/** mesh.admin.registry.forget_descriptor: { agent_id } → { ok: true }. Drops
 *  the agent's current descriptor when its account closes. PRIVILEGED. */
export async function handleAdminForgetDescriptor(
  env: Envelope,
  serviceId: string,
  forget: (agentId: string) => Promise<void>,
): Promise<Envelope> {
  const agentId = (env.payload as { agent_id?: unknown } | undefined)?.agent_id;
  if (typeof agentId !== "string" || !NKEY.test(agentId)) return refuse(env, serviceId, "agent_id must be an agent public key (U...)");
  await forget(agentId);
  return answer(env, serviceId, { ok: true, agent_id: agentId });
}

/** mesh.registry.presence_feed: {} → { key }. */
export function handlePresenceFeedKey(env: Envelope, serviceId: string, key: () => string | null): Envelope {
  return answer(env, serviceId, { key: key() });
}

/** mesh.presence.get: { node } → { node, status, last_seen }, or {} → { nodes: [...] }. */
export function handlePresenceGet(env: Envelope, serviceId: string, presence: PresenceStore): Envelope {
  const node = (env.payload as { node?: unknown } | undefined)?.node;
  if (node === undefined || node === null || node === "") {
    return answer(env, serviceId, { nodes: presence.list() });
  }
  if (typeof node !== "string") return refuse(env, serviceId, "node must be a node public key");
  const p = presence.get(node);
  return answer(env, serviceId, { node, status: presence.status(node), last_seen: p?.last_seen ?? null });
}
