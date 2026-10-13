/**
 * The storage layer: the one way core code reaches its stores
 * (docs/agent-messaging-server-plan.md, step 8).
 *
 * A core service is handed a `StorageLike`: a `Storage` from any binding, or
 * the JetStream client (or NATS connection) AgentMesh has always handed it,
 * which the layer adopts as the JetStream binding. The platform's calls and the
 * tests' stand-ins therefore needed no change when the services moved behind
 * the layer, and a server on another binding hands its own `Storage` in.
 */
import type { JetStreamClient, NatsConnection } from "nats";
import type { KeyedStore, Messaging, Storage } from "./types.js";
import { isKeyedStore, JetStreamKeyed } from "./jetstream/keyed.js";
import { isStorage, JetStreamStorage, type JetStreamHandle } from "./jetstream/storage.js";
import { isMessaging, NatsMessaging } from "./jetstream/messaging.js";
import { isReplicaError } from "./jetstream/kv.js";

export * from "./types.js";
export * from "./catalog.js";
export * from "./blobs.js";
export { isKeyedStore } from "./jetstream/keyed.js";
export { isStorage } from "./jetstream/storage.js";
export { isMessaging } from "./jetstream/messaging.js";
export { connectMesh, type MeshConnection } from "./connect.js";

/** The key chain's broker administration on the RabbitMQ binding
 *  (storage/rabbitmq/broker-admin.ts), loaded only when a revocation on that
 *  binding asks for it. */
export async function rabbitMqBrokerAdminFromEnv(env: NodeJS.ProcessEnv) {
  const m = await import("./rabbitmq/identity.js");
  return m.rabbitMqBrokerAdminFromEnv(env);
}

/** Start the broker check RabbitMQ asks about connections and operations
 *  (storage/rabbitmq/broker-auth.ts), when the storage is the RabbitMQ
 *  binding's. Null on any other binding. */
export async function startBrokerAuthFor(storage: Storage, env: NodeJS.ProcessEnv = process.env): Promise<{ close(): void } | null> {
  if (storage.binding !== "rabbitmq") return null;
  const { startBrokerAuth } = await import("./rabbitmq/identity.js");
  return startBrokerAuth((storage as unknown as { sql: import("./postgres/sql.js").Sql }).sql, env);
}

/**
 * Whether a store failed because of a setting the operator has to fix at boot
 * (on JetStream, a replica count the cluster cannot hold) rather than because
 * the store is down. Services that run on without an optional store let this
 * one through, so a wrong setting stops the boot instead of degrading it.
 */
export function isStoreSettingError(err: unknown): boolean {
  return isReplicaError(err);
}

/** A `Storage`, or a JetStream handle the layer adopts as one. */
export type StorageLike = Storage | JetStreamHandle;

/** A keyed store, or a JetStream bucket the layer adopts as one. */
export type KeyedLike = KeyedStore | JetStreamKeyed["kv"];

const adopted = new WeakMap<object, Storage>();

/** The storage behind a handle. A handle adopted once is the same storage the
 *  next time, so every service in a process shares one. A service handed the
 *  NATS connection as well as the JetStream client passes both, and the
 *  connection then answers for the stream manager, as it did before. */
export function storageOf(x: StorageLike, connection?: StorageLike | MessagingLike): Storage {
  if (isStorage(x)) return x;
  const conn = connection instanceof NatsMessaging ? connection.nc : connection;
  if (conn !== undefined && conn !== x && !isStorage(conn) && !isMessaging(conn)) {
    return new JetStreamStorage(x as JetStreamHandle, conn as JetStreamHandle);
  }
  if (typeof x === "object" && x !== null) {
    let s = adopted.get(x);
    if (!s) {
      s = new JetStreamStorage(x);
      adopted.set(x, s);
    }
    return s;
  }
  return new JetStreamStorage(x as JetStreamHandle);
}

/**
 * The JetStream client behind a storage on JetStream, for platform code that
 * still reaches JetStream itself (the hooks the platform installs are handed
 * the core's storage). Null on any other binding. Core code never calls it:
 * tools/ci/check-storage-layer.mjs fails on a core file that does.
 */
export function jetStreamOf(x: StorageLike): JetStreamClient | null {
  const s = storageOf(x);
  return s instanceof JetStreamStorage ? s.js : null;
}

/** The messaging interface, or the NATS connection the layer adopts as one. */
export type MessagingLike = Messaging | NatsConnection;

const adoptedConnections = new WeakMap<object, Messaging>();

/** The messaging interface behind a connection: one from any binding as it
 *  is, or the NATS connection AgentMesh has always handed the services, which
 *  the layer adopts (one wrapper per connection). */
export function messagingOf(x: MessagingLike): Messaging {
  if (isMessaging(x)) return x;
  if (typeof x === "object" && x !== null) {
    let m = adoptedConnections.get(x);
    if (!m) {
      m = new NatsMessaging(x as NatsConnection);
      adoptedConnections.set(x, m);
    }
    return m;
  }
  return new NatsMessaging(x as NatsConnection);
}

/**
 * A keyed store from what a constructor was given: a store from any binding as
 * it is, or a JetStream bucket wrapped (with the client it was opened on, which
 * listing needs). `js` may be a `Storage` built on JetStream, or the client.
 */
export function keyedOf(x: KeyedLike, js?: StorageLike): KeyedStore {
  if (isKeyedStore(x)) return x;
  const client = js === undefined ? undefined : isStorage(js) ? (js as JetStreamStorage).js : js;
  return new JetStreamKeyed(x, client as ConstructorParameters<typeof JetStreamKeyed>[1]);
}
