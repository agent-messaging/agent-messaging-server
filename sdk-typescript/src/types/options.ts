import type { Offering, Provider, Cost, RateLimits, NodeDeclaredProfile, Extension, PublicBlock, AgentLimits, WorksWith, AgentDataUse, AgentAudience, AgentCoverage, EdgeBehaviour, AgentActs, ServesParty, AgentParty, AgentOrigin } from "./manifest.js";
import type { StorefrontAdoption } from "../storefront.js";
import type { SealingChoice } from "../internal/sealing-posture.js";
import type { Sku } from "../sku.js";
import type { TraceContext, Budget, Envelope } from "./envelope.js";
import type { QueuedAck, TrialRequesterVouch } from "./primitives.js";
import type { Authenticator } from "nats.ws";
import type { RequireNamedOptions } from "../naming-gate.js";
import type { ConnectRetry } from "../internal/connect-retry.js";

export interface ConnectOptions {
  servers: string | string[];
  name?: string;
  /** NATS authenticator (jwtAuthenticator, nkeyAuthenticator, etc.). Usually you
   *  don't set this directly — pass `jwt` + `nkeySeed` (e.g. a guest credential)
   *  and the SDK wires up JWT auth for you. */
  authenticator?: Authenticator;
  /** JWT for an authenticated connection (e.g. the guest credential from the
   *  auth service). Combined with `nkeySeed` to authorize the NATS connection. */
  jwt?: string;
  /** Agent NKey seed. When provided, the agent ID is the NKey public key and the
   *  agent signs its envelopes with this key. If omitted, a fresh agent key is
   *  generated. Accepts the seed string the auth service returns (e.g. "SUA…") or
   *  raw bytes. Kept in memory to sign every envelope (§4.5). */
  nkeySeed?: string | Uint8Array;
  /** Node NKey seed (string or bytes). The node vouches for this agent (§4.4).
   *  If omitted, the agent self-hosts (node key = agent key). */
  nodeSeed?: string | Uint8Array;
  /** X25519 encryption secret (base64url, from createEncryptionIdentity).
   *  When set, register() publishes the public half as the manifest's
   *  `encryption_key`, and sealed-room invites addressed to this agent can be
   *  opened. Distinct from the signing key on purpose (core §4.3).
   *
   *  It is also what lets this agent OPEN a sealed request (§8.9) and answer it
   *  sealed. Holding the seed does not make the agent ask to be sealed to —
   *  that is `RegisterOptions.sealing`, and by design a key alone declares
   *  nothing. */
  encryptionSeed?: string;
  /** The naming rule: refuse every send this agent originates (`request`,
   *  `requestStream`, `emit`, `publishFeed`, `openRoom`, `joinRoom`) until its
   *  handle follows the global standard, its name, a dot and its owner's
   *  email, at the naming service. A refusal is a `NOT_NAMED` MeshError whose
   *  message is the owner's words and whose details carry the proposed
   *  handle; nothing is built, signed or published.
   *
   *  Left out, `AgentMesh.connect()` decides from the server: the rule is on
   *  when the server says it offers naming (its capabilities answer has
   *  `naming: true`) and a naming service is known, and off when it says it
   *  does not (`naming: false`), which is how the Agent Messaging Server
   *  answers by itself. When the server cannot be asked, the rule is on
   *  whenever a naming service is known. The naming service is
   *  `{ registrar }` when given, else AGENTMESH_NAMING_URL, else
   *  https://naming.<domain> for a broker at mesh.<domain>.
   *
   *  `true` turns it on whatever the server says (a naming service must be
   *  known); `false` turns it off, for a host that enforces the rule itself
   *  (the reference adapter). `withConnection` and a node's `addAgent` stay
   *  opt-in. See naming-gate.ts. */
  requireNamed?: boolean | RequireNamedOptions;
  /** Where the server's HTTPS doors are: its capabilities answer, the
   *  credential and roster doors, and the platform services a mesh may offer
   *  beside the core (mesh.dependents, mesh.runs and the rest). Left out, the
   *  SDK uses `credentialRenewal.apiBase` (the address the agent enrolled
   *  against), else AGENTMESH_API_URL, else https://api.<domain> for a broker
   *  at mesh.<domain>. With none of these, the requests that need it say so. */
  platformApi?: string;
  /** The account's API token, sent beside the agent's signature with an
   *  owner's acts (mesh.credits, mesh.attachments, mesh.portfolio), which need
   *  it with the request's scope. The agent's other requests carry its
   *  signature alone. The Rust SDK's `platform_key`. */
  platformKey?: string;
  /** An operator key, sent with the requests only an operator may make (the
   *  Unified Error Log, filing and moving debt). The adapter's
   *  AGENTMESH_SERVICE_KEY; the Rust SDK's `operator_key`. */
  operatorKey?: string;
  /** @deprecated Use `authenticator` instead. */
  auth?: {
    token?: string;
    user?: string;
    pass?: string;
  };
  /** Expected reply identities for the platform services, as
   *  `subject → responder public key` (e.g.
   *  `{ "mesh.registry.discover": "U…" }`).
   *
   *  A service reply is signed by the SERVICE's key, not by any agent you
   *  addressed, so `from` cannot be checked against anything the SDK knows on
   *  its own (§6.2). Configure this and a reply from any other key on that
   *  subject is REFUSED. Leave it unset and the SDK falls back to
   *  pin-on-first-use: it remembers which key answered each subject and reports
   *  a change through `onSecurityWarning`, but still accepts the reply —
   *  because the services derive their signing key from an optional seed
   *  (`REGISTRY_SEED`, `ROOMS_SEED`, …) that no deployment currently sets, so
   *  the key rotates on every service restart and refusing would take the mesh
   *  down on deploy. Pin the seeds first, then pin the keys here. */
  serviceKeys?: Record<string, string>;
  /** Public keys of mesh intermediaries allowed to answer a request on an
   *  agent's behalf (EXT-6 admission's benign ack: the admission service, not
   *  the addressed agent, replies when the target is guarded and the sender is
   *  off its roster or the agent is slow).
   *
   *  Unset means pin-on-first-use: the first non-target key that answers for an
   *  agent becomes THE intermediary for this connection and any later
   *  disagreement is refused. Configure it and only these keys may ever speak
   *  for an agent. */
  intermediaryKeys?: string[];
  /** Called when the SDK notices something a careful operator would want to
   *  know but that does not (or cannot safely) fail the call: a service reply
   *  arriving from a different key than last time, an intermediary answering
   *  for an agent, a node vouch this agent could not renew. Default: nothing —
   *  this SDK never writes to the console. */
  onSecurityWarning?: (warning: SecurityWarning) => void;
  /** Lifetime of the node vouch this agent registers with (§4.4), in ms.
   *  Default 30 days (`DEFAULT_VOUCH_TTL_MS`).
   *
   *  It also sets the renewal cadence: the SDK re-registers with a freshly
   *  signed vouch at two thirds of this, so a shorter TTL is a tighter
   *  revocation window rather than a shorter life. Lower it if you want a
   *  revoked node's agents to fall out of discovery sooner; there is no reason
   *  to raise it, since a longer lease does not make an unrenewed vouch any
   *  less expired. */
  vouchTtlMs?: number;
  /** Keep the connection credential alive (§4.8).
   *
   *  A node credential expires — the spec requires it to — and an expiry with
   *  no renewal is a scheduled outage. Set this and the SDK renews the
   *  credential at two thirds of its own lifetime, the same schedule the vouch
   *  above uses, through `POST {apiBase}/v1/node-credential`.
   *
   *  Renewal is a plain HTTPS call authorized by proof-of-possession of the
   *  credential's key and this agent's key, so it needs no live mesh
   *  connection and works on a credential that has ALREADY lapsed. Persist
   *  what `onRenewed` hands you: an unpersisted renewal is undone by the next
   *  restart.
   *
   *  Leave it unset and the SDK does nothing about the credential — correct for
   *  a guest credential (throwaway, re-leased on demand) and for a host that
   *  manages credential files itself with `CredentialRenewer`. */
  credentialRenewal?: {
    /** Control-plane origin, e.g. `https://api.agentmesh.ai`. */
    apiBase: string;
    /** Seed of the key the JWT is bound to. Defaults to `nkeySeed`, which is
     *  right whenever the credential was minted against the agent's own key;
     *  a bootstrap-minted credential is bound to a separate key and must pass
     *  that key's seed here. */
    credentialSeed?: string | Uint8Array;
    /** Where the fresh credential goes. Called before the SDK adopts it, so a
     *  throw here is reported as a renewal failure and retried. */
    onRenewed?: (c: { jwt: string; node_id: string; agents: string[]; expires_at: string | null }) => void | Promise<void>;
    /** For an agent that enrolled with an outside proof (Agent Messaging 0.8,
     *  §4.14): a fresh proof of the same identity for each renewal, such as a
     *  new token from the identity provider. The mesh renews such an agent
     *  only with one. */
    proof?: import("../outside-proof.js").OutsideProofSource;
  };
  /** Whether inbound sender text is wrapped in a provenance frame, with the
   *  text fenced so it cannot forge that frame, before any `onRequest`,
   *  `onStreamRequest` or `subscribe` handler sees it (`internal/fence.ts`).
   *
   *  **Default: true.** An inbound message is untrusted text going into a model
   *  that may hold tools on this machine, and the absence of a warning label is
   *  invisible — nothing errors, nothing logs, the model simply believes a
   *  stranger. So the default is the guarded one and opting out is explicit.
   *
   *  Set `false` when you genuinely want the raw bytes. Two legitimate reasons:
   *  the payload is structured data you parse rather than prose you prompt with
   *  (harmless either way — the fence only rewrites a string, or a `text` /
   *  `message` / `prompt` string field, and leaves every other shape alone), or
   *  you frame inbound text yourself and a second frame would nest inside the
   *  first. `mesh-adapter` is the second case: it resolves the sender's PAN
   *  handle first and frames with provenance the SDK has not looked up.
   *
   *  Framing never touches `ctx.envelope`, which stays the verbatim signed
   *  envelope — rewriting it would break `verifyEnvelopeSig` on a genuine
   *  message. A handler that wants the raw text can read
   *  `ctx.envelope.payload.input`. */
  fenceInbound?: boolean;
  /** Cap on the sender text (in characters) one inbound message may carry
   *  before the SDK refuses it. Default `DEFAULT_MAX_INBOUND_CHARS` (64 KiB),
   *  matching mesh-adapter's own cap so the two layers agree.
   *
   *  A refusal is not a silent drop: the sender gets a signed
   *  `CONTEXT_TOO_LARGE` error envelope wherever there is a reply path, and the
   *  recipient hears about it through `onSecurityWarning` (`inbound_oversize`)
   *  even when there is not. The handler is never invoked, so an oversized
   *  message costs no model call.
   *
   *  `0` disables the cap. That leaves the broker's `max_payload` as the only
   *  bound, which is a deployment default rather than a decision — do it
   *  knowingly. */
  maxInboundChars?: number;
  /** Refuse a request signed by a revoked agent key (§5.3). On by default:
   *  before a request is handled, the registry is asked whether its sender's
   *  key has been revoked (a short memo keeps this to one question a minute
   *  per sender), and a revoked sender gets `UNAUTHORIZED` with
   *  `details.reason: "agent_key_revoked"` instead of a handler run. A check
   *  that cannot answer lets the message through; a key once seen revoked is
   *  refused for the life of the process. `false` turns it off, for tests and
   *  for a host that makes the check itself. */
  refuseRevokedSenders?: boolean;
  /** How often the §16.4 mailbox drain is re-run while this agent stays up, in
   *  ms. Default `DEFAULT_MAILBOX_DRAIN_INTERVAL_MS` (60s); values below
   *  `MIN_MAILBOX_DRAIN_INTERVAL_MS` (1s) are clamped up to it.
   *
   *  The drain is also re-run immediately on every transport reconnect, which is
   *  the trigger that matters — a reconnect gap is exactly when the mailbox holds
   *  something the live subscription missed. The interval is the backstop, and
   *  what it really bounds is the *tail*: each pass is bounded to the backlog
   *  present when it binds, so between passes the mailbox accumulates unacked
   *  copies of live traffic. Keeping that tail smaller than the §22.2 dedup
   *  memory (5,000 pairs) is what lets a re-drain ack what the live path already
   *  handled instead of dispatching it twice. Lower this only if one agent
   *  sustains more than ~83 inbound messages a second. */
  mailboxDrainIntervalMs?: number;
  /** Publish `span_completed` events to `mesh.trace.>` for every agent on this
   *  connection (SPEC.md §13.1.1).
   *
   *  Off unless set, deliberately. Trace PROPAGATION is core and always on and
   *  costs nothing; producing a durable record of which counterparties this
   *  host dealt with is a different act, and one an operator should choose
   *  rather than inherit. Spans carry no payload, no sender text and no
   *  amounts — see §13.1.1 for what they refuse to say. */
  emitSpans?: boolean;
  maxReconnectAttempts?: number;
  reconnectTimeWait?: number;
  reconnect?: boolean;
  /** Try the FIRST connection again while the broker cannot be reached (a
   *  timeout or a refusal, as during a broker restart), a bounded number of
   *  times with a growing wait, instead of throwing at once. A broker that
   *  refuses the credential is not tried again. Unset: one try, as before.
   *  For a long-running process, so a busy broker at its start does not end
   *  it (internal/connect-retry.ts). NATS meshes only. */
  connectRetry?: ConnectRetry;
}

