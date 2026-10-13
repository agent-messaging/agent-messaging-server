/**
 * The gateway's side of the credits clearing. Pinned here:
 *
 *   - a priced attachment is discoverable as priced (priceForAgent), and a
 *     detached or free one is not;
 *   - a caller with NO account asking a priced agent gets 402 with
 *     agentmesh_code PAYMENT_REQUIRED before any mesh work happens;
 *   - a successful priced call settles caller → owner at the ledger with an
 *     idempotent txn id, and a same-account self-call does not;
 *   - an unreachable ledger reads as balance null — the pre-check's
 *     fail-closed input, because a broken till is not an open till.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisterOptions } from "../../sdk-typescript/src/types/options.js";
import { CREDITS_CURRENCY } from "../src/outbound/attach.js";
import { checkOperatorFee } from "../../sdk-typescript/src/sow.js";

const open: Server[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (open.length) {
    const s = open.pop()!;
    s.closeAllConnections?.();
    s.close();
  }
});

const storePath = () => join(mkdtempSync(join(tmpdir(), "credits-")), "attachments.json");

function card(base: string) {
  return {
    name: "Priced Studio",
    skills: [{ id: "tagline", name: "Tagline", description: "d" }],
    capabilities: { streaming: false },
    supportedInterfaces: [{ url: `${base}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  };
}

async function startRemote(): Promise<{ base: string }> {
  const remote = { base: "" };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(card(remote.base)));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString()) as { id: unknown };
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { message: { role: "ROLE_AGENT", parts: [{ data: { ok: true } }] } } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(server);
  remote.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return remote;
}

/**
 * A stub platform ledger: balances, charges, and the agent→account resolver.
 *
 * `charge` is switchable, because the three answers it can give are three
 * different facts and the settlement queue treats them differently: it took
 * the charge, it is not answering, or it refused the charge outright.
 */
type ChargeMode = "accept" | "down" | "refuse";
interface Ledger {
  base: string;
  charges: Record<string, unknown>[];
  mode: ChargeMode;
}

async function startLedger(
  balance = 1000,
  agentAccounts: Record<string, string | null> = {},
): Promise<Ledger> {
  const charges: Record<string, unknown>[] = [];
  const state = { mode: "accept" as ChargeMode };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (req.method === "GET" && url.startsWith("/internal/ledger/balance/")) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ balance }));
        return;
      }
      if (req.method === "GET" && url.startsWith("/internal/ledger/account-for-agent/")) {
        const key = decodeURIComponent(url.split("/").pop() ?? "");
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({ agent: key, account: agentAccounts[key] ?? null }),
        );
        return;
      }
      if (req.method === "POST" && url === "/internal/ledger/charge") {
        if (state.mode === "down") {
          res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "restarting" }));
          return;
        }
        if (state.mode === "refuse") {
          res.writeHead(422, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad retail: 8 (rate 9)" }));
          return;
        }
        charges.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, applied: true }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(server);
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    charges,
    get mode() { return state.mode; },
    set mode(m: ChargeMode) { state.mode = m; },
  };
}

interface Fake {
  bridge: import("../src/bridge.js").Bridge;
  handlers: Map<string, (input: unknown, ctx: unknown) => Promise<unknown>>;
  admits: Map<string, ((ctx: unknown) => void) | undefined>;
  accounts: Map<string, string | null>;
  cleared: Set<string>;
  registrations: number;
}

function fakeBridge(): Fake {
  const handlers = new Map<string, (input: unknown, ctx: unknown) => Promise<unknown>>();
  const admits = new Map<string, ((ctx: unknown) => void) | undefined>();
  const accounts = new Map<string, string | null>();
  const cleared = new Set<string>();
  let n = 0;
  const fake: Partial<Fake> = { registrations: 0 };
  const node = {
    addAgent: () => ({
      id: `UPRICED${(n++).toString().padStart(10, "0")}`,
      onRequest: (
        id: string,
        h: (input: unknown, ctx: unknown) => Promise<unknown>,
        options?: { admit?: (ctx: unknown) => void },
      ) => {
        handlers.set(id, h);
        admits.set(id, options?.admit);
      },
      register: async (_o: RegisterOptions) => {
        fake.registrations = (fake.registrations ?? 0) + 1;
      },
      deregister: async () => undefined,
    }),
    removeAgent: async () => true,
  };
  Object.assign(fake, {
    bridge: {
      meshNode: node,
      emitUsage: () => undefined,
      accountForAgentId: async (id: string) => accounts.get(id) ?? null,
      isHostedCaller: (id: string) => cleared.has(id),
    } as unknown as Fake["bridge"],
    handlers,
    admits,
    accounts,
    cleared,
  });
  return fake as Fake;
}

