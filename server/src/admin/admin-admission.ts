/**
 * The admin API's admission routes (step 10a of docs/agent-messaging-server-plan.md):
 * an agent's whole admission roster (EXT-6) and the held-attempt ledger behind
 * an owner's "Waiting" list, for the mesh's operator and for a platform
 * running beside the core, which decides on its accounts' authority and asks
 * the core to keep the result.
 *
 *   PUT    /admin/v1/agents/:key/roster         { roster, authority: "account" | "signed" }: store the whole
 *                                               roster. "signed" stores it only when its own signature
 *                                               verifies (EXT-6 §3); "account" is the account session's
 *                                               authority the platform checked (core §4.9)
 *   DELETE /admin/v1/agents/:key/roster         forget it (the account closed)
 *   GET    /admin/v1/rosters?subject=           every stored roster with an entry for that handle or key
 *                                               (matched without case), with the roster
 *   GET    /admin/v1/held[?agent=&decided=1]    entries still waiting on an owner (every agent's, or one's);
 *                                               with decided=1, one agent's decided entries
 *   POST   /admin/v1/held/report                { agent, sender, handle, operator, note?, facts? }
 *   POST   /admin/v1/held/decide                { agent, sender, stance: "allow" | "block" } -> { entry }
 *   POST   /admin/v1/held/resolve               { agent, sender }
 *   DELETE /admin/v1/held/:agent                every entry for one agent (the account closed) -> { purged }
 *
 * Reading a roster is the existing GET /admin/v1/agents/:key/admission.
 * Each answer is { status, body } and never throws.
 */
import type { DoorAnswer } from "../keychain/doors.js";
import type { AdminRequest } from "./admin-api.js";
import type { AdmissionStore } from "../admission/admission-store.js";
import type { HeldStore, KnockFacts } from "../admission/held-store.js";
import type { KeyedStore } from "../storage/index.js";

const NKEY = /^U[A-Z2-7]{55}$/;

export interface AdminAdmissionDeps {
  admission: Pick<AdmissionStore, "put" | "putAuthorized" | "purge">;
  held: () => Promise<Pick<HeldStore, "report" | "listWaiting" | "allWaiting" | "decide" | "decisions" | "resolve" | "purgeAgent">>;
  /** The rosters' store, for the one route that reads them all. */
  rosters?: () => Promise<KeyedStore>;
}

const ok = (body: Record<string, unknown>, status = 200): DoorAnswer => ({ status, body });
const no = (status: number, error: string): DoorAnswer => ({ status, body: { error } });
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function factsOf(v: unknown): KnockFacts {
  const f = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    ...(typeof f.line === "string" ? { line: f.line } : {}),
    ...(typeof f.files === "number" ? { files: f.files } : {}),
    ...(typeof f.via === "string" ? { via: f.via } : {}),
    ...(Array.isArray(f.grants) ? { grants: f.grants.filter((g): g is string => typeof g === "string") } : {}),
  };
}

export function adminAdmission(deps: AdminAdmissionDeps) {
  async function putRoster(key: string, b: Record<string, unknown>): Promise<DoorAnswer> {
    const roster = b.roster;
    if (!roster || typeof roster !== "object" || Array.isArray(roster)) return no(400, "roster is the whole roster document.");
    if (b.authority === "signed") {
      const stored = await deps.admission.put(key, roster as Record<string, unknown>);
      return stored ? ok({ stored: true }) : no(400, "The roster's signature does not verify for that owner key.");
    }
    if (b.authority !== "account") return no(400, 'authority is "account" or "signed".');
    await deps.admission.putAuthorized(key, roster as Record<string, unknown>, "account");
    return ok({ stored: true });
  }

  async function held(req: AdminRequest): Promise<DoorAnswer | null> {
    const seg = req.path.replace(/^\/admin\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const b = req.body ?? {};
    const store = await deps.held();
    if (seg.length === 1 && req.method === "GET") {
      const agent = req.query.get("agent");
      if (agent === null) return ok({ entries: await store.allWaiting() });
      if (!NKEY.test(agent)) return no(400, "agent is an agent public key.");
      return ok({ entries: req.query.get("decided") === "1" ? await store.decisions(agent) : await store.listWaiting(agent) });
    }
    if (seg.length === 2 && req.method === "DELETE") {
      if (!NKEY.test(seg[1]!)) return no(400, "That is not an agent public key.");
      return ok({ purged: await store.purgeAgent(seg[1]!) });
    }
    if (seg.length === 2 && req.method === "POST") {
      const agent = str(b.agent);
      const sender = str(b.sender);
      if (!agent || !NKEY.test(agent) || !sender) return no(400, "agent (an agent public key) and sender are required.");
      if (seg[1] === "report") {
        await store.report(agent, sender, str(b.handle), str(b.operator), str(b.note) ?? undefined, factsOf(b.facts));
        return ok({ reported: true });
      }
      if (seg[1] === "decide") {
        if (b.stance !== "allow" && b.stance !== "block") return no(400, 'stance is "allow" or "block".');
        return ok({ entry: await store.decide(agent, sender, b.stance) });
      }
      if (seg[1] === "resolve") {
        await store.resolve(agent, sender);
        return ok({ resolved: true });
      }
    }
    return null;
  }

  /** Every stored roster with an entry for this subject (a handle or a key,
   *  matched without case), with the roster: who would be affected when that
   *  subject's name changes. */
  async function rostersNaming(subject: string | null): Promise<DoorAnswer> {
    if (!subject || !subject.trim() || subject.length > 320) return no(400, "subject is a handle or an agent key.");
    if (!deps.rosters) return no(503, "This server cannot list its rosters.");
    const want = subject.trim().toLowerCase();
    const out: Array<{ agent: string; roster: Record<string, unknown> }> = [];
    for (const [agent, e] of (await (await deps.rosters()).list()).entries) {
      if (e.operation !== "PUT" || !e.value.length) continue;
      let roster: Record<string, unknown>;
      try { roster = e.json<Record<string, unknown>>(); } catch { continue; }
      const entries = Array.isArray(roster.entries) ? (roster.entries as Array<{ subject?: unknown }>) : [];
      if (entries.some((x) => typeof x?.subject === "string" && x.subject.trim().toLowerCase() === want)) out.push({ agent, roster });
    }
    return ok({ rosters: out });
  }

  /** The answer for an admission route, or null when the path is not one. */
  async function handle(req: AdminRequest): Promise<DoorAnswer | null> {
    const seg = req.path.replace(/^\/admin\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    try {
      if (seg[0] === "rosters" && seg.length === 1 && req.method === "GET") return await rostersNaming(req.query.get("subject"));
      if (seg[0] === "agents" && seg.length === 3 && seg[2] === "roster") {
        if (!NKEY.test(seg[1]!)) return no(400, "That is not an agent public key.");
        if (req.method === "PUT") return await putRoster(seg[1]!, req.body ?? {});
        if (req.method === "DELETE") { await deps.admission.purge(seg[1]!); return ok({ forgotten: true }); }
      }
      if (seg[0] === "held") return await held(req);
    } catch (err) {
      return no(503, `The core could not do that: ${(err as Error).message}`);
    }
    return null;
  }

  return { handle };
}

export type AdminAdmission = ReturnType<typeof adminAdmission>;
