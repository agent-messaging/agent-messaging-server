import { messagingOf, type MessagingLike } from "../storage/index.js";
import type { BusMessage, BusSubscription, Messaging } from "../storage/index.js";
import type { Envelope } from "../sdk.js";
import {
  decode,
  createEnvelope,
  childSpan,
  Subjects,
  uuid7,
} from "../sdk.js";
import { sealEnvelope, idOf, subscribeWithHandler } from "../shared/handler.js";
import { serviceQueue } from "../shared/queue-groups.js";
import { identityFromEnv } from "../shared/seed.js";
import { AdmissionStore } from "./admission-store.js";
import { storageOf, type KeyedStore, type StorageLike } from "../storage/index.js";
import { InboxBuffer } from "../registry/inbox-buffer.js";
import { AgentStatusStore } from "../shared/agent-status.js";
import { StopAnswerer, answerStopped } from "./stop-answerer.js";
import { actOf, entryExpired, hasGrants, permits, readKnock, type GrantedEntry } from "./grants.js";

/** Ceiling on guarded inboxes. Each guard is a live subscription plus a KV entry
 *  replayed on every restart, and asking for one is free, so the count is
 *  bounded. Generous next to any real deployment; raise it with the mesh. */
const MAX_GUARDS = Number(process.env.ADMISSION_MAX_GUARDS ?? 500);

/** How long a relayed message may wait for the recipient. The sender's own
 *  deadline is what matters (the SDK's default request timeout is 30s), and a
 *  little margin over it is generous; the old 300s pinned one in-flight request
 *  per relayed message for five minutes past any sender's patience. The relay
 *  re-arms this once when the agent's §6.4a accept arrives (see relayGuarded):
 *  the accept resets the SENDER's clock to a full timeout too, so a relay that
 *  kept its original deadline would stop listening exactly when a slow-but-
 *  admitted answer still has a live, waiting caller. */
const RELAY_TIMEOUT_MS = Number(process.env.ADMISSION_RELAY_TIMEOUT_MS ?? 35_000);

/** What the relay reads off an admitted request: who sent it (the roster
 *  decision and the reply routing), which envelope it is (the benign ack's
 *  in_reply_to), and whether it is the reaper's probe (relayGuarded says why
 *  that one shape keeps the transport reply subject). */
interface RelayedRequest {
  type?: string;
  from?: string;
  id?: string;
  payload?: { offering?: string; skill?: string };
}

/**
 * EXT-6 admission: mesh-side, pre-delivery filtering for opted-in agents.
 *
 * A guarded agent stops subscribing its public inbox and subscribes a private
 * `.guarded` subject instead. This service subscribes the public inbox on its
 * behalf, checks the agent's stored roster, and:
 *   - relays anything not blocked to the `.guarded` subject (transparently, so
 *     the agent still sees the sender's original signed envelope), and
 *   - drops what the roster blocks (an explicit `block`, an over-rate sender, or
 *     the tier default resolving to block), answering with a benign ack so a
 *     blocked sender cannot tell it was refused.
 *
 * The nuanced hold/allow decision stays on the client (only the client knows
 * what a message costs it); the mesh's job is to stop the traffic that should
 * never arrive — spam and floods — before it reaches the agent at all.
 *
 * This puts the service in the delivery path for guarded agents, so it is
 * opt-in: an agent asks to be guarded (a signed request proving its identity),
 * and the guard list is persisted so it survives a restart.
 */
export class AdmissionService {
  private guards = new Map<string, BusSubscription>();
  private rate = new Map<string, number[]>();
  private regCache = new Map<string, { at: number; ok: boolean; owner: string | null }>();
  private ctrl: BusSubscription[] = [];
  private inboxBuffer: InboxBuffer;
  /** The kill switch (docs/kill-switch-plan.md item 3): each stopped agent's
   *  status, and the answerer that tells its senders. Null when the status
   *  bucket cannot be opened; then nothing is answered for stopped agents and
   *  senders see the silence they saw before. */
  private status: AgentStatusStore | null = null;
  private answerer: StopAnswerer | null = null;
  private stopFollow: (() => void) | null = null;