async function managerWith(ledgerBase: string | null | "off") {
  vi.resetModules();
  // null = clearing ON but unreachable (a broken till, fail closed);
  // "off" = no clearing service at all (the operator switch, config-refused).
  vi.stubEnv("CLEARING_URL", ledgerBase === "off" ? "" : ledgerBase ?? "http://127.0.0.1:1");
  const { AttachmentManager } = await import("../src/outbound/manager.js");
  const { FileAttachmentStore } = await import("../src/outbound/store.js");
  const fb = fakeBridge();
  const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(storePath()));
  return { m, fb };
}

/**
 * A manager whose records AND settlement queue live in a directory the test
 * names, so a second manager over the same directory is what a restart looks
 * like from the outside.
 */
async function managerIn(dir: string, ledgerBase: string) {
  vi.resetModules();
  vi.stubEnv("CLEARING_URL", ledgerBase);
  const { AttachmentManager } = await import("../src/outbound/manager.js");
  const { FileAttachmentStore } = await import("../src/outbound/store.js");
  const { SettlementQueue } = await import("../src/outbound/settlements.js");
  const fb = fakeBridge();
  const m = new AttachmentManager(
    fb.bridge,
    new FileAttachmentStore(join(dir, "attachments.json")),
    undefined,
    new SettlementQueue(join(dir, "settlements.json")),
  );
  return { m, fb };
}

const queueFile = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "settlements.json"), "utf8")) as Array<Record<string, unknown>>;

describe("the credits currency code", () => {
  it("is ISO 4217 shaped — budget.ts and the EXT-8 fold both refuse anything else", () => {
    // "CREDITS" (7 letters) shipped once: callers could never offer a credits
    // ceiling and every spend fold silently accounted nothing. Pin the shape.
    expect(CREDITS_CURRENCY).toMatch(/^[A-Z]{3}$/);
  });
});

describe("priceForAgent", () => {
  it("knows a priced attachment, and free or detached ones are null", async () => {
    const remote = await startRemote();
    const { m } = await managerWith(null);
    const priced = await m.create({ url: remote.base, accountId: "acct_owner", policy: { rateCredits: 5 } });
    // BRIDGE-A2A.md §9.2: the price a caller is quoted carries the operator's
    // cut inside it, on its own line. This is the example the mapping itself
    // prints: 10% of 5 rounds up to 1, and retail is 6. The cut is disclosed as
    // the fixed charge it is, because a percentage basis floors exactly under
    // Agent SoW 0.9.0-draft §5.5.8 and 10% of 5 floors to 0.
    expect(await m.priceForAgent(priced.agentId!)).toEqual({
      rate: 5,
      retail: 6,
      operatorFee: { operator: "agentmesh.ai", basis: { kind: "fixed", fixed: 1 }, base: 5, amount: 1 },
      ownerAccount: "acct_owner",
    });

    await m.patch(priced.id, { rateCredits: 0 });
    expect(await m.priceForAgent(priced.agentId!)).toBeNull();

    await m.patch(priced.id, { rateCredits: 3 });
    await m.detach(priced.id);
    expect(await m.priceForAgent(priced.agentId!)).toBeNull();
    await m.stop();
  });
});

