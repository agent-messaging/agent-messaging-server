/**
 * Diagnostics — reusable probes for the mesh itself (AGENTMESH_DIAGNOSTICS.md).
 *
 * Library-first: this class is the contract. The mesh-adapter's `/diag/*`
 * session API and its `mesh-adapter diag` CLI are thin frontends over it, and
 * consumers (AgentMeetup's harness, ops scripts) bind to the RESULT SHAPES
 * here, never to probe internals.
 *
 * Latency is measured as data, not log archaeology: the adapter daemon
 * answers `__diag_echo__` itself (no attendant, no model, no tokens), and an
 * inbox-mode adapter stamps `meta.timing = { received_at, fetched_at,
 * replied_at }` on every reply — so one round trip decomposes into transit,
 * attendant poll lag, the agent's think time, and return.
 *
 * Clock-skew note: intervals stamped on the same machine (poll_lag, think)
 * are skew-free; cross-machine intervals (transit, return) inherit host clock
 * skew — when that matters, use `total - (poll_lag + think)` for their sum.
 */
import { nkeys } from "./internal/nkeys.js";
import { AgentMesh } from "./mesh.js";
import { Room, RoomsServiceSubjects } from "./rooms.js";
import { canonicalJSON, fromB64Url } from "./internal/identity.js";
import { ErrorCode, MeshError } from "./types/errors.js";
import { AM_URL_NAMING } from "./am-env.generated.js";

/** The offering an adapter daemon answers instantly, without waking the agent itself. */
export const DIAG_ECHO_OFFERING = "__diag_echo__";
/** Operator-scoped introspection: "what did your daemon do with message X?"
 *  Answered by the daemon (never the agent's model), and ONLY to a requester whose
 *  signed envelope resolves to the same operator as the target agent. */
export const DIAG_TRACE_OFFERING = "__diag_trace__";

const DEFAULT_REGISTRAR = AM_URL_NAMING;
const AGENT_ID_RE = /^U[A-Z2-7]{55}$/;

/** Domains found not to serve PAN WebFinger, remembered for an hour so that
 *  resolving many handles under gmail.com/etc. probes the domain at most once
 *  an hour — long-lived hosts must eventually notice a domain that starts
 *  serving it, which a process-lifetime cache never did. */
const NO_WEBFINGER_TTL_MS = 60 * 60 * 1000;
const noWebFingerDomains = new Map<string, number>();
function rememberNoWebFinger(domain: string): void {
  if (noWebFingerDomains.size > 5000) noWebFingerDomains.clear();
  noWebFingerDomains.set(domain, Date.now());
}
function recentlyNoWebFinger(domain: string): boolean {
  const at = noWebFingerDomains.get(domain);
  return at != null && Date.now() - at < NO_WEBFINGER_TTL_MS;
}

/**
 * Parse a hostname that is an IP LITERAL into its bytes, or null when the
 * hostname is a name rather than an address.
 *
 * Written by hand rather than reached for from `node:net`: this module ships
 * inside the browser bundle (one tsup entry, no platform split), so a static
 * Node builtin import would break every browser consumer — the same reason
 * `internal/trace-ambient.ts` goes out of its way to load `node:async_hooks`
 * through a non-literal specifier.
 *
 * The WHATWG URL parser already canonicalizes the octal/hex/decimal-shorthand
 * IPv4 forms (`0177.0.0.1`, `2130706433`, `0x7f.1` all serialize as
 * `127.0.0.1`) and compresses IPv6 — but it happily preserves the shapes that
 * carry an address INSIDE another family (`[::ffff:127.0.0.1]`), and a string
 * comparison against `127.` never sees those. Working in bytes does.
 */
function parseIpLiteral(host: string): { v4?: number[]; v6?: number[] } | null {
  // IPv4 dotted quad (post-URL-normalization it is the only IPv4 form left).
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const bytes = v4.slice(1, 5).map(Number);
    return bytes.every((b) => b <= 255) ? { v4: bytes } : null;
  }
  if (!host.includes(":")) return null; // a name, not an address
  // IPv6, with an optional trailing embedded IPv4 and at most one `::`.
  let text = host;
  let tail: number[] = [];
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (embedded) {
    const inner = parseIpLiteral(embedded[1]!);
    if (!inner?.v4) return null;
    tail = inner.v4;
    text = text.slice(0, embedded.index).replace(/:$/, "") || "::";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      const n = parseInt(g, 16);
      out.push((n >> 8) & 0xff, n & 0xff);
    }
    return out;
  };
  const head = groups(halves[0] ?? "");
  const rest = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (head === null || rest === null) return null;
  const known = head.length + rest.length + tail.length;
  if (known > 16) return null;
  if (halves.length === 1) {
    return known === 16 ? { v6: [...head, ...tail] } : null;
  }
  return { v6: [...head, ...new Array(16 - known).fill(0), ...rest, ...tail] };
}

