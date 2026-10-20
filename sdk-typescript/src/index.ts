// Main class
export {
  AgentMesh,
  type RequestResult,
  type StreamResult,
  type StreamChunk,
  type EventHandler,
  // Durable event subscriptions (SPEC §18.6 Event Consumer): subscribe() with
  // { durable } binds a JetStream consumer on MESH_EVENTS that survives the
  // process; stop() never deletes it, so the cursor resumes on the next bind.
  type SubscribeOptions,
  type DurableEventSubscription,
  type TaskUpdate,
  type TaskUpdateHandler,
  // Presence (§9.6): trackPresence subscribes to transitions BEFORE reading
  // the snapshot, which §9.6 makes a MUST for anyone tracking liveness.
  type PresenceTransition,
  type PresenceWatch,
  // Feeds (§6.6a): the owner-rooted event channel. trackFeed subscribes to
  // changes BEFORE reading the current-value snapshot (§9.6 order, applied to
  // feeds by §18.3).
  type FeedKind,
  type FeedWatch,
  // Durable feed subscriptions (SPEC §18.6 Feed Consumer): subscribeFeed()
  // with { durable } adds the feed to the agent's one consumer on MESH_FEED,
  // so what was published while it was offline arrives when it returns.
  type DurableFeedSubscription,
} from "./mesh.js";

// Sender pre-flight (§6.4b): the sender-side mirror of the §22 receiver
// obligations, run by request()/requestStream() before publishing and refused
// locally with the recipient's own codes. Exported so hosts that publish
// through their own transport can run the identical decisions
// (conformance/sender-preflight.json pins them).
export {
  effectiveInboundCap,
  preflightSenderText,
  preflightEnvelopeSize,
  preflightContentType,
} from "./preflight.js";

// The naming rule: an agent whose handle is not in the global standard (its
// name, a dot, its owner's email) sends nothing. ConnectOptions.requireNamed
// is on by default for AgentMesh.connect() (false opts out, for tests only);
// these are the pieces, for a host with its own transport
// (conformance/naming-gate.json pins the words, the shape and the proposals).
export {
  NAMING_STANDARD_WORDS,
  NAMED_TTL_MS,
  UNNAMED_TTL_MS,
  isStandardHandle,
  proposeHandle,
  notNamedError,
  registrarNameLookup,
  namingGateFor,
  NamingGate,
} from "./naming-gate.js";
export type { NameCheck, NameLookup, NamingStatus, NamingGateOptions, ProposedHandle, RequireNamedOptions } from "./naming-gate.js";

// Budget (§7.7): validation, the deadline predicates, and the typed
// admission/ceiling refusals a responder throws from its handlers. The
// lifecycle — attaching (RequestConfig.budget), revising (reviseBudget),
// reading (currentBudget), receiving (onTaskUpdate, ctx.budget) — is on
// AgentMesh.
export {
  validateBudget,
  pastDeadline,
  budgetRemainingMs,
  budgetInsufficient,
  deadlineUnmeetable,
  BudgetExhaustedError,
  type BudgetRevision,
} from "./budget.js";

// Owner allowance (EXT-8, mesh://extensions/allowance/v1): the signed,
// node-held spending policy an owner sets on their OWN agent — the owner-side
// complement to the §7.7 budget. Document handling (tagged signing under
// agentmesh-allowance-v1, fail-closed verification), the fixture-pinned floor
// metering, and smallest-remaining ceiling precedence live here; the
// lifecycle — arming (setAllowance), the automatic admission refusal, usage
// reporting (ctx.reportUsage / reportUsage), the queryable ledger
// (allowanceLedger), the ask-owner hold — is on AgentMesh.
export {
  ALLOWANCE_SIG_PREFIX,
  validateAllowance,
  verifyAllowanceSignature,
  canonicalAllowanceJSON,
  signAllowance,
  loadAllowance,
  meterAllowanceCost,
  allowanceDayOf,
  AllowanceEngine,
  type AllowanceDocument,
  type AllowanceCeiling,
  type AllowanceCostModel,
  type AllowanceScope,
  type AllowanceOnExhausted,
  type AllowanceUsage,
  type AllowanceLedgerEntry,
  type AllowanceLedgerView,
  type AllowanceBinding,
  type AllowanceDecision,
  type AllowanceStatus,
  type AllowanceQuestion,
  type AllowanceAskOwnerHandler,
  type AllowanceEstimator,
} from "./allowance.js";

// Cancel (§10.8): reason validation and the task.cancel input shape. The
// lifecycle — canceling (cancel), receiving (the inbox honours task.cancel),
// propagating (automatic, per-handler opt-out via HandlerOptions) — is on
// AgentMesh; the reason enum itself is with the task types below.
export {
  validateCancelReason,
  validateStopFields,
  parseCancelInput,
  type CancelInput,
  type StopFields,
  type StopQualifier,
} from "./cancel.js";

