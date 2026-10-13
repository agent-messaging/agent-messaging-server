import type { TrialDeclaration } from "../trial.js";

/** Presence status (§9.6). NOT part of the manifest in 0.2 — lives in the
 *  separate presence service. Kept here as the shared status vocabulary. */
export type Availability = "online" | "busy" | "degraded" | "offline";

/** A node's signed attestation that it hosts an agent (§4.4). Included in the
 *  manifest so the registry can verify the node→agent binding at register. */
export interface AgentAttestation {
  node: string;
  agent: string;
  issued_at: string;
  expires_at: string;
  sig: string;
}

/**
 * A portable trust attestation (§9.7): an operator's signed statement about a
 * subject (a node or agent) — its trust tier and role. Unlike the node vouch,
 * this is meant to travel: any party, on any mesh, verifies it against the
 * issuing operator's key WITHOUT consulting the issuing mesh (the DKIM pattern
 * — signature portable, trust decision local). This is the object federation
 * needs so reputation survives crossing a boundary (§21).
 */
export interface TrustAttestation {
  /**
   * What this signed object IS, inside the signed bytes. Every other signature
   * in the system is domain-separated (`pan-pair-v1`, `pan-rehome-v1`,
   * `pan-checkin-v3`); a bare object signature is the one shape that could be
   * replayed as a different kind of claim if the field sets ever converge, and
   * without it there is no way to version the format later without breaking
   * every signature already issued.
   */
  type: "agentmesh-trust-attestation-v1";
  /** The operator key that signed this claim. */
  issuer: string;
  /** The node (or agent) key the claim is about. */
  subject: string;
  claims: { trust_tier?: TrustTier; role?: NodeRole };
  issued_at: string;
  expires_at: string;
  sig: string;
}

/** The hosting-node reference carried in an agent's manifest (§8.1). */
export interface NodeRef {
  id: string;
  attestation: AgentAttestation;
  /** The node's self-declared profile (§9.7), carried with the vouch at register.
   *  Declared attributes only — attested attributes (`trust_tier`, `role`) are
   *  set by the operator and are deliberately not expressible here. */
  profile?: NodeDeclaredProfile;
}

export interface Provider {
  name: string;
  url?: string;
}

export interface OfferingExample {
  input: unknown;
  output: unknown;
}

/**
 * One entry of an offering's `needs` (§8.5.1): what must be in hand before
 * work can start, the way a contractor would say it. Exactly one of the five
 * keys — a shared resource (§7.5.5), material to attach (§7.5.3), a tool or
 * MCP server the caller must connect, a sign-in to a third-party service, or
 * prose. Deliberately loose: the reader at discovery time is usually a model
 * deciding whom to hire, so this must read well to a model, not validate well
 * in a parser.
 */
export interface NeedEntry {
  /** A shared-resource kind (`git`, …) the caller must provide (§7.5.5). */
  resource?: string;
  /** With `resource`: what the offering intends to do with it. */
  access?: "read" | "read-write";
  /** A MIME type the caller should attach (§7.5.3). */
  file?: string;
  /**
   * A tool or MCP server the CALLER must connect and authorize before this
   * offering can do anything.
   *
   * Distinct from `resource`, which is a thing the caller hands over, and from
   * `credential`, which is a sign-in the agent will ask for. This one is
   * capability the agent does not have until you wire it up, and its count is
   * what tells a buyer whether hiring this agent is a call or a project. The
   * tool's NAME as a person would say it ("your ticket system", "GitHub MCP"),
   * never an endpoint.
   */
  tool?: string;
  /** With `tool`: how it connects, when that is worth saying. `mcp` is the
   *  expected spelling for an MCP server; anything else is free text. */
  protocol?: string;
  /**
   * A named third-party service the agent will ask the caller to sign in to —
   * a product the caller licenses, a government or bank site they have an
   * account on. The service's NAME ("Colorado DMV", "Salesforce"), not a URL.
   *
   * The kind that has to be declared. To the person being asked, a third party
   * requesting a government or bank sign-in is indistinguishable from a
   * phishing attempt, so saying it up front is the only way the honest case can
   * look honest. Nothing here transports the credential itself: a caller who
   * agrees sends it sealed (§4.3) or through the service's own authorization
   * flow. Renderers should give this entry more room than the other kinds.
   */
  credential?: string;
  /** With `credential`: what the sign-in will be used for. The narrowest true
   *  answer, in plain language. */
  scope?: string;
  /** Anything that fits neither, in plain language. */
  text?: string;
  description?: string;
}

/**
 * One external service an agent says it integrates with (§8.8).
 *
 * A claim about an INTEGRATION and never about affiliation or endorsement.
 * "Works with the Colorado DMV" is the true thing a third-party wrapper needs
 * to be able to say; presenting AS the Colorado DMV is impersonation, and this
 * field makes it no less so. The field exists precisely so the honest statement
 * does not have to be made by borrowing somebody's identity.
 *
 * Nothing verifies any of it — `domain` is a string the registrant typed, not a
 * proven binding — so a consumer MUST NOT render an entry as verified or as
 * endorsement, and MUST NOT read an absent entry as "no such integration".
 */
