/**
 * The agents discover never lists (docs/agent-categories-plan.md, item 13):
 * Mesh Internal Test Agents, archived agents, agents in the trash, agents the
 * platform holds back, and agents retired or removed from their host.
 *
 * Since step 3 of docs/agent-messaging-server-plan.md the registry reads this
 * from the core's own stores (coreUnlistedResolver): the ownership record says
 * which agents may be listed, and the key chain's tombstones say which were
 * retired. Before, the API answered it in process. A resolver can still be
 * installed in its place (tests do). With nothing installed, or when the
 * answer fails, nothing is dropped: a listing that shows a test agent is a
 * smaller fault than a discover that returns nothing.
 */
import type { StorageLike } from "../storage/index.js";
import { AgentOwnerStore, listedOf } from "../keychain/agent-owners.js";
import { CredRevocationStore } from "../keychain/cred-revocation.js";

export type UnlistedResolver = () => Promise<Set<string>>;

let resolveUnlisted: UnlistedResolver | null = null;

export function setUnlistedResolver(fn: UnlistedResolver | null): void {
  resolveUnlisted = fn;
}

export async function unlistedKeys(): Promise<Set<string>> {
  if (!resolveUnlisted) return new Set();
  try {
    return await resolveUnlisted();
  } catch {
    return new Set();
  }
}

/** How long one reading is used. Discover asks on every call; a change shows
 *  in discovery within this. */
export const UNLISTED_MEMO_MS = 5_000;

/**
 * The core's own answer: every agent the ownership record says may not be
 * listed, and every agent a tombstone says was retired or removed from its
 * host. Read whole and kept for a few seconds. Throws when either store cannot
 * be read completely, which unlistedKeys turns into "nothing is dropped".
 */
export async function coreUnlistedResolver(js: StorageLike, now: () => number = Date.now): Promise<UnlistedResolver> {
  const owners = await AgentOwnerStore.create(js);
  const tombstones = await CredRevocationStore.create(js);
  let memo: { at: number; keys: Set<string> } | null = null;
  return async () => {
    if (memo && now() - memo.at < UNLISTED_MEMO_MS) return memo.keys;
    const keys = new Set<string>();
    for (const [k, rec] of await owners.allAgents()) if (!listedOf(rec)) keys.add(k);
    for (const k of await tombstones.retiredKeys()) keys.add(k);
    memo = { at: now(), keys };
    return keys;
  };
}
