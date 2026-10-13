/**
 * Node-credential renewal (§4.8).
 *
 * A node credential is a **lease**, exactly like the node vouch it sits under
 * (§4.4): SPEC §4.8 requires it to carry a finite expiry, and an expiry with no
 * renewal is just a scheduled outage. This module is the renewal half.
 *
 * The shape deliberately mirrors `internal/vouch.ts`, because it is the same
 * problem one layer down and the same answer should not be spelled two ways:
 *
 *   - the deadline is a fixed fraction into the credential's OWN lifetime
 *     (`iat` → `exp` read off the JWT), not a fraction of a configured TTL, so a
 *     credential minted by a different operator policy still gets a
 *     proportionate deadline;
 *   - the loop compares wall-clock against a stored deadline instead of
 *     sleeping until it, so a suspended laptop renews on its first tick after
 *     waking rather than a week late;
 *   - a failure leaves the deadline in place and the next tick retries — two
 *     thirds is chosen precisely so a whole third of the lifetime is left to
 *     recover in.
 *
 * **Renewal does not require a live connection, and does not require the
 * credential to still be valid.** It is a plain HTTPS call authorized by
 * proof-of-possession of the node key and every hosted agent key. That is the
 * property the whole migration rests on: an agent whose lease lapsed while its
 * host was powered off can still renew when it comes back, because the door it
 * knocks on is not the mesh.
 */
import { nkeys } from "./internal/nkeys.js";
import {
  MAX_VOUCH_CHECK_INTERVAL_MS,
  VOUCH_RENEWAL_FRACTION,
} from "./constants.js";
import { setUnrefInterval, type TimerHandle } from "./internal/timers.js";

/** Standard base64 with padding, no Buffer — this module ships to browsers. */
function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decode one base64url JWT segment to a UTF-8 string. */
function decodeSegment(seg: string): string {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((seg.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(out);
}

/** The three claims renewal scheduling needs out of a NATS user JWT. */
export interface CredentialClaims {
  /** The public nkey the credential is bound to — the key whose seed must sign
   *  the renewal request. */
  sub: string | null;
  /** Issued-at, unix seconds. */
  iat: number | null;
  /** Expiry, unix seconds. `null` means the credential never expires — the
   *  pre-§4.8 shape this module exists to retire. */
  exp: number | null;
}

/**
 * Read `sub`/`iat`/`exp` out of a NATS user JWT.
 *
 * Deliberately does NOT verify the signature. The broker verifies it at connect
 * time against the account chain, which is the only party that can; a client
 * verifying its own credential would prove nothing it does not already assume.
 * This is a read of a value the holder already possesses, for scheduling.
 *
 * Returns `null` when the string is not a JWT at all.
 */
export function decodeCredentialClaims(jwt: string): CredentialClaims | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const claim = JSON.parse(decodeSegment(parts[1])) as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      sub: typeof claim.sub === "string" ? claim.sub : null,
      iat: num(claim.iat),
      exp: num(claim.exp),
    };
  } catch {
    return null;
  }
}

/**
 * The instant (ms epoch) at which a credential should be renewed: the same two
 * thirds into its own lifetime that a vouch uses.
 *
 * `null` when the credential carries no usable window — either it never expires
 * (nothing to renew before) or its claims are unreadable. A `null` here is not
 * an error; it is the honest statement that there is no deadline to schedule
 * from, and `CredentialRenewer` treats it as "never due".
 */
export function credentialRenewAt(claims: CredentialClaims | null): number | null {
  if (!claims || claims.exp === null) return null;
  const expires = claims.exp * 1000;
  // A credential with no `iat` still has a deadline worth computing: assume the
  // conventional 30-day lease so an odd mint is not left unrenewed forever.
  const issued = claims.iat === null ? expires - 30 * 24 * 3600_000 : claims.iat * 1000;
  if (expires <= issued) return null;
  return issued + (expires - issued) * VOUCH_RENEWAL_FRACTION;
}

/** How often to check whether renewal is due, for a credential of this
 *  lifetime. Four checks inside the last third, capped hourly — see
 *  `internal/vouch.ts` for why this is a periodic check and not one long
 *  timer. */
export function credentialCheckIntervalMs(lifetimeMs: number): number {
  const window = lifetimeMs * (1 - VOUCH_RENEWAL_FRACTION);
  return Math.max(1, Math.min(Math.floor(window / 4), MAX_VOUCH_CHECK_INTERVAL_MS));
}