// Rooms (mesh://extensions/rooms/v1): shared conversations for N agents.
// All three grades, plus the durable record and the artifact drive.
export {
  Room,
  RoomsServiceSubjects,
  BoardSubjects,
  // The domain tag inside a descriptor's signed bytes (EXT-5 §2).
  ROOM_DESCRIPTOR_SIG_PREFIX,
  // The three verdicts a note on a file may carry (EXT-5 §8.4).
  ROOM_NOTE_VERDICTS,
  signDescriptor,
  verifyDescriptor,
  descriptorToToken,
  descriptorFromToken,
  type RoomDescriptor,
  type RoomPlaybook,
  // Where a room IS, as opposed to what it planned (EXT-5 §8.5).
  type RoomPhase,
  normalizePlaybook,
  type RoomMessage,
  type RoomExpelSeverity,
  type RoomMessageHandler,
  type OpenRoomOptions,
  type JoinRoomOptions,
  type RecordEntry,
  type RoomNote,
  type RoomNoteVerdict,
  type RoomNoteSource,
  type MyRoom,
  type BoardItem,
  type BoardItemClaim,
  type BoardList,
  type AttachResult,
  type FetchedArtifact,
  type SealedKey,
  type AclTransport,
} from "./rooms.js";

// Sealed-grade crypto (rooms §7.3): the agent X25519 encryption identity and
// the room-key primitives. Exposed so hosts (adapters, gateways) can mint and
// persist encryption identities and open sealed invites.
export {
  createEncryptionIdentity,
  encryptionPublicFromSeed,
  roomKeyFingerprint,
  sealKeyTo,
  openSealedKey,
  // Pairwise sealing (e2e-encryption/v1): seal a request/response payload to
  // one agent's declared encryption key; open with the recipient seed.
  sealPayloadTo,
  isSealedPayload,
  openSealedPayload,
  // Bind the requester's asked-for `reply_key` to the key its manifest
  // actually declares before sealing an answer to it (§6.11).
  resolveReplyKey,
  type SealedPayload,
} from "./internal/sealed.js";

// §8.9 `sealing`: the rule that decides whether an agent asks to be sealed to.
// Exported because the registry applies the identical rule to a stored manifest
// when deciding whether a declared posture is honest, and a second copy of a
// security default is a second copy that drifts.
export {
  derivedSealing,
  declaresCredentialNeed,
  type SealingChoice,
  type SealingInputs,
} from "./internal/sealing-posture.js";

// Messages for the person behind an agent (SPEC.md §5.7, an optional extension
// an agent declares): how the mark reads, the manifest declaration, the frame's
// audience line, the sender's pre-flight, and the shape the person surface
// receives. AgentMesh applies them on its receive paths.
export {
  AUDIENCE_EXTENSION_URI,
  AUDIENCE_DECLARATION,
  AUDIENCE_FRAME_LINE,
  readAudience,
  audienceOf,
  frameForPerson,
  declaresAudience,
  audiencePreflight,
  personTextOf,
} from "./audience.js";
export type {
  AudienceReading,
  AudienceReceiver,
  PersonMessage,
  PersonMessageHandler,
  AgentMayRead,
} from "./audience.js";

// Provenance framing + fencing for untrusted sender text (safety register 2.2,
// 2.3). Applied BY DEFAULT on the inbound dispatch path — `onRequest`,
// `onStreamRequest` and `subscribe` handlers receive framed text unless the
// agent was constructed with `fenceInbound: false`. Exported so a host can also
// frame text that arrives some other way (a sealed payload it just opened, a
// room message, an HTTP bridge), and so the frame's exact shape is testable
// across implementations.
export {
  fenceSenderText,
  frameMessage,
  fenceInboundInput,
  senderTextOf,
  inboundTextLength,
  BEGIN_SENDER_MESSAGE,
  END_SENDER_MESSAGE,
  type FrameProvenance,
  type SenderText,
  type SenderTextField,
} from "./internal/fence.js";

// Node host (§2, §4): one connection + credential, N hosted agents
export {
  MeshNode,
  type NodeConnectOptions,
  type AddAgentOptions,
} from "./node.js";

// Envelope types
export type {
  Envelope,
  PrimitiveType,
  TraceContext,
  ErrorObject,
  Budget,
  CostCeiling,
  Artifact,
  ArtifactPart,
  TextPart,
  DataPart,
  RefPart,
  ResourceEntry,
} from "./types/envelope.js";
export { PROTOCOL_VERSION } from "./types/envelope.js";

