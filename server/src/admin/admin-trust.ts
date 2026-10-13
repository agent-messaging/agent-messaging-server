/**
 * The admin API's trust routes (step 10 of the bring-your-own-identity plan):
 * the identity systems each tenant trusts (keychain/trust-anchors.ts), and
 * where each agent's identity came from (keychain/identity-records.ts).
 *
 *   GET    /admin/v1/trust                       every tenant's trust records
 *   GET    /admin/v1/tenants/:id/trust           one tenant's
 *   POST   /admin/v1/tenants/:id/trust           add one:
 *          { kind: "oauth", issuer, audience, require_binding?, jwks_uri?, id? }
 *          { kind: "spiffe", trust_domain, bundle | bundle_endpoint, require_mtls?, audience?, id? }
 *   DELETE /admin/v1/tenants/:id/trust/:trustId  remove one
 *   GET    /admin/v1/agents/:key/identity        where one agent's identity came from
 *
 * The CLI is `mesh-admin tenants trust add|list|remove` and
 * `mesh-admin agents identity`. Nothing here is secret: issuers, audiences,
 * trust domains and public keys. Removing a record stops new enrollments
 * through it and renewals of the agents enrolled through it (they renew only
 * with a fresh proof, which no longer checks); it revokes nothing by itself.
 */
import type { DoorAnswer } from "../keychain/doors.js";
import type { AdminRequest } from "./admin-api.js";
import type { AgentOwners } from "../keychain/agent-owners.js";
import { describeTrust, parseTrustRecord, type TrustAnchorList } from "../keychain/trust-anchors.js";
import type { IdentitySourceList } from "../keychain/identity-records.js";

const NKEY = /^U[A-Z2-7]{55}$/;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.=-]{0,127}$/;

const ok = (body: Record<string, unknown>, status = 200): DoorAnswer => ({ status, body });
const no = (status: number, error: string): DoorAnswer => ({ status, body: { error } });

export interface AdminTrustDeps {
  trust: TrustAnchorList;
  owners: AgentOwners;
  identitySources: IdentitySourceList;
  env?: NodeJS.ProcessEnv;
}

export function adminTrust(deps: AdminTrustDeps) {
  async function handle(req: AdminRequest): Promise<DoorAnswer | null> {
    const seg = req.path.replace(/^\/admin\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const m = req.method;
    if (seg.length === 1 && seg[0] === "trust" && m === "GET") {
      const all = await deps.trust.all();
      return ok({ tenants: [...all].filter(([, l]) => l.length).map(([tenant, list]) => ({ tenant, trust: list.map(describeTrust) })) });
    }
    if (seg[0] === "agents" && seg.length === 3 && seg[2] === "identity" && m === "GET") {
      if (!NKEY.test(seg[1]!)) return no(400, "That is not an agent public key (U followed by 55 characters).");
      const rec = await deps.identitySources.get(seg[1]!);
      return ok({ agent: seg[1], identity_source: rec?.identity_source ?? null, tenant: rec?.tenant ?? null, ...(rec?.attestation ? { attestation: rec.attestation } : {}) });
    }
    if (seg[0] !== "tenants" || seg[2] !== "trust") return null;
    const tenant = seg[1]!;
    if (!TENANT_ID.test(tenant)) return no(400, "That is not a tenant id.");
    if (seg.length === 3 && m === "GET") {
      return ok({ tenant, trust: (await deps.trust.list(tenant)).map(describeTrust) });
    }
    if (seg.length === 3 && m === "POST") {
      if (!(await deps.owners.tenant(tenant))) return no(404, `There is no tenant ${tenant}. Create it first (mesh-admin tenants create).`);
      const parsed = parseTrustRecord(req.body ?? {}, req.caller, deps.env ?? process.env);
      if (!parsed.ok) return no(400, parsed.error);
      const added = await deps.trust.add(tenant, parsed.record);
      if (!added.ok) return no(added.status, added.error);
      console.log(`[admin] ${req.caller} added trust record ${parsed.record.id} (${parsed.record.kind}) to tenant ${tenant}`);
      return ok({ tenant, added: describeTrust(parsed.record) }, 201);
    }
    if (seg.length === 4 && m === "DELETE") {
      const removed = await deps.trust.remove(tenant, seg[3]!);
      if (!removed) return no(404, `Tenant ${tenant} has no trust record ${seg[3]}.`);
      console.log(`[admin] ${req.caller} removed trust record ${seg[3]} from tenant ${tenant}`);
      return ok({ tenant, removed: seg[3] });
    }
    return null;
  }
  return { handle };
}

export type AdminTrust = ReturnType<typeof adminTrust>;