/** One hosted agent, and the means of proving it consents to being hosted.
 *  Supply exactly one of `seed` or `sign` — `sign` exists so a caller that holds
 *  an agent object but not its seed (a `MeshNode` and the agents it created)
 *  can consent without the seed leaving that object. */
export interface RenewalAgent {
  /** The agent's public nkey (`U…`). */
  id: string;
  /** Its seed (`SU…`), as the base32 string or raw bytes. Used only to sign the
   *  consent line; it is never transmitted. */
  seed?: string | Uint8Array;
  /** Detached Ed25519 signature over `message`, standard base64. */
  sign?: (message: string) => string;
}

/** A roster, or a function returning the current one. The function form is for
 *  a node whose hosted set changes: the roster is read at each renewal, so an
 *  agent added after the loop started is covered by the next credential. */
export type RenewalRoster = RenewalAgent[] | (() => RenewalAgent[]);

const rosterOf = (r: RenewalRoster): RenewalAgent[] => (typeof r === "function" ? r() : r);

export interface RenewedCredential {
  jwt: string;
  /** The key the new credential is bound to — unchanged by a renewal. */
  node_id: string;
  agents: string[];
  /** ISO-8601, or `null` if this instance still mints without an expiry. */
  expires_at: string | null;
  /** Agents the mesh left off this credential because they are stopped by
   *  the kill switch (`agent_paused` or `agent_terminated`). Absent when none
   *  is. */
  stopped?: Array<{ id: string; code: string }>;
}

/**
 * The mesh refused a credential. `code` is the machine reason when the mesh
 * gave one: `agent_paused` and `agent_terminated` (the kill switch) mean every
 * agent on the roster is stopped, and a host should say so and check back
 * later rather than retry in a loop; `agent_unnamed` is the naming rule.
 */
export class CredentialRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly stopped: Array<{ id: string; code: string }> = [],
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "CredentialRefusedError";
  }
  /** True when the refusal is the kill switch's: every agent is stopped. */
  get isStopped(): boolean {
    return this.code === "agent_paused" || this.code === "agent_terminated";
  }
}

const toBytes = (s: string | Uint8Array): Uint8Array =>
  typeof s === "string" ? new TextEncoder().encode(s) : s;

/**
 * Build the signed body of a node-credential request (`POST
 * /v1/node-credential`). Exported so a host can renew without the loop, and so
 * the signing contract is testable without a server.
 *
 * The node proves it wants exactly this roster; each agent proves it consents to
 * this node. Nothing here grants access to a key the caller did not prove.
 */
export function buildCredentialRequest(
  nodeSeed: string | Uint8Array,
  roster: RenewalRoster,
  nowSec = Math.floor(Date.now() / 1000),
): {
  node_id: string;
  ts: number;
  node_sig: string;
  agents: { id: string; sig: string }[];
} {
  const agents = rosterOf(roster);
  if (!agents.length) throw new Error("a node credential must cover at least one agent");
  const nodeKp = nkeys.fromSeed(toBytes(nodeSeed));
  const nodeId = nodeKp.getPublicKey();
  const enc = new TextEncoder();
  const ids = agents.map((a) => a.id);
  const line = [...ids].sort().join(",");
  const nodeSig = toB64(nodeKp.sign(enc.encode(`mesh-node-cred-v1:${nowSec}:${nodeId}:${line}`)));
  const signed = agents.map((a) => {
    const message = `mesh-node-agent-v1:${nowSec}:${nodeId}:${a.id}`;
    if (a.sign) return { id: a.id, sig: a.sign(message) };
    if (a.seed === undefined) throw new Error(`agent ${a.id.slice(0, 12)}… supplied neither seed nor sign`);
    const kp = nkeys.fromSeed(toBytes(a.seed));
    if (kp.getPublicKey() !== a.id) {
      throw new Error(`agent seed does not match id ${a.id.slice(0, 12)}…`);
    }
    return { id: a.id, sig: toB64(kp.sign(enc.encode(message))) };
  });
  return { node_id: nodeId, ts: nowSec, node_sig: nodeSig, agents: signed };
}

