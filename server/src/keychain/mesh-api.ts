/**
 * The core's mesh API: the credential doors (doors.ts) over HTTP, served by the
 * core's own process (step 3 of docs/agent-messaging-server-plan.md).
 *
 *   POST /v1/bootstrap   POST /v1/node-credential   POST /v1/credential/revoke-own
 *   POST /v1/agent-key/revoke-own   GET /v1/key-check/:key   GET /health
 *   POST /v1/key-standing (whether an account holds the caller's own agent key;
 *   the adapter asks it on a mesh that offers no naming, so AgentMesh's edge
 *   does not route it)
 *
 * and the registry's documents over HTTPS (registry/documents-http.ts, step
 * 10a): GET /v1/agents/:key/descriptor, /v1/descriptors/:digest,
 * /v1/agents/:key/eval-record, /v1/eval-records/:digest, /v1/gateway-check/:key.
 *
 * and the capabilities answer, GET /v1/capabilities (shared/capabilities.ts):
 * what this mesh offers, with the platform's entries on top when it runs
 * beside it. `GET /v1/capabilities?core=1` is the core's own answer alone,
 * which a platform beside it reads to put its entries on (step 10a).
 *
 * And the admin API under /admin/v1 (admin/admin-api.ts): tenants, agents,
 * credentials, the kill switch's cut and the audit log, for the mesh's
 * operator. It needs an admin token (MESH_ADMIN_TOKEN_FILE, admin/admin-auth.ts)
 * and refuses a request that came through a proxy unless
 * MESH_ADMIN_THROUGH_PROXY=on, so an edge that forwarded it by mistake still
 * gets nothing. AgentMesh's edge sends only the five credential paths here.
 *
 * Enrollment, renewal and revocation answer from the core's stores. When the
 * AgentMesh platform runs beside it (PLATFORM_STEPS_URL, the API's loopback
 * address), the platform's steps are asked there (platform-steps.ts); without
 * it the doors work alone. The edge (Caddy) sends these five paths here, so
 * no client's address changes.
 *
 * Settings, all optional: MESH_API_PORT (3005), MESH_API_HOST (127.0.0.1),
 * PLATFORM_STEPS_URL (none), MESH_PUBLIC_URL or API_BASE_URL (the address in
 * `renew_url`), MESH_NAME, MESH_NATS_ENDPOINTS and MESH_AMQP_ENDPOINTS (the
 * `mesh` block a minted credential comes back with, mesh-object.ts).
 */
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer, type Server as TlsServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { createTrustAttestation, nkeys } from "../sdk.js";
import { startBrokerAuthFor, storageOf, type StorageLike } from "../storage/index.js";
import { adminReads } from "../admin/admin-reads.js";
import { wouldRefuseLog } from "../shared/require-names.js";
import { adminViews } from "../admin/admin-views.js";
import { adminAdmission } from "../admin/admin-admission.js";
import { adminOwners } from "../admin/admin-owners.js";
import { adminAudit } from "../admin/admin-audit.js";
import { adminCredentials } from "../admin/admin-credentials.js";
import { adminKeychain } from "../admin/admin-keychain.js";
import { meshPause } from "./mesh-pause.js";
import { identityFromEnv } from "../shared/seed.js";
import { HeldStore } from "../admission/held-store.js";
import { InboxBuffer } from "../registry/inbox-buffer.js";
import { AuditLog } from "../activity/audit-log.js";
import { adminApi, type AdminApi } from "../admin/admin-api.js";
import { AdminAuth } from "../admin/admin-auth.js";
import { AdmissionStore } from "../admission/admission-store.js";
import { rosterDoor, type RosterDoor } from "../admission/roster-door.js";
import { dataDbPath } from "../data-dir.js";
import { AgentKeyRevocationStore } from "../shared/agent-key-revocations.js";
import { AgentStatusStore } from "../shared/agent-status.js";
import { coreCapabilities, withPlatform } from "../shared/capabilities.js";
import { metrics } from "../shared/ops-events.js";
import { AgentOwnerStore } from "./agent-owners.js";
import { BootTokens } from "./boot-tokens.js";
import { CredMintLog } from "./cred-mint-log.js";
import { CredRevocationStore } from "./cred-revocation.js";
import { revokeCredential, type CredentialRevokeInput } from "./credential-revoke.js";
import { credentialDoors, type CredentialDoors, type DoorAnswer, type PlatformSteps } from "./doors.js";
import { cutConnections } from "./kill-switch-cut.js";
import { connectBrokerAdmin, liveRevokeConfig } from "./live-revoke.js";
import { meshInfo } from "./mesh-object.js";
import { loopbackPlatformSteps, PlatformStepUnavailable } from "./platform-steps.js";
import { customerMintSeed } from "./split-keys.js";
import { StopStore } from "./stop-store.js";
import { TenantLimitStore } from "./tenant-limits.js";
import { TrustAnchorStore } from "./trust-anchors.js";
import { HttpProofKeys } from "./proof-keys.js";
import { ReplayCache } from "./outside-proof.js";
import { IdentitySourceStore, WorkloadBindingStore } from "./identity-records.js";
import { adminTrust } from "../admin/admin-trust.js";
import { stopSignals, type StopSignalReceiver } from "./stop-signals.js";
import { meshHome } from "../shared/capabilities.js";
import { registryDocuments, registryDocumentRoute, type RawAnswer, type RegistryDocuments } from "../registry/documents-http.js";
import { adminUsage } from "../admin/admin-usage.js";
import { adminStreams } from "../admin/admin-streams.js";
import { UsageStore } from "../activity/usage-store.js";

