/**
 * The durable store of A2A Tasks (bindings/a2a.md §5, §10, §11).
 *
 * Under the A2A binding (wire version 0.4.0) Agent Messaging has no task
 * model of its own: a Task is A2A's object, created by the server agent and
 * moved by the stream events it sends. This store keeps one record per A2A
 * Task id in `mesh_a2a_tasks`:
 *
 *   { task, requester, responder, engagement, seq, created_at, updated_at }
 *
 * `task` is the A2A Task, unchanged. The keys of the agent that created it
 * (`requester`) and of the agent that answers it (`responder`), and the
 * engagement it runs under, are kept BESIDE it, never inside it (§11). `seq`
 * is the number of the last stream event folded in (§8).
 *
 * What fills it. The server agent's node publishes each change to a Task on
 * `mesh.task.{taskId}.update` (binding §5, SPEC.md §7.4), numbered by
 * `payload.a2a.seq` in the Task's own order: first the Task itself, in reply
 * to the request that created it, then each status and artifact update. Each
 * frame's signature is checked; only the recorded responder moves a Task; a
 * change at or before the record's place is dropped; a Task in a terminal
 * state does not move again. The inbox tap the task manager already runs
 * supplies the creating request's verified sender and its engagement.
 *
 * Who reads it. The server agent's node relays a client's GetTask, ListTasks
 * or SubscribeToTask frame, signed by the client, to `mesh.task.a2a.get` or
 * `mesh.task.a2a.list`. The store answers when the node is the Task's
 * responder, the client's frame verifies and was addressed to that node, and
 * the client is the agent that created the Task. Anyone else gets
 * TaskNotFoundError, so a Task's existence is not disclosed (§10). An agent a
 * creator delegated to (SPEC.md §4.11) signs as that creator, so it passes the
 * same test.
 */
import type { BusMessage, KeyedStore } from "../storage/index.js";
import type { Envelope } from "../sdk.js";
import { createEnvelope, childSpan, decode, ErrorCode } from "../sdk.js";
import {
  A2AError,
  A2A_WIRE_VERSION,
  applyEvent,
  forbiddenFieldsRefusal,
  isA2AFrame,
  isTerminalState,
  listFrom,
  readRespondPayload,
  shapeTask,
  LIST_PAGE_MAX,
  type ListTasksRequest,
  type StreamResponse,
  type Task,
} from "../../../sdk-typescript/src/a2a/index.js";

/** One stored record: the A2A Task, and what the mesh keeps beside it. */
export interface A2ATaskRecord {
  task: Task;
  requester: string;
  responder: string;
  /** The engagement the work runs under, from the creating request's
   *  `meta.engagement`; null when it named none or this instance did not see
   *  the request. */
  engagement: string | null;
  seq: number;
  created_at: string;
  updated_at: string;
}

/** What this instance remembers of a request it saw delivered, until the
 *  answer that binds it to a Task arrives: its verified sender and engagement. */
interface SeenRequest {
  from: string;
  to: string | undefined;
  engagement: string | null;
}

const SEEN_MAX = 10_000;

function a2aError(err: A2AError, req: Envelope, serviceId: string): Envelope {
  return createEnvelope({
    type: "respond",
    from: serviceId,
    to: req.from,
    in_reply_to: req.id,
    trace: childSpan(req.trace),
    error: err.toErrorObject(),
  });
}

function notFound(id?: string): A2AError {
  return new A2AError("TaskNotFoundError", "No task with that id.", id ? { taskId: id } : {});
}

export class A2ATaskStore {
  private readonly seen = new Map<string, SeenRequest>();

  constructor(private readonly kv: KeyedStore) {}

  async read(taskId: string): Promise<{ record: A2ATaskRecord; revision: number } | null> {
    const entry = await this.kv.get(taskId);
    if (!entry || entry.operation === "DEL" || entry.operation === "PURGE" || !entry.value?.length) return null;
    try {
      return { record: entry.json<A2ATaskRecord>(), revision: entry.revision };
    } catch {
      return null;
    }
  }

