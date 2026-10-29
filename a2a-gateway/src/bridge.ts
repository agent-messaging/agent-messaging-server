/**
 * The bridge is a mesh NODE (BRIDGE-A2A.md §2): one credentialed connection,
 * vouching for hosted identities minted for external A2A parties. This module
 * owns the node, the inbound caller-identity pool, the exposure policy, and
 * the bridge-local task store.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createUser, fromSeed } from "nkeys.js";
import { MeshNode } from "../../sdk-typescript/src/node.js";
import { AgentMesh } from "../../sdk-typescript/src/mesh.js";
import type { Manifest } from "../../sdk-typescript/src/types/manifest.js";
import type { A2ATask } from "./core/jsonrpc.js";
import { linkFiles, meshLinker, outputToParts, type MeshFile } from "./core/parts.js";
import { MeshError, ErrorCode } from "../../sdk-typescript/src/types/errors.js";
import type { Envelope } from "../../sdk-typescript/src/types/envelope.js";
import { Subjects } from "../../sdk-typescript/src/internal/subjects.js";
import { meshStateToA2A } from "./core/states.js";
import { envelopeMetadata, markedForPerson, readableTextPart, stateMetadata } from "./core/over-a2a.js";

/** The words of a responder's update, as an A2A status message: what an
 *  `input-required` task asks for. */
function statusMessage(u: Envelope): { message?: A2ATask["status"]["message"] } {
  const text = (u.payload as { message?: unknown } | undefined)?.message;
  return typeof text === "string" && text ? { message: { role: "ROLE_AGENT", parts: [{ text }], messageId: `${u.id}-status` } } : {};
}

/** Task metadata without a stale `agentmesh.state`. */
function withoutState(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const { ["agentmesh.state"]: _s, ...rest } = meta ?? {};
  return rest;
}
import type { RequestContext } from "../../sdk-typescript/src/internal/offering-router.js";
import { BucketPool } from "./core/ratelimit.js";
import { meshAddress } from "./mesh-address.js";
import {
  BRIDGE_EXTENSION_URI,
  identityBridgeMarker,
  inboundCallerManifest,
  inboundCallerMarker,
  isA2aKind,
  type BridgeFront,
  type IdentityBridgeMarker,
  type InboundCallerMarker,
} from "./core/card.js";
import { ProofRefused, type BridgedCaller, type PresentedCredential, type ProofGate } from "./inbound/proofs.js";
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
  /** Outside proofs (inbound/proofs.ts, SPEC §4.15): callers that present an
   *  OAuth token or a SPIFFE JWT-SVID, checked with the server's key chain.
   *  Absent: such a credential is refused like an unknown key. */
  proofs?: ProofGate;
  /** The server's credential doors (its mesh API), handed to hosted
   *  identities as their platform address, so an agent's own admission can
   *  store its roster there. */
  coreUrl?: string;
}

/** The front the current call came in by, read when an envelope is signed,
 *  so every envelope a hosted identity sends carries the right marker. */
const frontOfCall = new AsyncLocalStorage<BridgeFront>();

/** Run `fn` as a call that came in by `front`. */
export function inFront<T>(front: BridgeFront, fn: () => T): T {
  return frontOfCall.run(front, fn);
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
  /** The identity's seed, when the bridge holds it here: what signs the
   *  questions to the key chain for a caller with an outside proof. */
  seed?: string;
  /** What the key chain last said about a caller with an outside proof. */
  bridged?: BridgedCaller;
  /** Whether this identity keeps an inbox (admission started), as the HTTPS
   *  and MCP fronts need. */
  inboxStarted?: boolean;
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
  /** Present when the caller signed the request itself (EXT-14): the caller's
   *  agent ID. A later act on the task (a cancel, an answer) has to be signed
   *  by the same key, because the gateway holds no identity for it. */
  signer?: string;
  /** Stops the watch on the Task's update subject (watchSignedTask). */
  stopWatch?: () => void;
  /** The offering the task's request named: what a caller's answer to an
   *  `input-required` task is sent on (EXT-14 §7). */
  offering?: string;
}

