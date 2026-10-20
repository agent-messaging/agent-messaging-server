/**
 * Activity Service — captures all agent request/response traffic.
 *
 * Taps `mesh.agent.*.inbox` to observe every request hitting an agent - and,
 * since the §6.4 hard cutover made the requester's inbox the reply channel,
 * every response reaching a requester too. Taps `mesh.agent.*.outbox`, where
 * the responder's SDK still mirrors each response it makes. The same respond
 * envelope can therefore be SEEN TWICE (requester's inbox + responder's
 * outbox), so recording classifies by the envelope, never by the arrival
 * subject, and counts each envelope once (see recordResponse).
 * Stores activity entries in NATS KV for timeline queries.
 * Serves `mesh.activity.list` for retrieving recent activity.
 *
 * An entry holds `inputPreview` — the first 200 characters of the request input —
 * so this store is bounded twice, by count AND by age, and removals purge rather
 * than soft-delete. See the Retention section and MAX_ENTRIES / MAX_AGE_MS below.
 */

import { messagingOf, type MessagingLike } from "../storage/index.js";
import type { BusSubscription, Messaging, StorageLike } from "../storage/index.js";
import type { Envelope } from "../sdk.js";
import {
  createEnvelope,
  decode,
  childSpan,
  uuid7,
  Subjects,
  ErrorCode,
  audienceOf,
} from "../sdk.js";
import { keyedOf, storageOf, type KeyedLike, type KeyedStore } from "../storage/index.js";
import { metrics } from "../shared/ops-events.js";
import { parseNodeAttestations } from "../registry/node-profile-store.js";
import { identityFromEnv } from "../shared/seed.js";
import { idOf, sealEnvelope, subscribeWithHandler } from "../shared/handler.js";
import { serviceQueue } from "../shared/queue-groups.js";
import { UsageStore } from "./usage-store.js";
import { AuditLog, sha256hex } from "./audit-log.js";
import {
  ADMISSION_REFUSAL_CODES,
  declaredUsage,
  usageReceiptParties,
  observedRefusal,
  observedRequest,
  observedResponse,
  observedResponseBytes,
  publishMeterEvents,
} from "../shared/metering.js";
import { MeteringFold } from "./metering-fold.js";
import { tapOutcome, unansweredReason } from "./monitor-classify.js";
import { WitnessFold } from "./witness-fold.js";
import { ExchangeIndex, type ExchangeRecord } from "./exchange-index.js";
import { dataDbPath } from "../data-dir.js";
import { coreUrl } from "../shared/settings.js";

/**
 * An env-configured bound, ignoring a value that is not a non-negative number.
 *
 * One deliberate deviation from the house one-liner
 * (`Number(process.env.X ?? default)`, inbox-buffer.ts:20-21): these two bounds
 * are the only thing standing between request content and indefinite retention,
 * and `Number("")` is 0 while `Number("30d")` is NaN — either of which silently
 * reads as "no limit" in a `length > n` or `now - ts > n` comparison. A typo in a
 * retention limit must not mean forever.
 */
function bound(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[activity] ${name}="${raw}" is not a number >= 0 — using the default ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * Retention on the activity ring — TWO bounds, both enforced, whichever binds
 * first.
 *
 *  - ACTIVITY_MAX_ENTRIES (default 500): how many exchanges the ring holds.
 *    Enforced on insert.
 *  - ACTIVITY_MAX_AGE_MS (default 30 days): how long one of them may live.
 *    Enforced by a periodic sweep; 0 turns the age bound off and leaves the
 *    count bound alone.
 *
 * The age bound exists because an entry is not metadata. `inputPreview` is the
 * first 200 characters of real request input, so a count bound ALONE means a
 * quiet mesh keeps that content indefinitely: 500 rows on a six-agent fleet is
 * months of conversation, and the reference deployment's bucket had no expiry of
 * any kind. Thirty days because the activity view exists so an operator can see
 * what has been happening RECENTLY — nothing in the read path can even ask for
 * older, since `handleList` accepts no time range and caps a page at 200 rows.
 *
 * This number is a privacy-policy commitment, not a tuning knob. Raising it
 * lengthens how long we hold other people's request content, so change it
 * against the published policy, not to make one debugging session easier.
 *
 * A bucket-level TTL would be the tidier mechanism and does NOT work here:
 * `ensureKvBucket` passes its options to `js.views.kv`, which applies them only
 * when it CREATES the stream (nats `kv.js` `init()` calls `streams.info` first
 * and uses an existing stream as-is), so the long-lived `mesh_activity` bucket —
 * created with no `max_age` — would never receive one. The expiry has to live in
 * the service or it is not an expiry.
 */
const MAX_ENTRIES = bound("ACTIVITY_MAX_ENTRIES", 500);
const MAX_AGE_MS = bound("ACTIVITY_MAX_AGE_MS", 30 * 24 * 3600_000);
/** How often the age bound is enforced. The first pass is one interval AFTER
 *  `start()`, never during load — bringing the service up must not itself be a
 *  deletion event (see `sweepExpired`). Floored at a second, because `0` is a
 *  legal value for the other two bounds but here it would mean a bucket scan on
 *  every event-loop tick. */
const SWEEP_INTERVAL_MS = Math.max(1000, bound("ACTIVITY_SWEEP_INTERVAL_MS", 3600_000));

/**
 * When a request with no response becomes an `unanswered` audit row.
 *
 * The audit log's capture used to be completed exchanges only, which made
 * silence invisible — and "I asked and got nothing" is precisely the kind of
 * claim an audit exists to settle. Five minutes default: every request path
 * through the platform carries a timeout well under that (the bridge forwards
 * with 60s), so by five minutes the exchange has genuinely not happened,
 * rather than not happened YET. 0 disables the sweep.
 */
const UNANSWERED_AFTER_MS = bound("AUDIT_UNANSWERED_AFTER_MS", 5 * 60_000);

/**
 * Whether a timestamp puts an entry past the cutoff.
 *
 * An unparseable value counts as EXPIRED. A row we cannot date is precisely the
 * unbounded retention this bound exists to end, it already sorts arbitrarily in
 * the ring, and the alternative — keeping it — is a hole any malformed envelope
 * can drive content through.
 */
function isExpired(ts: string | undefined, cutoff: number): boolean {
  const t = Date.parse(ts ?? "");
  return !Number.isFinite(t) || t < cutoff;
}

/**
 * The timestamp an entry is AGED BY — `recordedAt`, which this service stamps,
 * falling back to `ts` only when the field is absent.
 *
 * `ts` is the sender's claim: `recordRequest` copies `env.ts` when the requester
 * supplied one, and nothing verifies it. Aging on that meant a sender could
 * postdate its own envelope and postpone the expiry of the row holding the first
 * 200 characters of ITS OWN request — a year out, a century out, indefinitely —
 * which turns the 30-day bound into an opt-in. `recordedAt` is wall-clock at the
 * moment the tap saw the message and is never read from an envelope, so the only
 * clock that decides retention is ours.
 *
 * The fallback to `ts` is for rows written before this field existed, and it is
 * deliberate. Counting them as expired instead would make deploying this fix a
 * mass deletion of every preview already in the bucket, and this service's own
 * rule is that coming up must not be a deletion event (`sweepExpired`, and the
 * scheduling comment in `start()`). The residue it leaves is bounded: a pre-fix
 * row with a postdated `ts` still ages out, just later than it should have, and
 * there is at most one bucket's worth of them because every row written from now
 * on carries `recordedAt`. Destroying legitimate operator history to close a
 * bounded backlog would be the worse trade. A pre-fix row whose `ts` is not
 * parseable at all still goes, via `isExpired`.
 *
 * `ts` is kept on the record — it is what the envelope said, and the console
 * displays it — it just no longer decides anything.
 */
function agedAt(entry: { recordedAt?: string; ts?: string }): string | undefined {
  return entry.recordedAt ?? entry.ts;
}

/**
 * Keys allowed to read the mesh-wide views: the operator console and the API
 * gateway, which answer for many agents at once and so cannot be scoped by
 * sender. Operator config, exactly like NODE_ATTESTATIONS — a key here is a
 * grant, and an empty list means nobody gets the mesh-wide view (the console's
 * traffic screen goes blank until its key is listed, which is the safe default
 * for a service that hands out other agents' request content).
 */
const READER_KEYS: ReadonlySet<string> = new Set(
  (process.env.ACTIVITY_READER_KEYS ?? "")
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0),
);

/** Owner lookups are registry round-trips, so they are cached and budgeted. */
const OWNER_TTL_MS = 300_000;
const MAX_OWNER_LOOKUPS_PER_QUERY = 32;

/** What the activity row keeps of the §8.3 A2A bridge marker: enough to say
 *  the call was bridged and by which gateway caller, in this record's own
 *  naming. `callerRef` is the marker's `caller_ref`, the stable opaque handle
 *  the bridge operator resolves via its /admin/callers lookup. */
export interface ActivityBridgeMarker {
  /** The bridge node whose vouch the caller's traffic rode on. */
  node: string;
  /** The caller's stable opaque handle (`caller_ref` on the wire). */
  callerRef: string;
  /** account | operator | anonymous (`caller_kind` on the wire). */
  callerKind: string;
}

