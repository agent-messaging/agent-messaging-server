/**
 * Connecting the core to its binding: the messaging and the storage the core
 * services are handed, and the connection's life, chosen by the setting
 * first-run setup writes (MESH_BROKER):
 *
 *   nats      (the default) one NATS connection gives both.
 *   rabbitmq  an AMQP connection for messaging and Postgres for state (step 9
 *             of docs/agent-messaging-server-plan.md).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Messaging, Storage } from "./types.js";
import { createNatsClient } from "./jetstream/connect.js";
import { NatsMessaging } from "./jetstream/messaging.js";
import { JetStreamStorage } from "./jetstream/storage.js";

export interface MeshConnection {
  /** The binding, as MESH_BROKER names it. */
  readonly binding: string;
  readonly messaging: Messaging;
  readonly storage: Storage;
  /** Whether the connection is open now. */
  isOpen(): boolean;
  /** Finish what is in flight and close. */
  drain(): Promise<void>;
  /** Settles when the connection has closed, for whatever reason. */
  closed(): Promise<void>;
}

/** The bindings MESH_BROKER takes. */
export const BINDINGS = ["nats", "rabbitmq"] as const;

export async function connectMesh(opts: {
  binding?: string;
  servers: string;
  credsFile?: string;
  env?: NodeJS.ProcessEnv;
  /** The connection's name in the broker's views. */
  name?: string;
}): Promise<MeshConnection> {
  const binding = (opts.binding ?? "nats").toLowerCase();
  if (binding === "rabbitmq") return connectRabbitMq(opts.env ?? process.env, opts.name ?? "agent-messaging-server");
  if (binding !== "nats") {
    throw new Error(`MESH_BROKER=${binding}: this server runs on ${BINDINGS.join(" or ")}.`);
  }
  const { nc, js } = await createNatsClient(opts.servers, opts.credsFile);
  return {
    binding,
    messaging: new NatsMessaging(nc),
    storage: new JetStreamStorage(js, nc),
    isOpen: () => !nc.isClosed(),
    drain: () => nc.drain(),
    closed: async () => {
      await nc.closed();
    },
  };
}

/**
 * The AMQP address with the core's own user and password filled in, read by
 * exact name: MESH_AMQP_URL (amqp://host:5672/vhost), MESH_AMQP_USER and the
 * password from MESH_AMQP_PASSWORD_FILE. The URL may carry them itself.
 */
export function amqpUrlFromEnv(env: NodeJS.ProcessEnv, read: (p: string) => string = (p) => readFileSync(p, "utf8")): string {
  const raw = env.MESH_AMQP_URL?.trim();
  if (!raw) throw new Error("MESH_AMQP_URL is not set: where RabbitMQ is, as amqp://host:5672/vhost.");
  const url = new URL(raw);
  if (!url.username && env.MESH_AMQP_USER?.trim()) url.username = encodeURIComponent(env.MESH_AMQP_USER.trim());
  const passFile = env.MESH_AMQP_PASSWORD_FILE?.trim();
  if (!url.password && passFile) {
    let pass: string;
    try {
      pass = read(passFile).trim();
    } catch {
      throw new Error(`MESH_AMQP_PASSWORD_FILE points at ${passFile}, which cannot be read.`);
    }
    url.password = encodeURIComponent(pass);
  }
  return url.toString();
}

async function connectRabbitMq(env: NodeJS.ProcessEnv, name: string): Promise<MeshConnection> {
  const { AmqpLink } = await import("./rabbitmq/link.js");
  const { RabbitMqMessaging } = await import("./rabbitmq/messaging.js");
  const { RabbitMqStorage } = await import("./rabbitmq/storage.js");
  const { CapturePump } = await import("./rabbitmq/capture.js");
  const { pgSql, postgresConfigFromEnv } = await import("./postgres/sql.js");

  const sql = pgSql(postgresConfigFromEnv(env, (p) => readFileSync(p, "utf8")));
  const link = new AmqpLink({ url: amqpUrlFromEnv(env), name });
  await link.open();
  const setup = await link.channel();
  await setup.assertExchange("mesh", "topic", { durable: true });
  await setup.close();
  const messaging = new RabbitMqMessaging(link);
  const blobDir = env.MESH_BLOB_DIR?.trim() || join(env.MESH_DATA_DIR?.trim() || "./data", "blobs");
  const storage = new RabbitMqStorage(link, sql, messaging, blobDir);
  await storage.open();
  const pump = new CapturePump(link, sql);
  await pump.start();
  return {
    binding: "rabbitmq",
    messaging,
    storage,
    isOpen: () => link.isOpen(),
    drain: async () => {
      await messaging.flush().catch(() => undefined);
      await pump.stop();
      await storage.state.close();
      await link.close();
      await sql.close();
    },
    closed: () => link.closed(),
  };
}
