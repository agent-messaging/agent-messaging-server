/**
 * Who is allowed to touch a task — the question the state machine does not ask.
 *
 * `mesh.task.{id}.update` takes the task id from the SUBJECT and the new state
 * from the PAYLOAD, and `pub mesh.task.>` is in the durable credential template
 * (keychain/cred-template.ts; task ids are not derived from an agent key, so the
 * subject cannot be scoped to one). `mesh.task.get.{id}` is on the same
 * wildcard. So every agent that has signed up can reach every task's update and
 * read subjects, and can also `sub mesh.task.>` and `sub mesh.event.>` — which
 * is how it learns the task ids, requesters, responders and states to aim at. A
 * task id is not a secret and cannot stand in for authorization.
 *
 * `decode()` verifies an envelope's signature against the key named in the
 * envelope's own `from` (§5.3). That proves the sender holds the key it claims
 * and nothing more. §4.6 says the rest out loud: "receivers use the verified
 * `from` for authorization decisions" — and until this module existed, nothing
 * in the task manager did. The transition table (§7.3) was the only gate, and a
 * state-machine check answers "is this a legal move", never "is this your game".
 *
 * THE RULE: a task authorizes exactly two agents, and the record already names
 * them.
 *
 *   - `task.responder` — the agent that created the task. The record is born
 *     from the first update on the subject (nothing else writes the bucket), and
 *     that update's verified `from` becomes `responder`. §7.0/§7.3: the
 *     responder creates the task and drives its lifecycle.
 *   - `task.requester` — the agent the task was addressed to, taken from the
 *     creating envelope's `to`. §7.1 defines both fields as agent nkeys, so this
 *     comparison is against the same kind of value `env.from` holds.
 *
 * EITHER PARTY, not a per-party transition matrix. §7.3's trigger column names
 * which party typically acts, but it does not say which party PUBLISHES the
 * resulting update, and for two rows it is explicitly both: §7.2 has `canceled`
 * entered "by the requester or the responder". The two resumption rows
 * (`input_required → working`, `auth_required → working`) are triggered by the
 * requester supplying input or credentials via a follow-up `request` — which
 * arrives at the responder, so either party could reasonably publish the update,
 * and no SDK implements those rows yet to settle it. Guessing one and denying
 * the other would break a flow the spec permits, and it would break it as a
 * stuck task rather than an error. "Either party" is the tightest rule that
 * provably admits every row of §7.3.
 *
 * NO THIRD PARTY. Considered and deliberately not allowed:
 *
 *   - A supervisor or delegate. §10.3 `delegate` gives agent A a NEW task with C
 *     as responder and A as requester; A stays a party to its own task and never
 *     needs to reach into C's. §10.9 `transfer` is parked, and its own text has
 *     the receiving agent create a new task. No third actor appears in §7.3.
 *   - The platform itself. The task manager consumes updates; it never publishes
 *     one. An allowance for its key would be a standing forgery oracle for
 *     anything that read TASK_MANAGER_SEED, and would buy nothing that exists.
 *   - A node acting for a hosted agent. Under node-held keys (§4.5) the node
 *     signs AS the agent, so `from` is already the agent's key; §4.7 requires
 *     local delivery to be observationally identical, "same identity
 *     verification (`sig` against `from`)". A node needs no separate identity
 *     here, and giving it one would reintroduce the "is this crossing a node
 *     boundary?" branch §4.5 exists to remove.
 *   - A federated peer. §21: agents visit, traffic does not tunnel — "a visitor
 *     is a real client of the instance holding the state", publishing its own
 *     signed envelopes with its own key. Nothing relays on an agent's behalf.
 *
 * If a third party is ever genuinely needed, it belongs here as a named,
 * configured identity with its reason written down — the way the catalog names
 * the registry (catalog-service.ts) — not as a gap left open in case.
 */

import type { Task } from "../sdk.js";

/** The identifying fields, so callers can pass a partial record. */
export type TaskParties = Pick<Task, "requester" | "responder">;

/**
 * Is `from` — a signature-verified sender — one of this task's two parties?
 *
 * Exact string equality on nkeys, which are uppercase base32 and so have no
 * case or normalization question. An empty `requester` (a record written before
 * a creating update was required to name one) matches nothing: `from` cannot be
 * empty, because `decode()` had to verify a signature against it.
 */
export function isPartyToTask(task: TaskParties, from: string): boolean {
  return from === task.responder || from === task.requester;
}

/**
 * Log one refusal per distinct sender, and never more.
 *
 * An attacker mints signing keys for nothing and can publish on these subjects
 * as fast as the transport allows, so a line per refused message is a
 * disk-filling amplifier, and an unbounded set of the keys already seen is a
 * memory leak reachable from the open bus. Same shape, and the same reasoning,
 * as the catalog's forged-event reporting.
 *
 * Refusals are deliberately NOT published as an event: the task manager signs
 * what it emits, so an event per refusal would let a stranger drive signed
 * platform traffic about a task it has no part in — which is a smaller version
 * of the thing being fixed.
 */
const reported = new Set<string>();
const REPORT_CAP = 100;
let refusals = 0;

export function reportRefusal(what: string, from: string, detail: string): void {
  refusals++;
  if (reported.has(from)) return;
  if (reported.size < REPORT_CAP) reported.add(from);
  console.warn(
    `[task-manager] REFUSED ${what} from ${from.slice(0, 12)}… — ${detail} The envelope ` +
      `signature is valid, so this is a signed message from an agent that is not a party to ` +
      `this task. ${refusals} refusal(s) so far this process.`,
  );
}
