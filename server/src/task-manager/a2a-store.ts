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
import { createEnvelope, childSpan, decode, ErrorCode, TERMINAL_STATES } from "../sdk.js";
import {
  A2AError,
  A2A_WIRE_VERSION,
  applyEvent,
  budgetFromA2A,
  forbiddenFieldsRefusal,
  isA2AFrame,
  isTerminalState,
  isTrialTask,
  isValidBudgetBlock,
  listFrom,
  readRespondPayload,
  shapeTask,
  EXT_BUDGET,
  LIST_PAGE_MAX,
  type A2ACancel,
  type ListTasksRequest,
  type StreamResponse,
  type Task,
} from "../../../sdk-typescript/src/a2a/index.js";
import { a2aRequestFacts, wire030State, type OfferingDirectory } from "../shared/a2a-frames.js";
import { spendFromPayload, type Budget } from "./budget.js";
import { applyStateFields, flagStrandedA2A, MAX_FRAMES, publishStateOutputs, stopObjectRefusal, type A2AOutputDeps, type A2APlatformFields } from "./a2a-outputs.js";
import { attachOrigin, partiesMatch, ORIGIN_SKEW_MS } from "./origin.js";
import { noteOriginMiss } from "./origin-tap.js";

/** One stored record: the A2A Task, and what the mesh keeps beside it
 *  (SPEC.md §7.1; the platform's fields are a2a-outputs.ts's). */
export interface A2ATaskRecord extends A2APlatformFields {
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
 *  answer that binds it to a Task arrives: its verified sender and
 *  engagement, and what the starting Message said about the work. */
interface SeenRequest {
  from: string;
  to: string | undefined;
  engagement: string | null;
  /** The offering the Message named (shared/a2a-frames.ts). */
  offering?: string;
  trial?: boolean;
  budget?: Budget;
}

/** A CancelTask this instance saw delivered: who sent it to whom, and the
 *  reason its cancel extension gave. */
interface SeenCancel {
  from: string;
  to: string | undefined;
  cancel?: A2ACancel;
}

/** What the store needs to give the platform its outputs (a2a-outputs.ts).
 *  Each is optional: a store without `nc` and `kp` records Tasks and
 *  publishes nothing. */
export interface A2AStoreDeps extends A2AOutputDeps {
  /** Both Task stores as one (task-records.ts), where an origin is attached. */
  records?: KeyedStore;
  /** The agents' declared offerings, for a call that names none (§12.1). */
  offerings?: OfferingDirectory;
}

const SEEN_MAX = 10_000;

/** The budget a Message's budget extension sets, in the 0.3.0 shape. */
function budgetOfMessage(message: { metadata?: Record<string, unknown> } | undefined): Budget | undefined {
  const b = message?.metadata?.[EXT_BUDGET];
  return isValidBudgetBlock(b) ? (budgetFromA2A(b) as Budget) : undefined;
}

/** A request first seen well after the Task existed did not create it. */
function createdLongBefore(createdAt: string | undefined, observedAt: string): boolean {
  const created = Date.parse(createdAt ?? "");
  const seen = Date.parse(observedAt);
  return Number.isFinite(created) && Number.isFinite(seen) && seen - created > ORIGIN_SKEW_MS;
}

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
  /** The latest CancelTask seen for each Task id. */
  private readonly cancels = new Map<string, SeenCancel>();