// Manifest types
export type {
  Manifest,
  AgentEndpoints,
  AgentLimits,
  Offering,
  NeedEntry,
  Delivers,
  OfferingReporting,
  AgentDataUse,
  AgentComplianceEntry,
  // §8.12, the card-level declarations: who the agent is for, where its
  // answers hold, what it does outside that, whose interest it acts in, what
  // it can do, who else stands behind it, and where it came from. Declared on
  // RegisterOptions and merged by the storefront adopter, so the types have to
  // be reachable by anyone writing either.
  ListingDeclarations,
  AgentAudience,
  AgentCoverage,
  EdgeBehaviour,
  AgentActs,
  AgentAction,
  ServesParty,
  AgentParty,
  AgentOrigin,
  WorksWith,
  SealingPosture,
  Skill,
  SkillExample,
  PublicSkill,
  Provider,
  Cost,
  RateLimits,
  Trust,
  NodeRef,
  AgentAttestation,
  Extension,
  PublicBlock,
  PublicLink,
  PublicOffering,
  PublicAccess,
  PublicAccessScheme,
  AdmissionPolicy,
  TrustAttestation,
  IdentitySource,
  IdentitySourceKind,
  Availability,
  OfferingExample,
  NodeProfile,
  NodeDeclaredProfile,
  TrustTier,
  NodeRole,
  AvailabilityClass,
  Reachability,
  DevicePlatform,
  DeviceClass,
} from "./types/manifest.js";

// The first connection, tried again while the broker is busy (ConnectOptions.connectRetry).
export { dialWithRetry, isCredentialRefusal, type ConnectRetry } from "./internal/connect-retry.js";

// EXT-1 device-profile detection (mesh://extensions/device-profile/v1)
export { detectDeviceProfile, withDetectedDevice, SDK_CLIENT } from "./internal/device-profile.js";

// Task types
export type { Task, TaskState, CancelReason, TaskOrigin, TaskCanceledBy, TaskContests } from "./types/task.js";
export {
  isValidTransition,
  TERMINAL_STATES,
  VALID_TRANSITIONS,
  CANCEL_REASONS,
  isCancelReason,
  propagatedCancelNote,
  NEED_KINDS,
  isUnmetNeedRef,
  parseUnmetNeedRef,
  needRefOf,
  taskOriginOf,
  taskCanceledByOf,
  taskContestsOf,
} from "./types/task.js";

// Primitive payload types
export type {
  RegisterPayload,
  DiscoverQuery,
  DiscoverResult,
  RequestPayload,
  RespondPayload,
  RespondStatus,
  QueuedAck,
  EmitPayload,
  StreamChunkPayload,
} from "./types/primitives.js";

// The §13.5 usage receipt (declared meters): validation for host-side report
// tooling, the observed-name collision set, and the entry shape. Reporting
// itself is on AgentMesh (`reportMeterUsage`) and the handler ctx
// (`ctx.reportMeter`).
export { OBSERVED_METERS, validateMeterReport } from "./internal/meter-usage.js";
export type { UsageEntry } from "./internal/meter-usage.js";

// SKUs and prices (§19.1): declared commercial terms, their digest (the
// identity an agreement binds to), and the most-specific-wins cover rule.
export {
  SKU_DIGEST_PREFIX,
  publicSkuOf,
  skuDigest,
  skuFor,
  validateSku,
  validateSkuPrice,
  validateSkus,
} from "./sku.js";
export type { PublicSku, Sku, SkuCovers, SkuIncluded, SkuPeriod, SkuPrice, SkuProvider, SkuTier } from "./sku.js";
export {
  INPUT_PROBLEM_CODES,
  InputProblemsError,
  checkInputProblem,
  inputProblemsOf,
} from "./problems.js";
export type { InputProblem, InputProblemCode } from "./problems.js";
// Input an agent cannot use (§12.2 INPUT_NOT_UNDERSTOOD, Common Agent §4.7.1):
// the fit check, the standard reply, the card answer and the converter checks.
export {
  INPUT_NOT_UNDERSTOOD,
  CONVERT_OFFERING,
  ADAPT_OFFERING,
  DEFAULT_CONVERTER,
  CONVERTER_TIMEOUT_MS,
  MIN_CONFIDENCE,
  LONG_JOB_SECONDS,
  CONFIRM_WINDOW_MS,
  offeringsFromDescriptor,
  offeringsFromManifest,
  declaresStructuredInputs,
  isScripted,
  isHelpQuestion,
  isRunnerLine,
  isYes,
  isNo,
  statedFields,
  inputPresent,
  pickOffering,
  missingFor,
  fitCheck,
  kindWords,
  exampleFor,
  inputNotUnderstood,
  cardText,
  conversionRequest,
  checkConversion,
  applyConversion,
  needsConfirmation,
  readAsLine,
} from "./input-fit.js";
export type {
  DeclaredInput,
  DeclaredOffering,
  FileRef,
  FitResult,
  MissReason,
  StandardReply,
  ConvertedField,
  CheckedConversion,
} from "./input-fit.js";

