/**
 * First-run setup's NATS part (step 7 of docs/agent-messaging-server-plan.md,
 * "Tenancy and the NATS operator"): the operator, its signing key, the system
 * account and its user, the mesh's one account with its two signing keys, the
 * server's own users, and a broker configuration on the full resolver, so live
 * revocation and the kill switch's network cut work from the first start.
 *
 * What it makes, under the folder first-run fills:
 *
 *   keystore/       the operator's keystore, in the layout nsc reads
 *                   (`nsc --data-dir keystore --keystore-dir keystore`): every
 *                   seed, every JWT and every creds file. It holds the operator
 *                   identity key, which nothing on the server uses. The
 *                   operator keeps a copy offline (docs/nsc-keystore-restore.md
 *                   says why: lose it and every credential has to be issued
 *                   again).
 *   creds/          what the running server reads, each file readable by its
 *                   owner only:
 *                     core.creds, platform.creds   the core's and the
 *                       platform's users (docs/nats-users-runbook.md): only
 *                       platform may publish on mesh.admin.>
 *                     a2a-gateway.creds            the A2A gateway's node user
 *                     sys.creds                    a system account user, for
 *                       live revocation (MESH_SYS_CREDS_FILE)
 *                     operator-signing.nk          the operator signing key, which
 *                       re-signs the account to revoke live
 *                       (MESH_OPERATOR_SIGNING_KEY_FILE)
 *                     core-mint.nk                 the account signing key the
 *                       server's own users are signed with (ROOMS_MINT_SEED_FILE)
 *                     customer-mint.nk             the account signing key every
 *                       agent credential is signed with
 *                       (MESH_CUSTOMER_MINT_SEED_FILE), which the mesh pause
 *                       takes out of the account
 *   nats/nats.conf  the broker's settings: operator mode, the full resolver
 *                   with the system and mesh accounts preloaded, JetStream,
 *                   WebSocket, no anonymous connections.
 *   account-history/  where the account JWT is saved before each change
 *                   (MESH_ACCOUNT_JWT_HISTORY_DIR).
 *
 * Nothing here prints a seed, a JWT or a credential.
 *
 * The accounts are signed by the operator signing key, not the identity key,
 * as the hosted network's are after its migration, so the identity key is only
 * ever needed to sign the operator itself: to add a new signing key or drop a
 * suspect one.
 */
import { nkeys } from "nats";
import { encodeAccount, encodeOperator, encodeUser } from "nats-jwt";
import { join, resolve } from "node:path";
import { coreServerPermissions, fencedNodePermissions, platformServerPermissions, type CredPermissions } from "../keychain/cred-template.js";
import { ACCOUNT_SETTING, SIGNING_KEY_SETTING, SYS_CREDS_SETTING } from "../keychain/live-revoke.js";
import { CUSTOMER_KEY_SETTING, CUSTOMER_SEED_SETTING, JWT_HISTORY_SETTING } from "../keychain/split-keys.js";
import { credsFileText } from "../shared/creds-file.js";
import type { BrokerSetup, BrokerSetupResult, SetupContext } from "./broker-setup.js";
import type { Setting } from "./server-env.js";

type KeyPair = ReturnType<typeof nkeys.createOperator>;

const td = new TextDecoder();
const seedOf = (kp: KeyPair): string => td.decode(kp.getSeed());

/** The mesh's one account (tenants are records the core keeps, not NATS accounts). */
export const MESH_ACCOUNT = "mesh";
/** The system account's name, as nsc names it. */
export const SYS_ACCOUNT = "SYS";

/** The exports nsc gives a system account, so account monitoring works the same. */
const SYS_EXPORTS = [
  {
    name: "account-monitoring-streams",
    subject: "$SYS.ACCOUNT.*.>",
    type: "stream",
    account_token_position: 3,
    description: "Account specific monitoring stream",
    info_url: "https://docs.nats.io/nats-server/configuration/sys_accounts",
  },
  {
    name: "account-monitoring-services",
    subject: "$SYS.REQ.ACCOUNT.*.*",
    type: "service",
    response_type: "Stream",
    account_token_position: 4,
    description: "Request account specific monitoring services for: SUBSZ, CONNZ, LEAFZ, JSZ and INFO",
    info_url: "https://docs.nats.io/nats-server/configuration/sys_accounts",
  },
];

