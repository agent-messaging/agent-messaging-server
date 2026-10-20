import type { Msg, Subscription } from "nats.ws";
import type { Envelope } from "../types/envelope.js";
import type { StreamChunkPayload } from "../types/primitives.js";
import type { ConnectionManager } from "./connection.js";
import type { StreamWriter } from "./offering-router.js";
import type { TaskTracker } from "./task-tracker.js";
import { MeshError, ErrorCode } from "../types/errors.js";
import { createEnvelope } from "./envelope-builder.js";
import { encode, decodeChunk } from "./codec.js";
import { Subjects } from "./subjects.js";
import { childSpan } from "./trace.js";

/** A single chunk received from a streaming response. */
export interface StreamChunk {
  chunk_index: number;
  data: unknown;
  content_type?: string;
  final: boolean;
  envelope: Envelope;
}

export interface StreamWriterParams {
  agentId: string;
  requesterId: string;
  requestId: string;
  taskId: string;
  trace: Envelope["trace"];
  /** Signs an envelope with the responder agent's key. Streams are
   *  authenticated at the stream level (§11.6): the FINAL chunk is always
   *  signed (and carries chunk_count); intermediate chunks are signed only
   *  when the requester asked via config.sign_chunks. */
  sign: (env: Envelope) => Envelope;
  /** Requester asked for per-chunk signatures (config.sign_chunks, §11.6). */
  signChunks?: boolean;
  /** The work was admitted as a trial (Common Agent 7.7): the completion
   *  task update says `trial: true` so the platform gives it a trial receipt. */
  trial?: boolean;
  /** Publishes the completion task update (default: straight to the task's
   *  update subject). The responder routes it so that an id it could not yet
   *  check records nothing (AgentMesh.publishTaskUpdate). */
  publishUpdate?: (encoded: Uint8Array) => void;
}

/** Create a StreamWriter that publishes chunks to the stream subject. */
export function createStreamWriter(
  conn: ConnectionManager,
  params: StreamWriterParams,
): StreamWriter {
  let chunkIndex = 0;
  let closed = false;
  const streamSubject = Subjects.taskStream(params.taskId);

  const writer: StreamWriter = {
    get closed() {
      return closed;
    },
    get taskId() {
      return params.taskId;
    },

    write(data: unknown, contentType?: string): void {
      if (closed) {
        throw new MeshError(
          ErrorCode.STREAM_CLOSED,
          "Cannot write to a closed stream",
        );
      }

      const chunkPayload: StreamChunkPayload = {
        status: "working",
        chunk_index: chunkIndex++,
        final: false,
        content_type: contentType,
        data,
      };

      let chunkEnv = createEnvelope({
        type: "respond",
        from: params.agentId,
        to: params.requesterId,
        in_reply_to: params.requestId,
        task_id: params.taskId,
        trace: childSpan(params.trace),
        payload: chunkPayload,
      });
      // §11.6: intermediate chunks MAY omit sig; sign only when requested.
      if (params.signChunks) chunkEnv = params.sign(chunkEnv);

      conn.publish(streamSubject, encode(chunkEnv));
    },

    end(data?: unknown, contentType?: string): void {
      if (closed) return; // idempotent
      closed = true;

      const finalPayload: StreamChunkPayload = {
        status: "completed",
        chunk_index: chunkIndex++,
        final: true,
        content_type: contentType,
        data: data ?? null,
        // §11.6: the signed final brackets the stream — chunk_count lets the
        // requester detect truncation or injection.
        chunk_count: chunkIndex,
      };

      const finalEnv = params.sign(
        createEnvelope({
          type: "respond",
          from: params.agentId,
          to: params.requesterId,
          in_reply_to: params.requestId,
          task_id: params.taskId,
          trace: childSpan(params.trace),
          payload: finalPayload,
        }),
      );

      conn.publish(streamSubject, encode(finalEnv));

      // Publish task completion update (spec Section 11.3, step 6) — signed,
      // like every non-chunk envelope (§4.5). Carries the final result as
      // `output` so the durable task record preserves the answer for
      // requesters that lost the stream (disconnect, restart).
      const updateEnv = params.sign(
        createEnvelope({
          type: "respond",
          from: params.agentId,
          to: params.requesterId,
          in_reply_to: params.requestId,
          task_id: params.taskId,
          trace: childSpan(params.trace),
          payload: { status: "completed", output: data ?? null, ...(params.trial ? { trial: true } : {}) },
        }),
      );

      if (params.publishUpdate) params.publishUpdate(encode(updateEnv));
      else conn.publish(Subjects.taskUpdate(params.taskId), encode(updateEnv));
    },
  };

  return writer;
}

/** Create an AsyncIterable of StreamChunks from a NATS subscription.
 *  §11.6 verification: intermediate chunks may be unsigned (unless the
 *  requester set config.sign_chunks); the FINAL chunk must be signed and must
 *  carry `chunk_count`, which is checked against the chunks actually received
 *  to detect truncation or injection.
 *
 *  `responderId` is the identity that opened the stream — the `from` of the
 *  verified opening `respond`. It is the missing half of §11.6: a chunk's
 *  signature is verified against the chunk's OWN `from`, so "signed" only ever
 *  meant "somebody signed it", and this iterable had no idea who the stream
 *  belonged to. Anyone able to publish on `mesh.task.<id>.stream` could
 *  substitute a whole streamed answer with self-signed chunks (setting
 *  `chunk_count` to its own count so the truncation check passed too), or kill
 *  a stream at will. Binding every chunk to the opener closes that: the stream
 *  is what the responder said, or it is not the stream. */
