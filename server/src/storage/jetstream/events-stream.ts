/**
 * The platform event stream (SPEC §18.3): MESH_EVENTS, owner of `mesh.event.>`.
 *
 * §18.3 names this stream as required infrastructure: one Interest-retention
 * stream over the whole domain-event namespace, from which every per-subscriber
 * event consumer hangs. Historically this deployment never created it, because
 * two stream families each bound a SLICE of `mesh.event.>` directly (the
 * metering stream on `mesh.event.metering.usage` and each durable room's record
 * on `mesh.event.room.<id>.>`), and nats-server refuses two subject-bound
 * streams whose subjects overlap (err 10065). Sourcing is the coexistence
 * shape: MESH_EVENTS owns the subjects, and those streams become subject-less
 * streams SOURCING their slice from it (shared/metering.ts,
 * rooms/rooms-service.ts). That makes this stream load-bearing for room
 * recording and metering capture, not just for subscriptions.
 *
 * The cutover of a live mesh is NOT done here: a deployment that still holds
 * the old subject-bound streams gets a refusal (10065) on this stream's
 * creation, and the fix is the standalone migration tool, run once from a
 * workstation. This module only says so, loudly, and carries on: a boot must
 * not destroy streams to win an argument about who owns a subject.
 */

import type { JetStreamManager } from "nats";
import { RetentionPolicy, DiscardPolicy, StorageType } from "nats";
import { jsReplicas } from "./kv.js";

export const EVENTS_STREAM = "MESH_EVENTS";
export const EVENTS_SUBJECT = "mesh.event.>";

/** The one migration path off the pre-MESH_EVENTS stream layout. Named in the
 *  refusal log below so the operator reading it knows exactly what to run. */
export const EVENTS_MIGRATION_TOOL = "server/tools/migrate-events-stream.mjs";

/**
 * The §18.3 config, built fresh per call because `num_replicas` reads
 * MESH_JS_REPLICAS at creation time (shared/kv.ts). Exported, not inlined in
 * `ensureEventsStream`, so the migration tool creates the stream from THIS
 * shape and the tool and the service cannot drift.
 */
export function eventsStreamConfig() {
  return {
    name: EVENTS_STREAM,
    subjects: [EVENTS_SUBJECT],
    // Interest, per §18.3: an event nobody has a consumer for is not retained,
    // which is what keeps a whole-namespace stream from being a disk bill,
    // EXCEPT that the sourcing streams (metering, room records) each count as
    // interest for their slice, which is precisely how capture keeps working.
    retention: RetentionPolicy.Interest,
    discard: DiscardPolicy.Old,
    storage: StorageType.File,
    max_age: 24 * 60 * 60 * 1_000_000_000, // 24h in ns (§18.3)
    // §11.4 publish dedupe window. The subject-bound predecessors never set
    // one; the owning stream is where Nats-Msg-Id dedupe has to live now.
    duplicate_window: 2 * 60 * 1_000_000_000, // 2m in ns
    num_replicas: jsReplicas(),
  };
}

/** The server's refusal to bind subjects another stream already owns
 *  (err_code 10065). Matched on the code when the client surfaces it, on the
 *  message when it only kept the description. */
export function isOverlapError(err: unknown): boolean {
  const e = err as { api_error?: { err_code?: number }; message?: string } | null;
  if (e?.api_error?.err_code === 10065) return true;
  return typeof e?.message === "string" && /overlap/i.test(e.message);
}

/**
 * Create MESH_EVENTS if it does not exist. Idempotent; returns whether the
 * stream is usable. FAIL-SOFT on the overlap refusal: that state means the
 * deployment predates the migration and still holds subject-bound
 * MESH_METERING / rooms_* streams, and the remedy is the migration tool, not
 * anything a boot should attempt on its own.
 */
export async function ensureEventsStream(jsm: JetStreamManager): Promise<boolean> {
  try {
    try {
      await jsm.streams.info(EVENTS_STREAM);
      return true;
    } catch {
      /* not there yet; create below */
    }
    await jsm.streams.add(eventsStreamConfig());
    console.log(`[events] stream ${EVENTS_STREAM} created (${EVENTS_SUBJECT}, interest, 24h)`);
    return true;
  } catch (err) {
    if (isOverlapError(err)) {
      console.error(
        `[events] stream ${EVENTS_STREAM} REFUSED: its subjects (${EVENTS_SUBJECT}) overlap ` +
          `an existing subject-bound stream (err 10065). This deployment predates the ` +
          `MESH_EVENTS migration: MESH_METERING and/or rooms_* streams still bind slices of ` +
          `${EVENTS_SUBJECT} directly. Capture continues on the old streams, but §18.3 event ` +
          `consumers have no stream to hang from. Run ${EVENTS_MIGRATION_TOOL} (from a ` +
          `workstation, full-permission credentials) to convert them to sourced streams.`,
      );
    } else {
      console.error(
        `[events] stream ${EVENTS_STREAM} unavailable:`,
        err instanceof Error ? err.message : err,
      );
    }
    return false;
  }
}
