import type { RestsOnEntry } from "../rests-on.js";

export const PROTOCOL_VERSION = "0.3.0";

export type PrimitiveType =
  | "register"
  | "discover"
  | "request"
  | "respond"
  | "emit"
  | "subscribe";

export interface TraceContext {
  /** W3C Trace Context trace-id: 32 lowercase hex chars (§13.1). */
  trace_id: string;
  /** W3C Trace Context span-id: 16 lowercase hex chars. */
  span_id: string;
  parent_span_id?: string | null;
  /** W3C `tracestate`, carried verbatim. Omitted (never null) when absent —
   *  the canonical signing bytes must match the Rust SDK, which skips it. */
  tracestate?: string;
}

export interface ErrorObject {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
  retry_after_ms?: number | null;
}

/** The budget's money axis (§19.3, Economics extension). Integer micro-units
 *  (1,000,000 = one unit of the currency) so no floating point ever touches
 *  money; `currency` is an ISO 4217 code. Core treats the block as opaque —
 *  its semantics (the most the requester can be asked to pay) come from §7.7. */
export interface CostCeiling {
  /** Integer micro-units of the currency. 1,000,000 = one unit. Never a float. */
  amount_micro: number;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
}

/** The sender's budget for the work a message initiates or revises (§7.7): the
 *  most it may cost and the latest it may finish. An offer whose acceptance
 *  means something — a responder that takes the request is saying the work fits.
 *
 *  `revision` is REQUIRED: `0` on the initiating request, incremented by one on
 *  each revision. Revisions are absolute, never deltas — each states the entire
 *  budget, so the highest `revision` is simply the whole truth and a lost or
 *  reordered one corrupts nobody's arithmetic. At least one of `deadline` /
 *  `cost_ceiling` must be present. */
export interface Budget {
  /** Absolute RFC-3339 deadline (core axis). Compared under the §22.3
   *  clock-skew tolerance and no finer than one second (§7.7). */
  deadline?: string;
  /** Revision counter: 0 on the initiating request, +1 per revision. */
  revision: number;
  /** The money axis, defined by the Economics extension (§19.3). */
  cost_ceiling?: CostCeiling;
}

export interface TextPart {
  text: string;
}

export interface DataPart {
  data: Record<string, unknown>;
}

/**
 * A pointer to bytes held somewhere else (§7.5).
 *
 * The three original fields say where and how big. What they could not say is
 * *what* — so a reader that fetched a ref had no way to tell whether the bytes
 * it got back were the bytes the sender meant, and no way to notice if they
 * changed underneath. `digest` closes that: it is the sender's claim about the
 * content, checkable by anyone who fetches it, and it is what lets a ref be
 * cached, deduplicated, or re-fetched from a mirror without trusting the store.
 *
 * OPTIONAL, because artifacts on the wire predate it and a manifest-shaped
 * refusal to read them would break agents that are running today. Absent means
 * unverifiable, not verified — a reader that needs the guarantee should say so.
 */
export interface RefPart {
  /** Opaque URI locating the bytes. Readers MUST treat it as opaque and resolve
   *  it through the SDK rather than parsing it (§7.5). */
  ref: string;
  media_type: string;
  size: number;
  /** `sha256:<64 lowercase hex>` over the referenced bytes. */
  digest?: string;
  /** Filename, when the bytes are a file. Distinct from the artifact's `name`:
   *  one artifact may carry several files, and this is how each keeps its own.
   *  Also what an A2A `FilePart.name` maps to and from, so a file survives a
   *  round trip through the bridge with its name intact. */
  name?: string;
}

export type ArtifactPart = TextPart | DataPart | RefPart;

/**
 * One live object both parties knowingly operate on (§7.5.5) — a git
 * repository two agents are coding in together. The other thing from every
 * part type above: inline bytes and refs hand the receiver its own copy (a
 * ref's bytes can never change, so holding one IS holding a copy); a resource
 * points both parties at the same live thing, and each should expect the
 * other's changes to appear in it.
 *
 * Deliberately carries NONE of a ref's fields — no digest, size, media type,
 * or expiry. Those are snapshot-shaped claims, and no snapshot-shaped claim
 * can honestly be made about a place. The mesh asserts nothing about a
 * resource and stores nothing for it; retention (§7.5.2) does not apply.
 *
 * Travels as `resources` beside `files` in a request's input. Two rules from
 * the spec matter more than the shape: never fetch/clone/probe implicitly,
 * and never a credential in cleartext — access is arranged in the resource's
 * own auth domain (an invitation, a deploy key), or a secret rides sealed
 * (§4.3).
 */
export interface ResourceEntry {
  /** Where the resource lives. Never resolved through a mesh store. */
  uri: string;
  /** What sort of thing this is. `git` is reserved; otherwise open vocabulary —
   *  treat unrecognised kinds as opaque rather than guessing. */
  kind: string;
  /** What the sender intends the receiver to do with it. A receiver granted
   *  `read` that writes has left the agreement, whatever the resource's own
   *  permissions allow. */
  access: "read" | "read-write";
  name?: string;
  /** The right place for working conventions ("branch, then PR") — part of
   *  the agreement, not expressible in any field. */
  description?: string;
}

export interface Artifact {
  id: string;
  name: string;
  media_type: string;
  parts: ArtifactPart[];
  created_at?: string;
  meta?: Record<string, unknown>;
  /**
   * The bytes this deliverable was computed FROM (§5.6).
   *
   * A ref's `digest` pins the bytes a part points AT, which is the other half
   * of the problem: an artifact keeps verifying after the inputs behind it
   * have moved. Declaring them here puts them inside the envelope signature,
   * so a reader can ask whether the work still rests on what it said it did.
   *
   * OPTIONAL, and absent means the artifact declares nothing about its
   * inputs. That reads as unverifiable, never as "it had none".
   */
  rests_on?: RestsOnEntry[];
}

export interface Envelope {
  v: string;
  id: string;
  type: PrimitiveType;
  ts: string;
  from: string;
  trace: TraceContext;
  to?: string;
  task_id?: string;
  in_reply_to?: string;
  context_id?: string;
  /** The sender's budget for the work this message initiates or revises
   *  (§7.7, §5.2). Meaningful on `request` and on budget revisions; ignored
   *  elsewhere. Covered by `sig` like every other field. */
  budget?: Budget;
  error?: ErrorObject;
  payload?: unknown;
  artifacts?: Artifact[];
  meta?: Record<string, unknown>;
  /** Ed25519 signature over the canonical envelope (all fields except `sig`)
   *  by the `from` agent's key. Establishes per-agent identity independent of
   *  the transport connection (§4.5, §5.3). Required on the wire in 0.2. */
  sig?: string;
}
