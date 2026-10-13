/**
 * First-run setup's RabbitMQ part (step 9 of
 * docs/agent-messaging-server-plan.md, "On RabbitMQ").
 *
 * RabbitMQ has no operator → account → user chain, so the key chain is the
 * root of trust, exactly as on NATS: an operator, its signing key, and the
 * mesh's one account with its two signing keys (the server's, and the one
 * every agent credential is signed with, which the mesh pause takes out). The
 * account JWT is the binding's resolver; the server puts it into Postgres at
 * its first start and RabbitMQ's HTTP authentication backend asks the server
 * about every node connection (storage/rabbitmq/broker-auth.ts).
 *
 * What it makes, under the folder first-run fills:
 *
 *   keystore/        the operator's keystore in nsc's layout, as on NATS: the
 *                    operator identity key and every other seed. Keep a copy
 *                    offline.
 *   creds/           operator-signing.nk, core-mint.nk, customer-mint.nk (the
 *                    same settings as on NATS), amqp-core.password (the
 *                    server's own RabbitMQ user), a2a-gateway.creds (the A2A
 *                    gateway's node credential, as on NATS) and, when
 *                    first-run made the database's password, postgres.password.
 *   a2a-gateway.env  the gateway's CREDS_FILE and MESH_URL (an amqp:// address).
 *   rabbitmq/        rabbitmq.conf, enabled_plugins and definitions.json for
 *                    the broker (the mesh's virtual host and topic exchange,
 *                    and the server's own user, as a salted hash), the
 *                    operator and account JWTs, and schema.sql, the tables the
 *                    server keeps in Postgres.
 *   account-history/ where the account JWT is saved before each change.
 *
 * Postgres is a separate service, never embedded: the server is pointed at a
 * database with MESH_POSTGRES_URL and MESH_POSTGRES_PASSWORD_FILE. When
 * MESH_POSTGRES_URL is set while first-run runs, the tables are made there and
 * then; it needs only the rights to make tables and functions. When it is not,
 * first-run writes the default for the Postgres that Compose brings up, a
 * password for it, and the server makes its tables at its first start.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nkeys } from "nats";
import { encodeAccount, encodeOperator, encodeUser } from "nats-jwt";
import { fencedNodePermissions } from "../keychain/cred-template.js";
import { ACCOUNT_SETTING, SIGNING_KEY_SETTING } from "../keychain/live-revoke.js";
import { CUSTOMER_KEY_SETTING, CUSTOMER_SEED_SETTING, JWT_HISTORY_SETTING } from "../keychain/split-keys.js";
import { applySchema, SCHEMA_SQL } from "../storage/postgres/schema.js";
import { pgSql, postgresConfigFromEnv } from "../storage/postgres/sql.js";
import { credsFileText } from "../shared/creds-file.js";
import type { BrokerSetup, BrokerSetupResult, SetupContext } from "./broker-setup.js";
import type { Setting } from "./server-env.js";

type KeyPair = ReturnType<typeof nkeys.createOperator>;
const td = new TextDecoder();
const seedOf = (kp: KeyPair): string => td.decode(kp.getSeed());

export const MESH_ACCOUNT = "mesh";
/** The server's own RabbitMQ user. */
export const CORE_AMQP_USER = "mesh-core";

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} is "${raw}", which is not a port number.`);
  return n;
}

/** RabbitMQ's own password hash (rabbit_password_hashing_sha256): a 4-byte
 *  salt, then SHA-256 of salt and password, in base64. */
export function rabbitPasswordHash(password: string, salt: Buffer = randomBytes(4)): string {
  const digest = createHash("sha256").update(Buffer.concat([salt, Buffer.from(password, "utf8")])).digest();
  return Buffer.concat([salt, digest]).toString("base64");
}

/** The broker's definitions: the virtual host, the topic exchange, and the server's user. */
export function definitionsJson(o: { vhost: string; passwordHash: string }): string {
  return `${JSON.stringify(
    {
      rabbit_version: "4",
      users: [{ name: CORE_AMQP_USER, password_hash: o.passwordHash, hashing_algorithm: "rabbit_password_hashing_sha256", tags: ["administrator"] }],
      vhosts: [{ name: o.vhost }],
      permissions: [{ user: CORE_AMQP_USER, vhost: o.vhost, configure: ".*", write: ".*", read: ".*" }],
      exchanges: [{ name: "mesh", vhost: o.vhost, type: "topic", durable: true, auto_delete: false, internal: false, arguments: {} }],
    },
    null,
    2,
  )}\n`;
}

/** The broker's settings: loopback-or-not listeners, the 1 MB message cap the
 *  NATS binding has, the definitions, and the HTTP check for every node. */
export function rabbitmqConfText(o: {
  amqpPort: number;
  managementPort: number;
  definitions: string;
  brokerAuthUrl: string;
  written: string;
  /** Listen on this address only (MESH_RABBITMQ_LISTEN_ADDRESS); every interface when unset. */
  listen?: string;
}): string {
  const auth = o.brokerAuthUrl.replace(/\/$/, "");
  const ip = o.listen?.trim();
  return `# RabbitMQ for an Agent Messaging Server, written by first-run setup on ${o.written}.