/** Whether an IP literal is a globally routable unicast address. Everything
 *  else — this-network, loopback, private, CGNAT, link-local, documentation,
 *  multicast, broadcast, reserved, and every IPv6 shape that wraps an IPv4
 *  address — is refused. An allow-list, because the deny-lists are the thing
 *  that keeps growing a bypass. */
function isGlobalUnicast(ip: { v4?: number[]; v6?: number[] }): boolean {
  if (ip.v4) {
    const [a, b] = ip.v4 as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false; // 192.0.0/24 + TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51) return false; // TEST-NET-2
    if (a === 203 && b === 0) return false; // TEST-NET-3
    if (a >= 224) return false; // multicast, reserved, broadcast
    return true;
  }
  const v6 = ip.v6!;
  const first = v6[0]!;
  const second = v6[1]!;
  // Only 2000::/3 is global unicast at all…
  if ((first & 0xe0) !== 0x20) return false;
  // …minus the ranges inside it that tunnel or document an IPv4 address.
  if (first === 0x20 && second === 0x01 && v6[2] === 0 && v6[3] === 0) return false; // Teredo
  if (first === 0x20 && second === 0x02) return false; // 6to4
  if (first === 0x20 && second === 0x01 && v6[2] === 0x0d && v6[3] === 0xb8) return false; // doc
  return true;
}

/** Guard for a URL we follow only because a third party named it (the card
 *  link inside an anchor domain's WebFinger document, a §5.6 referral). http(s)
 *  only; a hostname must be either a globally routable IP literal or a real
 *  multi-label name — a hostile anchor domain must not be able to point a
 *  resolver at something inside the caller's network. Not DNS-rebinding proof;
 *  it closes the literal-address cases. Loopback is allowed only when the
 *  caller explicitly supplied an anchor base (the conformance seam), where a
 *  local server IS the anchor domain. */
function safeOutboundUrl(raw: string, allowLoopback = false): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  // A trailing dot is the same name to DNS but a different string to
  // `endsWith`, so normalize it away before any suffix test.
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return null;
  const ip = parseIpLiteral(h);
  if (ip) {
    const loopback =
      (ip.v4 !== undefined && ip.v4[0] === 127) ||
      (ip.v6 !== undefined && ip.v6.every((b, i) => b === (i === 15 ? 1 : 0)));
    if (loopback) return allowLoopback ? u : null;
    return isGlobalUnicast(ip) ? u : null;
  }
  const loopbackName = h === "localhost" || h.endsWith(".localhost");
  if (loopbackName) return allowLoopback ? u : null;
  // A single-label host resolves through the caller's search domains — it names
  // something on the local network by definition, never a registrar.
  if (!h.includes(".")) return allowLoopback ? u : null;
  if (
    h === "metadata.google.internal" ||
    h.endsWith(".internal") ||
    h.endsWith(".local")
  ) return null;
  return u;
}

const MAX_DOC_BYTES = 256 * 1024;

// ── registrar signing keys and pins (SPEC-NAMING §5.3) ──────────────────────
// §5.3 puts the signing key out of band on purpose: "so a verifier need not
// bootstrap trust from the same response it is verifying." Verifying
// `registrar_sig` with the `registrar_key` sitting beside it in the same
// document proves only that the document is internally consistent — a card
// forged with a freshly generated key passes, which is precisely how a §5.6
// referral to a hostile origin could return a card binding someone else's
// handle to the attacker's id and have `resolve()` report `resolved: true`.
//
// So the key comes from `<origin>/api/registrar-key`, and §5.3's two REQUIRED
// pins are kept: `handle → agent key` and, per origin, the registrar's signing
// key. Both are in-process and bounded — persistent pin state belongs to the
// embedder (the adapter persists them), but a resolver that pins nothing at all
// cannot notice the one event §5.3 says it must not miss.

const REGISTRAR_KEY_TTL_MS = 60 * 60 * 1000;
const registrarKeyDocs = new Map<string, { keys: string[]; at: number }>();
const registrarKeyPins = new Map<string, string>();
const handleKeyPins = new Map<string, string>();

/** The keys an origin publishes for card signing. Empty means "cannot verify",
 *  never "any key will do" — the registrar answers with an empty set both when
 *  it has no signing key and when signing is switched off. Only non-empty
 *  answers are cached, so a transient failure does not lock resolution out for
 *  the TTL.
 *
 *  `followRedirects` is true only for the operator's own configured registrar.
 *  For an origin a third party named (a §5.6 referral), a redirect would let
 *  that party bounce this fetch past safeOutboundUrl and back at something
 *  internal — the same reasoning as the anchor domain's card link. */
async function registrarSigningKeys(origin: string, followRedirects: boolean): Promise<string[]> {
  const hit = registrarKeyDocs.get(origin);
  if (hit && Date.now() - hit.at < REGISTRAR_KEY_TTL_MS) return hit.keys;
  const doc: any = await fetchJsonBounded(`${origin}/api/registrar-key`, 5000, followRedirects);
  // `keys` is the plain array of strings, current key first; `key_set` carries
  // the same keys with ids and status for rotation. Either shape is accepted so
  // a resolver keeps working across a registrar upgrade.
  const fromKeys = Array.isArray(doc?.keys) ? doc.keys : [];
  const fromSet = Array.isArray(doc?.key_set) ? doc.key_set.map((k: any) => k?.key) : [];
  const keys = [...fromKeys, ...fromSet].filter(
    (k: unknown): k is string => typeof k === "string" && k.length > 0,
  );
  if (keys.length > 0) {
    if (registrarKeyDocs.size > 500) registrarKeyDocs.clear();
    registrarKeyDocs.set(origin, { keys, at: Date.now() });
  }
  return keys;
}