export interface WorksWith {
  /** The external service's name. */
  service: string;
  /** That service's domain, so a reader knows which "Acme" is meant. Not
   *  checked by anybody. */
  domain?: string;
  /** What the integration does, in plain language. */
  description?: string;
}

import type { SowConfidentialityPromises, SowProcessor, SowReportingLevel } from "../sow.js";

/**
 * The card-level data-use declaration (§8.10): what happens to content a
 * buyer hands this agent — training, retention, human access, and the
 * services content passes through. The pre-admission shadow of the Agent SoW
 * confidentiality clause (§5.11): the clause's shape minus grades (everything
 * here is self-declared) and minus transport, which is §8.9's own field.
 *
 * SELF-DECLARED, and MUST be shown as such: nothing in the protocol verifies
 * what an operator's pipeline does with bytes, so no consumer may render any
 * of this as verified or enforced.
 *
 * ABSENT means the agent has not said, with NO default in either direction:
 * reading silence as "trains on everything" slanders the honest agent, and
 * reading it as "keeps nothing" grants a promise nobody made. A requirement
 * stated against `data_use` treats absence as not meeting it — fail closed.
 *
 * `promises` carries only the promises made, each spelled the literal `true`:
 * false is spelled by omission, because a promise left out is a promise not
 * made, and a reader MUST NOT infer one. `no_third_party_sharing` quantifies
 * over everything EXCEPT the declared processors. An EMPTY `processors` list
 * is itself a statement — content leaves the operator for nowhere — while an
 * omitted one states nothing.
 *
 * ONE declaration per agent, at card level, deliberately: the pipeline that
 * determines all of this is the operator's, shared by every offering, and a
 * per-offering split posture is a gaming surface. The registry validates on
 * the way in; a declaration whose shape cannot be read is dropped WHOLE at
 * registration rather than served in part, because a partially readable
 * privacy claim misleads more than none at all (§8.10).
 */
export interface AgentDataUse {
  /** The promises made, each spelled `true`; a promise left out is not made. */
  promises?: SowConfidentialityPromises;
  /** The retention ceiling the operator is prepared to bind, in whole days. */
  retention?: { max_days: number };
  /** The services content passes through so the work can happen, in §5.11's
   *  entry shape. Empty means "nowhere"; omitted states nothing. */
  processors?: SowProcessor[];
  /** The jurisdictions content may touch (§8.10) — where it is processed and
   *  stored — as lowercase ISO 3166-1 alpha-2 country codes. A SET
   *  declaration, not an ordinal: a buyer's requirement is an allowed list
   *  and the test is subset — every declared jurisdiction must be on the
   *  buyer's list. Declare only what the pipeline contractually commits to (a
   *  pinned region resolves to its country); an operator that cannot
   *  truthfully pin a jurisdiction declares nothing, and because the test is
   *  subset, an ABSENT `processed_in` fails any jurisdiction requirement —
   *  the correct fate for "we don't know where it runs" when the buyer
   *  asked. */
  processed_in?: string[];
}

/**
 * One compliance posture the operator claims (§8.11): the answer to "are you
 * SOC 2, do you operate under GDPR, can you touch PHI", advertised where a
 * buyer in a regulated industry can read it before anything forms.
 *
 * SELF-DECLARED, INCLUDING the attestation pointer. Nothing in the protocol
 * fetches the URL, verifies the auditor, or checks the expiry against
 * anything but the calendar: a consumer MUST present these as the operator's
 * own claims, and the attestation as a pointer the reader follows — never as
 * verification the platform performed.
 *
 * ABSENT means the operator has not said, and a stated requirement treats
 * silence as not meeting it. The `standard` vocabulary is OPEN (`soc2`,
 * `iso27001`, `gdpr`, `hipaa`, `pci-dss` are the expected spellings of the
 * usual suspects; standards proliferate) and comparison is exact token
 * equality, so the open vocabulary costs no determinism. Like `data_use`, an
 * unreadable `compliance` member is dropped WHOLE at registration rather
 * than served in part (§8.11).
 */
export interface AgentComplianceEntry {
  /** The claimed standard, as a lowercase token. Compared by exact equality. */
  standard: string;
  /** What the claim covers, in words. */
  scope?: string;
  /** Who said so — the operator's own pointer, never platform verification:
   *  an auditor's name, a URL a reader can follow, an expiry after which the
   *  claim is stale on its face. */
  attestation?: {
    by?: string;
    url?: string;
    expires_at?: string;
  };
}

