/**
 * The A2A 1.0 wire shapes, from the ones the gateway builds internally.
 *
 * A2A 1.0 serializes its messages as ProtoJSON of `lf.a2a.v1` (a2a.proto,
 * ADR-001), and a stock 1.0 implementation parses them strictly: the Python
 * `a2a-sdk` 1.1.0 refuses a field its schema does not have with -32602 on a
 * request, and with a parse error on a response. So what reaches a 1.0 peer
 * has to be exactly the 1.0 shape:
 *
 *   - a task state is its enum name, `TASK_STATE_COMPLETED`, not `completed`;
 *   - a file part is `{url | raw, filename, mediaType}` on the Part itself;
 *     the `{file: {uri, name, mimeType}}` wrapper is A2A 0.3's;
 *   - a status update has no `final` (the field went before 1.0);
 *   - `GetTask` and `CancelTask` answer with the Task itself, not `{task}`.
 *
 * The gateway keeps building its older shapes inside, because callers that
 * do not ask for 1.0 still get them (see `handleRpc`), and converts at the
 * edge with the functions here. Pure; each returns new objects and never edits
 * its input; each is idempotent, so a value already in 1.0 shape passes through.
 */
import type { A2APart } from "./jsonrpc.js";

const STATE_ENUM: Record<string, string> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  "auth-required": "TASK_STATE_AUTH_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
  canceled: "TASK_STATE_CANCELED",
  rejected: "TASK_STATE_REJECTED",
};

/** A task state in its ProtoJSON enum name. An enum name already is one. */
export function stateEnum(state: string): string {
  return STATE_ENUM[state] ?? state;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** One part in its 1.0 shape. Text and data parts are already 1.0 shaped; a
 *  `file` wrapper becomes a `url` (or `raw`) part with `filename` and
 *  `mediaType` beside it. Anything else is left alone. */
export function partToA2A10(part: A2APart): A2APart {
  const p = part as unknown as Obj;
  if (!isObj(p.file)) return part;
  const { file, ...rest } = p;
  const f = file as Obj;
  const url = str(f.uri) ?? str(f.url);
  const raw = str(f.bytes) ?? str(f.raw);
  const filename = str(f.name) ?? str(f.filename);
  const mediaType = str(f.mimeType) ?? str(f.mime_type) ?? str(f.mediaType);
  return {
    ...rest,
    ...(url ? { url } : raw ? { raw } : {}),
    ...(filename ? { filename } : {}),
    ...(mediaType ? { mediaType } : {}),
  } as unknown as A2APart;
}

export function partsToA2A10(parts: unknown): A2APart[] {
  return Array.isArray(parts) ? (parts as A2APart[]).map(partToA2A10) : [];
}

function message10(m: unknown): unknown {
  if (!isObj(m)) return m;
  return Array.isArray(m.parts) ? { ...m, parts: partsToA2A10(m.parts) } : m;
}

function artifact10(a: unknown): unknown {
  if (!isObj(a)) return a;
  return Array.isArray(a.parts) ? { ...a, parts: partsToA2A10(a.parts) } : a;
}

function status10(s: unknown): unknown {
  if (!isObj(s)) return s;
  return {
    ...s,
    ...(typeof s.state === "string" ? { state: stateEnum(s.state) } : {}),
    ...(s.message !== undefined ? { message: message10(s.message) } : {}),
  };
}

/** A Task in its 1.0 shape: the state's enum name, and every part inside it
 *  (status message, artifacts, history) as a 1.0 part. */
export function taskToA2A10(task: unknown): unknown {
  if (!isObj(task)) return task;
  return {
    ...task,
    ...(task.status !== undefined ? { status: status10(task.status) } : {}),
    ...(Array.isArray(task.artifacts) ? { artifacts: task.artifacts.map(artifact10) } : {}),
    ...(Array.isArray(task.history) ? { history: task.history.map(message10) } : {}),
  };
}

/**
 * A SendMessage result (`{task}` or `{message}`), a stream event (those two,
 * `statusUpdate` or `artifactUpdate`), or a bare Task, in its 1.0 shape.
 */
export function resultToA2A10<T>(value: T): T {
  if (!isObj(value)) return value;
  const v = value as Obj;
  // A bare Task: GetTask and CancelTask answer with one.
  if (typeof v.id === "string" && isObj(v.status)) return taskToA2A10(v) as T;
  const out: Obj = { ...v };
  if (v.task !== undefined) out.task = taskToA2A10(v.task);
  if (v.message !== undefined) out.message = message10(v.message);
  if (isObj(v.statusUpdate)) {
    const { final: _final, ...su } = v.statusUpdate;
    out.statusUpdate = { ...su, ...(su.status !== undefined ? { status: status10(su.status) } : {}) };
  }
  if (isObj(v.artifactUpdate)) {
    const au = v.artifactUpdate;
    out.artifactUpdate = { ...au, ...(au.artifact !== undefined ? { artifact: artifact10(au.artifact) } : {}) };
  }
  return out as T;
}