const MAX_BODY = 256 * 1024;

export interface MeshApiOptions {
  port?: number;
  host?: string;
  /** Remove a registration on its owner's authority, when the registry runs
   *  in this process (a revoke may deregister). */
  deregister?: ((agentKey: string) => Promise<void>) | null;
  /** The platform's steps; defaults to PLATFORM_STEPS_URL over loopback, or none. */
  platform?: PlatformSteps;
  env?: NodeJS.ProcessEnv;
}

/** The `mesh` block every minted credential comes back with (mesh-object.ts). */
export { meshInfo };

/** GET /v1/capabilities: what this mesh offers. With the platform beside it,
 *  the platform's entries go on top. A platform step that does not answer
 *  throws PlatformStepUnavailable, which the route answers 503: never the
 *  core's list alone, which would tell clients the platform is gone. */
export async function capabilitiesAnswer(platform: PlatformSteps): Promise<DoorAnswer> {
  const extra = platform.capabilities ? await platform.capabilities() : null;
  return { status: 200, body: withPlatform(coreCapabilities(), extra) as Record<string, unknown> };
}

export class MeshApi {
  private server: Server | null = null;

  private constructor(
    private doors: CredentialDoors,
    private platform: PlatformSteps,
    private port: number,
    private host: string,
    private env: NodeJS.ProcessEnv,
    private admin: AdminApi | null = null,
    private adminAuth: AdminAuth | null = null,
    private docs: RegistryDocuments | null = null,
  ) {}