/**
 * The §8.3 bridge marker, when the request envelope carries one.
 *
 * The A2A bridge signs an external caller's traffic with a hosted mesh
 * identity and puts `meta.a2a_bridge` on every envelope it sends, so a
 * receiver can tell a bridge vouch from a peer's own signature
 * (a2a-gateway/src/core/card.ts). The tap used to read everything BUT `meta`,
 * so an activity row named the hosted identity and nothing on the row said
 * the call was bridged. Lifted here is the subset the row needs; the rest of
 * the marker (`direction`, the A2A protocol version) is wire detail.
 *
 * `meta` sits inside the envelope signature, so like `ts` this is the
 * SENDER'S claim, recorded as what the envelope said and verified by nobody
 * here. A marker that is not an object, or names no caller, contributes
 * nothing — a row claiming "bridged" with no caller to name would say less
 * than saying nothing.
 */
function bridgeMarkerOf(env: Envelope): ActivityBridgeMarker | undefined {
  const marker = (env.meta as { a2a_bridge?: unknown } | undefined)?.a2a_bridge;
  if (typeof marker !== "object" || marker === null) return undefined;
  const m = marker as { node?: unknown; caller_ref?: unknown; caller_kind?: unknown };
  if (typeof m.caller_ref !== "string" || m.caller_ref.length === 0) return undefined;
  return {
    node: typeof m.node === "string" ? m.node : "",
    callerRef: m.caller_ref,
    callerKind: typeof m.caller_kind === "string" ? m.caller_kind : "",
  };
}

export interface ActivityEntry {
  id: string;
  /** The envelope's own timestamp — the SENDER'S claim, unverified. Displayed,
   *  never used to decide retention; see `agedAt` and `recordedAt`. */
  ts: string;
  /** When THIS SERVICE recorded the row (wall clock at the tap). The value the
   *  age bound is measured from, so no sender can postpone its own expiry.
   *  Optional because rows written before this field existed do not have it —
   *  those fall back to `ts` (`agedAt` says why). */
  recordedAt?: string;
  from: string;         // public key of requester
  to: string;           // agent ID (target)
  offering: string;
  taskId: string;
  /** The request envelope's id — bare responses (§6.4, no task_id) correlate
   *  via their in_reply_to pointing at this. Absent on pre-fix KV entries. */
  requestId?: string;
  inputPreview: string;  // truncated JSON of input
  /** SHA-256 of the FULL input JSON — what the audit log stores instead of
   *  content. Computed at the tap, before the preview truncation. */
  inputSha256?: string;
  /** Present when the request arrived through the A2A bridge: the envelope's
   *  `meta.a2a_bridge` marker (§8.3), lifted so the row says on its face that
   *  the call was bridged and by which gateway caller. Strictly additive —
   *  absent on every unbridged row, so those serialize byte-identically to
   *  rows written before this field existed. */
  a2aBridge?: ActivityBridgeMarker;
  /** Set when the unanswered sweep wrote this exchange to the audit log as
   *  `unanswered`, so a restart cannot write it twice. A response arriving
   *  AFTER this records a second, `completed` exchange on the chains — both
   *  events happened, and an append-only record says so in order. */
  auditedUnansweredAt?: string;
  status: "completed" | "failed";
  durationMs?: number;
  error?: string;
  /** Set when the first response for this exchange was counted (guards
   *  task-mode multi-respond flows against double-counting). */
  respondedAt?: string;
  /** Set when an answer's §13.5 usage receipt was honoured for this exchange.
   *  One receipt per request: a later one is dropped (see meterAnswer). */
  receiptAt?: string;
}

export class ActivityService {
  private subs: BusSubscription[] = [];
  private entries: ActivityEntry[] = [];
  /** Map of task_id → request timestamp for latency calculation */
  private pending = new Map<string, number>();
  /** Durable per-agent message counters; no message content. Postgres when
   *  USAGE_DB_URL is set (shared across instances), otherwise a local SQLite
   *  file — see usage-store.ts for what the fallback gives up. */
  private usage = new UsageStore();
  /** This service's signing identity (§4.5). Stable if ACTIVITY_SEED is set,
   *  else ephemeral per run; a set-but-unusable seed refuses to boot rather
   *  than falling back (shared/seed.ts). Replies used to go out unsigned under
   *  the literal string "mesh.service.activity", which every 0.2 caller's
   *  decode() rejects — and which left nothing to distinguish a real reply
   *  from a third party's. */
  private readonly kp = identityFromEnv("ACTIVITY_SEED");
  /** The account-facing, tamper-evident record (audit-log.ts). This process
   *  writes; the API process reads the same file. No signer here — signing
   *  happens at export, which is the API's side. */
  private readonly audit = new AuditLog(dataDbPath("AUDIT_DB_PATH", "audit.db"));
  /** agent id → owner key (§8.6), cached: the owner may read its agents' rows. */
  private owners = new Map<string, { at: number; owner: string | null }>();
  /** Periodic enforcement of the age bound (ACTIVITY_MAX_AGE_MS). */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Periodic audit of requests nothing ever answered (UNANSWERED_AFTER_MS). */
  private unansweredTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Whether the tap publishes §13.5 meter events (the normal path: the
   * MESH_METERING stream exists and the fold is consuming it, so the counters
   * are downstream of the stream). False is the DEGRADED path — JetStream
   * refused the stream or the consumer at boot — where the tap writes the
   * counters directly, exactly as it did before metering existed: the numbers
   * stay right, the stream and the peer rollup go dark, and boot said so.
   */
  private meteringOn = false;
  private fold: MeteringFold | null = null;
  /** The audit chains' durable backstop (witness-fold.ts): folds the per-agent
   *  mailbox streams into the chains so traffic that flowed while this
   *  service was down still lands on the record. Null when JetStream refused
   *  it at boot or MESH_AUDIT_WITNESS=off. */
  private witness: WitnessFold | null = null;
  /** The keys the operator attests as sandbox nodes (NODE_ATTESTATIONS,
   *  `trust_tier: "sandbox"`, the setting the registry reads too): shared
   *  throwaway credentials, worn by one holder after another. On AgentMesh
   *  these are the credentials its retired guest pool lent, for as long as
   *  they can still connect (docs/no-anonymous-agents-plan.md item 11). Read
   *  once at start, like the registry's. */
  private sandboxKeys: ReadonlySet<string> = new Set();

  private kv: KeyedStore;
  /** The durable, content-free request index (exchange-index.ts) an answer is
   *  correlated through when its request has left the ring. Null when the
   *  store could not be opened at boot: answers to evicted requests then go
   *  unmetered, as they did before the index existed, and boot said so. */
  private index: ExchangeIndex | null;

  constructor(
    private nc: Messaging,
    private js: StorageLike,
    kv: KeyedLike,
    index?: KeyedLike,
  ) {
    this.kv = keyedOf(kv, js);
    this.index = index ? new ExchangeIndex(keyedOf(index, js)) : null;
  }

  static async create(
    nc: MessagingLike,
    js: StorageLike,
  ): Promise<ActivityService> {
    const kv = await storageOf(js).keyed("mesh_activity");
    let index: KeyedStore | undefined;
    try {
      index = await storageOf(js).keyed("mesh_activity_requests");
    } catch (err) {
      console.error(
        "[activity] EXCHANGE INDEX UNAVAILABLE — an answer whose request has left the " +
          "activity ring will record no meter events:",
        err instanceof Error ? err.message : err,
      );
    }
    const service = new ActivityService(messagingOf(nc), js, kv, index);

    // Which keys are shared sandbox credentials: the operator's attestations.
    service.sandboxKeys = sandboxKeysOf(process.env.NODE_ATTESTATIONS);

    // Load the ring from KV.
    //
    // Enumerated with `snapshotKvBucket`, which throws rather than returning a
    // subset (shared/kv.ts explains why the old `kv.keys()` loop could not — it
    // awaited a `get()` per key, and the drop grows with the caller's per-key
    // work). Two things went wrong on a short read: the read path served a
    // fraction of the ring until the next restart, and the count bound below
    // trimmed THAT fraction — so rows the load never saw were never subject to
    // the count bound either and stayed in the bucket indefinitely, which is the
    // unbounded retention of request previews this ring is bounded to prevent.
    try {
      const snapshot = await kv.list();
      for (const entry of snapshot.entries.values()) {
        try {
          service.entries.push(entry.json<ActivityEntry>());
        } catch { /* skip corrupt */ }
      }
      // Newest first, by `agedAt` — recorded-at, not the sender's `ts`. The
      // count bound below trims the tail of THIS sort, so ordering on an
      // unverified sender timestamp let a postdated envelope pin itself to the
      // front of the ring and push genuine rows out of it. Same defect as the
      // age bound's, same fix.
      service.entries.sort((a, b) => (agedAt(b) ?? "").localeCompare(agedAt(a) ?? ""));
      // Rows written before the exchange index existed have no record there.
      // Seed one (never overwriting) BEFORE the trim below, so a request the
      // trim pushes out of the ring can still have its answer metered.
      for (const e of service.entries) {
        const rec = recordOf(e);
        if (rec) service.index?.seed(rec);
      }
      // Trim to max (the count bound; the age bound is swept, not applied here —
      // see `sweepExpired` on why load deliberately deletes nothing by age).
      if (service.entries.length > MAX_ENTRIES) {
        const removed = service.entries.splice(MAX_ENTRIES);
        for (const e of removed) {
          service.forget(e.id).catch(() => {});
        }
      }
      console.log(`[activity] loaded ${service.entries.length} entries from KV`);
    } catch (err) {
      // NOT "no existing entries in KV", which is what this used to say: an empty
      // bucket snapshots successfully with zero entries and never reaches here, so
      // reaching here means the read failed and the ring is not known to be empty.
      console.error(
        "[activity] KV load FAILED — the timeline will show only traffic recorded " +
          "after this restart, and rows already in the bucket are not counted " +
          "against the ring bound:",
        err instanceof Error ? err.message : err,
      );
    }

    return service;
  }

