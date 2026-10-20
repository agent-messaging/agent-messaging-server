/**
 * The metering substrate (SPEC §13.5) — meter events, their stream, and the
 * publishers the services share.
 *
 * A meter event is the atom of usage: who consumed what from whom, in which
 * meter's unit, derived from which envelope. Everything downstream folds the
 * same stream — the usage counters (activity/metering-fold.ts), the per-
 * counterparty rollup, and eventually rating (§19.6) — which is the whole
 * argument for the stream existing: one primitive, read from either end,
 * answers "who did I serve" and "whose agents did I consume" without a second
 * schema.
 *
 * Two writers exist today, both platform services: the activity tap (observed
 * request/response/bytes events, plus admission-refusal events) and the task
 * manager (task terminal events, beside the §19.2 receipt it already emits).
 * Both publish signed `emit` envelopes on ONE subject, captured by ONE stream:
 *
 *   subject: mesh.event.metering.usage        (METERING_SUBJECT)
 *   stream:  MESH_METERING                    (the storage layer's; on JetStream
 *                                             storage/jetstream/metering-stream.ts)
 *
 * Since the 2026-08-18 migration the subject itself is owned by MESH_EVENTS
 * (§18.3; shared/events-stream.ts), and MESH_METERING is a subject-less stream
 * SOURCING that one subject from it: same stream name, same retention, same
 * consumers, different capture path.
 *
 * The envelope payload is `{ domain, event_type, data }` like every other
 * platform event (§13.1's shape); `data.events` carries the meter events of
 * one observation moment together, so a fold can reconstruct the exchange
 * without correlation state. `data.failed` flags an exchange whose response
 * was an error — exchange context, deliberately NOT a field on the meter
 * event, whose shape is pinned by conformance/metering.json and stays the
 * spec's.
 *
 * Trust: the stream's subject is an ordinary event subject, so anything with a
 * credential can publish shapes onto it. A fold MUST therefore filter by the
 * verified envelope `from` against the keys it trusts (its own service key,
 * plus METERING_TRUSTED_KEYS) — an unsigned or stranger-signed event is a
 * counter-inflation primitive, not a meter event. The filter lives in the
 * fold, not here: this module builds and publishes, it never believes.
 */

import type { Messaging } from "../storage/index.js";
import { createEnvelope, Subjects, type Envelope } from "../sdk.js";
import { idOf, sealEnvelope, type ServiceIdentity } from "./handler.js";

// ─── The meter event (SPEC §13.5; conformance/metering.json) ────────────────

/** §13.5: the closed set of observed meters. Declared names MUST NOT collide
 *  with these — the class is a trust statement, and a collision would launder
 *  a claim as an observation. */
export const OBSERVED_METERS: ReadonlySet<string> = new Set([
  "requests",
  "responses",
  "events",
  "bytes_in",
  "bytes_out",
  "tasks_completed",
  "task_ms",
]);

const METER_NAME_RE = /^[a-z0-9_]{1,64}$/;

export interface MeterEvent {
  meter: string;
  /** A trust statement, not a category label: `observed` is the platform's own
   *  record; `declared` is the responder's claim (§13.5). */
  class: "observed" | "declared";
  /** Non-negative integer in the meter's unit. */
  quantity: number;
  /** The serving agent. */
  provider: string;
  /** The requesting agent. Always present — attribution in both directions is
   *  the point of the event. */
  consumer: string;
  offering?: string;
  task_id?: string;
  /** The id of the envelope this event derives from. (meter, envelope_id) is
   *  the idempotency key a fold MUST deduplicate on. */
  envelope_id: string;
  /** Events derived from an ANSWER (a respond's `responses` / `bytes_out`,
   *  declared receipt events, refusal events): the id of the request envelope
   *  answered (§13.5, Agent Messaging 0.9.5-draft). Lets a reader join a
   *  request's events (keyed by their own envelope_id) to its answer's without
   *  correlation state. Request-side events never carry it: their envelope_id
   *  IS the request id. Not part of the idempotency key. */
  request_id?: string;
  ts: string;
  /** Refusal events only: quantity 0, and the code that refused. */
  refused?: boolean;
  refusal_code?: string;
  /** Common Agent §7.7: the work was a trial. Recorded, never charged to the
   *  requester. */
  trial?: boolean;
}