/**
 * Who the agent was built to serve (§8.12).
 *
 * Two fields, not one, and the second is the one nobody thinks to declare. A
 * gradebook agent is `for` teachers and touches nobody else; a tutoring agent
 * is bought by a school, directed by a teacher, and TOUCHES a child. The same
 * split runs through clinician and patient, recruiter and applicant, advisor
 * and retail investor, and in every pair the second population is the one with
 * obligations attached to it and the one that is never the buyer.
 *
 * Deliberately free text rather than a vocabulary: the audiences worth naming
 * are open-ended, the reader is usually a model, and a closed enum here would
 * be wrong within a month. Card-level for the same reason `data_use` is
 * (§8.10) — an agent that served two different audiences from two offerings
 * would be two products.
 *
 * `touches` accepts the literal `none`, which is a real and common answer and
 * is NOT the same as saying nothing. Absent means the operator has not said.
 */
export interface AgentAudience {
  /** Who hires and directs it: "teachers", "accountants", "support leads". */
  for?: string;
  /** Who is on the receiving end without being the buyer, or `none`. */
  touches?: string;
}

/**
 * Where the agent's answers are valid (§8.12).
 *
 * Every agent has a boundary of competence and almost no listing states it. A
 * property valuation agent holding data for one postcode will answer about any
 * postcode, and the narrowness is not the danger: narrowness plus a confident
 * answer outside it is.
 *
 * NOT to be confused with `data_use.processed_in` (§8.10), which says where
 * content is handled. That is a privacy fact about bytes; this is a competence
 * fact about answers, and the two will be conflated by somebody reading a
 * listing unless a renderer keeps them apart.
 *
 * Self-declared. Absent means the operator has not said, which is not a claim
 * of universal coverage.
 */
export interface AgentCoverage {
  /** Places its answers hold, as the operator would name them. */
  geography?: string[];
  /** Legal jurisdictions its answers are correct under. */
  jurisdiction?: string[];
  /** Languages it works in, as BCP 47 tags where possible. */
  language?: string[];
  /** Anything the three above cannot carry, in plain language. */
  note?: string;
}

/**
 * What the agent does when asked outside its declared coverage (§8.12).
 *
 * - `declines`: it refuses rather than answering.
 * - `answers`: it will answer anyway, and the caller owns the consequences.
 *
 * ABSENT is the third state and means the operator has not said. A consumer
 * MUST NOT read silence as `declines`: that would turn missing information
 * into a safety promise nobody made. This is the one field on a narrow agent
 * that a buyer most needs, and it is checkable — one request inside the
 * declared coverage and one outside answers it.
 */
export type EdgeBehaviour = "declines" | "answers";

/**
 * Whose interest the agent acts in (§8.12).
 *
 * - `hirer`: the party that engaged it.
 * - `owner`: whoever operates it. A supplier's quoting agent answers your
 *   questions accurately and still optimises for its owner's margin.
 * - `neutral`: neither side, which is what an arbiter, auditor or escrow
 *   agent is for.
 *
 * In a list of results these look identical, and the distinction is not
 * derivable from anything else on the card. Absent means unstated; a careful
 * consumer should not assume `hirer`.
 */
export type ServesParty = "hirer" | "owner" | "neutral";

/**
 * One company standing behind this agent, besides whoever published it (§8.12).
 *
 * A single provider field is a fiction for most enterprise agents. An agent
 * built on a vendor's platform, configured by an agency, and run inside a
 * customer has three companies attached to three different scopes, and the
 * reader's real question is not "who made this" but "who do I call when it
 * misbehaves". One name cannot answer that.
 *
 * The PUBLISHER is not in this list. Exactly one party stands behind a
 * listing and it is named elsewhere; this carries the others, which is what
 * keeps accountability singular while letting the picture be honest.
 *
 * Naming a company here is a statement about this agent's construction, NOT a
 * claim of partnership, sponsorship or endorsement, and nothing verifies it —
 * the same rule `works_with` (§8.8) carries, for the same reason.
 */
export interface AgentParty {
  /** The company's name. */
  name: string;
  /**
   * What they did, from a closed set:
   * - `platform`: their product is what this agent is built on.
   * - `implementer`: they configured or customised it for the operator.
   * - `operator`: they run it day to day.
   * - `data_source`: the agent's answers rest on data they supply.
   */
  role: "platform" | "implementer" | "operator" | "data_source";
  /** Their domain, so a reader knows which "Acme" is meant. Checked by nobody. */
  url?: string;
  /** What they are on the hook for, in plain language. */
  note?: string;
}

/**
 * One thing the agent does that changes something (§8.12).
 *
 * `approval` is the member that matters. An agent that can close a ticket and
 * an agent that can close a ticket only after somebody says yes are different
 * purchases, and today a listing has no way to tell them apart.
 */
export interface AgentAction {
  /** What it does, as a person would say it: "closes tickets", "sends mail as
   *  you", "opens a pull request". */
  action: string;
  /** True when this action waits for a human or a policy check before it
   *  happens. ABSENT means the operator has not said, NOT that it proceeds
   *  unattended — the safe reading of silence here is the pessimistic one, and
   *  a consumer must not render absence as "approved automatically". */
  approval?: boolean;
  description?: string;
}

