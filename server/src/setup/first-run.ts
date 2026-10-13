/**
 * First-run setup for the Agent Messaging Server (step 7 of
 * docs/agent-messaging-server-plan.md).
 *
 *   npx tsx src/setup/first-run.ts [--dir DIR]
 *   docker run --rm -v mesh-config:/config <server image> first-run
 *
 * It fills one folder (MESH_CONFIG_DIR, else ./mesh-config) with everything a
 * new server needs before its first start: the broker's part, through the
 * broker's own setup (broker-setup.ts; NATS is nats-setup.ts), then the parts
 * that name no broker: the first admin token (made by
 * `mesh-admin token new`, the same tool an operator uses later), the server's
 * settings file (server.env) and a record of what was made (first-run.json).
 *
 * It runs once. A folder that already has first-run.json is left as it is,
 * and a folder that holds part of a setup without it is refused, so nothing a
 * mesh trusts is ever replaced. Starting over means a new, empty folder, and
 * new credentials for every agent.
 *
 * It never prints a seed, a credential or the token. Secrets are written
 * readable by their owner only.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_TOKEN_SETTING } from "../admin/admin-auth.js";
import { nkeys } from "../sdk.js";
import { serverRelease } from "../shared/server-release.js";
import type { BrokerSetup, BrokerSetupResult, SetupContext } from "./broker-setup.js";
import { natsSetup } from "./nats-setup.js";
import { rabbitmqSetup } from "./rabbitmq-setup.js";
import { configDir, CONFIG_DIR_SETTING, SERVER_ENV_FILE, writeSettingsFile, type Setting } from "./server-env.js";

/** The brokers first-run can set up, by the name MESH_BROKER takes. */
export const BROKERS: Readonly<Record<string, BrokerSetup>> = { nats: natsSetup, rabbitmq: rabbitmqSetup };
/** The setting that picks the broker. */
export const BROKER_SETTING = "MESH_BROKER";
/** The record of what was made. Its presence means setup is done. */
export const RECORD_FILE = "first-run.json";
/** The core services' signing identities: the service, and the setting that names its seed file. */
const SERVICE_IDENTITIES: readonly [string, string][] = [
  ["registry", "REGISTRY_SEED_FILE"],
  ["task-manager", "TASK_MANAGER_SEED_FILE"],
  ["activity", "ACTIVITY_SEED_FILE"],
  ["rooms", "ROOMS_SEED_FILE"],
  ["artifacts", "ARTIFACTS_SEED_FILE"],
  ["admission", "ADMISSION_SEED_FILE"],
];
/** What setup writes at the top of the folder. Any of these without the record is a half-finished setup. */
const OURS = [RECORD_FILE, SERVER_ENV_FILE, "a2a-gateway.env", "keystore", "creds", "nats", "rabbitmq", "account-history"];

const MESH_ADMIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "mesh-admin.mjs");

export class SetupRefused extends Error {}

export interface FirstRunOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  /** Where the summary goes. */
  print?: (line: string) => void;
}

export type FirstRunOutcome =
  | { done: "already"; dir: string; record: Record<string, unknown> }
  | { done: "now"; dir: string; record: Record<string, unknown>; result: BrokerSetupResult };

function context(dir: string, meshName: string, env: NodeJS.ProcessEnv): SetupContext {
  return {
    dir,
    meshName,
    env,
    mkdirPrivate(path) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    },
    mkdirPublic(path) {
      mkdirSync(path, { recursive: true, mode: 0o755 });
    },
    // "wx": a file that is already there is never replaced.
    writeSecret(path, text) {
      writeFileSync(path, text, { mode: 0o600, flag: "wx" });
      chmodSync(path, 0o600);
    },
    writePublic(path, text) {
      writeFileSync(path, text, { mode: 0o644, flag: "wx" });
    },
  };
}

/** The mesh's name: MESH_NAME, else "agent-messaging". Also the operator's name. */
function meshName(env: NodeJS.ProcessEnv): string {
  const name = env.MESH_NAME?.trim() || "agent-messaging";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)) {
    throw new SetupRefused(`MESH_NAME is "${name}". Use letters, digits, dots, dashes and underscores, up to 63 characters.`);
  }
  return name;
}

