import { nkeys } from "./internal/nkeys.js";
import { jwtAuthenticator } from "nats.ws";
import type { Availability, NodeDeclaredProfile } from "./types/manifest.js";
import type { ConnectOptions, SecurityWarning } from "./types/options.js";
import { ConnectionManager } from "./internal/connection.js";
import { createEnvelope } from "./internal/envelope-builder.js";
import { signEnvelope, type KeyPair } from "./internal/identity.js";
import { withDetectedDevice } from "./internal/device-profile.js";
import { encode } from "./internal/codec.js";
import { Subjects } from "./internal/subjects.js";
import { setUnrefInterval, type TimerHandle } from "./internal/timers.js";
import { vouchCheckIntervalMs } from "./internal/vouch.js";
import { CredentialRenewer, type CredentialStatus } from "./credential.js";
import { AgentMesh } from "./mesh.js";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_VOUCH_TTL_MS } from "./constants.js";

export interface NodeConnectOptions {
  /** JWT for the node's authenticated connection. Combined with `nodeSeed` —
   *  the NODE holds the transport credential (§4.2), not its agents. */
  jwt?: string;
  /** Node NKey seed (string or bytes). The node's public key is the node ID.
   *  If omitted, a fresh node key is generated (dev/self-contained use). */
  nodeSeed?: string | Uint8Array;
  /** The node's self-declared profile (§9.7): expected uptime, reachability,
   *  capacity. Attached to every hosted agent's registration by default. */
  profile?: NodeDeclaredProfile;
  /** Lifetime of the vouches this node signs (§4.4), in ms. Default 30 days.
   *  Also the renewal cadence: the node re-vouches each hosted agent at two
   *  thirds of it. */
  vouchTtlMs?: number;
  /** Keep the NODE credential alive (§4.8).
   *
   *  The node's credential is a lease with a finite expiry, and this is the
   *  thing that renews it — at two thirds of its own lifetime, the same
   *  schedule the vouches this node signs already use, through
   *  `POST {apiBase}/v1/node-credential`.
   *
   *  The roster is read at each renewal from the agents currently hosted, so an
   *  agent added later is covered by the next credential without any
   *  bookkeeping here. Nothing reconnects: the fresh credential matters at the
   *  next connect, and `onRenewed` is where a host writes it down.
   *
   *  Unset means the node does nothing about its credential, which is right for
   *  a dev node with a generated key and wrong for anything durable. */
  credentialRenewal?: {
    /** Control-plane origin, e.g. `https://api.agentmesh.ai`. */
    apiBase: string;
    /** Where the fresh credential goes. Called before the node adopts it. */
    onRenewed?: (c: { jwt: string; node_id: string; agents: string[]; expires_at: string | null }) => void | Promise<void>;
  };
  /** Extra transport options (reconnect behavior, connection name, etc.). */
  transport?: Omit<ConnectOptions, "servers" | "jwt" | "nkeySeed" | "nodeSeed" | "authenticator">;
}

export interface AddAgentOptions {
  /** Agent NKey seed. If omitted, a fresh agent keypair is generated — creating
   *  an agent is a local, zero-round-trip operation (§4.3). */
  nkeySeed?: string | Uint8Array;
  /** The agent's X25519 encryption secret (§4.3), as `connect()` takes it. A
   *  hosted agent that has one publishes `encryption_key` in its manifest,
   *  opens payloads sealed to it and seals its answers back (§8.9). Without
   *  it a hosted agent could not take part in sealing at all, which left a
   *  node's agents the only ones on the mesh a sender could not seal to. */
  encryptionSeed?: string;
}

/**
 * A mesh **Node** (§2, §4): one host, one transport connection, one credential —
 * hosting N agents, each with its own keypair, vouched for by this node (§4.4).
 *
 * This is the 0.2 model: agents do NOT hold transport credentials or open
 * connections. The node connects once (authenticated by the NODE key), then
 * `addAgent()` creates cheap keypair-only agent identities that all share the
 * connection. One node heartbeat covers every hosted agent (§9.6).
 *
 * For the degenerate single-agent case (node key = agent key), the standalone
 * `AgentMesh.connect()` remains the shortcut; use MeshNode when one host serves
 * multiple agents — the per-agent-credential ceremony this replaces is exactly
 * what §4.1 removed from v0.1.
 */
