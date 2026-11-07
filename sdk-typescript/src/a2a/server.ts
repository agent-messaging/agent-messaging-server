/**
 * The server agent's side of the A2A binding (bindings/a2a.md §5, §8, §10).
 *
 * An agent installs one handler with `mesh.a2a.serve(handler)`. The handler
 * receives each A2A Message a client sends and returns a Message (the work
 * finished in one round) or a Task (the work continues), and while it runs it
 * can emit status and artifact updates through the Task's handle. This module
 * turns that into frames:
 *
 *   - The SDK keeps one event sequence per Task. The first event a request
 *     gets goes to the client's inbox in a respond frame, so the client learns
 *     the Task id; every later event is a respond frame on
 *     `mesh.task.{taskId}.stream`. Each carries `payload.a2a.seq`, and the
 *     event that ends a stream carries `final: true` (§8).
 *   - `GetTask`, `ListTasks` and the snapshot `SubscribeToTask` starts from are
 *     answered from the mesh's durable task store: the node relays the
 *     client's own signed frame to the task manager, which applies the access
 *     rule of §10 (only the agent that created the Task). When no task manager
 *     answers, the node answers from what it holds itself, under the same rule.
 *   - `CancelTask` reaches the handler's cancel hook; a Task in a terminal
 *     state answers `TaskNotCancelableError`.
 *   - Push notifications are not supported: the four operations answer
 *     `PushNotificationNotSupportedError`, and the card says so.
 *
 * The node never adds a state, renames a field or changes what an operation
 * means (§1).
 */
import type { Envelope, ErrorObject, TraceContext } from "../types/envelope.js";
import { MeshError, ErrorCode } from "../types/errors.js";
import { childSpan } from "../internal/trace.js";
import { uuid7 } from "../internal/uuid.js";
import { isSubjectToken } from "../internal/subjects.js";
import {
  STREAMING_METHODS,
  activatedExtensions,
  applyEvent,
  cloneTask,
  endsStream,
  eventEndsStream,
  isA2AMethod,
  isTerminalState,
  readRequestPayload,
  readServiceParams,
  respondPayload,
  shapeTask,
} from "./binding.js";
import { A2AError, A2AErrors } from "./errors.js";
import {
  EXT_BUDGET,
  EXT_CANCEL,
  EXT_FAILURE,
  OVERDUE_METADATA,
  A2A_CANCEL_REASONS,
  budgetOf,
  ceilingReachedTask,
  deadlineUnmeetableTask,
  exhaustedTask,
  highestBudgetRevision,
  insufficientBudgetTask,
  isCeilingReached,
  isForPerson,
  offeringOf,
  type A2AAmount,
  type A2ACancel,
  type A2AFailure,
} from "./extensions.js";
import { validateStopFields } from "../cancel.js";
import { routeOffering } from "./readings.js";
import type { Budget } from "../types/envelope.js";
import type {
  AgentCard,
  Artifact,
  CancelTaskRequest,
  GetTaskRequest,
  ListTasksRequest,
  ListTasksResponse,
  Message,
  Part,
  SendMessageRequest,
  StreamResponse,
  Task,
  TaskState,
} from "./types.js";

/** The task manager's subjects for the node's reads (server/src/task-manager). */
export const A2A_STORE_SUBJECTS = {
  GET: "mesh.task.a2a.get",
  LIST: "mesh.task.a2a.list",
  /** A reader asks for one stream's frames, delivered to its inbox from the
   *  first (A2A binding §8; server/src/task-manager/a2a-follow.ts). */
  FOLLOW: "mesh.task.a2a.follow",
} as const;

/** ListTasks page size: A2A's default and its bounds. */
export const LIST_PAGE_DEFAULT = 50;
export const LIST_PAGE_MAX = 100;

/** What the node needs from the agent that hosts it. `AgentMesh` provides it. */
export interface A2AServerHost {
  readonly agentId: string;
  /** A signed 0.4.0 respond frame. */
  frame(p: {
    to: string;
    in_reply_to?: string;
    trace: TraceContext;
    payload?: unknown;
    error?: ErrorObject;
    /** Seal the payload to this X25519 key (§8a): set when the request came sealed. */
    sealTo?: string;
    /** The Task state to show in clear as meta.a2a_state on a sealed frame (§8a). */
    clearState?: string;
  }): Envelope;
  /** Publish a frame on a subject. */
  publish(subject: string, env: Envelope): void;
  /** The subject a Task's changes travel on for the task store
   *  (`mesh.task.{taskId}.update`, §5). */
  updateSubject(taskId: string): string;
  /** The subject of a Task's stream (`mesh.task.{taskId}.stream`). */
  streamSubject(taskId: string): string;
  /** A signed request to a mesh service; resolves with the answer's payload. */
  serviceRequest(subject: string, payload: unknown, timeoutMs: number): Promise<unknown>;
  /** The offerings this agent declares (§12.1), in its manifest. */
  offerings(): string[];
}

