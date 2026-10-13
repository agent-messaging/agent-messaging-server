/**
 * The mesh pause's own cut (docs/kill-switch-plan.md item 8): the customer
 * signing key taken out of the account, or put back, live at the broker
 * (split-keys.ts). Falls back, and says why, when the signing keys are not
 * split or the broker cannot take account updates; the caller then cuts each
 * customer connection one by one.
 *
 * In the core since step 10a: the platform's kill switch decides to pause the
 * mesh and asks the core (POST /admin/v1/keychain/mesh-pause), which holds the
 * operator signing key this needs.
 */
import { connectBrokerAdmin, liveRevokeConfig } from "./live-revoke.js";
import { customerSigningKey, JWT_HISTORY_SETTING, setCustomerKeyLive } from "./split-keys.js";

export interface MeshPauseAnswer {
  mode: "live" | "fallback";
  user_keys: number;
  shared: number;
  note: string;
}

export async function meshPause(pause: boolean, env: NodeJS.ProcessEnv = process.env): Promise<MeshPauseAnswer> {
  const key = customerSigningKey(env);
  if (!key) return { mode: "fallback", user_keys: 0, shared: 0, note: "The signing keys are not split on this mesh (MESH_CUSTOMER_SIGNING_KEY is not set), so each customer connection is cut one by one instead." };
  const cfg = liveRevokeConfig();
  if (!cfg.ok) return { mode: "fallback", user_keys: 0, shared: 0, note: `The broker could not be updated (${cfg.reason}), so each customer connection is cut one by one instead.` };
  const admin = await connectBrokerAdmin(cfg.config);
  try {
    const r = await setCustomerKeyLive({
      admin,
      accountId: cfg.config.accountId,
      operatorSigningSeed: cfg.config.signingSeed,
      customerKey: key,
      present: !pause,
      historyDir: env[JWT_HISTORY_SETTING],
    });
    return { mode: "live", user_keys: 0, shared: 0, note: r.note };
  } finally {
    await admin.close().catch(() => undefined);
  }
}
