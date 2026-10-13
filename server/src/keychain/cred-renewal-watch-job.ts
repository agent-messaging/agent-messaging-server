/**
 * The scheduled half of credential-renewal health: read the mint log, compare
 * with what was true last time, and tell the operator about the first renewal
 * ever seen.
 *
 * Split from `cred-renewal-watch.ts` so the decision logic there stays pure
 * and testable. This file is the I/O: the state record, the mint log, the
 * registry's keys, the operator alert, and the rules about what must never
 * break the server.
 *
 * It runs in the core, beside the mesh API and the audit backstop's watch
 * (core-start.ts), since step 10a of docs/agent-messaging-server-plan.md: the
 * mint log and the registry are the core's records. Its one notice goes out as
 * a `mesh.ops.alert` request (shared/ops-events.ts), which AgentMesh's
 * platform delivers by email, as the witness watch's alert does. Before the
 * move it ran in the API's process and sent the email itself.
 *
 * ONE NOTICE PER EVENT. State lives in the keyed store, not memory, so a
 * restart does not repeat itself. A credential going overdue, expiring or
 * renewing is written to the log, never sent (the owner, 2026-09-24): an agent
 * whose credential lapses simply stops connecting, and its owner renews it on
 * the machine that runs it.
 *
 * IT NEVER TAKES THE SERVER DOWN. No state, no mint log, nobody to take the
 * alert: all caught and logged.
 *
 * IT SAYS SO WHEN IT IS BLIND. An unreadable mint log skips the pass loudly
 * rather than diagnosing against a partial list.
 *
 * THE FIRST RENEWAL. The first renewal this watcher ever observes gets its own
 * one-time notice. The scheduled renewal path has a long feedback loop; the
 * one event that proves it works deserves more than a log line. It is recorded
 * as said only when someone took the alert, so a pass with nobody listening
 * asks again next time rather than losing it.
 */

import { storageOf, type KeyedStore, type MessagingLike, type StorageLike } from "../storage/index.js";
import { sendOpsAlert, type OpsAlert } from "../shared/ops-events.js";
import { CredMintLog } from "./cred-mint-log.js";
import { assess, firstRenewalOf, type CredSeen, type TrackedCred } from "./cred-renewal-watch.js";

const BUCKET = "mesh_cred_renewal_watch";
const STATE_KEY = "state";

/** Everything the watcher remembers between runs. */
interface WatchState {
  /** Per-connection-key verdict at the previous observation. */
  creds: Record<string, CredSeen>;
  /** Set once the one-time "the renewal path works" notice was taken. */
  firstRenewal?: { key: string; agent: string; at: string };
  seeded?: boolean;
  updatedAt?: string;
}

/** The part of a keyed store the watch uses. */
type StateStore = Pick<KeyedStore, "get" | "put">;

async function loadState(kv: StateStore): Promise<WatchState> {
  try {
    const e = await kv.get(STATE_KEY);
    if (!e) return { creds: {} };
    const s = JSON.parse(e.string()) as WatchState;
    return { ...s, creds: s.creds ?? {} };
  } catch {
    return { creds: {} };
  }
}

export interface CredWatchDeps {
  js: StorageLike;
  /** The bus the alert goes out on. Without one, and without `alert`, the
   *  notice is logged and asked again next pass. */
  nc?: MessagingLike;
  /** How the notice reaches the operator; answers whether it was taken.
   *  Default: a `mesh.ops.alert` request on `nc`. */
  alert?: (a: OpsAlert) => Promise<boolean>;
}

/** Seams for the unit tests; production callers pass none of these. */
export interface CredWatchOverrides {
  now?: () => number;
  openState?: () => Promise<StateStore>;
  readRecords?: () => Promise<TrackedCred[]>;
  purgeRecord?: (key: string) => Promise<unknown>;
  /** The agent keys registered now (tests); default reads the registry's keys. */
  readRegistered?: () => Promise<ReadonlySet<string>>;
}

/**
 * Every agent key the registry holds, or undefined when it cannot be read in
 * full: a partial list would make live agents look retired, so a failure
 * means nothing is skipped this pass.
 */
async function registeredAgents(js: StorageLike): Promise<ReadonlySet<string> | undefined> {
  try {
    const snap = await (await storageOf(js).keyed("mesh_registry")).list();
    return new Set(snap.keys);
  } catch (err) {
    console.warn(`[cred-watch] cannot read the registry, so no credential is skipped as retired this pass: ${(err as Error).message}`);
    return undefined;
  }
}

/** The one-time notice for the first renewal ever observed. */
export function firstRenewalAlert(first: TrackedCred): OpsAlert {
  return {
    type: "credential renewal watch",
    subject: "first credential renewal observed — the renewal path works",
    lines: [
      `A credential re-mint through the renewal door (POST /v1/node-credential) was observed for ` +
        `${first.label?.trim() || `agent ${first.agents[0]?.slice(0, 12)}…`} ` + // cut-ok: a key prefix in a notice; the record keeps the whole key
        `(connection key ${first.key.slice(0, 12)}…) at ${first.issuedAt}.`, // cut-ok: a key prefix in a notice; the record keeps the whole key
      `This is the first renewal this watcher has ever seen, so the renewal path is confirmed working end to end.`,
      `The new lease expires ${first.expiresAt ?? "never — it was minted while MESH_CRED_EXPIRY=off, so this credential will not come due"}.`,
      `The server cannot tell a scheduled renewal from a hand-run \`mesh-adapter credential renew\`. ` +
        `If nobody ran one by hand around this time, this was the timer.`,
    ],
    footer: "This notice is sent exactly once, for the first renewal ever observed. Routine renewals appear in the daily summary.",
  };
}

