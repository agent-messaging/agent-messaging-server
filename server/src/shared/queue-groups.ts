/**
 * Queue groups — which service subjects are one-of-N and which are all-of-N.
 *
 * ## Why this file exists
 *
 * Core NATS delivers a published message to EVERY matching subscriber. So two
 * instances of a service subscribed to the same request subject each receive
 * every request, each run the handler, and each publish a reply to the
 * requester's reply subject. The requester keeps the first answer and discards
 * the rest, so the duplication is invisible from outside while every request is
 * served twice — charged twice, rate-limited twice, and for anything that
 * writes, applied twice. Members of a NATS queue group are instead treated as
 * one logical subscriber and the server picks exactly one per message.
 *
 * That makes the queue group a prerequisite for a second instance, not a tuning
 * knob: a service subject has to carry one BEFORE a second instance of that
 * service can be started.
 *
 * It is NOT something to blanket-apply. Several subjects here are broadcasts
 * that every instance legitimately needs to see, because each instance keeps
 * local in-memory state that the message updates. Putting one of those in a
 * queue group would leave every instance but the winner holding state that is
 * silently wrong — a worse failure than the duplication, because it is
 * unrecoverable rather than merely doubled. The `BROADCAST` list below is that
 * set, with the reason for each one written next to it.
 *
 * The decision lives HERE rather than at the call sites so that it is auditable
 * in one place and pinned by one test (`__tests__/unit/queue-groups.test.ts`).
 * Every subscription in `services/src` passes `serviceQueue(subject)`, including
 * the broadcast ones, where it returns `undefined` — so a reader can see at each
 * call site that the question was asked, and the answer is looked up rather than
 * spelled by hand.
 *
 * ## Naming convention
 *
 * A queue group name is derived MECHANICALLY from its subject:
 *
 *   1. drop the leading `mesh.`
 *   2. replace each wildcard token (`*`, `>`) with the literal `all`
 *
 * So `mesh.registry.register` → `registry.register`, `mesh.registry.get.*` →
 * `registry.get.all`, and `mesh.agent.<key>.inbox` → `agent.<key>.inbox`.
 *
 * Three properties this buys:
 *
 *  - **Predictable.** The name is a pure function of the subject, so nobody has
 *    to remember one and two instances cannot disagree about it. A NATS queue
 *    group is joined by NAME: two instances that spell it differently are not in
 *    the same group and the duplication comes straight back, silently.
 *  - **Unique per subject.** A queue group is scoped per subject, so sharing one
 *    name across subjects would be harmless — but `mesh.registry.register` and
 *    `mesh.registry.register.*` are two different channels for the same handler,
 *    and distinct names keep them distinguishable in `nats server report` output
 *    and in broker metrics.
 *  - **Grantable.** NATS expresses subscribe permissions as `subject queue`
 *    pairs, so a name that mirrors the subject makes a grant like
 *    `allow_sub: "mesh.registry.> registry.>"` write itself. Wildcards are
 *    replaced rather than kept because a literal `*` inside a queue NAME is then
 *    matched as a pattern by those grants, which is a trap nobody needs.
 */

/**
 * Subjects that must reach EVERY instance — no queue group.
 *
 * Matched as literal subscription strings, which is exactly the right
 * granularity: `mesh.agent.*.inbox` (the activity service's wildcard tap) and
 * `mesh.agent.<key>.inbox` (the admission service's per-agent relay) overlap on
 * the wire but are different subscriptions with opposite answers, and the
 * literal string is what tells them apart.
 */
