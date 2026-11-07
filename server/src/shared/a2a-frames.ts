/**
 * What the platform reads from a frame of the A2A binding (wire version
 * 0.4.0, bindings/a2a.md): the facts a 0.3.0 envelope carried in its own
 * fields, which a 0.4.0 frame carries inside its A2A object instead (§4).
 *
 *   - the offering a call is for: the offering extension on the Message
 *     (§12.1), or during the 0.3.0 window the older keys `agentmesh.offering`
 *     and `agentmesh.skill` (the A2A Bridge §4.5); else the agent's one
 *     declared offering, which is the one it serves (§12.1);
 *   - the Task a frame concerns: a Message's `taskId`, the `id` of a
 *     CancelTask, GetTask or SubscribeToTask, the `taskId` of a push
 *     notification config, and on an answer the Task, status update or
 *     artifact update it carries;
 *   - whether a call asks for trial work (§12.8) and what it shows for an
 *     activity preview.
 *
 * The services that tap the bus (activity, the origin ledger, the A2A task
 * store) read these here, so they agree. Pure, except for the registry read
 * of {@link OfferingDirectory}.
 */
import type { Envelope } from "../sdk.js";
import type { KeyedStore } from "../storage/index.js";
import {
  EXT_CANCEL,
  EXT_OFFERING,
  isA2AFrame,
  isAcceptSignal,
  isExhausted,
  isTerminalState,
  isTrialMessage,
  readRequestPayload,
  readRespondPayload,
  type A2ACancel,
  type Message,
  type StreamResponse,
} from "../../../sdk-typescript/src/a2a/index.js";

/**
 * The offering recorded for an A2A operation that calls no offering of the
 * agent's. A cancel is the §10.8 cancel request, under the name the 0.3.0
 * wire gave it (`task.cancel`), so a cancel reads the same on both wires. The
 * reads, the push notification configs and the extended card are channel
 * work, not an offering's: they are recorded as `a2a.<method>`, a name no
 * agent declares, so none of them is ever priced as the agent's offering.
 */
export const CANCEL_OFFERING = "task.cancel";
export function operationOffering(method: string): string {
  return method === "CancelTask" ? CANCEL_OFFERING : `a2a.${method}`;
}

