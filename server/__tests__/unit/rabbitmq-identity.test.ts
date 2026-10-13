/**
 * The RabbitMQ binding's identity side (step 9 of
 * docs/agent-messaging-server-plan.md): the broker check RabbitMQ's HTTP
 * authentication backend asks (storage/rabbitmq/broker-auth.ts), live
 * revocation through the same BrokerAdmin the key chain uses on NATS
 * (storage/rabbitmq/broker-admin.ts), and first-run's broker files
 * (setup/rabbitmq-setup.ts).
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { nkeys } from "nats";
import { encodeAccount, encodeOperator, encodeUser } from "nats-jwt";
import { applySchema } from "../../src/storage/postgres/schema.js";
import type { Sql } from "../../src/storage/postgres/sql.js";
import { Management, RabbitMqBrokerAdmin, operatorKeysOf, seedAccount } from "../../src/storage/rabbitmq/broker-admin.js";
import {
  amqpUserName,
  BrokerAuth,
  connectProofText,
  credentialOf,
  queueAgent,
  resourceAllowed,
} from "../../src/storage/rabbitmq/broker-auth.js";
import { definitionsJson, rabbitmqConfText, rabbitPasswordHash } from "../../src/setup/rabbitmq-setup.js";
import { pgliteSql } from "./pglite-sql.js";

const te = new TextEncoder();
const NEVER = ["$KV.>", "mesh.peer.>", "mesh.aclroom.>", "$SYS.>"];

async function chain() {
  const operator = nkeys.createOperator();
  const opSigning = nkeys.createOperator();
  const account = nkeys.createAccount();
  const coreMint = nkeys.createAccount();
  const customerMint = nkeys.createAccount();
  const operatorJwt = await encodeOperator("t", operator as never, { signing_keys: [opSigning.getPublicKey()] });
  const accountJwt = async (extra: Record<string, unknown> = {}, keys = [coreMint.getPublicKey(), customerMint.getPublicKey()]) =>
    encodeAccount("mesh", account as never, { signing_keys: keys, ...extra } as never, { signer: opSigning as never });
  return { operator, opSigning, account, coreMint, customerMint, operatorJwt, accountJwt };
}

type Chain = Awaited<ReturnType<typeof chain>>;

async function nodeCred(c: Chain, agent: string, signer = c.customerMint) {
  const kp = nkeys.createUser();
  const jwt = await encodeUser("node", kp as never, signer as never, {
    issuer_account: c.account.getPublicKey(),
    pub: { allow: ["mesh.agent.*.inbox", `mesh.feed.${agent}.*`, "_INBOX.>", "mesh.registry.>"], deny: NEVER },
    sub: { allow: [`mesh.agent.${agent}.inbox`, `mesh.agent.${agent}.inbox.guarded`, "mesh.event.>", "_INBOX.>"], deny: NEVER },
  } as never, { exp: Math.floor(Date.now() / 1000) + 3600 } as never);
  return { kp, jwt };
}

function login(kp: ReturnType<typeof nkeys.createUser>, jwt: string, atMs = Date.now()) {
  const cred = credentialOf(jwt);
  const user = amqpUserName(cred);
  const sig = Buffer.from(kp.sign(te.encode(connectProofText(user, atMs)))).toString("base64url");
  return { user, password: `${jwt}~${atMs}~${sig}` };
}

let sql: Sql;
let c: Chain;
const AGENT = nkeys.createUser().getPublicKey();
const OTHER = nkeys.createUser().getPublicKey();

beforeEach(async () => {
  sql = await pgliteSql();
  await applySchema(sql);
  c = await chain();
  await seedAccount(sql, c.account.getPublicKey(), await c.accountJwt());
});

describe("the broker check", () => {
  it("lets a node in on its credential and a fresh proof made with its key", async () => {
    const auth = new BrokerAuth({ sql, accountId: c.account.getPublicKey(), vhost: "mesh" });
    const { kp, jwt } = await nodeCred(c, AGENT);
    const { user, password } = login(kp, jwt);
    expect(await auth.user(user, password)).toEqual({ ok: true });
    expect(await auth.vhost(user, "mesh")).toBe(true);
    expect(await auth.vhost(user, "/")).toBe(false);

    // A copied credential without the key's proof, or a proof that has aged, does not.
    const other = nkeys.createUser();
    const forged = `${jwt}~${Date.now()}~${Buffer.from(other.sign(te.encode(connectProofText(user, Date.now())))).toString("base64url")}`;
    expect((await auth.user(user, forged)).ok).toBe(false);
    expect((await auth.user(user, login(kp, jwt, Date.now() - 10 * 60_000).password)).why).toMatch(/stale/);
    expect((await auth.user(`${kp.getPublicKey()}:other`, password)).why).toMatch(/user name/);
    expect((await auth.user("anonymous", "no-credential")).ok).toBe(false);
  });

  it("refuses a credential from an unknown signer, and a revoked one", async () => {
    const auth = new BrokerAuth({ sql, accountId: c.account.getPublicKey(), vhost: "mesh" });
    const stranger = nkeys.createAccount();
    const bad = await nodeCred(c, AGENT, stranger);
    const l1 = login(bad.kp, bad.jwt);
    expect((await auth.user(l1.user, l1.password)).why).toMatch(/does not list/);

    const good = await nodeCred(c, AGENT);
    const iat = credentialOf(good.jwt).iat;
    await sql.query("update ams_account set jwt = $2 where account = $1", [
      c.account.getPublicKey(),
      await c.accountJwt({ revocations: { [good.kp.getPublicKey()]: iat } }),
    ]);
    const fresh = new BrokerAuth({ sql, accountId: c.account.getPublicKey(), vhost: "mesh" });
    const l2 = login(good.kp, good.jwt);
    expect((await fresh.user(l2.user, l2.password)).why).toBe("revoked");
  });

  it("answers topics from the credential's permissions, with §14's meaning of `>`", async () => {
    const auth = new BrokerAuth({ sql, accountId: c.account.getPublicKey(), vhost: "mesh" });
    const { kp, jwt } = await nodeCred(c, AGENT);
    const { user, password } = login(kp, jwt);
    await auth.user(user, password);
    expect(await auth.topic(user, "mesh", "mesh", "write", `mesh.agent.${OTHER}.inbox`)).toBe(true);
    expect(await auth.topic(user, "mesh", "mesh", "write", `mesh.feed.${OTHER}.news`)).toBe(false);
    expect(await auth.topic(user, "mesh", "mesh", "write", "mesh.peer.x.y")).toBe(false);
    expect(await auth.topic(user, "mesh", "mesh", "read", `mesh.agent.${AGENT}.inbox`)).toBe(true);
    expect(await auth.topic(user, "mesh", "mesh", "read", `mesh.agent.${OTHER}.inbox`)).toBe(false);
    expect(await auth.topic(user, "mesh", "mesh", "read", "mesh.event.*.#")).toBe(true); // mesh.event.>
    expect(await auth.topic(user, "mesh", "mesh", "read", "mesh.*.#")).toBe(false); // mesh.> reaches mesh.peer.>
    expect(await auth.topic(user, "mesh", "amq.topic", "write", "mesh.event.x")).toBe(false);
  });
});

describe("queue and resource rules", () => {
  it("names the agent a queue belongs to", () => {
    expect(queueAgent(`MESH_INBOX_${AGENT}`)).toBe(AGENT);
    expect(queueAgent(`mesh_event_${AGENT}_0123456789abcdef`)).toBe(AGENT);
    expect(queueAgent(`mesh_feed_${AGENT}`)).toBe(AGENT);
    expect(queueAgent("ams.capture")).toBeNull();
  });

  it("allows a node its own queues and nobody else's", async () => {
    const { jwt } = await nodeCred(c, AGENT);
    const cred = credentialOf(jwt);
    expect(resourceAllowed(cred, "queue", "amq.gen-abc", "configure")).toBe(true);
    expect(resourceAllowed(cred, "queue", `MESH_INBOX_${AGENT}`, "read")).toBe(true);
    expect(resourceAllowed(cred, "queue", `MESH_INBOX_${AGENT}`, "write")).toBe(false);
    expect(resourceAllowed(cred, "queue", `MESH_INBOX_${OTHER}`, "read")).toBe(false);
    expect(resourceAllowed(cred, "queue", `mesh_event_${AGENT}_0123456789abcdef`, "configure")).toBe(true);
    expect(resourceAllowed(cred, "queue", "ams.capture", "read")).toBe(false);
    expect(resourceAllowed(cred, "queue", "ams.group.x.0123", "read")).toBe(false);
    expect(resourceAllowed(cred, "exchange", "mesh", "write")).toBe(true);
    expect(resourceAllowed(cred, "exchange", "mesh", "configure")).toBe(false);
    expect(resourceAllowed(cred, "exchange", "amq.default", "write")).toBe(true);
  });
});

describe("live revocation on RabbitMQ", () => {
  class FakeManagement {
    closed: string[] = [];
    open = new Set<string>();
    async connectionsOf(user: string) {
      return this.open.has(user) ? [{ name: `c-${user}`, user }] : [];
    }
    async closeConnectionsOf(user: string) {
      this.closed.push(user);
      this.open.delete(user);
    }
  }

  it("stores an account update signed by the operator and closes what it revokes", async () => {
    const auth = new BrokerAuth({ sql, accountId: c.account.getPublicKey(), vhost: "mesh" });
    const one = await nodeCred(c, AGENT);
    const two = await nodeCred(c, AGENT);
    const l1 = login(one.kp, one.jwt);
    const l2 = login(two.kp, two.jwt);
    await auth.user(l1.user, l1.password);
    await auth.user(l2.user, l2.password);
    const mgmt = new FakeManagement();
    mgmt.open.add(l1.user);
    mgmt.open.add(l2.user);
    const admin = new RabbitMqBrokerAdmin(sql, mgmt as unknown as Management, operatorKeysOf(c.operatorJwt));

    // An account update not signed by the operator is refused.
    const rogue = nkeys.createOperator();
    const rogueJwt = await encodeAccount("mesh", c.account as never, { signing_keys: [] } as never, { signer: rogue as never });
    await expect(admin.pushAccount(rogueJwt)).rejects.toThrow(/not signed by the operator/);

    const held = await admin.lookupAccount(c.account.getPublicKey());
    expect(held).toContain(".");
    await new Promise((r) => setTimeout(r, 1100)); // a strictly younger iat
    await admin.pushAccount(await c.accountJwt({ revocations: { [one.kp.getPublicKey()]: Math.floor(Date.now() / 1000) } }));
    expect(mgmt.closed).toEqual([l1.user]);
    expect(await admin.stillConnected(c.account.getPublicKey(), [one.kp.getPublicKey(), two.kp.getPublicKey()])).toEqual([two.kp.getPublicKey()]);

    // The mesh pause: the agents' signing key leaves the account, and every
    // connection it signed is closed.
    await new Promise((r) => setTimeout(r, 1100));
    await admin.pushAccount(await c.accountJwt({ revocations: { [one.kp.getPublicKey()]: Math.floor(Date.now() / 1000) - 2 } }, [c.coreMint.getPublicKey()]));
    expect(mgmt.closed).toContain(l2.user);
    expect(await admin.stillConnected(c.account.getPublicKey(), [two.kp.getPublicKey()])).toEqual([]);
  });
});

describe("first-run's RabbitMQ files", () => {
  it("sets up a RabbitMQ mesh with nothing secret in its settings", async () => {
    const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { firstRun } = await import("../../src/setup/first-run.js");
    const dir = join(mkdtempSync(join(tmpdir(), "fr-rmq-")), "mesh-config");
    const out = await firstRun({ dir, env: { MESH_BROKER: "rabbitmq", MESH_NAME: "rmq-test", PATH: process.env.PATH } });
    expect(out.done).toBe("now");
    for (const f of ["rabbitmq/rabbitmq.conf", "rabbitmq/definitions.json", "rabbitmq/account.jwt", "rabbitmq/operator.jwt", "rabbitmq/schema.sql", "creds/amqp-core.password", "creds/postgres.password", "creds/customer-mint.nk", "server.env", "first-run.json"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    const env = readFileSync(join(dir, "server.env"), "utf8");
    expect(env).toContain("MESH_BROKER=rabbitmq");
    expect(env).toContain("MESH_POSTGRES_URL=postgres://mesh@127.0.0.1:5432/mesh");
    expect(env).toContain("MESH_AMQP_ENDPOINTS=amqp://localhost:5672/mesh");
    // Paths and public keys only: no seed, no password.
    expect(env).not.toMatch(/\bS[OAU][A-Z2-7]{50,}/);
    expect(env).not.toContain(readFileSync(join(dir, "creds", "amqp-core.password"), "utf8").trim());
    expect(JSON.parse(readFileSync(join(dir, "first-run.json"), "utf8")).broker).toBe("rabbitmq");
  });

  it("makes the A2A gateway's credential, which the broker check lets in, and says where the gateway connects", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { firstRun } = await import("../../src/setup/first-run.js");
    const dir = join(mkdtempSync(join(tmpdir(), "fr-rmq-gw-")), "mesh-config");
    await firstRun({ dir, env: { MESH_BROKER: "rabbitmq", MESH_NAME: "rmq-gw", PATH: process.env.PATH } });
    const gwEnv = readFileSync(join(dir, "a2a-gateway.env"), "utf8");
    expect(gwEnv).toContain("MESH_URL=amqp://127.0.0.1:5672/mesh");
    expect(gwEnv).toMatch(/CREDS_FILE=.*a2a-gateway\.creds/);
    expect(gwEnv).not.toMatch(/\bS[OAU][A-Z2-7]{50,}/);

    const creds = readFileSync(join(dir, "creds", "a2a-gateway.creds"), "utf8");
    // A creds file holds the JWT and the seed each on a line of its own between its markers.
    const credLines = creds.split(/\r?\n/).map((l) => l.trim());
    const jwt = credLines.find((l) => l.startsWith("eyJ"))!;
    const seed = credLines.find((l) => l.startsWith("SU"))!;
    const account = /^ROOMS_MINT_ISSUER_ACCOUNT=(.+)$/m.exec(readFileSync(join(dir, "server.env"), "utf8"))![1]!.trim();
    await seedAccount(sql, account, readFileSync(join(dir, "rabbitmq", "account.jwt"), "utf8").trim());
    const auth = new BrokerAuth({ sql, accountId: account, vhost: "mesh" });
    const { user, password } = login(nkeys.fromSeed(te.encode(seed)), jwt);
    expect(await auth.user(user, password)).toEqual({ ok: true });
    // Fenced: any agent it hosts, never the reserved or operator subjects.
    expect(await auth.topic(user, "mesh", "mesh", "write", `mesh.agent.${AGENT}.inbox`)).toBe(true);
    expect(await auth.topic(user, "mesh", "mesh", "write", "mesh.peer.x.y")).toBe(false);
  });

  it("hashes the server's password the way RabbitMQ checks it", () => {
    const salt = Buffer.from([1, 2, 3, 4]);
    const hash = Buffer.from(rabbitPasswordHash("secret", salt), "base64");
    expect(hash.subarray(0, 4)).toEqual(salt);
    expect(hash.subarray(4)).toEqual(createHash("sha256").update(Buffer.concat([salt, Buffer.from("secret")])).digest());
  });

  it("writes the virtual host, the exchange, the server's user and the HTTP check", () => {
    const defs = JSON.parse(definitionsJson({ vhost: "mesh", passwordHash: "x" }));
    expect(defs.vhosts).toEqual([{ name: "mesh" }]);
    expect(defs.exchanges[0]).toMatchObject({ name: "mesh", type: "topic", durable: true });
    expect(defs.users[0]).toMatchObject({ name: "mesh-core", hashing_algorithm: "rabbit_password_hashing_sha256" });
    const conf = rabbitmqConfText({ amqpPort: 5672, managementPort: 15672, definitions: "/config/rabbitmq/definitions.json", brokerAuthUrl: "http://server:3006", written: "now", listen: "127.0.0.1" });
    expect(conf).toContain("listeners.tcp.default = 127.0.0.1:5672");
    expect(conf).toContain("auth_backends.2 = http");
    expect(conf).toContain("auth_http.topic_path = http://server:3006/broker-auth/topic");
    expect(conf).toContain("max_message_size = 1048576");
  });
});
