/**
 * The origin tap's plumbing: how envelopes from `mesh.agent.*.inbox` reach the
 * ledger (origin.ts), and how the operator learns when origins go missing.
 *
 * ## Ordering without a serial loop
 *
 * One serial loop per subscription falls behind under load, and core NATS
 * drops messages for a subscriber that falls far enough behind. So envelopes
 * are processed concurrently, up to MAX_IN_FLIGHT, and ordered only where
 * order matters: by the request they concern. A request and every answer to
 * it share a key (the request's id, which an answer names in `in_reply_to`),
 * so a request's record is always written before its answers are judged, and
 * two answers to one request are judged in the order they arrived (the first
 * answer rule depends on it). A `task.cancel` request is keyed by its Task.
 * At MAX_IN_FLIGHT the tap stops reading until a slot frees, so pressure
 * shows up in the counters below rather than as silent loss in this process.
 *
 * ## Retries
 *
 * An answer whose request is not recorded yet (it arrived first, or the
 * request's write is still in flight on another key) is tried again on a
 * short bounded backoff (RETRY_DELAYS_MS), then counted as missed.
 *
 * ## What the operator sees
 *
 * Every miss is a `mesh.ops.metric` fact (`kind: "task_origin"`, `status` one
 * of the {@link OriginMiss} values), and the counts are logged once a minute
 * while any are non-zero, so a mesh where origins are being lost says so.
 */

import { decode, type Envelope } from "../sdk.js";
import { metrics } from "../shared/ops-events.js";
import { a2aAnswerTaskId, a2aRequestFacts, CANCEL_OFFERING, isAccept } from "../shared/a2a-frames.js";
import { isA2AFrame } from "../../../sdk-typescript/src/a2a/binding.js";
import { cancelIdentity, type Observation, type OriginLedger } from "./origin.js";

/** How many A2A requests that never create a Task are remembered, so their
 *  answers are not judged as answers that could have (see `ledgerView`). */
const NON_TASK_REQUESTS_MAX = 10_000;

/**
 * The envelope as the ledger reads it. The ledger reads a request's offering
 * and Task id, and an answer's Task id, from the 0.3.0 envelope fields; a
 * 0.4.0 frame (the A2A binding) carries them inside its A2A object instead
 * (bindings/a2a.md §4). So a 0.4.0 frame is shown to the ledger with those
 * fields filled in from its A2A object (shared/a2a-frames.ts), its id,
 * parties, `ts` and `in_reply_to` untouched. The frame was verified before
 * this; the view is never sent anywhere or verified again.
 *
 *  - SendMessage, SendStreamingMessage: the offering the Message names (or
 *    "", as SPEC.md §7.1 records a call naming none), and the Task id the
 *    Message names, which binds `bound_by: "request"` as §7.1 says.
 *  - CancelTask: a cancel request (§10.8) for the Task it names.
 *  - Every other operation (the reads, the push notification configs, the
 *    extended card) creates no Task and binds nothing: it is not shown, and
 *    neither are its answers, which carry a Task without having created one.
 *  - An answer: the Task id its Task, status update or artifact update
 *    carries; the 0.4.0 accept signal reads as the 0.3.0 one.
 *
 * Returns null for a frame the ledger does not see. A 0.3.0 envelope is
 * returned as it is.
 */
export function ledgerView(env: Envelope, nonTask: Set<string>): Envelope | null {
  if (!isA2AFrame(env)) return env;
  if (env.type === "request") {
    const facts = a2aRequestFacts(env);
    if (!facts) return env; // a channel frame (describe, knock, the probe) or a sealed payload
    if (facts.method === "SendMessage" || facts.method === "SendStreamingMessage") {
      return { ...env, payload: { offering: facts.offering ?? "" }, ...(facts.taskId ? { task_id: facts.taskId } : {}) } as Envelope;
    }
    remember(nonTask, env.id);
    if (facts.method === "CancelTask" && facts.taskId) {
      return { ...env, payload: { offering: CANCEL_OFFERING, input: { task_id: facts.taskId } } } as Envelope;
    }
    return null;
  }
  if (env.type === "respond") {
    if (typeof env.in_reply_to === "string" && nonTask.has(env.in_reply_to)) return null;
    if (isAccept(env)) return { ...env, payload: { status: "accepted" } } as Envelope;
    const taskId = a2aAnswerTaskId(env);
    return taskId ? ({ ...env, task_id: taskId } as Envelope) : env;
  }
  return env;
}

