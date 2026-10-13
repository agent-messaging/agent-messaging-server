/**
 * Stop signals (SPEC §4.12, step 16 of the bring-your-own-identity plan): a
 * tenant's identity provider tells the mesh, through the Shared Signals
 * Framework, that one of its workloads must stop, and the mesh stops the
 * agent that holds that identity at once.
 *
 *   POST /v1/signals/:tenant      a Security Event Token (RFC 8417) pushed per
 *                                 RFC 8935: content type
 *                                 application/secevent+jwt, answered 202
 *
 * The token is checked against the tenant's own trust records: its `iss` is
 * an OAuth issuer the tenant trusts, its signature verifies with that
 * issuer's published keys, its `aud` names this mesh's receiver
 * (MESH_SIGNALS_AUDIENCE, else the mesh home), and its `jti` has not been
 * seen. The events that stop an agent:
 *
 *   CAEP session-revoked, credential-change
 *   RISC account-disabled, identifier-changed
 *
 * The event's subject names the workload: `{ format: "opaque", id }`,
 * `{ format: "iss_sub", iss, sub }`, or a SPIFFE ID as `{ format: "uri", uri }`.
 * Every agent of the tenant that holds that identity, natively or through a
 * bridge, is paused on the account's authority: a stop record every mint door
 * reads, its status set to paused, and its connections cut as the kill switch
 * cuts them. The kill switch never waits on this; it adds to it. An event of
 * another kind, including one that would re-enable, never lifts a stop.
 */
import { decodeProtectedHeader, createLocalJWKSet, jwtVerify, decodeJwt } from "jose";
import type { AgentStatusEntry } from "../shared/agent-status.js";
import type { CutResult } from "./kill-switch-cut.js";
import { workloadKey, type WorkloadBindingList } from "./identity-records.js";
import { PROOF_ALGORITHMS, ReplayCache } from "./outside-proof.js";
import type { ProofKeySource } from "./proof-keys.js";
import type { StopRecord } from "./stop-record.js";
import { newStopId, type StopList } from "./stop-store.js";
import { oauthTrustFor, type TrustRecord } from "./trust-anchors.js";

export const STOP_EVENTS = new Set([
  "https://schemas.openid.net/secevent/caep/event-type/session-revoked",
  "https://schemas.openid.net/secevent/caep/event-type/credential-change",
  "https://schemas.openid.net/secevent/risc/event-type/account-disabled",
  "https://schemas.openid.net/secevent/risc/event-type/identifier-changed",
]);

/** `via` on a stop a signal placed. */
export const SIGNAL_VIA = "stop-signal";

export interface StopSignalDeps {
  anchors(): Promise<Map<string, TrustRecord[]>>;
  keys: ProofKeySource;
  workloads: WorkloadBindingList | null;
  stops: StopList | null;
  agentStatus: { set(k: string, rec: AgentStatusEntry): Promise<void> } | null;
  cut(keys: string[]): Promise<CutResult & { keys?: string[] }>;
  /** What a SET's `aud` must name. */
  audience: string;
  replay: ReplayCache;
  now?: () => number;
}

export interface SignalAnswer {
  status: number;
  body: Record<string, unknown>;
}

const bad = (err: string, description: string, status = 400): SignalAnswer => ({ status, body: { err, description } });

/** The workload ids an event's subject names. */
function workloadsOf(subject: unknown): string[] {
  if (!subject || typeof subject !== "object") return [];
  const s = subject as Record<string, unknown>;
  const out: string[] = [];
  if (s.format === "opaque" && typeof s.id === "string") out.push(s.id);
  if (s.format === "iss_sub" && typeof s.sub === "string") out.push(s.sub);
  if (s.format === "uri" && typeof s.uri === "string") out.push(s.uri);
  // A complex subject (SSF) names its parts; any part that names a workload counts.
  for (const v of Object.values(s)) if (v && typeof v === "object") out.push(...workloadsOf(v));
  return [...new Set(out)];
}

