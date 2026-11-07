/**
 * A2A over Agent Messaging: the frames (bindings/a2a.md §4 through §8).
 *
 * An A2A operation is a `request` frame whose payload is
 * `{a2a: {method, params}}`; each answer is a `respond` frame whose payload is
 * `{a2a: {result}}`, or an `error` (§9). Frames say wire version `0.4.0` and
 * never carry the envelope fields `task_id`, `context_id` or `artifacts`: the
 * Task id, the context id and the artifacts are A2A's and live in the A2A
 * object. Pure functions; no I/O.
 */
import type { Envelope } from "../types/envelope.js";
import { MeshError, ErrorCode } from "../types/errors.js";
import { canonicalJSON } from "../internal/identity.js";
import type { A2AMethod, StreamResponse, Task, TaskState } from "./types.js";

/** The binding's URI (§3): an Agent Card's `protocolBinding`, and what an
 *  agent lists in its manifest's `capabilities` when it serves A2A. */
export const A2A_BINDING_URI = "https://agentmessaging.ai/bindings/a2a/v1";

/** The wire version of a binding frame (§4, §14). 0.3.0 envelopes keep the
 *  SDK's `PROTOCOL_VERSION`. */
export const A2A_WIRE_VERSION = "0.4.0";

/** The A2A version this binding carries (§3 `protocolVersion`). */
export const A2A_PROTOCOL_VERSION = "1.0";

/** The eleven operations, spelled as A2A spells them (§5). */
export const A2A_METHODS: readonly A2AMethod[] = [
  "SendMessage",
  "SendStreamingMessage",
  "GetTask",
  "ListTasks",
  "CancelTask",
  "SubscribeToTask",
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
  "GetExtendedAgentCard",
];

/** The operations whose answers are stream events (§8). */
export const STREAMING_METHODS: ReadonlySet<A2AMethod> = new Set(["SendStreamingMessage", "SubscribeToTask"]);

export function isA2AMethod(v: unknown): v is A2AMethod {
  return typeof v === "string" && (A2A_METHODS as readonly string[]).includes(v);
}

/** A2A's terminal states (A2A §4.1.3): a Task in one never moves again. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

/** A2A's interrupted states: the Task waits on the client. A stream ends on
 *  one of these as on a terminal state (§8). */
export const INTERRUPTED_STATES: ReadonlySet<TaskState> = new Set([
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
]);

export function isTerminalState(s: unknown): boolean {
  return TERMINAL_STATES.has(s as TaskState);
}

/** Does this state end a stream (§8 termination)? */
export function endsStream(s: unknown): boolean {
  return TERMINAL_STATES.has(s as TaskState) || INTERRUPTED_STATES.has(s as TaskState);
}

// ─── Frame payloads ─────────────────────────────────────────────────

export interface A2ARequestPayload {
  a2a: { method: A2AMethod; params: unknown };
}

export interface A2ARespondPayload {
  a2a: { result: unknown; seq?: number; final?: boolean };
}

export function requestPayload(method: A2AMethod, params: unknown): A2ARequestPayload {
  return { a2a: { method, params: params ?? {} } };
}

/** A respond frame's payload. `seq` and `final` are set on stream events
 *  only (§8). */
export function respondPayload(result: unknown, stream?: { seq: number; final: boolean }): A2ARespondPayload {
  return {
    a2a: {
      result,
      ...(stream ? { seq: stream.seq, ...(stream.final ? { final: true } : {}) } : {}),
    },
  };
}

/** Is this envelope a binding frame: wire version 0.4.0? */
export function isA2AFrame(env: Pick<Envelope, "v">): boolean {
  return env.v === A2A_WIRE_VERSION;
}

/** The envelope fields a 0.4.0 frame must not carry (§4). */
export const FORBIDDEN_FRAME_FIELDS = ["task_id", "context_id", "artifacts"] as const;