  static async create(js: StorageLike, opts: MeshApiOptions = {}): Promise<MeshApi> {
    const env = opts.env ?? process.env;
    const tombstones = await CredRevocationStore.create(js);
    const mintLog = await CredMintLog.create(js);
    const owners = await AgentOwnerStore.create(js);
    const bootTokens = await BootTokens.create(js);
    const keyRevocations = await AgentKeyRevocationStore.create(js);
    const agentStatus = await AgentStatusStore.create(js);
    const stops = await StopStore.create(js);
    const limits = await TenantLimitStore.create(js);
    // Bring your own identity (SPEC §4.14, §9.7): the identity systems each
    // tenant trusts, where each agent's identity came from, and which agent
    // holds each outside identity. With no trust records, every outside proof
    // is refused and nothing else changes.
    const trust = await TrustAnchorStore.create(js);
    const identitySources = await IdentitySourceStore.create(js);
    const workloads = await WorkloadBindingStore.create(js);
    const publicUrl = env.MESH_PUBLIC_URL ?? env.API_BASE_URL ?? `http://localhost:${env.MESH_API_PORT ?? 3005}`;
    const proofKeys = new HttpProofKeys();
    const proofs = {
      anchors: () => trust.all(),
      keys: proofKeys,
      // A JWT-SVID names the mesh home: its public address, or any other
      // address it answers on (MESH_PUBLIC_ORIGINS), or MESH_PROOF_AUDIENCE.
      defaultAudience: [...new Set([(env.MESH_PROOF_AUDIENCE ?? publicUrl).trim().replace(/\/$/, ""), ...(env.MESH_PUBLIC_ORIGINS ?? "").split(",").map((x) => x.trim().replace(/\/$/, "")).filter(Boolean)])],
      replay: new ReplayCache(),
    };
    const platformUrl = env.PLATFORM_STEPS_URL?.trim();
    const platform = opts.platform ?? (platformUrl ? loopbackPlatformSteps(platformUrl) : {});
    const deregister = opts.deregister ?? null;
    const revoke = async (input: CredentialRevokeInput) => {
      const out = await revokeCredential(
        { tombstone: tombstones, mintLog, config: () => liveRevokeConfig(), connectAdmin: connectBrokerAdmin, deregister },
        input,
      );
      const who = input.agentKey ?? out.user_keys[0] ?? "";
      console.log(
        `[keychain] credential REVOKED for ${who.slice(0, 12)}… by ${input.by}: ${input.reason} ` +
          `(mode=${out.mode}, keys=${out.user_keys.length}, disconnected=${String(out.disconnected)}` +
          `${out.fallback_reason ? `, fallback: ${out.fallback_reason}` : ""})`,
      );
      metrics.event({ kind: "credential_revoked", actor: who, meta: { reason: input.reason, by: input.by, mode: out.mode, keys: out.user_keys.length, disconnected: out.disconnected } });
      return out;
    };
    const doors = credentialDoors({
      owners,
      bootTokens,
      tombstones,
      keyRevocations,
      agentStatus,
      stops,
      mintLog,
      limits,
      revokeCredential: revoke,
      platform,
      baseUrl: publicUrl,
      logPrefix: "[keychain]",
      env,
      meshInfo: () => meshInfo(env),
      proofs,
      identitySources,
      workloads,
      attest: identityAttester(env),
    });
    console.log(`[mesh-api] the platform's steps: ${platformUrl ? `over loopback at ${platformUrl}` : opts.platform ? "in process" : "none (the core works alone)"}`);

    // The admin API (admin/admin-api.ts), behind its own token.
    const cut = (keys: string[]) => cutConnections({ mintLog, config: () => liveRevokeConfig(), connectAdmin: connectBrokerAdmin }, keys);
    let auditLog: AuditLog | null | undefined;
    // Opened at the first audit query, read-mostly beside the activity
    // service that writes it (one host, WAL), with the export signer
    // (AUDIT_SIGNING_SEED): since step 10a the core signs the audit bundles
    // a platform beside it hands out (admin-audit.ts).
    const openAudit = (): AuditLog | null => {
      if (auditLog === undefined) {
        try { auditLog = new AuditLog(dataDbPath("AUDIT_DB_PATH", "audit.db"), identityFromEnv("AUDIT_SIGNING_SEED")); } catch (err) {
          console.error(`[admin] the audit log could not be opened: ${(err as Error).message}`);
          auditLog = null;
        }
      }
      return auditLog;
    };
    const admissionStore = await AdmissionStore.create(js);
    // The held ledger, opened on first use: this process is now its only
    // writer (the platform reports through the admin routes), so its copy of
    // the bucket is exact.
    let heldStore: Promise<HeldStore> | null = null;
    const held = () => (heldStore ??= HeldStore.create(js).catch((err) => { heldStore = null; throw err; }));
    // The usage store (activity/usage-store.ts), opened at the first Monitor
    // call beside the activity service that counts into it (one host, as the
    // API process opened it before step 10a). Its own flusher batches writes.
    let usageStore: UsageStore | null | undefined;
    const usage = (): UsageStore | null => {
      if (usageStore === undefined) {
        try { usageStore = new UsageStore(); usageStore.start(); } catch (err) {
          console.error(`[admin] the usage store could not be opened: ${(err as Error).message}`);
          usageStore = null;
        }
      }
      return usageStore;
    };
    // The event streams the platform folds, consumed on its behalf (admin/admin-streams.ts).
    const streamRoutes = adminStreams({ stream: (n) => storageOf(js).stream(n), schedule: () => storageOf(js).keyed("mesh_sched") });
    const admin = adminApi({
      owners,
      limits,
      bootTokens,
      tombstones,
      keyRevocations,
      agentStatus,
      stops,
      mintLog,
      admission: admissionStore,
      ownerRecords: adminOwners(owners),
      admissionRoutes: adminAdmission({ admission: admissionStore, held, rosters: () => storageOf(js).keyed("mesh_admission") }),
      holderOf: (k) => doors.holderOf(k),
      stopsFor: (keys) => doors.stopsFor(keys),
      revokeCredential: revoke,
      revokeAgentKey: (k, reason, who) => doors.revokeAgentKeyAction(k, reason, who),
      cut,
      audit: openAudit,
      auditRoutes: adminAudit(openAudit),
      credentialRoutes: adminCredentials({ env, mintLog }),
      keychainRoutes: adminKeychain({ tombstones, keyRevocations, agentStatus, stops, mintLog, bootTokens, revoke, cut, meshPause: (p) => meshPause(p, env) as never }),
      usageRoutes: adminUsage(usage),
      streamRoutes: streamRoutes,
      trustRoutes: adminTrust({ trust, owners, identitySources, env }),
      mintSeed: () => customerMintSeed(env),
      issuerAccount: env.ROOMS_MINT_ISSUER_ACCOUNT,
      meshInfo: () => meshInfo(env),
      facts: () => {
        const live = liveRevokeConfig();
        const seed = customerMintSeed(env);
        return {
          live_revocation: live.ok ? "on" : `off: ${live.reason}`,
          minting: seed.ok ? "on" : `off: ${seed.error}`,
        };
      },
      platformBeside: !!platformUrl || !!opts.platform,
      reads: adminReads({
        registrations: () => storageOf(js).keyed("mesh_registry"),
        feeds: () => storageOf(js).keyed("mesh_feed_state"),
        descriptors: () => storageOf(js).keyed("mesh_descriptors"),
        // The registry and the credential doors share this process, and so
        // this log (shared/require-names.ts).
        wouldRefuse: () => wouldRefuseLog.list(),
      }),
      views: adminViews({
        storage: storageOf(js),
        ownerOf: (k) => owners.agent(k),
        mailboxes: new InboxBuffer(js),
      }),
    });
    const auth = AdminAuth.fromEnv(env);
    console.log(`[mesh-api] admin API at /admin/v1: ${auth.describe()}`);
    // The registry's documents over HTTPS (registry/documents-http.ts).
    const docs = registryDocuments(js, env);
    const api = new MeshApi(doors, platform, opts.port ?? Number(env.MESH_API_PORT ?? 3005), opts.host ?? env.MESH_API_HOST ?? "127.0.0.1", env, admin, auth, docs);
    api.storage = js;
    api.rosters = rosterDoor(admissionStore);
    // Stop signals (§4.12, RFC 8935): a tenant's identity provider stops one of its workloads.
    api.signals = stopSignals({
      anchors: () => trust.all(),
      keys: proofKeys,
      workloads,
      stops,
      agentStatus,
      cut,
      audience: (env.MESH_SIGNALS_AUDIENCE ?? meshHome(env)).trim(),
      replay: new ReplayCache(),
    });
    api.closeUsage = async () => { await streamRoutes.close(); if (usageStore) await usageStore.close(); };
    return api;
  }

