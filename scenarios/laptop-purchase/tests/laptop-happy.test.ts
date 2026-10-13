/**
 * T1: a laptop for a new employee, end to end.
 *
 * quote (synchronous, external) -> approval (asynchronous, internal) ->
 * order (asynchronous, external) -> status -> shipment notice to the
 * approver and on to the requester.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, until } from "../src/mesh.js";
import { startScenario, type Scenario } from "../src/scenario.js";

let s: Scenario;
beforeAll(async () => {
  s = await startScenario();
});
afterAll(async () => {
  await s?.stop();
});

describe("T1 laptop purchase, happy path", () => {
  let quoteId = "";
  let orderId = "";

  it("gets a quote synchronously from the vendor's pricing agent", async () => {
    const started = Date.now();
    const { task_id, output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    expect(task_id, "a synchronous answer carries no task").toBeNull();
    expect(Date.now() - started).toBeLessThan(s.cfg.quote_timeout_ms);
    expect(output.found).toBe(true);
    expect(output.quote).toMatchObject({ sku: "LT-14-PRO", price_usd: 1899, quoted_by: s.ids.pricing.id });
    quoteId = output.quote!.quote_id;
  });

  it("asks for approval asynchronously and gets a task back at once", async () => {
    const quote = s.backend.quotes.get(quoteId)!;
    const asked = await s.requester.askApproval(quote, s.cfg.requirements);
    expect(asked.task_id, "approval is deferred work with a task id").toBeTruthy();
    expect(asked.status).toBe("working");

    const decision = await s.requester.awaitDecision(asked.task_id!, 30_000);
    expect(decision).toMatchObject({ decision: "approved", approved_by: s.ids.approver.id, ordered: true, order_status: "accepted" });
    expect(decision.approved_by, "the approver is a different identity from the requester").not.toBe(s.ids.requester.id);
    orderId = decision.order_id!;
  });

  it("the order was placed by the approver's identity, not the requester's", () => {
    const o = s.backend.orders.get(orderId)!;
    expect(o.buyer).toBe(s.ids.approver.id);
    expect(o.buyer).not.toBe(s.ids.requester.id);
  });

  it("reports the order's status while it is being fulfilled", async () => {
    const st = await s.approver.orderStatus(orderId);
    expect(["accepted", "processing"]).toContain(st.status);
    expect(st.tracking).toBeNull();
  });

  it("reports back to the approver and the requester after the shipment", async () => {
    await until(() => s.approver.notices.some((n) => n.order_id === orderId), s.cfg.ship_delay_ms + 30_000, "the approver's shipment notice");
    const n = s.approver.notices.find((x) => x.order_id === orderId)!;
    expect(n).toMatchObject({ status: "shipped", from: s.ids.orders.id });
    expect(n.tracking).toMatch(/^TRK\d+/);

    await until(() => s.requester.notices.some((x) => x.order_id === orderId), 30_000, "the requester's shipment notice");
    expect(s.requester.notices.find((x) => x.order_id === orderId)!.from).toBe(s.ids.approver.id);

    const st = await s.approver.orderStatus(orderId);
    expect(st.status).toBe("shipped");
    expect(st.history.map((h) => h.status)).toEqual(["accepted", "processing", "shipped"]);
  });

  it("the mesh's audit log shows each agent acting under its own identity", async () => {
    const agents = [s.ids.requester.id, s.ids.approver.id, s.ids.pricing.id, s.ids.orders.id].join(",");
    const r = await admin("GET", `/audit/entries?agents=${agents}&limit=500`);
    expect(r.status).toBe(200);
    const rows: any[] = r.json.entries ?? r.json.rows ?? r.json;
    expect(Array.isArray(rows)).toBe(true);
    const actors = new Set(rows.map((e) => e.agent ?? e.agent_id ?? e.actor));
    for (const id of [s.ids.requester.id, s.ids.approver.id]) expect(actors.has(id), `audit has rows for ${id}`).toBe(true);
  });
});