/**
 * What the agent does with what it can reach (§8.12).
 *
 * NOT the Agent Mandate, and the difference is who writes the document and
 * when. A mandate (agentmandate.net) is signed by the BUYER's organization at
 * hire time and names the powers, ceiling and expiry of one deployment. This
 * is written by the PUBLISHER before any buyer exists, and says what the agent
 * will do if you let it. A listing cannot point at a mandate, because at
 * listing time there is no mandate to point at.
 *
 * So the two never restate each other and must not be merged: this one informs
 * the decision to hire, the mandate is what constrains the thing once hired.
 * Declaring an action here grants nothing.
 *
 * "Connects to your ticket system" without saying whether it can close tickets
 * has told a reader almost nothing, which is why `mode` alone is not enough
 * and `act` should always be accompanied by named actions.
 */
export interface AgentActs {
  /** `read` changes nothing. `act` changes something. */
  mode: "read" | "act";
  /** With `act`: every action named individually. A declaration of `act` with
   *  no actions named is legal and deliberately unsatisfying — it says the
   *  agent does something without saying what. */
  actions?: AgentAction[];
}

/**
 * Where the agent came from (§8.12): four questions with small closed
 * vocabularies, from which the archetype labels people recognise ("marketplace
 * agent", "studio agent") are DERIVED.
 *
 * Stored as coordinates rather than as a label on purpose. Archetype names are
 * pinned to vendor product tiers that get renamed on somebody else's release
 * schedule, and a label stored as truth goes stale in the database while the
 * facts underneath it stay correct.
 */
export interface AgentOrigin {
  /** Whether the behaviour was written as code, configured on the buyer's side
   *  (by the buyer or an agency or integrator acting for them), or shipped
   *  prebuilt by a vendor. */
  written_by?: "developer" | "buyer_or_implementer" | "vendor";
  /** Whose infrastructure it executes on. */
  run_by?: "builder" | "vendor_platform" | "managed_runtime" | "not_running";
  /** Who is permitted to call it. NOT the same question as who it is for. */
  open_to?: "builder" | "team" | "company" | "anyone";
  /** How a buyer obtains it. */
  acquired_by?: "clone" | "subscription" | "channel" | "call";
}

/**
 * The §8.12 card-level declarations, as one named set.
 *
 * These seven sit BESIDE the storefront rather than inside it, and that is
 * deliberate rather than an accident of where they happened to be written: the
 * pipeline and the audience they describe belong to the agent, not to one
 * advertised offering, and a per-offering split posture is a gaming surface.
 * The registry validates each member on the way in and drops an unreadable one
 * whole, so a partial declaration is never served.
 *
 * Grouped here because two places need the same set: what an agent registers
 * ({@link RegisterOptions}) and what an owner's console edit proposes
 * (`storefront.ts`). An absent member means the operator has not said, which
 * every reader is required to treat as its own answer rather than as a default.
 */
export interface ListingDeclarations {
  audience?: AgentAudience;
  coverage?: AgentCoverage;
  edge?: EdgeBehaviour;
  acts?: AgentActs;
  serves?: ServesParty;
  parties?: AgentParty[];
  origin?: AgentOrigin;
}

/**
 * The offered reporting level (§8.5.2): the reporting level this offering's
 * provider offers to bind in an engagement formed over it, in the Agent SoW
 * §5.12 vocabulary — `records_only`, `on_change` or `check_ins`, ordinal,
 * compared as meets-or-exceeds.
 *
 * An ADVERTISEMENT, not a clause: what binds is the reporting clause inside
 * the signed engagement document. This exists so a buyer can compare providers
 * before anything forms, and so a stated requirement can be tested against it
 * as an integer without either party reading the other's prose.
 *
 * Self-declared, and MUST be shown as such: nothing in the protocol verifies
 * it, and a consumer that renders it must present it as the provider's own
 * claim, never as an observed record.
 *
 * `every` takes §5.12's restricted duration grammar (`P1W`, `P3D`, `PT12H`).
 * It MUST accompany `check_ins` — a calendar level advertised without a
 * calendar advertises nothing testable — and MUST NOT appear below it. The
 * registry validates on the way in: an unknown level or a malformed cadence
 * means the whole `reporting` field is dropped at registration rather than
 * served (§8.5.2), because a declaration that cannot be read declares nothing.
 */
export interface OfferingReporting {
  level: SowReportingLevel;
  /** The offered cadence — required with `check_ins`, refused below it. */
  every?: string;
}

/** What the caller gets (§8.5.1). */
export interface Delivers {
  /** Prose or a MIME type: the form of the finished deliverable. */
  final?: string;
  /** Whether checkpoint deliverables arrive as task updates along the way. */
  interim?: boolean;
  /** Whether the deliverable lands in a caller-provided resource (§7.5.5) —
   *  a pushed branch, an opened PR — rather than travelling back through the
   *  mesh. */
  in_resource?: boolean;
}

