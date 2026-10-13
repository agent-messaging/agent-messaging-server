/**
 * One agent, many places (SPEC §4.11).
 *
 * A person has one agent. The app, an assistant's connector and a program on
 * the person's own computer are places that one agent acts from, each under a
 * delegation the agent signed: "this place may act as me, for these things,
 * until this time". Committing acts (an agreement, money, a quote, a deploy,
 * who may act as the agent) are never in a delegation; each one needs an
 * approval the agent key signs after the person proved they are there.
 *
 * This module is the whole of the format: the three tagged signatures
 * (delegation, approval, a place's signed request), the scope rule, the act
 * classification, and the checks a receiver of a DIRECT delegated envelope
 * runs. It is deliberately not wired into the receive path: the reference
 * places speak through the key holder (§4.11 form 1), whose envelopes verify
 * exactly as §5.3 always said, and a receiver opts into the direct form by
 * calling `verifyDelegatedEnvelope`.
 */
import {
  canonicalJSON,
  fromB64Url,
  signTagged,
  signedEnvelopeBytes,
  toB64Url,
  verifyTagged,
  type KeyPair,
} from "./internal/identity.js";
import { nkeys } from "./internal/nkeys.js";
import type { Envelope } from "./types/envelope.js";

/** The domain tag inside a delegation's signed bytes (§4.11). */
export const DELEGATION_SIG_PREFIX = "agentmesh-delegation-v1\n";
/** The domain tag inside an approval's signed bytes (§4.11). */
export const APPROVAL_SIG_PREFIX = "agentmesh-approval-v1\n";
/** The domain tag inside a place's signed request to the key holder (§4.11). */
export const PLACE_REQUEST_SIG_PREFIX = "agentmesh-place-request-v1\n";

export type PlaceKind = "app" | "connector" | "machine";
export type DelegationScope = "read" | "everyday";
export const DELEGATION_SCOPES: readonly DelegationScope[] = ["read", "everyday"];

export interface DelegationPlace {
  id: string;
  /** Present when the place holds a key of its own. */
  key?: string;
  kind: PlaceKind;
  label: string;
}

export interface Delegation {
  id: string;
  agent: string;
  place: DelegationPlace;
  scopes: DelegationScope[];
  always_on?: boolean;
  issued_at: string;
  expires_at: string;
  sig: string;
}

export interface ApprovalAct {
  kind: string;
  /** sha256 hex of the act's canonical request (`actDigest`). */
  digest: string;
  summary: string;
}

export interface Approval {
  agent: string;
  delegation: string;
  act: ApprovalAct;
  method: string;
  approved_at: string;
  expires_at: string;
  sig: string;
}

/** The refusal reasons §4.11 names. */
export type DelegationRefusal =
  | "delegation_invalid"
  | "delegation_expired"
  | "delegation_revoked"
  | "delegation_scope"
  | "approval_required";

// ── committing vs everyday ────────────────────────────────────────────────

/**
 * The acts §4.11 calls committing: they bind the owner beyond the
 * conversation. No delegation covers one; each needs an approval. Kept as
 * words a record can carry, not as offering ids, because the same act has
 * different spellings in different doors.
 */
export const COMMITTING_ACTS: readonly string[] = [
  "form_agreement",
  "amend_agreement",
  "accept_quote",
  "accept_agreement",
  "spend",
  "hold_funds",
  "approve_deploy",
  "approve_install",
  "issue_delegation",
  "rotate_key",
  "revoke_key",
];

/** Acts a `read` scope covers. Everything else a delegation covers needs
 *  `everyday`. */
export const READ_ACTS: readonly string[] = ["read_inbox", "read_room", "read_jobs", "read_records", "discover", "resolve"];

export function isCommittingAct(kind: string): boolean {
  return COMMITTING_ACTS.includes(kind);
}

/** Does this delegation's scope list cover the act? A committing act is never
 *  covered, whatever the list says. */
export function scopeCovers(scopes: readonly string[], act: string): boolean {
  if (isCommittingAct(act)) return false;
  if (scopes.includes("everyday")) return true;
  return scopes.includes("read") && READ_ACTS.includes(act);
}

// ── signing ───────────────────────────────────────────────────────────────

const withoutSig = <T extends { sig?: string }>(o: T): Omit<T, "sig"> => {
  const { sig: _omit, ...rest } = o;
  return rest;
};

/** Sign a delegation with the AGENT's key. `body.agent` must be that key. */
export function signDelegation(body: Omit<Delegation, "sig">, agentKp: KeyPair): Delegation {
  if (agentKp.getPublicKey() !== body.agent) throw new Error("a delegation is signed by the agent it names");
  for (const s of body.scopes) {
    if (!DELEGATION_SCOPES.includes(s)) throw new Error(`a delegation carries only read and everyday, not ${String(s)}`);
  }
  const sig = toB64Url(signTagged(agentKp, DELEGATION_SIG_PREFIX, canonicalJSON(withoutSig(body as Delegation))));
  return { ...body, sig };
}