// Trials (Common Agent §7.7): the declaration, the admission order and its
// refusal, the counts a node keeps, and the request's trial context. The node
// applies them (mesh.ts setTrials, request options trial and trial_requester).
export {
  TRIAL_WHO,
  TRIAL_REASONS,
  TRIAL_LIMIT_KEYS,
  ADMISSION_LIMIT_KEYS,
  validateTrial,
  validateDescriptorTrials,
  trialOf,
  isTrialRequest,
  quoteFromPrice,
  moneyWords,
  nextUtcMidnight,
  trialDayOf,
  inputOverLimit,
  workCaps,
  trialRefusalWords,
  trialRefusal,
  trialRefused,
  trialAdmission,
  MemoryTrialLedger,
  isTrustedHost,
  trialRequesterOf,
  trialLedgerKey,
  trialInputsOf,
  descriptorOffering,
} from "./trial.js";
export type {
  TrialWho,
  TrialReason,
  TrialShape,
  TrialLimits,
  TrialDeclaration,
  TrialInputLimit,
  TrialInputLimitValue,
  TrialRequester,
  TrialCounts,
  TrialQuote,
  TrialRefusal,
  TrialRefusalDetails,
  TrialFunds,
  TrialAdmission,
  TrialLedger,
  TrialContext,
  TrialNodeOptions,
} from "./trial.js";
export { preflightTrial } from "./preflight.js";
export type { TrialRequesterVouch } from "./types/primitives.js";

// What a statement rested on (§5.6). The verdict is the reason this exists:
// a good signature over a statement whose inputs have moved is not the same
// fact as a good signature over one whose inputs are unchanged, and until now
// there was no way to tell them apart.
export {
  DIGEST_RE,
  MAX_RESTS_ON,
  checkFreshness,
  describeFreshness,
  validateRestsOn,
} from "./rests-on.js";
export type { Freshness, FreshnessResult, Observe, RestsOnEntry } from "./rests-on.js";

// The five questions (§3.3.1): project a describe document (§10.14) to the
// five answers, and diff what an agent said elsewhere against what it
// declared — the consistency rule as a library. Pure functions; describe
// itself is served by the platform, never from here. Projection and diff are
// pinned by conformance/five-questions.json, byte-identical with the Rust SDK.
export {
  FIVE_QUESTIONS,
  REFUSAL_STATEMENT,
  describeDocumentOf,
  diffAnswers,
  interview,
  projectFiveQuestions,
} from "./interview.js";
export type { AnswerMismatch, DescribeSource, FiveAnswers, Question } from "./interview.js";

// Artifacts (§7.5): the mesh-wide store for deliverables too big, or too
// binary, to travel inline. The agent methods (`putArtifact`, `fetchArtifact`)
// are the usual door; these are here for callers holding only a transport.
export {
  ArtifactSubjects,
  ARTIFACT_INLINE_MAX,
  putArtifact,
  fetchArtifact,
  statArtifact,
  removeArtifact,
  artifactUsage,
  artifactLink,
} from "./artifacts.js";
export type {
  ArtifactHost,
  ArtifactContent,
  ArtifactLink,
  ArtifactLinkOptions,
  ArtifactUsage,
  PutArtifactOptions,
  StoredArtifact,
} from "./artifacts.js";

// Agreements (§19.5): the consumer-signed acceptance of a seller's terms —
// document handling (tagged agentmesh-agreement-v1 signing, fail-closed
// verification), the matching rule, and the typed admission refusal. The
// lifecycle — arming (setAgreements), the platform lookup hook
// (onAgreementLookup), the automatic admission check — is on AgentMesh.
export {
  AGREEMENT_SIG_PREFIX,
  agreementCovers,
  agreementRequired,
  canonicalAgreementJSON,
  loadAgreement,
  signAgreement,
  validateAgreement,
  verifyAgreementSignature,
} from "./agreement.js";
export type { AgreementDocument, AgreementEvidence, AgreementRequiredDetails } from "./agreement.js";

// The funds hold (§19.5, the funds-hold contract): the balance half of the
// paid-work gate — the seller names the job, the platform names the amount.
// Shapes, the typed refusal, the fail-closed reader for the platform's answer
// and the release reasons. The lifecycle — placing the hold at admission, the
// injectable seams (onFundsHold / onFundsRelease), the per-task memory and the
// release at every terminal point that is not a delivery — is on AgentMesh.
export {
  FundsReleaseReason,
  insufficientFunds,
  loadFundsHoldResult,
} from "./funds.js";
export type {
  FundsHoldRequest,
  FundsHoldResult,
  FundsReleaseReasonValue,
  InsufficientFundsDetails,
} from "./funds.js";

