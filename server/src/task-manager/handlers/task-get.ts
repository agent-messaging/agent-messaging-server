import type { BusMessage } from "../../storage/index.js";
import type { KeyedStore } from "../../storage/index.js";
import type { Envelope, Task } from "../../sdk.js";
import { createEnvelope, childSpan, ErrorCode } from "../../sdk.js";
import { isPartyToTask, reportRefusal } from "../task-parties.js";
import { redactForRequester, type OriginLedger } from "../origin.js";

export async function handleTaskGet(
  env: Envelope,
  msg: BusMessage,
  kv: KeyedStore,
  serviceId: string,
  /** The origin ledger: projected onto the record at read time (origin.ts
   *  `view`), so evidence whose mirror was lost still shows. */
  origins?: OriginLedger,
): Promise<Envelope> {
  // Extract task_id from subject: mesh.task.get.{task_id}
  const parts = msg.subject.split(".");
  const taskId = parts[3];

  if (!taskId) {
    return createEnvelope({
      type: "respond",
      from: serviceId,
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: {
        code: ErrorCode.TASK_NOT_FOUND,
        message: "Missing task_id in subject",
        retryable: false,
      },
    });
  }

  const entry = await kv.get(taskId);
  // A removed task leaves a delete marker, which is absent too (storage/types.ts).
  if (!entry || entry.operation === "DEL" || entry.operation === "PURGE" || entry.value?.length === 0) {
    return createEnvelope({
      type: "respond",
      from: serviceId,
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: {
        code: ErrorCode.TASK_NOT_FOUND,
        message: `Task ${taskId} not found`,
        retryable: false,
      },
    });
  }

  const task = entry.json<Task>();

  // The read half of the same defect. This returned the WHOLE record — every
  // history envelope with its payloads, and every artifact, which §7.5 defines
  // as the task's deliverables — to whoever asked, with no identity check at
  // all. `mesh.task.get.*` is inside the `pub mesh.task.>` every durable
  // credential holds (keychain/cred-template.ts), and task ids are broadcast on
  // `mesh.event.task.*` and visible on `mesh.task.>`, so this was every agent's
  // task history and output readable by every other agent. The task id in
  // `env.payload.task_id` is ignored here on purpose — the subject is the id, and
  // the identity comes from the signature-verified `env.from`, never the payload.
  //
  // UNAUTHORIZED rather than TASK_NOT_FOUND. It does confirm the id exists, but
  // that is not a secret worth protecting by lying: anyone with the credential
  // can already enumerate live task ids off `mesh.task.>` and `mesh.event.task.*`
  // — while a false "not found" would send a genuine party debugging an expiry
  // or a typo instead of a permission.
  if (!isPartyToTask(task, env.from)) {
    reportRefusal(`mesh.task.get.${taskId}`, env.from, `it is not a party to this task.`);
    return createEnvelope({
      type: "respond",
      from: serviceId,
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: {
        code: ErrorCode.UNAUTHORIZED,
        message:
          `Task ${taskId} may only be read by its requester or its responder.`,
        retryable: false,
      },
    });
  }

  // The ledger's evidence, projected at read time (never written here). Then
  // what this party may see: the responder sees everything; the requester
  // sees its own origin, contests and cancel attribution, never what the
  // server recorded about other askers (origin.ts `redactForRequester`).
  let seen = (origins ? await origins.view(task as unknown as Record<string, unknown>, taskId) : task) as unknown as Task;
  if (env.from !== task.responder) seen = redactForRequester(seen as unknown as Record<string, unknown>) as unknown as Task;

  return createEnvelope({
    type: "respond",
    from: serviceId,
    to: env.from,
    in_reply_to: env.id,
    trace: childSpan(env.trace),
    payload: seen,
  });
}