  /** Port actually bound (after start). */
  get listeningOn(): number {
    const a = this.server?.address();
    return a && typeof a === "object" ? a.port : this.port;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        console.error("[mesh-api] unhandled:", err);
        if (!res.headersSent) send(res, { status: 500, body: { error: "internal error" } });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, this.host, resolve));
    console.log(`[mesh-api] listening on ${this.host}:${this.listeningOn}`);
    // The optional mTLS listener (SPEC §4.14): the same routes, over TLS that
    // asks for a client certificate, so an agent can enroll with its
    // X.509-SVID and a certificate-bound token can be checked. The
    // certificate is checked against the tenant's trust bundle by the door,
    // not by TLS, so any client may connect and an unknown one is refused there.
    const mtlsPort = Number(this.env.MESH_MTLS_PORT ?? 0);
    if (mtlsPort > 0) {
      const certFile = this.env.MESH_MTLS_CERT_FILE?.trim();
      const keyFile = this.env.MESH_MTLS_KEY_FILE?.trim();
      if (!certFile || !keyFile) {
        console.error("[mesh-api] MESH_MTLS_PORT is set without MESH_MTLS_CERT_FILE and MESH_MTLS_KEY_FILE; the mTLS listener is off.");
      } else {
        this.mtls = createTlsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile), requestCert: true, rejectUnauthorized: false }, (req, res) => {
          void this.route(req, res).catch((err) => {
            console.error("[mesh-api] unhandled:", err);
            if (!res.headersSent) send(res, { status: 500, body: { error: "internal error" } });
          });
        });
        await new Promise<void>((resolve) => this.mtls!.listen(mtlsPort, this.host, resolve));
        console.log(`[mesh-api] mTLS listener on ${this.host}:${mtlsPort}`);
      }
    }
    // On the RabbitMQ binding the broker asks the key chain who may connect
    // and what each connection may do (storage/rabbitmq/broker-auth.ts).
    if (this.storage) this.brokerAuth = await startBrokerAuthFor(storageOf(this.storage), this.env);
  }

  private brokerAuth: { close(): void } | null = null;
  private mtls: TlsServer | null = null;
  private storage: StorageLike | null = null;
  /** The stop signal receiver (keychain/stop-signals.ts). */
  private signals: StopSignalReceiver | null = null;
  /** The admission roster's own door (admission/roster-door.ts). */
  private rosters: RosterDoor | null = null;
  /** Writes the usage store's last batch, when the Monitor routes opened it. */
  private closeUsage: () => Promise<void> = async () => {};

  async stop(): Promise<void> {
    this.brokerAuth?.close();
    this.brokerAuth = null;
    await this.closeUsage().catch((err) => console.warn(`[mesh-api] the usage store's last batch: ${(err as Error).message}`));
    if (this.mtls) { await new Promise<void>((resolve) => this.mtls!.close(() => resolve())); this.mtls = null; }
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private adminRoute(req: IncomingMessage, method: string, path: string, query: URLSearchParams): Promise<DoorAnswer> {
    return adminAnswer(this.admin, this.adminAuth, req, method, path, query, this.env);
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mesh-api");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const ip = clientIp(req);
    try {
      if (method === "GET" && path === "/health") return send(res, { status: 200, body: { ok: true, service: "mesh-api" } });
      // `?core=1`: the core's own answer, without the platform's entries, for
      // a platform beside it that adds its own (step 10a).
      if (method === "GET" && path === "/v1/capabilities") {
        return send(res, url.searchParams.get("core") === "1" ? { status: 200, body: coreCapabilities() as Record<string, unknown> } : await capabilitiesAnswer(this.platform));
      }
      if (method === "POST" && path === "/v1/bootstrap") return send(res, await this.doors.bootstrap(await readJson(req), doorRequest(req, this.env)));
      if (method === "POST" && path === "/v1/node-credential") return send(res, await this.doors.nodeCredential(await readJson(req), ip, () => meshInfo(this.env), doorRequest(req, this.env)));
      // An identity bridge asks about a caller that holds no mesh key (§4.15).
      if (method === "POST" && path === "/v1/bridged-callers") return send(res, await this.doors.bridgedCaller(await readJson(req)));
      if (method === "POST" && path === "/v1/credential/revoke-own") return send(res, await this.doors.revokeOwnCredential(await readJson(req)));
      if (method === "POST" && path === "/v1/agent-key/revoke-own") return send(res, await this.doors.revokeOwnAgentKey(await readJson(req), ip));
      // Whether an account holds the caller's own agent key (doors.ts keyStanding):
      // what the reference adapter asks on a mesh that offers no naming.
      if (method === "POST" && path === "/v1/key-standing") return send(res, await this.doors.keyStanding(await readJson(req), ip));
      const m = /^\/v1\/key-check\/([^/]+)$/.exec(path);
      if (method === "GET" && m) return send(res, await this.doors.keyCheck(decodeURIComponent(m[1]!)));
      const sig = /^\/v1\/signals\/([^/]+)$/.exec(path);
      if (sig && this.signals) {
        if (method !== "POST") return send(res, { status: 405, body: { error: "Stop signals are pushed with POST (RFC 8935)." } });
        const raw = await readRaw(req);
        if (raw === "too large") return send(res, { status: 413, body: { err: "invalid_request", description: "The token is too large." } });
        const ct = req.headers["content-type"];
        return send(res, await this.signals(decodeURIComponent(sig[1]!), typeof ct === "string" ? ct : undefined, raw));
      }
      if (this.rosters && path.startsWith("/v1/rosters/")) {
        const answer = await this.rosters(method, path, () => readJson(req));
        if (answer) return send(res, answer);
      }
      const doc = this.docs ? await registryDocumentRoute(this.docs, method, path) : null;
      if (doc) return sendRaw(res, doc);
      if (path === "/admin" || path.startsWith("/admin/")) return send(res, await this.adminRoute(req, method, path, url.searchParams));
      return send(res, { status: 404, body: { error: "Not found" } });
    } catch (err) {
      if (err instanceof PlatformStepUnavailable) {
        console.error(`[mesh-api] ${path}: ${err.message}`);
        return send(res, { status: 503, body: { error: "This mesh could not finish that request right now. Try again shortly." } });
      }
      throw err;
    }
  }
}