// Job manifests (job-manifest-v1): the delivering agent's signed record of a
// completion's pieces — tagged agentmesh-job-manifest-v1 signing, verification
// with a typed reason (which refuses any other format before reading a byte
// of signature), the shape check, and the reuse computation between a prior
// manifest and its revision. Byte-identical to the Rust SDK's;
// conformance/job-manifest.json pins that.
export {
  JOB_MANIFEST_FORMAT,
  JOB_MANIFEST_SIG_PREFIX,
  canonicalJobManifestJSON,
  jobManifestReuse,
  jobManifestReuseClaimHolds,
  signJobManifest,
  validateJobManifest,
  verifyJobManifest,
} from "./job-manifest.js";
export type {
  JobManifest,
  JobManifestFault,
  JobManifestPiece,
  JobManifestReason,
  JobManifestReused,
  JobManifestVerdict,
  UnsignedJobManifest,
} from "./job-manifest.js";

// The three job doors (§5.7), from the asking side: the signed manifest of one
// task, what redoing named steps of it would cost now, and what the answering
// node wrote down about it while it happened (the door a customer diagnoses an
// agent through when the agent runs on somebody else's compute and there is no
// shell to open). Each door answers an unentitled asker and an unknown task
// with ONE sentence, so a stranger holding a task id learns nothing; these
// clients hand that sentence back as a refusal with `unknownOrNotYours` set
// rather than turning it into a thrown "not found". A transport failure still
// throws. The Rust SDK has the same three, with the same shapes.
export {
  DEFAULT_JOB_DOOR_TIMEOUT_MS,
  JOB_MANIFEST_DOOR,
  JOB_QUOTE_DOOR,
  JOB_QUOTE_FORMAT,
  JOB_RECORD_DOOR,
  JOB_RECORD_FORMAT,
  MANIFEST_UNREADABLE_REASON,
  NO_JOB_MANIFEST_REASON,
  NO_JOB_REASON,
  NO_REVISIONS_REASON,
  askJobManifest,
  askJobQuote,
  askJobRecord,
  parseJobManifestAnswer,
  parseJobQuoteAnswer,
  parseJobRecordAnswer,
} from "./job-doors.js";
export type {
  JobDoorOptions,
  JobDoorRefusal,
  JobDoorSource,
  JobManifestAnswer,
  JobQuote,
  JobQuoteAnswer,
  JobQuoteAsk,
  JobQuotePrice,
  JobQuoteStep,
  JobRecord,
  JobRecordAnswer,
  JobRecordCollected,
  JobRecordFolder,
  JobRecordHarness,
  JobRecordManifest,
  JobRecordPieceOutcome,
  JobRecordPiecesJson,
  JobRecordRefusal,
  JobRecordReply,
} from "./job-doors.js";

