/**
 * Security: a 0.4.0 call passes exactly the gates a 0.3.0 request passes
 * (CHANGELOG 0.67.0). Before 0.67.0 a 0.4.0 SendMessage naming an offering
 * reached a 0.3.0 `onRequest` handler (the legacy path, bindings/a2a.md §14)
 * and an A2A `serve` handler without the trial gate, the EXT-8 allowance,
 * the §19.5 agreement and funds hold, the admit hook or the accept signal.
 *
 * Each gate is checked three ways against the same server agent setup: a
 * 0.3.0 request, a 0.4.0 SendMessage reaching an `onRequest` handler, and a
 * 0.4.0 SendMessage reaching `a2a.serve`. A refusal is the same code on
 * every path and the handler never runs; each has a control that is
 * admitted. The admit hook and the handlers see one wire-neutral view of the
 * call (`ctx.call`, inbound-call.ts).
 */
import { describe, it, expect, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { makeBus, tick, type Bus } from "./a2a-bus.js";
import { MeshError, ErrorCode } from "../../src/types/errors.js";
import { budgetInsufficient } from "../../src/budget.js";
import type { RequestContext } from "../../src/internal/offering-router.js";
import type { AgentMesh } from "../../src/mesh.js";
import { signAgreement } from "../../src/agreement.js";
import { skuDigest, type Sku } from "../../src/sku.js";
import { isAcceptSignal } from "../../src/a2a/binding.js";
import { A2AError } from "../../src/a2a/errors.js";
import { EXT_BUDGET, withBudget, withOffering, withReceiptRequest, withTrial, forPerson } from "../../src/a2a/extensions.js";
import type { Message } from "../../src/a2a/types.js";
import type { InboundCall } from "../../src/inbound-call.js";
import { inboundCallOf } from "../../src/inbound-call.js";
import { signAllowance } from "../../src/allowance.js";

type Path = "0.3.0" | "legacy" | "serve";
const PATHS: Path[] = ["0.3.0", "legacy", "serve"];

let bus: Bus;
afterEach(async () => {
  await bus?.close();
});

const msg = (text = "please"): Message => ({ messageId: `m-${Math.random().toString(36).slice(2)}`, role: "ROLE_USER", parts: [{ text }] });

interface World {
  client: AgentMesh;
  server: AgentMesh;
  ran: Array<{ path: Path; call?: InboundCall; trial: boolean }>;
  admitted: RequestContext[];
}

/** One server agent: `onRequest("work")` for the 0.3.0 and legacy paths, or
 *  `a2a.serve` for the serve path. `admit` is installed on whichever. */
function world(path: Path, opts: { admit?: (ctx: RequestContext) => void | Promise<void>; fail?: boolean } = {}): World {
  bus = makeBus();
  const client = bus.agent();
  const server = bus.agent();
  (server as unknown as { manifest: unknown }).manifest = { id: server.id, name: "gated", offerings: [{ id: "work" }] };
  const ran: World["ran"] = [];
  const admitted: RequestContext[] = [];
  const admit = async (ctx: RequestContext) => {
    admitted.push(ctx);
    await opts.admit?.(ctx);
  };
  if (path === "serve") {
    server.a2a.serve(
      (_m, ctx) => {
        ran.push({ path, call: ctx.call, trial: !!ctx.trial });
        if (opts.fail) throw new A2AError("InternalError", "it broke");
        return { messageId: "r", role: "ROLE_AGENT", parts: [{ text: "did the work" }] };
      },
      { admit },
    );
  } else {
    server.onRequest(
      "work",
      (_input, ctx) => {
        ran.push({ path, call: ctx.call, trial: !!ctx.trial });
        if (opts.fail) throw new Error("it broke");
        return "did the work";
      },
      { admit },
    );
    // A node with only 0.3.0 handlers listens on its inbox once registered;
    // these tests do not register.
    (server as unknown as { listenInbox(): void }).listenInbox();
  }
  return { client, server, ran, admitted };
}

/** One call on a path; resolves to "ok" or the refusal's code. */
async function call(w: World, path: Path, o: { trial?: boolean; budget?: { revision: number; deadline?: string }; receipt?: "full" } = {}): Promise<string> {
  try {
    if (path === "0.3.0") {
      await w.client.request(w.server.id, "work", { text: "please" }, {
        timeout_ms: 2000,
        ...(o.trial ? { trial: true } : {}),
        ...(o.budget ? { budget: o.budget } : {}),
        ...(o.receipt ? { receipt: o.receipt } : {}),
      } as never);
    } else {
      let m = withOffering(msg(), "work");
      if (o.trial) m = withTrial(m);
      if (o.budget) m = withBudget(m, o.budget);
      if (o.receipt) m = withReceiptRequest(m, o.receipt);
      await w.client.a2a.sendMessage(w.server.id, m, { timeoutMs: 2000 });
    }
    return "ok";
  } catch (err) {
    return err instanceof MeshError || err instanceof A2AError ? err.code : String(err);
  }
}

describe("the trial gate", () => {
  it.each(PATHS)("%s: a trial the offering does not offer is refused with TRIAL_REFUSED, and nothing runs", async (path) => {
    const w = world(path);
    w.server.setTrials({ trials: {} });
    expect(await call(w, path, { trial: true })).toBe(ErrorCode.TRIAL_REFUSED);
    expect(w.ran).toEqual([]);
    expect(w.admitted).toEqual([]);
  });

  it.each(PATHS)("%s: a trial carrying a budget is refused", async (path) => {
    const w = world(path);
    w.server.setTrials({ trials: { work: { who: "anyone", limits: { per_requester_ever: 5 } } } });
    expect(await call(w, path, { trial: true, budget: { revision: 0, deadline: "2099-01-01T00:00:00Z" } })).toBe(ErrorCode.TRIAL_REFUSED);
    expect(w.ran).toEqual([]);
  });

  it.each(PATHS)("%s (control): an offered trial is admitted, counted, and the work knows it is a trial", async (path) => {
    const w = world(path);
    // A trial is paid for out of the trial ceiling of the owner's allowance.
    w.server.setAllowance(signAllowance({
      v: 1, agent: w.server.id,
      cost_model: { per_1k_tokens_micro: 1000, currency: "USD" },
      ceilings: [{ scope: "day", amount_micro: 10_000_000 }, { scope: "trial", amount_micro: 5_000_000 }],
      on_exhausted: "refuse",
      updated_at: new Date().toISOString(),
    } as never, nkeys.createUser()), { estimateTokens: () => 1000 });
    w.server.setTrials({ trials: { work: { who: "anyone", limits: { per_requester_ever: 1 } } } });
    expect(await call(w, path, { trial: true })).toBe("ok");
    expect(w.ran).toHaveLength(1);
    expect(w.ran[0]!.trial).toBe(true);
    expect(w.admitted[0]!.trial).toBeTruthy();
    // Counted: the second trial from the same requester is over the limit.
    expect(await call(w, path, { trial: true })).toBe(ErrorCode.TRIAL_REFUSED);
    expect(w.ran).toHaveLength(1);
  });
});

describe("the EXT-8 allowance", () => {
  it.each(PATHS)("%s: a fail-closed allowance refuses with BUDGET_INSUFFICIENT before anything runs", async (path) => {
    const w = world(path);
    w.server.setAllowance({ nonsense: true });
    expect(await call(w, path)).toBe(ErrorCode.BUDGET_INSUFFICIENT);
    expect(w.ran).toEqual([]);
    expect(w.admitted).toEqual([]);
  });

  it.each(PATHS)("%s (control): with no allowance armed the work runs", async (path) => {
    const w = world(path);
    expect(await call(w, path)).toBe("ok");
    expect(w.ran).toHaveLength(1);
  });
});

const ownerKp = nkeys.createUser();
const APPROVAL = "https://agentmesh.example/approve";
const paidSku: Sku = {
  sku: "default",
  covers: { agent: true },
  price: { model: "per_unit", currency: "USD", meter: "tokens_out", per: 1000, amount_micro: 1500 },
  provider: { id: "internal", checkout_url: APPROVAL },
};

/** Sell `work` under a paid SKU, the caller's account being `ownerKp`. */
async function sell(w: World, opts: { agreed: boolean }) {
  const s = w.server as unknown as {
    registerOpts: unknown;
    skuDigests: Map<string, string>;
    ownerOf: Map<string, { at: number; owner: string | null }>;
  };
  const digest = await skuDigest(paidSku);
  s.registerOpts = { name: "gated", skus: [paidSku] };
  s.skuDigests.set(paidSku.sku, digest);
  s.ownerOf.set(w.client.id, { at: Date.now(), owner: ownerKp.getPublicKey() });
  s.ownerOf.set(w.server.id, { at: Date.now(), owner: null });
  w.server.onAgreementLookup(async () =>
    opts.agreed ? [signAgreement({ v: 1, seller_agent: w.server.id, sku: "default", sku_digest: digest, agreed_at: "2026-08-02T15:00:00Z" } as never, ownerKp)] : [],
  );
}

describe("the §19.5 agreement and the funds hold", () => {
  it.each(PATHS)("%s: a paid offering the caller's account never agreed to is refused with AGREEMENT_REQUIRED", async (path) => {
    const w = world(path);
    await sell(w, { agreed: false });
    expect(await call(w, path)).toBe(ErrorCode.AGREEMENT_REQUIRED);
    expect(w.ran).toEqual([]);
  });

  it.each(PATHS)("%s: an account that cannot pay is refused with INSUFFICIENT_FUNDS", async (path) => {
    const w = world(path);
    await sell(w, { agreed: true });
    w.server.onFundsHold(async () => {
      throw new MeshError(ErrorCode.INSUFFICIENT_FUNDS, "not enough", { details: { amount_micro: 1500 } });
    });
    expect(await call(w, path)).toBe(ErrorCode.INSUFFICIENT_FUNDS);
    expect(w.ran).toEqual([]);
  });

  it.each(PATHS)("%s (control): agreed and funded, the work runs on a hold; work that fails gives the hold back", async (path) => {
    const w = world(path, { fail: true });
    await sell(w, { agreed: true });
    const holds: unknown[] = [];
    const released: Array<[string, string]> = [];
    w.server.onFundsHold(async (req) => {
      holds.push(req);
      return { hold_id: "hold-1", amount_micro: 1500, currency: "USD", free: false };
    });
    w.server.onFundsRelease(async (id, reason) => {
      released.push([id, reason]);
    });
    expect(await call(w, path)).not.toBe("ok");
    expect(w.ran).toHaveLength(1);
    expect(holds).toHaveLength(1);
    await tick(20);
    expect(released).toEqual([["hold-1", "task_failed"]]);
  });
});

describe("the admit hook", () => {
  it.each(PATHS)("%s: a refusal from admit is the first and only answer, and the handler never runs", async (path) => {
    const w = world(path, {
      admit: () => {
        throw budgetInsufficient({ amount_micro: 99, currency: "USD" });
      },
    });
    expect(await call(w, path)).toBe(ErrorCode.BUDGET_INSUFFICIENT);
    expect(w.ran).toEqual([]);
    expect(w.admitted).toHaveLength(1);
    // No accept went out before the refusal (§6.4a).
    expect(bus.log.some((l) => l.env.type === "respond" && (isAcceptSignal(l.env) || (l.env.payload as { status?: string } | undefined)?.status === "accepted"))).toBe(false);
  });

  it.each(PATHS)("%s: admit and the handler read one view of the call, whatever the wire", async (path) => {
    const w = world(path);
    expect(await call(w, path, { budget: { revision: 0, deadline: "2099-01-01T00:00:00Z" }, receipt: "full" })).toBe("ok");
    const seen = w.admitted[0]!.call!;
    expect(seen).toMatchObject({ offering: "work", budget: { revision: 0, deadline: "2099-01-01T00:00:00Z" }, trial: false, audience: "agent", receipt: "full" });
    expect(seen.wire).toBe(path === "0.3.0" ? "0.3.0" : "0.4.0");
    expect(w.admitted[0]!.budget).toMatchObject({ revision: 0 });
    expect(w.ran[0]!.call).toMatchObject({ offering: "work", receipt: "full" });
  });
});

describe("the accept signal", () => {
  it.each(PATHS)("%s: an admitted call is accepted before its answer", async (path) => {
    const w = world(path);
    expect(await call(w, path)).toBe("ok");
    const answers = bus.log.filter((l) => l.env.type === "respond" && l.env.to === w.client.id);
    const accept = answers.findIndex((l) => isAcceptSignal(l.env) || (l.env.payload as { status?: string } | undefined)?.status === "accepted");
    expect(accept).toBe(0);
    if (path !== "0.3.0") {
      expect(answers[0]!.env.v).toBe("0.4.0");
      expect(answers[0]!.env.payload).toEqual({ accepted: {} });
    }
  });

  it.each(["legacy", "serve"] as Path[])("%s: an attended inbox gets no accept, as on 0.3.0", async (path) => {
    const w = world(path);
    (w.server as unknown as { manifest: { interaction?: string } }).manifest.interaction = "interactive";
    await call(w, path);
    expect(bus.log.some((l) => l.env.type === "respond" && isAcceptSignal(l.env))).toBe(false);
  });
});

describe("the person surface and a malformed budget", () => {
  it.each(["legacy", "serve"] as Path[])("%s: a message for the person is surfaced and queued, never run", async (path) => {
    const w = world(path);
    const surfaced: unknown[] = [];
    w.server.onPersonMessage((m) => surfaced.push(m));
    const m = forPerson(withOffering(msg("for you"), "work"));
    const out = await w.client.a2a.sendMessage(w.server.id, m, { timeoutMs: 2000 }).then(() => "ok", (e: MeshError) => e.code);
    expect(out).toBe(ErrorCode.REQUEST_QUEUED);
    expect(w.ran).toEqual([]);
    expect(w.admitted).toEqual([]);
  });

  it.each(["legacy", "serve"] as Path[])("%s: a malformed budget extension is refused before any gate", async (path) => {
    const w = world(path);
    const m = withOffering(msg(), "work");
    m.metadata = { ...m.metadata, [EXT_BUDGET]: { revision: -1 } };
    const out = await w.client.a2a.sendMessage(w.server.id, m, { timeoutMs: 2000 }).then(() => "ok", (e: A2AError) => e.code);
    expect(out).toBe("InvalidParamsError");
    expect(w.ran).toEqual([]);
    expect(w.admitted).toEqual([]);
  });
});

describe("inboundCallOf", () => {
  it("reads the same facts from either wire", () => {
    const from = nkeys.createUser().getPublicKey();
    const old = inboundCallOf({ v: "0.3.0", id: "a", type: "request", from, to: "U", ts: "", budget: { revision: 1, deadline: "2099-01-01T00:00:00Z" }, task_id: "t1", payload: { offering: "work", input: { text: "hi" }, trial: true, config: { receipt: "summary" } } } as never);
    let m = withTrial(withReceiptRequest(withBudget(withOffering({ ...msg("hi"), taskId: "t1" }, "work"), { revision: 1, deadline: "2099-01-01T00:00:00Z" }), "summary"));
    m = { ...m };
    const neu = inboundCallOf({ v: "0.4.0", id: "b", type: "request", from, to: "U", ts: "", payload: { a2a: { method: "SendMessage", params: { message: m } } } } as never);
    for (const k of ["offering", "budget", "trial", "audience", "receipt", "taskId"] as const) expect(neu[k]).toEqual(old[k]);
    expect(neu.input).toEqual(old.input);
    expect(inboundCallOf({ v: "0.4.0", id: "c", type: "request", from, to: "U", ts: "", meta: { audience: "person" }, payload: { a2a: { method: "SendMessage", params: { message: msg() } } } } as never).audience).toBe("person");
  });
});