/**
 * Sign an agent's identity source as a portable trust attestation (§9.7),
 * with the key the doors mint credentials with. Null when minting is not
 * configured; the record is then kept without one. Thirty days: the doors
 * sign again at each enrollment, and a reader checks the expiry.
 */
export function identityAttester(env: NodeJS.ProcessEnv): (agent: string, source: import("../sdk.js").IdentitySource) => Record<string, unknown> | null {
  return (agent, source) => {
    const seed = customerMintSeed(env);
    if (!seed.ok) return null;
    try {
      const kp = nkeys.fromSeed(new TextEncoder().encode(seed.seed));
      return createTrustAttestation(kp as never, agent, { identity_source: source }, 30 * 24 * 60 * 60 * 1000) as unknown as Record<string, unknown>;
    } catch (err) {
      console.warn(`[keychain] the identity source of ${agent.slice(0, 12)}… was not signed: ${(err as Error).message}`);
      return null;
    }
  };
}

/**
 * What a door reads from the request beyond its body: the DPoP header, and
 * the client certificate chain when the request came over mTLS. Behind a
 * proxy that ends TLS, the proxy may pass the client certificate in the
 * header MESH_CLIENT_CERT_HEADER names (PEM, URL-encoded, as Envoy and nginx
 * forward it), which is believed only from this machine.
 */
