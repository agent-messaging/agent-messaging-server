// Sender pre-flight (SPEC.md §6.4b), asserted case by case against
// conformance/sender-preflight.json.
//
// This file ITERATES the fixture: every case in `sender_text.cases`,
// `envelope_size.cases` and `content_type.cases` is driven through the shipped
// pre-flight functions, so adding a case to the JSON grows this suite without
// touching this file. The end-to-end tests then prove request() actually runs
// the same decisions before publishing — and that a refusal publishes NOTHING
// (the fixture's mirror block: same code, same retryable, nothing published).
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src to agree with the fixture — never the fixture to agree
// with the code (the fixture changes only with a spec change alongside).
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode, MeshError } from "../../src/types/errors.js";
import { DEFAULT_MAX_INBOUND_CHARS } from "../../src/constants.js";
import { inboundTextLength } from "../../src/internal/fence.js";
import {
  effectiveInboundCap,
  preflightSenderText,
  preflightEnvelopeSize,
  preflightContentType,
} from "../../src/preflight.js";
import type { Manifest } from "../../src/types/manifest.js";
import type { Envelope } from "../../src/types/envelope.js";

// ── the fixture ─────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(here, "..", "..", "..", "conformance", "sender-preflight.json");

interface SenderTextCase {
  id: string;
  declared_cap: number | null;
  text?: string;
  text_utf16_len: number;
  verdict: "publish" | "refuse_local";
  error_code?: string;
  retryable?: boolean;
}
interface EnvelopeSizeCase {
  id: string;
  max_payload_bytes: number;
  envelope_bytes: number;
  verdict: "publish" | "refuse_local";
  error_code?: string;
  retryable?: boolean;
  details_limit?: string;
}
interface ContentTypeCase {
  id: string;
  offering_output_modes: string[];
  accepted_output: string[];
  verdict: "publish" | "refuse_local";
  error_code?: string;
  retryable?: boolean;
}
interface Fixture {
  version: number;
  spec: string;
  measurement: { unit: string; extraction: string; comparison: string };
  sender_text: { default_max_inbound_chars: number; cases: SenderTextCase[] };
  envelope_size: { cases: EnvelopeSizeCase[] };
  content_type: { cases: ContentTypeCase[] };
  mirror: { same_code: boolean; same_retryable: boolean; nothing_published_on_refusal: boolean };
}

const F: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

/** A minimal manifest declaring (or not declaring) the fixture's cap. */
function manifestWith(fields: Partial<Manifest>): Manifest {
  return {
    id: "UTEST",
    name: "t",
    description: "",
    version: "0.0.1",
    protocol_version: "0.2",
    endpoint: "mesh.agent.UTEST.inbox",
    node: {
      id: "UNODE",
      attestation: { node: "UNODE", agent: "UTEST", issued_at: "", expires_at: "", sig: "" },
    },
    capabilities: [],
    offerings: [],
    ...fields,
  };
}

// ── measurement: the sender's unit IS the receiver's unit ───────────────────

describe("§6.4b measurement — UTF-16 code units, the §22.5 ladder, strictly greater-than", () => {
  it("the fixture's default IS the SDK's §22.5 default — no parallel number", () => {
    expect(F.sender_text.default_max_inbound_chars).toBe(DEFAULT_MAX_INBOUND_CHARS);
  });

  it("counts UTF-16 code units, not scalar values: U+1F600 counts 2", () => {
    expect(inboundTextLength("😀")).toBe(2);
    expect(inboundTextLength("😀a")).toBe(3);
  });

  it("every fixture case with literal text measures exactly text_utf16_len", () => {
    for (const c of F.sender_text.cases) {
      if (c.text !== undefined) {
        expect(inboundTextLength(c.text), c.id).toBe(c.text_utf16_len);
      }
    }
  });
});

// ── sender_text cases ───────────────────────────────────────────────────────

