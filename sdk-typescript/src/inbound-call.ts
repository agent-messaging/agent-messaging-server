/**
 * One view of an inbound call, whatever wire it arrived on.
 *
 * A 0.3.0 request carries what the node's gates read in its own fields: the
 * offering and input in `payload`, the budget in the envelope's `budget`, the
 * trial mark in `payload.trial`, the receipt level in `payload.config`. A
 * 0.4.0 frame (bindings/a2a.md) carries the same facts inside its A2A object
 * and its extensions (§12). The node's gates (the trial gate, the allowance,
 * the agreement and funds hold, the admit hook, the person surface) and a
 * host's own admission code read this view, so neither has to know which
 * wire a call came on, and no 0.4.0 call can pass a gate by carrying its
 * facts where a 0.3.0 reader does not look.
 */
import type { Budget, Envelope } from "./types/envelope.js";
import { audienceOf } from "./audience.js";
import { receiptLevelOf, type ReceiptLevel } from "./receipt.js";
import { A2A_WIRE_VERSION, readRequestPayload } from "./a2a/binding.js";
import { budgetFromA2A, isForPerson, isTrialMessage } from "./a2a/extensions.js";
import { isValidBudgetBlock } from "./a2a/readings.js";
import { EXT_BUDGET } from "./a2a/extensions.js";
import type { Message } from "./a2a/types.js";

export interface InboundCall {
  /** The wire version the call arrived in. */
  wire: "0.3.0" | "0.4.0";
  /** On 0.4.0, the A2A operation (`SendMessage`, `CancelTask`, ...). */
  method?: string;
  /** The verified sender. */
  from: string;
  /** The request envelope's id. */
  requestId: string;
  /** The offering the call names: `payload.offering` (or `skill`) on 0.3.0,
   *  the offering extension (or the older keys) on 0.4.0; "" when it names
   *  none. The node routes a 0.4.0 call naming none to its one offering. */
  offering: string;
  /** What the call carries for the work: `payload.input` on 0.3.0; on 0.4.0
   *  the Message's parts read as a 0.3.0 input (a lone data part's data,
   *  else `{ text, data?, files? }`). */
  input: unknown;
  /** The A2A Message, on a 0.4.0 SendMessage. */
  message?: Message;
  /** The budget (§7.7), in the 0.3.0 shape: the envelope's `budget`, or the
   *  budget extension on the Message. Absent when none was sent. */
  budget?: Budget;
  /** A budget was sent but is not well formed: the node refuses the call. */
  budgetMalformed?: true;
  /** The call asks for trial work (Common Agent §7.7): `payload.trial` on
   *  0.3.0, the trial extension on 0.4.0 (§12.8). */
  trial: boolean;
  /** Who the call is for (SPEC §5.7): `meta.audience`, and on 0.4.0 the
   *  audience extension too; the two disagreeing reads as the person. */
  audience: "agent" | "person";
  /** The receipt level asked for (EXT-15): `payload.config.receipt` on
   *  0.3.0, the receipts extension on the starting Message on 0.4.0. */
  receipt: ReceiptLevel | null;
  /** The Task the call continues, when it names one. */
  taskId?: string;
  /** The conversation the call belongs to. */
  contextId?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** A Message's parts as a 0.3.0 handler's input (bindings/a2a.md §14). */
export function inputOfMessage(message: Message | undefined): unknown {
  const parts = message?.parts ?? [];
  const data = parts.filter((p) => p.data !== undefined);
  if (data.length === 1 && parts.length === 1) return data[0].data;
  const text = parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
  const files = parts.filter((p) => typeof p.url === "string" || typeof p.raw === "string");
  return {
    ...(text ? { text } : {}),
    ...(data.length ? { data: data.map((p) => p.data) } : {}),
    ...(files.length ? { files } : {}),
  };
}

/** The offering a Message names: the offering extension, else the older
 *  keys of the transition window. */
function offeringNamed(message: Message | undefined): string | undefined {
  const md = message?.metadata;
  if (!md) return undefined;
  const ext = (md["https://agentmessaging.ai/extensions/offering/v1"] as { offering?: unknown } | undefined)?.offering;
  return str(ext) ?? str(md["agentmesh.offering"]) ?? str(md["agentmesh.skill"]);
}

/** The view of one request envelope (already verified, and opened when it
 *  came sealed). */
export function inboundCallOf(env: Envelope): InboundCall {
  const meta = audienceOf(env);
  if (env.v === A2A_WIRE_VERSION) {
    const req = readRequestPayload(env);
    const method = typeof req?.method === "string" ? req.method : undefined;
    const params = (req?.params && typeof req.params === "object" ? req.params : {}) as Record<string, unknown>;
    const message = (params.message && typeof params.message === "object" ? params.message : undefined) as Message | undefined;
    const rawBudget = message?.metadata?.[EXT_BUDGET];
    const budgetOk = rawBudget !== undefined && isValidBudgetBlock(rawBudget);
    const taskId = str(message?.taskId) ?? (method && method !== "SendMessage" && method !== "SendStreamingMessage" ? str(params.id) ?? str(params.taskId) : undefined);
    return {
      wire: "0.4.0",
      ...(method ? { method } : {}),
      from: env.from,
      requestId: env.id,
      offering: method === "CancelTask" ? "task.cancel" : offeringNamed(message) ?? "",
      input: message ? inputOfMessage(message) : params,
      ...(message ? { message } : {}),
      ...(budgetOk ? { budget: budgetFromA2A(rawBudget) } : {}),
      ...(rawBudget !== undefined && !budgetOk ? { budgetMalformed: true as const } : {}),
      trial: isTrialMessage(message),
      audience: meta === "agent" && !isForPerson(message) ? "agent" : "person",
      receipt: receiptLevelOf(env.payload),
      ...(taskId ? { taskId } : {}),
      ...(str(message?.contextId) ? { contextId: message!.contextId } : {}),
    };
  }
  const p = (env.payload && typeof env.payload === "object" ? env.payload : {}) as { offering?: unknown; skill?: unknown; input?: unknown; trial?: unknown };
  return {
    wire: "0.3.0",
    from: env.from,
    requestId: env.id,
    offering: str(p.offering) ?? str(p.skill) ?? "",
    input: p.input,
    ...(env.budget !== undefined && env.budget !== null ? { budget: env.budget } : {}),
    trial: p.trial === true,
    audience: meta === "agent" ? "agent" : "person",
    receipt: receiptLevelOf(env.payload),
    ...(env.task_id ? { taskId: env.task_id } : {}),
    ...(env.context_id ? { contextId: env.context_id } : {}),
  };
}
