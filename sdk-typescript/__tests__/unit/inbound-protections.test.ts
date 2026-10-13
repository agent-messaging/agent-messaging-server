// The five inbound protections (SPEC.md §22), asserted case by case against
// conformance/inbound-protections.json.
//
// WHY THIS FILE READS A JSON FILE INSTEAD OF STATING ITS CASES
//
//   The five obligations — duplicate rejection, a freshness window, correct
//   addressing, an inbound size cap and sender-text fencing — are RECEIVER
//   obligations, and Go, Python and C# are expected to be written natively from
//   the specification rather than from a shared library. Two correct
//   implementations do not diverge on the rule; they diverge on canonicalization,
//   on whether a character is counted in bytes or in UTF-16 code units, and on
//   whether an empty body is joined into the frame. Prose cannot pin any of
//   that, so the fixture pins bytes, and every implementation is held to the
//   same bytes.
//
//   Which is why this file ITERATES the fixture. If the cases were enumerated in
//   TypeScript here, the fixture would be a second copy of the truth and the two
//   would drift — the exact failure the fixture exists to prevent, moved one
//   level up. Adding a case to the JSON must fail this suite until the
//   implementation handles it, and adding a whole new `*_cases` array must fail
//   it too: the last test in this file walks the fixture generically and demands
//   that every case it finds was executed.
//
//   THE FIXTURE IS THE AUTHORITY. When something here fails, fix
//   sdk-typescript/src (or mesh-adapter) to agree with the fixture — never the
//   fixture to agree with the code. tools/ci/check-inbound-protections.mjs is
//   the gate that says so from outside, and it counts what this file executed.
//
// DETERMINISM
//
//   No broker, no connection, no clock. Where a verdict depends on the
//   recipient's clock the case carries its own `now`, and `withClock` freezes
//   Date to it — the system clock is never read, so a case that passes today
//   passes in 2027.
import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import {
  signEnvelope,
  verifyEnvelopeSig,
  canonicalEnvelopeBytes,
  signedEnvelopeBytes,
  fromB64Url,
  ENVELOPE_SIG_PREFIX,
} from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { ErrorCode } from "../../src/types/errors.js";
import { Subjects } from "../../src/internal/subjects.js";
import {
  fenceSenderText,
  frameMessage,
  fenceInboundInput,
  senderTextOf,
  inboundTextLength,
  BEGIN_SENDER_MESSAGE,
  END_SENDER_MESSAGE,
} from "../../src/internal/fence.js";
import {
  MAX_CLOCK_SKEW_AHEAD_MS,
  MAX_CLOCK_SKEW_BEHIND_MS,
  MAX_MAILBOX_AGE_MS,
  MAX_SEEN_INBOX_IDS,
  DEFAULT_MAX_INBOUND_CHARS,
} from "../../src/constants.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { SecurityWarning } from "../../src/types/options.js";
import type { ConnectionManager } from "../../src/internal/connection.js";

// ── the fixture ─────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(here, "..", "..", "..", "conformance", "inbound-protections.json");

type Verdict = "accept" | "refuse";
interface Delivery {
  from: string;
  id: string;
  source?: "live" | "mailbox";
  now?: string;
  ts?: string;
  verdict: Verdict;
  refused_by?: string;
}
interface Fixture {
  version: number;
  spec: string;
  identities: {
    sender_seed: string;
    sender: string;
    recipient: string;
    recipient_case_bent: string;
    third_party: string;
    trace: { trace_id: string; span_id: string };
  };
  duplicate_rejection: {
    key: string;
    min_entries: number;
    cases: {
      id: string;
      deliveries?: Delivery[];
      generated_deliveries?: {
        from: string;
        id_template: string;
        i_from: number;
        i_to: number;
        each_verdict: Verdict;
      };
      then?: Delivery[];
    }[];
  };
  freshness: {
    max_clock_skew_ahead_ms: number;
    max_clock_skew_behind_ms: number;
    max_mailbox_age_ms: number;
    cases: { id: string; now: string; ts: string; source: "live" | "mailbox"; verdict: Verdict }[];
  };
  addressing: { self: string; cases: { id: string; envelope: string; verdict: Verdict }[] };
  size_cap: {
    default_max_inbound_chars: number;
    cases: {
      id: string;
      max_inbound_chars: number;
      input: unknown;
      measured_chars: number;
      verdict: Verdict;
    }[];
  };
  fencing: {
    markers: { begin: string; end: string };
    sender_text_cases: { id: string; input: string; expected: string }[];
    frame_cases: {
      id: string;
      text: string;
      provenance: {
        from: string;
        received_at: string;
        handle?: string;
        operator?: string;
        trace?: { trace_id: string; span_id: string };
      };
      expected: string;
    }[];
    payload_shape_cases: {
      id: string;
      input: unknown;
      sender_text: string;
      sender_text_field: string | null;
      framed: boolean;
      framed_field?: string;
      expected: unknown;
    }[];
  };
  refusals: {
    size_cap: {
      to_sender: {
        type: string;
        error_code: string;
        retryable: boolean;
      };
      to_recipient: { local_warning: string };
      handler_invoked: boolean;
    };
    duplicate: { to_sender: null };
    stale: { to_sender: null };
    misaddressed: { to_sender: null };
    hops_exceeded: { to_sender: null };
  };
  envelopes: Record<string, { canonical: string; envelope: Envelope }> & {
    /** The domain tag: every `sig` here covers signed_bytes_prefix + canonical (§5.3). */
    signed_bytes_prefix: string;
  };
  suspected_gaps: { cases: { id: string }[] };
}

