/**
 * Presence as a derived feed (docs/presence-feed.md; tracker 184).
 *
 * The platform presence agent owns one feed per watched agent:
 * `mesh.feed.{presence_agent}.{watched_agent_key}` — an agent key is a legal
 * single topic token. Only TRANSITIONS are published (the heartbeat join's
 * flips, which the monitor already computes), never heartbeats themselves,
 * and the value confesses its own decay: {presence, as_of, stale_after},
 * with the stated consumer rule that a value past stale_after is UNKNOWN,
 * never offline. `mesh.presence.get` stays the authoritative point read;
 * this is a push derivative of the same join, produced beside it, so the
 * two cannot disagree except by lag.
 *
 * Identity follows the announcer's pattern exactly: minted once, sealed at
 * rest in its own bucket (`mesh_presence_agent`, closure: keep), stable for
 * ever because the feed subject embeds it. Minted with kv.create rather than
 * read-then-put so two processes racing at first boot cannot mint two
 * identities and strand one of them's subscribers.
 */

import { messagingOf, type MessagingLike } from "../storage/index.js";
import type { Messaging } from "../storage/index.js";
import { nkeys, createEnvelope, signEnvelope, encode } from "../sdk.js";
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";
import { loadAtRestKey, seal, open, type AtRestKey, type Sealed } from "../shared/at-rest.js";
import type { FeedStateStore } from "../shared/feed-state.js";

/** 3 × the default heartbeat interval: past this, a stored value is UNKNOWN. */
const STALE_AFTER_MS = 3 * 30_000;

interface PresenceSecrets {
  seed: string;
}

interface StoredIdentity {
  agentKey: string;
  createdAt: string;
  keyId: string;
  sealed: Sealed;
}

export class PresenceFeedStore {
  private kv: KeyedStore;

  constructor(
    kv: KeyedLike,
    private atRest: AtRestKey | null,
  ) {
    this.kv = keyedOf(kv);
  }

  static async create(js: StorageLike): Promise<PresenceFeedStore> {
    return new PresenceFeedStore(await storageOf(js).keyed("mesh_presence_agent"), loadAtRestKey());
  }

  get enabled(): boolean {
    return !!this.atRest;
  }

  /** The one identity. `create`-first so a boot race cannot mint twice. */
  async ensureIdentity(): Promise<{ agentKey: string }> {
    if (!this.atRest) throw new Error("the presence feed is not configured on this instance (no at-rest key)");
    const existing = await this.read();
    if (existing) return { agentKey: existing.agentKey };
    const kp = nkeys.createUser();
    const rec: StoredIdentity = {
      agentKey: kp.getPublicKey(),
      createdAt: new Date().toISOString(),
      keyId: this.atRest.id,
      sealed: seal(this.atRest, { seed: new TextDecoder().decode(kp.getSeed()) } satisfies PresenceSecrets),
    };
    try {
      await this.kv.create("presence_identity", JSON.stringify(rec));
      return { agentKey: rec.agentKey };
    } catch {
      // Somebody else won the race; their identity is THE identity.
      const won = await this.read();
      if (!won) throw new Error("presence identity create raced and neither record survived");
      return { agentKey: won.agentKey };
    }
  }

  async unsealIdentity(): Promise<{ agentKey: string; seed: string } | null> {
    if (!this.atRest) return null;
    const rec = await this.read();
    if (!rec) return null;
    if (rec.keyId !== this.atRest.id) {
      throw new Error(
        `presence identity was sealed under key ${rec.keyId}, but this instance holds ` +
          `${this.atRest.id} — restore the original HOSTED_AGENT_KEY_FILE`,
      );
    }
    const secrets = open<PresenceSecrets>(this.atRest, rec.sealed);
    if (nkeys.fromSeed(new TextEncoder().encode(secrets.seed)).getPublicKey() !== rec.agentKey) {
      throw new Error("presence identity record is inconsistent: seed does not match agentKey");
    }
    return { agentKey: rec.agentKey, seed: secrets.seed };
  }

