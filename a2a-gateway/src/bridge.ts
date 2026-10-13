/**
 * The bridge is a mesh NODE (BRIDGE-A2A.md §2): one credentialed connection,
 * vouching for hosted identities minted for external A2A parties. This module
 * owns the node, the inbound caller-identity pool, the exposure policy, and
 * the bridge-local task store.
 */
import { randomUUID } from "node:crypto";
import { createUser } from "nkeys.js";
import { MeshNode } from "../../sdk-typescript/src/node.js";
import { AgentMesh } from "../../sdk-typescript/src/mesh.js";
import type { Manifest } from "../../sdk-typescript/src/types/manifest.js";
import type { A2ATask } from "./core/jsonrpc.js";
import { linkFiles, meshLinker, outputToParts, type MeshFile } from "./core/parts.js";
import { MeshError, ErrorCode } from "../../sdk-typescript/src/types/errors.js";
import type { RequestContext } from "../../sdk-typescript/src/internal/offering-router.js";
import { BucketPool } from "./core/ratelimit.js";
import { meshAddress } from "./mesh-address.js";
import { BRIDGE_EXTENSION_URI, inboundCallerManifest, inboundCallerMarker, type InboundCallerMarker } from "./core/card.js";
import { parseTrustedProxies, type ProxySet } from "./inbound/client-address.js";
import type { FileKeyStore } from "./inbound/keys.js";
import {
  callerKindOf,
  newCallerRecord,
  persistable,
  redactCaller,
  type CallerIdentityStore,
  type CallerKind,
  type RedactedCallerIdentity,
} from "./inbound/identity-store.js";

export interface BridgeCreds {
  jwt: string;
  seed: string;
}

export interface BridgeConfig {
  meshUrl: string;
  /** Public base URL of this bridge, used in generated cards
   *  (e.g. https://a2a.agentmesh.ai). */
  publicBaseUrl: string;
  port: number;
  creds?: BridgeCreds;
  /** API key -> label. Callers presenting a key get a stable hosted identity. */
  apiKeys?: Record<string, string>;
  /** Runtime-minted keys (self-serve, account-backed). Checked after the env
   *  list; a caller admitted here is identified by the key RECORD, so the raw
   *  key never becomes a map key anywhere. */
  keyStore?: FileKeyStore;
  /** Durable record of which hosted mesh identity belongs to which caller
   *  (inbound/identity-store.ts). Without it the bridge still runs, but a
   *  caller's identity is re-minted on every restart and an audit row naming
   *  one resolves to nobody afterwards — which is the whole reason the store
   *  exists. Tests and minimal dev boots leave it unset. */
  callerStore?: CallerIdentityStore;
  /** Admit callers that present NO credentials at all (BRIDGE-A2A.md §9 guest
   *  tier). Default FALSE — an open bridge is something an operator turns on,
   *  never something a deployment default hands them. */
  allowAnonymous?: boolean;
  /** Addresses/CIDRs of reverse proxies whose `X-Forwarded-For` may be
   *  believed. Empty means believe no header from anyone. */
  trustedProxies?: string[];
  /** Idle TTL for anonymous caller identities. Default 1h. */
  guestIdentityTtlMs?: number;
  /** Requests per minute per caller identity. Default 30. */
  ratePerMinute?: number;
}

interface HostedIdentity {
  agent: AgentMesh;
  lastUsed: number;
  /** The stable opaque handle this caller is known by on the wire (§8.3). For
   *  a persisted caller it comes from the record; anonymous callers get one for
   *  the run they are alive in. */
  ref: string;
  kind: CallerKind;
  /** True once the §2.1 rule 2 manifest has been registered for this identity,
   *  so a re-use does not re-register on every request. */
  markerRegistered: boolean;
}

interface TaskRecord {
  task: A2ATask;
  responder: string;
  callerKey: string;
  createdAt: number;
  /** Present when the task stands for a message the responder's node queued
   *  for an attended session (§6.4a): no mesh task exists yet, the reply
   *  arrives later at the caller identity's inbox, and this record is what
   *  the reply completes. */
  queued?: { inbox_id: string | null };
}

/** A fresh agent NKey seed. Same mint the attachment records use
 *  (outbound/manager.ts), and for the same reason: an identity the bridge can
 *  reproduce after a restart is one whose seed the bridge wrote down. */
