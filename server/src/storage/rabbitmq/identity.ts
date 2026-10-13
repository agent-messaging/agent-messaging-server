/**
 * The RabbitMQ binding's identity side, put together from settings read by
 * exact name (step 9 of docs/agent-messaging-server-plan.md):
 *
 *   ROOMS_MINT_ISSUER_ACCOUNT        the mesh's account
 *   MESH_ACCOUNT_JWT_FILE            the account JWT first-run made, put into
 *                                    the database at the first start
 *   MESH_OPERATOR_JWT_FILE           the operator JWT: whose keys may sign the account
 *   MESH_AMQP_URL, MESH_AMQP_USER, MESH_AMQP_PASSWORD_FILE
 *                                    the broker and the server's own user
 *   MESH_RABBITMQ_MANAGEMENT_URL     RabbitMQ's management API (http://127.0.0.1:15672)
 *   MESH_BROKER_AUTH_HOST, MESH_BROKER_AUTH_PORT
 *                                    where the broker check listens (127.0.0.1:3006)
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { amqpUrlFromEnv } from "../connect.js";
import { pgSql, postgresConfigFromEnv, type Sql } from "../postgres/sql.js";
import { Management, operatorKeysOf, RabbitMqBrokerAdmin, seedAccount } from "./broker-admin.js";
import { BrokerAuth, brokerAuthServer } from "./broker-auth.js";

const readText = (p: string) => readFileSync(p, "utf8");

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** The virtual host in MESH_AMQP_URL ("/" when it names none). */
export function vhostOf(amqpUrl: string): string {
  const p = new URL(amqpUrl).pathname;
  return p && p !== "/" ? decodeURIComponent(p.slice(1)) : "/";
}

function managementFromEnv(env: NodeJS.ProcessEnv): Management {
  const url = new URL(amqpUrlFromEnv(env, readText));
  return new Management({
    url: need(env, "MESH_RABBITMQ_MANAGEMENT_URL"),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    vhost: vhostOf(url.toString()),
  });
}

/** The key chain's broker administration on RabbitMQ, for one revocation. */
export async function rabbitMqBrokerAdminFromEnv(env: NodeJS.ProcessEnv): Promise<RabbitMqBrokerAdmin> {
  const operatorKeys = operatorKeysOf(readText(need(env, "MESH_OPERATOR_JWT_FILE")).trim());
  const sql = pgSql({ ...postgresConfigFromEnv(env, readText), max: 2 });
  return new RabbitMqBrokerAdmin(sql, managementFromEnv(env), operatorKeys, true);
}

/**
 * Start the broker check RabbitMQ asks about every connection and operation,
 * after putting the account JWT into the database if it is not there yet.
 * Returns the server, to close at shutdown.
 */
export async function startBrokerAuth(sql: Sql, env: NodeJS.ProcessEnv = process.env): Promise<Server> {
  const accountId = need(env, "ROOMS_MINT_ISSUER_ACCOUNT");
  const jwtFile = env.MESH_ACCOUNT_JWT_FILE?.trim();
  if (jwtFile) {
    if (await seedAccount(sql, accountId, readText(jwtFile).trim())) console.log("[broker-auth] the mesh's account is now in the database");
  }
  const auth = new BrokerAuth({ sql, accountId, vhost: vhostOf(amqpUrlFromEnv(env, readText)) });
  const server = brokerAuthServer(auth);
  const host = env.MESH_BROKER_AUTH_HOST?.trim() || "127.0.0.1";
  const port = Number(env.MESH_BROKER_AUTH_PORT ?? 3006);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  console.log(`[broker-auth] answering RabbitMQ's checks on ${host}:${port}`);
  return server;
}