/** No limit on connections, subscriptions or payload beyond the broker's own. */
const OPEN_LIMITS = { subs: -1, data: -1, payload: -1, imports: -1, exports: -1, wildcards: true, conn: -1, leaf: -1 };
/** JetStream on, with the broker's own limits as the real cap. */
const JETSTREAM_LIMITS = {
  mem_storage: -1,
  disk_storage: -1,
  streams: -1,
  consumer: -1,
  max_ack_pending: -1,
  mem_max_stream_bytes: -1,
  disk_max_stream_bytes: -1,
};

/** A port setting: a whole number from 1 to 65535, or the default. */
function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} is "${raw}", which is not a port number.`);
  return n;
}

/** A path for nats.conf: absolute, with forward slashes, which the broker reads on every system. */
function confPath(p: string): string {
  return resolve(p).replace(/\\/g, "/");
}

/** A string for nats.conf, quoted. */
function confString(s: string): string {
  if (/["\r\n]/.test(s)) throw new Error(`cannot write ${JSON.stringify(s)} into nats.conf`);
  return `"${s}"`;
}

/** The broker's settings file. Holds JWTs and public keys, never a seed. */
export function natsConfText(o: {
  serverName: string;
  port: number;
  wsPort: number;
  monitor: string;
  operatorJwt: string;
  sysAccount: string;
  preload: Record<string, string>;
  resolverDir: string;
  storeDir: string;
  written: string;
}): string {
  const preload = Object.entries(o.preload).map(([k, jwt]) => `  ${k}: ${jwt}`).join("\n");
  return `# The NATS broker for an Agent Messaging Server, written by first-run setup on ${o.written}.
# Operator mode on the full resolver: accounts are JWTs the broker keeps in the
# resolver folder, and the server pushes a new account JWT to revoke a credential
# live. Running first-run again does not touch this file.
server_name: ${confString(o.serverName)}
port: ${o.port}

operator: ${o.operatorJwt}
system_account: ${o.sysAccount}
resolver: {
  type: full
  dir: ${confString(o.resolverDir)}
  allow_delete: false
  interval: "2m"
  timeout: "1.9s"
}
# Read at every start. A newer JWT for the same account in the resolver folder
# (a revocation the server pushed) wins over the one here.
resolver_preload: {
${preload}
}

jetstream {
  store_dir: ${confString(o.storeDir)}
  max_mem: 1G
  max_file: 10G
}

# Agents in a browser, and the SDK, connect over WebSocket.
websocket {
  port: ${o.wsPort}
  no_tls: true
}

# Monitoring, on loopback only.
http: ${confString(o.monitor)}

# Set, not inherited: the server tells clients this is the largest message.
max_payload: 1048576