export interface Offering {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  input_modes?: string[];
  output_modes?: string[];
  examples?: OfferingExample[];
  streaming?: boolean;
  estimated_duration_ms?: number;
  /** The engagement contract (§8.5.1): what to have in hand before engaging. */
  needs?: NeedEntry[];
  /** The engagement contract (§8.5.1): what the caller gets, and how. */
  delivers?: Delivers;
  /** The offered reporting level (§8.5.2): self-declared, an advertisement
   *  and never a clause. See {@link OfferingReporting}. */
  reporting?: OfferingReporting;
  /** Trial work this offering offers (Common Agent 7.7): who may ask, what
   *  changes, and how many. Absent means no trial. */
  trial?: TrialDeclaration;
}

/** @deprecated Renamed (§8.5) — use {@link Offering}. */
export type Skill = Offering;
/** @deprecated Renamed (§8.5) — use {@link OfferingExample}. */
export type SkillExample = OfferingExample;

export interface Cost {
  per_request?: number;
  per_token?: number;
  currency: string;
  billing_model?: string;
}

export interface RateLimits {
  requests_per_second?: number;
  requests_per_minute?: number;
  concurrent_tasks?: number;
}

/** The agent's endpoint subjects, verbatim (§8.1, §14.4): what a caller
 *  addresses INSTEAD of constructing `mesh.agent.{id}.inbox` from the naming
 *  convention. At minimum `inbox`. OPTIONAL on registration — the registry
 *  stamps it from `endpoint` when absent, so a stored manifest never lacks it —
 *  and the SDK populates it at register time anyway. Resolved values win over
 *  construction wherever a manifest is at hand (§14.4). */
export interface AgentEndpoints {
  inbox?: string;
  [name: string]: string | undefined;
}

/** Declared per-message inbound limits senders pre-flight against (§6.4b,
 *  §8.1). `max_inbound_chars` overrides the §22.5 default (65,536 UTF-16 code
 *  units) for this agent; absent means the protocol default applies. `0` means
 *  the agent declared the cap off (§22.5 allows it as an explicit choice). */
export interface AgentLimits {
  max_inbound_chars?: number;
}

/** The manifest's trust block (§8.3). `signature` is NOT a signature over the
 *  manifest — it is the agent's signed claim binding its `id` to the
 *  `encryption_key` it published, at `issued_at`. That narrow binding is the one
 *  thing a reader must be able to authenticate before sealing anything to the
 *  key; the registry rewrites `owner`/`visibility`/`sandbox` server-side, so a
 *  whole-manifest signature could never verify for the party reading it back. */
export interface Trust {
  tenant?: string;
  /** When the key claim was made (RFC 3339). Inside the signed bytes, so a
   *  verifier can rebuild them. */
  issued_at?: string;
  /** base64url Ed25519 signature over the §8.3 key claim. */
  signature?: string;
}

/**
 * What an agent says about sealing its inbound requests (§8.9).
 *
 * `encryption_key` says the agent CAN be sealed to. This says whether a caller
 * should, and what happens to a request that arrived in the clear.
 *
 * - `required`: the agent will not read an unsealed request; it refuses with
 *   `SEALING_REQUIRED`.
 * - `preferred`: seal when you can; the agent reads both.
 *
 * ABSENT is the third state and the important one: it means the agent has not
 * said, it is what every manifest written before this field existed says, and
 * it must keep meaning cleartext. Nothing infers a posture from a published
 * `encryption_key` — an agent may hold one only for sealed rooms, with a
 * request handler that has never seen a `SealedPayload` in its life.
 */
export type SealingPosture = "required" | "preferred";

export interface Extension {
  uri: string;
  description?: string;
  required?: boolean;
  version?: string;
}

import type { PublicSku, Sku } from "../sku.js";

/** A link to a related agent, by handle — the mesh's hyperlink (§8.7). */
export interface PublicLink {
  handle: string;
  rel?: string;
}

/**
 * An advertised offering's interface, as a stranger sees it (§8.7).
 *
 * NOT written by the operator. The registry materializes these at register time
 * from the manifest's own `offerings`, selected by the IDs in `public.offerings`. That
 * matters: the alternative — asking an operator to restate each offering inside the
 * public block — is two copies of the same facts, and two copies drift. The
 * agent declares its offerings once, chooses which to advertise, and the storefront
 * is derived. Nothing is generated per REQUEST, so §8.7's "served verbatim"
 * still holds; the derivation happens once, on the way in, exactly like the
 * `owner` / `visibility` / `sandbox` rewrites (§8.3).
 *
 * `examples` is deliberately not carried: it is the largest field on an offering and
 * the least useful to somebody deciding whether to knock.
 */
export interface PublicOffering {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  /** What this offering takes and returns, as MIME types. The answer to "can I
   *  send it a file?" — which was previously unanswerable without admission. */
  input_modes?: string[];
  output_modes?: string[];
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  streaming?: boolean;
  estimated_duration_ms?: number;
  /** The engagement contract (§8.5.1), carried into the storefront so "who can
   *  push to my repo, and will I see drafts?" is answerable by a stranger. */
  needs?: NeedEntry[];
  delivers?: Delivers;
  /** The offered reporting level (§8.5.2), carried into the storefront by
   *  registry materialization. Unlike `needs`/`delivers` it is a closed
   *  vocabulary feeding an integer comparison, so it is VALIDATED on the way
   *  in: an unreadable declaration is dropped at registration, never served.
   *  Still self-declared — a renderer must present it as the provider's own
   *  claim. */
  reporting?: OfferingReporting;
}