export class MeshNode {
  private conn: ConnectionManager;
  private nodeKp: KeyPair;
  private nodeProfile?: NodeDeclaredProfile;
  private agents = new Map<string, AgentMesh>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** One renewal loop for every agent this node vouches for (§4.4). */
  private vouchTimer: TimerHandle | null = null;
  private vouchTtlMs = DEFAULT_VOUCH_TTL_MS;
  /** True only when the embedder chose a TTL. Hosted agents inherit the
   *  node's TTL ONLY then — otherwise each agent's registration decides its
   *  own lease from what its profile declares (§9.2 retention defaults). */
  private vouchTtlExplicit = false;
  private onSecurityWarning?: (w: SecurityWarning) => void;
  /** Inbound framing + size cap for every agent this node hosts. Read from the
   *  node's transport options once and handed to each `addAgent`, so a hosted
   *  agent is guarded exactly like a standalone one instead of relying on the
   *  caller to remember per agent. `undefined` = the SDK default (framing on). */
  private fenceInbound?: boolean;
  private maxInboundChars?: number;
  /** §5.3 revoked-sender refusal for every hosted agent. `undefined` = on. */
  private refuseRevokedSenders?: boolean;
  /** How often each hosted agent re-runs its §16.4 mailbox drain. Node-level for
   *  the same reason as the two above: the cadence is a property of the host, and
   *  every agent on this connection shares one reconnect stream. */
  private mailboxDrainIntervalMs?: number;
  /** §13.1.1 span emission for every agent this node hosts. Node-level because
   *  it is an operator's decision about a host, not something each agent should
   *  be able to switch on for itself. Off unless set. */
  private emitSpans?: boolean;
  /**
   * The mesh URL(s) this node dialled, handed to each hosted agent.
   *
   * Needed for ONE thing: the `acl` grade's room-scoped second connection
   * (EXT-5 §7.2). Room traffic at that grade rides `mesh.aclroom.<id>.>`, which
   * the broker permits only on the short-lived credential the rooms service
   * mints per member per room — so it cannot ride the node's own connection,
   * whatever that connection is allowed to do.
   *
   * Empty for `withConn`: a caller-supplied connection carries no URL to
   * redial, and `openAclTransport` says so rather than dialling nothing.
   */
  private servers: string[] = [];
  /** The §4.8 credential lease loop, or null when the embedder configured no
   *  `credentialRenewal`. One per node, because there is one credential. */
  private credRenewer: CredentialRenewer | null = null;
  private _closed = false;

  private constructor(conn: ConnectionManager, nodeKp: KeyPair, profile?: NodeDeclaredProfile) {
    this.conn = conn;
    this.nodeKp = nodeKp;
    this.nodeProfile = profile;
  }

  /** Connect to the mesh as a node. The connection is authenticated with the
   *  NODE credential (jwt + nodeSeed); hosted agents share it. */
  static async connect(servers: string | string[], opts?: NodeConnectOptions): Promise<MeshNode> {
    const toSeedBytes = (s?: string | Uint8Array): Uint8Array | undefined =>
      s === undefined ? undefined : typeof s === "string" ? new TextEncoder().encode(s) : s;
    const nodeSeedBytes = toSeedBytes(opts?.nodeSeed);

    const connectOpts: ConnectOptions = { servers, ...(opts?.transport ?? {}) };
    if (opts?.jwt && nodeSeedBytes) {
      connectOpts.authenticator = jwtAuthenticator(opts.jwt, nodeSeedBytes);
    }
    const conn = await ConnectionManager.connect(connectOpts);

    const nodeKp = nodeSeedBytes ? nkeys.fromSeed(nodeSeedBytes) : nkeys.createUser();
    // EXT-1: auto-fill device attributes (platform, client) under the caller's
    // declared profile — caller-supplied keys always win.
    const node = new MeshNode(conn, nodeKp, withDetectedDevice(opts?.profile));
    node.servers = Array.isArray(servers) ? servers : [servers];
    if (opts?.vouchTtlMs !== undefined) { node.vouchTtlMs = opts.vouchTtlMs; node.vouchTtlExplicit = true; }
    node.onSecurityWarning = opts?.transport?.onSecurityWarning;
    node.fenceInbound = opts?.transport?.fenceInbound;
    node.refuseRevokedSenders = opts?.transport?.refuseRevokedSenders;
    node.maxInboundChars = opts?.transport?.maxInboundChars;
    node.mailboxDrainIntervalMs = opts?.transport?.mailboxDrainIntervalMs;
    node.emitSpans = opts?.transport?.emitSpans;
    if (opts?.credentialRenewal && opts.jwt && opts.nodeSeed !== undefined) {
      node.startCredentialRenewal(opts.credentialRenewal, opts.jwt, opts.nodeSeed);
    }
    return node;
  }