/** What the gateway's node offers for relaying (SDK MeshNode). */
interface RelayNode {
  relayEnvelope(env: Envelope): void;
  watchEnvelopes(subject: string, handler: (env: Envelope) => void): () => void;
}

/** How a relayed request ended (Bridge.relaySigned). */
export type RelayOutcome =
  | { kind: "answer"; envelope: Envelope }
  | { kind: "queued"; envelope: Envelope; byDoor: boolean };

const TERMINAL = new Set(["completed", "failed", "canceled", "rejected", "exhausted"]);

/** The §6.4a queued acknowledgement, at the top of the payload or in its
 *  output, as the SDK reads it. */
export function isQueuedAck(env: Envelope): boolean {
  if (env.error) return false;
  const p = env.payload as Record<string, unknown> | null | undefined;
  for (const c of [p, p?.output as Record<string, unknown> | null | undefined]) {
    if (c && typeof c === "object" && c.queued === true && typeof c.inbox_id === "string" && c.inbox_id) return true;
  }
  return false;
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
  private descriptorCache = new Map<string, { descriptor: Record<string, unknown> | null; bytes?: Uint8Array; at: number }>();
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
      // Hosted identities ask the server's doors (rosters, and the like) here.
      ...(this.config.coreUrl ? { platformApi: this.config.coreUrl } : {}),
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
    return (await this.agentDescriptorBytes(agentId))?.descriptor ?? null;
  }

  /** The agent's Descriptor as the registry holds it: the exact bytes its
   *  digest covers (EXT-14 §10), and the parsed document. Null when the agent
   *  submitted none. Cached a minute, the same as manifests. */
  async agentDescriptorBytes(agentId: string): Promise<{ descriptor: Record<string, unknown>; bytes: Uint8Array } | null> {
    const cached = this.descriptorCache.get(agentId);
    if (cached && Date.now() - cached.at < MANIFEST_CACHE_MS) {
      return cached.descriptor && cached.bytes ? { descriptor: cached.descriptor, bytes: cached.bytes } : null;
    }
    if (!this.courier || !/^[A-Z0-9]{56}$/.test(agentId)) return null;
    let descriptor: Record<string, unknown> | null = null;
    let bytes: Uint8Array | undefined;
    try {
      const p = (await this.courier.serviceRequest(`mesh.registry.descriptor.get.${agentId}`, {}, 5000)) as { descriptor?: unknown };
      if (typeof p?.descriptor === "string") {
        const raw = Buffer.from(p.descriptor, "base64");
        const doc = JSON.parse(raw.toString("utf8")) as unknown;
        if (doc && typeof doc === "object" && !Array.isArray(doc)) {
          descriptor = doc as Record<string, unknown>;
          bytes = new Uint8Array(raw);
        }
      }
    } catch {
      descriptor = null;
    }
    if (this.descriptorCache.size > 5000) this.descriptorCache.clear();
    this.descriptorCache.set(agentId, { descriptor, ...(bytes ? { bytes } : {}), at: Date.now() });
    return descriptor && bytes ? { descriptor, bytes } : null;
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
        // A sandbox key is its own kind of caller (SPEC §4.15).
        return { key: minted.kind === "sandbox" ? `sandbox:${minted.id}` : `acctkey:${minted.id}` };
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
    // A caller that is not an A2A client (a sandbox key) keeps an inbox, as the HTTPS and MCP fronts read it.
    if (!isA2aKind(entry.kind)) await this.ensureInbox(key).catch(() => undefined);
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
      if (isA2aKind(existing.kind)) this.listenForLateReplies(agent);
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
      const revived: HostedIdentity = { agent, lastUsed: Date.now(), ref: existing.ref, kind: existing.kind, markerRegistered: false, seed: existing.identitySeed };
      this.stampMarker(revived);
      return revived;
    }

    const kind = callerKindOf(key);
    // A caller we will write down is minted from a seed we hold, so the record
    // can bring it back. One we will not (anonymous) is minted the old way.
    const seed = persistable(key) ? mintSeed() : undefined;
    const agent = this.node!.addAgent(seed ? { nkeySeed: seed } : undefined);
    if (isA2aKind(kind)) this.listenForLateReplies(agent);
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
    const minted: HostedIdentity = { agent, lastUsed: Date.now(), ref, kind, markerRegistered: false, ...(seed ? { seed } : {}) };
    this.stampMarker(minted);
    return minted;
  }

  /** Every envelope a hosted identity signs carries the identity-bridge
   *  marker (SPEC §4.15), with the front the current call came in by. A2A
   *  calls also pass `meta.a2a_bridge` themselves (attributionMeta). */
  private stampMarker(entry: HostedIdentity): void {
    const agent = entry.agent as { setOutgoingMeta?: (fn: (() => Record<string, unknown> | undefined) | null) => void };
    if (typeof agent.setOutgoingMeta !== "function") return;
    agent.setOutgoingMeta(() => ({
      identity_bridge: identityBridgeMarker({ node: this.node?.id ?? "", ref: entry.ref, kind: entry.kind, front: frontOfCall.getStore() ?? "a2a" }),
    }));
  }

  /**
   * The hosted identity for a caller presenting an outside proof (SPEC
   * §4.15): an OAuth token or a SPIFFE JWT-SVID. The key chain checks the
   * proof (inbound/proofs.ts) before the identity is written down, so a
   * refused token leaves nothing behind. One lasting identity per issuer and
   * subject, or per SPIFFE ID: the same caller gets the same mesh key on
   * every call and after every restart.
   */
  async proofIdentity(
    cred: Extract<PresentedCredential, { type: "proof" }>,
    req: { method: string; url: string; dpop?: string },
  ): Promise<{ agent: AgentMesh; key: string; caller: BridgedCaller }> {
    const gate = this.config.proofs;
    if (!gate) throw new ProofRefused("This bridge does not accept outside proofs. Use an API key.", 401, "proofs_not_offered");
    if (!this.node) throw new Error("bridge is not connected to the mesh yet");
    const key = gate.callerKeyOf(cred);
    const signWith = (seed: string) => (message: string) =>
      Buffer.from(fromSeed(new TextEncoder().encode(seed)).sign(new TextEncoder().encode(message))).toString("base64");

    let entry = this.identities.get(key);
    if (entry?.seed) {
      entry.bridged = await gate.check(cred, req, entry.agent.id, signWith(entry.seed));
    } else {
      // Not in the live pool: from the record, else a fresh key kept only in
      // memory until the key chain says yes.
      const existing = this.config.callerStore?.byCallerKey(key);
      const seed = existing?.identitySeed ?? mintSeed();
      const probe = fromSeed(new TextEncoder().encode(seed)).getPublicKey();
      const bridged = await gate.check(cred, req, probe, signWith(seed));
      entry = this.identities.get(key);
      if (!entry) {
        if (this.identities.size >= IDENTITY_MAX) this.evictOldestIdentity();
        const agent = this.node.addAgent({ nkeySeed: seed });
        if (!existing && this.config.callerStore) {
          await this.config.callerStore.put(newCallerRecord({ callerKey: key, accountId: bridged.tenant, agentId: agent.id, identitySeed: seed, ref: bridged.caller_ref }));
        }
        entry = { agent, lastUsed: Date.now(), ref: existing?.ref ?? bridged.caller_ref, kind: callerKindOf(key), markerRegistered: false, seed };
        this.stampMarker(entry);
        this.identities.set(key, entry);
        console.log(`[bridge] ${existing ? "restored" : "minted"} hosted identity for ${entry.kind} caller ${bridged.workload_id}: ${agent.id.slice(0, 12)}...`);
      }
      entry.bridged = bridged;
    }
    entry.lastUsed = Date.now();
    this.config.callerStore?.touch(key);
    if (!entry.markerRegistered) await this.registerCallerMarker(entry);
    // Its inbox from the first call, so what other agents send it waits there.
    await this.ensureInbox(key).catch((err) => console.warn(`[bridge] the inbox of caller ${entry!.ref.slice(0, 8)} did not start: ${(err as Error).message}`));
    return { agent: entry.agent, key, caller: entry.bridged! };
  }

  /**
   * Make sure a hosted identity keeps an inbox (SPEC EXT-6 §7: the agent's
   * own admission, with every message for an offering nothing handles kept),
   * which is how a caller on the HTTPS and MCP fronts reads what arrives for
   * it. Once per identity per process.
   */
  async ensureInbox(key: string): Promise<void> {
    const entry = this.identities.get(key);
    if (!entry || entry.inboxStarted) return;
    const agent = entry.agent as AgentMesh & { admission?: { start(o: Record<string, unknown>): Promise<void> } };
    if (!agent.admission) return;
    await agent.admission.start({ inbox: true });
    entry.inboxStarted = true;
  }

  /** What the key chain said about a caller with an outside proof, and the
   *  live identity's kind and reference, for whoami. */
  callerInfo(key: string): { kind: CallerKind; ref: string; agent_id: string; bridged?: BridgedCaller } | null {
    const e = this.identities.get(key);
    return e ? { kind: e.kind, ref: e.ref, agent_id: e.agent.id, ...(e.bridged ? { bridged: e.bridged } : {}) } : null;
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
  attributionMeta(callerKey: string): { a2a_bridge: InboundCallerMarker; identity_bridge: IdentityBridgeMarker } | undefined;
  attributionMeta(callerKey: string, front: BridgeFront): { a2a_bridge?: InboundCallerMarker; identity_bridge: IdentityBridgeMarker } | undefined;
  attributionMeta(callerKey: string, front: BridgeFront = "a2a"): { a2a_bridge?: InboundCallerMarker; identity_bridge: IdentityBridgeMarker } | undefined {
    const entry = this.identities.get(callerKey);
    if (!entry) return undefined;
    const general = identityBridgeMarker({ node: this.node?.id ?? "", ref: entry.ref, kind: entry.kind, front });
    // A2A traffic carries the A2A marker as well, unchanged (BRIDGE-A2A.md §8.3).
    return front === "a2a" ? { a2a_bridge: this.markerFor(entry), identity_bridge: general } : { identity_bridge: general };
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
    // The person's reply to a message an A2A caller wrote to them (§8.4).
    const withPerson = agent as { onPersonMessage?: (h: ((m: { from: string; inReplyTo?: string; envelope: Envelope }) => void) | null) => void };
    if (typeof withPerson.onPersonMessage === "function") withPerson.onPersonMessage((m) => this.personReply(m));
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

  // ─── Agent Messaging over A2A: a caller's own signed request (EXT-14) ──

  /** The one key besides an addressed agent that may answer for it: the
   *  mesh's admission service, whose benign queued ack (EXT-6 §7) stands in
   *  for an agent that has not let the sender in. Pinned on first use, the way
   *  the SDK pins it (Agent Messaging §6.2). */
  private intermediaryPin: string | null = null;

  /**
   * Pass a caller's own signed request through to the mesh, unchanged, and
   * wait for the answer at the caller's inbox (EXT-14 §5). Nothing is
   * signed here and no hosted identity is used: the envelope travels on the
   * caller's signature and the receiver checks it like any native message.
   *
   * Resolves with the substantive answer, or with the queued acknowledgement
   * (the agent's node queued it for an attended session, or the mesh's door
   * has not let the caller in). An accept signal (§6.4a) resets the wait.
   * Rejects with TRANSPORT_TIMEOUT when nothing substantive arrives in time.
   */
  relaySigned(env: Envelope, timeoutMs = 60_000): Promise<RelayOutcome> {
    const node = this.node as (MeshNode & Partial<RelayNode>) | null;
    if (!node) throw new Error("bridge is not connected to the mesh yet");
    if (typeof node.relayEnvelope !== "function" || typeof node.watchEnvelopes !== "function") {
      throw new MeshError(ErrorCode.INTERNAL_ERROR, "This gateway's node cannot relay envelopes");
    }
    return new Promise<RelayOutcome>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let accepted = false;
      let stop: (() => void) | null = null;
      const settle = (fn: () => void): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try {
          stop?.();
        } catch {
          /* already gone */
        }
        fn();
      };
      const arm = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(
          () =>
            settle(() =>
              reject(
                new MeshError(
                  ErrorCode.TRANSPORT_TIMEOUT,
                  accepted
                    ? `${env.to} accepted the request but sent no answer within ${timeoutMs} ms`
                    : `No answer from ${env.to} within ${timeoutMs} ms`,
                  accepted ? { details: { accepted: true } } : undefined,
                ),
              ),
            ),
          timeoutMs,
        );
        (timer as { unref?: () => void }).unref?.();
      };
      stop = node.watchEnvelopes!(Subjects.agentInbox(env.from), (r) => {
        if (r.type !== "respond" || r.in_reply_to !== env.id) return;
        if (r.to !== undefined && r.to !== env.from) return;
        const queued = isQueuedAck(r);
        if (r.from !== env.to) {
          // Only the mesh's door answers for an agent, and only with the ack.
          if (!queued) return;
          if (this.intermediaryPin === null) this.intermediaryPin = r.from;
          else if (this.intermediaryPin !== r.from) return;
          settle(() => resolve({ kind: "queued", envelope: r, byDoor: true }));
          return;
        }
        if (!r.error && (r.payload as { status?: unknown } | undefined)?.status === "accepted") {
          accepted = true;
          arm();
          return;
        }
        if (queued) {
          settle(() => resolve({ kind: "queued", envelope: r, byDoor: false }));
          return;
        }
        settle(() => resolve({ kind: "answer", envelope: r }));
      });
      arm();
      try {
        node.relayEnvelope!(env);
      } catch (err) {
        settle(() => reject(err));
      }
    });
  }

  /**
   * Keep a signed caller's Task record current from the responder's own
   * signed updates on the Task's update subject (Agent Messaging §7.3), since
   * no hosted identity tracks it. Only an update the responder signed is
   * applied. The watch ends when the Task ends or its record is swept.
   */
  watchSignedTask(taskId: string, responder: string): void {
    const node = this.node as (MeshNode & Partial<RelayNode>) | null;
    if (!node || typeof node.watchEnvelopes !== "function") return;
    const rec = this.tasks.get(taskId);
    if (!rec) return;
    rec.stopWatch?.();
    rec.stopWatch = node.watchEnvelopes(Subjects.taskUpdate(taskId), (u) => {
      if (u.from !== responder || u.task_id !== taskId) return;
      const status = (u.payload as { status?: unknown } | undefined)?.status;
      if (typeof status !== "string") return;
      const current = this.tasks.get(taskId);
      if (!current) return;
      current.task = {
        ...current.task,
        status: { state: meshStateToA2A(status as never), timestamp: new Date().toISOString(), ...statusMessage(u) },
        metadata: { ...withoutState(current.task.metadata), ...envelopeMetadata(u), ...stateMetadata(status) },
      };
      if (TERMINAL.has(status)) {
        current.stopWatch?.();
        current.stopWatch = undefined;
      }
    });
  }

  /**
   * The late answer to a signed request that was queued (§6.4a): the agent
   * answers later, at the signer's inbox, either with a fresh request whose
   * `input.in_reply_to` names the original (the attended-session reply) or
   * with a respond to it (a person's reply, §5.7). Only the agent the request
   * went to may complete it. The watch lasts as long as the task record.
   */
  watchSignedLateReply(requestId: string, signer: string, responder: string): void {
    const node = this.node as (MeshNode & Partial<RelayNode>) | null;
    if (!node || typeof node.watchEnvelopes !== "function") return;
    const rec = this.tasks.get(requestId);
    if (!rec) return;
    rec.stopWatch?.();
    rec.stopWatch = node.watchEnvelopes(Subjects.agentInbox(signer), (u) => {
      if (u.from !== responder || (u.to !== undefined && u.to !== signer)) return;
      const input = (u.payload as { input?: { in_reply_to?: unknown } } | undefined)?.input;
      const names = u.type === "respond" ? u.in_reply_to === requestId && !isQueuedAck(u) && (u.payload as { status?: unknown } | undefined)?.status !== "accepted" : u.type === "request" && input?.in_reply_to === requestId;
      if (!names) return;
      const current = this.tasks.get(requestId);
      if (!current) return;
      current.stopWatch?.();
      current.stopWatch = undefined;
      this.recordSignedReply(current, u);
    });
  }

  private recordSignedReply(rec: TaskRecord, u: Envelope): void {
    const person = markedForPerson(u);
    const p = (u.payload ?? {}) as { input?: Record<string, unknown>; output?: unknown; text?: unknown; status?: unknown };
    const failed = !!u.error || p.status === "failed" || p.status === "rejected";
    let body: unknown = u.type === "request" ? p.input : p.output;
    if (u.type === "request" && body && typeof body === "object") {
      const { in_reply_to: _i, usage: _u, cost: _c, error: _e, ...answer } = body as Record<string, unknown>;
      body = answer;
    }
    const parts = person ? [readableTextPart(u)] : body !== undefined ? outputToParts(body) : typeof p.text === "string" ? outputToParts({ text: p.text }) : [];
    const replyId = `${rec.task.id}-reply`;
    rec.task = {
      ...rec.task,
      status: {
        state: failed ? "failed" : "completed",
        timestamp: new Date().toISOString(),
        message: { role: "ROLE_AGENT", parts, messageId: replyId, metadata: { ...envelopeMetadata(u), ...(person ? { "agentmesh.audience": "person" } : {}) } },
      },
      metadata: { ...(rec.task.metadata ?? {}), ...envelopeMetadata(u) },
      ...(failed ? {} : { artifacts: [...(rec.task.artifacts ?? []), { artifactId: replyId, name: "reply", parts }] }),
    };
  }

  /**
   * A person's reply (§5.7) to a message an A2A caller wrote to them (§8.4),
   * arriving at the caller's hosted identity. It completes the gateway's
   * record with the reply's readable text (Agent Messaging §5.8) and the
   * agent's signed envelope beside it. Only the agent the message went to may
   * answer it.
   */
  private personReply(msg: { from: string; inReplyTo?: string; envelope: Envelope }): void {
    const rec = msg.inReplyTo ? this.tasks.get(msg.inReplyTo) : undefined;
    if (!rec || rec.responder !== msg.from || rec.task.metadata?.["agentmesh.audience"] !== "person") return;
    this.recordSignedReply(rec, msg.envelope);
  }

  /**
   * A hosted caller's task as its identity tracks it now (the SDK follows the
   * responder's signed updates on the task's subject), folded into the
   * gateway's record so GetTask says where the work stands, an
   * `input-required` included, and not only what the first answer said.
   */
  refreshFromHosted(rec: TaskRecord): void {
    if (rec.signer || rec.queued) return;
    const entry = this.identities.get(rec.callerKey);
    const live = (entry?.agent as { getTask?: (id: string) => { state?: string; history?: Envelope[] } | undefined } | undefined)?.getTask?.(rec.task.id);
    if (!live?.state) return;
    const state = meshStateToA2A(live.state as never);
    if (state === rec.task.status.state && !stateMetadata(live.state)["agentmesh.state"]) return;
    const last = Array.isArray(live.history) ? live.history[live.history.length - 1] : undefined;
    rec.task = {
      ...rec.task,
      status: { state, timestamp: new Date().toISOString(), ...(last ? statusMessage(last) : {}) },
      metadata: { ...withoutState(rec.task.metadata), ...stateMetadata(live.state) },
    };
  }

  putTask(record: { task: A2ATask; responder: string; callerKey: string; queued?: { inbox_id: string | null }; signer?: string; offering?: string }): void {
    if (this.tasks.size >= TASK_MAX) {
      const first = this.tasks.keys().next().value;
      if (first) {
        this.tasks.get(first)?.stopWatch?.();
        this.tasks.delete(first);
      }
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
      if (now - rec.createdAt > (rec.queued ? QUEUED_TASK_TTL_MS : TASK_TTL_MS)) {
        rec.stopWatch?.();
        this.tasks.delete(id);
      }
    }
  }
}
