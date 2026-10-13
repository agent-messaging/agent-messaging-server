/**
 * The one revoke action (docs/live-revocation-plan.md item 3).
 *
 * Every door that takes a credential away calls this: the operator's loopback
 * door (POST /internal/credential/revoke), the operator console's button, a
 * holder revoking its own credential, and an owner rotating a leaked agent key.
 * It does the same things in the same order every time:
 *
 *   1. record the revocation in the existing store, so the key is refused its
 *      next credential whatever happens after this;
 *   2. work out which connection keys carry this agent (the mint log knows),
 *      add them to the account JWT's revocations, sign it with the operator
 *      signing key and push it to the running broker (live-revoke.ts);
 *   3. deregister the agent, so nobody is sent to an address that is gone;
 *   4. check the broker's own connection list until the connection is gone,
 *      and say so, or say it is still there.
 *
 * When the push path is not configured (the broker is still on the memory
 * resolver, or a setting is missing) or the broker refuses the push, step 2
 * falls back to what this mesh did before: the key is refused its next
 * credential and the one in hand keeps working until it expires. The answer
 * says exactly that, with the window, in plain words.
 */
import type { TrackedCred } from "./cred-renewal-watch.js";
import {
  fallbackWindow,
  revokeLive,
  type BrokerAdmin,
  type LiveRevokeConfig,
} from "./live-revoke.js";

const USER_KEY = /^U[A-Z2-7]{55}$/;

export interface CredentialRevokeDeps {
  /** Step 1. Null when this process cannot record revocations at all. */
  tombstone: { revoke(agentKey: string, reason: string, by: string): Promise<{ at: string }> } | null;
  /** Where issued credentials are remembered. Null when unavailable: then only
   *  the keys the caller named are revoked at the broker. */
  mintLog: { all(): Promise<TrackedCred[]>; purge(key: string): Promise<void> } | null;
  /** The push path's configuration (live-revoke.ts liveRevokeConfig). */
  config: () => { ok: true; config: LiveRevokeConfig } | { ok: false; reason: string };
  connectAdmin: (config: LiveRevokeConfig) => Promise<BrokerAdmin>;
  deregister: ((agentKey: string) => Promise<void>) | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  verifyWithinMs?: number;
}

export interface CredentialRevokeInput {
  /** The agent whose credentials are revoked. Absent when the caller names
   *  connection keys only (a holder revoking one credential of its own). */
  agentKey?: string;
  /** Extra connection keys to revoke, beyond what the mint log knows (a fleet
   *  credential minted by hand with nsc, for instance). */
  userKeys?: string[];
  reason: string;
  by: string;
  /** Record a tombstone for `agentKey` (default true). A holder revoking one
   *  of its own credentials leaves the agent in good standing. */
  refuseRenewal?: boolean;
  /** Deregister `agentKey` from the registry (default true). */
  deregister?: boolean;
}

export interface CredentialRevokeResult {
  ok: true;
  revoked: true;
  at: string;
  mode: "live" | "fallback";
  /** Connection keys the broker was told to refuse (live) or would have been. */
  user_keys: string[];
  /** Other agents that shared a revoked connection and were cut off with it. */
  also_disconnected_agents: string[];
  deregistered: boolean;
  /** Live only: true when the broker's connection list no longer shows any of
   *  the keys, false when one outlived the check, null when it could not be read. */
  disconnected: boolean | null;
  still_connected: string[];
  took_ms: number | null;
  /** Fallback only: why the live path did not run. */
  fallback_reason?: string;
  /** Fallback only: how long the credential in hand stays usable. */
  window?: string;
  /** One or two sentences for the operator, in plain words. */
  note: string;
}

