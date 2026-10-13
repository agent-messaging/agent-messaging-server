/**
 * A stop on the stop list (keychain/stop-store.ts): what was stopped, how,
 * by whom and why. The kill switch's rules for who may press and what a stop
 * covers are the platform's (api/kill-switch.ts); the record itself is the
 * core's, because the key chain reads the list at every mint.
 */

export type StopScope = "agent" | "person" | "org" | "mesh";

/** `via` on a stop the core's admin API placed (admin/admin-api.ts, a
 *  credential revoke for an agent or a tenant). It is placed on the operator's
 *  authority, so an agent's owner cannot lift it; the admin API's restore
 *  does, and so can AgentMesh's operator console. */
export const ADMIN_VIA = "mesh-admin";
export type StopAction = "pause" | "terminate";
export type Authority = "owner" | "org_admin" | "operator";

/** Who pressed (or lifted): the authority they pressed on, and whose. */
export interface Presser {
  authority: Authority;
  /** The account that pressed. Absent only for the operator's loopback door. */
  account?: string;
  /** For `org_admin`: the organization the admin acted for. */
  org?: string;
}

export interface StopRecord {
  id: string;
  scope: StopScope;
  /** Agent key, account id, organization id, or "mesh". */
  target: string;
  /** A name for the target, for people reading the record (agent label or
   *  handle, the person's email, the organization's name). */
  target_label?: string;
  action: StopAction;
  by: Presser;
  why: string;
  at: string;
  /** How many agents the stop covered when it was pressed. */
  count: number;
  /** What the transport cut did, in one sentence, when it ran. */
  cut?: string;
  /** The connection keys the cut revoked. A lift cuts them once more, so each
   *  node re-mints at once with its resumed agents back on the credential
   *  instead of waiting for its next renewal. */
  cut_keys?: string[];
  /** Terminate only: the package the agent was installed from, when a deploy
   *  record says. Every deploy path refuses these exact bytes from then on
   *  (item 5, "Nothing starts again"). */
  package?: { name: string; version: string; sha256: string };
  /** Pressed by an account with no passkey: confirmed by a recent sign-in and
   *  the typed words instead (the owner's decision, 2026-09-27). */
  without_passkey?: true;
  /** Placed by AgentMesh, not pressed by anyone: a person's agent that had no
   *  message for the idle days (tenant-wake/waker.ts) is paused on its
   *  owner's authority, so the owner's own Resume lifts it with one press. */
  idle?: true;
  /** Set at the lift. `discarded`: the person chose "discard what was held",
   *  and this many messages that had waited were thrown away instead of
   *  delivered. */
  lifted?: { at: string; by: Presser; why?: string; without_passkey?: true; discarded?: number; via?: string };
  /** Placed from the operator's break-glass command rather than a page
   *  (`agentmesh mesh pause`, mesh-adapter/mesh-operator.mjs), for when the
   *  API is down: `by.account` is then the gcloud account that ran it. A lift
   *  made the same way says so in `lifted.via`. */
  via?: string;
}
