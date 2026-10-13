// The owner allowance (extensions/EXT-8-allowance.md; SPEC.md §7.7, §19.3),
// asserted case by case against conformance/allowance.json.
//
// Like the other conformance suites, this file ITERATES the fixture instead of
// restating its cases: the fixture pins the places two independent node
// implementations drift — the document's shape and canonical serialization
// under the owner signature (tag agentmesh-allowance-v1), floor-rounded
// metering arithmetic, smallest-remaining ceiling precedence, the refusal
// field names, and both exhaustion behaviours.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src to agree with the fixture — never the fixture to agree
// with the code (the fixture changes only with a spec change alongside).
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope, fromB64Url } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode } from "../../src/types/errors.js";
import type { CostCeiling, Envelope } from "../../src/types/envelope.js";
import type { RespondPayload } from "../../src/types/primitives.js";
import {
  ALLOWANCE_SIG_PREFIX,
  validateAllowance,
  verifyAllowanceSignature,
  canonicalAllowanceJSON,
  signAllowance,
  loadAllowance,
  meterAllowanceCost,
  AllowanceEngine,
  type AllowanceDocument,
  type AllowanceCeiling,
  type AllowanceScope,
  type AllowanceAskOwnerHandler,
} from "../../src/allowance.js";

// ── the fixture ─────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(here, "..", "..", "..", "conformance", "allowance.json");

interface ApplicableCeiling {
  scope: AllowanceScope;
  amount_micro: number;
  spent_micro: number;
  context_id?: string;
}

interface PrecedenceCase {
  case: string;
  request_context_id?: string;
  applicable: ApplicableCeiling[];
  estimate_micro: number;
  binding_scope: AllowanceScope;
  remaining_micro: number;
  expect: "accept" | "refuse";
  why: string;
}

interface Fixture {
  version: number;
  identities: { sender_seed: string; sender: string; recipient: string };
  document: {
    signed_bytes_prefix: string;
    valid: { case: string; note: string; canonical: string; signed: AllowanceDocument }[];
    invalid: { case: string; document: Record<string, unknown>; why: string }[];
  };
  metering: {
    rounding: string;
    cases: { tokens: number; per_1k_tokens_micro: number; cost_micro: number; why: string }[];
  };
  precedence: { cases: PrecedenceCase[] };
  refusal: {
    budget_insufficient: { error_code: string; details: { estimate: CostCeiling } };
  };
  exhaustion: {
    refuse: { on_exhausted: string; expect: string };
    ask_owner: { on_exhausted: string; expect: string };
  };
}

const F: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

const ownerKp = () => nkeys.fromSeed(new TextEncoder().encode(F.identities.sender_seed));

// ── the tag ─────────────────────────────────────────────────────────────────

describe("EXT-8 §1 — the domain tag", () => {
  it("the fixture's signed_bytes_prefix IS this SDK's ALLOWANCE_SIG_PREFIX — no parallel string", () => {
    expect(F.document.signed_bytes_prefix).toBe(ALLOWANCE_SIG_PREFIX);
  });

  it("the fixture's roles hold: the published seed is the OWNER, the recipient key the governed agent", () => {
    expect(ownerKp().getPublicKey()).toBe(F.identities.sender);
    for (const v of F.document.valid) {
      expect(v.signed.owner_key).toBe(F.identities.sender);
      expect(v.signed.agent).toBe(F.identities.recipient);
    }
  });
});

// ── document.valid — the really-signed vectors ──────────────────────────────

describe("EXT-8 §1 document.valid — every valid vector loads, byte-exactly", () => {
  for (const v of F.document.valid) {
    describe(v.case, () => {
      it("reproduces the fixture's canonical bytes exactly (sig excluded, absent members omitted)", () => {
        expect(canonicalAllowanceJSON(v.signed)).toBe(v.canonical);
      });

      it("loadAllowance accepts it (shape + owner signature)", () => {
        expect(() => loadAllowance(v.signed)).not.toThrow();
        expect(verifyAllowanceSignature(v.signed)).toBe(true);
      });

      it("the signature covers signed_bytes_prefix + canonical, strictly tagged", () => {
        expect(
          nkeys
            .fromPublic(v.signed.owner_key)
            .verify(
              new TextEncoder().encode(ALLOWANCE_SIG_PREFIX + v.canonical),
              fromB64Url(v.signed.sig),
            ),
        ).toBe(true);
      });

      it("signAllowance with the owner seed reproduces the pinned signature byte-for-byte", () => {
        // Ed25519 is deterministic, so the owner-tooling sign path must land
        // on exactly the fixture's sig — this is what pins the sign path, not
        // just the verify path.
        const { sig: _drop, ...unsigned } = v.signed;
        expect(signAllowance(unsigned, ownerKp()).sig).toBe(v.signed.sig);
      });
    });
  }
});