export function doorRequest(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): import("./doors.js").DoorRequest {
  const out: import("./doors.js").DoorRequest = {};
  const dpop = req.headers.dpop;
  if (typeof dpop === "string" && dpop) out.dpop = dpop;
  const sock = req.socket as TLSSocket;
  if (typeof sock.getPeerCertificate === "function" && sock.encrypted) {
    const chain: X509Certificate[] = [];
    let c = sock.getPeerCertificate(true) as { raw?: Buffer; issuerCertificate?: unknown } | null;
    const seen = new Set<string>();
    while (c && c.raw && chain.length < 10) {
      const fp = c.raw.toString("base64");
      if (seen.has(fp)) break;
      seen.add(fp);
      try { chain.push(new X509Certificate(c.raw)); } catch { break; }
      c = c.issuerCertificate as typeof c;
    }
    if (chain.length) out.clientCerts = chain;
    return out;
  }
  const header = env.MESH_CLIENT_CERT_HEADER?.trim().toLowerCase();
  const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
  if (header && local) {
    const v = req.headers[header];
    const pem = typeof v === "string" ? decodeURIComponent(v.replace(/^"|"$/g, "")) : "";
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    const chain: X509Certificate[] = [];
    for (const b of blocks.slice(0, 10)) { try { chain.push(new X509Certificate(b)); } catch { /* skip */ } }
    if (chain.length) out.clientCerts = chain;
  }
  return out;
}

export const ADMIN_PROXY_SETTING = "MESH_ADMIN_THROUGH_PROXY";

/** Whether a request carries a header a proxy adds (or the one this host's
 *  edge names), which the admin API refuses unless told otherwise. */