describe("§6.4b sender_text — at-cap, over-by-one, the undeclared default, astral planes", () => {
  for (const c of F.sender_text.cases) {
    it(`${c.id}: cap=${c.declared_cap ?? "(default)"} len=${c.text_utf16_len} → ${c.verdict}`, () => {
      const manifest =
        c.declared_cap === null
          ? manifestWith({}) // no limits block at all: the §22.5 default governs
          : manifestWith({ limits: { max_inbound_chars: c.declared_cap } });
      const cap = effectiveInboundCap(manifest);
      expect(cap).toBe(c.declared_cap ?? F.sender_text.default_max_inbound_chars);
      // The literal text when the fixture pins one (the astral cases), else a
      // string of exactly the pinned UTF-16 length.
      const input = c.text ?? "x".repeat(c.text_utf16_len);
      expect(inboundTextLength(input)).toBe(c.text_utf16_len);
      if (c.verdict === "publish") {
        expect(() => preflightSenderText(input, cap)).not.toThrow();
      } else {
        let thrown: MeshError | undefined;
        try {
          preflightSenderText(input, cap);
        } catch (err) {
          thrown = err as MeshError;
        }
        expect(thrown?.code).toBe(c.error_code);
        expect(thrown?.retryable).toBe(c.retryable);
      }
    });
  }

  it("a manifest that is not at hand at all pre-flights against the §22.5 default", () => {
    expect(effectiveInboundCap(undefined)).toBe(DEFAULT_MAX_INBOUND_CHARS);
    expect(effectiveInboundCap(null)).toBe(DEFAULT_MAX_INBOUND_CHARS);
  });
});

// ── envelope_size cases ─────────────────────────────────────────────────────

describe("§6.4b envelope_size — the transport bound, at and over", () => {
  for (const c of F.envelope_size.cases) {
    it(`${c.id}: ${c.envelope_bytes} bytes vs max ${c.max_payload_bytes} → ${c.verdict}`, () => {
      if (c.verdict === "publish") {
        expect(() => preflightEnvelopeSize(c.envelope_bytes, c.max_payload_bytes)).not.toThrow();
      } else {
        let thrown: MeshError | undefined;
        try {
          preflightEnvelopeSize(c.envelope_bytes, c.max_payload_bytes);
        } catch (err) {
          thrown = err as MeshError;
        }
        expect(thrown?.code).toBe(c.error_code);
        expect(thrown?.retryable).toBe(c.retryable);
        // error.details names the limit that fired, so an operator can tell
        // the two "too large" refusals apart while a caller never has to.
        expect(thrown?.details?.limit).toBe(c.details_limit);
      }
    });
  }
});

// ── content_type cases ──────────────────────────────────────────────────────

describe("§6.4b content_type — accepted_output vs the offering's output_modes", () => {
  for (const c of F.content_type.cases) {
    it(`${c.id}: offering produces [${c.offering_output_modes}] asked [${c.accepted_output}] → ${c.verdict}`, () => {
      const manifest = manifestWith({
        offerings: [
          {
            id: "work",
            name: "work",
            description: "",
            output_modes: c.offering_output_modes,
          },
        ],
      });
      if (c.verdict === "publish") {
        expect(() => preflightContentType(manifest, "work", c.accepted_output)).not.toThrow();
      } else {
        let thrown: MeshError | undefined;
        try {
          preflightContentType(manifest, "work", c.accepted_output);
        } catch (err) {
          thrown = err as MeshError;
        }
        expect(thrown?.code).toBe(c.error_code);
        expect(thrown?.retryable).toBe(c.retryable);
      }
    });
  }
});

// ── end to end: request() runs the same decisions before publishing ─────────

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

/** A fake connection whose registry serves one manifest, and which records
 *  every subject anything was sent to — the observable for the fixture's
 *  "nothing_published_on_refusal". */
function makeConn(target?: { manifest: Manifest }) {
  const registryKp = nkeys.createUser();
  const sentTo: string[] = [];
  const subs = new Map<string, (msg: unknown) => void>();
  /** §6.4 cutover: an agent-send's answer arrives at the REQUESTER's inbox;
   *  the reply subject is liveness-only. The fake routes accordingly. */
  const toRequesterInbox = (requester: string, data: Uint8Array) => {
    const subject = Subjects.agentInbox(requester);
    subs.get(subject)?.({ subject, data, reply: undefined, respond: () => true });
  };
  const conn = {
    sentTo,
    subs,
    toRequesterInbox,
    publish: vi.fn((subject: string) => {
      sentTo.push(subject);
    }),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      sentTo.push(subject);
      const req = decodeUnverified(data);
      const payload = subject.startsWith("mesh.registry.get.")
        ? (target?.manifest as unknown)
        : { status: "registered" };
      const bytes = encode(
        signEnvelope(
          createEnvelope({
            type: "respond",
            from: registryKp.getPublicKey(),
            to: req.from,
            in_reply_to: req.id,
            payload,
          }),
          registryKp,
        ),
      );
      if (!subject.startsWith("mesh.registry.")) toRequesterInbox(req.from, bytes);
      return { data: bytes };
    }),
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
      subs.set(subject, cb);
      return { unsubscribe: () => subs.delete(subject), drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    raw: { publish: () => {} },
    get isClosed() {
      return false;
    },
  };
  return conn;
}

