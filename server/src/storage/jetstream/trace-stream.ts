/**
 * The `MESH_TRACE` stream (SPEC §13.1.1, §14): a hand-off buffer for spans.
 *
 * This is deliberately NOT a store. Agents that have been told to emit publish
 * `span_completed` events to `mesh.trace.>`; a collector subscribes, converts
 * them and hands them to whatever observability platform the operator already
 * runs. Spans that nobody collects age out, and that is the intended behaviour
 * rather than a gap.
 *
 * Two decisions are encoded here rather than left to an operator's judgement,
 * because getting them wrong turns a buffer into a warehouse nobody asked for:
 *
 * **Retention is hours.** Long enough that a collector restart, a deploy or a
 * network blip does not lose the window; short enough that this can never
 * become the place traces live. Six hours by default. An operator who wants
 * span history keeps it in their own platform, which is built for it and which
 * they already pay for.
 *
 * **The stream is capped in bytes as well as age.** A single misbehaving agent
 * emitting spans in a loop must not be able to fill the disk that everyone
 * else's mail is buffered on. Discard-old, so pressure costs the oldest spans
 * rather than the newest ones or the mailboxes next door.
 *
 * `no_ack` for the same reason the inbox buffer has it: a span is published
 * fire-and-forget on a subject nobody replies to, and a pub-ack racing back
 * would be a reply to a message that expects none.
 */

import type { JetStreamManager } from "nats";
import { RetentionPolicy, DiscardPolicy, StorageType } from "nats";
import { jsReplicas } from "./kv.js";

export const TRACE_STREAM = "MESH_TRACE";
export const TRACE_SUBJECT = "mesh.trace.>";

const MAX_AGE_MS = Number(process.env.TRACE_STREAM_MAX_AGE_MS ?? 6 * 3600_000);
const MAX_BYTES = Number(process.env.TRACE_STREAM_MAX_BYTES ?? 256 * 1024 * 1024);
/** Off unless an operator asks for it, matching the SDK's emission default:
 *  a deployment where nobody emits spans should not carry the stream either. */
const ENABLED = process.env.TRACE_STREAM_ENABLED === "1";

/**
 * Create the stream if it is wanted and missing, and heal the two fields that
 * would make it something other than a buffer.
 *
 * Age and byte drift are healed on purpose. Everything else about the config
 * is an operator's business, but a `MESH_TRACE` that quietly grew a 30-day
 * `max_age` is no longer the thing this module documents, and nothing else
 * would ever notice.
 */
export async function ensureTraceStream(jsm: JetStreamManager): Promise<void> {
  if (!ENABLED) return;

  const config = {
    name: TRACE_STREAM,
    subjects: [TRACE_SUBJECT],
    retention: RetentionPolicy.Limits,
    discard: DiscardPolicy.Old,
    storage: StorageType.File,
    max_age: MAX_AGE_MS * 1_000_000, // ns
    max_bytes: MAX_BYTES,
    num_replicas: jsReplicas(),
    // Spans are published, never requested. See the inbox buffer for the same
    // reasoning: without this, JetStream answers a reply subject nobody is
    // listening on.
    no_ack: true,
  };

  try {
    let info;
    try { info = await jsm.streams.info(TRACE_STREAM); } catch { info = null; }

    if (!info) {
      await jsm.streams.add(config);
      console.log(
        `[registry] ${TRACE_STREAM} created as a hand-off buffer ` +
          `(${MAX_AGE_MS / 3600_000}h / ${Math.round(MAX_BYTES / 1024 / 1024)} MB, discard-old)`,
      );
      return;
    }

    const ageDrift = info.config.max_age !== config.max_age;
    const bytesDrift = info.config.max_bytes !== config.max_bytes;
    if (ageDrift || bytesDrift) {
      await jsm.streams.update(TRACE_STREAM, { ...info.config, max_age: config.max_age, max_bytes: config.max_bytes });
      console.log(
        `[registry] ${TRACE_STREAM} healed back to buffer limits` +
          (ageDrift ? ` (max_age was ${Math.round((info.config.max_age ?? 0) / 3.6e12)}h)` : "") +
          (bytesDrift ? " (max_bytes drifted)" : ""),
      );
    }
  } catch (err) {
    // A missing trace buffer costs telemetry and nothing else, so it must not
    // be able to stop the registry coming up.
    console.error(`[registry] ${TRACE_STREAM} ensure failed:`, err instanceof Error ? err.message : err);
  }
}
