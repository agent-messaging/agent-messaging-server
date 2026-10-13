/**
 * The core's credential doors (step 3 of docs/agent-messaging-server-plan.md):
 *
 *   POST /v1/bootstrap               enroll with a single-use key
 *   POST /v1/node-credential         mint or renew a node credential
 *   POST /v1/credential/revoke-own   a holder ends one of its credentials (§4.8)
 *   POST /v1/agent-key/revoke-own    a holder ends its agent signing key (§5.3)
 *   GET  /v1/key-check/:key          is this signing key revoked or stopped
 *
 * They lived inside the API until step 3. The logic moved here unchanged and
 * reads the core's own stores: the ownership record and tenants for whose an
 * agent is, the boot tokens, the tombstones, the signing key revocations, the
 * stop list and the mint log. Each step that belongs to the platform is an
 * optional hook (PlatformSteps), called at the same point in the same order:
 * linking an enrolled agent to its account and naming it, the agent cap, the
 * naming refusal, provider advisories, and the platform's own system agents.
 * With no platform the doors still enroll by a key the core minted, renew,
 * and revoke on their own.
 *
 * Two places run them. The core's mesh API (mesh-api.ts) serves them over HTTP
 * and reaches the platform's steps over loopback (platform-steps.ts); the API
 * runs the same doors in its own process with its steps in process, for
 * account.connect and for its old routes until the edge sends the five paths
 * to the core.
 *
 * Each door answers { status, body } and never throws.
 */
import { createHash, type X509Certificate } from "node:crypto";
import { nkeys } from "../sdk.js";
import { verifyAgentSig } from "../admission/held-store.js";
import { metrics } from "../shared/ops-events.js";
import { credsFileText } from "../shared/creds-file.js";
import { RateLimiter } from "../shared/rate-limiter.js";
import { namesAtDoor, namesUncheckedRefusal, unnamedStrangerRefusal } from "../shared/require-names.js";
import type { AgentKeyRevocationStore } from "../shared/agent-key-revocations.js";
import type { AgentStatusLookup } from "../shared/agent-status.js";
import { revokeAgentKey, revokeOwnStatement, type AgentKeyRevokeResult } from "./agent-key-rotate.js";
import { ownerAccountOf, stopPlaceOf, type AgentOwners, type AgentOwnerRecord } from "./agent-owners.js";
import type { BootTokens } from "./boot-tokens.js";
import { decideRenewal, type CredRevocationStore } from "./cred-revocation.js";
import { NODE_CREDENTIAL_MAX_AGENTS } from "./cred-template.js";
import type { CredMintLog } from "./cred-mint-log.js";
import type { CredentialRevokeInput, CredentialRevokeResult } from "./credential-revoke.js";
import { mintAfterCut } from "./kill-switch-cut.js";
import { meshInfo } from "./mesh-object.js";
import { mintNodeCredential } from "./node-mint.js";
import { customerMintSeed } from "./split-keys.js";
import { mintRefusal, partitionRoster, stopFor, stopsForKeys, type AgentOwnership, type StopFinding } from "./stop-rules.js";
import type { StopList } from "./stop-store.js";
import type { TenantLimitList } from "./tenant-limits.js";
import { identitySourceOf, reasonOf, verifyOutsideProof, type IdentitySource, type ProofDeps, type ProofInput, type VerifiedProof } from "./outside-proof.js";
import { workloadKey, type IdentitySourceList, type WorkloadBindingList } from "./identity-records.js";