// ── document.invalid — one stated reason each ───────────────────────────────

// The single fault each invalid case must be rejected FOR (matched against the
// rejection message, so a case failing for some other reason fails the test).
const INVALID_REASON: Record<string, RegExp> = {
  missing_sig: /unsigned/i,
  float_money: /integer.*never a float|never a float/i,
  unknown_scope: /closed enum/i,
  negative_amount: /non-negative/i,
  missing_cost_model: /cost_model.*required/i,
};

describe("EXT-8 §1 document.invalid — rejected for exactly the stated reason", () => {
  for (const { case: name, document, why } of F.document.invalid) {
    const reason = INVALID_REASON[name];
    it(`${name} (${why.slice(0, 70)}…)`, () => {
      expect(reason).toBeDefined(); // an invalid case this file does not know FAILS the suite
      expect(() => loadAllowance(document)).toThrowError(reason);
      // Shape rejection alone (no signature check) refuses it too — the SHAPE
      // is the fault, except for missing_sig where the absent sig IS the fault.
      expect(() => validateAllowance(document)).toThrowError(reason);
    });
  }

  it("every invalid case except missing_sig carries a GENUINE owner signature — shape rejection never depends on a signature failure", () => {
    for (const { case: name, document } of F.document.invalid) {
      expect(verifyAllowanceSignature(document)).toBe(name !== "missing_sig");
    }
  });
});

// ── metering — the pinned floor arithmetic ──────────────────────────────────

describe("EXT-8 §2 metering — cost_micro = floor(tokens × per_1k / 1000)", () => {
  it("the fixture pins FLOOR", () => {
    expect(F.metering.rounding).toBe("floor");
  });

  for (const c of F.metering.cases) {
    it(`${c.tokens} tokens @ ${c.per_1k_tokens_micro}/1k → ${c.cost_micro} (${c.why})`, () => {
      expect(meterAllowanceCost(c.tokens, c.per_1k_tokens_micro)).toBe(c.cost_micro);
    });
  }
});

// ── precedence — smallest remaining wins, driven through the real ledger ────
//
// Each case's `spent_micro` is seeded through the engine's own record() —
// never poked into internals — using a different task id than the decision's
// (task-ceiling spend must not apply), and a different UTC day for spend that
// must not land in the decision day's bucket.

const DECIDE_NOW = new Date("2026-07-29T12:00:00.000Z");
const OTHER_DAY = new Date("2026-07-28T12:00:00.000Z");
const DECIDE_TASK = "t-decide";

function engineFor(c: PrecedenceCase): AllowanceEngine {
  const kp = ownerKp();
  const ceilings: AllowanceCeiling[] = c.applicable.map((a) => ({
    scope: a.scope,
    amount_micro: a.amount_micro,
    ...(a.context_id !== undefined ? { context_id: a.context_id } : {}),
  }));
  const doc = signAllowance(
    {
      v: 1,
      agent: F.identities.recipient,
      cost_model: { per_1k_tokens_micro: 1500, currency: "USD" },
      ceilings,
      on_exhausted: "refuse",
      updated_at: "2026-07-28T15:00:00.000Z",
    },
    kp,
  );
  const engine = new AllowanceEngine(doc);
  c.applicable.forEach((a, i) => {
    if (a.spent_micro === 0) return;
    if (a.scope === "task") {
      // Accounted to the DECISION's own task on ANOTHER UTC day: the task
      // bucket accumulates across days, so only it carries the seed into the
      // decision (the other-day day bucket is irrelevant to it).
      engine.record(DECIDE_TASK, undefined, { cost_micro: a.spent_micro }, OTHER_DAY);
    } else if (a.scope === "context") {
      // Accounted to the ceiling's context on ANOTHER day, so only the
      // context bucket carries it into the decision.
      engine.record(`seed-${i}`, a.context_id ?? c.request_context_id, { cost_micro: a.spent_micro }, OTHER_DAY);
    } else {
      // Accounted on the decision's own UTC day, under a foreign task and no
      // context, so only the day bucket carries it.
      engine.record(`seed-${i}`, undefined, { cost_micro: a.spent_micro }, DECIDE_NOW);
    }
  });
  return engine;
}

