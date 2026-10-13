/**
 * The least-privilege permission template every minted credential gets.
 *
 * WHY THIS FILE EXISTS
 *
 * Until 2026-07-26 the mint paths built their user claim as `{}` — an empty
 * permissions block. In NATS an empty block does not mean "no permissions"; it
 * means "inherit the account's `default_permissions`". Ours deny a short list
 * (`mesh.peer.>`, `mesh.aclroom.>`) and allow everything else, so every
 * credential we handed out could:
 *
 *   - `sub mesh.agent.*.inbox` and read every other agent's mail;
 *   - drive `$JS.API.>` and drain or delete any agent's offline mailbox;
 *   - `sub $KV.mesh_sessions.>`, where account bearer tokens are the plaintext
 *     KEYS — i.e. read the session tokens of every signed-in human.
 *
 * That was true of the guest pool (fixed by re-minting and revoking), of
 * `POST /v1/bootstrap` (fixed by this file), and of the `nsc add user` calls in
 * the public Compose bootstrap (called out in the operator handbook). Three
 * separate sites, one mistake, made three times — which is the argument for a
 * single template in a single file rather than a permissions literal at each
 * mint. Add a mint path, import this; do not hand-roll a claim.
 *
 * WHAT AN AGENT ACTUALLY NEEDS
 *
 * Derived by reading the client, not by guessing. The offline mailbox drain
 * (`sdk-typescript/src/mesh.ts` `startOfflineDrain`) is the only part that
 * needs JetStream, and it touches exactly four API subjects plus acks, all of
 * them scoped to the agent's own `MESH_INBOX_<key>` stream. That is why this
 * template can narrow JetStream instead of denying it outright: the guest pool
 * denies `$JS.>` because sandbox agents are live-only by contract, but a
 * durable agent has a mailbox and must be able to empty it.
 *
 * WHAT IS DELIBERATELY STILL BROAD, AND WHY
 *
 *   - `pub mesh.agent.*.inbox` — reaching any agent's inbox IS the mesh. The
 *     wildcard is one token, so it does not match the five-token
 *     `mesh.agent.<k>.inbox.guarded`, which stays private to the admission
 *     service.
 *   - `pub _INBOX.>` - for the two places an agent still speaks on a transport
 *     reply subject after the §6.4 hard cutover: answering the reaper's
 *     `__registry_probe__` (§18.7 - its caller is a single-reply request that
 *     reads liveness there and nowhere else) and answering a guarded delivery
 *     (`.inbox.guarded`, where the admission relay is the requester of record
 *     and collects the accept and the answer on its own reply inbox). Every
 *     OTHER respond now goes to the requester's inbox subject, which the
 *     `mesh.agent.*.inbox` grant above already covers - the old justification,
 *     "a responder answers on the requester's reply subject", is no longer
 *     true of the protocol. That also retires the old objection to `resp`
 *     (allow_responses): a §7 task answering hours later no longer answers on
 *     the reply subject, and both remaining uses answer within seconds, so
 *     this grant is now wider than what it exists for and narrowing it to a
 *     `resp` bound is tracked as follow-up. It permits reply spoofing, which
 *     is real but much smaller than the three exposures above: envelopes are
 *     signed (SPEC §5), so a spoofed reply that matters still has to forge a
 *     signature - and a §6.4 requester ignores reply-subject data anyway.
 *   - `sub mesh.event.>` and `sub mesh.task.>` — neither carries the agent's key
 *     in its subject, so neither can be scoped by key. Events are a broadcast
 *     bus by design; the consequence for non-ACL rooms (any credential can
 *     watch a `capability` room live) is a rooms-design question, not something
 *     a credential template can fix. ACL rooms are on `mesh.aclroom.>` and are
 *     denied here.
 *
 * Every subject below is either derived from `sdk-typescript/src/internal/
 * subjects.ts` or from a JetStream call in `startOfflineDrain`. If a client
 * feature starts failing with a permissions violation, the honest fix is to add
 * the subject here with a comment saying which call needs it — not to widen a
 * wildcard, and never to go back to `{}`.
 */

/** JetStream stream holding one agent's offline mail. Must match
 *  `server/src/registry/inbox-buffer.ts` `inboxStreamName`. Duplicated rather
 *  than imported because that module pulls in the JetStream client, and this one
 *  is imported by the mint path; asserted equal in the unit test. */
function inboxStream(agentKey: string): string {
  return `MESH_INBOX_${agentKey}`;
}

/** The feed stream (SPEC §18.3) and one agent's durable consumer on it (§18.6
 *  Feed Consumer): ONE consumer per agent, named for the agent, whose
 *  filter_subjects list the feeds it follows durably. Must match
 *  `sdk-typescript/src/internal/subjects.ts` `feedConsumer`, the Rust and
 *  Python SDKs' twins, and `server/src/shared/feed-stream.ts` FEED_STREAM.
 *
 *  Why one consumer per agent and not one per feed, as the event consumer
 *  is: a NATS permission matches whole tokens, and a consumer name is one
 *  token of the JetStream API subject. A name derived from what the agent
 *  follows cannot be known when the credential is minted, so it could only
 *  be granted as `*`, and a `*` would let any agent pull (and so take) the
 *  deliveries of another agent's durable consumer. A name that IS the
 *  agent's key is granted exactly. */
const FEED_STREAM_NAME = "MESH_FEED";
function feedConsumer(agentKey: string): string {
  return `mesh_feed_${agentKey}`;
}

/** The JetStream calls one agent's durable feed subscription makes, each on
 *  its own consumer only: info, create or update (all three API shapes,
 *  since nats.js, nats-py and async-nats pick by server version and by
 *  whether there is one filter or several), pull, and ack. No stream info,
 *  no list, no delete: the consumer is the agent's cursor and is never
 *  deleted by the agent's own client. */
function feedConsumerGrants(agentKey: string): string[] {
  const c = feedConsumer(agentKey);
  const s = FEED_STREAM_NAME;
  return [
    `$JS.API.CONSUMER.INFO.${s}.${c}`,
    `$JS.API.CONSUMER.CREATE.${s}.${c}`,
    `$JS.API.CONSUMER.CREATE.${s}.${c}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${s}.${c}`,
    `$JS.API.CONSUMER.MSG.NEXT.${s}.${c}`,
    // `m.ack()`: the ack subject's second and third tokens are the stream and
    // the consumer, so this acks this agent's own feed deliveries only.
    `$JS.ACK.${s}.${c}.>`,
  ];
}