describe("settlement", () => {
  it("posts caller → owner with an idempotent txn id after a successful call", async () => {
    const remote = await startRemote();
    const ledger = await startLedger();
    const { m, fb } = await managerWith(ledger.base);
    const rec = await m.create({ url: remote.base, accountId: "acct_owner", policy: { rateCredits: 7 } });
    fb.accounts.set("UCALLERAGENT", "acct_caller");

    await fb.handlers.get("tagline")!({ product: "x" }, { taskId: "task-1", envelope: { from: "UCALLERAGENT" } });
    await new Promise((r) => setTimeout(r, 50)); // settle is post-success, off the hot path
    expect(ledger.charges).toHaveLength(1);
    expect(ledger.charges[0]).toMatchObject({
      txnId: `${rec.id}:task-1`,
      caller: "acct_caller",
      owner: "acct_owner",
      rate: 7,
      retail: 8, // rate + the 10% markup, rounded up — the platform's margin
      // §9.2 rule 3: the settlement carries the same operator fee line the
      // refusal quoted, with the amount actually taken, so the arithmetic is
      // checkable after the fact rather than only before it.
      operator_fee: { operator: "agentmesh.ai", basis: { kind: "fixed", fixed: 1 }, base: 7, amount: 1 },
      ref: "tagline",
    });
    // The line is the one a reader can check, and it accounts for exactly the
    // difference between the two legs the charge posts.
    const fee = (ledger.charges[0] as { operator_fee: { amount: number } }).operator_fee;
    expect(checkOperatorFee(fee as never).ok).toBe(true);
    expect(fee.amount).toBe(8 - 7);
    await m.stop();
  });

  it("does not settle a self-call or an account-less caller", async () => {
    const remote = await startRemote();
    const ledger = await startLedger();
    const { m, fb } = await managerWith(ledger.base);
    await m.create({ url: remote.base, accountId: "acct_owner", policy: { rateCredits: 7 } });
    fb.accounts.set("USELFAGENT", "acct_owner");

    await fb.handlers.get("tagline")!({ product: "x" }, { taskId: "t1", envelope: { from: "USELFAGENT" } });
    await fb.handlers.get("tagline")!({ product: "x" }, { taskId: "t2", envelope: { from: "USTRANGER" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(ledger.charges).toHaveLength(0);
    await m.stop();
  });
});

/**
 * Settlement runs after the work succeeded and off the request path, because
 * the answer already went back to the caller and retracting it is not an
 * option. That is the right call and it stays.
 *
 * What used to come with it is not. The charge was a single un-awaited POST:
 * if the ledger was restarting for the two seconds it took, the charge was
 * gone. No record it had ever been owed, nothing to retry it, and nothing
 * anywhere that could tell anyone it had happened. Off the request path is not
 * the same as best effort, and this is the difference.
 */
describe("a settlement is written down before it is attempted", () => {
  const settleDir = () => mkdtempSync(join(tmpdir(), "settle-"));

  async function oneCall(m: import("../src/outbound/manager.js").AttachmentManager, fb: Fake, task: string) {
    const rec = await m.create({ url: (await startRemote()).base, accountId: "acct_owner", policy: { rateCredits: 7 } });
    fb.accounts.set("UCALLERAGENT", "acct_caller");
    await fb.handlers.get("tagline")!({ product: "x" }, { taskId: task, envelope: { from: "UCALLERAGENT" } });
    await new Promise((r) => setTimeout(r, 80));
    return rec;
  }

  it("survives a ledger that was down, and the next process finishes it", async () => {
    const dir = settleDir();
    const ledger = await startLedger();
    ledger.mode = "down";

    const { m, fb } = await managerIn(dir, ledger.base);
    const rec = await oneCall(m, fb, "task-1");

    // Nothing landed, and under the old shape that would have been the end of
    // it. Instead the attempt is on disk, waiting.
    expect(ledger.charges).toHaveLength(0);
    const queued = queueFile(dir);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      txnId: `${rec.id}:task-1`,
      state: "pending",
      attempts: 1,
      label: "Priced Studio",
    });
    expect((queued[0].body as Record<string, unknown>)).toMatchObject({
      caller: "acct_caller", owner: "acct_owner", rate: 7, retail: 8,
    });
    await m.stop();

    // The process died there. A new one comes up over the same directory, and
    // by then the ledger is back.
    ledger.mode = "accept";
    const { m: m2 } = await managerIn(dir, ledger.base);
    await m2.retrySettlements();

    expect(ledger.charges).toHaveLength(1);
    expect(ledger.charges[0]).toMatchObject({
      txnId: `${rec.id}:task-1`, caller: "acct_caller", owner: "acct_owner", rate: 7, retail: 8,
    });
    // And the queue is empty: the ledger holds it now, so nothing keeps a
    // second copy of it forever.
    expect(queueFile(dir)).toHaveLength(0);
    expect(await m2.unsettled()).toHaveLength(0);
    await m2.stop();
  });

  it("leaves nothing behind when the ledger takes it first time", async () => {
    const dir = settleDir();
    const ledger = await startLedger();
    const { m, fb } = await managerIn(dir, ledger.base);
    await oneCall(m, fb, "task-1");
    expect(ledger.charges).toHaveLength(1);
    expect(await m.unsettled()).toHaveLength(0);
    await m.stop();
  });

  it("abandons a charge the ledger refuses, and leaves it where it can be found", async () => {
    // A refusal is not an outage. The ledger understood the charge and said
    // no, so posting it eleven more times gets the same answer eleven more
    // times. It is given up on at once, with the ledger's own words, and the
    // record STAYS: an abandoned settlement is money somebody was owed for
    // work that was delivered, and the only way that is not lost silently is
    // if it is somewhere a person can look.
    const dir = settleDir();
    const ledger = await startLedger();
    ledger.mode = "refuse";
    const { m, fb } = await managerIn(dir, ledger.base);
    const rec = await oneCall(m, fb, "task-9");

    expect(ledger.charges).toHaveLength(0);
    const held = await m.unsettled();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ txnId: `${rec.id}:task-9`, state: "abandoned", attempts: 1 });
    expect(held[0].lastError).toContain("422");
    expect(held[0].abandonedReason).toContain("repeating it will not change that");
    expect(held[0].abandonedReason).toContain("bad retail");

    // It is not quietly retried once the ledger starts saying yes, either: the
    // answer was final, and reversing that is somebody's decision to make.
    ledger.mode = "accept";
    await m.retrySettlements();
    expect(ledger.charges).toHaveLength(0);
    expect(queueFile(dir)[0]).toMatchObject({ state: "abandoned" });
    await m.stop();
  });

  it("widens the gap between attempts rather than hammering a ledger that is down", async () => {
    const dir = settleDir();
    const ledger = await startLedger();
    ledger.mode = "down";
    const { m, fb } = await managerIn(dir, ledger.base);
    await oneCall(m, fb, "task-2");

    await m.retrySettlements();
    await m.retrySettlements();
    const [rec] = await m.unsettled();
    expect(rec.attempts).toBe(3);
    expect(rec.state).toBe("pending");
    // One minute, then two, then four: the third failure schedules the fourth
    // attempt four minutes out.
    expect(Date.parse(rec.nextAt) - Date.parse(rec.lastAt!)).toBe(4 * 60_000);
    await m.stop();
  });
});

