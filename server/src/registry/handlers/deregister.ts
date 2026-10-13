import type { Messaging } from "../../storage/index.js";
import type { KeyedStore } from "../../storage/index.js";
import type { Envelope, Manifest } from "../../sdk.js";
import {
  createEnvelope,
  childSpan,
  Subjects,
  ErrorCode,
} from "../../sdk.js";
import { idOf, sealEnvelope, type ServiceIdentity } from "../../shared/handler.js";
import type { ClearGuardFn, InboxBuffer } from "../inbox-buffer.js";

/**
 * Remove ONE agent's registration and everything the registry hangs off it: the
 * directory entry, the in-memory cache, the offline-delivery mailbox, the EXT-6
 * guard entry, and the signed lifecycle event downstream state follows.
 *
 * This is the single removal path, extracted so there is exactly one. Two
 * callers reach it with two different authorities:
 *
 *   - `handleDeregister` below, on the AGENT's own authority (`env.from`, which
 *     `decode` has already verified against the envelope signature);
 *   - `RegistryService.deregisterOwned`, on the ACCOUNT owner's authority, when
 *     the account console closes an account and the agents' keys are not
 *     available to sign for themselves.
 *
 * A second, parallel removal would be the bug: whichever copy forgot the
 * mailbox, the guard entry or the event would leave state describing an agent
 * that no longer exists, which is exactly how 25 of the reference instance's 27
 * guard entries came to belong to agents with no manifest.
 *
 * Purges rather than deletes. `mesh_registry` is created with `history: 5`
 * (registry-service.ts), so a delete leaves up to five prior manifests — name,
 * description, owner key, encryption key, hosting node, and the EXT-1 device
 * fields — readable off the backing stream after the agent is "gone". The
 * reaper already purged; deregistration did not, so the removal a person asks
 * for was weaker than the one that happens to them automatically.
 */
export async function removeRegistration(
  agentId: string,
  kv: KeyedStore,
  nc: Messaging,
  serviceId: ServiceIdentity,
  cache: Map<string, Manifest>,
  inboxBuffer?: InboxBuffer,
  clearGuard?: ClearGuardFn,
): Promise<void> {
  await kv.purge(agentId);
  cache.delete(agentId);
  // The offline-delivery buffer follows its registration (§16.4).
  if (inboxBuffer) void inboxBuffer.remove(agentId);
  // So does the EXT-6 guard entry. The entry is a claim that this agent has
  // stopped listening on its public inbox and that admission is filtering on its
  // behalf; a deregistered agent has stopped listening on both, and re-registers
  // as an UNGUARDED agent unless it asks again. Left behind, the entry outlives
  // the fact it describes: admission keeps relaying to a private subject nobody
  // serves, and a mailbox recreated on the next registration is pointed at that
  // same subject — while the agent, on its public inbox, takes everything the
  // filter was supposed to stop. (25 of the 27 entries on the reference instance
  // belong to agents with no manifest at all: that is what write-only state
  // produces over a few weeks.) Best-effort, like the buffer: losing a
  // registration must not fail on the guard bucket.
  if (clearGuard) void clearGuard(agentId).catch(() => undefined);

  // Emit deregistration event, SIGNED like every other registry event
  // (§4.5): consumers decode() before acting, so an unsigned removal event was
  // dropped with IDENTITY_MISMATCH and their state drifted toward showing a
  // deregistered agent as present — fail-open on exactly the half of the
  // lifecycle that takes access away.
  //
  // The catalog subscribes this event and purges its entry for the agent
  // (catalog-service.ts). Until it did, the entry — agent id, name,
  // description — outlived every registration it described, forever.
  const eventEnv = createEnvelope({
    type: "emit",
    from: idOf(serviceId),
    payload: {
      domain: "registry",
      event_type: "agent_deregistered",
      data: { agent_id: agentId },
    },
  });
  nc.publish(Subjects.event("registry.agent_deregistered"), sealEnvelope(eventEnv, serviceId));

  console.log(`[registry] deregistered agent: ${agentId}`);
}

export async function handleDeregister(
  env: Envelope,
  kv: KeyedStore,
  nc: Messaging,
  serviceId: ServiceIdentity,
  cache: Map<string, Manifest>,
  inboxBuffer?: InboxBuffer,
  clearGuard?: ClearGuardFn,
): Promise<Envelope> {
  const agentId = env.from;

  // Check if agent exists
  const entry = await kv.get(agentId);
  if (!entry) {
    return createEnvelope({
      type: "respond",
      from: idOf(serviceId),
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: {
        code: ErrorCode.AGENT_UNAVAILABLE,
        message: `Agent ${agentId} not found in registry`,
        retryable: false,
      },
    });
  }

  await removeRegistration(agentId, kv, nc, serviceId, cache, inboxBuffer, clearGuard);

  return createEnvelope({
    type: "respond",
    from: idOf(serviceId),
    to: env.from,
    in_reply_to: env.id,
    trace: childSpan(env.trace),
    payload: { status: "deregistered", agent_id: agentId },
  });
}
