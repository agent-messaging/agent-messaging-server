/**
 * The client's side of the A2A binding: one call per A2A operation
 * (bindings/a2a.md §5), each sent as a 0.4.0 request frame to the server
 * agent's inbox, its answers read from the respond frames that come back.
 *
 * Streams (§8): the first event arrives at this agent's inbox; every later one
 * on `mesh.task.{taskId}.stream`, where several streams of one Task may share
 * the subject. Each frame names its stream (`streamId`, the opening request
 * frame's id) and its place in it (`seq`). The client reads its own stream's
 * frames in `seq` order and drops one it has seen. This server has no
 * durable stream behind the subject (SPEC.md §18.3), so a gap, or a stream
 * that stays quiet, is checked with `GetTask`, and the Task as it stands is
 * delivered as an event. A client that lost its connection calls
 * `subscribeToTask`, which opens a new stream from the Task's current state.
 */
import type { Envelope } from "../types/envelope.js";
import { MeshError, ErrorCode } from "../types/errors.js";
import { isSubjectToken } from "../internal/subjects.js";
import {
  A2A_PROTOCOL_VERSION,
  eventEndsStream,
  isTerminalState,
  isA2AFrame,
  readRespondPayload,
  requestPayload,
  serviceParams,
  taskIdOfEvent,
} from "./binding.js";
import { A2AError, A2AErrors } from "./errors.js";
import { EXT_CANCEL, cancelReasonOf, isForPerson, withCancelReason, type A2ACancel } from "./extensions.js";
import type {
  A2AMethod,
  A2AOperations,
  AgentCard,
  CancelTaskRequest,
  DeleteTaskPushNotificationConfigRequest,
  GetExtendedAgentCardRequest,
  GetTaskPushNotificationConfigRequest,
  GetTaskRequest,
  JsonObject,
  ListTaskPushNotificationConfigsRequest,
  ListTaskPushNotificationConfigsResponse,
  ListTasksRequest,
  ListTasksResponse,
  Message,
  SendMessageRequest,
  SendMessageResponse,
  StreamResponse,
  Task,
  TaskPushNotificationConfig,
} from "./types.js";

/** What the client needs from the agent that hosts it. `AgentMesh` provides it. */
export interface A2AClientHost {
  readonly agentId: string;
  /** A signed 0.4.0 request frame to `to`. */
  frame(p: { to: string; payload: unknown; meta?: Record<string, unknown>; seal?: boolean }): Envelope;
  /** A frame with its sealed payload opened (§8a), or the frame as it came. */
  open(env: Envelope): Envelope;
  /** Send a request frame to the agent's inbox and wait for its first answer
   *  (the channel's accept signal does not count). */
  call(agentId: string, env: Envelope, timeoutMs: number): Promise<Envelope>;
  /** Watch a subject for signed frames (each verified before it is passed on). */
  subscribe(subject: string, onFrame: (env: Envelope) => void): { unsubscribe(): void };
  /** The subject of a Task's stream. */
  streamSubject(taskId: string): string;
}

export interface A2ACallOptions {
  /** How long to wait for the answer. Default 30 seconds. */
  timeoutMs?: number;
  /** Service parameters for `meta.a2a` (§7). `A2A-Version` is set for you. */
  serviceParams?: Record<string, string>;
  /** Extensions to activate: joined into `A2A-Extensions` (§12). */
  extensions?: string[];
  /** The engagement this call runs under, recorded beside the Task by the
   *  server (§11). Carried as the envelope's `meta.engagement`. */
  engagement?: string;
  /** Seal the payload to the server agent's published encryption key (§8a,
   *  EXT-7); its answers come back sealed to this agent's key. */
  seal?: boolean;
}

export interface A2AStreamOptions extends A2ACallOptions {
  /** A quiet stream is checked with GetTask after this long. Default 5
   *  seconds. */
  idleResyncMs?: number;
}

/** A stream of A2A events: the Task id once it is known, the stream's id
 *  (its opening request frame's id) and the last `seq` delivered. */