  constructor(
    private readonly kv: KeyedStore,
    private readonly deps: A2AStoreDeps = {},
  ) {}

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
      const facts = a2aRequestFacts(env);
      if (facts?.method === "CancelTask") {
        if (facts.taskId) this.rememberIn(this.cancels, facts.taskId, { from: env.from, to: env.to, ...(facts.cancel ? { cancel: facts.cancel } : {}) });
        return;
      }
      const budget = budgetOfMessage(facts?.message);
      this.remember(env.id, {
        from: env.from,
        to: env.to,
        engagement: typeof engagement === "string" ? engagement : null,
        ...(facts?.offering ? { offering: facts.offering } : {}),
        ...(facts?.trial ? { trial: true } : {}),
        ...(budget ? { budget } : {}),
      });
      // A Message continuing a Task with a higher budget revision revises
      // the budget the receipts carry (§7.7, §12.2).
      if (facts?.taskId && budget) await this.reviseBudget(facts.taskId, env, budget);
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
    this.rememberIn(this.seen, id, seen);
  }

  private rememberIn<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > SEEN_MAX) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  /** A budget revision from the Task's requester to its responder, higher
   *  than the one recorded, replaces it whole (§7.7: absolute, never a
   *  delta). A terminal Task's budget is a record and does not change. */
  private async reviseBudget(taskId: string, env: Envelope, budget: Budget): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await this.read(taskId);
      if (!cur) return;
      const { record, revision } = cur;
      if (record.requester !== env.from || record.responder !== env.to || isTerminalState(record.task.status.state)) return;
      if (record.budget && budget.revision <= record.budget.revision) return;
      try {
        await this.kv.update(taskId, JSON.stringify({ ...record, budget }), revision);
        return;
      } catch {
        /* written meanwhile: read again */
      }
    }
  }

  /** The origin bound to this Task, if it attaches under the rules of
   *  origin.ts (its parties are the record's; it was not seen long after the
   *  Task existed). Null on a read failure: never a guess. */
  private async originFor(record: A2ATaskRecord, taskId: string) {
    const origins = this.deps.origins;
    if (!origins || record.origin) return null;
    try {
      const found = await origins.originFor(record.requester, record.responder, taskId);
      return found && partiesMatch(record, found) && !createdLongBefore(record.created_at, found.observed_at) ? found : null;
    } catch {
      return null;
    }
  }

  private async fold(env: Envelope, ev: StreamResponse, seq: number, streamTaskId: string | undefined): Promise<void> {
    const taskId = ev.task?.id ?? ev.statusUpdate?.taskId ?? ev.artifactUpdate?.taskId;
    if (typeof taskId !== "string" || !taskId) return; // a Message without a Task stores nothing
    if (streamTaskId !== undefined && streamTaskId !== taskId) return;

    for (let attempt = 0; attempt < 20; attempt++) {
      const cur = await this.read(taskId);
      const at = new Date().toISOString();
      let next: A2ATaskRecord;
      /** The 0.3.0-spelled state this change brings the Task to, when it is
       *  one the lifecycle events announce: the Task's birth and every status
       *  update, as a 0.3.0 Task announces every update. */
      let announce: string | null = null;
      let prevState: string | null = null;
      if (!cur) {
        // A record is born only from a full Task, never from a lone update.
        if (!ev.task) return;
        const req = typeof env.in_reply_to === "string" ? this.seen.get(env.in_reply_to) : undefined;
        // The requester is the verified sender of the request this answered,
        // when this instance saw it delivered to the answering agent;
        // otherwise the answer's own `to`.
        const asked = req && req.to === env.from ? req : undefined;
        const requester = asked ? asked.from : env.to;
        if (!requester) return;
        const refusal = stopObjectRefusal(ev.task);
        if (refusal) {
          console.warn(`[task-manager] refused A2A task ${taskId} from ${env.from.slice(0, 12)}…: ${refusal} (§10.8)`);
          return;
        }
        // The offering the call named, else the agent's one offering (§12.1).
        const offering = asked?.offering ?? (this.deps.offerings ? await this.deps.offerings.single(env.from) : undefined) ?? "";
        next = {
          task: ev.task,
          requester,
          responder: env.from,
          engagement: asked ? asked.engagement : null,
          seq,
          created_at: at,
          updated_at: at,
          offering,
          ...(asked?.trial || isTrialTask(ev.task) ? { trial: true } : {}),
          ...(asked?.budget ? { budget: asked.budget } : {}),
        };
        announce = wire030State(ev.task);
      } else {
        const { record } = cur;
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
        const refusal = stopObjectRefusal(task);
        if (refusal) {
          console.warn(`[task-manager] did not apply a change to A2A task ${taskId}: ${refusal} (§10.8)`);
          return;
        }
        next = { ...record, task, seq: Math.max(seq, record.seq), updated_at: at };
        prevState = wire030State(record.task);
        if (ev.statusUpdate || ev.task) announce = wire030State(task);
      }

      // The responder's reported spend rides beside the A2A object (§19.3).
      const spend = spendFromPayload(env.payload);
      if (spend) next.reported_spend = spend;
      next.frames = [...(next.frames ?? []), env].slice(-MAX_FRAMES);
      const found = await this.originFor(next, taskId);
      if (found) next.origin = found;
      // What the Task's new state brings: written once, when it is entered.
      if (announce !== null && announce !== prevState) {
        await applyStateFields(next, announce, env, taskId, this.deps, this.cancels.get(taskId)?.cancel);
      }
      if (this.deps.origins) {
        await this.deps.origins.projectAll(next as never, taskId).catch(() => false);
      }

      try {
        if (!cur) await this.kv.create(taskId, JSON.stringify(next));
        else await this.kv.update(taskId, JSON.stringify(next), cur.revision);
      } catch {
        continue; // written meanwhile: fold into what is there
      }
      await this.afterWrite(next, taskId, env, announce, prevState, !cur);
      return;
    }
    console.error(`[task-manager] A2A task ${taskId} could not be written after 20 tries`);
  }

  /** What follows a write: the platform's outputs for the new state, the
   *  settling of a cancel attribution, a late origin, stranded delegates. */
  private async afterWrite(record: A2ATaskRecord, taskId: string, env: Envelope, state: string | null, prevState: string | null, created: boolean): Promise<void> {
    const origins = this.deps.origins;
    const records = this.deps.records;
    // A record this write created: evidence the ledger wrote before it
    // existed is mirrored onto it now (origin.ts mirror).
    if (created && origins) {
      const askers = new Set(await origins.askersOf(record.responder, taskId).catch(() => [] as string[]));
      askers.add(record.requester);
      for (const a of askers) await origins.mirror(taskId, a, record.responder).catch(() => undefined);
    }
    // The ledger may bind the Task id between the lookup and the write.
    if (!record.origin && origins && records) {
      const found = await this.originFor(record, taskId);
      if (found && (await attachOrigin(records, taskId, found).catch(() => false))) record.origin = found;
      if (!record.origin && state !== null && TERMINAL_STATES.has(state as never)) {
        noteOriginMiss("terminal_without_origin", { task_id: taskId, state });
      }
    }
    if (state === null) return;
    publishStateOutputs(record, state, env, this.deps);
    if (state === prevState) return;
    if (state === "canceled" && record.canceled_by?.unverified && origins) origins.settleCanceledByLater(taskId);
    if (state === "canceled") {
      await flagStrandedA2A(record, this.kv, this.deps).catch((err) => console.error(`[task-manager] stranded-delegate check failed for A2A task ${taskId}:`, err));
    }
    console.log(`[task-manager] A2A task ${taskId}: ${state}`);
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