  /** @internal Construct a node over an existing connection (tests, embedders). */
  static withConnection(
    conn: ConnectionManager,
    nodeKp: KeyPair,
    profile?: NodeDeclaredProfile,
    opts?: {
      vouchTtlMs?: number;
      onSecurityWarning?: (w: SecurityWarning) => void;
      fenceInbound?: boolean;
      maxInboundChars?: number;
      mailboxDrainIntervalMs?: number;
      emitSpans?: boolean;
      refuseRevokedSenders?: boolean;
    },
  ): MeshNode {
    const node = new MeshNode(conn, nodeKp, profile);
    if (opts?.vouchTtlMs !== undefined) { node.vouchTtlMs = opts.vouchTtlMs; node.vouchTtlExplicit = true; }
    node.onSecurityWarning = opts?.onSecurityWarning;
    node.fenceInbound = opts?.fenceInbound;
    node.refuseRevokedSenders = opts?.refuseRevokedSenders;
    node.emitSpans = opts?.emitSpans;
    node.maxInboundChars = opts?.maxInboundChars;
    node.mailboxDrainIntervalMs = opts?.mailboxDrainIntervalMs;
    return node;
  }

  /** The node ID (the node key's public key). */
  get id(): string {
    return this.nodeKp.getPublicKey();
  }

  /** The node's declared profile (§9.7), if any. */
  get profile(): NodeDeclaredProfile | undefined {
    return this.nodeProfile;
  }

  /** Number of agents currently hosted by this node. */
  get agentCount(): number {
    return this.agents.size;
  }

  /** A hosted agent by its agent ID. */
  getAgent(agentId: string): AgentMesh | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Create an agent hosted by this node. The agent gets its own keypair (its
   * public key is its agent ID), shares the node's connection, and is vouched
   * for by this node's key at register (§4.4). The node's declared profile is
   * attached to the agent's registration by default (§9.7).
   */
  addAgent(opts?: AddAgentOptions): AgentMesh {
    if (this._closed) throw new Error("MeshNode is closed");
    const agent = AgentMesh.hostedBy(this.conn, this.nodeKp, {
      nkeySeed: opts?.nkeySeed,
      encryptionSeed: opts?.encryptionSeed,
      nodeProfile: this.nodeProfile,
      onSecurityWarning: this.onSecurityWarning,
      vouchTtlMs: this.vouchTtlExplicit ? this.vouchTtlMs : undefined,
      fenceInbound: this.fenceInbound,
      refuseRevokedSenders: this.refuseRevokedSenders,
      maxInboundChars: this.maxInboundChars,
      mailboxDrainIntervalMs: this.mailboxDrainIntervalMs,
      emitSpans: this.emitSpans,
      // So a hosted agent can open an acl room's scoped connection. Without it
      // every node-hosted agent was locked out of the one room grade whose
      // membership the broker actually enforces.
      servers: this.servers,
    });
    this.agents.set(agent.id, agent);
    this.startVouchRenewal();
    return agent;
  }

  /** Detach a hosted agent: unsubscribes it and removes it from this node.
   *  (Deregistration from the registry is the agent's own concern.) */
  async removeAgent(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    this.agents.delete(agentId);
    await agent.close(); // hosted agent: detaches subscriptions, leaves the connection open
    if (this.agents.size === 0) this.stopVouchRenewal();
    return true;
  }

  // ─── Vouch renewal (§4.4): one node, one loop, N re-vouched agents ──
  //
  // The vouch a hosted agent registers with is signed by THIS node's key and
  // expires (default 30 days). The registry enforces that expiry at both ends —
  // it refuses an expired attestation at register (§9.7) and reclaims a
  // registration whose attestation lapsed — so a node that stays up for a month
  // watches its agents drop out of discovery one by one unless it re-vouches
  // them. That is this loop.
  //
  // It lives on the NODE, not on each agent: the node key is the signer, and one
  // timer covering N agents is one thing to reason about (and to stop) instead of
  // N. The per-agent work is the agent's own re-registration, because only the
  // agent can re-sign its manifest key claim (§8.3) with its own key — the node
  // supplies the vouch, the agent supplies its signature, exactly as at first
  // registration.

  /** Re-vouch every hosted agent whose vouch has reached its renewal deadline.
   *  Agents that are not registered, already closed, or not yet due are skipped.
   *  Never throws; a failure is reported through `onSecurityWarning` and retried
   *  on the next pass. Returns how many were renewed. */
  async renewVouches(now = Date.now()): Promise<number> {
    let renewed = 0;
    for (const agent of [...this.agents.values()]) {
      if (await agent.renewVouchIfDue(now)) renewed++;
    }
    return renewed;
  }

  private startVouchRenewal(): void {
    if (this.vouchTimer !== null) return;
    this.vouchTimer = setUnrefInterval(
      () => void this.renewVouches(),
      vouchCheckIntervalMs(this.vouchTtlMs),
    );
  }