describe("EXT-8 §2 precedence — the binding ceiling is the smallest REMAINING, never the most specific", () => {
  for (const c of F.precedence.cases) {
    it(`${c.case}: ${c.why.slice(0, 80)}…`, () => {
      const engine = engineFor(c);
      const d = engine.decide(DECIDE_TASK, c.request_context_id, c.estimate_micro, DECIDE_NOW);
      expect(d.binding).not.toBeNull();
      expect(d.binding!.scope).toBe(c.binding_scope);
      expect(d.binding!.remaining_micro).toBe(c.remaining_micro);
      expect(d.fits).toBe(c.expect === "accept");
    });
  }
});

// The admission boundary itself: "would exceed" is STRICT, so an estimate
// exactly equal to the binding ceiling's remaining balance ADMITS — spending
// exactly what you have left is within the allowance. Pinned here at the
// engine level; the fixture's precedence case for it (estimate_equals_remaining)
// is driven by the generic loop above the moment it lands in allowance.json.
describe("EXT-8 §2 admission boundary — equality admits", () => {
  it("estimate == remaining admits; one micro more refuses", () => {
    const doc = signAllowance(
      {
        v: 1,
        agent: F.identities.recipient,
        cost_model: { per_1k_tokens_micro: 1500, currency: "USD" },
        ceilings: [{ scope: "day", amount_micro: 100 }],
        on_exhausted: "refuse",
        updated_at: "2026-07-28T15:00:00.000Z",
      },
      ownerKp(),
    );
    const engine = new AllowanceEngine(doc);
    engine.record("prior-task", undefined, { cost_micro: 60 }, DECIDE_NOW);

    const equal = engine.decide(DECIDE_TASK, undefined, 40, DECIDE_NOW);
    expect(equal.binding!.remaining_micro).toBe(40);
    expect(equal.fits).toBe(true);

    const over = engine.decide(DECIDE_TASK, undefined, 41, DECIDE_NOW);
    expect(over.fits).toBe(false);

    // The degenerate corner of the same rule: once the ceiling is spent to
    // exactly zero remaining, a zero estimate still fits — and one micro does
    // not.
    engine.record("prior-task", undefined, { cost_micro: 40 }, DECIDE_NOW);
    const zeroLeft = engine.decide(DECIDE_TASK, undefined, 0, DECIDE_NOW);
    expect(zeroLeft.binding!.remaining_micro).toBe(0);
    expect(zeroLeft.fits).toBe(true);
    expect(engine.decide(DECIDE_TASK, undefined, 1, DECIDE_NOW).fits).toBe(false);
  });
});

// ── refusal + exhaustion, driven through a real dispatch ────────────────────

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

function makeConn() {
  const subs = new Map<string, (msg: unknown) => void>();
  const registryKp = nkeys.createUser();
  return {
    subs,
    // Loop back to a matching subscription, the way the broker would: since
    // the §6.4 cutover, responds travel by publish to the sender's inbox.
    publish: vi.fn((subject: string, data: Uint8Array) => {
      subs.get(subject)?.({ subject, data, reply: undefined, respond: () => true });
    }),
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
}

async function armedAgent(opts: {
  onExhausted: "refuse" | "ask_owner";
  dayCeilingMicro: number;
  onAskOwner?: AllowanceAskOwnerHandler;
  handler: (input: unknown) => unknown;
}) {
  const conn = makeConn();
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
  );
  openAgents.push(agent);
  const owner = nkeys.createUser();
  agent.onRequest("work", (input) => opts.handler(input));
  await agent.register({ name: "allowance-conformance" });
  agent.setAllowance(
    signAllowance(
      {
        v: 1,
        agent: agent.id,
        cost_model: { per_1k_tokens_micro: 1000, currency: "USD" },
        ceilings: [{ scope: "day", amount_micro: opts.dayCeilingMicro }],
        on_exhausted: opts.onExhausted,
        updated_at: new Date().toISOString(),
      },
      owner,
    ),
    {
      // Priced to exactly the fixture's pinned quote: 500000 tokens at
      // 1000 micro / 1k tokens = 500000 micro.
      estimateTokens: () => 500_000,
      ...(opts.onAskOwner ? { onAskOwner: opts.onAskOwner } : {}),
    },
  );
  return { conn, agent, owner };
}

function sendWork(conn: ReturnType<typeof makeConn>, agent: AgentMesh) {
  const senderKp: KeyPair = nkeys.createUser();
  const reqEnv = signEnvelope(
    createEnvelope({
      type: "request",
      from: senderKp.getPublicKey(),
      to: agent.id,
      payload: { offering: "work", input: "go" },
    }),
    senderKp,
  );
  const replies: Envelope[] = [];
  // §6.4 cutover: replies land on the SENDER's inbox (via the fake's publish
  // loopback), not on the reply subject.
  conn.subs.set(Subjects.agentInbox(senderKp.getPublicKey()), (m) => {
    replies.push(decode((m as { data: Uint8Array }).data));
  });
  conn.subs.get(Subjects.agentInbox(agent.id))!({
    subject: Subjects.agentInbox(agent.id),
    data: encode(reqEnv),
    reply: "_INBOX.allowance-conformance",
    respond: () => true,
  });
  return replies;
}