  /** Every record, for ListTasks. */
  private async all(): Promise<A2ATaskRecord[]> {
    const snap = await this.kv.list();
    const out: A2ATaskRecord[] = [];
    for (const entry of snap.entries.values()) {
      try {
        const r = entry.json<A2ATaskRecord>();
        if (r && r.task && typeof r.task.id === "string") out.push(r);
      } catch {
        /* a record that does not parse lists as nothing */
      }
    }
    return out;
  }

  /**
   * One frame seen on the bus: a request delivered to an agent's inbox, an
   * answer delivered to the client's inbox, or an event on a Task's stream.
   * Anything that is not a well-formed, signed 0.4.0 frame is ignored, and a
   * frame carrying the old envelope fields is refused (§4) without effect.
   */
  async observe(subject: string, data: Uint8Array): Promise<void> {
    let env: Envelope;
    try {
      env = decode(data);
    } catch {
      return;
    }
    if (!isA2AFrame(env)) return;
    const refusal = forbiddenFieldsRefusal(env);
    if (refusal) {
      console.warn(`[task-manager] refused a 0.4.0 frame from ${env.from.slice(0, 12)}…: ${refusal.message} (${ErrorCode.INVALID_ENVELOPE})`);
      return;
    }
    if (env.type === "request") {
      if (!subject.endsWith(".inbox")) return;
      const engagement = (env.meta as Record<string, unknown> | undefined)?.engagement;
      this.remember(env.id, { from: env.from, to: env.to, engagement: typeof engagement === "string" ? engagement : null });
      return;
    }
    if (env.type !== "respond" || env.error) return;
    const answer = readRespondPayload(env);
    if (!answer) return;
    const ev = answer.result as StreamResponse;
    if (!ev || typeof ev !== "object") return;
    // Task changes travel on the Task's update subject, numbered in the
    // Task's own order (§5). Answers on inboxes and stream events are the
    // client's, and the store does not read them.
    const m = /^mesh\.task\.([^.]+)\.update$/.exec(subject);
    if (!m || answer.seq === undefined) return;
    await this.fold(env, ev, answer.seq, m[1]);
  }

