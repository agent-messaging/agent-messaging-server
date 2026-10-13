/**
 * The internal company, Acme: two agents with two different identities.
 *
 * - The requester (the onboarding agent) finds the price of a laptop for a
 *   new employee with a synchronous request to the vendor's pricing agent,
 *   then asks Acme's approver for approval, asynchronously.
 * - The approver (procurement) decides, and only the approver buys: it places
 *   the order with the vendor's order agent, can ask for the order's status,
 *   receives the shipment notice and passes it on to the requester.
 *
 * Approval is asynchronous on the mesh (§7.0 deferral): the approver's
 * handler takes as long as the decision takes, the requester's request is
 * answered at once with `working` and a task id, and the decision arrives as
 * the task's signed terminal update, which the requester awaits.
 */
import type { AgentMesh } from "agent-messaging";
import type { Requirements, ScenarioConfig } from "../config.js";
import { connect, sleep, type Enrolled } from "../mesh.js";
import type { Quote } from "./vendor.js";

export interface ShipmentNotice {
  order_id: string;
  po_number: string;
  sku: string;
  status: string;
  tracking: string | null;
  shipped_at?: string;
  from: string;
  received_at: number;
}

export interface Decision {
  decision: "approved" | "rejected";
  reason?: string;
  approved_by?: string;
  manager_reviewed?: boolean;
  ordered?: boolean;
  order_id?: string;
  order_status?: string;
  order_error?: string;
}

/** What the manager decides for a purchase above the auto-approve limit. */
export type ManagerPolicy = (quote: Quote, requirements: Requirements) => "approved" | "rejected";

export class ApproverAgent {
  mesh: AgentMesh | null = null;
  readonly requesters = new Set<string>();
  readonly notices: ShipmentNotice[] = [];
  /** order id -> the requester to tell when it ships */
  readonly purchases = new Map<string, string>();
  managerPolicy: ManagerPolicy = () => "approved";
  private poSeq = 0;

  constructor(readonly who: Enrolled, readonly orderAgentId: string, readonly cfg: ScenarioConfig) {}

  async start() {
    const mesh = await connect(this.who);

    mesh.onRequest(
      "approve_purchase",
      async (input, ctx): Promise<Decision> => {
        const from = ctx.envelope.from;
        if (!this.requesters.has(from)) throw new Error(`${from} is not an Acme requester; approval refused.`);
        const { quote, requirements } = input as { quote: Quote; requirements: Requirements };
        await sleep(this.cfg.approval_review_ms);

        if (Date.parse(quote.valid_until) < Date.now()) return { decision: "rejected", reason: `The quote expired at ${quote.valid_until}; get a new quote.` };
        if (quote.price_usd > requirements.budget_usd) return { decision: "rejected", reason: `$${quote.price_usd} is over the $${requirements.budget_usd} budget.` };

        let managerReviewed = false;
        if (quote.price_usd > this.cfg.auto_approve_limit_usd) {
          managerReviewed = true;
          await sleep(this.cfg.approval_delay_ms);
          if (this.managerPolicy(quote, requirements) === "rejected") return { decision: "rejected", reason: "The manager declined the purchase.", manager_reviewed: true };
          // The decision took time: a quote can lapse while it waits.
          if (Date.parse(quote.valid_until) < Date.now()) return { decision: "rejected", reason: `The quote expired at ${quote.valid_until} while it waited for the manager; get a new quote.`, manager_reviewed: true };
        }

        this.poSeq += 1;
        const po = `PO-${this.who.id.slice(0, 6)}-${this.poSeq}`;
        try {
          const r = await mesh.request(
            this.orderAgentId,
            "place_order",
            { quote_id: quote.quote_id, price_usd: quote.price_usd, po_number: po, idempotency_key: quote.quote_id },
            { timeout_ms: 15_000 },
          );
          const out = r.payload?.output as { order_id: string; status: string };
          this.purchases.set(out.order_id, from);
          return { decision: "approved", approved_by: this.who.id, manager_reviewed: managerReviewed, ordered: true, order_id: out.order_id, order_status: out.status };
        } catch (err) {
          return { decision: "approved", approved_by: this.who.id, manager_reviewed: managerReviewed, ordered: false, order_error: (err as Error).message };
        }
      },
      // Always answer the requester at once with a task; the decision follows.
      { deferAfterMs: 0 },
    );

    mesh.onRequest("shipment_notice", (input, ctx) => {
      const from = ctx.envelope.from;
      if (from !== this.orderAgentId) throw new Error("Shipment notices are taken only from the vendor's order agent.");
      const n = { ...(input as Omit<ShipmentNotice, "from" | "received_at">), from, received_at: Date.now() };
      this.notices.push(n);
      const requester = this.purchases.get(n.order_id);
      if (requester) mesh.request(requester, "shipment_notice", n, { timeout_ms: 60_000 }).catch(() => {});
      return { received: true };
    });

    await mesh.register({
      name: "acme-procurement",
      description: "Approves Acme purchases and places the orders.",
      visibility: "unlisted",
      offerings: [
        { id: "approve_purchase", name: "Approve purchase", description: "Decide a purchase and, if approved, order it." },
        { id: "shipment_notice", name: "Shipment notice", description: "Vendors say here when an order ships." },
      ],
    } as any);
    this.mesh = mesh;
    return this;
  }

