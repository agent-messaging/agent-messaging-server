/**
 * State feeds (SPEC §6.6a, §18.3): the platform side.
 *
 * A state feed's contract is "a late subscriber MUST be able to read the
 * current value without replaying history". The §18.3 binding realizes that as
 * a KV bucket keyed `{agent_id}.{topic}`, each key holding the latest emit
 * envelope, WRITTEN BY THE PLATFORM ON DELIVERY — the writer here is a durable
 * consumer over the whole feed grammar (`mesh.feed.*.*`, feed-stream.ts),
 * which is also the standing interest that makes MESH_FEED's interest
 * retention actually retain.
 *
 * The current value is served over request-reply on `mesh.feed.get`, the same
 * lookup shape as `mesh.presence.get` (§9.6) — deliberately NOT direct KV
 * reads from agents, because that would put `$JS.API` grants for a shared
 * bucket into every agent credential, and the credential template's whole
 * doctrine is that JetStream stays scoped to an agent's own mailbox stream
 * (keychain/cred-template.ts). Subscribe-before-snapshot (§9.6, restated for feeds
 * in §18.3) is the CALLER's obligation; this service just answers.
 *
 * Ownership is enforced twice: the credential template only grants publish on
 * `mesh.feed.<own key>.*`, and the writer here ALSO drops any envelope whose
 * verified `from` is not the subject's owner token — so a wide or legacy
 * credential cannot forge another agent's feed even if the transport lets the
 * publish through.
 */

import type { Messaging } from "../storage/index.js";
import { createEnvelope, decode, childSpan, ErrorCode } from "../sdk.js";
import type { Envelope } from "../sdk.js";
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike, type StreamConsumer } from "../storage/index.js";
import { FEED_STREAM, FEED_SUBJECT } from "./feed-stream.js";
import { subscribeWithHandler, type ServiceIdentity, idOf } from "./handler.js";
import { serviceQueue } from "./queue-groups.js";

export const FEED_STATE_BUCKET = "mesh_feed_state";
/** Current-value lookup, request-reply (§18.3). Three tokens, so it can never
 *  collide with a feed subject, which always has four. */
export const FEED_GET_SUBJECT = "mesh.feed.get";
/** The durable writer's consumer name on MESH_FEED. */
export const FEED_WRITER_DURABLE = "feed_state_writer";

/** Ed25519 user nkey, public half — the owner token of a feed subject. */
const NKEY_PUBLIC = /^U[A-Z2-7]{55}$/;
/** §14 token charset; a feed topic is a single token (§6.6a). */
const TOPIC_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** `mesh.feed.{agent}.{topic}` → its parts, or null for anything else. */
export function parseFeedSubject(subject: string): { agent: string; topic: string } | null {
  const parts = subject.split(".");
  if (parts.length !== 4 || parts[0] !== "mesh" || parts[1] !== "feed") return null;
  const [, , agent, topic] = parts;
  if (!NKEY_PUBLIC.test(agent) || !TOPIC_RE.test(topic)) return null;
  return { agent, topic };
}

/** The §18.3 KV key: `{agent_id}.{topic}`. */
export function feedKvKey(agent: string, topic: string): string {
  return `${agent}.${topic}`;
}

export type FeedWriteDecision =
  | { ok: true; agent: string; topic: string }
  | { ok: false; reason: string };

/**
 * Whether one delivered message is a feed write the platform should record.
 * Pure, so the ownership rule is testable apart from the consumer loop: the
 * subject must parse as a feed, and the envelope's VERIFIED sender must be the
 * subject's owner token (§6.6a — "only the owner publishes").
 */
export function feedWriteDecision(subject: string, from: string): FeedWriteDecision {
  const parsed = parseFeedSubject(subject);
  if (!parsed) return { ok: false, reason: `subject ${subject} is not a feed` };
  if (from !== parsed.agent) {
    return { ok: false, reason: `sender ${from.slice(0, 12)}… is not the owner of ${subject}` };
  }
  return { ok: true, ...parsed };
}

/**
 * The bucket, opened with the platform's standard helper (closure-registry.ts
 * records its disposition: purge by agent). `history: 1` IS the state-feed
 * semantic — each publish replaces the last.
 */
export class FeedStateStore {
  private kv: KeyedStore;

  constructor(
    js: StorageLike | undefined,
    kv: KeyedLike,
  ) {
    this.kv = keyedOf(kv, js);
  }

  static async open(js: StorageLike): Promise<FeedStateStore> {
    return new FeedStateStore(undefined, await storageOf(js).keyed("mesh_feed_state"));
  }

  /** Record the latest envelope for a feed, verbatim wire bytes. */
  async put(agent: string, topic: string, envelopeBytes: Uint8Array): Promise<void> {
    await this.kv.put(feedKvKey(agent, topic), envelopeBytes);
  }

