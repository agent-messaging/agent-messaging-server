/**
 * What the core tells whoever operates the mesh, over the wire.
 *
 * The core server (the Agent Messaging Server, docs/agent-messaging-server-plan.md)
 * runs no operator's code inside it. What an operator's own systems want from
 * it while it runs (product metrics, the errors it logged, an alert that needs
 * a person) goes out on the bus, on subjects under `mesh.ops.`, and whoever
 * operates the mesh listens. On AgentMesh that is the platform
 * (platform-shared/ops-listener.ts); on a server with nobody listening a fact
 * goes nowhere, and an alert is logged and asked again at the next pass.
 *
 * The subjects (version 1, every body JSON with `v: 1`):
 *
 *   mesh.ops.metric  publish  one product-metrics fact: kind, and optionally
 *                             actor, target, offering, status, duration_ms,
 *                             meta, and ts (ISO-8601, the time it happened)
 *   mesh.ops.error   publish  one error a core process logged: at, process,
 *                             type, message, severity, details, host, version
 *   mesh.ops.alert   request  one operator alert: type, subject, lines,
 *                             footer, severity; answered {"v":1,"ok":true} by
 *                             whoever delivers it to a person
 *   mesh.ops.heartbeat publish  a process's liveness, each heartbeat
 *                             interval: services, startedAt, at, natsOk,
 *                             process (the same record the process writes to
 *                             mesh_service_health)
 *
 * No agent's credential lists `mesh.ops.>` (keychain/cred-template.ts), so
 * these are between the core and its operator. Metadata only, never content.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { format } from "node:util";
import { dataDbPath } from "../data-dir.js";
import { messagingOf, type Messaging, type MessagingLike } from "../storage/index.js";
import { deploymentVersion } from "./deployment-version.js";

export const OPS_VERSION = 1;
export const OPS_METRIC_SUBJECT = "mesh.ops.metric";
export const OPS_ERROR_SUBJECT = "mesh.ops.error";
export const OPS_ALERT_SUBJECT = "mesh.ops.alert";
export const OPS_HEARTBEAT_SUBJECT = "mesh.ops.heartbeat";

/** One fact for the operator's product metrics. */
export interface MetricEvent {
  kind: string;
  actor?: string | null;
  target?: string | null;
  offering?: string | null;
  status?: string | null;
  duration_ms?: number | null;
  meta?: Record<string, unknown> | null;
  /** Event time; defaults to now. */
  ts?: Date;
}

/** One error as `mesh.ops.error` carries it. */
export interface OpsError {
  v: 1;
  at: string;
  process: string;
  type: string;
  message: string;
  severity: "error" | "critical";
  details: Record<string, unknown>;
  host: string;
  version: string | null;
}

/** One operator alert as `mesh.ops.alert` carries it. */
export interface OpsAlert {
  type: string;
  subject: string;
  lines: string[];
  footer: string;
  severity?: "error" | "critical";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const original = { error: console.error.bind(console), warn: console.warn.bind(console) };

let bus: Messaging | null = null;
let processName = "core";

/** Where this process's operator events go. Called once a core process is connected. */
export function installOpsBus(nc: MessagingLike, opts: { process?: string } = {}): void {
  bus = messagingOf(nc);
  if (opts.process) processName = opts.process;
}

/** Back to no bus. For tests. */
export function resetOpsBus(): void {
  bus = null;
  processName = "core";
}

function send(subject: string, body: Record<string, unknown>): boolean {
  if (!bus) return false;
  try {
    bus.publish(subject, encoder.encode(JSON.stringify({ v: OPS_VERSION, ...body })));
    return true;
  } catch {
    // A fact or an error report must never become an error of its own.
    return false;
  }
}

/** One service's liveness as `mesh.ops.heartbeat` carries it, every
 *  heartbeat interval (shared/service-health.ts). */
export interface OpsHeartbeat {
  services: string[];
  startedAt: string;
  at: string;
  natsOk: boolean;
}

/** A process's heartbeat on `mesh.ops.heartbeat`, when it has a bus. Dropped otherwise. */
export function publishHeartbeat(hb: OpsHeartbeat): void {
  send(OPS_HEARTBEAT_SUBJECT, { ...hb, process: processName });
}

/** A metrics fact on `mesh.ops.metric`, when this process has a bus. Dropped otherwise. */
export function publishMetric(e: MetricEvent): void {
  const { ts, ...rest } = e;
  send(OPS_METRIC_SUBJECT, { ...rest, ts: (ts ?? new Date()).toISOString() });
}

/**
 * The core's metrics door: a fact goes out on `mesh.ops.metric`, and the
 * platform's ops listener records it. Until step 10a the platform installed a
 * sink here for the core code its API process ran in its own process; that
 * code now runs only in the core, so there is no hook left.
 */
export const metrics = {
  event(e: MetricEvent): void {
    publishMetric(e);
  },
};

/** The report of one error, as it stands now. Exported for the tests. */
export function opsErrorOf(err: unknown, opts: { type?: string; severity?: "error" | "critical"; details?: Record<string, unknown> } = {}): OpsError {
  const e = err instanceof Error ? err : null;
  let message: string;
  try {
    message = (e ? e.message : typeof err === "string" ? err : JSON.stringify(err)) || "(no message)";
  } catch {
    message = String(err);
  }
  return {
    v: 1,
    at: new Date().toISOString(),
    process: processName,
    type: (opts.type ?? (e && e.name && e.name !== "Error" ? e.name : "error")).slice(0, 200), // cut-ok: a label, not content
    message: message.slice(0, 4000), // cut-ok: an error message, whose whole is in this process's log
    severity: opts.severity ?? "error",
    details: { ...(e?.stack ? { stack: e.stack.slice(0, 4000) } : {}), ...(opts.details ?? {}) }, // cut-ok: a stack, whole in the log
    host: hostname(),
    version: deploymentVersion().version ?? null,
  };
}

/** The report for one console.error call: its "[tag]" is its type. */
function consoleErrorOf(args: unknown[]): OpsError {
  const text = format(...args);
  const tag = /^\s*\[([^\]\n]{1,40})\]/.exec(text)?.[1]?.trim();
  const err = args.find((a): a is Error => a instanceof Error);
  const first = text.split("\n").find((l) => l.trim()) ?? text;
  return opsErrorOf(first.trim(), {
    type: tag ? `console.error [${tag}]` : err ? `console.error ${err.name || "Error"}` : "console.error",
    details: err?.stack ? { stack: err.stack.slice(0, 4000) } : text.includes("\n") ? { text: text.slice(0, 4000) } : {}, // cut-ok: whole in the log
  });
}

