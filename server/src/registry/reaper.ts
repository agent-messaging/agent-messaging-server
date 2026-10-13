import type { Messaging } from "../storage/index.js";
import type { KeyedStore } from "../storage/index.js";
import type { Manifest } from "../sdk.js";
import { Subjects, createEnvelope, encode, signEnvelope } from "../sdk.js";
import { sealEnvelope } from "../shared/handler.js";
import type { nkeys } from "../sdk.js";
type KeyPair = ReturnType<typeof nkeys.createUser>;
import type { PresenceStore } from "./presence-store.js";
import type { ClearGuardFn, InboxBuffer } from "./inbox-buffer.js";

/**
 * Registry retention policy (SPEC §9.2): reclaim registrations that are
 * provably dead, on three rules — none of which can ever bite a healthy agent:
 *
 * 1. DEAD NODE, availability-aware: a node continuously offline beyond its
 *    class's TTL. Silence is damning for `always_on` (24h default); for
 *    `intermittent`/`on_demand`/undeclared nodes the leash is the vouch
 *    expiry itself — a sleeping laptop stays discoverable for as long as its
 *    buffered mail waits, and far beyond.
 * 2. EXPIRED VOUCH: the node attestation backing the registration has lapsed
 *    (§4.4). Reclaimable regardless of liveness; re-registration renews it.
 * 3. DEAD AGENT ON A LIVE NODE (reference-binding probe, SPEC §18.7): a
 *    signed probe request to the agent's inbox. Any reply — even an error —
 *    proves liveness (a live SDK agent always answers, if only with
 *    OFFERING_NOT_FOUND). The transport's no-responders signal would be
 *    definitive, but in this deployment it can never fire: the activity
 *    service wildcard-subscribes mesh.agent.*.inbox, so every inbox always
 *    has at least one (non-replying) subscriber. A probe that goes
 *    unanswered therefore times out instead — so unanswered probes count as
 *    strikes, and reclaim requires several consecutive silent sweeps to
 *    protect a merely-slow agent.
 *
 * Transient heartbeat misses NEVER delete a manifest — that stays presence's
 * concern (§9.6). Reclamation emits the same observable events as
 * deregistration.
 */