/** What one 0.4.0 request frame says, as the platform reads it. */
export interface A2ARequestFacts {
  method: string;
  /** The offering the call names, when it names one (see the header). A
   *  SendMessage naming none leaves it undefined; {@link OfferingDirectory}
   *  fills in the agent's one offering. */
  offering?: string;
  /** The Task the request concerns, when it names one. */
  taskId?: string;
  /** The Message a SendMessage carries. */
  message?: Message;
  /** A CancelTask's reason, as the cancel extension carries it (§12.6). */
  cancel?: A2ACancel;
  /** The starting Message asks for trial work (§12.8). */
  trial: boolean;
  /** What an activity row may preview of the call: the Message's parts, or
   *  the operation's parameters. */
  input: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The offering a Message names: the extension, else the older keys. */
export function offeringNamed(message: Message | undefined): string | undefined {
  const md = message?.metadata;
  if (!md) return undefined;
  const ext = (md[EXT_OFFERING] as { offering?: unknown } | undefined)?.offering;
  return str(ext) ?? str(md["agentmesh.offering"]) ?? str(md["agentmesh.skill"]);
}

/** The facts of a 0.4.0 request frame, or null when the frame is not one
 *  (a 0.3.0 envelope, a channel frame such as describe or knock, a sealed
 *  payload whose A2A object only its receiver can read). */
export function a2aRequestFacts(env: Envelope): A2ARequestFacts | null {
  if (!isA2AFrame(env) || env.type !== "request") return null;
  const req = readRequestPayload(env);
  if (!req || typeof req.method !== "string") return null;
  const method = req.method;
  const params = (req.params && typeof req.params === "object" ? req.params : {}) as Record<string, unknown>;
  if (method === "SendMessage" || method === "SendStreamingMessage") {
    const message = (params.message && typeof params.message === "object" ? params.message : undefined) as Message | undefined;
    const offering = offeringNamed(message);
    const taskId = str(message?.taskId);
    return {
      method,
      ...(offering ? { offering } : {}),
      ...(taskId ? { taskId } : {}),
      ...(message ? { message } : {}),
      trial: isTrialMessage(message),
      input: message?.parts ?? [],
    };
  }
  const taskId = str(params.id) && (method === "CancelTask" || method === "GetTask" || method === "SubscribeToTask")
    ? str(params.id)
    : str(params.taskId);
  const cancelData = method === "CancelTask" ? (params.metadata as Record<string, unknown> | undefined)?.[EXT_CANCEL] : undefined;
  return {
    method,
    offering: operationOffering(method),
    ...(taskId ? { taskId } : {}),
    ...(cancelData && typeof cancelData === "object" && typeof (cancelData as { reason?: unknown }).reason === "string"
      ? { cancel: cancelData as A2ACancel }
      : {}),
    trial: false,
    input: params,
  };
}

/** The A2A answer a 0.4.0 respond frame carries, or null (an error, the
 *  accept signal, a queued acknowledgement, a sealed payload). */
export function a2aAnswerOf(env: Envelope): StreamResponse | null {
  if (!isA2AFrame(env) || env.type !== "respond") return null;
  const a = readRespondPayload(env);
  const r = a?.result as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return null;
  // A SendMessage result and a stream event have the same members; a GetTask
  // or CancelTask result is the Task itself.
  if ("task" in r || "message" in r || "statusUpdate" in r || "artifactUpdate" in r) return r as StreamResponse;
  if (typeof r.id === "string" && r.status && typeof r.status === "object") return { task: r as unknown as StreamResponse["task"] };
  return null;
}

/** The Task id a 0.4.0 answer carries, if any. */
export function a2aAnswerTaskId(env: Envelope): string | undefined {
  const ev = a2aAnswerOf(env);
  return str(ev?.task?.id) ?? str(ev?.statusUpdate?.taskId) ?? str(ev?.artifactUpdate?.taskId);
}

/** The channel's accept signal at 0.4.0 (`{accepted: {}}`, bindings/a2a.md
 *  §4) or at 0.3.0 (`status: "accepted"`, §6.4a). */
export function isAccept(env: Envelope): boolean {
  if (env.error) return false;
  if ((env.payload as { status?: unknown } | undefined)?.status === "accepted") return true;
  return isA2AFrame(env) && isAcceptSignal(env);
}

/**
 * The offerings each agent declares, read from the registry and kept for a
 * minute, so a call that names no offering is recorded under the agent's
 * one offering (§12.1). An agent declaring several, or none, or one the
 * registry could not be read for, has no single offering: undefined.
 */
export class OfferingDirectory {
  private readonly cache = new Map<string, { at: number; ids: string[] | null; fallback?: string }>();
  private registry: KeyedStore | null = null;

  constructor(
    private readonly open: () => Promise<KeyedStore>,
    private readonly ttlMs = 60_000,
    private readonly max = 10_000,
  ) {}