export async function revokeCredential(
  deps: CredentialRevokeDeps,
  input: CredentialRevokeInput,
): Promise<CredentialRevokeResult> {
  const now = deps.now ?? Date.now;
  const agentKey = input.agentKey;
  const refuse = input.refuseRenewal !== false && !!agentKey;

  // 1. Record it first, so the refusal stands even if everything after fails.
  let at = new Date(now()).toISOString();
  if (refuse && agentKey) {
    if (!deps.tombstone) throw new Error("revocations cannot be recorded on this process (no JetStream)");
    at = (await deps.tombstone.revoke(agentKey, input.reason, input.by)).at;
  }

  // 2a. Which connections carry this agent.
  let tracked: TrackedCred[] = [];
  if (deps.mintLog && agentKey) {
    tracked = (await deps.mintLog.all().catch(() => [])).filter((c) => c.agents.includes(agentKey));
  }
  const userKeys = [
    ...new Set([
      ...tracked.map((c) => c.key),
      ...(agentKey ? [agentKey] : []),
      ...(input.userKeys ?? []),
    ].filter((k) => USER_KEY.test(k))),
  ];
  const others = [...new Set(tracked.flatMap((c) => c.agents).filter((a) => a !== agentKey))];

  let deregistered = false;
  const deregisterOnce = async () => {
    if (deregistered || input.deregister === false || !agentKey || !deps.deregister) return;
    try { await deps.deregister(agentKey); deregistered = true; } catch { /* advisory */ }
  };

  // 2b. Push it to the broker, when the mesh is set up for that.
  const cfg = deps.config();
  let fallbackReason: string | null = cfg.ok ? null : cfg.reason;
  let live: Awaited<ReturnType<typeof revokeLive>> | null = null;
  if (cfg.ok && userKeys.length) {
    let admin: BrokerAdmin | null = null;
    try {
      admin = await deps.connectAdmin(cfg.config);
      live = await revokeLive({
        admin,
        accountId: cfg.config.accountId,
        signingSeed: cfg.config.signingSeed,
        userKeys,
        now: deps.now,
        sleep: deps.sleep,
        verifyWithinMs: deps.verifyWithinMs,
        // 3. Deregister between the push and the check.
        afterPush: deregisterOnce,
      });
    } catch (err) {
      fallbackReason = `the broker could not be updated (${(err as Error).message})`;
    } finally {
      await admin?.close().catch(() => undefined);
    }
  } else if (cfg.ok) {
    fallbackReason = "no connection key is known for this agent";
  }
  await deregisterOnce();

  // Credentials that will never renew must not look overdue to the renewal
  // watcher for the rest of their lives.
  if (deps.mintLog) {
    for (const c of tracked) await deps.mintLog.purge(c.key).catch(() => undefined);
    for (const k of input.userKeys ?? []) await deps.mintLog.purge(k).catch(() => undefined);
  }

  if (live) {
    const secs = (live.tookMs / 1000).toFixed(1);
    const sharing = others.length
      ? ` ${others.length} other agent${others.length === 1 ? "" : "s"} shared that connection and ${others.length === 1 ? "was" : "were"} cut off too; ${others.length === 1 ? "it comes" : "they come"} back when ${others.length === 1 ? "its" : "their"} node renews without the revoked agent.`
      : "";
    const renew = refuse ? " The key will not be issued another credential." : "";
    const note =
      live.verified === true
        ? `Revoked on the broker. The connection closed within ${secs} seconds.${renew}${sharing}`
        : live.verified === false
          ? `Revoked on the broker, but ${live.stillConnected.length} connection${live.stillConnected.length === 1 ? " was" : "s were"} still open after ${secs} seconds. Check the broker's connection list for ${live.stillConnected.map((k) => `${k.slice(0, 12)}...`).join(", ")}.${renew}`
          : `Revoked on the broker. The broker's connection list could not be read, so the disconnect was not confirmed.${renew}${sharing}`;
    return {
      ok: true,
      revoked: true,
      at,
      mode: "live",
      user_keys: userKeys,
      also_disconnected_agents: others,
      deregistered,
      disconnected: live.verified,
      still_connected: live.stillConnected,
      took_ms: live.tookMs,
      note,
    };
  }

  const window = fallbackWindow(tracked.map((c) => c.expiresAt), now());
  const reason = fallbackReason ?? "the live path did not run";
  const note = refuse
    ? `Live revocation did not happen: ${reason}. The key will not be issued another credential. ${window}`
    : `Live revocation did not happen: ${reason}. Nothing was changed at the broker.`;
  return {
    ok: true,
    revoked: true,
    at,
    mode: "fallback",
    user_keys: userKeys,
    also_disconnected_agents: [],
    deregistered,
    disconnected: null,
    still_connected: [],
    took_ms: null,
    fallback_reason: reason,
    ...(refuse ? { window } : {}),
    note,
  };
}