/** @deprecated Renamed (§8.5) — use {@link PublicOffering}. */
export type PublicSkill = PublicOffering;

/**
 * Who is let in (§8.12). A closed vocabulary, because it feeds a decision —
 * is it worth knocking — and an open one there means every reader guesses
 * differently. An unrecognized value is read as UNSTATED, never as `open`.
 */
export type AdmissionPolicy = "open" | "allowlist" | "screened" | "negotiated";

/**
 * One way a caller presents identity (§8.12). `transport` is load-bearing:
 * `http` schemes carry OpenAPI's own types verbatim and project into the A2A
 * card's `securitySchemes`; a `mesh` scheme is `mesh-identity` (NKey + account
 * JWT at the transport layer) and MUST NOT be projected, because it has no
 * OpenAPI representation and inventing one would put a fictional HTTP scheme
 * on a card consumers act on.
 *
 * SHAPES, NEVER BINDINGS. A member whose value would differ from one caller to
 * the next is a binding, not a shape: a header NAME belongs here, a header
 * VALUE does not. No credential, token, key, account or tenant identifier, or
 * per-caller URL or path — a registry that finds one drops the block whole.
 */
export interface PublicAccessScheme {
  /** Stable within this manifest; how the rest of the document refers to it. */
  id: string;
  /** Which door this scheme is for. */
  transport: "mesh" | "http";
  /** OpenAPI's own type for `http`; `mesh-identity` for `mesh`. */
  type: "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS" | "mesh-identity";
  /** OpenAPI `apiKey` members. `name` is the header/query/cookie NAME, never a value. */
  in?: "header" | "query" | "cookie";
  name?: string;
  /** OpenAPI `http` members. */
  scheme?: string;
  bearerFormat?: string;
  /** OpenAPI `oauth2` / `openIdConnect` members — the operator's own endpoints,
   *  identical for every caller, which is exactly why they are shapes. */
  flows?: Record<string, unknown>;
  openIdConnectUrl?: string;
  /** One sentence, for a person. */
  description?: string;
}

/**
 * How a caller gets in (§8.12). Two DIFFERENT questions: `schemes` is the
 * lock, `admission` is whose key was cut. A caller can satisfy every scheme
 * and still be refused, and that is not a malfunction.
 *
 * Three states, and silence is one: schemes present and non-empty means the
 * agent said what to present; `schemes: []` means it said there is nothing to
 * present; an absent block (or one with no `schemes`) means it has not said.
 * A reader MUST NOT collapse the third into the second.
 */
export interface PublicAccess {
  admission?: AdmissionPolicy;
  schemes?: PublicAccessScheme[];
}

/**
 * The public block (§8.7): the storefront — the ONLY manifest content served
 * pre-admission (via `describe`, §10.14, and the HTTPS storefront URL).
 * Operator-declared, served verbatim; nothing generates it at request time.
 *
 * Two fields are registry-materialized rather than operator-written —
 * `offering_details` and the default modes — see `PublicOffering` for why.
 */
export interface PublicBlock {
  /** One-paragraph storefront: what this agent does, in the operator's words. */
  description?: string;
  /** Offering IDs the operator advertises to strangers (MAY be a subset of offerings).
   *  A SELECTION, not a description: the descriptions are materialized into
   *  `offering_details` by the registry from the IDs named here. */
  offerings?: string[];
  /** Registry-materialized descriptors for the IDs in `offerings`. Never written by
   *  a registrant; anything supplied here is discarded and rebuilt. */
  offering_details?: PublicOffering[];
  /** Registry-materialized from the manifest's card-level defaults, so a
   *  stranger reading the storefront learns what the agent accepts without
   *  having to be admitted first. */
  default_input_modes?: string[];
  default_output_modes?: string[];
  /** What admission takes, in free text: terms, expectations, or a URL. The
   *  sentence a person reads; `access.admission` is the vocabulary a program
   *  reads. A pair, not a duplication — neither is derivable from the other,
   *  and where both are present they MUST NOT contradict (§8.7, §8.12). */
  admission?: string;
  /** How a caller authenticates and who is let in (§8.12). Shapes, never
   *  bindings: safe to serve to strangers pre-admission by construction. */
  access?: PublicAccess;
  /** Owner-written searches this agent should be found for (§8.7) — read by
   *  directories, fed into their search, and displayed as "things you can
   *  ask". Written by a person: a directory following this spec's companion
   *  policy will not display machine-generated ones. At most a handful, each
   *  one short line. */
  example_queries?: string[];
  /** Related agents by handle — what makes the public graph crawlable. */
  links?: PublicLink[];
  /** Commercial terms advertised to strangers (§19.1): each entry a SKU id,
   *  its price, and its digest — price as pre-admission data, so a buyer
   *  compares terms before knocking and an AGREEMENT_REQUIRED refusal
   *  (§19.5) points at terms the storefront already showed. */
  skus?: PublicSku[];
}

