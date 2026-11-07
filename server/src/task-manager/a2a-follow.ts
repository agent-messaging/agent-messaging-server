/**
 * Following a Task's stream through the task manager (A2A binding §8, SPEC.md
 * §14.3's last paragraph).
 *
 * The binding asks two things of a stream: nothing may be lost, even an event
 * published before the client listened, and only nodes hosting an agent that
 * may read the Task may receive it. SPEC.md §14.3 allows either narrowing each
 * credential's subscribe grant to the Task when the Task is created, or
 * serving the stream through a consumer the platform makes only after it
 * checks who may read. This server does the second, because it works the same
 * on both brokers and needs no credential to change while a Task lives:
 *
 *   - `MESH_TASKS` holds every frame published on `mesh.task.*.stream` for the
 *     Task horizon (storage/jetstream/tasks-stream.ts on JetStream, a
 *     Postgres-backed stream on RabbitMQ).
 *   - A client sends `mesh.task.a2a.follow` with its own signed request frame
 *     that opened the stream (SendStreamingMessage or SubscribeToTask) and the
 *     Task id. The task manager checks the frame is the asker's own, and that
 *     the asker created the Task when the store knows it (§10, SPEC.md §7.1).
 *   - It then makes a durable consumer on `mesh.task.{taskId}.stream`, from
 *     the first message the stream holds, and delivers to the client's inbox
 *     each frame of that stream the server agent addressed to the client: the
 *     server agent's own signed frames, unchanged. The inbox is the client's
 *     mailbox, so a client that is away gets them when it comes back. The
 *     frame marked `final` ends the delivery and removes the consumer.
 *
 * Asking again for the same stream resumes the same consumer, so a task
 * manager that restarted, or a client that reconnected, loses nothing. While
 * the 0.3.0 window is open (shared/wire-window.ts) credentials still grant
 * subscribe on `mesh.task.>`, which 0.3.0 clients read directly; once it is
 * closed, this is the only way a stream reaches a reader.
 */
import { createHash } from "node:crypto";
import type { BusMessage, Messaging, StreamStore } from "../storage/index.js";
import type { Envelope } from "../sdk.js";
import { createEnvelope, childSpan, decode, ErrorCode } from "../sdk.js";
import { A2AError, A2A_WIRE_VERSION, readRequestPayload, readRespondPayload } from "../../../sdk-typescript/src/a2a/index.js";
import { isSubjectToken } from "../../../sdk-typescript/src/internal/subjects.js";
import type { A2ATaskStore } from "./a2a-store.js";

/** The service subject. Not `mesh.task.*.stream`, which MESH_TASKS holds. */
export const A2A_FOLLOW_SUBJECT = "mesh.task.a2a.follow";

/** How long one delivery runs without a frame before it lets go (the
 *  consumer stays, and asking again resumes it). */
const IDLE_MS = Number(process.env.A2A_FOLLOW_IDLE_MS ?? 6 * 3600_000);

interface Active {
  stop(): void;
}

function answer(req: Envelope, serviceId: string, body: { payload?: unknown; error?: Envelope["error"] }): Envelope {
  return createEnvelope({
    type: "respond",
    from: serviceId,
    to: req.from,
    in_reply_to: req.id,
    trace: childSpan(req.trace),
    v: A2A_WIRE_VERSION,
    ...body,
  });
}

const notFound = (id?: string) => new A2AError("TaskNotFoundError", "No task with that id.", id ? { taskId: id } : {}).toErrorObject();

export class A2AFollow {
  private readonly active = new Map<string, Active>();

  constructor(
    /** MESH_TASKS, or null when it could not be made (followers then fall
     *  back to reading the Task). */
    private readonly stream: StreamStore | null,
    private readonly store: A2ATaskStore,
    private readonly nc: Pick<Messaging, "publish">,
  ) {}

  /** Durable consumer name for one client's stream. */
  static durableFor(taskId: string, streamId: string, client: string): string {
    return `a2a_follow_${createHash("sha256").update(`${taskId}|${streamId}|${client}`).digest("hex").slice(0, 40)}`;
  }

  async handle(req: Envelope, _msg: BusMessage, serviceId: string): Promise<Envelope> {
    const p = (req.payload ?? {}) as { frame?: unknown; taskId?: unknown };
    const taskId = p.taskId;
    if (!isSubjectToken(taskId)) return answer(req, serviceId, { error: notFound() });
    let frame: Envelope;
    try {
      frame = decode(new TextEncoder().encode(JSON.stringify(p.frame)));
    } catch {
      return answer(req, serviceId, { error: notFound(taskId) });
    }
    // The opening frame is the asker's own, a 0.4.0 stream request to the
    // agent that answers the Task.
    const method = readRequestPayload(frame)?.method;
    const params = (readRequestPayload(frame)?.params ?? {}) as { id?: unknown };
    if (
      frame.from !== req.from ||
      frame.v !== A2A_WIRE_VERSION ||
      frame.type !== "request" ||
      typeof frame.to !== "string" ||
      (method !== "SendStreamingMessage" && method !== "SubscribeToTask") ||
      (method === "SubscribeToTask" && params.id !== taskId)
    ) {
      return answer(req, serviceId, { error: notFound(taskId) });
    }
    // §10, SPEC.md §7.1: when the store knows the Task, only its creator, with
    // the agent that answers it.
    const rec = await this.store.read(taskId).catch(() => null);
    if (rec && (rec.record.requester !== req.from || rec.record.responder !== frame.to)) {
      return answer(req, serviceId, { error: notFound(taskId) });
    }
    if (!this.stream) {
      return answer(req, serviceId, {
        error: { code: ErrorCode.DEPENDENCY_FAILED, message: "This mesh holds no MESH_TASKS stream; read the Task with GetTask.", retryable: false },
      });
    }
    const durable = A2AFollow.durableFor(taskId, frame.id, req.from);
    if (!this.active.has(durable)) await this.deliver(durable, taskId, frame, req.from);
    return answer(req, serviceId, { payload: { following: true, durable } });
  }

  /** Run one delivery: the server agent's frames of this stream, addressed
   *  to the client, onto the client's inbox, until the final one. */
  private async deliver(durable: string, taskId: string, opening: Envelope, client: string): Promise<void> {
    const stream = this.stream!;
    const consumer = await stream.consume(durable, { filter: `mesh.task.${taskId}.stream`, from: "all" });
    let idle: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (idle) clearTimeout(idle);
      this.active.delete(durable);
      try {
        consumer.stop();
      } catch {
        /* already stopped */
      }
    };
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(stop, IDLE_MS);
      (idle as { unref?: () => void }).unref?.();
    };
    this.active.set(durable, { stop });
    arm();
    const inbox = `mesh.agent.${client}.inbox`;
    void (async () => {
      let done = false;
      for await (const d of consumer) {
        arm();
        let env: Envelope | null = null;
        try {
          env = decode(d.data);
        } catch {
          env = null;
        }
        const r = env ? readRespondPayload(env) : null;
        if (env && r && env.v === A2A_WIRE_VERSION && env.from === opening.to && env.to === client && r.streamId === opening.id) {
          this.nc.publish(inbox, d.data);
          if (r.final) done = true;
        }
        d.ack();
        if (done) break;
      }
      stop();
      if (done) await stream.removeConsumer?.(durable).catch(() => undefined);
    })().catch((err) => {
      console.error(`[task-manager] a2a follow ${durable}:`, err instanceof Error ? err.message : err);
      stop();
    });
  }

  /** Stop every delivery (the consumers stay, to be resumed). */
  stopAll(): void {
    for (const a of [...this.active.values()]) a.stop();
  }
}