function remember(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size > NON_TASK_REQUESTS_MAX) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

/** The ways an origin can go missing, as counted and reported. */
export type OriginMiss =
  /** An answer whose request was never recorded, after every retry. */
  | "unknown_request"
  /** A binding refused because the request was first seen long after its
   *  Task existed: a resume, or a tap that fell more than ORIGIN_SKEW_MS
   *  behind. */
  | "late"
  /** An envelope waited more than SLOW_MS between arriving and being looked
   *  at: the tap is behind. */
  | "slow"
  /** The tap is at MAX_IN_FLIGHT and has stopped reading. */
  | "backlog"
  /** A Task reached a terminal state with no origin (task-update.ts). Either
   *  its request never crossed this server, or an observation was lost. */
  | "terminal_without_origin"
  /** A request's first answer named a Task id already bound to another
   *  request; the meta names both request ids. */
  | "contested"
  /** A request named somebody else's Task id and was answered under it:
   *  the requester's choice, recorded nowhere but here. */
  | "foreign_task_named"
  /** A cancel attribution was still unverified 24 hours after the cancel
   *  and became unverified `expired`, for an operator. */
  | "canceled_by_expired"
  /** The ledger threw. */
  | "error";

export const MAX_IN_FLIGHT = 256;
export const RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000];
/** A `task.cancel` request whose write failed is tried again on a longer
 *  schedule: until it is written, a cancel attribution for its Task stays
 *  unverified (`window_incomplete`). */
export const CANCEL_RETRY_DELAYS_MS = [250, 1_000, 5_000, 30_000, 120_000];
export const SLOW_MS = 5_000;
const REPORT_EVERY_MS = 60_000;

const counts = new Map<OriginMiss, number>();
let reporter: ReturnType<typeof setInterval> | null = null;

/** Count one miss: a metric fact now, and the minute's log line later. */
export function noteOriginMiss(status: OriginMiss, meta: Record<string, unknown> = {}): void {
  counts.set(status, (counts.get(status) ?? 0) + 1);
  try {
    metrics.event({ kind: "task_origin", status, meta });
  } catch {
    /* the metric is advisory */
  }
  if (!reporter) {
    reporter = setInterval(flushOriginMisses, REPORT_EVERY_MS);
    reporter.unref?.();
  }
}

/** Log the counts since the last report, and reset them. Exported for tests. */
export function flushOriginMisses(): Record<string, number> {
  const out = Object.fromEntries(counts);
  if (counts.size) {
    console.warn(
      `[task-manager] task origins missed in the last minute: ` +
        [...counts].map(([k, v]) => `${k} ${v}`).join(", ") +
        ` (task-manager/origin-tap.ts says what each means)`,
    );
  }
  counts.clear();
  return out;
}

/** The agent whose inbox a subject is: `mesh.agent.<agent>.inbox`. */
export function inboxAgentOf(subject: string): string | null {
  const parts = subject.split(".");
  return parts.length === 4 && parts[0] === "mesh" && parts[1] === "agent" && parts[3] === "inbox" ? parts[2] : null;
}

/** The key an envelope is ordered by (see the header). */
function orderKey(env: Envelope): string {
  if (typeof env.in_reply_to === "string" && env.in_reply_to !== "") return `r:${env.in_reply_to}`;
  const payload = env.payload as { offering?: unknown; input?: { task_id?: unknown } } | undefined;
  if (env.type === "request" && payload?.offering === "task.cancel") {
    const t = payload.input?.task_id ?? env.task_id;
    if (typeof t === "string") return `c:${t}`;
  }
  return `r:${env.id}`;
}

export class OriginTap {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<Promise<void>>();
  /** A2A requests that create no Task, by id (`ledgerView`). */
  private readonly nonTask = new Set<string>();