const F = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

// ── the ledger ──────────────────────────────────────────────────────────────
//
// Every case this file drives records itself here. The last test compares the
// ledger against a generic walk of the fixture, and the CI gate reads the same
// ledger from outside — because a fixture-driven suite that silently skips a
// section is worse than no suite at all: it reports a number that sounds like
// coverage.

const executed = new Map<string, string>();
/** Cases the fixture declares that this suite cannot drive, each with the
 *  reason. EMPTY today, and the gate fails on any entry: an untestable case is
 *  a finding to report, never a quiet omission. */
const unexecuted: { key: string; why: string }[] = [];
const caseKey = (section: string, id: string) => `${section}#${id}`;
const ran = (section: string, id: string, driver: string) => {
  executed.set(caseKey(section, id), driver);
};

/** Every `*_cases` / `cases` array in the fixture, found without being told
 *  where to look — so a NEW section is a failure rather than a blind spot. */
function declaredCases(root: unknown): string[] {
  const out: string[] = [];
  const walk = (node: Record<string, unknown>, path: string) => {
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      if (Array.isArray(v)) {
        if (/cases$/.test(k)) {
          for (const el of v) out.push(caseKey(p, (el as { id: string }).id));
        }
      } else if (v && typeof v === "object") {
        walk(v as Record<string, unknown>, p);
      }
    }
  };
  walk(root as Record<string, unknown>, "");
  return out.sort();
}

afterAll(async () => {
  for (const a of openAgents.splice(0)) {
    try {
      await a.close();
    } catch {
      /* a fake connection cannot really fail to close */
    }
  }
  const ledger = {
    fixture: "conformance/inbound-protections.json",
    spec: F.spec,
    version: F.version,
    executed: [...executed.keys()].sort(),
    drivers: Object.fromEntries([...executed.entries()].sort()),
    unexecuted,
  };
  const out = process.env.INBOUND_PROTECTIONS_LEDGER;
  if (out) writeFileSync(out, JSON.stringify(ledger, null, 2));
  console.log(
    `INBOUND-PROTECTIONS-LEDGER executed=${ledger.executed.length} unexecuted=${unexecuted.length}`,
  );
});

// ── harness ─────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Freeze `Date` at the instant a case carries. Only Date is faked: the drain
 *  and the dispatch path are driven with real microtasks and real setTimeout. */
function withClock(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}
afterEach(() => {
  vi.useRealTimers();
});

/**
 * A KeyPair that PRESENTS a chosen public key.
 *
 * The addressing and ordering cases are only meaningful against the fixture's
 * own `self`, and the fixture deliberately discarded the seed the recipient was
 * minted from ("the recipient and third party never sign anything here"). So the
 * recipient identity is handed to the SDK as its public half plus a real
 * ephemeral signer: `agentId` is the fixture's `self`, which is the value the
 * §22.4 comparison is made against, and nothing in these cases depends on this
 * agent's own outbound signature.
 */
function keyPairPresenting(publicKey: string): KeyPair {
  const real = nkeys.createUser();
  return {
    getPublicKey: () => publicKey,
    getPrivateKey: () => real.getPrivateKey(),
    getSeed: () => real.getSeed(),
    sign: (input: Uint8Array) => real.sign(input),
    verify: (input: Uint8Array, sig: Uint8Array) => real.verify(input, sig),
    clear: () => real.clear(),
  } as unknown as KeyPair;
}