/** The one-publish unit: the meter events of one observation moment, plus the
 *  exchange context a fold needs (`failed`: the response was an error). */
export interface MeterEventBatch {
  events: MeterEvent[];
  failed?: boolean;
}

/**
 * Shape check, §13.5 / conformance/metering.json `event.invalid`. Fail closed:
 * an event that does not validate is not folded, and the fold logs rather
 * than guesses. Nothing here checks TRUTH — a well-formed declared quantity
 * is still a claim.
 */
export function validMeterEvent(e: unknown): e is MeterEvent {
  if (typeof e !== "object" || e === null) return false;
  const m = e as Record<string, unknown>;
  if (typeof m.meter !== "string" || !METER_NAME_RE.test(m.meter)) return false;
  if (m.class !== "observed" && m.class !== "declared") return false;
  // Declared names must not collide with the observed set.
  if (m.class === "declared" && OBSERVED_METERS.has(m.meter)) return false;
  if (m.class === "observed" && !OBSERVED_METERS.has(m.meter)) return false;
  if (typeof m.quantity !== "number" || !Number.isSafeInteger(m.quantity) || m.quantity < 0) {
    return false;
  }
  if (typeof m.provider !== "string" || m.provider === "") return false;
  if (typeof m.consumer !== "string" || m.consumer === "") return false;
  if (typeof m.envelope_id !== "string" || m.envelope_id === "") return false;
  if (typeof m.ts !== "string" || m.ts === "") return false;
  // A refusal event is a record, never a charge: quantity 0, always.
  if (m.refused === true && m.quantity !== 0) return false;
  if (m.refused !== undefined && typeof m.refused !== "boolean") return false;
  if (m.refusal_code !== undefined && typeof m.refusal_code !== "string") return false;
  if (m.trial !== undefined && typeof m.trial !== "boolean") return false;
  return true;
}

// ─── Builders (the observed writers) ────────────────────────────────────────

/** The admission-refusal codes whose error responds SHOULD also be recorded
 *  as quantity-0 `requests` events (§13.5 refusal events, §19.6 rate-to-zero). */
export const ADMISSION_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "BUDGET_INSUFFICIENT",
  "DEADLINE_UNMEETABLE",
  "AGREEMENT_REQUIRED",
]);

function base(
  meter: string,
  quantity: number,
  provider: string,
  consumer: string,
  envelopeId: string,
  extra?: Partial<MeterEvent>,
): MeterEvent {
  return {
    meter,
    class: "observed",
    quantity,
    provider,
    consumer,
    envelope_id: envelopeId,
    ts: new Date().toISOString(),
    ...extra,
  };
}

/** A `request` was delivered to `provider`: one `requests` event plus its
 *  `bytes_in`. Derives from the request envelope. */
export function observedRequest(
  provider: string,
  consumer: string,
  envelopeId: string,
  bytes: number,
  offering?: string,
  taskId?: string,
): MeterEventBatch {
  const extra = { ...(offering ? { offering } : {}), ...(taskId ? { task_id: taskId } : {}) };
  return {
    events: [
      base("requests", 1, provider, consumer, envelopeId, extra),
      base("bytes_in", Math.max(0, bytes), provider, consumer, envelopeId, extra),
    ],
  };
}

/** The FIRST `respond` of an exchange left `provider`: one `responses` event
 *  plus its `bytes_out`; `failed` marks an error response. Derives from the
 *  respond envelope; `requestId` names the request it answers. */
