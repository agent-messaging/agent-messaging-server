/**
 * The client's side of the A2A binding: one call per A2A operation
 * (bindings/a2a.md §5), each sent as a 0.4.0 request frame to the server
 * agent's inbox, its answers read from the respond frames that come back.
 *
 * Streams (§8): the first event arrives at this agent's inbox; every later one
 * on `mesh.task.{taskId}.stream`, where several streams of one Task may share
 * the subject. Each frame names its stream (`streamId`, the opening request
 * frame's id) and its place in it (`seq`). The client reads its own stream's
 * frames in `seq` order and drops one it has seen. The mesh keeps every
 * stream frame (MESH_TASKS, SPEC.md §18.3) and, once it has checked the client
 * may read the Task, delivers that stream's frames to the client's inbox from
 * the first (`mesh.task.a2a.follow`), so an event sent before the client
 * listened is not lost. A gap is closed with `SubscribeToTask`, which opens a
 * new stream from the Task's current state. Only as a safety net, the client
 * reads the Task with `GetTask` after a long quiet spell; on a mesh that does
 * not deliver streams it subscribes to the subject itself and reads the Task
 * once after it starts listening.
 */
import type { Envelope, TraceContext } from "../types/envelope.js";
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
  call(agentId: string, env: Envelope, timeoutMs: number, opts?: { onLate?: (env: Envelope) => void }): Promise<Envelope>;
  /** Watch a subject for signed frames (each verified before it is passed on). */
  subscribe(subject: string, onFrame: (env: Envelope) => void): { unsubscribe(): void };
  /** The subject of a Task's stream. */
  streamSubject(taskId: string): string;
  /** Ask the mesh to deliver one stream's frames to this agent's inbox, from
   *  the first, after it checks this agent may read the Task (A2A binding §8,
   *  the task manager's `mesh.task.a2a.follow`). True when it will; false when
   *  the mesh does not offer it (the client then subscribes itself). An A2A
   *  error (the Task is not this agent's) is thrown. */
  follow?(taskId: string, opening: Envelope): Promise<boolean>;
  /** Frames of one stream that reach this agent's inbox. Returns the way to
   *  stop listening. */
  onStreamFrame?(streamId: string, onFrame: (env: Envelope) => void): () => void;
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
  /** Further envelope `meta` for the request frame, such as a bridge's
   *  attribution marker (`a2a_bridge`). The keys this call sets itself
   *  (`a2a`, `engagement`, `audience`) win over the same keys here. */
  meta?: Record<string, unknown>;
  /** Seal the payload to the server agent's published encryption key (§8a,
   *  EXT-7); its answers come back sealed to this agent's key. */
  seal?: boolean;
  /**
   * When the agent's node queues the request for later (a queued
   * acknowledgement, SPEC.md §6.4a), the call rejects with REQUEST_QUEUED
   * (its details name `request_id`, `inbox_id`, `delivered`, `paused`).
   * The A2A answer that arrives later, naming that request, is handed here:
   * the result, or the A2AError or MeshError it carried. Kept for a day.
   */
  onLateAnswer?: (answer: { result: unknown } | { error: A2AError | MeshError }, requestId: string) => void;
  /**
   * Handed the signed request frame once it is made, before it is sent, so a
   * caller can record its id and trace even when the call then fails (a
   * queued request, a timeout). For streams, the frame that opens the stream.
   */
  onRequestFrame?: (frame: Envelope) => void;
}

