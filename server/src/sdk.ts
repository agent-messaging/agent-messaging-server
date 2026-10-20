// SDK re-export barrel — single import point for all SDK types and utilities.
// Services import from here instead of deep relative paths into ../sdk/src/.

// Types
export type {
  Envelope,
  TraceContext,
  ErrorObject,
  Artifact,
  PrimitiveType,
} from "../../sdk-typescript/src/types/envelope.js";
export { PROTOCOL_VERSION } from "../../sdk-typescript/src/types/envelope.js";

// What a statement rested on (SPEC.md §5.6). Re-exported rather than
// re-implemented: the platform validates the same shape the SDKs emit, and a
// second copy of the rules is a second thing to drift.
export { DIGEST_RE, MAX_RESTS_ON, checkFreshness, validateRestsOn } from "../../sdk-typescript/src/rests-on.js";
export type { Freshness, FreshnessResult, RestsOnEntry } from "../../sdk-typescript/src/rests-on.js";

// How a receiver reads `meta.audience` (SPEC.md §5.7). The activity tap applies
// rule 1 (a message marked for a person answers no wait) the way the SDK does.
export { audienceOf } from "../../sdk-typescript/src/audience.js";

export type {
  Manifest,
  Offering,
  OfferingReporting,
  AgentDataUse,
  AgentComplianceEntry,
  PublicBlock,
  PublicOffering,
  PublicAccess,
  PublicAccessScheme,
  AdmissionPolicy,
  Availability,
  NodeRef,
  AgentAttestation,
  NodeProfile,
  NodeDeclaredProfile,
  TrustTier,
  NodeRole,
  IdentitySource,
  IdentitySourceKind,
  TrustAttestation,
  AvailabilityClass,
  Reachability,
} from "../../sdk-typescript/src/types/manifest.js";

export type { Task, TaskState, TaskOrigin, TaskCanceledBy } from "../../sdk-typescript/src/types/task.js";
export {
  isValidTransition,
  TERMINAL_STATES,
  VALID_TRANSITIONS,
} from "../../sdk-typescript/src/types/task.js";

export type {
  DiscoverQuery,
  DiscoverResult,
  RegisterPayload,
  RequestPayload,
  RespondPayload,
  EmitPayload,
  StreamChunkPayload,
} from "../../sdk-typescript/src/types/primitives.js";

export { ErrorCode } from "../../sdk-typescript/src/types/errors.js";

// The largest file that rides inside a message (§7.5, §18.9). One number for
// the SDK that sends, the store that answers and the doors that serve a file
// to a browser, so the three cannot disagree about what "large" means.
export { ARTIFACT_INLINE_MAX } from "../../sdk-typescript/src/artifacts.js";