/** Whether a `$JS.` grant is exactly one of `agentKey`'s feed-consumer grants. */
function isOwnFeedConsumerGrant(subject: string, agentKey: string): boolean {
  return feedConsumerGrants(agentKey).includes(subject);
}

/** The permissions half of a NATS user claim. */
export interface CredPermissions {
  pub: { allow: string[]; deny: string[] };
  sub: { allow: string[]; deny: string[] };
}

/**
 * The rooms service's control plane (EXT-5): the request-reply verbs a client
 * publishes to reach the service. Enumerated rather than granted as
 * `mesh.rooms.>` because this file's whole doctrine is that an allow list names
 * the calls it permits — a wildcard here would silently cover any verb the rooms
 * service grows later, including ones no client should call.
 *
 * WHY THIS EXISTS: until it did, neither template listed a single rooms subject,
 * and a NATS allow list is exhaustive — so every credential the platform minted
 * was denied `Permissions Violation for Publish to "mesh.rooms.*"`. Rooms were
 * unreachable for every durable agent and every Gateway node on the deployed
 * mesh: no open, no join, no unread count, and above all no `credential`, which
 * is the acl grade's entire enforcement mechanism. The rooms tests missed it
 * because `tools/local-acl-mesh.mjs` mints its pool with `allow: [">"]` on
 * purpose — that harness exercises the SERVICE, so it says nothing about what
 * real clients are permitted to send.
 *
 * Reaching these subjects authorizes nothing by itself. Every handler decides
 * off `req.from`, which `wrapHandler`'s verifying `decode` has already checked
 * against the envelope signature: `admit` and `expel` are creator-only,
 * `credential` is admitted-members-only, `mine` and `cursor` answer about the
 * caller alone. This grant is permission to ASK.
 *
 * Note what is NOT here: `mesh.aclroom.>`, the acl traffic plane, stays in
 * `NEVER`. An acl member reaches a room's traffic on the short-lived
 * room-scoped credential the service mints, over a second connection — never on
 * its own agent credential. That separation is the grade.
 */
const ROOMS_CONTROL = [
  // Create or reclaim a durable room; read its record back (EXT-5 §4, §6).
  "mesh.rooms.provision",
  "mesh.rooms.reclaim",
  "mesh.rooms.replay",
  "mesh.rooms.status",
  // The artifact drive (CAP-3).
  "mesh.rooms.attach",
  "mesh.rooms.fetch",
  // "Rooms I can reach" and this member's read position — what a client needs
  // to render a room list with unread counts (ROOMS-UI-PLAN Phase 1).
  "mesh.rooms.mine",
  "mesh.rooms.cursor",
  // Own durable-room usage vs quota. Requires a signed envelope and resolves
  // the caller's own operator; there is no cross-operator query on the wire.
  "mesh.rooms.usage",
  // acl grade. `credential` is the mint the broker's enforcement rests on;
  // refusing its renewal IS revocation (EXT-5 §8.1). `leave` is a member
  // taking itself off the admit list (§8.3) — named HERE at birth, because
  // enumerated credentials in the field never learn a subject added later.
  "mesh.rooms.admit",
  "mesh.rooms.credential",
  "mesh.rooms.expel",
  "mesh.rooms.leave",
  // Notes on a file (EXT-5 §8.4): a member's attributed statement about the
  // bytes of something on the drive, and the read of them. Named HERE at birth
  // for the same reason `leave` was — an enumerated credential already in the
  // field never learns a subject added later, so a verb missing from this list
  // is a verb the whole deployed mesh is denied.
  "mesh.rooms.note",
  "mesh.rooms.notes",
];

/**
 * The artifact store (§7.5).
 *
 * This list exists because the store shipped without it and every credential
 * the platform mints was denied `Permissions Violation for Publish to
 * "mesh.artifacts.put"` — the service running, reachable by nothing. That is
 * the SECOND time this exact trap has been sprung, the first being
 * `mesh.rooms.>` (see the note above this file's ROOMS_CONTROL). A NATS allow
 * list is exhaustive, so a new service subject is invisible until it is named
 * HERE, and a service that answers on a subject nobody may publish to looks
 * healthy in every log it writes.
 *
 * Permission to ASK, like the rooms control plane. Every handler authorizes
 * for itself off the verified `env.from`: `put` resolves the caller's owner
 * from the registry and charges its quota, `remove` refuses another owner's
 * object, `usage` answers about the caller alone. `fetch` and `stat` are
 * deliberately open to any agent, because §7.5.4 makes possession of the
 * unguessable reference the read capability — the subject is not the boundary,
 * the ref is.
 */
const ARTIFACTS_CONTROL = [
  "mesh.artifacts.put",
  "mesh.artifacts.fetch",
  "mesh.artifacts.stat",
  "mesh.artifacts.remove",
  "mesh.artifacts.usage",
  // A file over the message size (2026-09-23): begin and commit are a `put`
  // in two halves around an upload by signed link, gated exactly as `put` is,
  // and `link` is a `fetch` answered with a URL, open to any holder of the ref
  // for the same reason `fetch` is. Named here at birth, because a credential
  // already in the field never learns a subject added later, and an SDK that
  // meets that refusal falls back to the inline put until its credential is
  // renewed.
  "mesh.artifacts.put.begin",
  "mesh.artifacts.put.commit",
  "mesh.artifacts.link",
  // Keeping a file one holds the ref to, under one's own owner (2026-09-23):
  // a write, gated exactly as `put` is (the caller's owner is charged for the
  // copy), with the ref as the read capability exactly as on `fetch`. The
  // platform's own hosted identity is the first caller, when a process runner
  // hands a delivered piece over by its ref; that credential is minted fresh
  // on every connect, so it learns this subject on the first call after a
  // deploy. A credential already in the field learns it only when renewed.
  "mesh.artifacts.keep",
  // The owner holding a file of its own past the sweep while a published page
  // shows it, and releasing it (2026-09-25). Gated inside the store on
  // ownership. The platform's hosted identities are the callers, minted fresh
  // on every connect, so they learn it on the first call after a deploy.
  "mesh.artifacts.hold",
];

/**
 * The work board (EXT-5 §10): a room's optional whiteboard of claimable items,
 * answered by the rooms service. Enumerated for the same doctrine as
 * ROOMS_CONTROL, and listed HERE at birth because this trap has now been
 * sprung twice (rooms, then artifacts): a NATS allow list is exhaustive, and a
 * new service subject is unreachable until it is named in the templates.
 *
 * Permission to ASK, nothing more. Every verb is gated inside the rooms
 * service on room membership — the caller presents the room's descriptor and
 * `admit` decides, exactly as it does for the record and the drive.
 */
