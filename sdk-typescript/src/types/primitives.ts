import type {
  Manifest,
  Availability,
  TrustTier,
  AvailabilityClass,
  Reachability,
  IdentitySourceKind,
} from "./manifest.js";
import type { CancelReason, TaskState } from "./task.js";
import type { CostCeiling } from "./envelope.js";

export type RegisterPayload = Manifest;

export interface DiscoverQuery {
  capabilities?: string[];
  /** Joined from the presence service at query time (§9.6). */
  availability?: Availability;
  offering_id?: string;
  tags?: string[];
  /** Restrict to agents hosted by a specific node (§9.3). */
  node?: string;
  /** Restrict to agents grouped under a specific owner key (§8.6) — a
   *  person's or org's roster. Visibility rules still apply. */
  owner?: string;
  /** Minimum node trust tier, joined from the node profile (§9.7). Ordered:
   *  sandbox < standard < verified. Nodes with no profile are excluded. */
  trust_tier?: TrustTier;
  /** Node's expected uptime pattern, joined from the node profile (§9.7). */
  availability_class?: AvailabilityClass;
  /** Node reachability, joined from the node profile (§9.7). */
  reachability?: Reachability;
  /** Where the agent's identity came from (§9.7 `identity_source`): every
   *  member given must match. Agents with no recorded source are excluded
   *  whenever this is set. */
  identity_source?: { kind?: IdentitySourceKind | IdentitySourceKind[]; issuer?: string; trust_domain?: string };
  version?: string;
  limit?: number;
  /** Only these agents, by agent ID (§9.3). Naming is not browsing: an
   *  unlisted agent, or one the registry keeps off its listings, is returned
   *  when named; a private one still only to its owner. */
  agent_ids?: string[];
  /** Cost-based filtering is provided by the Economics extension (§17). */
  max_cost?: { per_request: number; currency: string };
}

export interface DiscoverResult {
  agents: Manifest[];
  total: number;
}

export interface RequestPayload {
  offering: string;
  input: unknown;
  config?: {
    timeout_ms?: number;
    stream?: boolean;
    accepted_output?: string[];
    /** §11.6: requester demands a signature on EVERY stream chunk (strict
     *  mode for low-trust boundaries). Default: stream-level auth only. */
    sign_chunks?: boolean;
  };
  /** Common Agent 7.7: this request asks for trial work. Only `true` is a
   *  trial. A trial request carries no budget; one that does is refused
   *  `TRIAL_REFUSED` with reason `budget`. */
  trial?: boolean;
  /** A host's vouch for the person it sends this trial request on behalf of
   *  (Common Agent 7.7, Hosts). Honoured only when the sender is a host the
   *  responder's node trusts; from anyone else it is ignored and the sender
   *  itself is the requester. A vouched visitor is never signed in. */
  trial_requester?: TrialRequesterVouch;
}

/** Who a host says a trial request is for (Common Agent 7.7). `id` is stable
 *  for that person: an account id, or a visitor id the host issued. */
export interface TrialRequesterVouch {
  id: string;
  kind: "account" | "visitor";
  signed_in: boolean;
  verified: boolean;
}

/** `payload.status` on a `respond`. Either a Task state (§7.2) or the one
 *  value that is deliberately NOT a Task state: `"accepted"`, the §6.4a accept
 *  signal — a delivery signal emitted at admission, before the handler runs.
 *  It never appears in a Task record and never resolves a request; the first
 *  respond whose status is not `"accepted"` is the substantive reply (§7.0). */
export type RespondStatus = TaskState | "accepted";

export interface RespondPayload {
  status: RespondStatus;
  message?: string;
  output?: unknown;
  /** Why the work stopped (§10.8). REQUIRED on a canceled update and OPTIONAL
   *  on a failed one — a Task that simply did not work out is a complete
   *  statement. Either way a reason outside the closed enum is rejected as
   *  INVALID_ENVELOPE at the door. */
  reason?: CancelReason;
  /** Optional free-text context beside the reason (§10.8). The reason, not the
   *  note, is what the record carries as meaning. */
  note?: string;
  /** §10.8: which declared need (§8.5.1) the caller did not furnish, as
   *  `"<kind>:<value>"`. REQUIRED with `needs_not_furnished` and refused with
   *  any other reason. Whether the need was really declared is the platform's
   *  question, not the sender's (§10.8a). */
  unmet_need?: string;
  /** §10.8: the outside service that stopped working. Optional with
   *  `dependency_failed` and refused with any other reason. */
  dependency?: string;
  /** On a terminal respond (§19.3): the responder's reported actual spend —
   *  informative, never verified ("you can oblige an agent to respect a
   *  ceiling, but you cannot oblige its spend report to be true"). The SDK
   *  fills it from the EXT-8 allowance ledger when usage was reported for the
   *  task (`ctx.reportUsage` / `AgentMesh.reportUsage`). */
  cost?: CostCeiling;
  /** On a terminal respond (§13.5): the usage receipt — declared meter
   *  quantities (`tokens_out`, `tool_calls`, …) the host reported through
   *  `ctx.reportMeter` / `AgentMesh.reportMeterUsage`. The envelope signature
   *  covers it, which is the design: a usage report is a signed receipt with
   *  no new signature. The platform lifts entries into declared meter events
   *  at delivery; what the signature proves is authorship, not truth. */
  usage?: Array<{ meter: string; quantity: number }>;
  /** Common Agent 7.7: true on the responses and task updates of work admitted
   *  as a trial, so the platform gives the task a trial receipt (rated to zero
   *  for the requester) rather than counting it as a sale. */
  trial?: boolean;
}

export interface StreamChunkPayload {
  status: TaskState;
  chunk_index: number;
  final: boolean;
  content_type?: string;
  data: unknown;
  /** On the FINAL chunk only (§11.6): total chunks in the stream, including
   *  the final one. Signed, so the requester can detect truncation/injection. */
  chunk_count?: number;
}

/** The node-level queued acknowledgement (§6.4a, §16.4): a node holding an
 *  inbox for an attended session answers a request synchronously with this
 *  shape — `queued` certifies delivery to a held mailbox ONLY, deliberately
 *  not admission, and the real reply arrives later at the SENDER's own inbox
 *  correlated by `in_reply_to`. Disjoint from the accept signal by
 *  construction: `"accepted"` means a handler will run now; `queued` means a
 *  mailbox holds the message. Pinned in conformance/accept-signal.json. */
export interface QueuedAck {
  queued: true;
  inbox_id: string;
  /** Informative only; never part of the contract. */
  text?: string;
}

export interface EmitPayload {
  domain: string;
  event_type: string;
  data: unknown;
}