/** Sign an approval with the AGENT's key. Only after the owner's fresh proof. */
export function signApproval(body: Omit<Approval, "sig">, agentKp: KeyPair): Approval {
  if (agentKp.getPublicKey() !== body.agent) throw new Error("an approval is signed by the agent it names");
  const sig = toB64Url(signTagged(agentKp, APPROVAL_SIG_PREFIX, canonicalJSON(withoutSig(body as Approval))));
  return { ...body, sig };
}

/** What a place signs when it asks the key holder to act (§4.11 form 1). */
export interface PlaceRequest {
  delegation: string;
  ts: string;
  nonce: string;
  act: unknown;
}

export function signPlaceRequest(req: PlaceRequest, placeKp: KeyPair): string {
  return toB64Url(signTagged(placeKp, PLACE_REQUEST_SIG_PREFIX, canonicalJSON(req)));
}

export function verifyPlaceRequest(req: PlaceRequest, placeKey: string, sig: string): boolean {
  let raw: Uint8Array;
  try {
    raw = fromB64Url(sig);
  } catch {
    return false;
  }
  return verifyTagged(placeKey, PLACE_REQUEST_SIG_PREFIX, canonicalJSON(req), raw);
}

/** sha256 hex of an act's canonical JSON: what an approval's `act.digest` names. */
export async function actDigest(act: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJSON(act));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const b of hash) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// ── verifying ─────────────────────────────────────────────────────────────

export type Check = { ok: true } | { ok: false; reason: DelegationRefusal; detail: string };

const refuse = (reason: DelegationRefusal, detail: string): Check => ({ ok: false, reason, detail });

const isNkey = (k: unknown): k is string => {
  if (typeof k !== "string") return false;
  try {
    nkeys.fromPublic(k);
    return true;
  } catch {
    return false;
  }
};

/** A delegation's own checks: shape, the agent's signature, and its window. */
export function verifyDelegation(d: unknown, opts?: { now?: Date; agent?: string }): Check {
  const del = d as Partial<Delegation> | null;
  if (!del || typeof del !== "object") return refuse("delegation_invalid", "no delegation");
  if (typeof del.id !== "string" || !del.id) return refuse("delegation_invalid", "the delegation has no id");
  if (!isNkey(del.agent)) return refuse("delegation_invalid", "the delegation names no agent key");
  if (opts?.agent && del.agent !== opts.agent) return refuse("delegation_invalid", "the delegation is for a different agent");
  const place = del.place as Partial<DelegationPlace> | undefined;
  if (!place || typeof place.id !== "string" || typeof place.label !== "string") {
    return refuse("delegation_invalid", "the delegation names no place");
  }
  if (place.key !== undefined && !isNkey(place.key)) return refuse("delegation_invalid", "the place key is not a key");
  if (!Array.isArray(del.scopes) || del.scopes.some((s) => !DELEGATION_SCOPES.includes(s))) {
    return refuse("delegation_invalid", "the delegation's scopes are not read and everyday");
  }
  if (typeof del.sig !== "string") return refuse("delegation_invalid", "the delegation is not signed");
  let raw: Uint8Array;
  try {
    raw = fromB64Url(del.sig);
  } catch {
    return refuse("delegation_invalid", "the delegation's signature is not base64url");
  }
  if (!verifyTagged(del.agent, DELEGATION_SIG_PREFIX, canonicalJSON(withoutSig(del as Delegation)), raw)) {
    return refuse("delegation_invalid", "the agent's signature on the delegation does not verify");
  }
  const now = (opts?.now ?? new Date()).getTime();
  const from = Date.parse(del.issued_at ?? "");
  const until = Date.parse(del.expires_at ?? "");
  if (!Number.isFinite(from) || !Number.isFinite(until)) return refuse("delegation_invalid", "the delegation has no window");
  if (now < from - 5 * 60_000) return refuse("delegation_invalid", "the delegation is not valid yet");
  if (now >= until) return refuse("delegation_expired", "the delegation has expired");
  return { ok: true };
}

