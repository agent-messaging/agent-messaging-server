/**
 * The seam between first-run setup (first-run.ts), which names no broker, and
 * the part of it each broker needs. NATS is the one there is
 * (nats-setup.ts). The RabbitMQ binding (step 9 of
 * docs/agent-messaging-server-plan.md) adds its own: the signing key, the
 * virtual host, the core's own user and the database schema.
 */
import type { Setting } from "./server-env.js";

/** What every broker's setup is given. */
export interface SetupContext {
  /** The folder being filled, absolute. Empty when setup starts. */
  dir: string;
  /** The mesh's name: what minted credentials and the capabilities answer call it. */
  meshName: string;
  /** The settings first-run was started with, read by exact name. */
  env: NodeJS.ProcessEnv;
  /** Make a folder (and its parents) that only this user can read. */
  mkdirPrivate(path: string): void;
  /** Make a folder others on the host may read, such as the broker's (it may run as its own user). */
  mkdirPublic(path: string): void;
  /** Write a file that only this user can read: a seed, a credential, a token. */
  writeSecret(path: string, text: string): void;
  /** Write a file anyone on the host may read: it holds no secret. */
  writePublic(path: string, text: string): void;
}

/** One line of the summary: a thing that was made, and where. */
export interface Made {
  what: string;
  where: string;
  /** Public keys or names worth showing. Never a seed, a token or a credential. */
  detail?: string;
}

/** What a broker's setup made. */
export interface BrokerSetupResult {
  /** The settings the core server reads, for server.env. Paths and public keys only. */
  settings: Setting[];
  /** Settings files for other programs, by file name in the folder (the A2A gateway's). */
  otherSettings: { file: string; header: string[]; settings: Setting[] }[];
  /** What was made, for the summary and first-run.json. */
  made: Made[];
  /** The folder the operator must keep a copy of, and what is in it. */
  keep: { where: string; what: string };
  /** Public facts for first-run.json: key names and public keys. */
  record: Record<string, string>;
  /** How to start the broker, one line each. */
  startBroker: string[];
}

export interface BrokerSetup {
  /** The broker's name, as MESH_BROKER takes it. */
  name: string;
  /** Fill `ctx.dir` with what this broker needs. Throws with a plain sentence. */
  create(ctx: SetupContext): Promise<BrokerSetupResult>;
}