/** The fixture's sender, reconstructed from the published seed — so envelopes
 *  built here are signed by the same key the fixture's own envelopes are. */
const senderKp = nkeys.fromSeed(enc.encode(F.identities.sender_seed));

/**
 * A fake connection whose mailbox is a GROWING LOG with stream sequences.
 *
 * The §16.4 drain is bounded to the backlog present when it binds: it reads the
 * stream's last sequence, delivers up to it, and stops, because past that point a
 * captured message is the live subscription's and the two paths answer different
 * destinations (§22.2). So a mailbox fake cannot be a consumer that stays open
 * and blocks for a push — that is the shape of the bug. It is a log the test
 * appends to, plus a bind that sees whatever is in it at that moment, which is
 * what `deliverBuffered` asks for by re-registering.
 */
function makeConn() {
  const registryKp = nkeys.createUser();
  const published: { subject: string; data: Uint8Array }[] = [];
  const inboxHandlers = new Map<string, (msg: unknown) => void>();
  const acked: number[] = [];

  /** The mailbox stream: every captured message keeps the sequence it got. */
  const held: { seq: number; data: Uint8Array }[] = [];
  let lastSeq = 0;
  /** The durable's cursor: the highest sequence handed to a drain. */
  let deliveredUpTo = 0;
  const pending = () => held.filter((h) => h.seq > deliveredUpTo).length;

  const jsm = {
    streams: { info: vi.fn(async () => ({ state: { last_seq: lastSeq } })) },
    consumers: {
      info: vi.fn(async () => ({ num_pending: pending(), num_ack_pending: 0 })),
      add: vi.fn(async () => ({ num_pending: pending(), num_ack_pending: 0 })),
    },
  };
  const consumer = {
    fetch: vi.fn(async (opts: { max_messages: number }) => ({
      stop: () => {},
      async *[Symbol.asyncIterator]() {
        let n = 0;
        for (const h of held) {
          if (h.seq <= deliveredUpTo || n >= opts.max_messages) continue;
          deliveredUpTo = h.seq;
          n++;
          yield { seq: h.seq, data: h.data, ack: () => acked.push(h.seq) };
        }
      },
    })),
  };
  const raw = {
    jetstreamManager: vi.fn(async () => jsm),
    jetstream: vi.fn(() => ({ consumers: { get: vi.fn(async () => consumer) } })),
    publish: vi.fn((subject: string, data: Uint8Array) => published.push({ subject, data })),
  };

  const conn = {
    published,
    inboxHandlers,
    acked,
    raw,
    /** Capture one envelope into the mailbox, as the stream would. */
    pushMailbox(data: Uint8Array) {
      held.push({ seq: ++lastSeq, data });
    },
    publish: vi.fn((subject: string, data: Uint8Array) => published.push({ subject, data })),
    // `decodeUnverified` on purpose: an agent presenting the fixture's `self`
    // (see keyPairPresenting) signs its own register envelope with an ephemeral
    // key, and a fake registry verifying that is a fake-registry concern with
    // nothing to say about §22. The INBOUND path under test still uses the real
    // `decode`, signature check and all.
    request: vi.fn(async (_subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      return {
        data: encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: registryKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload: { status: "registered" },
            }),
            registryKp,
          ),
        ),
      };
    }),
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
      inboxHandlers.set(subject, cb);
      return { unsubscribe: () => {}, drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    get isClosed() {
      return false;
    },
  };
  return conn;
}
type Conn = ReturnType<typeof makeConn>;

const openAgents: AgentMesh[] = [];

/** One registered agent whose `chat` handler records what it was handed. */
async function makeAgent(opts: { kp?: KeyPair; maxInboundChars?: number } = {}) {
  const conn = makeConn();
  const warnings: SecurityWarning[] = [];
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    opts.kp ?? nkeys.createUser(),
    nkeys.createUser(),
    { maxInboundChars: opts.maxInboundChars, onSecurityWarning: (w) => warnings.push(w) },
  );
  const seen: unknown[] = [];
  agent.onRequest("chat", (input) => {
    seen.push(input);
    return { ok: true };
  });
  await agent.register({ name: "inbound-protections" });
  openAgents.push(agent);
  return { conn, agent, seen, warnings };
}