export interface A2AEventStream extends AsyncIterable<StreamResponse> {
  readonly taskId: string | undefined;
  readonly streamId: string | undefined;
  readonly lastSeq: number;
}

function raise(env: Envelope): never {
  const err = env.error!;
  throw A2AError.fromErrorObject(err) ?? MeshError.fromErrorObject(err);
}

export class A2AClient {
  constructor(private readonly host: A2AClientHost) {}

  private frameFor(agentId: string, method: A2AMethod, params: unknown, opts: A2ACallOptions): Envelope {
    const params2: Record<string, string> = { "A2A-Version": A2A_PROTOCOL_VERSION, ...(opts.serviceParams ?? {}) };
    if (opts.extensions?.length) params2["A2A-Extensions"] = opts.extensions.join(",");
    const meta: Record<string, unknown> = { a2a: serviceParams(params2) };
    if (opts.engagement !== undefined) meta.engagement = opts.engagement;
    // §12.3: a Message meant for the person carries meta.audience too, which
    // is what nodes on the mesh read; the two marks agree.
    const message = (params as { message?: Message } | undefined)?.message;
    if (message && isForPerson(message)) meta.audience = "person";
    return this.host.frame({ to: agentId, payload: requestPayload(method, params), meta, ...(opts.seal ? { seal: true } : {}) });
  }

  /** Any operation, by name: one request frame, its one answer. */
  async call<M extends A2AMethod>(
    agentId: string,
    method: M,
    params: A2AOperations[M]["params"],
    opts: A2ACallOptions = {},
  ): Promise<A2AOperations[M]["result"]> {
    const env = this.frameFor(agentId, method, params, opts);
    const resp = this.host.open(await this.host.call(agentId, env, opts.timeoutMs ?? 30_000));
    if (resp.error) raise(resp);
    const r = readRespondPayload(resp);
    if (!r) throw A2AErrors.invalidAgentResponse(`The answer to ${method} carried no payload.a2a.result.`);
    return r.result as A2AOperations[M]["result"];
  }

  sendMessage(agentId: string, request: SendMessageRequest | Message, opts?: A2ACallOptions): Promise<SendMessageResponse> {
    return this.call(agentId, "SendMessage", asSendRequest(request), opts);
  }

  sendStreamingMessage(agentId: string, request: SendMessageRequest | Message, opts?: A2AStreamOptions): A2AEventStream {
    return this.stream(agentId, "SendStreamingMessage", asSendRequest(request), opts ?? {});
  }

  getTask(agentId: string, request: GetTaskRequest | string, opts?: A2ACallOptions): Promise<Task> {
    return this.call(agentId, "GetTask", typeof request === "string" ? { id: request } : request, opts);
  }

  listTasks(agentId: string, request: ListTasksRequest = {}, opts?: A2ACallOptions): Promise<ListTasksResponse> {
    return this.call(agentId, "ListTasks", request, opts);
  }

  /**
   * Cancel a Task, with a reason (§12.6): `opts.cancel`, or one already in
   * the request's metadata under the cancel URI, else `user_requested`. The
   * cancel extension is activated for the call.
   */
  cancelTask(agentId: string, request: CancelTaskRequest | string, opts: A2ACallOptions & { cancel?: A2ACancel } = {}): Promise<Task> {
    const req: CancelTaskRequest = typeof request === "string" ? { id: request } : request;
    const { cancel, ...rest } = opts;
    const withReason = cancelReasonOf(req) ? req : withCancelReason(req, cancel ?? { reason: "user_requested" });
    const extensions = [...new Set([...(rest.extensions ?? []), EXT_CANCEL])];
    return this.call(agentId, "CancelTask", withReason, { ...rest, extensions });
  }

  subscribeToTask(agentId: string, request: { id: string; tenant?: string } | string, opts?: A2AStreamOptions): A2AEventStream {
    return this.stream(agentId, "SubscribeToTask", typeof request === "string" ? { id: request } : request, opts ?? {});
  }

