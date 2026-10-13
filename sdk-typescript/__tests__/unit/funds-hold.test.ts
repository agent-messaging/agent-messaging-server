// The funds hold at admission (§19.5, docs/funds-hold-contract.md) — the
// balance half of the paid-work gate, which the agreement check never asked:
//
//   agreed + funds        → the handler runs, the hold stands for the draw
//   agreed + no funds     → INSUFFICIENT_FUNDS, before any work, one reply
//   agreed + no platform  → refused, because an unchecked balance is not a
//                           balance to spend against
//   free                  → neither service is reached at all
//   the work failed       → the hold goes back
//
// Driven through the real inbound dispatch (the agreement test's harness), so
// what is asserted is what an actual caller would receive.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode, MeshError } from "../../src/types/errors.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { RespondPayload } from "../../src/types/primitives.js";
import { signAgreement, type AgreementDocument } from "../../src/agreement.js";
import { insufficientFunds, loadFundsHoldResult, type FundsHoldRequest } from "../../src/funds.js";
import { skuDigest, type Sku } from "../../src/sku.js";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

const APPROVAL = "https://app.example.com/agreements/approve";
const TOP_UP = "https://app.example.com/credits";

const buyerKp = nkeys.createUser();
const buyerOwnerKp = nkeys.createUser();

interface State {
  agreements: AgreementDocument[];
  /** What `mesh.funds.hold` answers when the default (mesh) path is used. */
  holdAnswer?: Record<string, unknown>;
  /** An error object `mesh.funds.hold` answers with instead. */
  holdError?: { code: string; message: string; details?: Record<string, unknown>; retryable: boolean };
}

/** A connection double answering the registry `get`, `mesh.agreements.list`,
 *  `mesh.funds.hold` and `mesh.funds.release`. */