  async start(): Promise<void> {
    // The metering substrate FIRST, before the taps publish into it: the
    // stream captures only while it exists, and the fold is what turns events
    // back into counters. Either failing leaves the tap on the legacy direct
    // path — degraded (no stream, no peer rollup), never wrong numbers.
    try {
      const metering = storageOf(this.js, this.nc).stream("MESH_METERING");
      if (await metering.ensure()) {
        this.fold = await MeteringFold.start(metering, this.usage, idOf(this.kp));
        this.meteringOn = this.fold !== null;
      }
    } catch (err) {
      console.error("[activity] metering setup failed:", err instanceof Error ? err.message : err);
    }
    if (!this.meteringOn) {
      console.error(
        "[activity] METERING IS OFF — the tap is writing counters directly. " +
          "agent_stats stays correct, but no meter events are recorded and the " +
          "per-counterparty rollup (mesh.usage.peers) will not advance.",
      );
    }

    // The two taps below are the only subscriptions in `services/src` that could
    // not be made safe for a second instance by a subscription option, so the
    // decision is spelled out here as well as in shared/queue-groups.ts.
    //
    // NO queue group on either. Correlation is per-instance and in-memory:
    // `recordRequest` puts a row in `this.entries` and a start time in
    // `this.pending`, and `recordResponse` has to find that row again to stamp
    // the duration, the completed/failed status, the outbound message count and
    // the one history event for the exchange. Load balancing the taps sends the
    // request to one instance and the response to another, and the second finds
    // no row and returns early — so with two instances roughly half of all
    // exchanges would keep their optimistic "completed", get no duration, count
    // no response and record no history. That is per-exchange data loss nothing
    // can reconstruct later.
    //
    // Broadcast is therefore the only mode in which the tap works at all — and
    // it is still NOT enough to run two activity instances. Every instance would
    // keep its own ring (so `mesh.activity.list` answers from a different half of
    // the timeline depending which instance wins the query), mint its own
    // `uuid7()` key for the same exchange (so the KV ring holds N copies and its
    // 500-row bound holds 500/N real exchanges), count the same message into the
    // usage counters, and write the same history row. Nothing about a queue group
    // fixes any of that; splitting the tap's durable writes out behind a single
    // elected writer or a JetStream durable consumer does, and that is a larger
    // change than this one. Until then the activity service is single-instance,
    // and the four query subjects below are grouped so that the read path is
    // ready when it is not.
    // The inbox tap: requests arriving at agents AND, post-§6.4-cutover,
    // responds arriving at requesters (the inbox is the reply channel now).
    const inboxSub = this.nc.subscribe("mesh.agent.*.inbox");
    this.tapMessages(inboxSub);
    this.subs.push(inboxSub);

    // Tap all agent outbox traffic (responses - SDK publishes a copy here).
    // Post-cutover this is usually the SECOND sighting of a respond the inbox
    // tap already saw; recordResponse dedupes by envelope id rather than this
    // tap being dropped, because the two sightings do not fully overlap (the
    // guarded-delivery and probe answers ride the reply subject and appear
    // only here, and either subscription can miss a message the other caught).
    const outboxSub = this.nc.subscribe("mesh.agent.*.outbox");
    this.tapMessages(outboxSub);
    this.subs.push(outboxSub);

    // The audit chains' durable backstop. The taps above see nothing while
    // this process is down; the per-agent mailbox streams (MESH_INBOX_*,
    // registry/inbox-buffer.ts) capture inbox traffic regardless, and the
    // witness fold folds those captures into the chains - the tap's richer
    // rows first (its hold window defers to them), "witnessed" pairs for what
    // the tap never saw. MESH_AUDIT_WITNESS=off switches it off (the
    // advisory-check discipline: a documented variable, not a fork).
    if ((process.env.MESH_AUDIT_WITNESS ?? "on").toLowerCase() !== "off") {
      this.witness = new WitnessFold(this.nc, this.js, this.audit);
      await this.witness.start();
    } else {
      console.error(
        "[activity] AUDIT WITNESS IS OFF (MESH_AUDIT_WITNESS=off) - traffic that " +
          "flows while this service is down will never reach the audit chains.",
      );
    }

    // The four query subjects DO join queue groups: each is request/reply with
    // one logical answer, and two instances answering would charge the rate
    // limiter twice and (for the usage reads) flush the counter batch twice.

    // Query handler: mesh.activity.list
    this.subs.push(
      subscribeWithHandler(this.nc, "mesh.activity.list", this.kp, (env) =>
        this.handleList(env),
      undefined, undefined, serviceQueue("mesh.activity.list")),
    );

    // Query handler: mesh.usage.list — per-agent totals from the stats table
    this.subs.push(
      subscribeWithHandler(this.nc, "mesh.usage.list", this.kp, (env) =>
        this.handleUsageList(env),
      undefined, undefined, serviceQueue("mesh.usage.list")),
    );

    // mesh.usage.summary — mesh-wide aggregate (operator console)
    this.subs.push(
      subscribeWithHandler(this.nc, "mesh.usage.summary", this.kp, (env) =>
        this.handleUsageSummary(env),
      undefined, undefined, serviceQueue("mesh.usage.summary")),
    );

    // mesh.usage.today — today's counters for specific agent ids (account view)
    this.subs.push(
      subscribeWithHandler(this.nc, "mesh.usage.today", this.kp, (env) =>
        this.handleUsageToday(env),
      undefined, undefined, serviceQueue("mesh.usage.today")),
    );

    // mesh.usage.peers — both directions for one agent (EXT-2 §7): who it
    // served, whose agents it consumed. Per-entity, so scoped like
    // mesh.usage.today rather than refused like the aggregates.
    this.subs.push(
      subscribeWithHandler(this.nc, "mesh.usage.peers", this.kp, (env) =>
        this.handleUsagePeers(env),
      undefined, undefined, serviceQueue("mesh.usage.peers")),
    );

    // mesh.activity.forget — a key erases its own rows (see handleForget).
    this.subs.push(
      subscribeWithHandler(this.nc, "mesh.activity.forget", this.kp, (env) =>
        this.handleForget(env),
      undefined, undefined, serviceQueue("mesh.activity.forget")),
    );

    this.usage.start();

    // The unanswered sweep. Checks at a fifth of the threshold so a row is
    // audited within ~20% of its deadline, floored at 30s.
    if (UNANSWERED_AFTER_MS > 0) {
      this.unansweredTimer = setInterval(
        () => this.sweepUnanswered(),
        Math.max(30_000, UNANSWERED_AFTER_MS / 5),
      );
      if (typeof this.unansweredTimer.unref === "function") this.unansweredTimer.unref();
    }

    // The age bound is SCHEDULED, not run now. A service coming up must not be a
    // deletion event: the first pass is one interval away, which is the window an
    // operator has to set ACTIVITY_MAX_AGE_MS=0 and restart if the bucket's
    // existing contents need reviewing before anything is removed.
    if (MAX_AGE_MS > 0) {
      this.sweepTimer = setInterval(() => {
        this.sweepExpired().catch((err) =>
          console.error("[activity] retention sweep failed:", err instanceof Error ? err.message : err),
        );
      }, SWEEP_INTERVAL_MS);
      // Don't hold the process open just to expire rows.
      if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
    }

    console.log(
      `[activity] service started (${idOf(this.kp).slice(0, 12)}…) · inbox + outbox tap + list/usage handlers · ` +
        `${READER_KEYS.size} mesh-wide reader key(s) · retention ${MAX_ENTRIES} entries / ` +
        `${MAX_AGE_MS > 0 ? `${Math.round(MAX_AGE_MS / 86_400_000)}d (swept every ${Math.round(SWEEP_INTERVAL_MS / 60_000)}m)` : "NO AGE LIMIT (ACTIVITY_MAX_AGE_MS=0)"}`,
    );
  }

  private tapMessages(sub: BusSubscription): void {
    (async () => {
      for await (const msg of sub) {
        try {
          const env = decode(msg.data);
          const bytes = msg.data.length;
          if (env.type === "request") {
            this.recordRequestOrAnswer(env, bytes);
          } else if (env.type === "respond") {
            this.recordResponse(env, bytes);
          }
        } catch { /* non-fatal — skip unparseable */ }
      }
    })();
  }

