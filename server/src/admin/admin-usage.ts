/**
 * The usage store's Monitor tables, for a platform beside the core (step 10a
 * of docs/agent-messaging-server-plan.md).
 *
 * The activity service counts traffic into hourly (sender, receiver) rows and
 * logs the exceptions (a failed or refused delivery) in the usage store
 * (activity/usage-store.ts). AgentMesh's Monitor page adds to the same rows
 * (what a guard said about a message at a hosted agent, the hosts' job
 * reports), reads them for an account's agents, decides held messages and
 * keeps its alarms there. It used to open the store in its own process; it now
 * asks the core through these routes.
 *
 *   POST /admin/v1/usage/record { pairs?, compute?, events? }   add counts and exceptions
 *   POST /admin/v1/usage/monitor/read { agents, since_hour }    pair and compute rows
 *   POST /admin/v1/usage/monitor/events { agents, since_ms, limit? }  exceptions, newest first
 *   POST /admin/v1/usage/monitor/held { agents, since_ms }      how many holds are open
 *   GET  /admin/v1/usage/monitor/events/:id                     one exception
 *   POST /admin/v1/usage/monitor/events/:id/decide { state }    release or discard an open hold
 *   GET  /admin/v1/usage/monitor/alarms[?account=]              an account's alarms, or every one
 *   PUT  /admin/v1/usage/monitor/alarms/:id { alarm }           store an alarm
 *   DELETE /admin/v1/usage/monitor/alarms/:id?account=          delete one of an account's alarms
 *
 * Nothing here is a message: counts, times, keys, reason categories in words.
 * Each answer is { status, body } and never throws.
 */
import type { DoorAnswer } from "../keychain/doors.js";
import type { AdminRequest } from "./admin-api.js";
import type { Alarm, ComputeCounts, MonitorEvent, MonitorRead, MonitorTables, PairCounts } from "../activity/monitor-types.js";
import { ALARM_KINDS, MONITOR_OUTCOMES } from "../activity/monitor-types.js";

const NKEY = /^U[A-Z2-7]{55}$/;
const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
/** An event's or alarm's id: the store's own (a UUID, `m-<message id>`,
 *  `al_...`), at most 64 characters, nothing that is not printable. */
const ID = /^[\x21-\x7e]{1,64}$/;
/** The most rows one record call takes, and agents one read names. */
export const MAX_ROWS = 500;
export const MAX_AGENTS = 2000;

/** What the routes need of the usage store (activity/usage-store.ts). */
export interface UsageLike {
  recordPair(sender: string, receiver: string, patch: Partial<Omit<PairCounts, "h" | "lat_n" | "lat_ms">> & { latMs?: number }, at?: number): void;
  recordCompute(agent: string, payer: string, patch: Partial<ComputeCounts>, at?: number): void;
  recordEvent(e: Omit<MonitorEvent, "id" | "state"> & { id?: string }): string | null;
  monitorRead(agents: string[], sinceHour: string): Promise<MonitorRead>;
  monitorEvents(agents: string[], sinceMs: number, limit?: number): Promise<MonitorEvent[]>;
  readonly monitor: Pick<MonitorTables, "event" | "decide" | "openHeld" | "alarms" | "putAlarm" | "deleteAlarm">;
}

const ok = (body: Record<string, unknown>, status = 200): DoorAnswer => ({ status, body });
const no = (status: number, error: string): DoorAnswer => ({ status, body: { error } });
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const PAIR_COUNTS = ["msgs", "delivered", "failed", "refused", "passed", "held", "flagged", "unchecked"] as const;
const COMPUTE_COUNTS = ["jobs", "job_ms", "failed", "mem_mb", "tokens_in", "tokens_out", "cost_micros"] as const;

function agentsOf(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_AGENTS) return null;
  return v.every((k) => typeof k === "string" && (NKEY.test(k) || k === "~other")) ? (v as string[]) : null;
}

function alarmOf(v: unknown, id: string): Alarm | null {
  const a = v as Partial<Alarm> | null;
  if (!a || typeof a !== "object" || a.id !== id) return null;
  if (!str(a.account_id) || !str(a.scope) || !ALARM_KINDS.includes(a.kind as never)) return null;
  if (a.state !== "ALARM" && a.state !== "OK" && a.state !== "NOT ENOUGH DATA") return null;
  if (a.threshold !== null && num(a.threshold) === undefined) return null;
  if (a.value !== null && typeof a.value !== "number") return null;
  if (num(a.created_at) === undefined || num(a.since) === undefined || num(a.emailed_at) === undefined) return null;
  return {
    id, account_id: a.account_id!, scope: a.scope!, kind: a.kind!, threshold: a.threshold ?? null,
    created_at: a.created_at!, state: a.state, value: a.value ?? null, since: a.since!, emailed_at: a.emailed_at!,
  };
}

