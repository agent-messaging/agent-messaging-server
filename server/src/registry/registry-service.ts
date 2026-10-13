import { messagingOf, type MessagingLike } from "../storage/index.js";
import type { BusSubscription, Messaging } from "../storage/index.js";
import type { Manifest } from "../sdk.js";
import { Subjects } from "../sdk.js";
import { isStoreSettingError, keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";
import { AgentKeyRevocationStore } from "../shared/agent-key-revocations.js";
import { AgentStatusStore } from "../shared/agent-status.js";
import { boundKeyOf, subscribeWithHandler } from "../shared/handler.js";
import { serviceQueue } from "../shared/queue-groups.js";
import { identityFromEnv } from "../shared/seed.js";
import { normalizeLegacyManifest } from "./endpoints.js";
import { handleRegister } from "./handlers/register.js";
import { handleDeregister, removeRegistration } from "./handlers/deregister.js";
import { handleDiscover } from "./handlers/discover.js";
import { handleGet } from "./handlers/get.js";
import { IdentitySourceView } from "./identity-source-view.js";
import { handleNodesList } from "./handlers/nodes.js";
import { ADMIN_DEREGISTER, ADMIN_FORGET_DESCRIPTOR, ADMIN_LISTING, PRESENCE_FEED_KEY, PRESENCE_GET, handleAdminDeregister, handleAdminForgetDescriptor, handleAdminListing, handlePresenceFeedKey, handlePresenceGet } from "./handlers/admin.js";
import { coreUnlistedResolver, setUnlistedResolver } from "./unlisted.js";
import { DescriptorStore } from "./descriptor-store.js";
import {
  handleDescriptorPut,
  handleDescriptorGet,
  handleDescriptorByDigest,
} from "./handlers/descriptor.js";
import { EvalRecordStore } from "./eval-record-store.js";
import {
  handleEvalRecordPut,
  handleEvalRecordGet,
  handleEvalRecordByDigest,
} from "./handlers/eval-record.js";
import { HeartbeatMonitor } from "./heartbeat-monitor.js";
import { PresenceStore } from "./presence-store.js";
import { NodeProfileStore, parseNodeAttestations } from "./node-profile-store.js";
import { Reaper } from "./reaper.js";
import { ManifestWatch } from "./manifest-watch.js";
import { InboxBuffer, type ClearGuardFn, type GuardStateFn } from "./inbox-buffer.js";
import { FeedStateService, FeedStateStore } from "../shared/feed-state.js";
import { PresenceFeedStore, PresenceFeedPublisher } from "./presence-feed.js";

/**
 * Read one agent's EXT-6 guard state out of the guard bucket.
 *
 * Three answers, not two. A read that FAILED is `"unknown"`, never `false`:
 * `false` licenses the inbox buffer to re-point that agent's mailbox at the raw,
 * unfiltered inbox, so collapsing a transient KV error into it would undo a guard
 * and log it as a routine heal. Same defect shape as the seed-file catch that
 * `shared/seed.ts` exists to remove — a catch that cannot tell absent from
 * broken, failing toward the unsafe branch.
 */
export function guardStateResolver(guardKv: KeyedStore): GuardStateFn {
  return async (agentId) => {
    try {
      const entry = await guardKv.get(agentId);
      // A deleted key still resolves, as a DEL entry — only a live PUT means
      // guarded.
      return entry?.operation === "PUT";
    } catch (err) {
      console.error(
        `[registry] guard-state lookup failed for ${agentId.slice(0, 12)}…, treating as UNKNOWN ` +
          `(the mailbox keeps whatever subject it has):`,
        err instanceof Error ? err.message : err,
      );
      return "unknown";
    }
  };
}

/**
 * Delete one agent's EXT-6 guard entry — the only write the registry makes on the
 * guard bucket, handed to deregister and the reaper as a single verb rather than
 * as the bucket itself.
 *
 * A guard entry claims the agent has stopped listening on its public inbox and
 * that admission is filtering on its behalf. When a registration ends, both
 * halves of that claim stop being true, so the entry has to go with it: until
 * this existed, guard state was write-only, and 25 of the 27 entries on the
 * reference instance belong to agents with no manifest at all.
 */
export function guardEntryClearer(guardKv: KeyedStore): ClearGuardFn {
  return async (agentId) => {
    await guardKv.delete(agentId);
  };
}

export class RegistryService {
  /** The registry's signing identity (§4.5). Stable if REGISTRY_SEED is set,
   *  else ephemeral per run; a set-but-unusable seed refuses to boot rather
   *  than falling back (shared/seed.ts). Its public nkey is the service `from`. */
  private readonly kp = identityFromEnv("REGISTRY_SEED");
  private readonly SERVICE_ID = this.kp.getPublicKey();
  /**
   * In-memory manifest cache. The authoritative answer to every discover query
   * for the life of this instance.
   *
   * PER INSTANCE, not module-global — which is the honest shape and also the only
   * one that can be tested: a shared module-level Map would make two in-process
   * instances agree for a reason that does not exist between two machines.
   *
   * Three things write it. The boot seed (`seedCache`, through
   * `snapshotKvBucket`, which throws rather than returning a short read); the
   * handlers, for the registrations this instance itself serves; and
   * `ManifestWatch`, for everything else that changes the `mesh_registry` bucket
   * — the registrations a PEER instance handled under a queue group, and admin
   * writes that emit no event. See manifest-watch.ts for why that is a KV watch
   * rather than a subscription to the registry's own lifecycle events.
   *
   * Discovery does not read KV per query. Not because enumeration is unreliable
   * (that was `kv.keys()`, and it is no longer used here) but because discover
   * filters across the whole directory, so a KV-per-query registry costs one
   * round trip per registered agent per query — and the vouch lookup on the
   * heartbeat path, which runs per heartbeat per node, would become a KV read
   * too.
   */
  private readonly cache = new Map<string, Manifest>();
  private subs: BusSubscription[] = [];
  private heartbeatMonitor: HeartbeatMonitor;
  /** Keeps `cache` in step with the KV bucket, including a peer's writes. */
  private manifestWatch: ManifestWatch;
  /** Node liveness — separate from the manifest registry (§9.6). */
  private presence = new PresenceStore();
  /** Node profiles — durable hosting conditions joined into discovery (§9.7).
   *  Attested attributes (trust_tier, role) seed from operator config: the
   *  NODE_ATTESTATIONS env var maps node public keys to attested attributes. */
  private profiles = new NodeProfileStore();
  /** Where each agent's identity came from (§9.7 identity_source), from the
   *  key chain's record, joined into discovery and get. */
  private identitySources = new IdentitySourceView(null);
  /** Retention policy (§9.2): reclaims long-dead registrations. */
  private reaper: Reaper;
  /** State feeds (§6.6a): the durable writer + `mesh.feed.get` responder.
   *  Null when feeds could not start; everything else runs without them. */
  private feedState: FeedStateService | null = null;
  /** Presence as a derived feed (docs/presence-feed.md; tracker 184).
   *  Null when off (no at-rest key); presence stays lookup-only then. */
  private presenceFeed: PresenceFeedPublisher | null = null;
  /** Per-agent offline-delivery buffers (§16.4): created with registration,
   *  deleted with it. */
  private inboxBuffer: InboxBuffer;
  /** Agent Descriptor storage (Common Agent spec §6.7): current per subject,
   *  every stored version by digest. Set in create(), before start(). */
  private descriptors!: DescriptorStore;
  /** Evaluation record storage (Common Agent spec §9.4): latest signed verdict
   *  per subject, every stored record by digest. Set in create(), before
   *  start(). */
  private evalRecords!: EvalRecordStore;
  /** Revoked agent signing keys (§5.3): answered on get, refused on register.
   *  Undefined when the bucket could not be opened; then neither door checks,
   *  and receivers keep what they already know is revoked. */
  private keyRevocations?: AgentKeyRevocationStore;
  /** The kill switch's per-agent status: paused and terminated agents. */
  private agentStatus?: AgentStatusStore;
  /** Deletes one agent's EXT-6 guard entry. The one write the registry does on
   *  the guard bucket, handed to deregister and the reaper as a single verb
   *  rather than as the bucket: a guard entry describes a subscription that a
   *  reclaimed or deregistered agent no longer has, so it must go when the
   *  registration goes. Undefined when the bucket is not available. */
  private clearGuard?: ClearGuardFn;

  private kv: KeyedStore;

  constructor(
    private nc: Messaging,
    private js: StorageLike,
    kv: KeyedLike,
    /** EXT-6 guard list. Read for guard state (a recreated mailbox must inherit
     *  the guard state admission still believes is in force) and, through
     *  `clearGuard`, deleted from when a registration ends. Absent when the
     *  admission service has never run on this deployment. */
    guardKv?: KeyedStore,
  ) {
    this.kv = keyedOf(kv, js);
    // Presence records what a HEARTBEAT proves; the vouch recorded at register
    // is what lets the monitor accept a heartbeat an agent sends for its node
    // (§9.6) without accepting one anybody sends for anybody's node.
    this.heartbeatMonitor = new HeartbeatMonitor(
      nc,
      this.kp,
      this.presence,
      (agentId) => this.cache.get(agentId)?.node?.id,
      // The presence feed's whole input: the join's flips, fanned to the
      // node's agents. Null publisher = the calls do nothing.
      (node, presence) => this.presenceFeed?.nodeFlip(node, presence),
    );
    this.manifestWatch = new ManifestWatch(
      this.kv,
      this.cache,
      undefined,
      // Every removal path (deregister, reaper, admin purge) flows through
      // the watch — the one honest hook for the presence feed's final
      // offline + stored-value purge (docs/presence-feed.md, hygiene).
      (key) => void this.presenceFeed?.forgetAgent(key),
    );
    this.inboxBuffer = new InboxBuffer(storageOf(js, nc), guardKv ? guardStateResolver(guardKv) : undefined);
    // Best effort at every call site, never rethrown: a guard entry that survives
    // one failed delete is still reconciled later — the agent's own SDK revokes it
    // on its next registration (EXT-6 §7.1), and the next deregister/reap tries
    // again.
    this.clearGuard = guardKv ? guardEntryClearer(guardKv) : undefined;
    this.reaper = new Reaper(
      nc,
      this.kv,
      this.cache,
      this.presence,
      this.kp,
      this.inboxBuffer,
      this.clearGuard,
    );
  }

  /** Seed attested node profiles (§9.7) from the operator's NODE_ATTESTATIONS.
   *  A node attested `trust_tier: "sandbox"` is a shared throwaway credential:
   *  a holder that re-registers is treated as the throwaway it is, not as a
   *  new unnamed agent. AgentMesh attests the credentials its retired guest
   *  pool lent this way, for as long as they can still connect
   *  (ecosystem.config.cjs). Read at boot. */
  private async seedAttestedProfiles(): Promise<void> {
    const attested = parseNodeAttestations(process.env.NODE_ATTESTATIONS);
    this.profiles.seedAttested(attested);
    const sandbox = [...attested.values()].filter((a) => a.trust_tier === "sandbox").length;
    if (sandbox > 0) console.log(`[registry] ${sandbox} node key(s) attested as trust_tier=sandbox by the operator`);
  }

  /**
   * Seed the in-memory cache from KV at boot.
   *
   * This is the load that must not come back short. The cache is the
   * authoritative answer to every discover query for the life of the process, so
   * a partial seed does not degrade discovery — it makes registered agents
   * undiscoverable until they re-register, and it makes the reaper's "no
   * manifest" test true for agents that have one. `snapshotKvBucket` throws
   * rather than returning a subset (see shared/kv.ts for why `kv.keys()` could
   * not), and a throw here is loud and recoverable: the service reports it and
   * the operator restarts, instead of running on a plausible half of the
   * registry.
   *
   * A cache seeded from a short read is incoherent from its first second no
   * matter what the watch does afterwards — the watch only carries CHANGES
   * forward, so a key that was missed here and never written again stays missing.
   */
  private async seedCache(): Promise<void> {
    try {
      const snapshot = await this.kv.list();
      for (const [key, entry] of snapshot.entries) {
        try {
          // §8.5 deprecation window: stored pre-rename manifests normalize on read.
          this.cache.set(key, normalizeLegacyManifest(entry.json<Manifest>()));
        } catch {
          // Skip corrupt entries
        }
      }
      console.log(
        `[registry] loaded ${this.cache.size} agents from KV into cache ` +
          `(${snapshot.subjects} subject(s), ${snapshot.tombstoned.length} tombstoned)`,
      );
    } catch (err) {
      // Distinguishable from an empty bucket, which the old catch could not do:
      // an empty bucket snapshots successfully with zero entries and never
      // reaches here.
      console.error(
        "[registry] KV cache seed FAILED — discovery will not see agents that " +
          "registered before this restart until they register again:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  static async create(
    nc: MessagingLike,
    js: StorageLike,
  ): Promise<RegistryService> {
    const storage = storageOf(js);
    const kv = await storage.keyed("mesh_registry");

    // The EXT-6 guard list, read-only here. Same bucket and options the
    // admission service uses, created rather than bound because the registry
    // usually starts first and a mailbox created before the bucket exists would
    // not know it should capture the filtered subject. A registry running
    // without admission just sees an empty bucket.
    let guardKv: KeyedStore | undefined;
    try {
      guardKv = await storage.keyed("mesh_admission_guards");
    } catch (err) {
      // A replica count the cluster cannot satisfy is an operator error to fix
      // at boot, not a degraded mode to run in for the life of the process — so
      // it goes through this catch rather than into it. Everything else really
      // is optional here (a registry with no admission service just sees an
      // empty bucket).
      if (isStoreSettingError(err)) throw err;
      guardKv = undefined;
    }

    const svc = new RegistryService(messagingOf(nc), js, kv, guardKv);
    svc.descriptors = await DescriptorStore.create(js);
    svc.evalRecords = await EvalRecordStore.create(js);
    try {
      svc.keyRevocations = await AgentKeyRevocationStore.create(js);
    } catch (err) {
      if (isStoreSettingError(err)) throw err;
      console.error(`[registry] agent key revocations unavailable, get and register will not check them: ${(err as Error).message}`);
    }
    // The kill switch's per-agent status (docs/kill-switch-plan.md item 3):
    // get says paused or terminated, register refuses a terminated agent.
    try {
      svc.agentStatus = await AgentStatusStore.create(js);
    } catch (err) {
      if (isStoreSettingError(err)) throw err;
      console.error(`[registry] agent status unavailable, get and register will not say paused or terminated: ${(err as Error).message}`);
    }
    // Baseline first, then `start()` opens the watch that carries it forward. Any
    // write that lands between the two is covered: the watch's default replay is
    // the last value of every key, so it re-reads the bucket as it stands when it
    // opens (manifest-watch.ts).
    await svc.seedCache();
    await svc.seedAttestedProfiles();
    try {
      svc.identitySources = new IdentitySourceView(await storage.keyed("mesh_identity_sources"));
    } catch (err) {
      if (isStoreSettingError(err)) throw err;
      console.error(`[registry] identity sources are not available, so discovery carries none: ${(err as Error).message}`);
    }
    // Which agents discover never lists, from the core's own stores (the
    // ownership record and the key chain's tombstones, unlisted.ts). Never
    // fatal: without them discover drops nothing, as it did with no resolver.
    try {
      setUnlistedResolver(await coreUnlistedResolver(js));
    } catch (err) {
      if (isStoreSettingError(err)) throw err;
      console.error(`[registry] the unlisted answer is not available, so discover lists every agent: ${(err as Error).message}`);
    }
    return svc;
  }

  async start(): Promise<void> {
    // Track the KV bucket for changes THIS instance did not make — a peer
    // instance's registrations and deregistrations (queue groups send each
    // request to exactly one of us) and admin writes that emit no event.
    // Deliberately first: from here on, every write to `mesh_registry` reaches
    // this cache, whoever made it.
    //
    // This is NOT an `nc.subscribe`, so queue-groups.ts does not apply to it —
    // but the same reasoning does, one level down. Each instance opens its own
    // ephemeral ordered consumer, so every instance sees every change; a shared
    // consumer would be the load-balanced case, and would leave whichever
    // instance lost each message serving a directory missing that agent.
    await this.manifestWatch.start();
    await this.identitySources.start();

    // §13.1.1 span buffer. Idempotent and no-ops unless TRACE_STREAM_ENABLED,
    // so every instance can call it and a deployment nobody asked for spans in
    // carries no stream at all.
    const storage = storageOf(this.js, this.nc);
    await storage.stream("MESH_TRACE").ensure();

    // State feeds (§6.6a): the MESH_FEED stream, the current-value writer, and
    // the `mesh.feed.get` responder. Started here because feeds are
    // presence-shaped — a small derived fact served over request-reply — and
    // the registry is presence's home. Fail-soft: a registry without feeds is
    // still a registry.
    this.feedState = await FeedStateService.start(this.nc, storage, this.kp);

    // Presence as a derived feed (tracker 184; the design gate is
    // docs/presence-feed.md). Transitions only, fanned from the node's join
    // flip to its registered agents' topics; the value carries its own
    // stale_after. Fail-soft like everything else here.
    try {
      this.presenceFeed = await PresenceFeedPublisher.start(
        this.nc,
        await PresenceFeedStore.create(this.js),
        await FeedStateStore.open(this.js).catch(() => null),
        (node) => {
          const out: string[] = [];
          for (const [id, m] of this.cache) {
            if (id === node || m.node?.id === node) out.push(id);
          }
          return out;
        },
      );
    } catch (err) {
      console.error("[presence-feed] not running:", err instanceof Error ? err.message : err);
    }

    // Every subscription below joins a queue group (shared/queue-groups.ts), so
    // exactly one registry instance answers each request. All six of these are
    // request/reply with one logical answer, and four of them WRITE: without a
    // group, two instances would each run `handleRegister` for the same request
    // — two KV writes, two presence updates, two mailbox creations and two
    // `agent_registered` events for one registration — and the requester would
    // see one reply and none of it.
    //
    // The heartbeat monitor started at the bottom of this method deliberately
    // does NOT join one; `mesh.heartbeat.>` is a broadcast and queue-groups.ts
    // says why.

    // Register handler. The trailing `{}` wires the naming rule (SPEC §6.2,
    // MESH_REQUIRE_NAMES in shared/require-names.ts): on or off is read live.
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        Subjects.REGISTRY_REGISTER,
        this.kp,
        (env, msg) => handleRegister(env, this.kv, this.nc, this.kp, this.cache, this.presence, this.profiles, this.inboxBuffer, msg, {}, this.keyRevocations, this.agentStatus),
        undefined,
        undefined,
        serviceQueue(Subjects.REGISTRY_REGISTER),
      ),
    );

    // The same handler on the connection-bound channel (§4.4 (b)): a credential
    // minted with `allow_pub: mesh.registry.register.<its own key>` cannot
    // publish under another key's token, which makes the trailing token the only
    // connection identity a core-NATS subscriber can see. Inert until credentials
    // are minted that way — nothing publishes here otherwise — and the request
    // is rate-limited against that key as well as the envelope sender.
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        `${Subjects.REGISTRY_REGISTER}.*`,
        this.kp,
        (env, msg) => handleRegister(env, this.kv, this.nc, this.kp, this.cache, this.presence, this.profiles, this.inboxBuffer, msg, {}, this.keyRevocations, this.agentStatus),
        undefined,
        (msg) => boundKeyOf(msg, Subjects.REGISTRY_REGISTER),
        // A DIFFERENT group from the un-tokenized subject above: the two are
        // separate channels for the same handler, and distinct names keep them
        // apart in broker metrics. (Queue groups are scoped per subject, so
        // sharing a name would also have worked; see queue-groups.ts.)
        serviceQueue(`${Subjects.REGISTRY_REGISTER}.*`),
      ),
    );

    // Deregister handler
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        Subjects.REGISTRY_DEREGISTER,
        this.kp,
        // The keypair, not the bare id: the lifecycle event it emits must be
        // signed (§4.5) or consumers drop it at decode().
        (env) =>
          handleDeregister(
            env,
            this.kv,
            this.nc,
            this.kp,
            this.cache,
            this.inboxBuffer,
            this.clearGuard,
          ),
        undefined,
        undefined,
        serviceQueue(Subjects.REGISTRY_DEREGISTER),
      ),
    );

    // Discover handler — reads from in-memory cache, not KV
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        Subjects.REGISTRY_DISCOVER,
        this.kp,
        (env) => handleDiscover(env, this.SERVICE_ID, this.cache, this.presence, this.profiles, this.identitySources),
        undefined,
        undefined,
        serviceQueue(Subjects.REGISTRY_DISCOVER),
      ),
    );

    // Get agent by ID handler (wildcard: mesh.registry.get.*)
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        "mesh.registry.get.*",
        this.kp,
        (env, msg) => handleGet(env, msg, this.kv, this.SERVICE_ID, this.cache, this.keyRevocations, this.agentStatus, this.identitySources),
        undefined,
        undefined,
        serviceQueue("mesh.registry.get.*"),
      ),
    );

    // Removing a registration on its owner's authority (handlers/admin.ts).
    // Privileged by the broker: only the platform's NATS user may publish on
    // mesh.admin.>. Replaces the in-process link the API used while it shared
    // this process.
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        ADMIN_DEREGISTER,
        this.kp,
        (env) => handleAdminDeregister(env, this.SERVICE_ID, (k) => this.deregisterOwned(k)),
        undefined,
        undefined,
        serviceQueue(ADMIN_DEREGISTER),
      ),
    );
    // Who a registration is shown to, set by the platform (the owner's
    // audience switch, AgentMesh's own agents listed for everyone).
    // Privileged like the door above.
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        ADMIN_LISTING,
        this.kp,
        (env) => handleAdminListing(env, this.SERVICE_ID, this.kv, this.cache),
        undefined,
        undefined,
        serviceQueue(ADMIN_LISTING),
      ),
    );
    // An agent's current descriptor, dropped when its account closes.
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        ADMIN_FORGET_DESCRIPTOR,
        this.kp,
        (env) => handleAdminForgetDescriptor(env, this.SERVICE_ID, (k) => this.descriptors.forget(k)),
        undefined,
        undefined,
        serviceQueue(ADMIN_FORGET_DESCRIPTOR),
      ),
    );
    // The presence feed's owner key, for the API's feeds list.
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        PRESENCE_FEED_KEY,
        this.kp,
        async (env) => handlePresenceFeedKey(env, this.SERVICE_ID, () => this.presenceFeedKey()),
        undefined,
        undefined,
        serviceQueue(PRESENCE_FEED_KEY),
      ),
    );
    // §9.6 presence lookup, from this instance's presence store. Every
    // instance hears every heartbeat (no queue group there, below), so any
    // one of them may answer.
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        PRESENCE_GET,
        this.kp,
        async (env) => handlePresenceGet(env, this.SERVICE_ID, this.presence),
        undefined,
        undefined,
        serviceQueue(PRESENCE_GET),
      ),
    );

    // Node inventory (§9.6/§9.7) — operator read joining profiles + presence.
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        "mesh.registry.nodes.list",
        this.kp,
        (env) => handleNodesList(env, this.SERVICE_ID, this.cache, this.presence, this.profiles),
        undefined,
        undefined,
        serviceQueue("mesh.registry.nodes.list"),
      ),
    );

    // Agent Descriptor storage (Common Agent spec §6.7): an agent submits its
    // own current descriptor, anyone fetches the current one for a subject or
    // any stored version by digest.
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        "mesh.registry.descriptor.put",
        this.kp,
        (env) => handleDescriptorPut(env, this.descriptors, this.nc, this.kp),
        undefined,
        undefined,
        serviceQueue("mesh.registry.descriptor.put"),
      ),
    );
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        "mesh.registry.descriptor.get.*",
        this.kp,
        (env, msg) => handleDescriptorGet(env, msg, this.descriptors, this.SERVICE_ID),
        undefined,
        undefined,
        serviceQueue("mesh.registry.descriptor.get.*"),
      ),
    );
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        "mesh.registry.descriptor.digest.*",
        this.kp,
        (env, msg) => handleDescriptorByDigest(env, msg, this.descriptors, this.SERVICE_ID),
        undefined,
        undefined,
        serviceQueue("mesh.registry.descriptor.digest.*"),
      ),
    );

    // Evaluation records (Common Agent spec §9.4): an evaluator submits its
    // signed verdict about a subject, anyone fetches the latest one for a
    // subject or any stored record by digest.
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        "mesh.registry.eval.put",
        this.kp,
        (env) => handleEvalRecordPut(env, this.evalRecords, this.nc, this.kp),
        undefined,
        undefined,
        serviceQueue("mesh.registry.eval.put"),
      ),
    );
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        "mesh.registry.eval.get.*",
        this.kp,
        (env, msg) => handleEvalRecordGet(env, msg, this.evalRecords, this.SERVICE_ID),
        undefined,
        undefined,
        serviceQueue("mesh.registry.eval.get.*"),
      ),
    );
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        "mesh.registry.eval.digest.*",
        this.kp,
        (env, msg) => handleEvalRecordByDigest(env, msg, this.evalRecords, this.SERVICE_ID),
        undefined,
        undefined,
        serviceQueue("mesh.registry.eval.digest.*"),
      ),
    );

    // Start heartbeat monitoring. NO queue group on `mesh.heartbeat.>` — each
    // instance keeps its own presence store and the two handlers above answer
    // from it, so a split heartbeat stream would have each instance marking the
    // nodes it did not hear from offline (queue-groups.ts).
    this.heartbeatMonitor.start();
    this.reaper.start();

    console.log("[registry] service started (12 subjects + heartbeat monitor + manifest watch)");
  }

  /**
   * Deregister an agent on its OWNER's authority rather than its own.
   *
   * `mesh.registry.deregister` takes the agent id from `env.from`, which decode
   * has verified against the envelope signature — so only the holder of the
   * agent's seed can ever use it. That is right for the protocol and useless for
   * account closure: the account record holds its agents' PUBLIC keys and no
   * seeds, so a closing account could not remove a single registration. Agents
   * stayed registered and discoverable after their owner left, which is the
   * first half of safety item 6.6.
   *
   * There is deliberately NO subject for this. The account console reaches it
   * in-process (main.ts hands the API service this method when both run in the
   * same process, which is the shipped deployment), so the power to remove
   * somebody else's registration is not published on the bus at all — no new
   * subject to authorize, no new key to hold, and nothing an agent that can
   * publish `mesh.registry.>` can reach. The cost is stated where it lands: an
   * API service running in a SEPARATE process from the registry gets no
   * capability, and the closure report tells the user their agents are still
   * registered. It does not pretend otherwise.
   *
   * Idempotent: an agent with no registration is already in the desired state,
   * so this resolves rather than throwing, and a closure that half-failed can be
   * retried end to end.
   */
  async deregisterOwned(agentId: string): Promise<void> {
    const entry = await this.kv.get(agentId).catch(() => null);
    if (!entry?.value.length) return;
    await removeRegistration(
      agentId,
      this.kv,
      this.nc,
      this.kp,
      this.cache,
      this.inboxBuffer,
      this.clearGuard,
    );
  }

  /** The presence feed's owner key, for the api's read route (handed over
   *  in-process like deregisterOwned). Null = the feed is off here. */
  presenceFeedKey(): string | null {
    return this.presenceFeed?.key ?? null;
  }

  async stop(): Promise<void> {
    for (const sub of this.subs) {
      sub.unsubscribe();
    }
    this.manifestWatch.stop();
    this.identitySources.stop();
    this.heartbeatMonitor.stop();
    this.reaper.stop();
    await this.feedState?.stop();
    console.log("[registry] service stopped");
  }
}
