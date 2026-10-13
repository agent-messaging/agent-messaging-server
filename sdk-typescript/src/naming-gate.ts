/**
 * The naming rule, on the sending side.
 *
 * Decided by the owner on 2026-09-25: every agent's handle follows one global
 * standard, the agent's name, a dot and its owner's email
 * (`genesis.stephen@example.com`), registered with the naming service, and an
 * agent without one sends nothing, whichever door it uses. The sender is told
 * why before anything leaves, in the words below, with the handle proposed
 * from the name the agent already has. There are no temporary names.
 *
 * The SDK enforces it for an agent that connects with `requireNamed`, which
 * `AgentMesh.connect()` turns on by default since 2026-09-27 (`false` opts out,
 * for tests only): every
 * send this agent originates (`request`, `requestStream`, `emit`,
 * `publishFeed`, `openRoom`, `joinRoom`) checks first and throws `NOT_NAMED`
 * before anything is built or signed. Registering, discovery, service calls
 * and answering a request sent TO the agent are left alone: an agent has to
 * be able to register and be named, and a handler's answer is the embedder's
 * to decide (`namingStatus()` says where the agent stands).
 *
 * The words, the handle shape and the proposals are pinned in
 * conformance/naming-gate.json, which the Rust SDK and the reference adapter
 * are held to as well.
 */

import { nkeys } from "./internal/nkeys.js";
import { canonicalJSON } from "./internal/identity.js";
import { MeshError, ErrorCode } from "./types/errors.js";
import { AM_URL_NAMING } from "./am-env.generated.js";

/** The platform's words (server/src/shared/naming-words.ts NAMING_STANDARD,
 *  then the sentence its refusal says next), so every door says the same. */
export const NAMING_STANDARD_WORDS =
  "AgentMesh uses one global standard for agent names: the agent's name, a dot, and its owner's email. That way no two agents anywhere have the same name. This agent does not have one yet, so nothing was sent.";


/** Whether a handle follows the global standard: a name with no dot, a dot,
 *  then the owner's email. */
