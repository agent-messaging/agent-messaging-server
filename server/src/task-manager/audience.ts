/**
 * SPEC.md §5.7, the server's part (core profile, §1.6): the task manager
 * applies no Task update whose `meta.audience` is present and is anything
 * other than the string "agent".
 *
 * A sender marks a message for the person behind the receiving agent with
 * `meta.audience: "person"`. Such a message carries no work, so it is never a
 * Task transition, and the update channel is the one path a server holds by
 * which a message for a person could reach a requester's task handler. The
 * signature covers `meta`, so the mark this service reads is the sender's own.
 *
 * Every present value other than "agent" is refused: "person", a string this
 * server does not know (§5.7 rule 5 reads it as "person"), and a value that is
 * not a string, `null` included. Carriage needs no code here: this service
 * never rewrites an envelope it relays, and conformance/audience.json's
 * `server.task_manager` cases are the ones the unit tests and c25 check.
 */

import type { Envelope } from "../sdk.js";

/**
 * The mark as this service judges it: `null` when the update applies (no
 * `meta.audience`, or the string "agent"), otherwise a short label for the log
 * and the invalid-transition report.
 */
export function audienceRefusal(env: Envelope): string | null {
  const meta = (env as { meta?: unknown }).meta;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return null;
  if (!Object.prototype.hasOwnProperty.call(meta, "audience")) return null;
  const value = (meta as Record<string, unknown>).audience;
  if (value === "agent") return null;
  if (typeof value === "string") return value === "person" ? "person" : `unknown string ${JSON.stringify(value)}`;
  return `malformed (${value === null ? "null" : typeof value})`;
}

/**
 * Log a refused first update once per sender, within a bound. A first update
 * names no existing Task, so there are no parties to check and nothing to
 * report on the event bus: publishing a signed event for it would let any key
 * make this service sign traffic about a task that does not exist. Same shape
 * and reasoning as task-parties.ts `reportRefusal`.
 */
const reported = new Set<string>();
const REPORT_CAP = 100;
let refused = 0;

export function reportAudienceFirstUpdate(taskId: string, from: string, label: string): void {
  refused++;
  if (reported.has(from)) return;
  if (reported.size < REPORT_CAP) reported.add(from);
  console.warn(
    `[task-manager] created no Task ${taskId}: the first update from ${from.slice(0, 12)}… is marked ` +
      `meta.audience ${label}, and a message for a person is never a Task transition (SPEC §5.7). ` +
      `${refused} such update(s) so far this process.`,
  );
}