/** One Task this agent runs, as its handle shows it to the handler. */
export interface TaskHandle {
  readonly id: string;
  readonly contextId: string;
  /** The Task as it stands (a copy). */
  readonly task: Task;
  /** Set the status, with an optional status message, and emit a
   *  TaskStatusUpdateEvent. */
  status(state: TaskState, message?: string | Message, metadata?: Record<string, unknown>): void;
  /** Add an artifact (or append parts to one) and emit a
   *  TaskArtifactUpdateEvent. */
  artifact(artifact: Artifact, opts?: { append?: boolean; lastChunk?: boolean }): void;
  complete(message?: string | Message): void;
  /** End the Task failed, with the reason when one is stated (§12.7). */
  fail(message?: string | Message, failure?: A2AFailure): void;
  /** §12.2: the deadline passed while the work goes on (the overdue mark on
   *  a status update; the state does not change). */
  overdue(message?: string | Message): void;
  /** §12.2: completed after the deadline (`completed_late`). */
  completeLate(message?: string | Message): void;
  reject(message?: string | Message, metadata?: Record<string, unknown>): void;
  requireInput(message: string | Message): void;
  requireAuth(message: string | Message): void;
  /** §12.2: the engagement's cap ended the work: canceled, with the
   *  `exhausted` outcome under the budget extension. */
  exhausted(text?: string): void;
  /** §12.2: refused at admission, the work does not fit the cost ceiling. */
  insufficient(estimate: A2AAmount | Record<string, unknown>, text?: string): void;
  /** §12.2: refused at admission, the deadline cannot be met. */
  deadlineUnmeetable(earliestCompletion: string, text?: string): void;
  /** §12.2: paused at the cost ceiling, waiting for a higher budget revision
   *  (input required), or a cancel with the reason budget_exhausted. */
  ceilingReached(spent: A2AAmount | Record<string, unknown>, estimateToFinish: A2AAmount | Record<string, unknown>, text?: string): void;
  /** Replace the whole Task at once (emits a Task event). */
  replace(task: Task): void;
  /** Resolves when the Task reaches a terminal or interrupted state. */
  settled(): Promise<Task>;
}

export interface A2AContext {
  /** The client's agent key, from the frame's verified signature (§10). */
  readonly caller: string;
  /** The A2A request object as it arrived. */
  readonly request: SendMessageRequest;
  /** The whole request frame. */
  readonly envelope: Envelope;
  /** Service parameters from `meta.a2a` (§7). */
  readonly serviceParams: Record<string, string>;
  /** The extensions the client activated (`A2A-Extensions`). */
  readonly extensions: string[];
  /** The offering this message calls (§12.1), resolved against what the
   *  agent declares. */
  readonly offering?: string;
  /** The budget the message carries (§12.2), if any. */
  readonly budget?: Budget;
  /** The message is meant for the person behind this agent (§12.3). */
  readonly forPerson: boolean;
  /** SendStreamingMessage rather than SendMessage. */
  readonly streaming: boolean;
  /** The Task the message continues, when it names one. */
  readonly existingTask?: Task;
  /** Aborted when the Task is canceled. */
  readonly signal: AbortSignal;
  /** Create this call's Task (or, for a message that continues one, take its
   *  handle). The Task starts in `TASK_STATE_SUBMITTED` unless told otherwise,
   *  with the client's message in its history. */
  startTask(init?: { state?: TaskState; contextId?: string; metadata?: Record<string, unknown> }): TaskHandle;
}

export type A2AHandlerResult = Message | Task | TaskHandle | void | undefined;
export type A2AHandler = (message: Message, ctx: A2AContext) => A2AHandlerResult | Promise<A2AHandlerResult>;

export interface A2AServeOptions {
  /** Called on CancelTask for a Task this node runs. Throw an A2AError to
   *  refuse; return to let the cancel stand. */
  onCancel?: (task: Task, caller: string, cancel: A2ACancel) => void | Promise<void>;
  /** The extended card (GetExtendedAgentCard), or a function of the caller
   *  that returns one. Absent: ExtendedAgentCardNotConfiguredError. */
  extendedCard?: AgentCard | ((caller: string) => AgentCard | Promise<AgentCard>);
  /** How long a SendMessage waits for the handler before answering with the
   *  Task as it stands, so a long Task does not outlive the client's reply
   *  window. Default 10 seconds. */
  replyWindowMs?: number;
  /** On a sealed frame, show the Task's state in clear as meta.a2a_state
   *  (§8a), for a carrier that shows it to a person. Off by default: it
   *  discloses the state to every carrier on the path. */
  stateInClear?: boolean;
  /** How long the node waits for the task store before answering from what
   *  it holds itself. Default 5 seconds. */
  storeTimeoutMs?: number;
  /** The offerings to resolve the offering extension against (§12.1).
   *  Default: the offerings the agent declares in its manifest. */
  offerings?: string[];
}

/** One open stream of a Task (§8): the request frame that opened it names
 *  it, and its events count from 0. */
interface OpenStream {
  id: string;
  seq: number;
  to: string;
  trace: TraceContext;
  sealTo?: string;
}

interface LiveTask {
  task: Task;
  requester: string;
  /** The Task's own order of changes, as published on its update subject. */
  version: number;
  /** The streams open on this Task, by streamId. */
  streams: Map<string, OpenStream>;
  trace: TraceContext;
  abort: AbortController;
  waiters: Array<(t: Task) => void>;
  handle?: TaskHandle;
}

