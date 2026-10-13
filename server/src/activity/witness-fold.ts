/**
 * The witness fold - the audit chains' durable backstop.
 *
 * The activity tap is a plain core subscription: it records nothing that
 * flows while this service is down, and an audit with scheduled blind spots
 * is a weaker claim than it looks. What the transport DOES capture durably is
 * every registered agent's mailbox - one JetStream stream per agent,
 * MESH_INBOX_<id>, holding everything published to its inbox subject whether
 * or not the agent (or this service) was up (registry/inbox-buffer.ts). This
 * fold consumes those streams with a durable consumer per stream, so a
 * request the transport durably held is guaranteed to reach the chains even
 * when the live tap missed it.
 *
 * What it writes is deliberately less than what the tap writes: a "witnessed"
 * pair, meaning the platform durably captured this message; the outcome is
 * not claimed. No duration, no completed/failed - the mailbox holds the
 * message, not what became of it.
 *
 * The HOLD WINDOW (WITNESS_HOLD_MS, default 10 minutes) is why this is a
 * backstop and not a second tap: a young capture is nak'd back until the live
 * tap and its unanswered sweep (5 minutes) have had their turn to write their
 * richer rows. Only what is still absent from the chains after that gets a
 * witnessed pair, keyed by the envelope's own id so a redelivery finds its
 * row and folds to nothing.
 *
 * Coverage is exactly the mailboxes' coverage: inbox traffic to registered,
 * mailbox-holding agents. Since the §6.4 cutover made the requester's inbox
 * the reply channel, that includes RESPONDS to mailbox-holding requesters -
 * judged as evidence of their exchange, keyed by the request's id, with the
 * §6.4a signals (accepts, queued acks) skipped (see judge). There is no
 * wildcard stream and no durable capture of the outbox mirror - extending
 * capture is a protocol task, not this fold's. Poison policy matches
 * metering-fold.ts: a message that cannot be decoded or judged is acked and
 * dropped, never redelivered forever.
 */

import type { Envelope } from "../sdk.js";
import { storageOf, type MessagingLike, type StorageLike, type StreamConsumer, type StreamFamily } from "../storage/index.js";
import { decode } from "../sdk.js";
import { AuditLog, sha256hex } from "./audit-log.js";

const DURABLE = "audit_witness";

/** How often the mailbox roster is re-listed for new streams. */
const RECONCILE_MS = Math.max(60_000, Number(process.env.WITNESS_RECONCILE_MS ?? 5 * 60_000));
/** How long a capture must age before the backstop judges it (see header). */
const HOLD_MS = Math.max(60_000, Number(process.env.WITNESS_HOLD_MS ?? 10 * 60_000));
/** The mailboxes' own retention (inbox-buffer.ts): anything claiming to be
 *  older is either a replayed relic or a lie, and neither belongs on a chain
 *  stamped with today's write time. */
const MAX_AGE_MS = 7 * 24 * 3600_000;

export class WitnessFold {
  /** Every agent's mailbox (storage layer, family `MESH_INBOX_<agent>`). */
  private mailboxes: StreamFamily;
  private reachable = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Live consume loops by stream name, so reconcile attaches each mailbox
   *  once and stop() can end them all. */
  private loops = new Map<string, StreamConsumer>();
  private stopped = false;
  private lastDropLog = 0;

  constructor(
    /** The connection, which answers for the streams on JetStream. */
    nc: StorageLike | MessagingLike,
    /** The storage (or the JetStream client the layer adopts as one). */
    js: StorageLike,
    /** The activity service's own AuditLog. Shared, not reopened: audit.db
     *  has ONE writer process, and this fold lives inside it. */
    private audit: AuditLog,
  ) {
    this.mailboxes = storageOf(js, nc).streams("MESH_INBOX_<agent>");
  }

  /** Attach to every mailbox now, then keep reconciling. Failure to reach
   *  the mailboxes leaves the backstop off - reported, because the tap still
   *  runs and the service must not die of its safety net. */
  async start(): Promise<void> {
    try {
      await this.reconcile(true);
    } catch (err) {
      console.error(
        "[witness] audit backstop could not reach the mailboxes and is NOT running:",
        err instanceof Error ? err.message : err,
      );
      return;
    }
    this.reachable = true;
    this.timer = setInterval(() => {
      this.reconcile().catch((err) =>
        console.error("[witness] reconcile failed:", err instanceof Error ? err.message : err),
      );
    }, RECONCILE_MS);
    // Don't hold the process open just to watch for new mailboxes.
    if (typeof this.timer.unref === "function") this.timer.unref();
    console.log(
      `[witness] audit backstop consuming ${this.loops.size} mailbox stream(s) ` +
        `(hold ${Math.round(HOLD_MS / 60_000)}m, reconcile every ${Math.round(RECONCILE_MS / 60_000)}m)`,
    );
  }

  /** One pass over the stream roster: attach to any mailbox not already
   *  being consumed. Departures need no pass of their own - deleting a
   *  stream (deregistration) ends its consume loop, which cleans itself up. */
  private async reconcile(first = false): Promise<void> {
    if ((!first && !this.reachable) || this.stopped) return;
    for await (const s of this.mailboxes.list()) {
      if (this.loops.has(s.name)) continue;
      await this.attach(s.name, s.id);
    }
  }

