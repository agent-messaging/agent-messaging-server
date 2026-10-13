/**
 * Agent Descriptor subjects (Common Agent spec §6.7):
 *
 *   mesh.registry.descriptor.put             submit your own current descriptor
 *   mesh.registry.descriptor.get.<agentKey>  fetch the current one for a subject
 *   mesh.registry.descriptor.digest.<hex>    fetch any stored version by digest
 *
 * The descriptor rides base64 in the envelope payload in both directions,
 * because the digest is over exact bytes (§6) and JSON re-encoding through
 * the envelope would not preserve them. A put is announced as
 * mesh.event.registry.descriptor_updated so consumers can subscribe rather
 * than poll (§8.6).
 */
import type { BusMessage, Messaging } from "../../storage/index.js";
import type { Envelope } from "../../sdk.js";
import { createEnvelope, childSpan, ErrorCode, Subjects } from "../../sdk.js";
import { idOf, sealEnvelope, type ServiceIdentity } from "../../shared/handler.js";
import { DescriptorStore, validateDescriptor } from "../descriptor-store.js";

function refusal(env: Envelope, serviceId: string, message: string): Envelope {
  return createEnvelope({
    type: "respond",
    from: serviceId,
    to: env.from,
    in_reply_to: env.id,
    trace: childSpan(env.trace),
    error: { code: ErrorCode.INVALID_QUERY, message, retryable: false },
  });
}

export async function handleDescriptorPut(
  env: Envelope,
  store: DescriptorStore,
  nc: Messaging,
  serviceId: ServiceIdentity,
): Promise<Envelope> {
  const b64 = (env.payload as { descriptor?: unknown } | undefined)?.descriptor;
  if (typeof b64 !== "string" || b64.length === 0) {
    return refusal(env, idOf(serviceId), "payload.descriptor (base64) is required");
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  } catch {
    return refusal(env, idOf(serviceId), "payload.descriptor is not base64");
  }

  // The envelope sender is the authenticated identity (§4.5); the store gate
  // requires subject.id to be exactly that key.
  const why = validateDescriptor(bytes, env.from);
  if (why !== null) return refusal(env, idOf(serviceId), why);

  const { digest, replaced } = await store.put(env.from, bytes);

  if (replaced) {
    const eventEnv = createEnvelope({
      type: "emit",
      from: idOf(serviceId),
      payload: {
        domain: "registry",
        event_type: "descriptor_updated",
        data: { agent_id: env.from, digest },
      },
    });
    nc.publish(Subjects.event("registry.descriptor_updated"), sealEnvelope(eventEnv, serviceId));
  }

  console.log(`[registry] descriptor stored for ${env.from} (${digest.slice(0, 12)}…)`);
  return createEnvelope({
    type: "respond",
    from: idOf(serviceId),
    to: env.from,
    in_reply_to: env.id,
    trace: childSpan(env.trace),
    payload: { stored: true, digest, replaced },
  });
}

export async function handleDescriptorGet(
  env: Envelope,
  msg: BusMessage,
  store: DescriptorStore,
  serviceId: string,
): Promise<Envelope> {
  // mesh.registry.descriptor.get.<agentKey>
  const agentKey = msg.subject.split(".")[4];
  const found = agentKey ? await store.getCurrent(agentKey) : null;
  if (!found) {
    return createEnvelope({
      type: "respond",
      from: serviceId,
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: {
        code: ErrorCode.AGENT_UNAVAILABLE,
        message: `No descriptor stored for ${agentKey ?? "(missing key)"}`,
        retryable: false,
      },
    });
  }
  return createEnvelope({
    type: "respond",
    from: serviceId,
    to: env.from,
    in_reply_to: env.id,
    trace: childSpan(env.trace),
    payload: { descriptor: Buffer.from(found.bytes).toString("base64"), digest: found.digest },
  });
}

export async function handleDescriptorByDigest(
  env: Envelope,
  msg: BusMessage,
  store: DescriptorStore,
  serviceId: string,
): Promise<Envelope> {
  // mesh.registry.descriptor.digest.<hex>
  const digest = msg.subject.split(".")[4] ?? "";
  const found = await store.getByDigest(digest.toLowerCase());
  if (!found) {
    return createEnvelope({
      type: "respond",
      from: serviceId,
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: {
        code: ErrorCode.AGENT_UNAVAILABLE,
        message: "No descriptor stored under that digest",
        retryable: false,
      },
    });
  }
  return createEnvelope({
    type: "respond",
    from: serviceId,
    to: env.from,
    in_reply_to: env.id,
    trace: childSpan(env.trace),
    payload: { descriptor: Buffer.from(found.bytes).toString("base64"), digest: found.digest },
  });
}