export function observedResponse(
  provider: string,
  consumer: string,
  envelopeId: string,
  bytes: number,
  failed: boolean,
  offering?: string,
  taskId?: string,
  requestId?: string,
): MeterEventBatch {
  const extra = {
    ...(offering ? { offering } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    ...(requestId ? { request_id: requestId } : {}),
  };
  return {
    events: [
      base("responses", 1, provider, consumer, envelopeId, extra),
      base("bytes_out", Math.max(0, bytes), provider, consumer, envelopeId, extra),
    ],
    ...(failed ? { failed: true } : {}),
  };
}

/** A follow-up `respond` on an already-counted exchange (task-mode
 *  multi-respond): bytes only, exactly as the counters have always worked.
 *  `requestId` names the request the exchange answers. */
export function observedResponseBytes(
  provider: string,
  consumer: string,
  envelopeId: string,
  bytes: number,
  requestId?: string,
): MeterEventBatch {
  return {
    events: [
      base("bytes_out", Math.max(0, bytes), provider, consumer, envelopeId,
        requestId ? { request_id: requestId } : undefined),
    ],
  };
}

/**
 * An admission refusal: a `requests` event with quantity 0 (§13.5). Declined
 * demand is a fact both parties reasonably want recorded, and it rates to
 * zero, always.
 *
 * Derives from the REFUSING RESPOND's envelope id, not the request's —
 * deliberately, because the delivered request already produced a `requests`
 * event under the request's id, and (meter, envelope_id) is the idempotency
 * key: the same key twice would make the refusal record disappear into the
 * dedupe. The fixture's refusal vector pins the distinct-id shape. The
 * refused request is named by `request_id` instead (§13.5).
 */
export function observedRefusal(
  provider: string,
  consumer: string,
  refusingEnvelopeId: string,
  refusalCode: string,
  offering?: string,
  requestId?: string,
): MeterEventBatch {
  return {
    events: [
      base("requests", 0, provider, consumer, refusingEnvelopeId, {
        refused: true,
        refusal_code: refusalCode,
        ...(offering ? { offering } : {}),
        ...(requestId ? { request_id: requestId } : {}),
      }),
    ],
  };
}

/**
 * The §13.5 usage receipt, lifted: `payload.usage` entries from a responder's
 * terminal respond become DECLARED meter events. The receipt arrived under the
 * responder's envelope signature (that is the whole design), so the events are
 * attributable claims — never observations, and the `class` says so. Entries
 * that fail declared-meter validation are dropped, fail closed; the caller
 * learns how many.
 */
export function declaredUsage(
  provider: string,
  consumer: string,
  envelopeId: string,
  entries: unknown,
  offering?: string,
  taskId?: string,
  requestId?: string,
): { batch: MeterEventBatch; dropped: number } {
  const raw = Array.isArray(entries) ? entries : [];
  const ts = new Date().toISOString();
  const events: MeterEvent[] = [];
  let dropped = 0;
  for (const e of raw) {
    const m = e as { meter?: unknown; quantity?: unknown };
    const candidate: MeterEvent = {
      meter: typeof m?.meter === "string" ? m.meter : "",
      class: "declared",
      quantity: typeof m?.quantity === "number" ? m.quantity : -1,
      provider,
      consumer,
      envelope_id: envelopeId,
      ts,
      ...(offering ? { offering } : {}),
      ...(taskId ? { task_id: taskId } : {}),
      ...(requestId ? { request_id: requestId } : {}),
    };
    if (validMeterEvent(candidate)) events.push(candidate);
    else dropped++;
  }
  return { batch: { events }, dropped };
}

/** A Task reached a terminal state: `task_ms` always, `tasks_completed` only
 *  on completion. Derives from the terminal update envelope (§13.5: events not
 *  derived from a single envelope use the Task's terminal envelope id). */
export function observedTaskTerminal(
  provider: string,
  consumer: string,
  terminalEnvelopeId: string,
  taskId: string,
  durationMs: number,
  completed: boolean,
  offering?: string,
): MeterEventBatch {
  const extra = { task_id: taskId, ...(offering ? { offering } : {}) };
  const events = [
    base("task_ms", Math.max(0, Math.round(durationMs)), provider, consumer, terminalEnvelopeId, extra),
  ];
  if (completed) {
    events.unshift(base("tasks_completed", 1, provider, consumer, terminalEnvelopeId, extra));
  }
  return { events };
}

// ─── The wire ───────────────────────────────────────────────────────────────

export const METERING_SUBJECT = Subjects.event("metering.usage");
export const METERING_STREAM = "MESH_METERING";

/**
 * Publish one batch of meter events as a signed emit envelope. Fire-and-forget
 * on the tap's hot path: never throws, and a failed publish loses that
 * moment's events the way a failed counter flush always has.
 */
export function publishMeterEvents(
  nc: Messaging,
  identity: ServiceIdentity,
  batch: MeterEventBatch,
): void {
  if (batch.events.length === 0) return;
  try {
    const env = createEnvelope({
      type: "emit",
      from: idOf(identity),
      payload: {
        domain: "metering",
        event_type: "usage",
        data: batch as unknown as Record<string, unknown>,
      },
    });
    nc.publish(METERING_SUBJECT, sealEnvelope(env, identity));
  } catch (err) {
    console.error("[metering] publish failed:", err instanceof Error ? err.message : err);
  }
}

/** The batch out of a decoded metering envelope, validated event by event.
 *  Invalid events are DROPPED (fail closed), and the caller is told how many. */
export function readBatch(env: Envelope): { batch: MeterEventBatch; dropped: number } {
  const data = (env.payload as { data?: { events?: unknown[]; failed?: unknown } })?.data;
  const raw = Array.isArray(data?.events) ? data.events : [];
  // §8.5 deprecation window: events written to the stream before the rename
  // carry `skill`. The stream is durable and folds replay it, so the old
  // spelling stays readable for as long as those events can appear in an open
  // rating window.
  for (const e of raw) {
    const ev = e as { offering?: unknown; skill?: unknown } | null;
    if (ev && typeof ev === "object" && ev.offering === undefined && typeof ev.skill === "string") {
      ev.offering = ev.skill;
    }
  }
  // §13.5 request_id is optional and a reader ignores what it cannot use: a
  // malformed one is dropped from the event, never the event itself, so the
  // counters stay whole and `MeterEvent.request_id` is always a real id.
  for (const e of raw) {
    const ev = e as { request_id?: unknown } | null;
    if (ev && typeof ev === "object" && "request_id" in ev &&
        (typeof ev.request_id !== "string" || ev.request_id === "")) {
      delete ev.request_id;
    }
  }
  const events = raw.filter(validMeterEvent);
  return {
    batch: { events, ...(data?.failed === true ? { failed: true } : {}) },
    dropped: raw.length - events.length,
  };
}

/**
 * Who provided and who consumed, for a usage receipt — and whether this
 * envelope carries one at all.
 *
 * Two shapes reach here and they read in OPPOSITE directions, which is the
 * whole reason this is a named function with tests rather than an expression
 * inside the tap:
 *
 *  - A terminal respond. The responder is the envelope's `to` (the tap records
 *    an exchange, and on a respond `to` is the agent that did the work).
 *  - An inbox-mode answer, which is a fresh REQUEST carrying `in_reply_to`.
 *    Here the agent that did the work is `from`, because it is now the sender.
 *
 * Getting that backwards does not fail loudly. It bills the buyer's work to
 * the seller and the seller's to the buyer, and every downstream number stays
 * internally consistent while being exactly wrong.
 *
 * Returns null when there is no receipt to lift: not a receipt-bearing shape,
 * no usage array, or an endpoint the tap could not name. A sealed payload
 * lands here too, since its `usage` is unreadable — correct, because a
 * platform that cannot see the content should not publish counts about it.
 */
export function usageReceiptParties(
  env: { in_reply_to?: string | null; payload?: unknown },
  entry: { to: string; from: string },
): { provider: string; consumer: string; raw: unknown[] } | null {
  const payload = env.payload as { status?: string; usage?: unknown } | undefined;
  const terminal = payload?.status === "completed" || payload?.status === "failed";
  const replyAnswer = !terminal && !!env.in_reply_to;
  if (!terminal && !replyAnswer) return null;

  const raw = payload?.usage;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const provider = terminal ? entry.to : entry.from;
  const consumer = terminal ? entry.from : entry.to;
  if (!provider || !consumer) return null;
  return { provider, consumer, raw };
}