/** Make the first admin token with mesh-admin, which never shows it. */
function makeAdminToken(file: string, env: NodeJS.ProcessEnv): void {
  const r = spawnSync(process.execPath, [MESH_ADMIN, "token", "new", "--out", file, "--name", "first-run"], { env, encoding: "utf8" });
  if (r.status !== 0 || !existsSync(file)) {
    throw new Error(`mesh-admin could not make the admin token (${(r.stderr || r.stdout || String(r.error ?? "")).trim()})`);
  }
  chmodSync(file, 0o600);
}

/** Run first-run setup. Throws SetupRefused with a plain sentence when it will not. */
export async function firstRun(opts: FirstRunOptions = {}): Promise<FirstRunOutcome> {
  const env = opts.env ?? process.env;
  const dir = resolve(opts.dir ?? configDir(env));
  const recordPath = join(dir, RECORD_FILE);

  if (existsSync(recordPath)) {
    return { done: "already", dir, record: JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown> };
  }
  if (existsSync(dir)) {
    const partial = readdirSync(dir).filter((f) => OURS.includes(f));
    if (partial.length) {
      throw new SetupRefused(
        `${dir} holds part of a setup (${partial.join(", ")}) but no ${RECORD_FILE}, so an earlier run did not finish. ` +
          `Nothing was changed. Move that folder aside, or empty it, and run first-run again.`,
      );
    }
  }

  const brokerName = env[BROKER_SETTING]?.trim() || "nats";
  const broker = BROKERS[brokerName];
  if (!broker) {
    throw new SetupRefused(`${BROKER_SETTING} is "${brokerName}". This server can be set up on: ${Object.keys(BROKERS).join(", ")}.`);
  }

  const name = meshName(env);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const ctx = context(dir, name, env);
  const result = await broker.create(ctx);

  // The parts that name no broker.
  const tokenFile = join(dir, "creds", "mesh-admin.token");
  ctx.mkdirPrivate(dirname(tokenFile));
  makeAdminToken(tokenFile, env);

  // Each core service signs what it sends with an identity of its own. Made
  // here so it stays the same across restarts (shared/seed.ts reads the file).
  const identities: Setting[] = [];
  for (const [service, setting] of SERVICE_IDENTITIES) {
    const file = join(dir, "creds", `${service}.nk`);
    ctx.writeSecret(file, new TextDecoder().decode(nkeys.createUser().getSeed()));
    identities.push({ name: setting, value: file, about: `The ${service} service's signing identity.` });
  }

  const dataDir = join(dir, "data");
  ctx.mkdirPrivate(dataDir);
  const apiPort = env.MESH_API_PORT?.trim() || "3005";
  const settings: Setting[] = [
    ...result.settings,
    ...identities,
    { name: ADMIN_TOKEN_SETTING, value: tokenFile, about: "The admin tokens. `mesh-admin token new --out` adds one." },
    { name: "MESH_NAME", value: name, about: "This mesh's name, as minted credentials and the capabilities answer give it." },
    {
      name: "MESH_PUBLIC_URL",
      value: env.MESH_PUBLIC_URL?.trim() || `http://localhost:${apiPort}`,
      about: "The address agents reach the credential doors at (renewal links point here).",
    },
    { name: "MESH_DATA_DIR", value: dataDir, about: "Where the audit log and the server's other SQLite files live." },
  ];
  writeSettingsFile(
    join(dir, SERVER_ENV_FILE),
    [
      "The Agent Messaging Server's settings, written by first-run setup. It holds no secret, only where each one is.",
      `The server reads this file when ${CONFIG_DIR_SETTING} names this folder. A setting already in its environment wins.`,
    ],
    settings,
  );
  for (const other of result.otherSettings) writeSettingsFile(join(dir, other.file), other.header, other.settings);

  const release = serverRelease(env);
  const record: Record<string, unknown> = {
    written: new Date().toISOString(),
    mesh: name,
    ...(release ? { server_version: release.version } : {}),
    ...result.record,
    keep_a_copy_of: relative(dir, result.keep.where) || ".",
  };
  // Last, so its presence means every file above is there.
  ctx.writePublic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { done: "now", dir, record, result };
}

