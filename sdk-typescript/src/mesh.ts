import { nkeys } from "./internal/nkeys.js";
import { jwtAuthenticator, connect as natsConnect, AckPolicy, DeliverPolicy, type ConsumerInfo, type Msg, type Subscription } from "nats.ws";
import type { Envelope, Artifact, Budget, ErrorObject } from "./types/envelope.js";
import type { Manifest, Availability, NodeDeclaredProfile, ListingDeclarations } from "./types/manifest.js";
import type { Task, TaskState, CancelReason } from "./types/task.js";
import { TERMINAL_STATES, propagatedCancelNote } from "./types/task.js";
import { validateBudget, BudgetExhaustedError, budgetInsufficient, type BudgetRevision } from "./budget.js";
import { InputProblemsError } from "./problems.js";
import {
  AllowanceEngine,
  type AllowanceUsage,
  type AllowanceStatus,
  type AllowanceLedgerView,
  type AllowanceLedgerEntry,
  type AllowanceAskOwnerHandler,
  type AllowanceEstimator,
} from "./allowance.js";
import {
  parseCancelInput,
  validateCancelReason,
  validateStopFields,
  type StopQualifier,
} from "./cancel.js";
import type {
  DiscoverQuery,
  DiscoverResult,
  RequestPayload,
  RespondPayload,
  EmitPayload,
  StreamChunkPayload,
  QueuedAck,
} from "./types/primitives.js";
import {
  effectiveInboundCap,
  preflightSenderText,
  preflightEnvelopeSize,
  preflightContentType,
  preflightTrial,
} from "./preflight.js";
import {
  MemoryTrialLedger,
  quoteFromPrice,
  trialAdmission,
  validateTrial,
  trialRequesterOf,
  trialLedgerKey,
  trialInputsOf,
  descriptorOffering,
  isTrustedHost,
  workCaps,
  type TrialDeclaration,
  type TrialRequester,
  type TrialFunds,
  type TrialNodeOptions,
  type TrialLedger,
  type TrialContext,
} from "./trial.js";
import { namingGateFor, type NamingGate, type NamingStatus, type RequireNamedOptions } from "./naming-gate.js";
import { RoomsDoor } from "./rooms-door.js";
import { BoardDoor } from "./board-door.js";
import { ReviewsDoor } from "./reviews-door.js";
import { capabilitiesReader, gatedDoor, notAvailableRefusal, type MeshCapabilities } from "./capabilities.js";
import {
  MessagesDoor, ContactsDoor, OwnerDoor, IdentityDoor, NamesDoor, FeedsDoor, RegistryDoor, type MeshDoorContext,
  type MessagesInboxRequests, type ContactsAdmissionRequests,
} from "./mesh-door.js";
import { AM_URL_API, AM_URL_NAMING, addressesFromBroker, requireApi } from "./am-env.generated.js";
import {
  PlatformServices,
  type MessagesRequests,
  type ContactsRequests,
  type OwnerRequests,
  type IdentityRequests,
  type NamesRequests,
  type FeedsRequests,
  type RegistryRequests,
  type RoomsRequests,
  type BoardRequests,
  type AgentsRequests,
  type DebtRequests,
  type PactRequests,
  type DependentsRequests,
  type CallsRequests,
  type CatalogRequests,
  type JobsRequests,
  type CreditsRequests,
  type AttachmentsRequests,
  type PortfolioRequests,
  type MemoryRequests,
  type AccountRequests,
  type TransformRequests,
  type ReviewsRequests,
  type ErrorsRequests,
  type RunsRequests,
  type SamplesRequests,
  type SchedulesRequests,
  type MandateRequests,
} from "./services.generated.js";
import { platformCaller } from "./service-caller.js";
import type {
  ConnectOptions,
  RegisterOptions,
  RequestConfig,
  StreamConfig,
  SecurityWarning,
} from "./types/options.js";
import { PROTOCOL_VERSION } from "./types/envelope.js";
import { MeshError, RejectedError, ErrorCode } from "./types/errors.js";
import { ConnectionManager } from "./internal/connection.js";
import { createEnvelope } from "./internal/envelope-builder.js";
import {
  signEnvelope,
  createAttestation,
  signManifest,
  verifyManifestSignature,
  type KeyPair,
} from "./internal/identity.js";
import { withDetectedDevice } from "./internal/device-profile.js";
import { encode, decode } from "./internal/codec.js";
import { Subjects, isSubjectToken, isPublishableSubject } from "./internal/subjects.js";
import { uuid7 } from "./internal/uuid.js";
import {
  AUDIENCE_DECLARATION,
  AUDIENCE_EXTENSION_URI,
  audienceOf,
  audiencePreflight,
  declaresAudience,
  frameForPerson,
  personTextOf,
  type AgentMayRead,
  type AudienceReceiver,
  type PersonMessage,
  type PersonMessageHandler,
} from "./audience.js";
import { RevokedSenders, type RevocationAnswer } from "./internal/revoked-senders.js";
import { childSpan } from "./internal/trace.js";
import { spanPayload, traceSubject, outcomeOf, type SpanInput, type SpanOutcome, type SpanData } from "./internal/spans.js";
import { runWithTrace } from "./internal/trace-ambient.js";
import { runWithDispatch, currentDispatch } from "./internal/dispatch-ambient.js";
import {
  OfferingRouter,
  type OfferingHandler,
  type StreamOfferingHandler,
  type RequestContext,
  type HandlerOptions,
} from "./internal/offering-router.js";
import { MeterUsageLedger } from "./internal/meter-usage.js";
import { publicSkuOf, skuDigest, skuFor, validateSkus, type Sku } from "./sku.js";
import {
  agreementCovers,
  agreementRequired,
  loadAgreement,
  type AgreementDocument,
} from "./agreement.js";
import {
  FundsReleaseReason,
  insufficientFunds,
  loadFundsHoldResult,
  type FundsHoldRequest,
  type FundsHoldResult,
  type FundsReleaseReasonValue,
} from "./funds.js";
import { TaskTracker } from "./internal/task-tracker.js";
import {
  createStreamWriter,
  createChunkIterable,
  type StreamChunk,
} from "./internal/stream.js";
import { setUnrefInterval, type TimerHandle } from "./internal/timers.js";
import { vouchRenewAt, vouchCheckIntervalMs } from "./internal/vouch.js";
import { CredentialRenewer, type CredentialStatus } from "./credential.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_STREAM_TIMEOUT_MS,
  DEFAULT_CHUNK_TIMEOUT_MS,
  DEFAULT_TASK_MAX_LIFETIME_MS,
  DEFAULT_VOUCH_TTL_MS,
  EPHEMERAL_VOUCH_TTL_MS,
  MAX_CLOCK_SKEW_AHEAD_MS,
  MAX_CLOCK_SKEW_BEHIND_MS,
  MAX_MAILBOX_AGE_MS,
  MAILBOX_DRAIN_BATCH,
  MAILBOX_DRAIN_EXPIRES_MS,
  AMQP_MAILBOX_LIVE_WINDOW_MS,
  AMQP_MAILBOX_PREFETCH,
  DEFAULT_MAILBOX_DRAIN_INTERVAL_MS,
  MIN_MAILBOX_DRAIN_INTERVAL_MS,
  MAX_SEEN_INBOX_IDS,
  MAX_SEEN_EVENT_IDS,
  DEFAULT_MAX_INBOUND_CHARS,
  TASK_RECORD_TIMEOUT_MS,
  TASK_RECORD_RECHECK_MS,
  TASK_RECORD_POLL_MAX_MS,
  TASK_RECORD_POLL_FIRST_MS,
} from "./constants.js";
import { fenceInboundInput, inboundTextLength } from "./internal/fence.js";
import { cardText, fitCheck, inputNotUnderstood, isHelpQuestion, offeringsFromManifest } from "./input-fit.js";
import {
  Room,
  RoomsServiceSubjects,
  descriptorFromToken,
  type RoomDescriptor,
  type RoomHost,
  type OpenRoomOptions,
  type JoinRoomOptions,
  type MyRoom,
} from "./rooms.js";
import {
  putArtifact,
  fetchArtifact,
  statArtifact,
  removeArtifact,
  artifactUsage,
  artifactLink,
  type ArtifactHost,
  type ArtifactUsage,
  type ArtifactContent,
  type ArtifactLink,
  type ArtifactLinkOptions,
  type PutArtifactOptions,
  type StoredArtifact,
} from "./artifacts.js";
import {
  encryptionPublicFromSeed,
  isSealedPayload,
  openSealedPayload,
  resolveReplyKey,
  sealPayloadTo,
} from "./internal/sealed.js";
import { derivedSealing } from "./internal/sealing-posture.js";
import { AdmissionGate, readKnockInput, textOfInput, type AdmissionControl, type AdmissionOptions, type DescribeDocument, type SenderFacts } from "./admission.js";
import { describeDocumentOf } from "./interview.js";
import { registrarNameLookup } from "./naming-gate.js";
import { NoRecordCache, RESUME_HINT_FRESH_MS, ResumableTasks } from "./internal/resumable-tasks.js";
import {
  StorefrontAdopter,
  type StorefrontAdoption,
  type StorefrontPassResult,
} from "./storefront.js";

export type { StreamChunk };

/** The §8.12 members an agent may declare, in one place.
 *
 * Two callers need the same list and must not disagree about it: the manifest
 * builder, which spreads these at card level, and the storefront adopter, which
 * merges an owner's console edit into exactly these and nothing else. A member
 * the operator did not set is left off entirely, because an absent declaration
 * and an empty one are different statements (§8.12) and only one of them is
 * true here.
 */
const LISTING_MEMBERS = [
  "audience",
  "coverage",
  "edge",
  "acts",
  "serves",
  "parties",
  "origin",
] as const;

function listingDeclarations(opts: Partial<ListingDeclarations>): ListingDeclarations {
  const out: Record<string, unknown> = {};
  for (const k of LISTING_MEMBERS) {
    if (opts[k] !== undefined) out[k] = opts[k];
  }
  return out as ListingDeclarations;
}

/** The prefix core NATS mints request-reply subjects under (`createInbox`'s
 *  default, §18.7). A reply subject outside it was chosen by the publisher, not
 *  by the transport; see the exceptions in sendRespond, the one reply path
 *  that still answers on a transport reply subject. */
const INBOX_SUBJECT_PREFIX = "_INBOX.";
/** The same on the RabbitMQ binding: a reply address minted by the broker's
 *  direct reply-to (the AMQP transport, internal/amqp-connection.ts). */
const AMQP_REPLY_PREFIX = "amq.rabbitmq.reply-to.";
/** Whether a reply address was minted by the transport, on either binding. */
const isTransportReply = (reply: unknown): reply is string =>
  typeof reply === "string" && (reply.startsWith(INBOX_SUBJECT_PREFIX) || reply.startsWith(AMQP_REPLY_PREFIX));

/** "in 9d", "in 3h", "in 12m", "already expired" — for the one message an
 *  operator reads when a vouch renewal is failing and the clock matters. */
function humanizeLeft(ms: number): string {
  if (!Number.isFinite(ms)) return "expiry unknown";
  if (ms <= 0) return "already expired";
  if (ms >= 48 * 3_600_000) return `in ${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `in ${Math.round(ms / 3_600_000)}h`;
  return `in ${Math.max(1, Math.round(ms / 60_000))}m`;
}

export interface RequestResult {
  /** The responder-assigned Task ID when the interaction is in Task mode, or
   *  `null` for a bare (single terminal reply) response (§6.4, §7.0). */
  task_id: string | null;
  payload: RespondPayload;
  artifacts?: Artifact[];
  envelope: Envelope;
}

export interface StreamResult {
  task_id: string;
  /** The initial "working" response envelope. */
  initial_envelope: Envelope;
  /** Async iterable of stream chunks. Completes after the final chunk. */
  chunks: AsyncIterable<StreamChunk>;
}

export type EventHandler = (
  payload: EmitPayload,
  envelope: Envelope,
) => void;

/** Options for subscribe() (SPEC §18.6 Event Consumer). */
export interface SubscribeOptions {
  /** Any non-empty string opts this subscription into DURABLE delivery: a
   *  JetStream consumer on MESH_EVENTS that survives this process and resumes
   *  where it left off. The consumer's NAME is not this string: it is the
   *  §18.6 cross-SDK contract, `mesh_event_{agent_id}_{subscriptionHash}`,
   *  derived from the agent and the pattern so every SDK binds the same
   *  consumer. The string is the caller's own label for the subscription and
   *  goes nowhere on the wire. */
  durable?: string;
  /** Durable only. When the consumer does not exist yet, start it from
   *  everything MESH_EVENTS still holds (DeliverPolicy.All) instead of new
   *  events only. An EXISTING durable keeps its cursor regardless: replay
   *  shapes creation, never a resume. */
  replay?: boolean;
}

/** What the durable path of subscribe() returns. `stop()` ends this client's
 *  consume loop and NEVER deletes the durable consumer: the consumer is the
 *  server-side cursor, and a deleted one cannot be resumed. */
export interface DurableEventSubscription {
  /** The §18.6 consumer name on MESH_EVENTS this subscription is bound to. */
  durable: string;
  stop(): Promise<void>;
}

/** What the durable path of subscribeFeed() returns (§18.6 Feed Consumer).
 *  `stop()` ends this subscription's handler and, when it was the last one,
 *  this client's consume loop. It NEVER deletes the consumer or drops the
 *  feed from its filters: the consumer is the server-side cursor, and the
 *  next start of this agent picks up what arrived while it was away. */
export interface DurableFeedSubscription {
  /** The agent's one feed consumer on MESH_FEED, `mesh_feed_{agent_id}`. */
  durable: string;
  /** The feed subject (or `mesh.feed.{agent}.*` pattern) this subscription follows. */
  subject: string;
  stop(): Promise<void>;
}

/** The slice of a JetStream delivery the durable event loop reads. Structural
 *  on purpose: the fakes in the test suite implement exactly this. */
interface JsLikeMsg {
  data: Uint8Array;
  subject?: string;
  ack(): void;
  /** Hand the delivery back for redelivery after `millis` (feed consumer). */
  nak?(millis?: number): void;
}

/** The AMQP transport's durable consumer (internal/amqp-connection.ts), as
 *  the durable subscriptions reach it on a RabbitMQ mesh. */
interface AmqpLike {
  consume(
    queue: string,
    opts?: { bind?: string[]; prefetch?: number },
  ): Promise<{ stop(): void; bind(pattern: string): Promise<void>; [Symbol.asyncIterator](): AsyncIterator<JsLikeMsg> }>;
}

/** A delivery on the durable feed consumer whose feed no handler in this
 *  process follows (yet) is handed back after this long, so a process that
 *  subscribes its feeds one after another does not lose a delivery for one it
 *  has not reached; max_deliver bounds how often. */
const FEED_UNCLAIMED_NAK_MS = 5_000;

/** Whether a feed delivery subject matches a feed subscription pattern
 *  (`mesh.feed.{agent}.{topic}` exactly, or `mesh.feed.{agent}.*`). */
function feedSubjectMatches(pattern: string, subject: string): boolean {
  if (pattern === subject) return true;
  const p = pattern.split(".");
  const s = subject.split(".");
  return p.length === 4 && s.length === 4 && p[3] === "*" && p[0] === s[0] && p[1] === s[1] && p[2] === s[2];
}

/** One task update as delivered to an `onTaskUpdate` handler: the fields of
 *  the update that matter to a requester, with the verbatim signed envelope
 *  alongside for anything else. */
export interface TaskUpdate {
  task_id: string;
  /** The state the responder reports, when the update carries one. */
  status?: TaskState;
  /** Present ONLY when this update applied a NEW budget revision (§7.7
   *  latest-wins): a lower-or-equal revision is ignored and surfaced as no
   *  budget at all. `currentBudget(task_id)` always has the governing one. */
  budget?: Budget;
  message?: string;
  output?: unknown;
}

export type TaskUpdateHandler = (update: TaskUpdate, envelope: Envelope) => void;

/** One presence transition (§9.6): a node's heartbeat, as `trackPresence`
 *  surfaces it. The node is named by the SUBJECT token (§10.10), and only an
 *  envelope signed by that node's own key is surfaced. */
export interface PresenceTransition {
  node: string;
  availability: Availability;
  /** The verbatim signed heartbeat envelope. */
  envelope: Envelope;
}

/** What `trackPresence` returns: the snapshot read AFTER the transition
 *  subscription was live (§9.6 subscribe-before-snapshot), and the handle to
 *  stop watching. `snapshot` is null when no presence service answered —
 *  transitions still flow either way. */
export interface PresenceWatch {
  snapshot: unknown;
  stop(): void;
}

/** The two feed kinds (§6.6a), chosen by the feed's owner: a `state` feed is
 *  a current value (each publish replaces the last; late subscribers read the
 *  current value without replaying history), a `stream` feed is an ordered
 *  history. Nothing else is a kind. */
export type FeedKind = "state" | "stream";

/** What `trackFeed` returns: the current-value snapshot read AFTER the change
 *  subscription was live (§9.6 subscribe-before-snapshot, applied to feeds by
 *  §18.3), and the handle to stop watching. `snapshot` is null when the feed
 *  has never published or no feed-state service answered — changes still flow
 *  either way. */
export interface FeedWatch {
  snapshot: Envelope | null;
  stop(): void;
}

/** How many other-agent manifests this agent keeps at hand, for §14.4
 *  endpoint resolution and §6.4b pre-flight. Bounded like every other
 *  wire-fed memory; oldest-first eviction. */
const MANIFEST_CACHE_MAX = 512;

/** How long a resolved consumer OWNER is trusted before the registry is asked
 *  again. Five minutes: an agent's owner effectively never changes, and this
 *  keeps a busy seller from a registry round trip per request. */
const AGREEMENT_TTL_MS = 300_000;

/** Where the platform answers "has this account accepted my terms?" (§19.5).
 *  The seller is the verified envelope `from`; the answer is filtered to it. */
const AGREEMENT_LOOKUP_SUBJECT = "mesh.agreements.list";

/** Where the platform authorises a job against the buyer's balance, and where
 *  a hold that came to nothing is given back (the funds-hold contract). Same
 *  authorization model as the agreement lookup: the verified envelope `from`
 *  IS the seller, never a payload field. */
const FUNDS_HOLD_SUBJECT = "mesh.funds.hold";
const FUNDS_RELEASE_SUBJECT = "mesh.funds.release";

/** How many live holds are remembered at once, so a dispatch that never
 *  reaches a terminal statement (crash, a handler that hangs past the task
 *  lifetime) cannot leak one entry per request forever. First-seen eviction,
 *  the same shape as every other bounded ledger here. An evicted hold is not
 *  lost money: it falls through to the platform's expiry sweep, which is the
 *  backstop this whole mechanism keeps in reserve. */
const MAX_TRACKED_HOLDS = 1000;
/** Trial tasks remembered so late usage reports still meter as trial spend. */
const MAX_TRACKED_TRIAL_TASKS = 1000;

export class AgentMesh {
  private conn: ConnectionManager;
  private agentId: string;
  private kp: KeyPair;
  private nodeKp: KeyPair;
  private manifest: Manifest | null = null;
  private router = new OfferingRouter();
  private tasks = new TaskTracker();
  /** Other agents' manifests, as discovery returned them (§14.4, §6.4b):
   *  the resolution source for endpoint subjects and the declaration source
   *  for pre-flight limits. Populated by discover()/getManifest() — never by
   *  a per-send fetch, which §6.4b does not ask for: an unknown recipient is
   *  pre-flighted against the §22.5 defaults and addressed by construction,
   *  which the SDK is the legitimate constructor of. Bounded, oldest-first. */
  private manifestCache = new Map<string, Manifest>();
  private inboxSub: Subscription | null = null;
  private guarded = false;
  /** Whether the subject `listenInbox` ACTUALLY subscribed is the private
   *  `.guarded` one. Not the same thing as `guarded`: an agent that is already
   *  listening is not re-pointed by a second `register()`, so after a
   *  re-registration `guarded` can say "no" while the live subscription is
   *  still on `.guarded`. Only this field answers "can mail reach us on the
   *  public inbox?", which is the question the guard entry must agree with. */
  private listeningOnGuarded = false;
  private eventSubs: Subscription[] = [];
  /** Durable event subscriptions (§18.6), stopped (never deleted) on
   *  drain/close/detach; see DurableEventSubscription.stop. */
  private durableEventSubs: DurableEventSubscription[] = [];
  /** The one durable feed consumer's consume loop (§18.6 Feed Consumer) and
   *  the handlers it dispatches to, keyed by feed pattern. Bindings are
   *  serialized through `feedDurableChain` so two subscribeFeed calls never
   *  race an update of the consumer's filters. */
  private feedDurable: {
    handlers: Map<string, EventHandler>;
    messages: { stop(): void };
    loop: Promise<void>;
  } | null = null;
  private feedDurableChain: Promise<unknown> = Promise.resolve();
  /** One update subscription per Task this agent initiated (§6.5): budget
   *  revisions and progress arrive on `mesh.task.<id>.update`. Torn down when
   *  the task goes terminal, and wholesale on detach. */
  private taskUpdateSubs = new Map<string, Subscription>();
  /** Per watched Task: resolves when its update subscription is live on the
   *  broker (watchTaskUpdates). */
  private taskUpdateBound = new Map<string, Promise<void>>();
  /** Per watched Task still running after its first record read: the one
   *  later read (watchTaskUpdates). Cleared on unwatch and detach. */
  private taskRecheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private taskUpdateHandler: TaskUpdateHandler | null = null;
  /** SPEC.md §5.7: where messages written to this agent's person go
   *  (`onPersonMessage`), and whether the person lets the agent read them
   *  (`setPersonMessages`, off until the person turns it on). */
  private personHandler: PersonMessageHandler | null = null;
  private agentMayRead: AgentMayRead = false;
  /** Delegations (§10.8): sub-requests a handler issued for an inbound task,
   *  recorded via the ambient dispatch context. Parent task id → the offering
   *  that delegated (for the per-handler opt-out) and the still-live sub-task
   *  ids. Entries leave when a sub-task goes terminal, when the parent's
   *  cancel is propagated, and when the tracker prunes the sub-task. */
  private delegations = new Map<string, { offering: string; subs: Set<string> }>();
  private subToParent = new Map<string, string>();
  /** Feeds this agent declared (§6.6a): full feed subject → kind. What
   *  `buildManifest` publishes as the manifest `emits` field, so declarations
   *  made before register() land in the manifest and later ones take effect
   *  on the next (re-)registration. */
  private declaredFeeds = new Map<string, FeedKind>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private _closed = false;
  /** Standalone agents own their connection; node-hosted agents share the
   *  node's connection and must never close it (§4.1, one connection per node). */
  private ownsConnection: boolean;
  /** For node-hosted agents: the node's declared profile (§9.7), attached to
   *  register() when the caller doesn't supply one. */
  private defaultNodeProfile?: NodeDeclaredProfile;
  /** X25519 encryption secret (§4.3), if the agent declared one. */
  private encryptionSeed?: string;
  /** Where to look for a sender's published encryption key when the registry
   *  will not vouch for one (setEncryptionKeyFallback). Null: nowhere else. */
  private encryptionKeyFallback: ((agentId: string) => Promise<string | null | undefined>) | null = null;
  /** The mesh URL(s), retained so acl rooms can open a room-scoped second
   *  connection with a service-issued credential (§7.2). */
  private servers: string[] = [];
  /** §6.2 response binding: operator-configured expected responders, and the
   *  learned pins used when nothing was configured. */
  private serviceKeys: Record<string, string> = {};
  private configuredIntermediaries: Set<string> | null = null;
  private servicePins = new Map<string, string>();
  private intermediaryPin: string | null = null;
  private onSecurityWarning?: (w: SecurityWarning) => void;
  // ── inbound hardening (safety register 2.3, 2.9) ─────────────────────
  /** Whether inbound sender text is framed + fenced before a handler sees it.
   *  Default ON: the absence of a warning label is invisible, so opting out has
   *  to be the thing you say out loud (ConnectOptions.fenceInbound). */
  private fenceInbound = true;
  /** Whether the SDK answers help questions from the card and input that does
   *  not fit with the standard reply (input-fit.ts). Default ON; an embedder
   *  with its own layer (mesh-adapter) turns it off with setInputFit. */
  private inputFitEnabled = true;
  /** Cap on inbound sender text, in characters. 0 disables. */
  private maxInboundChars = DEFAULT_MAX_INBOUND_CHARS;
  // ── vouch renewal (§4.4) ─────────────────────────────────────────────
  /** The options this agent registered with, kept so a renewal can re-register
   *  the same manifest under a freshly signed vouch. Null until register(). */
  private registerOpts: RegisterOptions | null = null;
  /** Lifetime to mint each vouch with, and the basis for the renewal cadence. */
  private vouchTtlMs = DEFAULT_VOUCH_TTL_MS;
  /** True when the embedder chose a TTL; the declared-availability default
   *  logic below then never second-guesses it. */
  private vouchTtlExplicit = false;
  /** Wall-clock instant (ms) at which the current vouch is due for renewal, and
   *  the instant it actually lapses. Wall-clock on purpose: a suspended host
   *  wakes up and compares against the real clock (see internal/vouch.ts). */
  private vouchRenewAtMs: number | null = null;
  private vouchExpiresAtIso: string | null = null;
  private lastVouchError: string | null = null;
  /** Standalone agents own this loop. Node-hosted agents do NOT: their node runs
   *  one loop for every agent it vouches for (MeshNode.renewVouches). */
  private vouchTimer: TimerHandle | null = null;
  private vouchRenewalInFlight = false;
  // ── node-credential renewal (§4.8) ───────────────────────────────────
  /** The credential lease loop, or null when the embedder passed no
   *  `credentialRenewal` (a guest credential, or a host that drives its own
   *  `CredentialRenewer`). Separate from the vouch loop on purpose: the vouch
   *  is a claim ABOUT this agent that the registry enforces, the credential is
   *  what lets the connection exist at all, and they can lapse independently. */
  private credRenewer: CredentialRenewer | null = null;
  /** The storefront adopter, or null when the agent never asked for one
   *  (`RegisterOptions.storefrontProposals`). Armed at register() rather than
   *  at connect(), because there is nothing to merge an owner's edit INTO until
   *  this agent has a registration of its own. */
  private storefront: StorefrontAdopter | null = null;
  // ── EXT-8 owner allowance ────────────────────────────────────────────
  /** The armed allowance engine, or null (no allowance, no metering, no
   *  allowance admission). A document that fails verification still ARMS the
   *  engine — in the fail-closed state where every ceiling reads exhausted —
   *  because a broken policy treated as absent fails open on the owner's
   *  money (EXT-8 §1). */
  private allowance: AllowanceEngine | null = null;
  // ── trials (Common Agent 7.7) ────────────────────────────────────────
  /** How this node reads and counts trial requests (`setTrials`). */
  private trialOpts: TrialNodeOptions = {};
  private trialLedger: TrialLedger = new MemoryTrialLedger();
  /** dispatch task id → the trial it was admitted as. Its spend is metered
   *  as trial spend, and its task updates say `trial: true`. Bounded. */
  private trialTasks = new Map<string, TrialContext>();
  /** The Tasks this agent paused or deferred, and who asked for each: the
   *  only requests that resume one (resolveDispatchTask). */
  private readonly resumableTasks = new ResumableTasks();
  /** Who asked for each dispatch this agent ran under a task id: the only
   *  agent whose task.cancel for it is taken (cancelStanding). */
  private readonly dispatchOwners = new ResumableTasks();
  /** Task ids the task manager recently had no record of. */
  private readonly noRecord = new NoRecordCache();
  /** The §13.5 usage-receipt ledger: declared meter reports accumulated per
   *  task until the terminal respond attaches them as `payload.usage`. */
  private meterUsage = new MeterUsageLedger();
  /** §19.5 agreements this node holds, keyed by consumer owner. Verified at
   *  arm time; the platform is the store, this is the enforcing copy. */
  private agreements = new Map<string, AgreementDocument[]>();
  /** Optional host hook: fetch a consumer owner’s agreements on demand (the
   *  platform read). Results are cached for AGREEMENT_TTL_MS. */
  private agreementLookup: ((consumerOwner: string) => Promise<unknown[]>) | null = null;
  /** Optional host hooks: place and give back the funds hold that authorises a
   *  paid job against the buyer's balance (the funds-hold contract). Injectable
   *  exactly like `agreementLookup`, so the whole admit/refuse matrix is
   *  testable without a running platform. */
  private fundsHold: ((req: FundsHoldRequest) => Promise<unknown>) | null = null;
  private fundsRelease: ((holdId: string, reason: string) => Promise<void>) | null = null;
  /** dispatch task id → the hold placed for it. The seller's memory of what it
   *  owes back: a task that fails or is abandoned releases its hold, a
   *  delivered one leaves it standing for the platform's draw. Bounded by
   *  MAX_TRACKED_HOLDS. */
  private taskHolds = new Map<string, string>();
  /** agent id → owner key (§8.6), cached: the account an agreement covers. */
  private ownerOf = new Map<string, { at: number; owner: string | null }>();
  /** sku id → its current digest (§19.1), computed once per registration. */
  private skuDigests = new Map<string, string>();
  /** Where a human approves terms when the SKU names no checkout_url. */
  private approvalUrl: string | null = null;
  /** The host's owner channel for `on_exhausted: "ask_owner"` (EXT-8 §2). The
   *  SDK cannot email anyone: it holds the work unstarted and asks the host.
   *  Unset, an ask_owner exhaustion refuses like `refuse` does — holding work
   *  with nobody to ask would just hang the caller into its timeout. */
  private allowanceAskOwner: AllowanceAskOwnerHandler | null = null;
  /** Host-supplied estimator for incoming work, in tokens. Default:
   *  ceil(sender-text chars / 4). */
  private allowanceEstimator: AllowanceEstimator | null = null;
  /** §13.1.1: publish `span_completed` events. Off until an operator says so. */
  private spansEnabled = false;
  private spansDropped = 0;
  /** The naming rule (naming-gate.ts): set when the agent connected with
   *  `requireNamed`, and then every send this agent originates asks it first. */
  private namingGate: NamingGate | null = null;
  /** §5.3: senders whose key the registry says is revoked are refused before
   *  their request is handled (revoked-senders.ts). Null when the host turned
   *  it off (`refuseRevokedSenders: false`). */
  private revokedSenders: RevokedSenders | null = new RevokedSenders((k) => this.registryRevocation(k));

  private constructor(
    conn: ConnectionManager,
    agentId: string,
    kp: KeyPair,
    nodeKp: KeyPair,
    ownsConnection = true,
    defaultNodeProfile?: NodeDeclaredProfile,
  ) {
    this.conn = conn;
    this.agentId = agentId;
    this.kp = kp;
    this.nodeKp = nodeKp;
    this.ownsConnection = ownsConnection;
    this.defaultNodeProfile = defaultNodeProfile;

    // Auto-prune every 60s: terminal tasks after 5 minutes, tasks a responder
    // never finished after their maximum lifetime (§6.10 — only terminal tasks
    // used to be pruned, so an unfinished one lived forever).
    this.pruneTimer = setInterval(() => {
      this.tasks.prune(300_000, DEFAULT_TASK_MAX_LIFETIME_MS);
      // Delegation records ride the tracker's lifetime: a pruned sub-task has
      // nothing left to cancel, so its delegation entry goes too (§10.8).
      for (const subId of this.subToParent.keys()) {
        if (!this.tasks.has(subId)) this.forgetDelegation(subId);
      }
    }, 60_000);
  }

  /** @internal Create an agent hosted by a MeshNode over its shared connection.
   *  The node key holds the connection; this agent gets its own keypair and is
   *  vouched by the node (§4.4). Used by MeshNode.addAgent — not public API. */
  static hostedBy(
    conn: ConnectionManager,
    nodeKp: KeyPair,
    opts?: {
      nkeySeed?: string | Uint8Array;
      /** X25519 encryption secret (§4.3), as `connect()` takes it. Publishes
       *  `encryption_key` at register, opens sealed inbound and seals the
       *  answer back (§8.9). A node keeps one per hosted agent and hands each
       *  agent its own, so a payload sealed to one agent opens on that agent
       *  and on no other agent the node holds. */
      encryptionSeed?: string;
      nodeProfile?: NodeDeclaredProfile;
      /** The node's warning sink. Without this a hosted agent has no channel at
       *  all for a failed vouch renewal or a changed service key. */
      onSecurityWarning?: (w: SecurityWarning) => void;
      vouchTtlMs?: number;
      /** Inbound framing/cap and the §16.4 re-drain cadence, inherited from the
       *  node's transport options so a node-hosted agent is guarded — and keeps
       *  its mailbox cursor at the head — exactly like a standalone one. */
      fenceInbound?: boolean;
      maxInboundChars?: number;
      mailboxDrainIntervalMs?: number;
      /** §5.3 revoked-sender refusal, as `connect()` takes it. */
      refuseRevokedSenders?: boolean;
      /** The node's mesh URL(s), for an acl room's scoped second connection
       *  only. See `MeshNode`'s `servers`. */
      servers?: string[];
      /** Publish `span_completed` events to `mesh.trace.>` (§13.1.1).
       *  Off unless an operator turns it on: trace PROPAGATION is always on and
       *  free, but producing a durable record of who this agent talked to is a
       *  different act and wants a decision. */
      emitSpans?: boolean;
      /** Where the server's HTTPS doors are (ConnectOptions.platformApi). */
      platformApi?: string;
    },
  ): AgentMesh {
    const seedBytes =
      opts?.nkeySeed === undefined
        ? undefined
        : typeof opts.nkeySeed === "string"
          ? new TextEncoder().encode(opts.nkeySeed)
          : opts.nkeySeed;
    const kp = seedBytes ? nkeys.fromSeed(seedBytes) : nkeys.createUser();
    const mesh = new AgentMesh(conn, kp.getPublicKey(), kp, nodeKp, false, opts?.nodeProfile);
    // Hosted agents share the node's connection for everything on `mesh.*`.
    // These are dialled only for an acl room's scoped second connection, which
    // no shared connection can carry.
    mesh.servers = opts?.servers ?? [];
    const implied = addressesFromBroker(mesh.servers);
    mesh.platformApi = opts?.platformApi ?? implied.api;
    mesh.registrarUrl = implied.naming;
    mesh.encryptionSeed = opts?.encryptionSeed;
    mesh.onSecurityWarning = opts?.onSecurityWarning;
    if (opts?.vouchTtlMs !== undefined) { mesh.vouchTtlMs = opts.vouchTtlMs; mesh.vouchTtlExplicit = true; }
    mesh.spansEnabled = opts?.emitSpans === true;
    mesh.applyInboundOptions(opts);
    return mesh;
  }

  /** @internal Construct a standalone agent over an existing connection (tests,
   *  embedders) — the counterpart to MeshNode.withConnection. `nodeKp` defaults
   *  to the agent's own key, which is the self-hosting case §4.4 allows. */
  static withConnection(
    conn: ConnectionManager,
    kp: KeyPair,
    nodeKp?: KeyPair,
    opts?: {
      vouchTtlMs?: number;
      onSecurityWarning?: (w: SecurityWarning) => void;
      fenceInbound?: boolean;
      maxInboundChars?: number;
      mailboxDrainIntervalMs?: number;
      /** §5.3 revoked-sender refusal, as `connect()` takes it. */
      refuseRevokedSenders?: boolean;
      /** X25519 encryption secret (§4.3), as `connect()` takes it: publishes
       *  `encryption_key` at register, opens sealed inbound and seals the
       *  answer back (§8.9). Omitted here until now, which quietly made this
       *  construction path the only one that could not participate in sealing. */
      encryptionSeed?: string;
      /** The node's mesh URL(s), for an acl room's scoped second connection
       *  only. See `MeshNode`'s `servers`. */
      servers?: string[];
      /** §13.1.1 span emission. Off unless set. */
      emitSpans?: boolean;
      /** The naming rule, as `connect()` takes it. There is no await here,
       *  so the first check starts in the background: an async send waits for
       *  it, and a synchronous one goes on the answer once there is one. */
      requireNamed?: boolean | RequireNamedOptions;
    },
  ): AgentMesh {
    const mesh = new AgentMesh(conn, kp.getPublicKey(), kp, nodeKp ?? kp, true);
    mesh.namingGate = namingGateFor(kp.getPublicKey(), opts?.requireNamed);
    if (mesh.namingGate) void mesh.namingGate.check();
    mesh.onSecurityWarning = opts?.onSecurityWarning;
    mesh.encryptionSeed = opts?.encryptionSeed;
    if (opts?.vouchTtlMs !== undefined) { mesh.vouchTtlMs = opts.vouchTtlMs; mesh.vouchTtlExplicit = true; }
    mesh.spansEnabled = opts?.emitSpans === true;
    mesh.applyInboundOptions(opts);
    return mesh;
  }

  /** The one place inbound framing, the inbound cap and the mailbox re-drain
   *  cadence are read from options, shared by all three construction paths so
   *  none of them can quietly ship a different default. `undefined` means "not
   *  asked for", which for framing is ON — an omitted option must never be the
   *  unguarded one. The drain interval is clamped rather than trusted: `0` would
   *  be a busy loop against the broker's JetStream API. */
  private applyInboundOptions(opts?: {
    fenceInbound?: boolean;
    maxInboundChars?: number;
    mailboxDrainIntervalMs?: number;
    refuseRevokedSenders?: boolean;
  }): void {
    if (opts?.fenceInbound !== undefined) this.fenceInbound = opts.fenceInbound;
    if (opts?.refuseRevokedSenders === false) this.revokedSenders = null;
    if (opts?.maxInboundChars !== undefined && Number.isFinite(opts.maxInboundChars)) {
      this.maxInboundChars = Math.max(0, Math.floor(opts.maxInboundChars));
    }
    if (
      opts?.mailboxDrainIntervalMs !== undefined &&
      Number.isFinite(opts.mailboxDrainIntervalMs)
    ) {
      this.mailboxDrainIntervalMs = Math.max(
        MIN_MAILBOX_DRAIN_INTERVAL_MS,
        Math.floor(opts.mailboxDrainIntervalMs),
      );
    }
  }

  /** Turn the input-fit layer on or off (default on). An embedder that runs
   *  its own copy of the layer, with admission in front of it, turns this one
   *  off so a message is judged once. */
  setInputFit(opts: { enabled: boolean }): void {
    this.inputFitEnabled = opts.enabled !== false;
  }

  /**
   * Input this agent cannot use, answered before any handler runs. Returns
   * true when it answered. Three cases, all read off this agent's own
   * registered manifest:
   *
   *  - a help question on `chat` is answered from the card, with no model;
   *  - `chat` with no chat handler gets the standard reply naming the
   *    offerings and what each takes (it was OFFERING_NOT_FOUND, which told a
   *    person nothing they could act on);
   *  - a structured input to a declared offering whose input schema lists a
   *    required member the input lacks gets the standard reply naming it.
   *
   * Everything else goes to the handler as before.
   */
  private answerInputFit(msg: Msg, env: Envelope, reqPayload: RequestPayload, viaReply: boolean, dispatchTaskId: string): boolean {
    const offerings = offeringsFromManifest(this.manifest);
    if (!offerings.length) return false;
    const raw = reqPayload.input as unknown;
    const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const text = typeof raw === "string" ? raw : typeof obj?.text === "string" ? obj.text : typeof obj?.prompt === "string" ? obj.prompt : "";
    const name = String(this.manifest?.name ?? "This agent");
    const reply = (payload: RespondPayload, error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }) => {
      const e = this.newEnvelope({
        type: "respond",
        from: this.agentId,
        to: env.from,
        in_reply_to: env.id,
        task_id: env.task_id,
        trace: childSpan(env.trace),
        payload,
        ...(error ? { error } : {}),
      });
      if (error) this.releaseHold(dispatchTaskId, FundsReleaseReason.REJECTED);
      this.sendRespond(msg, env, encode(e), { transportReply: viaReply, tap: true });
      return true;
    };
    const offering = reqPayload.offering;
    const declared = offerings.filter((o) => o.id !== "chat");
    if (offering === "chat" && isHelpQuestion(text)) {
      const card = cardText({ name, does: String(this.manifest?.description ?? ""), offerings: declared.length ? declared : offerings });
      return reply({ status: "completed", output: { text: card, grade: "declared" } });
    }
    const handler = this.router.resolve(offering);
    if (!handler && offering === "chat" && declared.length) {
      const fit = fitCheck({ offerings: declared, text });
      const r = inputNotUnderstood({
        agent: name, offerings: declared, offering: fit.offering,
        reason: fit.reason ?? "missing_input", missing: fit.missing,
      });
      return reply({ status: "failed", output: { text: r.text } }, r.error);
    }
    if (handler && offering !== "chat" && obj) {
      const o = offerings.find((x) => x.id === offering);
      const required = (o?.inputs ?? []).filter((i) => i.required);
      if (o && required.length) {
        const missing = required.filter((i) => obj[i.name] === undefined || obj[i.name] === null || obj[i.name] === "").map((i) => i.name);
        if (missing.length) {
          const r = inputNotUnderstood({ agent: name, offerings, offering: o, reason: "missing_input", missing });
          return reply({ status: "failed", output: { text: r.text } }, r.error);
        }
      }
    }
    return false;
  }

  /** Build an envelope and sign it with this agent's key (§4.5, always-sign).
   *  Meta from `setOutgoingMeta` rides underneath the caller's own. */
  private newEnvelope(params: Parameters<typeof createEnvelope>[0]): Envelope {
    const stamped = this.outgoingMeta?.();
    const p = stamped ? { ...params, meta: { ...stamped, ...(params.meta ?? {}) } } : params;
    return signEnvelope(createEnvelope(p), this.kp);
  }

  private outgoingMeta: (() => Record<string, unknown> | undefined) | null = null;

  /**
   * Stamp meta on every envelope this agent signs from now on, asked afresh
   * each time. For a key holder serving several places at once (SPEC §4.11
   * form 1): the function reads which place the current call came through
   * and returns `{ via: … }`, or undefined for none. The caller's own meta
   * keys win over the stamped ones. Pass null to stop.
   */
  setOutgoingMeta(fn: (() => Record<string, unknown> | undefined) | null): void {
    this.outgoingMeta = fn;
  }

  /**
   * Connect to the mesh. The agent always has an Ed25519 keypair (from
   * `opts.nkeySeed`, else freshly generated) — its public nkey is the agent ID,
   * and it signs every envelope it sends (§4.5). A node keypair (`opts.nodeSeed`,
   * else the agent key for self-hosting) vouches for the agent (§4.4).
   */
  static async connect(
    servers: string | string[],
    opts?: Omit<ConnectOptions, "servers">,
  ): Promise<AgentMesh> {
    // Seeds may arrive as the base32 string the auth service returns (e.g.
    // "SUA…") or as raw bytes. Normalize to bytes for nkeys.
    const toSeedBytes = (s?: string | Uint8Array): Uint8Array | undefined =>
      s === undefined ? undefined : typeof s === "string" ? new TextEncoder().encode(s) : s;
    const seedBytes = toSeedBytes(opts?.nkeySeed);
    const nodeSeedBytes = toSeedBytes(opts?.nodeSeed);

    // If a JWT + seed were supplied (e.g. a guest credential) and no explicit
    // authenticator, wire up JWT auth so the guarded connection is accepted.
    const connectOpts: ConnectOptions = { servers, ...opts };
    if (opts?.jwt && seedBytes && !opts.authenticator) {
      connectOpts.authenticator = jwtAuthenticator(opts.jwt, seedBytes);
    }
    const conn = await ConnectionManager.connect(connectOpts);

    const kp = seedBytes ? nkeys.fromSeed(seedBytes) : nkeys.createUser();
    const agentId = kp.getPublicKey();
    const nodeKp = nodeSeedBytes ? nkeys.fromSeed(nodeSeedBytes) : kp;

    // EXT-1: a standalone agent is its own node — attach auto-detected device
    // attributes (platform, client) as its default declared profile.
    const mesh = new AgentMesh(conn, agentId, kp, nodeKp, true, withDetectedDevice());
    mesh.encryptionSeed = opts?.encryptionSeed;
    mesh.servers = Array.isArray(servers) ? servers : [servers];
    mesh.serviceKeys = opts?.serviceKeys ?? {};
    // Where the server's HTTPS doors and its naming service are, when the
    // caller does not say: the address the agent enrolled against, the
    // environment, then the broker's own domain (am-env.generated.ts).
    const implied = addressesFromBroker(mesh.servers);
    mesh.platformApi = opts?.platformApi ?? opts?.credentialRenewal?.apiBase ?? AM_URL_API ?? implied.api;
    mesh.platformKey = opts?.platformKey;
    mesh.operatorKey = opts?.operatorKey;
    const namedExplicitly = (typeof opts?.requireNamed === "object" ? opts.requireNamed.registrar : undefined) ?? AM_URL_NAMING;
    mesh.registrarUrl = namedExplicitly ?? implied.naming;
    mesh.configuredIntermediaries = opts?.intermediaryKeys
      ? new Set(opts.intermediaryKeys)
      : null;
    mesh.onSecurityWarning = opts?.onSecurityWarning;
    if (opts?.vouchTtlMs !== undefined) { mesh.vouchTtlMs = opts.vouchTtlMs; mesh.vouchTtlExplicit = true; }
    // §13.1.1. Missing here in 0.43.0, which was worse than not offering it:
    // ConnectOptions declared emitSpans, so a caller could set it, typecheck
    // clean, and get silence. hostedBy and withConnection honoured it; the one
    // path the reference adapter actually uses did not.
    mesh.spansEnabled = opts?.emitSpans === true;
    mesh.applyInboundOptions(opts);
    // §4.8: the credential is a lease too. Started here rather than at
    // register() — an agent that only sends still needs a live credential, and
    // an agent that never registers still has one to keep alive.
    const cr = opts?.credentialRenewal;
    if (cr) {
      // Renewal needs the credential it is renewing, and `jwt` is the only
      // place it can come from. This used to be `if (cr && opts?.jwt)`, which
      // meant a caller who passed an explicit `authenticator` instead of `jwt`
      // configured a renewal loop that never ran and never said so. That is
      // exactly the bootstrap shape the quickstart recommends: the credential
      // is bound to its own key, so the authenticator is spelled out, and the
      // easy mistake is to then leave `jwt` off. Passing both is correct and
      // costs nothing, because an explicit authenticator always wins above.
      if (!opts?.jwt) {
        throw new Error(
          "credentialRenewal needs the credential it renews: pass `jwt` as well, even when you " +
            "also pass an explicit `authenticator` (the authenticator still wins for the connection)",
        );
      }
      const credSeed = cr.credentialSeed ?? opts.nkeySeed;
      if (credSeed === undefined) {
        throw new Error(
          "credentialRenewal needs the seed of the key the JWT is bound to — pass credentialSeed, " +
            "or nkeySeed when the credential was minted against the agent's own key",
        );
      }
      mesh.credRenewer = new CredentialRenewer({
        apiBase: cr.apiBase,
        jwt: opts.jwt,
        nodeSeed: credSeed,
        agents: [{ id: agentId, seed: kp.getSeed(), ...(cr.proof ? { proof: cr.proof } : {}) }],
        onRenewed: cr.onRenewed,
        onWarning: (w) => mesh.onSecurityWarning?.(w as SecurityWarning),
      });
      mesh.credRenewer.start();
    }
    // The naming rule: asked once now, so the first send (and a send that
    // cannot wait, like emit) has an answer to go on. Left out, it follows
    // what the server says it offers: on when it offers naming, off when it
    // says it does not, and on whenever a naming service is known when it
    // cannot be asked. A naming service only implied by the broker's domain
    // is forgotten when the server says it offers none.
    const ask = opts?.requireNamed === undefined || (!namedExplicitly && !!mesh.registrarUrl);
    const offered = ask ? await mesh.namingOffered() : undefined;
    if (offered === false && !namedExplicitly) mesh.registrarUrl = undefined;
    const rule = opts?.requireNamed ?? (offered === false ? false : !!mesh.registrarUrl);
    mesh.namingGate = namingGateFor(agentId, rule, mesh.registrarUrl);
    if (mesh.namingGate) await mesh.namingGate.check();
    return mesh;
  }

  // ─── The naming rule ───────────────────────────────────────────────

  /** Where this agent stands under the naming rule, as last checked: named
   *  (with its handle) or not. Null when the agent did not connect with
   *  `requireNamed`, or before the first check. */
  namingStatus(): NamingStatus | null {
    return this.namingGate?.current() ?? null;
  }

  /** Ask the naming service again now, forgetting the cached answer: call it
   *  after naming the agent (completeNaming) so it can send at once. */
  async recheckName(): Promise<NamingStatus | null> {
    if (!this.namingGate) return null;
    this.namingGate.forget();
    return this.namingGate.check();
  }

  // ─── Response binding (§6.2) ───────────────────────────────────────

  /**
   * Bind a request-reply response to the request it claims to answer.
   *
   * `decode()` proves only that SOMEBODY's key signed these bytes, and core
   * NATS resolves a request with the first message that reaches the muxed
   * inbox. Nothing connected the two, so any party that could observe a request
   * and publish to an `_INBOX.` subject answered first and had its payload,
   * `task_id` and `context_id` returned to the caller as the addressed agent's
   * answer. Three checks, in order of how much they can be trusted to know:
   *
   * 1. `in_reply_to` MUST equal the request's `id`. This one holds on every
   *    path, including the ones where the responder's key is unknowable in
   *    advance, and it alone defeats racing a reply blind.
   * 2. `to`, when present, MUST be us. A reply captured from someone else's
   *    exchange cannot be re-aimed.
   * 3. `from` MUST be the party we addressed, where we know who that is.
   *    Where we do not — the platform services — see the pin machinery below.
   */
  private bindResponse(
    respEnv: Envelope,
    request: Envelope,
    expected: { agent?: string; subject?: string },
  ): void {
    if (respEnv.in_reply_to !== request.id) {
      throw new MeshError(
        ErrorCode.IDENTITY_MISMATCH,
        `Response is not bound to this request: in_reply_to=${respEnv.in_reply_to ?? "(absent)"} ` +
          `does not match the request id, so it did not answer it (§6.2)`,
        { details: { from: respEnv.from } },
      );
    }
    if (respEnv.to !== undefined && respEnv.to !== this.agentId) {
      throw new MeshError(
        ErrorCode.IDENTITY_MISMATCH,
        `Response was addressed to ${respEnv.to}, not to this agent`,
        { details: { from: respEnv.from } },
      );
    }
    if (expected.agent !== undefined && respEnv.from !== expected.agent) {
      this.requirePinnedIntermediary(respEnv.from, expected.agent);
    } else if (expected.subject !== undefined) {
      this.checkServiceKey(expected.subject, respEnv.from);
    }
  }

  /** A third party answered for an agent. That is legitimate exactly once in
   *  the protocol — EXT-6 admission replies with a benign ack when a guarded
   *  agent's inbox drops the sender or the agent is too slow — and the SDK
   *  cannot tell that service's key from an impostor's, because nothing
   *  publishes the platform's service keys (see ConnectOptions.serviceKeys).
   *  So: an explicit allow-list if the operator configured one, otherwise the
   *  FIRST such key becomes the intermediary for this connection's lifetime and
   *  any later disagreement is refused. Pin-on-first-use narrows "any agent on
   *  the mesh may answer for any other" to "one key may, and you were told
   *  which"; it does not close the race for the very first ack. */
  private requirePinnedIntermediary(from: string, forAgent: string): void {
    if (this.configuredIntermediaries) {
      if (!this.configuredIntermediaries.has(from)) {
        throw new MeshError(
          ErrorCode.IDENTITY_MISMATCH,
          `${from} answered for ${forAgent} but is not a configured mesh intermediary (§6.2)`,
        );
      }
      return;
    }
    if (this.intermediaryPin === null) {
      this.intermediaryPin = from;
      this.onSecurityWarning?.({
        code: "intermediary_pinned",
        message:
          `${from} answered a request addressed to ${forAgent}; pinned as this connection's ` +
          `mesh intermediary. Only this key may answer for an agent from now on.`,
        subject: forAgent,
        from,
      });
      return;
    }
    if (this.intermediaryPin !== from) {
      throw new MeshError(
        ErrorCode.IDENTITY_MISMATCH,
        `${from} answered for ${forAgent}, but this connection's mesh intermediary is ` +
          `${this.intermediaryPin} (§6.2)`,
      );
    }
  }

  /** The `from` on a service reply is the SERVICE's key. When the operator
   *  configured it, a mismatch is refused. When not, we pin what answered and
   *  report a change — but still accept, because every platform service derives
   *  its key from an optional seed no deployment sets today, so the key rotates
   *  on restart and refusing would turn a service deploy into a mesh outage.
   *  This half of §6.2 is therefore change DETECTION until the seeds are
   *  pinned; `in_reply_to` and `to` are what actually hold on this path. */
  private checkServiceKey(subject: string, from: string): void {
    const configured = this.serviceKeys[subject];
    if (configured !== undefined) {
      if (configured !== from) {
        throw new MeshError(
          ErrorCode.IDENTITY_MISMATCH,
          `${subject} was answered by ${from}, not by the configured service key (§6.2)`,
        );
      }
      return;
    }
    const pinned = this.servicePins.get(subject);
    if (pinned === undefined) {
      this.servicePins.set(subject, from);
      return;
    }
    if (pinned !== from) {
      this.servicePins.set(subject, from);
      this.onSecurityWarning?.({
        code: "service_key_changed",
        message:
          `${subject} is now answered by ${from} (was ${pinned}). Expected after a service ` +
          `restart while the service signing seeds are unset; otherwise investigate.`,
        subject,
        from,
        previous: pinned,
      });
    }
  }

  /** This agent's unique ID. */
  get id(): string {
    return this.agentId;
  }

  /** @internal Detached Ed25519 signature over `message` by this agent's key,
   *  standard base64.
   *
   *  Exists for one caller: a `MeshNode` assembling the per-agent consent lines
   *  of a node-credential request (§4.8). The node must prove every hosted
   *  agent agreed to be hosted, and the alternative — handing the node each
   *  agent's seed — would put the key material somewhere it does not need to
   *  be. Not general-purpose signing: use `signEnvelope`/`signTagged` for
   *  anything protocol-shaped, which are domain-tagged and this is not. */
  signDetached(message: string): string {
    const sig = this.kp.sign(new TextEncoder().encode(message));
    let bin = "";
    for (const b of sig) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  /** Whether this agent has registered with the mesh. */
  get registered(): boolean {
    return this.manifest !== null;
  }

  // ─── Primitive 1: Register ─────────────────────────────────────────

  /** Register this agent with the mesh, making it discoverable. */
  async register(opts: RegisterOptions): Promise<Manifest> {
    // SPEC.md §5.7: declare `mesh://extensions/audience/v1` only when this
    // agent can reach its person, which here means a person surface is
    // registered. The SDK keeps the receiver rules on every path it owns.
    if (opts.personMessages === true) {
      if (!this.personHandler) {
        throw new MeshError(
          ErrorCode.INVALID_MANIFEST,
          "personMessages: true declares that messages for this agent's person reach that person (SPEC §5.7), " +
            "so register a person surface with onPersonMessage() first.",
        );
      }
      const others = (opts.extensions ?? []).filter((e) => e.uri !== AUDIENCE_EXTENSION_URI);
      opts = { ...opts, extensions: [...others, { ...AUDIENCE_DECLARATION }] };
    } else if (opts.extensions?.some((e) => e.uri === AUDIENCE_EXTENSION_URI) && !this.personHandler) {
      throw new MeshError(
        ErrorCode.INVALID_MANIFEST,
        "The audience extension says messages for this agent's person reach that person (SPEC §5.7), " +
          "so register a person surface with onPersonMessage() before declaring it.",
      );
    }
    const manifest = await this.buildManifest(opts);
    await this.sendRegister(manifest);

    this.manifest = manifest;
    // Copied, not aliased, so a renewal months later re-registers what the agent
    // actually registered rather than whatever the caller's object has become.
    this.registerOpts = { ...opts };
    this.noteVouch(manifest);
    // EXT-6 §7.1: ask the admission service to guard this inbox, and switch to
    // the private `.guarded` subject only on an explicit ok (see requestGuard).
    if (opts.guarded) this.guarded = await this.requestGuard();
    this.listenInbox();
    // The other half of that handshake. `requestGuard` is deliberately strict —
    // a rate-limited refusal, no responders, a timeout, the guard ceiling, or the
    // benign `{queued:true}` receipt all mean NOT guarded — and on any of those
    // this agent is now listening on its PUBLIC inbox. The mesh, meanwhile, may
    // still hold a guard entry for this key from a previous run: the entry is
    // written on guard and, until now, nothing ever revoked it. That leaves guard
    // state and reality disagreeing in the two worst directions at once — the
    // admission service relays this agent's mail to a private subject nobody is
    // listening on, and the registry points its offline mailbox at that same
    // subject, while every message that arrives on the public inbox reaches the
    // handler unfiltered because the filter the entry promises is not running.
    // So say so, out loud, and let the mesh drop the entry.
    if (opts.guarded && !this.listeningOnGuarded) await this.revokeGuard();
    // §16.4 offline delivery: registered agents may have a mailbox (a
    // per-agent JetStream buffer) holding messages sent while they were
    // offline. Bind its consumer and drain — silently a no-op when the mesh
    // provides no buffer (sandbox agents, older deployments) or the
    // credential can't reach the JetStream API. Re-run on every reconnect and
    // on an interval thereafter, because a single bounded pass leaves the tail
    // unacked and replayed on the next restart (see startOfflineDrain).
    const firstPass = this.startOfflineDrain();
    // On the RabbitMQ binding nothing keeps a message on the inbox subject but
    // a queue bound to it, so register() resolves only once the inbox is in
    // place: the mailbox consumer attached, or, with no mailbox, the live
    // subscription bound. A caller that is sent a request the moment this
    // returns then has it handed over at once (binding document §6.1). On
    // NATS the mailbox stream captures the subject, and the pass (which may be
    // draining a backlog) is not waited for.
    if (this.conn.binding === "amqp") await this.amqpInboxReady(firstPass);
    // Node-hosted agents don't heartbeat individually — one heartbeat from the
    // node covers all its agents (§9.6); MeshNode owns that loop. Same split for
    // vouch renewal: the node re-vouches every agent it holds (§4.4), so a
    // hosted agent must not run its own renewal loop.
    if (this.ownsConnection) {
      this.startHeartbeat();
      this.startVouchRenewal();
    }
    // §8.7/§8.12: adopt what the owner edits in the console. Started here and
    // not at connect() because the adopter merges into a registration, and
    // started for hosted agents too: a listing belongs to an agent key, and a
    // node hosting ten agents may have ten owners' edits waiting.
    this.startStorefrontAdoption(opts);
    return manifest;
  }

  /**
   * Arm the storefront adopter for this registration, replacing any previous
   * one.
   *
   * Re-registering with `storefrontProposals` unset STOPS the loop rather than
   * leaving the old one running. An agent that stopped asking to be listed by
   * its owner should stop being listed by its owner, and a background loop that
   * outlives the option that created it is the kind of thing nobody finds until
   * they are reading a control plane's access log.
   */
  private startStorefrontAdoption(opts: RegisterOptions): void {
    this.storefront?.stop();
    this.storefront = null;
    const cfg = opts.storefrontProposals;
    if (!cfg) return;
    this.storefront = new StorefrontAdopter({
      apiBase: cfg.apiBase,
      agentKey: this.agentId,
      seed: this.kp.getSeed(),
      pollIntervalMs: cfg.pollIntervalMs,
      onAdopted: cfg.onAdopted,
      fetchImpl: cfg.fetchImpl,
      // Read fresh at every pass: this agent may have re-registered for its own
      // reasons since the last one, and merging into a stale copy would
      // resurrect whatever it had just changed.
      current: () => ({
        public: this.registerOpts?.public,
        listing: this.registerOpts ? listingDeclarations(this.registerOpts) : undefined,
      }),
      // Adoption is a re-registration under this agent's own key. Carried into
      // `registerOpts` first so the vouch renewal months from now re-registers
      // the owner's words rather than the ones the process started with.
      apply: async (adoption) => {
        if (!this.registerOpts) throw new Error("this agent is no longer registered");
        if (!adoption.changed.length) return;
        this.registerOpts = {
          ...this.registerOpts,
          ...(adoption.public ? { public: adoption.public } : {}),
          ...(adoption.listing ?? {}),
        };
        await this.renewVouch();
      },
      onWarning: (w) => this.onSecurityWarning?.(w as SecurityWarning),
    });
    this.storefront.start();
  }

  /**
   * Ask now whether the owner has edited this agent's listing, and adopt it if
   * so. Returns what the pass did.
   *
   * Nothing to call on a healthy agent: `register()` arms the loop when
   * `storefrontProposals` is set, and the loop takes a pass immediately and
   * then every minute. This exists for a host that would rather drive the check
   * on its own clock (a webhook from the console, a SIGHUP, a test), and it
   * throws only when the agent never asked for adoption at all, because
   * silently doing nothing would be indistinguishable from adopting nothing.
   */
  async adoptStorefront(): Promise<StorefrontPassResult> {
    if (!this.storefront) {
      throw new Error(
        "adoptStorefront(): this agent registered without storefrontProposals, so there is " +
          "nowhere to fetch an owner's listing edit from",
      );
    }
    return this.storefront.adoptOnce();
  }

  /** Build the manifest to register: a fresh node vouch (§4.4) and a fresh
   *  manifest key claim (§8.3) every time, so this is also exactly what a
   *  renewal sends. */
  private async buildManifest(opts: RegisterOptions): Promise<Manifest> {
    // §19.1: refuse a malformed SKU at registration, where the operator can
    // see it — not at some later discovery read.
    if (opts.skus !== undefined) validateSkus(opts.skus);
    // §19.5: cache each SKU's current digest — the identity an agreement binds
    // to, recomputed only when a registration changes the terms.
    this.skuDigests.clear();
    // New terms make every held agreement stale by definition (§19.5), so
    // drop what we hold rather than carry acceptances of a price that no
    // longer exists.
    this.agreements.clear();
    for (const s of opts.skus ?? []) this.skuDigests.set(s.sku, await skuDigest(s));
    // A paid SKU with nowhere to approve cannot be enforced: refusing a buyer
    // with a dead end is worse than taking the work. Say so rather than
    // silently doing one or the other.
    const unenforceable = (opts.skus ?? []).filter(
      (s) => s.price.model !== "free" && !s.provider.checkout_url && !this.approvalUrl,
    );
    if (unenforceable.length) {
      console.warn(
        `[agentmesh] ${unenforceable.length} paid SKU(s) declare no approval route ` +
          `(provider.checkout_url, or setApprovalUrl) — their price is ADVERTISED but ` +
          `NOT enforced: a refusal a buyer cannot act on is a dead end (§19.5)`,
      );
    }
    // Ownership: defaults to the node (already vouched). An explicit owner seed
    // groups agents under one operator/org and gets its own owner attestation.
    const nodePub = this.nodeKp.getPublicKey();
    let owner = nodePub;
    // §9.2 retention defaults: ephemerality is the default, durability is
    // declared. A profile that states an availability_class made a retention
    // promise and earns the full vouch; an undeclared one gets the short
    // lease and self-cleans if abandoned. An explicit vouchTtlMs always wins.
    // Declared profile fields MERGE over the detected ones, so declaring a
    // class does not cost the platform/client attribution (EXT-1).
    const nodeProfile =
      opts.nodeProfile || this.defaultNodeProfile
        ? { ...this.defaultNodeProfile, ...opts.nodeProfile }
        : undefined;
    const vouchTtl = this.vouchTtlExplicit
      ? this.vouchTtlMs
      : nodeProfile?.availability_class
        ? this.vouchTtlMs
        : EPHEMERAL_VOUCH_TTL_MS;

    let ownerAttestation: Manifest["owner_attestation"];
    if (opts.ownerSeed !== undefined) {
      const ownerKp = nkeys.fromSeed(
        typeof opts.ownerSeed === "string" ? new TextEncoder().encode(opts.ownerSeed) : opts.ownerSeed,
      );
      owner = ownerKp.getPublicKey();
      // Renewed on the same clock as the node vouch: the registry applies the
      // same expiry rule to both (§9.7), so an owner attestation left to lapse
      // fails a re-registration just as surely as a stale node vouch.
      if (owner !== nodePub) {
        ownerAttestation = createAttestation(ownerKp, this.agentId, vouchTtl);
      }
    }

    const encryptionKey = this.encryptionSeed
      ? encryptionPublicFromSeed(this.encryptionSeed)
      : undefined;
    const offeringsDeclared =
      opts.offerings ?? (opts as { skills?: Manifest["offerings"] }).skills ?? [];
    const worksWith = opts.works_with?.length ? opts.works_with : undefined;

    const manifest: Manifest = {
      id: this.agentId,
      name: opts.name,
      description: opts.description ?? "",
      version: opts.version ?? "0.1.0",
      protocol_version: PROTOCOL_VERSION,
      visibility: opts.visibility,
      interaction: opts.interaction,
      harness: opts.harness,
      harness_version: opts.harness_version,
      model: opts.model,
      owner,
      owner_attestation: ownerAttestation,
      provider: opts.provider,
      encryption_key: encryptionKey,
      // §8.9: whether callers should seal what they send here. Derived from
      // what this agent already declared — an offering that asks for a
      // third-party sign-in earns `required`, a declared integration earns
      // `preferred` — so the vendor case is sealed without anybody configuring
      // encryption. Absent unless something says otherwise, which is what every
      // manifest written before this field existed says and must keep saying.
      sealing: derivedSealing(
        { encryption_key: encryptionKey, works_with: worksWith, offerings: offeringsDeclared },
        opts.sealing,
      ),
      endpoint: Subjects.agentInbox(this.agentId),
      // §14.4: carry the endpoint subjects verbatim so callers resolve rather
      // than construct. The registry stamps this when absent (§8.2); declaring
      // it here keeps even a registry-less peer-to-peer manifest resolvable.
      endpoints: { inbox: Subjects.agentInbox(this.agentId) },
      // §6.4b/§22.5: declare a nonstandard inbound cap so senders pre-flight
      // against the real value instead of the default. The default itself is
      // not declared — absent means "the protocol defaults apply" (§8.2) — so
      // the declaration exists exactly when it says something.
      limits:
        opts.limits ??
        (this.maxInboundChars !== DEFAULT_MAX_INBOUND_CHARS
          ? { max_inbound_chars: this.maxInboundChars }
          : undefined),
      node: {
        id: this.nodeKp.getPublicKey(),
        // The vouch, signed by the NODE key — the one this agent was handed at
        // construction, whether that is a MeshNode's key or (self-hosting) its
        // own. A renewal re-signs with the same key; nothing ever re-vouches
        // with a key it does not hold.
        attestation: createAttestation(this.nodeKp, this.agentId, vouchTtl),
        profile: nodeProfile,
      },
      capabilities: opts.capabilities ?? [],
      // Deprecation window (§8.5): embedders written against the pre-rename
      // API said `skills`. Honoured as input; the manifest emits only `offerings`.
      offerings: offeringsDeclared,
      // §6.6a: an agent SHOULD declare its feeds in its manifest `emits`
      // field — the full feed subjects, which is what makes them discoverable
      // through the registry like any other manifest fact. Carried only when
      // something was declared (declareFeed): absent means "declared none",
      // exactly what every manifest written before feeds existed says.
      emits: this.declaredFeeds.size
        ? [...this.declaredFeeds.keys()].sort()
        : undefined,
      default_input_modes: opts.default_input_modes,
      default_output_modes: opts.default_output_modes,
      // §8.8: what this agent integrates with. Carried only when it says
      // something — an empty array would read as "declared none", which is not
      // the same as "did not say".
      works_with: worksWith,
      // §8.10: the card-level data-use declaration, pass-through only. The
      // registry is the validator and drops an unreadable declaration WHOLE
      // on the way in; duplicating those rules here would let the two drift
      // and make the SDK's verdict compete with the authoritative one.
      data_use: opts.data_use,
      // §8.12: who this agent is for, where its answers hold, what it does
      // outside that, whose interest it serves, where it came from, what it can
      // do, and who else is behind it. Card-level members, spread rather than
      // nested, because that is the shape the registry validates and the
      // storefront materializes. Pass-through for the same reason `data_use`
      // is: the registry drops an unreadable member whole, and a second copy of
      // that rule here would compete with the authoritative one.
      //
      // Spread from one helper rather than seven assignments so that adding a
      // §8.12 member means editing one list, and so the set can be read back
      // out again by the storefront adopter, which has to merge an owner's
      // console edit into exactly these fields and no others.
      ...listingDeclarations(opts),
      public: await this.publicWithSkus(opts),
      cost: opts.cost,
      skus: opts.skus,
      rate_limits: opts.rate_limits,
      meta: opts.meta,
      extensions: opts.extensions,
    };

    // §8.3: sign the id→encryption_key binding with this agent's own key.
    // Without it, `encryption_key` is only as trustworthy as whatever answered
    // the registry call — which is how it became a way to have a room key sealed
    // to a stranger (see encryptionKeyFor below). The claim covers the id, the
    // key and the instant, and deliberately nothing else: the registry rewrites
    // `owner`/`visibility`/`sandbox` right after this, so a wider signature
    // could not verify for anyone reading the manifest back.
    signManifest(manifest, this.kp);
    return manifest;
  }

  /** The §8.7 storefront, with §19.1's price advertisement: when SKUs are
   *  declared, the public block carries each one's id, price, and digest —
   *  price is pre-admission data by design. An explicit `public.skus` wins:
   *  advertising less than you sell is a choice the spec protects. */
  private async publicWithSkus(opts: RegisterOptions): Promise<Manifest["public"]> {
    if (!opts.skus?.length) return opts.public;
    if (opts.public?.skus !== undefined) return opts.public;
    const advertised = await Promise.all(opts.skus.map(publicSkuOf));
    return { ...(opts.public ?? {}), skus: advertised };
  }

  /** Send a `register` for a built manifest and validate the registry's answer.
   *  Throws on refusal; falls back to a bare publish when no registry answers at
   *  all (peer-to-peer mode). Shared by register() and renewVouch(). */
  private async sendRegister(manifest: Manifest): Promise<void> {
    const envelope = this.newEnvelope({
      type: "register",
      from: this.agentId,
      payload: manifest,
    });

    try {
      const resp = await this.conn.request(
        Subjects.REGISTRY_REGISTER,
        encode(envelope),
        { timeout: 5000 },
      );
      const respEnv = decode(resp.data);
      this.bindResponse(respEnv, envelope, { subject: Subjects.REGISTRY_REGISTER });
      if (respEnv.error) {
        throw MeshError.fromErrorObject(respEnv.error);
      }
    } catch (err) {
      if (
        err instanceof MeshError &&
        err.code === ErrorCode.TRANSPORT_NO_RESPONDERS
      ) {
        // No registry running — publish anyway for peer-to-peer mode
        this.conn.publish(Subjects.REGISTRY_REGISTER, encode(envelope));
      } else {
        throw err;
      }
    }
  }

  // ─── Vouch renewal (§4.4) ──────────────────────────────────────────
  //
  // An agent's right to speak on the mesh is its node's vouch (§4.3), and a
  // vouch is a LEASE: `handleRegister` refuses an expired attestation (§9.7) and
  // the registry's reaper reclaims a registration whose attestation has lapsed.
  // So a process that registers once and stays up outlives its own registration
  // — it keeps working, keeps heartbeating, and simply stops being discoverable
  // at the 30-day mark, with nothing in its logs to say why. Renewal is what
  // makes "long-lived" and "registered" compatible.
  //
  // A renewal is a re-registration with a freshly signed vouch, which is the
  // path §9.2 names ("re-registration with a fresh vouch is the legitimate path
  // back"). It deliberately does NOT redo register()'s other side effects: the
  // inbox subscription is already live, the mailbox consumer is already bound,
  // and re-running the EXT-6 guard handshake could have the admission service
  // refuse a guard this agent already holds (rate limit, ceiling) and quietly
  // move a healthy agent off the inbox anyone is writing to.

  /** When the current vouch expires, when it is next due for renewal, and why
   *  the last renewal attempt failed (if it did). Null values mean "not
   *  registered". Exposed so a host that passes no `onSecurityWarning` can still
   *  see a lapsing vouch on its own health surface. */
  get vouch(): { expires_at: string | null; renew_at: string | null; last_error: string | null } {
    return {
      expires_at: this.vouchExpiresAtIso,
      renew_at: this.vouchRenewAtMs === null ? null : new Date(this.vouchRenewAtMs).toISOString(),
      last_error: this.lastVouchError,
    };
  }

  /** When the connection credential expires, when it is next due for renewal,
   *  and why the last attempt failed (§4.8).
   *
   *  `null` throughout when no `credentialRenewal` was configured. An
   *  `expires_at` of `null` on a CONFIGURED renewer is the pre-§4.8 shape: a
   *  credential that never expires, which is a finding rather than good news —
   *  nothing can take it away short of a broker restart. */
  get credential(): CredentialStatus {
    return (
      this.credRenewer?.status() ?? {
        expires_at: null,
        renew_at: null,
        expired: false,
        last_error: null,
      }
    );
  }

  /** Renew the connection credential now, regardless of schedule. Throws when
   *  no `credentialRenewal` was configured, or when the mesh refuses (which is
   *  what revocation looks like — see §4.8). */
  async renewCredential(): Promise<void> {
    if (!this.credRenewer) {
      throw new Error("renewCredential(): this agent was connected without credentialRenewal");
    }
    await this.credRenewer.renew();
  }

  /** @internal Renew the credential if its deadline has passed. Never throws;
   *  exposed so a host can drive the check on its own clock (tests, a
   *  supervisor loop) rather than only on the SDK's timer. */
  async renewCredentialIfDue(now = Date.now()): Promise<boolean> {
    return (await this.credRenewer?.renewIfDue(now)) ?? false;
  }

  /** Record the renewal deadline implied by a manifest's vouch. */
  private noteVouch(manifest: Manifest): void {
    const att = manifest.node?.attestation;
    this.vouchExpiresAtIso = att?.expires_at ?? null;
    this.vouchRenewAtMs = att ? vouchRenewAt(att) : null;
  }

  /**
   * Mint a fresh node vouch and re-register with it. Safe to call at any time —
   * this is also what the renewal loop calls — but callers normally do not need
   * to: an agent registered through this SDK renews itself.
   *
   * Throws if the agent has never registered (there is nothing to re-register)
   * or if the registry refuses the re-registration.
   */
  async renewVouch(): Promise<Manifest> {
    if (!this.registerOpts) {
      throw new Error("renewVouch(): this agent has not registered — call register() first");
    }
    if (this.isClosed) throw new Error("renewVouch(): this agent is closed");
    const manifest = await this.buildManifest(this.registerOpts);
    await this.sendRegister(manifest);
    this.manifest = manifest;
    this.noteVouch(manifest);
    this.lastVouchError = null;
    return manifest;
  }

  /**
   * @internal Renew if the current vouch has reached its renewal deadline.
   * Returns true when a renewal was performed.
   *
   * Never throws: this runs on a timer with no caller to catch it, and an
   * application should not have a stray rejection from a background lease
   * renewal surface as an unhandled rejection. A failure leaves the deadline in
   * place, so the next tick retries — the renewal point is two thirds of the way
   * through the TTL precisely so there is a third of it left to keep trying in.
   *
   * Called by this agent's own loop when it is standalone, and by MeshNode's one
   * loop for every agent that node vouches for.
   */
  async renewVouchIfDue(now = Date.now()): Promise<boolean> {
    if (this.isClosed || !this.registerOpts || this.vouchRenewAtMs === null) return false;
    if (now < this.vouchRenewAtMs) return false;
    if (this.vouchRenewalInFlight) return false;
    this.vouchRenewalInFlight = true;
    try {
      await this.renewVouch();
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.lastVouchError = reason;
      const expires = this.vouchExpiresAtIso;
      const leftMs = expires ? Date.parse(expires) - now : NaN;
      this.onSecurityWarning?.({
        code: "vouch_renewal_failed",
        message:
          `could not renew the node vouch for agent ${this.agentId.slice(0, 12)}…: ${reason}. ` +
          `The vouch expires ${expires ?? "at an unknown time"} (${humanizeLeft(leftMs)}); after ` +
          `that the registry stops accepting this agent's registration and drops it from ` +
          `discovery until it registers again. Retrying.`,
        subject: this.agentId,
      });
      return false;
    } finally {
      this.vouchRenewalInFlight = false;
    }
  }

  /** Start this agent's own renewal loop. Standalone agents only — a hosted
   *  agent is covered by its node's single loop. */
  private startVouchRenewal(): void {
    this.stopVouchRenewal();
    this.vouchTimer = setUnrefInterval(
      () => void this.renewVouchIfDue(),
      vouchCheckIntervalMs(this.vouchTtlMs),
    );
  }

  /** Stop the renewal loop. Called from deregister/close/drain so the timer
   *  never outlives the registration it maintains, and never keeps a process
   *  alive on its own. */
  private stopVouchRenewal(): void {
    if (this.vouchTimer !== null) {
      clearInterval(this.vouchTimer);
      this.vouchTimer = null;
    }
  }

  /**
   * Ask the admission service to guard this inbox (EXT-6 §7.1), and report
   * whether it said yes. `true` is the ONLY answer that may switch this agent
   * off its public inbox.
   *
   * Being wrong here is silent and total: a guarded agent listens only on
   * `mesh.agent.<id>.inbox.guarded`, and nothing relays to that subject unless
   * the service is actually guarding the agent. So an agent that wrongly
   * believes it is guarded looks healthy, registers, heartbeats — and never
   * receives another message.
   *
   * This used to set `guarded = true` on ANY reply, without decoding it. Two
   * paths made that a false belief:
   *
   *   - every service subject, this one included, is wrapped in the shared
   *     rate limiter (`server/src/shared/handler.ts`), which answers over the
   *     limit with a `RATE_LIMITED` *error* envelope. An agent that had just
   *     been chatty — or one of many agents behind a busy node — asked to be
   *     guarded, was refused, and unsubscribed itself from the only inbox
   *     anybody was writing to;
   *   - any mesh participant that could publish into this connection's reply
   *     inbox could answer first with anything at all, which made "make that
   *     agent unreachable" a single unsigned message.
   *
   * Hence: decode (so an unsigned or forged envelope is refused), bind to the
   * request (§6.2, so a raced reply is refused), reject any `error`, and
   * require the service's explicit ok. Everything else — a timeout, no
   * responders, an undecodable reply, an error, an ack for something else —
   * means NOT guarded and the agent stays on its public inbox. The service
   * refuses by saying nothing at all (it does that for an unregistered agent
   * and at its guard ceiling), which is exactly why silence and error must land
   * in the same place.
   *
   * The accepted ack is what the admission service actually sends: a signed
   * `respond` bound to this request, carrying `payload.output.ok === true`
   * (with `guarded` true, or absent). A worse-than-useless "ack" — the benign
   * `{queued: true}` receipt the service gives a *sender* whose message was
   * dropped — is not an ok and is refused.
   */
  private async requestGuard(): Promise<boolean> {
    const req = this.newEnvelope({
      type: "request",
      from: this.agentId,
      // §7.1: empty payload. The service derives the inbox from the verified
      // `from`, so there is nothing to say and no way to guard another inbox.
      payload: {},
    });
    let respEnv: Envelope;
    try {
      const resp = await this.conn.request(
        Subjects.ADMISSION_GUARD,
        encode(req),
        { timeout: 5000 },
      );
      respEnv = decode(resp.data);
      this.bindResponse(respEnv, req, { subject: Subjects.ADMISSION_GUARD });
    } catch {
      // Timeout, no responders, undecodable, unsigned, or not an answer to
      // this request. All of them: not guarded.
      return false;
    }
    if (respEnv.error) return false;
    const out = (respEnv.payload as { output?: { ok?: unknown; guarded?: unknown } } | undefined)
      ?.output;
    return out?.ok === true && out.guarded !== false;
  }

  /**
   * Tell the admission service to stop guarding this inbox (EXT-6 §7.1), because
   * we are not listening on the guarded subject.
   *
   * Only ever called when the agent ASKED to be guarded and did not get it (see
   * register). It is a best-effort reconciliation, not a precondition: a guard
   * entry is a claim about a subscription this process holds, and this process is
   * the only party that knows the subscription is not there. Nothing else revokes
   * one — the admission service is told by the agent, the registry only reads the
   * list — so an entry left behind by a previous run outlives it silently, and
   * the mesh keeps acting on it.
   *
   * Published, not requested: there is nothing to learn from the answer (we stay
   * on the public inbox either way), and a request would spend the SDK's timeout
   * on every mesh with no admission service deployed. Signed and empty-payloaded
   * exactly like the guard request — the service derives the inbox from the
   * verified `from`, so there is no way to unguard anybody else's.
   *
   * Never throws. A failure here leaves a stale entry, which is the state we
   * started in; it must not fail a registration that otherwise succeeded.
   */
  private async revokeGuard(): Promise<void> {
    try {
      const env = this.newEnvelope({
        type: "request",
        from: this.agentId,
        payload: {},
      });
      this.conn.publish(Subjects.ADMISSION_UNGUARD, encode(env));
    } catch {
      // Connection draining, closed, or refused: nothing to do. The next
      // registration tries again.
    }
  }

  /** Remove this agent's manifest from the registry (§9.2). The inverse of
   *  register; the agent keeps its connection and can re-register later. */
  async deregister(): Promise<void> {
    const envelope = this.newEnvelope({
      type: "register",
      from: this.agentId,
      payload: { deregister: true },
    });

    const resp = await this.conn.request(
      Subjects.REGISTRY_DEREGISTER,
      encode(envelope),
      { timeout: 5000 },
    );
    const respEnv = decode(resp.data);
    this.bindResponse(respEnv, envelope, { subject: Subjects.REGISTRY_DEREGISTER });
    if (respEnv.error) {
      throw MeshError.fromErrorObject(respEnv.error);
    }
    this.manifest = null;
    // Nor a listing to adopt into: an agent with no registration has no
    // storefront, and a poll that would re-register a deregistered agent is the
    // opposite of what deregister was called for.
    this.storefront?.stop();
    this.storefront = null;
    // There is no longer a registration to keep alive: stop renewing, and clear
    // the deadline so a hosting node's loop skips this agent too. register()
    // re-arms both if the agent comes back.
    this.stopVouchRenewal();
    this.vouchRenewAtMs = null;
    this.vouchExpiresAtIso = null;
  }

  // ─── Primitive 2: Discover ─────────────────────────────────────────

  /** Discover agents on the mesh matching an optional query. */
  async discover(query?: DiscoverQuery): Promise<DiscoverResult> {
    const envelope = this.newEnvelope({
      type: "discover",
      from: this.agentId,
      payload: query ?? {},
    });

    const resp = await this.conn.request(
      Subjects.REGISTRY_DISCOVER,
      encode(envelope),
      { timeout: DEFAULT_REQUEST_TIMEOUT_MS },
    );

    const respEnv = decode(resp.data);
    this.bindResponse(respEnv, envelope, { subject: Subjects.REGISTRY_DISCOVER });
    if (respEnv.error) {
      throw MeshError.fromErrorObject(respEnv.error);
    }

    const result = (respEnv.payload as DiscoverResult) ?? { agents: [], total: 0 };
    // §14.4/§6.4b: discovery records are the resolution source — keep them at
    // hand so later request()s address the carried endpoint subjects and
    // pre-flight against the declared limits.
    if (Array.isArray(result.agents)) {
      for (const m of result.agents) this.cacheManifest(m);
    }
    return result;
  }

  /**
   * The §4.3 key on a manifest ALREADY IN HAND, or null when there is nothing
   * here safe to seal to. The same two conditions `encryptionKeyFor` applies,
   * without its registry round trip: the §8.3 claim must verify, and the
   * manifest must be about the agent we are asking about.
   */
  private verifiedKeyOn(manifest: Manifest | undefined, agentId: string): string | null {
    if (!manifest || manifest.id !== agentId) return null;
    if (!verifyManifestSignature(manifest)) return null;
    return manifest.encryption_key ?? null;
  }

  /**
   * §8.9: seal this outbound `input`, or do not, and say why not.
   *
   * The decision reads the manifest **already at hand** — the one a prior
   * `discover` or `getManifest` cached — and never fetches. That is the same
   * rule §6.4b's sender pre-flight follows two lines above the call site, and
   * it is deliberate: putting a registry round trip in front of every request
   * would make a registry blip a messaging outage, which is a worse failure
   * than the one sealing fixes. The cost of the choice is stated honestly in
   * `docs/honesty-list.md`: a caller that never resolved the recipient sends
   * its first request in the clear and is refused by a `required` agent.
   *
   * `config.seal` overrides in both directions. `true` is for a caller that
   * knows what it is holding whatever the recipient declared, and it fails
   * rather than downgrades.
   */
  private sealOutbound(
    agentId: string,
    input: unknown,
    recipient: Manifest | undefined,
    explicit: boolean | undefined,
  ): unknown {
    if (explicit === false) return input;
    const posture = recipient?.id === agentId ? recipient.sealing : undefined;
    const wanted = explicit === true || posture === "required" || posture === "preferred";
    if (!wanted) return input;

    const key = this.verifiedKeyOn(recipient, agentId);
    if (!key) {
      // Nothing verified to seal to. A `required` recipient will refuse this
      // anyway, so refuse here instead and keep the payload off the wire —
      // earning the refusal remotely would mean leaking the thing first.
      if (posture === "required" || explicit === true) {
        throw new MeshError(
          ErrorCode.SEALING_REQUIRED,
          `${agentId} ${
            posture === "required"
              ? "requires sealed requests (§8.9)"
              : "was asked for a sealed request"
          }, and no verifiable encryption key for it is at hand. ` +
            `Call getManifest(${agentId.slice(0, 12)}…) first: sealing needs the agent's own ` +
            `§8.3 key claim, and this SDK will not seal to a key nobody signed for.`,
          { retryable: false },
        );
      }
      // `preferred`: the agent reads cleartext, so sending is correct — but
      // silence here is how a confidentiality property becomes a rumour.
      this.onSecurityWarning?.({
        code: "sent_in_clear",
        message:
          `${agentId} asks callers to seal (§8.9 preferred) and no verifiable encryption key ` +
          `for it is at hand, so this request went in cleartext. Resolve its manifest ` +
          `(getManifest) before sending anything confidential.`,
        subject: agentId,
      });
      return input;
    }

    // Our own key travels as `reply_key` so the answer comes back sealed. With
    // no encryption seed of our own there is nothing to name, and the extension
    // then permits a cleartext answer — worth saying out loud, because the
    // caller asked for confidentiality and is getting half of it.
    const replyKey = this.encryptionSeed
      ? encryptionPublicFromSeed(this.encryptionSeed)
      : undefined;
    if (!replyKey) {
      this.onSecurityWarning?.({
        code: "sent_in_clear",
        message:
          `This request to ${agentId} was sealed, but this agent published no encryption key ` +
          `of its own, so it named no reply_key and the ANSWER may come back in cleartext. ` +
          `Pass an encryptionSeed to connect() to seal both directions.`,
        subject: agentId,
      });
    }
    return sealPayloadTo(input, key, replyKey);
  }

  /**
   * The key a sealed request's answer may be sealed to (§8.9), or null for
   * "there is nothing here I am willing to encrypt to".
   *
   * `reply_key` rides outside the box, and although the envelope signature
   * covers it, that only proves the sender chose it — it does not tie it to the
   * sender's identity. `resolveReplyKey` re-ties the two: the sender's own
   * published, §8.3-verified key is what we seal to, and a `reply_key` naming
   * anything else is refused rather than quietly honoured.
   *
   * Cache first, registry second, the host's fallback third. A sender we have
   * already resolved costs nothing; one we have not costs the one lookup that
   * makes the answer safe to send at all. A cached key that disagrees with the
   * claim is asked about again, because the sender may have moved to a new key
   * since it was cached.
   *
   * The registry is not always willing to answer. It serves a `private`
   * agent's manifest to that agent's owner only and tells everyone else "not
   * found", and an agent that registers for the first time without saying is
   * private. So every new agent's sealed ask used to be refused here with
   * SEALING_REQUIRED, AFTER its message had been taken: the sender was told
   * its message failed and sent it again (2026-10-05 on dev, 2026-10-11 on
   * prod). When the registry yields nothing verified, the host's fallback
   * (setEncryptionKeyFallback) is asked, and its answer must still equal the
   * claimed key: a disagreement is refused exactly as before.
   */
  private async replySealKey(from: string, claimed: string | undefined): Promise<string | null> {
    const cached = this.verifiedKeyOn(this.manifestCache.get(from), from);
    let declared =
      cached !== null && (claimed === undefined || claimed === cached)
        ? cached
        : await this.encryptionKeyFor(from);
    if (!declared && this.encryptionKeyFallback) {
      try {
        declared = (await this.encryptionKeyFallback(from)) ?? null;
      } catch {
        declared = null;
      }
    }
    return resolveReplyKey(claimed, declared);
  }

  /**
   * Where else a sender's published encryption key may be found, for the one
   * question the registry can decline to answer: which key a sealed ask's
   * answer may be sealed to (§8.9). The function is given the sender's agent
   * id and answers that agent's key, or null when it has none it vouches for.
   *
   * Asked only when the registry yields no verified key, and only ever to
   * confirm the `reply_key` the sender named, never to choose a different one.
   * A host that resolves agents through a naming authority whose cards it
   * verifies (the reference adapter does, SPEC-NAMING §5.3) answers from the
   * card, which carries the key the agent declared in its own signed check-in.
   * Pass null to remove it.
   */
  setEncryptionKeyFallback(fn: ((agentId: string) => Promise<string | null | undefined>) | null): void {
    this.encryptionKeyFallback = fn;
  }

  /**
   * Another agent's published X25519 encryption key (§4.3), or null when it has
   * none we are willing to use.
   *
   * This is the key secrets get sealed TO — a room key in an invite, a pairwise
   * request payload — so taking it from "whatever answered the registry call"
   * was enough to have those secrets sealed to a stranger: forge the reply with
   * your own X25519 key and you decrypt everything in a room you were never
   * admitted to, with no error on either side. Two conditions before the key is
   * handed out, both cheap and both necessary:
   *
   * - the manifest's `trust.signature` verifies as the agent's own §8.3 claim
   *   binding this `id` to this `encryption_key`, so the agent itself declared
   *   the key; and
   * - that `id` is the agent we asked about, so a signed manifest for B cannot
   *   be served as the answer for A.
   *
   * A manifest carrying no such claim — registered by an older SDK, or by one
   * that signed a different claim version — is refused here, and the agent fixes
   * it by re-registering. That is the intended failure: sealing to a key nobody
   * vouched for is the bug, so "cannot verify" must mean "will not seal".
   */
  async encryptionKeyFor(agentId: string): Promise<string | null> {
    try {
      const manifest = await this.getManifest(agentId);
      if (manifest?.id !== agentId) return null;
      if (!verifyManifestSignature(manifest)) return null;
      return manifest.encryption_key ?? null;
    } catch {
      return null;
    }
  }

  /** Ask the registry whether `key` is a revoked agent key (§5.3). A registry
   *  `get` answers a revoked key with `UNAUTHORIZED`, `details.reason:
   *  agent_key_revoked`; any other answer, a manifest or not-found included,
   *  means not revoked. Anything that is not a verified answer from the
   *  registry to this question is `unknown`, which revoked-senders.ts treats
   *  as "let it through". */
  private async registryRevocation(key: string): Promise<RevocationAnswer> {
    const envelope = this.newEnvelope({ type: "discover", from: this.agentId, payload: { agent_id: key } });
    let respEnv: Envelope;
    try {
      const resp = await this.conn.request(Subjects.registryGet(key), encode(envelope), {
        timeout: RevokedSenders.LOOKUP_TIMEOUT_MS,
      });
      respEnv = decode(resp.data);
      this.bindResponse(respEnv, envelope, { subject: "mesh.registry.get" });
    } catch {
      return { unknown: true };
    }
    const err = respEnv.error;
    if (err?.code === ErrorCode.UNAUTHORIZED && err.details?.reason === "agent_key_revoked") {
      const at = err.details.revoked_at;
      const to = err.details.replaced_by;
      return {
        revoked: true,
        ...(typeof at === "string" ? { revokedAt: at } : {}),
        ...(typeof to === "string" ? { replacedBy: to } : {}),
        ...(err.details.status === "terminated" ? { terminated: true } : {}),
      };
    }
    // The kill switch (§9 registry status): a paused agent's manifest says
    // so, and a receiver refuses what it sends until it is resumed.
    const status = (respEnv.payload as { status?: unknown; status_since?: unknown } | undefined)?.status;
    if (status === "paused") {
      const since = (respEnv.payload as { status_since?: unknown }).status_since;
      return { revoked: false, paused: true, ...(typeof since === "string" ? { since } : {}) };
    }
    return { revoked: false };
  }

  /** Fetch a single agent's manifest by ID (registry get, §9.2). Unlisted
   *  agents are reachable this way; private agents only by their owner. */
  async getManifest(agentId: string): Promise<Manifest> {
    const envelope = this.newEnvelope({
      type: "discover",
      from: this.agentId,
      payload: { agent_id: agentId },
    });

    const subject = Subjects.registryGet(agentId);
    const resp = await this.conn.request(subject, encode(envelope), {
      timeout: DEFAULT_REQUEST_TIMEOUT_MS,
    });

    const respEnv = decode(resp.data);
    // `mesh.registry.get.<id>` is per-agent, so pinning by subject would learn
    // one service key per agent ever looked up. Pin the registry as a whole
    // instead — it is one service and one key.
    this.bindResponse(respEnv, envelope, { subject: "mesh.registry.get" });
    if (respEnv.error) {
      throw MeshError.fromErrorObject(respEnv.error);
    }

    const manifest = respEnv.payload as Manifest;
    // Cache only an answer about the agent we asked about (§14.4): a manifest
    // for B served as the answer for A must not become A's resolution.
    if (manifest?.id === agentId) this.cacheManifest(manifest);
    return manifest;
  }

  // ─── Resolution (§14.4) and the §6.4a reply channel ────────────────

  /** Remember a manifest discovery handed back, keyed by its own `id`. */
  private cacheManifest(m: unknown): void {
    const man = m as Manifest | null | undefined;
    if (!man || typeof man !== "object" || typeof man.id !== "string" || man.id.length === 0) {
      return;
    }
    // Deprecation window (§8.5): manifests stored before the rename carry the
    // legacy field names. Normalized in place — here, the one choke point every
    // inbound manifest passes — so `discover` and `getManifest` hand back one
    // vocabulary and pre-flight never misses a declared interface. Mutating is
    // safe: the §8.3 signature covers only the id→encryption_key claim.
    const legacy = man as Manifest & { skills?: Manifest["offerings"] };
    if (man.offerings === undefined && Array.isArray(legacy.skills)) man.offerings = legacy.skills;
    if (man.public) {
      const pub = man.public as typeof man.public & {
        skills?: string[];
        skill_details?: NonNullable<Manifest["public"]>["offering_details"];
      };
      if (pub.offerings === undefined && Array.isArray(pub.skills)) pub.offerings = pub.skills;
      if (pub.offering_details === undefined && Array.isArray(pub.skill_details)) {
        pub.offering_details = pub.skill_details;
      }
    }
    // Re-insert so the bound evicts the stalest entry, not the busiest.
    this.manifestCache.delete(man.id);
    this.manifestCache.set(man.id, man);
    if (this.manifestCache.size > MANIFEST_CACHE_MAX) {
      const oldest = this.manifestCache.keys().next().value;
      if (oldest !== undefined) this.manifestCache.delete(oldest);
    }
  }

  /** The subject that reaches an agent's inbox (§14.4): the resolved value —
   *  the manifest's `endpoints.inbox`, else its `endpoint` — when a discovery
   *  record or manifest is at hand, verbatim; otherwise constructed from the
   *  naming convention, which the SDKs are the one legitimate constructor of.
   *  Resolved values win when present: that is what lets a future subject
   *  renaming be a registry change instead of an ecosystem flag day. */
  private resolvedInbox(agentId: string): string {
    const m = this.manifestCache.get(agentId);
    const candidate = m?.endpoints?.inbox ?? m?.endpoint;
    if (isPublishableSubject(candidate)) return candidate;
    return Subjects.agentInbox(agentId);
  }

  /** The §6.4a queued acknowledgement, if this respond carries one. The
   *  pinned shape (conformance/accept-signal.json): `queued` is boolean true
   *  and `inbox_id` is present and non-empty. The reference adapter answers
   *  it as a handler result, so it rides `payload.output`; a node answering
   *  raw puts it in `payload` directly. Both are recognized. */
  private queuedAckOf(env: Envelope): QueuedAck | null {
    if (env.error) return null;
    const p = env.payload as Record<string, unknown> | null | undefined;
    const candidates = [p, p?.output as Record<string, unknown> | null | undefined];
    for (const c of candidates) {
      if (
        c &&
        typeof c === "object" &&
        c.queued === true &&
        typeof c.inbox_id === "string" &&
        c.inbox_id.length > 0
      ) {
        return {
          queued: true,
          inbox_id: c.inbox_id,
          ...(typeof c.text === "string" ? { text: c.text } : {}),
          // The mesh's answer for a paused agent (§4.12) says so, with the
          // reason a stop carries everywhere else (`agent_paused`).
          ...(c.paused === true ? { paused: true as const } : {}),
          ...(typeof c.code === "string" ? { reason: c.code } : {}),
        };
      }
    }
    return null;
  }

  /** The typed non-answer a queued ack turns into (§6.4a: the ack MUST NOT be
   *  treated as the substantive reply). SDK-local code; ack fields ride in
   *  `details` so a caller (or the diagnostics probe) can carry on. */
  private queuedError(ack: QueuedAck, request: Envelope): MeshError {
    return new MeshError(
      ErrorCode.REQUEST_QUEUED,
      ack.paused
        ? `${request.to ?? "The target"} is paused: the mesh stopped it (§4.12). This request waits in its ` +
            `inbox (${ack.inbox_id}) and is delivered when it resumes; its reply, if any, arrives then at ` +
            `this agent's own inbox, correlated by in_reply_to.`
        : `The target's node queued this request (inbox ${ack.inbox_id}) for an attended session ` +
            `(§6.4a, §16.4). That is delivery to a held mailbox, not an answer: the real reply, if ` +
            `any, arrives later at this agent's own inbox, correlated by in_reply_to.`,
      {
        retryable: false,
        details: {
          queued: true,
          inbox_id: ack.inbox_id,
          request_id: request.id,
          ...(ack.text !== undefined ? { text: ack.text } : {}),
          ...(ack.paused ? { paused: true, reason: ack.reason ?? "agent_paused" } : {}),
        },
      },
    );
  }

  /** Outbound agent requests whose responds will arrive at THIS agent's own
   *  inbox (§6.4 hard cutover), keyed by the request envelope's id, which is
   *  what the respond's `in_reply_to` names. Two lookups resolve an entry,
   *  each after the §22 protections have run: `handleInboxRespond` for a true
   *  respond, and the inbox-mode-answer correlation in `handleInboxMessage`
   *  for a node's fresh request threading the same id. `awaitAgentReply`
   *  removes the entry when the wait settles, so an answer landing after a
   *  timeout finds nothing and is handled like any other unclaimed arrival. */
  private pendingAgentReplies = new Map<
    string,
    { request: Envelope; agentId: string; onRespond: (env: Envelope) => void }
  >();

  /**
   * Send an agent request and wait for the SUBSTANTIVE respond (§6.4a, §7.0):
   * the first respond whose `payload.status` is not `"accepted"`.
   *
   * §6.4 hard cutover: the responder's responds (the accept, the answer)
   * arrive at THIS agent's own inbox, correlated by `in_reply_to`, and are
   * routed here by `handleInboxRespond` after the §22 protections. The request
   * still goes out with a transport reply subject, but that subject is
   * liveness-plus-queued-ack only now: it carries the server's no-responders
   * verdict (offline with no mailbox, which is what keeps offline detection
   * fast) and the one delivery-status signal a NODE answers synchronously,
   * the §6.4a queued ack, which is honored there so REQUEST_QUEUED messaging
   * survives the cutover (the EXT-6 admission service's benign ack is this
   * exact shape). Every other message arriving on it is ignored.
   *
   * - An **accept** resets the response timeout (a full `timeout` again from
   *   the accept's arrival, §6.4a's "the wait is no longer blind"), fires the
   *   caller's `onAccept` hook, and never resolves the request.
   * - The **queued ack** fires `onQueued` and rejects with `REQUEST_QUEUED`:
   *   the real reply, if any, arrives later as its own inbox delivery.
   * - Traffic that fails decoding, response binding (§6.2) or `(from, id)`
   *   dedup (§22.2) never reaches the pending entry: the inbox pipeline
   *   refuses it, so a third party cannot fail the request by racing it.
   *
   * A timeout after an accept was seen carries `details.accepted: true`, so
   * request() can report "admitted but never answered" instead of the
   * misleading "may just be offline".
   */
  private async awaitAgentReply(
    subject: string,
    envelope: Envelope,
    bytes: Uint8Array,
    agentId: string,
    timeout: number,
    hooks: { onAccept?: (env: Envelope) => void; onQueued?: (ack: QueuedAck, env: Envelope) => void },
  ): Promise<Envelope> {
    const conn = this.conn as ConnectionManager & {
      requestMulti?: ConnectionManager["requestMulti"];
    };
    // The respond comes to our inbox, so we must be listening there BEFORE the
    // request leaves, including for an agent that never register()ed: making
    // requests is what obliges it to receive answers.
    this.listenInbox();
    return await new Promise<Envelope>((resolve, reject) => {
      let accepted = false;
      let stopLiveness: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let done = false;
      const settle = (fn: () => void): void => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        this.pendingAgentReplies.delete(envelope.id);
        try {
          stopLiveness?.(); // the watch has nothing left to learn
        } catch {
          /* already gone */
        }
        fn();
      };
      const onTimeout = (): void =>
        settle(() =>
          reject(
            accepted
              ? new MeshError(
                  ErrorCode.TRANSPORT_TIMEOUT,
                  `${agentId} accepted this request (§6.4a: delivered, admitted, handler running) but ` +
                    `no substantive respond arrived within the reset timeout of ${timeout}ms.`,
                  { details: { accepted: true } },
                )
              : new MeshError(
                  ErrorCode.TRANSPORT_TIMEOUT,
                  `Request timed out on subject '${subject}'`,
                ),
          ),
        );
      const arm = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(onTimeout, timeout);
      };
      arm();

      this.pendingAgentReplies.set(envelope.id, {
        request: envelope,
        agentId,
        onRespond: (env: Envelope) => {
          if (!env.error && (env.payload as RespondPayload | undefined)?.status === "accepted") {
            accepted = true;
            arm(); // §6.4a: reset the timeout, keep waiting
            try {
              hooks.onAccept?.(env);
            } catch {
              /* the hook's problem, not the request's */
            }
            return;
          }
          const ack = this.queuedAckOf(env);
          if (ack) {
            try {
              hooks.onQueued?.(ack, env);
            } catch {
              /* the hook's problem */
            }
            settle(() => reject(this.queuedError(ack, envelope)));
            return;
          }
          settle(() => resolve(env));
        },
      });

      // The ONE message the reply subject still answers with: the §6.4a
      // queued ack, run through the same §6.2/§22 checks the inbox runs
      // before it is honored. Everything else is ignored WITHOUT being
      // remembered: entering an ignored copy into the dedup memory would let
      // anyone who can publish to the reply subject front-run the inbox
      // delivery of the same `(from, id)` out of it.
      const replySubjectAck = (data: Uint8Array): void => {
        let env: Envelope;
        try {
          env = decode(data);
        } catch {
          return;
        }
        try {
          this.bindResponse(env, envelope, { agent: agentId });
        } catch {
          return; // not an answer to this request (§6.2)
        }
        const ack = this.queuedAckOf(env);
        if (!ack) return;
        if (!this.freshEnough(env, false)) return;
        if (!this.rememberInboxId(env.from, env.id)) return; // §22.2
        try {
          hooks.onQueued?.(ack, env);
        } catch {
          /* the hook's problem */
        }
        settle(() => reject(this.queuedError(ack, envelope)));
      };

      // The liveness watch. Its FAILURES matter in two grades: no-responders
      // is always a verdict (the fast offline detection this subject still
      // exists for), and any other failure (its own timeout, a publish
      // refusal) ends the wait only while nothing has been heard. After an
      // accept the responder is demonstrably live and mid-work, the pending
      // timer was reset by that accept, and the liveness watch expiring on
      // its ORIGINAL schedule must not cut the extended wait short.
      const onLiveness = (err: unknown): void => {
        if (err instanceof MeshError && err.code === ErrorCode.TRANSPORT_NO_RESPONDERS) {
          settle(() => reject(err));
          return;
        }
        if (!accepted) settle(() => reject(err));
      };
      try {
        if (typeof conn.requestMulti === "function") {
          void conn
            .requestMulti(subject, bytes, {
              timeout,
              classify: (m: Msg) => {
                replySubjectAck(m.data); // settles the wait itself when it is the ack
                return "ignore";
              },
              onListen: (stop: () => void) => {
                stopLiveness = stop;
              },
            })
            .then(() => undefined, onLiveness);
        } else {
          // Single-reply connections (test fakes, embedders) publish the same
          // way; the one reply their request() can resolve with gets the same
          // queued-ack-or-ignored treatment.
          void conn
            .request(subject, bytes, { timeout })
            .then((resp) => replySubjectAck(resp.data), onLiveness);
        }
      } catch (err) {
        settle(() => reject(err));
      }
    });
  }

  // ─── Primitive 3: Request ──────────────────────────────────────────

  /**
   * Send a request to another agent and wait for the response.
   *
   * 0.2: the requester does NOT create a Task up front. The responder decides
   * the shape of the reply (§6.4): a **bare** terminal response (`task_id: null`)
   * for work it finishes immediately, or a **Task** response (a responder-
   * assigned `task_id` with a non-terminal status) for deferred work. A local
   * Task is tracked only in the latter case.
   */
  async request(
    agentId: string,
    offering: string,
    input: unknown,
    config?: RequestConfig,
  ): Promise<RequestResult> {
    return this.requestWith(agentId, offering, input, config, {});
  }

  /** request(), with what only the SDK's own calls may ask for:
   *  `preAdmission` for `describe` (§10.14), which strangers make before they
   *  are let in and an agent not yet named may make too. */
  private async requestWith(
    agentId: string,
    offering: string,
    input: unknown,
    config: RequestConfig | undefined,
    internal: { preAdmission?: boolean },
  ): Promise<RequestResult> {
    // The naming rule, before anything else is looked at: an unnamed agent
    // sends nothing, and is told why (naming-gate.ts).
    if (this.namingGate && !internal.preAdmission) await this.namingGate.require();
    // Whoever this agent writes to may answer it: their messages are
    // solicited, and admission lets them through (admission.ts).
    if (!internal.preAdmission) this.admissionGate?.noteAddressed(agentId);
    // Common Agent 7.7: a trial carries no budget; refused before anything is
    // built or signed, with the code the responder would answer with.
    preflightTrial(config?.trial, config?.budget);
    if (config?.budget !== undefined) this.checkInitiatingBudget(config.budget);

    // §6.4b sender pre-flight, before anything is built or signed: the
    // recipient's declared limits when its manifest is at hand (a prior
    // discover/getManifest cached it), the §22.5 defaults when not. A refusal
    // here carries the code the recipient would answer with, so pre-flight
    // and remote refusals are indistinguishable to the caller.
    const recipient = this.manifestCache.get(agentId);
    preflightSenderText(input, effectiveInboundCap(recipient));
    preflightContentType(recipient, offering, config?.accepted_output);

    // §8.9: seal the caller's material when the recipient asks to be sealed to.
    // AFTER the pre-flight checks on purpose — the §22.5 text cap and the
    // content-type check are about what the recipient will read, which is the
    // plaintext, and measuring base64 ciphertext against a character cap would
    // refuse messages that are inside it.
    const reqPayload: RequestPayload = {
      offering,
      input: this.sealOutbound(agentId, input, recipient, config?.seal),
      config: config
        ? {
            timeout_ms: config.timeout_ms,
            stream: config.stream,
            accepted_output: config.accepted_output,
          }
        : undefined,
      ...(config?.trial === true ? { trial: true } : {}),
      ...(config?.trial === true && config.trial_requester ? { trial_requester: config.trial_requester } : {}),
    };

    const envelope = this.newEnvelope({
      type: "request",
      from: this.agentId,
      to: agentId,
      context_id: config?.context_id,
      trace: config?.trace ? childSpan(config.trace) : undefined,
      budget: config?.budget,
      payload: reqPayload,
      // Evidence of acting for a person (§4.16) rides in meta, under the envelope signature.
      meta: config?.on_behalf_of ? { ...(config.meta ?? {}), on_behalf_of: config.on_behalf_of } : config?.meta,
    });

    // §6.4b envelope-size check: the serialized envelope against the
    // transport's advertised maximum payload (§18.9), refused before publish.
    const bytes = encode(envelope);
    preflightEnvelopeSize(bytes.length, this.conn.maxPayload);

    const timeout = config?.timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS;

    // The producer half of this hop (§13.1.1). Timed around the wire wait
    // only: what happens after the reply lands is this process unsealing and
    // bookkeeping, which is not the hop and would inflate every duration.
    const spanStart = Date.now();
    const closeSpan = (outcome: SpanOutcome, errorCode?: string) =>
      this.publishSpan({
        trace: envelope.trace,
        kind: "producer",
        agentId: this.agentId,
        operation: "request",
        peer: agentId,
        offering,
        contextId: config?.context_id,
        outcome,
        errorCode,
        startedAt: spanStart,
        endedAt: Date.now(),
      });

    let respEnv: Envelope;
    try {
      respEnv = await this.awaitAgentReply(
        this.resolvedInbox(agentId),
        envelope,
        bytes,
        agentId,
        timeout,
        { onAccept: config?.onAccept, onQueued: config?.onQueued },
      );
    } catch (err) {
      const { outcome, errorCode } = outcomeOf(err);
      closeSpan(outcome, errorCode);
      // §16.4: silence usually means offline, not gone. Registered agents
      // have a mailbox, so the request was captured there regardless; the
      // reply, if the agent chooses to answer, arrives at the SENDER's own
      // inbox later (correlated by in_reply_to). Say so instead of a bare
      // transport error — EXCEPT after an accept (§6.4a): the agent was
      // demonstrably live and admitted the work, so "may just be offline"
      // would be the wrong story, and awaitAgentReply already told the right
      // one (details.accepted).
      if (
        err instanceof MeshError &&
        (err.code === ErrorCode.TRANSPORT_TIMEOUT ||
          err.code === ErrorCode.TRANSPORT_NO_RESPONDERS) &&
        err.details?.accepted !== true
      ) {
        // Silence from an agent the mesh has stopped, or whose key was
        // revoked, is not "maybe offline": ask the registry (§9.2 status,
        // §4.10) and say what it answers. A pause keeps the message (§4.12);
        // a terminated agent or a revoked key never reads it.
        const standing = await this.registryRevocation(agentId);
        if ("revoked" in standing && standing.revoked) {
          throw new MeshError(
            ErrorCode.AGENT_UNAVAILABLE,
            standing.terminated
              ? `${agentId} was terminated (§4.12). It does not come back, and this request will not be read.`
              : `${agentId}'s signing key was revoked (§4.10), so this request will not be read` +
                  (standing.replacedBy ? `; the agent moved to ${standing.replacedBy}.` : "."),
            {
              cause: err,
              details: {
                captured: false,
                reason: standing.terminated ? "agent_terminated" : "agent_key_revoked",
                request_id: envelope.id,
                ...(standing.revokedAt ? { revoked_at: standing.revokedAt } : {}),
                ...(standing.replacedBy ? { replaced_by: standing.replacedBy } : {}),
              },
            },
          );
        }
        if ("revoked" in standing && standing.paused) {
          throw new MeshError(
            ErrorCode.REQUEST_QUEUED,
            `${agentId} is paused: the mesh stopped it (§4.12). This request waits in its inbox and ` +
              `is delivered when it resumes; its reply, if any, arrives then at this agent's own inbox.`,
            {
              cause: err,
              details: {
                queued: true,
                captured: true,
                paused: true,
                reason: "agent_paused",
                request_id: envelope.id,
                ...(standing.since ? { since: standing.since } : {}),
              },
            },
          );
        }
        throw new MeshError(
          ErrorCode.AGENT_UNAVAILABLE,
          `No response from ${agentId} — the agent may just be offline. ` +
            `If it is a registered agent, this request was captured by its mailbox ` +
            `and its reply, if any, will arrive at your own inbox later.`,
          // The request's id rides along: a later reply names it (in_reply_to),
          // and a question to an owner is settled by it (mesh.owner.ask).
          { cause: err, details: { captured: true, request_id: envelope.id } },
        );
      }
      throw err;
    }

    let respPayload = respEnv.payload as RespondPayload;
    const taskId = respEnv.task_id ?? null;

    // A reply arrived, so the hop succeeded at the transport. Whether the WORK
    // succeeded is the responder's status, and a failed answer is a failed
    // span: a trace that reports "ok" for a refusal is worse than no trace.
    closeSpan(
      respPayload?.status === "failed" ? "error" : "ok",
      typeof respEnv.error?.code === "string" ? respEnv.error.code : undefined,
    );

    // §8.9: a sealed answer, opened for the caller. The ENVELOPE is left
    // verbatim — its signature covers the ciphertext, so a task history holding
    // the plaintext would hold a record that no longer verifies. The returned
    // payload is a copy, which is the honest split: the envelope is what
    // arrived, the payload is what it says.
    if (this.encryptionSeed && isSealedPayload(respPayload?.output)) {
      const opened = openSealedPayload(respPayload.output, this.encryptionSeed);
      if (opened) respPayload = { ...respPayload, output: opened.payload };
    }

    // Task mode: the responder deferred and assigned a Task. Track it locally.
    if (taskId) {
      // The id is the RESPONDER's choice (§6.4), and the tracker used to
      // `Map.set` it — so a responder could name a task this agent is already
      // tracking and take over its state, history and artifacts. Refuse rather
      // than overwrite; UUIDv7 ids do not collide by accident.
      if (this.tasks.has(taskId)) {
        throw new MeshError(
          ErrorCode.IDENTITY_MISMATCH,
          `${agentId} answered with task_id ${taskId}, which is already tracked here — ` +
            `refusing to let one responder replace another's task`,
        );
      }
      this.tasks.create({
        id: taskId,
        requester: this.agentId,
        responder: agentId,
        offering,
        // The accept is filtered out by awaitAgentReply, and "accepted" is
        // not a Task state (§7.2) — narrow so it can never be recorded as one.
        state:
          respPayload?.status && respPayload.status !== "accepted"
            ? respPayload.status
            : "working",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        history: [envelope, respEnv],
        artifacts: respEnv.artifacts ?? [],
        context_id: config?.context_id ?? respEnv.context_id,
        // §7.7 scope: the responder went deferred, so the Task inherits the
        // request's budget and it becomes live — revisable, latest-wins.
        budget: config?.budget,
      });
      this.recordDelegation(taskId);
      // The task id is the responder's, so this agent could not subscribe to
      // the task's updates before it asked. It waits here until the
      // subscription is live, so the caller never acts on `working` while a
      // terminal update could still fall into the gap, and the task record is
      // read once it is live for any update published before (watchTaskUpdates).
      await this.watchTaskUpdates(taskId);
    }

    if (respEnv.error) {
      const err = MeshError.fromErrorObject(respEnv.error);
      // A Task-mode error reply (e.g. BUDGET_EXHAUSTED pausing into
      // input_required) leaves a LIVE task behind — the caller needs its id to
      // revise the budget or cancel, and the thrown error is all it gets.
      if (taskId !== null) {
        throw new MeshError(err.code, err.message, {
          details: { ...err.details, task_id: taskId },
          retryable: err.retryable,
          retry_after_ms: err.retry_after_ms,
        });
      }
      throw err;
    }

    return {
      task_id: taskId,
      payload: respPayload,
      artifacts: respEnv.artifacts,
      envelope: respEnv,
    };
  }

  // ─── Streaming Request ─────────────────────────────────────────────

  /** Send a streaming request to another agent. Returns an async iterable of chunks. */
  async requestStream(
    agentId: string,
    offering: string,
    input: unknown,
    config?: StreamConfig,
  ): Promise<StreamResult> {
    if (this.namingGate) await this.namingGate.require();
    preflightTrial(config?.trial, config?.budget);
    if (config?.budget !== undefined) this.checkInitiatingBudget(config.budget);
    const taskId = uuid7();

    // §6.4b sender pre-flight — same three checks as request(), same codes.
    const recipient = this.manifestCache.get(agentId);
    preflightSenderText(input, effectiveInboundCap(recipient));
    preflightContentType(recipient, offering, config?.accepted_output);

    // §8.9 covers the request's `input` here exactly as it does on the bare
    // path — the caller's material is the same material. It does NOT cover the
    // chunks that come back: those are their own envelopes on the stream
    // subject, and nothing in this SDK encrypts them. Sealing the ask and
    // leaving the answer readable is half a guarantee, so the section says so
    // in as many words rather than letting a reader assume the other half.
    const reqPayload: RequestPayload = {
      offering,
      input: this.sealOutbound(agentId, input, recipient, config?.seal),
      config: {
        timeout_ms: config?.timeout_ms,
        stream: true,
        accepted_output: config?.accepted_output,
        sign_chunks: config?.sign_chunks,
      },
      ...(config?.trial === true ? { trial: true } : {}),
      ...(config?.trial === true && config.trial_requester ? { trial_requester: config.trial_requester } : {}),
    };

    const envelope = this.newEnvelope({
      type: "request",
      from: this.agentId,
      to: agentId,
      task_id: taskId,
      context_id: config?.context_id,
      trace: config?.trace ? childSpan(config.trace) : undefined,
      budget: config?.budget,
      payload: reqPayload,
      // Evidence of acting for a person (§4.16) rides in meta, under the envelope signature.
      meta: config?.on_behalf_of ? { ...(config.meta ?? {}), on_behalf_of: config.on_behalf_of } : config?.meta,
    });

    const bytes = encode(envelope);
    preflightEnvelopeSize(bytes.length, this.conn.maxPayload);

    this.tasks.create({
      id: taskId,
      requester: this.agentId,
      responder: agentId,
      offering,
      state: "submitted",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      history: [envelope],
      artifacts: [],
      context_id: config?.context_id,
      budget: config?.budget,
    });
    // The task id is this agent's own, so the subscription is asked for
    // before the request goes out, and on both transports it is live first:
    // there is no gap, and so no record to read.
    void this.watchTaskUpdates(taskId, { readRecord: false });
    this.recordDelegation(taskId);

    // Subscribe BEFORE sending request to prevent race condition (task_id is requester-generated)
    const streamSub = this.conn.raw.subscribe(Subjects.taskStream(taskId));

    const timeout = config?.timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS;

    let initialEnv: Envelope;
    try {
      // §6.4a: an accept may precede the opening respond — awaitAgentReply
      // skips it (resetting the timeout) and resolves on the first
      // substantive reply, which for a stream is §11.3's signed opening
      // "working" respond carrying the task_id.
      initialEnv = await this.awaitAgentReply(
        this.resolvedInbox(agentId),
        envelope,
        bytes,
        agentId,
        timeout,
        { onAccept: config?.onAccept, onQueued: config?.onQueued },
      );
    } catch (err) {
      streamSub.unsubscribe();
      throw err;
    }

    this.tasks.addToHistory(taskId, initialEnv);

    if (initialEnv.error) {
      streamSub.unsubscribe();
      try {
        this.tasks.transition(taskId, "failed");
      } catch {
        /* best-effort */
      }
      throw MeshError.fromErrorObject(initialEnv.error);
    }

    const initialPayload = initialEnv.payload as RespondPayload;
    if (initialPayload?.status && initialPayload.status !== "accepted") {
      try {
        this.tasks.transition(taskId, initialPayload.status);
      } catch {
        /* best-effort */
      }
    }

    const chunkTimeoutMs = config?.chunk_timeout_ms ?? DEFAULT_CHUNK_TIMEOUT_MS;
    const streamTimeoutMs =
      config?.stream_timeout_ms ?? DEFAULT_STREAM_TIMEOUT_MS;

    // The stream belongs to whoever opened it. `initialEnv.from` is that party,
    // proven by a verified signature and bound to this request above — so every
    // chunk must carry the same `from` and this task's id, or it is not part of
    // the stream (§11.6, §6.1). Anything else on the subject is dropped.
    const chunks = createChunkIterable(
      streamSub,
      taskId,
      this.tasks,
      chunkTimeoutMs,
      streamTimeoutMs,
      config?.sign_chunks ?? false,
      initialEnv.from,
    );

    return {
      task_id: taskId,
      initial_envelope: initialEnv,
      chunks,
    };
  }

  // ─── Primitive 4: Respond (via offering handlers) ─────────────────────

  /** Register a handler for incoming requests on an offering. Options are
   *  per-handler (§10.8): `propagateCancel: false` opts this handler out of
   *  automatic cancel propagation to its sub-requests. */
  onRequest(offeringId: string, handler: OfferingHandler, options?: HandlerOptions): void {
    this.router.register(offeringId, handler, options);
  }

  /** Register a streaming handler for incoming requests on an offering. */
  onStreamRequest(offeringId: string, handler: StreamOfferingHandler, options?: HandlerOptions): void {
    this.router.registerStream(offeringId, handler, options);
  }

  /** Set a default handler for requests that don't match any registered offering. */
  onDefault(handler: OfferingHandler): void {
    this.router.setDefault(handler);
  }

  /** Remove an offering handler. */
  removeHandler(offeringId: string): void {
    this.router.unregister(offeringId);
    this.router.unregisterStream(offeringId);
  }

  // ─── Span emission (§13.1.1) ───────────────────────────────────────

  /**
   * Publish one completed span, if this agent was told to.
   *
   * Best-effort and deliberately swallowing: telemetry must never be able to
   * fail the work it describes. A publish that throws because the connection
   * is draining should cost a span, not a request.
   *
   * Not routed through `emit()`. Spans go to `mesh.trace.>` rather than the
   * event bus, so nobody's `subscribe("trace.>")` handler receives them and
   * they do not inherit event-bus semantics. The envelope is still built and
   * signed the normal way, so a collector can verify which agent said this.
   */
  private publishSpan(input: SpanInput): void {
    if (!this.spansEnabled) return;
    try {
      const envelope = this.newEnvelope({
        type: "emit",
        from: this.agentId,
        // The span describes THIS hop, so it carries the hop's own context
        // rather than opening a child: a span about a span is nobody's idea
        // of a useful trace.
        trace: input.trace,
        payload: spanPayload(input),
      });
      this.conn.publish(traceSubject(this.agentId), encode(envelope));
    } catch (err) {
      // Swallowed, because a span must never fail the work it describes. But
      // NOT silently: on 2026-08-15 every span this node produced was refused
      // by the broker for a fortnight-old permissions reason, and from here it
      // was indistinguishable from "nothing happened". It was found by reading
      // the broker's log on another machine, which is not a thing an operator
      // will do.
      //
      // Said once, with the reason, then counted. A drop that repeats every
      // request must not become a log that nobody reads.
      this.spansDropped++;
      if (this.spansDropped === 1) {
        const why = err instanceof Error ? err.message : String(err);
        console.warn(
          `[agentmesh] span emission is on but a span could not be published: ${why}. ` +
            `Further drops are counted, not logged. A permissions refusal here usually ` +
            `means this node's credential predates mesh.trace.> and needs renewing.`,
        );
      }
    }
  }

  /** How many spans could not be published (§13.1.1). Zero unless something
   *  is wrong; a rising number with emission on means the broker is refusing
   *  them, most often a credential minted before `mesh.trace.>` existed. */
  get droppedSpans(): number {
    return this.spansDropped;
  }

  // ─── Primitive 5: Emit ─────────────────────────────────────────────

  /** Emit an event to the mesh. */
  emit(topic: string, data: unknown): void {
    this.namingGate?.requireCached();
    const parts = topic.split(".");
    const payload: EmitPayload = {
      domain: parts[0] ?? topic,
      event_type: parts.slice(1).join(".") || topic,
      data,
    };

    const envelope = this.newEnvelope({
      type: "emit",
      from: this.agentId,
      payload,
    });

    // §18.8: the envelope id doubles as the JetStream Nats-Msg-Id, so any
    // stream capturing this subject (the per-room streams, MESH_METERING) can
    // drop a duplicate publish inside its duplicate window. Core NATS ignores
    // the header, so this costs nothing when no stream is listening.
    this.conn.publish(Subjects.event(topic), encode(envelope), {
      headers: { "Nats-Msg-Id": envelope.id },
    });
  }

  /**
   * Watch completed spans (§13.1.1). This is the collector seam.
   *
   * Deliberately separate from `subscribe()`: spans live on `mesh.trace.>`
   * rather than the event bus, so an application subscribing to events never
   * receives telemetry and a collector watching telemetry never receives
   * application events. The two have different audiences and different
   * lifetimes and should not share a subject tree.
   *
   * The envelope is decoded the verified way, so a collector knows WHICH agent
   * claims each span rather than trusting a payload. A message that is not a
   * well-formed span is skipped rather than passed on half-read: a collector
   * that has to defend itself against its own source is a collector nobody
   * will run.
   */
  onSpan(
    handler: (span: SpanData, envelope: Envelope) => void,
    opts?: { agentId?: string },
  ): Subscription {
    const subject = opts?.agentId ? traceSubject(opts.agentId) : "mesh.trace.>";
    return this.conn.subscribe(subject, (msg: Msg) => {
      try {
        const env = decode(msg.data);
        const payload = env.payload as { domain?: string; event_type?: string; data?: SpanData };
        if (payload?.domain !== "trace" || payload.event_type !== "span_completed") return;
        const span = payload.data;
        if (!span?.trace_id || !span.span_id) return;
        handler(span, env);
      } catch {
        /* an undecodable or unsigned span is not worth stopping the stream for */
      }
    });
  }

  // ─── Feeds (§6.6a) ─────────────────────────────────────────────────

  /**
   * Publish to one of this agent's own feeds (§6.6a): the owner-rooted event
   * channel `mesh.feed.{self}.{topic}`. An ordinary `emit` envelope — no new
   * fields, no new signature — whose payload is exactly `{topic, kind, data}`,
   * NEVER the `{domain, event_type, data}` split of `emit()`: a feed topic is
   * one token and is never split on dots. `kind` defaults to `"state"` (a
   * current value; each publish replaces the last) and `"stream"` (an ordered
   * history) is the only other kind; anything else is refused, as is a topic
   * that is not a single subject token — a dotted topic would smuggle extra
   * tokens past the owner grant.
   */
  publishFeed(topic: string, data: unknown, opts?: { kind?: FeedKind }): void {
    this.namingGate?.requireCached();
    const kind = opts?.kind ?? "state";
    if (kind !== "state" && kind !== "stream") {
      throw new MeshError(
        ErrorCode.INVALID_ENVELOPE,
        `feed kind must be "state" or "stream" (§6.6a), got ${JSON.stringify(kind).slice(0, 64)}`,
      );
    }
    const subject = Subjects.feed(this.agentId, topic); // refuses a non-token topic
    const envelope = this.newEnvelope({
      type: "emit",
      from: this.agentId,
      payload: { topic, kind, data },
    });
    // §18.8: the envelope id doubles as the JetStream Nats-Msg-Id, exactly as
    // emit() sends it — MESH_FEED carries the same ≥2-minute duplicate window
    // as MESH_EVENTS (§18.3), and core NATS ignores the header when no stream
    // is listening.
    this.conn.publish(subject, encode(envelope), {
      headers: { "Nats-Msg-Id": envelope.id },
    });
  }

  /**
   * Subscribe to another agent's feed (§6.6a): `topic` names one feed, or
   * `"*"` matches all of that agent's feeds (§6.7 unchanged). An ephemeral
   * live subscription, dispatched through the same §22 event pipeline as
   * subscribe() — shared verbatim, so a protection cannot exist on one path
   * and not the other — with this subscription's subject as the §22.2 dedup
   * scope. Feed deliveries are AMBIENT: they reach the event handler and
   * nothing else — never the inbox, never mail, never a waiting count.
   *
   * With `opts.durable` it is the SPEC §18.6 Feed Consumer instead: the feed
   * is added to this agent's one durable consumer on MESH_FEED
   * (`mesh_feed_{agent_id}`), so a publish made while this agent was offline
   * is delivered when it comes back, and one its handler failed on is
   * redelivered. That path returns a Promise of a `DurableFeedSubscription`,
   * because binding the consumer is a round trip. See subscribeFeedDurable.
   */
  subscribeFeed(agentId: string, topic: string, handler: EventHandler): Subscription;
  subscribeFeed(
    agentId: string,
    topic: string,
    handler: EventHandler,
    opts: { durable: string | true },
  ): Promise<DurableFeedSubscription>;
  subscribeFeed(
    agentId: string,
    topic: string,
    handler: EventHandler,
    opts?: { durable?: string | boolean },
  ): Subscription | Promise<DurableFeedSubscription> {
    if (opts?.durable) return this.subscribeFeedDurable(agentId, topic, handler);
    const pattern = Subjects.feedPattern(agentId, topic);
    const sub = this.conn.subscribe(pattern, (msg: Msg) => {
      try {
        const env = decode(msg.data);
        this.dispatchEvent(env, msg.subject, handler, false, pattern);
      } catch {
        // Decode/handler errors are non-fatal for subscriptions
      }
    });
    this.eventSubs.push(sub);
    return sub;
  }

  /**
   * The durable half of subscribeFeed() (SPEC §18.6 Feed Consumer).
   *
   * ONE consumer per agent on MESH_FEED, named `mesh_feed_{agent_id}`, whose
   * `filter_subjects` are every feed the agent follows durably. One per agent
   * and not one per feed because a credential grants a consumer only by its
   * whole name (a permission matches whole subject tokens), and the agent's
   * own key is the one name known when its credential is minted; a consumer
   * named per feed could only be granted as `*`, and then any agent could
   * pull another agent's deliveries. Config, pinned by SPEC and by every
   * SDK's tests: ack_policy Explicit, deliver_policy New, ack_wait 30s,
   * max_deliver 5.
   *
   * Binding: info on the consumer; when it is missing, create it with this
   * feed as its one filter; when it stands without this feed, update its
   * filters to add it. Filters are never removed here: a feed this process no
   * longer follows keeps arriving, and a delivery no handler claims is handed
   * back after FEED_UNCLAIMED_NAK_MS (so a process that subscribes several
   * feeds one after another does not lose one it has not reached yet), and
   * max_deliver ends it.
   *
   * One consume loop per process, shared by every durable feed subscription,
   * because a pull consumer splits its deliveries between whoever pulls. A
   * delivery is dispatched through the §22 pipeline (buffered freshness
   * window, per-pattern dedup) to every handler whose pattern matches its
   * subject and acked after they all return; a handler that throws leaves it
   * unacked for redelivery. Undecodable bytes are acked and dropped.
   *
   * A missing MESH_FEED stream or a refused JetStream call throws, loudly,
   * rather than degrading to a live subscription: a caller who asked for
   * durability must not silently get the weak thing. A credential minted
   * before the feed-consumer grant existed is refused here; renewing it
   * gives it the grant.
   */
  private subscribeFeedDurable(
    agentId: string,
    topic: string,
    handler: EventHandler,
  ): Promise<DurableFeedSubscription> {
    const pattern = Subjects.feedPattern(agentId, topic); // validates both tokens
    const run = this.feedDurableChain.then(() => this.bindFeedDurable(pattern, handler));
    this.feedDurableChain = run.catch(() => undefined);
    return run;
  }

  private async bindFeedDurable(pattern: string, handler: EventHandler): Promise<DurableFeedSubscription> {
    const stream = Subjects.FEED_STREAM;
    const durable = Subjects.feedConsumer(this.agentId);
    try {
      if (this.conn.binding === "amqp") {
        // The RabbitMQ binding: the agent's one durable feed queue, of the
        // consumer's name, bound to every feed it follows durably.
        if (!this.feedDurable) {
          const c = await (this.conn as unknown as AmqpLike).consume(durable, { bind: [pattern] });
          const messages = c as unknown as { stop(): void; [Symbol.asyncIterator](): AsyncIterator<JsLikeMsg> };
          const handlers = new Map<string, EventHandler>();
          this.feedDurable = { handlers, messages, loop: this.feedDurableLoop(messages, handlers) };
        } else {
          await (this.feedDurable.messages as unknown as { bind(p: string): Promise<void> }).bind(pattern);
        }
      } else {
      const raw = this.conn.raw;
      const jsm = await raw.jetstreamManager();
      let filters: string[] | null = null;
      try {
        const info = (await jsm.consumers.info(stream, durable)) as unknown as {
          config?: { filter_subjects?: string[]; filter_subject?: string };
        };
        const c = info?.config ?? {};
        filters = c.filter_subjects?.length ? [...c.filter_subjects] : c.filter_subject ? [c.filter_subject] : [];
      } catch {
        filters = null; // no consumer yet
      }
      if (filters === null) {
        await jsm.consumers.add(stream, {
          durable_name: durable,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.New,
          ack_wait: 30_000_000_000, // 30s in ns
          max_deliver: 5,
          filter_subjects: [pattern],
        });
      } else if (!filters.includes(pattern)) {
        await jsm.consumers.update(stream, durable, {
          filter_subject: undefined,
          filter_subjects: [...filters, pattern],
        } as unknown as Parameters<typeof jsm.consumers.update>[2]);
      }
      if (!this.feedDurable) {
        const consumer = await raw.jetstream().consumers.get(stream, durable);
        const messages = (await consumer.consume()) as unknown as {
          stop(): void;
          [Symbol.asyncIterator](): AsyncIterator<JsLikeMsg>;
        };
        const handlers = new Map<string, EventHandler>();
        const loop = this.feedDurableLoop(messages, handlers);
        this.feedDurable = { handlers, messages, loop };
      }
      }
    } catch (err) {
      throw new MeshError(
        ErrorCode.DEPENDENCY_FAILED,
        `subscribeFeed("${pattern}", { durable }) could not bind this agent's feed consumer ` +
          `${durable} on ${stream}. Durable feed subscriptions need JetStream and the ${stream} ` +
          `stream on this mesh, and a credential that grants this agent its own feed consumer ` +
          `(one minted before that grant existed is refused until it is renewed). Not degrading ` +
          `to a live subscription: you asked for durability.`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
    const state = this.feedDurable!;
    state.handlers.set(pattern, handler);
    return {
      durable,
      subject: pattern,
      stop: async () => {
        if (this.feedDurable !== state || state.handlers.get(pattern) !== handler) return;
        state.handlers.delete(pattern);
        if (state.handlers.size === 0) {
          this.feedDurable = null;
          try {
            state.messages.stop();
          } catch {
            /* already stopped */
          }
          await state.loop;
        }
      },
    };
  }

  private feedDurableLoop(
    messages: { stop(): void; [Symbol.asyncIterator](): AsyncIterator<JsLikeMsg> },
    handlers: Map<string, EventHandler>,
  ): Promise<void> {
    return (async () => {
      for await (const m of messages) {
        let env: Envelope | null = null;
        try {
          env = decode(m.data);
        } catch {
          env = null;
        }
        if (env === null) {
          m.ack(); // undecodable buffered bytes: drop, don't loop
          continue;
        }
        const subject = typeof m.subject === "string" ? m.subject : "";
        const claimed = [...handlers].filter(([pattern]) => feedSubjectMatches(pattern, subject));
        if (claimed.length === 0) {
          // Nobody here follows this feed (yet): hand it back for later.
          try {
            m.nak?.(FEED_UNCLAIMED_NAK_MS);
          } catch {
            /* the connection went; redelivery follows ack_wait */
          }
          continue;
        }
        try {
          for (const [pattern, h] of claimed) this.dispatchEvent(env, subject, h, true, pattern);
          m.ack(); // after every handler returned: the ack is "durably handled"
        } catch {
          // Handler failure: no ack, so ack_wait redelivers (up to max_deliver).
        }
      }
    })().catch(() => {
      // The iterator ends when the connection closes or stop() is called.
    });
  }

  /** Stop (never delete) the durable feed consumer's loop. */
  private stopFeedDurable(): void {
    const state = this.feedDurable;
    this.feedDurable = null;
    if (!state) return;
    state.handlers.clear();
    try {
      state.messages.stop();
    } catch {
      /* already stopped */
    }
  }

  /**
   * Read a state feed's current value (§18.3): request-reply on
   * `mesh.feed.get` with `{agent, topic}`, answered `{found, envelope}` by
   * the platform's feed-state service from the KV entry it keeps per feed.
   * Returns the stored emit envelope, or null when the feed has never
   * published — or when no feed-state service answered on this mesh at all,
   * degrading exactly as trackPresence's snapshot does. A malformed agent id
   * or topic still throws: that is a caller bug, not a mesh condition.
   */
  async feedValue(agentId: string, topic: string): Promise<Envelope | null> {
    Subjects.feed(agentId, topic); // token validation only; refuses "*" too
    try {
      const res = (await this.serviceRequest(
        Subjects.FEED_GET,
        { agent: agentId, topic },
        5_000,
      )) as { found?: boolean; envelope?: Envelope | null } | null;
      return res?.found && res.envelope ? res.envelope : null;
    } catch {
      return null; // no feed-state service on this mesh; changes still flow
    }
  }

  /**
   * Track a feed (§6.6a, §18.3): SUBSCRIBE to the feed subject FIRST, THEN
   * read the current-value snapshot — in that order, the §9.6
   * subscribe-before-snapshot rule, which §18.3 applies to feeds for the same
   * reason it applies to presence. A publish that fires between a snapshot
   * read and a later subscription lands in the gap and is simply never seen,
   * while the worst case of this order is one publish seen twice — as the
   * snapshot and as a delivery — which applying state idempotently absorbs
   * (so apply it idempotently).
   *
   * `topic` names ONE feed: a current value is a per-feed fact, so the `"*"`
   * pattern has no snapshot and belongs to subscribeFeed(). `snapshot` is
   * null when the feed has never published or no feed-state service answered
   * — deliveries still flow either way. Call `stop()` to unsubscribe.
   */
  async trackFeed(
    agentId: string,
    topic: string,
    handler: EventHandler,
  ): Promise<FeedWatch> {
    Subjects.feed(agentId, topic); // one concrete feed: refuses "*" and non-tokens
    // §9.6: the subscription goes live before the snapshot is requested.
    const sub = this.subscribeFeed(agentId, topic, handler);
    const snapshot = await this.feedValue(agentId, topic);
    return { snapshot, stop: () => sub.unsubscribe() };
  }

  /**
   * Declare one of this agent's feeds (§6.6a): topic and kind, validated
   * exactly as publishFeed() validates them. Declarations made before
   * register() land in the manifest's `emits` field — the full feed subjects,
   * sorted — which is what makes feeds discoverable through the registry like
   * any other manifest fact ("an agent SHOULD declare its feeds in its
   * manifest emits field"). A declaration made after register() takes effect
   * on the next registration (a renewal re-registers the ORIGINAL options, so
   * re-register deliberately, don't wait for the vouch clock).
   */
  declareFeed(topic: string, kind: FeedKind): void {
    if (kind !== "state" && kind !== "stream") {
      throw new MeshError(
        ErrorCode.INVALID_ENVELOPE,
        `feed kind must be "state" or "stream" (§6.6a), got ${JSON.stringify(kind).slice(0, 64)}`,
      );
    }
    this.declaredFeeds.set(Subjects.feed(this.agentId, topic), kind);
  }

  // ─── Primitive 6: Subscribe ────────────────────────────────────────

  /**
   * The §22 event pipeline, shared verbatim by the ephemeral and durable
   * subscription paths so a protection cannot exist on one and not the other
   * (§22.1). §22.2 and §22.3, which the ephemeral path used to skip: dedup
   * BEFORE freshness, same order and same reasoning as handleInboxMessage
   * (a stale envelope must still be remembered). The §22.2 memory is the
   * event-side one, scoped per subscription PATTERN: §22.2 suppresses the
   * same envelope arriving twice on one subscription (live copy plus durable
   * redelivery of the same pattern share a scope and still dedup), never a
   * delivery to a second subscription the app deliberately overlapped with
   * the first — an agent subscribed to both `x.built` and `x.*` registered
   * two handlers and gets the event in each, exactly as the transport
   * delivers it. Both
   * refusals are silent (§22.7): a fire-and-forget event has no reply path,
   * and dedup/staleness answer nobody. The size cap (§22.5) is refused to the
   * RECIPIENT's warning sink only, for the same reason. `buffered` selects the
   * freshness window: a durable consumer legitimately replays events as old as
   * MESH_EVENTS retains, which the live window would refuse wholesale.
   *
   * Refusals return false and are COMPLETE handling. A handler exception
   * propagates to the caller, which decides what a failed dispatch means on
   * its path (the ephemeral path drops it, the durable path withholds the ack
   * so ack_wait redelivers).
   */
  private dispatchEvent(
    env: Envelope,
    subject: string,
    handler: EventHandler,
    buffered: boolean,
    pattern: string,
  ): boolean {
    if (!this.rememberEventId(pattern, env.from, env.id)) return false;
    if (!this.freshEnough(env, buffered)) return false;
    // SPEC.md §5.7 rule 6: an event carrying the mark goes to no handler.
    if (audienceOf(env) !== "agent") {
      this.dropMarked(env, `an event on ${subject}`);
      return false;
    }
    const payload = env.payload as EmitPayload;
    // An event body is untrusted text from a stranger exactly like a
    // request body is, and it reaches the same model. Same cap, same frame.
    const size = inboundTextLength(payload?.data);
    if (this.maxInboundChars > 0 && size > this.maxInboundChars) {
      this.onSecurityWarning?.({
        code: "inbound_oversize",
        message:
          `Event on ${subject} carries ${size} characters, ` +
          `over this agent's ${this.maxInboundChars}-character cap`,
        from: env.from,
        subject,
      });
      return false;
    }
    const framed = this.fenceInbound
      ? { ...payload, data: fenceInboundInput(payload?.data, { from: env.from, trace: env.trace }) }
      : payload;
    runWithTrace(env.trace, () => handler(framed, env));
    return true;
  }

  /**
   * The first 16 lowercase hex characters of SHA-256 over the UTF-8 pattern:
   * the EXACT cross-SDK §18.6 durable-name contract, pinned byte-for-byte in
   * both SDKs' tests. "billing.invoice_ready" hashes to "99397ba4a29eec30",
   * so that pattern's consumer is `mesh_event_{agent_id}_99397ba4a29eec30`.
   * Derived from the pattern (not caller-chosen) so an agent re-subscribing
   * the same pattern after a restart binds the SAME consumer and resumes its
   * cursor instead of minting a fresh one per process.
   */
  private static async subscriptionHash(pattern: string): Promise<string> {
    const bytes = new TextEncoder().encode(pattern);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
    let hex = "";
    for (const b of hash.subarray(0, 8)) hex += b.toString(16).padStart(2, "0");
    return hex;
  }

  /** Subscribe to events matching a topic pattern (supports NATS wildcards).
   *
   *  Without options this is the ephemeral live subscription it has always
   *  been, returning the transport `Subscription`. With `opts.durable` it is
   *  the SPEC §18.6 Event Consumer: a durable JetStream consumer on
   *  MESH_EVENTS that survives this process, resumes where it left off, and
   *  redelivers what the handler failed on. That path returns a Promise of a
   *  `DurableEventSubscription` instead, because binding the consumer is a
   *  round trip. `opts.replay` (only meaningful with `durable`) makes a
   *  NEWLY-created consumer start from everything the stream still holds
   *  (DeliverPolicy.All) rather than new events only; an existing durable
   *  keeps its cursor either way, which is the point of durability. */
  subscribe(pattern: string, handler: EventHandler): Subscription;
  subscribe(
    pattern: string,
    handler: EventHandler,
    opts: SubscribeOptions & { durable: string },
  ): Promise<DurableEventSubscription>;
  subscribe(
    pattern: string,
    handler: EventHandler,
    opts?: SubscribeOptions,
  ): Subscription | Promise<DurableEventSubscription> {
    if (opts?.durable) {
      return this.subscribeDurable(pattern, handler, opts.replay === true);
    }
    const sub = this.conn.subscribe(
      Subjects.event(pattern),
      (msg: Msg) => {
        try {
          const env = decode(msg.data);
          this.dispatchEvent(env, msg.subject, handler, false, pattern);
        } catch {
          // Decode/handler errors are non-fatal for subscriptions
        }
      },
    );
    this.eventSubs.push(sub);
    return sub;
  }

  /**
   * The durable half of subscribe() (SPEC §18.6 Event Consumer). JetStream
   * mechanics modelled on the mailbox drain: info-then-add on the consumer,
   * `consumers.get`, then a consume loop. The consumer name is the §18.6
   * contract (`mesh_event_{agent_id}_{subscriptionHash}`, see
   * subscriptionHash); its config is pinned by SPEC and by both SDKs' tests:
   * ack_policy Explicit, deliver_policy New (All when `replay`), ack_wait 30s,
   * max_deliver 5, filter_subject `mesh.event.{pattern}`.
   *
   * Each delivery is acked AFTER the handler returns: the ack is the "durably
   * handled" signal, so a handler that throws leaves the delivery unacked and
   * ack_wait redelivers it, up to max_deliver. An undecodable message acks
   * without dispatch (drop, don't loop), and a §22 refusal (dedup, freshness,
   * size cap) acks too, because a refusal is complete handling. The freshness
   * window is the BUFFERED one: a replayed event is old by construction, and
   * the live window would refuse everything a replay exists to deliver.
   *
   * A missing MESH_EVENTS stream or a refused JetStream API throws, loudly,
   * rather than degrading to the ephemeral path: a developer who asked for
   * durability must not silently get the weak thing.
   *
   * `stop()` ends this client's consume loop and NEVER deletes the durable,
   * for the same reason stopOfflineDrain never does: the consumer is the
   * server-side cursor, and deleting it would make the next start replay or
   * skip instead of resuming.
   */
  private async subscribeDurable(
    pattern: string,
    handler: EventHandler,
    replay: boolean,
  ): Promise<DurableEventSubscription> {
    const stream = "MESH_EVENTS";
    const durable = `mesh_event_${this.agentId}_${await AgentMesh.subscriptionHash(pattern)}`;
    const filter = Subjects.event(pattern);
    let messages: { stop(): void; [Symbol.asyncIterator](): AsyncIterator<JsLikeMsg> };
    try {
      if (this.conn.binding === "amqp") {
        // The RabbitMQ binding: a durable queue of the same name, bound to the
        // pattern, is the cursor (it holds what arrives while the agent is
        // away). It holds from when it is first made; `replay` has nothing
        // older to give there.
        messages = (await (this.conn as unknown as AmqpLike).consume(durable, { bind: [filter] })) as unknown as typeof messages;
      } else {
      const raw = this.conn.raw;
      const jsm = await raw.jetstreamManager();
      try {
        await jsm.consumers.info(stream, durable);
      } catch {
        await jsm.consumers.add(stream, {
          durable_name: durable,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: replay ? DeliverPolicy.All : DeliverPolicy.New,
          ack_wait: 30_000_000_000, // 30s in ns
          max_deliver: 5,
          filter_subject: filter,
        });
      }
      const consumer = await raw.jetstream().consumers.get(stream, durable);
      messages = (await consumer.consume()) as unknown as typeof messages;
      }
    } catch (err) {
      throw new MeshError(
        ErrorCode.DEPENDENCY_FAILED,
        `subscribe("${pattern}", { durable }) could not bind the ${stream} stream. Durable ` +
          `event subscriptions need JetStream and the ${stream} stream on this mesh; the ` +
          `likely causes are a mesh that has not provisioned ${stream}, or sandbox ` +
          `credentials without JetStream API access. Not degrading to an ephemeral ` +
          `subscription: you asked for durability.`,
        { cause: err instanceof Error ? err : undefined },
      );
    }

    const loop = (async () => {
      for await (const m of messages) {
        let env: Envelope | null = null;
        try {
          env = decode(m.data);
        } catch {
          env = null;
        }
        if (env === null) {
          m.ack(); // undecodable buffered bytes: drop, don't loop
          continue;
        }
        try {
          this.dispatchEvent(env, typeof m.subject === "string" ? m.subject : filter, handler, true, pattern);
          m.ack(); // after the handler returned: the ack is "durably handled"
        } catch {
          // Handler failure: no ack, so ack_wait redelivers (up to max_deliver).
        }
      }
    })().catch(() => {
      // The iterator ends when the connection closes or stop() is called;
      // either way there is nobody to throw to.
    });

    const handle: DurableEventSubscription = {
      durable,
      stop: async () => {
        try {
          messages.stop();
        } catch {
          /* already stopped */
        }
        await loop;
      },
    };
    this.durableEventSubs.push(handle);
    return handle;
  }

  // ─── Service requests ──────────────────────────────────────────────

  /** Signed request to a bare service subject (registry-style, not an agent
   *  inbox): the rooms service, usage queries, etc. Resolves with the
   *  response payload; rejects on error envelopes. */
  async serviceRequest(
    subject: string,
    payload: unknown,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const env = this.newEnvelope({
      type: "request",
      from: this.agentId,
      payload,
    });
    const resp = await this.conn.request(subject, encode(env), {
      timeout: timeoutMs,
    });
    const respEnv = decode(resp.data);
    this.bindResponse(respEnv, env, { subject });
    if (respEnv.error) throw MeshError.fromErrorObject(respEnv.error);
    return respEnv.payload;
  }

  // ─── Artifacts (§7.5) ──────────────────────────────────────────────

  /**
   * Store bytes and get back a reference to put in an artifact.
   *
   * ```ts
   * const ref = await agent.putArtifact(pdf, { media_type: "application/pdf", name: "report.pdf" });
   * await ctx.respond({ artifacts: [{ id, name: "Report", media_type: "application/pdf", parts: [ref] }] });
   * ```
   *
   * The returned object IS a `RefPart` — ref, media type, size, digest, name —
   * so it drops straight into `parts` with nothing to assemble by hand.
   */
  async putArtifact(bytes: Uint8Array, opts: PutArtifactOptions = {}): Promise<StoredArtifact> {
    return putArtifact(this.artifactHost(), bytes, opts);
  }

  /** Fetch a reference's bytes. The digest and length are verified before this
   *  returns — §7.5.1 requires it, and a check the caller has to remember is a
   *  check that does not happen. */
  async fetchArtifact(ref: string): Promise<ArtifactContent> {
    return fetchArtifact(this.artifactHost(), ref);
  }

  /** What a reference is, without moving the bytes. */
  async statArtifact(ref: string) {
    return statArtifact(this.artifactHost(), ref);
  }

  /** Delete an artifact this agent's owner owns. */
  async removeArtifact(ref: string): Promise<void> {
    return removeArtifact(this.artifactHost(), ref);
  }

  /** How much of the owner's artifact quota is used, and what the limits are. */
  async artifactUsage(): Promise<ArtifactUsage> {
    return artifactUsage(this.artifactHost());
  }

  /** A short-lived signed download link to an artifact, for a browser or a
   *  person rather than an agent. Any mesh identity holding the ref may ask
   *  (§7.5.4); hand the link to the one party it is for. */
  async artifactLink(ref: string, opts: ArtifactLinkOptions = {}): Promise<ArtifactLink> {
    return artifactLink(this.artifactHost(), ref, opts);
  }

  private artifactHost(): ArtifactHost {
    return { serviceRequest: (subject, payload, timeoutMs) => this.serviceRequest(subject, payload, timeoutMs) };
  }

  // ─── Rooms (mesh://extensions/rooms/v1) ────────────────────────────

  /** @internal The capabilities a Room borrows from this agent. */
  private roomHost(): RoomHost {
    return {
      agentId: this.agentId,
      keyPair: this.kp,
      outgoingMeta: () => this.outgoingMeta?.(),
      publish: (subject, data) => this.conn.publish(subject, data),
      subscribe: (subject, onEnvelope) => {
        const sub = this.conn.subscribe(subject, (msg: Msg) => {
          try {
            onEnvelope(decode(msg.data));
          } catch {
            // Undecodable traffic on a room subject is dropped.
          }
        });
        this.eventSubs.push(sub);
        return sub;
      },
      request: (agentId, offering, input, config) =>
        this.request(agentId, offering, input, config),
      encryptionSeed: this.encryptionSeed,
      getEncryptionKey: (agentId) => this.encryptionKeyFor(agentId),
      surfaceToPerson: (env, text, roomId) => this.surfaceToPerson(env, "say", { text, roomId }),
      audienceDeclaredBy: (agentId) => this.audienceDeclaredBy(agentId),
      onAudienceDropped: (env, why) => this.dropMarked(env, why),
      serviceRequest: (subject, payload, timeoutMs) =>
        this.serviceRequest(subject, payload, timeoutMs),
      openAclTransport: async (jwt, seed, inboxPrefix) => {
        // A second connection authenticated by the service-issued scoped
        // credential; the broker permits it only on this room's subjects.
        //
        // Node-hosted agents reach this too — a node retains the URL it dialled
        // and hands it to each hosted agent, precisely so a host like the Egg
        // Gateway or an official service agent is not locked out of the one grade
        // whose membership the broker enforces. An EMPTY list means the agent was
        // built over a caller-supplied connection (`MeshNode.withConn`), which
        // carries no URL to redial; dialling nothing would fail as an obscure
        // transport error a long way from this cause.
        if (!this.servers.length) {
          throw new MeshError(
            ErrorCode.INTERNAL_ERROR,
            "acl rooms need a mesh URL to dial the room-scoped connection; this agent was built " +
              "over a caller-supplied connection that carries none",
          );
        }
        if (this.conn.binding === "amqp") {
          // The RabbitMQ binding: the same room-scoped credential, presented
          // over AMQP; the broker check holds it to the room's subjects.
          const ac = await ConnectionManager.connect({
            servers: this.servers,
            authenticator: jwtAuthenticator(jwt, new TextEncoder().encode(seed)),
            reconnect: false,
          });
          return {
            publish: (subject, data) => ac.publish(subject, data),
            subscribe: (subject, onEnvelope) =>
              ac.subscribe(subject, (msg: Msg) => {
                try { onEnvelope(decode(msg.data)); } catch { /* drop undecodable */ }
              }),
            close: () => ac.close(),
          };
        }
        const nc = await natsConnect({
          servers: this.servers,
          authenticator: jwtAuthenticator(jwt, new TextEncoder().encode(seed)),
          // The credential permits this room's subjects and the reply space the
          // service scoped it to — nothing else. Leaving the default `_INBOX.`
          // gets the connection's OWN inbox subscription denied by the broker.
          ...(inboxPrefix ? { inboxPrefix } : {}),
        });
        return {
          publish: (subject, data) => nc.publish(subject, data),
          subscribe: (subject, onEnvelope) => {
            const sub = nc.subscribe(subject);
            (async () => {
              for await (const msg of sub) {
                try { onEnvelope(decode(msg.data)); } catch { /* drop undecodable */ }
              }
            })();
            return sub;
          },
          close: () => nc.close(),
        };
      },
    };
  }

  private roomsDoor: RoomsDoor | null = null;
  private boardDoor: BoardDoor | null = null;
  private reviewsDoor: ReviewsDoor | null = null;
  private platformApi: string | undefined;
  private platformKey: string | undefined;
  private operatorKey: string | undefined;
  private platformServicesCache: PlatformServices | null = null;

  /** The platform services this agent reaches through the service door,
   *  each request signed with its own key (platform-services/README.md). The
   *  account token rides only with an owner's acts and the operator key only
   *  with an operator's (service-caller.ts). */
  private platformServices(): PlatformServices {
    if (!this.platformServicesCache) {
      this.platformServicesCache = new PlatformServices(platformCaller({
        api: this.platformApi,
        key: this.platformKey,
        operatorKey: this.operatorKey,
        agent: { id: this.agentId, sign: (m) => this.signDetached(m) },
        capabilities: () => this.capabilities(),
      }));
    }
    return this.platformServicesCache;
  }

  private capabilitiesRead: (() => Promise<MeshCapabilities | null>) | null = null;

  /** What this mesh offers: its capabilities answer (GET /v1/capabilities on
   *  the platformApi address), read once and again every five minutes. Null
   *  when the mesh gives none. Every request of a platform service checks it
   *  first, and one the mesh does not offer is refused with NOT_AVAILABLE
   *  ("... is not available on this mesh ..."); core requests work on any
   *  Agent Messaging server and are never refused for it (capabilities.ts). */
  capabilities(): Promise<MeshCapabilities | null> {
    const api = this.apiAddress();
    if (!api) return Promise.resolve(null);
    this.capabilitiesRead ??= capabilitiesReader(api);
    return this.capabilitiesRead();
  }

  /** The address this agent reaches its mesh's HTTPS doors at; a refusal
   *  that says how to give one when none is known. */
  private meshApi(): string {
    return requireApi(this.platformApi ?? AM_URL_API);
  }

  /** The address of this agent's mesh's HTTPS doors, or undefined when none
   *  is known (ConnectOptions.platformApi says where it comes from). */
  apiAddress(): string | undefined {
    const a = this.platformApi ?? AM_URL_API;
    return a ? a.replace(/\/+$/, "") : undefined;
  }

  /** The naming service this agent uses to look names up, or undefined when
   *  none is known (ConnectOptions.requireNamed says where it comes from). */
  namingService(): string | undefined {
    const r = this.registrarUrl ?? AM_URL_NAMING;
    return r ? r.replace(/\/+$/, "") : undefined;
  }

  /** Whether the server says it offers naming (its capabilities answer's
   *  `naming`), or undefined when it cannot be asked or does not say. */
  private async namingOffered(): Promise<boolean | undefined> {
    const caps = this.apiAddress() ? await this.capabilities().catch(() => null) : null;
    return caps && typeof caps.naming === "boolean" ? caps.naming : undefined;
  }

  /** Refuses a platform request this mesh does not offer. */
  private async requireOffered(request: string): Promise<void> {
    const no = notAvailableRefusal(await this.capabilities(), request, this.meshApi());
    if (no) throw no;
  }

  /** What depends on one of this agent's owner's agents or solutions
   *  (platform-services/dependents.json). */
  get dependents(): DependentsRequests {
    return this.platformServices().dependents;
  }

  /** The mesh-wide board of open calls (platform-services/calls.json): read
   *  them, post one as this agent's account, offer to take one. */
  get calls(): CallsRequests {
    return this.platformServices().calls;
  }

  /** Search the catalog for a solution or an agent by what it does
   *  (platform-services/catalog.json): the MCP tool catalog_search and
   *  `agentmesh catalog search`. */
  get catalog(): CatalogRequests {
    return this.platformServices().catalog;
  }

  /** The jobs agents delivered to this agent's account, and changing one
   *  (platform-services/jobs.json): the MCP tools jobs_* and `agentmesh jobs`. */
  get jobs(): JobsRequests {
    return this.platformServices().jobs;
  }

  /** The account's credits (platform-services/credits.json). An owner's
   *  read: connect with platformKey set to the account's API token with the
   *  credits scope. */
  get credits(): CreditsRequests {
    return this.platformServices().credits;
  }

  /** Outside A2A agents the account attaches to the mesh
   *  (platform-services/attachments.json). An owner's act: connect with
   *  platformKey set to the account's API token with the attachments scope. */
  get attachments(): AttachmentsRequests {
    return this.platformServices().attachments;
  }

  /** The account's agent portfolio (platform-services/portfolio.json). An
   *  owner's record: connect with platformKey set to the account's API token
   *  with the portfolio scope. */
  get portfolio(): PortfolioRequests {
    return this.platformServices().portfolio;
  }

  /** This agent's own memory across jobs (platform-services/memory.json):
   *  remember, recall and reflect, signed by this agent's key. */
  get memory(): MemoryRequests {
    return this.platformServices().memory;
  }

  /** The account this agent works for (platform-services/account.json):
   *  checking an account token, joining with an agent key, which account
   *  this agent acts for and what the system runs, signed by this agent's
   *  key; and the owner's acts of making agent and gateway keys, which need
   *  platformKey set to the account's API token with the agents or keys
   *  scope. */
  get account(): AccountRequests {
    return this.platformServices().account;
  }

  /** The transformation projects this agent's account may open
   *  (platform-services/transform.json): read only. Changing a project is
   *  the transform helper's act, sent to it as a message. */
  get transform(): TransformRequests {
    return this.platformServices().transform;
  }

  /** A signed review of the other party to an engagement, or a judgment of
   *  whether its spend was worth it (platform-services/reviews.json): signed
   *  here, by this agent's key, over the bytes the reputation bureau keeps. */
  get reviews(): ReviewsRequests {
    this.reviewsDoor ??= gatedDoor(new ReviewsDoor({
      agentId: this.agentId,
      sign: (m) => this.signDetached(m),
      resolve: async (t) => {
        const { Diagnostics } = await import("./diagnostics.js");
        const r = await new Diagnostics(this).resolve(t).catch(() => null);
        return r?.resolved && r.agentId ? r.agentId : null;
      },
      api: this.platformApi,
    }), "reviews", (r) => this.requireOffered(r));
    return this.reviewsDoor;
  }

  /** Published samples of agents' and solutions' work (platform-services/samples.json). */
  get samples(): SamplesRequests {
    return this.platformServices().samples;
  }

  /** The owner's schedules: make, list, run now, pause (platform-services/schedules.json). */
  get schedules(): SchedulesRequests {
    return this.platformServices().schedules;
  }

  /** The owner's account's runs and what they cost (platform-services/runs.json). */
  get runs(): RunsRequests {
    return this.platformServices().runs;
  }

  /** The Unified Error Log, for operators: needs `operatorKey` set to an
   *  operator key with the scope each request names (platform-services/errors.json). */
  get errors(): ErrorsRequests {
    return this.platformServices().errors;
  }

  /** What is known about an agent: today its AgentDoc (platform-services/agents.json). */
  get agents(): AgentsRequests {
    return this.platformServices().agents;
  }

  /** The ledger: the debt items against the owner's own agents and
   *  solutions; filing and moving items is the platform's, with its key
   *  (platform-services/debt.json). */
  get debt(): DebtRequests {
    return this.platformServices().debt;
  }

  /** Charters and mandates (platform-services/mandate.json): read an
   *  organization's charter and the mandates issued under it, and check
   *  whether a person may commit the organization to an act. */
  get mandate(): MandateRequests {
    return this.platformServices().mandate;
  }

  /** PACT (platform-services/pact.json): have this agent talk to a
   *  business's agent for its owner, signed by AgentMesh as the owner's
   *  personal-agent platform (BRIDGE-A2A.md section 14.10). */
  get pact(): PactRequests {
    return this.platformServices().pact;
  }

  /** The rooms service's requests (platform-services/rooms.json): the same
   *  names, fields and answers as the MCP tools rooms_open, rooms_post and
   *  the rest, and the command line's `agentmesh rooms`. Built on openRoom
   *  and joinRoom, whose live room comes back as `room`. */
  get rooms(): RoomsRequests {
    if (!this.roomsDoor) this.roomsDoor = new RoomsDoor(this);
    return this.roomsDoor;
  }

  // ── admission on this agent's own side (admission.ts, EXT-6 §7) ──────────

  private admissionGate: AdmissionGate | null = null;
  private admissionSync = true;
  /** sender agent id → its handle, or null when it has none (10 minutes). */
  private senderHandles = new Map<string, { at: number; handle: string | null }>();
  /** sender agent id → describe requests answered in the last minute. */
  private describeHits = new Map<string, number[]>();
  /** This agent's own card from the naming service, for describe (10 minutes). */
  private ownCard: { at: number; card: Record<string, unknown> | null } | null = null;

  /**
   * Admission on this agent's own side: who may reach it, who is waiting at
   * its door, and its inbox. Off until `start()`. Once started, a knock
   * puts its sender on the waiting list, a message from a sender the roster
   * does not cover is held (`registered: "hold"` by default), and
   * `mesh.contacts.waiting()`, `admit()` and `block()` and
   * `mesh.messages.inbox()`, `reply()` and `dismiss()` work.
   */
  get admission(): AdmissionControl {
    return {
      start: async (opts: AdmissionOptions = {}) => {
        this.admissionGate = await AdmissionGate.open(this.agentId, this.kp, opts);
        // SPEC.md §5.7: a held message for the person goes to the person once
        // its sender is let in.
        this.admissionGate.onPersonReleased = (h) =>
          h.envelope ? this.surfaceToPerson(h.envelope as Envelope, "request") : false;
        this.admissionSync = opts.syncRoster !== false;
        await this.syncRoster();
      },
      running: () => this.admissionGate !== null,
      roster: () => this.admissionGate?.roster() ?? null,
      flush: async () => { await this.admissionGate?.flush(); },
    };
  }

  /** Store the signed roster on the mesh (PUT /v1/rosters/:owner), so a
   *  guarded inbox drops what it blocks before delivery. Quiet when the
   *  server has no such door or cannot be reached: the agent's own door
   *  still applies the roster, which is the authority (EXT-6 §7). */
  private async syncRoster(): Promise<void> {
    const gate = this.admissionGate;
    const api = this.apiAddress();
    if (!gate || !this.admissionSync || !api) return;
    try {
      await fetch(`${api}/v1/rosters/${this.agentId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(gate.roster()),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      /* the mesh's copy catches up at the next change */
    }
  }

  /** A sender's handle, from the naming service when one is known; null when
   *  it has none or none can be asked. Kept for ten minutes. */
  private async senderHandle(agentId: string): Promise<string | null> {
    const registrar = this.namingService();
    if (!registrar) return null;
    const hit = this.senderHandles.get(agentId);
    if (hit && Date.now() - hit.at < 600_000) return hit.handle;
    const r = await registrarNameLookup(registrar)(agentId).catch(() => null);
    const handle = r?.status === "named" && typeof r.handle === "string" ? r.handle : null;
    this.senderHandles.set(agentId, { at: Date.now(), handle });
    if (this.senderHandles.size > 2000) this.senderHandles.delete(this.senderHandles.keys().next().value!);
    return handle;
  }

  /** sender agent id → what the registry says about it, for admission (10 minutes). */
  private senderFactsCache = new Map<string, { at: number; facts: SenderFacts }>();

  /** What the registry says about a sender, for the roster's source entries
   *  and the `bridged` tier (EXT-6 0.5.0): whether it is registered, whether
   *  it reaches the mesh through a bridge, and where its identity came from.
   *  A lookup that fails is read as a registered native agent, as before. */
  private async senderFacts(agentId: string): Promise<SenderFacts> {
    const hit = this.senderFactsCache.get(agentId);
    if (hit && Date.now() - hit.at < 600_000) return hit.facts;
    let facts: SenderFacts;
    try {
      // Two seconds at most: a registry that does not answer leaves the sender
      // read as before, a registered native agent, and the answer is not kept.
      const m = (await Promise.race([
        this.getManifest(agentId),
        new Promise<never>((_, no) => { const t = setTimeout(() => no(new Error("registry slow")), 2000); (t as { unref?: () => void }).unref?.(); }),
      ])) as Manifest & { identity_source?: { kind?: string; issuer?: string; trust_domain?: string } };
      const exts = Array.isArray(m.extensions) ? m.extensions.map((e) => (e as { uri?: unknown })?.uri) : [];
      const bridged = m.identity_source?.kind === "bridged" || exts.includes("mesh://extensions/identity-bridge/v1") || exts.includes("mesh://extensions/a2a-bridge/v1");
      facts = { registered: true, bridged, ...(m.identity_source ? { source: m.identity_source } : {}) };
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code !== ErrorCode.AGENT_UNAVAILABLE) return { registered: true, bridged: false };
      facts = { registered: false, bridged: false };
    }
    this.senderFactsCache.set(agentId, { at: Date.now(), facts });
    if (this.senderFactsCache.size > 2000) this.senderFactsCache.delete(this.senderFactsCache.keys().next().value!);
    return facts;
  }

  /** A terminal answer to a request, with no task and no accept before it. */
  private answerDirect(msg: Msg, env: Envelope, output: unknown, viaReply: boolean, error?: ErrorObject): void {
    const out = this.newEnvelope({
      type: "respond",
      from: this.agentId,
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      ...(error ? { error, payload: { status: "failed" } } : { payload: { status: "completed", output } }),
    });
    this.sendRespond(msg, env, encode(out), { transportReply: viaReply, tap: true });
  }

  /** The §6.4a queued acknowledgement, shaped as conformance/accept-signal.json
   *  pins it. A held message and a blocked one get the same words, so a sender
   *  cannot tell them apart; only a message put in the inbox says delivered. */
  private answerQueued(msg: Msg, env: Envelope, viaReply: boolean, delivered: boolean): void {
    const name = this.manifest?.name ?? "This agent";
    const text = delivered
      ? `Delivered to ${name}'s inbox. It answers in its own time.`
      : `Sent; it reaches ${name} if ${name} admits you.`;
    this.answerDirect(msg, env, { queued: true, inbox_id: env.id, text, ...(delivered ? { delivered: true } : {}) }, viaReply);
  }

  /** §10.14 `describe`: the manifest's public block and the agent's signed
   *  card, from declared content only. Rate-limited per requester. */
  private async answerDescribe(msg: Msg, env: Envelope, viaReply: boolean): Promise<void> {
    const now = Date.now();
    const hits = (this.describeHits.get(env.from) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= 30) {
      this.describeHits.set(env.from, hits);
      this.answerDirect(msg, env, null, viaReply, { code: ErrorCode.RATE_LIMITED, message: "Too many describe requests from this agent. Ask again in a minute.", retryable: true });
      return;
    }
    hits.push(now);
    this.describeHits.set(env.from, hits);
    if (this.describeHits.size > 5000) this.describeHits.delete(this.describeHits.keys().next().value!);
    const m = this.manifest;
    if (m?.visibility === "private") {
      this.answerDirect(msg, env, { described: false, visibility: "private", reason: "This agent is private: it does not describe itself." }, viaReply);
      return;
    }
    const registrar = this.namingService();
    if (registrar && (!this.ownCard || now - this.ownCard.at > 600_000)) {
      const card = await fetch(`${registrar}/api/resolve?agent_id=${encodeURIComponent(this.agentId)}`, { signal: AbortSignal.timeout(5000) })
        .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null))
        .catch(() => null);
      this.ownCard = { at: now, card };
    }
    const doc = m ? describeDocumentOf({ ...m, id: this.agentId } as Manifest) : {};
    const card = this.ownCard?.card;
    this.answerDirect(msg, env, { ...doc, agent_id: this.agentId, ...(card ? { card } : {}) }, viaReply);
  }

  /** EXT-6 §9.3 `knock`: the same answer to everyone, and the sender on the
   *  waiting list. A knock that carries words is refused, in words. */
  private async answerKnock(msg: Msg, env: Envelope, reqPayload: RequestPayload, viaReply: boolean): Promise<void> {
    const gate = this.admissionGate!;
    const read = readKnockInput(reqPayload.input);
    if (!read.ok) {
      this.answerDirect(msg, env, { received: false, refused: true, code: "KNOCK_CARRIES_NO_MESSAGE", error: read.why }, viaReply);
      return;
    }
    const handle = await this.senderHandle(env.from);
    this.answerDirect(msg, env, gate.knock(env.from, read, handle ?? undefined), viaReply);
  }

  /** The roster's word on one request. True when it was answered here (held,
   *  blocked, or put in the inbox) and must go no further. */
  private async admissionDoor(
    msg: Msg,
    env: Envelope,
    reqPayload: RequestPayload,
    viaReply: boolean,
    /** SPEC.md §5.7: the message is marked for this agent's person. It is
     *  held like any other; let in, it goes to the person surface (the caller's
     *  branch), never into the harness's inbox as text. */
    forPerson = false,
  ): Promise<boolean> {
    const gate = this.admissionGate!;
    const stance = gate.stanceFor(env.from, await this.senderFacts(env.from));
    if (stance === "block") {
      this.answerQueued(msg, env, viaReply, false);
      return true;
    }
    if (stance === "hold") {
      const handle = await this.senderHandle(env.from);
      gate.hold({
        id: env.id, from: env.from, received_at: new Date().toISOString(), offering: reqPayload.offering,
        input: forPerson ? env.payload : reqPayload.input,
        ...(forPerson ? { audience: "person" as const, envelope: env } : {}),
        ...(env.task_id ? { task_id: env.task_id } : {}), ...(env.context_id ? { context_id: env.context_id } : {}),
      }, handle ?? undefined);
      this.answerQueued(msg, env, viaReply, false);
      return true;
    }
    // Let in. Into the inbox when the agent collects what nobody handles.
    if (!forPerson && gate.collectsUnhandled && !this.router.has(reqPayload.offering) && !this.router.hasDefault) {
      const input = reqPayload.input;
      const inReplyTo = (input as { in_reply_to?: unknown } | null)?.in_reply_to;
      gate.file({
        id: env.id, from: env.from, text: textOfInput(input), received_at: new Date().toISOString(),
        kind: typeof inReplyTo === "string" ? "reply" : "message", offering: reqPayload.offering, input,
        ...(typeof inReplyTo === "string" ? { in_reply_to: inReplyTo } : {}),
        ...(env.task_id ? { task_id: env.task_id } : {}), ...(env.context_id ? { context_id: env.context_id } : {}),
      });
      this.answerQueued(msg, env, viaReply, true);
      void this.senderHandle(env.from);
      return true;
    }
    return false;
  }

  /**
   * §10.14 `describe`: read another agent's public card (its manifest's
   * `public` block, and its signed name card when it has one) before you are
   * let in. It never runs the other agent's model or code, and it needs no
   * name: an agent not yet named may describe others.
   */
  async describe(target: string, opts: { timeout_ms?: number } = {}): Promise<DescribeDocument> {
    let agentId = target.trim();
    if (!/^U[A-Z2-7]{55}$/.test(agentId)) {
      const { Diagnostics } = await import("./diagnostics.js");
      const r = await new Diagnostics(this).resolve(agentId);
      if (!r.resolved || !r.agentId) {
        throw new MeshError(ErrorCode.NOT_FOUND, `${target} could not be found: ${r.error ?? "its name did not resolve"}.`, { retryable: false });
      }
      agentId = r.agentId;
    }
    // Where the agent's identity came from (§9.7 identity_source) is the
    // mesh's attested record, read from the registry beside the agent's own
    // answer. Whatever the agent says about it is dropped: an agent does not
    // get to describe its own provenance.
    // The registry is asked beside the agent, and never holds the card up for
    // long: a registry that has not answered half a second after the agent
    // did leaves the record out.
    const lookup = this.getManifest(agentId).catch(() => null);
    const res = await this.requestWith(agentId, "describe", {}, { timeout_ms: opts.timeout_ms ?? 15_000 }, { preAdmission: true });
    const registered = await Promise.race([
      lookup,
      new Promise<null>((ok) => { const t = setTimeout(() => ok(null), 500); (t as { unref?: () => void }).unref?.(); }),
    ]);
    const out = (res.payload as { output?: unknown } | undefined)?.output ?? res.payload;
    if (!out || typeof out !== "object") throw new MeshError(ErrorCode.INVALID_ENVELOPE, `${target} answered describe with no document.`, { retryable: false });
    const { identity_source: _claimed, ...doc } = out as DescribeDocument;
    const { identity_source_attestation: _claimedAtt, ...rest } = doc as DescribeDocument & { identity_source_attestation?: unknown };
    const reg = registered as (typeof registered & { identity_source_attestation?: Record<string, unknown> }) | null;
    return (reg?.identity_source
      ? { ...rest, identity_source: reg.identity_source, ...(reg.identity_source_attestation ? { identity_source_attestation: reg.identity_source_attestation } : {}) }
      : rest) as DescribeDocument;
  }

  // ── the mesh's own requests (platform-services/*.json, "part": "mesh") ──
  // The same names, fields and answers as the MCP tools messages_send,
  // feeds_read and the rest, and the command line's agentmesh messages,
  // agentmesh feeds and the rest. Built on request(), discover() and the
  // feed primitives, which stay as they were (mesh-door.ts).

  private meshDoorsCache: {
    messages: MessagesDoor; contacts: ContactsDoor; owner: OwnerDoor; identity: IdentityDoor;
    names: NamesDoor; feeds: FeedsDoor; registry: RegistryDoor;
  } | null = null;
  private registrarUrl: string | undefined;

  private meshDoors(): NonNullable<AgentMesh["meshDoorsCache"]> {
    if (!this.meshDoorsCache) {
      const ctx: MeshDoorContext = {
        mesh: this,
        api: () => this.meshApi(),
        registrar: () => this.namingService(),
        admission: () => this.admissionGate,
        syncRoster: () => this.syncRoster(),
        declaredFeeds: () => [...this.declaredFeeds.entries()].map(([subject, kind]) => ({ topic: subject.slice(subject.lastIndexOf(".") + 1), kind })),
        retireFeed: (topic) => this.declaredFeeds.delete(Subjects.feed(this.agentId, topic)),
      };
      this.meshDoorsCache = {
        // owner.ask needs the AgentMesh platform (its tier), so it checks
        // the mesh offers it first; the rest are core.
        messages: new MessagesDoor(ctx), contacts: new ContactsDoor(ctx),
        owner: gatedDoor(new OwnerDoor(ctx), "owner", (r) => this.requireOffered(r)), identity: new IdentityDoor(ctx),
        names: new NamesDoor(ctx), feeds: new FeedsDoor(ctx), registry: new RegistryDoor(ctx),
      };
    }
    return this.meshDoorsCache;
  }

  /** Sending a message to another agent (platform-services/messages.json).
   *  Messages arriving for this agent come to onRequest, as before; with
   *  admission started, inbox(), reply() and dismiss() read and answer the
   *  ones it keeps (admission.ts). */
  get messages(): MessagesRequests & MessagesInboxRequests {
    return this.meshDoors().messages;
  }

  /** Knocking, and who is around (platform-services/contacts.json); with
   *  admission started, waiting(), admit() and block() (admission.ts). */
  get contacts(): ContactsRequests & ContactsAdmissionRequests {
    return this.meshDoors().contacts;
  }

  /** Asking the person who owns this agent (platform-services/owner.json). */
  get owner(): OwnerRequests {
    return this.meshDoors().owner;
  }

  /** Who this agent is on the mesh (platform-services/identity.json). */
  get identity(): IdentityRequests {
    return this.meshDoors().identity;
  }

  /** Looking agents up, and naming this one (platform-services/names.json). */
  get names(): NamesRequests {
    return this.meshDoors().names;
  }

  /** Feeds, declared, published, followed and read (platform-services/feeds.json). */
  get feeds(): FeedsRequests {
    return this.meshDoors().feeds;
  }

  /** The agents on the mesh now (platform-services/registry.json). */
  get registry(): RegistryRequests {
    return this.meshDoors().registry;
  }

  /** A durable room's work board (platform-services/board.json): the same
   *  names, fields and answers as the MCP tools board_post, board_claim and
   *  the rest, and `agentmesh board`. Done on the rooms the rooms door
   *  holds, with Room's postWork, claimWork and the rest. */
  get board(): BoardRequests {
    if (!this.roomsDoor) this.roomsDoor = new RoomsDoor(this);
    this.boardDoor ??= new BoardDoor(this.roomsDoor);
    return this.boardDoor;
  }

  /** Open a new room. The returned Room's `token` is the pasteable membership
   *  credential; share it (or call `room.invite`) to admit others. Ephemeral
   *  by default; `durable: true` provisions a record + drive via the mesh's
   *  rooms service (async, quota-gated) — see Room.openDurable. */
  openRoom(opts: OpenRoomOptions & JoinRoomOptions & { durable: true }): Promise<Room>;
  openRoom(opts: OpenRoomOptions & JoinRoomOptions & { acl: true }): Promise<Room>;
  openRoom(opts?: OpenRoomOptions & JoinRoomOptions & { durable?: false; acl?: false }): Room;
  openRoom(opts?: OpenRoomOptions & JoinRoomOptions): Room | Promise<Room> {
    this.namingGate?.requireCached();
    if (opts?.acl) return Room.openAcl(this.roomHost(), opts);
    if (opts?.durable) return Room.openDurable(this.roomHost(), opts);
    return Room.open(this.roomHost(), opts);
  }

  /** Join a room from its descriptor or token. Verifies the creator's
   *  signature before subscribing; posts a signed `join`. Ephemeral/sealed
   *  joins are synchronous; an acl join is async (it fetches a scoped
   *  credential and opens the room-scoped connection), so `await` the result —
   *  awaiting the synchronous cases simply returns the Room. */
  /** Rooms this agent can reach, from the rooms service: acl rooms it has been
   *  admitted to, plus any room it created — each with the record's `last_seq`
   *  and this agent's own `cursor`, so unread counts need one round trip.
   *
   *  Capability and sealed rooms the agent merely holds a descriptor for are
   *  NOT here and cannot be: at those grades membership is possession of the
   *  descriptor and the service never learns of it (EXT-5 §6). A client that
   *  wants to list those has to remember its own descriptors. `complete: false`
   *  on the wire says so explicitly rather than implying the list is exhaustive. */
  async myRooms(): Promise<MyRoom[]> {
    const res = (await this.serviceRequest(RoomsServiceSubjects.MINE, {})) as {
      rooms?: MyRoom[];
    };
    return res?.rooms ?? [];
  }

  joinRoom(
    descriptorOrToken: RoomDescriptor | string,
    opts?: JoinRoomOptions,
  ): Room | Promise<Room> {
    // A join announces this agent to every member, so it is a send.
    this.namingGate?.requireCached();
    const descriptor =
      typeof descriptorOrToken === "string" ? descriptorFromToken(descriptorOrToken) : descriptorOrToken;
    if (descriptor.privacy === "acl") return Room.joinAcl(this.roomHost(), descriptor, opts);
    return Room.join(this.roomHost(), descriptor, opts);
  }

  // ─── Heartbeat ───────────────────────────────────────────────────

  /** Send a single heartbeat to the mesh. 0.2: heartbeats are node-scoped and
   *  feed the presence service (§9.6), not the registry. One heartbeat from a
   *  node covers the agents it hosts. */
  sendHeartbeat(availability?: Availability): void {
    const nodeId = this.nodeKp.getPublicKey();
    const envelope = this.newEnvelope({
      type: "emit",
      from: this.agentId,
      payload: { node: nodeId, availability: availability ?? "online" },
    });
    this.conn.publish(Subjects.heartbeat(nodeId), encode(envelope));
  }

  /**
   * Track liveness (§9.6): SUBSCRIBE to the presence transition stream FIRST,
   * THEN read the snapshot — in that order, which §9.6 makes a MUST. A
   * transition that fires between a snapshot read and a later subscription
   * lands in the gap and is simply never seen — the consumer's stale entry
   * looks exactly like a quiet healthy one — while the worst case of this
   * order is a transition seen twice, which applying state idempotently
   * absorbs (so apply them idempotently).
   *
   * Transitions are the node heartbeats (§10.10): the SUBJECT token, not the
   * payload, names the node, and only an envelope actually signed by that
   * node's own key is surfaced — anyone can publish to a heartbeat subject,
   * but nobody else can sign as the node. The snapshot is the presence
   * service's `get_presence` answer (§9.6), or `null` when no presence
   * service answered on this mesh; transitions still flow either way.
   *
   * `opts.node` narrows the watch to one node; omitted watches every node's
   * heartbeats. Call `stop()` to unsubscribe.
   */
  async trackPresence(
    handler: (transition: PresenceTransition) => void,
    opts?: { node?: string; snapshotTimeoutMs?: number },
  ): Promise<PresenceWatch> {
    // §9.6: the subscription goes live before the snapshot is requested.
    const subject = opts?.node
      ? Subjects.heartbeat(opts.node)
      : "mesh.heartbeat.>";
    const sub = this.conn.subscribe(subject, (msg: Msg) => {
      try {
        const env = decode(msg.data);
        const node = msg.subject.split(".")[2];
        if (!node || env.from !== node) return; // only the node's own key speaks for it
        const hb = env.payload as { availability?: unknown } | undefined;
        const availability: Availability =
          hb?.availability === "online" ||
          hb?.availability === "busy" ||
          hb?.availability === "degraded" ||
          hb?.availability === "offline"
            ? hb.availability
            : "online";
        handler({ node, availability, envelope: env });
      } catch {
        // Unsigned or undecodable heartbeats are dropped, exactly as the
        // presence service drops them.
      }
    });
    this.eventSubs.push(sub);

    let snapshot: unknown = null;
    try {
      snapshot = await this.serviceRequest(
        Subjects.PRESENCE_GET,
        opts?.node ? { node: opts.node } : {},
        opts?.snapshotTimeoutMs ?? 5_000,
      );
    } catch {
      snapshot = null; // no presence service on this mesh; transitions still flow
    }
    return { snapshot, stop: () => sub.unsubscribe() };
  }

  /** Start sending periodic heartbeats. */
  startHeartbeat(intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS): void {
    this.stopHeartbeat();
    this.sendHeartbeat();
    // A timer must never throw: an exception from it ends the host process.
    // The connection can close under a running timer (the kill switch cuts a
    // connection on a lift so its node re-mints, and a hosted agent lives in
    // the platform's own process), and a beat on a closed connection is one
    // nobody can receive, so it is dropped and the timer stops.
    this.heartbeatTimer = setInterval(() => {
      try {
        this.sendHeartbeat();
      } catch (err) {
        if ((err as { code?: string })?.code === "CONNECTION_CLOSED") this.stopHeartbeat();
      }
    }, intervalMs);
  }

  /** Stop sending periodic heartbeats. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Stop the task prune timer. */
  private stopPruneTimer(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  // ─── Task access ───────────────────────────────────────────────────

  /** Get a tracked task by ID. */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  // ─── Budget (§7.7) ─────────────────────────────────────────────────

  /** An initiating request's budget: valid, and at revision 0 — the revision
   *  counter belongs to the Task's lifetime, and a fresh request (including a
   *  resubmission after refuse-with-estimate) starts a fresh conversation. */
  private checkInitiatingBudget(budget: Budget): void {
    validateBudget(budget);
    if (budget.revision !== 0) {
      throw new MeshError(
        ErrorCode.INVALID_ENVELOPE,
        `budget.revision must be 0 on an initiating request (§7.7), got ${budget.revision} — ` +
          `revisions travel as task updates (reviseBudget)`,
        { retryable: false },
      );
    }
  }

  /**
   * Register a handler for updates to Tasks this agent initiated (§6.5): state
   * transitions, outputs, and budget revisions on `mesh.task.<id>.update`.
   *
   * One handler for all tasks, matching `onDefault`'s shape — dispatch on
   * `update.task_id`. The SDK's own bookkeeping (state, artifacts, latest-wins
   * budget) runs whether or not a handler is set; the handler is the
   * application's window, not the mechanism. Updates this agent published
   * itself (its own budget revisions echoed back) are book-kept but not
   * surfaced.
   */
  // ─── Messages for the person behind an agent (SPEC.md §5.7) ─────────

  /**
   * Where messages written to this agent's person go. A request, a respond or
   * a room post marked `meta.audience: "person"` (or any string other than
   * "agent") is given to no offering handler, no tool and no model: the SDK
   * hands it here, with the verified sender and the time, for the host to show
   * the person on the surface where they review what concerns this agent.
   * Register it before `register({ personMessages: true })`, which declares
   * `mesh://extensions/audience/v1`.
   */
  onPersonMessage(handler: PersonMessageHandler | null): void {
    this.personHandler = handler;
  }

  /**
   * The person's setting (§5.7): whether they let this agent read messages
   * written to them, for everyone (`true`) or for the senders a function
   * accepts. Off until the person turns it on. With it on, each message
   * handed to `onPersonMessage` also carries `agentNote`: the text framed
   * with the audience line, which the agent may tell its person about,
   * summarize or draft an answer from, and acts on in no way. Nothing is ever
   * dispatched to an offering handler.
   */
  setPersonMessages(opts: { agentMayRead: AgentMayRead }): void {
    this.agentMayRead = opts.agentMayRead;
  }

  /** Whether an agent declares that it keeps §5.7's rules: `true`, `false`,
   *  or `"unknown"` when its manifest could not be read. */
  async audienceDeclaredBy(agentId: string): Promise<boolean | "unknown"> {
    try {
      return declaresAudience(await this.getManifest(agentId));
    } catch {
      return "unknown";
    }
  }

  /** The sender's pre-flight (§5.7): refuses locally with
   *  `AUDIENCE_NOT_SUPPORTED`, naming the receivers that do not declare the
   *  extension, unless the caller chose to send anyway. */
  private async preflightAudience(receivers: readonly string[], sendAnyway: boolean | undefined): Promise<void> {
    if (sendAnyway === true) return;
    const seen: AudienceReceiver[] = [];
    for (const id of receivers) seen.push({ id, declares: await this.audienceDeclaredBy(id) });
    const verdict = audiencePreflight(seen, { sendAnyway });
    if (!verdict.send) {
      throw new MeshError(
        ErrorCode.AUDIENCE_NOT_SUPPORTED,
        `${verdict.receivers.join(", ")} ${verdict.receivers.length === 1 ? "does" : "do"} not declare ` +
          `${AUDIENCE_EXTENSION_URI}, so nothing says this message will reach the person rather than the ` +
          `agent (SPEC §5.7). Nothing was sent. Ask your person whether to send anyway: their agent may ` +
          `read this as a request.`,
        { retryable: false, details: { receivers: verdict.receivers } },
      );
    }
  }

  /**
   * Send a message written to the person behind another agent (§5.7): a
   * `request` marked `meta.audience: "person"`, with the text in
   * `payload.text`, no offering, no budget and no task id. Refused locally
   * with `AUDIENCE_NOT_SUPPORTED` when the receiver does not declare
   * `mesh://extensions/audience/v1`, unless `sendAnyway` is set; the agent
   * SHOULD take that choice from its own person.
   *
   * Resolves with `queued` (the receiver's queued acknowledgement, which is
   * what a receiver that keeps §5.7 answers), `unconfirmed` (no answer in
   * time; a registered receiver's mailbox has it), or `answered` (the
   * receiver answered it as work, which a receiver that keeps §5.7 never
   * does). A person's reply arrives later through `onPersonMessage`.
   */
  async sendToPerson(
    agentId: string,
    text: string,
    opts: { sendAnyway?: boolean; context_id?: string; timeout_ms?: number } = {},
  ): Promise<{ outcome: "queued" | "unconfirmed" | "answered"; request_id: string; inbox_id?: string; payload?: unknown }> {
    if (this.namingGate) await this.namingGate.require();
    this.admissionGate?.noteAddressed(agentId);
    await this.preflightAudience([agentId], opts.sendAnyway);
    const recipient = this.manifestCache.get(agentId);
    preflightSenderText({ text }, effectiveInboundCap(recipient));
    const envelope = this.newEnvelope({
      type: "request",
      from: this.agentId,
      to: agentId,
      context_id: opts.context_id,
      payload: { text },
      meta: { audience: "person" },
    });
    const bytes = encode(envelope);
    preflightEnvelopeSize(bytes.length, this.conn.maxPayload);
    try {
      const resp = await this.awaitAgentReply(
        this.resolvedInbox(agentId),
        envelope,
        bytes,
        agentId,
        opts.timeout_ms ?? 30_000,
        {},
      );
      if (resp.error) throw MeshError.fromErrorObject(resp.error);
      return { outcome: "answered", request_id: envelope.id, payload: resp.payload };
    } catch (err) {
      if (err instanceof MeshError && err.code === ErrorCode.REQUEST_QUEUED) {
        const inbox = err.details?.inbox_id;
        return { outcome: "queued", request_id: envelope.id, ...(typeof inbox === "string" ? { inbox_id: inbox } : {}) };
      }
      if (
        err instanceof MeshError &&
        (err.code === ErrorCode.TRANSPORT_TIMEOUT || err.code === ErrorCode.TRANSPORT_NO_RESPONDERS)
      ) {
        return { outcome: "unconfirmed", request_id: envelope.id };
      }
      throw err;
    }
  }

  /**
   * The person's reply to a message written to them (§5.7): a bare
   * `respond` marked for a person in turn, `in_reply_to` the message,
   * `payload.status: "completed"` and the text in `payload.text`, with no
   * task id. Sent only with the person's own words: a reply the agent writes
   * without the person's approval is the agent's own message and goes out as
   * an ordinary one. The same pre-flight applies as for `sendToPerson`.
   */
  async replyToPerson(
    original: Pick<Envelope, "id" | "from">,
    text: string,
    opts: { sendAnyway?: boolean } = {},
  ): Promise<{ id: string }> {
    if (this.namingGate) await this.namingGate.require();
    await this.preflightAudience([original.from], opts.sendAnyway);
    const envelope = this.newEnvelope({
      type: "respond",
      from: this.agentId,
      to: original.from,
      in_reply_to: original.id,
      payload: { status: "completed", text },
      meta: { audience: "person" },
    });
    const bytes = encode(envelope);
    preflightEnvelopeSize(bytes.length, this.conn.maxPayload);
    this.conn.publish(this.resolvedInbox(original.from), bytes);
    return { id: envelope.id };
  }

  /** Hand a message written to the person to the person surface (§5.7 rule
   *  2), with the agent's framed copy when the person allows it. Returns
   *  whether a surface took it. */
  private surfaceToPerson(
    env: Envelope,
    kind: PersonMessage["kind"],
    extra: { text?: string; roomId?: string } = {},
  ): boolean {
    const text = extra.text ?? personTextOf(env.payload);
    const receivedAt = new Date();
    const allow =
      typeof this.agentMayRead === "function" ? this.agentMayRead(env.from) === true : this.agentMayRead === true;
    const message: PersonMessage = {
      kind,
      from: env.from,
      receivedAt: receivedAt.toISOString(),
      ...(text !== undefined ? { text } : {}),
      ...(typeof env.in_reply_to === "string" ? { inReplyTo: env.in_reply_to } : {}),
      ...(extra.roomId ? { roomId: extra.roomId } : {}),
      ...(allow && text !== undefined
        ? { agentNote: frameForPerson(text, { from: env.from, trace: env.trace, receivedAt }) }
        : {}),
      envelope: env,
    };
    const handler = this.personHandler;
    if (!handler) {
      this.onSecurityWarning?.({
        code: "person_message_unsurfaced",
        message:
          "a message written to this agent's person arrived and no person surface is registered " +
          "(onPersonMessage), so it was given to no handler and shown to nobody (SPEC §5.7)",
        from: env.from,
        subject: this.agentId,
      });
      return false;
    }
    try {
      const r = handler(message);
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
    } catch {
      /* a surface that throws does not make the message work for the agent */
    }
    return true;
  }

  /** §5.7 rule 6 and §22.7: a marked event or Task update goes to no handler,
   *  and the agent hears about it. */
  private dropMarked(env: Envelope, where: string): void {
    this.onSecurityWarning?.({
      code: "audience_marked_dropped",
      message: `dropped ${where} marked meta.audience for a person: it is never given to a handler (SPEC §5.7)`,
      from: env.from,
      subject: this.agentId,
    });
  }

  onTaskUpdate(handler: TaskUpdateHandler): void {
    this.taskUpdateHandler = handler;
  }

  /**
   * Wait for a Task's terminal update (§7.3) and return its payload — for a
   * completion, the `output` (§11.3 step 6) with the §19.3 `cost` and §13.5
   * `usage` exactly as a bare terminal respond would carry them.
   *
   * This is the requester's half of §7.0 deferral
   * (`HandlerOptions.deferAfterMs`): a request that resolved with
   * `status: "working"` and a `task_id` is work still running, and this is how
   * to wait for it. Three sources, so no terminal is lost: the local task
   * store (the request path has watched the update subject since before it
   * returned `working`), this call's own subscription, and the task manager's
   * durable record (§7.4), read once the subscription is live and again at
   * growing intervals while the wait lasts. The record also answers a caller
   * that restarted and holds no local record of the task, as long as it is
   * the task's requester. Resolves on `completed`, `failed`, `canceled`,
   * `exhausted` or `rejected`; rejects with TRANSPORT_TIMEOUT when the wait
   * elapses first.
   */
  async awaitTask(taskId: string, timeoutMs = 300_000): Promise<RespondPayload> {
    return await new Promise<RespondPayload>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let wakePoll: (() => void) | undefined;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        wakePoll?.();
        sub.unsubscribe();
        fn();
      };
      const sub = this.conn.subscribe(Subjects.taskUpdate(taskId), (msg: Msg) => {
        try {
          // Signed updates only (§4.5): an update that does not verify is not
          // a statement anyone made.
          const updateEnv = decode(msg.data);
          if (updateEnv.task_id !== taskId) return;
          const payload = updateEnv.payload as RespondPayload | undefined;
          if (payload?.status && TERMINAL_STATES.has(payload.status as TaskState)) {
            finish(() => resolve(payload));
          }
        } catch {
          /* undecodable/unsigned traffic on an update subject is dropped */
        }
      });
      timer = setTimeout(() => {
        finish(() =>
          reject(
            new MeshError(
              ErrorCode.TRANSPORT_TIMEOUT,
              `task ${taskId} reached no terminal state within ${timeoutMs}ms`,
            ),
          ),
        );
      }, timeoutMs);
      const fromLocal = (): boolean => {
        const payload = this.terminalPayload(taskId);
        if (payload) finish(() => resolve(payload));
        return payload !== undefined;
      };
      if (fromLocal()) return;
      void (async () => {
        // Once the connection has flushed, this call's subscription is live:
        // a terminal published from then on arrives on it. One published
        // before is in the local store or in the task manager's record.
        await this.connFlushed();
        let wait = TASK_RECORD_POLL_FIRST_MS;
        while (!done) {
          if (fromLocal()) return;
          const recorded = await this.terminalFromRecord(taskId);
          if (recorded) {
            finish(() => resolve(recorded));
            return;
          }
          if (fromLocal() || done) return;
          await new Promise<void>((r) => {
            wakePoll = r;
            pollTimer = setTimeout(r, wait);
            (pollTimer as unknown as { unref?: () => void }).unref?.();
          });
          wait = Math.min(wait * 2, TASK_RECORD_POLL_MAX_MS);
        }
      })();
    });
  }

  /** A Task's terminal payload from the task manager's record (§7.4), or
   *  undefined while it is still running or the record cannot be read. For a
   *  Task this agent tracks, the record's statements go through recoverTask
   *  like any other update. For one it does not (a requester that restarted),
   *  only a terminal statement signed by the record's responder, on a record
   *  naming this agent as the requester, is taken. */
  private async terminalFromRecord(taskId: string): Promise<RespondPayload | undefined> {
    if (this.tasks.get(taskId)) {
      await this.recoverTask(taskId);
      return this.terminalPayload(taskId);
    }
    let record: { requester?: string; responder?: string; history?: Envelope[] } | undefined;
    try {
      record = (await this.serviceRequest(Subjects.taskGet(taskId), { task_id: taskId }, TASK_RECORD_TIMEOUT_MS)) as typeof record;
    } catch {
      return undefined;
    }
    if (!record || record.requester !== this.agentId || !record.responder) return undefined;
    const history = Array.isArray(record.history) ? record.history : [];
    for (let i = history.length - 1; i >= 0; i--) {
      let env: Envelope;
      try {
        env = decode(encode(history[i]));
      } catch {
        continue;
      }
      if (env.type !== "respond" || env.task_id !== taskId || env.from !== record.responder) continue;
      const payload = env.payload as RespondPayload | undefined;
      if (payload?.status && TERMINAL_STATES.has(payload.status as TaskState)) return payload;
    }
    return undefined;
  }

  /**
   * The budget currently governing a Task: the highest-revision budget seen,
   * from the initiating request or any revision by either party. Absolute
   * semantics (§7.7) — the latest revision is the whole truth, and revisions
   * at or below it were ignored. Undefined when the task is unknown here or
   * never had a budget.
   */
  currentBudget(taskId: string): Budget | undefined {
    return this.tasks.get(taskId)?.budget;
  }

  /**
   * Revise a Task's budget (§7.7): publish a task update carrying only the
   * `budget` block — the ENTIRE budget, because revisions are absolute, never
   * deltas — with the next revision number.
   *
   * `budget.revision` may be omitted: the SDK tracks the current revision per
   * task it initiated and increments it. When supplied it must be greater than
   * the current one — monotonicity is enforced locally before anything is
   * sent, so a stale caller cannot publish a revision the mesh (and this SDK's
   * own latest-wins bookkeeping) would ignore. A terminal Task's budget cannot
   * be revised (`TASK_INVALID_TRANSITION`), matching the task manager's rule.
   *
   * Returns the full budget as sent, revision included.
   */
  reviseBudget(taskId: string, budget: BudgetRevision): Budget {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new MeshError(
        ErrorCode.TASK_NOT_FOUND,
        `Task ${taskId} is not tracked here — only a party to a Task may revise its budget (§7.7)`,
      );
    }
    if (TERMINAL_STATES.has(task.state)) {
      throw new MeshError(
        ErrorCode.TASK_INVALID_TRANSITION,
        `Task ${taskId} is ${task.state} — a Task in a terminal state cannot have its budget revised (§7.7)`,
      );
    }

    const current = task.budget?.revision;
    const full: Budget = {
      ...budget,
      // First statement of a budget on a hitherto budget-less Task starts at 0;
      // otherwise the next revision.
      revision: budget.revision ?? (current === undefined ? 0 : current + 1),
    };
    validateBudget(full);
    if (current !== undefined && full.revision <= current) {
      throw new MeshError(
        ErrorCode.TASK_INVALID_TRANSITION,
        `budget revision ${full.revision} is not after the current revision ${current} — ` +
          `revisions are absolute and monotonic (§7.7)`,
      );
    }

    const envelope = this.newEnvelope({
      type: "respond",
      from: this.agentId,
      to: task.responder === this.agentId ? task.requester : task.responder,
      task_id: taskId,
      budget: full,
      // Deliberately no payload: §7.7 — "a task update carrying only the
      // `budget` block". A status here would be this party asserting task
      // state it does not own.
    });
    // We subscribe to the very subject we are about to publish on, so our own
    // revision comes back around. Remember it now and the echo is dropped by
    // the §22.2 memory instead of being book-kept twice.
    this.rememberInboxId(this.agentId, envelope.id);
    this.conn.publish(Subjects.taskUpdate(taskId), encode(envelope));

    this.tasks.applyBudget(taskId, full);
    this.tasks.addToHistory(taskId, envelope);
    return full;
  }

  // ─── Owner allowance (EXT-8) ───────────────────────────────────────

  /**
   * Arm an owner allowance (extensions/EXT-8-allowance.md): a signed,
   * node-held spending policy this agent's own node enforces at admission.
   * From here on, every inbound request is priced (host estimator, else
   * tokens ≈ ceil(sender-text chars / 4), through the document's cost_model)
   * and checked against every applicable ceiling BEFORE the §6.4a accept is
   * emitted and before any handler runs — an allowance-broke refusal is a
   * refusal of admission, and §6.4a orders those "instead of an accept, never
   * after one". The refusal is §7.7's refusal-with-estimate
   * (`BUDGET_INSUFFICIENT`, `details.estimate` = the price quote), on the wire
   * indistinguishable from a budget-broke one, deliberately.
   *
   * **Never throws.** A document that fails shape or signature verification
   * still arms — in the FAIL-CLOSED state, where every ceiling reads exhausted
   * until a valid replacement arrives (EXT-8 §1: failing open here is failing
   * open on the owner's money). The returned status (also `allowanceStatus()`)
   * is how the host observes that state: `valid: false` plus `error`. A
   * document governing a different agent fails closed the same way.
   *
   * Replacing the document (the owner raising a ceiling, `on_exhausted`
   * flipping) keeps the ledger: spend already metered stays accounted.
   *
   * `opts.onAskOwner` is the owner channel for `on_exhausted: "ask_owner"`:
   * the SDK holds the work unstarted and asks the HOST (it cannot email
   * anyone). Resolve `true` after raising the ceiling via a fresh
   * `setAllowance` and the SDK re-checks admission; `false` (or no handler
   * registered at all) refuses with the same shape `refuse` uses.
   */
  setAllowance(
    doc: unknown,
    opts?: { estimateTokens?: AllowanceEstimator; onAskOwner?: AllowanceAskOwnerHandler },
  ): AllowanceStatus {
    this.allowance = new AllowanceEngine(doc, {
      expectedAgent: this.agentId,
      inheritLedgerFrom: this.allowance ?? undefined,
    });
    if (opts?.estimateTokens !== undefined) this.allowanceEstimator = opts.estimateTokens;
    if (opts?.onAskOwner !== undefined) this.allowanceAskOwner = opts.onAskOwner;
    return this.allowance.status();
  }

  /** Disarm the allowance entirely: no metering, no allowance admission. This
   *  is the owner REMOVING their policy — distinct from a broken document,
   *  which stays armed fail-closed (see setAllowance). Ledger included. */
  clearAllowance(): void {
    this.allowance = null;
    this.allowanceAskOwner = null;
    this.allowanceEstimator = null;
  }

  /** The armed allowance as the host observes it — including the fail-closed
   *  error state — or null when none is armed. */
  allowanceStatus(): AllowanceStatus | null {
    return this.allowance?.status() ?? null;
  }

  /** The queryable spend ledger (EXT-8 §2): every metered entry plus the
   *  per-task / per-context / per-UTC-day rollups the ceilings are enforced
   *  against. Empty (currency null) when no valid allowance is armed. */
  allowanceLedger(): AllowanceLedgerView {
    return (
      this.allowance?.ledgerView() ?? {
        currency: null,
        entries: [],
        total_micro: 0,
        by_task: {},
        by_context: {},
        by_day: {},
        by_trial_day: {},
      }
    );
  }

  /**
   * Report a task's model usage to the allowance meter — the host-side twin of
   * `ctx.reportUsage`, for hosts that learn their usage after the turn rather
   * than inside the handler. `{ tokens }` converts through the armed
   * document's cost_model with the fixture-pinned floor;
   * `{ cost_micro }` is money directly. Accounted to the task, `contextId`
   * (defaulting to the tracked Task's own context, if this SDK tracked it),
   * and the UTC day of this instant.
   *
   * A FAIL-CLOSED allowance (broken document, wrong agent) still records:
   * admission is refusing everything, but spend that already happened must
   * survive into the valid replacement, not be forgiven with the breakage.
   * Returns the ledger entry, or null when no allowance is armed at all or
   * tokens were reported with no readable cost model to convert them.
   */
  reportUsage(
    taskId: string,
    usage: AllowanceUsage,
    contextId?: string,
  ): AllowanceLedgerEntry | null {
    if (!this.allowance) return null;
    const ctx = contextId ?? this.tasks.get(taskId)?.context_id;
    // Trial work (Common Agent 7.7) is metered as trial spend: against the
    // trial ceiling and every wider one.
    return this.allowance.record(taskId, ctx, usage, new Date(), { trial: this.trialTasks.has(taskId) });
  }

  // ─── Trials (Common Agent 7.7) ───────────────────────────────

  /**
   * Configure how this node admits trial requests: the Descriptor whose
   * offerings carry `trial` (or the declarations directly), where counts are
   * kept, which senders are trusted hosts whose `trial_requester` vouch is
   * honoured, and how a sender agent is judged signed in and verified.
   * Replaces what was set before; the ledger is kept unless a new one is given.
   */
  setTrials(opts: TrialNodeOptions): void {
    this.trialOpts = { ...opts };
    if (opts.ledger) this.trialLedger = opts.ledger;
  }

  /** The trial an offering declares, from `setTrials` or from the manifest
   *  this agent registered, or null. Read leniently: a declaration that does
   *  not validate is no trial. */
  private trialDeclarationFor(offeringId: string): { trial: TrialDeclaration | null; inputs: ReadonlyArray<{ name?: unknown; kind?: unknown }> } {
    const explicit = this.trialOpts.trials?.[offeringId];
    const fromDescriptor = descriptorOffering(this.trialOpts.descriptor, offeringId);
    const fromManifest = (this.manifest?.offerings ?? []).find((o) => o.id === offeringId) as unknown as Record<string, unknown> | undefined;
    const source = fromDescriptor ?? fromManifest ?? null;
    const inputs = Array.isArray(fromDescriptor?.inputs)
      ? (fromDescriptor!.inputs as Array<{ name?: unknown; kind?: unknown }>)
      : offeringsFromManifest(this.manifest).find((o) => o.id === offeringId)?.inputs ?? [];
    // Checked against the Descriptor's offering when there is one, so a shape
    // naming an input it does not declare is no trial. A manifest declares
    // inputs as a schema and no outputs, so a declaration read beside one is
    // checked on its own.
    const candidate = explicit !== undefined ? explicit : source?.trial;
    const trial = candidate !== undefined && validateTrial(candidate, fromDescriptor) === null
      ? (candidate as TrialDeclaration)
      : null;
    return { trial, inputs };
  }

  /**
   * The trial gate (Common Agent 7.7), run on a request carrying
   * `trial: true` before the allowance, the agreement and the accept.
   * Returns the trial context to admit, or null after sending the refusal as
   * this dispatch's first and only reply.
   */
  private async trialAdmissionGate(
    msg: Msg,
    env: Envelope,
    reqPayload: RequestPayload,
    taskId: string,
    transportReply: boolean,
  ): Promise<TrialContext | null> {
    const now = new Date();
    const offering = reqPayload.offering;
    // The application decides (TrialNodeOptions.gatedBy): the node marks the
    // task as trial work and lets the application's admit refuse or admit it.
    if (this.trialOpts.gatedBy === "application") {
      const ctx: TrialContext = {
        trial: true,
        requester: trialRequesterOf({ senderKey: env.from, vouch: undefined, trustedHost: false, sender: { signed_in: false, verified: false } }),
        shape: undefined,
        caps: [],
      };
      this.trialTasks.set(taskId, ctx);
      if (this.trialTasks.size > MAX_TRACKED_TRIAL_TASKS) {
        const oldest = this.trialTasks.keys().next().value;
        if (oldest !== undefined) this.trialTasks.delete(oldest);
      }
      return ctx;
    }
    const { trial, inputs: declared } = this.trialDeclarationFor(offering);
    const sku = skuFor(this.registerOpts?.skus, offering);
    const quote = quoteFromPrice(sku ? sku.price : { model: "free" });
    const hasBudget = env.budget !== undefined && env.budget !== null;

    const trustedHost = isTrustedHost(this.trialOpts.trustedHosts, env.from);
    const vouch = trustedHost ? reqPayload.trial_requester : undefined;
    let sender = { signed_in: false, verified: false };
    // Only asked when the vouch does not decide it and the trial asks who.
    if (!hasBudget && trial && !(trustedHost && vouch)) {
      try {
        sender = this.trialOpts.describeSender
          ? await this.trialOpts.describeSender(env.from)
          : { signed_in: (await this.consumerOwner(env.from)) !== null, verified: false };
      } catch {
        sender = { signed_in: false, verified: false };
      }
    }
    const requester: TrialRequester = trialRequesterOf({ senderKey: env.from, vouch, trustedHost, sender });
    const key = trialLedgerKey(requester, env.from);
    const counts = trial ? await this.trialLedger.counts(key, offering, now) : { requester_day: 0, day: 0, requester_ever: 0 };

    // The funds answer: no allowance at all is no trial ceiling, so `none`.
    let funds: TrialFunds = { state: "none" };
    if (this.allowance && trial) {
      const estimateTokens = this.allowanceEstimator
        ? this.allowanceEstimator(env, reqPayload)
        : Math.ceil(inboundTextLength(reqPayload.input) / 4);
      const estimateMicro = this.allowance.priceTokens(estimateTokens) ?? 0;
      funds = this.allowance.trialFunds(taskId, env.context_id, estimateMicro, now);
    }

    const decision = trialAdmission({
      trial,
      hasBudget,
      requester,
      // With no declared inputs to read kinds from, the shape's own inputs
      // are read as text, the default kind: free text is never let past a
      // limit for want of a declaration.
      inputs: trialInputsOf(reqPayload.input, declared.length ? declared : (trial?.shape?.inputs ?? []).map((i) => ({ name: i.name }))),
      counts,
      funds,
      quote,
      now,
      agentName: this.trialOpts.agentName ?? (this.manifest?.name ? String(this.manifest.name) : undefined),
    });
    if (!decision.ok) {
      const refuseEnv = this.newEnvelope({
        type: "respond",
        from: this.agentId,
        to: env.from,
        in_reply_to: env.id,
        task_id: env.task_id,
        trace: childSpan(env.trace),
        error: {
          code: decision.refusal.code,
          message: decision.refusal.message,
          retryable: false,
          details: decision.refusal.details as unknown as Record<string, unknown>,
        },
        payload: { status: "failed" },
      });
      this.sendRespond(msg, env, encode(refuseEnv), { transportReply, tap: true });
      return null;
    }
    // Admitted: count it now, before any work. Never undone.
    await this.trialLedger.record(key, offering, now);
    const ctx: TrialContext = { trial: true, requester, shape: trial!.shape, caps: workCaps(trial!.shape) };
    this.trialTasks.set(taskId, ctx);
    if (this.trialTasks.size > MAX_TRACKED_TRIAL_TASKS) {
      const oldest = this.trialTasks.keys().next().value;
      if (oldest !== undefined) this.trialTasks.delete(oldest);
    }
    return ctx;
  }

  /** `{ trial: true }` for a task admitted as a trial, to spread into the
   *  payload of its responses and task updates; empty otherwise. */
  private trialMark(taskId: string): { trial?: true } {
    return this.trialTasks.has(taskId) ? { trial: true } : {};
  }

  /**
   * Report a declared meter quantity for a task's §13.5 usage receipt — the
   * host-side twin of `ctx.reportMeter`, for hosts that learn their usage
   * after the turn rather than inside the handler. Additive per (task, meter);
   * the accumulated entries ride the task's terminal respond as
   * `payload.usage`, covered by the envelope signature (a usage report is a
   * signed receipt with no new signature). Quantity twin of `reportUsage`,
   * which meters MONEY through the EXT-8 cost model — report both when both
   * are known; neither implies the other.
   *
   * Throws INPUT_INVALID on a malformed report: meter names are
   * `[a-z0-9_]{1,64}`, never an observed meter's name, quantities are
   * non-negative integers.
   */
  reportMeterUsage(taskId: string, meter: string, quantity: number): void {
    this.meterUsage.report(taskId, meter, quantity);
  }

  // ─── Agreements (§19.5) ──────────────────────────────────────

  /**
   * Arm the agreements this node enforces against — the consumer-signed
   * acceptances of THIS agent's terms. Each is verified as it is armed; one
   * that does not check out is DROPPED with a warning rather than held, which
   * is the safe direction: an unverifiable agreement authorises nothing.
   *
   * The platform is the store (§19.5's store-and-sync posture); this is the
   * enforcing copy. Replaces the whole set, so a revocation is a re-arm
   * without the revoked document.
   */
  setAgreements(docs: readonly unknown[]): { armed: number; rejected: number } {
    const next = new Map<string, AgreementDocument[]>();
    let rejected = 0;
    for (const raw of docs) {
      let doc: AgreementDocument;
      try {
        doc = loadAgreement(raw);
      } catch (err) {
        rejected++;
        console.warn(
          `[agentmesh] agreement dropped: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      // An agreement naming a different seller is somebody else's business.
      if (doc.seller_agent !== this.agentId) {
        rejected++;
        continue;
      }
      const held = next.get(doc.consumer_owner) ?? [];
      held.push(doc);
      next.set(doc.consumer_owner, held);
    }
    this.agreements = next;
    return { armed: [...next.values()].reduce((n, v) => n + v.length, 0), rejected };
  }

  /** The agreements currently armed, flattened — what this node would enforce
   *  against right now. */
  heldAgreements(): AgreementDocument[] {
    return [...this.agreements.values()].flat();
  }

  /**
   * Override how a consumer owner's agreements are fetched. The default asks
   * the platform (`mesh.agreements.list`, filtered to this seller), which is
   * what a deployment running the services already has; supply this for one
   * that does not, or to read from a cache of your own.
   *
   * Called at most once per owner per TTL. A throw is treated as "no
   * agreements", so an outage refuses paid work rather than giving it away.
   */
  onAgreementLookup(fn: (consumerOwner: string) => Promise<unknown[]>): void {
    this.agreementLookup = fn;
  }

  /**
   * Override how a job's funds hold is placed. The default asks the platform
   * (`mesh.funds.hold`), which is what a deployment running the services
   * already has; supply this for one that does not, or to authorise against a
   * ledger of your own.
   *
   * Called once per admitted paid dispatch, after the §19.5 coverage check and
   * before any work. The answer is read through `loadFundsHoldResult` whoever
   * supplied it, so a host hook cannot admit work by answering with a shape
   * the contract does not define.
   *
   * A throw REFUSES the work: a balance this agent could not check is not a
   * balance it may spend against. Throw a `MeshError` with code
   * `INSUFFICIENT_FUNDS` — carrying the shortfall and a top-up URL in
   * `details` — to have the buyer told exactly that, or `BUDGET_INSUFFICIENT`
   * — carrying the estimate and the spend ceiling in `details` — when the job
   * would pass an engagement's ceiling; any other throw refuses as "the funds
   * service could not be reached", which is retryable.
   */
  onFundsHold(fn: (req: FundsHoldRequest) => Promise<unknown>): void {
    this.fundsHold = fn;
  }

  /**
   * Override how a hold is given back. The default asks the platform
   * (`mesh.funds.release`).
   *
   * Called when a held task fails, is declined or is canceled — never when it
   * delivered, because a delivered job's hold is what the platform's draw
   * settles against. Best-effort by design: a release that cannot be sent
   * leaves the hold to expire, which is why the platform sets an expiry at all.
   */
  onFundsRelease(fn: (holdId: string, reason: string) => Promise<void>): void {
    this.fundsRelease = fn;
  }

  /** Where a human approves terms when a SKU names no `provider.checkout_url`
   *  — the deployment's own approval surface for the `internal` provider
   *  (§19.4). Without one, paid SKUs advertise but do not enforce. */
  setApprovalUrl(url: string): void {
    this.approvalUrl = url;
  }

  // ─── Cancel (§10.8) ────────────────────────────────────────────────

  /**
   * Cancel a Task this agent is party to, with a REQUIRED reason from the
   * closed §10.8 enum and an optional free-text note (the reason, not the
   * note, is what the record carries as meaning).
   *
   * Cancellation is effective when sent (§10.8, deliberately unacknowledged):
   * this method publishes the canceled update on the task's update subject —
   * which is what the task manager records — transitions the local record,
   * stops watching, and then notifies the counterparty's inbox with a
   * `task.cancel` request on a best-effort basis. The counterparty may be
   * offline with the cancel in its mailbox; that is the mesh working.
   *
   * Best-effort on the work: a Task already terminal here throws
   * `TASK_NOT_CANCELABLE`, and a completion that crossed the cancel in
   * flight stands.
   */
  cancel(taskId: string, reason: CancelReason, note?: string, qualifier?: StopQualifier): void {
    const unmetNeed = qualifier?.unmetNeed;
    const dependency = qualifier?.dependency;
    validateCancelReason(reason, note, unmetNeed, dependency);
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new MeshError(
        ErrorCode.TASK_NOT_FOUND,
        `Task ${taskId} is not tracked here — only a party to a Task may cancel it (§10.8)`,
      );
    }
    if (TERMINAL_STATES.has(task.state)) {
      throw new MeshError(
        ErrorCode.TASK_NOT_CANCELABLE,
        `Task ${taskId} is ${task.state} — a Task in a terminal state cannot be canceled (§10.8)`,
      );
    }

    const counterparty = task.responder === this.agentId ? task.requester : task.responder;

    // The record: a canceled update on the task's own subject, carrying the
    // reason next to the status (conformance/cancel.json `shapes`). Same
    // echo-suppression dance as reviseBudget: we subscribe to this subject.
    const updateEnv = this.newEnvelope({
      type: "respond",
      from: this.agentId,
      to: counterparty,
      task_id: taskId,
      payload: {
        status: "canceled",
        reason,
        ...(note !== undefined ? { note } : {}),
        ...(unmetNeed !== undefined ? { unmet_need: unmetNeed } : {}),
        ...(dependency !== undefined ? { dependency } : {}),
      },
    });
    this.rememberInboxId(this.agentId, updateEnv.id);
    this.conn.publish(Subjects.taskUpdate(taskId), encode(updateEnv));

    this.tasks.addToHistory(taskId, updateEnv);
    this.tasks.transition(taskId, "canceled");
    this.unwatchTaskUpdates(taskId);
    this.forgetDelegation(taskId);
    this.resumableTasks.forget(taskId);

    // The notification: tell the counterparty to stop, §10.8's composed
    // request. Fire-and-forget by design — the requester does not wait, and
    // silence means offline-with-a-mailbox, not failure.
    const cancelReq = this.newEnvelope({
      type: "request",
      from: this.agentId,
      to: counterparty,
      payload: {
        offering: "task.cancel",
        input: {
          task_id: taskId,
          reason,
          ...(note !== undefined ? { note } : {}),
          ...(unmetNeed !== undefined ? { unmet_need: unmetNeed } : {}),
          ...(dependency !== undefined ? { dependency } : {}),
        },
      },
    });
    void this.conn
      .request(this.resolvedInbox(counterparty), encode(cancelReq), {
        timeout: DEFAULT_REQUEST_TIMEOUT_MS,
      })
      .catch(() => {
        /* effective when sent (§10.8): delivery is on mailbox time */
      });
  }

  /**
   * End a Task this agent is performing as `failed`, saying why (§10.8).
   *
   * The reason is OPTIONAL: a Task that simply did not work out is a complete
   * statement and nobody is obliged to invent an excuse. What the reason buys
   * is the distinction between three endings that otherwise look identical in
   * the record — the performer did not deliver, the caller never furnished
   * something the offering declared it needed (`needs_not_furnished`, which
   * MUST name the declared need), and an outside service the performer depends
   * on broke (`dependency_failed`).
   *
   * What this method does NOT do is decide whose failure it was. That is
   * `attribution`, the platform computes it by checking the named need against
   * this agent's own registered manifest, and it is deliberately not something
   * a party can put on the wire (§10.8a). Saying `needs_not_furnished` about a
   * need that was never declared reads as a plain failure, so the way to be
   * believed is to declare what you need before the work starts.
   */
  failTask(taskId: string, reason?: CancelReason, note?: string, qualifier?: StopQualifier): void {
    const stop = validateStopFields(
      {
        ...(reason !== undefined ? { reason } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(qualifier?.unmetNeed !== undefined ? { unmet_need: qualifier.unmetNeed } : {}),
        ...(qualifier?.dependency !== undefined ? { dependency: qualifier.dependency } : {}),
      },
      false,
    );
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new MeshError(
        ErrorCode.TASK_NOT_FOUND,
        `Task ${taskId} is not tracked here — only a party to a Task may fail it (§10.8)`,
      );
    }
    if (TERMINAL_STATES.has(task.state)) {
      throw new MeshError(
        ErrorCode.TASK_INVALID_TRANSITION,
        `Task ${taskId} is ${task.state} — a Task in a terminal state cannot fail (§7.3)`,
      );
    }

    const counterparty = task.responder === this.agentId ? task.requester : task.responder;
    const updateEnv = this.newEnvelope({
      type: "respond",
      from: this.agentId,
      to: counterparty,
      task_id: taskId,
      payload: { status: "failed", ...stop },
    });
    this.rememberInboxId(this.agentId, updateEnv.id);
    this.conn.publish(Subjects.taskUpdate(taskId), encode(updateEnv));

    this.tasks.addToHistory(taskId, updateEnv);
    this.tasks.transition(taskId, "failed");
    this.unwatchTaskUpdates(taskId);
    this.forgetDelegation(taskId);
    // Ended: no request resumes it any more.
    this.resumableTasks.forget(taskId);
  }

  /** Record the sub-request a running handler just issued (§10.8): if there
   *  is an ambient dispatch context, the new task is a delegation of it. */
  private recordDelegation(subTaskId: string): void {
    const dispatch = currentDispatch();
    if (!dispatch) return;
    let entry = this.delegations.get(dispatch.taskId);
    if (!entry) {
      entry = { offering: dispatch.offering, subs: new Set() };
      this.delegations.set(dispatch.taskId, entry);
    }
    entry.subs.add(subTaskId);
    this.subToParent.set(subTaskId, dispatch.taskId);
  }

  /** Drop a sub-task from its parent's delegation record (terminal, canceled
   *  locally, or pruned). */
  private forgetDelegation(subTaskId: string): void {
    const parent = this.subToParent.get(subTaskId);
    this.subToParent.delete(subTaskId);
    if (parent === undefined) return;
    const entry = this.delegations.get(parent);
    if (!entry) return;
    entry.subs.delete(subTaskId);
    if (entry.subs.size === 0) this.delegations.delete(parent);
  }

  /** §10.8 propagation: an inbound cancel for `parentTaskId` forwards to each
   *  still-live delegate as `upstream_cancelled`, the original reason in the
   *  note — unless the handler that delegated opted out. */
  private propagateCancel(parentTaskId: string, reason: CancelReason, note?: string): void {
    const entry = this.delegations.get(parentTaskId);
    if (!entry) return;
    // The opt-out is per handler, looked up by the offering that delegated
    // (`propagateCancel: false` = "this handler manages its own delegates").
    if (this.router.optionsFor(entry.offering)?.propagateCancel === false) return;
    this.delegations.delete(parentTaskId);
    const forwardedNote = propagatedCancelNote(reason, note);
    for (const subId of [...entry.subs]) {
      this.subToParent.delete(subId);
      const sub = this.tasks.get(subId);
      if (!sub || TERMINAL_STATES.has(sub.state)) continue;
      try {
        this.cancel(subId, "upstream_cancelled", forwardedNote);
      } catch {
        /* best-effort per delegate: one failed forward must not stop the rest */
      }
    }
  }

  /** Subscribe to a Task's update subject. Idempotent per task.
   *
   *  Resolves when the subscription is live on the broker. On RabbitMQ a
   *  subscription is a queue bound to the exchange a few round trips after it
   *  is asked for, and a message published before the binding exists is
   *  routed to no queue at all. When the task id came from the responder (a
   *  deferred answer, §7.0), the responder can publish the terminal update
   *  before that binding exists, so the caller waits for it here, and once it
   *  is live the task manager's durable record is read once (§7.4) for any
   *  statement published in the gap. A second read follows a little later,
   *  for a statement the task manager had not stored yet at the first. */
  private watchTaskUpdates(taskId: string, opts: { readRecord?: boolean } = {}): Promise<void> {
    const existing = this.taskUpdateBound.get(taskId);
    if (this.taskUpdateSubs.has(taskId) && existing) return existing;
    const sub = this.conn.subscribe(Subjects.taskUpdate(taskId), (msg: Msg) => {
      try {
        // Full decode: updates progress local Task state and carry budget
        // revisions, so an unsigned or forged one must not (§4.5, §5.3).
        this.handleTaskUpdate(taskId, decode(msg.data));
      } catch {
        // Undecodable/unsigned traffic on an update subject is dropped.
      }
    });
    this.taskUpdateSubs.set(taskId, sub);
    const bound = this.connFlushed();
    this.taskUpdateBound.set(taskId, bound);
    if (opts.readRecord === false) return bound;
    void bound.then(async () => {
      if (!this.taskUpdateSubs.has(taskId)) return;
      if (await this.recoverTask(taskId)) return;
      if (!this.taskUpdateSubs.has(taskId)) return;
      const timer = setTimeout(() => {
        this.taskRecheckTimers.delete(taskId);
        if (this.taskUpdateSubs.has(taskId)) void this.recoverTask(taskId);
      }, TASK_RECORD_RECHECK_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.taskRecheckTimers.set(taskId, timer);
    });
    return bound;
  }

  private unwatchTaskUpdates(taskId: string): void {
    const sub = this.taskUpdateSubs.get(taskId);
    if (sub) {
      sub.unsubscribe();
      this.taskUpdateSubs.delete(taskId);
    }
    this.taskUpdateBound.delete(taskId);
    const timer = this.taskRecheckTimers.get(taskId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.taskRecheckTimers.delete(taskId);
    }
  }

  /**
   * Read the task manager's durable record of a Task this agent asked for
   * (`mesh.task.get.<id>`, §7.4) and apply the statements in it that the
   * update subscription did not deliver. Each one is checked like a live one:
   * its signature against its `from`, and only the Task's two parties may
   * progress it (handleTaskUpdate). Never throws; a mesh with no task record
   * (or none yet) changes nothing. True when the local Task is terminal.
   */
  private async recoverTask(taskId: string): Promise<boolean> {
    const isTerminal = () => {
      const t = this.tasks.get(taskId);
      return !!t && TERMINAL_STATES.has(t.state);
    };
    if (!this.tasks.get(taskId)) return false;
    if (isTerminal()) return true;
    let record: { history?: Envelope[] } | undefined;
    try {
      record = (await this.serviceRequest(Subjects.taskGet(taskId), { task_id: taskId }, TASK_RECORD_TIMEOUT_MS)) as
        | { history?: Envelope[] }
        | undefined;
    } catch {
      return isTerminal();
    }
    for (const env of Array.isArray(record?.history) ? record.history : []) {
      let verified: Envelope;
      try {
        // A statement read back from the record is verified exactly as one
        // read off the wire: its own signature, against its own `from`.
        verified = decode(encode(env));
      } catch {
        continue;
      }
      this.handleTaskUpdate(taskId, verified, true);
    }
    return isTerminal();
  }

  /** Resolves when everything this agent has asked of its connection so far
   *  has reached the broker, its subscriptions included (on RabbitMQ: bound).
   *  Never rejects; a connection that cannot say resolves at once. */
  private connFlushed(): Promise<void> {
    const conn = this.conn as unknown as { flush?: () => Promise<void> };
    if (typeof conn.flush !== "function") return Promise.resolve();
    return conn.flush().catch(() => undefined);
  }

  /** The terminal payload of a Task this agent tracks, or undefined while it
   *  is still running. */
  private terminalPayload(taskId: string): RespondPayload | undefined {
    const task = this.tasks.get(taskId);
    if (!task || !TERMINAL_STATES.has(task.state)) return undefined;
    for (let i = task.history.length - 1; i >= 0; i--) {
      const payload = task.history[i].payload as RespondPayload | undefined;
      if (payload?.status === task.state) return payload;
    }
    return { status: task.state } as RespondPayload;
  }

  /** Dispatch one verified envelope from a Task's update subject, or, with
   *  `recorded`, one read back from the task manager's durable record (§7.4).
   *  A recorded statement is old by construction, so its freshness bound is
   *  the mailbox's retention, as for the §16.4 drain; the seen-id memory still
   *  keeps a statement that also arrived live from being applied twice. */
  private handleTaskUpdate(taskId: string, env: Envelope, recorded = false): void {
    if (env.type !== "respond") return;
    if (env.task_id !== taskId) return;
    // "accepted" is not a Task state and never appears in a Task record
    // (§6.4a, §7.2): an accept has no business on an update subject at all.
    if ((env.payload as RespondPayload | undefined)?.status === "accepted") return;
    const task = this.tasks.get(taskId);
    if (!task) return;
    // Only the two parties to the Task may progress it — the local half of
    // §7.7's UNAUTHORIZED rule. `from` is signature-verified by decode().
    if (env.from !== task.responder && env.from !== task.requester) return;
    // §22.2/§22.3 hold on this path like any other inbound path: same dedup
    // memory (the update subject and the inbox can both deliver a copy), same
    // live freshness window.
    if (!this.rememberInboxId(env.from, env.id)) return;
    if (!this.freshEnough(env, recorded)) return;

    // SPEC.md §5.7 rule 6: a Task update marked for a person (or with a mark
    // that is not a string) is never a Task transition and goes to no handler.
    if (audienceOf(env) !== "agent") {
      this.dropMarked(env, `a Task update for ${taskId}`);
      return;
    }

    // Budget revisions: absolute, latest wins (§7.7). A lower-or-equal
    // revision is ignored by applyBudget, and a malformed budget is ignored
    // outright — the tracked budget stands either way.
    let appliedBudget: Budget | undefined;
    if (env.budget !== undefined) {
      try {
        validateBudget(env.budget);
        if (this.tasks.applyBudget(taskId, env.budget)) appliedBudget = env.budget;
      } catch {
        /* malformed revision: ignored */
      }
    }

    this.tasks.addToHistory(taskId, env);
    const payload = env.payload as RespondPayload | undefined;
    // Safe cast: the accept — the one non-Task status — was dropped above.
    const status = payload?.status as TaskState | undefined;
    if (status) {
      try {
        this.tasks.transition(taskId, status);
      } catch {
        /* out-of-order or repeated update: local state stands */
      }
    }
    if (env.artifacts?.length) this.tasks.addArtifacts(taskId, env.artifacts);
    if (status !== undefined && TERMINAL_STATES.has(status)) {
      this.unwatchTaskUpdates(taskId);
      // A terminal sub-task is no longer a live delegate (§10.8).
      this.forgetDelegation(taskId);
    }

    // Our own revisions come back around on the subject we publish and
    // subscribe; they were book-kept above and are not application news.
    if (env.from === this.agentId) return;
    this.taskUpdateHandler?.(
      {
        task_id: taskId,
        status,
        budget: appliedBudget,
        message: payload?.message,
        output: payload?.output,
      },
      env,
    );
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /** Gracefully drain all subscriptions and close the connection. A node-hosted
   *  agent detaches (unsubscribes) but leaves the node's shared connection open. */
  async drain(): Promise<void> {
    this.stopHeartbeat();
    this.stopPruneTimer();
    this.stopVouchRenewal();
    this.credRenewer?.stop();
    this.storefront?.stop();
    this.stopOfflineDrain();
    this.stopDurableEventSubs();
    this.stopFeedDurable();
    if (this.ownsConnection) {
      await this.conn.drain();
    } else {
      this.detachSubscriptions();
    }
    this._closed = true;
  }

  /** Close the connection immediately. A node-hosted agent detaches
   *  (unsubscribes) but leaves the node's shared connection open. */
  async close(): Promise<void> {
    this.stopHeartbeat();
    this.stopPruneTimer();
    this.stopVouchRenewal();
    this.credRenewer?.stop();
    this.storefront?.stop();
    this.stopOfflineDrain();
    this.stopDurableEventSubs();
    this.stopFeedDurable();
    if (this.ownsConnection) {
      await this.conn.close();
    } else {
      this.detachSubscriptions();
    }
    this._closed = true;
  }

  /** Unsubscribe this agent's inbox and event subscriptions without touching
   *  the (shared) connection. */
  private detachSubscriptions(): void {
    this.inboxSub?.unsubscribe();
    this.inboxSub = null;
    this.listeningOnGuarded = false;
    for (const sub of this.eventSubs) sub.unsubscribe();
    this.eventSubs = [];
    this.stopDurableEventSubs();
    this.stopFeedDurable();
    for (const sub of this.taskUpdateSubs.values()) sub.unsubscribe();
    this.taskUpdateSubs.clear();
    this.taskUpdateBound.clear();
    for (const timer of this.taskRecheckTimers.values()) clearTimeout(timer);
    this.taskRecheckTimers.clear();
  }

  /** Stop (never delete) every durable event subscription. Splice-idempotent,
   *  so drain/close and detach can each call it. Fire-and-forget: a stop is a
   *  local iterator ending, and teardown has nowhere to put its promise. */
  private stopDurableEventSubs(): void {
    for (const d of this.durableEventSubs.splice(0)) {
      void d.stop().catch(() => {
        /* already stopped */
      });
    }
  }

  /** Whether the connection is closed. */
  get isClosed(): boolean {
    return this._closed || this.conn.isClosed;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private listenInbox(): void {
    // On an AMQP mesh the mailbox consumer may be the inbox (consumeAmqpMailbox).
    if (this.inboxSub || this.inboxViaMailbox) return;

    this.listeningOnGuarded = this.guarded;
    this.inboxSub = this.conn.subscribe(
      this.guarded
        ? Subjects.agentInboxGuarded(this.agentId)
        : Subjects.agentInbox(this.agentId),
      (msg: Msg) => {
        this.handleInboxMessage(msg).catch(() => {
          // Errors are handled inside handleInboxMessage
        });
      },
    );
  }

  /** §5.5 dedup memory: the live subscription and the offline-buffer consumer
   *  can both deliver the same envelope (drain overlap, redelivery).
   *
   *  Keyed on `(from, id)`, not on `id` alone. An envelope `id` is the SENDER's
   *  choice, so keying on it alone let one sender suppress another's traffic by
   *  guessing (or observing) an id, and conflated two unrelated senders that
   *  happened to pick the same one. The memory stays bounded — an unbounded set
   *  fed from the wire is a memory-exhaustion primitive — which is exactly why
   *  the freshness window in handleInboxMessage has to exist: dedup catches a
   *  repeat, the window catches the replay dedup has forgotten. */
  private seenInboxIds = new Set<string>();
  private seenInboxOrder: string[] = [];
  private rememberInboxId(from: string, id: string): boolean {
    // `|` cannot appear in either half — `from` is a base32 nkey and `id` a
    // UUID — so the composite key is unambiguous.
    const key = `${from}|${id}`;
    if (this.seenInboxIds.has(key)) return false;
    this.seenInboxIds.add(key);
    this.seenInboxOrder.push(key);
    if (this.seenInboxOrder.length > MAX_SEEN_INBOX_IDS) {
      const drop = this.seenInboxOrder.shift();
      if (drop) this.seenInboxIds.delete(drop);
    }
    return true;
  }

  /** §22.2 memory for event subscriptions, SEPARATE from the inbox's on
   *  purpose, mirroring the Rust SDK's `seen_events`: events arrive on
   *  subjects anyone may publish to, so a flood of them must not be able to
   *  evict the inbox memory's entries and reopen the replay gap there. Same
   *  bound and first-seen eviction as `rememberInboxId`; the key adds the
   *  subscription PATTERN (trailing, because a subject token could itself
   *  contain `|` while `from` and `id` cannot), so a duplicate is "this
   *  subscription already handled this envelope" — a second subscription the
   *  app deliberately overlapped is a different scope and still delivers,
   *  while the live and durable paths for the SAME pattern share a scope and
   *  dedup against each other. */
  private seenEventIds = new Set<string>();
  private seenEventOrder: string[] = [];
  private rememberEventId(pattern: string, from: string, id: string): boolean {
    const key = `${from}|${id}|${pattern}`;
    if (this.seenEventIds.has(key)) return false;
    this.seenEventIds.add(key);
    this.seenEventOrder.push(key);
    if (this.seenEventOrder.length > MAX_SEEN_EVENT_IDS) {
      const drop = this.seenEventOrder.shift();
      if (drop) this.seenEventIds.delete(drop);
    }
    return true;
  }

  /** Whether an inbound envelope's `ts` is inside the accepted window.
   *
   *  A signature says who wrote an envelope, never when — so without this, any
   *  agent holding a copy of something Alice once sent could publish it into a
   *  third agent's inbox months later and have it executed as authentic from
   *  Alice. `buffered` is the §16.4 mailbox drain, where an envelope is old by
   *  construction; there the bound is the buffer's own retention instead. */
  private freshEnough(env: Envelope, buffered: boolean): boolean {
    const ts = Date.parse(env.ts);
    if (Number.isNaN(ts)) return false;
    const drift = Date.now() - ts;
    if (drift < -MAX_CLOCK_SKEW_AHEAD_MS) return false;
    return drift <= (buffered ? MAX_MAILBOX_AGE_MS : MAX_CLOCK_SKEW_BEHIND_MS);
  }

  // ── §16.4 drain lifecycle ────────────────────────────────────────────
  //
  // Three separate facts, because they have three different lifetimes and
  // collapsing any two of them is a bug:
  //
  //  - `offlineDrainActive` — the drain SUBSYSTEM is armed (timer + reconnect
  //    watcher). Set once at register, cleared by close/drain. Also the pull
  //    loop's run flag, so a close ends a pass in progress between pulls.
  //  - `offlineDrainInFlight` — ONE pass is running. This is the mutex, and it
  //    is the role the old single `offlineDrainStarted` flag already played:
  //    that flag was raised synchronously at the top of the drain and released
  //    in its `finally`, so it never admitted a second overlapping drain. Now
  //    that there are three triggers (register, the interval, a reconnect)
  //    instead of one, it needs a name that says so.
  //  - `mailboxDrainTimer` / `stopReconnectWatch` — the two triggers, which have
  //    to be torn down or a closed agent keeps waking up.
  /** Whether the drain subsystem is armed. */
  private offlineDrainActive = false;
  /** Whether one drain pass is running right now. */
  private offlineDrainInFlight = false;
  private offlineMessages: { stop(): void } | null = null;
  private mailboxDrainTimer: TimerHandle | null = null;
  private stopReconnectWatch: (() => void) | null = null;
  /** How often the drain is re-run (§16.4). See ConnectOptions. */
  private mailboxDrainIntervalMs = DEFAULT_MAILBOX_DRAIN_INTERVAL_MS;

  /** Stop the mailbox drain — both triggers and any pass in progress — so
   *  close/drain can actually finish.
   *
   *  Clearing `offlineDrainActive` is also how a pass in progress is told to
   *  stop between pulls. What it deliberately does NOT do is clear
   *  `offlineDrainInFlight`: that flag belongs to the running pass, which
   *  releases it in its own `finally`, and clearing it here would let a
   *  re-register admit a second pass alongside one that is still awaiting a
   *  pull. Nor does it delete the durable consumer: `stop()` ends this client's
   *  iterator and leaves the consumer — and therefore its server-side cursor —
   *  in place. A deleted durable would be recreated on the next start with
   *  `DeliverPolicy.All` and replay the whole buffer instead of resuming. */
  private stopOfflineDrain(): void {
    this.offlineDrainActive = false;
    if (this.mailboxDrainTimer !== null) {
      clearInterval(this.mailboxDrainTimer);
      this.mailboxDrainTimer = null;
    }
    this.stopReconnectWatch?.();
    this.stopReconnectWatch = null;
    try { this.offlineMessages?.stop(); } catch { /* already stopped */ }
    this.offlineMessages = null;
    try { this.amqpMailbox?.stop(); } catch { /* already stopped */ }
    this.amqpMailbox = null;
    this.inboxViaMailbox = false;
  }

  /** The mailbox consumer on an AMQP mesh (see consumeAmqpMailbox). */
  private amqpMailbox: { stop(): void } | null = null;
  private amqpMailboxStarting = false;
  /** On an AMQP mesh, whether the mailbox consumer is this agent's inbox: the
   *  live subscription is then not held, so each message arrives once. */
  private inboxViaMailbox = false;

  /**
   * §16.4 on the RabbitMQ binding. The agent's mailbox is a durable queue,
   * `MESH_INBOX_{id}`, bound to the agent's inbox subject, that the broker
   * keeps for the agent while it is away; acknowledging a message takes it
   * out. So there is no bounded drain to re-run: one consumer stays on the
   * queue for the life of the agent, and it is the agent's inbox.
   *
   * Each message arrives once. The queue holds every message on the inbox
   * subject, so once the consumer is attached the live subscription would only
   * hand the agent a second copy of each; it is dropped, and put back if the
   * mailbox goes (a reclaimed registration). Until the registry has made the
   * mailbox (and for a sandbox agent, which has none) the live subscription is
   * the inbox, and the next pass asks for the mailbox again; a message the two
   * both hand over in that moment is dispatched once, by the §22.2 memory.
   *
   * A delivery carries its reply address, so the two reply-address
   * exceptions of §18.7 (the registry's probe, a guarded delivery's relay) are
   * answered on it as a live subscription would. What the queue held when the
   * consumer attached, a redelivery, and anything sent longer ago than
   * AMQP_MAILBOX_LIVE_WINDOW_MS is dispatched as mail that waited (§16.4: the
   * mailbox's freshness window, no accept); the rest as live delivery.
   * Dispatches run side by side, up to AMQP_MAILBOX_PREFETCH, and each is
   * acknowledged when it finishes, so a message whose dispatch was cut short
   * by a dropped connection comes again.
   */
  private async consumeAmqpMailbox(): Promise<void> {
    if (this.amqpMailbox || this.amqpMailboxStarting) return;
    this.amqpMailboxStarting = true;
    const queue = `MESH_INBOX_${this.agentId}`;
    const inbox = Subjects.agentInbox(this.agentId);
    const guardedInbox = Subjects.agentInboxGuarded(this.agentId);
    try {
      const conn = this.conn as unknown as {
        queueExists(name: string): Promise<boolean>;
        consume(name: string, opts?: { prefetch?: number }): Promise<{
          stop(): void;
          [Symbol.asyncIterator](): AsyncIterator<{
            subject: string;
            data: Uint8Array;
            reply?: string;
            respond(data?: Uint8Array): boolean;
            backlog?: boolean;
            ack(): void;
            nak(delayMs?: number): void;
          }>;
        }>;
      };
      if (!(await conn.queueExists(queue))) return;
      if (!this.offlineDrainActive || this.isClosed) return;
      const consumer = await conn.consume(queue, { prefetch: AMQP_MAILBOX_PREFETCH });
      if (!this.offlineDrainActive || this.isClosed) {
        consumer.stop();
        return;
      }
      this.amqpMailbox = consumer;
      // The mailbox is the inbox now: the live copy goes.
      this.inboxViaMailbox = true;
      this.inboxSub?.unsubscribe();
      this.inboxSub = null;
      void (async () => {
        for await (const m of consumer) {
          // Only what came on this agent's inbox subjects. A message put into
          // the queue by its name, through the default exchange, never came on
          // a subject, and is dropped (binding document §2.1).
          if (m.subject !== inbox && m.subject !== guardedInbox) {
            m.ack();
            continue;
          }
          let waited = m.backlog === true;
          if (!waited) {
            try {
              const sentAt = Date.parse(decode(m.data).ts);
              waited = !Number.isNaN(sentAt) && Date.now() - sentAt > AMQP_MAILBOX_LIVE_WINDOW_MS;
            } catch {
              // Not an envelope: the dispatch drops it.
            }
          }
          const msg = { data: m.data, subject: m.subject, reply: m.reply, respond: (d?: Uint8Array) => m.respond(d) } as unknown as Msg;
          void this.handleInboxMessage(msg, waited).then(
            () => m.ack(),
            () => m.nak(1000),
          );
        }
      })()
        .catch(() => undefined)
        .finally(() => {
          // The queue went (a reclaimed registration) or the agent stopped.
          if (this.amqpMailbox !== consumer) return;
          consumer.stop();
          this.amqpMailbox = null;
          this.inboxViaMailbox = false;
          if (this.offlineDrainActive && !this.isClosed) this.listenInbox();
        });
    } catch {
      // Unreachable now; the next pass asks again.
    } finally {
      this.amqpMailboxStarting = false;
    }
  }

  /**
   * Arm the §16.4 drain: one pass now, then a pass on every reconnect and one
   * every `mailboxDrainIntervalMs`.
   *
   * **Why it repeats.** A single bounded pass closes the race the bound exists
   * for (see drainMailboxOnce) and leaves a different problem behind. The pass
   * stops at the bind-time bound, so everything the mailbox captures afterwards
   * — which is every live message, because the mailbox stream captures the very
   * subject the live subscription is on — sits on the durable consumer
   * undelivered and unacked. The cursor stays where the pass left it and the
   * tail grows for the life of the process, capped only by the stream's
   * retention. Then the next restart binds, sees the whole tail as backlog, and
   * dispatches it: handlers re-run, answers go to senders' inboxes, and the
   * fresh process's dedup memory cannot suppress any of it because §22.2 does
   * not survive a restart. The old unbounded drain never had that, because it
   * acked every live copy as it went — so a bound alone trades a race for
   * replay-on-restart, which on a long-lived agent is the worse of the two.
   *
   * Re-running the bounded pass keeps the cursor at the head. Each pass still
   * reads a FRESH last sequence and stops there, so the bound is not weakened;
   * what the live path already handled in this process is caught by the dedup
   * memory and merely acked rather than dispatched again; and anything the live
   * subscription missed during a reconnect gap is recovered now instead of being
   * deferred to the next restart.
   *
   * **Reconnect is the trigger that matters.** A gap in the live subscription is
   * precisely the window in which the mailbox holds a message nothing dispatched.
   * The interval is the backstop for gaps the client did not report as a
   * reconnect (a stalled consumer, a missed delivery) and, more importantly, the
   * bound on how big the tail is allowed to get — see
   * DEFAULT_MAILBOX_DRAIN_INTERVAL_MS for why that bound is the dedup memory's
   * size and why 60s clears it by two orders of magnitude.
   */
  private startOfflineDrain(): Promise<void> {
    if (this.offlineDrainActive) {
      // A second register() on an agent that is already draining. The triggers
      // are already armed; just take a pass now (the in-flight guard makes that
      // a no-op if one is running).
      return this.drainMailboxOnce();
    }
    this.offlineDrainActive = true;
    // Unref'd: a housekeeping loop must never be the reason a script hangs.
    this.mailboxDrainTimer = setUnrefInterval(
      () => void this.drainMailboxOnce(),
      this.mailboxDrainIntervalMs,
    );
    // The transport's own reconnect event, not a poll of connection state.
    // Guarded by a typeof rather than assumed: embedders (and this SDK's own
    // tests) construct agents over hand-rolled connection objects, and a missing
    // reconnect hook must cost them the prompt pass, not the drain.
    if (typeof this.conn.onReconnect === "function") {
      this.stopReconnectWatch = this.conn.onReconnect(() => {
        if (this.offlineDrainActive && !this.isClosed) void this.drainMailboxOnce();
      });
    }
    return this.drainMailboxOnce();
  }

  /**
   * On an AMQP mesh: wait until this agent's inbox is in place. `firstPass` is
   * the mailbox pass register() started, which attaches the consumer when the
   * registry has made the mailbox (it answers a registration once it has).
   * Then everything asked of the connection so far is waited for, which binds
   * the live subscription when there is no mailbox (a sandbox agent, or a
   * mailbox the registry could not make in time). Neither ever throws: an
   * inbox that could not be set up now is set up by the next pass, as before.
   */
  private async amqpInboxReady(firstPass: Promise<void>): Promise<void> {
    await firstPass.catch(() => undefined);
    const conn = this.conn as unknown as { flush?: () => Promise<void> };
    if (typeof conn.flush === "function") await conn.flush().catch(() => undefined);
  }

  /** §16.4 offline delivery, receiving half: bind a durable consumer on the
   *  agent's mailbox (`MESH_INBOX_{id}`) and run the messages it was holding
   *  through the normal inbox dispatch. Responses go where every response goes
   *  since the §6.4 cutover, to the SENDER's inbox (correlated by
   *  `in_reply_to`), which is itself buffered if the sender has meanwhile gone
   *  offline. Acks after dispatch: the ack is the node's
   *  "durably accepted" signal, and from then the node owns the message.
   *  Silent no-op when there is no mailbox or no JetStream permission.
   *
   *  **The drain is bounded to the backlog that existed when it bound.** The
   *  mailbox stream captures the very subject live messages arrive on, so an
   *  unbounded drain competes with the live subscription for every live
   *  message, with §22.2 dedup deciding which of the two dispatches runs.
   *  Since the §6.4 cutover the two answer the SAME destination (the sender's
   *  inbox), so the bound is no longer what keeps a waiting requester's answer
   *  from going astray; what it still buys is that live traffic is handled by
   *  the live path, promptly, instead of waiting on a drain pass that happens
   *  to be running, and that a slow pass cannot turn into an open-ended second
   *  consumer of everything the agent receives. The accept differs on purpose:
   *  the live path emits it, the drain never does (§6.4a below).
   *
   *  A drain that stops early because a JetStream call failed is a degraded
   *  start, not a dead agent: `register` has already established the live
   *  subscription, so the agent is serving either way. The same holds for a
   *  failed re-drain: it never throws to its caller (a timer tick or a reconnect
   *  callback, neither of which has anywhere to put an error) and it never
   *  disarms the triggers, so the next pass simply tries again.
   *
   *  **One pass at a time.** `offlineDrainInFlight` is raised synchronously
   *  before the first `await`, so two triggers landing in the same tick — a
   *  reconnect during a re-register, an interval tick while a slow pass is still
   *  pulling — cannot produce two passes over one durable consumer. The second
   *  one returns immediately and the next tick picks up whatever it would have
   *  found. */
  private async drainMailboxOnce(): Promise<void> {
    if (this.offlineDrainInFlight || !this.offlineDrainActive || this.isClosed) return;
    if (this.conn.binding === "amqp") return this.consumeAmqpMailbox();
    this.offlineDrainInFlight = true;
    const stream = `MESH_INBOX_${this.agentId}`;
    const durable = `inbox_${this.agentId}`;
    try {
      const raw = this.conn.raw;
      const jsm = await raw.jetstreamManager();

      // The bound. `state.last_seq` is the highest sequence the STREAM has
      // assigned — deliberately not any consumer number: a consumer reports a
      // stream sequence AND its own delivery sequence, and the latter counts
      // deliveries to one consumer rather than positions in the stream.
      let bound: number;
      try {
        bound = (await jsm.streams.info(stream)).state.last_seq;
      } catch {
        return; // no mailbox on this mesh (sandbox agent, or older deployment)
      }

      let info: ConsumerInfo;
      try {
        info = await jsm.consumers.info(stream, durable);
      } catch {
        info = await jsm.consumers.add(stream, {
          durable_name: durable,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.All,
          ack_wait: 30_000_000_000, // 30s in ns
          max_deliver: 5,
        });
      }

      // An empty backlog stops here and now, rather than opening a pull that
      // waits out its expiry for a message that is never coming. `num_pending`
      // is what this consumer has yet to be delivered, `num_ack_pending` what
      // it was delivered and never acked; zero of both means there is nothing
      // this bind could hand over. It is also the loop's budget: the consumer
      // cannot deliver more than it says it holds, so a drain cannot outlive
      // what was there when it bound.
      const budget = info.num_pending + info.num_ack_pending;
      if (bound === 0 || budget === 0) return;

      const consumer = await raw.jetstream().consumers.get(stream, durable);
      let remaining = budget;
      // `offlineDrainActive` doubles as the run flag: stopOfflineDrain()
      // clears it, so close()/drain() end this loop between pulls.
      while (this.offlineDrainActive && remaining > 0) {
        const want = Math.min(remaining, MAILBOX_DRAIN_BATCH);
        const messages = await consumer.fetch({
          max_messages: want,
          expires: MAILBOX_DRAIN_EXPIRES_MS,
        });
        this.offlineMessages = messages;
        let got = 0;
        for await (const m of messages) {
          got++;
          // `m.seq` is the STREAM sequence (`m.info.streamSequence`).
          // `m.info.deliverySequence` is this consumer's own counter and is not
          // comparable to the bound.
          //
          // Past the bound this message arrived after the bind, which means the
          // live subscription owns it. It is neither dispatched nor acked here:
          // acking would be this path claiming a message it did not handle.
          if (m.seq > bound) return;
          try {
            let env: Envelope | null = null;
            try {
              env = decode(m.data);
            } catch {
              env = null;
            }
            if (env === null) {
              m.ack(); // undecodable buffered bytes: drop, don't loop
            } else {
              // §6.4 hard cutover: drained and live dispatches answer the same
              // destination (the sender's inbox, from the verified `from`), so
              // the drain no longer synthesises a reply subject. The message
              // object it hands over is data-only; the probe exception needs a
              // live transport reply, and a drained probe has none.
              await this.handleInboxMessage({ data: m.data } as unknown as Msg, true);
              m.ack();
            }
          } catch {
            // Dispatch failure: let ack_wait redeliver (up to max_deliver).
          }
          // The backlog present at bind time is fully drained.
          if (m.seq >= bound) return;
        }
        remaining -= got;
        // The pull came back with nothing: the consumer has no more of the
        // bind-time backlog to give, whatever its counters said.
        if (got === 0) return;
      }
    } catch {
      // JetStream API unreachable with this credential, or a pull failed
      // partway through. Live-only until the next pass, which is a degraded
      // start rather than a dead one — and deliberately NOT a reason to disarm
      // the triggers: a mailbox that is unreachable now (a broker restart, a
      // JetStream API blip) is reachable again later, and the tail keeps growing
      // in the meantime.
    } finally {
      // Release the mutex and the pull iterator — NOT the triggers. The pass is
      // over; the subsystem is not.
      try { this.offlineMessages?.stop(); } catch { /* already stopped */ }
      this.offlineMessages = null;
      this.offlineDrainInFlight = false;
    }
  }

  /**
   * Deliver a respond for an inbound request (§6.4 hard cutover): published to
   * the SENDER's inbox, correlated by `in_reply_to`, and never to the transport
   * reply subject. The destination is derived from the signature-verified
   * `from`, so the reflection primitive the old `mayReplyTo` guard existed for
   * (a publisher naming an arbitrary subject as its reply and collecting this
   * key's signed envelopes there) has nothing left to reflect. It also means
   * drained and live requests are answered identically, and a request that
   * arrived with no reply subject at all still gets its answer.
   *
   * TWO exceptions answer on the transport reply subject instead, both marked
   * by `transportReply` and both prefix-checked (§18.7) so neither can become
   * the reflection primitive:
   *
   *  - The registry reaper's `__registry_probe__`: a liveness check that must
   *    stay cheap, no inbox round trip. A drained probe has no live reply
   *    subject and is answered to nobody, which is what a liveness probe of an
   *    offline agent deserves.
   *  - A request DELIVERED ON THE GUARDED INBOX SUBJECT (EXT-6 §7): the
   *    requester of record there is the admission guard relay, transport
   *    plumbing with no inbox of its own that forwards the answer to the true
   *    sender itself. Publishing to the true sender's inbox would bypass the
   *    guard's forwarding role. The distinguishing fact is the DELIVERY
   *    subject, which the message carries; nothing sniffs the payload.
   *    Deliveries on the plain inbox subject follow the inbox rule
   *    unconditionally. A guarded-captured message the mailbox DRAIN hands
   *    over has no live relay waiting, so the drained path answers to the
   *    sender's inbox as it always has, which is consistent: the guard
   *    already admitted anything that reached the stream.
   *
   * `tap` mirrors the respond onto this agent's outbox for the operator
   * surfaces, exactly where the old call sites did.
   */
  private sendRespond(
    msg: Msg,
    requestEnv: Envelope,
    encoded: Uint8Array,
    opts: { transportReply?: boolean; tap?: boolean } = {},
  ): void {
    if (opts.transportReply) {
      if (isTransportReply(msg.reply)) {
        msg.respond(encoded);
      }
    } else {
      this.conn.publish(Subjects.agentInbox(requestEnv.from), encoded);
    }
    if (opts.tap) this.conn.publish(Subjects.agentOutbox(this.agentId), encoded);
  }

  /** The terminal (or pausing) statement of a §7.0 deferred dispatch: a signed
   *  respond on `mesh.task.{id}.update` — the subject the streaming `end` and
   *  `failTask` already publish on, which the task manager records durably
   *  (§7.4) — plus the outbox tap every respond gets. The requester's SDK is
   *  watching this subject from the moment the `working` respond arrived. */
  private publishDeferredTerminal(
    taskId: string,
    requestEnv: Envelope,
    body: { payload: RespondPayload & { problems?: unknown }; error?: ErrorObject | null },
    opts: { outbox?: boolean } = {},
  ): void {
    const updateEnv = this.newEnvelope({
      type: "respond",
      from: this.agentId,
      to: requestEnv.from,
      in_reply_to: requestEnv.id,
      task_id: taskId,
      trace: childSpan(requestEnv.trace),
      // Common Agent 7.7: a trial's task updates say so, so the platform
      // gives the task a trial receipt rather than counting a sale.
      payload: { ...body.payload, ...this.trialMark(taskId) },
      error: body.error ?? undefined,
    });
    const encoded = encode(updateEnv);
    this.noteResumable(taskId, requestEnv, body.payload.status);
    this.conn.publish(Subjects.taskUpdate(taskId), encoded);
    if (opts.outbox !== false) this.conn.publish(Subjects.agentOutbox(this.agentId), encoded);
  }

  /** Keep `resumableTasks` in step with what this agent records on a Task: a
   *  pause (`input_required`) leaves it resumable by the requester that asked
   *  for it, and anything else (`working` on a resume or a deferral, or a
   *  terminal statement) ends that. A Task still working is not resumable: a
   *  second request naming it would run a second handler beside the first. */
  private noteResumable(taskId: string, requestEnv: Envelope, status: string | undefined): void {
    if (status === "input_required") {
      const offering = (requestEnv.payload as RequestPayload | undefined)?.offering;
      this.resumableTasks.remember(taskId, requestEnv.from, typeof offering === "string" ? offering : "");
      this.noRecord.delete(taskId);
    } else if (status) {
      this.resumableTasks.forget(taskId);
    }
  }

  /** What the task manager's record (§7.4) says about a Task's parties.
   *  `none`: no record (cached briefly). `not_party`: a record this agent may
   *  not read, so somebody else's. `unreadable`: no answer that says either. */
  private async readTaskParties(
    taskId: string,
  ): Promise<
    | { kind: "record"; requester: string; responder: string; state: unknown; offering: string }
    | { kind: "none" }
    | { kind: "not_party" }
    | { kind: "unreadable"; reason: string }
  > {
    if (this.noRecord.has(taskId)) return { kind: "none" };
    let record: { requester?: unknown; responder?: unknown; state?: unknown; offering?: unknown } | undefined;
    try {
      record = (await this.serviceRequest(Subjects.taskGet(taskId), { task_id: taskId }, TASK_RECORD_TIMEOUT_MS)) as typeof record;
    } catch (err) {
      const code = err instanceof MeshError ? err.code : undefined;
      if (code === ErrorCode.TASK_NOT_FOUND || code === ErrorCode.NOT_FOUND) {
        this.noRecord.add(taskId);
        return { kind: "none" };
      }
      if (code === ErrorCode.UNAUTHORIZED) return { kind: "not_party" };
      return { kind: "unreadable", reason: err instanceof Error ? err.message : "no answer" };
    }
    if (!record || typeof record.requester !== "string" || typeof record.responder !== "string") {
      this.noRecord.add(taskId);
      return { kind: "none" };
    }
    return {
      kind: "record",
      requester: record.requester,
      responder: record.responder,
      state: record.state,
      offering: typeof record.offering === "string" ? record.offering : "",
    };
  }

  /**
   * Which Task an inbound request runs under, and whether it is a RESUME
   * (§7.3: the follow-up request that takes a paused Task back to working).
   *
   * `env.task_id` is not proof of anything: task ids are broadcast on
   * `mesh.event.task.*`, so a third party can name somebody else's paused
   * Task. And the task manager would take what this agent recorded on it,
   * because this agent is a party to that Task. So a request is a resume only
   * when this agent paused that Task for `env.from` (`resumableTasks`; an
   * entry older than RESUME_HINT_FRESH_MS is confirmed on the record first),
   * or, when it does not remember it (a restart, an evicted entry), when the
   * Task's own record names `env.from` as the requester and this agent as the
   * responder and is still paused.
   *
   * - `fresh`: ordinary work under `taskId`: the request's own id when it
   *   names a Task nobody has recorded (a requestStream's requester-made id),
   *   a NEW id when it names a Task that is not paused (still working, or
   *   ended) or whose record could not be read. Nothing is recorded on a Task
   *   the request named unless the work itself creates it.
   * - `resume`: the paused Task, resumed by its own requester.
   * - `refuse`: the request names a Task that positively belongs to someone
   *   else. Answered with the error, never worked.
   */
  private async resolveDispatchTask(
    env: Envelope,
  ): Promise<{ kind: "fresh" | "resume"; taskId: string } | { kind: "refuse"; error: ErrorObject }> {
    const named = env.task_id;
    if (named === undefined) return { kind: "fresh", taskId: uuid7() };
    const notYours: ErrorObject = {
      code: ErrorCode.UNAUTHORIZED,
      message:
        `Task ${named} was not opened by you with this agent, so this request cannot resume it (§7.3). ` +
        `Send the request without a task_id to start new work.`,
      retryable: false,
    };
    const known = this.resumableTasks.get(named);
    if (known) {
      if (known.requester !== env.from) return { kind: "refuse", error: notYours };
      if (Date.now() - known.rememberedAt < RESUME_HINT_FRESH_MS) return { kind: "resume", taskId: named };
      // An older pause is a hint: the Task may have ended where this agent
      // could not see it (a cancel through the task manager, the overdue
      // sweep). The record says; when it cannot be read, the hint stands.
      const seen = await this.readTaskParties(named);
      if (seen.kind === "unreadable") return { kind: "resume", taskId: named };
      if (seen.kind === "not_party") return { kind: "refuse", error: notYours };
      if (seen.kind === "record" && (seen.requester !== env.from || seen.responder !== this.agentId)) {
        return { kind: "refuse", error: notYours };
      }
      if (seen.kind === "record" && seen.state === "input_required") {
        this.resumableTasks.remember(named, env.from, known.offering);
        return { kind: "resume", taskId: named };
      }
      this.resumableTasks.forget(named);
      return { kind: "fresh", taskId: uuid7() };
    }

    // Not paused here. A dispatch this agent ran under the id says whose it is.
    const owner = this.dispatchOwners.get(named);
    if (owner) return owner.requester === env.from ? { kind: "fresh", taskId: uuid7() } : { kind: "refuse", error: notYours };

    // Unknown here: the Task's record (§7.4) carries both parties.
    const seen = await this.readTaskParties(named);
    switch (seen.kind) {
      // No record: nobody's Task. Ordinary work, under the id the requester chose.
      case "none":
        return { kind: "fresh", taskId: named };
      // A record this agent is not a party to: somebody else's Task.
      case "not_party":
        return { kind: "refuse", error: notYours };
      // Could not tell: ordinary work under a new id, so a slow or absent task
      // manager does not stop work (or streams), and nothing lands on a Task
      // that might be somebody else's.
      case "unreadable":
        return { kind: "fresh", taskId: uuid7() };
    }
    if (seen.requester !== env.from || seen.responder !== this.agentId) return { kind: "refuse", error: notYours };
    if (seen.state === "input_required") {
      this.resumableTasks.remember(named, env.from, seen.offering);
      return { kind: "resume", taskId: named };
    }
    // The requester's own Task, but not paused (still working, or ended): new
    // work under a new id, so nothing lands on a record that cannot take it.
    return { kind: "fresh", taskId: uuid7() };
  }

  /** Whether `env.from` may cancel `taskId` here (§10.8): only the Task's
   *  requester, by what this agent remembers or else by the Task's record.
   *  `nothing`: no dispatch here and no record, so there is nothing to cancel. */
  private async cancelStanding(
    taskId: string,
    from: string,
  ): Promise<{ kind: "requester" | "nothing" } | { kind: "refuse"; error: ErrorObject }> {
    const notYours: ErrorObject = {
      code: ErrorCode.UNAUTHORIZED,
      message: `Task ${taskId} was not opened by you with this agent, so you cannot cancel it (§10.8).`,
      retryable: false,
    };
    const owner = this.dispatchOwners.get(taskId) ?? this.resumableTasks.get(taskId);
    if (owner) return owner.requester === from ? { kind: "requester" } : { kind: "refuse", error: notYours };
    const seen = await this.readTaskParties(taskId);
    switch (seen.kind) {
      case "none":
        return { kind: "nothing" };
      case "not_party":
        return { kind: "refuse", error: notYours };
      case "unreadable":
        return {
          kind: "refuse",
          error: {
            code: ErrorCode.AGENT_UNAVAILABLE,
            message: `Task ${taskId}'s record could not be read to check who may cancel it (${seen.reason}). Send the cancel again shortly.`,
            retryable: true,
          },
        };
    }
    return seen.requester === from && seen.responder === this.agentId ? { kind: "requester" } : { kind: "refuse", error: notYours };
  }

  /**
   * One respond envelope arriving at this agent's own inbox (§6.4 hard
   * cutover): the answer to an outbound request this agent is waiting on, live
   * or drained from the mailbox. The two deliveries carry the SAME envelope
   * to the SAME destination now, so this is the one correlation point.
   *
   * The §22 protections run here in the same shape the request path runs them:
   * addressing, freshness (the buffered window for drained copies), then §6.2
   * response binding against the pending request, then `(from, id)` dedup.
   * A respond that matches no pending request is dropped in silence: the wait
   * it answered has timed out (its caller was already told the mailbox story,
   * §16.4), or it was never ours. An inbox-mode answer, the fresh `request`
   * envelope a node sends with `in_reply_to` naming the original request, is
   * correlated on the REQUEST path (see handleInboxMessage): when the wait it
   * names is still open it resolves it the same way a respond here does, and
   * otherwise it is dispatched like any other request.
   */
  private handleInboxRespond(env: Envelope, buffered: boolean): void {
    if (env.to !== undefined && env.to !== this.agentId) return;
    if (!this.freshEnough(env, buffered)) return;
    // SPEC.md §5.7: a respond marked for a person is a person's reply to a
    // message this agent's person sent. It resolves no wait (rule 1) and goes
    // to the person surface. A malformed mark has no reply path on a respond,
    // so it is dropped and the agent hears about it (§22.7).
    const audience = audienceOf(env);
    if (audience !== "agent") {
      if (!this.rememberInboxId(env.from, env.id)) return; // §22.2
      if (audience === "malformed") {
        this.dropMarked(env, "a respond with a malformed meta.audience");
        return;
      }
      this.surfaceToPerson(env, "respond");
      return;
    }
    const pending =
      typeof env.in_reply_to === "string"
        ? this.pendingAgentReplies.get(env.in_reply_to)
        : undefined;
    if (!pending) return;
    try {
      this.bindResponse(env, pending.request, { agent: pending.agentId });
    } catch {
      return; // not an answer to this request (§6.2)
    }
    if (!this.rememberInboxId(env.from, env.id)) return; // §22.2
    pending.onRespond(env);
  }

  /**
   * Is this inbound payload over the sender-text cap — and if so, refuse it
   * out loud (safety register 2.9, and 8.4 on why a silent drop is not enough).
   *
   * Two channels, because they inform different people and neither one alone
   * covers both:
   *
   *  - The SENDER gets a signed `CONTEXT_TOO_LARGE` error envelope at its own
   *    inbox (§6.4), so an honest caller that sent too much learns why
   *    instead of timing out. It is not retryable: the same bytes will be too
   *    big next time.
   *  - The RECIPIENT hears it through `onSecurityWarning`, including on the
   *    mailbox drain where the sender may be long gone. 8.4's complaint is
   *    that a refusal is invisible to the person being protected; a cap that
   *    dropped in silence would earn the same complaint.
   *
   * The handler is never invoked either way, which is the point: an oversized
   * message must not cost a model call.
   */
  private overInboundCap(
    input: unknown,
    env: Envelope,
    msg: Msg,
    transportReply: boolean,
  ): boolean {
    if (this.maxInboundChars <= 0) return false;
    const size = inboundTextLength(input);
    if (size <= this.maxInboundChars) return false;

    const message =
      `Inbound message carries ${size} characters of sender text, over this agent's ` +
      `${this.maxInboundChars}-character cap (ConnectOptions.maxInboundChars)`;
    const errEnv = this.newEnvelope({
      type: "respond",
      from: this.agentId,
      to: env.from,
      in_reply_to: env.id,
      task_id: env.task_id,
      trace: childSpan(env.trace),
      error: { code: ErrorCode.CONTEXT_TOO_LARGE, message, retryable: false },
    });
    // Tap: the refusal is observable to the operator surfaces, like every
    // other response this agent makes.
    this.sendRespond(msg, env, encode(errEnv), { transportReply, tap: true });
    this.onSecurityWarning?.({
      code: "inbound_oversize",
      message,
      from: env.from,
      subject: this.agentId,
    });
    return true;
  }

  /** Dispatch one inbound inbox message. `buffered` marks the §16.4 mailbox
   *  drain, whose messages are old by construction and whose reply subject the
   *  drain synthesised rather than the transport minting it. */
  private async handleInboxMessage(msg: Msg, buffered = false): Promise<void> {
    let env: Envelope;
    try {
      env = decode(msg.data);
    } catch {
      // Dropped in silence. This used to answer with a SIGNED error envelope on
      // the publisher's chosen reply subject — so one malformed message made
      // this agent put its signature on any subject it was permitted to
      // publish, for free and unrated. c03 already treats silence as a refusal:
      // "silence is also a refusal".
      return;
    }

    // §6.4 hard cutover: responds to this agent's own outbound requests arrive
    // HERE (the inbox is the reply channel) on both deliveries, live and
    // drained from the mailbox. Correlated against the pending requests after
    // its own copy of the §22 checks.
    if (env.type === "respond") {
      this.handleInboxRespond(env, buffered);
      return;
    }

    if (env.type !== "request") return;

    // §5.5 dedup: the same envelope can arrive twice — once live, once from
    // the offline buffer (drain overlap or redelivery). Handle it once.
    // Deliberately BEFORE the freshness check: a stale envelope must still be
    // remembered, or the copy the mailbox captured (whose age the mailbox
    // window forgives) would sail past a rejection the live path just made.
    if (!this.rememberInboxId(env.from, env.id)) return;

    // The envelope is signed, but a signature binds it to its author, not to
    // the subject it arrived on. `to` is the author's statement of who this was
    // for, so an envelope naming someone else is a replay onto our inbox by a
    // third party — every agent Alice ever messaged holds one it could aim
    // here. (An absent `to` is legitimate: service calls omit it.)
    if (env.to !== undefined && env.to !== this.agentId) return;

    // …and a signature says nothing about WHEN, so bound the age (§5.5).
    if (!this.freshEnough(env, buffered)) return;

    // Relay guard (§21.2, §5): an envelope whose meta.hops exceeds the bound
    // has been around the block too many times — drop it silently. Normal
    // single-instance traffic never sets hops, so this costs nothing today
    // and is the loop-prevention primitive peering relies on later.
    const hops = (env.meta as Record<string, unknown> | undefined)?.hops;
    if (typeof hops === "number" && hops > 3) return;

    // §5.3: "Receivers MUST refuse a message signed by a revoked agent key."
    // The signature above proves which key signed; this asks whether that key
    // is still its owner's. After the cheap checks, so a malformed or replayed
    // envelope costs no registry question, and before anything is handled or
    // answered as though the sender were who it says.
    if (this.revokedSenders) {
      const revoked = await this.revokedSenders.check(env.from);
      // The kill switch (§5.3): a paused sender is refused too. Its node may
      // still be able to publish, so the receiver refusing is what makes the
      // pause hold. Unlike a revocation, a pause is lifted, and the memo says
      // so again within a minute of the resume.
      if (revoked?.paused) {
        const viaReply = !buffered && typeof msg.subject === "string" && msg.subject.endsWith(".inbox.guarded");
        const errEnv = this.newEnvelope({
          type: "respond",
          from: this.agentId,
          to: env.from,
          in_reply_to: env.id,
          trace: childSpan(env.trace),
          error: {
            code: ErrorCode.UNAUTHORIZED,
            message: "The agent that sent this is paused by its owner or by AgentMesh, so its messages are refused until it is resumed (§5.3).",
            details: { reason: "agent_paused", ...(revoked.since ? { stopped_at: revoked.since } : {}) },
            retryable: false,
          },
        });
        this.sendRespond(msg, env, encode(errEnv), { transportReply: viaReply });
        this.onSecurityWarning?.({
          code: "stopped_sender",
          message: "refused a request from an agent that is paused by the kill switch",
          from: env.from,
          subject: this.agentId,
        });
        return;
      }
      if (revoked) {
        const viaReply = !buffered && typeof msg.subject === "string" && msg.subject.endsWith(".inbox.guarded");
        const errEnv = this.newEnvelope({
          type: "respond",
          from: this.agentId,
          to: env.from,
          in_reply_to: env.id,
          trace: childSpan(env.trace),
          error: {
            code: ErrorCode.UNAUTHORIZED,
            message: "The key that signed this message has been revoked, so it is refused (§5.3).",
            details: {
              reason: "agent_key_revoked",
              ...(revoked.revokedAt ? { revoked_at: revoked.revokedAt } : {}),
              ...(revoked.replacedBy ? { replaced_by: revoked.replacedBy } : {}),
            },
            retryable: false,
          },
        });
        this.sendRespond(msg, env, encode(errEnv), { transportReply: viaReply });
        this.onSecurityWarning?.({
          code: "revoked_sender",
          message: `refused a request signed by a revoked key${revoked.replacedBy ? `; the agent moved to ${revoked.replacedBy}` : ""}`,
          from: env.from,
          subject: this.agentId,
        });
        return;
      }
    }

    // SPEC.md §5.7 rule 5: a mark that is present and is not a string is
    // refused before any handler runs, answered at the sender's inbox. Every
    // string other than "agent" reads as "person".
    const audience = audienceOf(env);
    if (audience === "malformed") {
      const viaReply = !buffered && typeof msg.subject === "string" && msg.subject.endsWith(".inbox.guarded");
      const errEnv = this.newEnvelope({
        type: "respond",
        from: this.agentId,
        to: env.from,
        in_reply_to: env.id,
        trace: childSpan(env.trace),
        error: {
          code: ErrorCode.INVALID_ENVELOPE,
          message: "meta.audience must be a string: \"agent\" or \"person\" (SPEC §5.7).",
          details: { reason: "audience_malformed" },
          retryable: false,
        },
      });
      this.sendRespond(msg, env, encode(errEnv), { transportReply: viaReply });
      return;
    }

    // The adapter's inbox-mode answer shape (§6.4a): a node that queued a
    // message answers later with a FRESH request whose `in_reply_to` names
    // the original request's envelope id. When the wait it names is still
    // open HERE, this arrival is the correlated answer, and it resolves that
    // wait exactly as a true respond would: after the §22 protections above
    // and the same §6.2 binding, instead of being dispatched to a handler
    // (both delivering the answer to application code twice, and answering
    // an answer, would be wrong). A request threading `in_reply_to` that
    // names NO open wait is an ordinary request, dispatched normally; the
    // asynchronous case, where the caller was already told REQUEST_QUEUED
    // and stopped waiting, lands there.
    // A request marked for a person is never an answer to a wait (§5.7 rule 1).
    if (typeof env.in_reply_to === "string" && audience === "agent") {
      const pending = this.pendingAgentReplies.get(env.in_reply_to);
      // Only the ADDRESSED AGENT ITSELF may answer as a request. Checked
      // before bindResponse on purpose: the §6.2 intermediary allowance (and
      // its pin-on-first-use side effect) belongs to the queued-ack path, and
      // a third party threading a stolen id must neither resolve the wait nor
      // get itself pinned by trying.
      if (pending && env.from === pending.agentId) {
        try {
          this.bindResponse(env, pending.request, { agent: pending.agentId });
          pending.onRespond(env);
          return;
        } catch {
          // Not an answer to that wait (§6.2): dispatched normally below.
        }
      }
    }

    // EXT-6 guarded delivery (see sendRespond): a request arriving on the
    // guarded inbox subject was relayed by the admission guard, whose reply
    // subject is where the answer must go. Decided from the DELIVERY subject
    // alone, and only live: a drained message carries no delivery subject and
    // has no relay waiting.
    const guarded =
      !buffered && typeof msg.subject === "string" && msg.subject.endsWith(".inbox.guarded");

    // A wire-supplied task_id ends up interpolated into the stream and update
    // subjects this agent publishes on (§18.1), and it is echoed on every reply
    // — so it must be a single subject token before it goes anywhere. A dotted
    // one let the SENDER choose which subject the victim published its
    // genuinely-signed chunks onto, including the requester's own live stream.
    if (env.task_id !== undefined && !isSubjectToken(env.task_id)) {
      const errEnv = this.newEnvelope({
        type: "respond",
        from: this.agentId,
        to: env.from,
        in_reply_to: env.id,
        trace: childSpan(env.trace),
        error: {
          code: ErrorCode.INVALID_ENVELOPE,
          message: "task_id must be a single NATS subject token (no '.', '*' or '>')",
          retryable: false,
        },
      });
      this.sendRespond(msg, env, encode(errEnv), { transportReply: guarded });
      return;
    }

    // §7.7: the budget is the offer the handler is about to decide on — read
    // before any work — so a malformed one is refused up front, like a
    // malformed task_id, rather than handed to a handler as if it bound
    // anything. An ABSENT budget is fine (it is OPTIONAL); a present one must
    // be the real shape.
    if (env.budget !== undefined) {
      try {
        validateBudget(env.budget);
      } catch (budgetErr) {
        const errEnv = this.newEnvelope({
          type: "respond",
          from: this.agentId,
          to: env.from,
          in_reply_to: env.id,
          task_id: env.task_id,
          trace: childSpan(env.trace),
          error: {
            code: ErrorCode.INVALID_ENVELOPE,
            message:
              budgetErr instanceof MeshError ? budgetErr.message : "Invalid budget (§7.7)",
            retryable: false,
          },
        });
        this.sendRespond(msg, env, encode(errEnv), { transportReply: guarded });
        return;
      }
    }

    const reqPayload = env.payload as RequestPayload;

    // Deprecation window (§8.5): senders on pre-rename SDKs say `skill`.
    // Normalized once, here, so dispatch, SKU lookup and admission all see one
    // vocabulary. Emission everywhere in this SDK uses only the new name.
    if (reqPayload && reqPayload.offering === undefined) {
      const legacy = (env.payload as { skill?: unknown }).skill;
      if (typeof legacy === "string") reqPayload.offering = legacy;
    }

    // The §6.4 exception (see sendRespond): the reaper's liveness probe is
    // answered on the transport reply subject, so every reply this dispatch
    // makes needs to know it is one. It also gets no §6.4a accept, because the
    // probe's caller reads ONE reply, and an accept in front of the answer
    // would be that reply.
    const probe = audience === "agent" && reqPayload?.offering === "__registry_probe__";
    // Where this dispatch's replies go: the transport reply subject for the
    // two sendRespond exceptions, the sender's inbox for everything else.
    const viaReply = probe || guarded;

    // A message far larger than a message is not a message (2.9). Before the
    // handler is resolved, so an oversized message costs no model call, and
    // before the stream branch, because `config.stream = true` used to be the
    // flag that walked past every check the adapter had (2.4) and the SDK must
    // not reintroduce that shape.
    // A message for a person carries its text in `payload.text` (§5.7), so
    // that is what the cap measures for one.
    if (this.overInboundCap(audience === "person" ? ((env.payload as Record<string, unknown> | undefined)?.text ?? env.payload) : reqPayload.input, env, msg, viaReply)) return;

    // ── the pre-admission surface (§1.5 invariant 4) ──────────────────────
    // `describe` reads and `knock` asks; admission applies to neither, and
    // neither creates a task, sends an accept, or reaches a handler the
    // application did not register for it by name (a default handler is the
    // agent's own code, and §10.14 says a describe must never run it).
    if (audience === "agent" && !probe && reqPayload.offering === "describe" && !this.router.has("describe")) {
      await this.answerDescribe(msg, env, viaReply);
      return;
    }
    if (audience === "agent" && !probe && reqPayload.offering === "knock" && this.admissionGate && !this.router.has("knock")) {
      await this.answerKnock(msg, env, reqPayload, viaReply);
      return;
    }

    // ── §8.9 open the box ────────────────────────────────────────────────
    // After the size cap, which is a DoS measure and belongs on the bytes that
    // actually arrived; before everything else, so the cancel parser, the
    // admission hooks, the fence and the handler all see one shape and no part
    // of the pipeline has to know about ciphertext.
    //
    // Only when this agent holds an encryption seed AND the box opens. A seed
    // we do not have, or a box that is not ours, leaves the payload exactly as
    // it arrived: an embedder that opens sealed payloads in its own handler
    // (the reference adapter does) keeps working unchanged.
    let sealedIn = false;
    let claimedReplyKey: string | undefined;
    if (this.encryptionSeed && isSealedPayload(reqPayload.input)) {
      const opened = openSealedPayload(reqPayload.input, this.encryptionSeed);
      if (opened) {
        reqPayload.input = opened.payload;
        sealedIn = true;
        claimedReplyKey = opened.reply_key;
      }
    }

    // §10.8: `task.cancel` is a protocol operation, not an application offering —
    // intercepted BEFORE fencing (fencing rewrites input, and the reason is a
    // closed-enum string matched byte-exactly) and before the router, so an
    // agent honours cancels whether or not the application registered
    // anything. The note is sender text; the §22.5 cap above already bounded it.
    if (audience === "agent" && reqPayload.offering === "task.cancel") {
      await this.handleInboundCancel(msg, env, reqPayload, viaReply);
      return;
    }

    // ── §8.9 `required`: this inbox does not read cleartext ──────────────
    // A refusal of admission, so it lands here: after the §22 checks, before
    // the accept, and after the cancel interception on purpose. A cancel is a
    // protocol operation carrying a task id and a closed-enum reason, not the
    // caller's material, and an agent that stopped honouring cancels because
    // they were not encrypted would be protecting nothing at the cost of the
    // one message that ends work already running.
    if (this.manifest?.sealing === "required" && !sealedIn) {
      const errEnv = this.newEnvelope({
        type: "respond",
        from: this.agentId,
        to: env.from,
        in_reply_to: env.id,
        task_id: env.task_id,
        trace: childSpan(env.trace),
        error: {
          code: ErrorCode.SEALING_REQUIRED,
          message:
            `This agent declares sealing: "required" (§8.9) and this request arrived in the ` +
            `clear, so its content was not read. Resolve this agent's manifest, seal to the ` +
            `encryption_key its §8.3 claim covers, and send again.`,
          retryable: false,
        },
        payload: { status: "failed" },
      });
      this.sendRespond(msg, env, encode(errEnv), { transportReply: viaReply, tap: true });
      return;
    }

    // ── EXT-6 admission, on this agent's own side (admission.ts) ─────────
    // After the §22 checks and the box is open, before anything is accepted:
    // a sender the roster holds or blocks gets the queued acknowledgement and
    // nothing else, and a message for an offering with no handler goes to the
    // inbox when the agent asked for one.
    if (this.admissionGate && !probe && (await this.admissionDoor(msg, env, reqPayload, viaReply, audience === "person"))) return;

    // ── SPEC.md §5.7: a message written to this agent's person ──────────
    // After admission (the mark gives a sender no standing: a held sender
    // stays held) and before anything that makes it work: no trial, no
    // allowance, no agreement, no admit hook, no accept, no Task, no metering
    // and no dispatch, whatever offering or budget it names. It goes to the
    // person surface, and the sender gets the queued acknowledgement any
    // queued message gets.
    if (audience === "person") {
      const surfaced = this.surfaceToPerson(env, "request");
      this.answerQueued(msg, env, viaReply, surfaced);
      return;
    }

    // The task id this dispatch runs under, computed once so the §7.7
    // admission phase, the regular handler and the stream branch all agree.
    // A request naming a Task resumes it only when that Task is this agent's
    // paused work for this same requester (resolveDispatchTask): a task id is
    // public, and naming one is not owning it. Before admission, so a refused
    // request places no hold and gets no accept.
    const resolved = await this.resolveDispatchTask(env);
    if (resolved.kind === "refuse") {
      const refuseEnv = this.newEnvelope({
        type: "respond",
        from: this.agentId,
        to: env.from,
        in_reply_to: env.id,
        trace: childSpan(env.trace),
        error: resolved.error,
        payload: { status: "failed" },
      });
      this.sendRespond(msg, env, encode(refuseEnv), { transportReply: viaReply, tap: true });
      return;
    }
    const dispatchTaskId = resolved.taskId;
    const resuming = resolved.kind === "resume";
    // Who asked for this dispatch: the only agent whose task.cancel for it is
    // taken (cancelStanding), and whose later request naming it is its own.
    this.dispatchOwners.remember(dispatchTaskId, env.from, reqPayload.offering);
    this.noRecord.delete(dispatchTaskId);

    // ── §7.7 admission, then the §6.4a accept ──────────────────────────
    // Everything §22 refuses has been refused above. What remains before the
    // handler is the responder's own admission decision, in two layers, both
    // BEFORE the accept (§6.4a: "refusals of admission happen instead of an
    // accept, never after one"):
    //
    //  1. The EXT-8 allowance — the OWNER's policy, checked SDK-automatically
    //    whenever one is armed, and first: an exhausted allowance refuses (or
    //    holds for the owner) without consulting application code at all.
    //  2. The per-offering `admit` hook (HandlerOptions.admit) — the
    //    APPLICATION's decision, where budgetInsufficient / deadlineUnmeetable
    //    belong. A hook that throws makes the refusal the first (and only)
    //    reply.
    //  0. A trial request (Common Agent 7.7) goes through the trial gate
    //     first: its own order (budget, offered, who, input, counts, funds),
    //     its own refusal (TRIAL_REFUSED), and on admission it is counted and
    //     owes nothing, so the ordinary allowance check, the agreement and the
    //     funds hold are skipped. Its spend is metered as trial spend.
    let trialCtx: TrialContext | null = null;
    if (reqPayload.trial === true) {
      trialCtx = await this.trialAdmissionGate(msg, env, reqPayload, dispatchTaskId, viaReply);
      if (!trialCtx) return;
    }
    if (this.allowance && !trialCtx) {
      const admitted = await this.allowanceAdmission(msg, env, reqPayload, dispatchTaskId, viaReply);
      if (!admitted) return;
    }
    // 1b. The §19.5 agreement — has this consumer's ACCOUNT accepted the terms
    //     of the paid SKU covering this offering? — and, once it has, the funds
    //     hold that authorises this job against its balance. Free offerings
    //     reach neither service. From here on a paid dispatch may be carrying a
    //     hold, which every terminal point below either leaves standing (it
    //     delivered) or releases (it did not).
    if (!trialCtx && !(await this.agreementAdmission(msg, env, reqPayload, dispatchTaskId, viaReply))) return;
    const admitHook = this.router.optionsFor(reqPayload.offering)?.admit;
    if (admitHook) {
      try {
        await admitHook({
          envelope: env,
          taskId: dispatchTaskId,
          traceContext: env.trace,
          budget: env.budget,
          reportUsage: (usage) => void this.reportUsage(dispatchTaskId, usage, env.context_id),
          reportMeter: (meter, quantity) => this.reportMeterUsage(dispatchTaskId, meter, quantity),
          ...(trialCtx ? { trial: trialCtx } : {}),
        });
      } catch (err) {
        const meshErr =
          err instanceof MeshError
            ? err
            : new MeshError(
                ErrorCode.INTERNAL_ERROR,
                err instanceof Error ? err.message : "Admission refused",
                { cause: err instanceof Error ? err : undefined },
              );
        const refuseEnv = this.newEnvelope({
          type: "respond",
          from: this.agentId,
          to: env.from,
          in_reply_to: env.id,
          task_id: env.task_id,
          trace: childSpan(env.trace),
          error: meshErr.toErrorObject(),
          payload: { status: "failed" },
        });
        // The application refused work the funds gate already authorised — the
        // hold was placed a few lines above, because the contract puts it where
        // coverage is established. Nothing will be done and nothing will be
        // drawn, so give it straight back.
        this.releaseHold(dispatchTaskId, FundsReleaseReason.ADMISSION_REFUSED);
        this.sendRespond(msg, env, encode(refuseEnv), { transportReply: viaReply, tap: true });
        return;
      }
    }

    // The accept signal (§6.4a): a non-terminal respond with payload.status
    // "accepted", in_reply_to the admitted request, NO task_id on the wire —
    // emitted the moment admission is complete, BEFORE the handler (or its
    // dispatch) runs, so a caller facing a cold handler's multi-second first
    // token stops waiting blind. What may follow it is the work's own outcome,
    // including a dispatch error (OFFERING_NOT_FOUND, INPUT_INVALID) — a failure
    // of the work may follow an accept; a refusal of admission may not.
    //
    // Three paths never emit it (the probe's reason is at `probe` above):
    //
    //  - An agent registered `interactive` (§8.3a) holds an attended inbox:
    //    its handler queues the message for a live session rather than
    //    working it, and §6.4a forbids "accepted" there — nothing is about to
    //    run, and the queued ack the handler answers with is the whole
    //    synchronous reply.
    //  - A §16.4 mailbox-drain dispatch (`buffered`): the accept is a
    //    LIVE-delivery signal only (§6.4a). It exists to hold a live caller's
    //    wait open, and a drained request's caller stopped waiting when its
    //    window closed — its answer arrives at its own inbox, where an accept
    //    beside it would certify an admission the substantive respond already
    //    proves.
    //
    // Service ops (register §6.2, discover §6.3, describe §10.14) never reach
    // this path — they are answered by the platform services, not the inbox.
    if (!buffered && !probe && this.manifest?.interaction !== "interactive") {
      const acceptEnv = this.newEnvelope({
        type: "respond",
        from: this.agentId,
        to: env.from,
        in_reply_to: env.id,
        trace: childSpan(env.trace),
        payload: { status: "accepted" },
      });
      // Tap: the accept is observable to the operator surfaces like every
      // other response this agent makes.
      this.sendRespond(msg, env, encode(acceptEnv), { transportReply: guarded, tap: true });
    }

    // Untrusted text, framed and fenced before any handler sees it (2.2, 2.3),
    // unless the caller opted out because it frames inbound text itself. The
    // ENVELOPE is left verbatim: `ctx.envelope` must still verify.
    const input = this.fenceInbound
      ? fenceInboundInput(reqPayload.input, { from: env.from, trace: env.trace })
      : reqPayload.input;

    // Input this agent cannot use (§12.2 INPUT_NOT_UNDERSTOOD, Common Agent
    // §4.7.1): a help question on the chat offering is answered from the card,
    // and a message that does not carry what the offering declares gets the
    // standard reply, before any handler runs. Read off the raw input: the
    // fence rewrites text, and the phrases are matched on what was sent.
    if (this.inputFitEnabled && this.answerInputFit(msg, env, reqPayload, viaReply, dispatchTaskId)) return;

    const isStreamRequest = reqPayload.config?.stream === true;

    // Check for stream handler first if streaming is requested
    if (isStreamRequest) {
      const streamHandler = this.router.resolveStream(reqPayload.offering);
      if (streamHandler) {
        // §7.3: a stream that resumes a paused Task takes it back to working
        // on the record first, so the stream's own ending (completed, failed)
        // is a legal step from there. A fresh stream's first update creates
        // its record, so it needs none.
        if (resuming) this.publishDeferredTerminal(dispatchTaskId, env, { payload: { status: "working" } }, { outbox: false });
        await this.handleStreamRequest(
          msg,
          env,
          reqPayload,
          input,
          streamHandler,
          viaReply,
          dispatchTaskId,
        );
        return;
      }
    }

    // Fall through to regular handler
    const handler = this.router.resolve(reqPayload.offering);

    if (!handler) {
      const errEnv = this.newEnvelope({
        type: "respond",
        from: this.agentId,
        to: env.from,
        in_reply_to: env.id,
        task_id: env.task_id,
        trace: childSpan(env.trace),
        error: {
          code: ErrorCode.OFFERING_NOT_FOUND,
          message: `No handler registered for offering '${reqPayload.offering}'`,
          retryable: false,
        },
      });
      // A SKU covered this offering and nothing is registered to do it — a
      // misconfiguration on this side, so the buyer's money goes back.
      this.releaseHold(dispatchTaskId, FundsReleaseReason.OFFERING_NOT_FOUND);
      // Tap: publish error response for activity observation
      this.sendRespond(msg, env, encode(errEnv), { transportReply: viaReply, tap: true });
      return;
    }

    const ctx: RequestContext = {
      envelope: env,
      taskId: dispatchTaskId,
      traceContext: env.trace,
      budget: env.budget,
      reportUsage: (usage) => void this.reportUsage(dispatchTaskId, usage, env.context_id),
      reportMeter: (meter, quantity) => this.reportMeterUsage(dispatchTaskId, meter, quantity),
      ...(trialCtx ? { trial: trialCtx } : {}),
    };

    // The consumer half of the hop (§13.1.1), parented under the sender's span
    // by virtue of carrying the inbound envelope's own trace. Timed around the
    // handler, which is the part this agent is answerable for.
    const spanStart = Date.now();
    const closeSpan = (outcome: SpanOutcome, errorCode?: string) =>
      this.publishSpan({
        trace: env.trace,
        kind: "consumer",
        agentId: this.agentId,
        operation: "request",
        peer: env.from,
        offering: reqPayload.offering,
        taskId: dispatchTaskId,
        contextId: env.context_id,
        outcome,
        errorCode,
        startedAt: spanStart,
        endedAt: Date.now(),
      });

    // §7.0: set when this dispatch answered the live wait with `working` and
    // owes its terminal statement to the task update channel instead.
    let deferred = false;

    // §7.3: the Task record must see a LEGAL sequence of states. Two dispatch
    // shapes used to skip `working` on the task update channel and then state
    // an outcome that only `working` may lead to:
    //
    //  - A RESUME: a request naming an existing Task (`env.task_id`), the
    //    follow-up `request` §7.3 names as the trigger of input_required →
    //    working. The record was parked in input_required, and the outcome
    //    (failed, completed) is refused from there, so the Task never ended.
    //  - A DEFERRAL: the `working` answer went to the caller's inbox only, so
    //    a Task paused or ended by a later update had never been working on
    //    the record either.
    //
    // So a resume records `working` on the update channel before its handler
    // runs, and a deferral records it when it defers. After that, every
    // outcome is legal from `working`, and a resume's outcome is recorded on
    // the channel too (`recordOnTask`), whatever its inbox reply looks like.
    // The inbox replies themselves are unchanged. `resuming` is decided above
    // (resolveDispatchTask): a request that merely names a Task is not one.
    let workingRecorded = false;
    const recordOnTask = (payload: RespondPayload & { problems?: unknown }, error?: ErrorObject | null) =>
      this.publishDeferredTerminal(dispatchTaskId, env, { payload, error }, { outbox: false });
    const recordWorking = () => {
      if (workingRecorded) return;
      workingRecorded = true;
      recordOnTask({ status: "working" });
    };
    if (resuming) recordWorking();
    try {
      // §13.1: the inbound trace is ambient while the handler runs, so any
      // request/emit the handler makes joins the same trace automatically.
      // §10.8: so is the dispatch (task id + offering), so any sub-request the
      // handler makes is recorded as a delegation for cancel propagation.
      // §7.0 deferral (HandlerOptions.deferAfterMs): a LIVE dispatch with a
      // threshold configured races the handler against it; when the handler
      // is still running at the threshold, the caller's live wait is answered
      // with a non-terminal `working` respond carrying the dispatch task id,
      // and the terminal statement will travel the task update channel below.
      // Drained dispatches never defer — their requester has no live wait to
      // release, and the late terminal respond already reaches its inbox
      // (§6.4). Same gate as the Rust SDK.
      const deferAfterMs = this.router.optionsFor(reqPayload.offering)?.deferAfterMs;
      const run = runWithDispatch({ taskId: ctx.taskId, offering: reqPayload.offering }, () =>
        runWithTrace(env.trace, () => handler(input, ctx)),
      );
      let result: unknown;
      if (deferAfterMs !== undefined && !buffered) {
        const DEFER = Symbol("defer");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const raced = await Promise.race([
          run,
          new Promise<typeof DEFER>((r) => {
            timer = setTimeout(() => r(DEFER), deferAfterMs);
          }),
        ]);
        if (raced === DEFER) {
          deferred = true;
          // §7.3: the record goes working before anything this Task says next.
          recordWorking();
          const workingEnv = this.newEnvelope({
            type: "respond",
            from: this.agentId,
            to: env.from,
            in_reply_to: env.id,
            task_id: dispatchTaskId,
            trace: childSpan(env.trace),
            payload: { status: "working", ...this.trialMark(dispatchTaskId) },
          });
          // Same shape and destination as the §11.3 streaming opening; tapped
          // like every other respond this agent makes.
          this.sendRespond(msg, env, encode(workingEnv), { transportReply: viaReply, tap: true });
          result = await run;
        } else {
          clearTimeout(timer);
          result = raced;
        }
      } else {
        result = await run;
      }
      closeSpan("ok");

      const respPayload: RespondPayload = {
        status: "completed",
        output: result,
        ...this.trialMark(dispatchTaskId),
      };

      // §19.3: report actual spend in the `cost` field of the terminal
      // respond — the total the host reported for this task through
      // ctx.reportUsage / reportUsage(), metered by the EXT-8 allowance.
      // Informative, not verified, exactly as the budget's spend report is.
      const spendReport = this.allowanceSpendReport(ctx.taskId);
      if (spendReport) respPayload.cost = spendReport;

      // §13.5: the usage receipt — declared meter quantities the host reported
      // through ctx.reportMeter, attached where the envelope signature covers
      // them. Attach-once: the ledger forgets the task as it hands these over.
      const usageReport = this.meterUsage.take(ctx.taskId);
      if (usageReport) respPayload.usage = usageReport;

      // ── §8.9 the deliverable goes back the way it came ─────────────
      // A sealed ask that named a reply_key asked for a sealed answer, and
      // this is the one place in the exchange where the deliverable exists —
      // so answering in the clear here would undo the whole thing at the
      // worst possible moment. `output` is what gets sealed; `status`, cost
      // and the usage receipt stay readable, because a mesh that cannot see
      // whether work completed cannot be operated (§8.9's list).
      //
      // A sealed ask that named NO reply_key asked for nothing back and is
      // answered in the clear, which the extension permits and which is what
      // a sender holding no encryption key of its own has chosen.
      if (sealedIn && claimedReplyKey !== undefined) {
        const key = await this.replySealKey(env.from, claimedReplyKey);
        if (!key) {
          const refuseEnv = this.newEnvelope({
            type: "respond",
            from: this.agentId,
            to: env.from,
            in_reply_to: env.id,
            task_id: env.task_id,
            trace: childSpan(env.trace),
            error: {
              code: ErrorCode.SEALING_REQUIRED,
              message:
                `This request was sealed and asked for a sealed answer, but its reply_key ` +
                `could not be resolved against the sender's own published encryption key ` +
                `(§8.3, §8.9) — either the sender declared none, or it named a different ` +
                `key. The work ran; the answer is NOT being sent in the clear.`,
              retryable: false,
            },
            payload: { status: "failed" },
          });
          // The work ran and the deliverable is being withheld, so the buyer
          // gets nothing: the task ends `failed` and the hold goes back. The
          // seller absorbs the compute, which is the right way round — an
          // unresolvable reply_key is a fact about this exchange, not a reason
          // to charge somebody for an answer they never received.
          this.releaseHold(dispatchTaskId, FundsReleaseReason.SEALING_REQUIRED);
          if (deferred) {
            // The caller was told `working`: the sealing refusal is this
            // task's terminal statement and travels the update channel.
            this.publishDeferredTerminal(dispatchTaskId, env, {
              payload: { status: "failed", note: "SEALING_REQUIRED: the reply_key could not be resolved" },
              error: refuseEnv.error,
            });
            return;
          }
          if (resuming) recordOnTask({ status: "failed", note: "SEALING_REQUIRED: the reply_key could not be resolved" }, refuseEnv.error);
          this.sendRespond(msg, env, encode(refuseEnv), { transportReply: viaReply, tap: true });
          return;
        }
        respPayload.output = sealPayloadTo(
          respPayload.output,
          key,
          this.encryptionSeed ? encryptionPublicFromSeed(this.encryptionSeed) : undefined,
        );
      }

      // §7.0 deferred completion: the caller was told `working`, so the
      // terminal statement — output, §19.3 cost and §13.5 usage exactly as a
      // bare answer would carry them — is published on the task update
      // channel, where the task manager records it durably (§7.4) and
      // `awaitTask` / the requester's local task store recover it.
      if (deferred) {
        // Delivered: the hold stands for the platform's draw (see holdDelivered).
        this.holdDelivered(dispatchTaskId);
        this.publishDeferredTerminal(dispatchTaskId, env, { payload: respPayload });
        return;
      }

      // 0.2: a synchronous handler completes the work in one terminal reply —
      // a BARE response (no task_id). No Task is created (§6.4). Deferred and
      // streaming work (which does create a Task) goes through other paths.
      const respEnv = this.newEnvelope({
        type: "respond",
        from: this.agentId,
        to: env.from,
        in_reply_to: env.id,
        trace: childSpan(env.trace),
        payload: respPayload,
      });

      // §6.4a third carve-out beside probe and guarded: an interactive
      // agent's queued ack "rides the transport reply channel, the one
      // channel §18.7 reserves for delivery-status signals" — it is the node
      // speaking about delivery, not the agent answering, and the caller's
      // live wait on the reply subject is what it exists to release. Shape
      // over mode on the value side (queuedAckOf is the pinned
      // accept-signal.json matcher) but gated on the declared interaction,
      // so a service agent whose handler happens to return {queued, inbox_id}
      // still answers at the sender's inbox like any result. On a drained
      // dispatch there is no reply subject and sendRespond sends nothing:
      // the queued ack is a live-delivery signal, exactly like the accept.
      const queuedAck =
        this.manifest?.interaction === "interactive" && this.queuedAckOf(respEnv) !== null;

      // Delivered: the hold stands, and the platform draws against it when the
      // rating fold writes this job's charge.
      this.holdDelivered(dispatchTaskId);

      // A resumed Task ends on its record too. The usage receipt stays on the
      // inbox reply alone: one receipt per request (§13.5). Not on a queued
      // ack: an interactive agent that queued the resume for its session has
      // not answered it yet, so the record stays `working` (recorded when the
      // resume arrived) until the real answer, and no completion is claimed.
      if (resuming && !queuedAck) {
        const { usage: _receipt, ...recorded } = respPayload;
        recordOnTask(recorded);
      }

      // Tap: publish response for activity observation
      this.sendRespond(msg, env, encode(respEnv), { transportReply: viaReply || queuedAck, tap: true });
    } catch (err) {
      // A rejection is a refusal rather than a failure, and the span says so:
      // "this agent declined" and "this agent broke" are different facts and a
      // trace that conflates them sends somebody debugging the wrong thing.
      if (err instanceof RejectedError) closeSpan("refused");
      else {
        const { outcome, errorCode } = outcomeOf(err);
        closeSpan(outcome, errorCode);
      }

      // The funds hold, if this dispatch carries one. The PAUSES keep theirs:
      // `input_required` is not terminal, the task is expected to resume on a
      // corrected input or a budget revision, and releasing here would leave
      // the resumed work unauthorised. Everything terminal below gives it back.
      if (!(err instanceof InputProblemsError) && !(err instanceof BudgetExhaustedError)) {
        this.releaseHold(
          dispatchTaskId,
          err instanceof RejectedError
            ? FundsReleaseReason.REJECTED
            : FundsReleaseReason.TASK_FAILED,
        );
      }

      // §7.0: a deferred dispatch already answered the live wait with
      // `working`, so every outcome from here is a task update. The pauses
      // stay pauses (working → input_required is a legal §7.3 transition);
      // a rejection after work began is recorded as `failed` (§7.3 has no
      // working → rejected edge) with the decline in the note.
      if (deferred) {
        if (err instanceof InputProblemsError) {
          this.publishDeferredTerminal(dispatchTaskId, env, {
            payload: { status: "input_required", message: err.message, problems: err.problems },
          });
        } else if (err instanceof BudgetExhaustedError) {
          this.publishDeferredTerminal(dispatchTaskId, env, {
            payload: { status: "input_required", message: err.message },
            error: err.toErrorObject(),
          });
        } else if (err instanceof RejectedError) {
          this.publishDeferredTerminal(dispatchTaskId, env, {
            payload: { status: "failed", note: `rejected after the work began: ${err.message}` },
          });
        } else {
          const meshErr =
            err instanceof MeshError
              ? err
              : new MeshError(
                  ErrorCode.INTERNAL_ERROR,
                  err instanceof Error ? err.message : "Handler error",
                  { cause: err instanceof Error ? err : undefined },
                );
          const failPayload: RespondPayload = { status: "failed" };
          const failUsage = this.meterUsage.take(ctx.taskId);
          if (failUsage) failPayload.usage = failUsage;
          this.publishDeferredTerminal(dispatchTaskId, env, {
            payload: failPayload,
            error: meshErr.toErrorObject(),
          });
        }
        return;
      }

      // A handler that throws RejectedError is DECLINING the task (§7.2
      // `rejected`), not failing it. Terminal, bare reply, no error object.
      if (err instanceof RejectedError) {
        // §7.3 has no working → rejected edge: a resumed Task that is then
        // declined is recorded failed, the decline in the note (as deferred).
        if (resuming) recordOnTask({ status: "failed", note: `rejected after the work began: ${err.message}` });
        const rejEnv = this.newEnvelope({
          type: "respond",
          from: this.agentId,
          to: env.from,
          in_reply_to: env.id,
          task_id: env.task_id,
          trace: childSpan(env.trace),
          payload: { status: "rejected", message: err.message },
        });
        this.sendRespond(msg, env, encode(rejEnv), { transportReply: viaReply, tap: true });
        return;
      }

      // §6.5 problem reports: the handler cannot proceed for want of a
      // usable input and is pausing on DESCRIBED problems, not failing.
      // Non-terminal `input_required` with `payload.problems` exactly as
      // the handler raised them, and a task_id — the same §7.0 promotion a
      // budget pause gets, because the resolution (a corrected input, a
      // restored permission) continues on the Task.
      if (err instanceof InputProblemsError) {
        const pauseEnv = this.newEnvelope({
          type: "respond",
          from: this.agentId,
          to: env.from,
          in_reply_to: env.id,
          task_id: ctx.taskId,
          trace: childSpan(env.trace),
          payload: { status: "input_required", message: err.message, problems: err.problems, ...this.trialMark(ctx.taskId) },
        });
        // The same pause on the task's own subject: this is the CREATING
        // update (the task manager fixes the parties from it — `to` names
        // the requester), so the parked task exists as a record and the
        // wait is visible to the requester's surfaces, not only to the
        // requester's socket. Without this, a park was a reply that
        // vanished with the connection. Published BEFORE the inbox reply, so
        // a requester that acts on the reply at once (a revision, a resume)
        // finds the record there.
        const recordEnv = this.newEnvelope({
          type: "respond",
          from: this.agentId,
          to: env.from,
          task_id: ctx.taskId,
          trace: childSpan(env.trace),
          payload: { status: "input_required", message: err.message, problems: err.problems, ...this.trialMark(ctx.taskId) },
        });
        this.noteResumable(ctx.taskId, env, "input_required");
        this.conn.publish(Subjects.taskUpdate(ctx.taskId), encode(recordEnv));
        this.sendRespond(msg, env, encode(pauseEnv), { transportReply: viaReply, tap: true });
        return;
      }

      // §7.7 hitting the ceiling: the handler stopped BEFORE crossing it and
      // is pausing, not failing. Non-terminal `input_required` with
      // BUDGET_EXHAUSTED, spend so far and the estimate to finish in the
      // error details, and a task_id — which for a bare request is the §7.0
      // promotion: the budget conversation continues on the Task. The input
      // required is money: a budget revision resumes, a cancel keeps the
      // partial artifacts.
      if (err instanceof BudgetExhaustedError) {
        const pauseEnv = this.newEnvelope({
          type: "respond",
          from: this.agentId,
          to: env.from,
          in_reply_to: env.id,
          task_id: ctx.taskId,
          trace: childSpan(env.trace),
          error: err.toErrorObject(),
          payload: { status: "input_required", message: err.message },
        });
        // The same pause on the task's own subject, as for input problems: the
        // budget conversation continues on the Task, so the Task must exist
        // as a record (a revision for a Task with no record is refused). The
        // creating update goes first, before the inbox reply, as above.
        recordOnTask({ status: "input_required", message: err.message }, err.toErrorObject());
        this.sendRespond(msg, env, encode(pauseEnv), { transportReply: viaReply, tap: true });
        return;
      }

      const meshErr =
        err instanceof MeshError
          ? err
          : new MeshError(
              ErrorCode.INTERNAL_ERROR,
              err instanceof Error ? err.message : "Handler error",
              { cause: err instanceof Error ? err : undefined },
            );

      // §13.5: a failed terminal respond carries the receipt too — the work
      // consumed whether or not it succeeded, and an honest receipt says so.
      const failUsage = this.meterUsage.take(ctx.taskId);
      const errEnv = this.newEnvelope({
        type: "respond",
        from: this.agentId,
        to: env.from,
        in_reply_to: env.id,
        task_id: env.task_id,
        trace: childSpan(env.trace),
        error: meshErr.toErrorObject(),
        payload: { status: "failed", ...(failUsage ? { usage: failUsage } : {}) },
      });

      // A resumed Task ends failed on its record too (the receipt stays on the reply).
      if (resuming) recordOnTask({ status: "failed" }, errEnv.error);

      // Tap: publish error response for activity observation
      this.sendRespond(msg, env, encode(errEnv), { transportReply: viaReply, tap: true });
    }
  }

  /** An inbound `task.cancel` request (§10.8): validate the reason at the
   *  door, propagate to still-live delegates, acknowledge with the canceled
   *  state. Best-effort on the work by design — there is no responder-side
   *  task registry, so the acknowledgement reports the cancel as taken, and a
   *  completion that crossed it in flight stands on the update subject. */
  private async handleInboundCancel(
    msg: Msg,
    env: Envelope,
    reqPayload: RequestPayload,
    transportReply: boolean,
  ): Promise<void> {
    let taskId: string;
    let reason: CancelReason;
    let note: string | undefined;
    try {
      ({ taskId, reason, note } = parseCancelInput(reqPayload.input, env.task_id));
    } catch (err) {
      // The closed enum's teeth (§10.8): unknown or missing reason is
      // INVALID_ENVELOPE at the door, exactly like a malformed budget.
      const errEnv = this.newEnvelope({
        type: "respond",
        from: this.agentId,
        to: env.from,
        in_reply_to: env.id,
        task_id: env.task_id,
        trace: childSpan(env.trace),
        error: {
          code: ErrorCode.INVALID_ENVELOPE,
          message: err instanceof MeshError ? err.message : "Invalid cancel (§10.8)",
          retryable: false,
        },
      });
      this.sendRespond(msg, env, encode(errEnv), { transportReply });
      return;
    }

    // Only the Task's requester cancels it. A task id is public (it is
    // broadcast on mesh.event.task.*), and a cancel releases the funds hold
    // and cancels every Task this one subcontracted, so anybody else's cancel
    // is refused and does nothing.
    const standing = await this.cancelStanding(taskId, env.from);
    if (standing.kind === "refuse") {
      const errEnv = this.newEnvelope({
        type: "respond",
        from: this.agentId,
        to: env.from,
        in_reply_to: env.id,
        trace: childSpan(env.trace),
        error: standing.error,
      });
      this.sendRespond(msg, env, encode(errEnv), { transportReply, tap: true });
      return;
    }
    // A canceled Task is not resumable.
    this.resumableTasks.forget(taskId);

    // §10.8 propagation MUST: forward to every still-live delegate of this
    // task as `upstream_cancelled`, original reason in the note — unless the
    // handler that delegated opted out (HandlerOptions.propagateCancel).
    // (`nothing`: no dispatch ran here under the id and it has no record, so
    // there are no delegates and no hold, and the acknowledgement stands.)
    if (standing.kind === "requester") this.propagateCancel(taskId, reason, note);

    // A canceled task will not be delivered, so its hold goes back. Cancels
    // are best-effort on the WORK — there is no responder-side task registry,
    // and a completion that crossed the cancel in flight stands — but the hold
    // is ours to settle and the cancel names the task id, so this is the one
    // place we can settle it. A completion that raced the cancel releases
    // nothing, because a delivered task has already forgotten its hold; a
    // cancel for a task this agent never ran finds no entry and does nothing.
    if (standing.kind === "requester") this.releaseHold(taskId, FundsReleaseReason.CANCELED);

    const respEnv = this.newEnvelope({
      type: "respond",
      from: this.agentId,
      to: env.from,
      in_reply_to: env.id,
      task_id: taskId,
      trace: childSpan(env.trace),
      payload: { status: "canceled" },
    });
    // Tap: publish response for activity observation
    this.sendRespond(msg, env, encode(respEnv), { transportReply, tap: true });
  }

  /** The §19.3 spend report for a task's terminal respond: the allowance
   *  ledger's total for the task, in the document's currency. Null when no
   *  valid allowance is armed or nothing was reported — an absent report is
   *  legal (SHOULD), a made-up one is not. */
  private allowanceSpendReport(taskId: string): { amount_micro: number; currency: string } | null {
    if (!this.allowance) return null;
    const currency = this.allowance.valid ? this.allowance.currency() : null;
    if (currency === null) return null;
    const spent = this.allowance.spentForTask(taskId);
    if (spent <= 0) return null;
    return { amount_micro: spent, currency };
  }

  /** The owner key that groups the requesting agent's account (§8.6), cached.
   *  Null when the agent is unregistered or the registry cannot be reached —
   *  in which case no agreement can be matched, and paid work is refused. */
  private async consumerOwner(agentId: string): Promise<string | null> {
    const hit = this.ownerOf.get(agentId);
    if (hit && Date.now() - hit.at < AGREEMENT_TTL_MS) return hit.owner;
    let owner: string | null = null;
    try {
      owner = (await this.getManifest(agentId)).owner ?? null;
    } catch {
      owner = null;
    }
    this.ownerOf.set(agentId, { at: Date.now(), owner });
    return owner;
  }

  /**
   * The platform's agreement record for one consumer account, filtered to THIS
   * seller by the service (§19.5). The default lookup: a deployment that runs
   * the platform gets enforcement with nothing to wire, and one that does not
   * supplies its own through `onAgreementLookup`.
   *
   * A refusal or a timeout here is NOT "no agreements" by accident — it
   * throws, and the caller treats a throw as uncovered, so an outage refuses
   * paid work rather than giving it away.
   */
  private async lookupAgreementsOnMesh(consumerOwner: string): Promise<unknown[]> {
    const envelope = this.newEnvelope({
      type: "request",
      from: this.agentId,
      payload: { consumer_owner: consumerOwner },
    });
    const resp = await this.conn.request(AGREEMENT_LOOKUP_SUBJECT, encode(envelope), {
      timeout: DEFAULT_REQUEST_TIMEOUT_MS,
    });
    const respEnv = decode(resp.data);
    if (respEnv.error) throw MeshError.fromErrorObject(respEnv.error);
    const list = (respEnv.payload as { agreements?: unknown } | undefined)?.agreements;
    return Array.isArray(list) ? list : [];
  }

  /**
   * Ask the platform to authorise one job against the buyer's balance (the
   * funds-hold contract). The default hold: a deployment that runs the
   * platform gets the balance check with nothing to wire, and one that does
   * not supplies its own through `onFundsHold`.
   *
   * Never sends an amount. The platform holds the agreement and resolves the
   * live SKU through the same resolver the rating fold uses, so the hold and
   * the charge that follows it cannot disagree about the price; a seller that
   * could name the figure would be the one place where they could.
   *
   * A refusal or a timeout THROWS, like the agreement lookup, and for the same
   * reason: the caller treats a throw as "not authorised", so an outage
   * refuses paid work rather than giving it away.
   */
  private async placeHoldOnMesh(req: FundsHoldRequest): Promise<unknown> {
    const envelope = this.newEnvelope({
      type: "request",
      from: this.agentId,
      payload: { ...req },
    });
    const resp = await this.conn.request(FUNDS_HOLD_SUBJECT, encode(envelope), {
      timeout: DEFAULT_REQUEST_TIMEOUT_MS,
    });
    const respEnv = decode(resp.data);
    if (respEnv.error) throw MeshError.fromErrorObject(respEnv.error);
    return respEnv.payload;
  }

  /** Give a hold back over `mesh.funds.release`. Fire-and-forget by design —
   *  see `releaseHold` for why nothing waits on it. */
  private async releaseHoldOnMesh(holdId: string, reason: string): Promise<void> {
    const envelope = this.newEnvelope({
      type: "request",
      from: this.agentId,
      payload: { hold_id: holdId, reason },
    });
    const resp = await this.conn.request(FUNDS_RELEASE_SUBJECT, encode(envelope), {
      timeout: DEFAULT_REQUEST_TIMEOUT_MS,
    });
    const respEnv = decode(resp.data);
    if (respEnv.error) throw MeshError.fromErrorObject(respEnv.error);
  }

  /** Remember the hold this dispatch is running under, bounded. */
  private rememberHold(taskId: string, holdId: string): void {
    this.taskHolds.set(taskId, holdId);
    if (this.taskHolds.size > MAX_TRACKED_HOLDS) {
      const oldest = this.taskHolds.keys().next().value as string;
      this.taskHolds.delete(oldest);
    }
  }

  /**
   * The work was delivered: forget the hold WITHOUT releasing it. The platform
   * draws against a standing hold when the rating fold writes the charge, so
   * releasing here would hand the money back a moment before billing for it.
   */
  private holdDelivered(taskId: string): void {
    this.taskHolds.delete(taskId);
  }

  /**
   * The work will not be delivered — it failed, was declined, was refused by
   * the application's own admit hook after the hold was placed, or was
   * canceled. Give the money back now.
   *
   * Fire-and-forget: nothing in the buyer's refusal or the task's failure waits
   * on the release, because making a failure slower (or a second failure) to
   * give money back would be the worse trade. A release that does not land
   * leaves the hold to the platform's expiry sweep — expiry is the backstop,
   * never the plan, which is exactly why this is called at every terminal
   * point that is not a delivery.
   *
   * The entry is dropped BEFORE the send, so a double settle cannot release
   * twice.
   */
  private releaseHold(taskId: string, reason: FundsReleaseReasonValue): void {
    const holdId = this.taskHolds.get(taskId);
    if (holdId === undefined) return;
    this.taskHolds.delete(taskId);
    const send = this.fundsRelease
      ? this.fundsRelease(holdId, reason)
      : this.releaseHoldOnMesh(holdId, reason);
    void Promise.resolve(send).catch(() => {
      /* the expiry sweep is the backstop; nothing useful to say to the caller */
    });
  }

  /**
   * The §19.5 agreement check — SDK-automatic whenever a paid SKU covers the
   * requested offering, run in the same admission slot as the allowance and
   * BEFORE any work.
   *
   * Returns true to admit. False means the refusal (already sent, to the
   * sender's inbox) was this dispatch's first and only reply.
   *
   * Two obstacles, checked in order, both before any work: did this account
   * AGREE to the price (§19.5), and can it PAY it (the funds hold). The second
   * is only ever asked once the first says yes — a buyer who never accepted the
   * terms is told to accept them, not told their balance.
   *
   * Free is the default and the fast path: an offering covered by no SKU, or by a
   * `free` one, never reaches a lookup and never reaches a hold. Only a priced
   * offering pays for the owner resolution, and only once per owner per TTL.
   */
  private async agreementAdmission(
    msg: Msg,
    env: Envelope,
    reqPayload: RequestPayload,
    /** The dispatch task id — the job the hold is placed against, shared with
     *  the rest of the dispatch so the release can find it again. */
    taskId: string,
    transportReply: boolean,
  ): Promise<boolean> {
    const sku = skuFor(this.registerOpts?.skus, reqPayload.offering);
    if (!sku || sku.price.model === "free") return true; // §19.1: uncovered is free
    const approvalUrl = sku.provider.checkout_url ?? this.approvalUrl;
    if (!approvalUrl) return true; // warned at registration; a dead-end refusal helps nobody
    const digest = this.skuDigests.get(sku.sku);
    if (digest === undefined) return true; // no digest computed: cannot state what to accept

    const owner = await this.consumerOwner(env.from);

    // Same owner on both sides is not a sale, and must not be dressed up as
    // one. Without this an operator's own agents refuse each other until the
    // operator has formally accepted their own terms — a signature they give
    // themselves, recording a promise to pay themselves, checked against their
    // own price. Nothing about that ceremony protects anybody: the agreement
    // exists so a stranger cannot be charged a price they never saw, and there
    // is no stranger here.
    //
    // Resolved through the SAME lookup as the consumer rather than from a field
    // captured at registration, for two reasons: the registry rewrites `owner`
    // server-side (§8.3), so a locally-remembered value can be wrong; and using
    // one resolution path means the two sides cannot disagree about what an
    // owner IS. Cached per owner per TTL like any other, and only ever reached
    // on the priced path.
    if (owner !== null) {
      const self = await this.consumerOwner(this.agentId);
      if (self !== null && self === owner) return true;
    }

    let covered = false;
    if (owner !== null) {
      // The armed set first; the platform lookup only when this owner is
      // unknown here, and at most once per TTL.
      const held = this.agreements.get(owner) ?? [];
      covered = held.some((d) =>
        agreementCovers(d, {
          consumerOwner: owner,
          sellerAgent: this.agentId,
          sku: sku.sku,
          skuDigest: digest,
        }),
      );
      if (!covered) {
        // Reaching here means what we hold does NOT answer the question, so
        // ASK — every time, with no cache in front of it. Two attempts at one
        // went wrong live on 2026-08-02: caching the MISS made "approve, then
        // send again" keep refusing, and caching the HIT kept serving an
        // acceptance of the OLD terms after a re-price. Both read as broken
        // rather than as caching, and both were suppressing exactly the call
        // that would have fixed them — which is the tell that the cache never
        // belonged on this path. The lookup is one KV read, on a path that
        // does no work, already bounded by the inbound rate limiter.
        try {
          const fetched = this.agreementLookup
            ? await this.agreementLookup(owner)
            : await this.lookupAgreementsOnMesh(owner);
          const verified: AgreementDocument[] = [];
          for (const raw of fetched) {
            try {
              const doc = loadAgreement(raw);
              if (doc.seller_agent === this.agentId) verified.push(doc);
            } catch { /* an unverifiable agreement authorises nothing */ }
          }
          // Replace rather than merge: the platform's answer is the whole
          // truth for this (owner, seller) pair, so a revoked agreement
          // disappears here instead of lingering.
          this.agreements.set(owner, verified);
          covered = verified.some((d) =>
            agreementCovers(d, {
              consumerOwner: owner,
              sellerAgent: this.agentId,
              sku: sku.sku,
              skuDigest: digest,
            }),
          );
        } catch {
          covered = false; // a platform outage refuses paid work, never gives it away
        }
      }
    }
    // The account agreed to the price. Now the second question — can it pay?
    // `owner` is non-null by construction whenever `covered` is true: it is
    // only ever set inside the branch above.
    if (covered && owner !== null) {
      return await this.fundsAdmission(
        msg,
        env,
        { sku, digest, approvalUrl },
        owner,
        taskId,
        transportReply,
      );
    }

    const refuseEnv = this.newEnvelope({
      type: "respond",
      from: this.agentId,
      to: env.from,
      in_reply_to: env.id,
      task_id: env.task_id,
      trace: childSpan(env.trace),
      error: agreementRequired({
        sku: sku.sku,
        sku_digest: digest,
        approval_url: approvalUrl,
      }).toErrorObject(),
      payload: { status: "failed" },
    });
    // Tap: the refusal is observable to the operator surfaces, and the
    // platform records it as a quantity-0 meter event (§13.5).
    this.sendRespond(msg, env, encode(refuseEnv), { transportReply, tap: true });
    return false;
  }

  /**
   * The balance half of the paid-work gate (the funds-hold contract of
   * 2026-09-12): the buyer has agreed to this SKU's current terms, so ask the
   * platform to authorise this job against the buyer's balance before a line of
   * work runs.
   *
   * Returns true to admit — with the hold remembered against `taskId`, so
   * whichever terminal point this dispatch reaches can either leave it standing
   * for the draw or give it back. False means the refusal (already sent, to the
   * sender's inbox) was this dispatch's first and only reply, exactly as with a
   * missing agreement: the two are siblings, in the same slot, in the same
   * shape.
   *
   * A zero-value answer (`free: true`) admits and remembers nothing. It should
   * not be reachable — a free SKU returned at the top of `agreementAdmission`
   * and never got here — but a zero-value AGREEMENT can produce one, and
   * turning free work into a refusal because the ledger will not hold nothing
   * is the failure the platform's short-circuit exists to prevent.
   */
  private async fundsAdmission(
    msg: Msg,
    env: Envelope,
    /** The covering SKU as the coverage gate resolved it, with the two things
     *  a refusal needs to state: the digest the buyer would be accepting, and
     *  where they go to accept it. Passed in rather than re-resolved so both
     *  refusals out of this slot name the same terms. */
    terms: { sku: Sku; digest: string; approvalUrl: string },
    consumerOwner: string,
    taskId: string,
    transportReply: boolean,
  ): Promise<boolean> {
    const sku = terms.sku;
    // Never a `quantity`: at admission the work has not run, so the seller does
    // not know one, and a guess would be the seller naming the amount by the
    // back door. The contract's remainder rule covers a per-unit job that ends
    // up bigger than the hold.
    const req: FundsHoldRequest = {
      consumer_owner: consumerOwner,
      sku: sku.sku,
      job_id: taskId,
    };

    let held: FundsHoldResult;
    try {
      const answer = this.fundsHold ? await this.fundsHold(req) : await this.placeHoldOnMesh(req);
      // Read through the same loader whoever answered: a host hook must not be
      // able to admit paid work by returning a shape the contract does not
      // define, any more than the platform can.
      held = loadFundsHoldResult(answer);
    } catch (err) {
      // Four different facts, told apart on purpose.
      const fromPlatform = err instanceof MeshError ? err : null;
      const code = fromPlatform?.code ?? null;
      let refusal: MeshError;
      if (fromPlatform !== null && code === ErrorCode.INSUFFICIENT_FUNDS) {
        // The platform SAID no: pass its own words through — it is the only
        // party that knows the amount, the shortfall and where to add funds,
        // and the SDK inventing any of those would be inventing money.
        // Rebuilt rather than forwarded so `details.sku` is always there: the
        // platform is answering about a job and need not name the SKU, but the
        // buyer's refusal must, the same way the agreement refusal does.
        refusal = insufficientFunds(
          { sku: sku.sku, ...fromPlatform.details },
          fromPlatform.message,
        );
      } else if (fromPlatform !== null && code === ErrorCode.BUDGET_INSUFFICIENT) {
        // The platform SAID no on the engagement's spend ceiling, not on the
        // balance: a fixed-fee engagement whose period ceiling this job would
        // pass (Agent SoW §5.5.1). Same rule as INSUFFICIENT_FUNDS: pass its own
        // words and figures through — the estimate is the price quote, and the
        // ceiling and what remains of it are the platform's to know, not ours.
        // Not retryable: the same message gets the same answer until the
        // ceiling moves or the period turns. `details.sku` is guaranteed, as
        // on every refusal out of this slot.
        refusal = new MeshError(ErrorCode.BUDGET_INSUFFICIENT, fromPlatform.message, {
          retryable: false,
          details: { sku: sku.sku, ...fromPlatform.details },
        });
      } else if (code === ErrorCode.AGREEMENT_REQUIRED) {
        // The hold door re-checks coverage against the LIVE terms and can
        // disagree with the coverage gate a few lines above: the seller
        // re-priced between the two calls, or the platform's own registry read
        // came back empty. The contract's rule is that this is a missing
        // agreement and answers AGREEMENT_REQUIRED, "so the seller has one
        // refusal path and not two" — so forward it as exactly the refusal the
        // coverage gate would have sent, built from the seller's own digest and
        // approval URL rather than the platform's, because those are the terms
        // this agent is actually selling on.
        refusal = agreementRequired({
          sku: sku.sku,
          sku_digest: terms.digest,
          approval_url: terms.approvalUrl,
        });
      } else {
        // The platform could not be ASKED (timeout, no responders, a malformed
        // answer): refuse too — a balance this agent could not check is not a
        // balance it may spend against, which is the agreement lookup's rule
        // ("a platform outage refuses paid work, never gives it away") applied
        // to the same slot. But say what actually happened. INSUFFICIENT_FUNDS
        // here would tell a solvent buyer to go and top up an account that is
        // already full, and send them to a checkout over an outage on our side;
        // the honest code is the retryable one, because the identical message a
        // minute later may well be admitted.
        refusal = new MeshError(
          ErrorCode.AGENT_UNAVAILABLE,
          `Refused at admission: '${sku.sku}' is a paid offering and the funds service ` +
            `could not authorise this job, so no work was started (§19.5). Nothing was ` +
            `charged; try again.`,
          { retryable: true, details: { sku: sku.sku } },
        );
      }
      const refuseEnv = this.newEnvelope({
        type: "respond",
        from: this.agentId,
        to: env.from,
        in_reply_to: env.id,
        task_id: env.task_id,
        trace: childSpan(env.trace),
        error: refusal.toErrorObject(),
        payload: { status: "failed" },
      });
      // Tap, like the agreement refusal beside it: an admission refusal is
      // observable to the operator surfaces.
      this.sendRespond(msg, env, encode(refuseEnv), { transportReply, tap: true });
      return false;
    }

    if (held.hold_id !== null) this.rememberHold(taskId, held.hold_id);
    return true;
  }

  /**
   * The EXT-8 allowance admission check — SDK-automatic whenever an allowance
   * is armed, run BEFORE the per-offering admit hook and before the §6.4a accept.
   * Returns true to admit; false means the refusal (already sent, to the
   * sender's inbox) was this dispatch's first and only reply.
   *
   * The estimate is the host's estimator in tokens (default: ceil(sender-text
   * chars / 4)) priced through the document's cost_model; the decision is
   * smallest-remaining-wins across every applicable ceiling; a fail-closed
   * document reads as every ceiling exhausted (EXT-8 §1).
   *
   * On exhaustion, `on_exhausted` decides (EXT-8 §2): `refuse` answers §7.7's
   * refusal-with-estimate — BUDGET_INSUFFICIENT with `details.estimate` as the
   * price quote (§19.3 makes this legal even against a request that offered no
   * ceiling; on the wire it is indistinguishable from a budget-broke refusal,
   * deliberately). `ask_owner` holds the work unstarted and asks the host's
   * owner channel instead; the work proceeds only if the owner raised the
   * ceiling (a fresh setAllowance) and the re-check now fits. No owner channel
   * registered means nobody can ever answer, so the hold degrades to the same
   * refusal rather than hanging the caller into its timeout.
   */
  private async allowanceAdmission(
    msg: Msg,
    env: Envelope,
    reqPayload: RequestPayload,
    taskId: string,
    transportReply: boolean,
  ): Promise<boolean> {
    const engine = this.allowance!;
    const estimateTokens = this.allowanceEstimator
      ? this.allowanceEstimator(env, reqPayload)
      : Math.ceil(inboundTextLength(reqPayload.input) / 4);
    const estimateMicro = engine.priceTokens(estimateTokens) ?? 0;

    let decision = engine.decide(taskId, env.context_id, estimateMicro);
    if (decision.fits) return true;

    const currency = engine.currency();
    const estimate =
      currency === null ? undefined : { amount_micro: decision.estimate_micro, currency };

    if (engine.onExhausted() === "ask_owner" && this.allowanceAskOwner) {
      let proceed = false;
      try {
        proceed = await this.allowanceAskOwner({
          envelope: env,
          taskId,
          offering: reqPayload.offering,
          estimate: estimate ?? null,
          binding: decision.binding,
        });
      } catch {
        proceed = false; // an owner channel that errors is an owner that declined
      }
      if (proceed) {
        // The owner "raised the ceiling" by replacing the document
        // (setAllowance), which kept the ledger. Re-check against whatever is
        // armed NOW — approval is not admission; the arithmetic still decides.
        const current = this.allowance;
        if (current === null) return true; // owner removed the allowance entirely
        const reprice = current.priceTokens(estimateTokens) ?? 0;
        decision = current.decide(taskId, env.context_id, reprice);
        if (decision.fits) return true;
      }
    }

    const refuseEnv = this.newEnvelope({
      type: "respond",
      from: this.agentId,
      to: env.from,
      in_reply_to: env.id,
      task_id: env.task_id,
      trace: childSpan(env.trace),
      error: budgetInsufficient(estimate).toErrorObject(),
      payload: { status: "failed" },
    });
    // Tap: the refusal is observable to the operator surfaces, like every
    // other response this agent makes.
    this.sendRespond(msg, env, encode(refuseEnv), { transportReply, tap: true });
    return false;
  }

  private async handleStreamRequest(
    msg: Msg,
    env: Envelope,
    reqPayload: RequestPayload,
    /** The handler's input, already framed + fenced by the caller unless the
     *  agent opted out. Passed in rather than re-read from `reqPayload` so the
     *  stream path cannot drift back to raw text — that drift is exactly what
     *  made `config.stream = true` a way around every check (2.4). */
    input: unknown,
    handler: StreamOfferingHandler,
    /** Whether replies go to the transport reply subject (the sendRespond
     *  exceptions) rather than the sender's inbox. */
    transportReply: boolean,
    /** The dispatch task id handleInboxMessage computed — shared with the
     *  §7.7 admission phase so the whole dispatch agrees on one id. Validated
     *  as a single subject token before we get here (it becomes part of two
     *  publish subjects). */
    taskId: string,
  ): Promise<void> {

    const ctx: RequestContext = {
      envelope: env,
      taskId,
      traceContext: env.trace,
      // Validated by handleInboxMessage before either branch (§7.7).
      budget: env.budget,
      reportUsage: (usage) => void this.reportUsage(taskId, usage, env.context_id),
      reportMeter: (meter, quantity) => this.reportMeterUsage(taskId, meter, quantity),
      ...(this.trialTasks.has(taskId) ? { trial: this.trialTasks.get(taskId)! } : {}),
    };

    // Step 1: the opening "working" respond (§11.3). First-hop respond, so it
    // goes to the requester's inbox like any other (§6.4 hard cutover); the
    // chunks that follow ride the task's own stream subject, unchanged.
    const initialPayload: RespondPayload = {
      status: "working",
      message: "Streaming started",
      ...this.trialMark(taskId),
    };

    const initialEnv = this.newEnvelope({
      type: "respond",
      from: this.agentId,
      to: env.from,
      in_reply_to: env.id,
      task_id: taskId,
      trace: childSpan(env.trace),
      payload: initialPayload,
    });

    this.sendRespond(msg, env, encode(initialEnv), { transportReply });

    // Step 2: Create StreamWriter. It signs the final chunk (always, §11.6)
    // and every chunk when the requester asked via config.sign_chunks.
    const writer = createStreamWriter(this.conn, {
      agentId: this.agentId,
      requesterId: env.from,
      requestId: env.id,
      taskId,
      trace: env.trace,
      sign: (e) => signEnvelope(e, this.kp),
      signChunks: reqPayload.config?.sign_chunks ?? false,
      trial: this.trialTasks.has(taskId),
    });

    // Step 3: Call the handler. However it ends, the Task is not resumable
    // from this dispatch's pause any more (it never paused: streams end).
    this.resumableTasks.forget(taskId);
    try {
      await runWithDispatch({ taskId, offering: reqPayload.offering }, () =>
        runWithTrace(env.trace, () => handler(input, ctx, writer)),
      );

      // Auto-close if handler returns without calling end()
      if (!writer.closed) {
        writer.end();
      }
      // Delivered: the stream ran to its end, so the hold stands for the draw.
      this.holdDelivered(taskId);
    } catch (err) {
      // The stream failed. A writer already closed delivered its chunks before
      // the throw, so that one counts as delivered too — the buyer has the
      // work, and clawing the hold back over a tidy-up error would be giving
      // away what was already handed over.
      if (writer.closed) this.holdDelivered(taskId);
      else this.releaseHold(taskId, FundsReleaseReason.TASK_FAILED);
      if (!writer.closed) {
        const meshErr =
          err instanceof MeshError
            ? err
            : new MeshError(
                ErrorCode.INTERNAL_ERROR,
                err instanceof Error ? err.message : "Stream handler error",
                { cause: err instanceof Error ? err : undefined },
              );

        // Publish error chunk on stream subject
        const errChunkEnv = this.newEnvelope({
          type: "respond",
          from: this.agentId,
          to: env.from,
          in_reply_to: env.id,
          task_id: taskId,
          trace: childSpan(env.trace),
          error: meshErr.toErrorObject(),
          payload: { status: "failed", chunk_index: 0, final: true, data: null },
        });
        this.conn.publish(Subjects.taskStream(taskId), encode(errChunkEnv));

        // Publish task failure update
        const failEnv = this.newEnvelope({
          type: "respond",
          from: this.agentId,
          to: env.from,
          task_id: taskId,
          trace: childSpan(env.trace),
          payload: { status: "failed", ...this.trialMark(taskId) },
        });
        this.conn.publish(Subjects.taskUpdate(taskId), encode(failEnv));
      }
    }
  }
}