  private remember(id: string, seen: SeenRequest): void {
    this.seen.set(id, seen);
    if (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  private async fold(env: Envelope, ev: StreamResponse, seq: number, streamTaskId: string | undefined): Promise<void> {
    const taskId = ev.task?.id ?? ev.statusUpdate?.taskId ?? ev.artifactUpdate?.taskId;
    if (typeof taskId !== "string" || !taskId) return; // a Message without a Task stores nothing
    if (streamTaskId !== undefined && streamTaskId !== taskId) return;

    for (let attempt = 0; attempt < 20; attempt++) {
      const cur = await this.read(taskId);
      const at = new Date().toISOString();
      if (!cur) {
        // A record is born only from a full Task, never from a lone update.
        if (!ev.task) return;
        const req = typeof env.in_reply_to === "string" ? this.seen.get(env.in_reply_to) : undefined;
        // The requester is the verified sender of the request this answered,
        // when this instance saw it delivered to the answering agent;
        // otherwise the answer's own `to`.
        const requester = req && req.to === env.from ? req.from : env.to;
        if (!requester) return;
        const record: A2ATaskRecord = {
          task: ev.task,
          requester,
          responder: env.from,
          engagement: req && req.to === env.from ? req.engagement : null,
          seq,
          created_at: at,
          updated_at: at,
        };
        try {
          await this.kv.create(taskId, JSON.stringify(record));
          return;
        } catch {
          continue; // written meanwhile: fold into what is there
        }
      }
      const { record, revision } = cur;
      // Only the agent that answers the Task moves it.
      if (record.responder !== env.from) {
        console.warn(`[task-manager] ignored an event for A2A task ${taskId} from ${env.from.slice(0, 12)}…, which does not answer it`);
        return;
      }
      // An event at or before the record's place in the sequence is already in it.
      if (seq <= record.seq) return;
      if (isTerminalState(record.task.status.state)) return;
      const task = applyEvent(record.task, ev);
      if (!task) return;
      const next: A2ATaskRecord = { ...record, task, seq: Math.max(seq, record.seq), updated_at: at };
      try {
        await this.kv.update(taskId, JSON.stringify(next), revision);
        return;
      } catch {
        continue;
      }
    }
    console.error(`[task-manager] A2A task ${taskId} could not be written after 20 tries`);
  }

  /**
   * The client's relayed frame, checked: it verifies, it was addressed to the
   * node relaying it, and it is a 0.4.0 frame without the old fields. Returns
   * the client's frame, or null for anything else (answered not found).
   */
  private relayedFrame(req: Envelope): Envelope | null {
    const raw = (req.payload as { frame?: unknown } | undefined)?.frame;
    if (!raw || typeof raw !== "object") return null;
    let frame: Envelope;
    try {
      frame = decode(new TextEncoder().encode(JSON.stringify(raw)));
    } catch {
      return null;
    }
    if (frame.v !== A2A_WIRE_VERSION || frame.type !== "request" || frame.to !== req.from) return null;
    return frame;
  }

  /** `mesh.task.a2a.get`: one Task, for its creator, through its responder's
   *  node. Answers `{task, seq, requester}`. */
  async handleGet(req: Envelope, _msg: BusMessage, serviceId: string): Promise<Envelope> {
    const frame = this.relayedFrame(req);
    if (frame && forbiddenFieldsRefusal(frame)) return a2aError(new A2AError("InvalidRequestError", "The relayed frame carries task_id, context_id or artifacts."), req, serviceId);
    const params = (frame?.payload as { a2a?: { params?: { id?: unknown; historyLength?: unknown } } } | undefined)?.a2a?.params;
    const id = typeof params?.id === "string" ? params.id : typeof (frame?.payload as { a2a?: { params?: { message?: { taskId?: unknown } } } })?.a2a?.params?.message?.taskId === "string"
      ? ((frame!.payload as { a2a: { params: { message: { taskId: string } } } }).a2a.params.message.taskId)
      : undefined;
    if (!frame || !id) return a2aError(notFound(), req, serviceId);
    const cur = await this.read(id);
    if (!cur || cur.record.responder !== req.from || cur.record.requester !== frame.from) return a2aError(notFound(id), req, serviceId);
    return createEnvelope({
      type: "respond",
      from: serviceId,
      to: req.from,
      in_reply_to: req.id,
      trace: childSpan(req.trace),
      payload: { task: cur.record.task, seq: cur.record.seq, requester: cur.record.requester },
    });
  }

  /** `mesh.task.a2a.list`: the Tasks the client created with the relaying
   *  node. Answers `{result: ListTasksResponse, seqs}`. */
  async handleList(req: Envelope, _msg: BusMessage, serviceId: string): Promise<Envelope> {
    const frame = this.relayedFrame(req);
    if (!frame) return a2aError(new A2AError("InvalidRequestError", "ListTasks is answered for a relayed, signed client frame."), req, serviceId);
    const p = ((frame.payload as { a2a?: { params?: unknown } } | undefined)?.a2a?.params ?? {}) as ListTasksRequest;
    if (p.pageSize !== undefined && (!Number.isInteger(p.pageSize) || p.pageSize < 1 || p.pageSize > LIST_PAGE_MAX)) {
      return a2aError(new A2AError("InvalidParamsError", `pageSize must be an integer from 1 to ${LIST_PAGE_MAX}.`), req, serviceId);
    }
    const mine = (await this.all()).filter((r) => r.responder === req.from && r.requester === frame.from);
    const result = listFrom(mine.map((r) => r.task), p);
    const seqs: Record<string, number> = {};
    for (const r of mine) seqs[r.task.id] = r.seq;
    return createEnvelope({
      type: "respond",
      from: serviceId,
      to: req.from,
      in_reply_to: req.id,
      trace: childSpan(req.trace),
      payload: { result: { ...result, tasks: result.tasks.map((t) => shapeTask(t, {})) }, seqs },
    });
  }
}
