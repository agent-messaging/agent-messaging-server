import { MeshError, ErrorCode } from "../types/errors.js";

/**
 * A single NATS subject token: no `.`, no `*`, no `>`, no whitespace, never
 * empty (§18.1). Every id this module interpolates into a subject MUST pass.
 *
 * A dot does not corrupt a subject, it *extends* it — an id carrying one
 * silently moves the publish into a neighbouring namespace, and `*`/`>` widen
 * a subscribe into everyone else's. That is how a remote requester's `task_id`
 * became a publish-anywhere primitive: `mesh.task.${taskId}.stream` with a
 * wire-supplied `taskId` let the sender pick the subject the victim published
 * its (genuinely signed) chunks onto. Every legitimate id here is already
 * token-safe by construction — base32 nkeys (A–Z, 2–7), UUIDv7 (hex + `-`),
 * base64url room ids — so this rejects nothing real.
 *
 * The check lives HERE, at the construction site, as well as at each call site
 * that accepts a value from the wire: a future caller cannot forget what it
 * cannot reach around.
 */
const SUBJECT_TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isSubjectToken(v: unknown): v is string {
  return typeof v === "string" && SUBJECT_TOKEN_RE.test(v);
}

/**
 * A concrete, publishable NATS subject (§14.4 resolution): non-empty
 * dot-joined tokens of printable ASCII, no wildcards, no whitespace. Resolved
 * endpoint values from a manifest's `endpoints` block are addressed verbatim
 * — that is the point of resolution, a future subject renaming must survive —
 * but a value that could not be a publish subject at all (a `*`/`>` would
 * make it a pattern, whitespace breaks the protocol line) falls back to
 * construction instead of being published.
 */
export function isPublishableSubject(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 512) return false;
  return v
    .split(".")
    .every((t) => t.length > 0 && /^[\x21-\x7e]+$/.test(t) && !t.includes("*") && !t.includes(">"));
}

function token(kind: string, v: string): string {
  if (!isSubjectToken(v)) {
    throw new MeshError(
      ErrorCode.INVALID_ENVELOPE,
      `${kind} is not a single NATS subject token (§18.1): ${JSON.stringify(v).slice(0, 64)}`,
    );
  }
  return v;
}

export const Subjects = {
  REGISTRY_REGISTER: "mesh.registry.register",
  REGISTRY_DEREGISTER: "mesh.registry.deregister",
  REGISTRY_DISCOVER: "mesh.registry.discover",

  registryGet(agentId: string): string {
    return `mesh.registry.get.${token("agent id", agentId)}`;
  },

  agentInbox(agentId: string): string {
    return `mesh.agent.${token("agent id", agentId)}.inbox`;
  },

  agentOutbox(agentId: string): string {
    return `mesh.agent.${token("agent id", agentId)}.outbox`;
  },

  taskUpdate(taskId: string): string {
    return `mesh.task.${token("task id", taskId)}.update`;
  },

  taskStream(taskId: string): string {
    return `mesh.task.${token("task id", taskId)}.stream`;
  },

  /** Event subjects are multi-token by design — a topic IS dotted, and a
   *  subscribe pattern legitimately carries `*`/`>`. The token rule cannot
   *  apply here; callers that build a topic out of an id (rooms) validate the
   *  id themselves before it gets this far. */
  event(topic: string): string {
    return `mesh.event.${topic}`;
  },

  /** Feed subject (§6.6a): `mesh.feed.{agent_id}.{topic}` — the owner-rooted
   *  event channel, exactly four tokens. Unlike `event()` above, a feed topic
   *  is ONE token and must never be split on dots: a dotted topic would
   *  smuggle a fifth token past the owner grant (`mesh.feed.<own key>.*`), so
   *  it is refused at the builder, never split. A wildcard is not a topic
   *  either — subscriptions that want "all of one agent's feeds" go through
   *  `feedPattern()`, which is the only place `*` is legitimate. */
  feed(agentId: string, topic: string): string {
    return `mesh.feed.${token("agent id", agentId)}.${token("feed topic", topic)}`;
  },

  /** The subscribe-side variant of `feed()`: identical grammar, plus exactly
   *  one extra shape — topic `"*"`, matching all of one agent's feeds (§6.6a,
   *  §6.7). Kept separate from `feed()` so a publish path can never widen
   *  itself into a pattern by accident. */
  feedPattern(agentId: string, topic: string): string {
    if (topic === "*") return `mesh.feed.${token("agent id", agentId)}.*`;
    return Subjects.feed(agentId, topic);
  },

  /** Parse a delivery subject as a feed (§6.6a): exactly four tokens,
   *  `mesh.feed.` prefix, a user nkey in the owner position, a single
   *  token-charset topic. Anything else — including the three-token lookup
   *  subject `mesh.feed.get` and the `mesh.event.` family — is not a feed
   *  and returns null. */
  parseFeedSubject(subject: string): { agent: string; topic: string } | null {
    if (typeof subject !== "string") return null;
    const parts = subject.split(".");
    if (parts.length !== 4 || parts[0] !== "mesh" || parts[1] !== "feed") return null;
    const [, , agent, topic] = parts;
    if (!/^U[A-Z2-7]{55}$/.test(agent)) return null;
    if (!isSubjectToken(topic)) return null;
    return { agent, topic };
  },

  /** State-feed current-value lookup (§18.3): request-reply, `{agent, topic}`
   *  in, `{found, envelope}` out. Three tokens, so it is never itself a feed. */
  FEED_GET: "mesh.feed.get",

  /** The optional stream-feed history stream (§18.3), the only stream bound
   *  to `mesh.feed.>`. */
  FEED_STREAM: "MESH_FEED",

  /** An agent's durable feed consumer on MESH_FEED (§18.6 Feed Consumer):
   *  ONE per agent, `mesh_feed_{agent_id}`, whose `filter_subjects` are the
   *  feeds it follows durably. Named for the agent, not the feed, because a
   *  credential can grant a consumer only by its whole name, and this is the
   *  one name known when the credential is minted. Cross-SDK contract. */
  feedConsumer(agentId: string): string {
    return `mesh_feed_${token("agent id", agentId)}`;
  },

  /** Node-scoped heartbeat (§9.6). */
  heartbeat(nodeId: string): string {
    return `mesh.heartbeat.${token("node id", nodeId)}`;
  },

  /** Node/agent liveness lookup (§9.6). */
  PRESENCE_GET: "mesh.presence.get",

  /** EXT-6 §7.1 admission control: ask for / stop mesh-side inbox filtering. */
  ADMISSION_GUARD: "mesh.admission.guard",
  ADMISSION_UNGUARD: "mesh.admission.unguard",

  /** The private subject a guarded agent listens on: the admission service
   *  subscribes the public inbox and relays what the roster allows here
   *  (EXT-6 §7). Nothing relays to it unless the service says it is guarding
   *  this agent, which is why the client must never assume it is. */
  agentInboxGuarded(agentId: string): string {
    return `mesh.agent.${token("agent id", agentId)}.inbox.guarded`;
  },
} as const;
