/**
 * The business rules around the purchase: what happens when the laptop
 * cannot be found, the vendor is away, the approval says no, the manager has
 * to decide, the quote lapses, the price is changed, the order is sent twice,
 * or the order is cancelled before it ships.
 */
import { afterEach, describe, expect, it } from "vitest";
import { sleep, until } from "../src/mesh.js";
import { startScenario, type Scenario } from "../src/scenario.js";

let s: Scenario | undefined;
afterEach(async () => {
  await s?.stop();
  s = undefined;
});

describe("laptop purchase, when things go another way", () => {
  it("T2 requirements no laptop meets: the pricing agent says so and nothing else happens", async () => {
    s = await startScenario();
    const { output } = await s.requester.getQuote(s.ids.pricing.id, { ...s.cfg.requirements, ram_gb_min: 128 });
    expect(output).toEqual({ found: false, reason: "No laptop in our catalog meets those requirements." });
    expect(s.backend.quotes.size).toBe(0);
    expect(s.backend.orders.size).toBe(0);
  });

  it("T3 pricing agent offline: the synchronous call fails within its timeout instead of hanging", async () => {
    s = await startScenario();
    await s.pricing.stop();
    const started = Date.now();
    await expect(s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements)).rejects.toThrow();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(s.cfg.quote_timeout_ms - 250);
    expect(took).toBeLessThan(s.cfg.quote_timeout_ms + 3000);
  });

  it("T4a over budget: approval is refused and no order is placed", async () => {
    s = await startScenario();
    const req = { ...s.cfg.requirements, budget_usd: 1500 };
    const { output } = await s.requester.getQuote(s.ids.pricing.id, req);
    const d = await s.requester.approval(output.quote!, req, 30_000);
    expect(d.decision).toBe("rejected");
    expect(d.reason).toMatch(/over the \$1500 budget/);
    expect(s.backend.orders.size).toBe(0);
  });

  it("T4b the manager declines: no order is placed", async () => {
    s = await startScenario();
    s.approver.managerPolicy = () => "rejected";
    const req = { ...s.cfg.requirements, ram_gb_min: 64, screen_in_max: 17, budget_usd: 3500 };
    const { output } = await s.requester.getQuote(s.ids.pricing.id, req);
    expect(output.quote!.price_usd).toBeGreaterThan(s.cfg.auto_approve_limit_usd);
    const d = await s.requester.approval(output.quote!, req, s.cfg.approval_delay_ms + 30_000);
    expect(d).toMatchObject({ decision: "rejected", manager_reviewed: true });
    expect(s.backend.orders.size).toBe(0);
  });

  it("T5 above the auto-approve limit: the approval waits for the manager, then the order goes through", async () => {
    s = await startScenario();
    const req = { ...s.cfg.requirements, ram_gb_min: 64, screen_in_max: 17, budget_usd: 3500 };
    const { output } = await s.requester.getQuote(s.ids.pricing.id, req);
    const asked = await s.requester.askApproval(output.quote!, req);
    expect(asked.task_id, "the requester has a task while the manager decides").toBeTruthy();
    expect(asked.answeredInMs).toBeLessThan(s.cfg.approval_delay_ms);
    const started = Date.now();
    const d = await s.requester.awaitDecision(asked.task_id!, s.cfg.approval_delay_ms + 30_000);
    expect(Date.now() - started + asked.answeredInMs).toBeGreaterThanOrEqual(s.cfg.approval_delay_ms - 100);
    expect(d).toMatchObject({ decision: "approved", manager_reviewed: true, ordered: true });
    expect(s.backend.orders.get(d.order_id!)!.sku).toBe("LT-16-MAX");
  });

  it("T11 the quote expires before approval: approval is refused, and the vendor refuses the stale quote too", async () => {
    s = await startScenario({ quote_ttl_ms: 800 });
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    await sleep(1200);
    const d = await s.requester.approval(output.quote!, s.cfg.requirements, 30_000);
    expect(d.decision).toBe("rejected");
    expect(d.reason).toMatch(/expired/);
    await expect(
      s.approver.mesh!.request(s.ids.orders.id, "place_order", { quote_id: output.quote!.quote_id, price_usd: output.quote!.price_usd, po_number: "PO-STALE", idempotency_key: "stale" }, { timeout_ms: 5000 }),
    ).rejects.toThrow(/expired/);
    expect(s.backend.orders.size).toBe(0);
  });

  it("T15 the requester lowers the quoted price: approved internally, but the vendor refuses the order", async () => {
    s = await startScenario();
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    const tampered = { ...output.quote!, price_usd: 999 };
    const d = await s.requester.approval(tampered, s.cfg.requirements, 30_000);
    expect(d).toMatchObject({ decision: "approved", ordered: false });
    expect(d.order_error).toMatch(/is for \$1899, not \$999/);
    expect(s.backend.orders.size).toBe(0);
  });

  it("T10 the same order sent twice: the vendor keeps one order", async () => {
    s = await startScenario();
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    const q = output.quote!;
    const body = { quote_id: q.quote_id, price_usd: q.price_usd, po_number: "PO-DUP", idempotency_key: `dup-${q.quote_id}` };
    const first = await s.approver.mesh!.request(s.ids.orders.id, "place_order", body, { timeout_ms: 5000 });
    const second = await s.approver.mesh!.request(s.ids.orders.id, "place_order", body, { timeout_ms: 5000 });
    const a = first.payload?.output as any;
    const b = second.payload?.output as any;
    expect(b.order_id).toBe(a.order_id);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(s.backend.orders.size).toBe(1);
  });

  it("T12 cancelled before it ships: status says cancelled and no shipment notice ever comes", async () => {
    s = await startScenario({ ship_delay_ms: 4000 });
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    const d = await s.requester.approval(output.quote!, s.cfg.requirements, 30_000);
    expect(d.ordered).toBe(true);
    const c = await s.approver.cancelOrder(d.order_id!);
    expect(c.status).toBe("cancelled");
    await sleep(s.cfg.ship_delay_ms + 1500);
    expect((await s.approver.orderStatus(d.order_id!)).status).toBe("cancelled");
    expect(s.approver.notices).toHaveLength(0);
    expect(s.requester.notices).toHaveLength(0);
  });

  it("T12b an order that has shipped cannot be cancelled", async () => {
    s = await startScenario({ ship_delay_ms: 1000 });
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    const d = await s.requester.approval(output.quote!, s.cfg.requirements, 30_000);
    await until(() => s!.approver.notices.length > 0, 30_000, "shipment notice");
    await expect(s.approver.cancelOrder(d.order_id!)).rejects.toThrow(/already shipped/);
  });
});