  constructor(
    private readonly ledger: OriginLedger,
    private readonly opts: {
      maxInFlight?: number;
      retryDelaysMs?: number[];
      cancelRetryDelaysMs?: number[];
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  /** In-flight observations (for tests and the backlog check). */
  get pending(): number {
    return this.inFlight.size;
  }

  /**
   * Take one message. Resolves when there is room for the next one, not when
   * this one is done (see `drain`).
   */
  async push(subject: string, data: Uint8Array): Promise<void> {
    const agent = inboxAgentOf(subject);
    if (!agent) return;
    let env: Envelope;
    try {
      const seen = ledgerView(decode(data), this.nonTask);
      if (!seen) return;
      env = seen;
    } catch {
      return; // unsigned, unverifiable or not an envelope: not observed
    }
    // A cancel request is in its window from the moment it arrives, so a
    // cancel attribution read before it is written knows it is missing.
    void this.ledger.cancelArrived(env);
    this.enqueue(env, agent, Date.now(), 0);
    const max = this.opts.maxInFlight ?? MAX_IN_FLIGHT;
    if (this.inFlight.size >= max) {
      noteOriginMiss("backlog", { in_flight: this.inFlight.size });
      while (this.inFlight.size >= max) await Promise.race(this.inFlight);
    }
  }

  /** Wait for everything taken so far, retries included. */
  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  /** Append one observation to its key's chain. */
  private enqueue(env: Envelope, agent: string, arrived: number, attempt: number): void {
    const key = orderKey(env);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.observe(env, agent, arrived, attempt));
    this.chains.set(key, run);
    const tracked: Promise<void> = run.finally(() => {
      this.inFlight.delete(tracked);
      if (this.chains.get(key) === run) this.chains.delete(key);
    });
    this.inFlight.add(tracked);
  }

  private async observe(env: Envelope, agent: string, arrived: number, attempt: number): Promise<void> {
    if (attempt === 0) {
      const waited = Date.now() - arrived;
      if (waited > SLOW_MS) noteOriginMiss("slow", { waited_ms: waited });
    }
    const delays = this.opts.retryDelaysMs ?? RETRY_DELAYS_MS;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    try {
      const outcome: Observation = await this.ledger.observe(env, agent, { final: attempt >= delays.length, receivedAt: arrived });
      await this.ledger.cancelSettledInTap(env).catch(() => undefined);
      if (outcome === "unknown_request" && attempt < delays.length) {
        // Tried again later, OUTSIDE this key's chain, so a request queued
        // behind this answer on the same key is written first. The pending
        // retry holds an in-flight slot, so `drain` waits for it.
        const retry = sleep(delays[attempt]).then(() => this.enqueue(env, agent, arrived, attempt + 1));
        const held: Promise<void> = retry.finally(() => this.inFlight.delete(held));
        this.inFlight.add(held);
        return;
      }
      // Counted only for an answer that could have bound a Task. An answer
      // with no Task id to a request the ledger never keeps (a describe, a
      // knock) is expected to stay unknown.
      // Counted for an answer that could have bound a Task, and for an
      // inbox-mode answer (which would have closed its request). A respond
      // with no Task id to a request the ledger never keeps (a describe, a
      // knock) is expected to stay unknown. Contests are counted by the
      // ledger, which knows both request ids.
      if (outcome === "unknown_request" && (env.task_id || env.type === "request")) {
        noteOriginMiss("unknown_request", { answer_id: env.id, in_reply_to: env.in_reply_to });
      } else if (outcome === "late") noteOriginMiss("late", { envelope_id: env.id, task_id: env.task_id });
    } catch (err) {
      noteOriginMiss("error", { envelope_id: env.id });
      console.error("[task-manager] origin tap:", err);
      // A cancel request whose write failed stays pending in its window (the
      // ledger marked it) and is tried again, outside its key's chain.
      const cancelDelays = this.opts.cancelRetryDelaysMs ?? CANCEL_RETRY_DELAYS_MS;
      if (cancelIdentity(env) && attempt < cancelDelays.length) {
        const retry = sleep(cancelDelays[attempt]).then(() => this.enqueue(env, agent, arrived, attempt + 1));
        const held: Promise<void> = retry.finally(() => this.inFlight.delete(held));
        this.inFlight.add(held);
      }
    }
  }
}
