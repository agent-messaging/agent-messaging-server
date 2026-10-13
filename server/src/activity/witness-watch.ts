/**
 * The watcher for the watcher: is the audit backstop actually keeping up?
 *
 * The witness fold (witness-fold.ts) guarantees that traffic the transport
 * durably held reaches the audit chains, but the guarantee is bounded by the
 * mailboxes' own retention: MESH_INBOX_* streams drop messages at 7 days, so a
 * backstop that stays down or wedged longer than that loses the tail with no
 * record that it ever existed. Nothing else notices, because the failure mode
 * is an ABSENCE: a consumer that is missing, or present and not moving. This
 * job exists to turn that absence into a sentence an operator reads long
 * before the cliff.
 *
 * Three findings, all read from JetStream's own accounting, none requiring the
 * activity process to be up (which is the point - the backstop lives there):
 *
 *   missing  - a mailbox stream with no "audit_witness" consumer at all. The
 *              fold's reconcile pass attaches new mailboxes within 5 minutes,
 *              so a stream younger than an hour is warm-up, not a finding.
 *   lagging  - the consumer exists but num_pending has grown past
 *              WITNESS_LAG_THRESHOLD. A healthy fold holds messages for
 *              minutes (its hold window), not thousands deep.
 *   stale    - the consumer's oldest outstanding work is older than
 *              WITNESS_STALE_MS (default 48h), well inside the 7-day cliff.
 *              The age comes from the message just past the consumer's ack
 *              floor when JetStream will hand it to us; when it will not, we
 *              fall back to the stream's first_ts, which is conservative (the
 *              oldest RETAINED message, acked or not, so it can flag a stream
 *              whose pending work is actually fresh - accepted, because that
 *              path only runs when the precise read failed).
 *
 * MESH_AUDIT_WITNESS=off is a deliberate operator choice (the same switch the
 * fold honors), so the watch does not manufacture findings against a backstop
 * that was turned off on purpose; it says once per pass that coverage is off
 * and reports nothing.
 *
 * ALERT RATE LIMITING: an alert goes out (a `mesh.ops.alert` request, which
 * AgentMesh's platform turns into its error log's entry and one email) only on
 * the transition from a clean pass to a pass with findings, judged against
 * state kept in KV so a restart does not re-announce a known problem. A
 * persisting problem alerts once, and again only after a clean pass in
 * between; an alert nobody took is asked again at the next pass. Every pass logs its findings to
 * the console regardless, because the log is the record that this ran and what
 * it saw. Same discipline as process-watch-job.ts, same reason: at a
 * half-hour interval, per-pass alerting is 48 emails a day for one wedged
 * consumer, which is how an operator learns to stop reading them.
 */

import { storageOf, type KeyedStore, type MessagingLike, type StorageLike, type StreamFamily } from "../storage/index.js";
import { sendOpsAlert, type OpsAlert } from "../shared/ops-events.js";

/** The fold's durable (witness-fold.ts). Duplicated as a literal rather than
 *  imported so this file never pulls the fold's SDK and audit-log dependency
 *  chain into the process that runs the watch. */
const DURABLE = "audit_witness";

/** The mailboxes' retention (registry/inbox-buffer.ts). Named in the alert so
 *  the operator knows what the deadline actually is. */
const RETENTION_DAYS = 7;

/** How long a new mailbox may sit consumer-less before it is a finding. The
 *  fold reconciles every 5 minutes, so an hour of grace flags only a reconcile
 *  loop that has genuinely stopped, never a mailbox it has not met yet. */
export const CREATE_GRACE_MS = 3600_000;

const BUCKET = "mesh_witness_watch";
const STATE_KEY = "state";

/** Floors, not clamps from above: an operator may watch as coarsely as they
 *  like, but a zero or garbage value must not turn the watch into a busy loop
 *  or a hair trigger. Read per call so tests (and a restart) see the env. */
export function watchIntervalMs(): number {
  return Math.max(5 * 60_000, Number(process.env.WITNESS_WATCH_INTERVAL_MS ?? 30 * 60_000));
}
export function lagThreshold(): number {
  return Math.max(100, Number(process.env.WITNESS_LAG_THRESHOLD ?? 5000));
}
export function staleMs(): number {
  return Math.max(3600_000, Number(process.env.WITNESS_STALE_MS ?? 48 * 3600_000));
}