/** The private (from, id) memory, driven directly where the fixture states a
 *  case as a pair rather than as an envelope. The method, the Set and the
 *  eviction are the shipped ones; only `decode` is bypassed, which is the one
 *  thing §22.2 is explicitly NOT about ("this is not a signature check"). It is
 *  also the only way to drive a delivery from the fixture's `third_party`, whose
 *  seed the fixture discarded on purpose. */
type SeenMemory = { rememberInboxId(from: string, id: string): boolean };
const memoryOf = (agent: AgentMesh) => agent as unknown as SeenMemory;

/** Build a request envelope from the fixture's sender, optionally overriding
 *  wire fields the fixture pins (`ts`, `id`), and sign it for real. */
function requestEnvelope(
  to: string | undefined,
  input: unknown,
  over: Partial<Envelope> = {},
  kp: KeyPair = senderKp,
): Envelope {
  const env = createEnvelope({
    type: "request",
    from: kp.getPublicKey(),
    ...(to === undefined ? {} : { to }),
    payload: { offering: "chat", input },
  });
  Object.assign(env, over);
  return signEnvelope(env, kp);
}

/** Deliver on the LIVE inbox subscription, with a transport-minted reply
 *  subject so the agent is willing to answer. Returns the replies it made. */
async function deliverLive(conn: Conn, agentId: string, env: Envelope): Promise<Uint8Array[]> {
  const cb = conn.inboxHandlers.get(Subjects.agentInbox(agentId));
  if (!cb) throw new Error("agent is not listening on its inbox");
  const before = conn.published.length;
  cb({
    data: encode(env),
    subject: Subjects.agentInbox(agentId),
    reply: "_INBOX.abc123",
    respond: () => true,
  });
  await settle();
  // §6.4 cutover: replies are PUBLISHED to the sender's inbox, so the fake's
  // publish record is where they land.
  const senderInbox = Subjects.agentInbox(env.from);
  return conn.published
    .slice(before)
    .filter((p) => p.subject === senderInbox)
    .map((p) => p.data);
}

/** Deliver through the §16.4 mailbox drain (`buffered = true`).
 *
 *  A drain is bounded to the backlog present when it bound, so a message
 *  captured after the agent registered is not the finished drain's to dispatch —
 *  a later bind is. Re-registering is how a test asks for that bind, and it is
 *  what a reconnecting agent really does. */
async function deliverBuffered(conn: Conn, agent: AgentMesh, env: Envelope): Promise<void> {
  const before = conn.acked.length;
  conn.pushMailbox(encode(env));
  await agent.register({ name: "inbound-protections" });
  await waitUntil(() => conn.acked.length > before);
}

const settle = () => new Promise((r) => setTimeout(r, 0));
async function waitUntil(pred: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await settle();
  }
  throw new Error("timed out waiting for the drain");
}

/** Deliver `env` the way the case says, and report the verdict the way §22
 *  expresses it: an accepted envelope reaches the handler, a refused one does
 *  not. Every one of the five protections is silent-by-drop except the size
 *  cap, so "did the handler run" is the observable. */
async function verdictOf(
  source: "live" | "mailbox",
  agent: { conn: Conn; agent: AgentMesh; seen: unknown[] },
  env: Envelope,
): Promise<{ verdict: Verdict; replies: Uint8Array[] }> {
  const before = agent.seen.length;
  let replies: Uint8Array[] = [];
  if (source === "mailbox") await deliverBuffered(agent.conn, agent.agent, env);
  else replies = await deliverLive(agent.conn, agent.agent.id, env);
  return { verdict: agent.seen.length > before ? "accept" : "refuse", replies };
}

// ═══════════════════════════════════════════════════════════════════════════
// The pinned constants are the shipped constants
// ═══════════════════════════════════════════════════════════════════════════