export function stopSignals(deps: StopSignalDeps) {
  const now = () => (deps.now ?? Date.now)();

  return async function receive(tenant: string, contentType: string | undefined, raw: string): Promise<SignalAnswer> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.=-]{0,127}$/.test(tenant)) return bad("invalid_request", "The address names no tenant.");
    if (contentType && !/^application\/secevent\+jwt\b/i.test(contentType.trim())) return bad("invalid_request", "A stop signal is a Security Event Token, sent as application/secevent+jwt (RFC 8935).");
    const token = raw.trim();
    let header: ReturnType<typeof decodeProtectedHeader>;
    try { header = decodeProtectedHeader(token); } catch { return bad("invalid_request", "The body is not a JWT."); }
    if (typeof header.alg !== "string" || !(PROOF_ALGORITHMS as readonly string[]).includes(header.alg)) return bad("invalid_key", "The token's algorithm is not accepted; none and HMAC never are.");
    if (header.typ !== undefined && String(header.typ).toLowerCase() !== "secevent+jwt") return bad("invalid_request", 'A Security Event Token has typ "secevent+jwt".');
    let claims: Record<string, unknown>;
    try { claims = decodeJwt(token) as Record<string, unknown>; } catch { return bad("invalid_request", "The token's claims cannot be read."); }
    const iss = typeof claims.iss === "string" ? claims.iss : "";
    const all = await deps.anchors();
    const anchor = oauthTrustFor(all, iss).find((m) => m.tenant === tenant)?.anchor;
    if (!anchor) return bad("invalid_issuer", "This tenant trusts no issuer by that name.");
    let verified: Record<string, unknown> | null = null;
    for (const refresh of [false, true]) {
      try {
        const set = await deps.keys.oauthKeys(anchor, refresh);
        const { payload } = await jwtVerify(token, createLocalJWKSet(set as never), {
          issuer: iss, audience: deps.audience, algorithms: [...PROOF_ALGORITHMS], clockTolerance: 300, currentDate: new Date(now()),
        });
        verified = payload as Record<string, unknown>;
        break;
      } catch (err) {
        if (refresh) {
          const m = (err as Error).message;
          if (/"aud"/.test(m)) return bad("invalid_audience", "The token is not addressed to this mesh's receiver.");
          return bad("authentication_failed", "The token's signature does not verify with the issuer's keys.", 400);
        }
      }
    }
    if (!verified) return bad("authentication_failed", "The token could not be checked.");
    const jti = typeof verified.jti === "string" ? verified.jti : "";
    if (!jti) return bad("invalid_request", "A Security Event Token needs a jti.");
    if (!deps.replay.firstUse(`${iss}\n${jti}`, now() + 24 * 3600_000, now())) return { status: 202, body: { accepted: true, duplicate: true } };
    const events = verified.events && typeof verified.events === "object" ? (verified.events as Record<string, unknown>) : {};
    const stopping = Object.entries(events).filter(([type]) => STOP_EVENTS.has(type));
    if (!stopping.length) return { status: 202, body: { accepted: true, stopped: [] } };

    const workloads = new Set<string>();
    for (const [, ev] of stopping) for (const w of workloadsOf((ev as { subject?: unknown })?.subject ?? verified.sub_id)) workloads.add(w);
    const agents = new Set<string>();
    for (const w of workloads) {
      for (const key of [workloadKey("oauth", iss, w), workloadKey("oauth", `bridged:${iss}`, w)]) {
        const b = deps.workloads ? await deps.workloads.get(key).catch(() => null) : null;
        if (b && b.tenant === tenant) agents.add(b.agent);
      }
    }
    const stopped: string[] = [];
    for (const agent of agents) {
      if (!deps.stops) break;
      const at = new Date(now()).toISOString();
      const rec: StopRecord = {
        id: newStopId(),
        scope: "agent",
        target: agent,
        action: "pause",
        by: { authority: "owner", account: tenant },
        why: `stop signal from ${iss}: ${stopping.map(([t]) => t.slice(t.lastIndexOf("/") + 1)).join(", ")}`.slice(0, 500), // cut-ok: a reason sentence, stored whole up to the record's limit
        at,
        count: 1,
        via: SIGNAL_VIA,
      };
      await deps.stops.put(rec);
      await deps.agentStatus?.set(agent, { status: "paused", since: at, stop_id: rec.id, scope: "agent" }).catch(() => undefined);
      const cut = await deps.cut([agent]).catch((err): CutResult & { keys?: string[] } => ({ mode: "none", user_keys: 0, shared: 0, note: `The connections could not be cut: ${(err as Error).message}. Every mint door refuses this agent.` }));
      rec.cut = cut.note;
      if (cut.keys?.length) rec.cut_keys = cut.keys.slice(0, 2000); // cut-ok: the record's bound; the cut itself used every key
      await deps.stops.put(rec).catch(() => undefined);
      stopped.push(agent);
      console.log(`[keychain] stop signal from ${iss}: agent ${agent.slice(0, 12)}… of ${tenant} paused (${cut.note})`);
    }
    return { status: 202, body: { accepted: true, stopped } };
  };
}

export type StopSignalReceiver = ReturnType<typeof stopSignals>;