/**
 * How long one renewal request may take before it is abandoned.
 *
 * Explicit, and small, for a reason the default does not cover: `fetch` on Node
 * has no overall request deadline, so a connection that opens and then stalls
 * hangs the call indefinitely — and while it hangs, `CredentialRenewer` holds
 * its in-flight guard, so the periodic loop stops retrying. One stalled socket
 * would quietly consume the entire renewal window. Fifteen seconds is generous
 * for a request whose body is four short fields, and the loop is what turns a
 * timeout into a retry.
 *
 * **There is deliberately no retry inside the call.** Retrying here would nest
 * a second, invisible schedule inside the two-thirds one and make the real
 * cadence unknowable. `renewIfDue` leaves the deadline in place on failure, so
 * the next tick is the retry — roughly hourly through the last third of the
 * credential's life, which is hundreds of attempts before anything lapses.
 * `sdk-rust` matches both numbers exactly.
 */
export const CREDENTIAL_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Renew (or first-mint) a node credential.
 *
 * `apiBase` is the mesh's control-plane origin, e.g. `https://api.agentmesh.ai`.
 * Returns the fresh JWT; the caller keeps the seed it already holds, because a
 * renewal never changes the key the credential is bound to. Persisting the new
 * JWT is the caller's job — this module does not know where the credential
 * lives.
 */