  private constructor(
    private nc: Messaging,
    private store: AdmissionStore,
    private js: StorageLike,
    private guardKv: KeyedStore,
    /** Signing identity (§4.5). Stable if ADMISSION_SEED is set; a set-but-
     *  unusable seed refuses to boot rather than falling back (shared/seed.ts). */
    private kp = identityFromEnv("ADMISSION_SEED"),
  ) {
    this.inboxBuffer = new InboxBuffer(storageOf(js, nc));
  }

  static async create(nc: MessagingLike, js: StorageLike): Promise<AdmissionService> {
    const store = await AdmissionStore.create(js);
    const guardKv = await storageOf(js).keyed("mesh_admission_guards");
    return new AdmissionService(messagingOf(nc), store, js, guardKv);
  }

  async start(): Promise<void> {
    // Through subscribeWithHandler, like every other service subject, so these
    // two share the shared NATS rate limiter: on a bare subscribe loop they were
    // the one control surface on the mesh nothing metered.
    //
    // NEITHER joins a queue group, which is unusual for a request/reply subject
    // and is the right answer here (shared/queue-groups.ts has the full
    // argument). What these two change is not a shared record but a LIVE
    // SUBSCRIPTION inside the instance that handles them — `guard` opens one on
    // the agent's public inbox, `unguard` closes it — so every instance has to
    // apply both or its local subscription set is wrong.
    //
    // Queueing `unguard` in particular would be an outright bug: instance A
    // would unsubscribe and delete the durable entry while instance B, which
    // subscribed the same inbox during its own boot replay, kept relaying. The
    // agent is by then back on its raw public inbox, so a request to it reaches
    // the agent AND B's stale relay, which forwards to a `.guarded` subject
    // nobody serves, times out, and answers the sender with the benign
    // "delivered to the recipient's inbox" ack — which the sender may keep in
    // place of the agent's real answer.
    //
    // The duplication broadcast does cause is benign and bounded: every effect
    // here is idempotent (`guard` early-returns on `this.guards.has`, the KV put
    // writes a constant, `setGuarded` sets a constant), all N instances reply
    // with the same constant payload and the requester keeps the first, and the
    // relay subscriptions the instances end up holding are themselves in a
    // per-agent queue group so exactly one of them relays each message. The cost
    // to name is that the shared rate limiter is charged once per instance per
    // control request, so N instances divide this subject's limit by N.
    this.ctrl.push(
      subscribeWithHandler(
        this.nc, "mesh.admission.guard", this.kp, (env) => this.onControl(env, true),
        undefined, undefined, serviceQueue("mesh.admission.guard"),
      ),
    );
    this.ctrl.push(
      subscribeWithHandler(
        this.nc, "mesh.admission.unguard", this.kp, (env) => this.onControl(env, false),
        undefined, undefined, serviceQueue("mesh.admission.unguard"),
      ),
    );
    await this.replayGuards();
    // The kill switch: answer senders for stopped agents, and refuse mail
    // from a stopped sender at the guard. Best-effort: without the bucket the
    // service runs as before.
    try {
      this.status = await AgentStatusStore.create(this.js);
      this.answerer = new StopAnswerer(this.nc, this.kp, (k) => this.guards.has(k));
      this.stopFollow = await this.status.follow((k, rec) => this.answerer?.onStatus(k, rec));
    } catch (err) {
      console.error(`[admission] agent status unavailable, stopped agents are not answered for: ${err instanceof Error ? err.message : err}`);
    }
    console.log(`[admission] service up (${idOf(this.kp).slice(0, 12)}…) · guarding ${this.guards.size}/${MAX_GUARDS}`);
  }

