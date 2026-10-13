/**
 * The external laptop vendor: two agents in one company, sharing the
 * vendor's own systems (its catalog, its quotes and its orders).
 *
 * - The pricing agent answers "quote" synchronously: requirements in, the
 *   cheapest laptop that meets them out, with a quote that expires.
 * - The order agent takes "place_order" and answers at once with an order id;
 *   the order is then fulfilled in the background. "order_status" says where
 *   it is, "cancel_order" stops it before it ships, and when it ships the
 *   order agent tells the buyer with a "shipment_notice" request, which waits
 *   in the buyer's mailbox if the buyer is offline.
 *
 * The order agent only takes orders from buyers the vendor has on file:
 * whoever signed the request (the envelope's `from`, checked by the server)
 * must be one of them. The identity that asked for the price cannot buy.
 */
import type { AgentMesh } from "agent-messaging";
import type { CatalogItem, Requirements, ScenarioConfig } from "../config.js";
import { connect, type Enrolled } from "../mesh.js";

export interface Quote {
  quote_id: string;
  sku: string;
  model: string;
  price_usd: number;
  valid_until: string;
  vendor: string;
  quoted_by: string;
}

export type OrderStatus = "accepted" | "processing" | "shipped" | "cancelled";

export interface Order {
  order_id: string;
  quote_id: string;
  sku: string;
  price_usd: number;
  buyer: string;
  po_number: string;
  status: OrderStatus;
  tracking: string | null;
  history: Array<{ status: OrderStatus; at: string }>;
}