const BOARD_CONTROL = [
  "mesh.board.post",
  "mesh.board.list",
  "mesh.board.claim",
  "mesh.board.complete",
  "mesh.board.abandon",
  "mesh.board.withdraw",
];

/**
 * Subjects no credential we mint may ever touch, in either direction. Kept
 * separate from the allow lists because deny wins in NATS: even if someone
 * later widens an allow list by accident, these hold. Belt and braces on
 * purpose — the allow lists below already exclude all of them.
 */
const NEVER = [
  // Session bearer tokens are the KEYS in this bucket; every other bucket
  // holds accounts, rosters, or tasks. No agent has business in any of them.
  "$KV.>",
  // The federation plane (t03). Reserved to peer credentials.
  "mesh.peer.>",
  // ACL rooms carry their own scoped credentials with per-room subjects.
  "mesh.aclroom.>",
  // Server monitoring and account events.
  "$SYS.>",
];

/**
 * The template for a DURABLE agent credential: an agent that signed up, is
 * owned by an account, and has an offline mailbox.
 *
 * @param agentKey the agent's own public nkey (`U…`). Every self-scoped
 *   subject below embeds it, which is what makes one agent's credential
 *   useless against another agent.
 */
/**
 * ONE JOB'S CREDENTIAL: what a worker gets when the work runs somewhere we do
 * not own.
 *
 * ## Why this is not the durable credential
 *
 * Today an agent is a long-lived process on a host we run, holding a durable
 * credential that can register, listen on its own inbox, drain its mailbox,
 * open rooms, post to the board and reach any agent. That is the right set for
 * something that IS the agent. It is the wrong set to hand to a container on
 * somebody else's cloud for the ninety seconds it takes to write a review.
 *
 * The move to burstable sandboxes splits one process into two. A supervisor we
 * run keeps the address: it stays registered, holds the mailbox, and decides
 * that a message has arrived. A worker somewhere else does the work for that
 * one message and exits. So the worker never listens as the agent, never
 * registers, never drains a mailbox, and never needs to be reachable. It
 * replies, it stores what it made, and it goes away.
 *
 * Handing a sandbox provider the durable seed would make that provider able to
 * BE the agent for as long as it holds it, across every job, with no expiry.
 * That is the thing this function exists to prevent, and it is a design
 * requirement rather than a hardening pass: the durable seed never leaves our
 * side, and what crosses the boundary is this, minted per job and expiring.
 *
 * ## What it can do
 *
 * Reply on its own outbox, report task progress, store the pieces it produced,
 * and emit its own span. Nothing else. `sends` widens it by exactly one grant,
 * for a job whose work IS to send to other agents: our process runner is the
 * only one so far, and the widening is per job rather than per agent because
 * an agent that orchestrates one job does not orchestrate every job.
 *
 * ## What it cannot do
 *
 * Subscribe to the agent's inbox at all, which is the narrowing that matters:
 * a worker that could listen as the agent could take a message meant for the
 * next job, and there would be no record that it had. It also cannot register
 * or deregister, cannot guard or unguard the door, cannot open a room, cannot
 * touch the board, cannot publish a feed, and cannot reach JetStream, because
 * the mailbox belongs to the supervisor.
 */
export function jobWorkerPermissions(agentKey: string, { sends = false }: { sends?: boolean } = {}): CredPermissions {
  return {
    pub: {
      allow: [
        // Its answer to the one message it was given.
        `mesh.agent.${agentKey}.outbox`,
        // Task progress and completion. Task ids are not derived from the
        // agent key, so this cannot be self-scoped; it is the same compromise
        // the durable credential makes and for the same reason.
        "mesh.task.>",
        // The pieces it made. A delivery is the whole point of a worker, so
        // this is the one control plane it keeps.
        ...ARTIFACTS_CONTROL,
        // Its own span, scoped to its own key: a span says "this agent did
        // this", so publishing one as another agent is a forgery.
        `mesh.trace.${agentKey}`,
        // Every request it makes subscribes a reply subject for the
        // transport's liveness verdict; the client picks the prefix, so this
        // cannot be scoped.
        "_INBOX.>",
        // A job whose work is to send to other agents. Off by default, and
        // decided per job: the process runner sends each phase to its holder,
        // and nothing else on the fleet needs this.
        ...(sends ? ["mesh.agent.*.inbox", "mesh.registry.discover", "mesh.registry.get"] : []),
      ],
      deny: [...NEVER],
    },
    sub: {
      allow: [
        // Replies to what it sent, and task updates for the task it is doing.
        "_INBOX.>",
        "mesh.task.>",
      ],
      deny: [
        ...NEVER,
        // THE narrowing that matters. A worker never listens as the agent:
        // the supervisor holds the address and the mailbox. A worker that
        // could subscribe here could take the next job's message, and nothing
        // would record that it had.
        "mesh.agent.>",
      ],
    },
  };
}

/**
 * The guard on the above, run before any job credential is minted. Every rule
 * here is a thing that must never be true of a credential we hand to a machine
 * we do not own, and an empty allow list is the worst of them because it
 * INHERITS the account defaults rather than granting nothing.
 */
export function assertJobWorkerNarrow(perms: CredPermissions, agentKey: string, { sends = false }: { sends?: boolean } = {}): void {
  const bad: string[] = [];
  if (!perms.pub?.allow?.length) bad.push("pub.allow is empty, which INHERITS account defaults");
  if (!perms.sub?.allow?.length) bad.push("sub.allow is empty, which INHERITS account defaults");
  for (const s of NEVER) {
    if (!perms.pub?.deny?.includes(s)) bad.push(`pub.deny is missing "${s}"`);
    if (!perms.sub?.deny?.includes(s)) bad.push(`sub.deny is missing "${s}"`);
  }
  // It must not be able to listen as the agent, by any spelling.
  for (const s of perms.sub?.allow ?? []) {
    if (s.startsWith("mesh.agent.")) bad.push(`sub.allow "${s}": a worker must never listen as the agent`);
  }
  if (!perms.sub?.deny?.includes("mesh.agent.>")) bad.push('sub.deny is missing "mesh.agent.>"');
  // It must not be able to change what the agent IS, or who may reach it.
  const FORBIDDEN_PUB = [
    "mesh.registry.register", "mesh.registry.deregister",
    "mesh.admission.guard", "mesh.admission.unguard",
    "mesh.rooms.provision", "mesh.board.post",
  ];
  for (const s of perms.pub?.allow ?? []) {
    if (FORBIDDEN_PUB.includes(s)) bad.push(`pub.allow "${s}": a worker may not change what the agent is or who may reach it`);
    if (s.startsWith("$JS.")) bad.push(`pub.allow "${s}": the mailbox belongs to the supervisor, not the worker`);
    if (s.startsWith("mesh.feed.")) bad.push(`pub.allow "${s}": a worker does not publish the agent's feed`);
    // Writing to another agent's outbox would be speaking as them.
    if (s.startsWith("mesh.agent.") && s.endsWith(".outbox") && s !== `mesh.agent.${agentKey}.outbox`) {
      bad.push(`pub.allow "${s}" is another agent's outbox`);
    }
  }
  // Reaching other agents is a per-job grant, never a default.
  const reaches = (perms.pub?.allow ?? []).includes("mesh.agent.*.inbox");
  if (reaches && !sends) bad.push('pub.allow "mesh.agent.*.inbox" without the job declaring that it sends');
  if (!reaches && sends) bad.push('the job declares that it sends, but nothing grants it a way to');
  if (bad.length) throw new Error(`refusing to mint a job credential for ${agentKey.slice(0, 12)}: ${bad.join("; ")}`);
}