/**
 * §4: "A receiver MUST refuse a 0.4.0 frame that carries them with
 * INVALID_ENVELOPE." Returns the refusal, or null for a frame that is fine.
 * Presence is what counts, null included: the field is not part of a 0.4.0
 * envelope at all.
 */
export function forbiddenFieldsRefusal(env: Envelope): MeshError | null {
  if (!isA2AFrame(env)) return null;
  const e = env as unknown as Record<string, unknown>;
  const present = FORBIDDEN_FRAME_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(e, f));
  if (present.length === 0) return null;
  return new MeshError(
    ErrorCode.INVALID_ENVELOPE,
    `A 0.4.0 frame must not carry ${present.join(", ")}: the Task id, the context id and the artifacts ` +
      `live in the A2A object (A2A binding §4).`,
    { retryable: false, details: { reason: "a2a_forbidden_field", fields: present } },
  );
}

/** The A2A request a frame carries, or null when the payload is not one. */
export function readRequestPayload(env: Envelope): { method: unknown; params: unknown } | null {
  const p = env.payload as { a2a?: { method?: unknown; params?: unknown } } | undefined;
  if (!p || typeof p !== "object" || !p.a2a || typeof p.a2a !== "object") return null;
  return { method: p.a2a.method, params: p.a2a.params ?? {} };
}

/** The A2A answer a respond frame carries, or null when the frame carries
 *  none (an error, or the channel's accept signal). */
export function readRespondPayload(env: Envelope): { result: unknown; seq?: number; final: boolean } | null {
  const p = env.payload as { a2a?: { result?: unknown; seq?: unknown; final?: unknown } } | undefined;
  if (!p || typeof p !== "object" || !p.a2a || typeof p.a2a !== "object") return null;
  if (!("result" in p.a2a)) return null;
  return {
    result: p.a2a.result,
    ...(typeof p.a2a.seq === "number" && Number.isInteger(p.a2a.seq) && p.a2a.seq >= 0 ? { seq: p.a2a.seq } : {}),
    final: p.a2a.final === true,
  };
}

/** The channel's accept signal on a 0.4.0 frame (§11): `{accepted: {...}}`
 *  with no `a2a` member. It precedes the first A2A answer and answers
 *  nothing. */
export function isAcceptSignal(env: Envelope): boolean {
  if (env.error) return false;
  const p = env.payload as Record<string, unknown> | undefined;
  return !!p && typeof p === "object" && p.accepted !== undefined && p.a2a === undefined;
}

// ─── Service parameters (§7) ────────────────────────────────────────

/** The most `meta.a2a` may weigh, in canonical JSON (§7). */
export const SERVICE_PARAMS_MAX_BYTES = 8 * 1024;

/**
 * Check and normalize service parameters for `meta.a2a`: string keys, string
 * values, at most 8 KiB in canonical JSON. Throws INVALID_ENVELOPE otherwise.
 */
export function serviceParams(params: Record<string, string> | undefined): Record<string, string> | undefined {
  if (params === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "string") {
      throw new MeshError(ErrorCode.INVALID_ENVELOPE, `Service parameter ${k} must be a string (A2A binding §7).`);
    }
    out[k] = v;
  }
  const size = new TextEncoder().encode(canonicalJSON(out)).length;
  if (size > SERVICE_PARAMS_MAX_BYTES) {
    throw new MeshError(
      ErrorCode.INVALID_ENVELOPE,
      `meta.a2a is ${size} bytes in canonical JSON; the limit is ${SERVICE_PARAMS_MAX_BYTES} (A2A binding §7).`,
    );
  }
  return out;
}

/** The service parameters a frame carries, or {} (§7). Values that are not
 *  strings are dropped. */