export function adminUsage(usage: () => UsageLike | null) {
  function record(b: Record<string, unknown>): DoorAnswer {
    const pairs = Array.isArray(b.pairs) ? b.pairs : [];
    const compute = Array.isArray(b.compute) ? b.compute : [];
    const events = Array.isArray(b.events) ? b.events : [];
    if (pairs.length + compute.length + events.length > MAX_ROWS) return no(413, `At most ${MAX_ROWS} rows a call.`);
    const u = usage();
    if (!u) return no(503, "The usage store cannot be opened on this server.");
    let taken = 0;
    for (const r of pairs as Array<Record<string, unknown>>) {
      if (!r || !str(r.sender) || !str(r.receiver)) continue;
      const p = (r.patch ?? {}) as Record<string, unknown>;
      const patch: Partial<Omit<PairCounts, "h" | "lat_n" | "lat_ms">> & { latMs?: number } = {};
      for (const f of PAIR_COUNTS) { const v = num(p[f]); if (v !== undefined) patch[f] = Math.round(v); }
      const lat = num(p.latMs);
      if (lat !== undefined) patch.latMs = lat;
      u.recordPair(r.sender as string, r.receiver as string, patch, num(r.at));
      taken++;
    }
    for (const r of compute as Array<Record<string, unknown>>) {
      if (!r || !str(r.agent) || typeof r.payer !== "string") continue;
      const p = (r.patch ?? {}) as Record<string, unknown>;
      const patch: Partial<ComputeCounts> = {};
      for (const f of COMPUTE_COUNTS) { const v = num(p[f]); if (v !== undefined) patch[f] = v; }
      u.recordCompute(r.agent as string, r.payer, patch, num(r.at));
      taken++;
    }
    const ids: Array<string | null> = [];
    for (const r of events as Array<Record<string, unknown>>) {
      const outcome = r?.outcome as MonitorEvent["outcome"];
      if (!r || !MONITOR_OUTCOMES.includes(outcome) || num(r.at) === undefined || typeof r.sender_id !== "string" || typeof r.receiver_id !== "string") {
        ids.push(null);
        continue;
      }
      ids.push(u.recordEvent({
        ...(str(r.id) && ID.test(r.id as string) ? { id: r.id as string } : {}),
        at: r.at as number,
        sender_id: r.sender_id,
        receiver_id: r.receiver_id,
        outcome,
        reason: typeof r.reason === "string" ? r.reason : "",
        ms: num(r.ms) ?? null,
        account_id: str(r.account_id),
        message_id: str(r.message_id),
      }));
      taken++;
    }
    return ok({ taken, event_ids: ids });
  }

  async function route(seg: string[], m: string, q: URLSearchParams, b: Record<string, unknown>): Promise<DoorAnswer | null> {
    if (seg.length === 1 && seg[0] === "record" && m === "POST") return record(b);
    if (seg[0] !== "monitor") return null;
    const u = usage();
    if (!u) return no(503, "The usage store cannot be opened on this server.");
    const [, what, id, sub] = seg;
    if (what === "read" && seg.length === 2 && m === "POST") {
      const agents = agentsOf(b.agents);
      const since = str(b.since_hour);
      if (!agents || !since || !HOUR.test(since)) return no(400, "agents is a list of agent keys and since_hour an hour like 2026-10-12T09.");
      const read = await u.monitorRead(agents, since);
      return ok({ pairs: read.pairs, compute: read.compute });
    }
    if (what === "events" && seg.length === 2 && m === "POST") {
      const agents = agentsOf(b.agents);
      const since = num(b.since_ms);
      if (!agents || since === undefined) return no(400, "agents is a list of agent keys and since_ms a time in milliseconds.");
      return ok({ events: await u.monitorEvents(agents, since, num(b.limit) ?? 200) });
    }
    if (what === "held" && seg.length === 2 && m === "POST") {
      const agents = agentsOf(b.agents);
      const since = num(b.since_ms);
      if (!agents || since === undefined) return no(400, "agents is a list of agent keys and since_ms a time in milliseconds.");
      return ok({ open: agents.length ? await u.monitor.openHeld(agents, since) : 0 });
    }
    if (what === "events" && id !== undefined) {
      if (!ID.test(id)) return no(400, "That is not an event id.");
      if (seg.length === 3 && m === "GET") return ok({ event: await u.monitor.event(id) });
      if (seg.length === 4 && sub === "decide" && m === "POST") {
        if (b.state !== "released" && b.state !== "discarded") return no(400, 'state is "released" or "discarded".');
        return ok({ decided: await u.monitor.decide(id, b.state) });
      }
    }
    if (what === "alarms") {
      if (seg.length === 2 && m === "GET") return ok({ alarms: await u.monitor.alarms(q.get("account") || null) });
      if (seg.length === 3 && id !== undefined) {
        if (!ID.test(id)) return no(400, "That is not an alarm id.");
        if (m === "PUT") {
          const alarm = alarmOf(b.alarm, id);
          if (!alarm) return no(400, "alarm is an alarm record whose id is the one in the path.");
          await u.monitor.putAlarm(alarm);
          return ok({ stored: true });
        }
        if (m === "DELETE") {
          const account = q.get("account");
          if (!account) return no(400, "account is required.");
          return ok({ deleted: await u.monitor.deleteAlarm(id, account) });
        }
      }
    }
    return null;
  }

  async function handle(req: AdminRequest): Promise<DoorAnswer | null> {
    const seg = req.path.replace(/^\/admin\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    if (seg[0] !== "usage") return null;
    try {
      return await route(seg.slice(1), req.method, req.query, req.body ?? {});
    } catch (err) {
      return no(503, `The usage store could not do that: ${(err as Error).message}`);
    }
  }

  return { handle };
}

export type AdminUsage = ReturnType<typeof adminUsage>;
