// The EXT-8 allowance HOOK FLOW: arming (setAllowance, fail-closed states),
// the host usage report (ctx.reportUsage inside a handler, mesh.reportUsage
// after the turn), the queryable ledger, the default and host-supplied
// estimators, the admission ordering against the accept signal and the
// per-offering admit hook, and the §19.3 spend report on the terminal respond.
// The wire shapes and pinned arithmetic live in allowance-conformance.test.ts;
// this file is about the machinery a HOST touches.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode, MeshError } from "../../src/types/errors.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { RespondPayload } from "../../src/types/primitives.js";
import {
  signAllowance,
  loadAllowance,
  allowanceDayOf,
  type AllowanceDocument,
  type AllowanceCeiling,
} from "../../src/allowance.js";

// ── harness (the budget-conformance dispatch double) ────────────────────────

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

async function makeAgent() {
  const conn = makeConn();
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
  );
  openAgents.push(agent);
  await agent.register({ name: "allowance-unit" });
  return { conn, agent };
}

function docFor(
  agent: AgentMesh,
  ownerKp: KeyPair,
  over: {
    ceilings?: AllowanceCeiling[];
    per1k?: number;
    currency?: string;
    onExhausted?: "refuse" | "ask_owner";
  } = {},
): AllowanceDocument {
  return signAllowance(
    {
      v: 1,
      agent: agent.id,
      cost_model: {
        per_1k_tokens_micro: over.per1k ?? 100,
        currency: over.currency ?? "USD",
      },
      ceilings: over.ceilings ?? [{ scope: "day", amount_micro: 10_000_000 }],
      on_exhausted: over.onExhausted ?? "refuse",
      updated_at: new Date().toISOString(),
    },
    ownerKp,
  );
}