  private async attach(stream: string, agent: string): Promise<void> {
    try {
      // From the beginning: the backlog a fresh consumer finds is exactly
      // the traffic that flowed before the backstop existed.
      const iter = await this.mailboxes.member(agent).consume(DURABLE, { from: "all" });
      this.loops.set(stream, iter);
      void this.run(stream, iter);
    } catch (err) {
      // Next reconcile retries; one refusing mailbox must not stop the rest.
      console.error(
        `[witness] could not attach to ${stream}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async run(stream: string, iter: StreamConsumer): Promise<void> {
    try {
      for await (const m of iter) {
        let holdMs = 0;
        try {
          holdMs = this.judge(m.data);
        } catch (err) {
          // Undecodable, unverifiable, or unjudgeable: dropped, not redelivered
          // forever - a poison message must not wedge the mailbox's consumer.
          holdMs = 0;
          this.dropLog(err instanceof Error ? err.message : String(err));
        }
        if (holdMs > 0) m.nak(holdMs);
        else m.ack();
      }
    } catch {
      // The stream went away mid-consume - an agent deregistering takes its
      // mailbox with it, and that is routine, not an error.
    } finally {
      if (this.loops.get(stream) === iter) this.loops.delete(stream);
    }
  }

  /**
   * One capture's verdict: 0 to ack it (folded or discarded), a positive
   * delay to nak it back for later. Throws are the caller's poison path.
   */
  private judge(data: Uint8Array): number {
    const env: Envelope = decode(data); // verifies the envelope signature
    const t = Date.parse(env.ts ?? "");
    // No date means no hold window and no age bound - and a row we cannot
    // place in time adds nothing an audit could settle.
    if (!Number.isFinite(t)) return 0;
    const age = Date.now() - t;
    if (age > MAX_AGE_MS) return 0;
    if (age < HOLD_MS) {
      // Still inside the live tap's turn. `ts` is the sender's claim, so a
      // postdated envelope gets at most one hold window per delivery, not a
      // parking spot as far out as it cares to date itself.
      return Math.min(HOLD_MS, HOLD_MS - age);
    }
    if (env.type !== "request" && env.type !== "respond") return 0;
    const payload = env.payload as
      | {
          offering?: string;
          skill?: string;
          input?: unknown;
          status?: string;
          queued?: unknown;
          inbox_id?: unknown;
          output?: { queued?: unknown; inbox_id?: unknown };
        }
      | undefined;
    // §8.5 deprecation window: pre-rename senders say `skill`.
    const offering = payload?.offering ?? payload?.skill ?? "unknown";
    // Registry liveness probes are plumbing, not traffic - the tap's rule.
    if (offering === "__registry_probe__") return 0;
    // §6.4a signals, which the cutover routes through the requester's inbox
    // and therefore into its mailbox stream: an accept says a handler is about
    // to run, a queued ack says a message reached a held mailbox. Neither is
    // an exchange, so neither may become a "witnessed" pair - a row minted
    // from an accept would claim the platform witnessed an exchange whose
    // outcome nothing captured, under an id no other sighting dedupes against.
    // The tap skips them for the same reason.
    if (env.type === "respond") {
      if (!env.error && payload?.status === "accepted") return 0;
      const ackish = (c?: { queued?: unknown; inbox_id?: unknown }) =>
        c?.queued === true && typeof c.inbox_id === "string" && c.inbox_id.length > 0;
      if (ackish(payload) || ackish(payload?.output)) return 0;
    }
    // Already on a chain: the tap saw it, or an earlier delivery of this same
    // capture did. For a respond, the tap's row carries the REQUEST's id, so
    // the exchange is looked up under `in_reply_to` as well - a respond whose
    // exchange is already recorded needs no second telling.
    if (this.audit.hasRequest(env.id)) return 0;
    if (env.in_reply_to && this.audit.hasRequest(env.in_reply_to)) return 0;
    const inputJson = payload?.input !== undefined ? JSON.stringify(payload.input) : undefined;
    if (env.type === "respond") {
      // A respond in a REQUESTER's mailbox stream (the §6.4 reply channel),
      // whose request never made a chain - the responder had no mailbox and
      // the tap was down. Witness the EXCHANGE it evidences, not the wire
      // artifact: the parties come from the respond read in reverse (its
      // sender is the agent that served, its recipient the one that asked),
      // and the row is keyed by `in_reply_to` - the request's id, the same key
      // every other record of this exchange carries - so a later sighting of
      // this exchange from either side folds to nothing above. Keying it by
      // the respond's own id would let the accept, the answer and a tap row
      // each chain the same exchange under a different name.
      this.audit.appendWitnessed({
        from: env.to ?? "",
        to: env.from,
        skill: offering,
        taskId: env.task_id,
        requestId: env.in_reply_to ?? env.id,
        inputSha256: undefined,
      });
      return 0;
    }
    this.audit.appendWitnessed({
      from: env.from,
      to: env.to ?? "",
      skill: offering,
      taskId: env.task_id,
      requestId: env.id,
      inputSha256: inputJson !== undefined ? sha256hex(inputJson) : undefined,
    });
    return 0;
  }

  private dropLog(what: string): void {
    const now = Date.now();
    if (now - this.lastDropLog < 60_000) return;
    this.lastDropLog = now;
    console.error(`[witness] dropped from the audit backstop: ${what}`);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const iter of this.loops.values()) iter.stop();
    this.loops.clear();
  }
}