/** An approval's checks against the act it is presented for. */
export async function verifyApproval(
  a: unknown,
  expect: { agent: string; delegation: string; act: unknown; now?: Date },
): Promise<Check> {
  const ap = a as Partial<Approval> | null;
  if (!ap || typeof ap !== "object" || !ap.act || typeof ap.sig !== "string") {
    return refuse("approval_required", "this act commits the owner and carries no approval");
  }
  if (ap.agent !== expect.agent) return refuse("approval_required", "the approval is for a different agent");
  if (ap.delegation !== expect.delegation) return refuse("approval_required", "the approval is for a different place");
  let raw: Uint8Array;
  try {
    raw = fromB64Url(ap.sig);
  } catch {
    return refuse("approval_required", "the approval's signature is not base64url");
  }
  if (!verifyTagged(expect.agent, APPROVAL_SIG_PREFIX, canonicalJSON(withoutSig(ap as Approval)), raw)) {
    return refuse("approval_required", "the agent's signature on the approval does not verify");
  }
  if (ap.act.digest !== (await actDigest(expect.act))) return refuse("approval_required", "the approval is for a different act");
  const now = (expect.now ?? new Date()).getTime();
  if (!(now < Date.parse(ap.expires_at ?? ""))) return refuse("approval_required", "the approval has expired");
  return { ok: true };
}

/**
 * The direct form (§4.11 form 2): an envelope `from` the agent, signed by a
 * place's key, carrying the delegation in `meta.delegation`. The checks run in
 * the order §4.11 gives. `isRevoked` answers for a key (agent or place), and
 * `isDelegationRevoked` for a delegation id; either may be absent, in which
 * case the check is skipped, never assumed passed by a caller that asked.
 */
export async function verifyDelegatedEnvelope(
  env: Envelope,
  opts: {
    act: string;
    /** The act's canonical request, for a committing act's approval digest. */
    request?: unknown;
    now?: Date;
    isRevoked?: (key: string) => boolean | Promise<boolean>;
    isDelegationRevoked?: (id: string) => boolean | Promise<boolean>;
  },
): Promise<Check & { place?: DelegationPlace }> {
  const meta = (env.meta ?? {}) as { delegation?: Delegation; approval?: Approval };
  const del = meta.delegation;
  const own = verifyDelegation(del, { agent: env.from, now: opts.now });
  if (!own.ok) return own;
  const d = del as Delegation;
  if (!d.place.key) return refuse("delegation_invalid", "a place with no key cannot sign for itself");
  let raw: Uint8Array;
  try {
    raw = fromB64Url(env.sig ?? "");
  } catch {
    return refuse("delegation_invalid", "the envelope's signature is not base64url");
  }
  let ok = false;
  try {
    ok = nkeys.fromPublic(d.place.key).verify(signedEnvelopeBytes(env), raw);
  } catch {
    ok = false;
  }
  if (!ok) return refuse("delegation_invalid", "the place's signature on the envelope does not verify");
  if (opts.isRevoked && ((await opts.isRevoked(d.agent)) || (await opts.isRevoked(d.place.key)))) {
    return refuse("delegation_revoked", "the place was signed out");
  }
  if (opts.isDelegationRevoked && (await opts.isDelegationRevoked(d.id))) {
    return refuse("delegation_revoked", "the place was signed out");
  }
  if (isCommittingAct(opts.act)) {
    const ap = await verifyApproval(meta.approval, { agent: d.agent, delegation: d.id, act: opts.request ?? null, now: opts.now });
    if (!ap.ok) return ap;
    return { ok: true, place: d.place };
  }
  if (!scopeCovers(d.scopes, opts.act)) return refuse("delegation_scope", `this place may not ${opts.act.replace(/_/g, " ")}`);
  return { ok: true, place: d.place };
}

/** Sign an envelope as a place (the direct form): `from` stays the agent,
 *  the delegation rides in `meta.delegation`, the place key signs. */
export function signDelegatedEnvelope(env: Envelope, delegation: Delegation, placeKp: KeyPair, approval?: Approval): Envelope {
  if (env.from !== delegation.agent) throw new Error("a delegated envelope is from the agent its delegation names");
  if (delegation.place.key !== placeKp.getPublicKey()) throw new Error("the place signs with the key its delegation names");
  env.meta = { ...(env.meta ?? {}), delegation, ...(approval ? { approval } : {}) };
  env.sig = toB64Url(placeKp.sign(signedEnvelopeBytes(env)));
  return env;
}

/** The `meta.via` a key holder stamps when it signs for a place (form 1). */
export interface Via {
  delegation: string;
  place: string;
  kind: PlaceKind;
}

/** Read `meta.via` off an envelope, or null. Never authority: it is the key
 *  holder's statement of where the agent acted from. */
export function viaOf(env: { meta?: Record<string, unknown> | null } | null | undefined): Via | null {
  const v = env?.meta?.via as Partial<Via> | undefined;
  if (!v || typeof v.place !== "string" || typeof v.delegation !== "string") return null;
  const kind = v.kind === "app" || v.kind === "connector" || v.kind === "machine" ? v.kind : "app";
  return { delegation: v.delegation, place: v.place.slice(0, 80), kind };
}
