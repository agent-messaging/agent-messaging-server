// The budget wire shapes (SPEC.md §7.7, §19.3, §12.2), asserted case by case
// against conformance/budget.json.
//
// Like inbound-protections.test.ts, this file ITERATES the fixture instead of
// restating its cases: the fixture pins the bytes two independent
// implementations (this SDK and sdk-rust) must agree on — the budget block's
// shape, the canonical serialization under the envelope signature, the refusal
// detail field names, revision ordering, and the deadline skew boundary.
// Adding a case to the JSON grows this suite without touching this file.
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
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import {
  signEnvelope,
  canonicalEnvelopeBytes,
  signedEnvelopeBytes,
  fromB64Url,
  ENVELOPE_SIG_PREFIX,
} from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { TaskTracker } from "../../src/internal/task-tracker.js";
import { ErrorCode, RETRYABLE_CODES } from "../../src/types/errors.js";
import { MAX_CLOCK_SKEW_AHEAD_MS } from "../../src/constants.js";
import {
  validateBudget,
  pastDeadline,
  budgetInsufficient,
  deadlineUnmeetable,
  BudgetExhaustedError,
} from "../../src/budget.js";
import type { Budget, CostCeiling, Envelope } from "../../src/types/envelope.js";
import type { RespondPayload } from "../../src/types/primitives.js";
import type { ConnectionManager } from "../../src/internal/connection.js";

// ── the fixture ─────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(here, "..", "..", "..", "conformance", "budget.json");

interface Fixture {
  version: number;
  spec: string;
  identities: { sender_seed: string; sender: string; recipient: string };
  block: {
    valid: Budget[];
    invalid: { case: string; block: unknown; why: string }[];
  };
  envelope: {
    /** The domain tag: `signed.sig` covers signed_bytes_prefix + canonical (§5.3). */
    signed_bytes_prefix: string;
    canonical: string;
    signed: Envelope;
  };
  revisions: {
    ordering_case: { applied_in_order: Budget[]; expect_current: Budget; why: string };
    absolute_case: { applied_in_order: Budget[]; expect_current: Budget; why: string };
  };
  refusals: {
    budget_insufficient: { error_code: string; details: { estimate: CostCeiling } };
    deadline_unmeetable: { error_code: string; details: { earliest_completion: string } };
    budget_exhausted_pause: {
      error_code: string;
      status: string;
      details: { spent: CostCeiling; estimate_to_finish: CostCeiling };
    };
    deadline_exceeded_marker: { error_code: string };
  };
  deadline: {
    skew_tolerance_ms: number;
    granularity_ms: number;
    cases: { deadline: string; now: string; past: boolean; why: string }[];
  };
}

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

// ── block.valid / block.invalid ─────────────────────────────────────────────

describe("§7.7 block.valid — every valid block passes validateBudget", () => {
  fixture.block.valid.forEach((block, i) => {
    it(`valid[${i}] ${JSON.stringify(block).slice(0, 60)}`, () => {
      expect(() => validateBudget(block)).not.toThrow();
    });
  });
});

describe("§7.7 block.invalid — every invalid block is rejected", () => {
  for (const { case: name, block, why } of fixture.block.invalid) {
    it(`${name} (${why})`, () => {
      expect(() => validateBudget(block)).toThrowError(
        expect.objectContaining({ code: ErrorCode.INVALID_ENVELOPE }),
      );
    });
  }
});

// ── envelope: canonical bytes and signature ─────────────────────────────────

describe("§5.2/§4.5 envelope — canonicalization and signature cover the budget", () => {
  it("reproduces the fixture's canonical bytes exactly from the signed envelope", () => {
    const canonical = new TextDecoder().decode(canonicalEnvelopeBytes(fixture.envelope.signed));
    expect(canonical).toBe(fixture.envelope.canonical);
  });

  it("the signature verifies via decode()", () => {
    expect(() => decode(encode(fixture.envelope.signed))).not.toThrow();
  });

  it("the signature covers signed_bytes_prefix + canonical, strictly tagged (§5.3)", () => {
    expect(fixture.envelope.signed_bytes_prefix).toBe(ENVELOPE_SIG_PREFIX);
    // Pin the TAGGED form directly: an untagged legacy signature would still
    // pass decode() via the 0.2 dual-accept, so this assertion is what holds
    // the fixture to the new scheme.
    expect(
      nkeys
        .fromPublic(fixture.envelope.signed.from)
        .verify(
          signedEnvelopeBytes(fixture.envelope.signed),
          fromB64Url(fixture.envelope.signed.sig!),
        ),
    ).toBe(true);
  });

  it("the carried budget block itself validates", () => {
    expect(() => validateBudget(fixture.envelope.signed.budget)).not.toThrow();
  });

  it("one changed micro-unit fails verification", () => {
    const tampered = structuredClone(fixture.envelope.signed);
    tampered.budget!.cost_ceiling!.amount_micro += 1;
    expect(() => decode(encode(tampered))).toThrowError(
      expect.objectContaining({ code: ErrorCode.IDENTITY_MISMATCH }),
    );
  });
});

// ── revisions: absolute, latest wins ────────────────────────────────────────