function send(
  conn: ReturnType<typeof makeConn>,
  agent: AgentMesh,
  input: unknown,
  opts: { contextId?: string; offering?: string } = {},
) {
  const senderKp: KeyPair = nkeys.createUser();
  const reqEnv = signEnvelope(
    createEnvelope({
      type: "request",
      from: senderKp.getPublicKey(),
      to: agent.id,
      context_id: opts.contextId,
      payload: { offering: opts.offering ?? "work", input },
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
    reply: "_INBOX.allowance-unit",
    respond: () => true,
  });
  return replies;
}

const terminalOf = (replies: Envelope[]) =>
  replies.find((e) => (e.payload as RespondPayload | undefined)?.status !== "accepted");

// ── document handling (host-side) ───────────────────────────────────────────

describe("sign/load round trip", () => {
  it("signAllowance produces a document loadAllowance accepts; tampering breaks it", () => {
    const owner = nkeys.createUser();
    const doc = signAllowance(
      {
        v: 1,
        agent: nkeys.createUser().getPublicKey(),
        cost_model: { per_1k_tokens_micro: 1500, currency: "USD" },
        ceilings: [{ scope: "task", amount_micro: 500_000 }],
        on_exhausted: "refuse",
        updated_at: "2026-07-28T15:00:00.000Z",
      },
      owner,
    );
    expect(doc.owner_key).toBe(owner.getPublicKey());
    expect(() => loadAllowance(doc)).not.toThrow();

    const tampered = { ...doc, ceilings: [{ scope: "task" as const, amount_micro: 500_001 }] };
    expect(() => loadAllowance(tampered)).toThrowError(
      expect.objectContaining({ code: ErrorCode.IDENTITY_MISMATCH }),
    );
  });
});

// ── arming and the fail-closed state ────────────────────────────────────────

describe("setAllowance — arming, fail-closed, clearing", () => {
  it("a valid document arms valid; the status is observable", async () => {
    const { agent } = await makeAgent();
    const status = agent.setAllowance(docFor(agent, nkeys.createUser()));
    expect(status.valid).toBe(true);
    expect(status.error).toBeUndefined();
    expect(agent.allowanceStatus()).toMatchObject({ valid: true, on_exhausted: "refuse" });
  });

  it("a broken document arms FAIL-CLOSED: valid false, error set, and admission refuses everything", async () => {
    const { conn, agent } = await makeAgent();
    const handler = vi.fn(() => "never");
    agent.onRequest("work", handler);
    const doc = docFor(agent, nkeys.createUser());
    const status = agent.setAllowance({ ...doc, sig: undefined }); // unsigned
    expect(status.valid).toBe(false);
    expect(status.error).toMatch(/unsigned/i);

    const replies = send(conn, agent, "hello");
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    expect(replies).toHaveLength(1); // no accept — refusal of admission
    expect(replies[0].error).toMatchObject({ code: ErrorCode.BUDGET_INSUFFICIENT });
    expect(handler).not.toHaveBeenCalled();
  });

  it("a document governing a DIFFERENT agent fails closed too — one document per agent", async () => {
    const { agent } = await makeAgent();
    const owner = nkeys.createUser();
    const strangers = signAllowance(
      {
        v: 1,
        agent: nkeys.createUser().getPublicKey(), // not this agent
        cost_model: { per_1k_tokens_micro: 100, currency: "USD" },
        ceilings: [{ scope: "day", amount_micro: 10_000_000 }],
        on_exhausted: "refuse",
        updated_at: new Date().toISOString(),
      },
      owner,
    );
    const status = agent.setAllowance(strangers);
    expect(status.valid).toBe(false);
    expect(status.error).toMatch(/governs/);
  });

  it("a valid replacement repairs the fail-closed state, and clearAllowance disarms entirely", async () => {
    const { conn, agent } = await makeAgent();
    agent.onRequest("work", () => "ok");
    const owner = nkeys.createUser();
    agent.setAllowance({ nonsense: true });
    expect(agent.allowanceStatus()!.valid).toBe(false);

    agent.setAllowance(docFor(agent, owner));
    expect(agent.allowanceStatus()!.valid).toBe(true);
    const replies = send(conn, agent, "hello");
    await vi.waitFor(() => expect(terminalOf(replies)).toBeDefined());
    expect((terminalOf(replies)!.payload as RespondPayload).status).toBe("completed");

    agent.clearAllowance();
    expect(agent.allowanceStatus()).toBeNull();
    expect(agent.allowanceLedger()).toEqual({
      currency: null,
      entries: [],
      total_micro: 0,
      by_task: {},
      by_context: {},
      by_day: {},
      by_trial_day: {},
    });
  });
});

// ── the usage hook and the ledger ───────────────────────────────────────────

describe("ctx.reportUsage / reportUsage — the host supplies usage, the SDK meters", () => {
  it("a handler reports { tokens }; the ledger accounts floor-metered spend to task, context and UTC day; the terminal respond carries cost (§19.3)", async () => {
    const { conn, agent } = await makeAgent();
    agent.setAllowance(docFor(agent, nkeys.createUser(), { per1k: 100 }));
    agent.onRequest("work", (_input, ctx) => {
      ctx.reportUsage({ tokens: 333 }); // 33.3 → floors to 33
      return "done";
    });

    const replies = send(conn, agent, "hello", { contextId: "meetup-s1-e4" });
    await vi.waitFor(() => expect(terminalOf(replies)).toBeDefined());
    const terminal = terminalOf(replies)!;
    const payload = terminal.payload as RespondPayload;
    expect(payload.status).toBe("completed");
    expect(payload.cost).toEqual({ amount_micro: 33, currency: "USD" });

    const ledger = agent.allowanceLedger();
    const today = allowanceDayOf(new Date());
    expect(ledger.currency).toBe("USD");
    expect(ledger.total_micro).toBe(33);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      context_id: "meetup-s1-e4",
      day: today,
      tokens: 333,
      cost_micro: 33,
    });
    expect(ledger.by_task[ledger.entries[0].task_id]).toBe(33);
    expect(ledger.by_context["meetup-s1-e4"]).toBe(33);
    expect(ledger.by_day[today]).toBe(33);
  });

  it("{ cost_micro } is money directly — no conversion; it wins over tokens when both are present", async () => {
    const { conn, agent } = await makeAgent();
    agent.setAllowance(docFor(agent, nkeys.createUser()));
    agent.onRequest("work", (_input, ctx) => {
      ctx.reportUsage({ tokens: 1_000_000, cost_micro: 7 });
      return "done";
    });
    const replies = send(conn, agent, "hello");
    await vi.waitFor(() => expect(terminalOf(replies)).toBeDefined());
    expect((terminalOf(replies)!.payload as RespondPayload).cost).toEqual({
      amount_micro: 7,
      currency: "USD",
    });
  });

  it("the host-side twin: reportUsage(taskId, usage) after the turn, accumulating across reports", async () => {
    const { agent } = await makeAgent();
    agent.setAllowance(docFor(agent, nkeys.createUser(), { per1k: 1500 }));
    const entry = agent.reportUsage("t-after", { tokens: 1000 }, "evening-run");
    expect(entry).toMatchObject({ task_id: "t-after", context_id: "evening-run", cost_micro: 1500 });
    agent.reportUsage("t-after", { cost_micro: 500 });
    expect(agent.allowanceLedger().by_task["t-after"]).toBe(2000);
    expect(agent.allowanceLedger().total_micro).toBe(2000);
  });

  it("without ANY allowance armed there is nothing to meter against: reportUsage returns null and the respond carries no cost", async () => {
    const { conn, agent } = await makeAgent();
    agent.onRequest("work", (_input, ctx) => {
      ctx.reportUsage({ tokens: 1000 }); // no allowance armed — a no-op
      return "done";
    });
    expect(agent.reportUsage("t1", { tokens: 5 })).toBeNull();
    const replies = send(conn, agent, "hello");
    await vi.waitFor(() => expect(terminalOf(replies)).toBeDefined());
    expect((terminalOf(replies)!.payload as RespondPayload).cost).toBeUndefined();
  });

  it("usage with neither tokens nor cost_micro is refused loudly", async () => {
    const { agent } = await makeAgent();
    agent.setAllowance(docFor(agent, nkeys.createUser()));
    expect(() => agent.reportUsage("t1", {})).toThrowError(MeshError);
  });

  it("FAIL-CLOSED still keeps the books: usage records while admission refuses, and the repaired document inherits the spend", async () => {
    const { conn, agent } = await makeAgent();
    const owner = nkeys.createUser();
    const good = docFor(agent, owner, { per1k: 1500 });
    agent.onRequest("work", () => "never");

    const status = agent.setAllowance({ ...good, sig: undefined }); // unsigned → fail-closed
    expect(status.valid).toBe(false);

    // Bookkeeping continues: money directly, and tokens through the still-
    // readable declared model. Refusal stops NEW spend; it never erases books.
    expect(agent.reportUsage("t-held", { cost_micro: 500 })).toMatchObject({ cost_micro: 500 });
    expect(agent.reportUsage("t-held", { tokens: 1000 })).toMatchObject({ cost_micro: 1500 });
    expect(agent.allowanceLedger().by_task["t-held"]).toBe(2000);

    // …while every admission refuses.
    const replies = send(conn, agent, "hello");
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    expect(replies[0].error).toMatchObject({ code: ErrorCode.BUDGET_INSUFFICIENT });

    // The valid replacement inherits the outage's spend.
    agent.setAllowance(good);
    expect(agent.allowanceStatus()!.valid).toBe(true);
    expect(agent.allowanceLedger().by_task["t-held"]).toBe(2000);
  });

  it("a fail-closed document for a DIFFERENT agent keeps the books the same way", async () => {
    const { agent } = await makeAgent();
    const strangers = signAllowance(
      {
        v: 1,
        agent: nkeys.createUser().getPublicKey(),
        cost_model: { per_1k_tokens_micro: 100, currency: "USD" },
        ceilings: [{ scope: "day", amount_micro: 10_000_000 }],
        on_exhausted: "refuse",
        updated_at: new Date().toISOString(),
      },
      nkeys.createUser(),
    );
    expect(agent.setAllowance(strangers).valid).toBe(false);
    expect(agent.reportUsage("t1", { tokens: 333 })).toMatchObject({ cost_micro: 33 });
    expect(agent.allowanceLedger().total_micro).toBe(33);
  });

  it("replacing the document keeps the ledger — raising a ceiling does not forgive the morning's spend", async () => {
    const { agent } = await makeAgent();
    const owner = nkeys.createUser();
    agent.setAllowance(docFor(agent, owner));
    agent.reportUsage("t1", { cost_micro: 4200 });
    agent.setAllowance(docFor(agent, owner, { ceilings: [{ scope: "day", amount_micro: 99_000_000 }] }));
    expect(agent.allowanceLedger().total_micro).toBe(4200);
  });
});

