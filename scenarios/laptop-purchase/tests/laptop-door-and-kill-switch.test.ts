/**
 * T13: the vendor keeps a door. A new buyer from Acme reads the vendor's
 * card, knocks and is let in; an agent the vendor blocks never gets through.
 *
 * T14: the kill switch. The mesh's operator revokes the vendor's order agent
 * in the middle of a purchase; Acme's side gets a clear failure instead of
 * hanging, and no order is placed after the revoke.
 */
import { afterEach, describe, expect, it } from "vitest";
import { admin, connect, enroll, runId, sleep, tenant, until } from "../src/mesh.js";
import { startScenario, type Scenario } from "../src/scenario.js";

let s: Scenario | undefined;
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await s?.stop();
  s = undefined;
  await Promise.allSettled(closers.splice(0).map((c) => c()));
});

describe("the vendor's door", () => {
  it("T13 a stranger is held at the door until admitted; a blocked agent never gets through", async () => {
    const run = runId();
    const vendor = await tenant(`laptopvendor-${run}`);
    const acme = await tenant(`acme-${run}`);
    const other = await tenant(`other-${run}`);
    const desk = await enroll(vendor, "vendor sales desk");
    const buyer = await enroll(acme, "acme procurement approver");
    const stranger = await enroll(other, "unknown sender");

    const d = await connect(desk);
    closers.push(() => d.close());
    await d.admission.start({ inbox: true });
    await d.register({
      name: `laptopvendor-${run}-sales`,
      description: "Sets up new business customers.",
      visibility: "public",
      public: { summary: "Laptop vendor sales desk: open a business account.", offerings: ["chat"] },
      offerings: [{ id: "chat", name: "Chat", description: "Ask to open a business account." }],
      guarded: true,
    } as any);

    const replies: any[] = [];
    const b = await connect(buyer);
    closers.push(() => b.close());
    b.onRequest("chat", (input) => {
      replies.push(input);
      return { ok: true };
    });
    await b.register({ name: `acme-${run}-procurement`, description: "Buys for Acme.", visibility: "unlisted", offerings: [{ id: "chat", name: "Chat", description: "Answers come here." }] } as any);

    const card = await b.describe(desk.id);
    expect(card.public?.summary).toMatch(/sales desk/);

    const first = await b.messages.send({ to: desk.id, text: "Acme would like a business account for laptop orders." });
    expect(first.delivered, "a stranger's message is held").toBe(false);
    await b.contacts.knock({ to: desk.id, via: "the vendor's website" });
    const waiting = (await d.contacts.waiting()).senders.find((x: any) => x.agent_id === buyer.id);
    expect(waiting?.found_you_by).toBe("the vendor's website");

    const admitted = await d.contacts.admit({ sender: buyer.id, note: "Acme, new customer" });
    expect(admitted.released).toBe(1);
    const msg = (await d.messages.inbox()).messages.find((m: any) => m.from === buyer.id);
    expect(msg?.text).toMatch(/business account/);
    const answered = await d.messages.reply({ inbox_id: msg!.id, text: "Account open. Your buyer is on file." });
    expect(answered.delivered).toBe(true);
    await until(() => replies.length > 0, 10_000, "the sales desk's answer");
    expect(String(replies[0].text)).toMatch(/Account open/);

    const x = await connect(stranger);
    closers.push(() => x.close());
    await x.register({ name: `other-${run}`, description: "Sends things.", visibility: "unlisted", offerings: [] } as any);
    await d.contacts.block({ sender: stranger.id, note: "not a customer" });
    const spam = await x.messages.send({ to: desk.id, text: "Cheap laptops, buy now!" });
    expect(spam.delivered).toBe(false);
    await sleep(1500);
    const leaked =
      (await d.contacts.waiting()).senders.some((w: any) => w.agent_id === stranger.id) ||
      (await d.messages.inbox()).messages.some((m: any) => m.from === stranger.id);
    expect(leaked).toBe(false);
  });
});

describe("the kill switch", () => {
  it("T14 the vendor's order agent is revoked mid-purchase: Acme gets a clear failure and no order is placed", async () => {
    s = await startScenario({ ship_delay_ms: 60_000 });
    const { output } = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    const first = await s.requester.approval(output.quote!, s.cfg.requirements, 30_000);
    expect(first.ordered).toBe(true);

    const r = await admin("POST", "/credentials/revoke", { agent: s.ids.orders.id, reason: "laptop scenario kill switch test" });
    expect([200, 201, 202]).toContain(r.status);
    await sleep(3000);

    // The operator's revoke is a pause (SPEC §4.12): the agent is cut off, a
    // request to it waits in its mailbox, and the caller is told it is paused
    // (server 0.2.1, SDK 0.61.1: REQUEST_QUEUED with details.paused).
    await expect(s.approver.orderStatus(first.order_id!, 3000)).rejects.toMatchObject({
      code: "REQUEST_QUEUED",
      details: { paused: true, reason: "agent_paused" },
    });

    const ordersBefore = s.backend.orders.size;
    const again = await s.requester.getQuote(s.ids.pricing.id, s.cfg.requirements);
    const second = await s.requester.approval(again.output.quote!, s.cfg.requirements, 60_000);
    expect(second).toMatchObject({ decision: "approved", ordered: false });
    expect(second.order_error).toMatch(/is paused/i);
    expect(s.backend.orders.size).toBe(ordersBefore);

    // And the revoked credential cannot come back on.
    await s.orders.stop();
    await expect(s.orders.start()).rejects.toThrow();
  }, 120_000);
});