export async function runCredRenewalWatch(deps: CredWatchDeps, overrides: CredWatchOverrides = {}): Promise<void> {
  let kv: StateStore;
  try {
    kv = await (overrides.openState ? overrides.openState() : storageOf(deps.js).keyed(BUCKET));
  } catch (err) {
    console.warn(`[cred-watch] no state bucket, skipping this pass: ${(err as Error).message}`);
    return;
  }

  // The mint log, read completely or not at all: a record this pass cannot
  // see is a credential it would wrongly stop tracking.
  let log: CredMintLog | null = null;
  let records: TrackedCred[];
  try {
    if (overrides.readRecords) {
      records = await overrides.readRecords();
    } else {
      log = await CredMintLog.create(deps.js);
      records = await log.all();
    }
  } catch (err) {
    console.warn(`[cred-watch] cannot read the mint log, skipping this pass: ${(err as Error).message}`);
    return;
  }

  const state = await loadState(kv);
  const firstRun = !state.seeded;
  const nowMs = overrides.now ? overrides.now() : Date.now();
  const registered = overrides.readRegistered ? await overrides.readRegistered().catch(() => undefined) : await registeredAgents(deps.js);
  const { findings, alerts, next, superseded } = assess(records, state.creds, nowMs, registered);

  // Always log the bad ones, whether or not they are new. The log is the
  // record that this ran and what it saw.
  const bad = findings.filter((f) => f.verdict !== "ok");
  if (bad.length) {
    console.warn(`[cred-watch] ${bad.length} credential(s) unhealthy: ` + bad.map((f) => `${f.name}=${f.verdict}`).join(" "));
    for (const f of bad) console.warn(`[cred-watch]   ${f.detail}`);
  }

  // The one-time proof, sent as an operator alert.
  const first = state.firstRenewal ? null : firstRenewalOf(records);
  let firstSaid = false;
  if (first) {
    const send = deps.alert ?? (deps.nc ? (a: OpsAlert) => sendOpsAlert(a, { nc: deps.nc }) : null);
    try {
      firstSaid = send ? await send(firstRenewalAlert(first)) : false;
    } catch (err) {
      console.error(`[cred-watch] first-renewal notice could not be sent: ${(err as Error).message}`);
    }
    if (!firstSaid) console.warn("[cred-watch] nobody took the first-renewal notice; the next pass asks again.");
  }

  // A credential going overdue, expiring or renewing is written to the log,
  // never sent (the owner, 2026-09-24).
  for (const f of alerts) {
    console.log(`[cred-watch] ${f.verdict === "ok" ? "closed" : f.verdict}: ${f.detail}`);
  }

  // Superseded records: the agent moved to a new connection key, so the old
  // lease can never renew and must not sit in the log ripening into a false
  // alarm. assess() already closed any open thread for these.
  for (const key of superseded) {
    try {
      if (overrides.purgeRecord) await overrides.purgeRecord(key);
      else await log?.purge(key);
    } catch (err) {
      console.warn(`[cred-watch] could not purge ${key.slice(0, 12)}…: ${(err as Error).message}`); // cut-ok: a key prefix in a log line
    }
  }

  const updated: WatchState = {
    creds: next,
    firstRenewal:
      state.firstRenewal ??
      (first && firstSaid ? { key: first.key, agent: first.agents[0] ?? first.key, at: first.issuedAt } : undefined),
    seeded: true,
    updatedAt: new Date(nowMs).toISOString(),
  };
  try {
    await kv.put(STATE_KEY, JSON.stringify(updated));
  } catch (err) {
    // Without this the next pass has no baseline and repeats itself. Worth
    // saying, not worth throwing.
    console.warn(`[cred-watch] could not persist state: ${(err as Error).message}`);
  }

  if (firstRun) {
    console.log(
      `[cred-watch] first pass: ${records.length} credential(s) on record. ` +
        "Only expiring mints and renewal-door re-mints are tracked; anything minted before the log existed " +
        "becomes visible at its first renewal.",
    );
  }
}

/**
 * Hand the watch to the core's scheduler (core-start.ts). Hourly, not every
 * five minutes: a lease measured in days moves slowly, and the alert line
 * (80% of lifetime) leaves days of margin. The scheduler's lease means one
 * process checks.
 */
export function registerCredRenewalWatchJob(
  scheduler: {
    register(job: { name: string; intervalMs: number; leaseTtlMs?: number; run: () => Promise<void> }): void;
  },
  deps: CredWatchDeps,
): void {
  scheduler.register({
    name: "cred-renewal-watch",
    intervalMs: Math.max(10 * 60_000, Number(process.env.CRED_RENEWAL_WATCH_INTERVAL_MS ?? 3600_000)),
    run: () => runCredRenewalWatch(deps),
  });
}