  private stopVouchRenewal(): void {
    if (this.vouchTimer !== null) {
      clearInterval(this.vouchTimer);
      this.vouchTimer = null;
    }
  }

  // ─── Credential renewal (§4.8): one node, one credential, one lease ──
  //
  // The layer below the vouch loop, and the one whose lapse is harder. An
  // expired VOUCH costs discovery: the agents drop out of the registry and a
  // re-registration puts them back. An expired CREDENTIAL costs the connection
  // itself — the broker refuses it, and no amount of retrying on the mesh can
  // fix a problem that stops you reaching the mesh.
  //
  // Which is why renewal is HTTPS and not a mesh call: it stays available
  // exactly when the credential does not. A node that was switched off through
  // its whole renewal window comes back with a dead credential, renews over
  // HTTPS, and connects — no operator, no re-bootstrap, no lost identity.

  /** @internal Arm the credential loop. Also renews immediately if the
   *  credential is already past its deadline, which is the case that matters:
   *  a node returning from a long sleep. */
  private startCredentialRenewal(
    cfg: NonNullable<NodeConnectOptions["credentialRenewal"]>,
    jwt: string,
    nodeSeed: string | Uint8Array,
  ): void {
    this.credRenewer = new CredentialRenewer({
      apiBase: cfg.apiBase,
      jwt,
      nodeSeed,
      // Read at renewal time: an agent added after this node connected is
      // covered by the next credential without anything re-registering it here.
      agents: () =>
        [...this.agents.values()].map((a) => ({ id: a.id, sign: (m: string) => a.signDetached(m) })),
      onRenewed: cfg.onRenewed,
      onWarning: (w) => this.onSecurityWarning?.(w as SecurityWarning),
    });
    this.credRenewer.start();
  }

  /** When this node's credential expires, when it is next due for renewal, and
   *  why the last attempt failed (§4.8). All-null when no `credentialRenewal`
   *  was configured; an `expires_at` of null on a configured node means the
   *  credential carries no expiry at all, which is the pre-§4.8 shape. */
  get credential(): CredentialStatus {
    return (
      this.credRenewer?.status() ?? {
        expires_at: null,
        renew_at: null,
        expired: false,
        last_error: null,
      }
    );
  }

  /** Renew the node credential now, regardless of schedule. Throws when no
   *  `credentialRenewal` was configured, or when the mesh refuses — a refusal
   *  IS the revocation mechanism (§4.8), so treat it as a real answer rather
   *  than a transient fault. */
  async renewCredential(): Promise<void> {
    if (!this.credRenewer) {
      throw new Error("renewCredential(): this node was connected without credentialRenewal");
    }
    await this.credRenewer.renew();
  }

  /** @internal Renew if the deadline has passed. Never throws. Exposed so a
   *  supervisor can drive the check on its own clock. */
  async renewCredentialIfDue(now = Date.now()): Promise<boolean> {
    return (await this.credRenewer?.renewIfDue(now)) ?? false;
  }

  // ─── Node heartbeat (§9.6): one heartbeat covers all hosted agents ──

  /** Send a single node heartbeat, signed by the node key, from the node ID. */
  sendHeartbeat(availability?: Availability): void {
    const nodeId = this.id;
    const envelope = signEnvelope(
      createEnvelope({
        type: "emit",
        from: nodeId,
        payload: { node: nodeId, availability: availability ?? "online" },
      }),
      this.nodeKp,
    );
    this.conn.publish(Subjects.heartbeat(nodeId), encode(envelope));
  }

  /** Start the periodic node heartbeat. */
  startHeartbeat(intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS): void {
    this.stopHeartbeat();
    this.sendHeartbeat();
    // A timer must never throw (it would end the host process); a beat on a
    // connection that closed under it is dropped and the timer stops.
    this.heartbeatTimer = setInterval(() => {
      try {
        this.sendHeartbeat();
      } catch (err) {
        if ((err as { code?: string })?.code === "CONNECTION_CLOSED") this.stopHeartbeat();
      }
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /** Gracefully drain: detach all hosted agents, then drain the connection. */
  async drain(): Promise<void> {
    this.stopHeartbeat();
    this.stopVouchRenewal();
    this.credRenewer?.stop();
    for (const agent of this.agents.values()) await agent.drain();
    this.agents.clear();
    await this.conn.drain();
    this._closed = true;
  }

  /** Close immediately: detach all hosted agents, then close the connection. */
  async close(): Promise<void> {
    this.stopHeartbeat();
    this.stopVouchRenewal();
    this.credRenewer?.stop();
    for (const agent of this.agents.values()) await agent.close();
    this.agents.clear();
    await this.conn.close();
    this._closed = true;
  }

  get isClosed(): boolean {
    return this._closed || this.conn.isClosed;
  }
}