export function durableAgentPermissions(agentKey: string): CredPermissions {
  const stream = inboxStream(agentKey);
  return {
    pub: {
      allow: [
        // Registry: register, deregister, discover, get. All request/reply.
        "mesh.registry.>",
        // Reach any agent's public inbox. See the note above on why this is
        // wide and why `.guarded` is not included.
        "mesh.agent.*.inbox",
        // Its own outbox only.
        `mesh.agent.${agentKey}.outbox`,
        // §13.1.1 spans, scoped to its own key for the same reason the outbox
        // is: a span says "this agent did this", so publishing one AS another
        // agent is the forgery this list exists to prevent. Emission is off by
        // default at the node, so this grant costs nothing until an operator
        // turns it on.
        `mesh.trace.${agentKey}`,
        // Task progress and streaming (§7, §11). Task ids are not derived from
        // the agent key, so these cannot be self-scoped.
        "mesh.task.>",
        // Emit (§6).
        "mesh.event.>",
        // Feeds (§6.6a): publish ONLY under its own owner token. The single
        // `*` pins topics to one token, which is §6.6a's grammar — this grant
        // is the transport half of "only the owner publishes"; the state
        // writer's from-check (shared/feed-state.ts) is the other half.
        `mesh.feed.${agentKey}.*`,
        // The current-value lookup (§18.3), request-reply like presence.
        "mesh.feed.get",
        // Liveness lookup and node heartbeat (§9.6, §10.10).
        "mesh.presence.get",
        "mesh.heartbeat.*",
        // Ask the admission service to guard/unguard this inbox (EXT-6 §7.1).
        "mesh.admission.guard",
        "mesh.admission.unguard",
        // The rooms control plane (EXT-5). See ROOMS_CONTROL.
        ...ROOMS_CONTROL,
        // The artifact store (§7.5). See ARTIFACTS_CONTROL.
        ...ARTIFACTS_CONTROL,
        // The work board (EXT-5 §10). See BOARD_CONTROL.
        ...BOARD_CONTROL,
        // Reply subjects - post-§6.4-cutover only the probe answer and
        // guarded-delivery answers still publish here (the header note).
        "_INBOX.>",
        // --- the offline mailbox drain, and nothing else in JetStream ---
        // `jetstreamManager()` handshake.
        "$JS.API.INFO",
        // `jsm.streams.info(stream)` — does this agent have a mailbox?
        `$JS.API.STREAM.INFO.${stream}`,
        // `jsm.consumers.info` / `.add` — both API shapes, old and new.
        `$JS.API.CONSUMER.INFO.${stream}.*`,
        `$JS.API.CONSUMER.CREATE.${stream}.*`,
        `$JS.API.CONSUMER.DURABLE.CREATE.${stream}.*`,
        // `consumer.consume()` pulls.
        `$JS.API.CONSUMER.MSG.NEXT.${stream}.*`,
        // `m.ack()`. Scoped to this stream: the ack subject's second token is
        // the stream name, so this cannot ack another agent's mail.
        `$JS.ACK.${stream}.>`,
        // --- its durable feed subscription (§18.6 Feed Consumer) ---
        // One consumer on MESH_FEED named for this agent; see
        // feedConsumerGrants. Reading a feed is open broadcast (§6.6a); the
        // grant exists so a follower that was offline gets what it missed.
        ...feedConsumerGrants(agentKey),
      ],
      deny: [...NEVER],
    },
    sub: {
      allow: [
        // THE narrowing that matters: its own inbox, not `mesh.agent.*.inbox`.
        `mesh.agent.${agentKey}.inbox`,
        // The private subject the admission service relays to when guarding.
        `mesh.agent.${agentKey}.inbox.guarded`,
        `mesh.agent.${agentKey}.outbox`,
        // Subscribed events and updates for tasks it initiated. Not
        // self-scopeable; see the note above.
        "mesh.event.>",
        "mesh.task.>",
        // Any agent's feeds (§6.6a): open broadcast by design, like events.
        // Exactly four tokens, so this can never receive `mesh.feed.get`
        // requests, which have three.
        "mesh.feed.*.*",
        // Reply inboxes. The client picks its own random prefix, so this cannot
        // be scoped to the credential. Still fully needed after the §6.4
        // cutover: every request the agent MAKES subscribes one for the
        // transport's liveness verdict, and control-plane RPC replies
        // (registry, rooms, tasks, artifacts, admission) arrive here - it is
        // agent-to-agent RESPONSE data that no longer does.
        "_INBOX.>",
      ],
      deny: [...NEVER],
    },
  };
}

/**
 * The template for a NODE credential (SPEC §4.1, §14.3): one host, one
 * connection, N hosted agents. §14.3 is explicit — "a node's User JWT MUST
 * define explicit publish and subscribe permissions covering the subjects of
 * every agent it hosts" — and until this function existed nothing could mint
 * that shape. Every issued credential was single-agent, so a node hosting
 * more than one agent (the Egg Gateway is the reference case) hit a NATS
 * permissions violation on every hosted agent's inbox subscription.
 *
 * The shape is the union of `durableAgentPermissions` over the hosted agents:
 * per-agent subjects are ENUMERATED, never wildcarded. The tempting
 * `mesh.agent.*.inbox` subscribe wildcard would let any node read any agent's
 * mail — exactly the exposure the 2026-07-26 fix closed. The consequence is
 * that adding an agent to a node means re-minting the credential with the new
 * subjects and reconnecting; that is the spec-faithful trade, not a defect.
 *
 * @param nodeKey the node's own public nkey (`U…`). The JWT is bound to this
 *   key, so possession of the node seed is what makes the credential usable.
 * @param agentKeys the hosted agents' public nkeys. Deduplicated; the node key
 *   itself never grants agent subjects unless it is also listed as an agent.
 */