// Agent SoW pricing arrangements (https://agentsow.com §5.5): the fixed-fee,
// time-and-materials and no-charge clauses, the mandatory not-to-exceed cap and
// its reservation window, rating that stops at the cap, pass-through lines
// billed at cost against an upstream receipt, the §5.5.8 operator fee disclosed
// in the quote and again in the settlement record, the §5.5.7 rule that nothing
// settles under a no-charge engagement, the §7.1 document states including
// `exhausted`, and the §6.2 organizational-authority fields. Canonicalization
// and signing use the agent-sow-v1 domain tag and are byte-identical to the
// Rust SDK's — `conformance/sow-pricing.json` pins that.
export {
  APPROVAL_AUTHORITIES,
  ARBITER_VERDICT_SIG_PREFIX,
  CHECKABLE_QUALIFICATION_KINDS,
  DEFAULT_AMENDMENT_AUTHORITY,
  DEFAULT_FORMATION_AUTHORITY,
  DEFAULT_REPORTING_LEVEL,
  OPERATOR_FEE_BASIS_GRADE,
  PRICING_ARRANGEMENTS,
  ROLE_ARBITER,
  SOW_ARBITER_FEES,
  SOW_CONFIDENTIALITY_PROMISES,
  SOW_DISPUTES_POSTURES,
  SOW_END_STATES,
  SOW_QUALIFICATION_KINDS,
  SOW_FLOOR_REMEDIES,
  SOW_REPORTING_GRADE,
  SOW_REPORTING_LEVELS,
  SOW_SIG_PREFIX,
  SOW_SUBCONTRACTING_POSTURES,
  admitSettlement,
  admitsWork,
  arbiterVerdictSignedBytes,
  canonicalSowJSON,
  checkOperatorFee,
  checkSettlement,
  committedPrice,
  confidentialityOf,
  confidentialityShortfall,
  directedOfferRefusal,
  disputesOf,
  divisorOf,
  fixedFeePrice,
  isDirectedProposal,
  isFixedFee,
  isNoCharge,
  isScoredOutcome,
  isTimeAndMaterials,
  liabilityOf,
  loadSowPrice,
  mandateVerified,
  maxRatedTotalUnderCap,
  meetsReportingLevel,
  noChargePrice,
  operatorFee,
  operatorFeeAmount,
  operatorFeeGrade,
  passThroughLines,
  providerNet,
  qualificationGradeCeiling,
  qualificationRefusal,
  qualificationsOf,
  quoteWithOperatorFee,
  rateLine,
  rateUsage,
  refuseFurtherWorkUnderOperator,
  reportingCadenceWarning,
  reportingEveryMs,
  reportingLevelRank,
  reportingOf,
  reportingShortfall,
  requiredAssertions,
  reservationReleaseAt,
  reservationWithinTerm,
  serviceFloorsOf,
  settlementTotal,
  settlementWithOperatorFee,
  settles,
  signArbiterVerdict,
  signSow,
  sowAgreed,
  sowSignedBytes,
  subcontractConformance,
  subcontractingOf,
  timeAndMaterialsPrice,
  validateArbiterVerdict,
  validateOperatorFee,
  validateScheduleAgainstMeters,
  validateSettlementLine,
  validateSowApproval,
  validateSowConfidentiality,
  validateSowDisputes,
  validateSowLiability,
  validateSowOfferedTo,
  validateSowParty,
  validateSowPrice,
  validateSowQualification,
  validateSowQualifications,
  validateSowReporting,
  validateSowServiceFloors,
  validateSowSubcontracting,
  verifyArbiterVerdictSignature,
  verifySowSignature,
} from "./sow.js";
export type {
  ApprovalAuthority,
  ArbiterVerdictExpectation,
  PricingArrangement,
  SowApprovalAct,
  SowApprovalRecord,
  SowArbiterBinding,
  SowArbiterExclusion,
  SowArbiterFee,
  SowArbiterVerdict,
  SowArbiterVerdictSignature,
  SowCap,
  SowCeiling,
  SowConfidentiality,
  SowConfidentialityPromise,
  SowConfidentialityPromises,
  SowConfidentialityRequirement,
  SowDisputeReason,
  SowDisputedSettlement,
  SowDisputes,
  SowDisputesPosture,
  SowDocumentState,
  SowFixedFeePrice,
  SowFixedFeeRate,
  SowGrade,
  SowLiability,
  SowMeteredCount,
  SowNoChargePrice,
  SowOfferedTo,
  SowOperatorFee,
  SowOperatorFeeBasis,
  SowParty,
  SowPeriod,
  SowPrice,
  SowProcessor,
  SowQualification,
  SowQualificationFacts,
  SowQualificationKind,
  SowQuote,
  SowRating,
  SowReporting,
  SowReportingLevel,
  SowReservation,
  SowScheduleLine,
  SowServiceFloor,
  SowServiceFloors,
  SowServiceFloorsBreach,
  SowSettlementLine,
  SowSettlementRecord,
  SowSettlementVerdict,
  SowSignature,
  SowSubcontracting,
  SowSubcontractingPosture,
  SowSubcontractorEntry,
  SowTimeAndMaterialsPrice,
} from "./sow.js";

// Options
export type {
  ConnectOptions,
  RegisterOptions,
  RequestConfig,
  StreamConfig,
  SecurityWarning,
} from "./types/options.js";

// Errors
export { MeshError, RejectedError, ErrorCode, RETRYABLE_CODES } from "./types/errors.js";

// Offering handler types
export type {
  OfferingHandler,
  StreamOfferingHandler,
  StreamWriter,
  RequestContext,
  HandlerOptions,
} from "./internal/offering-router.js";

// Constants
export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_TIME_WAIT_MS,
  DEFAULT_STREAM_TIMEOUT_MS,
  DEFAULT_CHUNK_TIMEOUT_MS,
  // Node vouch lifetime (§4.4) and the fraction of it at which the SDK renews.
  DEFAULT_VOUCH_TTL_MS,
  VOUCH_RENEWAL_FRACTION,
  // The inbound sender-text cap (safety register 2.9). Matches mesh-adapter's
  // MAX_INBOUND_CHARS; override per agent with `maxInboundChars`.
  DEFAULT_MAX_INBOUND_CHARS,
  // How often an agent asks whether its owner edited its listing, and the
  // floor under a configured interval.
  DEFAULT_STOREFRONT_POLL_MS,
  MIN_STOREFRONT_POLL_MS,
  STOREFRONT_REQUEST_TIMEOUT_MS,
} from "./constants.js";

// Auth utilities
export {
  jwtAuthenticator,
  nkeyAuthenticator,
  credsAuthenticator,
  nkeys,
} from "nats.ws";
export type { Authenticator, Subscription } from "nats.ws";