export async function renewNodeCredential(
  apiBase: string,
  nodeSeed: string | Uint8Array,
  roster: RenewalRoster,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = CREDENTIAL_REQUEST_TIMEOUT_MS,
): Promise<RenewedCredential> {
  const body = buildCredentialRequest(nodeSeed, roster);
  let res: Response;
  try {
    res = await fetchImpl(`${apiBase.replace(/\/$/, "")}/v1/node-credential`, {
      signal: AbortSignal.timeout(timeoutMs),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // A timeout surfaces as a bare "The operation was aborted", which in a
    // warning about a lapsing credential reads like a bug in the SDK rather
    // than an unreachable mesh. Say which it was.
    const name = (err as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`credential renewal timed out after ${timeoutMs}ms — the mesh did not answer`);
    }
    throw err;
  }
  const data = (await res.json().catch(() => ({}))) as Partial<RenewedCredential> & {
    error?: string;
    code?: string;
    retry_after_seconds?: number;
  };
  if (!res.ok || !data.jwt) {
    throw new CredentialRefusedError(
      data.error ?? `credential renewal failed: HTTP ${res.status}`,
      res.status,
      typeof data.code === "string" ? data.code : null,
      Array.isArray(data.stopped) ? data.stopped : [],
      typeof data.retry_after_seconds === "number" ? data.retry_after_seconds : null,
    );
  }
  return {
    jwt: data.jwt,
    node_id: data.node_id ?? body.node_id,
    agents: data.agents ?? body.agents.map((a) => a.id),
    expires_at: data.expires_at ?? null,
    ...(Array.isArray(data.stopped) && data.stopped.length ? { stopped: data.stopped } : {}),
  };
}

/** What a host surface (adapter `status`, a health page) needs to render. */
export interface CredentialStatus {
  /** ISO-8601, or `null` for a credential that carries no expiry — the
   *  pre-§4.8 shape. `null` is a finding, not a clean bill of health. */
  expires_at: string | null;
  /** ISO-8601 renewal deadline, or `null` when there is nothing to schedule. */
  renew_at: string | null;
  /** True once the credential's own expiry is in the past. Such a credential
   *  cannot open a connection — but it CAN still be renewed, which is why this
   *  is a state and not a terminal condition. */
  expired: boolean;
  /** Why the last attempt failed, or `null`. */
  last_error: string | null;
}

export interface CredentialRenewerOptions {
  /** Control-plane origin, e.g. `https://api.agentmesh.ai`. */
  apiBase: string;
  /** The credential in hand. */
  jwt: string;
  /** The seed of the key the credential is bound to (from the `.creds` file). */
  nodeSeed: string | Uint8Array;
  /** Every agent the credential covers, with the means of consenting. Pass a
   *  function when the hosted set can change between renewals. */
  agents: RenewalRoster;
  /** Called with the fresh credential after a successful renewal — this is
   *  where a host persists it. An `onRenewed` that throws is reported as a
   *  renewal failure, because a credential that was not written down was not
   *  really renewed. */
  onRenewed?: (c: RenewedCredential) => void | Promise<void>;
  /** Called when an attempt fails. The loop keeps retrying. */
  onWarning?: (w: { code: string; message: string; subject?: string }) => void;
  fetchImpl?: typeof fetch;
}

/**
 * The renewal loop for one node credential.
 *
 * Owned by whoever holds the credential file — `MeshNode` and `AgentMesh` wire
 * one up when handed credential material, and the reference adapter drives one
 * directly. Kept as its own object rather than folded into the client because
 * the most important call is `renewIfExpiring()` **before** connecting, and at
 * that point there is no client yet.
 */
export class CredentialRenewer {
  private jwt: string;
  private claims: CredentialClaims | null;
  private renewAtMs: number | null;
  private lastError: string | null = null;
  private inFlight = false;
  private timer: TimerHandle | null = null;

  constructor(private readonly opts: CredentialRenewerOptions) {
    this.jwt = opts.jwt;
    this.claims = decodeCredentialClaims(opts.jwt);
    this.renewAtMs = credentialRenewAt(this.claims);
  }

  /** The credential currently in hand — the fresh one after a renewal. */
  get credential(): string {
    return this.jwt;
  }

  status(now = Date.now()): CredentialStatus {
    const expMs = this.claims?.exp === null || this.claims === null ? null : this.claims.exp * 1000;
    return {
      expires_at: expMs === null ? null : new Date(expMs).toISOString(),
      renew_at: this.renewAtMs === null ? null : new Date(this.renewAtMs).toISOString(),
      expired: expMs !== null && expMs <= now,
      last_error: this.lastError,
    };
  }

  /**
   * Renew now, regardless of the schedule. Throws on failure.
   *
   * A successful renewal replaces the in-hand credential and resets the
   * deadline. The connection is NOT re-established: an open NATS connection
   * keeps its authorization for as long as it stays open, so the new credential
   * matters at the next connect. That is deliberate — reconnecting a healthy
   * agent to install a credential it does not yet need is the more disruptive
   * choice.
   */
  async renew(): Promise<RenewedCredential> {
    const fresh = await renewNodeCredential(
      this.opts.apiBase,
      this.opts.nodeSeed,
      this.opts.agents,
      this.opts.fetchImpl ?? fetch,
    );
    // Persist BEFORE adopting: if the host cannot write it down, the renewal
    // did not happen as far as the next start is concerned, and pretending
    // otherwise would clear the deadline that gets us retried.
    await this.opts.onRenewed?.(fresh);
    this.jwt = fresh.jwt;
    this.claims = decodeCredentialClaims(fresh.jwt);
    this.renewAtMs = credentialRenewAt(this.claims);
    this.lastError = null;
    return fresh;
  }

  /**
   * Renew if the deadline has passed. Returns true when a renewal happened.
   *
   * Never throws: this runs on a timer with no caller to catch it. A failure
   * leaves the deadline in place so the next tick retries.
   */
  async renewIfDue(now = Date.now()): Promise<boolean> {
    if (this.renewAtMs === null || now < this.renewAtMs || this.inFlight) return false;
    this.inFlight = true;
    try {
      await this.renew();
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.lastError = reason;
      const s = this.status(now);
      this.opts.onWarning?.({
        code: "credential_renewal_failed",
        message:
          `could not renew the node credential for ${this.claims?.sub?.slice(0, 12) ?? "this node"}…: ` +
          `${reason}. It expires ${s.expires_at ?? "at an unknown time"}; after that this node cannot ` +
          `open a connection to the mesh until it renews. Renewal does not need a working connection, ` +
          `so retrying is the right move — and it will keep retrying.`,
        subject: this.claims?.sub ?? undefined,
      });
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * The startup call: renew if the credential is past its deadline **or already
   * expired**, before anything tries to connect with it.
   *
   * This is what makes a lapsed credential self-healing. A host that was
   * powered off through its whole renewal window comes back with a dead
   * credential; `renewIfDue` covers it (an expired credential is by definition
   * past two thirds), and doing it before connect means the operator never sees
   * an authentication error they have to fix by hand.
   */
  async renewIfExpiring(now = Date.now()): Promise<boolean> {
    return this.renewIfDue(now);
  }

  /** Start the periodic check. Idempotent. */
  start(): void {
    this.stop();
    const lifetime =
      this.claims?.exp !== null && this.claims?.exp !== undefined && this.claims.iat !== null
        ? (this.claims.exp - this.claims.iat) * 1000
        : 30 * 24 * 3600_000;
    this.timer = setUnrefInterval(() => void this.renewIfDue(), credentialCheckIntervalMs(lifetime));
  }

  /** Stop the periodic check. Safe to call when not started. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
