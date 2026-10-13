/**
 * Boot tokens: the single-use keys `agentmesh up <key>` redeems at
 * `/v1/bootstrap`. Moved here from the account store in step 3 of
 * docs/agent-messaging-server-plan.md, because the bootstrap door is the
 * core's; the bucket kept its name, so nothing was copied.
 *
 * Single-use, single-agent: whoever mints one hands it to ONE agent, and the
 * exchange burns it. A leak costs one agent slot, never the account. In
 * AgentMesh the console mints them under a person's session; a core alone
 * mints them through its admin API (plan step 6).
 */
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";

/** What a token carries besides its account and label. `deferName`: the agent
 *  joins with no name and no naming proposal, because whoever installs it
 *  binds the name itself once it is ready (a container install). */
export interface BootTokenOpts {
  deferName?: boolean;
}

export interface BootTokenData {
  accountId: string;
  label: string;
  name?: string;
  org?: string;
  deferName?: boolean;
}

/** The bucket, opened with the settings it has always had. */
export async function openBootTokenBucket(js: StorageLike): Promise<KeyedStore> {
  // Bootstrap tokens ride in an email and get pasted into an agent's config
  // later that day (or week): a longer, single-use window, seven days
  // (storage/catalog.ts). The name is written out because
  // closure-registry.test.ts finds buckets by reading these calls.
  return storageOf(js).keyed("mesh_boot_tokens");
}

export class BootTokens {
  private kv: KeyedStore;

  constructor(kv: KeyedLike) {
    this.kv = keyedOf(kv);
  }

  static async create(js: StorageLike): Promise<BootTokens> {
    return new BootTokens(await openBootTokenBucket(js));
  }

  /** `org`, when given, is an organisation the agent joins at bootstrap
   *  besides the account's home: the approver of a deploy request chose it. */
  async put(token: string, accountId: string, label: string, name?: string, org?: string, opts: BootTokenOpts = {}): Promise<void> {
    await this.kv.put(token, JSON.stringify({
      accountId, label, name, ...(org ? { org } : {}),
      ...(opts.deferName ? { deferName: true } : {}),
      at: new Date().toISOString(),
    }));
  }

  /**
   * Redeem a token: its data, or null when it is unknown, used or expired.
   *
   * Single-use means single-use under concurrency too: the token is claimed by
   * purging it AT the revision read. Get-then-delete let two simultaneous
   * redemptions both see a live value and both proceed, so a leaked key
   * onboarded N agents. Purge rather than delete, so the spent value (account
   * id and label) is not left readable as history.
   */
  async take(token: string): Promise<BootTokenData | null> {
    try {
      const entry = await this.kv.get(token);
      if (!entry?.value.length) return null;
      const data = entry.json<BootTokenData>();
      try {
        await this.kv.purge(token, { previousRevision: entry.revision });
      } catch {
        return null; // somebody else claimed it first
      }
      return data ?? null;
    } catch {
      return null;
    }
  }
}