export function readServiceParams(env: Envelope): Record<string, string> {
  const a2a = (env.meta as Record<string, unknown> | undefined)?.a2a;
  if (!a2a || typeof a2a !== "object" || Array.isArray(a2a)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a2a as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

/** One service parameter by name, compared without regard to case, as HTTP
 *  header names are (§7). */
export function serviceParam(params: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(params)) if (k.toLowerCase() === want) return v;
  return undefined;
}

/** The extensions a client activated in `A2A-Extensions` (§7, §12). */
export function activatedExtensions(params: Record<string, string>): string[] {
  const raw = serviceParam(params, "A2A-Extensions");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── Stream events ──────────────────────────────────────────────────

/** The Task id a stream event concerns, if any. */
export function taskIdOfEvent(ev: StreamResponse): string | undefined {
  return ev.task?.id ?? ev.statusUpdate?.taskId ?? ev.artifactUpdate?.taskId ?? ev.message?.taskId;
}

/** Does this event end its stream (§8)? A Message without a Task, a Task or
 *  status update in a terminal or interrupted state. */
export function eventEndsStream(ev: StreamResponse): boolean {
  if (ev.message && !ev.task && !ev.statusUpdate && !ev.artifactUpdate) return true;
  if (ev.task) return endsStream(ev.task.status?.state);
  if (ev.statusUpdate) return endsStream(ev.statusUpdate.status?.state);
  return false;
}

/** A deep copy of a Task, so a stored or sent copy never shares objects with
 *  the one a handler keeps editing. */
export function cloneTask(t: Task): Task {
  return JSON.parse(JSON.stringify(t)) as Task;
}

/**
 * Fold one stream event into a Task (A2A §3.1.2's meaning of each event): a
 * Task replaces it; a status update sets the status (a status message joins
 * the history) and merges metadata; an artifact update adds the artifact, or
 * appends its parts to the one with the same id when `append` is set. Returns
 * the new Task, or the same one when the event does not concern it. A Task in
 * a terminal state does not move again.
 */
export function applyEvent(task: Task | undefined, ev: StreamResponse): Task | undefined {
  if (ev.task) {
    if (task && isTerminalState(task.status.state) && ev.task.id === task.id) return task;
    return cloneTask(ev.task);
  }
  if (!task) return task;
  if (ev.statusUpdate && ev.statusUpdate.taskId === task.id) {
    if (isTerminalState(task.status.state)) return task;
    const next = cloneTask(task);
    next.status = JSON.parse(JSON.stringify(ev.statusUpdate.status));
    if (ev.statusUpdate.status.message) next.history = [...(next.history ?? []), next.status.message!];
    if (ev.statusUpdate.metadata) next.metadata = { ...(next.metadata ?? {}), ...ev.statusUpdate.metadata };
    return next;
  }
  if (ev.artifactUpdate && ev.artifactUpdate.taskId === task.id) {
    if (isTerminalState(task.status.state)) return task;
    const next = cloneTask(task);
    const a = JSON.parse(JSON.stringify(ev.artifactUpdate.artifact));
    const list = next.artifacts ?? [];
    const i = list.findIndex((x) => x.artifactId === a.artifactId);
    if (i >= 0 && ev.artifactUpdate.append) list[i] = { ...list[i], parts: [...list[i].parts, ...a.parts] };
    else if (i >= 0) list[i] = a;
    else list.push(a);
    next.artifacts = list;
    return next;
  }
  return task;
}

/** A Task cut to what a reader asked for (GetTask `historyLength`, ListTasks
 *  `includeArtifacts`). An unset `historyLength` keeps the whole history; 0
 *  keeps none. */
export function shapeTask(task: Task, opts: { historyLength?: number; includeArtifacts?: boolean } = {}): Task {
  const t = cloneTask(task);
  if (typeof opts.historyLength === "number" && opts.historyLength >= 0 && t.history) {
    t.history = opts.historyLength === 0 ? [] : t.history.slice(-opts.historyLength);
    if (t.history.length === 0) delete t.history;
  }
  if (opts.includeArtifacts === false) delete t.artifacts;
  return t;
}
