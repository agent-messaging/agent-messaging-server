/**
 * Who may do what. The identity that finds the price is not the identity
 * that approves and buys, and the mesh's signatures are what make that hold:
 * every agent checks the verified sender, and a message whose signature does
 * not match its sender is dropped before any agent acts on it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encode } from "agent-messaging";
import { sleep } from "../src/mesh.js";
import { startScenario, type Scenario } from "../src/scenario.js";

let s: Scenario;
let orderId = "";
beforeAll(async () => {
  s = await startScenario({ ship_delay_ms: 60_000 });
  const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
  const d = await s.requester.approval(output.quote!, s.cfg.requirements, 30_000);
  orderId = d.order_id!;
});
afterAll(async () => {
  await s?.stop();
});

/** Publish a request envelope by hand, so a test can break its signature. */
async function sendRaw(from: Scenario["requester"]["mesh"], to: string, offering: string, input: unknown, tamper: (env: any) => void) {
  const m = from as any;
  const env = m.newEnvelope({ type: "request", from: m.agentId, to, payload: { offering, input } });
  tamper(env);
  m.conn.publish(m.resolvedInbox(to), encode(env));
}

describe("identities and signatures", () => {
  it("the four agents are four different identities in two tenants", () => {
    const ids = [s.ids.requester, s.ids.approver, s.ids.pricing, s.ids.orders].map((e) => e.id);
    expect(new Set(ids).size).toBe(4);
    expect(s.ids.requester.tenant).toBe(s.ids.approver.tenant);
    expect(s.ids.pricing.tenant).toBe(s.ids.orders.tenant);
    expect(s.ids.requester.tenant).not.toBe(s.ids.pricing.tenant);
  });

  it("T6 the requester, who found the price, cannot place the order itself", async () => {
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    const q = output.quote!;
    await expect(
      s.requester.mesh!.request(s.ids.orders.id, "place_order", { quote_id: q.quote_id, price_usd: q.price_usd, po_number: "PO-SELF", idempotency_key: "self" }, { timeout_ms: 5000 }),
    ).rejects.toThrow(/not a buyer on file/);
    expect([...s.backend.orders.values()].every((o) => o.buyer === s.ids.approver.id)).toBe(true);
  });

  it("T6b an outside agent cannot ask Acme's approver to approve a purchase", async () => {
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    await expect(
      s.pricing.mesh!.request(s.ids.approver.id, "approve_purchase", { quote: output.quote, requirements: s.cfg.requirements }, { timeout_ms: 5000 }),
    ).rejects.toThrow(/not an Acme requester/);
  });

  it("T6c only the buyer can read an order's status", async () => {
    await expect(s.requester.mesh!.request(s.ids.orders.id, "order_status", { order_id: orderId }, { timeout_ms: 5000 })).rejects.toThrow(/No such order for you/);
    expect((await s.approver.orderStatus(orderId)).order_id).toBe(orderId);
  });

  it("T6d a shipment notice from anyone but the vendor's order agent is refused", async () => {
    await expect(
      s.pricing.mesh!.request(s.ids.approver.id, "shipment_notice", { order_id: orderId, status: "shipped", tracking: "FAKE" }, { timeout_ms: 5000 }),
    ).rejects.toThrow(/only from the vendor's order agent/);
    expect(s.approver.notices).toHaveLength(0);
  });

  it("T7a a message claiming to be from the approver but signed by the requester is dropped", async () => {
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    const q = output.quote!;
    const before = s.backend.orders.size;
    await sendRaw(s.requester.mesh, s.ids.orders.id, "place_order", { quote_id: q.quote_id, price_usd: q.price_usd, po_number: "PO-FORGED", idempotency_key: "forged" }, (env) => {
      env.from = s.ids.approver.id;
    });
    await sleep(3000);
    expect(s.backend.orders.size).toBe(before);
  });

  it("T7b a signed message changed after signing is dropped", async () => {
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    const q = output.quote!;
    const before = s.backend.orders.size;
    // The approver's own envelope, with the price lowered after it was signed.
    await sendRaw(s.approver.mesh, s.ids.orders.id, "place_order", { quote_id: q.quote_id, price_usd: q.price_usd, po_number: "PO-ALTERED", idempotency_key: "altered" }, (env) => {
      env.payload.input.po_number = "PO-ALTERED-AFTER-SIGNING";
    });
    await sleep(3000);
    expect(s.backend.orders.size).toBe(before);
  });

  it("T7c control: the same hand-built message, untouched, is accepted", async () => {
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    const q = output.quote!;
    const before = s.backend.orders.size;
    await sendRaw(s.approver.mesh, s.ids.orders.id, "place_order", { quote_id: q.quote_id, price_usd: q.price_usd, po_number: "PO-CONTROL", idempotency_key: "control" }, () => {});
    await sleep(3000);
    expect(s.backend.orders.size).toBe(before + 1);
  });
});
