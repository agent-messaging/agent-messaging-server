/**
 * MESH_METERING on JetStream: the usage events (shared/metering.ts publishes
 * them, activity/metering-fold.ts folds them), kept 400 days for rating.
 * Moved here from shared/metering.ts with the storage layer; the settings are
 * the ones it always had.
 */
import type { JetStreamManager } from "nats";
import { RetentionPolicy, DiscardPolicy, StorageType } from "nats";
import { jsReplicas } from "./kv.js";
import { ensureEventsStream, EVENTS_STREAM, EVENTS_MIGRATION_TOOL } from "./events-stream.js";

export const METERING_STREAM = "MESH_METERING";
/** `Subjects.event("metering.usage")` (shared/metering.ts METERING_SUBJECT). */
export const METERING_SUBJECT = "mesh.event.metering.usage";

/** How long the stream keeps events. Rating (§19.6) replays this stream, so
 *  the default is generous; an operator bounded by disk sets it lower. */
const MAX_AGE_DAYS = (() => {
  const n = Number(process.env.METERING_MAX_AGE_DAYS ?? "");
  return Number.isFinite(n) && n > 0 ? n : 400;
})();

/**
 * The metering stream's config: SUBJECT-LESS, sourcing its slice from
 * MESH_EVENTS. The subject binding moved to MESH_EVENTS (§18.3 owns
 * `mesh.event.>`, and nats-server refuses overlapping subject-bound streams;
 * events-stream.ts), so this stream keeps only what was always its own:
 * the 400-day retention rating replays. Exported so the migration tool
 * recreates the stream from THIS shape and cannot drift from the service.
 */
export function meteringStreamConfig() {
  return {
    name: METERING_STREAM,
    retention: RetentionPolicy.Limits,
    discard: DiscardPolicy.Old,
    storage: StorageType.File,
    max_age: MAX_AGE_DAYS * 86_400_000 * 1_000_000, // ns
    num_replicas: jsReplicas(),
    sources: [{ name: EVENTS_STREAM, filter_subject: METERING_SUBJECT }],
    // Plain publishes (emit, no reply subject): no pub-ack race to silence,
    // so no no_ack here, unlike the inbox capture streams. With sourcing the
    // JetStream pub-ack (if a writer ever asked for one) would come from
    // MESH_EVENTS anyway; the writers here use core publish and never see one.
  };
}

/**
 * Create the metering stream if it does not exist. Idempotent; returns whether
 * the stream is usable. A caller that gets `false` MUST fall back to whatever
 * it did before the stream existed (the activity service falls back to direct
 * counter writes) and say so loudly — losing meter events silently would look
 * exactly like a quiet mesh.
 *
 * MESH_EVENTS is ensured FIRST, in here rather than at the call site: the one
 * caller is the activity service's start path (activity/activity-service.ts),
 * and a sourced stream without its source captures nothing; the ordering is
 * this module's invariant, not the caller's.
 */
export async function ensureMeteringStream(jsm: JetStreamManager): Promise<boolean> {
  try {
    // Fail-soft by design: on a pre-migration deployment this logs the 10065
    // refusal (events-stream.ts) and the subject-bound branch below still
    // captures, so the boot degrades loudly instead of failing.
    await ensureEventsStream(jsm);
    try {
      const info = await jsm.streams.info(METERING_STREAM);
      if ((info.config.subjects ?? []).length > 0) {
        // Transition state: the stream predates MESH_EVENTS and still binds
        // METERING_SUBJECT itself. It keeps capturing, which is exactly why a
        // boot must NOT auto-migrate: converting means delete-and-recreate,
        // and this path runs with service credentials on every restart.
        console.error(
          `[metering] stream ${METERING_STREAM} is still SUBJECT-BOUND (pre-MESH_EVENTS ` +
            `layout). Capture continues, but ${EVENTS_STREAM} cannot be created while this ` +
            `stream owns ${METERING_SUBJECT}. Run ${EVENTS_MIGRATION_TOOL} to convert it ` +
            `to a sourced stream; not auto-migrating at boot.`,
        );
      }
      return true;
    } catch {
      /* not there yet — create below */
    }
    await jsm.streams.add(meteringStreamConfig());
    console.log(
      `[metering] stream ${METERING_STREAM} created ` +
        `(sourced from ${EVENTS_STREAM}, ${MAX_AGE_DAYS}d retention)`,
    );
    return true;
  } catch (err) {
    console.error(
      `[metering] stream ${METERING_STREAM} unavailable:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