  createTaskPushNotificationConfig(agentId: string, config: TaskPushNotificationConfig, opts?: A2ACallOptions): Promise<TaskPushNotificationConfig> {
    return this.call(agentId, "CreateTaskPushNotificationConfig", config, opts);
  }

  getTaskPushNotificationConfig(agentId: string, request: GetTaskPushNotificationConfigRequest, opts?: A2ACallOptions): Promise<TaskPushNotificationConfig> {
    return this.call(agentId, "GetTaskPushNotificationConfig", request, opts);
  }

  listTaskPushNotificationConfigs(
    agentId: string,
    request: ListTaskPushNotificationConfigsRequest,
    opts?: A2ACallOptions,
  ): Promise<ListTaskPushNotificationConfigsResponse> {
    return this.call(agentId, "ListTaskPushNotificationConfigs", request, opts);
  }

  deleteTaskPushNotificationConfig(agentId: string, request: DeleteTaskPushNotificationConfigRequest, opts?: A2ACallOptions): Promise<JsonObject> {
    return this.call(agentId, "DeleteTaskPushNotificationConfig", request, opts);
  }

  getExtendedAgentCard(agentId: string, request: GetExtendedAgentCardRequest = {}, opts?: A2ACallOptions): Promise<AgentCard> {
    return this.call(agentId, "GetExtendedAgentCard", request, opts);
  }

  /**
   * A streaming operation (§8). The iterator yields each event of this
   * request's stream once, in `seq` order, and ends after the event marked
   * `final`: a terminal state, or a Message that answers without a Task. It
   * stays open through an interrupted state, as A2A says.
   */
  private stream(agentId: string, method: "SendStreamingMessage" | "SubscribeToTask", params: unknown, opts: A2AStreamOptions): A2AEventStream {
    const self = this;
    const state = { taskId: undefined as string | undefined, streamId: undefined as string | undefined, lastSeq: -1 };
    const iterate = async function* (): AsyncGenerator<StreamResponse> {
      const env = self.frameFor(agentId, method, params, opts);
      state.streamId = env.id;
      // SubscribeToTask names its Task, so the stream subject is listened to
      // before the request leaves and no event can come first.
      const known = method === "SubscribeToTask" ? (params as { id?: string }).id : undefined;
      const listener = known && isSubjectToken(known) ? self.listen(agentId, known, env.id) : null;
      try {
        const first = self.host.open(await self.host.call(agentId, env, opts.timeoutMs ?? 30_000));
        if (first.error) raise(first);
        const r = readRespondPayload(first);
        if (!r) throw A2AErrors.invalidAgentResponse(`The answer to ${method} carried no payload.a2a.result.`);
        const ev0 = r.result as StreamResponse;
        state.taskId = taskIdOfEvent(ev0);
        state.lastSeq = 0;
        yield ev0;
        if (r.final || eventEndsStream(ev0) || !state.taskId) return;
        // A Task id becomes a subject token (§5); one that cannot is refused.
        if (!isSubjectToken(state.taskId)) throw A2AErrors.invalidAgentResponse("The Task id is not a single subject token (A2A binding §5).");
        yield* self.follow(agentId, state, opts, listener ?? self.listen(agentId, state.taskId, env.id), ev0);
      } finally {
        listener?.stop();
      }
    };
    return {
      get taskId() {
        return state.taskId;
      },
      get lastSeq() {
        return state.lastSeq;
      },
      get streamId() {
        return state.streamId;
      },
      [Symbol.asyncIterator]: iterate,
    };
  }

