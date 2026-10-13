/**
 * The admin API's audit log routes beyond the operator's query (step 10a of
 * docs/agent-messaging-server-plan.md): what a platform running beside the
 * core needs from the audit log, which the core keeps and signs. AgentMesh's
 * account console, closure, daily export and ledger anchoring use these rather
 * than opening the log's file.
 *
 *   GET  /admin/v1/audit/entries?agents=&limit=   recent rows across these agents, newest first (500 at most)
 *   POST /admin/v1/audit/export { account, agents? }   the signed bundle (activity/audit-log.ts export); with
 *                                                  no agents, every agent with a chain (the whole mesh)
 *   POST /admin/v1/audit/forget { agents }        erase these agents' rows (an account closing) -> { deleted }
 *   GET  /admin/v1/audit/heads                    each chain's head { id, seq, entry_hash }, for anchoring
 *
 * The operator's own query stays GET /admin/v1/audit?agent=|tenant= (admin-api.ts).
 * Each answer is { status, body } and never throws.
 */
import type { DoorAnswer } from "../keychain/doors.js";
import type { AdminRequest } from "./admin-api.js";
import type { AuditLog } from "../activity/audit-log.js";

const NKEY = /^U[A-Z2-7]{55}$/;
const MAX_AGENTS = 5000;

const ok = (body: Record<string, unknown>, status = 200): DoorAnswer => ({ status, body });
const no = (status: number, error: string): DoorAnswer => ({ status, body: { error } });

function keysOf(v: unknown): string[] | null {
  const list = typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(v) ? v : null;
  if (!list || list.length > MAX_AGENTS || !list.every((k) => typeof k === "string" && NKEY.test(k))) return null;
  return list as string[];
}

/** `audit` is the log opened with the export signer, or null when this host has none. */
export function adminAudit(audit: () => AuditLog | null) {
  async function handle(req: AdminRequest): Promise<DoorAnswer | null> {
    const seg = req.path.replace(/^\/admin\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    if (seg[0] !== "audit" || seg.length !== 2) return null;
    const log = audit();
    if (!log) return no(503, "The audit log is not on this host, so it cannot be read here.");
    const b = req.body ?? {};
    try {
      if (seg[1] === "entries" && req.method === "GET") {
        const agents = keysOf(req.query.get("agents") ?? "");
        if (!agents) return no(400, "agents is a comma-separated list of agent public keys.");
        const limit = Math.max(1, Math.min(Number(req.query.get("limit") ?? 50) || 50, 500));
        return ok({ entries: log.list(agents, limit) });
      }
      if (seg[1] === "export" && req.method === "POST") {
        if (typeof b.account !== "string" || !b.account.trim()) return no(400, "account names whose bundle this is.");
        const agents = b.agents === undefined ? log.agentIds() : keysOf(b.agents);
        if (!agents) return no(400, "agents is a list of agent public keys.");
        return ok(log.export(b.account, agents) as unknown as Record<string, unknown>);
      }
      if (seg[1] === "forget" && req.method === "POST") {
        const agents = keysOf(b.agents);
        if (!agents) return no(400, "agents is a list of agent public keys.");
        return ok({ deleted: log.deleteForAgents(agents) });
      }
      if (seg[1] === "heads" && req.method === "GET") return ok({ heads: log.heads() });
    } catch (err) {
      return no(503, `The audit log could not do that: ${(err as Error).message}`);
    }
    return null;
  }
  return { handle };
}

export type AdminAuditRoutes = ReturnType<typeof adminAudit>;
