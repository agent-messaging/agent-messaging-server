import type { BusMessage } from "../../storage/index.js";
import type { KeyedStore } from "../../storage/index.js";
import type { Envelope, Manifest } from "../../sdk.js";
import { createEnvelope, childSpan, ErrorCode } from "../../sdk.js";
import { withEndpoints } from "../endpoints.js";
import { AGENT_KEY_REVOKED, type AgentKeyRevocationLookup } from "../../shared/agent-key-revocations.js";
import type { AgentStatusLookup } from "../../shared/agent-status.js";
import { withIdentitySource, type IdentitySourceView } from "../identity-source-view.js";

export async function handleGet(
  env: Envelope,
  msg: BusMessage,
  kv: KeyedStore,
  serviceId: string,
  cache: Map<string, Manifest>,
  revocations?: AgentKeyRevocationLookup,
  /** The kill switch's per-agent status (shared/agent-status.ts). */
  statuses?: AgentStatusLookup,
  /** Where each agent's identity came from (§9.7), joined on read. */
  sources?: IdentitySourceView | null,
): Promise<Envelope> {
  // Extract agent_id from subject: mesh.registry.get.{agent_id}
  const parts = msg.subject.split(".");
  const agentId = parts[3];

  if (!agentId) {
    return createEnvelope({
      type: "respond",
      from: serviceId,
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: {
        code: ErrorCode.INVALID_QUERY,
        message: "Missing agent_id in subject",
        retryable: false,
      },
    });
  }

  // §5.3: a revoked agent key is answered as revoked, before anything else and
  // whatever its registration says, because this is the question receivers ask
  // before they accept a message signed by it. A store that cannot be read
  // answers as before; receivers keep the keys they already know are revoked.
  const revoked = revocations ? await revocations.get(agentId).catch(() => null) : null;
  // The kill switch (§9 registry status): paused or terminated. A status that
  // cannot be read is left out, never answered as "active".
  const stopped = statuses ? await statuses.get(agentId).catch(() => null) : null;
  if (revoked || stopped?.status === "terminated") {
    // A terminated agent's key is revoked with it, so the answer keeps the
    // reason every receiver already refuses on (agent_key_revoked) and says
    // it was terminated beside it.
    return createEnvelope({
      type: "respond",
      from: serviceId,
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: {
        code: ErrorCode.UNAUTHORIZED,
        message: stopped?.status === "terminated"
          ? `Agent ${agentId} was terminated; it does not come back`
          : `Agent key ${agentId} has been revoked`,
        details: {
          reason: AGENT_KEY_REVOKED,
          revoked_at: revoked?.at ?? stopped?.since,
          ...(revoked?.replaced_by ? { replaced_by: revoked.replaced_by } : {}),
          ...(stopped?.status === "terminated" ? { status: "terminated", terminated_at: stopped.since } : {}),
        },
        retryable: false,
      },
    });
  }

  const entry = await kv.get(agentId);
  // A deregistered agent leaves a delete marker, which is absent too
  // (storage/types.ts): reading it as a manifest answered INTERNAL_ERROR.
  if (!entry || entry.operation === "DEL" || entry.operation === "PURGE" || entry.value?.length === 0) {
    return createEnvelope({
      type: "respond",
      from: serviceId,
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: {
        code: ErrorCode.AGENT_UNAVAILABLE,
        message: `Agent ${agentId} not found`,
        retryable: false,
      },
    });
  }

  // Stamp `endpoints` on read (§8.2/§14.4): records stored before the field
  // existed lack it in KV, and every manifest the registry serves must carry
  // the resolved subjects.
  // The identity source is the key chain's record (§9.7), never the registration's.
  const manifest = withIdentitySource(withEndpoints(entry.json<Manifest>()), sources ?? null);

  // Private manifests are returned only to the owner. Report "not found" to
  // everyone else so their existence isn't revealed. (Unlisted stays reachable
  // by ID — that's the point of unlisted.)
  if (manifest.visibility === "private") {
    const callerOwner = cache.get(env.from)?.owner;
    if (callerOwner === undefined || manifest.owner !== callerOwner) {
      return createEnvelope({
        type: "respond",
        from: serviceId,
        to: env.from,
        in_reply_to: env.id,
        trace: childSpan(env.trace),
        error: {
          code: ErrorCode.AGENT_UNAVAILABLE,
          message: `Agent ${agentId} not found`,
          retryable: false,
        },
      });
    }
  }

  return createEnvelope({
    type: "respond",
    from: serviceId,
    to: env.from,
    in_reply_to: env.id,
    trace: childSpan(env.trace),
    // A paused agent is still found, so a sender learns it is paused and that
    // mail waits, and a receiver refuses what it sends (§5.3).
    payload: stopped?.status === "paused" ? { ...manifest, status: "paused", status_since: stopped.since } : manifest,
  });
}
