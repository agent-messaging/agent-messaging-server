/**
 * The admin API's ownership record routes (step 10a of
 * docs/agent-messaging-server-plan.md): the agent ownership record and the
 * tenants (keychain/agent-owners.ts), record by record, for a platform that
 * keeps its own record of accounts and projects it over the core's
 * (AgentMesh's api/owner-projection.ts). The operator's own way to change
 * ownership is the agents and tenants routes of admin-api.ts.
 *
 *   GET    /admin/v1/owner-records/agents        { records }: every agent's record
 *   GET    /admin/v1/owner-records/agents/:key   { record }: one, or null
 *   PUT    /admin/v1/owner-records/agents/:key   { record }: write it as given
 *   DELETE /admin/v1/owner-records/agents/:key   remove it
 *   GET    /admin/v1/owner-records/tenants       { records }
 *   GET    /admin/v1/owner-records/tenants/:id   { record }
 *   PUT    /admin/v1/owner-records/tenants/:id   { record }
 *   DELETE /admin/v1/owner-records/tenants/:id
 *
 * A record written here is checked for its shape, and its key or id must be
 * the one in the path. Each answer is { status, body } and never throws.
 */
import type { DoorAnswer } from "../keychain/doors.js";
import type { AdminRequest } from "./admin-api.js";
import type { AgentOwnerRecord, AgentOwners, TenantRecord } from "../keychain/agent-owners.js";

const NKEY = /^U[A-Z2-7]{55}$/;
const TENANT_ID = /^[A-Za-z0-9_.@:-]{1,200}$/;

const ok = (body: Record<string, unknown>, status = 200): DoorAnswer => ({ status, body });
const no = (status: number, error: string): DoorAnswer => ({ status, body: { error } });

const strOrNull = (v: unknown) => v === null || typeof v === "string";

function agentRecordOf(v: unknown, key: string): AgentOwnerRecord | null {
  const r = v as AgentOwnerRecord;
  if (!r || typeof r !== "object" || r.key !== key) return null;
  if (![r.account, r.org, r.home_org, r.person, r.category, r.label].every(strOrNull)) return null;
  if (typeof r.listed !== "boolean" || typeof r.updated_at !== "string") return null;
  if (r.custody !== null && (typeof r.custody !== "object" || typeof r.custody.account !== "string" || !strOrNull(r.custody.email))) return null;
  if (r.payer !== undefined && !strOrNull(r.payer)) return null;
  return r;
}

function tenantRecordOf(v: unknown, id: string): TenantRecord | null {
  const r = v as TenantRecord;
  if (!r || typeof r !== "object" || r.id !== id) return null;
  if (typeof r.disabled !== "boolean" || !strOrNull(r.home_org) || !strOrNull(r.owner_key) || typeof r.updated_at !== "string") return null;
  return r;
}

export function adminOwners(owners: AgentOwners) {
  async function handle(req: AdminRequest): Promise<DoorAnswer | null> {
    const seg = req.path.replace(/^\/admin\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    if (seg[0] !== "owner-records") return null;
    const [, kind, id] = seg;
    const m = req.method;
    try {
      if (kind === "agents") {
        if (seg.length === 2 && m === "GET") return ok({ records: [...(await owners.allAgents()).values()] });
        if (seg.length !== 3) return null;
        if (!NKEY.test(id!)) return no(400, "That is not an agent public key.");
        if (m === "GET") return ok({ record: await owners.agent(id!) });
        if (m === "DELETE") { await owners.removeAgent(id!); return ok({ removed: true }); }
        if (m === "PUT") {
          const rec = agentRecordOf(req.body?.record, id!);
          if (!rec) return no(400, "record is an agent ownership record for this key.");
          await owners.putAgent(rec);
          return ok({ written: true });
        }
      }
      if (kind === "tenants") {
        if (seg.length === 2 && m === "GET") return ok({ records: [...(await owners.allTenants()).values()] });
        if (seg.length !== 3) return null;
        if (!TENANT_ID.test(id!)) return no(400, "That is not a tenant id.");
        if (m === "GET") return ok({ record: await owners.tenant(id!) });
        if (m === "DELETE") { await owners.removeTenant(id!); return ok({ removed: true }); }
        if (m === "PUT") {
          const rec = tenantRecordOf(req.body?.record, id!);
          if (!rec) return no(400, "record is a tenant record for this id.");
          await owners.putTenant(rec);
          return ok({ written: true });
        }
      }
    } catch (err) {
      return no(503, `The ownership record could not be read whole: ${(err as Error).message}`);
    }
    return null;
  }
  return { handle };
}

export type AdminOwners = ReturnType<typeof adminOwners>;