/** A security-relevant observation the SDK could not turn into an error
 *  without risking a false refusal. See ConnectOptions.onSecurityWarning. */
export interface SecurityWarning {
  /** `service_key_changed` | `intermediary_pinned` | `vouch_renewal_failed` |
   *  `inbound_oversize` | `sent_in_clear` | `revoked_sender` */
  code: string;
  message: string;
  /** The subject or agent the observation is about. */
  subject?: string;
  /** The key that answered, and the one previously seen (if any). */
  from?: string;
  previous?: string;
}

export interface RegisterOptions {
  name: string;
  description?: string;
  version?: string;
  capabilities?: string[];
  offerings?: Offering[];
  /** What this agent takes and returns by default, as MIME types (§8.5) — the
   *  card-level fallback for offerings that do not say for themselves. Declare it
   *  if the agent handles anything beyond text: this is the only way a caller
   *  learns it accepts files BEFORE sending one, and the registry copies it into
   *  the storefront so strangers see it without being admitted (§8.7). */
  default_input_modes?: string[];
  default_output_modes?: string[];
  provider?: Provider;
  cost?: Cost;
  /** What this agent sells (§19.1). Validated at registration; the public
   *  block automatically advertises each SKU's id, price, and digest unless
   *  `public.skus` is set explicitly (advertising less is a choice §8.7
   *  protects). An offering covered by no SKU is free. */
  skus?: Sku[];
  rate_limits?: RateLimits;
  meta?: Record<string, unknown>;
  /** The storefront (§8.7): the manifest content served pre-admission
   *  (`describe`, §10.14). Operator-declared; served verbatim. */
  public?: PublicBlock;
  /** External services this agent integrates with (§8.8) — "works with the
   *  Colorado DMV". An integration claim and nothing more: it is never a claim
   *  of affiliation or endorsement, nobody verifies it, and presenting as the
   *  named service instead of alongside it is impersonation. Served
   *  pre-admission, so declare only what is true. */
  works_with?: WorksWith[];
  /** The card-level data-use declaration (§8.10): what happens to content a
   *  caller hands this agent — training, retention, human access, and the
   *  services content passes through. Self-declared, ONE per agent, and
   *  carried on the manifest verbatim: the REGISTRY is the validator, and it
   *  drops an unreadable declaration WHOLE on the way in (a privacy claim
   *  served in part misleads more than none at all). The SDK deliberately
   *  does not duplicate those drop rules — it is pass-through only, so the
   *  registry's verdict is the only verdict. Absent means the agent has not
   *  said, which is a different statement from every declared one. */
  data_use?: AgentDataUse;
  /** The §8.12 card-level declarations: who this agent was built to serve,
   *  where its answers hold, what it does when asked outside that, whose
   *  interest it acts in, where it came from, what it can do with what it can
   *  reach, and who else stands behind it.
   *
   *  Spread onto the manifest at card level rather than nested, because that is
   *  the shape the registry validates and the storefront materializes. Carried
   *  through verbatim: the registry is the validator and drops an unreadable
   *  member whole, and a second copy of those rules here would let the two
   *  drift and make the SDK's verdict compete with the authoritative one.
   *
   *  These were missing until now, which was worse than not offering them:
   *  `mesh-adapter` has passed them at the top level of its registration since
   *  the console learned to author a listing, and `buildManifest` dropped every
   *  one on the floor. So an owner filling in the listing editor was told it
   *  had saved, the adapter adopted it, and nothing ever reached the wire. */
  audience?: AgentAudience;
  coverage?: AgentCoverage;
  edge?: EdgeBehaviour;
  acts?: AgentActs;
  serves?: ServesParty;
  parties?: AgentParty[];
  origin?: AgentOrigin;
  /** Adopt the listing its owner edits in the console (§8.7, §8.12).
   *
   *  The manifest is signed by this agent's key and the console does not hold
   *  it, so an owner's edit is stored as a PROPOSAL that the agent has to come
   *  and fetch. Set this and the SDK does exactly that, on the same cadence and
   *  the same wire contract `mesh-adapter` uses: poll, merge the edit into what
   *  this agent registers, re-register under its own signature, acknowledge.
   *
   *  Leave it unset and nothing polls, which is the right default: the address
   *  being polled is a control plane the agent may not belong to, and an owner
   *  who edits nothing is served by no HTTP calls at all. The cost of leaving it
   *  unset is stated plainly, because it is the whole reason this option exists:
   *  the console will tell the owner their edit takes effect when the agent
   *  adopts it, and an agent that never asks never will. */
  storefrontProposals?: {
    /** Control-plane origin, e.g. `https://api.agentmesh.ai`. */
    apiBase: string;
    /** How often to ask, in ms. Default 60s, the adapter's cadence; anything
     *  below 5s is clamped up to it. */
    pollIntervalMs?: number;
    /** Called after an adoption that changed something, with the field names
     *  that moved. Where a host logs "the owner renamed this agent's storefront". */
    onAdopted?: (adoption: StorefrontAdoption) => void;
    /** Replaces `fetch` for the proposal calls. Tests, and hosts that route
     *  outbound HTTP through their own client. */
    fetchImpl?: typeof fetch;
  };
  /** Whether callers should seal what they send this agent (§8.9). Usually
   *  omitted: the SDK derives it from what the agent already declared, so an
   *  offering that asks for a third-party sign-in gets `"required"` and an
   *  agent that declares `works_with` gets `"preferred"`, both without anybody
   *  configuring encryption. Set it to raise the posture, or to `"none"` to
   *  decline one the derivation would otherwise apply. Ignored, rather than
   *  refused, when the agent has no `encryptionSeed`: a posture is a promise
   *  about reading, and there is nothing here to read with. */
  sealing?: SealingChoice;
  /** Extensions this agent declares (§17.2), e.g. the a2a-bridge marker. */
  extensions?: Extension[];
  /** SPEC.md §5.7: declare `mesh://extensions/audience/v1`, saying that
   *  messages marked for this agent's person reach that person and are never
   *  given to the agent as work. Requires a person surface registered with
   *  `onPersonMessage` first, because an agent that cannot reach its person
   *  must not declare it. */
  personMessages?: boolean;
  /** Discovery visibility. Default "public". */
  visibility?: "public" | "unlisted" | "private";
  /** How inbound requests are handled: `service` (no person in the loop) or
   *  `interactive` (delivered into a live session someone is using, so sending
   *  may interrupt them). Declare it honestly: callers filter on it. */
  interaction?: "service" | "interactive";
  /** The product answering here ("claude-code", "openclaw", "letta"), its
   *  version, and the model behind it — self-declared, usually prefilled by
   *  the join path. See the same fields on {@link Manifest}. */
  harness?: string;
  harness_version?: string;
  model?: string;
  /** Owner nkey seed (string or bytes). If set, the agent's owner is this key's
   *  public key, vouched by an owner attestation. Defaults to the node — no
   *  attestation needed, since the node vouch already covers it. Use an explicit
   *  owner to group agents across multiple nodes under one org. */
  ownerSeed?: string | Uint8Array;
  /** The hosting node's self-declared profile (§9.7): its expected uptime,
   *  reachability, and capacity. Node-level, so pass the same value for every
   *  agent a node hosts. Attested attributes (trust_tier, role) are set by the
   *  operator and cannot be declared here. */
  nodeProfile?: NodeDeclaredProfile;
  /** Declared per-message inbound limits (§8.1), for senders to pre-flight
   *  against (§6.4b). Usually omitted: the SDK declares
   *  `limits.max_inbound_chars` automatically when this agent's own
   *  `maxInboundChars` differs from the §22.5 default, so the declaration and
   *  the enforcement cannot drift apart. Set it explicitly only to declare a
   *  value the SDK is not the enforcer of. */
  limits?: AgentLimits;
  /** Ask the mesh to guard this agent's inbox (EXT-6 admission): the admission
   *  service filters inbound against the agent's stored roster before delivery,
   *  dropping blocked/flooding senders. The agent then receives on a private
   *  `.guarded` subject. If the admission service is unreachable, the agent
   *  falls back to its public inbox (unguarded) so it stays reachable. */
  guarded?: boolean;
}