describe("EXT-8 §2 refusal — the pinned BUDGET_INSUFFICIENT shape, before any accept", () => {
  it("refuses at admission with details.estimate as the price quote; the refusal is the FIRST reply", async () => {
    const f = F.refusal.budget_insufficient;
    const handler = vi.fn(() => "never");
    const { conn, agent } = await armedAgent({
      onExhausted: "refuse",
      dayCeilingMicro: 0, // pinned shut
      handler,
    });
    const replies = sendWork(conn, agent);
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));

    // §6.4a ordering: an allowance-broke refusal is a refusal of admission —
    // it happens INSTEAD of an accept, never after one.
    expect(replies).toHaveLength(1);
    const refusal = replies[0];
    expect((refusal.payload as RespondPayload).status).not.toBe("accepted");
    expect(refusal.error).toMatchObject({
      code: f.error_code,
      retryable: false,
      details: f.details, // { estimate: { amount_micro: 500000, currency: "USD" } }
    });
    expect(f.error_code).toBe(ErrorCode.BUDGET_INSUFFICIENT);
    // No owner interaction, no work performed (exhaustion.refuse).
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("EXT-8 §2 exhaustion — on_exhausted decides", () => {
  it("ask_owner, owner declines: refuse with the SAME BUDGET_INSUFFICIENT shape; the handler never ran", async () => {
    const f = F.refusal.budget_insufficient;
    const handler = vi.fn(() => "never");
    const asked = vi.fn(async () => false);
    const { conn, agent } = await armedAgent({
      onExhausted: "ask_owner",
      dayCeilingMicro: 0,
      onAskOwner: asked,
      handler,
    });
    const replies = sendWork(conn, agent);
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));

    expect(asked).toHaveBeenCalledTimes(1);
    const q = asked.mock.calls[0]![0] as { estimate: CostCeiling | null; offering: string };
    expect(q.offering).toBe("work");
    expect(q.estimate).toEqual(f.details.estimate);

    expect(replies).toHaveLength(1);
    expect(replies[0].error).toMatchObject({ code: f.error_code, details: f.details });
    expect(handler).not.toHaveBeenCalled();
  });

  it("ask_owner, owner raises the ceiling: the held work proceeds — accept, then completion", async () => {
    const handler = vi.fn(() => "done");
    let ownerRef: KeyPair | null = null;
    let agentRef: AgentMesh | null = null;
    const asked = vi.fn(async () => {
      // The owner raises the ceiling: a fresh signed document replaces the
      // old one (the ledger survives), and only THEN does the host say yes.
      agentRef!.setAllowance(
        signAllowance(
          {
            v: 1,
            agent: agentRef!.id,
            cost_model: { per_1k_tokens_micro: 1000, currency: "USD" },
            ceilings: [{ scope: "day", amount_micro: 600_000 }],
            on_exhausted: "ask_owner",
            updated_at: new Date().toISOString(),
          },
          ownerRef!,
        ),
      );
      return true;
    });
    const { conn, agent, owner } = await armedAgent({
      onExhausted: "ask_owner",
      dayCeilingMicro: 0,
      onAskOwner: asked,
      handler,
    });
    ownerRef = owner;
    agentRef = agent;

    const replies = sendWork(conn, agent);
    await vi.waitFor(() =>
      expect(
        replies.some((e) => (e.payload as RespondPayload | undefined)?.status === "completed"),
      ).toBe(true),
    );

    expect(asked).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    // Admission completed only after the owner's raise: accept first, then the
    // substantive completion — never a refusal.
    expect((replies[0].payload as RespondPayload).status).toBe("accepted");
    const terminal = replies.find(
      (e) => (e.payload as RespondPayload | undefined)?.status === "completed",
    )!;
    expect(terminal.error ?? undefined).toBeUndefined();
  });

  it("ask_owner with NO owner channel registered degrades to the refusal — held work with nobody to ask would only hang the caller", async () => {
    const handler = vi.fn(() => "never");
    const { conn, agent } = await armedAgent({
      onExhausted: "ask_owner",
      dayCeilingMicro: 0,
      handler,
    });
    const replies = sendWork(conn, agent);
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    expect(replies[0].error).toMatchObject({ code: ErrorCode.BUDGET_INSUFFICIENT });
    expect(handler).not.toHaveBeenCalled();
  });
});