  private async read(): Promise<StoredIdentity | null> {
    try {
      const e = await this.kv.get("presence_identity");
      return e && e.operation === "PUT" && e.value.length ? (JSON.parse(e.string()) as StoredIdentity) : null;
    } catch {
      return null;
    }
  }
}

/** What one presence-feed value carries (docs/presence-feed.md). */
export interface PresenceValue {
  presence: "online" | "offline";
  as_of: string;
  /** Past this instant the value is UNKNOWN, never offline — the §9.6
   *  reconciliation, printed into every value rather than documented apart
   *  from it. */
  stale_after: string;
}

export class PresenceFeedPublisher {
  private kp: ReturnType<typeof nkeys.createUser> | null = null;
  private agentKey: string | null = null;
  /** Last presence published per watched agent — transitions only. */
  private lastPublished = new Map<string, "online" | "offline">();

  constructor(
    private nc: Messaging,
    private store: PresenceFeedStore,
    /** Purge hygiene on deregistration; null degrades to no purge. */
    private feedStates: FeedStateStore | null,
    /** The registered agents a node's flip fans out to (vouch join),
     *  including the node key itself when it is a self-hosting agent. */
    private agentsOf: (node: string) => string[],
  ) {}

  /** The feed's owner key, for the read route. Null when not configured. */
  get key(): string | null {
    return this.agentKey;
  }

  static async start(
    nc: MessagingLike,
    store: PresenceFeedStore,
    feedStates: FeedStateStore | null,
    agentsOf: (node: string) => string[],
  ): Promise<PresenceFeedPublisher | null> {
    if (!store.enabled) {
      console.log("[presence-feed] off (no at-rest key) — presence stays lookup-only");
      return null;
    }
    try {
      await store.ensureIdentity();
      const unsealed = await store.unsealIdentity();
      if (!unsealed) return null;
      const pub = new PresenceFeedPublisher(messagingOf(nc), store, feedStates, agentsOf);
      pub.kp = nkeys.fromSeed(new TextEncoder().encode(unsealed.seed));
      pub.agentKey = unsealed.agentKey;
      console.log(`[presence-feed] publishing as ${unsealed.agentKey.slice(0, 12)}… (transitions only)`);
      return pub;
    } catch (err) {
      console.error("[presence-feed] could not start:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** A node's join flipped. Fan out to its registered agents' topics. */
  nodeFlip(node: string, presence: "online" | "offline"): void {
    for (const agent of this.agentsOf(node)) this.publish(agent, presence);
  }

  /** One agent's presence value, published only when it CHANGES — the
   *  monitor's own cadence (30s sweep, online-on-first-beat) bounds the rate,
   *  and same-value republish is exactly the noise feeds must not add. */
  private publish(agent: string, presence: "online" | "offline"): void {
    if (!this.kp || !this.agentKey) return;
    if (this.lastPublished.get(agent) === presence) return;
    this.lastPublished.set(agent, presence);
    const now = Date.now();
    const value: PresenceValue = {
      presence,
      as_of: new Date(now).toISOString(),
      stale_after: new Date(now + STALE_AFTER_MS).toISOString(),
    };
    const env = createEnvelope({
      type: "emit",
      from: this.agentKey,
      payload: { topic: agent, kind: "state", data: value },
    });
    signEnvelope(env, this.kp as never);
    // The envelope id as the message id: the feed stream drops a repeat within
    // its window (on NATS, the Nats-Msg-Id header).
    this.nc.publish(`mesh.feed.${this.agentKey}.${agent}`, encode(env), { msgId: env.id });
  }

  /** Deregistration hygiene (docs/presence-feed.md): a removed registration
   *  gets a final offline, then its topic's stored value goes — the ordinary
   *  closure purge cannot reach entries under the presence agent's prefix. */
  async forgetAgent(agent: string): Promise<void> {
    if (!this.agentKey) return;
    this.publish(agent, "offline");
    this.lastPublished.delete(agent);
    try {
      await this.feedStates?.forgetTopic(this.agentKey, agent);
    } catch {
      /* the 24h stream retention erases what this could not */
    }
  }
}