  async stop(): Promise<void> {
    for (const sub of this.subs) {
      sub.unsubscribe();
    }
    this.fold?.stop();
    this.fold = null;
    // Before the audit log closes below: a witness loop appending to a closed
    // database would only add a shutdown error to every stop.
    this.witness?.stop();
    this.witness = null;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.unansweredTimer) {
      clearInterval(this.unansweredTimer);
      this.unansweredTimer = null;
    }
    // Exchange-index writes queued on the tap's hot path (a request's record,
    // a first answer's respondedAt) land before shutdown, or a restart would
    // meter a follow-up as a first answer or miss an evicted exchange.
    try {
      await this.index?.drain();
    } catch { /* each write already logged its own failure */ }
    await this.usage.close(); // flushes pending counters
    this.audit.close();
    console.log("[activity] service stopped");
  }

  // ── Recording ─────────────────────────────────────────────────

  private recordRequest(env: Envelope, bytes = 0): void {
    const payload = env.payload as { offering?: string; skill?: string; input?: unknown } | undefined;
    // §8.5 deprecation window: pre-rename senders say `skill`.
    const offering = payload?.offering ?? payload?.skill ?? "unknown";

    // Registry liveness probes are plumbing, not traffic — don't record them
    // as activity or count them toward usage stats.
    if (offering === "__registry_probe__") return;
    const taskId = env.task_id ?? uuid7();
    const inputJson = payload?.input !== undefined ? JSON.stringify(payload.input) : undefined;
    const inputStr = inputJson !== undefined ? inputJson.slice(0, 200) : "";

    // Track pending for latency — keyed by request id (bare responses
    // correlate via in_reply_to) and by task id when the requester set one.
    this.pending.set(env.id, Date.now());
    if (env.task_id) this.pending.set(env.task_id, Date.now());

    // The Monitor's hourly pair row (monitor-types.ts): one message, counted,
    // never kept. Its outcome and delivery time land when the answer does.
    if (env.from && env.to) this.usage.recordPair(env.from, env.to, { msgs: 1 });

    // Usage accounting: a request arrived at this agent, and the mesh
    // delivered it on the sender's behalf — the fair-use quantity
    // (plans.html). Normal path: one meter-event batch (§13.5), which the
    // fold turns back into these exact counter writes plus the peer rollup.
    // Degraded path (metering off) or a party missing from the envelope:
    // the legacy direct writes, which need only one side.
    if (this.meteringOn && env.to && env.from) {
      publishMeterEvents(
        this.nc,
        this.kp,
        observedRequest(env.to, env.from, env.id, bytes, offering, env.task_id),
      );
    } else {
      if (env.to) this.usage.recordIn(env.to, bytes);
      if (env.from) this.usage.recordDelivered(env.from, bytes);
    }

    const bridged = bridgeMarkerOf(env);
    const entry: ActivityEntry = {
      id: uuid7(),
      ts: env.ts ?? new Date().toISOString(),
      // Stamped here, from our clock, never from the envelope — this is what the
      // age bound reads (`agedAt`).
      recordedAt: new Date().toISOString(),
      from: env.from,
      to: env.to ?? "",
      offering,
      taskId,
      requestId: env.id,
      inputPreview: inputStr,
      inputSha256: inputJson !== undefined ? sha256hex(inputJson) : undefined,
      ...(bridged ? { a2aBridge: bridged } : {}),
      status: "completed", // optimistic — updated if we see a failure response
    };

    // The durable twin of the ring row, without the content: what an answer
    // needs to be metered after the row has been evicted (exchange-index.ts).
    this.index?.remember({
      v: 1,
      requestId: env.id,
      from: entry.from,
      to: entry.to,
      offering,
      ...(env.task_id ? { taskId: env.task_id } : {}),
      recordedAt: entry.recordedAt!,
    });

    this.addEntry(entry);
  }

  /** Respond envelope ids already recorded, bounded, first-seen-evicted -
   *  §22.2's shape, the metering fold's size discipline. Post-§6.4-cutover the
   *  SAME respond envelope arrives twice (requester's inbox + responder's
   *  outbox mirror), and without this the second sighting re-ran everything
   *  after the once-per-exchange gate: `recordOutBytes` charged the bytes
   *  twice on the degraded direct-write path, and the §13.5 receipt was
   *  re-published (idempotent only while the fold's dedupe ledger remembers). */
  private seenResponds = new Set<string>();
  private static readonly MAX_SEEN_RESPONDS = 10_000;

  private rememberRespond(id: string): boolean {
    if (this.seenResponds.has(id)) return false;
    this.seenResponds.add(id);
    if (this.seenResponds.size > ActivityService.MAX_SEEN_RESPONDS) {
      const oldest = this.seenResponds.values().next().value as string;
      this.seenResponds.delete(oldest);
    }
    return true;
  }

  /**
   * A `request` envelope: a new request, or an inbox-mode answer to an
   * earlier one (§13.5 "a new `request` carrying `in_reply_to`").
   *
   * An agent that answers later — a human-paced or mailbox-driven one, whose
   * node acknowledged the asking envelope with a queued ack (§6.4a) — sends
   * its answer as a fresh request whose `in_reply_to` names the original
   * request. That answer is the exchange's response and is metered as one:
   * `responses`/`bytes_out` (the first answer only, as for a respond), its
   * `payload.usage` receipt as declared usage, `request_id` the original
   * request, and the ORIGINAL requester as the consumer. Metering it as the
   * request it looks like would bill it the other way round — the requester
   * as the provider of a request the answering agent consumed.
   *
   * It is an answer only when the exchange it names is known (the ring, else
   * the durable exchange index) and the envelope is the asked agent speaking
   * to the original requester: `from` is the request's `to`, `to` is its
   * `from`, and it is meant for the agent, not a person (§5.7 rule 1, which
   * the SDK's own correlation applies). Anything else that happens to carry
   * `in_reply_to` — a third party's request, the asked agent writing to
   * somebody else, an unknown id — is an ordinary request.
   */
  private recordRequestOrAnswer(env: Envelope, bytes = 0): void {
    const replyTo = typeof env.in_reply_to === "string" && env.in_reply_to !== "" ? env.in_reply_to : undefined;
    if (replyTo === undefined || !forTheAgent(env)) {
      this.recordRequest(env, bytes);
      return;
    }
    const entry = this.entries.find((e) => e.requestId === replyTo);
    if (entry) {
      if (answersAsRequest(env, entry)) this.recordResponse(env, bytes, entry);
      else this.recordRequest(env, bytes);
      return;
    }
    if (!this.index) {
      this.recordRequest(env, bytes);
      return;
    }
    this.recordAnswerFromIndex(env, bytes, replyTo);
  }

  /**
   * The index half of recordRequestOrAnswer: the request named by
   * `in_reply_to` has left the ring. An answer when the stored exchange is
   * the asked agent's own; otherwise — unknown id, expired record, or a
   * sender or addressee who is not the exchange's other party — the envelope
   * is recorded as the ordinary request it is.
   */
  private recordAnswerFromIndex(env: Envelope, bytes: number, replyTo: string): void {
    const index = this.index!;
    let ordinary = false;
    index
      .update(replyTo, (rec) => {
        if (!rec || !answersAsRequest(env, rec)) {
          ordinary = true;
          return null;
        }
        return this.meterFromRecord(env, bytes, rec);
      })
      .then(
        () => { if (ordinary) this.recordRequest(env, bytes); },
        (err) => {
          // The index could not say. Recording it as a request keeps the
          // traffic counted, as the tap did before inbox answers were known.
          console.error("[activity] looking up an inbox answer's exchange failed:", err instanceof Error ? err.message : err);
          this.recordRequest(env, bytes);
        },
      );
  }

  /**
   * An answer: a `respond`, or an inbox-mode answer `request` whose exchange
   * `found` the caller already matched (recordRequestOrAnswer).
   */
  private recordResponse(env: Envelope, bytes = 0, found?: ActivityEntry): void {
    // §6.4a: an accept is a signal that the handler is ABOUT to run, never the
    // exchange's response - and post-cutover it precedes nearly every answer
    // on the same tapped subjects. Counting it would stamp the duration at
    // accept time (every exchange "completes" in one admission round-trip),
    // append the audit row before the work ran, and leave a real failure
    // arriving later recorded as completed. The SDK requester filters accepts
    // out of its own wait for the same reason; so does this tap.
    if (!found && !env.error && (env.payload as { status?: string } | undefined)?.status === "accepted") {
      return;
    }

    // Correlate by the request envelope id first (in_reply_to) — bare
    // responses (§6.4) carry no task_id by design — then by task id.
    const entry = found ?? this.entries.find(
      (e) =>
        (env.in_reply_to !== undefined && e.requestId === env.in_reply_to) ||
        (env.task_id !== undefined && e.taskId === env.task_id),
    );
    if (!entry) {
      // Not in the ring — evicted by the count bound (500 exchanges MESH-WIDE),
      // the age bound, or a restart's trim. The answer is still traffic and
      // still billable, so it is metered from the durable index instead.
      this.recordFromIndex(env, bytes);
      return;
    }

    // Only the responder of record answers its own exchange. A respond signed
    // by ANYONE ELSE - the admission service's benign ack, a node's queued
    // ack - is an intermediary's delivery-status statement, and post-cutover
    // those land on the requester's inbox where this tap now sees them.
    // Counting one would charge a response to an agent that never spoke and
    // close the exchange as completed on a third party's say-so; skipping
    // leaves the exchange for its real answer, or for the unanswered sweep,
    // which is the honest record of a message that only ever reached a
    // mailbox. (Pre-cutover parity, too: intermediary acks rode the reply
    // subject, which no tap observed.)
    if (entry.to !== "" && env.from !== entry.to) return;

    // One count per envelope, however many subjects delivered it (see the
    // field comment on seenResponds). Judged after the guards above so the
    // ledger holds only envelopes that were actually recorded.
    if (!this.rememberRespond(env.id)) return;

    const startTime =
      (entry.requestId !== undefined ? this.pending.get(entry.requestId) : undefined) ??
      this.pending.get(entry.taskId);
    if (entry.requestId) this.pending.delete(entry.requestId);
    this.pending.delete(entry.taskId);

    if (startTime) {
      entry.durationMs = Date.now() - startTime;
    }

    if (env.error) {
      entry.status = "failed";
      entry.error = env.error.message ?? "Unknown error";
    }

    // The meter events, from the ring row (see meterAnswer).
    const first = !entry.respondedAt;
    const hadReceipt = !!entry.receiptAt;
    const receiptEntries = this.meterAnswer(env, bytes, {
      from: entry.from,
      to: entry.to,
      offering: entry.offering,
      // The entry's own id first: a task-mode respond correlated by task_id
      // carries no in_reply_to. Pre-fix KV entries have no requestId;
      // in_reply_to covers them.
      requestId: entry.requestId ?? env.in_reply_to ?? undefined,
      first,
      failed: entry.status === "failed",
      receiptTaken: hadReceipt,
    });
    const tookReceipt = !hadReceipt && receiptEntries !== undefined;
    if (tookReceipt) entry.receiptAt = new Date().toISOString();
    if (entry.to && first) {
      // The Monitor: how the exchange came out and how long delivery took,
      // on the first answer only. The first answer from a mailbox agent is
      // its receipt that the message was filed, so the time is send to inbox.
      // An exchange the unanswered sweep already counted as failed is not
      // counted twice.
      if (entry.from && !entry.auditedUnansweredAt) {
        const o = tapOutcome(env.error?.code);
        this.usage.recordPair(entry.from, entry.to, { [o.outcome]: 1, latMs: entry.durationMs });
        if (o.outcome !== "delivered") {
          this.usage.recordEvent({
            at: Date.now(), sender_id: entry.from, receiver_id: entry.to, outcome: o.outcome,
            reason: o.reason, ms: entry.durationMs ?? null, account_id: null, message_id: null,
          });
        }
      }
      entry.respondedAt = new Date().toISOString();
      // The index learns the exchange has been answered, so a follow-up that
      // arrives after this row leaves the ring counts bytes only, as here.
      const rec = recordOf(entry);
      if (rec) this.index?.remember(rec);
      // Durable history: one event per completed exchange. Metadata only —
      // parties, offering, outcome, duration; never content.
      metrics.event({
        kind: "request",
        actor: entry.from,
        target: entry.to,
        offering: entry.offering,
        status: entry.status,
        duration_ms: entry.durationMs ?? null,
      });
      // And the account-facing audit chains, both parties. Best-effort like
      // the recorder: the tap must never die of its own bookkeeping.
      try {
        this.audit.appendExchange({
          from: entry.from,
          to: entry.to,
          // The audit row's field is still `skill`: every existing row's
          // entry_hash covers that name, and the signed-export format (with
          // its offline verifier) is frozen with it. The VOCABULARY renamed
          // (§8.5); the tamper-evident record's bytes did not.
          skill: entry.offering,
          taskId: entry.taskId,
          requestId: entry.requestId,
          status: entry.status,
          durationMs: entry.durationMs,
          inputSha256: entry.inputSha256,
          // §13.5 tie-in: the declared usage receipt, when this first respond
          // was also the terminal one (bare mode — the adapter's whole path).
          // A task-mode receipt arriving on a later respond reaches the meter
          // stream but not this row; the chain records what it saw when it
          // wrote, and rows are never rewritten.
          usage: receiptEntries,
        });
      } catch (err) {
        console.error("[activity] audit append failed:", err);
      }
    }

    // A receipt honoured on a later answer: the index learns it too, so an
    // answer arriving after this row leaves the ring cannot declare again.
    // (On the first answer the write above already carried it.)
    if (tookReceipt && !(entry.to && first)) {
      const rec = recordOf(entry);
      if (rec) this.index?.remember(rec);
    }

    // Persist update
    const data = new TextEncoder().encode(JSON.stringify(entry));
    this.kv.put(entry.id, data).catch(() => {});
  }

  /**
   * The §13.5 meter events an answer produces — the one place they are built,
   * whether the exchange was found in the ring or in the exchange index.
   * Returns the declared usage receipt's entries, for the audit row.
   *
   * Usage accounting: a response left this agent (`x.to` is the agent). The
   * exchange counts once — task-mode agents respond multiple times, so only
   * the `first` answer is a `responses` event — but bytes count on every
   * answer, because every answer is traffic. Same normal/degraded split as
   * recordRequest; the fold reconstructs the once-per-exchange rule from which
   * events the batch carries.
   *
   * §13.5 request_id: every event derived from an answer names the request it
   * answers, so a reader joins the request's batch (keyed by its own
   * envelope_id) to this one without the correlation held here.
   */
  private meterAnswer(
    env: Envelope,
    bytes: number,
    x: {
      from: string;
      to: string;
      offering: string;
      requestId?: string;
      first: boolean;
      failed: boolean;
      /** The exchange already had a receipt honoured: this one is dropped. */
      receiptTaken: boolean;
    },
  ): Array<{ meter: string; quantity: number }> | undefined {
    const metered = this.meteringOn && x.to !== "" && x.from !== "";

    // §13.5 usage receipt, lifted into DECLARED meter events. Two shapes
    // carry one: a terminal respond (the responder did the work) and an
    // inbox-mode answer, a fresh request carrying `in_reply_to` (its SENDER,
    // the asked agent, did the work). Either way the receipt is read against
    // the exchange `x`: the asked agent provided, the original requester
    // consumed. The inbox answer was metered as nothing but a reversed
    // request until the tap learned to match it to its exchange
    // (recordRequestOrAnswer), so every inbox agent's receipts were lost.
    //
    // The receipt rode the reporter's own envelope signature; these events
    // carry the claim into the stream, where rating (§19.6) decides what it is
    // worth. Validated whether or not metering is on, because the audit chains
    // record the claim either way.
    //
    // ONE receipt per request: the first answer carrying a valid one — a
    // respond or an inbox answer, first answer or not — is honoured, and any
    // later receipt on the same request is dropped. Each answer is its own
    // envelope, so the (meter, envelope_id) dedupe would let a provider
    // declare usage again with every extra answer it sends. "First receipt"
    // rather than "first answer" because a task-mode agent's receipt rides
    // its terminal respond, which follows a `working` update. Bytes still
    // meter on every answer, below. Returns undefined for a dropped receipt.
    let receiptEntries: Array<{ meter: string; quantity: number }> | undefined;
    // A respond is passed WITHOUT its in_reply_to: on a respond that field
    // names the request, not an inbox answer, and `usageReceiptParties` would
    // read a non-terminal one (a task-mode "working" update) in the
    // reply-request direction, the requester as provider. Only its terminal
    // shape carries a receipt.
    const parties =
      env.type === "request"
        ? replyReceiptParties(env, x)
        : usageReceiptParties({ payload: env.payload }, x);
    if (parties) {
      const { batch, dropped } = declaredUsage(
        parties.provider, parties.consumer, env.id, parties.raw, x.offering, env.task_id, x.requestId,
      );
      if (dropped > 0) {
        console.warn(`[activity] dropped ${dropped} malformed usage entr(y/ies) from ${parties.provider.slice(0, 12)}…`);
      }
      if (batch.events.length > 0 && x.receiptTaken) {
        console.warn(
          `[activity] dropped a second usage receipt for request ${x.requestId ?? "(unknown)"} from ${parties.provider.slice(0, 12)}… (one receipt per request)`,
        );
      } else if (batch.events.length > 0) {
        receiptEntries = batch.events.map((e) => ({ meter: e.meter, quantity: e.quantity }));
        if (this.meteringOn) publishMeterEvents(this.nc, this.kp, batch);
      }
    }
    if (x.to && !x.first) {
      if (metered) {
        publishMeterEvents(this.nc, this.kp, observedResponseBytes(x.to, x.from, env.id, bytes, x.requestId));
      } else {
        this.usage.recordOutBytes(x.to, bytes);
      }
    }
    if (x.to && x.first) {
      if (metered) {
        publishMeterEvents(
          this.nc,
          this.kp,
          observedResponse(x.to, x.from, env.id, bytes, x.failed, x.offering, env.task_id, x.requestId),
        );
        // §13.5 refusal events: an admission refusal is declined demand, and
        // both parties reasonably want it recorded. Derives from the REFUSING
        // respond's id (metering.ts says why not the request's).
        const code = env.error?.code;
        if (code !== undefined && ADMISSION_REFUSAL_CODES.has(code)) {
          publishMeterEvents(
            this.nc,
            this.kp,
            observedRefusal(x.to, x.from, env.id, code, x.offering, x.requestId),
          );
        }
      } else {
        this.usage.recordOut(x.to, x.failed, bytes);
      }
    }
    return receiptEntries;
  }

  /**
   * Meter an answer whose request is no longer in the ring, from the exchange
   * index (exchange-index.ts) — the same events, under the same
   * (meter, envelope_id) keys, as if the row had still been there.
   *
   * The guards are the ring path's, applied to the stored request: only the
   * responder of record answers its own exchange, and one envelope counts
   * once however many subjects delivered it. "First answer" is the record's
   * `respondedAt`, which the ring path writes too, so an exchange answered
   * while its row was in the ring and followed up after it left counts its
   * `responses` once.
   *
   * What it does NOT do is everything the ring row exists for beyond billing:
   * no duration (the start time was the row's), no Monitor pair, no history
   * event, no audit row. Those describe the exchange for the activity views
   * and the account's audit chains, which have their own backstop for what
   * the tap missed (the witness fold); the meter stream is what bills.
   */
  private recordFromIndex(env: Envelope, bytes: number): void {
    const index = this.index;
    if (!index) return;
    // Whether the record a lookup reached exists at all, so an in_reply_to
    // naming nothing the index knows can fall back to the task id.
    const viaRequest = async (requestId: string, strict: boolean): Promise<boolean> => {
      let known = false;
      await index.update(requestId, (rec) => {
        if (!rec) return null;
        known = true;
        // Only the responder of record answers its own exchange. A match made
        // by the task-id fallback must name that responder outright: a
        // record with no `to` cannot be claimed through an alias.
        if (strict ? rec.to === "" || env.from !== rec.to : rec.to !== "" && env.from !== rec.to) return null;
        return this.meterFromRecord(env, bytes, rec);
      });
      return known;
    };
    (async () => {
      // Correlate as the ring does (recordResponse): by the request envelope
      // id first (in_reply_to — bare mode, and task-mode answers that carry
      // it), then by task id, through the requester-scoped task alias; the
      // requester is the respond's `to`.
      const replyTo = typeof env.in_reply_to === "string" && env.in_reply_to !== "" ? env.in_reply_to : undefined;
      if (replyTo !== undefined && (await viaRequest(replyTo, false))) return;
      if (env.task_id !== undefined && env.to) {
        const requestId = await index.requestForTask(env.to, env.task_id);
        if (requestId !== undefined && requestId !== replyTo) await viaRequest(requestId, true);
      }
    })().catch((err) =>
      console.error("[activity] metering an evicted exchange failed:", err instanceof Error ? err.message : err),
    );
  }

  /**
   * Meter an answer against a stored exchange the caller has already matched
   * to the answering agent. Returns the record to write back (the first
   * answer stamps `respondedAt`), or null for no write.
   */
  private meterFromRecord(env: Envelope, bytes: number, rec: ExchangeRecord): ExchangeRecord | null {
    if (!this.rememberRespond(env.id)) return null;
    const first = !rec.respondedAt;
    // A record written before receiptAt existed reads as no receipt yet.
    const hadReceipt = typeof rec.receiptAt === "string";
    const receipt = this.meterAnswer(env, bytes, {
      from: rec.from,
      to: rec.to,
      offering: rec.offering,
      requestId: rec.requestId,
      first,
      failed: !!env.error,
      receiptTaken: hadReceipt,
    });
    const now = new Date().toISOString();
    const tookReceipt = !hadReceipt && receipt !== undefined;
    if (!first && !tookReceipt) return null;
    return {
      ...rec,
      ...(first ? { respondedAt: now } : {}),
      ...(tookReceipt ? { receiptAt: now } : {}),
    };
  }

  /**
   * Write the `unanswered` audit rows for requests past the threshold. The
   * activity entry keeps its optimistic "completed" (that field is the RING's
   * display; the audit chain is the record), gains the marker so this runs
   * once per exchange across restarts, and stays correlatable — a response
   * arriving later still lands, and then the chain shows both events.
   */
  private sweepUnanswered(): void {
    const cutoff = Date.now() - UNANSWERED_AFTER_MS;
    for (const entry of this.entries) {
      if (entry.respondedAt || entry.auditedUnansweredAt) continue;
      const t = Date.parse(agedAt(entry) ?? "");
      if (!Number.isFinite(t) || t > cutoff) continue;
      try {
        this.audit.appendExchange({
          from: entry.from,
          to: entry.to,
          // The audit row's field is still `skill`: every existing row's
          // entry_hash covers that name, and the signed-export format (with
          // its offline verifier) is frozen with it. The VOCABULARY renamed
          // (§8.5); the tamper-evident record's bytes did not.
          skill: entry.offering,
          taskId: entry.taskId,
          requestId: entry.requestId,
          status: "unanswered",
          inputSha256: entry.inputSha256,
        });
        entry.auditedUnansweredAt = new Date().toISOString();
        // The Monitor counts it failed, once; a late answer is not counted
        // again (recordResponse).
        if (entry.from && entry.to) {
          this.usage.recordPair(entry.from, entry.to, { failed: 1 });
          this.usage.recordEvent({
            at: Date.now(), sender_id: entry.from, receiver_id: entry.to, outcome: "failed",
            reason: unansweredReason(UNANSWERED_AFTER_MS), ms: null, account_id: null, message_id: null,
          });
        }
        const data = new TextEncoder().encode(JSON.stringify(entry));
        this.kv.put(entry.id, data).catch(() => {});
      } catch (err) {
        console.error("[activity] unanswered audit append failed:", err);
      }
    }
  }

  private addEntry(entry: ActivityEntry): void {
    this.entries.unshift(entry); // newest first

    // Persist
    const data = new TextEncoder().encode(JSON.stringify(entry));
    this.kv.put(entry.id, data).catch(() => {});

    // Count bound. The age bound runs on its own sweep; whichever binds first
    // wins, and on a busy mesh that is still this one.
    if (this.entries.length > MAX_ENTRIES) {
      const removed = this.entries.splice(MAX_ENTRIES);
      for (const e of removed) {
        this.forgetPending(e);
        this.forget(e.id).catch(() => {});
      }
    }
  }

  // ── Retention ─────────────────────────────────────────────────
  //
  // Two bounds (see MAX_ENTRIES / MAX_AGE_MS at the top of this file), and what
  // they guard is content: `inputPreview` is the first 200 characters of a real
  // request. So "removed" here has to mean removed from the store, not dropped
  // from the answer — a row the read path skips but the bucket still holds is the
  // exact shape of the problem this closes.
  //
  // A third removal reason joins them below and is not a bound at all:
  // `handleForget` erases every row naming ONE key, because a key that changes
  // hands (the recycled guest pool) makes its next holder a party to every row
  // naming it. Same purge, same reason.

  /**
   * Remove one entry's KV key for good — PURGE, not delete.
   *
   * `kv.delete` is a SOFT delete: it appends a `DEL` marker and leaves earlier
   * revisions of the key on the backing stream, where `kv.history()` still reads
   * them for anyone with $KV access. `mesh_activity` is created with
   * `history: 1`, so the marker happens to evict the value along with it — but
   * that is a coincidence of bucket config, not a property of `delete`, and
   * `js.views.kv` only applies its options when it CREATES the stream, so a
   * bucket that was ever made or altered with a larger history would keep the
   * preview indefinitely behind a key that reads as deleted. `kv.purge` writes a
   * rollup marker that drops every prior message on the subject whatever the
   * history is, which is what "gone" has to mean for somebody's request text.
   *
   * Purge needs `allow_rollup_hdrs` on the stream. If an older bucket lacks it
   * the purge fails, and then a soft delete is still better than leaving the row
   * in place — so fall back, loudly, because that path is the weaker guarantee.
   */
  private async forget(key: string): Promise<boolean> {
    try {
      await this.kv.purge(key);
      return true;
    } catch (err) {
      try {
        await this.kv.delete(key);
        console.error(
          `[activity] purge of ${key} failed (${err instanceof Error ? err.message : err}); ` +
            `fell back to a soft delete, which leaves earlier revisions on the stream if the ` +
            `bucket's history is above 1. Check allow_rollup_hdrs on KV_mesh_activity.`,
        );
        return true;
      } catch {
        return false;
      }
    }
  }

  /** Drop the latency bookkeeping for an entry leaving the ring. Once the entry
   *  is gone `recordResponse` can never match it, so its `pending` keys are
   *  unreachable and would otherwise sit in the map for the life of the process. */
  private forgetPending(entry: ActivityEntry): void {
    if (entry.requestId) this.pending.delete(entry.requestId);
    this.pending.delete(entry.taskId);
  }

  /**
   * Enforce the age bound: drop every entry older than ACTIVITY_MAX_AGE_MS from
   * memory AND from the KV bucket. Returns what it removed.
   *
   * RETROACTIVE by design. An entry is judged by `agedAt` — the recorded-at
   * stamp this service wrote, or `ts` for rows that predate that field — so rows
   * already in the bucket when this bound shipped are subject to it too, and the
   * first sweep after a deploy will remove any that are already past it. There is
   * no honest alternative — a bound that only applied to rows written from now on
   * would leave precisely the old previews it exists to remove sitting there
   * forever. An operator who wants to look before anything goes deploys with
   * ACTIVITY_MAX_AGE_MS=0 and turns it on afterwards.
   *
   * The KV side is a bucket SCAN rather than a walk of `this.entries`, because a
   * key whose in-memory row is already gone — a `kv.put` that landed after the
   * prune, a `kv.delete` that rejected, a restart between the two — is exactly
   * the case where content outlives the read path, and nothing else would ever
   * come back for it.
   *
   * Nothing here reads a sender-supplied time. `agedAt` explains why, and why the
   * pre-`recordedAt` rows still fall back to `ts`.
   */
  async sweepExpired(now = Date.now()): Promise<{ dropped: number; purged: number }> {
    if (MAX_AGE_MS <= 0) return { dropped: 0, purged: 0 };
    const cutoff = now - MAX_AGE_MS;

    // Memory first, so the read path stops serving expired rows immediately even
    // if the bucket scan below fails halfway.
    const keep: ActivityEntry[] = [];
    let dropped = 0;
    for (const entry of this.entries) {
      if (isExpired(agedAt(entry), cutoff)) {
        this.forgetPending(entry);
        dropped++;
      } else {
        keep.push(entry);
      }
    }
    this.entries = keep;

    // The bucket scan. `listKvKeys` throws rather than returning a subset, and
    // that matters more here than anywhere else in this file: this loop is the
    // ONLY thing that ever removes a stored `inputPreview`, and it was the
    // slowest possible caller of `kv.keys()` — a `get()` and often a `purge()`
    // awaited per key, which is the shape that measured 1 key of 500
    // (shared/kv.ts). A short list did not report a smaller sweep; it silently
    // left expired request previews in the bucket, which is the retention
    // commitment above not being kept.
    //
    // The keys are listed FIRST and purged afterwards — deliberately, and not as
    // the old "drain first" mitigation: with a server-computed subject list there
    // is nothing to truncate, and a key that a concurrent writer adds after the
    // listing is a fresh row this sweep has no business judging anyway.
    let purged = 0;
    try {
      for (const key of (await this.kv.list()).keys) {
        let expired = true; // a row we cannot read cannot be dated — it goes
        try {
          const raw = await this.kv.get(key);
          if (!raw || raw.operation !== "PUT") continue; // already gone
          expired = isExpired(agedAt(raw.json<ActivityEntry>()), cutoff);
        } catch { /* corrupt value: falls through as expired, which is correct */ }
        if (expired && (await this.forget(key))) purged++;
      }
    } catch (err) {
      // Reported, not swallowed, and never as "nothing to purge": the previews
      // this pass would have removed are still there, and the next pass is an
      // interval away.
      console.error(
        "[activity] retention sweep could not scan the bucket, so nothing was " +
          "purged this pass — expired request previews are STILL in mesh_activity:",
        err instanceof Error ? err.message : err,
      );
    }

    if (dropped > 0 || purged > 0) {
      console.log(
        `[activity] retention sweep: ${purged} key(s) purged, ${dropped} row(s) dropped ` +
          `(older than ${Math.round(MAX_AGE_MS / 86_400_000)}d) · ${this.entries.length} held`,
      );
    }
    return { dropped, purged };
  }

  /**
   * Erase every row naming one key — both directions, memory and bucket.
   *
   * The third removal reason, alongside the two bounds above, and the only one
   * that is not about age or volume: an IDENTITY ENDING. A key that is about to
   * be handed to somebody else has to leave nothing behind, because the next
   * holder of that key is a party to every row naming it and `mayRead` will
   * hand them the `inputPreview` inside it.
   *
   * It removes rows where the key is `from` (its own request text) AND rows
   * where it is `to` (a third party's request text, sent to it). Both leak to
   * the next holder, so both go. What the counterparty loses is the ring's
   * copy, not the record: `audit-log.ts` keeps the exchange — parties,
   * offering, outcome, duration and `inputSha256` — and has never held content.
   *
   * Removal is `forget`, the same purge the bounds use, for the same reason
   * (see it). A soft delete would leave the preview on the backing stream, and
   * a read-path filter would leave it in the bucket; neither is what a key
   * changing hands requires.
   *
   * The bucket is scanned as well as the ring for the reason `sweepExpired`
   * gives: a key whose in-memory row is already gone is exactly the case where
   * content outlives the read path, and the ring is rebuilt from the bucket at
   * every boot, so a row left there comes BACK into the read path on restart.
   *
   * A failed scan is reported as an ERROR rather than a partial success. The
   * caller (the credential pool's recycle path) refuses to hand the key on when
   * this does not come back clean, so a silent partial answer would be the
   * whole leak reopening quietly.
   */
  private async handleForget(env: Envelope): Promise<Envelope> {
    const reply = (payload: Record<string, unknown>, error?: { code: string; message: string }) =>
      createEnvelope({
        type: "respond",
        from: idOf(this.kp),
        to: env.from,
        in_reply_to: env.id,
        trace: childSpan(env.trace),
        ...(error ? { error: { ...error, retryable: true } } : {}),
        payload,
      });

    // Authorization is the signature. `decode` has already verified `sig`
    // against `from` (§5.3), so a caller can only ever name ITSELF here — there
    // is no `id` in the payload to name somebody else with, and so no grant to
    // configure and no operator key to leak. Erasing your own request text is
    // not a privilege.
    const subject = env.from;
    if (!subject) {
      return reply({}, { code: ErrorCode.INPUT_INVALID, message: "mesh.activity.forget needs a signed sender" });
    }

    const names = (e: ActivityEntry) => e.from === subject || e.to === subject;
    let purged = 0;
    let failed = 0;

    // Memory first, so the read path stops serving these rows immediately even
    // if the bucket scan below fails.
    const keep: ActivityEntry[] = [];
    const doomed: ActivityEntry[] = [];
    for (const e of this.entries) (names(e) ? doomed : keep).push(e);
    this.entries = keep;
    for (const e of doomed) {
      this.forgetPending(e);
      if (await this.forget(e.id)) purged++;
      else failed++;
    }

    let scanned = 0;
    try {
      const snapshot = await this.kv.list();
      scanned = snapshot.keys.length;
      for (const [key, raw] of snapshot.entries) {
        let row: ActivityEntry;
        try {
          row = raw.json<ActivityEntry>();
        } catch {
          continue; // unreadable: not attributable to this key, and the age bound takes it
        }
        if (!names(row)) continue;
        if (await this.forget(key)) purged++;
        else failed++;
      }
    } catch (err) {
      const message =
        `the activity bucket could not be scanned, so rows naming ${subject.slice(0, 12)}… may ` +
        `still be stored: ${err instanceof Error ? err.message : err}`;
      console.error(`[activity] forget FAILED — ${message}`);
      return reply({ agent: subject, purged, complete: false }, { code: ErrorCode.INTERNAL_ERROR, message });
    }

    if (failed > 0) {
      const message = `${failed} row(s) naming ${subject.slice(0, 12)}… could not be removed`;
      console.error(`[activity] forget INCOMPLETE — ${message}`);
      return reply({ agent: subject, purged, failed, complete: false }, { code: ErrorCode.INTERNAL_ERROR, message });
    }

    if (purged > 0) {
      console.log(`[activity] forget: ${purged} row(s) purged for ${subject.slice(0, 12)}… (${scanned} key(s) scanned)`);
    }
    return reply({ agent: subject, purged, scanned, complete: true });
  }

  // ── Authorization ─────────────────────────────────────────────
  //
  // These subjects hand out other agents' traffic: `from`/`to`/`offering` (the
  // whole who-talks-to-whom graph) plus `inputPreview`, the first 200 characters
  // of real request input. The code used to concede that it relied on the API
  // gateway to scope the answer, which does nothing at all for a caller that
  // reaches the subject directly — any credential on the mesh could publish an
  // empty query and read 200 entries of everyone's content. Access now needs one
  // of two things: the caller is a PARTY to the exchange (its key is the sender
  // or the recipient), or it OWNS one of the parties (§8.6, the owner key that
  // groups an account's agents). Operator surfaces that legitimately answer for
  // the whole mesh are named in ACTIVITY_READER_KEYS.

  /** A caller the operator has granted the mesh-wide view. */
  private isReader(caller: string): boolean {
    return READER_KEYS.has(caller);
  }

  /** An agent's owner key from the registry (§8.6), cached. Null when the agent
   *  is unregistered or the registry cannot be reached — in which case nothing
   *  is disclosed on the strength of ownership. */
  private async lookupOwner(agentId: string): Promise<string | null> {
    let owner: string | null = null;
    try {
      const q = sealEnvelope(
        createEnvelope({ type: "discover", from: idOf(this.kp), payload: { agent_id: agentId } }),
        this.kp,
      );
      const resp = await this.nc.request(Subjects.registryGet(agentId), q, { timeout: 2000 });
      const env = decode(resp.data) as { error?: unknown; payload?: { owner?: string } };
      if (!env.error) owner = env.payload?.owner ?? null;
    } catch {
      owner = null;
    }
    this.owners.set(agentId, { at: Date.now(), owner });
    return owner;
  }

  /** Owner keys for the given agent ids: cache hits are free, misses cost a
   *  registry round-trip and are budgeted per query. An id left unresolved is
   *  simply not disclosed. */
  private async ownersFor(ids: string[]): Promise<Map<string, string | null>> {
    const known = new Map<string, string | null>();
    const need: string[] = [];
    for (const id of ids) {
      if (!id || known.has(id) || need.includes(id)) continue;
      const hit = this.owners.get(id);
      if (hit && Date.now() - hit.at < OWNER_TTL_MS) known.set(id, hit.owner);
      else if (need.length < MAX_OWNER_LOOKUPS_PER_QUERY) need.push(id);
    }
    await Promise.all(
      need.map(async (id) => {
        known.set(id, await this.lookupOwner(id));
      }),
    );
    return known;
  }

  /** True if `caller` may see rows about `agentId`: itself, or an agent it owns. */
  private mayRead(caller: string, agentId: string, owners: Map<string, string | null>): boolean {
    if (!agentId) return false;
    if (agentId === caller) return true;
    return owners.get(agentId) === caller && caller.length > 0;
  }

  // ── Query Handler ─────────────────────────────────────────────

  private async handleList(env: Envelope): Promise<Envelope> {
    const query = (env.payload as {
      limit?: number;
      from?: string;       // filter by requester public key
      to?: string;         // filter by agent ID
      appKeys?: string[];  // filter by any of these public keys
    }) ?? {};

    let results = this.entries;

    if (query.from) {
      results = results.filter((e) => e.from === query.from);
    }
    if (query.to) {
      results = results.filter((e) => e.to === query.to);
    }
    if (query.appKeys?.length) {
      const keySet = new Set(query.appKeys);
      results = results.filter((e) => keySet.has(e.from));
    }

    // Scope to what this caller is entitled to (see Authorization, above).
    if (!this.isReader(env.from)) {
      const parties = results.filter((e) => e.from !== env.from && e.to !== env.from);
      const owners = await this.ownersFor(parties.flatMap((e) => [e.to, e.from]));
      results = results.filter(
        (e) => this.mayRead(env.from, e.from, owners) || this.mayRead(env.from, e.to, owners),
      );
    }

    const limit = Math.min(query.limit ?? 50, 200);
    results = results.slice(0, limit);

    return createEnvelope({
      type: "respond",
      from: idOf(this.kp),
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      payload: { entries: results, total: results.length },
    });
  }

  /** Refusal for the aggregate views, which have no per-caller subset: they
   *  describe the whole mesh or every agent on it, so they are operator reads. */
  private refuseAggregate(env: Envelope, subject: string): Envelope {
    return createEnvelope({
      type: "respond",
      from: idOf(this.kp),
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: {
        code: ErrorCode.UNAUTHORIZED,
        message:
          `${subject} is a mesh-wide operator view; ask about your own agents ` +
          `(mesh.usage.today with your agent ids) or have your key added to ACTIVITY_READER_KEYS`,
        retryable: false,
      },
    });
  }

  /** mesh.usage.list — per-agent message totals (counters only, no content).
   *  Every agent on the mesh in one answer, so: readers only. */
  private async handleUsageList(env: Envelope): Promise<Envelope> {
    if (!this.isReader(env.from)) return this.refuseAggregate(env, "mesh.usage.list");
    const query = (env.payload as { limit?: number }) ?? {};
    const agents = await this.usage.list(query.limit ?? 100);
    return createEnvelope({
      type: "respond",
      from: idOf(this.kp),
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      payload: { agents, total: agents.length },
    });
  }

  /** mesh.usage.summary — mesh-wide aggregate: today's totals, a per-day
   *  series, and today's top talkers by delivered bytes. Counters only, but the
   *  top-talkers list names agents, so: readers only. */
  private async handleUsageSummary(env: Envelope): Promise<Envelope> {
    if (!this.isReader(env.from)) return this.refuseAggregate(env, "mesh.usage.summary");
    const query = (env.payload as { days?: number; top?: number }) ?? {};
    const summary = await this.usage.summary(query.days ?? 7, query.top ?? 10);
    return createEnvelope({
      type: "respond",
      from: idOf(this.kp),
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      payload: summary as unknown as Record<string, unknown>,
    });
  }

  /**
   * mesh.usage.peers — both directions for ONE agent: who it served, whose
   * agents it consumed (the §13.5 fold's counterparty rollup). Per-entity and
   * more revealing than the counters — it names the agents on the other side
   * of every exchange — so it is scoped hard: the agent itself, its owner, or
   * a configured reader. Nothing here is filtered down for a stranger,
   * because a subset of somebody else's counterparty graph is still somebody
   * else's counterparty graph.
   *
   * ## Refused outright for a shared sandbox credential
   *
   * "The agent itself" is a sound rule for an agent and the wrong rule for a
   * BORROWED address. A guest credential is one of a fixed pool the mesh lends
   * out for about ten minutes and then hands to the next caller, so `env.from
   * === id` on a pool key does not mean "your own rollup"; it means "the
   * rollup of whoever has been wearing this address", which over a thirty-day
   * window is mostly strangers.
   *
   * Two obvious repairs were both rejected. ERASING the rollup at each lease
   * boundary deletes peer rows on BOTH sides (usage-store.ts `deleteAgent`),
   * so it would destroy the real agent's own record of its own exchanges, and
   * unlike the activity ring there is no audit chain underneath holding it.
   * DATE-SCOPING the answer to the current lease needs a per-key epoch that
   * survives a restart, which is a second store to keep in step and a rule
   * every future read path has to remember to apply.
   *
   * Refusing is neither. It destroys nothing, needs no state beyond the
   * published key set, and cannot be forgotten, because it sits on the deny
   * side of the check rather than inside the shape of the answer. Nobody
   * trying the mesh from a sandbox credential needs a counterparty rollup for
   * an address they are holding for ten minutes; the read exists for them only
   * because the authorization rule happened to admit them.
   *
   * A configured reader is unaffected: an operator investigating abuse is
   * exactly who should still be able to see it.
   */
  private async handleUsagePeers(env: Envelope): Promise<Envelope> {
    const query = (env.payload as { id?: string; days?: number; limit?: number }) ?? {};
    const id = typeof query.id === "string" ? query.id : "";
    const reply = (payload: Record<string, unknown>, error?: { code: string; message: string }) =>
      createEnvelope({
        type: "respond",
        from: idOf(this.kp),
        to: env.from,
        in_reply_to: env.id,
        trace: childSpan(env.trace),
        ...(error ? { error: { ...error, retryable: false } } : {}),
        payload,
      });
    if (!id) {
      return reply({}, { code: ErrorCode.INPUT_INVALID, message: "mesh.usage.peers needs an agent `id`" });
    }
    // The shared-credential refusal, before the ownership check, because it is
    // not a question of who owns the address: nobody does. Named, never a 404 —
    // a caller told "no such thing" learns the wrong lesson and asks again.
    if (!this.isReader(env.from) && (this.sandboxKeys.has(env.from) || this.sandboxKeys.has(id))) {
      return reply({}, {
        code: ErrorCode.UNAUTHORIZED,
        message:
          "mesh.usage.peers is refused for shared sandbox credentials. A guest credential is lent " +
          "from a pool and recycled between unrelated holders, so its counterparty rollup is not " +
          `one caller's to read. Use a credential of your own${coreUrl("app") ? `: ${coreUrl("app")}` : "."}`,
      });
    }
    if (!this.isReader(env.from) && env.from !== id) {
      const owners = await this.ownersFor([id]);
      if (!this.mayRead(env.from, id, owners)) {
        return reply({}, {
          code: ErrorCode.UNAUTHORIZED,
          message: "mesh.usage.peers answers for your own agents: the caller must be the agent, its owner, or a configured reader",
        });
      }
    }
    const result = await this.usage.peers(
      id,
      typeof query.days === "number" ? query.days : 30,
      typeof query.limit === "number" ? query.limit : 100,
    );
    return reply({ agent: id, ...result } as unknown as Record<string, unknown>);
  }

  /** mesh.usage.today — today's counters for the given agent ids (the account
   *  console's your-plan panel). Scoped to the ids the caller is entitled to:
   *  itself and the agents it owns. Counters are not content, but "which agents
   *  exist and how busy they are" is still somebody else's business. */
  private async handleUsageToday(env: Envelope): Promise<Envelope> {
    const query = (env.payload as { ids?: string[] }) ?? {};
    let ids = Array.isArray(query.ids) ? query.ids.filter((id) => typeof id === "string") : [];
    if (!this.isReader(env.from)) {
      const owners = await this.ownersFor(ids.filter((id) => id !== env.from));
      ids = ids.filter((id) => this.mayRead(env.from, id, owners));
    }
    const agents = await this.usage.today(ids);
    return createEnvelope({
      type: "respond",
      from: idOf(this.kp),
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      payload: { agents, day: new Date().toISOString().slice(0, 10) },
    });
  }
}