export function createChunkIterable(
  sub: Subscription,
  taskId: string,
  tasks: TaskTracker,
  chunkTimeoutMs: number,
  streamTimeoutMs: number,
  requireSignedChunks = false,
  responderId?: string,
): AsyncIterable<StreamChunk> {
  async function* generate(): AsyncGenerator<StreamChunk> {
    const iter = sub[Symbol.asyncIterator]();
    const streamDeadline = Date.now() + streamTimeoutMs;
    let received = 0;

    try {
      while (true) {
        const remaining = streamDeadline - Date.now();
        if (remaining <= 0) {
          throw new MeshError(
            ErrorCode.TRANSPORT_TIMEOUT,
            `Stream timed out after ${streamTimeoutMs}ms for task ${taskId}`,
          );
        }

        const chunkWait = Math.min(chunkTimeoutMs, remaining);

        // Race next message against timeout. The handle is cleared once the
        // race settles: the loser used to stay armed for the full
        // chunk_timeout (30s by default), so a fast stream left one live timer
        // per chunk — tens of thousands of them on a long one.
        let chunkTimer: ReturnType<typeof setTimeout> | undefined;
        let result: IteratorResult<Msg>;
        try {
          result = await Promise.race([
            iter.next(),
            new Promise<never>((_, reject) => {
              chunkTimer = setTimeout(
                () =>
                  reject(
                    new MeshError(
                      ErrorCode.TRANSPORT_TIMEOUT,
                      `No chunk received within ${chunkTimeoutMs}ms for task ${taskId}`,
                    ),
                  ),
                chunkWait,
              );
            }),
          ]);
        } finally {
          if (chunkTimer !== undefined) clearTimeout(chunkTimer);
        }

        if (result.done) break;

        const msg = result.value;
        // A frame that fails structural validation or (when required)
        // signature verification is an injected or corrupt chunk, not the
        // stream's end — drop it and keep consuming (§11.6). Anyone can
        // publish bytes at a subject; only verifying chunks are the stream.
        let env: ReturnType<typeof decodeChunk>;
        try {
          env = decodeChunk(msg.data, requireSignedChunks);
        } catch {
          continue;
        }
        // …and neither is a chunk from the wrong party or the wrong task.
        // Dropped, not thrown, for the same reason (this is the c05 shape):
        // making a forged chunk fatal would hand any publisher a way to kill
        // the stream, which is the attack, not the defence.
        if (responderId !== undefined && env.from !== responderId) continue;
        if (env.task_id !== taskId) continue;

        // An error frame reports a fault rather than carrying a chunk, so it is
        // read before the chunk-shape check below and needs no payload at all.
        if (env.error) {
          tasks.addToHistory(taskId, env);
          received++;
          try {
            tasks.transition(taskId, "failed");
          } catch {
            /* best-effort */
          }
          throw MeshError.fromErrorObject(env.error);
        }

        // …and neither is a frame carrying no chunk. `payload` is OPTIONAL in a
        // structurally valid envelope, so reading `payload.final` off a frame
        // without one threw a TypeError from inside the generator, escaping the
        // caller's for-await: the one-message stream kill c05 closed for
        // undecodable frames, still open for an empty or non-chunk payload. The
        // responder check above cannot rule it out either — an intermediate
        // chunk MAY be unsigned (§11.6), so its `from` is an unverified claim.
        //
        // The drop sits HERE, with the other drops and before `received++`, for
        // the same reason they do: a frame that is not part of the stream must
        // not count toward the final `chunk_count`, or ignoring it would come
        // back as a fatal "incomplete or tampered" at the end of the stream.
        const payload = env.payload as StreamChunkPayload | null | undefined;
        if (typeof payload !== "object" || payload === null || typeof payload.final !== "boolean") {
          continue;
        }
        tasks.addToHistory(taskId, env);
        received++;

        if (payload.final) {
          // §11.6: the final chunk MUST be signed (it brackets the stream)…
          if (typeof env.sig !== "string" || !env.sig) {
            throw new MeshError(
              ErrorCode.IDENTITY_MISMATCH,
              `Final stream chunk for task ${taskId} is unsigned`,
            );
          }
          // …and MUST carry chunk_count, checked against what actually arrived.
          if (payload.chunk_count !== received) {
            throw new MeshError(
              ErrorCode.INVALID_ENVELOPE,
              `Stream for task ${taskId} is incomplete or tampered: ` +
                `final declares ${payload.chunk_count} chunk(s), received ${received}`,
            );
          }
        }

        const chunk: StreamChunk = {
          chunk_index: payload.chunk_index,
          data: payload.data,
          content_type: payload.content_type,
          final: payload.final,
          envelope: env,
        };

        yield chunk;

        if (payload.final) {
          if (payload.status) {
            try {
              tasks.transition(taskId, payload.status);
            } catch {
              /* best-effort */
            }
          }
          return;
        }
      }
    } finally {
      sub.unsubscribe();
    }
  }

  return generate();
}