/** A target agent's manifest, signed-shape enough for the cache: real key,
 *  declared cap, one offering, and a resolvable endpoints block. */
function targetManifest(opts: {
  kp: ReturnType<typeof nkeys.createUser>;
  cap?: number;
  inbox?: string;
}): Manifest {
  const id = opts.kp.getPublicKey();
  return manifestWith({
    id,
    endpoint: Subjects.agentInbox(id),
    endpoints: { inbox: opts.inbox ?? Subjects.agentInbox(id) },
    ...(opts.cap !== undefined ? { limits: { max_inbound_chars: opts.cap } } : {}),
    offerings: [
      { id: "work", name: "work", description: "", output_modes: ["text/plain"] },
    ],
  });
}

describe("§6.4b end to end — request() refuses locally and publishes nothing", () => {
  async function callerWith(manifest: Manifest) {
    const conn = makeConn({ manifest });
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);
    // The manifest comes to hand the way §14.4 says it does: via a lookup.
    await caller.getManifest(manifest.id);
    conn.sentTo.length = 0; // forget the lookup traffic; count only the send
    return { conn, caller };
  }

  it("over the declared cap: CONTEXT_TOO_LARGE locally, nothing published (mirror block)", async () => {
    expect(F.mirror.same_code).toBe(true);
    expect(F.mirror.nothing_published_on_refusal).toBe(true);
    const targetKp = nkeys.createUser();
    const { conn, caller } = await callerWith(targetManifest({ kp: targetKp, cap: 100 }));
    let thrown: MeshError | undefined;
    try {
      await caller.request(targetKp.getPublicKey(), "work", "x".repeat(101));
    } catch (err) {
      thrown = err as MeshError;
    }
    expect(thrown?.code).toBe(ErrorCode.CONTEXT_TOO_LARGE);
    expect(thrown?.retryable).toBe(false); // same retryable as §22.5's refusal
    expect(conn.sentTo).toEqual([]); // nothing published, so nothing signed or retried
  });

  it("at the declared cap: published — the comparison is strictly greater-than", async () => {
    const targetKp = nkeys.createUser();
    const { conn, caller } = await callerWith(targetManifest({ kp: targetKp, cap: 100 }));
    const result = await caller.request(targetKp.getPublicKey(), "work", "x".repeat(100));
    expect(result).toBeDefined();
    expect(conn.sentTo.length).toBeGreaterThan(0);
  });

  it("unsatisfiable accepted_output: CONTENT_TYPE_NOT_SUPPORTED locally, nothing published", async () => {
    const targetKp = nkeys.createUser();
    const { conn, caller } = await callerWith(targetManifest({ kp: targetKp }));
    let thrown: MeshError | undefined;
    try {
      await caller.request(targetKp.getPublicKey(), "work", "go", {
        accepted_output: ["image/png"],
      });
    } catch (err) {
      thrown = err as MeshError;
    }
    expect(thrown?.code).toBe(ErrorCode.CONTENT_TYPE_NOT_SUPPORTED);
    expect(thrown?.retryable).toBe(false);
    expect(conn.sentTo).toEqual([]);
  });

  it("an unknown recipient (no manifest at hand) pre-flights against the default — no forced fetch", async () => {
    const conn = makeConn();
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);
    const targetKp = nkeys.createUser();
    let thrown: MeshError | undefined;
    try {
      await caller.request(targetKp.getPublicKey(), "work", "x".repeat(DEFAULT_MAX_INBOUND_CHARS + 1));
    } catch (err) {
      thrown = err as MeshError;
    }
    expect(thrown?.code).toBe(ErrorCode.CONTEXT_TOO_LARGE);
    // No manifest lookup happened on the send path: the §22.5 default governed.
    expect(conn.sentTo.every((s) => !s.startsWith("mesh.registry."))).toBe(true);
    expect(conn.sentTo).toEqual([]);
  });
});

