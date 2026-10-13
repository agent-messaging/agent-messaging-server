/**
 * MESH_FEED on JetStream, for the tests that read its settings. The stream is
 * the storage layer's (storage/jetstream/feed-stream.ts); the core services
 * reach it through the layer (`storage.stream("MESH_FEED")`), never here.
 */
export { FEED_STREAM, FEED_SUBJECT, feedStreamConfig, ensureFeedStream } from "../storage/jetstream/feed-stream.js";