export interface DoorAnswer {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** Who holds an agent, as the renewal decision reads it. */
export interface Holder {
  id: string;
  disabled?: boolean;
}

/** An advisory about an agent, as the key check carries it. */
export interface Advisory {
  tier: string;
  severity: string;
  id: string;
  title: string;
}

/**
 * The platform's steps. Every one is optional; each says what the doors do
 * without it.
 */
export interface PlatformSteps {
  /** Bootstrap, before the mint: the account's standing and the agent cap.
   *  `found: false` refuses (404); `disabled` refuses (403); `capBlocked`
   *  refuses (403) and keeps the token. Without it: the tenant record. */
  enrollCheck?(accountId: string, agentId: string): Promise<{ found: boolean; disabled?: boolean; capBlocked?: { error: string }; email?: string | null; homeOrg?: string | null }>;
  /** Bootstrap, after the mint: link the agent to its account (and the
   *  organization the token names), and name it. `cap` is the cap refusing
   *  the link. Without it: the core records the agent as the tenant's. */
  enrolled?(input: { accountId: string; agentId: string; label: string; name?: string; org?: string; deferName?: boolean }): Promise<{ cap?: string; handle: string | null; naming: { name_at: string } | null; accountEmail: string | null }>;
  /** Renewal: what to say to an unnamed agent its account holds, when names
   *  are required. Without it: the stranger's refusal. */
  namingRefusal?(accountId: string, agentKey: string): Promise<{ status: number; body: Record<string, unknown> } | null>;
  /** The key check: the strongest advisory a provider issued. Without it: none
   *  (advisories are deployment-defined, SPEC 0.5 §1.6). */
  advisory?(key: string): Promise<Advisory | null>;
  /** The platform's own system agents, which a mesh pause leaves running.
   *  Without it: none beyond what the ownership record calls mesh-system. */
  systemKeys?(): Promise<string[]>;
  /** Whose agent, when the ownership record has no answer: the account store,
   *  for one release (step 3, phase B). Without it: nobody. */
  holderFallback?(key: string): Promise<Holder | null>;
  /** Where an agent sits, when the ownership record cannot place it: the
   *  account store, for one release. Without it: unplaced. */
  placeFallback?(keys: string[]): Promise<AgentOwnership[]>;
  /** The capabilities answer (shared/capabilities.ts): the platform's entries
   *  on top of the core's. Without it: the core's answer alone. */
  capabilities?(): Promise<Record<string, unknown>>;
  /** Whether names are required at the node-credential door
   *  (MESH_REQUIRE_NAMES), as the platform's settings say. Without it, or
   *  when it does not answer: this process's environment. */
  namesRequired?(): Promise<boolean>;
}

export interface DoorDeps {
  owners: AgentOwners | null;
  bootTokens: BootTokens | null;
  tombstones: CredRevocationStore | null;
  keyRevocations: AgentKeyRevocationStore | null;
  agentStatus: AgentStatusLookup | null;
  stops: StopList | null;
  mintLog: CredMintLog | null;
  /** Each tenant's own limits (tenant-limits.ts). Absent: no tenant has one. */
  limits?: TenantLimitList | null;
  /** The one revoke action (credential-revoke.ts) wired to this process. */
  revokeCredential: (input: CredentialRevokeInput) => Promise<CredentialRevokeResult>;
  platform: PlatformSteps;
  /** The address the renewal door is reached at, for `renew_url`. */
  baseUrl: string;
  /** Where the log lines say they come from. */
  logPrefix?: string;
  env?: NodeJS.ProcessEnv;
  /** Whether MESH_REQUIRE_NAMES is on. Default: this process's environment. */
  namesRequired?: () => Promise<boolean>;
  /** The `mesh` object of SPEC §18.10 for the bootstrap door's answer.
   *  Default: mesh-object.ts from `env`. */
  meshInfo?: () => Record<string, unknown>;
  /** Outside proofs (SPEC §4.14): enrolling with a proof from an identity
   *  system a tenant trusts. Absent: the bootstrap door refuses every proof. */
  proofs?: ProofDeps | null;
  /** Where each agent's identity came from (identity-records.ts). Absent: not recorded. */
  identitySources?: IdentitySourceList | null;
  /** Which agent holds each outside identity (identity-records.ts). */
  workloads?: WorkloadBindingList | null;
  /** Sign an identity source as a portable trust attestation (§9.7). Absent
   *  or null: the record is kept without one. */
  attest?: (agent: string, source: IdentitySource) => Record<string, unknown> | null;
}

/** What a door can read from the request itself, beyond its body. */
export interface DoorRequest {
  /** The DPoP proof from the `DPoP` header (RFC 9449). */
  dpop?: string;
  /** The client certificate chain, leaf first, when the request came over mTLS. */
  clientCerts?: X509Certificate[];
}

const NKEY = /^U[A-Z2-7]{55}$/;

/** The credential doors, wired to `deps`. */
export function credentialDoors(deps: DoorDeps) {
  const env = deps.env ?? process.env;
  const log = deps.logPrefix ?? "[keychain]";
  const keyRevokeLimiter = new RateLimiter(10, 60 * 60 * 1000);
  // The adapter keeps a yes for half an hour and a no for a few seconds.
  const standingLimiter = new RateLimiter(600, 60 * 60 * 1000);

  const orgsOn = () => (env.MESH_ORGS ?? "on").trim().toLowerCase() !== "off";

  /** The record, or null; "unread" when it could not be read. */
  const recordOf = async (k: string): Promise<AgentOwnerRecord | null | "unread"> => {
    if (!deps.owners) return "unread";
    try { return await deps.owners.agent(k); } catch { return "unread"; }
  };

  /** Who holds an agent: the record and its tenant, else the platform's fallback. */
  const holderOf = async (k: string): Promise<Holder | null> => {
    const rec = await recordOf(k);
    const account = rec === "unread" ? null : ownerAccountOf(rec);
    if (account && deps.owners) {
      const tenant = await deps.owners.tenant(account).catch(() => null);
      if (tenant) return { id: account, disabled: tenant.disabled };
    }
    return deps.platform.holderFallback ? deps.platform.holderFallback(k) : null;
  };

  /** The stops in force for these keys (kill switch item 1). Throws when the
   *  stop list cannot be read; every door fails closed on it. */
  const stopsFor = async (keys: string[]): Promise<Map<string, StopFinding>> => {
    const out = new Map<string, StopFinding>();
    if (!deps.stops || !keys.length) return out;
    const active = await deps.stops.active();
    if (!active.length) return out;
    let world: AgentOwnership[] | null = null;
    if (active.some((s) => s.scope !== "agent")) {
      world = [];
      const records = deps.owners ? await deps.owners.allAgents().catch(() => null) : null;
      if (records) for (const r of records.values()) { const p = stopPlaceOf(r); if (p) world.push(p); }
      const known = new Set(world.map((a) => a.key));
      const missing = keys.filter((k) => !known.has(k));
      if (missing.length && deps.platform.placeFallback) world.push(...(await deps.platform.placeFallback(missing)));
      // The platform's own system agents keep running through a mesh pause.
      if (active.some((s) => s.scope === "mesh") && deps.platform.systemKeys) {
        const own = new Set(await deps.platform.systemKeys().catch(() => [] as string[]));
        const seen = new Set(world.map((a) => a.key));
        world = [...world.map((a) => (own.has(a.key) ? { ...a, category: "mesh-system" } : a)),
          ...keys.filter((k) => own.has(k) && !seen.has(k)).map((k) => ({ key: k, person: null, org: null, category: "mesh-system" }))];
      }
    }
    return stopsForKeys(active, keys, world);
  };

  // ── POST /v1/bootstrap ───────────────────────────────────────────────

  /** The addresses a door may be said to be at, for a DPoP proof's `htu`:
   *  its public address, and any others this mesh answers on
   *  (MESH_PUBLIC_ORIGINS, comma-separated origins). */
  const doorUrls = (path: string): string[] => {
    const bases = [deps.baseUrl, ...(env.MESH_PUBLIC_ORIGINS ?? "").split(",")].map((x) => x.trim().replace(/\/$/, "")).filter(Boolean);
    return [...new Set(bases.map((b) => `${b}${path}`))];
  };

  /** Write where an agent's identity came from, signed when the mesh can sign.
   *  Best effort for the default enrollment; an outside proof's record is
   *  written before the door answers. */
  const recordSource = async (agent: string, tenant: string | null, source: IdentitySource): Promise<void> => {
    if (!deps.identitySources) return;
    const attestation = deps.attest ? deps.attest(agent, source) : null;
    await deps.identitySources.put({ agent, tenant, identity_source: source, ...(attestation ? { attestation } : {}) });
  };

  async function bootstrap(b: { token?: string; agent_id?: string; proof?: unknown; dpop?: unknown } | null, req: DoorRequest = {}): Promise<DoorAnswer> {
    const reply = (status: number, body: Record<string, unknown>): DoorAnswer => ({ status, body });
    if (b && b.proof !== undefined && b.token === undefined) return bootstrapWithProof(b, req);
    if (!b?.token || !b?.agent_id) return reply(400, { error: "token and agent_id required" });
    if (!NKEY.test(b.agent_id)) return reply(400, { error: "agent_id must be a user public nkey (U…)" });
    // A customer credential: signed by the customer signing key once the keys
    // are split (split-keys.ts), so the mesh pause reaches it.
    const seedRead = customerMintSeed(env);
    if (!seedRead.ok) return reply(seedRead.status, { error: seedRead.error });
    if (!deps.bootTokens) return reply(503, { error: "agent keys cannot be redeemed on this instance right now" });

    const data = await deps.bootTokens.take(b.token);
    if (!data) return reply(400, { error: "unknown, used, or expired agent key — mint a fresh one in your console" });
    const restore = (full = true) => full
      ? deps.bootTokens!.put(b.token!, data.accountId, data.label, data.name, data.org, { deferName: data.deferName })
      : deps.bootTokens!.put(b.token!, data.accountId, data.label, data.name);

    // The account's standing: the platform's word when it is here, else the tenant record.
    let homeOrg: string | null = null;
    if (deps.platform.enrollCheck) {
      let c: Awaited<ReturnType<NonNullable<PlatformSteps["enrollCheck"]>>>;
      try {
        c = await deps.platform.enrollCheck(data.accountId, b.agent_id);
      } catch (err) {
        await restore();
        console.error(`${log} bootstrap: the account could not be checked: ${(err as Error).message}`);
        return reply(503, { error: "Could not check this account right now, so no credential was issued. Try again shortly." });
      }
      if (!c.found) return reply(404, { error: "account not found" });
      if (c.disabled) return reply(403, { error: "This account is disabled." });
      // Re-store the token so a cap refusal does not burn it.
      if (c.capBlocked) {
        await restore();
        return reply(403, { error: c.capBlocked.error });
      }
      homeOrg = c.homeOrg ?? null;
    } else {
      const tenant = deps.owners ? await deps.owners.tenant(data.accountId).catch(() => null) : null;
      if (!tenant) return reply(404, { error: "account not found" });
      if (tenant.disabled) return reply(403, { error: "This account is disabled." });
      homeOrg = tenant.home_org;
    }
    // A revoked signing key (§5.3) does not come back through the front door.
    if (await deps.keyRevocations?.get(b.agent_id).catch(() => null)) {
      await restore();
      return reply(403, { error: "The signing key on this machine has been revoked because it leaked. Create a new one (agentmesh key rotate), then run this command again." });
    }
    // The kill switch: a stopped agent is not issued a credential through the
    // front door either. The account's own stops count too.
    {
      let found: StopFinding | undefined;
      try {
        found = (await stopsFor([b.agent_id])).get(b.agent_id);
        if (!found) {
          const active = deps.stops ? await deps.stops.active() : [];
          const org = orgsOn() ? (data.org ?? homeOrg ?? null) : null;
          const f = active.length ? stopFor(active, { key: b.agent_id, person: data.org && data.org !== homeOrg ? null : data.accountId, org }) : null;
          if (f) found = f;
        }
      } catch {
        await restore(false);
        return reply(503, { error: "Could not check whether this agent is stopped, so no credential was issued. Try again shortly." });
      }
      if (found) {
        await restore(false);
        const r = mintRefusal(found, b.agent_id);
        metrics.event({ kind: "node_credential_refused", actor: b.agent_id, meta: { door: "bootstrap", reason: r.body.code } });
        return reply(r.status, r.body);
      }
    }
    // Exclusivity: a key can be under one account only.
    let bootHolder: Holder | null;
    try {
      bootHolder = await holderOf(b.agent_id);
    } catch {
      await restore();
      return reply(503, { error: "Could not check who holds this agent right now, so no credential was issued. Try again shortly." });
    }
    if (bootHolder && bootHolder.id !== data.accountId) {
      await restore();
      return reply(409, { error: EXCLUSIVITY_ERROR });
    }
    // The tenant's own agent limit, when the admin API set one
    // (tenant-limits.ts). No limit, no read.
    {
      const refusal = await agentLimitRefusal(deps, data.accountId, b.agent_id).catch(() => "unread" as const);
      if (refusal === "unread") {
        await restore();
        return reply(503, { error: "Could not check this tenant's agent limit right now, so no credential was issued. Try again shortly." });
      }
      if (refusal) {
        await restore();
        return reply(403, refusal);
      }
    }

    const ukp = nkeys.createUser();
    const minted = await mintNodeCredential({
      subject: ukp,
      agentIds: [b.agent_id],
      mintSeed: seedRead.seed,
      issuerAccount: env.ROOMS_MINT_ISSUER_ACCOUNT,
      namePrefix: "agent",
    });
    const seed = new TextDecoder().decode(ukp.getSeed());
    const agentId = b.agent_id;

    let handle: string | null = null;
    let naming: { name_at: string } | null = null;
    let accountEmail: string | null = null;
    if (deps.platform.enrolled) {
      let e: Awaited<ReturnType<NonNullable<PlatformSteps["enrolled"]>>>;
      try {
        e = await deps.platform.enrolled({ accountId: data.accountId, agentId, label: data.label, name: data.name, org: data.org, deferName: data.deferName });
      } catch (err) {
        await restore();
        console.error(`${log} bootstrap: the agent could not be linked to its account: ${(err as Error).message}`);
        return reply(503, { error: "The agent could not be linked to your account just now. Run the same command again shortly." });
      }
      if (e.cap) return reply(403, { error: e.cap });
      handle = e.handle;
      naming = e.naming;
      accountEmail = e.accountEmail;
    } else if (deps.owners) {
      // No platform: the core records the agent as the tenant's itself.
      const now = new Date().toISOString();
      const prior = await deps.owners.agent(agentId).catch(() => null);
      await deps.owners.putAgent({
        key: agentId, account: data.accountId, org: data.org ?? null, home_org: data.org ? null : homeOrg,
        person: data.accountId, category: "account", listed: prior?.listed ?? true, label: data.label,
        custody: null, payer: data.accountId, updated_at: now,
      });
    }
    // A key coming in through the front door is not a revoked one: clear any
    // tombstone from an earlier retirement.
    await deps.tombstones?.clear(agentId).catch(() => undefined);
    await deps.mintLog?.recordMint({
      key: minted.subject,
      agents: [agentId],
      label: data.label,
      expiresAt: minted.expiresAt,
      door: "bootstrap",
      account: data.accountId,
      org: data.org ?? homeOrg ?? null,
    });
    console.log(`${log} bootstrap: agent ${agentId.slice(0, 12)}… ("${data.label}"${handle ? ` -> ${handle}` : ""}) joined ${accountEmail ?? data.accountId} with durable creds (expires ${minted.expiresAt ?? "never"})`);
    // Its identity came from this mesh's own enrollment (§9.7 identity_source).
    await recordSource(agentId, data.accountId, { kind: "mesh", since: new Date().toISOString() })
      .catch((err) => console.warn(`${log} bootstrap: the identity source of ${agentId.slice(0, 12)}… was not recorded: ${(err as Error).message}`));
    return reply(200, {
      ok: true,
      jwt: minted.jwt,
      seed,
      creds: credsFileText(minted.jwt, seed),
      label: data.label,
      handle,
      ...(naming ? { naming } : {}),
      account_email: accountEmail,
      expires_at: minted.expiresAt,
      renew_url: `${deps.baseUrl.replace(/\/$/, "")}/v1/node-credential`,
      // The same object as every other door's (SPEC §18.10).
      mesh: deps.meshInfo ? deps.meshInfo() : meshInfo(env),
    });
  }

  // ── POST /v1/bootstrap with an outside proof (SPEC §4.14) ───────────

  /**
   * Enroll with a proof from an identity system a tenant trusts, in place of
   * the operator's one-time key: `{ agent_id, proof: { kind, token }, dpop? }`,
   * or an X.509-SVID over mTLS with `proof: { kind: "x509-svid" }`. The proof
   * names its tenant through the trust record that accepts it. Then the same
   * checks as the one-time key (the tenant's standing, a revoked signing key,
   * the stop list, a key another tenant holds, the tenant's agent limit), the
   * same credential, and two records: where the agent's identity came from,
   * and which agent holds the outside identity now. A second agent key
   * enrolling with the same outside identity replaces the first, whose key is
   * revoked (§4.10).
   */
  async function bootstrapWithProof(b: { agent_id?: string; proof?: unknown; dpop?: unknown }, req: DoorRequest): Promise<DoorAnswer> {
    const reply = (status: number, body: Record<string, unknown>): DoorAnswer => ({ status, body });
    const refused = (status: number, code: string, error: string) => {
      metrics.event({ kind: "node_credential_refused", actor: b.agent_id ?? "", meta: { door: "bootstrap-proof", reason: code } });
      return reply(status, { error, code });
    };
    if (!deps.proofs) return reply(403, { error: "This mesh accepts no outside proofs. Enroll with an enrollment key from its operator.", code: "proofs_not_offered" });
    if (!b.agent_id) return reply(400, { error: "agent_id and proof required" });
    if (!NKEY.test(b.agent_id)) return reply(400, { error: "agent_id must be a user public nkey (U…)" });
    const proof = b.proof as ProofInput | null;
    if (!proof || typeof proof !== "object" || typeof proof.kind !== "string") return reply(400, { error: 'proof must be { "kind": "oauth" | "jwt-svid", "token": "…" }, or { "kind": "x509-svid" } over mTLS.' });
    if (b.dpop !== undefined && typeof b.dpop !== "string") return reply(400, { error: "dpop, when given, must be the DPoP proof JWT." });
    const seedRead = customerMintSeed(env);
    if (!seedRead.ok) return reply(seedRead.status, { error: seedRead.error });

    const v = await verifyOutsideProof(proof, {
      method: "POST",
      urls: doorUrls("/v1/bootstrap"),
      ...(typeof b.dpop === "string" ? { dpop: b.dpop } : req.dpop ? { dpop: req.dpop } : {}),
      ...(req.clientCerts ? { clientCerts: req.clientCerts } : {}),
    }, deps.proofs);
    if (!v.ok) {
      console.log(`${log} bootstrap: an outside proof was refused for ${b.agent_id.slice(0, 12)}…: ${v.code}`);
      metrics.event({ kind: "node_credential_refused", actor: b.agent_id, meta: { door: "bootstrap-proof", reason: v.code } });
      return reply(v.status, { error: v.error, code: v.code, details: { reason: reasonOf(v.code) } });
    }
    const p = v.proof;
    const agentId = b.agent_id;
    const tenant = p.tenant;

    // The tenant's standing: the platform's word when it is here, else the tenant record.
    let homeOrg: string | null = null;
    if (deps.platform.enrollCheck) {
      let c: Awaited<ReturnType<NonNullable<PlatformSteps["enrollCheck"]>>>;
      try { c = await deps.platform.enrollCheck(tenant, agentId); } catch {
        return reply(503, { error: "Could not check this account right now, so no credential was issued. Try again shortly." });
      }
      if (!c.found) return refused(404, "account_not_found", "The tenant that trusts this proof's issuer was not found.");
      if (c.disabled) return refused(403, "account_disabled", "This account is disabled.");
      if (c.capBlocked) return refused(403, "agent_cap", c.capBlocked.error);
      homeOrg = c.homeOrg ?? null;
    } else {
      const t = deps.owners ? await deps.owners.tenant(tenant).catch(() => null) : null;
      if (!t) return refused(404, "account_not_found", "The tenant that trusts this proof's issuer was not found.");
      if (t.disabled) return refused(403, "account_disabled", "This account is disabled.");
      homeOrg = t.home_org;
    }
    if (await deps.keyRevocations?.get(agentId).catch(() => null)) {
      return refused(403, "agent_key_revoked", "This signing key has been revoked. Make a new key pair, then enroll again with it.");
    }
    {
      let found: StopFinding | undefined;
      try {
        found = (await stopsFor([agentId])).get(agentId);
        if (!found) {
          const active = deps.stops ? await deps.stops.active() : [];
          const f = active.length ? stopFor(active, { key: agentId, person: tenant, org: orgsOn() ? homeOrg : null }) : null;
          if (f) found = f;
        }
      } catch {
        return reply(503, { error: "Could not check whether this agent is stopped, so no credential was issued. Try again shortly." });
      }
      if (found) {
        const r = mintRefusal(found, agentId);
        metrics.event({ kind: "node_credential_refused", actor: agentId, meta: { door: "bootstrap-proof", reason: r.body.code } });
        return reply(r.status, r.body);
      }
    }
    let holder: Holder | null;
    try { holder = await holderOf(agentId); } catch {
      return reply(503, { error: "Could not check who holds this agent right now, so no credential was issued. Try again shortly." });
    }
    if (holder && holder.id !== tenant) return refused(409, "held_elsewhere", EXCLUSIVITY_ERROR);
    {
      const refusal = await agentLimitRefusal(deps, tenant, agentId).catch(() => "unread" as const);
      if (refusal === "unread") return reply(503, { error: "Could not check this tenant's agent limit right now, so no credential was issued. Try again shortly." });
      if (refusal) return reply(403, refusal);
    }
    // Which agent holds this outside identity now. Read before the mint, so a
    // store that cannot be read refuses rather than letting two keys hold one identity.
    const scope = p.kind === "oauth" ? p.issuer! : "spiffe";
    const wKey = workloadKey(p.kind === "oauth" ? "oauth" : "spiffe", scope, p.workload_id);
    let prior: Awaited<ReturnType<WorkloadBindingList["get"]>> = null;
    if (deps.workloads) {
      try { prior = await deps.workloads.get(wKey); } catch {
        return reply(503, { error: "Could not check which agent holds this identity right now, so no credential was issued. Try again shortly." });
      }
    }

    const ukp = nkeys.createUser();
    const minted = await mintNodeCredential({
      subject: ukp,
      agentIds: [agentId],
      mintSeed: seedRead.seed,
      issuerAccount: env.ROOMS_MINT_ISSUER_ACCOUNT,
      namePrefix: "agent",
    });
    const seed = new TextDecoder().decode(ukp.getSeed());
    const label = p.workload_id.length > 120 ? `${p.workload_id.slice(0, 117)}...` : p.workload_id; // cut-ok: a display label; the whole id is in the identity source

    let handle: string | null = null;
    let naming: { name_at: string } | null = null;
    if (deps.platform.enrolled) {
      try {
        const e = await deps.platform.enrolled({ accountId: tenant, agentId, label, deferName: true });
        if (e.cap) return reply(403, { error: e.cap });
        handle = e.handle;
        naming = e.naming;
      } catch (err) {
        console.error(`${log} bootstrap: the agent could not be linked to its account: ${(err as Error).message}`);
        return reply(503, { error: "The agent could not be linked to its account just now. Try again shortly." });
      }
    } else if (deps.owners) {
      const now = new Date().toISOString();
      const old = await deps.owners.agent(agentId).catch(() => null);
      await deps.owners.putAgent({
        key: agentId, account: tenant, org: null, home_org: homeOrg,
        person: tenant, category: "account", listed: old?.listed ?? true, label,
        custody: null, payer: tenant, updated_at: now,
      });
    }
    const since = new Date().toISOString();
    const source = identitySourceOf(p, since);
    try {
      await recordSource(agentId, tenant, source);
      await deps.workloads?.put(wKey, {
        agent: agentId, tenant, kind: p.kind === "oauth" ? "oauth" : "spiffe", workload_id: p.workload_id,
        ...(p.issuer ? { issuer: p.issuer } : {}), ...(p.trust_domain ? { trust_domain: p.trust_domain } : {}),
        since: prior?.agent === agentId ? prior.since : since, updated_at: since,
      });
    } catch (err) {
      console.error(`${log} bootstrap: the identity records for ${agentId.slice(0, 12)}… could not be written: ${(err as Error).message}`);
      return reply(503, { error: "This enrollment could not be recorded right now, so no credential was issued. Try again shortly." });
    }
    // One outside identity, one agent: the key that held it before is revoked (§4.10).
    if (prior && prior.agent !== agentId) {
      await revokeAgentKeyAction(prior.agent, `its outside identity ${p.workload_id} enrolled a new key`, "keychain", agentId)
        .catch((err) => console.error(`${log} bootstrap: the key that held ${p.workload_id} before (${prior!.agent.slice(0, 12)}…) could not be revoked: ${(err as Error).message}`));
    }
    await deps.tombstones?.clear(agentId).catch(() => undefined);
    await deps.mintLog?.recordMint({ key: minted.subject, agents: [agentId], label, expiresAt: minted.expiresAt, door: "bootstrap", account: tenant, org: homeOrg });
    metrics.event({ kind: "node_credential", actor: agentId, meta: { door: "bootstrap-proof", proof: p.kind, binding: p.binding?.kind ?? "none" } });
    console.log(`${log} bootstrap: agent ${agentId.slice(0, 12)}… joined ${tenant} with a ${p.kind} proof for ${p.workload_id}${prior && prior.agent !== agentId ? ` (replacing ${prior.agent.slice(0, 12)}…)` : ""}, expires ${minted.expiresAt ?? "never"}`);
    return reply(200, {
      ok: true,
      jwt: minted.jwt,
      seed,
      creds: credsFileText(minted.jwt, seed),
      label,
      handle,
      ...(naming ? { naming } : {}),
      account_email: null,
      expires_at: minted.expiresAt,
      renew_url: `${deps.baseUrl.replace(/\/$/, "")}/v1/node-credential`,
      identity_source: source,
      ...(prior && prior.agent !== agentId ? { replaced: prior.agent } : {}),
      mesh: deps.meshInfo ? deps.meshInfo() : meshInfo(env),
    });
  }

  // ── POST /v1/bridged-callers (SPEC §4.15) ───────────────────────────

  /**
   * An identity bridge asks the key chain about a caller that holds no mesh
   * key: `{ node_id, ts, node_sig, caller_id, caller_sig, proof, binding? }`.
   * The bridge is a node this mesh names as one (MESH_BRIDGE_NODES); it signs
   * the request with its node key, and the caller's hosted identity signs too,
   * so the bridge proves it holds the key it speaks for. The proof is checked
   * as at enrollment, with the binding the bridge checked on the caller's own
   * request (its DPoP key's thumbprint, or its certificate's hash) in place of
   * one this door can check itself.
   *
   * A caller that passes belongs to the tenant whose trust record accepted its
   * proof: the hosted identity is recorded as that tenant's, unlisted, with an
   * identity source of kind "bridged". The bridge asks again whenever a token
   * is new and at least once a minute, so a stop, a revoked key or a removed
   * trust record reaches a bridged caller within a minute.
   */
  async function bridgedCaller(b: {
    node_id?: string; ts?: number; node_sig?: string; caller_id?: string; caller_sig?: string;
    proof?: unknown; binding?: { jkt?: unknown; x5t?: unknown }; audiences?: unknown;
  } | null): Promise<DoorAnswer> {
    const reply = (status: number, body: Record<string, unknown>): DoorAnswer => ({ status, body });
    if (!deps.proofs) return reply(403, { error: "This mesh accepts no outside proofs.", code: "proofs_not_offered" });
    if (!b?.node_id || !b.ts || !b.node_sig || !b.caller_id || !b.caller_sig) return reply(400, { error: "node_id, ts, node_sig, caller_id, caller_sig and proof are required" });
    if (!NKEY.test(b.node_id) || !NKEY.test(b.caller_id)) return reply(400, { error: "node_id and caller_id must be user public nkeys (U…)" });
    const bridges = new Set((env.MESH_BRIDGE_NODES ?? "").split(",").map((x) => x.trim()).filter(Boolean));
    if (!bridges.has(b.node_id)) return reply(403, { error: "This node is not one this mesh names as an identity bridge (MESH_BRIDGE_NODES).", code: "not_a_bridge" });
    if (Math.abs(Date.now() / 1000 - b.ts) > 600) return reply(401, { error: "stale timestamp, re-sign with the current time" });
    if (!verifyAgentSig(b.node_id, bridgedCallerStatement(b.ts, b.node_id, b.caller_id), b.node_sig)) return reply(401, { error: "node_sig does not verify against node_id" });
    if (!verifyAgentSig(b.caller_id, bridgedHostedStatement(b.ts, b.node_id, b.caller_id), b.caller_sig)) return reply(401, { error: "caller_sig does not verify against caller_id" });
    const proof = b.proof as ProofInput | null;
    if (!proof || typeof proof !== "object" || (proof.kind !== "oauth" && proof.kind !== "jwt-svid")) return reply(400, { error: 'proof must be { "kind": "oauth" | "jwt-svid", "token": "…" }' });
    const bound = b.binding && typeof b.binding === "object" ? b.binding : null;
    const v = await verifyOutsideProof(proof, {
      method: "POST",
      urls: [],
      // The front the caller called (RFC 8707): a token may name it in aud.
      ...(Array.isArray(b.audiences) ? { extraAudiences: (b.audiences as unknown[]).filter((x): x is string => typeof x === "string" && /^https?:\/\//.test(x)).slice(0, 4) } : {}),
      ...(bound ? { verifiedBinding: { ...(typeof bound.jkt === "string" ? { jkt: bound.jkt } : {}), ...(typeof bound.x5t === "string" ? { x5t: bound.x5t } : {}) } } : {}),
    }, deps.proofs);
    if (!v.ok) return reply(v.status, { error: v.error, code: v.code, details: { reason: reasonOf(v.code) } });
    const p = v.proof;
    const caller = b.caller_id;
    const tenant = p.tenant;

    let homeOrg: string | null = null;
    if (deps.platform.enrollCheck) {
      const c = await deps.platform.enrollCheck(tenant, caller).catch(() => null);
      if (!c) return reply(503, { error: "Could not check this account right now. Try again shortly." });
      if (!c.found) return reply(404, { error: "The tenant that trusts this proof's issuer was not found.", code: "account_not_found" });
      if (c.disabled) return reply(403, { error: "This account is disabled.", code: "account_disabled" });
      homeOrg = c.homeOrg ?? null;
    } else {
      const t = deps.owners ? await deps.owners.tenant(tenant).catch(() => null) : null;
      if (!t) return reply(404, { error: "The tenant that trusts this proof's issuer was not found.", code: "account_not_found" });
      if (t.disabled) return reply(403, { error: "This account is disabled.", code: "account_disabled" });
      homeOrg = t.home_org;
    }
    if (await deps.keyRevocations?.get(caller).catch(() => null)) return reply(403, { error: "This caller's hosted key has been revoked.", code: "agent_key_revoked" });
    try {
      let found = (await stopsFor([caller])).get(caller);
      if (!found) {
        const active = deps.stops ? await deps.stops.active() : [];
        found = active.length ? stopFor(active, { key: caller, person: tenant, org: orgsOn() ? homeOrg : null }) ?? undefined : undefined;
      }
      if (found) {
        const r = mintRefusal(found, caller);
        return reply(r.status, r.body);
      }
    } catch {
      return reply(503, { error: "Could not check whether this caller is stopped. Try again shortly." });
    }
    let holder: Holder | null;
    try { holder = await holderOf(caller); } catch { return reply(503, { error: "Could not check who holds this caller right now. Try again shortly." }); }
    if (holder && holder.id !== tenant) return reply(409, { error: EXCLUSIVITY_ERROR, code: "held_elsewhere" });

    const scope = p.kind === "oauth" ? p.issuer! : "spiffe";
    const callerRef = p.kind === "oauth" ? createHash("sha256").update(`${p.issuer}\n${p.workload_id}`).digest("hex") : p.workload_id;
    const prior = await deps.identitySources?.get(caller).catch(() => null);
    const same = prior?.identity_source.kind === "bridged" && prior.identity_source.bridge === b.node_id && prior.identity_source.workload_id === p.workload_id;
    const source: IdentitySource = same ? prior!.identity_source : identitySourceOf(p, new Date().toISOString(), b.node_id);
    if (!same) {
      try {
        if (!holder) {
          const label = `bridged ${p.workload_id}`.slice(0, 120); // cut-ok: a display label; the whole id is in the identity source
          if (deps.platform.enrolled) await deps.platform.enrolled({ accountId: tenant, agentId: caller, label, deferName: true });
          else if (deps.owners) {
            await deps.owners.putAgent({
              key: caller, account: tenant, org: null, home_org: homeOrg, person: tenant, category: "account",
              listed: false, label, custody: null, payer: tenant, updated_at: new Date().toISOString(),
            });
          }
        }
        await recordSource(caller, tenant, source);
        await deps.workloads?.put(workloadKey(p.kind === "oauth" ? "oauth" : "spiffe", `bridged:${scope}`, p.workload_id), {
          agent: caller, tenant, kind: p.kind === "oauth" ? "oauth" : "spiffe", workload_id: p.workload_id,
          ...(p.issuer ? { issuer: p.issuer } : {}), ...(p.trust_domain ? { trust_domain: p.trust_domain } : {}),
          bridge: b.node_id, since: source.since, updated_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`${log} bridged-callers: the records for ${caller.slice(0, 12)}… could not be written: ${(err as Error).message}`);
        return reply(503, { error: "This caller could not be recorded right now. Try again shortly." });
      }
      console.log(`${log} bridged-callers: ${b.node_id.slice(0, 12)}… bridges ${caller.slice(0, 12)}… for ${p.workload_id} (tenant ${tenant})`);
    }
    return reply(200, {
      ok: true,
      tenant,
      caller_id: caller,
      caller_kind: p.kind === "oauth" ? "oauth" : "spiffe",
      caller_ref: callerRef,
      workload_id: p.workload_id,
      ...(p.issuer ? { issuer: p.issuer } : {}),
      ...(p.trust_domain ? { trust_domain: p.trust_domain } : {}),
      binding: p.binding?.kind ?? null,
      expires_at: p.expires_at,
      identity_source: source,
    });
  }

  /**
   * The fresh-proof rule at renewal (SPEC §4.8, §4.14): an agent that enrolled
   * with an outside proof renews only with a fresh proof of the same identity,
   * so an agent its company has turned off cannot renew. Answers, for each
   * agent on the roster, whether it passes; an agent enrolled any other way
   * passes without one.
   */
  async function freshProofCheck(
    agents: { id?: string; proof?: unknown; dpop?: unknown }[],
    req: DoorRequest,
  ): Promise<{ passed: string[]; refused: { id: string; code: string; error: string }[] } | "unread"> {
    const passed: string[] = [];
    const out: { id: string; code: string; error: string }[] = [];
    for (const a of agents) {
      const id = a.id!;
      let rec: Awaited<ReturnType<IdentitySourceList["get"]>> = null;
      if (deps.identitySources) {
        try { rec = await deps.identitySources.get(id); } catch { return "unread"; }
      }
      const kind = rec?.identity_source.kind;
      if (kind !== "oauth" && kind !== "spiffe" && kind !== "wimse") { passed.push(id); continue; }
      const proof = a.proof as ProofInput | undefined;
      if (!proof || typeof proof !== "object" || !deps.proofs) {
        out.push({ id, code: "fresh_proof_required", error: "This agent enrolled with an outside proof, so it renews only with a fresh proof of the same identity." });
        continue;
      }
      const v = await verifyOutsideProof(proof, {
        method: "POST",
        urls: doorUrls("/v1/node-credential"),
        ...(typeof a.dpop === "string" ? { dpop: a.dpop } : req.dpop && agents.length === 1 ? { dpop: req.dpop } : {}),
        ...(req.clientCerts ? { clientCerts: req.clientCerts } : {}),
      }, deps.proofs);
      if (!v.ok) { out.push({ id, code: v.code, error: v.error }); continue; }
      if (v.proof.tenant !== rec!.tenant || v.proof.workload_id !== rec!.identity_source.workload_id) {
        out.push({ id, code: "fresh_proof_mismatch", error: "The fresh proof is for a different identity from the one this agent enrolled with." });
        continue;
      }
      const scope = v.proof.kind === "oauth" ? v.proof.issuer! : "spiffe";
      const bound = deps.workloads ? await deps.workloads.get(workloadKey(v.proof.kind === "oauth" ? "oauth" : "spiffe", scope, v.proof.workload_id)).catch(() => "unread" as const) : null;
      if (bound === "unread") return "unread";
      if (bound && bound.agent !== id) {
        out.push({ id, code: "identity_moved", error: "This outside identity now belongs to another agent key, so this one does not renew." });
        continue;
      }
      passed.push(id);
    }
    return { passed, refused: out };
  }

  // ── POST /v1/node-credential ─────────────────────────────────────────

  async function nodeCredential(
    b: { node_id?: string; ts?: number; node_sig?: string; agents?: { id?: string; sig?: string; proof?: unknown; dpop?: unknown }[] } | null,
    ip: string,
    meshInfo: () => Record<string, unknown>,
    req: DoorRequest = {},
  ): Promise<DoorAnswer> {
    const reply = (status: number, body: Record<string, unknown>): DoorAnswer => ({ status, body });
    if (!b?.node_id || !b?.ts || !b?.node_sig || !Array.isArray(b.agents) || b.agents.length === 0) {
      return reply(400, { error: "node_id, ts, node_sig, agents[] required" });
    }
    if (!NKEY.test(b.node_id)) return reply(400, { error: "node_id must be a user public nkey (U…)" });
    if (b.agents.length > NODE_CREDENTIAL_MAX_AGENTS) {
      return reply(400, { error: `a node credential covers at most ${NODE_CREDENTIAL_MAX_AGENTS} agents` });
    }
    if (Math.abs(Date.now() / 1000 - b.ts) > 600) return reply(401, { error: "stale timestamp — re-sign with current time" });
    const ids: string[] = [];
    for (const a of b.agents) {
      if (!a?.id || !a?.sig) return reply(400, { error: "every agents[] entry needs id and sig" });
      if (!NKEY.test(a.id)) return reply(400, { error: `agent id ${a.id.slice(0, 12)}… is not a user public nkey (U…)` });
      if (ids.includes(a.id)) return reply(400, { error: "duplicate agent id" });
      ids.push(a.id);
    }
    const roster = [...ids].sort().join(",");
    if (!verifyAgentSig(b.node_id, `mesh-node-cred-v1:${b.ts}:${b.node_id}:${roster}`, b.node_sig)) {
      return reply(401, { error: "node_sig does not verify against node_id" });
    }
    for (const a of b.agents) {
      if (!verifyAgentSig(a.id!, `mesh-node-agent-v1:${b.ts}:${b.node_id}:${a.id}`, a.sig!)) {
        return reply(401, { error: `agent signature does not verify for ${a.id!.slice(0, 12)}…` });
      }
    }

    // An agent that enrolled with an outside proof renews only with a fresh
    // one (§4.8, §4.14); it is left off the credential without one.
    const fresh = await freshProofCheck(b.agents, req);
    if (fresh === "unread") {
      return reply(503, { error: "Could not check how these agents enrolled right now, so no credential was issued. Retry; your current credential is unaffected." });
    }
    const proofRefused = fresh.refused;
    if (proofRefused.length) {
      if (!fresh.passed.length) {
        const first = proofRefused[0]!;
        console.log(`${log} node-credential REFUSED for ${b.node_id.slice(0, 12)}…: ${first.code} (${ip})`);
        metrics.event({ kind: "node_credential_refused", actor: b.node_id, meta: { agents: ids.length, reason: first.code } });
        return reply(401, { error: first.error, code: first.code, details: { reason: reasonOf(first.code) }, refused: proofRefused.map(({ id, code }) => ({ id, code })) });
      }
      const off = new Set(proofRefused.map((r) => r.id));
      ids.splice(0, ids.length, ...ids.filter((k) => !off.has(k)));
      console.log(`${log} node-credential: ${b.node_id.slice(0, 12)}… left ${proofRefused.length} agent(s) off for want of a fresh proof (${ip})`);
    }

    // The standing question, after proof-of-possession and before the mint:
    // refusing here is what "revoked" means on this mesh (§4.8). Fail closed.
    const holderMemo = new Map<string, Holder | null>();
    let decision: Awaited<ReturnType<typeof decideRenewal>>;
    try {
      decision = await decideRenewal(
        {
          holderOf: async (k) => {
            const h = await holderOf(k);
            holderMemo.set(k, h);
            return h;
          },
          revocationOf: (k) => (deps.tombstones ? deps.tombstones.get(k) : Promise.resolve(null)),
          clearRevocation: deps.tombstones ? (k) => deps.tombstones!.clear(k) : undefined,
          signingKeyRevoked: deps.keyRevocations ? async (k) => !!(await deps.keyRevocations!.get(k)) : undefined,
        },
        ids,
        { leaveOff: true },
      );
    } catch (err) {
      console.error(`${log} node-credential: standing check failed, refusing to mint: ${(err as Error).message}`);
      return reply(503, {
        error:
          "could not check this node's standing right now, and issuing a credential without " +
          "checking would defeat the only revocation this mesh has. Retry — your current " +
          "credential is unaffected.",
      });
    }
    if (!decision.allow) {
      console.log(`${log} node-credential REFUSED for ${b.node_id.slice(0, 12)}…: ${decision.error} (${ip})`);
      metrics.event({ kind: "node_credential_refused", actor: b.node_id, meta: { agents: ids.length } });
      return reply(decision.status, { error: decision.error });
    }

    const leftOff = decision.leftOff ?? [];
    const standing = ids.filter((k) => !leftOff.some((l) => l.id === k));
    if (leftOff.length) console.log(`${log} node-credential: ${b.node_id.slice(0, 12)}… left ${leftOff.length} retired or revoked agent(s) off its credential (${ip})`);
    let stopped: Map<string, StopFinding>;
    try {
      stopped = await stopsFor(standing);
    } catch (err) {
      console.error(`${log} node-credential: stop list unreadable, refusing to mint: ${(err as Error).message}`);
      return reply(503, { error: "could not check whether these agents are stopped right now, so no credential was issued. Retry; your current credential is unaffected." });
    }
    const split = partitionRoster(standing, stopped);
    const running = split.running;
    if (!running.length) {
      const r = mintRefusal(stopped.get(standing[0])!, standing[0]);
      console.log(`${log} node-credential REFUSED for ${b.node_id.slice(0, 12)}…: every agent on the roster is stopped (${ip})`);
      metrics.event({ kind: "node_credential_refused", actor: b.node_id, meta: { agents: ids.length, reason: r.body.code } });
      return reply(r.status, { ...r.body, stopped: split.stopped });
    }

    // MESH_REQUIRE_NAMES (shared/require-names.ts).
    const labels = new Map<string, string | null>();
    for (const k of running) {
      const rec = await recordOf(k);
      labels.set(k, rec === "unread" || !rec ? null : rec.label);
    }
    // Whether names are required: the switch this process was handed, else
    // the platform's, when one runs beside the core (its settings store is
    // where the operator turns it on), else this process's environment.
    const namesOn = deps.namesRequired
      ? await deps.namesRequired().catch(() => false)
      : deps.platform.namesRequired
        ? await deps.platform.namesRequired().catch(() => undefined)
        : undefined;
    const names = await namesAtDoor("node-credential", running, {
      ...(namesOn !== undefined ? { on: namesOn } : {}),
      labelOf: (k) => labels.get(k) ?? null,
      why: (k) => (holderMemo.get(k) ? "no verified name" : "no verified name, and no account holds it"),
    });
    let mintIds = names.pass;
    if (names.on && !names.pass.length) {
      let refusal: { status: number; body: Record<string, unknown> };
      if (names.unreachable.length) refusal = { status: 503, body: namesUncheckedRefusal() };
      else {
        const first = names.unnamed[0]!;
        const holder = holderMemo.get(first) ?? null;
        const r = holder && deps.platform.namingRefusal ? await deps.platform.namingRefusal(holder.id, first).catch(() => null) : null;
        refusal = r ?? { status: 403, body: unnamedStrangerRefusal() };
      }
      console.log(`${log} node-credential REFUSED for ${b.node_id.slice(0, 12)}…: no agent on the roster has a verified name (${ip})`);
      metrics.event({ kind: "node_credential_refused", actor: b.node_id, meta: { agents: ids.length, reason: refusal.body.code } });
      return reply(refusal.status, refusal.body);
    }
    if (!names.on) mintIds = running;
    else if (names.pass.length < running.length) {
      console.log(
        `[require-names] node-credential: issued for ${names.pass.length} of ${running.length}; left out ` +
          [...names.unnamed, ...names.unreachable].map((k) => `${labels.get(k) ?? "(no name)"} ${k.slice(0, 12)}…`).join(", "),
      );
    }

    // No credential for an agent no tenant holds (SPEC §4.1, §4.8; the core
    // profile's "no node credential for an account without an owner"), whatever
    // the naming setting says. Until 2026-10-12 a mesh with names off minted
    // on proof of key possession alone, which is the gap conformance c19 shows.
    // Names stay optional: this asks only whether a tenant holds the key (the
    // ownership record, else the platform's fallback, as `holderOf` answers).
    // An agent no tenant holds is left off the way a retired one is, so the
    // rest of a node's roster still gets its credential; with none left, the
    // door refuses. Asked after the names check, so where names are required an
    // unnamed stranger is still told about naming, as before.
    const unowned = mintIds.filter((k) => !holderMemo.get(k));
    if (unowned.length) {
      mintIds = mintIds.filter((k) => holderMemo.get(k));
      if (!mintIds.length) {
        const body = noOwnerRefusal();
        console.log(`${log} node-credential REFUSED for ${b.node_id.slice(0, 12)}…: no tenant holds ${unowned.length === 1 ? "the agent" : `any of the ${unowned.length} agents`} on the roster (${ip})`);
        metrics.event({ kind: "node_credential_refused", actor: b.node_id, meta: { agents: ids.length, reason: body.code } });
        return reply(403, body);
      }
      console.log(`${log} node-credential: ${b.node_id.slice(0, 12)}… left ${unowned.length} agent(s) no tenant holds off its credential: ${unowned.map((k) => `${k.slice(0, 12)}…`).join(", ")} (${ip})`);
    }

    const seedRead = customerMintSeed(env);
    if (!seedRead.ok) return reply(seedRead.status, { error: seedRead.error });
    // A node cut by the kill switch this very second must get a credential
    // issued after the cut, wherever the cut happened.
    await mintAfterCut(b.node_id, undefined, undefined, deps.mintLog ? (k) => deps.mintLog!.cutAt(k) : undefined);
    const minted = await mintNodeCredential({
      subject: b.node_id,
      agentIds: mintIds,
      mintSeed: seedRead.seed,
      issuerAccount: env.ROOMS_MINT_ISSUER_ACCOUNT,
      namePrefix: "node",
    });
    console.log(`${log} node-credential: ${b.node_id.slice(0, 12)}… minted for ${mintIds.length} agent(s)${mintIds.length < ids.length ? ` (${ids.length - mintIds.length} left out: stopped, retired, no tenant, or no verified name)` : ""}, expires ${minted.expiresAt ?? "never"} (${ip})`);
    metrics.event({ kind: "node_credential", actor: b.node_id, meta: { agents: mintIds.length } });
    await deps.mintLog?.recordMint({
      key: minted.subject,
      agents: mintIds,
      expiresAt: minted.expiresAt,
      door: "renewal",
      account: decision.accountId,
    });
    return reply(200, {
      ok: true,
      jwt: minted.jwt,
      node_id: b.node_id,
      agents: mintIds,
      ...(split.stopped.length || leftOff.some((l) => l.reason === "key_revoked")
        ? { stopped: [...split.stopped, ...leftOff.filter((l) => l.reason === "key_revoked").map((l) => ({ id: l.id, code: "agent_key_revoked" }))] }
        : {}),
      ...(leftOff.some((l) => l.reason === "retired") ? { retired: leftOff.filter((l) => l.reason === "retired").map((l) => l.id) } : {}),
      // Left off because no tenant holds them (above).
      ...(unowned.length ? { unowned } : {}),
      // Left off because they enrolled with an outside proof and sent no fresh one.
      ...(proofRefused.length ? { refused: proofRefused.map(({ id, code }) => ({ id, code })) } : {}),
      expires_at: minted.expiresAt,
      mesh: meshInfo(),
    });
  }

  // ── POST /v1/credential/revoke-own ───────────────────────────────────

  async function revokeOwnCredential(b: { user_key?: unknown; ts?: unknown; sig?: unknown } | null): Promise<DoorAnswer> {
    const userKey = typeof b?.user_key === "string" ? b.user_key : "";
    const ts = typeof b?.ts === "number" ? b.ts : NaN;
    const sig = typeof b?.sig === "string" ? b.sig : "";
    if (!NKEY.test(userKey) || !Number.isFinite(ts) || !sig) {
      return { status: 400, body: { error: "user_key (U...), ts (unix seconds) and sig are required" } };
    }
    if (Math.abs(Date.now() / 1000 - ts) > 600) return { status: 401, body: { error: "stale timestamp, re-sign with the current time" } };
    if (!verifyAgentSig(userKey, `mesh-cred-revoke-v1:${ts}:${userKey}`, sig)) {
      return { status: 401, body: { error: "sig does not verify against user_key" } };
    }
    // Only a key this mesh issued a credential on: keys are free to make, and
    // every entry is pushed to the broker.
    if (!deps.mintLog) return { status: 503, body: { error: "the credential records cannot be read right now, try again shortly" } };
    const known = (await deps.mintLog.all().catch(() => [])).some((c) => c.key === userKey);
    if (!known) return { status: 404, body: { error: "this mesh has no record of a credential issued on that key" } };
    const out = await deps.revokeCredential({ userKeys: [userKey], reason: "revoked by its holder", by: "holder", refuseRenewal: false, deregister: false });
    return { status: 200, body: out as unknown as Record<string, unknown> };
  }

  // ── POST /v1/agent-key/revoke-own ────────────────────────────────────

  async function revokeAgentKeyAction(key: string, reason: string, by: string, replacedBy?: string): Promise<AgentKeyRevokeResult> {
    if (!deps.keyRevocations) throw new Error("agent key revocations cannot be recorded on this process (no JetStream)");
    const revs = deps.keyRevocations;
    const out = await revokeAgentKey(
      {
        markRevoked: (k, rec) => revs.revoke(k, rec),
        revokeCredentials: (k, r, who) => deps.revokeCredential({ agentKey: k, reason: `agent key revoked: ${r}`, by: who }),
      },
      key, reason, by, replacedBy,
    );
    metrics.event({ kind: "agent_key_revoked", actor: key, meta: { reason, by, replaced: !!replacedBy } });
    console.log(`${log} agent key REVOKED ${key.slice(0, 12)}… by ${by}: ${reason}`);
    return out;
  }

  async function revokeOwnAgentKey(b: { agent_key?: unknown; ts?: unknown; sig?: unknown } | null, ip: string): Promise<DoorAnswer> {
    if (!keyRevokeLimiter.check(ip).allowed) return { status: 429, body: { error: "too many key revocations from this address, try again later" } };
    const key = typeof b?.agent_key === "string" ? b.agent_key : "";
    const ts = typeof b?.ts === "number" ? b.ts : NaN;
    const sig = typeof b?.sig === "string" ? b.sig : "";
    if (!NKEY.test(key) || !Number.isFinite(ts) || !sig) {
      return { status: 400, body: { error: "agent_key (U...), ts (unix seconds) and sig are required" } };
    }
    if (Math.abs(Date.now() / 1000 - ts) > 600) return { status: 401, body: { error: "stale timestamp, re-sign with the current time" } };
    if (!verifyAgentSig(key, revokeOwnStatement(ts, key), sig)) return { status: 401, body: { error: "sig does not verify against agent_key" } };
    try {
      return { status: 200, body: (await revokeAgentKeyAction(key, "revoked by its holder", "holder")) as unknown as Record<string, unknown> };
    } catch (err) {
      return { status: 503, body: { error: (err as Error).message } };
    }
  }

  // ── GET /v1/key-check/:key ───────────────────────────────────────────

  async function keyCheck(key: string): Promise<DoorAnswer> {
    if (!NKEY.test(key)) return { status: 400, body: { error: "not an agent public key" } };
    if (!deps.keyRevocations) return { status: 503, body: { error: "the revocation record cannot be read right now" } };
    let rec: Awaited<ReturnType<AgentKeyRevocationStore["get"]>>;
    try { rec = await deps.keyRevocations.get(key); } catch { return { status: 503, body: { error: "the revocation record cannot be read right now" } }; }
    // Whether the agent is paused or terminated, so a receiver refuses a
    // stopped sender (§5.3). An unreadable status leaves the field out.
    const st = await deps.agentStatus?.get(key).catch(() => null);
    const adv = deps.platform.advisory ? await deps.platform.advisory(key).catch(() => null) : null;
    return {
      status: 200,
      headers: { "cache-control": "public, max-age=15" },
      body: {
        ...(rec
          ? { revoked: true, revoked_at: rec.at, ...(rec.replaced_by ? { replaced_by: rec.replaced_by } : {}) }
          : { revoked: false }),
        ...(st ? { stopped: st.status, stopped_at: st.since } : {}),
        ...(adv ? { advisory: { tier: adv.tier, severity: adv.severity, id: adv.id, title: adv.title } } : {}),
      },
    };
  }

  // ── POST /v1/key-standing ────────────────────────────────────────────

  /** Whether an account on this mesh holds the caller's agent key, asked by
   *  the key's holder (a fresh signature over `mesh-key-standing-v1:<ts>:<key>`).
   *  On a mesh that offers no naming, the reference adapter sends as an agent
   *  only when this says yes, in place of a verified name (2026-10-12). Only
   *  the holder learns the answer, so it is no oracle on a public key. */
  async function keyStanding(b: { agent_key?: unknown; ts?: unknown; sig?: unknown } | null, ip: string): Promise<DoorAnswer> {
    if (!standingLimiter.check(ip).allowed) return { status: 429, body: { error: "too many standing checks from this address, try again later" } };
    const key = typeof b?.agent_key === "string" ? b.agent_key : "";
    const ts = typeof b?.ts === "number" ? b.ts : NaN;
    const sig = typeof b?.sig === "string" ? b.sig : "";
    if (!NKEY.test(key) || !Number.isFinite(ts) || !sig) {
      return { status: 400, body: { error: "agent_key (U...), ts (unix seconds) and sig are required" } };
    }
    if (Math.abs(Date.now() / 1000 - ts) > 600) return { status: 401, body: { error: "stale timestamp, re-sign with the current time" } };
    if (!verifyAgentSig(key, keyStandingStatement(ts, key), sig)) return { status: 401, body: { error: "sig does not verify against agent_key" } };
    let holder: Holder | null;
    try {
      holder = await holderOf(key);
    } catch {
      return { status: 503, body: { error: "this mesh could not check who holds this agent right now, try again shortly" } };
    }
    return { status: 200, body: { agent_key: key, enrolled: !!holder && !holder.disabled, ...(holder?.disabled ? { account_disabled: true } : {}) } };
  }

  return { bootstrap, bridgedCaller, nodeCredential, revokeOwnCredential, revokeOwnAgentKey, revokeAgentKeyAction, keyCheck, keyStanding, stopsFor, holderOf };
}

export type CredentialDoors = ReturnType<typeof credentialDoors>;

/**
 * The refusal when enrolling `agentKey` under `tenant` would take the tenant
 * past its own agent limit, or null when it would not (or no limit is set).
 * Throws when the limit is set and the agents cannot be counted. The bootstrap
 * door and the admin API's enroll both ask it.
 */
export async function agentLimitRefusal(
  deps: Pick<DoorDeps, "owners" | "limits">,
  tenant: string,
  agentKey: string,
): Promise<{ error: string; code: string; limit: number } | null> {
  if (!deps.limits) return null;
  const max = (await deps.limits.get(tenant))?.max_agents;
  if (typeof max !== "number") return null;
  if (!deps.owners) throw new Error("the ownership record is not open");
  const all = await deps.owners.allAgents();
  const n = [...all.values()].filter((r) => r.account === tenant && r.key !== agentKey).length;
  if (n < max) return null;
  return {
    error: `This tenant already has ${n} agent${n === 1 ? "" : "s"}, and its limit is ${max}. Remove one, or ask this mesh's operator to raise the limit.`,
    code: "tenant_agent_limit",
    limit: max,
  };
}

/** What an identity bridge signs with its node key to ask about a caller (§4.15). */
export function bridgedCallerStatement(ts: number, node: string, caller: string): string {
  return `mesh-bridge-caller-v1:${ts}:${node}:${caller}`;
}

/** What the caller's hosted identity signs beside it: the bridge holds this key. */
export function bridgedHostedStatement(ts: number, node: string, caller: string): string {
  return `mesh-bridge-hosted-v1:${ts}:${node}:${caller}`;
}

/** The statement an agent signs to ask the key-standing door about itself. */
export function keyStandingStatement(ts: number, key: string): string {
  return `mesh-key-standing-v1:${ts}:${key}`;
}

/** What the node-credential door says when no account (tenant) on this mesh
 *  holds any agent on the roster. The code is the rooms service's word for the
 *  same fact. */
export function noOwnerRefusal(): { error: string; code: string } {
  return {
    error:
      "No account on this mesh holds this agent, so no credential was issued. A credential is issued only for an agent " +
      "its owner has enrolled: redeem an agent key made in the owner's account (agentmesh up <agent-key>), or ask this " +
      "mesh's operator to enroll it, then try again.",
    code: "no_owner_on_record",
  };
}

/** What the bootstrap door says when the key is already held by another account. */
export const EXCLUSIVITY_ERROR =
  "This agent is already linked to a different account. Remove it there first, then link it here.";