// Identity / signing (§4–5). Public so agents can sign/verify out of band and
// so the envelope contract is testable across implementations.
export {
  canonicalJSON,
  // The domain tag inside the envelope's signed bytes (§5.3): sig covers
  // ENVELOPE_SIG_PREFIX + the canonical envelope JSON.
  ENVELOPE_SIG_PREFIX,
  // Sibling domain tags for the other canonical-JSON signatures, plus the
  // shared tagged-sign/verify machinery they ride on. Hosts that mint vouches
  // or admission rosters out of band sign with signTagged and the matching
  // prefix; verifiers use verifyTagged, which accepts the tagged form only
  // (the 0.2 draft window's untagged fallback closed at protocol 0.3).
  VOUCH_SIG_PREFIX,
  ADMISSION_ROSTER_SIG_PREFIX,
  signTagged,
  verifyTagged,
  signEnvelope,
  verifyEnvelopeSig,
  createAgentIdentity,
  keyPairFromSeed,
  createAttestation,
  verifyAttestation,
  createTrustAttestation,
  verifyTrustAttestation,
  // Manifest signing (§8.3): register() signs, and anyone consuming a
  // manifest's `encryption_key` verifies before sealing anything to it.
  signManifest,
  verifyManifestSignature,
} from "./internal/identity.js";
export { createEnvelope } from "./internal/envelope-builder.js";
// Faster ed25519 signing and verifying for a server's nkeys (the services wrap
// the `nats` package's nkeys with it), exported so a server or platform that
// imports this package by its name gets the same speed-up.
export { accelerate as accelerateNkeys } from "./internal/fast-nkeys.js";
// The wire primitives a server or platform builds on, which it used to reach
// by a path into this package: the envelope codec (decode verifies the
// signature), the subject names (§14), UUIDv7 ids, base64url, the key pair
// type, and when a vouch is due for renewal.
export { encode, decode } from "./internal/codec.js";
export { Subjects } from "./internal/subjects.js";
export { uuid7 } from "./internal/uuid.js";
export { toB64Url, fromB64Url } from "./internal/identity.js";
export type { KeyPair } from "./internal/identity.js";
export { vouchRenewAt } from "./internal/vouch.js";

// One agent, many places (§4.11): the delegation a place acts under, the
// approval a committing act needs, a place's signed request to the key
// holder, and the checks a receiver of a direct delegated envelope runs.
export {
  DELEGATION_SIG_PREFIX,
  APPROVAL_SIG_PREFIX,
  PLACE_REQUEST_SIG_PREFIX,
  DELEGATION_SCOPES,
  COMMITTING_ACTS,
  READ_ACTS,
  isCommittingAct,
  scopeCovers,
  signDelegation,
  verifyDelegation,
  signApproval,
  verifyApproval,
  signPlaceRequest,
  verifyPlaceRequest,
  actDigest,
  verifyDelegatedEnvelope,
  signDelegatedEnvelope,
  viaOf,
} from "./delegation.js";
export type {
  Delegation,
  DelegationPlace,
  DelegationScope,
  DelegationRefusal,
  Approval,
  ApprovalAct,
  PlaceKind,
  PlaceRequest,
  Via,
} from "./delegation.js";

// Tracing (§13.1): W3C Trace Context helpers for bridging to HTTP-instrumented
// systems, and the ambient store used for automatic propagation.
export { newTraceContext, childSpan, toTraceparent, fromTraceparent } from "./internal/trace.js";
// §13.1.1. Exported so anyone can write a collector against the same shapes
// the SDK emits, rather than reverse-engineering them from a payload.
export { traceSubject, spanData, spanPayload, outcomeOf } from "./internal/spans.js";
export type { SpanData, SpanInput, SpanKind, SpanOutcome } from "./internal/spans.js";
export { otlpTraces } from "./internal/otlp.js";
export { otlpTracesProto } from "./internal/otlp-proto.js";
export type { OtlpOptions } from "./internal/otlp.js";
export { runWithTrace, currentTrace } from "./internal/trace-ambient.js";

export { exchangeBootstrapToken } from "./bootstrap.js";
// Enrolling with an identity the company already gave the agent (§4.14).
export {
  exchangeOutsideProof,
  createDpopProof,
  generateDpopKey,
  ProofRefusedError,
} from "./outside-proof.js";
export type { OutsideProof, OutsideProofSource, OutsideProofResult } from "./outside-proof.js";
// Acting for a person (§4.16): evidence in meta.on_behalf_of, checked by the receiver.
export { verifyOnBehalfOf, onBehalfOfOf } from "./on-behalf-of.js";
export type { OnBehalfOf, OnBehalfOfKind, OnBehalfOfResult, VerifyOnBehalfOfOptions } from "./on-behalf-of.js";
export type { BootstrapResult } from "./bootstrap.js";
export { bindingOfUrl, connectTransport, transportFromMesh } from "./transport.js";
export type { Binding, MeshObject } from "./transport.js";

// Storefront proposals (§8.7, §8.12): the owner edits the listing in the
// console, which cannot sign this agent's manifest, so the edit waits as a
// proposal until the agent fetches it, merges it, re-registers under its own
// key and acknowledges. Arm it with `RegisterOptions.storefrontProposals`; the
// pieces are exported for hosts that drive the door themselves and so the merge
// rules — which must agree with mesh-adapter's, or the console is telling half
// the fleet something untrue — are testable without an HTTP server.
export {
  STOREFRONT_PROPOSAL_V1,
  StorefrontAdopter,
  ackStorefrontProposal,
  buildStorefrontProposalRequest,
  fetchStorefrontProposal,
  mergeStorefrontProposal,
  storefrontProposalCanonical,
  storefrontProposalEndpoint,
} from "./storefront.js";
export type {
  StorefrontAdopterOptions,
  StorefrontAdoption,
  StorefrontBlocks,
  StorefrontPassResult,
  StorefrontProposal,
} from "./storefront.js";