describe("§7.7 revisions — applied through the task tracker", () => {
  function runCase(name: "ordering_case" | "absolute_case") {
    const { applied_in_order, expect_current, why } = fixture.revisions[name];
    it(`${name}: ${why.slice(0, 70)}…`, () => {
      const tracker = new TaskTracker();
      tracker.create({
        id: "t1",
        requester: "R",
        responder: "S",
        offering: "work",
        state: "working",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        history: [],
        artifacts: [],
      });
      for (const rev of applied_in_order) {
        validateBudget(rev); // every fixture revision is a well-formed budget
        tracker.applyBudget("t1", rev);
      }
      expect(tracker.get("t1")!.budget).toEqual(expect_current);
    });
  }
  runCase("ordering_case");
  runCase("absolute_case");
});

// ── refusal shapes ──────────────────────────────────────────────────────────

describe("§12.2 refusals — codes and detail field names", () => {
  it("budget_insufficient: details.estimate, cost_ceiling-shaped", () => {
    const f = fixture.refusals.budget_insufficient;
    const err = budgetInsufficient(f.details.estimate);
    expect(err.toErrorObject()).toMatchObject({
      code: f.error_code,
      retryable: false,
      details: f.details,
    });
  });

  it("deadline_unmeetable: details.earliest_completion, an RFC-3339 instant", () => {
    const f = fixture.refusals.deadline_unmeetable;
    const err = deadlineUnmeetable(f.details.earliest_completion);
    expect(err.toErrorObject()).toMatchObject({
      code: f.error_code,
      retryable: false,
      details: f.details,
    });
  });

  it("budget_exhausted_pause: details.spent + details.estimate_to_finish ('spent', not 'spend')", () => {
    const f = fixture.refusals.budget_exhausted_pause;
    const err = new BudgetExhaustedError({
      spent: f.details.spent,
      estimate_to_finish: f.details.estimate_to_finish,
    });
    expect(err.toErrorObject()).toMatchObject({
      code: f.error_code,
      retryable: false,
      details: f.details,
    });
  });

  it("deadline_exceeded_marker: the code exists and is not retryable (a marker, never a refusal)", () => {
    const f = fixture.refusals.deadline_exceeded_marker;
    expect(ErrorCode.DEADLINE_EXCEEDED).toBe(f.error_code);
    expect(RETRYABLE_CODES.has(ErrorCode.DEADLINE_EXCEEDED)).toBe(false);
  });
});

// ── the pause, dispatched for real ──────────────────────────────────────────
//
// The fixture pins the whole pause reply — status input_required alongside
// error.code BUDGET_EXHAUSTED and the two detail blocks — so it is asserted
// against a real handler dispatch, not just the error class.

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

describe("§7.7 hitting the ceiling — the dispatched pause matches the fixture", () => {
  it("replies non-terminal input_required with the pinned error shape", async () => {
    const f = fixture.refusals.budget_exhausted_pause;
    const conn = makeConn();
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(agent);
    agent.onRequest("work", () => {
      throw new BudgetExhaustedError({
        spent: f.details.spent,
        estimate_to_finish: f.details.estimate_to_finish,
      });
    });
    await agent.register({ name: "budget-conformance" });

    const senderKp: KeyPair = nkeys.createUser();
    const reqEnv = signEnvelope(
      createEnvelope({
        type: "request",
        from: senderKp.getPublicKey(),
        to: agent.id,
        budget: fixture.block.valid[0],
        payload: { offering: "work", input: "go" },
      }),
      senderKp,
    );
    const replies: Uint8Array[] = [];
    // §6.4 cutover: replies land on the SENDER's inbox (via the fake's publish
    // loopback), not on the reply subject.
    conn.subs.set(Subjects.agentInbox(senderKp.getPublicKey()), (m) => {
      replies.push((m as { data: Uint8Array }).data);
    });
    conn.subs.get(Subjects.agentInbox(agent.id))!({
      subject: Subjects.agentInbox(agent.id),
      data: encode(reqEnv),
      reply: "_INBOX.conformance",
      respond: () => true,
    });
    // §6.4a: the ceiling is hit MID-WORK, after admission — so the accept
    // precedes the pause. The pause is the first substantive reply.
    const substantive = () =>
      replies
        .map((d) => decode(d))
        .find((e) => (e.payload as RespondPayload | undefined)?.status !== "accepted");
    await vi.waitFor(() => expect(substantive()).toBeDefined());

    const reply = substantive()!;
    expect((reply.payload as RespondPayload).status).toBe(f.status);
    expect(reply.error).toMatchObject({
      code: f.error_code,
      retryable: false,
      details: f.details,
    });
    // On a bare request the same reply carries the task_id that promotes to
    // deferred mode (§7.0).
    expect(typeof reply.task_id).toBe("string");
  });
});

// ── deadline cases ──────────────────────────────────────────────────────────

describe("§7.7 deadline.cases — §22.3 skew, second granularity, inclusive bounds", () => {
  it("the fixture's tolerance IS this SDK's §22.3 constant — no parallel number", () => {
    expect(fixture.deadline.skew_tolerance_ms).toBe(MAX_CLOCK_SKEW_AHEAD_MS);
  });

  for (const c of fixture.deadline.cases) {
    it(`${c.why} (deadline ${c.deadline}, now ${c.now}) → past=${c.past}`, () => {
      const budget: Budget = { revision: 0, deadline: c.deadline };
      expect(pastDeadline(budget, Date.parse(c.now))).toBe(c.past);
    });
  }
});