describe("§22 — the fixture's numbers are the SDK's numbers", () => {
  it("markers, windows, cap and memory size all agree", () => {
    expect(F.fencing.markers.begin).toBe(BEGIN_SENDER_MESSAGE);
    expect(F.fencing.markers.end).toBe(END_SENDER_MESSAGE);
    expect(F.freshness.max_clock_skew_ahead_ms).toBe(MAX_CLOCK_SKEW_AHEAD_MS);
    expect(F.freshness.max_clock_skew_behind_ms).toBe(MAX_CLOCK_SKEW_BEHIND_MS);
    expect(F.freshness.max_mailbox_age_ms).toBe(MAX_MAILBOX_AGE_MS);
    expect(F.size_cap.default_max_inbound_chars).toBe(DEFAULT_MAX_INBOUND_CHARS);
    // The memory must hold AT LEAST the pinned minimum; the eviction case below
    // is what proves it does not hold more than a bound.
    expect(MAX_SEEN_INBOX_IDS).toBeGreaterThanOrEqual(F.duplicate_rejection.min_entries);
    expect(F.duplicate_rejection.key).toBe("(from, id)");
  });

  it("the fixture's own identities are coherent", () => {
    // Independent of the SDK: proves the fixture is self-consistent, so a later
    // failure points at the implementation rather than at the fixture.
    expect(senderKp.getPublicKey()).toBe(F.identities.sender);
    expect(F.addressing.self).toBe(F.identities.recipient);
    expect(F.identities.recipient_case_bent).not.toBe(F.identities.recipient);
    expect(F.identities.recipient_case_bent.toUpperCase()).toBe(F.identities.recipient);
  });

  it("every pinned envelope's signature covers signed_bytes_prefix + `canonical` (§5.3)", () => {
    expect(F.envelopes.signed_bytes_prefix).toBe(ENVELOPE_SIG_PREFIX);
    // `envelopes` also carries `comment` and `signed_bytes_prefix` strings,
    // hence the shape guard.
    const named = Object.entries(F.envelopes).filter(([, v]) => v && typeof v === "object");
    expect(named.length).toBeGreaterThan(0);
    for (const [name, spec] of named) {
      expect(dec.decode(canonicalEnvelopeBytes(spec.envelope)), name).toBe(spec.canonical);
      expect(verifyEnvelopeSig(spec.envelope), name).toBe(true);
      // Strictly the TAGGED form — an untagged legacy signature would still
      // pass verifyEnvelopeSig via the 0.2 dual-accept, so pin the fixture to
      // the tagged bytes directly.
      expect(
        nkeys
          .fromPublic(spec.envelope.from)
          .verify(signedEnvelopeBytes(spec.envelope), fromB64Url(spec.envelope.sig!)),
        name,
      ).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §22.6 fencing — sender text
// ═══════════════════════════════════════════════════════════════════════════

describe("§22.6 fencing.sender_text_cases — fenceSenderText, byte for byte", () => {
  for (const c of F.fencing.sender_text_cases) {
    it(c.id, () => {
      expect(fenceSenderText(c.input)).toBe(c.expected);
      // And the property behind the bytes: no line a reader sees may begin with
      // a marker run. Split by the WHOLE line-terminator class, not by the class
      // the fence happens to normalise — that difference is the U+2028 defect.
      for (const line of fenceSenderText(c.input).split(/[\n\u{0085}\u{2028}\u{2029}]/u)) {
        expect(line.startsWith("---"), `${c.id}: ${JSON.stringify(line)}`).toBe(false);
        expect(line.startsWith("==="), `${c.id}: ${JSON.stringify(line)}`).toBe(false);
      }
      ran("fencing.sender_text_cases", c.id, "fenceSenderText()");
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// §22.6 fencing — the frame
// ═══════════════════════════════════════════════════════════════════════════

describe("§22.6 fencing.frame_cases — frameMessage, byte for byte", () => {
  for (const c of F.fencing.frame_cases) {
    it(c.id, () => {
      expect(
        frameMessage(c.text, {
          from: c.provenance.from,
          handle: c.provenance.handle ?? null,
          operator: c.provenance.operator ?? null,
          trace: c.provenance.trace ?? null,
          receivedAt: new Date(c.provenance.received_at),
        }),
      ).toBe(c.expected);
      ran("fencing.frame_cases", c.id, "frameMessage()");
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// §22.6 fencing — which payload shapes get framed
// ═══════════════════════════════════════════════════════════════════════════

describe("§22.6 fencing.payload_shape_cases — fenceInboundInput + senderTextOf", () => {
  // The frames pinned in these cases were produced with the same provenance the
  // frame_cases pin, so it is taken from there rather than restated.
  const base = F.fencing.frame_cases.find((c) => c.id === "frame_unresolved_sender")!.provenance;
  const prov = { from: base.from, receivedAt: new Date(base.received_at) };

  const hasFrameMarker = (v: unknown): boolean =>
    typeof v === "string"
      ? v.includes(BEGIN_SENDER_MESSAGE)
      : !!v && typeof v === "object"
        ? Object.values(v as Record<string, unknown>).some(hasFrameMarker)
        : false;

  for (const c of F.fencing.payload_shape_cases) {
    it(c.id, () => {
      const before = structuredClone(c.input);
      const out = fenceInboundInput(c.input, prov);

      // The exact bytes the fixture pins.
      expect(out).toEqual(c.expected);

      // The input object is COPIED, never mutated: the same object graph hangs
      // off the verbatim signed envelope, which must still verify.
      expect(c.input).toEqual(before);

      // What the §22.5 MEASUREMENT walk found, which is a different question
      // from where the frame went.
      const st = senderTextOf(c.input);
      expect(st.text).toBe(c.sender_text);
      expect(st.field).toBe(c.sender_text_field);

      // Where the frame went, if anywhere.
      if (!c.framed) {
        expect(hasFrameMarker(out)).toBe(false);
      } else if (c.sender_text_field === "self") {
        expect(out).toContain(BEGIN_SENDER_MESSAGE);
      } else {
        const field = c.framed_field ?? (c.sender_text_field as string);
        const framed = (out as Record<string, unknown>)[field];
        expect(typeof framed).toBe("string");
        expect(framed as string).toContain(BEGIN_SENDER_MESSAGE);
        // Exactly one field is framed — framing every rung would hand a model
        // two provenance headers for one message.
        const others = Object.entries(out as Record<string, unknown>).filter(
          ([k]) => k !== field,
        );
        for (const [k, v] of others) {
          expect(hasFrameMarker(v), `${c.id}: ${k} must not be framed too`).toBe(false);
        }
      }
      ran("fencing.payload_shape_cases", c.id, "fenceInboundInput() + senderTextOf()");
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// §22.5 the inbound size cap
// ═══════════════════════════════════════════════════════════════════════════

describe("§22.5 size_cap.cases — measured, then refused or dispatched", () => {
  for (const c of F.size_cap.cases) {
    it(c.id, async () => {
      // 1. the measurement, in UTF-16 code units
      expect(inboundTextLength(c.input)).toBe(c.measured_chars);

      // 2. the verdict, through the real dispatch path at the case's own cap
      const a = await makeAgent({ maxInboundChars: c.max_inbound_chars });
      const env = requestEnvelope(a.agent.id, c.input);
      const { verdict, replies } = await verdictOf("live", a, env);
      expect(verdict).toBe(c.verdict);

      // 3. §22.7 — the refusal is announced at BOTH ends, and the handler never
      //    ran, so an oversized message costs no model call.
      if (c.verdict === "refuse") {
        const r = F.refusals.size_cap;
        expect(a.seen).toHaveLength(0);
        expect(r.handler_invoked).toBe(false);
        expect(replies).toHaveLength(1);
        const err = decode(replies[0]!);
        expect(err.type).toBe(r.to_sender.type);
        expect(err.error?.code).toBe(r.to_sender.error_code);
        expect(err.error?.code).toBe(ErrorCode.CONTEXT_TOO_LARGE);
        expect(err.error?.retryable).toBe(r.to_sender.retryable);
        expect(err.in_reply_to).toBe(env.id);
        expect(err.to).toBe(env.from);
        expect(a.warnings.map((w) => w.code)).toContain(r.to_recipient.local_warning);
      }
      ran("size_cap.cases", c.id, "inboundTextLength() + inbox dispatch");
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// §22.3 the freshness window
// ═══════════════════════════════════════════════════════════════════════════

describe("§22.3 freshness.cases — live window vs mailbox retention", () => {
  for (const c of F.freshness.cases) {
    it(`${c.id} (${c.source})`, async () => {
      withClock(c.now);
      const a = await makeAgent();
      const env = requestEnvelope(a.agent.id, { text: "hello" }, { ts: c.ts });
      const { verdict, replies } = await verdictOf(c.source, a, env);
      expect(verdict).toBe(c.verdict);
      // §22.7: a stale envelope is refused in SILENCE. An error envelope would
      // tell a replayer which of its held copies are still inside the window.
      if (c.verdict === "refuse") {
        expect(F.refusals.stale.to_sender).toBeNull();
        expect(replies).toHaveLength(0);
      }
      ran("freshness.cases", c.id, "inbox dispatch on a frozen clock");
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// §22.4 addressing
// ═══════════════════════════════════════════════════════════════════════════

describe("§22.4 addressing.cases — `to` compared byte for byte against self", () => {
  for (const c of F.addressing.cases) {
    it(c.id, async () => {
      const spec = F.envelopes[c.envelope]!;
      // The envelopes are really signed, so this drives decode() as well: a
      // verdict reached by failing verification would prove nothing about §22.4.
      expect(verifyEnvelopeSig(spec.envelope)).toBe(true);
      withClock(spec.envelope.ts);
      const a = await makeAgent({ kp: keyPairPresenting(F.addressing.self) });
      expect(a.agent.id).toBe(F.addressing.self);
      const { verdict, replies } = await verdictOf("live", a, spec.envelope);
      expect(verdict).toBe(c.verdict);
      // §22.7: silent. Replying would confirm to a third party that this inbox
      // is live, and would put this key's signature on a reply to a message it
      // was never sent.
      if (c.verdict === "refuse") {
        expect(F.refusals.misaddressed.to_sender).toBeNull();
        expect(replies).toHaveLength(0);
      }
      ran("addressing.cases", c.id, "inbox dispatch as the fixture's own `self`");
    });
  }

  it("the §21 relay guard drops hops_over_the_relay_bound, also in silence", async () => {
    // Not one of the four addressing cases; the fixture ships the envelope so
    // that the addressing fixture is not read as the only meta-level drop.
    const spec = F.envelopes.hops_over_the_relay_bound!;
    withClock(spec.envelope.ts);
    const a = await makeAgent({ kp: keyPairPresenting(F.addressing.self) });
    const { verdict, replies } = await verdictOf("live", a, spec.envelope);
    expect(verdict).toBe("refuse");
    expect(F.refusals.hops_exceeded.to_sender).toBeNull();
    expect(replies).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §22.2 duplicate rejection
// ═══════════════════════════════════════════════════════════════════════════

describe("§22.2 duplicate_rejection.cases — keyed on (from, id)", () => {
  const byId = (id: string) => F.duplicate_rejection.cases.find((c) => c.id === id)!;

  // The three cases the fixture states as bare (from, id) pairs. One of them
  // delivers from `third_party`, whose seed the fixture discarded, so these are
  // driven against the memory itself rather than through decode() — which is
  // exactly the boundary the fixture draws: "Envelope authenticity: this is not
  // a signature check."
  const pairOnly = F.duplicate_rejection.cases.filter(
    (x) => x.deliveries && x.deliveries.every((d) => d.source === undefined),
  );
  for (const c of pairOnly) {
    it(c.id, async () => {
      const { agent } = await makeAgent();
      const mem = memoryOf(agent);
      for (const d of c.deliveries!) {
        expect(mem.rememberInboxId(d.from, d.id), `${c.id}/${d.id}/${d.from.slice(0, 8)}`).toBe(
          d.verdict === "accept",
        );
      }
      ran("duplicate_rejection.cases", c.id, "rememberInboxId() directly");
    });
  }

  it("remembered_before_the_freshness_check", async () => {
    // ORDERING, and it is normative. The stale envelope goes down the LIVE path
    // (refused for age) and must STILL be remembered, so that the copy the
    // mailbox captured — whose age the 7-day window forgives — does not sail
    // past the rejection the live path just made.
    const c = byId("remembered_before_the_freshness_check");
    const [first, second] = c.deliveries!;
    const spec = F.envelopes.stale_by_two_hours!;
    expect(spec.envelope.from).toBe(first!.from);
    expect(spec.envelope.id).toBe(first!.id);

    withClock(first!.now!);
    const a = await makeAgent({ kp: keyPairPresenting(F.addressing.self) });
    expect((await verdictOf("live", a, spec.envelope)).verdict).toBe(first!.verdict);
    expect((await verdictOf("mailbox", a, spec.envelope)).verdict).toBe(second!.verdict);

    // `refused_by` is not observable from outside — both refusals are silent
    // drops — so it is established by difference instead: the SAME envelope on
    // the mailbox path of a FRESH agent is ACCEPTED, because the mailbox window
    // forgives two hours. So the second refusal above cannot have been the
    // window; the only thing left is the memory, which is the ordering claim.
    withClock(second!.now!);
    const fresh = await makeAgent({ kp: keyPairPresenting(F.addressing.self) });
    expect((await verdictOf("mailbox", fresh, spec.envelope)).verdict).toBe("accept");
    expect(second!.refused_by).toBe("duplicate");
    ran("duplicate_rejection.cases", c.id, "live-then-mailbox dispatch + a difference control");
  });

  it("eviction_forgets_and_that_is_why_the_window_exists", async () => {
    // The memory is bounded on purpose — an unbounded set fed from the wire is a
    // remote memory-exhaustion primitive — so it forgets, and the freshness
    // window is what still refuses the replay it forgot.
    const c = byId("eviction_forgets_and_that_is_why_the_window_exists");
    const g = c.generated_deliveries!;
    const [evicted, stale] = c.then!;

    /** An agent whose memory has been filled exactly as the case's generator
     *  says: `vector-0` … `vector-5000`, every one accepted. */
    const filled = async () => {
      const a = await makeAgent({ kp: keyPairPresenting(F.addressing.self) });
      const mem = memoryOf(a.agent);
      for (let i = g.i_from; i <= g.i_to; i++) {
        const id = g.id_template.replace("{i}", String(i));
        expect(mem.rememberInboxId(g.from, id), id).toBe(g.each_verdict === "accept");
      }
      return a;
    };

    // then[0]: `vector-0` fell off the end, so re-delivering it is ACCEPTED.
    // Nothing is broken — the envelope is inside the freshness window, so this
    // is a message the sender could have re-sent anyway.
    withClock(evicted!.now!);
    const a = await filled();
    const e0 = requestEnvelope(a.agent.id, { text: "hello" }, { id: evicted!.id, ts: evicted!.ts });
    expect((await verdictOf("live", a, e0)).verdict).toBe(evicted!.verdict);

    // then[1]: the same id, two hours old, REFUSED. Delivered on a second agent
    // filled the same way, because on the first agent then[0] has just put
    // `vector-0` back in the memory and the dedup would refuse it — the same
    // verdict for a different reason. Here nothing has re-added it (then[0]
    // above proved the fill evicts it), so the window is provably the refuser,
    // which is what `refused_by` claims.
    withClock(stale!.now!);
    const b = await filled();
    const e1 = requestEnvelope(b.agent.id, { text: "hello" }, { id: stale!.id, ts: stale!.ts });
    const r = await verdictOf("live", b, e1);
    expect(r.verdict).toBe(stale!.verdict);
    expect(r.replies).toHaveLength(0); // silent, per §22.7
    expect(stale!.refused_by).toBe("freshness");

    // …and in strict sequence the verdict is the same, which is the case as the
    // fixture literally orders it.
    const seq = await verdictOf("live", a, requestEnvelope(a.agent.id, { text: "hello" }, { id: stale!.id, ts: stale!.ts }));
    expect(seq.verdict).toBe(stale!.verdict);
    ran("duplicate_rejection.cases", c.id, "generated fill of rememberInboxId() + dispatch");
  }, 30_000);

  it("a duplicate is refused in SILENCE — the first copy was already answered", async () => {
    // §22.7: answering twice would make one delivery look like two, and a
    // duplicate is normal transport behaviour rather than misbehaviour.
    expect(F.refusals.duplicate.to_sender).toBeNull();
    withClock(F.envelopes.addressed_to_recipient!.envelope.ts);
    const a = await makeAgent({ kp: keyPairPresenting(F.addressing.self) });
    const env = F.envelopes.addressed_to_recipient!.envelope;
    expect((await verdictOf("live", a, env)).verdict).toBe("accept");
    const again = await verdictOf("live", a, env);
    expect(again.verdict).toBe("refuse");
    expect(again.replies).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The fixture drives this suite, not the other way round
// ═══════════════════════════════════════════════════════════════════════════

describe("coverage of the fixture", () => {
  // Deliberately LAST in the file: vitest runs a file's tests in declaration
  // order, so by the time this runs the ledger is complete.
  it("every case in every *cases array of the fixture was executed", () => {
    const declared = declaredCases(F);
    const missing = declared.filter(
      (k) => !executed.has(k) && !unexecuted.some((u) => u.key === k),
    );
    // A case added to the JSON — or a whole new section — lands here first.
    expect(missing).toEqual([]);
    // There is nothing in this fixture this suite cannot drive. If that ever
    // stops being true, the entry and its reason belong in `unexecuted`, where
    // the CI gate reports it as a finding rather than hiding it in a count.
    expect(unexecuted).toEqual([]);
    expect([...executed.keys()].sort()).toEqual(declared);
  });

  it("the suspected_gaps block is pinned, and an entry in it fails the run above", () => {
    // Nothing is pinned as suspected today. The block stays because the
    // discipline it records is the fixture's own: a behaviour nobody has ruled
    // on is pinned rather than omitted. An entry appearing here has no driver,
    // so `missing` catches it — which is the intended failure.
    expect(Array.isArray(F.suspected_gaps.cases)).toBe(true);
    for (const c of F.suspected_gaps.cases) {
      expect(executed.has(caseKey("suspected_gaps.cases", c.id))).toBe(true);
    }
  });
});
