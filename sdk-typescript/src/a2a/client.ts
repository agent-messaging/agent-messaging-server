/**
 * The client's side of the A2A binding: one call per A2A operation
 * (bindings/a2a.md §5), each sent as a 0.4.0 request frame to the server
 * agent's inbox, its answers read from the respond frames that come back.
 *
 * Streams (§8): the first event arrives at this agent's inbox; every later one
 * on `mesh.task.{taskId}.stream`, numbered by `seq`. The client keeps the last
 * `seq` it delivered. An event it has seen is dropped; a gap, or a stream that
 * stays quiet, is closed by calling `SubscribeToTask`, which answers with the
 * Task's current state and the `seq` it stands at, and the stream goes on from
 * there. That is also how a client that lost its connection resumes.
 */
import type { Envelope } from "../types/envelope.js";
import { MeshError, ErrorCode } from "../types/errors.js";
import {
  A2A_PROTOCOL_VERSION,
  endsStream,
  eventEndsStream,
  isA2AFrame,
  readRespondPayload,
  requestPayload,
  serviceParams,
  taskIdOfEvent,
} from "./binding.js";
import { A2AError, A2AErrors } from "./errors.js";
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
  frame(p: { to: string; payload: unknown; meta?: Record<string, unknown> }): Envelope;
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
}

export interface A2AStreamOptions extends A2ACallOptions {
  /** A quiet stream is checked with SubscribeToTask after this long. Default
   *  5 seconds. */
  idleResyncMs?: number;
  /** For a resumed subscription: the last `seq` already delivered. Events up
   *  to it are dropped. */
  afterSeq?: number;
}

/** A stream of A2A events, with the Task id once it is known and the last
 *  `seq` delivered, which is what a client keeps to resume. */
export interface A2AEventStream extends AsyncIterable<StreamResponse> {
  readonly taskId: string | undefined;
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
    return this.host.frame({ to: agentId, payload: requestPayload(method, params), meta });
  }

  /** Any operation, by name: one request frame, its one answer. */
  async call<M extends A2AMethod>(
    agentId: string,
    method: M,
    params: A2AOperations[M]["params"],
    opts: A2ACallOptions = {},
  ): Promise<A2AOperations[M]["result"]> {
    const env = this.frameFor(agentId, method, params, opts);
    const resp = await this.host.call(agentId, env, opts.timeoutMs ?? 30_000);
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

  cancelTask(agentId: string, request: CancelTaskRequest | string, opts?: A2ACallOptions): Promise<Task> {
    return this.call(agentId, "CancelTask", typeof request === "string" ? { id: request } : request, opts);
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
   * A streaming operation (§8). The iterator yields each event once, in
   * `seq` order, and ends after the event marked `final` (or one that puts
   * the Task in a terminal or interrupted state, or a Message without a
   * Task).
   */
  private stream(agentId: string, method: "SendStreamingMessage" | "SubscribeToTask", params: unknown, opts: A2AStreamOptions): A2AEventStream {
    const self = this;
    const state = { taskId: undefined as string | undefined, lastSeq: opts.afterSeq ?? -1 };
    const iterate = async function* (): AsyncGenerator<StreamResponse> {
      const env = self.frameFor(agentId, method, params, opts);
      const first = await self.host.call(agentId, env, opts.timeoutMs ?? 30_000);
      if (first.error) raise(first);
      const r = readRespondPayload(first);
      if (!r) throw A2AErrors.invalidAgentResponse(`The answer to ${method} carried no payload.a2a.result.`);
      const ev0 = r.result as StreamResponse;
      state.taskId = taskIdOfEvent(ev0);
      const seq0 = r.seq ?? 0;
      if (seq0 > state.lastSeq) {
        state.lastSeq = seq0;
        yield ev0;
      }
      if (r.final || eventEndsStream(ev0) || !state.taskId) return;
      yield* self.follow(agentId, state, opts);
    };
    return {
      get taskId() {
        return state.taskId;
      },
      get lastSeq() {
        return state.lastSeq;
      },
      [Symbol.asyncIterator]: iterate,
    };
  }

  /** The events after `state.lastSeq` on a Task's stream subject, with gaps
   *  and silences closed by SubscribeToTask. */
  private async *follow(
    agentId: string,
    state: { taskId: string | undefined; lastSeq: number },
    opts: A2AStreamOptions,
  ): AsyncGenerator<StreamResponse> {
    const taskId = state.taskId!;
    const pending = new Map<number, { ev: StreamResponse; final: boolean }>();
    let wake: (() => void) | null = null;
    const nudge = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const sub = this.host.subscribe(this.host.streamSubject(taskId), (env) => {
      // Only the server agent speaks on its Tasks' streams, in 0.4.0 frames.
      if (env.from !== agentId || !isA2AFrame(env) || env.error) return;
      const r = readRespondPayload(env);
      if (!r || r.seq === undefined || r.seq <= state.lastSeq) return;
      const ev = r.result as StreamResponse;
      if (taskIdOfEvent(ev) !== taskId) return;
      pending.set(r.seq, { ev, final: r.final || eventEndsStream(ev) });
      nudge();
    });
    const idleMs = opts.idleResyncMs ?? 5_000;
    try {
      for (;;) {
        // Deliver what is next in order.
        let next = pending.get(state.lastSeq + 1);
        while (next) {
          pending.delete(state.lastSeq + 1);
          state.lastSeq += 1;
          yield next.ev;
          if (next.final) return;
          next = pending.get(state.lastSeq + 1);
        }
        const gap = pending.size > 0;
        if (!gap) {
          const woke = await new Promise<boolean>((resolve) => {
            const t = setTimeout(() => {
              wake = null;
              resolve(false);
            }, idleMs);
            wake = () => {
              clearTimeout(t);
              resolve(true);
            };
          });
          if (woke) continue;
        }
        // A gap, or nothing for a while: read the Task's current state.
        let snap: { ev: StreamResponse; seq: number; final: boolean } | null = null;
        try {
          const env = this.frameFor(agentId, "SubscribeToTask", { id: taskId }, opts);
          const resp = await this.host.call(agentId, env, opts.timeoutMs ?? 30_000);
          if (resp.error) raise(resp);
          const r = readRespondPayload(resp);
          if (r) snap = { ev: r.result as StreamResponse, seq: r.seq ?? 0, final: r.final };
        } catch (err) {
          // A missing or refused Task ends the stream; a transport hiccup is
          // tried again after the next quiet period.
          if (err instanceof A2AError) throw err;
          if (!(err instanceof MeshError) || err.code !== ErrorCode.TRANSPORT_TIMEOUT) throw err;
        }
        if (snap && snap.seq > state.lastSeq) {
          state.lastSeq = snap.seq;
          for (const k of [...pending.keys()]) if (k <= snap.seq) pending.delete(k);
          yield snap.ev;
          if (snap.final || endsStream(snap.ev.task?.status?.state)) return;
        } else if (gap) {
          // The store has not caught up with the gap yet: skip to what has
          // arrived rather than wait on an event that is gone.
          const lowest = Math.min(...pending.keys());
          state.lastSeq = lowest - 1;
        }
      }
    } finally {
      sub.unsubscribe();
    }
  }
}

function asSendRequest(r: SendMessageRequest | Message): SendMessageRequest {
  return (r as Message).parts !== undefined && (r as Message).role !== undefined ? { message: r as Message } : (r as SendMessageRequest);
}