  /** Where an order is, asked of the vendor synchronously. */
  async orderStatus(orderId: string, timeoutMs = 5000) {
    const r = await this.mesh!.request(this.orderAgentId, "order_status", { order_id: orderId }, { timeout_ms: timeoutMs });
    return r.payload?.output as { order_id: string; status: string; tracking: string | null; history: Array<{ status: string; at: string }> };
  }

  async cancelOrder(orderId: string) {
    const r = await this.mesh!.request(this.orderAgentId, "cancel_order", { order_id: orderId }, { timeout_ms: 5000 });
    return r.payload?.output as { order_id: string; status: string };
  }

  async stop() {
    await this.mesh?.close();
    this.mesh = null;
  }
}

export class RequesterAgent {
  mesh: AgentMesh | null = null;
  readonly notices: ShipmentNotice[] = [];

  constructor(readonly who: Enrolled, readonly approverId: string, readonly cfg: ScenarioConfig) {}

  async start() {
    const mesh = await connect(this.who);
    mesh.onRequest("shipment_notice", (input, ctx) => {
      if (ctx.envelope.from !== this.approverId) throw new Error("Shipment notices are taken only from Acme procurement.");
      this.notices.push({ ...(input as ShipmentNotice), from: ctx.envelope.from, received_at: Date.now() });
      return { received: true };
    });
    await mesh.register({
      name: "acme-onboarding",
      description: "Gets new employees what they need on day one.",
      visibility: "unlisted",
      offerings: [{ id: "shipment_notice", name: "Shipment notice", description: "Procurement says here when an order ships." }],
    } as any);
    this.mesh = mesh;
    return this;
  }

  /** Step 1, synchronous: ask the vendor's pricing agent and wait for the answer. */
  async getQuote(pricingAgentId: string, requirements: Requirements) {
    const r = await this.mesh!.request(pricingAgentId, "quote", requirements, { timeout_ms: this.cfg.quote_timeout_ms });
    return { task_id: r.task_id, output: r.payload?.output as { found: boolean; quote?: Quote; reason?: string } };
  }

  /** Step 2, asynchronous: send the quote for approval and get a task back at once. */
  async askApproval(quote: Quote, requirements: Requirements) {
    const sentAt = Date.now();
    const r = await this.mesh!.request(this.approverId, "approve_purchase", { quote, requirements }, { timeout_ms: 10_000 });
    return { task_id: r.task_id, status: r.payload?.status, answeredInMs: Date.now() - sentAt, immediate: r.payload?.output as Decision | undefined };
  }

  /** Ask for approval and wait for the decision, whether it came back as a
   *  task or (for a refusal decided on the spot) as a direct answer. */
  async approval(quote: Quote, requirements: Requirements, timeoutMs: number): Promise<Decision & { task_id: string | null }> {
    const asked = await this.askApproval(quote, requirements);
    if (!asked.task_id) return { ...(asked.immediate as Decision), task_id: null };
    return { ...(await this.awaitDecision(asked.task_id, timeoutMs)), task_id: asked.task_id };
  }

  /** Wait for the approval task's decision. */
  async awaitDecision(taskId: string, timeoutMs: number): Promise<Decision> {
    const done = await this.mesh!.awaitTask(taskId, timeoutMs);
    return done.output as Decision;
  }

  async stop() {
    await this.mesh?.close();
    this.mesh = null;
  }
}