/** How many agents one node credential covers at most. The subjects are
 *  enumerated per agent (see below), so the number bounds the JWT's size and
 *  the standing check's work per mint, and nothing else. It was 16 while the
 *  only node was the Egg Gateway; the adapter node (docs/adapter-node-spec.md)
 *  is designed for hundreds of agents on one process, so the ceiling sits
 *  above its design target of 500. */
export const NODE_CREDENTIAL_MAX_AGENTS = 512;

export function nodePermissions(nodeKey: string, agentKeys: string[]): CredPermissions {
  const agents = [...new Set(agentKeys)];
  const pubAllow: string[] = [
    // Registry: register, deregister, discover, get — for every hosted agent.
    "mesh.registry.>",
    // Reach any agent's public inbox (same width, same rationale as the
    // durable template: reaching inboxes IS the mesh).
    "mesh.agent.*.inbox",
    // Task progress, streaming, events, liveness, node heartbeat, admission.
    "mesh.task.>",
    "mesh.event.>",
    // The feed current-value lookup (§18.3); per-agent feed PUBLISH grants are
    // enumerated in the loop below, like every other self-scoped subject.
    "mesh.feed.get",
    "mesh.presence.get",
    "mesh.heartbeat.*",
    "mesh.admission.guard",
    "mesh.admission.unguard",
    // The rooms control plane (EXT-5), for every hosted agent. The Gateway is
    // the reference case: it holds ONE node credential and its hosted agents'
    // rooms all ride it.
    ...ROOMS_CONTROL,
    // The artifact store (§7.5), same reasoning: a node's hosted agents write
    // and read their deliverables on the node's one credential.
    ...ARTIFACTS_CONTROL,
    // The work board (EXT-5 §10), same reasoning again: hosted agents post to
    // and claim from their rooms' whiteboards on the node's one credential.
    ...BOARD_CONTROL,
    // Reply subjects - as on the durable template, the §6.4 cutover leaves
    // only two publishers of these: hosted agents answering the reaper's
    // probe, and hosted agents answering a guarded delivery to the admission
    // relay. Ordinary responds ride `mesh.agent.*.inbox` now (header note
    // there, including why a `resp` bound is the tracked narrowing).
    "_INBOX.>",
    // JetStream handshake, once.
    "$JS.API.INFO",
  ];
  const subAllow: string[] = [
    // Broadcast planes — not self-scopeable (see the durable template).
    "mesh.event.>",
    "mesh.task.>",
    // Any agent's feeds (§6.6a) — same width and rationale as events.
    "mesh.feed.*.*",
    // Reply inboxes for the node's own requests: the liveness verdict on
    // every agent request it hosts, and control-plane RPC replies. Response
    // data from other agents arrives at the hosted inboxes below (§6.4).
    "_INBOX.>",
  ];
  for (const key of agents) {
    const stream = inboxStream(key);
    pubAllow.push(
      // This agent's outbox.
      `mesh.agent.${key}.outbox`,
      // §13.1.1 spans for this agent only, same scoping as the outbox.
      `mesh.trace.${key}`,
      // This agent's own feeds (§6.6a), same self-scoping as the outbox.
      `mesh.feed.${key}.*`,
      // Its offline-mailbox drain, scoped to its own stream.
      `$JS.API.STREAM.INFO.${stream}`,
      `$JS.API.CONSUMER.INFO.${stream}.*`,
      `$JS.API.CONSUMER.CREATE.${stream}.*`,
      `$JS.API.CONSUMER.DURABLE.CREATE.${stream}.*`,
      `$JS.API.CONSUMER.MSG.NEXT.${stream}.*`,
      `$JS.ACK.${stream}.>`,
      // Its durable feed subscription, on its own consumer only (§18.6).
      ...feedConsumerGrants(key),
    );
    subAllow.push(
      // THE point of the node credential: this agent's inbox, enumerated.
      `mesh.agent.${key}.inbox`,
      `mesh.agent.${key}.inbox.guarded`,
      `mesh.agent.${key}.outbox`,
    );
  }
  return {
    pub: { allow: pubAllow, deny: [...NEVER] },
    sub: { allow: subAllow, deny: [...NEVER] },
  };
}

/**
 * `assertNarrow` for node credentials: every agent-scoped subject must name a
 * key from the hosted set, every JetStream subject must name a hosted agent's
 * stream, and the deny list must hold. Same contract as `assertNarrow` — call
 * it on the claim actually being signed, fail loudly.
 */
export function assertNarrowNode(perms: CredPermissions, agentKeys: string[]): void {
  const bad: string[] = [];
  const agents = new Set(agentKeys);
  const streams = new Set(agentKeys.map(inboxStream));

  if (!agentKeys.length) bad.push("agent set is empty — a node credential must host at least one agent");
  if (!perms.pub?.allow?.length) bad.push("pub.allow is empty, which INHERITS account defaults");
  if (!perms.sub?.allow?.length) bad.push("sub.allow is empty, which INHERITS account defaults");

  for (const s of NEVER) {
    if (!perms.pub?.deny?.includes(s)) bad.push(`pub.deny is missing "${s}"`);
    if (!perms.sub?.deny?.includes(s)) bad.push(`sub.deny is missing "${s}"`);
  }

  // No subscribe reaches an inbox outside the hosted set, and no wildcard can
  // smuggle one in.
  for (const s of perms.sub?.allow ?? []) {
    if (!s.startsWith("mesh.agent.")) continue;
    const key = s.split(".")[2];
    if (key === "*" || key === ">" || !agents.has(key)) {
      bad.push(`sub.allow "${s}" is not scoped to a hosted agent's key`);
    }
  }

  // JetStream stays inside the hosted agents' own mailbox streams, and their
  // own feed consumers, granted exactly.
  for (const s of perms.pub?.allow ?? []) {
    if (!s.startsWith("$JS.")) continue;
    if (s === "$JS.API.INFO") continue;
    if (agentKeys.some((k) => isOwnFeedConsumerGrant(s, k))) continue;
    if (![...streams].some((st) => s.includes(st))) {
      bad.push(`pub.allow "${s}" reaches JetStream outside the hosted agents' streams`);
    }
  }

  // Feed publishes stay under hosted agents' own owner tokens (§6.6a). The
  // lookup subject is the one legitimate non-tokenized grant.
  for (const s of perms.pub?.allow ?? []) {
    if (!s.startsWith("mesh.feed.")) continue;
    if (s === "mesh.feed.get") continue;
    const owner = s.split(".")[2];
    if (s !== `mesh.feed.${owner}.*` || !agents.has(owner)) {
      bad.push(`pub.allow "${s}" publishes feeds outside the hosted agents' own (§6.6a)`);
    }
  }

  if (bad.length) {
    throw new Error(
      `refusing to mint a node credential with unsafe permissions:\n  ` + bad.join("\n  "),
    );
  }
}