export class Reaper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly bootAt = Date.now();
  private readonly alwaysOnTtlMs = Number(process.env.REAPER_TTL_MS ?? 24 * 60 * 60 * 1000);
  private readonly sandboxTtlMs = Number(process.env.REAPER_SANDBOX_TTL_MS ?? 60 * 60 * 1000);
  private readonly intervalMs = Number(process.env.REAPER_INTERVAL_MS ?? 10 * 60 * 1000);
  private readonly probeTimeoutMs = Number(process.env.REAPER_PROBE_TIMEOUT_MS ?? 3000);
  /** Sweeps are 10min apart, so 3 strikes ≈ 30min of consecutive silence. */
  private static readonly PROBE_STRIKES = 3;
  /** Consecutive unanswered-probe strikes per agent id. */
  private strikes = new Map<string, number>();
  /**
   * When this instance first became AWARE of each registration.
   *
   * The clock for rule 1 when the hosting node has never heartbeated to us. It
   * used to be `bootAt` alone, which was right while the cache could only ever
   * contain what this instance had itself seeded or handled: a registration
   * arrived through `handleRegister`, which stamps the node online in presence,
   * so `presence.get(node)` always had a real timestamp for anything registered
   * during the run.
   *
   * That stopped being true when the cache started tracking the KV bucket
   * (manifest-watch.ts). A registration a PEER instance handled appears in this
   * instance's cache with no presence entry at all — the peer stamped presence in
   * ITS store, and a node that does not heartbeat produces nothing for ours. With
   * `bootAt` as the clock, an instance that has been up longer than the TTL would
   * measure that fresh registration's silence from its own boot and reclaim it on
   * the next sweep: a sandbox agent (1h TTL, and the class least likely to
   * heartbeat) registered through instance A could be reclaimed by instance B
   * seconds later. Cache coherence would then have made things worse than the
   * incoherence it fixed.
   *
   * Bounded by the cache: entries for agents no longer in it are dropped at the
   * end of each sweep.
   */
  private firstSeen = new Map<string, number>();

  constructor(
    private nc: Messaging,
    private kv: KeyedStore,
    private cache: Map<string, Manifest>,
    private presence: PresenceStore,
    private kp: KeyPair,
    private inboxBuffer?: InboxBuffer,
    /** Deletes a reclaimed agent's EXT-6 guard entry (see reclaim). */
    private clearGuard?: ClearGuardFn,
  ) {}

  private get serviceId(): string {
    return this.kp.getPublicKey();
  }

  start(): void {
    this.timer = setInterval(() => {
      this.sweep().catch((err) => console.error("[registry:reaper] sweep failed:", err));
    }, this.intervalMs);
    console.log(
      `[registry:reaper] active: always_on ttl=${this.alwaysOnTtlMs / 60000}min, sandbox ttl=${this.sandboxTtlMs / 60000}min, ` +
        `intermittent ttl=vouch expiry, probe timeout=${this.probeTimeoutMs}ms, every ${this.intervalMs / 60000}min`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<number> {
    const now = Date.now();
    let reaped = 0;

    for (const [id, manifest] of [...this.cache.entries()]) {
      const node = manifest.node?.id ?? manifest.id;
      // First sight of this registration, from this instance's point of view.
      // Always ≥ bootAt, so the "a restart reaps nothing for a full TTL" property
      // below is preserved rather than replaced.
      let knownSince = this.firstSeen.get(id);
      if (knownSince === undefined) {
        knownSince = now;
        this.firstSeen.set(id, now);
      }

      // Rule 2: expired vouch reclaims regardless of liveness.
      const expiresAt = Date.parse(manifest.node?.attestation?.expires_at ?? "");
      const vouchExpired = Number.isFinite(expiresAt) && expiresAt < now;

      if (this.presence.status(node) !== "offline") {
        // Live node. Rule 3: probe the agent's inbox unless the vouch already lapsed.
        if (vouchExpired) {
          await this.reclaim(id, manifest, node, "vouch expired");
          reaped++;
          continue;
        }
        if (await this.probeSaysDead(id)) {
          // Mail waiting is proof somebody still counts on this agent, and an
          // unanswered probe on a live node is most often that node failing
          // to subscribe, not the agent being gone. The planner was reclaimed
          // this way on 2026-09-29 with three plan requests in its mailbox,
          // and they went with it (technical debt 82). So it stays registered
          // with its mailbox, the strikes start again, and it is said.
          const waiting = await this.waitingFor(id);
          if (waiting !== 0) {
            this.strikes.delete(id);
            console.warn(`[registry:reaper] ${manifest.name} (${id.slice(0, 12)}...) did not answer ${Reaper.PROBE_STRIKES} probes and was NOT reclaimed: ${waiting === null ? "its mailbox could not be read" : `${waiting} message${waiting === 1 ? "" : "s"} wait in its mailbox`}`);
            continue;
          }
          await this.reclaim(id, manifest, node, `inbox unserved (${Reaper.PROBE_STRIKES} strikes)`, 0);
          reaped++;
        }
        continue;
      }

      // Offline node. Rule 1 (availability-aware TTL) or rule 2 (vouch expiry).
      if (vouchExpired) {
        await this.reclaim(id, manifest, node, "vouch expired");
        reaped++;
        continue;
      }
      const cls = manifest.node?.profile?.availability_class;
      let ttl: number | null;
      if (manifest.sandbox) ttl = this.sandboxTtlMs;
      else if (cls === "always_on") ttl = this.alwaysOnTtlMs;
      else ttl = null; // intermittent/on_demand/undeclared: vouch expiry is the only clock
      if (ttl === null) continue;

      // Node never seen -> measure silence from when we first knew of the
      // registration (≥ boot), so neither a restart nor a registration another
      // instance handled reaps anything until a full TTL of observed silence.
      const lastSeen = this.presence.get(node)?.last_seen ?? knownSince;
      if (now - lastSeen < ttl) continue;

      await this.reclaim(id, manifest, node, `node silent ${Math.round((now - lastSeen) / 60000)}min${manifest.sandbox ? " [sandbox]" : ""}`);
      reaped++;
    }

    // Forget registrations that are no longer in the cache — deregistered here,
    // or removed by a peer and applied through the watch. Without this the map
    // grows for the life of the process on a mesh with churn.
    if (this.firstSeen.size > this.cache.size) {
      for (const id of [...this.firstSeen.keys()]) {
        if (!this.cache.has(id)) this.firstSeen.delete(id);
      }
    }

    if (reaped > 0) console.log(`[registry:reaper] sweep done: ${reaped} reclaimed, ${this.cache.size} remain`);
    return reaped;
  }

  /** Signed probe to the agent's inbox. True only after PROBE_STRIKES
   *  consecutive unanswered sweeps. Any reply — even an error — resets the
   *  count. Both no-responders and timeout count as strikes: the activity
   *  tap's wildcard inbox subscription means no-responders can never fire
   *  here, so an unanswered probe surfaces as a timeout (see header note). */
  private async probeSaysDead(agentId: string): Promise<boolean> {
    let unanswered = false;
    try {
      const env = createEnvelope({
        type: "request",
        from: this.serviceId,
        to: agentId,
        payload: { offering: "__registry_probe__", input: null },
      });
      signEnvelope(env, this.kp);
      // Live: for the agent's node if it is listening now, never kept for one
      // that is away (on RabbitMQ the mailbox queue would otherwise hold it).
      await this.nc.request(Subjects.agentInbox(agentId), encode(env), { timeout: this.probeTimeoutMs, live: true });
    } catch {
      // No reply within the window (timeout or no-responders): a strike.
      unanswered = true;
    }
    if (!unanswered) {
      this.strikes.delete(agentId);
      return false;
    }
    const strikes = (this.strikes.get(agentId) ?? 0) + 1;
    this.strikes.set(agentId, strikes);
    return strikes >= Reaper.PROBE_STRIKES;
  }

  /** Messages waiting in an agent's mailbox: 0 with no buffer tier, null when it could not be read. */
  private async waitingFor(id: string): Promise<number | null> {
    if (!this.inboxBuffer || typeof this.inboxBuffer.pending !== "function") return 0;
    try {
      return await this.inboxBuffer.pending(id);
    } catch {
      return null;
    }
  }

  private async reclaim(id: string, manifest: Manifest, node: string, reason: string, known?: number | null): Promise<void> {
    const waiting = known === undefined ? await this.waitingFor(id) : known;
    await this.kv.purge(id).catch(() => undefined);
    this.cache.delete(id);
    this.strikes.delete(id);
    this.firstSeen.delete(id);
    // The offline-delivery buffer follows its registration (§16.4), but never
    // with mail in it: a mailbox holding messages is kept, so an agent that
    // registers again under the same key is handed what waited (ensure() is
    // idempotent), and the mailbox's own retention ages out what nobody
    // collects. A mailbox that could not be read counts as holding mail.
    if (this.inboxBuffer && waiting === 0) void this.inboxBuffer.remove(id);
    else if (this.inboxBuffer) reason = `${reason}; its mailbox was kept with ${waiting === null ? "an unknown number of" : waiting} message${waiting === 1 ? "" : "s"} waiting`;
    // And so does the EXT-6 guard entry. A guard entry claims the agent has left
    // its public inbox and that admission filters on its behalf; a reclaimed
    // agent has no registration and, when it comes back, comes back UNGUARDED
    // unless it asks again. An entry left behind has admission relaying to a
    // private subject nobody serves and the next re-registration's mailbox
    // pointed there too, while the returning agent takes unfiltered mail on its
    // public inbox. Reclaim is where most of the stale entries came from — the
    // reference instance holds 27, of which 25 have no manifest at all. Best
    // effort: a reap must not fail on the guard bucket.
    if (this.clearGuard) void this.clearGuard(id).catch(() => undefined);
    console.log(`[registry:reaper] reclaimed ${manifest.name} (${id.slice(0, 12)}...) — ${reason}`);

    // Signed like register's event (§4.5). Consumers decode() before acting, so
    // an unsigned reap was dropped with IDENTITY_MISMATCH and downstream state
    // kept showing a reclaimed agent as present — fail-open on the removal half
    // of the lifecycle.
    const eventEnv = createEnvelope({
      type: "emit",
      from: this.serviceId,
      payload: {
        domain: "registry",
        event_type: "agent_reaped",
        data: { agent_id: id, node, reason },
      },
    });
    this.nc.publish(Subjects.event("registry.agent_reaped"), sealEnvelope(eventEnv, this.kp));
  }
}