/** A call's answer with the frames it travelled in (`callWithFrames`). */
export interface A2ACallResult<R = unknown> {
  /** The A2A response object, as `call` returns it. */
  result: R;
  /** The request frame's id: what the answer's `in_reply_to`, the receipts
   *  and the meter events derived from the answer name. */
  requestId: string;
  /** The request frame's trace. */
  trace: TraceContext;
  /** The signed request frame, and the answer as it arrived (opened, when it
   *  came sealed). */
  frames: { request: Envelope; response: Envelope };
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
    const meta: Record<string, unknown> = { ...(opts.meta ?? {}), a2a: serviceParams(params2) };
    if (opts.engagement !== undefined) meta.engagement = opts.engagement;
    // §12.3: a Message meant for the person carries meta.audience too, which
    // is what nodes on the mesh read; the two marks agree.
    const message = (params as { message?: Message } | undefined)?.message;
    if (message && isForPerson(message)) meta.audience = "person";
    const env = this.host.frame({ to: agentId, payload: requestPayload(method, params), meta, ...(opts.seal ? { seal: true } : {}) });
    opts.onRequestFrame?.(env);
    return env;
  }

  /** Any operation, by name: one request frame, its one answer. */
  async call<M extends A2AMethod>(
    agentId: string,
    method: M,
    params: A2AOperations[M]["params"],
    opts: A2ACallOptions = {},
  ): Promise<A2AOperations[M]["result"]> {
    return (await this.callWithFrames(agentId, method, params, opts)).result;
  }

  /**
   * `call`, answered with the frames it travelled in: the result, the request
   * frame's id and trace, and the request and response frames themselves. A
   * failed call throws as `call` does; `opts.onRequestFrame` sees the request
   * frame first.
   */
  async callWithFrames<M extends A2AMethod>(
    agentId: string,
    method: M,
    params: A2AOperations[M]["params"],
    opts: A2ACallOptions = {},
  ): Promise<A2ACallResult<A2AOperations[M]["result"]>> {
    const env = this.frameFor(agentId, method, params, opts);
    const onLateAnswer = opts.onLateAnswer;
    const onLate = onLateAnswer
      ? (late: Envelope) => {
          const opened = this.host.open(late);
          if (opened.error) {
            onLateAnswer({ error: A2AError.fromErrorObject(opened.error) ?? MeshError.fromErrorObject(opened.error) }, env.id);
            return;
          }
          const r = readRespondPayload(opened);
          if (r) onLateAnswer({ result: r.result }, env.id);
        }
      : undefined;
    const resp = this.host.open(await this.host.call(agentId, env, opts.timeoutMs ?? 30_000, onLate ? { onLate } : undefined));
    if (resp.error) raise(resp);
    const r = readRespondPayload(resp);
    if (!r) throw A2AErrors.invalidAgentResponse(`The answer to ${method} carried no payload.a2a.result.`);
    return { result: r.result as A2AOperations[M]["result"], requestId: env.id, trace: env.trace, frames: { request: env, response: resp } };
  }

  sendMessage(agentId: string, request: SendMessageRequest | Message, opts?: A2ACallOptions): Promise<SendMessageResponse> {
    return this.call(agentId, "SendMessage", asSendRequest(request), opts);
  }

  /** `sendMessage`, answered with the frames it travelled in (`callWithFrames`). */
  sendMessageWithFrames(agentId: string, request: SendMessageRequest | Message, opts?: A2ACallOptions): Promise<A2ACallResult<SendMessageResponse>> {
    return this.callWithFrames(agentId, "SendMessage", asSendRequest(request), opts);
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
      const onLateAnswer = opts.onLateAnswer;
      const onLate = onLateAnswer
        ? (late: Envelope) => {
            const opened = self.host.open(late);
            if (opened.error) onLateAnswer({ error: A2AError.fromErrorObject(opened.error) ?? MeshError.fromErrorObject(opened.error) }, env.id);
            else {
              const r = readRespondPayload(opened);
              if (r) onLateAnswer({ result: r.result }, env.id);
            }
          }
        : undefined;
      // SubscribeToTask names its Task, so the stream subject is listened to
      // before the request leaves and no event can come first.
      const known = method === "SubscribeToTask" ? (params as { id?: string }).id : undefined;
      const listener = known && isSubjectToken(known) ? await self.listen(agentId, known, env) : null;
      try {
        const first = self.host.open(await self.host.call(agentId, env, opts.timeoutMs ?? 30_000, onLate ? { onLate } : undefined));
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
        yield* self.follow(agentId, state, opts, listener ?? (await self.listen(agentId, state.taskId, env)), ev0);
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

  /**
   * Listen for the frames of one stream, opened by `opening`. The mesh
   * delivers them to this agent's inbox from the first (`durable`), after it
   * checks this agent may read the Task; a mesh that does not offer that is
   * read by subscribing to the Task's stream subject, where only events after
   * the subscription arrive.
   */
  private async listen(agentId: string, taskId: string, opening: Envelope): Promise<StreamListener> {
    const streamId = opening.id;
    const pending = new Map<number, { ev: StreamResponse; final: boolean }>();
    let off: (() => void) | null = null;
    let sub: { unsubscribe(): void } | null = null;
    const l: StreamListener = {
      pending,
      wake: null,
      durable: false,
      stop: () => {
        off?.();
        sub?.unsubscribe();
      },
    };
    const onFrame = (sealed: Envelope) => {
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
    };
    if (this.host.onStreamFrame) off = this.host.onStreamFrame(streamId, onFrame);
    if (this.host.follow && off) {
      try {
        l.durable = await this.host.follow(taskId, opening);
      } catch (err) {
        off();
        throw err;
      }
    }
    if (!l.durable) sub = this.host.subscribe(this.host.streamSubject(taskId), onFrame);
    return l;
  }

  /** The events after `state.lastSeq` of one stream. A gap, or a stream that
   *  stays quiet, is checked with GetTask: a Task that moved on is delivered
   *  as it stands, and a finished one ends the stream. */
  private async *follow(
    agentId: string,
    state: { taskId: string | undefined; lastSeq: number },
    opts: A2AStreamOptions,
    listener: StreamListener,
    first: StreamResponse,
  ): AsyncGenerator<StreamResponse> {
    const taskId = state.taskId!;
    let l = listener;
    // A stream the mesh delivers loses nothing, so a quiet spell is only
    // checked now and then; one read from the subject is checked sooner.
    const idleMs = opts.idleResyncMs ?? (l.durable ? 30_000 : 5_000);
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
    let catchUp = !l.durable;
    try {
      for (;;) {
        let next = l.pending.get(state.lastSeq + 1);
        while (next) {
          l.pending.delete(state.lastSeq + 1);
          // `final` on an event that does not end the stream (an interrupted
          // state, say) is a broken stream (§8).
          if (next.final && !eventEndsStream(next.ev)) throw A2AErrors.invalidAgentResponse("A stream frame said final on an event that does not end the stream (A2A binding §8).");
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
        if (gap) {
          // A gap the subscription cannot close: a new stream from the Task's
          // current state (§8). Its frames are listened for before it is asked.
          const env = this.frameFor(agentId, "SubscribeToTask", { id: taskId }, { ...opts, onRequestFrame: undefined });
          const l2 = await this.listen(agentId, taskId, env);
          let resp: Envelope;
          try {
            resp = this.host.open(await this.host.call(agentId, env, opts.timeoutMs ?? 30_000));
            if (resp.error) raise(resp);
          } catch (err) {
            l2.stop();
            throw err;
          }
          const r = readRespondPayload(resp);
          if (!r) {
            l2.stop();
            throw A2AErrors.invalidAgentResponse("The answer to SubscribeToTask carried no payload.a2a.result.");
          }
          l.stop();
          l = l2;
          state.lastSeq = 0;
          const ev = r.result as StreamResponse;
          note(ev);
          yield ev;
          if (r.final || eventEndsStream(ev)) return;
          continue;
        }
        // A quiet spell, or the first pass: read the Task as the store holds it.
        catchUp = false;
        let task: Task | null = null;
        try {
          task = await this.getTask(agentId, taskId, { ...opts, onRequestFrame: undefined });
        } catch (err) {
          if (err instanceof A2AError) throw err;
          if (!(err instanceof MeshError) || err.code !== ErrorCode.TRANSPORT_TIMEOUT) throw err;
        }
        // Delivered only when it moved on.
        if (task && (task.status.state !== lastState || (task.status.timestamp && task.status.timestamp !== lastStamp))) {
          note({ task });
          yield { task };
          if (isTerminalState(task.status.state)) return;
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
  /** The mesh delivers this stream from its first event (MESH_TASKS). */
  durable: boolean;
  stop(): void;
}

function asSendRequest(r: SendMessageRequest | Message): SendMessageRequest {
  return (r as Message).parts !== undefined && (r as Message).role !== undefined ? { message: r as Message } : (r as SendMessageRequest);
}