/**
 * Agent manifest (§8). 0.2: durable description only — no liveness fields
 * (availability/last_heartbeat moved to the presence service, §9.6) and no
 * `network` block. `node` (the hosting-node vouch) is required. `cost` remains
 * only as an Economics-extension field (§17), not core.
 */
export interface Manifest {
  id: string;
  name: string;
  description: string;
  version: string;
  protocol_version: string;
  provider?: Provider;
  /** The agent's X25519 encryption public key (core §4.3): lets others seal
   *  content to this agent (e.g. a sealed-room key). OPTIONAL — absent means
   *  the agent participates only in cleartext. */
  encryption_key?: string;
  /** Whether callers should seal what they send here, and whether an unsealed
   *  request gets read at all (§8.9). Absent means the agent has not said,
   *  which senders must read as cleartext. Requires `encryption_key`. */
  sealing?: SealingPosture;
  /** What happens to content a buyer hands this agent (§8.10). Card-level,
   *  one declaration per agent; pre-admission data that travels with the
   *  storefront the way `sealing` does. Self-declared; absent means the agent
   *  has not said. See {@link AgentDataUse}. */
  data_use?: AgentDataUse;
  /** The compliance postures the operator claims (§8.11). Card-level,
   *  pre-admission, and self-declared INCLUDING each entry's attestation
   *  pointer; absent means the operator has not said, and a stated
   *  requirement treats silence as not meeting it. See
   *  {@link AgentComplianceEntry}. */
  compliance?: AgentComplianceEntry[];
  /** Who this agent was built to serve, and who it touches without being the
   *  buyer (§8.12). Card-level, pre-admission, self-declared. See
   *  {@link AgentAudience}. */
  audience?: AgentAudience;
  /** Where this agent's answers are valid (§8.12). NOT `data_use.processed_in`,
   *  which is about where bytes are handled. See {@link AgentCoverage}. */
  coverage?: AgentCoverage;
  /** What it does when asked outside `coverage` (§8.12). Absent means unstated
   *  and MUST NOT be read as `declines`. See {@link EdgeBehaviour}. */
  edge?: EdgeBehaviour;
  /** What it does with what it can reach (§8.12). Read-only, or acting with
   *  each action named and flagged for approval. NOT a mandate: this informs
   *  the decision to hire, a mandate constrains the thing once hired. See
   *  {@link AgentActs}. */
  acts?: AgentActs;
  /** Whose interest it acts in (§8.12). See {@link ServesParty}. */
  serves?: ServesParty;
  /** The other companies standing behind this agent (§8.12) — the platform it
   *  is built on, whoever configured it, whoever runs it, whose data it rests
   *  on. NOT the publisher, who is exactly one party named elsewhere. An
   *  integration-style claim: unverified, and never endorsement. See
   *  {@link AgentParty}. */
  parties?: AgentParty[];
  /** Where it came from, as four coordinates rather than an archetype label
   *  (§8.12). See {@link AgentOrigin}. */
  origin?: AgentOrigin;
  endpoint: string;
  /** Endpoint subjects, verbatim, for callers to resolve rather than construct
   *  (§14.4). Registry-populated when absent at registration (§8.2). */
  endpoints?: AgentEndpoints;
  /** Declared inbound limits senders pre-flight against (§6.4b, §8.2). */
  limits?: AgentLimits;
  node: NodeRef;
  capabilities: string[];
  offerings: Offering[];
  /** What this agent accepts and returns by default, as MIME types, when a
   *  offering does not say for itself (§8.5). The card-level fallback: an offering's
   *  own `input_modes` / `output_modes` win where present.
   *
   *  Absent means unstated, and a caller should read that as text — but the
   *  point of the field is that "unstated" was previously the ONLY thing an
   *  agent could say. An agent that takes a PDF had no way to publish that,
   *  and every consumer invented `["application/json", "text/plain"]` on its
   *  behalf. Maps directly to A2A's `defaultInputModes` / `defaultOutputModes`. */
  default_input_modes?: string[];
  default_output_modes?: string[];
  accepts?: string[];
  emits?: string[];
  /** External services this agent integrates with (§8.8). Pre-admission data:
   *  it travels with the storefront, because a claim nobody can read before
   *  knocking is not a claim. An integration claim ONLY — never affiliation,
   *  never endorsement, and never verified. */
  works_with?: WorksWith[];
  /** The storefront (§8.7): the content served pre-admission. */
  public?: PublicBlock;
  rate_limits?: RateLimits;
  trust?: Trust;
  extensions?: Extension[];
  meta?: Record<string, unknown>;
  /** Economics extension field (§17); not core. */
  cost?: Cost;
  /** What this agent sells (§19.1): named commercial terms — covers + price
   *  + billing provider. An offering covered by no SKU is FREE. Replaces the
   *  retired `cost` block (kept above for wire tolerance of old manifests). */
  skus?: Sku[];
  /** Who may discover this agent.
   *
   *  "public" is open discovery. "organization" is everybody in the owner's
   *  organization. "private" is the owner alone. "unlisted" is hidden from
   *  discovery but still reachable by ID, which is what makes it different
   *  from private: private is also withheld from `get` for non-owners.
   *
   *  A FIRST registration that says nothing is "private". An agent somebody
   *  just made is theirs until they widen it, and widening is always a
   *  deliberate act. A RE-registration that says nothing keeps whatever it
   *  had, so an agent that has been running in the open does not disappear
   *  because its code never mentioned the field.
   *
   *  Registry-enforced. This is listing privacy, not confidentiality. */
  visibility?: "public" | "organization" | "unlisted" | "private";
  /** How inbound requests are handled, so a caller knows what reaching this
   *  agent MEANS before it sends anything (§8.2).
   *
   *  - `service`: handled without a person in the loop. Sending disturbs nobody.
   *  - `interactive`: delivered into a live session a human is using. Sending
   *    may interrupt someone, and an answer waits on their attention.
   *
   *  Absent means unknown, which a careful caller should read as `interactive`:
   *  the cautious assumption. This is a fact about how the agent is running,
   *  not a claim about its quality. */
  interaction?: "service" | "interactive";
  /** The product answering here — the assistant or framework the agent runs
   *  inside ("claude-code", "openclaw", "hermes", "letta"), as its operator
   *  names it. Self-declared like every storefront fact, though join paths
   *  usually prefill it (an MCP client introduces itself; the adapter knows
   *  what it wraps). Absent means the operator has not said. */
  harness?: string;
  /** The harness's version, from the same source as `harness`. */
  harness_version?: string;
  /** The model behind the agent, at whatever precision the operator stands
   *  behind — a family ("claude") or an exact name ("claude-opus-5"). The
   *  operator's word, and it drifts: models change more often than cards, so
   *  readers weigh it against the registration's age. */
  model?: string;
  /** Set when the agent runs under a sandbox/guest credential. The registry
   *  clamps sandbox agents out of public discovery (never listed openly),
   *  regardless of the visibility they request. */
  sandbox?: boolean;
  /** The controlling operator/org (a public key). Defaults to the node id.
   *  Owner-scoped discovery returns an owner's unlisted/private agents only to
   *  that owner. Always populated by the registry once stored. */
  owner?: string;
  /** When `owner` differs from the node, an attestation signed by the owner key
   *  binding owner→agent (same shape as the node vouch); verified at register. */
  owner_attestation?: AgentAttestation;
}