/** One mailbox as the pass saw it. Collection and judgment are separate so the
 *  judgment is a pure function the tests can drive without a connection. */
export interface MailboxObservation {
  stream: string;
  /** Stream creation, epoch ms; NaN when unparseable (judged as old, because
   *  an unreadable birthday must not grant indefinite grace). */
  createdMs: number;
  /** null when the consumer does not exist - the "missing" case. */
  consumer: {
    numPending: number;
    /** num_pending + num_ack_pending: everything not yet folded to done. */
    outstanding: number;
    /** Age source for "stale"; null when there is nothing outstanding. */
    oldestOutstandingMs: number | null;
  } | null;
}

export interface WitnessFinding {
  stream: string;
  kind: "missing" | "lagging" | "stale";
  pending: number;
  /** For "stale": the oldest outstanding message's timestamp, epoch ms. */
  oldestMs?: number;
}

/**
 * Read every mailbox stream and its backstop consumer. Per-stream failures are
 * judged, not thrown: an unreachable consumer info IS the "missing" signal,
 * and one refusing mailbox must not blind the pass to the rest.
 */
export async function observeMailboxes(mailboxes: StreamFamily): Promise<MailboxObservation[]> {
  const out: MailboxObservation[] = [];
  for await (const s of mailboxes.list()) {
    const name = s.name;
    const createdMs = s.state.created ? s.state.created.getTime() : NaN;
    let consumer: MailboxObservation["consumer"] = null;
    try {
      const box = mailboxes.member(s.id);
      const ci = await box.consumerState(DURABLE);
      const outstanding = ci.pending + ci.ackPending;
      let oldestOutstandingMs: number | null = null;
      if (outstanding > 0) {
        // The oldest not-yet-folded message sits just past the ack floor
        // (mailbox streams are limits-retained, so interior gaps only appear
        // when retention has already eaten past the floor - hence the clamp
        // to first_seq, which IS the disaster this watch exists to preempt).
        const seq = Math.max(ci.ackFloor + 1, s.state.firstSeq);
        try {
          oldestOutstandingMs = (await box.read(seq)).time.getTime();
        } catch {
          // Precise read refused; fall back to the stream's oldest retained
          // message. Conservative, as the header says: it can flag fresh
          // pending work on an old stream, and that beats reporting nothing.
          const t = s.state.messages > 0 && s.state.firstTime ? s.state.firstTime.getTime() : NaN;
          oldestOutstandingMs = Number.isFinite(t) ? t : null;
        }
      }
      consumer = { numPending: ci.pending, outstanding, oldestOutstandingMs };
    } catch {
      consumer = null;
    }
    out.push({ stream: name, createdMs, consumer });
  }
  return out;
}

/** Judge one pass's observations. Pure; thresholds come from the env unless a
 *  test hands its own. A stream can be both lagging and stale, and both are
 *  said, because they call for different reactions (scale vs unwedge). */
export function assessWitness(
  observations: MailboxObservation[],
  nowMs: number,
  opts: { lagThreshold?: number; staleMs?: number } = {},
): WitnessFinding[] {
  const lag = opts.lagThreshold ?? lagThreshold();
  const stale = opts.staleMs ?? staleMs();
  const findings: WitnessFinding[] = [];
  for (const o of observations) {
    if (o.consumer === null) {
      // Warm-up grace: the fold has 5-minute reconciles to meet a new mailbox.
      // An unparseable created date gets no grace (NaN fails the comparison).
      if (nowMs - o.createdMs < CREATE_GRACE_MS) continue;
      findings.push({ stream: o.stream, kind: "missing", pending: 0 });
      continue;
    }
    if (o.consumer.numPending > lag) {
      findings.push({ stream: o.stream, kind: "lagging", pending: o.consumer.numPending });
    }
    if (
      o.consumer.outstanding > 0 &&
      o.consumer.oldestOutstandingMs !== null &&
      nowMs - o.consumer.oldestOutstandingMs > stale
    ) {
      findings.push({
        stream: o.stream,
        kind: "stale",
        pending: o.consumer.numPending,
        oldestMs: o.consumer.oldestOutstandingMs,
      });
    }
  }
  return findings;
}

/** "about 2 days" / "about 5 hours" - the alert talks in units an operator
 *  weighs against a 7-day deadline, not in milliseconds. */