const agentMessage = (content: string | Message, task: Task): Message =>
  typeof content === "string"
    ? {
        messageId: uuid7(),
        role: "ROLE_AGENT",
        parts: [{ text: content }],
        taskId: task.id,
        ...(task.contextId ? { contextId: task.contextId } : {}),
      }
    : content;

const now = () => new Date().toISOString();

/** The Task state a result or stream event shows, if it shows one. */
function stateOfResult(r: unknown): string | undefined {
  const o = r as StreamResponse | undefined;
  return o?.task?.status?.state ?? o?.statusUpdate?.status?.state ?? (isTask(r) ? (r as Task).status.state : undefined);
}

function isTask(v: unknown): v is Task {
  return !!v && typeof v === "object" && typeof (v as Task).id === "string" && !!(v as Task).status && typeof (v as Task).status === "object";
}

function isMessage(v: unknown): v is Message {
  return !!v && typeof v === "object" && Array.isArray((v as Message).parts) && typeof (v as Message).role === "string";
}

function isHandle(v: unknown): v is TaskHandle {
  return !!v && typeof v === "object" && typeof (v as TaskHandle).status === "function" && typeof (v as TaskHandle).id === "string";
}

/** A store or transport failure the node answers around (it falls back to
 *  what it holds), as against an answer from the store. */
function storeUnreachable(err: unknown): boolean {
  return (
    err instanceof MeshError &&
    (err.code === ErrorCode.TRANSPORT_TIMEOUT ||
      err.code === ErrorCode.TRANSPORT_NO_RESPONDERS ||
      err.code === ErrorCode.TRANSPORT_PERMISSION_DENIED)
  );
}

/** The A2A error a store answer carries, if it is one. */
function a2aErrorOf(err: unknown): A2AError | null {
  if (err instanceof A2AError) return err;
  if (err instanceof MeshError) return A2AError.fromErrorObject(err.toErrorObject());
  return null;
}

export class A2AServerAgent {
  private handler: A2AHandler | null = null;
  private opts: A2AServeOptions = {};
  private readonly live = new Map<string, LiveTask>();
  /** Answers 0.4.0 SendMessage for an agent with no A2A handler: its 0.3.0
   *  handlers (§14), wired by AgentMesh. */
  legacy: ((offering: string | undefined, message: Message, env: Envelope) => Promise<Message>) | null = null;

  constructor(private readonly host: A2AServerHost) {}

  /** Install the handler (replacing any earlier one). */
  serve(handler: A2AHandler, opts: A2AServeOptions = {}): void {
    this.handler = handler;
    this.opts = opts;
  }

  get serving(): boolean {
    return this.handler !== null;
  }

  get options(): A2AServeOptions {
    return this.opts;
  }

  /** The Tasks this node holds in memory (a copy of each). */
  tasks(): Task[] {
    return [...this.live.values()].map((l) => cloneTask(l.task));
  }

  /** The handle of a Task this node runs, for work that continues after its
   *  handler returned. */
  handleFor(taskId: string): TaskHandle | undefined {
    const l = this.live.get(taskId);
    return l ? this.makeHandle(l) : undefined;
  }

  /**
   * Answer one 0.4.0 request frame. `reply` sends a respond frame to the
   * client (its inbox, or the guarded relay's reply subject). The frame has
   * already passed every check the inbox makes (signature, `to`, freshness,
   * revoked or paused sender, admission) and the §4 field check.
   */
  async dispatch(env: Envelope, reply: (resp: Envelope) => void, opts: { sealTo?: string } = {}): Promise<void> {
    const req = readRequestPayload(env);
    const sealTo = opts.sealTo;
    const answerError = (err: A2AError | MeshError): void =>
      reply(this.frameOf({ to: env.from, in_reply_to: env.id, trace: childSpan(env.trace), error: err.toErrorObject() }, sealTo));
    const answer = (result: unknown, stream?: { streamId: string; seq: number; final: boolean }): void =>
      reply(this.frameOf({ to: env.from, in_reply_to: env.id, trace: childSpan(env.trace), payload: respondPayload(result, stream) }, sealTo));

    if (!req) {
      answerError(new A2AError("InvalidRequestError", "A 0.4.0 request frame carries payload.a2a with method and params (A2A binding §4)."));
      return;
    }
    if (!isA2AMethod(req.method)) {
      answerError(A2AErrors.methodNotFound(req.method));
      return;
    }
    const params = (req.params && typeof req.params === "object" ? req.params : {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case "SendMessage":
        case "SendStreamingMessage":
          await this.sendMessage(env, params as unknown as SendMessageRequest, STREAMING_METHODS.has(req.method), reply, sealTo);
          return;
        case "GetTask": {
          const p = params as unknown as GetTaskRequest;
          if (typeof p.id !== "string" || !p.id) throw A2AErrors.invalidParams("GetTask needs the Task's id.");
          const { task } = await this.readTask(env, p.id);
          answer(shapeTask(task, { historyLength: p.historyLength }));
          return;
        }
        case "ListTasks":
          answer(await this.listTasks(env, params as ListTasksRequest));
          return;
        case "CancelTask":
          answer(await this.cancelTask(env, params as unknown as CancelTaskRequest));
          return;
        case "SubscribeToTask": {
          const id = (params as { id?: unknown }).id;
          if (typeof id !== "string" || !id) throw A2AErrors.invalidParams("SubscribeToTask needs the Task's id.");
          // §8: a new stream, from the Task's current state as the store holds
          // it. Its later events follow on the stream subject under this
          // request's id.
          const { task, seq, requester } = await this.readTask(env, id);
          let live = this.live.get(id);
          if (!live || live.version < seq) live = this.adopt(task, seq, requester ?? env.from, env.trace);
          const final = isTerminalState(task.status.state);
          if (!final) live.streams.set(env.id, { id: env.id, seq: 0, to: env.from, trace: env.trace, ...(sealTo ? { sealTo } : {}) });
          answer({ task: cloneTask(live.task) }, { streamId: env.id, seq: 0, final });
          return;
        }
        case "CreateTaskPushNotificationConfig":
        case "GetTaskPushNotificationConfig":
        case "ListTaskPushNotificationConfigs":
        case "DeleteTaskPushNotificationConfig":
          throw A2AErrors.pushNotSupported();
        case "GetExtendedAgentCard": {
          const card = this.opts.extendedCard;
          if (!card) throw A2AErrors.extendedCardNotConfigured();
          answer(typeof card === "function" ? await card(env.from) : card);
          return;
        }
      }
    } catch (err) {
      if (err instanceof A2AError || err instanceof MeshError) answerError(err);
      else answerError(A2AErrors.internal(err instanceof Error ? err.message : String(err)));
    }
  }