/**
 * Refuse to mint a credential whose permissions are broader than the template
 * intends. This exists because the failure we are fixing was silent: `{}` looks
 * harmless, produced no error, and the credential worked perfectly — it just
 * also worked on everyone else's mail. A mint that cannot prove it is narrow
 * should fail loudly instead.
 *
 * Called on the actual claim just before signing, so it also catches a future
 * caller that builds a claim by hand or spreads extra fields over the template.
 *
 * @throws Error naming the specific violation.
 */
export function assertNarrow(perms: CredPermissions, agentKey: string): void {
  const bad: string[] = [];

  // An empty or absent allow list is the bug itself: it inherits the account
  // defaults. This is the assertion that would have caught the original.
  if (!perms.pub?.allow?.length) bad.push("pub.allow is empty, which INHERITS account defaults");
  if (!perms.sub?.allow?.length) bad.push("sub.allow is empty, which INHERITS account defaults");

  for (const s of NEVER) {
    if (!perms.pub?.deny?.includes(s)) bad.push(`pub.deny is missing "${s}"`);
    if (!perms.sub?.deny?.includes(s)) bad.push(`sub.deny is missing "${s}"`);
  }

  // No credential may subscribe to another agent's inbox. A `*` or `>` anywhere
  // in an inbox subscribe subject means it can.
  for (const s of perms.sub?.allow ?? []) {
    if (!s.startsWith("mesh.agent.")) continue;
    const key = s.split(".")[2];
    if (key !== agentKey) {
      bad.push(`sub.allow "${s}" is not scoped to this agent's key (${agentKey.slice(0, 8)}…)`);
    }
  }

  // JetStream must be scoped to this agent's own mailbox stream. A bare
  // `$JS.API.>` is how a credential drains someone else's mail.
  // The one other JetStream reach is this agent's own feed consumer, granted
  // subject by subject (never a `*` in the consumer's place).
  const stream = inboxStream(agentKey);
  for (const s of perms.pub?.allow ?? []) {
    if (!s.startsWith("$JS.")) continue;
    if (s === "$JS.API.INFO") continue;
    if (isOwnFeedConsumerGrant(s, agentKey)) continue;
    if (!s.includes(stream)) bad.push(`pub.allow "${s}" reaches JetStream outside ${stream} and its own feed consumer`);
  }

  // Feed publishes must stay under this agent's own owner token (§6.6a) —
  // a `*` or somebody else's key in the owner position is feed forgery.
  for (const s of perms.pub?.allow ?? []) {
    if (!s.startsWith("mesh.feed.")) continue;
    if (s === "mesh.feed.get") continue;
    if (s !== `mesh.feed.${agentKey}.*`) {
      bad.push(`pub.allow "${s}" publishes feeds outside this agent's own (§6.6a)`);
    }
  }

  if (bad.length) {
    throw new Error(
      `refusing to mint a credential with unsafe permissions:\n  ` + bad.join("\n  "),
    );
  }
}

/**
 * THE OPERATOR CONSOLE'S CONNECTION: read and watch, nothing else.
 *
 * The console used to borrow a credential from the shared sandbox pool, first
 * through the no-signup guest door and then, from 2026-09-27, through
 * `POST /v1/operator/console-credential`. The pool is retired
 * (docs/no-anonymous-agents-plan.md item 11), so that route now mints this: a
 * fresh key per sign-in, bound to it, expiring with the operator session.
 *
 * Derived from what the console actually sends (console/src/nats.ts and the
 * screens under console/src/operator/), not from the pool's shape:
 *
 *   requests   mesh.registry.discover, mesh.registry.nodes.list,
 *              mesh.activity.list, mesh.usage.list, mesh.usage.summary,
 *              mesh.catalog.list, and one agent's inbox for the diagnostics
 *              skill call (`mesh.agent.*.inbox`, the one-token wildcard every
 *              template carries: reaching an inbox IS the mesh)
 *   watches    mesh.event.> and mesh.heartbeat.> (Live Feed, Overview),
 *              mesh.task.*.update (Budgets), its own inbox (the answer to a
 *              diagnostics call, which rides the requester's inbox after the
 *              §6.4 cutover), and _INBOX.> for the transport's replies
 *
 * It registers nothing, has no outbox, no mailbox, no feeds, no rooms, no
 * board and no artifacts, and answers no requests (so no `resp`). The key is
 * never an agent: nothing names it and nothing should, because it is a
 * reader's connection, not somebody on the mesh.
 */
export function consoleReaderPermissions(key: string): CredPermissions {
  return {
    pub: {
      allow: [
        "mesh.registry.discover",
        "mesh.registry.nodes.list",
        "mesh.activity.list",
        "mesh.usage.list",
        "mesh.usage.summary",
        "mesh.catalog.list",
        "mesh.agent.*.inbox",
      ],
      deny: [...CONSOLE_NEVER],
    },
    sub: {
      allow: [
        "_INBOX.>",
        `mesh.agent.${key}.inbox`,
        "mesh.event.>",
        "mesh.heartbeat.>",
        "mesh.task.*.update",
      ],
      deny: [...CONSOLE_NEVER],
    },
  };
}

/** What the console's connection is denied beyond `NEVER`: all of JetStream
 *  and the object store. It reads through the services, never the streams. */
const CONSOLE_NEVER = [...NEVER, "$JS.>", "$O.>"];

/** The guard on the above, run on the claim actually signed. A reader that
 *  could register, speak as an agent, or touch a stream is not a reader. */