function pin(store: Map<string, string>, key: string, value: string): string | null {
  const was = store.get(key);
  if (store.size > 5000) store.clear();
  store.set(key, value);
  return was !== undefined && was !== value ? was : null;
}

/** How many §5.6 referrals to follow. A handle that has moved twice is
 *  ordinary; a longer chain is a misconfiguration or a loop, and the honest
 *  answer is "unresolvable" rather than an unbounded walk. */
const MAX_REFERRAL_HOPS = 3;

const originOf = (url: string): string => {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};

const isLoopbackUrl = (url: string): boolean => /^https?:\/\/(localhost|127\.|\[::1\])/i.test(url);

/** Fetch JSON with a bounded time and a bounded size.
 *
 *  `followRedirects` is false for anything a third party named (an anchor
 *  domain's card link): following one would let a public host bounce the
 *  request past safeOutboundUrl and back at something internal. It is true for
 *  the registrar, which is a URL the operator configured — refusing redirects
 *  there would break the ordinary http→https hop for no security gain. */
/** A renamed handle's 404 (SPEC-NAMING §5.8): its `moved_to` and the words,
 *  or null for any other answer. Bounded like everything else read here. */
async function movedAnswer(url: string): Promise<{ to: string; says: string } | null> {
  try {
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
    if (res.status !== 404) return null;
    const text = await res.text();
    if (text.length > 16_384) return null;
    const body = JSON.parse(text);
    if (typeof body?.moved_to !== "string" || !body.moved_to) return null;
    const says = typeof body.error === "string" && body.error ? body.error : `renamed to ${body.moved_to}`;
    return { to: body.moved_to, says };
  } catch {
    return null;
  }
}

