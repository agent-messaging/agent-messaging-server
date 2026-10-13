/**
 * The usage fold — agent_stats as a CONSUMER of the meter-event stream.
 *
 * Before this, the activity tap wrote the usage counters directly. Now the tap
 * publishes §13.5 meter events (shared/metering.ts) and this fold — a durable
 * JetStream consumer on MESH_METERING — turns them back into the same counter
 * writes, plus the per-counterparty rollup the direct path never had. The
 * numbers agent_stats/agent_stats_daily hold are BY CONSTRUCTION what they
 * always were: the fold reconstructs the exact legacy calls (recordIn /
 * recordDelivered / recordOut / recordOutBytes) from the event batch, and the
 * reconciliation test pins that equivalence.
 *
 * Three properties the direct path could not offer:
 *
 *  - **Counterparty.** Every event carries provider AND consumer, so the fold
 *    feeds `agent_stats_daily_peer` — "who did I serve" and "whose agents did
 *    I consume" are the same rows read from opposite ends.
 *  - **Idempotency.** (meter, envelope_id) is the §13.5 dedupe key; JetStream
 *    redelivery can never double-count. The dedupe ledger is bounded,
 *    first-seen-evicted, remembered BEFORE judging — §22.2's shape.
 *  - **Replayability.** The stream outlives the fold, so later consumers
 *    (rating, §19.6) read the same facts the counters were built from.
 *
 * Trust: the metering subject is an ordinary event subject anyone with a
 * credential can publish on, so the fold accepts an envelope only when its
 * VERIFIED `from` is a key it trusts — its own service key plus
 * METERING_TRUSTED_KEYS (the task manager's key, in a deployment that wants
 * task meters folded here someday). Everything else is dropped loudly: a
 * stranger-signed meter event is a counter-inflation primitive, not a fact.
 *
 * Failure policy matches the counters' lifelong one: an event that cannot be
 * folded is dropped (acked), never redelivered forever — a poison message
 * must not wedge the stream, and these are counters, not money. Rating reads
 * the stream itself, not this fold, so nothing here decides what anything
 * costs.
 */

import { decode } from "../sdk.js";
import type { StreamConsumer, StreamStore } from "../storage/index.js";
import {
  METERING_STREAM,
  METERING_SUBJECT,
  readBatch,
  type MeterEventBatch,
} from "../shared/metering.js";
import type { UsageStore } from "./usage-store.js";

const DURABLE = "activity_usage_fold";

/** Bounded dedupe ledger: remember-before-judging, first-seen eviction —
 *  §22.2's shape, applied to the §13.5 idempotency key. 50k keys covers hours
 *  of fleet traffic; an eviction older than the JetStream ack floor is a key
 *  that can no longer be redelivered anyway. */
const MAX_SEEN = 50_000;

const TRUSTED_ENV_KEYS: string[] = (process.env.METERING_TRUSTED_KEYS ?? "")
  .split(/[\s,]+/)
  .map((k) => k.trim())
  .filter((k) => k.length > 0);

/**
 * Apply one validated batch to the counters and the peer rollup.
 *
 * Exported and pure over its inputs (the store batches internally), so the
 * reconciliation test can drive it without NATS. The mapping is the legacy
 * tap behaviour, reconstructed:
 *
 *   requests(1) + bytes_in  → recordIn(provider, bytes); recordDelivered(consumer, bytes)
 *   responses(1) + bytes_out → recordOut(provider, failed, bytes)
 *   bytes_out alone          → recordOutBytes(provider, bytes)   (task-mode follow-up)
 *   requests(0, refused)     → peer refusals only — never a counter
 *   tasks_completed/task_ms  → not folded (no stats column); the stream keeps
 *                              them for rating (§19.6)
 */