  /** A respond frame, sealed to `sealTo` when the request came sealed, with
   *  the Task's state in clear when the agent asked for that (§8a). */
  private frameOf(
    p: { to: string; in_reply_to?: string; trace: TraceContext; payload?: unknown; error?: ErrorObject },
    sealTo: string | undefined,
  ): Envelope {
    if (!sealTo) return this.host.frame(p);
    const state = this.opts.stateInClear ? stateOfResult((p.payload as { a2a?: { result?: unknown } } | undefined)?.a2a?.result) : undefined;
    return this.host.frame({ ...p, sealTo, ...(state ? { clearState: state } : {}) });
  }

  // ─── SendMessage / SendStreamingMessage ───────────────────────────

  private resolveOffering(message: Message): string | undefined {
    const declared = this.opts.offerings ?? this.host.offerings();
    const named = offeringOf(message);
    // §12.1: one declared offering is served when a message names none;
    // several, and a message naming none or one not declared, is refused
    // with the invalid-parameters error listing them.
    // During the transition window the older keys are read too (routeOffering).
    if (declared.length === 0) return named;
    const routed = routeOffering(declared, message.metadata);
    if ("offering" in routed) return routed.offering;
    throw A2AErrors.invalidParams(
      named === undefined
        ? "This agent declares several offerings; name one with the offering extension."
        : `This agent does not declare the offering ${JSON.stringify(named)}.`,
      { offerings: routed.offerings },
    );
  }

