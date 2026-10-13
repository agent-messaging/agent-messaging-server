/**
 * The shipment comes long after the order, and nobody waits online for it.
 * The shipment notice is a request on the mesh: if the approver (or the
 * requester) is offline when the laptop ships, it waits in that agent's
 * mailbox and is delivered when the agent comes back.
 *
 * SHIP_DELAY_MS and OFFLINE_WINDOW_MS set how long; the nightly run uses
 * hours.
 */
import { afterEach, describe, expect, it } from "vitest";
import { sleep, until } from "../src/mesh.js";
import { startScenario, type Scenario } from "../src/scenario.js";

let s: Scenario | undefined;
afterEach(async () => {
  await s?.stop();
  s = undefined;
});

const shipDelay = () => Number(process.env.SHIP_DELAY_MS ?? 3000);

describe("long-running purchase", () => {
  it("T8 status is right at every stage while the approver polls", async () => {
    s = await startScenario({ ship_delay_ms: shipDelay() });
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    const d = await s.requester.approval(output.quote!, s.cfg.requirements, 30_000);
    const seen: string[] = [];
    await until(async () => {
      const st = await s!.approver.orderStatus(d.order_id!);
      if (seen.at(-1) !== st.status) seen.push(st.status);
      return st.status === "shipped";
    }, s.cfg.ship_delay_ms + 30_000, "the order to ship");
    expect(seen[0]).toMatch(/accepted|processing/);
    expect(seen.at(-1)).toBe("shipped");
    expect(seen).toContain("processing");
  });

  it("T9 the approver is offline when the laptop ships: the notice waits and arrives when it is back", async () => {
    s = await startScenario({ ship_delay_ms: shipDelay() });
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    const d = await s.requester.approval(output.quote!, s.cfg.requirements, 30_000);

    await s.approver.stop();
    await until(() => s!.backend.orders.get(d.order_id!)!.status === "shipped", s.cfg.ship_delay_ms + 30_000, "the order to ship");
    const shippedAt = Date.now();
    await sleep(s.cfg.offline_window_ms);
    expect(s.approver.notices).toHaveLength(0);

    await s.approver.start();
    await until(() => s!.approver.notices.some((n) => n.order_id === d.order_id), 60_000, "the held shipment notice");
    const n = s.approver.notices.find((x) => x.order_id === d.order_id)!;
    expect(n.received_at - shippedAt).toBeGreaterThanOrEqual(s.cfg.offline_window_ms);
    expect(n).toMatchObject({ status: "shipped", from: s.ids.orders.id });
    expect(s.orders.undelivered).toHaveLength(0);

    await until(() => s!.requester.notices.some((x) => x.order_id === d.order_id), 30_000, "the requester's notice");
  });

  it("T9b the requester is offline when procurement passes the notice on: it arrives when the requester is back", async () => {
    s = await startScenario({ ship_delay_ms: shipDelay() });
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    const d = await s.requester.approval(output.quote!, s.cfg.requirements, 30_000);

    await s.requester.stop();
    await until(() => s!.approver.notices.some((n) => n.order_id === d.order_id), s.cfg.ship_delay_ms + 30_000, "the approver's notice");
    await sleep(s.cfg.offline_window_ms);
    expect(s.requester.notices).toHaveLength(0);

    await s.requester.start();
    await until(() => s!.requester.notices.some((x) => x.order_id === d.order_id), 60_000, "the held notice to the requester");
  });
});