# A node credential lists the subjects of every agent it hosts, and the JWT
# travels in the CONNECT line, so the default 4096 bytes is too small.
max_control_line: 262144
`;
}

/** Where nsc keeps a seed in its keystore. */
function nscKeyPath(keystore: string, pub: string): string {
  return join(keystore, "keys", pub[0]!, pub.slice(1, 3), `${pub}.nk`);
}

/** A user JWT signed by an account signing key, as the key chain mints them. */
async function userJwt(name: string, user: KeyPair, signer: KeyPair, account: string, perms: CredPermissions | null): Promise<string> {
  const claim: Record<string, unknown> = { ...(perms ?? {}), issuer_account: account };
  return encodeUser(name, user as never, signer as never, claim as never, {});
}

export const natsSetup: BrokerSetup = {
  name: "nats",

  async create(ctx: SetupContext): Promise<BrokerSetupResult> {
    const { dir, env } = ctx;
    const natsPort = port(env, "MESH_NATS_PORT", 4222);
    const wsPort = port(env, "MESH_WS_PORT", 4443);
    const monitorPort = port(env, "MESH_NATS_MONITOR_PORT", 8222);
    const operatorName = ctx.meshName;
    const written = new Date().toISOString();

    const keystore = join(dir, "keystore");
    const credsDir = join(dir, "creds");
    const natsDir = join(dir, "nats");
    const historyDir = join(dir, "account-history");
    const resolverDir = env.NATS_RESOLVER_DIR?.trim() || join(natsDir, "resolver");
    const storeDir = env.NATS_STORE_DIR?.trim() || join(natsDir, "jetstream");
    for (const d of [keystore, credsDir, historyDir]) ctx.mkdirPrivate(d);
    // The broker may run as a user of its own, and nothing in here is secret.
    ctx.mkdirPublic(natsDir);

    // ── keys ────────────────────────────────────────────────────────────
    const operator = nkeys.createOperator();
    const operatorSigning = nkeys.createOperator();
    const sys = nkeys.createAccount();
    const sysSigning = nkeys.createAccount();
    const mesh = nkeys.createAccount();
    const coreMint = nkeys.createAccount();
    const customerMint = nkeys.createAccount();

    // ── JWTs ────────────────────────────────────────────────────────────
    const operatorJwt = await encodeOperator(operatorName, operator as never, {
      signing_keys: [operatorSigning.getPublicKey()],
      system_account: sys.getPublicKey(),
    });
    const sysJwt = await encodeAccount(
      SYS_ACCOUNT,
      sys as never,
      {
        exports: SYS_EXPORTS,
        limits: { ...OPEN_LIMITS },
        signing_keys: [sysSigning.getPublicKey()],
        default_permissions: { pub: {}, sub: {} },
        authorization: {},
      } as never,
      { signer: operatorSigning as never },
    );
    const meshJwt = await encodeAccount(
      MESH_ACCOUNT,
      mesh as never,
      {
        limits: { ...OPEN_LIMITS, ...JETSTREAM_LIMITS },
        signing_keys: [coreMint.getPublicKey(), customerMint.getPublicKey()],
        default_permissions: { pub: {}, sub: {} },
        authorization: {},
      } as never,
      { signer: operatorSigning as never },
    );

    // ── users ───────────────────────────────────────────────────────────
    // The system user has no permissions block of its own, as nsc makes it:
    // the system account is the broker's, and nothing else connects to it.
    const users: { name: string; account: string; kp: KeyPair; jwt: string; file: string; about: string }[] = [];
    const addUser = async (name: string, account: string, signer: KeyPair, perms: CredPermissions | null, about: string) => {
      const kp = nkeys.createUser();
      const accountKey = account === SYS_ACCOUNT ? sys.getPublicKey() : mesh.getPublicKey();
      users.push({ name, account, kp, jwt: await userJwt(name, kp, signer, accountKey, perms), file: join(credsDir, `${name}.creds`), about });
    };
    await addUser("sys", SYS_ACCOUNT, sysSigning, null, "system account user, for live revocation");
    await addUser("core", MESH_ACCOUNT, coreMint, coreServerPermissions(), "the core's processes; may not publish on mesh.admin.>");
    await addUser("platform", MESH_ACCOUNT, coreMint, platformServerPermissions(), "the platform's processes, if the AgentMesh platform runs beside the core");
    await addUser("a2a-gateway", MESH_ACCOUNT, coreMint, fencedNodePermissions(), "the A2A gateway's node");

    // ── the keystore, in nsc's layout ───────────────────────────────────
    ctx.writePublic(join(keystore, ".gitignore"), "# ignore all nk files \n**/*.nk\n\n# ignore all creds files\n**/*.creds\n");
    const opStore = join(keystore, operatorName);
    ctx.mkdirPrivate(join(opStore, "accounts", SYS_ACCOUNT, "users"));
    ctx.mkdirPrivate(join(opStore, "accounts", MESH_ACCOUNT, "users"));
    ctx.writePublic(join(opStore, ".nsc"), JSON.stringify({ managed: false, name: operatorName, kind: "operator", version: "1" }));
    ctx.writePublic(join(opStore, `${operatorName}.jwt`), operatorJwt);
    ctx.writePublic(join(opStore, "accounts", SYS_ACCOUNT, `${SYS_ACCOUNT}.jwt`), sysJwt);
    ctx.writePublic(join(opStore, "accounts", MESH_ACCOUNT, `${MESH_ACCOUNT}.jwt`), meshJwt);
    for (const kp of [operator, operatorSigning, sys, sysSigning, mesh, coreMint, customerMint, ...users.map((u) => u.kp)]) {
      const path = nscKeyPath(keystore, kp.getPublicKey());
      ctx.mkdirPrivate(join(path, ".."));
      ctx.writeSecret(path, seedOf(kp));
    }
    for (const u of users) {
      const creds = credsFileText(u.jwt, seedOf(u.kp));
      ctx.writePublic(join(opStore, "accounts", u.account, "users", `${u.name}.jwt`), u.jwt);
      ctx.mkdirPrivate(join(keystore, "creds", operatorName, u.account));
      ctx.writeSecret(join(keystore, "creds", operatorName, u.account, `${u.name}.creds`), creds);
      ctx.writeSecret(u.file, creds);
    }

    // ── what the running server reads ───────────────────────────────────
    const operatorSigningFile = join(credsDir, "operator-signing.nk");
    const coreMintFile = join(credsDir, "core-mint.nk");
    const customerMintFile = join(credsDir, "customer-mint.nk");
    ctx.writeSecret(operatorSigningFile, seedOf(operatorSigning));
    ctx.writeSecret(coreMintFile, seedOf(coreMint));
    ctx.writeSecret(customerMintFile, seedOf(customerMint));

    // ── the broker's settings ───────────────────────────────────────────
    ctx.writePublic(
      join(natsDir, "nats.conf"),
      natsConfText({
        serverName: operatorName,
        port: natsPort,
        wsPort,
        monitor: `127.0.0.1:${monitorPort}`,
        operatorJwt,
        sysAccount: sys.getPublicKey(),
        preload: { [sys.getPublicKey()]: sysJwt, [mesh.getPublicKey()]: meshJwt },
        resolverDir: confPath(resolverDir),
        storeDir: confPath(storeDir),
        written,
      }),
    );

    const endpoints = env.MESH_NATS_ENDPOINTS?.trim() || `nats://localhost:${natsPort},ws://localhost:${wsPort}`;
    const credsOf = (name: string) => users.find((u) => u.name === name)!.file;
    const settings: Setting[] = [
      { name: "NATS_URL", value: `nats://127.0.0.1:${natsPort}`, about: "Where the broker is, from the server's side." },
      { name: "NATS_CREDS", value: credsOf("core"), about: "The core's own NATS user. It may not publish on mesh.admin.>." },
      { name: SIGNING_KEY_SETTING, value: operatorSigningFile, about: "The operator signing key, which re-signs the account to revoke a credential live." },
      { name: SYS_CREDS_SETTING, value: credsOf("sys"), about: "A system account user: the broker takes account updates and connection lists from it." },
      { name: ACCOUNT_SETTING, value: mesh.getPublicKey(), about: "The mesh's account, which every credential is minted under." },
      { name: "ROOMS_MINT_SEED_FILE", value: coreMintFile, about: "The account signing key the server's own users are signed with." },
      { name: CUSTOMER_SEED_SETTING, value: customerMintFile, about: "The account signing key every agent credential is signed with." },
      { name: CUSTOMER_KEY_SETTING, value: customerMint.getPublicKey(), about: "Its public key, which the mesh pause takes out of the account and the resume puts back." },
      { name: JWT_HISTORY_SETTING, value: historyDir, about: "Where the account JWT is saved before each change." },
      { name: "MESH_NATS_ENDPOINTS", value: endpoints, about: "The broker addresses handed to agents with their credentials. Use addresses agents can reach." },
      { name: "MESH_BRIDGE_NODES", value: users.find((u) => u.name === "a2a-gateway")!.kp.getPublicKey(), about: "The node the gateway runs as, which may speak for callers that hold no mesh key (identity bridges, SPEC §4.15)." },
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
            { name: "CREDS_FILE", value: credsOf("a2a-gateway"), about: "The gateway's NATS user." },
            { name: "MESH_URL", value: `ws://127.0.0.1:${wsPort}`, about: "The broker's WebSocket address, from the gateway's side." },
          ],
        },
      ],
      made: [
        { what: "operator", where: "keystore/", detail: `${operatorName} ${operator.getPublicKey()}` },
        { what: "operator signing key", where: "creds/operator-signing.nk", detail: operatorSigning.getPublicKey() },
        { what: "system account and user", where: "creds/sys.creds", detail: sys.getPublicKey() },
        { what: "mesh account", where: "keystore/", detail: mesh.getPublicKey() },
        { what: "account signing keys", where: "creds/core-mint.nk, creds/customer-mint.nk", detail: `server ${coreMint.getPublicKey()}, agents ${customerMint.getPublicKey()}` },
        { what: "NATS users", where: "creds/core.creds, creds/platform.creds, creds/a2a-gateway.creds", detail: "core, platform, a2a-gateway" },
        { what: "broker settings", where: "nats/nats.conf", detail: `full resolver, port ${natsPort}, WebSocket ${wsPort}` },
      ],
      keep: {
        where: keystore,
        what: "the operator key, which is this mesh's identity, with every other key and credential setup made",
      },
      record: {
        broker: "nats",
        operator_name: operatorName,
        operator: operator.getPublicKey(),
        operator_signing_key: operatorSigning.getPublicKey(),
        system_account: sys.getPublicKey(),
        account: mesh.getPublicKey(),
        server_signing_key: coreMint.getPublicKey(),
        agent_signing_key: customerMint.getPublicKey(),
        ...Object.fromEntries(users.map((u) => [`user_${u.name.replace(/-/g, "_")}`, u.kp.getPublicKey()])),
      },
      startBroker: [`nats-server -c ${confPath(join(natsDir, "nats.conf"))}`],
    };
  },
};