export function assertConsoleReader(perms: CredPermissions, key: string): void {
  const bad: string[] = [];
  if (!perms.pub?.allow?.length) bad.push("pub.allow is empty, which INHERITS account defaults");
  if (!perms.sub?.allow?.length) bad.push("sub.allow is empty, which INHERITS account defaults");
  for (const s of CONSOLE_NEVER) {
    if (!perms.pub?.deny?.includes(s)) bad.push(`pub.deny is missing "${s}"`);
    if (!perms.sub?.deny?.includes(s)) bad.push(`sub.deny is missing "${s}"`);
  }
  for (const s of perms.pub?.allow ?? []) {
    if (s.startsWith("$")) bad.push(`pub.allow "${s}" reaches the server's own subjects`);
    if (s.startsWith("mesh.registry.") && s !== "mesh.registry.discover" && s !== "mesh.registry.nodes.list") {
      bad.push(`pub.allow "${s}": the console reads the registry and never writes it`);
    }
    if (s.endsWith(".outbox") || s.startsWith("mesh.feed.") || s.startsWith("mesh.rooms.") || s.startsWith("mesh.board.") || s.startsWith("mesh.artifacts.") || s.startsWith("mesh.admission.")) {
      bad.push(`pub.allow "${s}": the console is a reader, not an agent`);
    }
    if (s === "_INBOX.>") bad.push('pub.allow "_INBOX.>": the console answers nobody');
  }
  for (const s of perms.sub?.allow ?? []) {
    if (!s.startsWith("mesh.agent.")) continue;
    if (s !== `mesh.agent.${key}.inbox`) bad.push(`sub.allow "${s}" is not the console's own inbox`);
  }
  if (bad.length) throw new Error(`refusing to mint a console credential:\n  ${bad.join("\n  ")}`);
}

/**
 * What a SANDBOX credential is additionally denied, beyond `NEVER`. A guest is
 * live-only by contract: no JetStream at all (`$JS.>` — a durable agent narrows
 * it to its own mailbox stream; a guest has no mailbox), no object store, and
 * none of the two rooms verbs whose grant IS the acl enforcement mechanism.
 */
const SANDBOX_NEVER = [
  ...NEVER,
  "$JS.>",
  "$O.>",
  "mesh.rooms.admit",
  "mesh.rooms.credential",
];

/** The permissions half of a sandbox user claim: pub/sub like every other
 *  template, plus the `resp` bound that replaces a blanket `_INBOX.>` publish
 *  grant. `ttl` is nanoseconds on the wire (NATS claim convention). */
export interface SandboxPermissions extends CredPermissions {
  resp: { max: number; ttl: number };
}

/** 300 seconds, in the nanoseconds the claim carries. A guest's reply window
 *  is deliberately short: a sandbox conversation answers now or not at all. */
const SANDBOX_RESP_TTL_NS = 300_000_000_000;

/**
 * The template for a SANDBOX (guest pool) credential: the credential
 * `/v1/guest` hands to a stranger with no signup.
 *
 * THIS IS THE DEPLOYED SHAPE, WRITTEN DOWN. The hosted pool was re-minted to
 * least privilege on 2026-07-25 by hand, and the exact claims have lived only
 * inside those sixty JWTs ever since — the operator handbook could only say
 * "copy a deployed credential rather than inventing one". This function is
 * that shape as code, decoded from the deployed pool and reproduced entry for
 * entry, so a bootstrap can mint a narrow pool from birth and the rotation
 * job's refuse-to-widen ratchet sees nothing gained.
 *
 * Two grants here are documented as wider than we want and are reproduced
 * anyway (docs/safety-considerations.md 7.7 and 5.3): the `_INBOX.>`
 * SUBSCRIBE (a guest can read every reply to every request in the account)
 * and the `mesh.event.>` subscribe (every capability-grade room is readable
 * live). Narrowing either is a behaviour change for every deployed client and
 * belongs to its own rotation, decided on its own page — not to this file
 * quietly diverging from what is actually enforced. Note what is already
 * closed on the reply side: there is NO `_INBOX.>` in the publish allow —
 * that grant was the response-forgery primitive the 2026-07 re-mint removed —
 * and replies ride the bounded `resp` instead.
 *
 * @param agentKey the pool identity's own public nkey (`U…`). The three
 *   self-scoped entries (outbox, heartbeat, register.<key>) embed it.
 */
export function sandboxPermissions(agentKey: string): SandboxPermissions {
  return {
    pub: {
      allow: [
        // Read-only platform surfaces a guest console renders.
        "mesh.activity.list",
        "mesh.admission.guard",
        "mesh.admission.unguard",
        // Reaching inboxes IS the mesh, for a guest as for anyone (the same
        // one-token wildcard note as the durable template: `.guarded` stays
        // private to the admission service).
        "mesh.agent.*.inbox",
        `mesh.agent.${agentKey}.outbox`,
        "mesh.catalog.get.*",
        "mesh.catalog.list",
        // Emit (§6).
        "mesh.event.>",
        `mesh.heartbeat.${agentKey}`,
        "mesh.presence.get",
        // Registry: register/deregister/discover/get, plus the key-scoped
        // register subject the sandbox flow uses. Descriptor subjects are the
        // two reads only: a guest may fetch anyone's descriptor, and put stays
        // durable-tier (a sandbox identity has no descriptor to submit).
        "mesh.registry.descriptor.digest.*",
        "mesh.registry.descriptor.get.*",
        "mesh.registry.deregister",
        "mesh.registry.discover",
        // Evaluation-record reads (Common Agent spec §9.4), the two reads only,
        // same posture as the descriptor subjects above: anyone may fetch a
        // subject's latest verdict or any archived one, and put stays
        // durable-tier — an evaluator submitting signed verdicts is a durable
        // agent, never a guest.
        "mesh.registry.eval.digest.*",
        "mesh.registry.eval.get.*",
        "mesh.registry.get.*",
        "mesh.registry.nodes.list",
        "mesh.registry.register",
        `mesh.registry.register.${agentKey}`,
        // The rooms verbs a guest may ASK (service-side authorization decides;
        // see ROOMS_CONTROL). Deliberately NOT the whole control plane: no
        // mine/cursor/leave/note/notes, no work board, no artifact store —
        // a guest that wants those signs up.
        "mesh.rooms.attach",
        "mesh.rooms.expel",
        "mesh.rooms.fetch",
        "mesh.rooms.provision",
        "mesh.rooms.reclaim",
        "mesh.rooms.replay",
        "mesh.rooms.status",
        "mesh.rooms.usage",
        // Task progress and streaming for tasks it participates in (§7, §11).
        "mesh.task.*.stream",
        "mesh.task.*.update",
        "mesh.task.get.*",
        // Its own usage, answered about the caller alone.
        "mesh.usage.list",
        "mesh.usage.summary",
        "mesh.usage.today",
      ],
      deny: [...SANDBOX_NEVER],
    },
    sub: {
      allow: [
        // Reply inboxes — the documented-open 7.7 grant; see the note above.
        // What flows through them narrowed with the §6.4 cutover: agent
        // responses now travel inbox-to-inbox, so what a guest can overhear
        // here is control-plane RPC replies plus the probe and
        // guarded-delivery answers that still use reply subjects. Narrower in
        // fact, unchanged in grant - 7.7's page decides its rotation.
        "_INBOX.>",
        // Its own inbox, exactly like every other template.
        `mesh.agent.${agentKey}.inbox`,
        `mesh.agent.${agentKey}.inbox.>`,
        // Broadcast planes, not self-scopeable (see the durable template).
        "mesh.event.>",
        "mesh.heartbeat.>",
        "mesh.task.*.stream",
      ],
      deny: [...SANDBOX_NEVER],
    },
    // Reply-subject publishes ride this bound instead of a blanket `_INBOX.>`
    // publish grant: eight messages, five minutes, gone. Post-§6.4-cutover
    // that means probe answers and guarded-delivery answers - a guest's
    // ordinary responses go to the requester's inbox and ride the
    // `mesh.agent.*.inbox` grant above, so this is no longer a bound on how
    // fast a guest can answer. Noted, not widened or removed here: whether
    // the reply-rate intent moves to the inbox grant is a rotation decision.
    resp: { max: 8, ttl: SANDBOX_RESP_TTL_NS },
  };
}