async function fetchJsonBounded(url: string, timeoutMs = 2500, followRedirects = false): Promise<any> {
  try {
    const res = await fetch(url, {
      redirect: followRedirects ? "follow" : "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    // Content-Length is the server's claim, and a hostile one simply omits it.
    // Reading the body with a RUNNING cap is what actually bounds memory: the
    // old `await res.arrayBuffer()` had already buffered the whole response
    // before the size was ever compared, so an endless body was an endless
    // allocation no matter what the check said afterwards.
    if (Number(res.headers.get("content-length") ?? 0) > MAX_DOC_BYTES) return null;
    const reader = res.body?.getReader?.();
    if (!reader) {
      const buf = new Uint8Array(await res.arrayBuffer());
      return buf.byteLength > MAX_DOC_BYTES ? null : JSON.parse(new TextDecoder().decode(buf));
    }
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_DOC_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
    const buf = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      buf.set(p, at);
      at += p.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

/** SPEC-NAMING §5.5/§5.2 — resolution authority flows from the name's owner:
 *  the anchor domain, where it serves WebFinger for the anchor, outranks any
 *  registrar. Probe the anchor domain's `/.well-known/webfinger`; if it names
 *  a PAN card, that card is authoritative. Anything else (no WebFinger, no card
 *  link, timeout) falls through to the registrar of record. Kept cheap: a short
 *  timeout and a per-domain negative cache, so gmail-style anchors cost one
 *  probe an hour.
 *
 *  `anchorBase` stands in as the anchor domain's well-known host. It is a
 *  constructor option, never an ambient env var: whatever answers this probe
 *  decides which key a name resolves to, and an env var made that a lever
 *  anything in the process environment could pull. */
async function anchorDomainCardUrl(handle: string, anchorBase?: string): Promise<string | null> {
  const at = handle.lastIndexOf("@");
  if (at < 0) return null;
  const domain = handle.slice(at + 1).toLowerCase();
  if (!domain || recentlyNoWebFinger(domain)) return null;
  const probe = safeOutboundUrl(
    `${anchorBase ?? `https://${domain}`}/.well-known/webfinger?resource=${encodeURIComponent("acct:" + handle)}`,
    !!anchorBase,
  );
  if (!probe) {
    if (!anchorBase) rememberNoWebFinger(domain);
    return null;
  }
  const jrd: any = await fetchJsonBounded(probe.href);
  const link = (jrd?.links ?? []).find((l: any) => l?.rel === "urn:pan:card" && l?.href);
  if (!link) {
    if (!anchorBase) rememberNoWebFinger(domain);
    return null;
  }
  const card = safeOutboundUrl(String(link.href), !!anchorBase);
  if (!card) {
    if (!anchorBase) rememberNoWebFinger(domain);
    return null;
  }
  return card.href;
}

// ── result shapes (the cross-project contract) ──────────────────────────────

export interface DiagStep {
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface PingTiming {
  /** send -> remote daemon received (cross-machine: skew-prone). */
  transit_ms: number;
  /** daemon received -> attendant fetched (turn mode only; skew-free). */
  poll_lag_ms?: number;
  /** attendant fetched -> reply posted: the agent's THINK TIME — how long
   *  its model/CLI took to produce the answer (turn mode only; skew-free). */
  think_ms?: number;
  /** reply posted -> received here (cross-machine: skew-prone). */
  return_ms: number;
}

export interface PingResult {
  handle: string;
  agentId: string | null;
  ok: boolean;
  mode: "echo" | "turn";
  /** Total round trip, measured on this side's clock alone. */
  ms: number;
  /** Present when the remote adapter stamps timing (0.26+). */
  timing?: PingTiming;
  /** Remote adapter's self-reported version, when the echo carries it. */
  remoteVersion?: string;
  error?: string;
}

export interface ResolveResult {
  handle: string;
  resolved: boolean;
  ms: number;
  /** Which registrar answered — surfaces stale-domain bugs. */
  registrar: string;
  agentId?: string;
  /** e.g. "agent-key", "agent-key-delegated:<partner>". */
  binding?: string;
  /** Who answered the resolution (§5.5): the anchor domain, or the registrar. */
  authority?: "anchor-domain" | "registrar";
  /** A pin changed (SPEC-NAMING §5.3): this handle now resolves to a different
   *  agent key than the one seen before, or the authority signs with a
   *  different key. Legitimate on re-pairing or key rotation, and exactly the
   *  signal that matters if a registrar is compromised or coerced — the remedy
   *  is out-of-band re-verification with the owner, not silent acceptance. The
   *  result still carries `resolved: true`: §5.3 makes a pin change a warning,
   *  where an absent or bad signature is a discard. */
  warning?: string;
  /** A renamed agent's old handle, in its window (SPEC-NAMING §5.8): it still
   *  resolves, and this says the new handle and the day the old one stops. */
  notice?: string;
  renamedTo?: string;
  /** A renamed agent's old handle after its window: where the agent went.
   *  `resolved` is false and `error` says so in words. */
  movedTo?: string;
  error?: string;
}

export interface RoomCheckResult {
  grade: "capability" | "acl" | "sealed";
  roomId?: string;
  steps: {
    open: DiagStep;
    invite: DiagStep;
    join: DiagStep;
    presence: DiagStep;
    teardown: DiagStep;
  };
}

/** One inbox entry as the TARGET's daemon reports it (its own clock). */
export interface TraceEntry {
  id: string;
  kind: string;
  room?: string;
  status: string;         // pending | held | acked | replied | expired
  received_at: string;
  fetched_at: string | null;
  replied_at: string | null;
  in_reply_to: string | null;
  from: string;
  text_head: string;
}

export interface TraceResult {
  handle: string;
  agentId: string | null;
  ok: boolean;
  /** false when the target refused (different operator, unsigned, old adapter). */
  authorized: boolean;
  found: boolean;
  entry?: TraceEntry;     // id query
  entries?: TraceEntry[]; // room query
  error?: string;
}

export interface RoomsStatusResult {
  /** Always the CALLER's operator; cross-operator queries are ops-tool only. */
  operator: string;
  rooms: number;
  cap: number;
  overCap: boolean;
  list: { name: string | null; roomId: string; ageSec: number }[];
}

export interface DiagnosticsOptions {
  registrar?: string;
  /**
   * Turn pings to an inbox-mode agent get only a "queued" ack synchronously;
   * the real reply arrives later as a fresh request to THIS agent. An
   * embedder that owns the inbox (the adapter daemon) supplies this hook:
   * given the outbound request's envelope id, resolve with the reply entry
   * (`{ text?, timing? }`) when it lands, or null on timeout. Without the
   * hook, a queued turn ping reports the ack only.
   */
  awaitAsyncReply?: (
    requestEnvelopeId: string,
    timeoutMs: number,
  ) => Promise<{ text?: string; timing?: Record<string, unknown> } | null>;
  /**
   * Testing seam (SPEC-NAMING §5.5): treat this base URL as the anchor
   * domain's well-known host instead of `https://<domain>`. Lets a conformance
   * suite stand in as the anchor domain without owning one. Explicit on
   * purpose — whatever answers the anchor probe outranks the registrar and so
   * decides which key a name resolves to, which is not a decision any ambient
   * environment variable should be able to make. Leave unset in normal use.
   */
  anchorWebFingerBase?: string;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const msBetween = (fromIso: unknown, toIso: unknown): number | null => {
  if (typeof fromIso !== "string" || typeof toIso !== "string") return null;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return b - a;
};

/** Build a PingTiming from remote stamps; null when the stamps are absent. */
function timingFrom(
  sentAtIso: string,
  doneAtIso: string,
  stamps: { received_at?: unknown; fetched_at?: unknown; replied_at?: unknown } | undefined,
): PingTiming | undefined {
  if (!stamps) return undefined;
  const transit = msBetween(sentAtIso, stamps.received_at);
  const ret = msBetween(stamps.replied_at, doneAtIso);
  if (transit === null || ret === null) return undefined;
  const poll = msBetween(stamps.received_at, stamps.fetched_at);
  const think = msBetween(stamps.fetched_at, stamps.replied_at);
  return {
    transit_ms: transit,
    ...(poll !== null ? { poll_lag_ms: poll } : {}),
    ...(think !== null ? { think_ms: think } : {}),
    return_ms: ret,
  };
}

// ── the library ─────────────────────────────────────────────────────────────

export class Diagnostics {
  private mesh: AgentMesh;
  private registrar: string;
  private awaitAsyncReply?: DiagnosticsOptions["awaitAsyncReply"];
  private anchorWebFingerBase?: string;

  constructor(mesh: AgentMesh, opts: DiagnosticsOptions = {}) {
    this.mesh = mesh;
    this.registrar = opts.registrar ?? DEFAULT_REGISTRAR;
    this.awaitAsyncReply = opts.awaitAsyncReply;
    this.anchorWebFingerBase = opts.anchorWebFingerBase;
  }

  /** Resolve a handle (or reverse-resolve an agent id), verifying the card
   *  against the authority's out-of-band signing key (SPEC-NAMING §5.3
   *  MUST-sign), checking that the card answers the question asked, and pinning
   *  `handle → agent key` and `origin → signing key` for the process. Pin
   *  changes surface in `warning`; persistent pin state across restarts is
   *  still the embedder's concern (the adapter persists it). */
  async resolve(target: string): Promise<ResolveResult> {
    const t0 = Date.now();
    const base: ResolveResult = {
      handle: target,
      resolved: false,
      ms: 0,
      registrar: this.registrar,
    };
    try {
      // §5.5 authority chain: for a handle (not a bare agent id), the anchor
      // domain outranks the registrar. Try the domain's WebFinger first; only
      // if it does not answer with a card do we ask the registrar of record.
      let resolveUrl: string;
      let authority: "anchor-domain" | "registrar" = "registrar";
      const domainCardUrl = AGENT_ID_RE.test(target)
        ? null
        : await anchorDomainCardUrl(target, this.anchorWebFingerBase);
      if (domainCardUrl) {
        resolveUrl = domainCardUrl;
        authority = "anchor-domain";
      } else {
        const q = AGENT_ID_RE.test(target)
          ? `agent_id=${encodeURIComponent(target)}`
          : `handle=${encodeURIComponent(target)}`;
        resolveUrl = `${this.registrar}/api/resolve?${q}`;
      }
      // Bounded on both branches: an anchor domain that accepts the connection
      // and then stalls must not hang resolution (and with it every ping that
      // resolves first) forever.
      const anchorServed = authority === "anchor-domain";
      let data: any = await fetchJsonBounded(resolveUrl, anchorServed ? 5000 : 8000, !anchorServed);

      // §5.6 referrals: a registrar that no longer holds the handle answers
      // with where it went, not with a card. Follow, bounded and loop-aware.
      // Without this a re-homed handle is simply unresolvable, which makes the
      // move look like a disappearance to everyone except the two registrars.
      if (!anchorServed) {
        const seen = new Set<string>([originOf(this.registrar)]);
        for (let hop = 0; data?.referral?.registrar && hop <= MAX_REFERRAL_HOPS; hop++) {
          const next = safeOutboundUrl(String(data.referral.registrar), isLoopbackUrl(this.registrar));
          if (!next) return { ...base, error: "referred to an address we will not follow" };
          const origin = next.origin.toLowerCase();
          if (seen.has(origin)) return { ...base, error: "referral loop" };
          seen.add(origin);
          if (hop === MAX_REFERRAL_HOPS) return { ...base, error: `referred more than ${MAX_REFERRAL_HOPS} times` };
          base.registrar = next.origin;
          // No redirects on a hop: the origin was named by the PREVIOUS
          // registrar, not by the operator, so a redirect here is that party
          // steering the fetch past safeOutboundUrl. A registrar that expects
          // to be referred to must serve its API at the URL it publishes.
          data = await fetchJsonBounded(
            `${next.origin}/api/resolve?${AGENT_ID_RE.test(target) ? `agent_id=${encodeURIComponent(target)}` : `handle=${encodeURIComponent(target)}`}`,
            8000,
            false,
          );
        }
      }

      base.ms = Date.now() - t0;
      base.authority = authority;
      if (!data && !anchorServed && !AGENT_ID_RE.test(target)) {
        // §5.8: a renamed agent's old handle past its window answers 404 with
        // where the agent went. The bounded read takes no 404, so ask once more
        // for that answer alone.
        const moved = await movedAnswer(`${base.registrar}/api/resolve?handle=${encodeURIComponent(target)}`);
        if (moved) return { ...base, movedTo: moved.to, error: moved.says };
      }
      if (!data) return { ...base, error: "no answer from the resolution authority" };
      const card = data?.card;
      if (!card) return { ...base, error: "no card in response" };
      if (!data.registrar_sig || !data.registrar_key)
        return { ...base, error: "card is unsigned (SPEC-NAMING §5.3)" };

      // §5.3: the key must come from the authority's own out-of-band endpoint,
      // not from the document being verified. `base.registrar` already tracks
      // referral hops, so this is the origin that actually served the card.
      const authorityOrigin = originOf(anchorServed ? resolveUrl : base.registrar);
      const published = await registrarSigningKeys(
        authorityOrigin,
        authorityOrigin === originOf(this.registrar),
      );
      if (published.length === 0)
        return {
          ...base,
          error: `${authorityOrigin} publishes no card-signing key at /api/registrar-key, so its cards cannot be verified (SPEC-NAMING §5.3)`,
        };
      if (!published.includes(String(data.registrar_key)))
        return {
          ...base,
          error: "card was signed with a key this authority does not publish (SPEC-NAMING §5.3)",
        };

      try {
        const ok = nkeys
          .fromPublic(data.registrar_key)
          .verify(
            new TextEncoder().encode(canonicalJSON(card)),
            // The registrar emits STANDARD base64 with padding; normalize to
            // base64url before decoding.
            fromB64Url(String(data.registrar_sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")),
          );
        if (!ok) return { ...base, error: "card signature invalid" };
      } catch {
        return { ...base, error: "card signature unverifiable" };
      }

      // A signature proves the registrar said this; it does not prove the
      // registrar answered the question ASKED. Nothing tied the card to the
      // query, so a signed card for one handle satisfied a lookup of another —
      // substitution with a genuine signature. Resolution is case-folded
      // whole-handle (§5.2), so compare that way.
      const reverse = AGENT_ID_RE.test(target);
      const ep = (card.endpoints ?? []).find((e: any) => e.protocol === "agentmesh");
      if (!reverse) {
        const got = typeof card.handle === "string" ? card.handle.toLowerCase() : "";
        if (got !== target.toLowerCase())
          return {
            ...base,
            error: `card is for ${card.handle ?? "(no handle)"}, not for the handle queried`,
          };
      } else if (ep?.agent_id !== target) {
        return { ...base, error: "card does not bind the agent id queried" };
      }

      // §5.3 pins, and §5.6's rule about them: alarm on a change of KEY, never
      // on a change of registrar alone — re-homing moves custodians, not keys.
      const warnings: string[] = [];
      const keyWas = pin(registrarKeyPins, authorityOrigin, String(data.registrar_key));
      if (keyWas)
        warnings.push(
          `${authorityOrigin} now signs cards with ${data.registrar_key} (was ${keyWas})`,
        );
      const handleKey = typeof card.handle === "string" ? card.handle.toLowerCase() : null;
      if (handleKey && typeof ep?.agent_id === "string") {
        const idWas = pin(handleKeyPins, handleKey, ep.agent_id);
        if (idWas)
          warnings.push(
            `${handleKey} now resolves to ${ep.agent_id} (was ${idWas}) — legitimate on ` +
              `re-pairing; otherwise re-verify with the owner out of band (SPEC-NAMING §5.3)`,
          );
      }

      return {
        ...base,
        handle: card.handle ?? target,
        resolved: true,
        agentId: ep?.agent_id,
        binding: card.binding ?? undefined,
        ...(warnings.length ? { warning: warnings.join("; ") } : {}),
        ...(typeof data.notice?.says === "string" && data.notice.says
          ? { notice: data.notice.says, ...(typeof data.notice.renamed_to === "string" ? { renamedTo: data.notice.renamed_to } : {}) }
          : {}),
        ...(ep ? {} : { error: "card has no agentmesh endpoint" }),
      };
    } catch (e: any) {
      base.ms = Date.now() - t0;
      return { ...base, error: e?.message ?? String(e) };
    }
  }

  /**
   * Ping an agent. Echo mode (default) is answered by the remote DAEMON —
   * milliseconds, no model, no tokens: proves resolution + transport + daemon
   * liveness. `turn: true` sends a real message through the attendant and the
   * agent itself (its model answers) and
   * model; for inbox-mode targets the reply is asynchronous and needs the
   * embedder's awaitAsyncReply hook (see DiagnosticsOptions).
   */
  async ping(
    target: string,
    opts: { turn?: boolean; offering?: string; timeoutMs?: number } = {},
  ): Promise<PingResult> {
    const mode: "echo" | "turn" = opts.turn ? "turn" : "echo";
    const timeoutMs = opts.timeoutMs ?? (opts.turn ? 300_000 : 15_000);
    const base: PingResult = { handle: target, agentId: null, ok: false, mode, ms: 0 };

    let agentId = target;
    if (!AGENT_ID_RE.test(target)) {
      const r = await this.resolve(target);
      if (!r.resolved || !r.agentId)
        return { ...base, ms: r.ms, error: r.error ?? `could not resolve ${target}` };
      agentId = r.agentId;
    }
    base.agentId = agentId;

    const t0 = Date.now();
    const sentAt = new Date(t0).toISOString();
    try {
      if (mode === "echo") {
        const result = await this.mesh.request(
          agentId,
          DIAG_ECHO_OFFERING,
          { sent_at: sentAt },
          { timeout_ms: timeoutMs },
        );
        const doneAt = new Date().toISOString();
        const p: any = result.payload?.output ?? result.payload ?? {};
        return {
          ...base,
          ok: p?.echo === true,
          ms: Date.now() - t0,
          timing: timingFrom(sentAt, doneAt, p),
          remoteVersion: typeof p?.version === "string" ? p.version : undefined,
          ...(p?.echo === true ? {} : { error: "no echo in response (older adapter?)" }),
        };
      }

      // turn mode: a real message through the agent.
      let result;
      try {
        result = await this.mesh.request(
          agentId,
          opts.offering ?? "chat",
          { text: "diag ping — reply with a single word." },
          { timeout_ms: Math.min(timeoutMs, 300_000) },
        );
      } catch (err) {
        // §6.4a: an inbox-mode target's node answers with the queued ack,
        // which the SDK surfaces as REQUEST_QUEUED instead of resolving —
        // delivery to a held mailbox, with the real reply arriving later as a
        // fresh request to THIS agent. That is the asynchronous path this
        // probe already knew how to wait on.
        if (
          err instanceof MeshError &&
          err.code === ErrorCode.REQUEST_QUEUED &&
          typeof err.details?.request_id === "string"
        ) {
          return await this.awaitQueuedTurn(base, err.details.request_id, sentAt, t0, timeoutMs);
        }
        throw err;
      }
      const p: any = result.payload?.output ?? result.payload ?? {};
      if (p?.queued) {
        // Single-reply transports (no requestMulti) can still resolve with the
        // ack itself; same asynchronous path.
        const reqId = result.envelope?.in_reply_to ?? null;
        if (!reqId) {
          return {
            ...base,
            ok: true,
            ms: Date.now() - t0,
            error: "queued only — async reply needs the daemon's awaitAsyncReply hook",
          };
        }
        return await this.awaitQueuedTurn(base, reqId, sentAt, t0, timeoutMs);
      }
      // Pipe-mode target: the reply is synchronous, timing rides the payload.
      const doneAt = new Date().toISOString();
      return {
        ...base,
        ok: true,
        ms: Date.now() - t0,
        timing: timingFrom(sentAt, doneAt, p?.timing),
      };
    } catch (e: any) {
      return { ...base, ms: Date.now() - t0, error: e?.message ?? String(e) };
    }
  }

  /** The queued half of a turn ping (§6.4a queued ack): the message is held in
   *  the target's inbox, and the real reply arrives later as a fresh request
   *  to this agent — which only the embedder's awaitAsyncReply hook can see. */
  private async awaitQueuedTurn(
    base: PingResult,
    requestId: string,
    sentAt: string,
    t0: number,
    timeoutMs: number,
  ): Promise<PingResult> {
    if (!this.awaitAsyncReply) {
      return {
        ...base,
        ok: true,
        ms: Date.now() - t0,
        error: "queued only — async reply needs the daemon's awaitAsyncReply hook",
      };
    }
    const remaining = Math.max(1_000, timeoutMs - (Date.now() - t0));
    const entry = await this.awaitAsyncReply(requestId, remaining);
    const doneAt = new Date().toISOString();
    if (!entry) return { ...base, ms: Date.now() - t0, error: `no reply within ${timeoutMs}ms` };
    return {
      ...base,
      ok: true,
      ms: Date.now() - t0,
      timing: timingFrom(sentAt, doneAt, entry.timing as any),
    };
  }

  /**
   * Open a real room, invite a real agent, watch it arrive, tear down.
   * Consumes one durable-room slot transiently at the acl grade. Never
   * leaks: rooms are named `diag-*` and teardown runs in a finally (and the
   * ops reclaim tool treats stray `diag-*` rooms as always sweepable). A
   * `join` miss can be the TARGET's fault (its attendant didn't auto-join) —
   * the step detail says which side gave up.
   */
  async roomCheck(opts: {
    grade: "capability" | "acl" | "sealed";
    target: string;
    joinTimeoutMs?: number;
  }): Promise<RoomCheckResult> {
    const joinTimeoutMs = opts.joinTimeoutMs ?? 120_000;
    const skipped: DiagStep = { ok: false, ms: 0, detail: "skipped (earlier step failed)" };
    const result: RoomCheckResult = {
      grade: opts.grade,
      steps: { open: { ...skipped }, invite: { ...skipped }, join: { ...skipped }, presence: { ...skipped }, teardown: { ...skipped } },
    };

    let agentId = opts.target;
    if (!AGENT_ID_RE.test(opts.target)) {
      const r = await this.resolve(opts.target);
      if (!r.resolved || !r.agentId) {
        result.steps.open = { ok: false, ms: r.ms, detail: `could not resolve target: ${r.error}` };
        return result;
      }
      agentId = r.agentId;
    }

    const name = `diag-${Math.random().toString(36).slice(2, 8)}`;
    let room: Room | null = null;
    try {
      // open
      let t = Date.now();
      try {
        if (opts.grade === "acl") room = await this.mesh.openRoom({ name, acl: true });
        else if (opts.grade === "sealed") room = this.mesh.openRoom({ name, sealed: true });
        else room = this.mesh.openRoom({ name });
        result.steps.open = { ok: true, ms: Date.now() - t };
      } catch (e: any) {
        result.steps.open = { ok: false, ms: Date.now() - t, detail: e?.message ?? String(e) };
        return result;
      }

      // Arm the join watcher BEFORE inviting, so a fast join can't be missed.
      const joined = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), joinTimeoutMs);
        room!.onMessage((m) => {
          if (m.type === "join" && m.member === agentId) {
            clearTimeout(timer);
            resolve(true);
          }
        });
      });

      // invite
      t = Date.now();
      try {
        await room.invite(
          agentId,
          "diagnostic room check — join freely; this room closes itself shortly",
        );
        result.steps.invite = { ok: true, ms: Date.now() - t };
      } catch (e: any) {
        result.steps.invite = { ok: false, ms: Date.now() - t, detail: e?.message ?? String(e) };
        return result;
      }

      // join (the target's attendant must choose to auto-join)
      t = Date.now();
      const arrived = room.members.includes(agentId) || (await joined);
      result.steps.join = arrived
        ? { ok: true, ms: Date.now() - t }
        : {
            ok: false,
            ms: Date.now() - t,
            detail: `target did not join within ${joinTimeoutMs}ms — its attendant may not auto-join, poll slowly, or be down (not necessarily a mesh fault)`,
          };
      if (!arrived) return result;

      // presence
      t = Date.now();
      const present = room.members.includes(agentId);
      result.steps.presence = present
        ? { ok: true, ms: Date.now() - t }
        : { ok: false, ms: Date.now() - t, detail: "joined but absent from the live roster" };
      return result;
    } finally {
      const t = Date.now();
      if (room) {
        try {
          result.roomId = room.id;
          const reclaimable = room.durable; // acl rooms are always durable
          try { room.close("diagnostic check complete"); } catch { /* already detached */ }
          if (reclaimable) await room.reclaim();
          result.steps.teardown = { ok: true, ms: Date.now() - t };
        } catch (e: any) {
          result.steps.teardown = {
            ok: false,
            ms: Date.now() - t,
            detail: `${e?.message ?? e} — a stray diag-* room is reclaimable by the ops tool`,
          };
        }
      }
    }
  }

  /**
   * Ask another agent's DAEMON what it did with a message — the probe that
   * explains a silent turn (delivered? fetched? replied, acked, or held?).
   * Operator-scoped: the target answers only a signed request from an agent
   * bound to the SAME operator; anyone else gets authorized: false. Query by
   * envelope `id` (exact, also matches replies via in_reply_to) or by `room`
   * (the target's recent entries for that room).
   */
  async trace(
    target: string,
    query: { id?: string; room?: string; limit?: number },
    opts: { timeoutMs?: number } = {},
  ): Promise<TraceResult> {
    const base: TraceResult = { handle: target, agentId: null, ok: false, authorized: false, found: false };
    let agentId = target;
    if (!AGENT_ID_RE.test(target)) {
      const r = await this.resolve(target);
      if (!r.resolved || !r.agentId) return { ...base, error: r.error ?? `could not resolve ${target}` };
      agentId = r.agentId;
    }
    base.agentId = agentId;
    try {
      const result = await this.mesh.request(agentId, DIAG_TRACE_OFFERING, query, {
        timeout_ms: opts.timeoutMs ?? 20_000,
      });
      const p: any = result.payload?.output ?? result.payload ?? {};
      if (p?.authorized === undefined) {
        // An older adapter routes unknown offerings to its default handler and
        // queues them — surface that honestly instead of pretending.
        return { ...base, ok: false, error: "target adapter does not support trace (pre-0.28)" };
      }
      return {
        ...base,
        ok: p.authorized === true,
        authorized: p.authorized === true,
        found: p.found === true,
        entry: p.entry ?? undefined,
        entries: p.entries ?? undefined,
        error: p.reason ?? p.error ?? undefined,
      };
    } catch (e: any) {
      return { ...base, error: e?.message ?? String(e) };
    }
  }

  /** The calling operator's durable-room usage vs quota, from the rooms
   *  service (`mesh.rooms.usage`). Answers only for the CALLER's operator. */
  async roomsStatus(): Promise<RoomsStatusResult> {
    try {
      const payload = await this.mesh.serviceRequest(RoomsServiceSubjects.USAGE, {}, 15_000);
      return payload as RoomsStatusResult;
    } catch (e: any) {
      if (e instanceof MeshError && e.code === ErrorCode.TRANSPORT_NO_RESPONDERS) {
        throw new Error(
          "the rooms service does not answer usage queries (mesh.rooms.usage) — it may predate diagnostics support",
        );
      }
      throw e;
    }
  }
}