// ── Node Profile (§9.7) ──────────────────────────────────────────────
// Durable, node-keyed description of the conditions a host runs under, joined
// into discovery via the agent's current vouching node. `trust_tier` and
// `role` are operator-attested; the rest are node-declared advisory hints.

/** Node trust standing, granted (attested) by the operator (§9.7). */
export type TrustTier = "verified" | "standard" | "sandbox";
/** Node role in the mesh (§9.7). */
export type NodeRole = "participant" | "service";
/** A node's *expected* uptime pattern (durable), distinct from live presence (§9.7). */
export type AvailabilityClass = "always_on" | "intermittent" | "on_demand";
/** How a node attaches to the transport (§9.7). */
export type Reachability = "direct" | "leaf";
/** OS family a node runs on (EXT-1, `mesh://extensions/device-profile/v1`). */
export type DevicePlatform = "darwin" | "win32" | "linux" | "android" | "ios" | "browser";
/** Coarse device form factor (EXT-1). */
export type DeviceClass = "laptop" | "desktop" | "server" | "mobile" | "browser" | "embedded";

export interface NodeProfile {
  /** The node this profile describes (node ID). */
  node: string;
  /** Attested: operator-signed; a node MUST NOT self-declare these. */
  trust_tier?: TrustTier;
  role?: NodeRole;
  /** Declared: self-reported advisory hints. */
  availability_class?: AvailabilityClass;
  reachability?: Reachability;
  capacity?: { max_agents?: number; max_concurrency?: number };
  /** Declared device description (EXT-1). Advisory, like all declared attrs. */
  platform?: DevicePlatform;
  os_version?: string;
  client?: string;
  device_class?: DeviceClass;
}

/** The subset of node-profile attributes a node MAY self-declare (§9.7).
 *  Attested attributes (`trust_tier`, `role`) are intentionally excluded so a
 *  node cannot claim a standing it was not granted. */
export interface NodeDeclaredProfile {
  availability_class?: AvailabilityClass;
  reachability?: Reachability;
  capacity?: { max_agents?: number; max_concurrency?: number };
  /** Device description keys (EXT-1, `mesh://extensions/device-profile/v1`).
   *  SDKs SHOULD auto-fill `platform` and `client`; the embedding application
   *  supplies `device_class`/`os_version` where it knows them. */
  platform?: DevicePlatform;
  os_version?: string;
  client?: string;
  device_class?: DeviceClass;
}