  /** The current value, decoded, or null when the feed has never published. */
  async current(agent: string, topic: string): Promise<Envelope | null> {
    const entry = await this.kv.get(feedKvKey(agent, topic)).catch(() => null);
    if (!entry || entry.operation !== "PUT" || !entry.value.length) return null;
    try {
      return decode(entry.value);
    } catch {
      return null;
    }
  }

  /** The topics an agent currently holds a value for. Enumerates off the
   *  backing stream (shared/kv.ts) — never `kv.keys()`. */
  async topicsOf(agent: string): Promise<string[]> {
    const keys = (await this.kv.list()).keys;
    const prefix = `${agent}.`;
    return keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  /** Forget ONE topic's stored value — deregistration hygiene for feeds
   *  whose owner outlives the subject (the presence agent's per-agent
   *  topics, registry/presence-feed.ts). */
  async forgetTopic(agent: string, topic: string): Promise<void> {
    await this.kv.purge(feedKvKey(agent, topic));
  }

  /** Closure cascade: forget every feed value this agent ever held. */
  async forget(agent: string): Promise<void> {
    const keys = (await this.kv.list()).keys;
    const prefix = `${agent}.`;
    for (const k of keys) {
      if (k.startsWith(prefix)) await this.kv.purge(k);
    }
  }
}

/**
 * The running half: the durable writer plus the `mesh.feed.get` responder.
 * Started by the registry process (registry-service.ts), the same home as
 * presence — a feed's current value is presence-shaped: a small fact served
 * over request-reply, derived from traffic.
 */
export class FeedStateService {
  private iter: StreamConsumer | null = null;
  private lastDropLog = 0;

  private constructor(
    private store: FeedStateStore,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private sub: any,
  ) {}

  static async start(
    nc: Messaging,
    storage: StorageLike,
    identity: ServiceIdentity,
  ): Promise<FeedStateService | null> {
    try {
      const feed = storageOf(storage).stream("MESH_FEED");
      const usable = await feed.ensure();
      const store = await FeedStateStore.open(storage);

      // The lookup responder answers even when the stream is down: a stored
      // current value is still current.
      const sub = subscribeWithHandler(
        nc,
        FEED_GET_SUBJECT,
        identity,
        async (env) => FeedStateService.answerGet(env, store, identity),
        undefined,
        undefined,
        serviceQueue(FEED_GET_SUBJECT),
      );

      const svc = new FeedStateService(store, sub);
      if (usable) {
        svc.iter = await feed.consume(FEED_WRITER_DURABLE, { filter: FEED_SUBJECT });
        void svc.run();
        console.log(
          `[feed] state writer consuming ${FEED_STREAM} (durable ${FEED_WRITER_DURABLE}); ` +
            `lookup on ${FEED_GET_SUBJECT}`,
        );
      } else {
        console.warn(`[feed] state writer NOT running (stream unavailable); lookup serves stored values only`);
      }
      return svc;
    } catch (err) {
      console.error("[feed] state service could not start:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  private static async answerGet(
    env: Envelope,
    store: FeedStateStore,
    identity: ServiceIdentity,
  ): Promise<Envelope> {
    const p = (env.payload ?? {}) as { agent?: unknown; topic?: unknown };
    const agent = typeof p.agent === "string" ? p.agent : "";
    const topic = typeof p.topic === "string" ? p.topic : "";
    const base = {
      type: "respond" as const,
      from: idOf(identity),
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
    };
    if (!NKEY_PUBLIC.test(agent) || !TOPIC_RE.test(topic)) {
      return createEnvelope({
        ...base,
        error: {
          code: ErrorCode.INVALID_ENVELOPE,
          message: "feed.get payload must carry { agent: <nkey>, topic: <single token> }",
          retryable: false,
        },
      });
    }
    const current = await store.current(agent, topic);
    return createEnvelope({
      ...base,
      payload: current ? { found: true, envelope: current } : { found: false, envelope: null },
    });
  }

  /** Fold loop: parse, verify ownership, store, ack. Poison messages are
   *  acked and dropped — a bad publish must not wedge every feed after it. */
  private async run(): Promise<void> {
    if (!this.iter) return;
    for await (const m of this.iter) {
      try {
        const env = decode(m.data); // verifies the envelope signature (§4.5)
        // The forgery case the subject shape exists to prevent (§6.6a): a
        // verified sender publishing under somebody else's owner token.
        const d = feedWriteDecision(m.subject, env.from);
        if (!d.ok) this.dropLog(d.reason);
        else await this.store.put(d.agent, d.topic, m.data);
      } catch (err) {
        this.dropLog(err instanceof Error ? err.message : String(err));
      }
      m.ack();
    }
  }

  /** At most one drop line a minute; a flood of bad publishes is one fact. */
  private dropLog(reason: string): void {
    const now = Date.now();
    if (now - this.lastDropLog < 60_000) return;
    this.lastDropLog = now;
    console.warn(`[feed] dropped: ${reason}`);
  }

  async stop(): Promise<void> {
    try {
      await this.iter?.close();
    } catch {
      /* already closing */
    }
    try {
      this.sub?.unsubscribe();
    } catch {
      /* already closed */
    }
  }
}