// ── estimation and admission ────────────────────────────────────────────────

describe("admission — estimation, enforcement against the ledger, ordering", () => {
  it("the default estimator prices tokens ≈ ceil(sender-text chars / 4) through the cost model", async () => {
    // 8 chars → 2 tokens → at 1000 micro/1k tokens → 2 micro. A day ceiling of
    // 2 admits; after 1 micro of recorded spend the same estimate no longer
    // fits (2 > 1 remaining) and admission refuses.
    const { conn, agent } = await makeAgent();
    agent.setAllowance(
      docFor(agent, nkeys.createUser(), {
        per1k: 1000,
        ceilings: [{ scope: "day", amount_micro: 2 }],
      }),
    );
    agent.onRequest("work", () => "ok");

    const first = send(conn, agent, "12345678");
    await vi.waitFor(() => expect(terminalOf(first)).toBeDefined());
    expect((terminalOf(first)!.payload as RespondPayload).status).toBe("completed");

    agent.reportUsage("t-warmup", { cost_micro: 1 });
    const second = send(conn, agent, "12345678");
    await vi.waitFor(() => expect(second.length).toBeGreaterThan(0));
    expect(second[0].error).toMatchObject({
      code: ErrorCode.BUDGET_INSUFFICIENT,
      details: { estimate: { amount_micro: 2, currency: "USD" } },
    });
  });

  it("a host estimator overrides the default", async () => {
    const { conn, agent } = await makeAgent();
    const estimator = vi.fn(() => 1_000_000); // 1M tokens: far over any ceiling here
    agent.setAllowance(
      docFor(agent, nkeys.createUser(), { ceilings: [{ scope: "task", amount_micro: 500 }] }),
      { estimateTokens: estimator },
    );
    agent.onRequest("work", () => "never");
    const replies = send(conn, agent, "x");
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    expect(estimator).toHaveBeenCalledTimes(1);
    expect(replies[0].error).toMatchObject({ code: ErrorCode.BUDGET_INSUFFICIENT });
  });

  it("the allowance check is SDK-automatic and runs BEFORE the per-offering admit hook — an exhausted allowance refuses without consulting application code", async () => {
    const { conn, agent } = await makeAgent();
    const admit = vi.fn();
    const handler = vi.fn(() => "never");
    agent.onRequest("work", handler, { admit });
    // per_1k high enough that even a short input estimates above zero — a
    // zero estimate legitimately FITS a pinned-shut ceiling (the fixture's
    // "0.999 floors to 0" case), which is not what this test is about.
    agent.setAllowance(
      docFor(agent, nkeys.createUser(), {
        per1k: 1_000_000,
        ceilings: [{ scope: "day", amount_micro: 0 }],
      }),
    );
    const replies = send(conn, agent, "hello");
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    expect(replies).toHaveLength(1); // the refusal is the first and only reply
    expect(replies[0].error).toMatchObject({ code: ErrorCode.BUDGET_INSUFFICIENT });
    expect(admit).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("when the work fits, the accept still precedes the handler and the ledger enforces the running total", async () => {
    // Task ceiling 100 micro; each request estimates 2 micro and REPORTS 60.
    // First request fits and completes; its recorded spend leaves 40 in the
    // day bucket, so the second request's 2-micro estimate still fits, but a
    // third after another 60 does not (120 > 100).
    const { conn, agent } = await makeAgent();
    agent.setAllowance(
      docFor(agent, nkeys.createUser(), {
        per1k: 1000,
        ceilings: [{ scope: "day", amount_micro: 100 }],
      }),
    );
    agent.onRequest("work", (_input, ctx) => {
      ctx.reportUsage({ cost_micro: 60 });
      return "ok";
    });

    for (const expected of ["completed", "completed"]) {
      const replies = send(conn, agent, "12345678");
      await vi.waitFor(() => expect(terminalOf(replies)).toBeDefined());
      expect((replies[0].payload as RespondPayload).status).toBe("accepted");
      expect((terminalOf(replies)!.payload as RespondPayload).status).toBe(expected);
    }

    const third = send(conn, agent, "12345678");
    await vi.waitFor(() => expect(third.length).toBeGreaterThan(0));
    expect(third).toHaveLength(1);
    expect(third[0].error).toMatchObject({ code: ErrorCode.BUDGET_INSUFFICIENT });
  });

  it("an estimate that exactly equals the remaining balance ADMITS at dispatch — 'would exceed' is strict", async () => {
    // Day ceiling 100; the host estimator prices the work at exactly 100.
    const { conn, agent } = await makeAgent();
    agent.setAllowance(
      docFor(agent, nkeys.createUser(), {
        per1k: 1000,
        ceilings: [{ scope: "day", amount_micro: 100 }],
      }),
      { estimateTokens: () => 100 }, // 100 tokens @ 1000/1k = exactly 100 micro
    );
    agent.onRequest("work", () => "ok");

    const replies = send(conn, agent, "hello");
    await vi.waitFor(() => expect(terminalOf(replies)).toBeDefined());
    expect((replies[0].payload as RespondPayload).status).toBe("accepted");
    expect((terminalOf(replies)!.payload as RespondPayload).status).toBe("completed");

    // One micro of recorded spend later, the same estimate no longer fits.
    agent.reportUsage("t-spend", { cost_micro: 1 });
    const second = send(conn, agent, "hello");
    await vi.waitFor(() => expect(second.length).toBeGreaterThan(0));
    expect(second[0].error).toMatchObject({
      code: ErrorCode.BUDGET_INSUFFICIENT,
      details: { estimate: { amount_micro: 100, currency: "USD" } },
    });
  });

  it("a context ceiling narrowed to one event refuses inside that context and admits outside it", async () => {
    const { conn, agent } = await makeAgent();
    agent.setAllowance(
      docFor(agent, nkeys.createUser(), {
        per1k: 1000,
        ceilings: [
          { scope: "context", context_id: "meetup-s1-e4", amount_micro: 0 },
          { scope: "day", amount_micro: 10_000_000 },
        ],
      }),
    );
    agent.onRequest("work", () => "ok");

    const inside = send(conn, agent, "hello", { contextId: "meetup-s1-e4" });
    await vi.waitFor(() => expect(inside.length).toBeGreaterThan(0));
    expect(inside[0].error).toMatchObject({ code: ErrorCode.BUDGET_INSUFFICIENT });

    const outside = send(conn, agent, "hello", { contextId: "some-other-context" });
    await vi.waitFor(() => expect(terminalOf(outside)).toBeDefined());
    expect((terminalOf(outside)!.payload as RespondPayload).status).toBe("completed");
  });
});