// ── §14.4 resolution: resolved endpoints win; construction is the fallback ──

describe("§14.4 resolution — a manifest at hand addresses by its endpoints block", () => {
  it("request() publishes to the manifest's endpoints.inbox, verbatim", async () => {
    const targetKp = nkeys.createUser();
    const resolvedSubject = "mesh030.agent.RENAMED.inbox"; // a renamed tree, §20.4's case
    const conn = makeConn({
      manifest: targetManifest({ kp: targetKp, inbox: resolvedSubject }),
    });
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);
    await caller.getManifest(targetKp.getPublicKey());
    conn.sentTo.length = 0;
    // The fake registry also answers agent sends; sign as the target.
    conn.request.mockImplementation(async (subject: string, data: Uint8Array) => {
      conn.sentTo.push(subject);
      const req = decodeUnverified(data);
      const bytes = encode(
        signEnvelope(
          createEnvelope({
            type: "respond",
            from: targetKp.getPublicKey(),
            to: req.from,
            in_reply_to: req.id,
            payload: { status: "completed", output: { ok: true } },
          }),
          targetKp,
        ),
      );
      conn.toRequesterInbox(req.from, bytes);
      return { data: bytes };
    });
    await caller.request(targetKp.getPublicKey(), "work", "go");
    expect(conn.sentTo).toEqual([resolvedSubject]);
  });

  it("without a manifest at hand, the SDK constructs — it is the convention's legitimate constructor", async () => {
    const targetKp = nkeys.createUser();
    const conn = makeConn();
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);
    conn.request.mockImplementation(async (subject: string, data: Uint8Array) => {
      conn.sentTo.push(subject);
      const req = decodeUnverified(data);
      const bytes = encode(
        signEnvelope(
          createEnvelope({
            type: "respond",
            from: targetKp.getPublicKey(),
            to: req.from,
            in_reply_to: req.id,
            payload: { status: "completed", output: { ok: true } },
          }),
          targetKp,
        ),
      );
      conn.toRequesterInbox(req.from, bytes);
      return { data: bytes };
    });
    await caller.request(targetKp.getPublicKey(), "work", "go");
    expect(conn.sentTo).toEqual([Subjects.agentInbox(targetKp.getPublicKey())]);
  });

  it("a wildcard-shaped endpoints value is never addressed — construction wins over a non-publishable subject", async () => {
    const targetKp = nkeys.createUser();
    const conn = makeConn({
      manifest: targetManifest({ kp: targetKp, inbox: "mesh.agent.>.inbox" }),
    });
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);
    await caller.getManifest(targetKp.getPublicKey());
    conn.sentTo.length = 0;
    conn.request.mockImplementation(async (subject: string, data: Uint8Array) => {
      conn.sentTo.push(subject);
      const req = decodeUnverified(data);
      const bytes = encode(
        signEnvelope(
          createEnvelope({
            type: "respond",
            from: targetKp.getPublicKey(),
            to: req.from,
            in_reply_to: req.id,
            payload: { status: "completed" },
          }),
          targetKp,
        ),
      );
      conn.toRequesterInbox(req.from, bytes);
      return { data: bytes };
    });
    await caller.request(targetKp.getPublicKey(), "work", "go");
    expect(conn.sentTo).toEqual([Subjects.agentInbox(targetKp.getPublicKey())]);
  });
});

// ── registration declares what senders pre-flight against ───────────────────

describe("§8.1 declaration — register() carries endpoints and a nonstandard cap", () => {
  it("declares endpoints.inbox always, and limits only when the cap differs from the default", async () => {
    const conn = makeConn();
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
      { maxInboundChars: 100 },
    );
    openAgents.push(agent);
    const manifest = await agent.register({ name: "declares" });
    expect(manifest.endpoints).toEqual({ inbox: Subjects.agentInbox(agent.id) });
    expect(manifest.limits).toEqual({ max_inbound_chars: 100 });
  });

  it("the default cap is NOT declared: absent means the protocol defaults apply (§8.2)", async () => {
    const conn = makeConn();
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(agent);
    const manifest = await agent.register({ name: "defaults" });
    expect(manifest.limits).toBeUndefined();
    expect(manifest.endpoints).toEqual({ inbox: Subjects.agentInbox(agent.id) });
  });
});
