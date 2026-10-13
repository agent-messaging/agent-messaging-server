/**
 * The transport cut (docs/kill-switch-plan.md item 2).
 *
 * Only nodes are NATS users, and a node credential covers every agent on the
 * node. So stopping one agent cuts its node's connection: every connection key
 * the mint log says carries a stopped agent is revoked AS OF NOW on the broker
 * (live-revoke.ts, the one push path). The node's credential in hand stops
 * working; the node renews over HTTP at once (the adapter re-mints on a
 * revoke-drop), and the renewal door mints it a credential without the stopped
 * agents' subjects. The other agents on the node are back within seconds.
 *
 * Nothing here writes a renewal tombstone or deregisters: a pause is undone by
 * lifting the stop, and the mint doors read the stop list for as long as it
 * stands. Terminate goes further through the signing-key revocation
 * (kill-switch-action.ts `terminateKey`).
 *
 * WHY A MEMORY OF CUT INSTANTS
 *
 * A NATS revocation refuses every JWT for that key issued AT OR BEFORE the
 * revocation's second. A node that re-mints in the same second as the cut
 * would be handed a credential that is already revoked, and would loop. The
 * renewal door asks `mintAfterCut` before it mints on a key, and waits into
 * the next second when it has to.
 */
import type { TrackedCred } from "./cred-renewal-watch.js";
import { revokeLive, type BrokerAdmin, type LiveRevokeConfig } from "./live-revoke.js";

/** What the transport cut did: pressing the switch (api/kill-switch-action.ts) reports it. */
export interface CutResult {
  mode: "live" | "fallback" | "none";
  /** Connection keys revoked at the broker (live) or that would have been. */
  user_keys: number;
  /** Agents not covered by the stop that shared a cut connection. They come
   *  back at once: their node renews without the stopped agents. */
  shared: number;
  note: string;
  /** The connection keys revoked, when the cut ran per connection. */
  keys?: string[];
}

const USER_KEY = /^U[A-Z2-7]{55}$/;

export interface CutDeps {
  mintLog: { all(): Promise<TrackedCred[]>; noteCut?(keys: string[], sec: number): Promise<void> } | null;
  config: () => { ok: true; config: LiveRevokeConfig } | { ok: false; reason: string };
  connectAdmin: (config: LiveRevokeConfig) => Promise<BrokerAdmin>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  verifyWithinMs?: number;
}

/** Connection key -> the second it was last cut, for `mintAfterCut`. */
const cutAt = new Map<string, number>();

/** Wait, when needed, until a credential minted now on `key` is issued after
 *  the key's last cut. Returns how long it waited, in milliseconds. */
export async function mintAfterCut(
  key: string,
  now: () => number = Date.now,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  /** The cut as another process recorded it (CredMintLog.cutAt). */
  recorded?: (key: string) => Promise<number | null>,
): Promise<number> {
  const sec = cutAt.get(key) ?? (recorded ? (await recorded(key).catch(() => null)) ?? undefined : undefined);
  if (sec === undefined) return 0;
  const nowMs = now();
  const wait = (sec + 1) * 1000 - nowMs + 50;
  if (wait <= 0) {
    if (Math.floor(nowMs / 1000) > sec + 60) cutAt.delete(key);
    return 0;
  }
  await sleep(wait);
  return wait;
}

/** For tests: forget every cut instant. */
export function forgetCuts(): void {
  cutAt.clear();
}

/** Which connections carry any of these agents, and who else rides them. */
export function connectionsCarrying(tracked: TrackedCred[], agentKeys: string[]): { keys: string[]; shared: string[] } {
  const want = new Set(agentKeys);
  const hits = tracked.filter((c) => c.agents.some((a) => want.has(a)));
  const keys = [...new Set([...hits.map((c) => c.key), ...agentKeys].filter((k) => USER_KEY.test(k)))];
  const shared = [...new Set(hits.flatMap((c) => c.agents).filter((a) => !want.has(a)))];
  return { keys, shared };
}

export async function cutConnections(deps: CutDeps, agentKeys: string[]): Promise<CutResult & { keys: string[] }> {
  if (!agentKeys.length) return { mode: "none", user_keys: 0, shared: 0, note: "No agents were covered.", keys: [] };
  const tracked = deps.mintLog ? await deps.mintLog.all().catch(() => [] as TrackedCred[]) : [];
  const { keys, shared } = connectionsCarrying(tracked, agentKeys);
  const cfg = deps.config();
  if (!cfg.ok) {
    return {
      mode: "fallback",
      user_keys: keys.length,
      shared: 0,
      note: `The connections were not cut at the broker (${cfg.reason}). Every mint door refuses these agents, so each stops at its next renewal, within seven days.`,
      keys,
    };
  }
  let admin: BrokerAdmin | null = null;
  try {
    admin = await deps.connectAdmin(cfg.config);
    const live = await revokeLive({
      admin,
      accountId: cfg.config.accountId,
      signingSeed: cfg.config.signingSeed,
      userKeys: keys,
      now: deps.now,
      sleep: deps.sleep,
      verifyWithinMs: deps.verifyWithinMs,
    });
    const sec = Math.floor((deps.now ?? Date.now)() / 1000);
    for (const k of keys) cutAt.set(k, sec);
    // And on the mint log, for a mint door in another process (the core's
    // credential doors run apart from the kill switch since step 3).
    await deps.mintLog?.noteCut?.(keys, sec);
    const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
    const back = shared.length ? ` ${n(shared.length, "other agent")} shared a cut connection and ${shared.length === 1 ? "comes" : "come"} back when the node renews without the stopped agents.` : "";
    const verified = live.verified === true
      ? `closed within ${(live.tookMs / 1000).toFixed(1)} seconds`
      : live.verified === false
        ? `revoked, but ${n(live.stillConnected.length, "connection")} still showed after ${(live.tookMs / 1000).toFixed(1)} seconds`
        : "revoked; the broker's connection list could not be read to confirm";
    return { mode: "live", user_keys: keys.length, shared: shared.length, note: `${n(keys.length, "connection")} ${verified}.${back}`, keys };
  } catch (err) {
    return {
      mode: "fallback",
      user_keys: keys.length,
      shared: 0,
      note: `The connections were not cut at the broker (${(err as Error).message}). Every mint door refuses these agents, so each stops at its next renewal, within seven days.`,
      keys,
    };
  } finally {
    await admin?.close().catch(() => undefined);
  }
}
