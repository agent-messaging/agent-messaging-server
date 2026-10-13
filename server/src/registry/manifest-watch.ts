import { keyedOf, type KeyedEntry, type KeyedLike, type KeyedStore, type KeyedWatch } from "../storage/index.js";
import type { Manifest } from "../sdk.js";
import { normalizeLegacyManifest } from "./endpoints.js";

/**
 * Keeps one registry instance's in-memory manifest cache in step with the
 * `mesh_registry` KV bucket — including the writes that another instance made.
 *
 * ## The problem this exists for
 *
 * `RegistryService`'s cache is the whole answer to `mesh.registry.discover`, and
 * until this existed it was written by exactly two things: the boot seed, and the
 * handlers that ran IN THIS PROCESS. Queue groups (shared/queue-groups.ts) send
 * each registration to exactly one instance, which is what makes two instances
 * safe to write — and it is also what makes the cache wrong: the instance that
 * did not handle the registration never hears about it and answers discovery from
 * a directory missing that agent, for the life of the process. Discovery would
 * then depend on which instance the query happened to reach. An agent visible or
 * invisible by coin flip is worse than a slow answer, so this is the blocker on
 * running a second instance at all, not a refinement of one.
 *
 * ## Why a KV watch and not the lifecycle events
 *
 * The registry already publishes signed `agent_registered` / `agent_deregistered`
 * / `agent_reaped` events, deliberately as broadcasts, and the catalog service
 * consumes them to invalidate its own in-memory cache. Copying that pattern here
 * was the obvious move. It was not taken, for four reasons that all point the
 * same way:
 *
 *  1. **`agent_registered` cannot populate a cache entry.** It carries
 *     `{agent_id, name, node, sandbox}` — not the endpoint, offerings,
 *     capabilities, owner, visibility or node profile that discovery filters and
 *     returns. So an event consumer would have to read the KV key anyway, and
 *     the event would be a hint to re-read rather than the data. Widening the
 *     event to carry a whole manifest changes a published event shape for every
 *     existing consumer, to duplicate a store both instances already share.
 *  2. **Core NATS events are at-most-once.** An instance that is disconnected,
 *     or restarting, when the event is published never learns of that
 *     registration — and nothing re-seeds afterwards, so the entry is missing
 *     until the process is restarted. A KV watch runs on a JetStream ordered
 *     consumer: on a reconnect or a lost consumer, the client recreates it from
 *     the last stream sequence it delivered (`_resetOrderedConsumer`, driven by
 *     the 5s idle-heartbeat monitor and by delivery-sequence gap detection), so
 *     what was missed is replayed off the stream instead of being lost. That is
 *     the difference between a cache that heals and one that drifts.
 *  3. **Not every write emits an event.** `scripts/purge-stale-registry.ts`
 *     purges KV keys directly and its instructions end with "restart
 *     agentmesh-services so the in-memory manifest cache reloads" — because
 *     nothing told the cache. A watch observes the bucket, so it sees admin
 *     writes, not just the ones that remembered to announce themselves.
 *  4. **Nothing from the bus can poison the cache.** `decode()` proves an
 *     envelope was signed by whoever `from` names; it does NOT prove that
 *     whoever that is is the registry. A cache fed by bus events is therefore
 *     only as trustworthy as the ACL on `mesh.event.registry.>`, and a forged
 *     "agent_deregistered" would evict a live agent from discovery. Reading the
 *     durable store instead moves the trust boundary to KV write access, which
 *     is where the manifests already live: the boot seed has always trusted it.
 *     There is nothing to verify a signature on here because nothing
 *     untrusted is consumed.
 *
 * SPEC §9.2 already lists this as a registry operation: "Watch — KV watch on
 * `mesh_registry` bucket — subscribe to manifest changes (additions, updates,
 * deletions)".
 *
 * ## What it does NOT replace
 *
 * The boot seed. `snapshotKvBucket` is the authoritative baseline because it
 * accounts for every subject the server lists and throws rather than returning a
 * subset; the watch's initial replay comes through the same JetStream iterator
 * machinery whose accounting is exactly what `shared/kv.ts` documents as
 * untrustworthy in `kv.keys()`. So the seed establishes the baseline and the
 * watch carries it forward.
 *
 * The default `include` (last value per key) is kept rather than "updates only"
 * on purpose: the watch opens AFTER the seed, and the replay of current values
 * closes the gap between the two. It is redundant with the seed by design, and
 * redundant work at boot is the cheap side of that trade.
 *
 * Handlers still write the cache directly when they handle a registration. This
 * is not belt-and-braces: it is read-your-writes for the agent that registered,
 * which must not have to wait for a round trip through JetStream before it is
 * discoverable on the instance it just talked to. The watch echo that follows
 * sets the same bytes.
 */
export class ManifestWatch {
  private iter: KeyedWatch | null = null;
  private stopped = false;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  /** Highest KV revision applied. A KV revision IS the backing stream sequence,
   *  so this doubles as the resume point for a reopened watch. */
  private lastRevision = 0;
  /** How many times the watch has been opened, including the first. */
  private opens = 0;

  private kv: KeyedStore;

  constructor(
    kv: KeyedLike,
    private cache: Map<string, Manifest>,
    /** Delay before a broken watch is reopened. */
    private readonly reopenMs = Number(process.env.REGISTRY_WATCH_REOPEN_MS ?? 2000),
    /** Fired when a registration LEAVES the cache (DEL/PURGE of a key that
     *  was live here) — every removal path flows through this watch, handler
     *  and reaper and admin purge alike, which is what makes it the one
     *  honest hook for removal side-effects (the presence feed's final
     *  offline + topic purge). Only for keys actually in the cache, so the
     *  boot replay's old delete markers fire nothing. */
    private readonly onRemoved?: (key: string) => void,
  ) {
    this.kv = keyedOf(kv);
  }