function mintSeed(): string {
  return new TextDecoder().decode(createUser().getSeed());
}

const IDENTITY_MAX = 5000;
const TASK_TTL_MS = 60 * 60 * 1000;
/** A queued message waits on a person; its task is kept a day, not an hour. */
const QUEUED_TASK_TTL_MS = 24 * 60 * 60 * 1000;
const TASK_MAX = 10000;
const MANIFEST_CACHE_MS = 60 * 1000;

/** Why a caller was refused. Both answer 401; the operator needs to tell the
 *  cases apart, because one is a client mistake and the other is this bridge's
 *  configured policy. */
export type RefusalReason = "invalid_key" | "credentials_required";

export interface CallerRefused {
  error: "unauthorized";
  reason: RefusalReason;
  message: string;
}

/** Is a mesh agent open to callers outside the mesh? See Bridge.isExposed. */
export function isExposed(manifest: Manifest): boolean {
  const exts = Array.isArray(manifest.extensions) ? manifest.extensions : [];
  if (exts.some((e) => e && typeof e === "object" && (e as { uri?: unknown }).uri === BRIDGE_EXTENSION_URI)) return true;
  const access = (manifest.public as { access?: { schemes?: Array<{ id?: unknown; transport?: unknown }> } } | undefined)?.access;
  return (access?.schemes ?? []).some((s) => s && s.transport === "http" && s.id === "a2a-gateway");
}

