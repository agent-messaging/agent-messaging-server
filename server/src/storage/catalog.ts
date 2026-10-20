/**
 * Every core store, by its name in the storage layer.
 *
 * The name of each store is the name `docs/store-map.json` gives it, which is
 * also the bucket, stream or object store that holds it on JetStream, so the
 * map, the layer and the broker agree without a translation table.
 * tools/ci/check-store-owners.mjs reads the names from this file and fails when
 * a core store in the map has no name here in the block for its kind, or a
 * name here is not a core store in the map. Each block's entries are written
 * one to a line, `name: { ... },`, which is how the check reads them.
 *
 * What each entry carries is what a binding needs to create the store the
 * first time: for keyed records, how many revisions of a key to keep and how
 * long a value lives. They are the settings each service passed when it
 * created its bucket itself, unchanged. A store that already exists keeps the
 * settings it was made with; JetStream applies these only on creation.
 */

export interface KeyedStoreSpec {
  /** Revisions of one key kept, the newest included. */
  history: number;
  /** How long a value lives, in milliseconds. Absent: forever. */
  readonly ttlMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How often a service writes its heartbeat (shared/service-health.ts), and
 *  how long one counts: three missed beats. */
export const SERVICE_HEARTBEAT_MS = 15_000;
export const SERVICE_HEARTBEAT_TTL_MS = SERVICE_HEARTBEAT_MS * 3;

/** The keyed-record stores. */
export const KEYED_STORES = {
  // The registry: manifests, descriptors, evaluation records, presence.
  mesh_registry: { history: 5 },
  mesh_descriptors: { history: 1 },
  mesh_descriptor_archive: { history: 1 },
  mesh_eval_records: { history: 1 },
  mesh_eval_record_archive: { history: 1 },
  mesh_presence_agent: { history: 1 },
  // Admission: rosters, guards and held knocks.
  mesh_admission: { history: 3 },
  mesh_admission_guards: { history: 1 },
  mesh_held: { history: 1 },
  // The key chain: owners, tenants, limits, boot tokens, stops, mints, revocations.
  mesh_agent_owners: { history: 1 },
  mesh_tenants: { history: 1 },
  mesh_tenant_limits: { history: 1 },
  mesh_boot_tokens: { history: 1, ttlMs: 7 * DAY_MS },
  mesh_stops: { history: 1 },
  mesh_cred_mints: { history: 1 },
  mesh_cred_revocations: { history: 1 },
  mesh_cred_renewal_watch: { history: 1 },
  mesh_agent_key_revocations: { history: 1 },
  mesh_agent_status: { history: 1 },
  // Bring your own identity: the identity systems each tenant trusts, where
  // each agent's identity came from, and which agent holds each outside identity.
  mesh_trust_anchors: { history: 1 },
  mesh_identity_sources: { history: 1 },
  mesh_workload_ids: { history: 1 },
  // Tasks.
  mesh_tasks: { history: 10, ttlMs: 7 * DAY_MS },
  // Rooms: records, the work board and notes.
  mesh_rooms: { history: 1 },
  mesh_board_items: { history: 1 },
  mesh_room_notes: { history: 1 },
  // Files: the artifact index (the bytes are a blob store).
  mesh_artifacts_index: { history: 1 },
  // Activity: the request log and the audit backstop's watch.
  mesh_activity: { history: 1 },
  // The exchange index (activity/exchange-index.ts): who asked whom, per request
  // id, no content, so an answer meters after its ring row is gone. A week, the
  // Task horizon: deferred work answered inside it still meters.
  mesh_activity_requests: { history: 1, ttlMs: 7 * DAY_MS },
  mesh_witness_watch: { history: 1 },
  // Feeds: the latest state of each state feed.
  mesh_feed_state: { history: 1 },
  // Scheduled work's leases and run records, and service heartbeats.
  mesh_sched: { history: 2 },
  mesh_service_health: { history: 1, ttlMs: SERVICE_HEARTBEAT_TTL_MS },
} as const satisfies Record<string, KeyedStoreSpec>;

export type KeyedStoreName = keyof typeof KEYED_STORES;

/**
 * The streams the layer makes itself, by name, with what each holds. Their
 * settings on JetStream are in storage/jetstream/streams.ts, unchanged from
 * when each service made its own.
 */
export const SINGLE_STREAMS = {
  /** Every emitted event (`mesh.event.>`), kept a day while something consumes it. */
  MESH_EVENTS: { holds: "mesh.event.>" },
  /** Every feed publish (`mesh.feed.<owner>.<topic>`), kept a day while the state writer consumes it. */
  MESH_FEED: { holds: "mesh.feed.*.*" },
  /** Usage events (`mesh.event.metering.usage`), kept 400 days for rating. */
  MESH_METERING: { holds: "mesh.event.metering.usage" },
  /** Trace spans (`mesh.trace.>`), a short buffer, only when TRACE_STREAM_ENABLED=1. */
  MESH_TRACE: { holds: "mesh.trace.>" },
} as const;

export type SingleStreamName = keyof typeof SINGLE_STREAMS;

/** Families of streams, one per member, named `<prefix><member id>`. */
export const STREAM_FAMILIES = {
  /** An agent's mailbox: its inbox while it is away (seven days, 25 MB by default). */
  "MESH_INBOX_<agent>": { prefix: "MESH_INBOX_" },
  /** A durable room's record: everything said in it, up to the room's limits. */
  "rooms_<room>": { prefix: "rooms_" },
} as const;

export type StreamFamilyName = keyof typeof STREAM_FAMILIES;

/**
 * The blob stores, by name. Each can live in the binding's own store (on
 * JetStream an object store of this name), in a folder or in Google Cloud
 * Storage, as the operator sets it (storage/blobs.ts).
 */
export const BLOB_STORES = {
  /** The artifact store's bytes (ARTIFACTS_BACKEND). */
  mesh_artifacts: {},
  /** The rooms drive (ROOMS_DRIVE_BACKEND). */
  rooms_drive: {},
} as const;

export type BlobStoreName = keyof typeof BLOB_STORES;