export function isStandardHandle(h: unknown): boolean {
  return typeof h === "string" && /^[^\s@.]+\.[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(h);
}

export interface ProposedHandle {
  /** The name part, as the naming service would take it; null when none. */
  name: string | null;
  /** The owner's email, when a usable one was given; null otherwise. */
  email: string | null;
  /** The whole proposal, with a placeholder for a part that is not known. */
  handle: string;
}

/** The handle proposed from the name the agent already has: lower case,
 *  anything the naming service would refuse turned into a dash, and the
 *  owner's email after the dot when it is known. */
export function proposeHandle(name?: string | null, email?: string | null): ProposedHandle {
  const n = String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  const e = typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? email.trim().toLowerCase() : null;
  return { name: n || null, email: e, handle: `${n || "<agent name>"}.${e ?? "<owner's email>"}` };
}

/** The refusal an unnamed agent gets: the owner's words, then the proposed
 *  handle and how to start naming. */
export function notNamedError(opts: { name?: string | null; email?: string | null } = {}): MeshError {
  const p = proposeHandle(opts.name, opts.email);
  const confirm = p.email
    ? `The proposed name is ${p.handle}, and ${p.email} confirms it with a code we email.`
    : `The proposed name is ${p.handle}, and the owner confirms it with a code we email.`;
  const how = `To name it, call startNaming with the owner's email and then completeNaming with the code${p.name ? ` and the name "${p.name}"` : ""}, or run agentmesh join --email-code.`;
  return new MeshError(ErrorCode.NOT_NAMED, `${NAMING_STANDARD_WORDS} ${confirm} ${how}`, {
    retryable: false,
    details: { proposed_handle: p.handle, naming: { sdk: ["startNaming", "verifyNaming", "completeNaming"], cli: "agentmesh join --email-code" } },
  });
}

/** What one look at the naming service found for an agent key. `unnamed` is
 *  the service saying it has no handle for the key (or one not in the
 *  standard shape, carried in `handle`); `unreachable` is no usable answer. */
export interface NameCheck {
  status: "named" | "unnamed" | "unreachable";
  handle?: string | null;
}

/** How a gate asks. Swappable, so an embedder with its own resolver (and the
 *  tests) can answer without the network. */
export type NameLookup = (agentId: string) => Promise<NameCheck>;

/** The naming service's reverse lookup, verified the way SPEC-NAMING §5.3
 *  says: the card's signature checked with a key the registrar publishes at
 *  its own /api/registrar-key, and the card bound to the key asked about. A
 *  404 is "not named"; anything else that is not a verified card is
 *  "unreachable", never "named". */
export function registrarNameLookup(registrar: string, fetchImpl: typeof fetch = fetch): NameLookup {
  const base = registrar.replace(/\/+$/, "");
  let keys: { at: number; list: string[] } | null = null;
  const signingKeys = async (): Promise<string[]> => {
    if (keys && Date.now() - keys.at < 60 * 60 * 1000) return keys.list;
    const r = await fetchImpl(`${base}/api/registrar-key`, { signal: AbortSignal.timeout(5000) });
    const doc: any = r.ok ? await r.json().catch(() => null) : null;
    const list = [
      ...(Array.isArray(doc?.keys) ? doc.keys : []),
      ...(Array.isArray(doc?.key_set) ? doc.key_set.map((k: any) => k?.key) : []),
    ].filter((k: unknown): k is string => typeof k === "string" && k.length > 0);
    if (list.length) keys = { at: Date.now(), list };
    return list;
  };
  return async (agentId: string): Promise<NameCheck> => {
    try {
      const r = await fetchImpl(`${base}/api/resolve?agent_id=${encodeURIComponent(agentId)}`, { signal: AbortSignal.timeout(8000) });
      if (r.status === 404) return { status: "unnamed", handle: null };
      if (!r.ok) return { status: "unreachable" };
      const data: any = await r.json().catch(() => null);
      const card = data?.card;
      if (!card || !data.registrar_sig || !data.registrar_key) return { status: "unreachable" };
      if (!(await signingKeys()).includes(String(data.registrar_key))) return { status: "unreachable" };
      const sig = Uint8Array.from(atob(String(data.registrar_sig)), (c) => c.charCodeAt(0));
      if (!nkeys.fromPublic(String(data.registrar_key)).verify(new TextEncoder().encode(canonicalJSON(card)), sig)) return { status: "unreachable" };
      const bound = (card.endpoints ?? []).some((e: any) => e?.protocol === "agentmesh" && e?.agent_id === agentId);
      if (!bound) return { status: "unreachable" };
      const handle = typeof card.handle === "string" ? card.handle : null;
      return isStandardHandle(handle) ? { status: "named", handle } : { status: "unnamed", handle };
    } catch {
      return { status: "unreachable" };
    }
  };
}

/** How long an answer is kept: a handle does not change while a process
 *  runs; "not named" is kept briefly so an agent named a moment ago sends at
 *  once. Pinned in conformance/naming-gate.json's `cache`. */
export const NAMED_TTL_MS = 30 * 60_000;
export const UNNAMED_TTL_MS = 5_000;

/** Where an agent stands, as the gate last saw it. */
export interface NamingStatus {
  named: boolean;
  handle: string | null;
  /** True when the naming service did not answer: the agent may send (an
   *  outage is not evidence of no name), and `handle` is the one verified
   *  earlier, or null. */
  unchecked?: boolean;
  checkedAt: number;
}

export interface NamingGateOptions {
  agentId: string;
  lookup: NameLookup;
  /** The name the agent already has, for the proposal. */
  name?: string;
  /** The owner's email, for the proposal. */
  ownerEmail?: string;
  /** A handle verified before (kept by the embedder across restarts),
   *  reported while the naming service does not answer. */
  lastVerified?: string;
  now?: () => number;
}

/** What `ConnectOptions.requireNamed` takes when it is more than `true`. */
export interface RequireNamedOptions {
  /** The naming service to ask. Default: the one the connection implies
   *  (AGENTMESH_NAMING_URL, or naming.<domain> for a broker at mesh.<domain>). */
  registrar?: string;
  /** Ask some other way (an embedder's own resolver, a test). Wins over
   *  `registrar`. */
  lookup?: NameLookup;
  /** The name the agent already has, for the proposed handle. */
  name?: string;
  /** The owner's email, for the proposed handle. */
  ownerEmail?: string;
  /** A handle verified in an earlier run, reported while the naming service
   *  does not answer. */
  lastVerified?: string;
}

/** Build the gate an agent's `requireNamed` option asks for. */
export function namingGateFor(
  agentId: string,
  opt: boolean | RequireNamedOptions | undefined,
  /** The naming service the connection implies, used when `opt` names none. */
  registrar?: string,
): NamingGate | null {
  if (!opt) return null;
  const o: RequireNamedOptions = opt === true ? {} : opt;
  const where = o.registrar ?? registrar ?? AM_URL_NAMING;
  if (!o.lookup && !where) {
    throw new MeshError(
      ErrorCode.INPUT_INVALID,
      "requireNamed needs the naming service's address: pass requireNamed: { registrar }, or set AGENTMESH_NAMING_URL. " +
        "A mesh that offers no naming service is used without it: leave requireNamed out.",
      { retryable: false },
    );
  }
  return new NamingGate({
    agentId,
    lookup: o.lookup ?? registrarNameLookup(where!),
    name: o.name,
    ownerEmail: o.ownerEmail,
    lastVerified: o.lastVerified,
  });
}

/** The one check every send runs, with its cache. */
export class NamingGate {
  private readonly opts: NamingGateOptions;
  private status: NamingStatus | null = null;
  private lastVerified: string | null;
  private inFlight: Promise<NamingStatus> | null = null;

  constructor(opts: NamingGateOptions) {
    this.opts = opts;
    this.lastVerified = isStandardHandle(opts.lastVerified) ? (opts.lastVerified as string) : null;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** The last answer, without asking again. Null before the first check. */
  current(): NamingStatus | null {
    return this.status;
  }

  /** Ask (or use the cached answer while it is fresh). */
  private fresh(s: NamingStatus): boolean {
    return this.now() - s.checkedAt < (s.named && !s.unchecked ? NAMED_TTL_MS : UNNAMED_TTL_MS);
  }

  async check(): Promise<NamingStatus> {
    const s = this.status;
    if (s && this.fresh(s)) return s;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const c = await this.opts.lookup(this.opts.agentId).catch((): NameCheck => ({ status: "unreachable" }));
      const at = this.now();
      let next: NamingStatus;
      if (c.status === "named" && isStandardHandle(c.handle)) {
        this.lastVerified = c.handle as string;
        next = { named: true, handle: c.handle as string, checkedAt: at };
      } else if (c.status === "unreachable") {
        // An outage is not evidence of no name: the send goes through, as the
        // platform's guard lets it, and the question is asked again soon.
        next = { named: true, handle: this.lastVerified, unchecked: true, checkedAt: at };
      } else {
        next = { named: false, handle: c.handle ?? null, checkedAt: at };
      }
      this.status = next;
      return next;
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** Forget the cached answer, so the next send asks again (after naming). */
  forget(): void {
    this.status = null;
  }

  private refusal(): MeshError {
    return notNamedError({ name: this.opts.name, email: this.opts.ownerEmail });
  }

  /** Throws NOT_NAMED unless this agent may send. */
  async require(): Promise<void> {
    const s = await this.check();
    if (!s.named) throw this.refusal();
  }

  /** The same, for a send that cannot wait: judged on the last answer, with a
   *  fresh one asked for in the background when it has gone stale. With no
   *  answer yet it is treated like an unanswered naming service: the send
   *  goes through. connect() asks before it returns, so this is rare. */
  requireCached(): void {
    const s = this.status;
    if (!s || !this.fresh(s)) void this.check();
    if (s && !s.named) throw this.refusal();
  }
}