/** The summary first-run prints. Paths and public keys only. */
export function summary(outcome: FirstRunOutcome): string[] {
  const { dir } = outcome;
  if (outcome.done === "already") {
    return [
      `First-run setup was already done in ${dir} (on ${String(outcome.record.written ?? "an earlier run")}). Nothing was changed.`,
      `To start over, use a new, empty folder. Every agent then needs a new credential.`,
    ];
  }
  const { result } = outcome;
  const rel = (p: string) => relative(dir, p) || ".";
  const lines = [
    `First-run setup is done. This server's files are in ${dir}.`,
    ``,
    `KEEP A COPY OF THE OPERATOR KEY`,
    `  ${result.keep.where} holds ${result.keep.what}.`,
    `  Copy that folder somewhere safe and offline now. If it is lost, no new signing key can be made,`,
    `  and every credential has to be issued again under a new operator.`,
    `  The running server does not need it. Once you have a copy, you may remove it from this machine.`,
    ``,
    `What was made`,
    ...result.made.map((m) => `  ${m.what.padEnd(24)} ${m.where}${m.detail ? `  (${m.detail})` : ""}`),
    `  ${"admin token".padEnd(24)} creds/mesh-admin.token  (not shown)`,
    `  ${"service identities".padEnd(24)} creds/<service>.nk  (${SERVICE_IDENTITIES.map(([s]) => s).join(", ")})`,
    `  ${"server settings".padEnd(24)} ${SERVER_ENV_FILE}${result.otherSettings.length ? `, ${result.otherSettings.map((o) => o.file).join(", ")}` : ""}`,
    ``,
    `Secrets are in creds/ and ${rel(result.keep.where)}/, readable by their owner only. Nothing secret was printed.`,
    ``,
    `Next`,
    ...result.startBroker.map((l, i) => `  ${i + 1}. Start the broker:  ${l}`),
    `  ${result.startBroker.length + 1}. Start the server with ${CONFIG_DIR_SETTING}=${dir}`,
    `  ${result.startBroker.length + 2}. Check it:  ${ADMIN_TOKEN_SETTING}=${join(dir, "creds", "mesh-admin.token")} node tools/mesh-admin.mjs status`,
  ];
  return lines;
}

const HELP = `first-run: set up a new Agent Messaging Server.

  first-run [--dir DIR]

Fills DIR (default: ${CONFIG_DIR_SETTING}, else ./mesh-config) with the broker's
keys and settings, the server's own credentials, the first admin token and the
server's settings file. It runs once: a folder already set up is left as it is.

Settings it reads, all optional:
  ${BROKER_SETTING}             the broker: nats (the default) or rabbitmq
  MESH_POSTGRES_URL       (rabbitmq) a database to make the server's tables in
                          now, with MESH_POSTGRES_PASSWORD_FILE; unset, the
                          default for Compose's Postgres is written instead
  MESH_AMQP_PORT, MESH_RABBITMQ_MANAGEMENT_PORT, MESH_BROKER_AUTH_PORT
                          (rabbitmq) 5672, 15672 and 3006
  MESH_AMQP_VHOST         (rabbitmq) the virtual host (default mesh)
  MESH_AMQP_ENDPOINTS     (rabbitmq) broker addresses agents are given
  MESH_BROKER_AUTH_URL    (rabbitmq) where RabbitMQ reaches the server's checks
  MESH_NAME               the mesh's name (default agent-messaging)
  MESH_NATS_ENDPOINTS     broker addresses agents are given, comma-separated
                          (default nats://localhost:4222,ws://localhost:4443)
  MESH_PUBLIC_URL         where agents reach the credential doors
                          (default http://localhost:3005)
  MESH_NATS_PORT, MESH_WS_PORT, MESH_NATS_MONITOR_PORT   the broker's ports
                          (4222, 4443, 8222 on loopback)
  NATS_STORE_DIR, NATS_RESOLVER_DIR   the broker's JetStream and resolver
                          folders (default DIR/nats/jetstream, DIR/nats/resolver)
`;

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dir") dir = argv[++i];
    else if (a.startsWith("--dir=")) dir = a.slice("--dir=".length);
    else {
      process.stderr.write(`first-run: unknown argument ${a}. See first-run --help.\n`);
      return 2;
    }
  }
  try {
    const outcome = await firstRun({ dir });
    for (const line of summary(outcome)) console.log(line);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(e instanceof SetupRefused ? `first-run: ${msg}` : `first-run failed: ${msg}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