  /** Listen on a Task's stream subject for the frames of one stream. */
  private listen(agentId: string, taskId: string, streamId: string): StreamListener {
    const pending = new Map<number, { ev: StreamResponse; final: boolean }>();
    const l: StreamListener = {
      pending,
      wake: null,
      stop: () => sub.unsubscribe(),
    };
    const sub = this.host.subscribe(this.host.streamSubject(taskId), (sealed) => {
      const env = this.host.open(sealed);
      // Only the server agent speaks on its Tasks' streams, in 0.4.0 frames,
      // and several streams share the subject: this one's frames only.
      if (env.from !== agentId || !isA2AFrame(env) || env.error) return;
      const r = readRespondPayload(env);
      if (!r || r.streamId !== streamId || r.seq === undefined) return;
      const ev = r.result as StreamResponse;
      if (taskIdOfEvent(ev) !== taskId) return;
      if (!pending.has(r.seq)) pending.set(r.seq, { ev, final: r.final || eventEndsStream(ev) });
      const w = l.wake;
      l.wake = null;
      w?.();
    });
    return l;
  }

  /** The events after `state.lastSeq` of one stream. A gap, or a stream that
   *  stays quiet, is checked with GetTask: a Task that moved on is delivered
   *  as it stands, and a finished one ends the stream. */
  private async *follow(
    agentId: string,
    state: { taskId: string | undefined; lastSeq: number },
    opts: A2AStreamOptions,
    l: StreamListener,
    first: StreamResponse,
  ): AsyncGenerator<StreamResponse> {
    const taskId = state.taskId!;
    const idleMs = opts.idleResyncMs ?? 5_000;
    let lastState: string | undefined;
    let lastStamp: string | undefined;
    const note = (ev: StreamResponse) => {
      const st = ev.task?.status ?? ev.statusUpdate?.status;
      if (st) {
        lastState = st.state;
        lastStamp = st.timestamp ?? lastStamp;
      }
    };
    note(first);
    // Events the server sent before this subscription existed are not kept
    // for it (no durable stream on this server), so the first pass reads the
    // Task once, as a quiet spell would.
    let catchUp = true;
    try {
      for (;;) {
        let next = l.pending.get(state.lastSeq + 1);
        while (next) {
          l.pending.delete(state.lastSeq + 1);
          state.lastSeq += 1;
          note(next.ev);
          yield next.ev;
          if (next.final) return;
          next = l.pending.get(state.lastSeq + 1);
        }
        for (const k of [...l.pending.keys()]) if (k <= state.lastSeq) l.pending.delete(k);
        const gap = l.pending.size > 0;
        if (!gap && !catchUp) {
          const woke = await new Promise<boolean>((resolve) => {
            const t = setTimeout(() => {
              l.wake = null;
              resolve(false);
            }, idleMs);
            l.wake = () => {
              clearTimeout(t);
              resolve(true);
            };
          });
          if (woke) continue;
        }
        // A gap, a quiet spell, or the first pass: read the Task as the store
        // holds it.
        catchUp = false;
        let task: Task | null = null;
        try {
          task = await this.getTask(agentId, taskId, opts);
        } catch (err) {
          if (err instanceof A2AError) throw err;
          if (!(err instanceof MeshError) || err.code !== ErrorCode.TRANSPORT_TIMEOUT) throw err;
        }
        // After a gap the Task holds what was lost, so it is always delivered;
        // after a quiet spell, only when it moved on.
        if (task && (gap || task.status.state !== lastState || (task.status.timestamp && task.status.timestamp !== lastStamp))) {
          note({ task });
          yield { task };
          if (isTerminalState(task.status.state)) return;
        }
        if (gap) {
          // What was lost is in the Task just delivered (or the store has not
          // caught up): go on from what has arrived.
          state.lastSeq = Math.min(...l.pending.keys()) - 1;
        }
      }
    } finally {
      l.stop();
    }
  }
}

interface StreamListener {
  pending: Map<number, { ev: StreamResponse; final: boolean }>;
  wake: (() => void) | null;
  stop(): void;
}

function asSendRequest(r: SendMessageRequest | Message): SendMessageRequest {
  return (r as Message).parts !== undefined && (r as Message).role !== undefined ? { message: r as Message } : (r as SendMessageRequest);
}