  /**
   * Re-guard every agent in the durable guard list. Throws if the list cannot be
   * read COMPLETELY, which is why it is a separate method with this comment.
   *
   * A guard entry is a claim that the agent has stopped listening on its public
   * inbox and that this service is filtering on its behalf. So an entry this
   * replay misses is not one less guarded agent — it is an agent nobody is
   * subscribed to at all: senders publish to `mesh.agent.<id>.inbox`, the agent
   * listens on the `.guarded` subject under it, and with no relay in between every
   * message to it is dropped in silence, for the life of the process, with the
   * console still showing the agent as registered and online.
   *
   * This used to be `for await (const k of await this.guardKv.keys(">"))` with the
   * subscribe, the KV write-back and the mailbox re-point all happening INSIDE the
   * loop. `kv.keys()` drops whatever the producer queued while the caller was
   * awaiting the previous batch (shared/kv.ts documents the mechanism), and it
   * drops more the slower the caller is — a caller awaiting 1 ms per key measured
   * 1 key of 500. Each iteration here awaits a subscription, a KV put and a
   * JetStream stream update, so this was the slowest caller in the codebase
   * reading the list whose incompleteness costs the most.
   *
   * `listKvKeys` throws rather than returning a subset, and the throw is NOT
   * caught here: `start()` is called unguarded from main.ts, so it becomes a boot
   * failure naming the bucket. That is deliberate. Booting with a partial list
   * produces black-holed agents nothing detects and nothing retries, while a
   * refusal to boot is visible in the first ten lines of the log and is fixed by
   * a restart once JetStream answers. No `minKeys` floor is passed because at
   * boot there is nothing independent to compare against — the helper's own
   * accounting (every subject the server listed resolved to live, tombstoned or
   * vanished) is what makes the list trustworthy.
   */
  private async replayGuards(): Promise<void> {
    let keys: string[];
    try {
      keys = (await this.guardKv.list()).keys;
    } catch (err) {
      console.error(
        "[admission] the guard list could not be read COMPLETELY, so this service " +
          "will not start: guarded agents whose entry was missed receive nothing at " +
          "all (they listen on the private subject and nobody relays to it). " +
          "Refusing to run half-guarded:",
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
    for (const k of keys) {
      // Replay is capped like live guarding.
      if (this.guards.size >= MAX_GUARDS) {
        console.error(
          `[admission] guard ceiling ${MAX_GUARDS} reached during replay; ` +
            `${keys.length - this.guards.size} entry(ies) NOT restored — those agents ` +
            `are unreachable until the ceiling is raised (ADMISSION_MAX_GUARDS)`,
        );
        break;
      }
      await this.guard(k);
    }
  }

  async stop(): Promise<void> {
    for (const s of this.ctrl) s.unsubscribe();
    for (const s of this.guards.values()) s.unsubscribe();
    this.stopFollow?.();
    this.answerer?.stop();
  }

  /**
   * guard/unguard control: authorized because the envelope's `from` is the agent
   * asking to guard its own inbox (a forged `from` fails signature verification
   * upstream). Guarding additionally requires the agent to be REGISTERED —
   * putting this service in a delivery path costs a live subscription and a KV
   * entry replayed on every restart, and registration is the one step that at
   * least ran the §4.4 vouch.
   *
   * A refusal answers NOTHING, on purpose. The client reads any reply at all as
   * "you are guarded" and then subscribes only the private `.guarded` subject,
   * so a spoken refusal would strand it on a subject nobody serves. Silence lets
   * its request time out and it keeps its public inbox.
   */
  private async onControl(env: Envelope, enable: boolean): Promise<Envelope | null> {
    const from = env.from;
    if (!from) return null;
    if (enable) {
      // Fresh lookup: a negative cached before the agent registered must not
      // lock it out of guarding for the cache's lifetime.
      if (!(await this.manifestInfo(from, true)).registered) {
        console.warn(`[admission] guard refused for unregistered ${from.slice(0, 12)}…`);
        return null;
      }
      if (!this.guards.has(from) && this.guards.size >= MAX_GUARDS) {
        console.error(`[admission] guard ceiling ${MAX_GUARDS} reached; refusing ${from.slice(0, 12)}…`);
        return null;
      }
      await this.guard(from);
    } else {
      await this.unguard(from);
    }
    return createEnvelope({
      type: "respond",
      from: idOf(this.kp),
      to: from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      payload: { output: { ok: true, guarded: enable } },
    });
  }

  private async guard(agentId: string): Promise<void> {
    const guardedSubject = `${Subjects.agentInbox(agentId)}.guarded`;
    // Already guarded: don't subscribe twice, but DO re-point the mailbox. A
    // deregister/reap deletes the agent's mailbox and the next register creates a
    // fresh one capturing the RAW inbox, while this service still believes the
    // agent is guarded — so the offline drain would replay exactly the traffic
    // admission dropped. That is the c07 defect arriving by a second path; the
    // early return that used to sit here is what let it through. (The registry
    // now also consults the guard list when it creates a mailbox — belt and
    // braces, because either side may act first.)
    if (this.guards.has(agentId)) {
      // Re-affirm the KV entry as well, and NOT only because a repeat put is
      // harmless: the registry now DELETES the entry when a registration ends
      // (deregister, reap), so deregister → re-register → re-guard reaches this
      // branch with a live subscription and no entry. Writing it back is what
      // keeps this service's memory and the durable list from disagreeing —
      // without it the guard survives only until the next admission restart,
      // whose replay would then find nothing, leaving the agent listening on a
      // private subject with nobody relaying to it. Silent and total.
      await this.guardKv.put(agentId, "1");
      await this.inboxBuffer.setGuarded(agentId, true);
      return;
    }
    // The relay, in a PER-AGENT queue group — the one subscription in the tree
    // where a missing queue group causes duplicate delivery to an AGENT rather
    // than merely a duplicate reply to a requester. Two admission instances both
    // guarding this agent both hold this subscription (the control subjects are
    // broadcast, so both applied the guard), and without a group both would
    // relay every message to `mesh.agent.<id>.inbox.guarded`: the agent would
    // handle each request twice, and each instance would separately await its own
    // reply and answer the sender, so a non-idempotent offering would run twice for
    // one request. In the group the server picks exactly one relay per message.
    //
    // The group name is derived from the subject, so it is per agent: instances
    // guarding different agents never share a group, and the two instances
    // guarding THIS agent always agree on the name without coordinating.
    const inboxSubject = Subjects.agentInbox(agentId);
    const sub = this.nc.subscribe(inboxSubject, { queue: serviceQueue(inboxSubject) });
    (async () => {
      for await (const msg of sub) await this.onInbox(agentId, guardedSubject, msg);
    })();
    this.guards.set(agentId, sub);
    await this.guardKv.put(agentId, "1");
    // Point the offline mailbox (§16.4) at the admission-filtered subject, so
    // buffered mail for an offline guarded agent is only what admission
    // approved — never the raw inbox the drain would otherwise replay.
    await this.inboxBuffer.setGuarded(agentId, true);
  }

  private async unguard(agentId: string): Promise<void> {
    this.guards.get(agentId)?.unsubscribe();
    this.guards.delete(agentId);
    try { await this.guardKv.delete(agentId); } catch { /* already gone */ }
    await this.inboxBuffer.setGuarded(agentId, false);
  }

  private async onInbox(recipientId: string, guardedSubject: string, msg: BusMessage): Promise<void> {
    let env: RelayedRequest | undefined;
    try { env = decode(msg.data) as unknown as RelayedRequest; } catch { return; }
    const from = env?.from;
    // The kill switch. A stopped recipient: its mailbox (pointed at the guarded
    // subject) keeps the mail when paused, and the sender is told either way.
    // A stopped sender: its mail is dropped here (§5.3), whatever the roster.
    const recipientStop = this.status ? await this.status.get(recipientId).catch(() => null) : null;
    if (recipientStop) {
      if (recipientStop.status === "paused") this.nc.publish(guardedSubject, msg.data);
      if (env) answerStopped(this.nc, msg, env, recipientId, recipientStop.status, this.kp);
      return;
    }
    const senderStop = from && this.status ? await this.status.get(from).catch(() => null) : null;
    if (senderStop) {
      if (env?.type === "request") this.benignAck(env, msg);
      return;
    }
    // A knock carries an identity and at most enumerated grant names, never
    // words (Common Agent §7.1, next version). One that carries anything
    // else is not a knock, and is refused here in words before any roster
    // is read; a well-formed knock still passes through whatever the tier.
    if (env?.type === "request" && actOf(env.payload).kind === "knock") {
      const read = readKnock((env.payload as { input?: unknown } | undefined)?.input);
      if (!read.ok) {
        this.refuseKnock(env, msg, read.why);
        return;
      }
    }
    const decision = from ? await this.decide(recipientId, from, env?.type === "request" ? env.payload : undefined, env?.type === "request") : "drop";
    if (decision === "relay") {
      await this.relayGuarded(recipientId, guardedSubject, env!, msg);
      return;
    }
    // Dropped: a request gets the benign ack so refusal reads as a normal
    // delivery. A dropped RESPOND gets silence - nothing is awaiting an answer
    // to an answer, and a queued ack for one would land in the responder's
    // inbox as an unclaimed curiosity.
    if (env?.type === "request") this.benignAck(env, msg);
  }

  /**
   * Relay one admitted message to the guarded subject and move the agent's
   * answers to where the sender can actually hear them (§6.4 hard cutover).
   *
   * The guarded delivery is one of the two reply-subject exceptions: the agent
   * answers THIS RELAY on the transport reply subject, because the relay is
   * the requester of record on the guarded hop. §6.4a means the first thing it
   * says there is the accept, with the substantive respond following - so the
   * old single-reply request here captured the accept and dropped the answer.
   * And forwarding either onto the SENDER's reply subject stopped meaning
   * anything: a §6.4 requester ignores every byte of data arriving there (the
   * SDK's awaitAgentReply classifies all reply-subject traffic "ignore"; the
   * subject survives only for the transport's no-responders verdict).
   *
   * So the relay subscribes a reply inbox of its own, collects the stream, and
   * moves bytes to the subjects the receiver contract actually reads:
   *
   *  - the §6.4a accept is republished VERBATIM to the sender's inbox - the
   *    exact subject it would have arrived on had the agent been unguarded -
   *    so the sender's accept handling (timeout reset, onAccept) works through
   *    a guard it cannot see;
   *  - the first substantive respond (anything that is not an accept: the
   *    answer, an error, an interactive agent's queued ack) is republished
   *    VERBATIM to the sender's inbox, where it correlates by in_reply_to like
   *    every other §6.4 respond.
   *
   * Verbatim is the security argument, not a shortcut. The envelope is already
   * signed by the agent and already names in_reply_to and the sender; the
   * relay admits and forwards, and it must never NEED to forge - so it moves
   * bytes between subjects and nothing else, and the sender's §6.2 binding
   * verifies the agent's signature, never ours. The same argument runs in
   * reverse for what the relay refuses to move: a reply on this inbox NOT
   * signed by the guarded agent is skipped, because anything with a credential
   * can publish to an `_INBOX.` subject and this relay must not launder a
   * third party's bytes onto a subject the sender trusts.
   *
   * One shape stays on the reply subject end to end: the reaper's
   * `__registry_probe__` (§18.7), the OTHER reply-subject exception. Its
   * caller is a single-reply `nc.request` whose whole protocol is "any reply
   * proves liveness", the agent answers it with no accept in front, and
   * re-routing that answer to an inbox the reaper never reads would reap every
   * guarded agent for silence.
   *
   * Time bound: RELAY_TIMEOUT_MS overall, re-armed once by the accept (the
   * constant's comment says why). Nothing heard at all by the deadline gets
   * the benign ack, exactly as the old timeout path did. Silence AFTER an
   * accept gets nothing more: a queued ack behind an accept would be a §6.4a
   * contradiction (an accept promises the handler is running, a queued ack
   * says nothing is), and the sender's own reset timeout already tells the
   * honest "admitted but never answered" story.
   */
  private async relayGuarded(
    recipientId: string,
    guardedSubject: string,
    env: RelayedRequest,
    msg: BusMessage,
  ): Promise<void> {
    // Only a REQUEST opens a reply collection. §6.4 routes RESPONDS through the
    // requester's inbox subject too, so a guarded agent's incoming answers all
    // pass through this relay now - and an answer is not a conversation opener:
    // nothing will ever speak on a reply inbox for one, so waiting the full
    // window per respond would stall this guard's serial delivery loop for 35s
    // per answer the agent receives, and the benign ack the old timeout path
    // sent would land as junk in the responder's inbox. Bytes across, done.
    if (env.type !== "request") {
      this.nc.publish(guardedSubject, msg.data);
      return;
    }
    // §8.5 deprecation window: pre-rename senders say `skill`.
    const probe = (env.payload?.offering ?? env.payload?.skill) === "__registry_probe__";
    // The true sender's inbox - where every non-probe answer now belongs.
    // `from` came out of a signature-verified envelope, so it is a real nkey;
    // the guard is against a subject-unsafe value ever reaching a publish.
    let senderInbox: string | null = null;
    if (env.from) {
      try { senderInbox = Subjects.agentInbox(env.from); } catch { senderInbox = null; }
    }

    const relayInbox = this.nc.newInbox();
    const sub = this.nc.subscribe(relayInbox);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      if (timer !== null) clearTimeout(timer);
      // Unsubscribing ends the iteration below; that IS the deadline firing.
      timer = setTimeout(() => sub.unsubscribe(), RELAY_TIMEOUT_MS);
    };
    arm();
    let sawAccept = false;
    let answered = false;
    try {
      this.nc.publish(guardedSubject, msg.data, { reply: relayInbox });
      for await (const reply of sub) {
        let renv: { from?: string; error?: unknown; payload?: { status?: string } } | undefined;
        try { renv = decode(reply.data) as typeof renv; } catch { continue; }
        if (renv?.from !== recipientId) continue; // not the agent's own signature - not ours to move
        if (!renv.error && renv.payload?.status === "accepted") {
          if (senderInbox) this.nc.publish(senderInbox, reply.data);
          if (!sawAccept) { sawAccept = true; arm(); } // re-arm ONCE - repeats must not hold this open
          continue;
        }
        if (probe) {
          if (msg.reply) msg.respond(reply.data);
        } else if (senderInbox) {
          this.nc.publish(senderInbox, reply.data);
        }
        answered = true;
        break;
      }
    } catch {
      // The subscription failed under us - indistinguishable from the deadline,
      // and handled the same way below.
    } finally {
      if (timer !== null) clearTimeout(timer);
      sub.unsubscribe();
    }
    // Recipient not listening / timed out with nothing said: the benign ack, so
    // the sender sees a normal queued delivery rather than a leak.
    if (!answered && !sawAccept) this.benignAck(env, msg);
  }

  /** Roster decision, mesh-side. Only ever returns drop for a definite block
   *  (explicit block entry, over-rate, or tier default = block); everything
   *  else relays and the client applies hold/allow. */
  private async decide(recipientId: string, from: string, payload?: unknown, isRequest = false): Promise<"relay" | "drop"> {
    // The roster that governs an agent is its OWNER's roster (an account managing
    // its agents' policy, core §4.9), keyed by the owner key. Fall back to the
    // agent's own key for a self-owned, client-signed roster.
    const owner = (await this.manifestInfo(recipientId)).owner;
    const roster = (owner ? await this.store.get(owner) : null) ?? await this.store.get(recipientId);
    const limits = (roster?.limits as { per_sender_per_hour?: number }) ?? {};
    if (this.overRate(recipientId, from, limits.per_sender_per_hour ?? 12)) return "drop";
    const entries = (roster?.entries as Array<{ subject: string; stance: string } & GrantedEntry>) ?? [];
    // A connection's entry that has run out is no entry: the sender meets
    // its tier default below, as a stranger would.
    const entry = entries.find((e) => e.subject === from && !(hasGrants(e) && entryExpired(e)));
    if (entry?.stance === "block") return "drop";
    if (entry && hasGrants(entry) && isRequest) {
      // A connection: what this message needs against what the connection
      // allows. The mesh enforces a projection: what it cannot read (a
      // sealed input) and an Errands order (whose per-order OK is the
      // recipient's to give) go on to the recipient's own client, which
      // applies the same rule (admission/grants.ts).
      const v = permits(entry, actOf(payload));
      return v.ok === false ? "drop" : "relay";
    }
    if (entry) return "relay";
    const defaults = (roster?.defaults as Record<string, string>) ?? { registered: "hold", anonymous: "block" };
    const tier = (await this.manifestInfo(from)).registered ? "registered" : "anonymous";
    const stance = defaults[tier] ?? (tier === "anonymous" ? "block" : "hold");
    return stance === "block" ? "drop" : "relay";
  }

  private overRate(recipient: string, from: string, perHour: number): boolean {
    const key = `${recipient}|${from}`;
    const now = Date.now();
    const hits = (this.rate.get(key) ?? []).filter((t) => now - t < 3600_000);
    if (hits.length >= perHour) { this.rate.set(key, hits); return true; }
    hits.push(now); this.rate.set(key, hits);
    return false;
  }

  /** Resolve an agent's registry manifest, cached: whether it is registered and
   *  the owner key it registered under. Used to classify a sender's tier and to
   *  find the roster that governs a recipient. `refresh` skips the cache read for
   *  the control path, where a stale negative would refuse a legitimate guard. */
  private async manifestInfo(
    agentId: string,
    refresh = false,
  ): Promise<{ registered: boolean; owner: string | null }> {
    const hit = refresh ? undefined : this.regCache.get(agentId);
    if (hit && Date.now() - hit.at < 300_000) return { registered: hit.ok, owner: hit.owner ?? null };
    let ok = false, owner: string | null = null;
    try {
      // Must be a valid SIGNED envelope: the registry decodes and verifies
      // before the handler runs, so an empty body fails validation and every
      // lookup returns an error — which silently classified EVERY sender as
      // anonymous (masked in production only because the fleet uses allow/allow
      // rosters). Found by conformance c07.
      const q = sealEnvelope(createEnvelope({ type: "discover", from: idOf(this.kp), payload: { agent_id: agentId } }), this.kp);
      const resp = await this.nc.request(Subjects.registryGet(agentId), q, { timeout: 2000 });
      const env = decode(resp.data) as { error?: unknown; payload?: { owner?: string } };
      ok = !env.error && !!env.payload;
      owner = (env.payload?.owner as string) ?? null;
    } catch { ok = false; }
    this.regCache.set(agentId, { at: Date.now(), ok, owner });
    return { registered: ok, owner };
  }

  /**
   * The courtesy "queued" respond a sender gets when its message will produce
   * no answer here - the roster dropped it, or the guarded agent never took
   * the relayed delivery. Shaped exactly like a node's §6.4a queued ack, so a
   * blocked sender cannot tell a refusal from a normal held delivery.
   *
   * Post-§6.4-cutover it goes to TWO places, because the two kinds of caller
   * listen in two places:
   *
   *  - The SENDER'S INBOX, which is where a §6.4 requester actually hears it.
   *    The SDK's awaitAgentReply classifies everything on the transport reply
   *    subject "ignore" (sdk-typescript/src/mesh.ts - the reply subject is
   *    liveness-only now), so a reply-subject copy alone would leave a new
   *    sender waiting out its full timeout instead of getting REQUEST_QUEUED.
   *    At the inbox the ack correlates by in_reply_to and is admitted despite
   *    being signed by this service's key rather than the agent's - the SDK's
   *    intermediary pin (§6.2) exists for exactly this ack.
   *  - The transport REPLY SUBJECT, kept as a delivery-status signal for
   *    single-reply callers that still read it. The reaper is the one that
   *    matters: its probe protocol counts ANY reply as liveness (§18.7), and
   *    dropping this copy would turn "guarded agent whose roster holds the
   *    registry's key" into three silent strikes and a reap.
   *
   * Both copies are the same signed bytes - this service says only what it
   * knows (delivery), under its own name.
   */
  /** A knock that carried words: refused in words, signed by this service,
   *  to the same two places the benign ack goes. */
  private refuseKnock(env: { id?: string; from?: string }, msg: BusMessage, why: string): void {
    const refusal = createEnvelope({
      type: "respond",
      from: idOf(this.kp),
      to: env.from,
      in_reply_to: env.id,
      payload: { output: { received: false, refused: true, code: "KNOCK_CARRIES_NO_MESSAGE", error: why } },
    });
    const bytes = sealEnvelope(refusal, this.kp);
    if (msg.reply) msg.respond(bytes);
    if (env.from) {
      try { this.nc.publish(Subjects.agentInbox(env.from), bytes); } catch { /* unaddressable sender */ }
    }
  }

  private benignAck(env: { id?: string; from?: string } | undefined, msg: BusMessage): void {
    const ack = createEnvelope({
      type: "respond",
      from: idOf(this.kp),
      to: env?.from,
      in_reply_to: env?.id,
      // The adapter's stranger sentence (mesh-adapter doorAnswer): true
      // whether the message was taken or dropped, which "Delivered" was not.
      payload: { output: { queued: true, inbox_id: uuid7(), text: "Sent; it reaches the recipient if the recipient admits you." } },
    });
    const bytes = sealEnvelope(ack, this.kp);
    if (msg.reply) msg.respond(bytes);
    if (env?.from) {
      // Same token guard as relayGuarded: a verified `from` is a real nkey,
      // and nothing subject-unsafe may reach a publish.
      try { this.nc.publish(Subjects.agentInbox(env.from), bytes); } catch { /* unaddressable sender */ }
    }
  }
}