/** The vendor's back office, shared by its two agents. */
export class VendorBackend {
  quotes = new Map<string, Quote>();
  orders = new Map<string, Order>();
  byIdempotencyKey = new Map<string, string>();
  private seq = 0;
  constructor(readonly name: string, readonly catalog: CatalogItem[]) {}
  nextId(prefix: string) {
    this.seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.seq}`;
  }
}

function fits(item: CatalogItem, r: Requirements) {
  return item.cpu_cores >= r.cpu_cores_min && item.ram_gb >= r.ram_gb_min && item.storage_gb >= r.storage_gb_min && item.screen_in <= r.screen_in_max;
}

export class PricingAgent {
  mesh: AgentMesh | null = null;
  constructor(readonly who: Enrolled, readonly backend: VendorBackend, readonly cfg: ScenarioConfig) {}

  async start() {
    const mesh = await connect(this.who);
    mesh.onRequest("quote", (input) => {
      const r = input as Requirements;
      const matches = this.backend.catalog.filter((i) => fits(i, r)).sort((a, b) => a.price_usd - b.price_usd);
      if (!matches.length) return { found: false, reason: "No laptop in our catalog meets those requirements." };
      const item = matches[0];
      const quote: Quote = {
        quote_id: this.backend.nextId("Q"),
        sku: item.sku,
        model: item.model,
        price_usd: item.price_usd,
        valid_until: new Date(Date.now() + this.cfg.quote_ttl_ms).toISOString(),
        vendor: this.backend.name,
        quoted_by: this.who.id,
      };
      this.backend.quotes.set(quote.quote_id, quote);
      return { found: true, quote };
    });
    await mesh.register({
      name: `${this.backend.name}-pricing`,
      description: "Quotes laptops that meet a set of requirements.",
      visibility: "public",
      offerings: [{ id: "quote", name: "Quote", description: "The cheapest laptop that meets the requirements, with a price valid for a limited time." }],
    } as any);
    this.mesh = mesh;
    return this;
  }

  async stop() {
    await this.mesh?.close();
    this.mesh = null;
  }
}

export class OrderAgent {
  mesh: AgentMesh | null = null;
  /** Buyers the vendor has on file, by agent id. */
  readonly buyers = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout[]>();
  /** Shipment notices that could not be delivered, with why. */
  readonly undelivered: Array<{ order_id: string; why: string }> = [];

  constructor(readonly who: Enrolled, readonly backend: VendorBackend, readonly cfg: ScenarioConfig) {}

  private refuse(why: string): never {
    throw new Error(why);
  }

  private move(o: Order, status: OrderStatus) {
    o.status = status;
    o.history.push({ status, at: new Date().toISOString() });
  }

  private fulfil(o: Order) {
    const processing = setTimeout(() => o.status === "accepted" && this.move(o, "processing"), Math.min(500, this.cfg.ship_delay_ms / 2));
    const ship = setTimeout(() => {
      if (o.status === "cancelled") return;
      o.tracking = `TRK${Math.floor(Math.random() * 1e9)}`;
      this.move(o, "shipped");
      this.notifyShipped(o);
    }, this.cfg.ship_delay_ms);
    this.timers.set(o.order_id, [processing, ship]);
  }

  /** Tell the buyer. A request, not an event: if the buyer is offline it
   *  waits in the buyer's mailbox on the mesh and arrives when it is back. */
  private notifyShipped(o: Order) {
    const notice = { order_id: o.order_id, po_number: o.po_number, sku: o.sku, status: o.status, tracking: o.tracking, shipped_at: o.history.at(-1)?.at };
    this.mesh
      ?.request(o.buyer, "shipment_notice", notice, { timeout_ms: Math.max(60_000, this.cfg.offline_window_ms * 10) })
      .catch((err: Error) => this.undelivered.push({ order_id: o.order_id, why: err.message }));
  }

  async start() {
    const mesh = await connect(this.who);

    mesh.onRequest("place_order", (input, ctx) => {
      const from = ctx.envelope.from;
      if (!this.buyers.has(from)) this.refuse(`${from} is not a buyer on file with ${this.backend.name}; only an approved buyer can place an order.`);
      const req = input as { quote_id: string; price_usd: number; po_number: string; idempotency_key: string };
      const again = this.backend.byIdempotencyKey.get(req.idempotency_key);
      if (again) {
        const o = this.backend.orders.get(again)!;
        return { order_id: o.order_id, status: o.status, duplicate: true };
      }
      const q = this.backend.quotes.get(req.quote_id);
      if (!q) this.refuse(`Quote ${req.quote_id} is not one we issued.`);
      if (Date.parse(q.valid_until) < Date.now()) this.refuse(`Quote ${q.quote_id} expired at ${q.valid_until}; ask for a new quote.`);
      if (req.price_usd !== q.price_usd) this.refuse(`Quote ${q.quote_id} is for $${q.price_usd}, not $${req.price_usd}.`);
      const o: Order = {
        order_id: this.backend.nextId("ORD"),
        quote_id: q.quote_id,
        sku: q.sku,
        price_usd: q.price_usd,
        buyer: from,
        po_number: req.po_number,
        status: "accepted",
        tracking: null,
        history: [{ status: "accepted", at: new Date().toISOString() }],
      };
      this.backend.orders.set(o.order_id, o);
      this.backend.byIdempotencyKey.set(req.idempotency_key, o.order_id);
      this.fulfil(o);
      return { order_id: o.order_id, status: o.status, ships_in_ms: this.cfg.ship_delay_ms, duplicate: false };
    });

    mesh.onRequest("order_status", (input, ctx) => {
      const o = this.backend.orders.get((input as { order_id: string }).order_id);
      if (!o || o.buyer !== ctx.envelope.from) this.refuse("No such order for you.");
      return { order_id: o.order_id, status: o.status, tracking: o.tracking, history: o.history };
    });

    mesh.onRequest("cancel_order", (input, ctx) => {
      const o = this.backend.orders.get((input as { order_id: string }).order_id);
      if (!o || o.buyer !== ctx.envelope.from) this.refuse("No such order for you.");
      if (o.status === "shipped") this.refuse(`Order ${o.order_id} has already shipped.`);
      if (o.status !== "cancelled") {
        for (const t of this.timers.get(o.order_id) ?? []) clearTimeout(t);
        this.move(o, "cancelled");
      }
      return { order_id: o.order_id, status: o.status };
    });

    await mesh.register({
      name: `${this.backend.name}-orders`,
      description: "Takes laptop orders from buyers on file, reports their status and says when they ship.",
      visibility: "public",
      offerings: [
        { id: "place_order", name: "Place order", description: "Order against a quote. Answers at once with an order id." },
        { id: "order_status", name: "Order status", description: "Where an order is." },
        { id: "cancel_order", name: "Cancel order", description: "Cancel an order that has not shipped." },
      ],
    } as any);
    this.mesh = mesh;
    return this;
  }

  async stop() {
    for (const ts of this.timers.values()) ts.forEach(clearTimeout);
    await this.mesh?.close();
    this.mesh = null;
  }
}