  /** True while a watch is open and feeding the cache. */
  get watching(): boolean {
    return this.iter !== null;
  }

  /** Opens counted so a test (and an operator reading logs) can tell a reopened
   *  watch from one that never broke. */
  get openCount(): number {
    return this.opens;
  }

  /**
   * Open the watch and start applying entries.
   *
   * Deliberately does NOT throw. A registry whose watch cannot open is still
   * correct on its own writes, so refusing to boot would turn "a second instance
   * would drift" into "the mesh has no registry" — but it is not safe to run a
   * SECOND instance in that state, so the failure is logged in those words and
   * retried rather than swallowed.
   */
  async start(): Promise<void> {
    this.stopped = false;
    await this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
    this.iter?.stop();
    this.iter = null;
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    try {
      // Resume from just after the last revision applied, when there is one: a
      // reopened watch must not replay the whole bucket, and must not skip what
      // it missed while broken. With no revision yet (the first open, or a first
      // open that failed) the default last-value replay is the right baseline.
      const iter = await this.kv.watch(
        this.lastRevision > 0 ? { fromRevision: this.lastRevision + 1 } : {},
      );
      if (this.stopped) {
        iter.stop();
        return;
      }
      this.iter = iter;
      this.opens++;
      console.log(
        `[registry] watching mesh_registry for manifest changes` +
          `${this.lastRevision > 0 ? ` from revision ${this.lastRevision + 1}` : ""}` +
          `${this.opens > 1 ? ` (open #${this.opens})` : ""}`,
      );
      void this.drain(iter);
    } catch (err) {
      this.iter = null;
      console.error(
        "[registry] could NOT watch mesh_registry — this instance's manifest cache will " +
          "only ever see the registrations it handles itself, so do not run a second " +
          "registry instance until this works. Retrying:",
        err instanceof Error ? err.message : err,
      );
      this.scheduleReopen();
    }
  }

  private async drain(iter: KeyedWatch): Promise<void> {
    try {
      for await (const entry of iter) {
        try {
          this.apply(entry);
        } catch (err) {
          // One bad entry must never end the watch: the alternative is a cache
          // that stops tracking the bucket over a single unparseable value.
          console.error(
            `[registry] manifest watch could not apply '${entry.key.slice(0, 12)}…':`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      if (this.stopped) return;
      // The iterator ended on its own. Every reason for that (the ordered
      // consumer could not be recreated, the subscription closed) leaves the
      // cache frozen at whatever it happened to hold, which is the silent
      // incoherence this class exists to prevent — so it is loud, and it reopens.
      console.error(
        "[registry] manifest watch on mesh_registry ENDED with no error; the cache is " +
          "frozen until it reopens, so this instance would not see another instance's " +
          "registrations. Reopening.",
      );
    } catch (err) {
      if (this.stopped) return;
      console.error(
        "[registry] manifest watch on mesh_registry FAILED; the cache is frozen until " +
          "it reopens. Reopening:",
        err instanceof Error ? err.message : err,
      );
    }
    if (this.iter === iter) this.iter = null;
    this.scheduleReopen();
  }

  private scheduleReopen(): void {
    if (this.stopped || this.reopenTimer) return;
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      void this.open();
    }, this.reopenMs);
    // Never hold the process open on a retry timer.
    this.reopenTimer.unref?.();
  }

  /**
   * Apply one KV entry to the cache.
   *
   * A PUT sets, a DEL or PURGE deletes — the bucket's own state, not an
   * interpretation of it. An unparseable value is SKIPPED rather than treated as
   * a removal: a value we cannot read is not an agent that deregistered, and
   * collapsing the two would take a live agent out of discovery on every
   * instance that read it. (`registry-service.ts` skips corrupt entries in the
   * boot seed for the same reason.)
   */
  private apply(entry: KeyedEntry): void {
    if (entry.revision > this.lastRevision) this.lastRevision = entry.revision;

    if (entry.operation !== "PUT") {
      if (this.cache.delete(entry.key)) {
        console.log(
          `[registry] manifest cache: removed ${entry.key.slice(0, 12)}… ` +
            `(${entry.operation} in KV, rev ${entry.revision})`,
        );
        try {
          this.onRemoved?.(entry.key);
        } catch (err) {
          console.error("[registry] onRemoved hook failed:", err instanceof Error ? err.message : err);
        }
      }
      return;
    }

    let manifest: Manifest;
    try {
      // §8.5 deprecation window: manifests stored before the rename read back
      // normalized, so every cache consumer sees one vocabulary.
      manifest = normalizeLegacyManifest(entry.json<Manifest>());
    } catch (err) {
      console.error(
        `[registry] manifest watch: '${entry.key.slice(0, 12)}…' rev ${entry.revision} is not ` +
          `parseable JSON; keeping the previous value rather than treating it as a removal:`,
        err instanceof Error ? err.message : err,
      );
      return;
    }

    // Quiet when nothing changed. The replay right after the boot seed re-reads
    // every key, and the echo of this instance's own write arrives a moment after
    // the handler already logged it; neither is news. What IS news is a manifest
    // this instance did not write — a registration another instance handled, or an
    // admin tool's edit — and that is what this line reports.
    const before = this.cache.get(entry.key);
    if (before && JSON.stringify(before) === JSON.stringify(manifest)) return;
    this.cache.set(entry.key, manifest);
    console.log(
      `[registry] manifest cache: ${before ? "updated" : "added"} ${entry.key.slice(0, 12)}… ` +
        `(${manifest.name ?? "unnamed"}, rev ${entry.revision})`,
    );
  }
}