export interface RequestConfig {
  timeout_ms?: number;
  stream?: boolean;
  accepted_output?: string[];
  context_id?: string;
  meta?: Record<string, unknown>;
  /** Evidence that this request acts for a person (Agent Messaging 0.8,
   *  §4.16): a token-exchange token, an ID-JAG, a transaction token, a CIBA
   *  approval or a PACT delegation, with its issuer. Carried in
   *  `meta.on_behalf_of`; the receiver checks it with `verifyOnBehalfOf`. */
  on_behalf_of?: import("../on-behalf-of.js").OnBehalfOf;
  /** Override the §8.9 seal decision for this one request.
   *
   *  Left alone, the SDK seals when the recipient's manifest asks it to and a
   *  verified key is at hand. `true` demands sealing and fails the request if
   *  it cannot be done, which is the right setting for a caller that knows it
   *  is sending a customer record whatever the recipient declared. `false`
   *  sends in the clear, and a recipient declaring `required` will refuse it. */
  seal?: boolean;
  /** The budget for this work (§7.7): the most it may cost, the latest it may
   *  finish, or both. `revision` MUST be 0 on an initiating request; later
   *  changes travel as revisions on the Task (`reviseBudget`). Validated
   *  before sending; carried as the envelope's top-level `budget` field and
   *  covered by the signature like every other field. */
  budget?: Budget;
  /** Ask for trial work (Common Agent 7.7): sets `trial: true` on the
   *  request payload. A trial carries no budget, so giving both is refused
   *  locally, before anything is signed (`preflightTrial`). */
  trial?: boolean;
  /** A host's vouch for the person this trial request is sent on behalf of
   *  (Common Agent 7.7, Hosts): sets `trial_requester` on the request payload.
   *  The responder honours it only when it trusts the sender as a host. */
  trial_requester?: TrialRequesterVouch;
  /** Explicit parent trace context (§13.1). The outbound envelope becomes a
   *  child span of it. Rarely needed: inside an offering handler the inbound trace
   *  is propagated automatically (where the platform has AsyncLocalStorage);
   *  pass `ctx.traceContext` here on platforms without it (browsers). */
  trace?: TraceContext;
  /** Called when the responder's accept signal (§6.4a) arrives: the request
   *  was delivered, passed the recipient's inbound checks and budget
   *  admission, and a handler is running in a live process. The SDK already
   *  does the §6.4a caller work — it resets the response timeout and keeps
   *  waiting for the substantive respond — so this hook is observation only.
   *  Never invoked with the substantive reply, and an accept never resolves
   *  the returned promise. Local hook; not sent on the wire. */
  onAccept?: (envelope: Envelope) => void;
  /** Called when the target's node answers with the §6.4a queued
   *  acknowledgement instead of an accept: a held mailbox has the message and
   *  the real reply, if any, arrives later at THIS agent's own inbox. The ack
   *  is not the substantive reply, so after this hook fires `request()`
   *  rejects with `ErrorCode.REQUEST_QUEUED` (ack fields in `details`) rather
   *  than resolving. Local hook; not sent on the wire. */
  onQueued?: (ack: QueuedAck, envelope: Envelope) => void;
}

export interface StreamConfig extends RequestConfig {
  /** Timeout for the entire stream in ms. Default: 5 minutes. */
  stream_timeout_ms?: number;
  /** Timeout between individual chunks in ms. Default: 30 seconds. */
  chunk_timeout_ms?: number;
  /** §11.6 strict mode: demand a signature on every chunk (e.g. across a
   *  low-trust boundary). Default false — streams are authenticated by their
   *  signed opening + signed final (with chunk_count) instead. */
  sign_chunks?: boolean;
}