const spoolPath = (): string => dataDbPath("MESH_OPS_SPOOL_PATH", "ops-spool.jsonl");

let reporting = false;
let inReport = false;

/**
 * Report this process's errors on `mesh.ops.error`: every console.error line
 * still prints as before and is also sent, and an uncaught exception is
 * written to a spool file (a process about to die cannot wait for the bus)
 * and sent by the next process to start. Once per process, after
 * `installOpsBus`.
 */
export function reportErrorsOnBus(): void {
  if (reporting) return;
  reporting = true;
  console.error = (...args: unknown[]): void => {
    original.error(...args);
    if (inReport) return;
    inReport = true;
    try {
      send(OPS_ERROR_SUBJECT, { ...consoleErrorOf(args) });
    } finally {
      inReport = false;
    }
  };
  process.on("uncaughtExceptionMonitor", (err, origin) => {
    spoolError(err, origin === "unhandledRejection" ? "unhandled rejection" : "uncaught exception");
  });
  const sent = drainOpsSpool();
  if (sent) console.log(`[ops] sent ${sent} crash report(s) left by an earlier process`);
}

/** Write a report synchronously, for a process about to die. */
export function spoolError(err: unknown, type: string): void {
  try {
    const p = spoolPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify(opsErrorOf(err, { type, severity: "critical" }))}\n`);
  } catch {
    // A full disk is not something a dying process can fix.
  }
}

/** Send what crashed processes left in the spool. Answers how many were sent. */
export function drainOpsSpool(): number {
  if (!bus) return 0;
  const p = spoolPath();
  if (!existsSync(p)) return 0;
  const taken = `${p}.${process.pid}.draining`;
  try { renameSync(p, taken); } catch { return 0; } // another process took it
  let n = 0;
  try {
    for (const line of readFileSync(taken, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as OpsError;
        if (send(OPS_ERROR_SUBJECT, { ...r })) n++;
      } catch { /* a torn line from a crash mid-write */ }
    }
  } finally {
    try { unlinkSync(taken); } catch { /* gone */ }
  }
  return n;
}

/**
 * Ask whoever operates the mesh to deliver an alert to a person. Answers true
 * only when someone said they took it; false when nobody listens or nobody
 * answered in time, so the caller can ask again later.
 */
export async function sendOpsAlert(a: OpsAlert, opts: { timeoutMs?: number; nc?: MessagingLike } = {}): Promise<boolean> {
  const via = opts.nc ? messagingOf(opts.nc) : bus;
  if (!via) return false;
  try {
    const m = await via.request(OPS_ALERT_SUBJECT, encoder.encode(JSON.stringify({ v: OPS_VERSION, ...a })), { timeout: opts.timeoutMs ?? 15_000 });
    const answer = JSON.parse(decoder.decode(m.data)) as { ok?: unknown };
    return answer.ok === true;
  } catch {
    return false;
  }
}

/** The console as it was, for code that must not report itself. */
export const opsConsole = original;