export class Bridge {
  readonly config: BridgeConfig;
  private node: MeshNode | null = null;
  /**
   * The bridge's own hosted agent. It exists ONLY to make registry calls
   * (`discover`, `getManifest`) on the bridge's behalf, and it is deliberately
   * NEVER registered — see `registersOwnManifest` below for the reasoning.
   */
  private courier: AgentMesh | null = null;
  private identities = new Map<string, HostedIdentity>();
  private rates: BucketPool;
  private proxies: ProxySet | null;
  private tasks = new Map<string, TaskRecord>();
  private manifestCache = new Map<string, { manifest: Manifest; at: number }>();
  private descriptorCache = new Map<string, { descriptor: Record<string, unknown> | null; at: number }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: BridgeConfig) {
    this.config = {
      guestIdentityTtlMs: 60 * 60 * 1000,
      ratePerMinute: 30,
      allowAnonymous: false,
      ...config,
    };
    // Throws on an unparseable entry: a trust list is a security decision, and
    // a typo must not quietly widen or narrow it (client-address.ts).
    this.proxies = parseTrustedProxies(this.config.trustedProxies);
    this.rates = new BucketPool(this.config.ratePerMinute!, IDENTITY_MAX);
  }

  /**
   * FIX 4 / BRIDGE-A2A.md §2 — the bridge publishes no manifest of its own, on
   * purpose.
   *
   * The bridge is a *node*, not an agent. §8 maps manifests for the parties it
   * bridges; nothing in the mapping gives the bridge itself one. A manifest is
   * a promise that an identity answers requests on declared skills, and the
   * courier answers nothing — registering it would publish a promise the bridge
   * cannot keep, and would add surface that a conforming third-party bridge
   * (§12) would not have.
   *
   * The bridge is not thereby invisible. Every hosted identity it vouches for
   * carries `node.id` = this node's key plus the §8.3 a2a-bridge marker, and the
   * node heartbeats, so "which node bridged this agent, and is it alive" is
   * answerable from the mesh. Operator liveness is HTTP `/healthz`, which needs
   * no mesh credential.
   */
  readonly registersOwnManifest = false;

  /** The bridge node's mesh id, or null before `connect()`. Null is a real
   *  state now: the HTTP listener binds BEFORE the mesh connection (boot.ts). */
  get nodeId(): string | null {
    return this.node?.id ?? null;
  }

  /** True once the mesh connection is up and the bridge can do mesh work. */
  get ready(): boolean {
    return this.node !== null;
  }

  get meshNode(): MeshNode {
    if (!this.node) throw new Error("bridge is not connected to the mesh yet");
    return this.node;
  }

  get trustedProxies(): ProxySet | null {
    return this.proxies;
  }

  /** True when generated cards must advertise a bearer scheme (§9: cards MUST
   *  declare exactly what the bridge accepts). */
  get apiKeyRequired(): boolean {
    return this.hasApiKeys() || this.config.keyStore?.hasLiveKeys() === true;
  }

  get anonymousAllowed(): boolean {
    return this.config.allowAnonymous === true;
  }

  /** Startup complaints worth printing once, loudly. Returned rather than
   *  logged so a caller can decide where they go and a test can read them. */
  configWarnings(): string[] {
    const out: string[] = [];
    if (!this.hasApiKeys() && !this.config.keyStore && !this.anonymousAllowed) {
      out.push(
        "no API_KEYS are configured, no key store is attached, and ALLOW_ANONYMOUS is off, so every inbound A2A call will be refused with 401. " +
          "Set API_KEYS=\"<key>=<label>,...\" to admit callers, or ALLOW_ANONYMOUS=1 to run an open bridge on purpose.",
      );
    }
    if (this.anonymousAllowed) {
      out.push(
        "ALLOW_ANONYMOUS is ON: any caller on the network reaches the mesh through this bridge without credentials, " +
          `at ${this.config.ratePerMinute}/min per client address, and /agents will enumerate the exposed directory to them.`,
      );
    }
    if (!this.proxies) {
      out.push(
        "no TRUSTED_PROXIES configured: X-Forwarded-For is ignored and callers are identified by socket address. " +
          "Correct for a directly exposed bridge; behind a reverse proxy, set TRUSTED_PROXIES so each caller gets its own identity and rate budget.",
      );
    }
    return out;
  }

  async connect(): Promise<void> {
    // NATS or RabbitMQ, by the address's scheme, as the SDK chooses (mesh-address.ts).
    const { servers } = meshAddress(this.config.meshUrl);
    this.node = await MeshNode.connect(servers, {
      jwt: this.config.creds?.jwt,
      nodeSeed: this.config.creds?.seed,
      // §9.2 retention: durability is declared. The bridge is a supervised
      // service, so its hosted attachments earn the full vouch; undeclared
      // they would ride the short ephemeral lease meant for dev spawns.
      profile: { availability_class: "always_on", reachability: "direct" },
      // A broker busy with a deploy answers the first connect with a timeout;
      // try again for about a minute and a half, saying so, rather than exit
      // and be restarted by pm2 (2026-10-12). Later drops are the transport's
      // own reconnect, unchanged.
      transport: {
        connectRetry: {
          onRetry: (i) => console.warn(`[bridge] the broker did not take the connection (try ${i.attempt} of ${i.attempts}: ${i.error.message}); trying again in ${Math.round(i.delayMs / 100) / 10} s`),
        },
      },
    });
    this.node.startHeartbeat();
    this.courier = this.node.addAgent();
    this.sweepTimer = setInterval(() => this.sweep(), 60 * 1000);
    console.log(`[bridge] node connected: ${this.node.id.slice(0, 12)}...`);
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.node) await this.node.drain();
    this.node = null;
    this.courier = null;
  }

  // ─── Exposure policy (BRIDGE-A2A.md §2.1 rule 4) ───────────────────

  /** Fetch (with a short cache) the manifest of a mesh agent, applying the
   *  exposure policy: public, non-sandbox agents only. Returns null when the
   *  agent must not be exposed (indistinguishable from not existing). */
  async exposableManifest(agentId: string): Promise<Manifest | null> {
    const cached = this.manifestCache.get(agentId);
    if (cached && Date.now() - cached.at < MANIFEST_CACHE_MS) return cached.manifest;
    if (!this.courier) return null;

    let manifest: Manifest;
    try {
      manifest = await this.courier.getManifest(agentId);
    } catch {
      return null;
    }
    if (!manifest || manifest.visibility === "private" || manifest.visibility === "unlisted") return null;
    if (manifest.sandbox) return null;

    this.manifestCache.set(agentId, { manifest, at: Date.now() });
    return manifest;
  }

  /** An agent's current descriptor from the registry (descriptor-spec §8.2),
   *  the JSON its adapter submitted; null when it submitted none. Cached a
   *  minute, the same as manifests. */
  async agentDescriptor(agentId: string): Promise<Record<string, unknown> | null> {
    const cached = this.descriptorCache.get(agentId);
    if (cached && Date.now() - cached.at < MANIFEST_CACHE_MS) return cached.descriptor;
    if (!this.courier || !/^[A-Z0-9]{56}$/.test(agentId)) return null;
    let descriptor: Record<string, unknown> | null = null;
    try {
      const p = (await this.courier.serviceRequest(`mesh.registry.descriptor.get.${agentId}`, {}, 5000)) as { descriptor?: unknown };
      if (typeof p?.descriptor === "string") {
        const doc = JSON.parse(Buffer.from(p.descriptor, "base64").toString("utf8")) as unknown;
        if (doc && typeof doc === "object" && !Array.isArray(doc)) descriptor = doc as Record<string, unknown>;
      }
    } catch {
      descriptor = null;
    }
    if (this.descriptorCache.size > 5000) this.descriptorCache.clear();
    this.descriptorCache.set(agentId, { descriptor, at: Date.now() });
    return descriptor;
  }

  /**
   * Is a mesh agent open to callers outside the mesh? The agent's own
   * registration says so: its access declaration carries the gateway's HTTP
   * scheme when the operator set the door's a2a tier to allow. Without it
   * the agent is mesh only, and this gateway names no door for it. An
   * attachment (an A2A agent the bridge brought INTO the mesh) carries the
   * bridge extension and is exposed by construction: it lives outside.
   */
  static isExposed(manifest: Manifest): boolean {
    return isExposed(manifest);
  }

  /** Publicly discoverable agents (for the bridge index page). */
  async listExposable(): Promise<Manifest[]> {
    if (!this.courier) return [];
    const result = await this.courier.discover({ limit: 100 });
    return result.agents.filter((m) => !m.sandbox && (m.visibility ?? "public") === "public");
  }

  // ─── Inbound caller identities (BRIDGE-A2A.md §9) ──────────────────

  private hasApiKeys(): boolean {
    return !!this.config.apiKeys && Object.keys(this.config.apiKeys).length > 0;
  }

  /**
   * The admission decision, with nothing minted. Fail-closed: an absent API key
   * is admitted ONLY where the operator turned `allowAnonymous` on.
   *
   * BRIDGE-A2A.md §9 permits an anonymous guest tier — it does not require one,
   * and "permitted" is not "default". Before this, an unset `API_KEYS` (the
   * production state) meant every anonymous caller on the internet was handed a
   * mesh identity and 30 mesh requests a minute.
   */
  authorizeCaller(apiKey: string | undefined, clientAddr: string): { key: string } | CallerRefused {
    if (apiKey !== undefined) {
      if (this.hasApiKeys() && apiKey in this.config.apiKeys!) {
        return { key: `key:${apiKey}` };
      }
      // The runtime-minted, account-backed keys (self-serve). Identified by
      // record id, so a revoked-and-reminted account gets a NEW identity and
      // the raw key string never keys any map.
      const minted = this.config.keyStore?.verify(apiKey);
      if (minted) {
        return { key: `acctkey:${minted.id}` };
      }
      return {
        error: "unauthorized",
        reason: "invalid_key",
        message: "The presented API key is not recognised by this bridge.",
      };
    }
    if (!this.anonymousAllowed) {
      return {
        error: "unauthorized",
        reason: "credentials_required",
        message:
          "This bridge requires an API key: send `Authorization: Bearer <key>`. " +
          "Anonymous access is off (ALLOW_ANONYMOUS).",
      };
    }
    return { key: `ip:${clientAddr}` };
  }

  /** Resolve the hosted mesh identity for an inbound caller, minting one on
   *  first sight. Keyed by API key when presented, else by resolved client
   *  address (ephemeral, TTL-evicted). Each distinct caller gets a distinct
   *  identity (§2.1 rule 1) — which is only true if `clientAddr` is the caller
   *  and not the proxy in front of it; see inbound/client-address.ts. */
  async callerIdentity(
    apiKey: string | undefined,
    clientAddr: string,
  ): Promise<{ agent: AgentMesh; key: string } | CallerRefused> {
    const decision = this.authorizeCaller(apiKey, clientAddr);
    if ("error" in decision) return decision;
    return { agent: await this.identityFor(decision.key), key: decision.key };
  }

  /**
   * The hosted identity for an already-authorized caller key.
   *
   * Three layers, in order: the live pool (an `AgentMesh` with its inbox open),
   * the durable record (a seed that reproduces the SAME mesh id the caller had
   * before the last restart), and finally a fresh mint. Only the third writes
   * a new record.
   *
   * Awaited rather than fire-and-forget because it does two things a request
   * must not race: it reads the caller's record, and on first sight it
   * registers the §2.1 rule 2 marker manifest. Both happen once per caller per
   * process, not per request.
   */
  async identityFor(key: string): Promise<AgentMesh> {
    if (!this.node) throw new Error("bridge is not connected to the mesh yet");
    let entry = this.identities.get(key);
    if (!entry) {
      if (this.identities.size >= IDENTITY_MAX) this.evictOldestIdentity();
      entry = await this.reviveOrMint(key);
      this.identities.set(key, entry);
    }
    entry.lastUsed = Date.now();
    this.config.callerStore?.touch(key);
    // §2.1 rule 2. Registration is best-effort on purpose: a registry that is
    // down must not turn into a 500 for a caller whose actual work — the mesh
    // request — is about to go through fine. It is retried on the next use.
    if (!entry.markerRegistered) await this.registerCallerMarker(entry);
    return entry.agent;
  }

  /** Bring a caller's identity back from its record, or mint a new one and
   *  write the record. The seed is what makes "back" possible: the same seed
   *  yields the same mesh public key, so the caller keeps the id other agents
   *  and audit rows already know it by. */
  private async reviveOrMint(key: string): Promise<HostedIdentity> {
    const store = this.config.callerStore;
    const existing = store?.byCallerKey(key);
    if (existing) {
      const agent = this.node!.addAgent({ nkeySeed: existing.identitySeed });
      this.listenForLateReplies(agent);
      // The seed IS the id, so these agree unless the file was edited by hand.
      // If they ever disagree, believe the seed and re-index — `put` keeps the
      // superseded agent id resolvable, which is the property audit rows need.
      if (agent.id !== existing.agentId) {
        console.warn(
          `[bridge] caller ${existing.ref.slice(0, 8)} recorded agent ${existing.agentId.slice(0, 12)}... but its seed yields ${agent.id.slice(0, 12)}...; re-indexing on the seed`,
        );
        await store!.put({ ...existing, agentId: agent.id });
      }
      console.log(
        `[bridge] restored hosted identity for caller ${existing.ref.slice(0, 8)}: ${agent.id.slice(0, 12)}...`,
      );
      return { agent, lastUsed: Date.now(), ref: existing.ref, kind: existing.kind, markerRegistered: false };
    }

    const kind = callerKindOf(key);
    // A caller we will write down is minted from a seed we hold, so the record
    // can bring it back. One we will not (anonymous) is minted the old way.
    const seed = persistable(key) ? mintSeed() : undefined;
    const agent = this.node!.addAgent(seed ? { nkeySeed: seed } : undefined);
    this.listenForLateReplies(agent);
    let ref: string;
    if (store && seed) {
      const record = newCallerRecord({
        callerKey: key,
        keyRecordId: kind === "account" ? key.slice("acctkey:".length) : null,
        accountId: await this.accountForCallerKey(key),
        agentId: agent.id,
        identitySeed: seed,
      });
      await store.put(record);
      ref = record.ref;
    } else {
      // No store (tests, minimal boots) or an anonymous caller: the handle
      // exists for this run so the marker is still well-formed on the wire.
      ref = randomUUID();
    }
    console.log(
      `[bridge] minted hosted identity for ${kind} caller ${ref.slice(0, 8)}: ${agent.id.slice(0, 12)}...`,
    );
    return { agent, lastUsed: Date.now(), ref, kind, markerRegistered: false };
  }

  /**
   * Register the caller identity's manifest so it carries the bridge extension
   * marker (§2.1 rule 2, §8.3). Unlisted and offering-nothing: the identity
   * answers no requests, and open discovery must not suggest it does.
   *
   * Anonymous callers are skipped. Their identity is an IP address with a
   * one-hour idle life, and publishing a registry entry per client address
   * would trade a bounded set of manifests for an unbounded one. They still
   * carry the marker on every envelope, which is where a receiver reads it.
   */
  private async registerCallerMarker(entry: HostedIdentity): Promise<void> {
    if (entry.kind === "anonymous") {
      entry.markerRegistered = true;
      return;
    }
    try {
      await entry.agent.register(inboundCallerManifest(this.markerFor(entry)));
      entry.markerRegistered = true;
    } catch (err) {
      console.warn(
        `[bridge] could not register the bridge marker for caller ${entry.ref.slice(0, 8)} (retrying on next use):`,
        err,
      );
    }
  }

  private markerFor(entry: HostedIdentity): InboundCallerMarker {
    return inboundCallerMarker({ node: this.node?.id ?? "", ref: entry.ref, kind: entry.kind });
  }

  /**
   * The §8.3 marker for an authorized caller key, ready to hand to
   * `request({ meta })`. Envelope `meta` is covered by the envelope signature,
   * so a receiver that reads this is reading something the bridge node signed
   * rather than a header anyone on the path could have added.
   *
   * Returns undefined for a caller with no live identity — there is nothing
   * truthful to say about a caller the bridge has not minted for.
   */
  attributionMeta(callerKey: string): { a2a_bridge: InboundCallerMarker } | undefined {
    const entry = this.identities.get(callerKey);
    return entry ? { a2a_bridge: this.markerFor(entry) } : undefined;
  }

  /** Token-bucket rate check for a caller key. Buckets are keyed independently
   *  of identities so a read that mints nothing (a card fetch, the index) is
   *  still counted against its caller. */
  rateOk(callerKey: string): boolean {
    return this.rates.take(callerKey);
  }

  /** Seconds a refused caller should wait, for `Retry-After`. */
  retryAfterSeconds(callerKey: string): number {
    return this.rates.retryAfterSeconds(callerKey);
  }

  /** The ACCOUNT behind a caller key: only self-serve minted keys have one.
   *  Env-list keys are the operator's, anonymous callers are nobody's — both
   *  answer null, and null cannot pay for anything. */
  async accountForCallerKey(callerKey: string): Promise<string | null> {
    if (!callerKey.startsWith("acctkey:")) return null;
    const rec = await this.config.keyStore?.get(callerKey.slice("acctkey:".length));
    return rec?.accountId ?? null;
  }

  /**
   * The account behind a hosted identity's AGENT id — the settlement's read:
   * the outbound tap sees the mesh caller's agent id, and this walks it back to
   * the account that presented the credential.
   *
   * The live pool is checked first because it is current, then the durable
   * record. The second lookup is the one that matters after the fact: an
   * identity evicted from the pool, or minted by a process that has since
   * exited, still resolves — which is the difference between an audit row that
   * names somebody and an audit row that names a string.
   */
  async accountForAgentId(agentId: string): Promise<string | null> {
    for (const [key, entry] of this.identities) {
      if (entry.agent.id === agentId) return this.accountForCallerKey(key);
    }
    return this.config.callerStore?.byAgentId(agentId)?.accountId ?? null;
  }

  /** The durable attribution record behind a hosted identity's agent id, with
   *  no secrets in it. The operator's "who was this?" — see /admin/callers. */
  callerForAgentId(agentId: string): RedactedCallerIdentity | undefined {
    const rec = this.config.callerStore?.byAgentId(agentId);
    return rec ? redactCaller(rec) : undefined;
  }

  /** The same lookup from the handle the §8.3 marker publishes. */
  callerForRef(ref: string): RedactedCallerIdentity | undefined {
    const rec = this.config.callerStore?.byRef(ref);
    return rec ? redactCaller(rec) : undefined;
  }

  /** Every caller this bridge has ever minted an identity for, redacted.
   *  Filtered by account, this is exactly the key list an account-scoped audit
   *  export needs in order to include its gateway traffic. */
  listCallers(accountId?: string | null): RedactedCallerIdentity[] {
    return (this.config.callerStore?.list(accountId) ?? []).map(redactCaller);
  }

  /** True when this agent id is one of the bridge's OWN hosted caller
   *  identities — i.e. its payment (or refusal) already happened at the 402
   *  gate. The priced-attachment admission hook's exemption test: everyone
   *  else is an un-cleared mesh-native caller.
   *
   *  The record is consulted alongside the live pool, so an identity that was
   *  evicted (or predates this process) is still recognised as the bridge's
   *  own and is not charged a second time on the mesh-native path. */
  isHostedCaller(agentId: string): boolean {
    for (const entry of this.identities.values()) {
      if (entry.agent.id === agentId) return true;
    }
    return this.config.callerStore?.byAgentId(agentId) !== undefined;
  }

  /**
   * Emit one gateway usage event on the mesh (topic `a2a_bridge.usage`), via
   * the courier. Nothing consumes it yet; that is the point — metering that
   * starts on billing's launch day has no history, so the meter runs from the
   * gateway's first day instead. Best-effort by construction: a usage event
   * must never fail, block, or outlive the work it describes.
   */
  emitUsage(event: Record<string, unknown>): void {
    try {
      (this.courier as unknown as { emit?: (topic: string, data: unknown) => void })?.emit?.(
        "a2a_bridge.usage",
        event,
      );
    } catch {
      // Swallowed on purpose; see above.
    }
  }

  /**
   * One INBOUND gateway call, on the same usage topic the outbound direction
   * uses. Until now the inbound direction emitted nothing at all, so the only
   * record of a bridged call was the activity tap's view of the mesh envelope —
   * which names the hosted identity and, before the caller store, could not be
   * walked back any further.
   *
   * `caller_ref` is on it; the ACCOUNT is not. This rides `mesh.event.*`, a bus
   * any credentialed subscriber can read, and an account id on it would be a
   * disclosure nobody asked for. The ref resolves to an account through
   * /admin/callers, which answers only the operator, on loopback.
   */
  emitInboundCall(callerKey: string, event: Record<string, unknown>): void {
    const entry = this.identities.get(callerKey);
    this.emitUsage({
      direction: "inbound",
      ...(entry ? { caller_ref: entry.ref, caller_kind: entry.kind, caller_agent: entry.agent.id } : {}),
      ...event,
    });
  }

  private evictOldestIdentity(): void {
    let oldest: [string, HostedIdentity] | null = null;
    for (const e of this.identities.entries()) {
      if (!oldest || e[1].lastUsed < oldest[1].lastUsed) oldest = e;
    }
    if (oldest) this.retireIdentity(oldest[0], oldest[1]);
  }

  /** Drop an identity from the LIVE pool. The durable record stays: the pool is
   *  a cache of open inboxes, the record is who the caller is, and the second
   *  question outlives the first. A persisted caller that comes back is revived
   *  from its seed with the same mesh id. */
  private retireIdentity(key: string, entry: HostedIdentity): void {
    this.identities.delete(key);
    this.rates.forget(key);
    // Take the marker manifest back out of the registry: nothing is listening
    // on that inbox any more, and a manifest is a claim about a live identity.
    // The record, not the registration, is what makes the id resolvable later.
    void entry.agent.deregister().catch(() => undefined);
    void this.node?.removeAgent(entry.agent.id);
  }

  // ─── Bridge-local task store (BRIDGE-A2A.md §4.1 GetTask) ──────────

  /**
   * A caller identity exists to ask, not to answer, so the one request it
   * takes is the late half of its own exchange: a node that queued a message
   * for an attended session (§6.4a) answers later with a fresh "chat"
   * request whose input names the original request in `in_reply_to`. That
   * request completes the queued task the caller is polling. Anything else
   * arriving here is refused by name.
   */
  private listenForLateReplies(agent: AgentMesh): void {
    // The fake node the tests hand back is narrower than the SDK's agent.
    if (typeof (agent as { onDefault?: unknown }).onDefault !== "function") return;
    agent.onDefault((input, ctx) => this.lateReply(input, ctx, agent));
  }

  /**
   * Wait for the late reply to a queued request (§6.4a), for a caller that
   * holds its HTTP exchange open instead of handing out a task: PACT's
   * message:send is synchronous (BRIDGE-A2A.md §14.7). Resolves with the
   * reply's body when the responder answers within `ms`, else null. Only the
   * agent the request went to may answer it, as for a queued task.
   */
  awaitLateReply(requestId: string, responder: string, ms: number): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.lateWaiters.delete(requestId);
        resolve(null);
      }, ms);
      timer.unref?.();
      this.lateWaiters.set(requestId, {
        responder,
        resolve: (body) => {
          clearTimeout(timer);
          this.lateWaiters.delete(requestId);
          resolve(body);
        },
      });
    });
  }

  private lateWaiters = new Map<string, { responder: string; resolve: (body: Record<string, unknown>) => void }>();

  private lateReply(input: unknown, ctx: RequestContext, agent?: AgentMesh): { received: true } | Promise<{ received: true }> {
    // The SDK frames and fences inbound sender text before a handler sees it,
    // for a handler that is a model reading its own inbox. This handler is
    // code, and it passes the answer on as a typed A2A part whose role says
    // who wrote it, so it reads the verbatim signed input from the envelope;
    // the framed copy is the fallback when the envelope carries none.
    const raw = (ctx.envelope?.payload as { input?: unknown } | undefined)?.input;
    const source = raw !== undefined ? raw : input;
    const body = source && typeof source === "object" && !Array.isArray(source) ? (source as Record<string, unknown>) : null;
    const irt = body && typeof body.in_reply_to === "string" ? body.in_reply_to : null;
    // A caller holding its exchange open for this reply (PACT) takes it first.
    const waiter = irt ? this.lateWaiters.get(irt) : undefined;
    if (waiter && waiter.responder === ctx.envelope.from) {
      waiter.resolve(body!);
      return { received: true };
    }
    const rec = irt ? this.tasks.get(irt) : undefined;
    // Only the agent the message was queued at may answer it: the envelope's
    // signed `from` is checked against the task's responder, so a third party
    // holding a task id cannot complete somebody else's wait.
    if (!rec || !rec.queued || rec.responder !== ctx.envelope.from) {
      throw new MeshError(
        ErrorCode.OFFERING_NOT_FOUND,
        "This gateway identity takes no requests of its own; it only receives the reply to a message it sent that was queued (input.in_reply_to naming that request).",
      );
    }
    const refusal = body!.error && typeof body!.error === "object" ? (body!.error as { code?: unknown; message?: unknown }) : null;
    // The adapter's reply carries bookkeeping beside the answer; the answer
    // is what becomes the artifact.
    const { in_reply_to: _irt, usage: _usage, cost: _cost, error: _error, ...answer } = body!;
    // Files the answer names only by mesh reference go out by signed link,
    // made with this gateway identity: the run-file door needs its owner's
    // session (AgentMesh technical debt 447). Only then is the reply recorded.
    const files = (answer as { files?: unknown }).files;
    if (agent && Array.isArray(files) && files.some((f) => f && typeof f === "object" && !(f as MeshFile).uri && (f as MeshFile).ref)) {
      return linkFiles(answer, meshLinker(agent)).then((linked) => this.recordLateReply(rec, refusal, linked as Record<string, unknown>));
    }
    return this.recordLateReply(rec, refusal, answer);
  }

  private recordLateReply(
    rec: TaskRecord,
    refusal: { code?: unknown; message?: unknown } | null,
    answer: Record<string, unknown>,
  ): { received: true } {
    const parts = outputToParts(answer);
    const timestamp = new Date().toISOString();
    const replyId = `${rec.task.id}-reply`;
    rec.task = {
      ...rec.task,
      status: {
        state: refusal ? "failed" : "completed",
        timestamp,
        message: {
          role: "ROLE_AGENT",
          parts: refusal ? [{ text: String(refusal.message ?? refusal.code ?? "The agent refused this message.") }] : parts,
          messageId: replyId,
        },
      },
      ...(refusal ? {} : { artifacts: [...(rec.task.artifacts ?? []), { artifactId: replyId, name: "reply", parts }] }),
    };
    return { received: true };
  }

  putTask(record: { task: A2ATask; responder: string; callerKey: string; queued?: { inbox_id: string | null } }): void {
    if (this.tasks.size >= TASK_MAX) {
      const first = this.tasks.keys().next().value;
      if (first) this.tasks.delete(first);
    }
    this.tasks.set(record.task.id, { ...record, createdAt: Date.now() });
  }

  getTaskRecord(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  updateTask(taskId: string, task: A2ATask): void {
    const rec = this.tasks.get(taskId);
    if (rec) rec.task = task;
  }

  private sweep(): void {
    const now = Date.now();
    const idTtl = this.config.guestIdentityTtlMs!;
    for (const [key, entry] of this.identities) {
      if (key.startsWith("ip:") && now - entry.lastUsed > idTtl) {
        this.retireIdentity(key, entry);
      }
    }
    for (const [id, rec] of this.tasks) {
      if (now - rec.createdAt > (rec.queued ? QUEUED_TASK_TTL_MS : TASK_TTL_MS)) this.tasks.delete(id);
    }
  }
}
