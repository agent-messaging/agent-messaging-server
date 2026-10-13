// Trials at the node (Common Agent 7.7): the gate in handleInboxMessage, run
// through a real dispatch on a fake connection, plus the sender-side check.
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
import type { Envelope, Budget } from "../../src/types/envelope.js";
import type { RespondPayload } from "../../src/types/primitives.js";
import type { RequestContext } from "../../src/internal/offering-router.js";
import { signAllowance, type AllowanceCeiling } from "../../src/allowance.js";
import { preflightTrial } from "../../src/preflight.js";
import { MemoryTrialLedger, trialInputsOf, type TrialDeclaration, type TrialNodeOptions } from "../../src/trial.js";

const open: AgentMesh[] = [];
afterEach(async () => {
  for (const a of open.splice(0)) await a.close();
});

function makeConn() {
  const subs = new Map<string, (msg: unknown) => void>();
  const published: Array<{ subject: string; env: Envelope }> = [];
  const registryKp = nkeys.createUser();
  return {
    subs,
    published,
    publish: vi.fn((subject: string, data: Uint8Array) => {
      try { published.push({ subject, env: decode(data) }); } catch { /* not an envelope */ }
      subs.get(subject)?.({ subject, data, reply: undefined, respond: () => true });
    }),
    request: vi.fn(async (_subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      return {
        data: encode(signEnvelope(createEnvelope({
          type: "respond", from: registryKp.getPublicKey(), to: req.from, in_reply_to: req.id,
          payload: { status: "registered" },
        }), registryKp)),
      };
    }),
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
      subs.set(subject, cb);
      return { unsubscribe: () => subs.delete(subject), drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    raw: { publish: () => {} },
    get isClosed() { return false; },
  };
}

const TRIAL: TrialDeclaration = {
  who: "signed_in",
  shape: { inputs: [{ name: "focus", limit: { max_chars: 10 } }, { name: "site", limit: { max_pages: 3 } }], marked: true },
  limits: { per_requester_per_day: 1, per_day: 10 },
};

async function node(opts: {
  ceilings?: AllowanceCeiling[] | null;
  trials?: Record<string, TrialDeclaration>;
  trial?: Partial<TrialNodeOptions>;
  handler?: (input: unknown, ctx: RequestContext) => unknown;
}) {
  const conn = makeConn();
  const agent = AgentMesh.withConnection(conn as unknown as ConnectionManager, nkeys.createUser(), nkeys.createUser());
  open.push(agent);
  const seen: RequestContext[] = [];
  agent.onRequest("work", (input, ctx) => { seen.push(ctx); return opts.handler ? opts.handler(input, ctx) : "done"; });
  await agent.register({ name: "trial-node" });
  if (opts.ceilings !== null) {
    agent.setAllowance(signAllowance({
      v: 1, agent: agent.id,
      cost_model: { per_1k_tokens_micro: 1000, currency: "USD" },
      ceilings: opts.ceilings ?? [{ scope: "day", amount_micro: 10_000_000 }, { scope: "trial", amount_micro: 5_000_000 }],
      on_exhausted: "refuse",
      updated_at: new Date().toISOString(),
    }, nkeys.createUser()), { estimateTokens: () => 1000 });
  }
  agent.setTrials({
    trials: opts.trials ?? { work: TRIAL },
    describeSender: () => ({ signed_in: true, verified: false }),
    ...(opts.trial ?? {}),
  });
  return { conn, agent, seen };
}

function send(conn: ReturnType<typeof makeConn>, agent: AgentMesh, payload: Record<string, unknown>, extra: { budget?: Budget; sender?: KeyPair } = {}) {
  const kp = extra.sender ?? nkeys.createUser();
  const env = signEnvelope(createEnvelope({
    type: "request", from: kp.getPublicKey(), to: agent.id,
    payload: { offering: "work", ...payload },
    ...(extra.budget ? { budget: extra.budget } : {}),
  }), kp);
  const replies: Envelope[] = [];
  conn.subs.set(Subjects.agentInbox(kp.getPublicKey()), (m) => replies.push(decode((m as { data: Uint8Array }).data)));
  conn.subs.get(Subjects.agentInbox(agent.id))!({ subject: Subjects.agentInbox(agent.id), data: encode(env), reply: "_INBOX.trial", respond: () => true });
  return { replies, kp };
}

const terminal = (rs: Envelope[]) => rs.find((r) => (r.payload as RespondPayload | undefined)?.status !== "accepted");
const reasonOf = (r: Envelope | undefined) => (r?.error?.details as { reason?: string } | undefined)?.reason;

describe("trial gate at the node", () => {
  it("a trial carrying a budget is refused reason budget, before any accept, even with no trial offered", async () => {
    const { conn, agent, seen } = await node({ trials: {} });
    const { replies } = send(conn, agent, { input: "go", trial: true }, { budget: { revision: 0, cost_ceiling: { amount_micro: 1, currency: "USD" } } });
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    expect(replies).toHaveLength(1);
    expect(replies[0]!.error?.code).toBe(ErrorCode.TRIAL_REFUSED);
    expect(reasonOf(replies[0])).toBe("budget");
    expect((replies[0]!.error?.details as { quote?: unknown }).quote).toBeDefined();
    expect(seen).toHaveLength(0);
  });

  it("gatedBy application: the node decides nothing, skips the allowance, hands the trial to the application and marks the reply", async () => {
    // No trial declared and no trial ceiling: under the node's own gate this
    // would be refused, but the application in front of it decides.
    const { conn, agent, seen } = await node({ trials: {}, ceilings: [{ scope: "day", amount_micro: 10_000_000 }], trial: { gatedBy: "application" } });
    const { replies } = send(conn, agent, { input: "go", trial: true });
    await vi.waitFor(() => expect(terminal(replies)).toBeDefined());
    const done = terminal(replies)!;
    expect((done.payload as RespondPayload).status).toBe("completed");
    expect((done.payload as RespondPayload).trial).toBe(true);
    expect(seen[0]!.trial).toMatchObject({ trial: true });
  });

  it("an offering with no trial is refused not_offered with a quote", async () => {
    const { conn, agent } = await node({ trials: {} });
    const { replies } = send(conn, agent, { input: "go", trial: true });
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    expect(reasonOf(replies[0])).toBe("not_offered");
    expect((replies[0]!.error?.details as { quote: { words: string } }).quote.words).toMatch(/free/);
  });

  it("admits, counts once, hands the handler the trial context, meters trial spend, and marks the reply", async () => {
    const ledger = new MemoryTrialLedger();
    const { conn, agent, seen } = await node({
      trial: { ledger },
      handler: (_i, ctx) => { ctx.reportUsage({ cost_micro: 7 }); return "ok"; },
    });
    const { replies, kp } = send(conn, agent, { input: { focus: "short", site: "https://example.com/" }, trial: true });
    await vi.waitFor(() => expect(terminal(replies)).toBeDefined());
    const done = terminal(replies)!;
    expect((done.payload as RespondPayload).status).toBe("completed");
    expect((done.payload as RespondPayload).trial).toBe(true);
    expect(seen[0]!.trial).toMatchObject({ trial: true, requester: { id: kp.getPublicKey(), kind: "agent", signed_in: true } });
    expect(seen[0]!.trial!.caps).toEqual([{ input: "site", limit: { max_pages: 3 } }]);
    expect(ledger.counts(`agent:${kp.getPublicKey()}`, "work", new Date())).toEqual({ requester_day: 1, day: 1, requester_ever: 1 });
    const day = new Date().toISOString().slice(0, 10);
    expect(agent.allowanceLedger().by_trial_day[day]).toBe(7);
    expect(agent.allowanceLedger().by_day[day]).toBe(7);
  });

  it("the second trial from one requester past per_requester_per_day is refused requester_day with resets_at, and not counted", async () => {
    const ledger = new MemoryTrialLedger();
    const { conn, agent } = await node({ trial: { ledger } });
    const sender = nkeys.createUser();
    const a = send(conn, agent, { input: "hi", trial: true }, { sender });
    await vi.waitFor(() => expect(terminal(a.replies)).toBeDefined());
    const b = send(conn, agent, { input: "hi again", trial: true }, { sender });
    await vi.waitFor(() => expect(b.replies.length).toBeGreaterThan(0));
    expect(reasonOf(b.replies[0])).toBe("requester_day");
    expect((b.replies[0]!.error?.details as { resets_at?: string }).resets_at).toMatch(/T00:00:00.000Z$/);
    expect(ledger.counts(`agent:${sender.getPublicKey()}`, "work", new Date()).requester_day).toBe(1);
  });

  it("free text over a text input's trial limit is refused input", async () => {
    const { conn, agent } = await node({});
    const { replies } = send(conn, agent, { input: "this is far more than ten characters", trial: true });
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    expect(reasonOf(replies[0])).toBe("input");
    expect((replies[0]!.error?.details as { input?: string }).input).toBe("focus");
  });

  it("reads the trial from the Descriptor it is handed; free text does not count against a url input", async () => {
    const descriptor = {
      offerings: [{
        id: "work",
        inputs: [{ name: "site", kind: "url" }, { name: "focus", kind: "text" }],
        trial: { who: "anyone", shape: { inputs: [{ name: "site", limit: { max_chars: 5 } }] }, limits: { per_day: 5 } },
      }],
    };
    const { conn, agent, seen } = await node({ trials: {}, trial: { descriptor } });
    const { replies } = send(conn, agent, { input: "a long sentence well over five characters", trial: true });
    await vi.waitFor(() => expect(terminal(replies)).toBeDefined());
    expect((terminal(replies)!.payload as RespondPayload).status).toBe("completed");
    expect(seen[0]!.trial!.shape?.inputs?.[0]?.name).toBe("site");
    const over = send(conn, agent, { input: { site: "https://example.com/" }, trial: true });
    await vi.waitFor(() => expect(over.replies.length).toBeGreaterThan(0));
    expect(reasonOf(over.replies[0])).toBe("input");
  });

  it("no allowance at all refuses funds; an allowance with no trial ceiling refuses funds", async () => {
    const a = await node({ ceilings: null });
    const r1 = send(a.conn, a.agent, { input: "hi", trial: true });
    await vi.waitFor(() => expect(r1.replies.length).toBeGreaterThan(0));
    expect(reasonOf(r1.replies[0])).toBe("funds");
    const b = await node({ ceilings: [{ scope: "day", amount_micro: 10_000_000 }] });
    const r2 = send(b.conn, b.agent, { input: "hi", trial: true });
    await vi.waitFor(() => expect(r2.replies.length).toBeGreaterThan(0));
    expect(reasonOf(r2.replies[0])).toBe("funds");
  });

  it("a vouch is honoured only from a trusted host; a vouched visitor is not signed in", async () => {
    const host = nkeys.createUser();
    const { conn, agent, seen } = await node({ trial: { trustedHosts: [host.getPublicKey()] } });
    const vouch = { id: "vis_1", kind: "visitor", signed_in: true, verified: true };
    const fromHost = send(conn, agent, { input: "hi", trial: true, trial_requester: vouch }, { sender: host });
    await vi.waitFor(() => expect(fromHost.replies.length).toBeGreaterThan(0));
    expect(reasonOf(fromHost.replies[0])).toBe("not_eligible");
    const stranger = send(conn, agent, { input: "hi", trial: true, trial_requester: vouch });
    await vi.waitFor(() => expect(terminal(stranger.replies)).toBeDefined());
    expect((terminal(stranger.replies)!.payload as RespondPayload).status).toBe("completed");
    expect(seen.at(-1)!.trial!.requester.kind).toBe("agent");
    const account = send(conn, agent, { input: "hi", trial: true, trial_requester: { id: "acct_9", kind: "account", signed_in: true, verified: false } }, { sender: host });
    await vi.waitFor(() => expect(terminal(account.replies)).toBeDefined());
    expect(seen.at(-1)!.trial!.requester).toEqual({ id: "acct_9", kind: "account", signed_in: true, verified: false });
  });

  it("ordinary requests are untouched by the trial gate", async () => {
    const { conn, agent, seen } = await node({});
    const { replies } = send(conn, agent, { input: "this is far more than ten characters" });
    await vi.waitFor(() => expect(terminal(replies)).toBeDefined());
    expect((terminal(replies)!.payload as RespondPayload).status).toBe("completed");
    expect((terminal(replies)!.payload as RespondPayload).trial).toBeUndefined();
    expect(seen[0]!.trial).toBeUndefined();
  });
});

describe("trialInputsOf (the same rule as the reference adapter)", () => {
  const declared = [{ name: "brief", kind: "text" }, { name: "focus", kind: "text" }, { name: "customer web address", kind: "url" }];
  it("free text counts against every text input, not a url", () => {
    expect(trialInputsOf("hello", declared)).toEqual({ brief: "hello", focus: "hello" });
  });
  it("a labelled line is read for an input the inputs object does not give", () => {
    expect(trialInputsOf({ text: "brief: one\nfocus: two words", inputs: { "customer web address": "https://a.example/" } }, declared).focus).toBe("two words");
  });
  it("with an inputs object, free text is not counted against an input it leaves out", () => {
    expect(trialInputsOf({ text: "a long brief", inputs: { brief: "b" } }, declared).focus).toBeUndefined();
  });
});

describe("sender side", () => {
  it("preflightTrial refuses trial with a budget, and nothing else", () => {
    expect(() => preflightTrial(true, { revision: 0 })).toThrow(MeshError);
    try { preflightTrial(true, { revision: 0 }); } catch (e) {
      expect((e as MeshError).code).toBe(ErrorCode.TRIAL_REFUSED);
      expect((e as MeshError).details?.reason).toBe("budget");
    }
    expect(() => preflightTrial(true, undefined)).not.toThrow();
    expect(() => preflightTrial(false, { revision: 0 })).not.toThrow();
  });

  it("request() with trial and a budget is refused locally, before anything is published", async () => {
    const conn = makeConn();
    const agent = AgentMesh.withConnection(conn as unknown as ConnectionManager, nkeys.createUser(), nkeys.createUser());
    open.push(agent);
    const before = conn.publish.mock.calls.length;
    await expect(agent.request("someone", "work", "hi", { trial: true, budget: { revision: 0, cost_ceiling: { amount_micro: 1, currency: "USD" } } }))
      .rejects.toMatchObject({ code: ErrorCode.TRIAL_REFUSED });
    expect(conn.publish.mock.calls.length).toBe(before);
  });

  it("request() sets trial and trial_requester on the payload", async () => {
    const conn = makeConn();
    const agent = AgentMesh.withConnection(conn as unknown as ConnectionManager, nkeys.createUser(), nkeys.createUser());
    open.push(agent);
    const target = nkeys.createUser().getPublicKey();
    const sentTo = () => [...conn.publish.mock.calls, ...conn.request.mock.calls]
      .map((c) => { try { return decodeUnverified(c[1] as Uint8Array); } catch { return null; } })
      .filter((e): e is Envelope => !!e && e.type === "request" && e.to === target);
    void agent.request(target, "work", "hi", { trial: true, trial_requester: { id: "vis_2", kind: "visitor", signed_in: false, verified: false }, timeout_ms: 50 }).catch(() => {});
    await vi.waitFor(() => expect(sentTo().length).toBeGreaterThan(0));
    expect(sentTo()[0]!.payload).toMatchObject({ trial: true, trial_requester: { id: "vis_2", kind: "visitor" } });
  });
});
