/**
 * Which stops reach an agent, and what a mint door answers for a stopped one.
 *
 * The kill switch's coverage rules, moved here from api/kill-switch.ts in step 3
 * of docs/agent-messaging-server-plan.md, because the core's credential doors
 * (doors.ts) ask them before every mint. Pure: the caller hands in the stops in
 * force and where each agent sits. Pressing and lifting a stop, with its
 * authority rules, stay with the platform in api/kill-switch.ts, which
 * re-exports these.
 */
import { ADMIN_VIA, type StopAction, type StopRecord } from "./stop-record.js";

/** Where one agent sits, as the kill switch reads it. */
export interface AgentOwnership {
  key: string;
  /** The person whose agent it is: the account a home organization is for, or
   *  the account holding it on a pre-organization record. Null for an agent an
   *  organization owns. */
  person: string | null;
  /** The organization holding it, home or not. Null when organizations are
   *  off or no organization holds it. */
  org: string | null;
  category?: string;
  label?: string;
}

/** Does this stop cover this agent? */
export function covers(stop: Pick<StopRecord, "scope" | "target">, own: AgentOwnership): boolean {
  switch (stop.scope) {
    case "agent":
      return stop.target === own.key;
    case "person":
      return !!own.person && stop.target === own.person;
    case "org":
      return !!own.org && stop.target === own.org;
    case "mesh":
      return own.category !== "mesh-system";
  }
}

export interface StopFinding {
  /** The stop that decides: a terminate if any covers the agent, else the
   *  oldest pause. */
  stop: StopRecord;
  action: StopAction;
  /** Every stop in force that covers the agent. */
  all: StopRecord[];
}

/** The stop in force for this agent, or null when none covers it. `stops`
 *  are the ACTIVE stops (lifted ones are ignored here too, defensively). */
export function stopFor(stops: StopRecord[], own: AgentOwnership): StopFinding | null {
  const hits = stops.filter((s) => !s.lifted && covers(s, own));
  if (!hits.length) return null;
  const term = hits.find((s) => s.action === "terminate");
  const stop = term ?? [...hits].sort((a, b) => a.at.localeCompare(b.at))[0];
  return { stop, action: stop.action, all: hits };
}

/**
 * The stops in force for each of these keys, the question every mint door
 * asks. `world` is where every agent sits; null means only one-agent stops are
 * in force, and nothing needs resolving. A key nobody holds is covered by the
 * mesh scope and by its own one-agent stops only.
 */
export function stopsForKeys(active: StopRecord[], keys: string[], world: AgentOwnership[] | null): Map<string, StopFinding> {
  const out = new Map<string, StopFinding>();
  if (!active.length) return out;
  for (const key of keys) {
    const own = world?.find((a) => a.key === key) ?? { key, person: null, org: null };
    const f = stopFor(active, own);
    if (f) out.set(key, f);
  }
  return out;
}

/** Split a node's roster into the agents it may still carry and the stopped
 *  ones, keeping the roster's order. */
export function partitionRoster(ids: string[], stopped: Map<string, StopFinding>): { running: string[]; stopped: Array<{ id: string; code: string }> } {
  return {
    running: ids.filter((k) => !stopped.has(k)),
    stopped: ids.filter((k) => stopped.has(k)).map((k) => ({ id: k, code: stopped.get(k)!.action === "terminate" ? AGENT_TERMINATED : AGENT_PAUSED })),
  };
}

/** The machine codes a refusal carries, one spelling everywhere (mint doors,
 *  registry, inbox, adapter, SDK). */
export const AGENT_PAUSED = "agent_paused";
export const AGENT_TERMINATED = "agent_terminated";

function scopeWords(s: StopRecord): string {
  if (s.via === ADMIN_VIA && s.scope !== "mesh") return "this mesh's operator";
  switch (s.scope) {
    case "agent": return "its owner";
    case "person": return "its owner, who paused everything they own";
    case "org": return "its organization";
    case "mesh": return "AgentMesh, which paused the whole mesh";
  }
}

/** What a mint door answers for a stopped agent. Said plainly, so an adapter
 *  can show it and wait rather than retrying in a loop. */
export function mintRefusal(f: StopFinding, agentKey: string): { status: number; body: Record<string, unknown> } {
  const who = scopeWords(f.stop);
  if (f.action === "terminate") {
    return {
      status: 403,
      body: {
        error: `Agent ${agentKey.slice(0, 12)}... was terminated by ${who} on ${f.stop.at}. It cannot be issued a credential again.`,
        code: AGENT_TERMINATED,
        stopped_at: f.stop.at,
        scope: f.stop.scope,
      },
    };
  }
  return {
    status: 403,
    body: {
      error: `Agent ${agentKey.slice(0, 12)}... is paused by ${who} since ${f.stop.at}. It gets a credential again when the pause is lifted; check back in a few minutes.`,
      code: AGENT_PAUSED,
      stopped_at: f.stop.at,
      scope: f.stop.scope,
      retry_after_seconds: 300,
    },
  };
}
