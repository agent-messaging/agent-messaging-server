/**
 * The marks the storage layer puts on what a binding hands out, so `storageOf`,
 * `keyedOf` and `messagingOf` (index.ts) can tell a value from any binding from
 * a raw JetStream handle they should adopt. Registered symbols, so the
 * JetStream binding's own copies (storage/jetstream/) are the same marks.
 */
export const KEYED_STORE = Symbol.for("agent-messaging.storage.keyed");
export const STORAGE = Symbol.for("agent-messaging.storage");
export const MESSAGING = Symbol.for("agent-messaging.messaging");