  private async sendMessage(
    env: Envelope,
    request: SendMessageRequest,
    streaming: boolean,
    reply: (resp: Envelope) => void,
    sealTo?: string,
  ): Promise<void> {
    const message = request?.message;
    if (!isMessage(message) || typeof message.messageId !== "string") {
      throw A2AErrors.invalidParams("SendMessage needs a message with messageId, role and parts.");
    }
    const offering = this.resolveOffering(message);

    // A message that names a Task continues it, when it is the caller's own
    // and not finished (A2A §3.1.1).
    let existing: LiveTask | undefined;
    if (typeof message.taskId === "string" && message.taskId) {
      existing = this.live.get(message.taskId);
      if (!existing) {
        const { task, seq, requester } = await this.readTask(env, message.taskId);
        existing = this.adopt(task, seq, requester ?? env.from, env.trace);
      } else if (existing.requester !== env.from) {
        throw A2AErrors.taskNotFound(message.taskId);
      }
      // §12.2: a Task paused at its cost ceiling resumes only on a budget
      // revision higher than any before it.
      if (isCeilingReached(existing.task)) {
        const revision = budgetOf(message)?.revision;
        const before = highestBudgetRevision(existing.task);
        if (revision === undefined || revision <= before) {
          throw A2AErrors.invalidParams(
            "This task is paused at its cost ceiling: resume it with a budget whose revision is higher than " + before + ", or cancel it with the reason budget_exhausted.",
            { taskId: existing.task.id, revision: before },
          );
        }
      }
      if (isTerminalState(existing.task.status.state)) {
        throw new A2AError("UnsupportedOperationError", "The task is in a terminal state and takes no more messages.", {
          taskId: existing.task.id,
          state: existing.task.status.state,
        });
      }
    }

    if (!this.handler) {
      if (this.legacy && !existing) {
        const out = await this.legacy(offering, message, env);
        this.answerFirst(env, reply, { message: out }, streaming ? { streamId: env.id, seq: 0, final: true } : undefined, sealTo);
        return;
      }
      throw A2AErrors.unsupported("A2A messages");
    }

    let live: LiveTask | undefined = existing;
    let answered = false;
    const abort = existing?.abort ?? new AbortController();
    const create = (task: Task): LiveTask => {
      const l: LiveTask = { task, requester: env.from, version: 0, streams: new Map(), trace: env.trace, abort, waiters: [] };
      this.live.set(task.id, l);
      // The Task's first change, for the task store: the Task itself, in
      // reply to the request that created it (§5).
      this.publishUpdate(l, { task: cloneTask(task) }, env.id);
      return l;
    };
    const firstAnswer = (): void => {
      if (answered || !live) return;
      answered = true;
      const snapshot = cloneTask(live.task);
      if (streaming) {
        // The stream this request opens: its first event is this answer.
        const final = isTerminalState(snapshot.status.state);
        if (!final) live.streams.set(env.id, { id: env.id, seq: 0, to: env.from, trace: env.trace, ...(sealTo ? { sealTo } : {}) });
        this.answerFirst(env, reply, { task: snapshot }, { streamId: env.id, seq: 0, final }, sealTo);
      } else {
        this.answerFirst(env, reply, { task: snapshot }, undefined, sealTo);
      }
    };

    if (existing) {
      // The client's message joins the history and the Task works again.
      existing.task.history = [...(existing.task.history ?? []), message];
      existing.trace = env.trace;
    }

    const ctx: A2AContext = {
      caller: env.from,
      request,
      envelope: env,
      serviceParams: readServiceParams(env),
      extensions: activatedExtensions(readServiceParams(env)),
      ...(offering !== undefined ? { offering } : {}),
      ...(budgetOf(message) ? { budget: budgetOf(message) } : {}),
      forPerson: isForPerson(message),
      streaming,
      ...(existing ? { existingTask: cloneTask(existing.task) } : {}),
      signal: abort.signal,
      startTask: (init = {}) => {
        if (!live) {
          // A Task id becomes a subject token (§5): a UUID always is one.
          const id = uuid7();
          const contextId = init.contextId ?? message.contextId ?? uuid7();
          live = create({
            id,
            contextId,
            status: { state: init.state ?? "TASK_STATE_SUBMITTED", timestamp: now() },
            history: [{ ...message, taskId: id, contextId }],
            ...(init.metadata ? { metadata: init.metadata } : {}),
          });
        }
        const handle = this.makeHandle(live, () => {
          // Before the first answer has gone, a terminal or interrupted state
          // answers a blocking SendMessage now (A2A §3.1.1).
          if (!answered && !streaming && endsStream(live!.task.status.state)) firstAnswer();
        });
        live.handle = handle;
        // A streaming call answers with the Task the moment it exists, so the
        // client learns its id (§8); a non-blocking call does too.
        if (streaming || request.configuration?.returnImmediately) firstAnswer();
        return handle;
      },
    };

    // A long Task answers with the Task as it stands when the reply window
    // closes, and goes on after (§15: longer than the mesh's reply window).
    const windowMs = this.opts.replyWindowMs ?? 10_000;
    const windowTimer = setTimeout(() => firstAnswer(), windowMs);
    (windowTimer as { unref?: () => void }).unref?.();

    let result: A2AHandlerResult;
    try {
      result = await this.handler(message, ctx);
    } catch (err) {
      clearTimeout(windowTimer);
      if (live && answered) {
        // The Task exists and the client knows it: the error ends it.
        this.makeHandle(live).fail(err instanceof Error ? err.message : String(err));
        return;
      }
      if (live && !existing) {
        // The client never learned of the Task: it ends as failed on the
        // record, and the error is the answer.
        this.makeHandle(live).fail(err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
    clearTimeout(windowTimer);

    if (isHandle(result)) {
      // The handle of the call's own Task: answered below with its Task.
    } else if (isTask(result)) {
      if (!live) {
        if (!isSubjectToken(result.id)) throw A2AErrors.internal("A Task id must be a single subject token (A2A binding §5).");
        live = create(cloneTask(result));
      } else if (JSON.stringify(result) !== JSON.stringify(live.task)) {
        this.emit(live, { task: cloneTask(result) });
      }
    } else if (isMessage(result)) {
      if (!live) {
        this.answerFirst(env, reply, { message: result }, streaming ? { streamId: env.id, seq: 0, final: true } : undefined, sealTo);
        return;
      }
      // A Message from a handler that also started a Task is the Task's
      // status message.
      if (!answered) live.task.status = { ...live.task.status, message: result };
    } else if (!live) {
      throw A2AErrors.invalidAgentResponse("The agent's handler returned neither a Message nor a Task.");
    }

    if (!answered) firstAnswer();
  }

  private answerFirst(
    env: Envelope,
    reply: (resp: Envelope) => void,
    result: { task?: Task; message?: Message },
    stream: { streamId: string; seq: number; final: boolean } | undefined,
    sealTo?: string,
  ): void {
    reply(this.frameOf({ to: env.from, in_reply_to: env.id, trace: childSpan(env.trace), payload: respondPayload(result, stream) }, sealTo));
  }

  /** One change, published for the task store on the Task's update subject
   *  (§5), numbered in the Task's own order. Never sealed: the task manager
   *  reads it. */
  private publishUpdate(live: LiveTask, ev: StreamResponse, inReplyTo?: string): void {
    this.host.publish(
      this.host.updateSubject(live.task.id),
      this.host.frame({
        to: live.requester,
        ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
        trace: childSpan(live.trace),
        payload: respondPayload(ev, { seq: live.version }),
      }),
    );
  }

  /** Emit one event for a Task: fold it in, publish it for the task store,
   *  and send it on every stream open on the Task with that stream's next
   *  seq (§8). The event that ends a stream is its last. */
  private emit(live: LiveTask, ev: StreamResponse, after?: () => void): void {
    const before = live.task;
    const next = applyEvent(live.task, ev);
    if (!next || next === before) return; // a terminal Task does not move
    live.task = next;
    live.version += 1;
    this.publishUpdate(live, ev);
    const final = eventEndsStream(ev);
    for (const st of [...live.streams.values()]) {
      st.seq += 1;
      this.host.publish(
        this.host.streamSubject(live.task.id),
        this.frameOf({ to: st.to, trace: childSpan(st.trace), payload: respondPayload(ev, { streamId: st.id, seq: st.seq, final }) }, st.sealTo),
      );
      if (final) live.streams.delete(st.id);
    }
    after?.();
    if (endsStream(live.task.status.state)) {
      const waiters = live.waiters.splice(0);
      for (const w of waiters) w(cloneTask(live.task));
    }
  }

  private makeHandle(live: LiveTask, after?: () => void): TaskHandle {
    const self = this;
    const status = (state: TaskState, message?: string | Message, metadata?: Record<string, unknown>): void => {
      const t = live.task;
      self.emit(
        live,
        {
          statusUpdate: {
            taskId: t.id,
            contextId: t.contextId ?? "",
            status: { state, ...(message !== undefined ? { message: agentMessage(message, t) } : {}), timestamp: now() },
            ...(metadata ? { metadata } : {}),
          },
        },
        after,
      );
    };
    return {
      get id() {
        return live.task.id;
      },
      get contextId() {
        return live.task.contextId ?? "";
      },
      get task() {
        return cloneTask(live.task);
      },
      status,
      artifact(artifact, opts = {}) {
        const t = live.task;
        self.emit(
          live,
          {
            artifactUpdate: {
              taskId: t.id,
              contextId: t.contextId ?? "",
              artifact,
              ...(opts.append ? { append: true } : {}),
              ...(opts.lastChunk ? { lastChunk: true } : {}),
            },
          },
          after,
        );
      },
      complete: (m) => status("TASK_STATE_COMPLETED", m),
      fail: (m, failure) => status("TASK_STATE_FAILED", m, failure ? { [EXT_FAILURE]: checkedFailure(failure) } : undefined),
      overdue: (m) => status(live.task.status.state, m, { ...OVERDUE_METADATA }),
      completeLate: (m) => status("TASK_STATE_COMPLETED", m ?? "Completed after the deadline.", { [EXT_BUDGET]: { outcome: "completed_late" } }),
      reject: (m, md) => status("TASK_STATE_REJECTED", m, md),
      requireInput: (m) => status("TASK_STATE_INPUT_REQUIRED", m),
      requireAuth: (m) => status("TASK_STATE_AUTH_REQUIRED", m),
      exhausted(text) {
        const ended = exhaustedTask(live.task, text);
        status("TASK_STATE_CANCELED", ended.status.message, ended.metadata);
      },
      insufficient(estimate, text) {
        const ended = insufficientBudgetTask(live.task, estimate, text);
        status("TASK_STATE_REJECTED", ended.status.message, ended.metadata);
      },
      deadlineUnmeetable(earliestCompletion, text) {
        const ended = deadlineUnmeetableTask(live.task, earliestCompletion, text);
        status("TASK_STATE_REJECTED", ended.status.message, ended.metadata);
      },
      ceilingReached(spent, estimateToFinish, text) {
        const paused = ceilingReachedTask(live.task, spent, estimateToFinish, text);
        status("TASK_STATE_INPUT_REQUIRED", paused.status.message, paused.metadata);
      },
      replace(task) {
        self.emit(live, { task: cloneTask(task) }, after);
      },
      settled() {
        if (endsStream(live.task.status.state)) return Promise.resolve(cloneTask(live.task));
        return new Promise<Task>((resolve) => live.waiters.push(resolve));
      },
    };
  }

  /** A Task read back from the store, held in memory so a message continuing
   *  it, or a cancel, has a sequence to continue. */
  private adopt(task: Task, seq: number, requester: string, trace: TraceContext): LiveTask {
    const prior = this.live.get(task.id);
    const l: LiveTask = {
      task: cloneTask(task),
      requester,
      version: seq,
      streams: prior?.streams ?? new Map(),
      trace,
      abort: prior?.abort ?? new AbortController(),
      waiters: prior?.waiters ?? [],
    };
    this.live.set(task.id, l);
    return l;
  }

  // ─── Reads from the task store (§5, §10) ──────────────────────────

  /**
   * One Task for the client that sent `env`, from the durable store, with the
   * node's own copy when it is newer. The store applies §10's rule; when it
   * cannot be reached, the node applies the same rule to its own copy.
   * Anyone but the Task's creator gets TaskNotFoundError.
   */
  private async readTask(env: Envelope, taskId: string): Promise<{ task: Task; seq: number; requester?: string }> {
    const mine = this.live.get(taskId);
    let stored: { task: Task; seq: number; requester?: string } | null = null;
    try {
      const out = (await this.host.serviceRequest(A2A_STORE_SUBJECTS.GET, { frame: env, id: taskId }, this.opts.storeTimeoutMs ?? 5_000)) as {
        task?: Task;
        seq?: number;
        requester?: string;
      };
      if (out && isTask(out.task)) stored = { task: out.task, seq: typeof out.seq === "number" ? out.seq : 0, requester: out.requester };
    } catch (err) {
      const a2a = a2aErrorOf(err);
      if (a2a) {
        // The store does not know it yet (its fold runs behind the node), or
        // says the caller may not read it. The node's own copy decides the
        // first case, under the same rule.
        if (a2a.code === "TaskNotFoundError" && mine && mine.requester === env.from) {
          return { task: cloneTask(mine.task), seq: mine.version, requester: mine.requester };
        }
        throw a2a;
      }
      if (!storeUnreachable(err)) throw err;
    }
    if (stored) {
      if (mine && mine.version >= stored.seq && mine.requester === env.from) {
        return { task: cloneTask(mine.task), seq: mine.version, requester: mine.requester };
      }
      return stored;
    }
    if (mine && mine.requester === env.from) return { task: cloneTask(mine.task), seq: mine.version, requester: mine.requester };
    throw A2AErrors.taskNotFound(taskId);
  }

  private async listTasks(env: Envelope, p: ListTasksRequest): Promise<ListTasksResponse> {
    if (p.pageSize !== undefined && (!Number.isInteger(p.pageSize) || p.pageSize < 1 || p.pageSize > LIST_PAGE_MAX)) {
      throw A2AErrors.invalidParams(`pageSize must be an integer from 1 to ${LIST_PAGE_MAX}.`);
    }
    try {
      const out = (await this.host.serviceRequest(A2A_STORE_SUBJECTS.LIST, { frame: env }, this.opts.storeTimeoutMs ?? 5_000)) as {
        result?: ListTasksResponse;
        seqs?: Record<string, number>;
      };
      if (out?.result && Array.isArray(out.result.tasks)) {
        // The node's newer copies of Tasks the store listed.
        const tasks = out.result.tasks.map((t) => {
          const mine = this.live.get(t.id);
          return mine && mine.requester === env.from && mine.version >= (out.seqs?.[t.id] ?? 0)
            ? shapeTask(mine.task, { historyLength: p.historyLength, includeArtifacts: p.includeArtifacts })
            : t;
        });
        return { ...out.result, tasks };
      }
    } catch (err) {
      const a2a = a2aErrorOf(err);
      if (a2a) throw a2a;
      if (!storeUnreachable(err)) throw err;
    }
    return listFrom(
      [...this.live.values()].filter((l) => l.requester === env.from).map((l) => l.task),
      p,
    );
  }

  private async cancelTask(env: Envelope, p: CancelTaskRequest): Promise<Task> {
    if (typeof p?.id !== "string" || !p.id) throw A2AErrors.invalidParams("CancelTask needs the Task's id.");
    const cancel = cancelReasonFor(p, activatedExtensions(readServiceParams(env)).includes(EXT_CANCEL));
    let live = this.live.get(p.id);
    if (live && live.requester !== env.from) throw A2AErrors.taskNotFound(p.id);
    if (!live) {
      const { task, seq, requester } = await this.readTask(env, p.id);
      live = this.adopt(task, seq, requester ?? env.from, env.trace);
    }
    const state = live.task.status.state;
    if (isTerminalState(state)) throw A2AErrors.taskNotCancelable(p.id, state);
    if (this.opts.onCancel) await this.opts.onCancel(cloneTask(live.task), env.from, cancel);
    live.abort.abort();
    // §12.6: the reason stays on the record, under the cancel URI.
    this.makeHandle(live).status("TASK_STATE_CANCELED", "Canceled at the client's request (" + cancel.reason + ").", {
      ...(p.metadata ?? {}),
      [EXT_CANCEL]: cancel,
    });
    return cloneTask(live.task);
  }
}

/**
 * The reason a CancelTask carries (§12.6), checked against SPEC.md §10.8: a
 * reason from the closed list, a note that is a string, and the field each
 * qualified reason needs (`unmetNeed` with needs_not_furnished, `dependency`
 * with dependency_failed, spelled as the binding spells them). A client
 * that does not declare the extension may send none, which is recorded as
 * user_requested; one that declares it must send one.
 */
export function cancelReasonFor(p: CancelTaskRequest, declared: boolean): A2ACancel {
  const raw = p.metadata?.[EXT_CANCEL];
  if (raw === undefined) {
    if (declared) throw A2AErrors.invalidParams("A client that declares the cancel extension sends a reason (A2A binding §12.6).", { reasons: [...A2A_CANCEL_REASONS] });
    return { reason: "user_requested" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw A2AErrors.invalidParams("The cancel extension's data is an object with a reason.");
  const d = raw as Record<string, unknown>;
  // CancelTask is always a 0.4.0 frame, so the A2A spelling alone (binding
  // §12.6); `unmet_need` belongs to a 0.3.0 cancel's input.
  if (d.unmet_need !== undefined) throw A2AErrors.invalidParams("The cancel extension spells it unmetNeed (A2A binding §12.6).", { reasons: [...A2A_CANCEL_REASONS] });
  const unmetNeed = d.unmetNeed;
  try {
    validateStopFields({ reason: d.reason, note: d.note, unmet_need: unmetNeed, dependency: d.dependency }, true);
  } catch (err) {
    throw A2AErrors.invalidParams(err instanceof Error ? err.message : String(err), { field: "metadata." + EXT_CANCEL, reasons: [...A2A_CANCEL_REASONS] });
  }
  return {
    reason: d.reason as A2ACancel["reason"],
    ...(typeof d.note === "string" ? { note: d.note } : {}),
    ...(typeof unmetNeed === "string" ? { unmetNeed } : {}),
    ...(typeof d.dependency === "string" ? { dependency: d.dependency } : {}),
  };
}

/** A failure reason (§12.7) checked against §10.8: the handler's own
 *  statement, so a malformed one is the handler's bug and throws. */
function checkedFailure(f: A2AFailure): A2AFailure {
  validateStopFields({ reason: f.reason, unmet_need: f.unmetNeed, dependency: f.dependency }, true);
  return { reason: f.reason, ...(f.unmetNeed ? { unmetNeed: f.unmetNeed } : {}), ...(f.dependency ? { dependency: f.dependency } : {}) };
}

/** ListTasks over a set of Tasks the caller may read: filtered, newest status
 *  first, paged by offset (A2A §3.1.4). Shared with the task manager. */
export function listFrom(all: Task[], p: ListTasksRequest): ListTasksResponse {
  const after = p.statusTimestampAfter ? Date.parse(p.statusTimestampAfter) : NaN;
  const matching = all
    .filter((t) => (p.contextId ? t.contextId === p.contextId : true))
    .filter((t) => (p.status && p.status !== "TASK_STATE_UNSPECIFIED" ? t.status.state === p.status : true))
    .filter((t) => (Number.isNaN(after) ? true : Date.parse(t.status.timestamp ?? "") > after))
    .sort((a, b) => (b.status.timestamp ?? "").localeCompare(a.status.timestamp ?? "") || a.id.localeCompare(b.id));
  const size = Math.min(Math.max(p.pageSize ?? LIST_PAGE_DEFAULT, 1), LIST_PAGE_MAX);
  const start = p.pageToken && /^\d+$/.test(p.pageToken) ? Number(p.pageToken) : 0;
  const page = matching.slice(start, start + size);
  const next = start + size < matching.length ? String(start + size) : "";
  return {
    tasks: page.map((t) => shapeTask(t, { historyLength: p.historyLength ?? 0, includeArtifacts: p.includeArtifacts ?? false })),
    nextPageToken: next,
    pageSize: size,
    totalSize: matching.length,
  };
}

/** A Message's content as a 0.3.0 handler's input (§14): the data of a lone
 *  data part, else the text of its text parts as `{text}`, with any files as
 *  `files` beside it. */
export function legacyInputOf(message: Message): unknown {
  const parts = message.parts ?? [];
  const data = parts.filter((p) => p.data !== undefined);
  if (data.length === 1 && parts.length === 1) return data[0].data;
  const text = parts
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
  const files = parts.filter((p) => typeof p.url === "string" || typeof p.raw === "string");
  return {
    ...(text ? { text } : {}),
    ...(data.length ? { data: data.map((p) => p.data) } : {}),
    ...(files.length ? { files } : {}),
  };
}

/** A 0.3.0 handler's output as A2A parts (§14). */
export function partsOfOutput(output: unknown): Part[] {
  if (output === undefined || output === null) return [];
  if (typeof output === "string") return [{ text: output }];
  return [{ data: output }];
}

/** A 0.3.0 request's input as an A2A Message (§14). */
export function messageOfLegacyInput(input: unknown, offering: string | undefined): Message {
  const parts: Part[] =
    typeof input === "string"
      ? [{ text: input }]
      : input && typeof input === "object" && typeof (input as { text?: unknown }).text === "string" && Object.keys(input).length === 1
        ? [{ text: (input as { text: string }).text }]
        : input === undefined
          ? []
          : [{ data: input }];
  return {
    messageId: uuid7(),
    role: "ROLE_USER",
    parts,
    ...(offering ? { metadata: { "https://agentmessaging.ai/extensions/offering/v1": { offering } } } : {}),
  };
}

/** An A2A answer as a 0.3.0 handler's output (§14): a lone data part's data,
 *  else the text. */
export function outputOfParts(parts: Part[]): unknown {
  if (parts.length === 1 && parts[0].data !== undefined) return parts[0].data;
  const text = parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
  if (parts.every((p) => typeof p.text === "string")) return text;
  return { ...(text ? { text } : {}), parts };
}