/** §5.7 rule 1: only a message for the agent (no mark, or "agent") can be an
 *  answer; one marked for a person, or malformed, never is. */
function forTheAgent(env: Envelope): boolean {
  return audienceOf(env) === "agent";
}

/**
 * Is this `request` the asked agent answering its own exchange — sent by the
 * exchange's responder of record, to the exchange's requester? Both parties
 * must be known: an exchange with an empty side cannot be answered this way,
 * so nobody can thread an id into a stranger's exchange and bill it.
 */
function answersAsRequest(env: Envelope, x: { from: string; to: string }): boolean {
  return x.from !== "" && x.to !== "" && env.from === x.to && env.to === x.from;
}

/**
 * The §13.5 receipt on an inbox-mode answer, read off the exchange it answers:
 * the asked agent (`x.to`) provided, the original requester (`x.from`)
 * consumed — the same parties as a terminal respond's receipt. The answer
 * envelope's own from/to point the other way and are not used.
 */
function replyReceiptParties(
  env: Envelope,
  x: { from: string; to: string },
): { provider: string; consumer: string; raw: unknown[] } | null {
  const raw = (env.payload as { usage?: unknown } | undefined)?.usage;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!x.to || !x.from) return null;
  return { provider: x.to, consumer: x.from, raw };
}

/** A ring row's content-free twin in the exchange index; null for a row that
 *  predates `requestId` (nothing to key it by). */
function recordOf(e: ActivityEntry): ExchangeRecord | null {
  if (!e.requestId) return null;
  return {
    v: 1,
    requestId: e.requestId,
    from: e.from,
    to: e.to,
    offering: e.offering,
    // No taskId: the row's is minted when the request carried none, and the
    // row cannot say which. The task alias is written once, at request time,
    // where the envelope can (recordRequest).
    recordedAt: agedAt(e) ?? new Date().toISOString(),
    ...(e.respondedAt ? { respondedAt: e.respondedAt } : {}),
    ...(e.receiptAt ? { receiptAt: e.receiptAt } : {}),
  };
}

/** The keys an operator attests as sandbox nodes (NODE_ATTESTATIONS). */
export function sandboxKeysOf(json: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [key, attrs] of parseNodeAttestations(json)) if (attrs.trust_tier === "sandbox") out.add(key);
  return out;
}