/**
 * `assertNarrow` for sandbox credentials: the live-only contract must hold
 * ($JS nowhere in an allow), the widened deny list must hold, the reply-side
 * closure must hold (no `_INBOX.>` publish, a bounded `resp` present), and
 * every agent-scoped subject must name this pool identity's own key. Same
 * contract as its siblings — call it on the claim actually being signed.
 */
export function assertNarrowSandbox(perms: SandboxPermissions, agentKey: string): void {
  const bad: string[] = [];

  if (!perms.pub?.allow?.length) bad.push("pub.allow is empty, which INHERITS account defaults");
  if (!perms.sub?.allow?.length) bad.push("sub.allow is empty, which INHERITS account defaults");

  for (const s of SANDBOX_NEVER) {
    if (!perms.pub?.deny?.includes(s)) bad.push(`pub.deny is missing "${s}"`);
    if (!perms.sub?.deny?.includes(s)) bad.push(`sub.deny is missing "${s}"`);
  }

  // Live-only means live-only: no JetStream reach at all, not even the
  // stream-scoped subjects a durable credential gets.
  for (const s of [...(perms.pub?.allow ?? []), ...(perms.sub?.allow ?? [])]) {
    if (s.startsWith("$JS")) bad.push(`allow "${s}" reaches JetStream, which a sandbox credential never may`);
  }

  // No subscribe reaches an inbox that is not this identity's own.
  for (const s of perms.sub?.allow ?? []) {
    if (!s.startsWith("mesh.agent.")) continue;
    const key = s.split(".")[2];
    if (key !== agentKey) {
      bad.push(`sub.allow "${s}" is not scoped to this identity's key (${agentKey.slice(0, 8)}…)`);
    }
  }

  // The response-forgery closure: replies ride `resp`, never a blanket grant.
  if (perms.pub?.allow?.includes("_INBOX.>")) {
    bad.push('pub.allow contains "_INBOX.>" — the response-forgery primitive the pool re-mint removed');
  }
  if (!perms.resp || !(perms.resp.max >= 1) || !(perms.resp.ttl >= 1)) {
    bad.push("resp bound is missing — without it a guest cannot answer requests at all");
  } else {
    if (perms.resp.max > 8) bad.push(`resp.max ${perms.resp.max} is wider than the pool's contract (8)`);
    if (perms.resp.ttl > SANDBOX_RESP_TTL_NS) bad.push(`resp.ttl ${perms.resp.ttl}ns is longer than the pool's contract (${SANDBOX_RESP_TTL_NS}ns)`);
  }

  if (bad.length) {
    throw new Error(
      `refusing to mint a sandbox credential with unsafe permissions:\n  ` + bad.join("\n  "),
    );
  }
}

// ── The server's own users ─────────────────────────────────────────────────
// What first-run setup (setup/nats-setup.ts) mints for the server's own
// processes, and what the old self-host bundle's mint (scripts/mint-bootstrap.ts)
// mints for its nodes. They are written here with every other permission
// literal, so the server's own users and the agents' credentials are read in
// one place.

/** The privileged subjects only the platform's user may publish
 *  (docs/nats-users-runbook.md): deregister, listing, forget descriptor. */
export const ADMIN_SUBJECTS = "mesh.admin.>";

/** The core's processes: everything, except publishing on the privileged
 *  subjects. Deny wins in NATS, so the deny holds against the `>` beside it. */
export function coreServerPermissions(): CredPermissions {
  return {
    pub: { allow: [">"], deny: [ADMIN_SUBJECTS] },
    sub: { allow: [">"], deny: [] },
  };
}

/** The platform's processes, when the AgentMesh platform runs beside the
 *  core: everything, the privileged subjects included. Written down rather
 *  than left empty, because an empty permissions block inherits the account's
 *  defaults (the 2026-07-26 incident). */
export function platformServerPermissions(): CredPermissions {
  return {
    pub: { allow: [">"], deny: [] },
    sub: { allow: [">"], deny: [] },
  };
}

/**
 * The fence for a node that cannot be scoped to its agents' keys, because it
 * hosts agents it learns about after the credential is made: the A2A gateway,
 * which puts outside A2A agents on the mesh, and the old bundle's node-1.
 * Everything, minus the subjects nothing on a node has business with, and
 * minus publishing on the privileged subjects.
 */
export function fencedNodePermissions(): CredPermissions {
  const deny = [
    // Session bearer tokens are the KEYS in one of these buckets.
    "$KV.>",
    // Server monitoring and account events.
    "$SYS.>",
    // The object store.
    "$O.>",
    // The federation plane, reserved to peer credentials.
    "mesh.peer.>",
    // ACL room traffic rides per-room credentials; never a node's own.
    "mesh.aclroom.>",
    // What the core tells its operator (shared/ops-events.ts): facts, errors
    // and alerts between the server and whoever runs it, not a node's.
    "mesh.ops.>",
  ];
  return {
    pub: { allow: [">"], deny: [...deny, ADMIN_SUBJECTS] },
    sub: { allow: [">"], deny: [...deny] },
  };
}