  /** The agent's declared offering ids, or null when they cannot be read. */
  async offerings(agent: string): Promise<string[] | null> {
    const hit = this.cache.get(agent);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.ids;
    let ids: string[] | null = null;
    let fallback: string | undefined;
    try {
      const kv = (this.registry ??= await this.open());
      const entry = await kv.get(agent);
      if (entry && entry.operation !== "DEL" && entry.operation !== "PURGE" && entry.value?.length) {
        const m = entry.json<{ offerings?: unknown; default_offering?: unknown }>();
        ids = (Array.isArray(m?.offerings) ? m.offerings : [])
          .map((o) => (o as { id?: unknown })?.id)
          .filter((id): id is string => typeof id === "string" && id !== "");
        // §12.1 (0.4.2-draft): an agent with several may name a default.
        if (typeof m.default_offering === "string" && ids.includes(m.default_offering)) fallback = m.default_offering;
      } else {
        ids = [];
      }
    } catch {
      this.registry = null;
      ids = null;
    }
    this.cache.set(agent, { at: Date.now(), ids, ...(fallback ? { fallback } : {}) });
    if (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return ids;
  }

  /** The offering a call naming none goes to (§12.1): the agent's one
   *  declared offering, or the default an agent with several names in its
   *  manifest (`default_offering`), or undefined. */
  async single(agent: string): Promise<string | undefined> {
    const ids = await this.offerings(agent);
    if (ids && ids.length === 1) return ids[0];
    return this.cache.get(agent)?.fallback;
  }
}

/**
 * A Task's state as the 0.3.0 wire spells it (SPEC.md §6.8), the spelling
 * the platform's lifecycle events use (`mesh.event.task.<state>`, §7.1):
 * A2A's state in lower case without its prefix, and a canceled Task carrying
 * the budget extension's `exhausted` outcome is `exhausted`.
 */
export function wire030State(task: { status?: { state?: unknown }; metadata?: Record<string, unknown> } | undefined): string {
  const s = typeof task?.status?.state === "string" ? task.status.state : "TASK_STATE_UNSPECIFIED";
  if (isExhausted(task as never)) return "exhausted";
  return s.replace(/^TASK_STATE_/, "").toLowerCase();
}

/**
 * A 0.4.0 frame shown in the 0.3.0 fields the activity tap reads
 * (activity/activity-service.ts): a request's `payload.offering` (the
 * resolved offering, see {@link OfferingDirectory}), `payload.input` (what
 * the call carries, for the preview and its digest) and `task_id`; an
 * answer's `task_id`, and `payload.status` where it says how the exchange
 * ended (`completed`, or `failed` for a failed Task), so a §13.5 usage
 * receipt beside `payload.a2a` on the frame that answers the call or reports
 * the final state is lifted as on 0.3.0; the 0.4.0 accept signal as the
 * 0.3.0 one. `inReplyTo` makes a reply (§12.9) read as the inbox-mode answer
 * to the request it names. The frame's id, parties, `ts`, `meta` and
 * `payload.usage` stay as they are; the view is never sent or verified.
 * A frame that is not a 0.4.0 frame is returned as it is.
 */
export function activityView(env: Envelope, opts: { offering?: string; inReplyTo?: string } = {}): Envelope {
  if (!isA2AFrame(env)) return env;
  const payload = (env.payload && typeof env.payload === "object" ? env.payload : {}) as Record<string, unknown>;
  if (env.type === "request") {
    const facts = a2aRequestFacts(env);
    if (!facts) return env;
    const offering = opts.offering ?? facts.offering;
    return {
      ...env,
      payload: { ...payload, ...(offering ? { offering } : {}), input: facts.input },
      ...(facts.taskId ? { task_id: facts.taskId } : {}),
      ...(opts.inReplyTo && !env.in_reply_to ? { in_reply_to: opts.inReplyTo } : {}),
    } as Envelope;
  }
  if (env.type !== "respond") return env;
  if (isAccept(env)) return { ...env, payload: { ...payload, status: "accepted" } } as Envelope;
  const ev = a2aAnswerOf(env);
  if (!ev) return env;
  const taskId = str(ev.task?.id) ?? str(ev.statusUpdate?.taskId) ?? str(ev.artifactUpdate?.taskId);
  const state = ev.task?.status?.state ?? ev.statusUpdate?.status?.state;
  const ended = ev.message && !ev.task ? "completed" : isTerminalState(state) ? (state === "TASK_STATE_FAILED" ? "failed" : "completed") : undefined;
  return {
    ...env,
    ...(taskId ? { task_id: taskId } : {}),
    ...(ended ? { payload: { ...payload, status: ended } } : {}),
  } as Envelope;
}
