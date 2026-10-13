/**
 * The laptop purchase scenario, set up fresh on the mesh: two tenants (Acme
 * and the vendor), four agents with four identities, and the business
 * relationships between them (who is a buyer on file, who may ask for
 * approval). Each call makes new tenants, so tests never share state.
 */
import { loadConfig, type ScenarioConfig } from "./config.js";
import { enroll, runId, tenant, type Enrolled } from "./mesh.js";
import { ApproverAgent, RequesterAgent } from "./agents/acme.js";
import { OrderAgent, PricingAgent, VendorBackend } from "./agents/vendor.js";

export interface Scenario {
  cfg: ScenarioConfig;
  run: string;
  tenants: { acme: string; vendor: string };
  ids: { requester: Enrolled; approver: Enrolled; pricing: Enrolled; orders: Enrolled };
  backend: VendorBackend;
  requester: RequesterAgent;
  approver: ApproverAgent;
  pricing: PricingAgent;
  orders: OrderAgent;
  stop(): Promise<void>;
}

export async function startScenario(overrides: Partial<ScenarioConfig> = {}): Promise<Scenario> {
  const cfg = { ...loadConfig(), ...overrides };
  const run = runId();
  const acme = await tenant(`acme-${run}`);
  const vendor = await tenant(`laptopvendor-${run}`);

  const ids = {
    requester: await enroll(acme, "acme onboarding agent"),
    approver: await enroll(acme, "acme procurement approver"),
    pricing: await enroll(vendor, "vendor pricing agent"),
    orders: await enroll(vendor, "vendor order agent"),
  };

  const backend = new VendorBackend(`laptopvendor-${run}`, cfg.vendor_catalog);
  const pricing = await new PricingAgent(ids.pricing, backend, cfg).start();
  const orders = new OrderAgent(ids.orders, backend, cfg);
  // Vendor onboarding: Acme's approver is the buyer on file. Its requester is not.
  orders.buyers.add(ids.approver.id);
  await orders.start();

  const approver = new ApproverAgent(ids.approver, ids.orders.id, cfg);
  approver.requesters.add(ids.requester.id);
  await approver.start();
  const requester = await new RequesterAgent(ids.requester, ids.approver.id, cfg).start();

  return {
    cfg,
    run,
    tenants: { acme, vendor },
    ids,
    backend,
    requester,
    approver,
    pricing,
    orders,
    async stop() {
      await Promise.allSettled([requester.stop(), approver.stop(), orders.stop(), pricing.stop()]);
    },
  };
}