# The server's own user is in the definitions. Every other connection is a node
# presenting a credential the key chain signed, which RabbitMQ asks the server
# to check (the HTTP authentication backend).
listeners.tcp.default = ${ip ? `${ip}:` : ""}${o.amqpPort}
management.tcp.port = ${o.managementPort}
${ip ? `management.tcp.ip = ${ip}\n` : ""}
# Set, not inherited: the largest message, as on the NATS binding.
max_message_size = 1048576

load_definitions = ${resolve(o.definitions).replace(/\\/g, "/")}

auth_backends.1 = internal
auth_backends.2 = http
auth_http.http_method = post
auth_http.user_path = ${auth}/broker-auth/user
auth_http.vhost_path = ${auth}/broker-auth/vhost
auth_http.resource_path = ${auth}/broker-auth/resource
auth_http.topic_path = ${auth}/broker-auth/topic
`;
}

function nscKeyPath(keystore: string, pub: string): string {
  return join(keystore, "keys", pub[0]!, pub.slice(1, 3), `${pub}.nk`);
}

export const rabbitmqSetup: BrokerSetup = {
  name: "rabbitmq",

  async create(ctx: SetupContext): Promise<BrokerSetupResult> {
    const { dir, env } = ctx;
    const amqpPort = port(env, "MESH_AMQP_PORT", 5672);
    const managementPort = port(env, "MESH_RABBITMQ_MANAGEMENT_PORT", 15672);
    const authPort = port(env, "MESH_BROKER_AUTH_PORT", 3006);
    const vhost = env.MESH_AMQP_VHOST?.trim() || "mesh";
    const written = new Date().toISOString();
    const operatorName = ctx.meshName;

    const keystore = join(dir, "keystore");
    const credsDir = join(dir, "creds");
    const rmqDir = join(dir, "rabbitmq");
    const historyDir = join(dir, "account-history");
    for (const d of [keystore, credsDir, historyDir]) ctx.mkdirPrivate(d);
    ctx.mkdirPublic(rmqDir);

    // ── the key chain: the same operator and account as on NATS ─────────
    const operator = nkeys.createOperator();
    const operatorSigning = nkeys.createOperator();
    const mesh = nkeys.createAccount();
    const coreMint = nkeys.createAccount();
    const customerMint = nkeys.createAccount();
    const operatorJwt = await encodeOperator(operatorName, operator as never, { signing_keys: [operatorSigning.getPublicKey()] });
    const accountJwt = await encodeAccount(
      MESH_ACCOUNT,
      mesh as never,
      { signing_keys: [coreMint.getPublicKey(), customerMint.getPublicKey()], default_permissions: { pub: {}, sub: {} }, authorization: {} } as never,
      { signer: operatorSigning as never },
    );

    ctx.writePublic(join(keystore, ".gitignore"), "# ignore all nk files \n**/*.nk\n\n# ignore all creds files\n**/*.creds\n");
    const opStore = join(keystore, operatorName);
    ctx.mkdirPrivate(join(opStore, "accounts", MESH_ACCOUNT, "users"));
    ctx.writePublic(join(opStore, ".nsc"), JSON.stringify({ managed: false, name: operatorName, kind: "operator", version: "1" }));
    ctx.writePublic(join(opStore, `${operatorName}.jwt`), operatorJwt);
    ctx.writePublic(join(opStore, "accounts", MESH_ACCOUNT, `${MESH_ACCOUNT}.jwt`), accountJwt);
    for (const kp of [operator, operatorSigning, mesh, coreMint, customerMint]) {
      const path = nscKeyPath(keystore, kp.getPublicKey());
      ctx.mkdirPrivate(join(path, ".."));
      ctx.writeSecret(path, seedOf(kp));
    }

    const operatorSigningFile = join(credsDir, "operator-signing.nk");
    const coreMintFile = join(credsDir, "core-mint.nk");
    const customerMintFile = join(credsDir, "customer-mint.nk");
    ctx.writeSecret(operatorSigningFile, seedOf(operatorSigning));
    ctx.writeSecret(coreMintFile, seedOf(coreMint));
    ctx.writeSecret(customerMintFile, seedOf(customerMint));

    // The A2A gateway's node credential, as on NATS: fenced (it hosts the
    // outside agents it learns about later), signed by the server's signing
    // key, no expiry. RabbitMQ's checks (broker-auth.ts) accept it as any
    // node's, from its permissions.
    const gateway = nkeys.createUser();
    const gatewayJwt = await encodeUser("a2a-gateway", gateway as never, coreMint as never, { ...fencedNodePermissions(), issuer_account: mesh.getPublicKey() } as never, {});
    const gatewayCreds = credsFileText(gatewayJwt, seedOf(gateway));
    const gatewayCredsFile = join(credsDir, "a2a-gateway.creds");
    ctx.writeSecret(gatewayCredsFile, gatewayCreds);
    const gatewayKeyPath = nscKeyPath(keystore, gateway.getPublicKey());
    ctx.mkdirPrivate(join(gatewayKeyPath, ".."));
    ctx.writeSecret(gatewayKeyPath, seedOf(gateway));
    ctx.writePublic(join(opStore, "accounts", MESH_ACCOUNT, "users", "a2a-gateway.jwt"), gatewayJwt);

    const operatorJwtFile = join(rmqDir, "operator.jwt");
    const accountJwtFile = join(rmqDir, "account.jwt");
    ctx.writePublic(operatorJwtFile, `${operatorJwt}\n`);
    ctx.writePublic(accountJwtFile, `${accountJwt}\n`);

    // ── RabbitMQ ─────────────────────────────────────────────────────────
    const amqpPassword = randomBytes(24).toString("base64url");
    const amqpPasswordFile = join(credsDir, "amqp-core.password");
    ctx.writeSecret(amqpPasswordFile, `${amqpPassword}\n`);
    const definitions = join(rmqDir, "definitions.json");
    ctx.writePublic(definitions, definitionsJson({ vhost, passwordHash: rabbitPasswordHash(amqpPassword) }));
    const brokerAuthUrl = env.MESH_BROKER_AUTH_URL?.trim() || `http://127.0.0.1:${authPort}`;
    ctx.writePublic(join(rmqDir, "rabbitmq.conf"), rabbitmqConfText({ amqpPort, managementPort, definitions, brokerAuthUrl, written, listen: env.MESH_RABBITMQ_LISTEN_ADDRESS }));
    ctx.writePublic(join(rmqDir, "enabled_plugins"), "[rabbitmq_management,rabbitmq_auth_backend_http].\n");

    // ── Postgres: a separate service, pointed at by a URL ────────────────
    ctx.writePublic(join(rmqDir, "schema.sql"), SCHEMA_SQL);
    let pgUrl = env.MESH_POSTGRES_URL?.trim() || "";
    let pgPasswordFile = env.MESH_POSTGRES_PASSWORD_FILE?.trim() || "";
    const made: BrokerSetupResult["made"] = [];
    let tables = "made by the server at its first start";
    if (pgUrl) {
      try {
        const sql = pgSql({ ...postgresConfigFromEnv(env, (p) => readFileSync(p, "utf8")), max: 1 });
        try {
          await applySchema(sql);
        } finally {
          await sql.close();
        }
        tables = "made now";
      } catch (err) {
        throw new Error(
          `MESH_POSTGRES_URL is set, but its tables could not be made there (${err instanceof Error ? err.message : err}). ` +
            `The database user needs the right to create tables and functions in it.`,
        );
      }
    } else {
      // The default: the Postgres that Compose brings up, with a password made here.
      pgUrl = `postgres://mesh@127.0.0.1:5432/mesh`;
      pgPasswordFile = join(credsDir, "postgres.password");
      ctx.writeSecret(pgPasswordFile, `${randomBytes(24).toString("base64url")}\n`);
      made.push({ what: "database password", where: "creds/postgres.password", detail: "for the Postgres that Compose brings up (POSTGRES_PASSWORD_FILE)" });
    }

    const endpoints = env.MESH_AMQP_ENDPOINTS?.trim() || `amqp://localhost:${amqpPort}/${encodeURIComponent(vhost)}`;
    const settings: Setting[] = [
      { name: "MESH_BROKER", value: "rabbitmq", about: "The binding: RabbitMQ, with Postgres beside it for state." },
      { name: "MESH_AMQP_URL", value: `amqp://127.0.0.1:${amqpPort}/${encodeURIComponent(vhost)}`, about: "Where RabbitMQ is, from the server's side, with the mesh's virtual host." },
      { name: "MESH_AMQP_USER", value: CORE_AMQP_USER, about: "The server's own RabbitMQ user." },
      { name: "MESH_AMQP_PASSWORD_FILE", value: amqpPasswordFile, about: "Its password." },
      { name: "MESH_RABBITMQ_MANAGEMENT_URL", value: `http://127.0.0.1:${managementPort}`, about: "RabbitMQ's management API, which closes a revoked node's connections." },
      { name: "MESH_POSTGRES_URL", value: pgUrl, about: "The database the server keeps its state in. Any Postgres the server can reach; the password is not written here." },
      ...(pgPasswordFile ? [{ name: "MESH_POSTGRES_PASSWORD_FILE", value: pgPasswordFile, about: "The database password." }] : []),
      { name: "MESH_BROKER_AUTH_PORT", value: String(authPort), about: "Where the server answers RabbitMQ's checks of node connections." },
      { name: SIGNING_KEY_SETTING, value: operatorSigningFile, about: "The operator signing key, which re-signs the account to revoke a credential live." },
      { name: "MESH_OPERATOR_JWT_FILE", value: operatorJwtFile, about: "The operator JWT: whose keys may sign the account." },
      { name: "MESH_ACCOUNT_JWT_FILE", value: accountJwtFile, about: "The account JWT first-run made. The server puts it into the database at its first start; after that the database's copy is the one that counts." },
      { name: ACCOUNT_SETTING, value: mesh.getPublicKey(), about: "The mesh's account, which every credential is minted under." },
      { name: "ROOMS_MINT_SEED_FILE", value: coreMintFile, about: "The account signing key the server's own credentials are signed with." },
      { name: CUSTOMER_SEED_SETTING, value: customerMintFile, about: "The account signing key every agent credential is signed with." },
      { name: "MESH_BRIDGE_NODES", value: gateway.getPublicKey(), about: "The node the gateway runs as, which may speak for callers that hold no mesh key (identity bridges, SPEC §4.15)." },
      { name: CUSTOMER_KEY_SETTING, value: customerMint.getPublicKey(), about: "Its public key, which the mesh pause takes out of the account and the resume puts back." },
      { name: JWT_HISTORY_SETTING, value: historyDir, about: "Where the account JWT is saved before each change." },
      { name: "MESH_AMQP_ENDPOINTS", value: endpoints, about: "The broker addresses handed to agents with their credentials. Use addresses agents can reach." },
    ];

    return {
      settings,
      otherSettings: [
        {
          file: "a2a-gateway.env",
          header: [
            "The A2A gateway's settings, written by first-run setup. Holds no secret, only where one is.",
            "Pass it to the gateway's container with --env-file, or set the same names in its environment.",
          ],
          settings: [
            { name: "CREDS_FILE", value: gatewayCredsFile, about: "The gateway's node credential." },
            { name: "MESH_URL", value: `amqp://127.0.0.1:${amqpPort}/${encodeURIComponent(vhost)}`, about: "The broker's AMQP address, from the gateway's side; its scheme picks the transport." },
          ],
        },
      ],
      made: [
        { what: "operator", where: "keystore/", detail: `${operatorName} ${operator.getPublicKey()}` },
        { what: "operator signing key", where: "creds/operator-signing.nk", detail: operatorSigning.getPublicKey() },
        { what: "mesh account", where: "rabbitmq/account.jwt", detail: mesh.getPublicKey() },
        { what: "account signing keys", where: "creds/core-mint.nk, creds/customer-mint.nk", detail: `server ${coreMint.getPublicKey()}, agents ${customerMint.getPublicKey()}` },
        { what: "RabbitMQ user", where: "creds/amqp-core.password", detail: CORE_AMQP_USER },
        { what: "A2A gateway credential", where: "creds/a2a-gateway.creds, a2a-gateway.env", detail: gateway.getPublicKey() },
        { what: "broker settings", where: "rabbitmq/rabbitmq.conf, rabbitmq/definitions.json", detail: `virtual host ${vhost}, port ${amqpPort}, checks at ${brokerAuthUrl}` },
        { what: "database tables", where: "rabbitmq/schema.sql", detail: tables },
        ...made,
      ],
      keep: { where: keystore, what: "the operator key, which is this mesh's identity, with every other key setup made" },
      record: {
        broker: "rabbitmq",
        operator_name: operatorName,
        operator: operator.getPublicKey(),
        operator_signing_key: operatorSigning.getPublicKey(),
        account: mesh.getPublicKey(),
        server_signing_key: coreMint.getPublicKey(),
        agent_signing_key: customerMint.getPublicKey(),
        amqp_user: CORE_AMQP_USER,
        vhost,
      },
      startBroker: [
        `Postgres, reachable at the address in MESH_POSTGRES_URL`,
        `RabbitMQ 4 with RABBITMQ_CONFIG_FILE=${join(rmqDir, "rabbitmq.conf")} and RABBITMQ_ENABLED_PLUGINS_FILE=${join(rmqDir, "enabled_plugins")}`,
      ],
    };
  },
};