// Internal utilities
export { createEnvelope } from "../../sdk-typescript/src/internal/envelope-builder.js";
export { encode, decode } from "../../sdk-typescript/src/internal/codec.js";
export {
  verifyAttestation,
  attestationExpired,
  createAttestation,
  createAgentIdentity,
  keyPairFromSeed,
  signEnvelope,
  verifyEnvelopeSig,
  // The bytes a PAN card signature covers (SPEC-NAMING §5.3) — the storefront
  // verifies cards before republishing them to the open web.
  canonicalJSON,
  // Tagged canonical-JSON signatures: the admission roster's domain tag and
  // the shared dual-accept verifier (tagged first, legacy untagged fallback
  // through the 0.2 draft window). One canonicalization and one verify path
  // in the system — services must not carry private copies.
  ADMISSION_ROSTER_SIG_PREFIX,
  signTagged,
  verifyTagged,
  // base64url — the SDK-object signature encoding (EXT-8 allowance `sig`).
  toB64Url,
  fromB64Url,
  // The portable trust attestation (§9.7): the key chain signs an agent's
  // identity source as one.
  createTrustAttestation,
  verifyTrustAttestation,
} from "../../sdk-typescript/src/internal/identity.js";
// nats's nkeys with native Ed25519 (sdk-typescript/src/internal/fast-nkeys.ts):
// tweetnacl cost 23 ms a verify on the platform VM, node:crypto 0.25 ms.
import { nkeys as natsNkeys } from "nats";
import { accelerate as accelerateNkeys } from "../../sdk-typescript/src/internal/fast-nkeys.js";
export const nkeys: typeof natsNkeys = accelerateNkeys(natsNkeys);
// §4.4/§9.2 vouch renewal arithmetic — the SDK's one reading of "when is a
// vouch due for renewal" (issued + 2/3 of its own window). Services that
// EXPOSE renewal state must derive it from this, never from a private copy,
// or the deadline the owner sees drifts from the one the agent acts on.
export { vouchRenewAt } from "../../sdk-typescript/src/internal/vouch.js";
// EXT-8 allowance document machinery (one reading in the system — the SDK's):
// the tagged prefix, shape validation, signature verification, and the
// shape-then-signature loader that callers fail closed on.
export {
  ALLOWANCE_SIG_PREFIX,
  validateAllowance,
  verifyAllowanceSignature,
  loadAllowance,
  signAllowance,
} from "../../sdk-typescript/src/allowance.js";
export type {
  AllowanceDocument,
  AllowanceCeiling,
  AllowanceCostModel,
  AllowanceScope,
  AllowanceOnExhausted,
} from "../../sdk-typescript/src/allowance.js";
// §19.5 agreement machinery, same one-reading rule as the allowance above:
// the tagged prefix, shape validation, signature verification, the loader
// callers fail closed on, and the matching rule enforcement shares.
export {
  AGREEMENT_SIG_PREFIX,
  validateAgreement,
  verifyAgreementSignature,
  loadAgreement,
  signAgreement,
  agreementCovers,
} from "../../sdk-typescript/src/agreement.js";
export type { AgreementDocument, AgreementEvidence } from "../../sdk-typescript/src/agreement.js";
// §19.1 SKU machinery: the digest an agreement binds to, and the
// most-specific-wins cover rule enforcement and pricing reads share.
export { skuDigest, skuFor, validateSkus, publicSkuOf } from "../../sdk-typescript/src/sku.js";
export type { Sku, SkuPrice, PublicSku } from "../../sdk-typescript/src/sku.js";
// §3.3.1 five-questions machinery: the projection from declared bytes to the
// five answers, and the consistency diff (ask, then diff). Re-exported rather
// than re-implemented — the projection/diff shapes are pinned by
// conformance/five-questions.json and shared with the Rust SDK, so a services
// copy would be a second reading waiting to drift. The interview harness
// (src/interview/) orchestrates these; it does not re-derive them.
export {
  FIVE_QUESTIONS,
  REFUSAL_STATEMENT,
  projectFiveQuestions,
  diffAnswers,
  describeDocumentOf,
} from "../../sdk-typescript/src/interview.js";
export type { FiveAnswers, AnswerMismatch, Question } from "../../sdk-typescript/src/interview.js";
export { Subjects } from "../../sdk-typescript/src/internal/subjects.js";
export { verifyDescriptor, normalizePlaybook, descriptorFromToken } from "../../sdk-typescript/src/rooms.js";
export type { RoomPlaybook, RoomPhase } from "../../sdk-typescript/src/rooms.js";
export type { RoomDescriptor } from "../../sdk-typescript/src/rooms.js";
export { childSpan, newTraceContext } from "../../sdk-typescript/src/internal/trace.js";
export { uuid7 } from "../../sdk-typescript/src/internal/uuid.js";
// Agent SoW §5.5 pricing arrangements: the price clause, the rate schedule
// and its `per` divisor, the mandatory cap and reservation, the §5.5.7 rule
// that nothing settles under a no-charge engagement, and the rating that
// turns RAW meter counts into a settlement record. One reading, shared with
// both SDKs and pinned by conformance/sow-pricing.json — the services copy of
// this arithmetic drifted the moment the spec moved, which is the argument
// for not having a second one.
export {
  // The signing constant, the canonical bytes, and the verifier. Services
  // carried its own copy of all three; a duplicated signing prefix is the
  // most dangerous duplicate there is, because a drift in it does not fail
  // loudly, it silently stops verifying documents somebody already signed.
  SOW_SIG_PREFIX,
  canonicalSowJSON,
  sowSignedBytes,
  verifySowSignature,
  sowAgreed,
  // Construction. §5.5.3's cap and §5.5.4's reservation are required
  // parameters of timeAndMaterialsPrice rather than options with defaults, so
  // a clause missing either is a compile error here and a refusal at runtime.
  fixedFeePrice,
  timeAndMaterialsPrice,
  // §5.5.7. `noChargePrice` takes a grade and nothing else, so a free
  // offering's clause cannot pick up a currency or a rate of zero on the way
  // out; `settles` and `admitSettlement` are the two halves of "nothing
  // settles" — the predicate the money paths ask before they start, and the
  // refusal a client node owes a settlement record citing one.
  noChargePrice,
  settles,
  admitSettlement,
  isNoCharge as isNoChargePrice,
  // §7.1's state vocabulary, including `exhausted`.
  SOW_END_STATES,
  admitsWork,
  isScoredOutcome,
  // §6.1 approval authority and its stated defaults.
  APPROVAL_AUTHORITIES,
  DEFAULT_FORMATION_AUTHORITY,
  DEFAULT_AMENDMENT_AUTHORITY,
  // §12.1.1, the directed standing proposal. One reading of who may form and
  // of when the offer ends, shared with the Rust SDK and pinned by
  // conformance/sow-pricing.json — the refusal wording is part of it, because
  // a counterparty that acted on a document it was handed is owed the same
  // reason whichever runtime turns it away.
  validateSowOfferedTo,
  isDirectedProposal,
  directedOfferRefusal,
  // §12.1, the conditions a counterparty must meet before its countersign is
  // accepted. The kind vocabulary is CLOSED and the grade a kind may claim is
  // the SDK's, not a seller's: a condition nothing can verify tops out at
  // `evidence` however the document is written, which is §12.1 rule 4 and §3
  // rule 1 held in one place rather than re-argued per surface. The refusal
  // wording travels with them for the same reason the directed one does.
  SOW_QUALIFICATION_KINDS,
  CHECKABLE_QUALIFICATION_KINDS,
  qualificationGradeCeiling,
  qualificationRefusal,
  qualificationsOf,
  requiredAssertions,
  validateSowQualification,
  validateSowQualifications,
  // §5.11, confidentiality and retention. The canonical split clause validated
  // sub-clause by sub-clause (transport and retention runtime-checkable and
  // 'enforced'; the inside-its-own-walls promises 'recorded', never presented
  // as more), and the deterministic pre-admission comparison a client runs
  // against advertised terms — shared with the Rust SDK and pinned by
  // conformance/sow-data-use.json, sentences included, because a provider
  // marked not-meeting is owed the same words whichever runtime did the
  // comparing. Processor acceptability is not compared in v1.
  SOW_CONFIDENTIALITY_PROMISES,
  confidentialityOf,
  confidentialityShortfall,
  validateSowConfidentiality,
  // §5.10, disputes, and the arbiter's verdict (agentroles.ai/arbiter.html §4).
  // The clause validation and the verdict machinery — the exact-sum split, the
  // clause-side expectation check, and signature verification under the
  // agent-arbiter-verdict-v1 tag — shared with the Rust SDK and pinned by
  // conformance/sow-disputes.json. This is the MACHINERY half only: the
  // clearing half (opening a dispute, freezing the disputed amount, moving
  // money on a verified verdict per §5.10.2) is tracker #149, and until it
  // lands a verified verdict here is evidence, not settlement.
  ARBITER_VERDICT_SIG_PREFIX,
  ROLE_ARBITER,
  SOW_ARBITER_FEES,
  SOW_DISPUTES_POSTURES,
  arbiterVerdictSignedBytes,
  disputesOf,
  validateArbiterVerdict,
  validateSowDisputes,
  verifyArbiterVerdictSignature,
  // §5.12, reporting. The ordinal levels and the meets-or-exceeds test, shared
  // with the Rust SDK and pinned by conformance/sow-reporting.json — including
  // the exact shortfall sentence an advisory mandate shows, because a
  // responder marked non-conforming is owed the same words whichever runtime
  // did the comparing. The cadence-vs-cap warning is here too: a MAY, never a
  // refusal, computed exactly so two runtimes cannot disagree at the boundary.
  SOW_REPORTING_LEVELS,
  SOW_REPORTING_GRADE,
  DEFAULT_REPORTING_LEVEL,
  reportingLevelRank,
  meetsReportingLevel,
  reportingEveryMs,
  reportingOf,
  reportingShortfall,
  reportingCadenceWarning,
  validateSowReporting,
  // §5.13 liability and §5.14 service floors, shared with the Rust SDK and
  // pinned by conformance/sow-terms.json. Liability is the clause courts
  // enforce — graded 'recorded', and nothing on the platform refuses or
  // gates on it. Service floors are what the engagement ledger measures a
  // task's request-to-terminal span against: a miss is a recorded obligation
  // failure, never a money movement, and the breach rule is what a for-cause
  // termination citing floor misses is verified against.
  SOW_FLOOR_REMEDIES,
  liabilityOf,
  serviceFloorsOf,
  validateSowLiability,
  validateSowServiceFloors,
  // §5.15, subcontracting. The clause validation, the absence-states-nothing
  // accessor, and the flow-down comparator — terms only narrow going down —
  // shared with the Rust SDK and pinned by conformance/sow-subcontracting.json,
  // sentences included, because a provider whose subcontract does not narrow
  // is owed the same words whichever runtime computed the chain. Consumed by
  // the formation advisory in api-service: when a forming engagement's client
  // agent is the provider of an engagement whose clause names the new
  // provider, the platform holds both documents and runs the comparison.
  SOW_SUBCONTRACTING_POSTURES,
  subcontractConformance,
  subcontractingOf,
  validateSowSubcontracting,
  divisorOf,
  rateLine,
  rateUsage as rateSowUsage,
  validateSowPrice,
  loadSowPrice,
  validateSettlementLine,
  validateScheduleAgainstMeters,
  reservationReleaseAt,
  reservationWithinTerm,
  passThroughLines,
  committedPrice,
  isTimeAndMaterials as isTimeAndMaterialsPrice,
  isFixedFee,
  PRICING_ARRANGEMENTS,
  // §5.5.8. The platform IS the operator on the resale path: it builds the
  // quote and it settles the charge, so the markup that used to be a bare
  // `rate + ceil(rate * pct / 100)` in two files is now one disclosed line
  // built by one implementation. `checkOperatorFee` is the arithmetic a reader
  // runs, `checkSettlement` is the client node's three checks against the
  // quote it holds, and there is deliberately no repair function to import.
  OPERATOR_FEE_BASIS_GRADE,
  checkOperatorFee,
  checkSettlement,
  maxRatedTotalUnderCap,
  operatorFee,
  operatorFeeAmount,
  operatorFeeGrade,
  providerNet,
  quoteWithOperatorFee,
  refuseFurtherWorkUnderOperator,
  settlementTotal,
  settlementWithOperatorFee,
  validateOperatorFee,
} from "../../sdk-typescript/src/sow.js";
export type {
  SowDocumentState,
  SowSignature,
  SowGrade,
  SowOfferedTo,
  SowQualification,
  SowQualificationFacts,
  SowQualificationKind,
  ApprovalAuthority as SowApprovalAuthority,
  PricingArrangement,
  SowPrice,
  SowFixedFeePrice,
  SowTimeAndMaterialsPrice,
  SowNoChargePrice,
  SowScheduleLine,
  SowCap,
  SowReservation,
  SowMeteredCount,
  SowSettlementLine,
  SowRating,
  SowDisputeReason,
  SowDisputedSettlement,
  SowDisputes,
  SowDisputesPosture,
  SowArbiterBinding,
  SowArbiterFee,
  SowArbiterVerdict,
  SowArbiterVerdictSignature,
  ArbiterVerdictExpectation,
  SowOperatorFee,
  SowOperatorFeeBasis,
  SowQuote,
  SowSettlementRecord,
  SowSettlementVerdict,
  SowReporting,
  SowReportingLevel,
  SowLiability,
  SowServiceFloor,
  SowServiceFloors,
  SowServiceFloorsBreach,
  SowConfidentiality,
  SowConfidentialityPromise,
  SowConfidentialityPromises,
  SowConfidentialityRequirement,
  SowProcessor,
  SowSubcontracting,
  SowSubcontractingPosture,
  SowSubcontractorEntry,
} from "../../sdk-typescript/src/sow.js";

// Trials (Common Agent §7.7). Re-exported, not re-implemented: the registry
// refuses the same declarations the nodes refuse, and the platform's trial
// doors admit in the same order with the same refusal.
export {
  validateTrial,
  validateDescriptorTrials,
  trialOf,
  quoteFromPrice,
  moneyWords,
  nextUtcMidnight,
  trialDayOf,
  inputOverLimit,
  workCaps,
  trialRefusal,
  trialAdmission,
  TRIAL_REASONS,
} from "../../sdk-typescript/src/trial.js";
export type {
  TrialDeclaration,
  TrialRequester,
  TrialCounts,
  TrialQuote,
  TrialRefusal,
  TrialRefusalDetails,
  TrialFunds,
  TrialAdmission,
  TrialShape,
  TrialReason,
} from "../../sdk-typescript/src/trial.js";

// Admission by source (EXT-6 0.5.0): the same roster rule the SDK's gate applies,
// so the admission service and an agent's own door never disagree.
export { rosterStance, sourceStance, tierStance, parseRosterSource } from "../../sdk-typescript/src/admission.js";
export type { SenderFacts } from "../../sdk-typescript/src/admission.js";
