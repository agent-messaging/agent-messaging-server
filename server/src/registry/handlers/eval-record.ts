/**
 * Evaluation record subjects (Common Agent spec §9.4; the descriptor pipeline's
 * shape):
 *
 *   mesh.registry.eval.put                submit a signed verdict about a subject
 *   mesh.registry.eval.get.<subjectKey>   fetch the latest record for a subject
 *   mesh.registry.eval.digest.<hex>       fetch any stored record by digest
 *
 * The record rides base64 in the envelope payload in both directions, because
 * the digest is over exact bytes and JSON re-encoding through the envelope
 * would not preserve them. A put is announced as
 * mesh.event.registry.eval_record_updated so consumers can subscribe rather
 * than poll.
 */
import type { BusMessage, Messaging } from "../../storage/index.js";
import type { Envelope } from "../../sdk.js";
import { createEnvelope, childSpan, ErrorCode, Subjects } from "../../sdk.js";
import { idOf, sealEnvelope, type ServiceIdentity } from "../../shared/handler.js";
import { EvalRecordStore, validateEvalRecord } from "../eval-record-store.js";

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

export async function handleEvalRecordPut(
  env: Envelope,
  store: EvalRecordStore,
  nc: Messaging,
  serviceId: ServiceIdentity,
): Promise<Envelope> {
  const b64 = (env.payload as { record?: unknown } | undefined)?.record;
  if (typeof b64 !== "string" || b64.length === 0) {
    return refusal(env, idOf(serviceId), "payload.record (base64) is required");
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  } catch {
    return refusal(env, idOf(serviceId), "payload.record is not base64");
  }

  // The envelope sender is the authenticated identity (§4.5); the store gate
  // requires the record's signature to be BY exactly that key. The subject the
  // record names is somebody else — an evaluator signs verdicts about other
  // agents, which is the one place this differs from the descriptor put.
  const checked = validateEvalRecord(bytes, env.from);
  if (!checked.ok) return refusal(env, idOf(serviceId), checked.error);

  const { digest, replaced } = await store.put(checked.subject, bytes);

  if (replaced) {
    const eventEnv = createEnvelope({
      type: "emit",
      from: idOf(serviceId),
      payload: {
        domain: "registry",
        event_type: "eval_record_updated",
        data: { agent_id: checked.subject, evaluator: env.from, digest },
      },
    });
    nc.publish(Subjects.event("registry.eval_record_updated"), sealEnvelope(eventEnv, serviceId));
  }

  console.log(
    `[registry] eval record stored for ${checked.subject} by ${env.from} (${digest.slice(0, 12)}…)`,
  );
  return createEnvelope({
    type: "respond",
    from: idOf(serviceId),
    to: env.from,
    in_reply_to: env.id,
    trace: childSpan(env.trace),
    payload: { stored: true, digest, replaced, subject: checked.subject },
  });
}

export async function handleEvalRecordGet(
  env: Envelope,
  msg: BusMessage,
  store: EvalRecordStore,
  serviceId: string,
): Promise<Envelope> {
  // mesh.registry.eval.get.<subjectKey>
  const subjectKey = msg.subject.split(".")[4];
  const found = subjectKey ? await store.getCurrent(subjectKey) : null;
  if (!found) {
    return createEnvelope({
      type: "respond",
      from: serviceId,
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: {
        code: ErrorCode.AGENT_UNAVAILABLE,
        message: `No eval record stored for ${subjectKey ?? "(missing key)"}`,
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
    payload: { record: Buffer.from(found.bytes).toString("base64"), digest: found.digest },
  });
}

export async function handleEvalRecordByDigest(
  env: Envelope,
  msg: BusMessage,
  store: EvalRecordStore,
  serviceId: string,
): Promise<Envelope> {
  // mesh.registry.eval.digest.<hex>
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
        message: "No eval record stored under that digest",
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
    payload: { record: Buffer.from(found.bytes).toString("base64"), digest: found.digest },
  });
}