export function applyBatch(usage: UsageStore, batch: MeterEventBatch): void {
  const byMeter = new Map<string, (typeof batch.events)[number]>();
  for (const e of batch.events) byMeter.set(e.meter, e);

  const requests = byMeter.get("requests");
  const bytesIn = byMeter.get("bytes_in");
  const responses = byMeter.get("responses");
  const bytesOut = byMeter.get("bytes_out");

  if (requests && requests.refused === true) {
    // Declined demand: recorded on the peer rollup, charged to nobody's
    // message counters — the request itself was already counted when it was
    // delivered, under its own envelope id.
    usage.recordPeer(requests.provider, requests.consumer, { refusals: 1 });
    return;
  }

  if (requests) {
    const bytes = bytesIn?.quantity ?? 0;
    usage.recordIn(requests.provider, bytes);
    usage.recordDelivered(requests.consumer, bytes);
    usage.recordPeer(requests.provider, requests.consumer, { requests: 1, bytes_in: bytes });
    return;
  }

  if (responses) {
    const bytes = bytesOut?.quantity ?? 0;
    const failed = batch.failed === true;
    usage.recordOut(responses.provider, failed, bytes);
    usage.recordPeer(responses.provider, responses.consumer, {
      responses: 1,
      bytes_out: bytes,
      errors: failed ? 1 : 0,
    });
    return;
  }

  if (bytesOut) {
    usage.recordOutBytes(bytesOut.provider, bytesOut.quantity);
    usage.recordPeer(bytesOut.provider, bytesOut.consumer, { bytes_out: bytesOut.quantity });
  }
  // Anything else (task meters, future declared meters) is deliberately not
  // folded here — the stream is the record; this fold is only the counters'.
}

export class MeteringFold {
  private iter: StreamConsumer | null = null;
  private seen = new Set<string>();
  private lastDropLog = 0;

  private constructor(
    private usage: UsageStore,
    private trusted: ReadonlySet<string>,
  ) {}

  /**
   * Ensure the durable consumer and start folding. Returns null when the
   * consumer cannot be set up — the caller falls back to direct counter
   * writes and says so (activity-service.ts).
   */
  static async start(
    metering: StreamStore,
    usage: UsageStore,
    selfKey: string,
  ): Promise<MeteringFold | null> {
    try {
      const fold = new MeteringFold(usage, new Set([selfKey, ...TRUSTED_ENV_KEYS]));
      fold.iter = await metering.consume(DURABLE, { filter: METERING_SUBJECT });
      void fold.run();
      console.log(
        `[metering] usage fold consuming ${METERING_STREAM} (durable ${DURABLE}, ` +
          `${fold.trusted.size} trusted writer key(s))`,
      );
      return fold;
    } catch (err) {
      console.error(
        "[metering] usage fold could not start:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  private async run(): Promise<void> {
    if (!this.iter) return;
    for await (const m of this.iter) {
      try {
        const env = decode(m.data); // verifies the envelope signature
        if (!this.trusted.has(env.from)) {
          this.dropLog(`untrusted writer ${env.from.slice(0, 12)}…`);
        } else {
          const { batch, dropped } = readBatch(env);
          if (dropped > 0) this.dropLog(`${dropped} malformed event(s)`);
          this.fold(batch);
        }
      } catch (err) {
        // Unverifiable or unparseable: dropped, not redelivered — a poison
        // message must not wedge the counters.
        this.dropLog(err instanceof Error ? err.message : String(err));
      }
      m.ack();
    }
  }

  /** Dedupe on the §13.5 key, then apply. A batch is one observation moment
   *  written atomically, so its keys are all-or-none: any seen key means the
   *  whole batch was already applied (a redelivery). */
  private fold(batch: MeterEventBatch): void {
    if (batch.events.length === 0) return;
    const keys = batch.events.map((e) => `${e.meter}|${e.envelope_id}`);
    if (keys.some((k) => this.seen.has(k))) return;
    for (const k of keys) {
      this.seen.add(k);
      if (this.seen.size > MAX_SEEN) {
        const oldest = this.seen.values().next().value as string;
        this.seen.delete(oldest);
      }
    }
    applyBatch(this.usage, batch);
  }

  private dropLog(what: string): void {
    const now = Date.now();
    if (now - this.lastDropLog < 60_000) return;
    this.lastDropLog = now;
    console.error(`[metering] dropped from the usage fold: ${what}`);
  }

  stop(): void {
    this.iter?.stop();
    this.iter = null;
  }
}