describe("the §7.7 side: mesh-native clearing at admission", () => {
  const admitCall = (fb: Fake, from: string, budget?: unknown) =>
    (fb.admits.get("tagline") as unknown as (ctx: unknown) => Promise<void>)({ envelope: { from }, budget });

  it("refuses a caller that resolves to NO account, with RETAIL in XCR micro", async () => {
    const remote = await startRemote();
    const ledger = await startLedger(1000, {});
    const { m, fb } = await managerWith(ledger.base);
    await m.create({ url: remote.base, accountId: "acct_owner", policy: { rateCredits: 3 } });

    await expect(admitCall(fb, "USTRANGERMESHAGENT")).rejects.toMatchObject({
      code: "BUDGET_INSUFFICIENT",
      details: { estimate: { amount_micro: 4_000_000, currency: CREDITS_CURRENCY } },
    });
    await m.stop();
  });

  it("ADMITS a mesh caller whose account exists and is funded — the clearing", async () => {
    const remote = await startRemote();
    const ledger = await startLedger(1000, { UMESHCALLERAGENT: "acct_payer" });
    const { m, fb } = await managerWith(ledger.base);
    const rec = await m.create({ url: remote.base, accountId: "acct_owner", policy: { rateCredits: 3 } });

    await expect(admitCall(fb, "UMESHCALLERAGENT")).resolves.toBeUndefined();

    // ...and the successful call settles, naming the AGENT for the EXT-8 fold.
    await fb.handlers.get("tagline")!({ product: "x" }, { taskId: "mesh-t1", envelope: { from: "UMESHCALLERAGENT" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(ledger.charges).toHaveLength(1);
    expect(ledger.charges[0]).toMatchObject({
      txnId: `${rec.id}:mesh-t1`,
      caller: "acct_payer",
      owner: "acct_owner",
      rate: 3,
      retail: 4,
      spendAgentKey: "UMESHCALLERAGENT",
    });
    await m.stop();
  });

  it("refuses an empty pocket and a lowball CREDITS ceiling, each with the counter-offer", async () => {
    const remote = await startRemote();
    const ledger = await startLedger(1, { UPOORAGENT: "acct_poor" });
    const { m, fb } = await managerWith(ledger.base);
    await m.create({ url: remote.base, accountId: "acct_owner", policy: { rateCredits: 3 } });

    await expect(admitCall(fb, "UPOORAGENT")).rejects.toMatchObject({ code: "BUDGET_INSUFFICIENT" });
    await expect(
      admitCall(fb, "UPOORAGENT", { cost_ceiling: { amount_micro: 1_000_000, currency: CREDITS_CURRENCY } }),
    ).rejects.toMatchObject({
      code: "BUDGET_INSUFFICIENT",
      details: { estimate: { amount_micro: 4_000_000, currency: CREDITS_CURRENCY } },
    });
    await m.stop();
  });

  it("the owner's own agents call free; an unreachable resolver fails closed", async () => {
    const remote = await startRemote();
    const ledger = await startLedger(0, { UOWNERSAGENT: "acct_owner" });
    const { m, fb } = await managerWith(ledger.base);
    await m.create({ url: remote.base, accountId: "acct_owner", policy: { rateCredits: 3 } });
    await expect(admitCall(fb, "UOWNERSAGENT")).resolves.toBeUndefined();
    await m.stop();

    const remote2 = await startRemote();
    const { m: m2, fb: fb2 } = await managerWith(null); // dead resolver
    await m2.create({ url: remote2.base, accountId: "acct_owner", policy: { rateCredits: 3 } });
    await expect(admitCall(fb2, "UANYMESHAGENT")).rejects.toMatchObject({ code: "DEPENDENCY_FAILED" });
    await m2.stop();
  });

  it("admits the bridge's own cleared callers, and free attachments hook nothing", async () => {
    const remote = await startRemote();
    const { m, fb } = await managerWith(null);
    await m.create({ url: remote.base, accountId: "acct_owner", policy: { rateCredits: 3 } });
    fb.cleared.add("UCLEAREDCALLER");
    await expect(admitCall(fb, "UCLEAREDCALLER")).resolves.toBeUndefined();
    await m.stop();

    const remote2 = await startRemote();
    const { m: m2, fb: fb2 } = await managerWith(null);
    await m2.create({ url: remote2.base, accountId: "acct_owner" }); // free
    expect(fb2.admits.get("tagline")).toBeUndefined();
    await m2.stop();
  });

  it("a price change re-attaches immediately — free → priced must not stay open", async () => {
    const remote = await startRemote();
    const { m, fb } = await managerWith(null);
    const rec = await m.create({ url: remote.base, accountId: "acct_owner" });
    expect(fb.admits.get("tagline")).toBeUndefined();
    expect(fb.registrations).toBe(1);

    await m.patch(rec.id, { rateCredits: 2 });
    expect(fb.registrations).toBe(2); // re-attached, same identity
    expect(fb.admits.get("tagline")).toBeTypeOf("function");

    // And a non-price policy patch does NOT churn the registration.
    await m.patch(rec.id, { visibility: "unlisted" });
    expect(fb.registrations).toBe(2);
    await m.stop();
  });
});

describe("the operator switch: no clearing service at all", () => {
  it("refuses a rate at create and at patch, and free attachments work untouched", async () => {
    const remote = await startRemote();
    const { m } = await managerWith("off");
    await expect(
      m.create({ url: remote.base, accountId: "acct_owner", policy: { rateCredits: 3 } }),
    ).rejects.toMatchObject({ status: 422 });

    const free = await m.create({ url: remote.base, accountId: "acct_owner" });
    expect(free.state).toBe("active");
    await expect(m.patch(free.id, { rateCredits: 2 })).rejects.toMatchObject({ status: 422 });
    // OFF is a configuration, not an outage: rate zero stays patchable.
    await expect(m.patch(free.id, { visibility: "unlisted" })).resolves.toBeTruthy();
    await m.stop();
  });
});

describe("the fail-closed input", () => {
  it("an unreachable ledger reads as balance null", async () => {
    const { m } = await managerWith(null); // CLEARING_URL points at a dead port
    expect(await m.ledgerBalance("acct_x")).toBeNull();
    await m.stop();
  });
});