export function cameThroughProxy(headers: IncomingMessage["headers"], env: NodeJS.ProcessEnv = process.env): boolean {
  const named = env.MESH_REAL_IP_HEADER?.toLowerCase();
  return ["x-forwarded-for", "forwarded", "x-real-ip", ...(named ? [named] : [])].some((h) => headers[h] !== undefined);
}

/** The admin API's door: no proxy unless allowed, then the admin token. */
export async function adminAnswer(
  admin: AdminApi | null,
  auth: AdminAuth | null,
  req: IncomingMessage,
  method: string,
  path: string,
  query: URLSearchParams,
  env: NodeJS.ProcessEnv,
): Promise<DoorAnswer> {
  const noStore = { "cache-control": "no-store" };
  if (!admin || !auth) return { status: 503, headers: noStore, body: { error: "The admin API is not running in this process." } };
  if ((env[ADMIN_PROXY_SETTING] ?? "").trim().toLowerCase() !== "on" && cameThroughProxy(req.headers, env)) {
    return { status: 403, headers: noStore, body: { error: `The admin API answers only callers that reach it directly, not through a proxy. To allow a proxy, set ${ADMIN_PROXY_SETTING}=on.` } };
  }
  const caller = auth.check(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined);
  if (!caller.ok) return { status: caller.status, headers: noStore, body: { error: caller.error } };
  if (!path.startsWith("/admin/v1/")) return { status: 404, headers: noStore, body: { error: "No such admin route. The admin API is under /admin/v1/." } };
  let body: Record<string, unknown> | null = null;
  if (method !== "GET" && method !== "HEAD") {
    const raw = await readRaw(req);
    if (raw === "too large") return { status: 413, headers: noStore, body: { error: `The request body is over ${MAX_BODY} bytes.` } };
    if (raw) {
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return { status: 400, headers: noStore, body: { error: "The request body is not JSON." } }; }
      if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, headers: noStore, body: { error: "The request body must be a JSON object." } };
    }
  }
  const out = await admin.handle({ method, path, query, body, caller: caller.name });
  return { ...out, headers: { ...noStore, ...(out.headers ?? {}) } };
}

async function readRaw(req: IncomingMessage): Promise<string | "too large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return "too large";
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The JSON body, or null when there is none, it is not JSON, or it is too
 *  large: the doors answer a null body as a request missing its fields, as
 *  the API always has. */
async function readJson(req: IncomingMessage): Promise<never> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) {
      console.warn(`[mesh-api] request body over ${MAX_BODY} bytes; socket destroyed`);
      req.destroy();
      return null as never;
    }
    chunks.push(c as Buffer);
  }
  if (!size) return null as never;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as never;
  } catch {
    return null as never;
  }
}

function send(res: ServerResponse, a: DoorAnswer): void {
  if (a.headers) for (const [k, v] of Object.entries(a.headers)) res.setHeader(k, v);
  res.writeHead(a.status, { "content-type": "application/json" });
  res.end(JSON.stringify(a.body));
}

/** An answer that may carry raw bytes with their own headers (a stored document). */
function sendRaw(res: ServerResponse, a: RawAnswer): void {
  if (a.body instanceof Uint8Array) {
    res.writeHead(a.status, a.headers ?? {});
    res.end(Buffer.from(a.body));
    return;
  }
  send(res, { status: a.status, body: a.body, ...(a.headers ? { headers: Object.fromEntries(Object.entries(a.headers).map(([k, v]) => [k, String(v)])) } : {}) });
}

/** The caller's address, read the way the API reads it (resolveClientIp):
 *  behind the edge on this host, MESH_REAL_IP_HEADER or the last
 *  X-Forwarded-For entry; otherwise the socket. For rate limits and logs. */
function clientIp(req: IncomingMessage): string {
  const sock = req.socket.remoteAddress ?? "unknown";
  const local = sock === "127.0.0.1" || sock === "::1" || sock === "::ffff:127.0.0.1";
  if (!local) return sock;
  const named = process.env.MESH_REAL_IP_HEADER?.toLowerCase();
  if (named) {
    const v = req.headers[named];
    const ip = (Array.isArray(v) ? v[0] : v)?.trim();
    if (ip) return ip;
  }
  const fwd = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(fwd) ? fwd.join(",") : fwd ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return chain.length ? chain[chain.length - 1]! : sock;
}