const BROADCAST: ReadonlySet<string> = new Set([
  // ── The activity service's traffic taps ────────────────────────────────
  //
  // Correlation is per-instance and in-memory. `recordRequest` puts a row in
  // `this.entries` and a start time in `this.pending`; `recordResponse` finds
  // that row again by `in_reply_to`/`task_id` to stamp the duration, the
  // completed/failed status and the outbound message count, and to write the
  // one history event for the exchange. Both halves have to reach the SAME
  // instance or the second half finds nothing and returns early.
  //
  // Under a queue group with two instances that is what happens to roughly half
  // of all exchanges: the request lands on A, the response on B, and B has no
  // row for it — so the exchange keeps its optimistic "completed", never gets a
  // duration, never counts a response, and never records a history event. That
  // is per-exchange data loss nothing can reconstruct afterwards.
  //
  // Stated plainly, because it is the residual on this change: broadcast is the
  // only mode in which the tap WORKS, and it is still not enough to run two
  // activity instances. Every instance keeps its own ring (so
  // `mesh.activity.list` answers from a different half of the timeline
  // depending on who wins the query), every instance mints its own `uuid7()`
  // key for the same exchange (so the KV ring holds N copies of it and its
  // 500-row bound holds 500/N real exchanges), every instance counts the same
  // message into the usage counters, and every instance writes the same history
  // row. The queue group is not the mechanism that fixes any of that; splitting
  // the tap's durable writes out behind a single elected writer or a JetStream
  // durable consumer is, and that is a larger change than this one. Until then
  // the activity service runs single-instance, and this list is not the reason.
  "mesh.agent.*.inbox",
  "mesh.agent.*.outbox",

  // ── Node heartbeats (§9.6/§10.9) ──────────────────────────────────────
  //
  // Each registry instance keeps its OWN in-memory `PresenceStore`, and both
  // `mesh.registry.discover` and `mesh.registry.nodes.list` answer from it. A
  // queue group would split the heartbeat stream between instances, and the
  // 60-second staleness sweep on each side would then mark every node it did
  // not happen to hear from `offline` — so discovery would report agents online
  // or offline depending on which instance answered the query. Every instance
  // needs every heartbeat.
  //
  // The cost of broadcast, named: each instance emits its own
  // `presence.node_online`/`node_offline` event, so those events arrive N times.
  // They are advisory notifications rather than state transitions, and the
  // duplication follows from per-instance presence, which predates this change.
  "mesh.heartbeat.>",

  // ── Registry lifecycle events, as consumed by the catalog ──────────────
  //
  // The catalog's `this.cache` is an in-memory Map that is the WHOLE answer to
  // `mesh.catalog.list`, and these three events are the only thing that
  // invalidates it.
  //
  // A queue group on the removal events would resurrect exactly the bug the
  // removal listener was added to fix (safety item 6.3). Instance A takes
  // `agent_deregistered`, purges the KV key and drops the entry from ITS cache;
  // instance B never sees the event, so B's cache still holds the deregistered
  // agent's id, name and description — and serves them to whoever asks, for the
  // life of the process, from a KV key that no longer exists. "Delete my agent"
  // would reach the directory a stranger reads only half the time.
  //
  // The durable side is idempotent, which is what makes broadcast safe: N
  // instances each `kv.purge` an already-purged key (a rollup marker apiece,
  // harmless) or each `kv.put` the same entry (identical bytes, last write
  // wins). The one observable artefact is that an auto-catalogued entry's
  // `added_at`/`updated_at` can differ by a few milliseconds depending on which
  // instance's write landed last.
  "mesh.event.registry.agent_registered",
  "mesh.event.registry.agent_deregistered",
  "mesh.event.registry.agent_reaped",

  // ── EXT-6 admission control ───────────────────────────────────────────
  //
  // These look like request/reply, and they are, but the thing they change is
  // per-instance local state: `guard` creates a live subscription on the agent's
  // public inbox inside the instance that handles it, and `unguard` tears that
  // subscription down. So every instance has to apply both.
  //
  // Queueing `unguard` would be an outright bug. Instance A unsubscribes its
  // relay and deletes the durable entry; instance B, which subscribed the same
  // inbox during its own boot replay, keeps relaying. The agent has meanwhile
  // gone back to listening on its raw public inbox, so a request to it is now
  // received by the agent AND by B's stale relay — which forwards to a
  // `.guarded` subject nobody serves, times out, and answers the sender with a
  // benign "delivered to the recipient's inbox" ack. The sender may well take
  // that ack instead of the agent's real answer.
  //
  // Queueing `guard` would be milder but still wrong in the same direction:
  // only the winning instance would subscribe, so there would be no failover
  // until the other instance next restarts and replays the durable list.
  //
  // Broadcast is safe because every effect is idempotent and de-duplicated:
  // `guard` early-returns on `this.guards.has(agentId)`, `guardKv.put(id,"1")`
  // writes a constant, `setGuarded` sets a constant, and `guardKv.delete` is
  // wrapped for the already-gone case. The relay subscriptions the two
  // instances end up holding are themselves in a per-agent queue group (see
  // `serviceQueue` below), so exactly one of them relays each message — which
  // is the duplication that would actually have been visible to an agent, and
  // it is the one this change closes.
  //
  // Two costs, named. The shared NATS rate limiter is charged once per instance
  // per control request, so N instances divide the guard/unguard rate limit by
  // N; that is acceptable for an infrequent opt-in control operation. And all N
  // instances reply — the requester keeps the first, and the payload is a
  // constant `{ok:true, guarded:<bool>}`, so there is nothing to disagree
  // about.
  "mesh.admission.guard",
  "mesh.admission.unguard",
]);

/**
 * The queue group NAME for a subject, by the convention documented above.
 *
 * Pure and total: it names a group for any subject, including the broadcast
 * ones. Use `serviceQueue` to get the decision; this is only the naming.
 */
export function queueFor(subject: string): string {
  return subject
    .replace(/^mesh\./, "")
    .split(".")
    .map((token) => (token === "*" || token === ">" ? "all" : token))
    .join(".");
}

/** True if every instance must receive this subject's messages. */
export function isBroadcastSubject(subject: string): boolean {
  return BROADCAST.has(subject);
}

/**
 * The queue group a subscription on `subject` should join, or `undefined` when
 * every instance must see the message.
 *
 * The default is a queue group. That is the right default for this tree — of its
 * 34 subscription subjects, 26 are request/reply with one logical answer and the
 * 8 above are not — and it means a new request subject is safe for a second
 * instance the moment it is wired through here. A new subject that is genuinely a
 * broadcast observer has to be added to `BROADCAST` above, with its reason, or it
 * will be load balanced.
 */
export function serviceQueue(subject: string): string | undefined {
  return isBroadcastSubject(subject) ? undefined : queueFor(subject);
}