// Node-credential lifecycle (§4.8). A node credential is a lease on the same
// two-thirds renewal schedule as the vouch it sits under; renewal is a plain
// HTTPS call authorized by proof-of-possession, so it works with no live
// connection and works on a credential that has already lapsed.
export {
  decodeCredentialClaims,
  credentialRenewAt,
  credentialCheckIntervalMs,
  buildCredentialRequest,
  renewNodeCredential,
  CredentialRenewer,
  // The kill switch: a refusal carries the mesh's code (agent_paused,
  // agent_terminated) so a host waits instead of retrying.
  CredentialRefusedError,
  // The per-request deadline. `sdk-rust`'s built-in transport uses the same
  // number; retry is the renewal loop's job in both, never the call's.
  CREDENTIAL_REQUEST_TIMEOUT_MS,
} from "./credential.js";
export type {
  CredentialClaims,
  CredentialStatus,
  CredentialRenewerOptions,
  RenewalAgent,
  RenewalRoster,
  RenewedCredential,
} from "./credential.js";

export { startNaming, verifyNaming, completeNaming } from "./naming.js";
export type { NamingSession } from "./naming.js";

// Diagnostics (AGENTMESH_DIAGNOSTICS.md): reusable probes for the mesh —
// resolution, echo/brain ping with latency decomposition, room mechanics,
// durable-room usage. The library IS the contract; the adapter's /diag/*
// session API and diag CLI are thin frontends over it.
export {
  Diagnostics,
  DIAG_ECHO_OFFERING,
  DIAG_TRACE_OFFERING,
  type DiagnosticsOptions,
  type DiagStep,
  type PingResult,
  type PingTiming,
  type ResolveResult,
  type RoomCheckResult,
  type RoomsStatusResult,
  type TraceEntry,
  type TraceResult,
} from "./diagnostics.js";

// Platform services (platform-services/*.json, docs/platform-services-plan.md):
// one definition per service, every door generated from it. mesh.rooms is
// here today; the types are what each request sends and answers.
export * from "./services.generated.js";
export { RoomsDoor, ROOM_FILE_MAX_BYTES, ROOM_POST_MAX_CHARS } from "./rooms-door.js";
export { BoardDoor } from "./board-door.js";
export {
  MessagesDoor, ContactsDoor, OwnerDoor, IdentityDoor, NamesDoor, FeedsDoor, RegistryDoor, MESH_TEXT_MAX, type MeshDoorContext,
  type MessagesInboxRequests, type MessagesInboxResult, type MessagesReplyInput, type MessagesReplyResult, type MessagesReplyRefusal,
  type MessagesDismissInput, type MessagesDismissResult, type MessagesDismissRefusal,
  type ContactsAdmissionRequests, type ContactsWaitingResult, type ContactsAdmitInput, type ContactsAdmitResult, type ContactsAdmitRefusal,
  type ContactsBlockInput, type ContactsBlockResult, type ContactsBlockRefusal,
} from "./mesh-door.js";
// Admission on the agent's own side (EXT-6 §7): the signed roster, the
// waiting list and the inbox (mesh.admission, mesh.contacts, mesh.messages).
export {
  AdmissionGate, signAdmissionRoster, verifyAdmissionRoster, fileAdmissionStore, readKnockInput, KNOCK_GRANT_NAMES,
  rosterStance, sourceStance, tierStance, parseRosterSource, type SenderFacts,
  type AdmissionControl, type AdmissionOptions, type AdmissionRoster, type AdmissionRosterEntry, type AdmissionStance,
  type AdmissionState, type AdmissionStore, type WaitingSender, type InboxMessage, type HeldMessage, type DescribeDocument,
} from "./admission.js";
// Where the SDK finds a server's HTTPS doors and naming service by itself.
export { addressesFromBroker } from "./am-env.generated.js";
export { platformCaller, type PlatformCallerOptions } from "./service-caller.js";
// What a mesh offers (GET /v1/capabilities) and the "not available on this
// mesh" check every platform request makes against it.
export { capabilitiesReader, meshOffers, notAvailableRefusal, CAPABILITIES_TTL_MS, type MeshCapabilities } from "./capabilities.js";
// PACT 1.0 (BRIDGE-A2A.md 14): the JOSE pieces, the rules, the personal-agent
// client, and the helpers for an agent that serves a business. One namespace,
// so none of its names meets one already exported here.
export * as pact from "./pact/index.js";