function makeConn(state: State) {
  const subs = new Map<string, (msg: unknown) => void>();
  const serviceKp = nkeys.createUser();
  const answer = (req: Envelope, payload: Record<string, unknown>, error?: unknown) =>
    encode(
      signEnvelope(
        createEnvelope({
          type: "respond",
          from: serviceKp.getPublicKey(),
          to: req.from,
          in_reply_to: req.id,
          payload,
          ...(error ? { error: error as never } : {}),
        }),
        serviceKp,
      ),
    );
  return {
    subs,
    holds: [] as Record<string, unknown>[],
    releases: [] as Record<string, unknown>[],
    publish: vi.fn((subject: string, data: Uint8Array) => {
      subs.get(subject)?.({ subject, data, reply: undefined, respond: () => true });
    }),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      if (subject === "mesh.agreements.list") {
        return {
          data: answer(req, {
            agreements: state.agreements.filter((a) => a.seller_agent === req.from),
          }),
        };
      }
      if (subject === "mesh.funds.hold") {
        conn.holds.push(req.payload as Record<string, unknown>);
        if (state.holdError) return { data: answer(req, { status: "failed" }, state.holdError) };
        return {
          data: answer(
            req,
            state.holdAnswer ?? {
              hold_id: "job:owner:seller:default:task",
              amount_micro: 1500,
              currency: "USD",
              free: false,
              simulated: true,
              available_after: 8500,
            },
          ),
        };
      }
      if (subject === "mesh.funds.release") {
        conn.releases.push(req.payload as Record<string, unknown>);
        return { data: answer(req, { released: true }) };
      }
      if (subject === Subjects.registryGet(buyerKp.getPublicKey())) {
        return {
          data: answer(req, { id: buyerKp.getPublicKey(), owner: buyerOwnerKp.getPublicKey() }),
        };
      }
      return { data: answer(req, { status: "registered" }) };
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
let conn: ReturnType<typeof makeConn>;

const paidSku = (amountMicro = 1500): Sku => ({
  sku: "default",
  covers: { agent: true },
  price: {
    model: "per_unit",
    currency: "USD",
    meter: "tokens_out",
    per: 1000,
    amount_micro: amountMicro,
  },
  provider: { id: "internal", checkout_url: APPROVAL },
});

const freeSku: Sku = {
  sku: "gratis",
  covers: { offerings: ["free-thing"] },
  price: { model: "free" },
  provider: { id: "internal" },
};

/** A seller with `work` (succeeds), `explodes` (throws) and `free-thing`. */
async function makeSeller(skus: Sku[], state: State) {
  conn = makeConn(state);
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
  );
  openAgents.push(agent);
  agent.onRequest("work", () => "did the work");
  agent.onRequest("free-thing", () => "free work");
  agent.onRequest("explodes", () => {
    throw new Error("the work broke");
  });
  await agent.register({ name: "funds-seller", skus });
  return agent;
}

function send(agent: AgentMesh, offering = "work"): Envelope[] {
  const reqEnv = signEnvelope(
    createEnvelope({
      type: "request",
      from: buyerKp.getPublicKey(),
      to: agent.id,
      payload: { offering, input: "please" },
    }),
    buyerKp,
  );
  const replies: Envelope[] = [];
  conn.subs.set(Subjects.agentInbox(buyerKp.getPublicKey()), (m) => {
    replies.push(decode((m as { data: Uint8Array }).data));
  });
  conn.subs.get(Subjects.agentInbox(agent.id))!({
    subject: Subjects.agentInbox(agent.id),
    data: encode(reqEnv),
    reply: "_INBOX.funds-unit",
    respond: () => true,
  });
  return replies;
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const terminalOf = (replies: Envelope[]) =>
  replies.find((e) => (e.payload as RespondPayload | undefined)?.status !== "accepted");

const agreementFor = (seller: string, digest: string): AgreementDocument =>
  signAgreement(
    {
      v: 1,
      seller_agent: seller,
      sku: "default",
      sku_digest: digest,
      agreed_at: "2026-09-12T09:00:00Z",
    } as never,
    buyerOwnerKp,
  );

/** A seller whose agreement is already in place, so every test below starts at
 *  the question the hold exists to answer. */
async function coveredSeller(state: State, skus: Sku[] = [paidSku()]) {
  const agent = await makeSeller(skus, state);
  state.agreements = [agreementFor(agent.id, await skuDigest(skus[0]))];
  return agent;
}

describe("free is the fast path", () => {
  it("an offering covered by a free SKU reaches neither service", async () => {
    const state: State = { agreements: [] };
    const agent = await makeSeller([paidSku(), freeSku], state);
    const replies = send(agent, "free-thing");
    await settle();
    expect((terminalOf(replies)?.payload as RespondPayload).output).toBe("free work");
    expect(conn.holds).toHaveLength(0);
    expect(conn.releases).toHaveLength(0);
  });

  it("an agent that declares no SKUs never asks for a hold", async () => {
    const state: State = { agreements: [] };
    const agent = await makeSeller([], state);
    const replies = send(agent);
    await settle();
    expect((terminalOf(replies)?.payload as RespondPayload).output).toBe("did the work");
    expect(conn.holds).toHaveLength(0);
  });

  it("no agreement refuses at the FIRST question and never asks the second", async () => {
    // A buyer who never accepted the terms is told to accept them, not told
    // about their balance — and the ledger is not troubled on their behalf.
    const state: State = { agreements: [] };
    const agent = await makeSeller([paidSku()], state);
    const replies = send(agent);
    await settle();
    expect(terminalOf(replies)?.error?.code).toBe(ErrorCode.AGREEMENT_REQUIRED);
    expect(conn.holds).toHaveLength(0);
  });
});

describe("the hold at admission", () => {
  it("a successful hold admits the work", async () => {
    const state: State = { agreements: [] };
    const agent = await coveredSeller(state);
    const replies = send(agent);
    await settle();
    const terminal = terminalOf(replies);
    expect(terminal?.error).toBeUndefined();
    expect((terminal?.payload as RespondPayload).output).toBe("did the work");
    expect(conn.holds).toHaveLength(1);
    // Delivered: the hold stands for the platform's draw, nothing is released.
    expect(conn.releases).toHaveLength(0);
  });

  it("names the job and NEVER an amount", async () => {
    // The seller names the job; the platform names the amount. A seller that
    // could state the figure is the one place where a hold and the charge that
    // follows it could disagree.
    const state: State = { agreements: [] };
    const agent = await coveredSeller(state);
    send(agent);
    await settle();
    const req = conn.holds[0];
    expect(req.consumer_owner).toBe(buyerOwnerKp.getPublicKey());
    expect(req.sku).toBe("default");
    expect(typeof req.job_id).toBe("string");
    expect(req.amount_micro).toBeUndefined();
    expect(req.amount).toBeUndefined();
    expect(req.currency).toBeUndefined();
    // No quantity either: at admission the work has not run.
    expect(req.quantity).toBeUndefined();
    // The seller is the verified envelope `from`, never a payload field.
    expect(req.seller).toBeUndefined();
    expect(req.seller_agent).toBeUndefined();
  });

  it("insufficient funds refuses with exactly one reply, before any work", async () => {
    const state: State = {
      agreements: [],
      holdError: {
        code: "INSUFFICIENT_FUNDS",
        message: "Balance 400 does not cover 1500 micro-units. Add funds at " + TOP_UP,
        details: { shortfall_micro: 1100, amount_micro: 1500, currency: "USD", top_up_url: TOP_UP },
        retryable: false,
      },
    };
    const agent = await coveredSeller(state);
    const replies = send(agent);
    await settle();

    expect(replies).toHaveLength(1); // the refusal is the first and only reply
    const terminal = replies[0];
    expect(terminal.error?.code).toBe(ErrorCode.INSUFFICIENT_FUNDS);
    expect(terminal.error?.retryable).toBe(false);
    expect((terminal.payload as RespondPayload).status).toBe("failed");
    const details = terminal.error?.details as Record<string, unknown>;
    // The platform's own figures survive — it is the only party that knows them.
    expect(details.shortfall_micro).toBe(1100);
    expect(details.top_up_url).toBe(TOP_UP);
    // And the SDK guarantees the SKU, the way the agreement refusal does.
    expect(details.sku).toBe("default");
    // No work ran, and nothing was released: a refused hold was never placed.
    expect(replies.some((e) => (e.payload as RespondPayload)?.output !== undefined)).toBe(false);
    expect(conn.releases).toHaveLength(0);
  });

  it("a platform outage refuses paid work, never gives it away", async () => {
    const state: State = { agreements: [] };
    const agent = await coveredSeller(state);
    agent.onFundsHold(async () => {
      throw new Error("funds service unreachable");
    });
    const replies = send(agent);
    await settle();

    const terminal = terminalOf(replies);
    expect(terminal?.error).toBeDefined();
    expect(replies.some((e) => (e.payload as RespondPayload)?.output !== undefined)).toBe(false);
    // But an outage is NOT a verdict about the buyer's balance: telling a
    // solvent buyer to top up would send them to a checkout over a fault of
    // ours. The honest code is the retryable one.
    expect(terminal?.error?.code).toBe(ErrorCode.AGENT_UNAVAILABLE);
    expect(terminal?.error?.retryable).toBe(true);
    expect(terminal?.error?.code).not.toBe(ErrorCode.INSUFFICIENT_FUNDS);
  });

  it("the hold door's own AGREEMENT_REQUIRED stays AGREEMENT_REQUIRED", async () => {
    // The hold door re-checks coverage against the LIVE terms and can disagree
    // with the coverage gate that ran a moment earlier (the seller re-priced in
    // between; the platform's registry read came back empty). The contract's
    // rule is that this refuses as a missing agreement, so the seller has one
    // refusal path and not two — and the buyer gets the approval URL, not a
    // shrug about an outage.
    const state: State = {
      agreements: [],
      holdError: {
        code: "AGREEMENT_REQUIRED",
        message: "No SKU 'default' stands in this seller's current terms",
        details: { sku: "default", sku_digest: "", approval_url: "" },
        retryable: false,
      },
    };
    const sku = paidSku();
    const agent = await coveredSeller(state, [sku]);
    const replies = send(agent);
    await settle();

    const terminal = terminalOf(replies);
    expect(terminal?.error?.code).toBe(ErrorCode.AGREEMENT_REQUIRED);
    const details = terminal?.error?.details as Record<string, unknown>;
    // Built from the SELLER's own terms, not echoed from the platform's blanks:
    // these are what this agent is actually selling on.
    expect(details.sku_digest).toBe(await skuDigest(sku));
    expect(details.approval_url).toBe(APPROVAL);
    expect(replies.some((e) => (e.payload as RespondPayload)?.output !== undefined)).toBe(false);
  });

  it("a malformed answer is not an admission", async () => {
    // Fail-closed on the one input a half-deployed platform most easily gets
    // wrong: an unreadable answer is not "the hold succeeded".
    const state: State = { agreements: [], holdAnswer: { ok: true } };
    const agent = await coveredSeller(state);
    const replies = send(agent);
    await settle();
    expect(terminalOf(replies)?.error).toBeDefined();
    expect(replies.some((e) => (e.payload as RespondPayload)?.output !== undefined)).toBe(false);
  });

  it("a zero-value answer admits and leaves nothing to release", async () => {
    // A zero-value agreement gives free work a RECORD, not a round trip — but
    // if one reaches the hold, `free: true` must admit rather than fail.
    const state: State = {
      agreements: [],
      holdAnswer: { hold_id: null, amount_micro: 0, free: true },
    };
    const agent = await coveredSeller(state);
    const replies = send(agent, "explodes");
    await settle();
    expect(terminalOf(replies)?.error?.code).toBe(ErrorCode.INTERNAL_ERROR); // the handler ran
    expect(conn.releases).toHaveLength(0); // and there was no hold to give back
  });

  it("goes over mesh.funds.hold by default, with no host wiring", async () => {
    const state: State = { agreements: [] };
    const agent = await coveredSeller(state);
    send(agent);
    await settle();
    expect(conn.request.mock.calls.some(([s]) => s === "mesh.funds.hold")).toBe(true);
  });
});

describe("settling the hold", () => {
  it("a failed task releases it", async () => {
    const state: State = { agreements: [] };
    const agent = await coveredSeller(state);
    const replies = send(agent, "explodes");
    await settle();
    expect(terminalOf(replies)?.error?.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(conn.releases).toHaveLength(1);
    expect(conn.releases[0].hold_id).toBe("job:owner:seller:default:task");
    expect(conn.releases[0].reason).toBe("task_failed");
  });

  it("a delivered task leaves it standing for the draw", async () => {
    const state: State = { agreements: [] };
    const agent = await coveredSeller(state);
    send(agent);
    await settle();
    expect(conn.releases).toHaveLength(0);
  });

  it("a released hold is released once, however many terminal points fire", async () => {
    const state: State = { agreements: [] };
    const agent = await coveredSeller(state);
    const released: string[] = [];
    agent.onFundsRelease(async (holdId) => {
      released.push(holdId);
    });
    send(agent, "explodes");
    await settle();
    expect(released).toHaveLength(1);
  });

  it("an offering with no handler releases rather than charging for nothing", async () => {
    const state: State = { agreements: [] };
    const agent = await coveredSeller(state);
    const replies = send(agent, "not-registered");
    await settle();
    expect(terminalOf(replies)?.error?.code).toBe(ErrorCode.OFFERING_NOT_FOUND);
    expect(conn.releases[0]?.reason).toBe("offering_not_found");
  });

  it("the application's own admit hook refusing releases what the gate held", async () => {
    const state: State = { agreements: [] };
    const agent = await coveredSeller(state);
    agent.onRequest(
      "picky",
      () => "never runs",
      {
        admit: () => {
          throw new MeshError(ErrorCode.UNAUTHORIZED, "not for you");
        },
      },
    );
    const replies = send(agent, "picky");
    await settle();
    expect(terminalOf(replies)?.error?.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(conn.releases[0]?.reason).toBe("admission_refused");
  });

  it("a release that cannot be sent leaves the hold to expiry, not to a second reply", async () => {
    // Expiry is the backstop, never the plan: a failing release must not turn
    // one failure into two, or make the buyer wait on it.
    const state: State = { agreements: [] };
    const agent = await coveredSeller(state);
    agent.onFundsRelease(async () => {
      throw new Error("release service down");
    });
    const replies = send(agent, "explodes");
    await settle();
    expect(replies).toHaveLength(2); // the accept and the one failure
    expect(terminalOf(replies)?.error?.code).toBe(ErrorCode.INTERNAL_ERROR);
  });
});

describe("the injectable seams", () => {
  it("onFundsHold replaces the platform call entirely", async () => {
    const state: State = { agreements: [] };
    const agent = await coveredSeller(state);
    const seen: FundsHoldRequest[] = [];
    agent.onFundsHold(async (req) => {
      seen.push(req);
      return { hold_id: "local-1", amount_micro: 1500, currency: "USD", free: false };
    });
    const replies = send(agent);
    await settle();
    expect((terminalOf(replies)?.payload as RespondPayload).output).toBe("did the work");
    expect(seen).toHaveLength(1);
    expect(conn.request.mock.calls.some(([s]) => s === "mesh.funds.hold")).toBe(false);
  });

  it("a host hook cannot admit paid work with a shape the contract does not define", async () => {
    const state: State = { agreements: [] };
    const agent = await coveredSeller(state);
    agent.onFundsHold(async () => ({ looks: "fine" }));
    const replies = send(agent);
    await settle();
    expect(terminalOf(replies)?.error).toBeDefined();
    expect(replies.some((e) => (e.payload as RespondPayload)?.output !== undefined)).toBe(false);
  });

  it("a host hook throwing INSUFFICIENT_FUNDS refuses in the buyer's words", async () => {
    const state: State = { agreements: [] };
    const agent = await coveredSeller(state);
    agent.onFundsHold(async () => {
      throw insufficientFunds({ sku: "default", shortfall_micro: 42, top_up_url: TOP_UP });
    });
    const replies = send(agent);
    await settle();
    const terminal = terminalOf(replies);
    expect(terminal?.error?.code).toBe(ErrorCode.INSUFFICIENT_FUNDS);
    expect((terminal?.error?.details as Record<string, unknown>).shortfall_micro).toBe(42);
  });
});

describe("loadFundsHoldResult", () => {
  it("reads a well-formed answer", () => {
    const r = loadFundsHoldResult({
      hold_id: "job:a:b:c:d",
      amount_micro: 1500,
      currency: "USD",
      free: false,
      simulated: true,
      available_after: 100,
    });
    expect(r).toEqual({
      hold_id: "job:a:b:c:d",
      amount_micro: 1500,
      currency: "USD",
      free: false,
      simulated: true,
      available_after: 100,
    });
  });

  it("reads the free short-circuit", () => {
    expect(loadFundsHoldResult({ hold_id: null, amount_micro: 0, free: true })).toEqual({
      hold_id: null,
      amount_micro: 0,
      free: true,
    });
  });

  it.each([
    ["not an object", "nope"],
    ["no hold_id and not free", { amount_micro: 10, free: false }],
    ["an empty hold_id", { hold_id: "", amount_micro: 10, free: false }],
    ["free AND a hold_id", { hold_id: "x", amount_micro: 0, free: true }],
    ["a missing amount", { hold_id: "x", free: false }],
    ["a negative amount", { hold_id: "x", amount_micro: -1, free: false }],
    ["a fractional amount", { hold_id: "x", amount_micro: 1.5, free: false }],
  ])("refuses %s", (_name, raw) => {
    expect(() => loadFundsHoldResult(raw)).toThrow(MeshError);
  });
});
