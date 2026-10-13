/**
 * MESH_EVENTS on JetStream, for the migration tool (server/tools/
 * migrate-events-stream.mjs) and the tests that read its settings. The stream is
 * the storage layer's (storage/jetstream/events-stream.ts); the core services
 * reach it through the layer (`storage.stream("MESH_EVENTS")`), never here.
 */
export {
  EVENTS_STREAM,
  EVENTS_SUBJECT,
  EVENTS_MIGRATION_TOOL,
  eventsStreamConfig,
  isOverlapError,
  ensureEventsStream,
} from "../storage/jetstream/events-stream.js";