function aboutAge(ms: number): string {
  const hours = Math.round(ms / 3600_000);
  if (hours < 48) return `about ${Math.max(1, hours)} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `about ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * One message covering every finding. Plain sentences: the reader is an
 * operator on a phone deciding whether to get up, and the subject alone often
 * has to carry that decision, so it names the worst thing (missing coverage
 * outranks old work, old work outranks a deep queue).
 */
export function composeWitnessAlert(
  findings: WitnessFinding[],
  nowMs: number,
): { subject: string; lines: string[] } {
  const missing = findings.filter((f) => f.kind === "missing");
  const lagging = findings.filter((f) => f.kind === "lagging");
  const stale = findings.filter((f) => f.kind === "stale");
  const lines: string[] = [];

  if (missing.length) {
    lines.push(
      `${missing.length} mailbox stream${missing.length === 1 ? " has" : "s have"} no audit ` +
        `backstop consumer, so nothing is copying their traffic into the audit record: ` +
        `${missing.map((f) => f.stream).join(", ")}.`,
    );
  }
  if (lagging.length) {
    const total = lagging.reduce((n, f) => n + f.pending, 0);
    const worst = lagging.reduce((a, b) => (b.pending > a.pending ? b : a));
    lines.push(
      `The audit backstop is ${total} messages behind on ${lagging.length} mailbox ` +
        `stream${lagging.length === 1 ? "" : "s"}; the deepest is ${worst.stream} at ` +
        `${worst.pending}.`,
    );
  }
  if (stale.length) {
    const oldest = stale.reduce((a, b) => ((b.oldestMs ?? nowMs) < (a.oldestMs ?? nowMs) ? b : a));
    lines.push(
      `The oldest unprocessed traffic is ${aboutAge(nowMs - (oldest.oldestMs ?? nowMs))} old, ` +
        `on ${oldest.stream}. Mailbox streams drop messages at ${RETENTION_DAYS} days, and ` +
        `anything dropped unprocessed never reaches the audit record.`,
    );
  }

  const subject = missing.length
    ? `audit backstop missing on ${missing.length} mailbox stream${missing.length === 1 ? "" : "s"}`
    : stale.length
      ? `audit backstop has ${aboutAge(nowMs - (stale[0].oldestMs ?? nowMs))}-old unprocessed traffic`
      : `audit backstop ${lagging.reduce((n, f) => n + f.pending, 0)} messages behind`;

  return { subject, lines };
}

/** Everything the watch remembers between runs. In KV, not memory, so a
 *  restart does not turn a known problem back into news. */
interface WatchState {
  hadFindings: boolean;
  updatedAt?: string;
}

async function loadState(kv: KeyedStore): Promise<WatchState> {
  try {
    const e = await kv.get(STATE_KEY);
    if (!e) return { hadFindings: false };
    return JSON.parse(e.string()) as WatchState;
  } catch {
    return { hadFindings: false };
  }
}

/** One operator alert, as the watch composes it (`mesh.ops.alert`). */
export type OperatorAlert = OpsAlert;

export interface WitnessWatchDeps {
  /** The connection, which answers for the streams on JetStream. */
  nc: StorageLike | MessagingLike;
  /** The storage (or the JetStream client the layer adopts as one). */
  js: StorageLike;
  /**
   * Hands an operator alert to whoever delivers alerts to a person, and says
   * whether someone took it. The watch is core (it guards the core's own
   * audit log); how an alert reaches a person is the operator's. Default: a
   * `mesh.ops.alert` request on the bus (shared/ops-events.ts), which
   * AgentMesh's platform answers with its Unified Error Log and email.
   */
  alert?: (a: OperatorAlert) => Promise<boolean>;
}

/** Seams for the unit tests; production callers pass none of these. */
export interface WitnessWatchOverrides {
  now?: () => number;
  mailboxes?: StreamFamily;
  openState?: () => Promise<KeyedStore>;
}

export async function runWitnessWatch(
  deps: WitnessWatchDeps,
  overrides: WitnessWatchOverrides = {},
): Promise<WitnessFinding[]> {
  // The fold's own switch. Off is a choice, not a failure, so the pass says so
  // and manufactures nothing - an operator who turned the backstop off should
  // not be paged about the consumers it is deliberately not running.
  if ((process.env.MESH_AUDIT_WITNESS ?? "on").toLowerCase() === "off") {
    console.log(
      "[witness-watch] MESH_AUDIT_WITNESS=off: the audit backstop is disabled on this mesh, " +
        "so there is nothing to watch and no findings are reported.",
    );
    return [];
  }

  let mailboxes: StreamFamily;
  try {
    mailboxes = overrides.mailboxes ?? storageOf(deps.js, deps.nc).streams("MESH_INBOX_<agent>");
  } catch (err) {
    console.warn(`[witness-watch] cannot reach the mailboxes, skipping this pass: ${(err as Error).message}`);
    return [];
  }

  const nowMs = overrides.now ? overrides.now() : Date.now();
  let observations: MailboxObservation[];
  try {
    observations = await observeMailboxes(mailboxes);
  } catch (err) {
    // The stream LIST failed, which is different from one bad mailbox: a pass
    // that saw nothing must not conclude everything recovered.
    console.warn(`[witness-watch] cannot list mailbox streams, skipping this pass: ${(err as Error).message}`);
    return [];
  }

  const findings = assessWitness(observations, nowMs);

  // Always log, whether or not anything is emailed. The log is the record
  // that this ran and what it saw.
  if (findings.length) {
    console.warn(
      `[witness-watch] ${findings.length} finding(s) across ${observations.length} mailbox stream(s): ` +
        findings.map((f) => `${f.stream}=${f.kind}`).join(" "),
    );
  }

  let kv: KeyedStore;
  try {
    kv = await (overrides.openState ? overrides.openState() : storageOf(deps.js).keyed(BUCKET));
  } catch (err) {
    // Without the baseline the once-per-transition rule cannot be honored, and
    // repeating an alert every half hour is worse than logging it. Findings
    // are already on the console above.
    console.warn(`[witness-watch] no state bucket; findings logged, alerting skipped: ${(err as Error).message}`);
    return findings;
  }
  const state = await loadState(kv);

  // THE RULE: alert only on the transition from a clean pass to a pass with
  // findings. A problem that persists said its piece already; it gets a second
  // alert only after a clean pass in between. State is in KV, so a restart
  // does not reset the edge. An alert nobody took (no operator listening, or
  // none answering in time) is not recorded as said, so the next pass asks
  // again rather than losing it.
  const worthSending = findings.length > 0 && !state.hadFindings;
  let said = true;

  if (worthSending) {
    const { subject, lines } = composeWitnessAlert(findings, nowMs);
    const alert = deps.alert ?? ((a: OperatorAlert) => sendOpsAlert(a, { nc: deps.nc as MessagingLike }));
    try {
      said = await alert({
        type: "witness watch", subject, lines,
        footer: "The backstop runs inside the activity service; check that process first. This notice is " +
          "sent when findings first appear, not once per check, so an unchanged problem will not " +
          "email again until it has cleared and returned.",
      });
    } catch (err) {
      said = false;
      console.error(`[witness-watch] operator alert could not be sent: ${(err as Error).message}`);
    }
    if (!said) {
      console.warn("[witness-watch] nobody took the operator alert; the findings are logged above, and the next pass asks again.");
    }
  }

  if (findings.length === 0 && state.hadFindings) {
    console.log("[witness-watch] the audit backstop has recovered; all mailbox consumers look healthy.");
  }

  try {
    await kv.put(STATE_KEY, JSON.stringify({ hadFindings: findings.length > 0 && said, updatedAt: new Date(nowMs).toISOString() } satisfies WatchState));
  } catch (err) {
    // Without this the next pass has no baseline and repeats itself. Worth
    // saying, not worth throwing.
    console.warn(`[witness-watch] could not persist state: ${(err as Error).message}`);
  }

  return findings;
}

/**
 * Hand the watch to the scheduler. Run beside the core's mesh API
 * (core-start.ts), not in the activity service, deliberately: the failure
 * being watched for is the activity process (or its fold) being down or
 * wedged, and a watcher living inside the thing it watches goes down with it.
 * On AgentMesh the mesh API runs in its own process (agentmesh-mesh); a
 * server that runs every service in one process watches from the same one.
 */
export function registerWitnessWatchJob(
  scheduler: {
    register(job: { name: string; intervalMs: number; leaseTtlMs?: number; run: () => Promise<void> }): void;
  },
  deps: WitnessWatchDeps,
): void {
  scheduler.register({
    name: "witness-watch",
    intervalMs: watchIntervalMs(),
    // Default lease: the pass is a handful of metadata reads, nowhere near
    // the five-minute TTL even on a large fleet.
    run: async () => {
      await runWitnessWatch(deps);
    },
  });
}
