/**
 * Revoking an agent's SIGNING key, and moving the agent to a new one
 * (SPEC §5.3, docs/live-revocation-plan.md item 5).
 *
 * Three doors reach this, with three different authorities:
 *
 *   - the HOLDER (POST /v1/agent-key/revoke-own): whoever holds the key signs
 *     its own revocation. Needs no account, because ending a key is the one
 *     thing a thief holding it cannot turn against the owner.
 *   - the OWNER (POST /v1/accounts/:id/agents/:key/rotate-key): revokes the old
 *     key AND moves the agent, its place in the account and its name, to a new
 *     key the caller proves it holds. That second half re-points a trusted name,
 *     so it takes two factors: a signed-in session with a fresh passkey, or an
 *     account token together with the old key's own signature (the adapter's
 *     `agentmesh key rotate` holds both; a stolen token alone does not).
 *   - the OPERATOR (console and loopback): revokes, never moves. Moving a name
 *     is the owner's act.
 *
 * Revoking does, in order: mark the key revoked in the registry's record
 * (receivers ask the registry before they accept a message signed by it), then
 * the credential revoke action for that key, which refuses its renewal, cuts
 * its connections at the broker when the mesh can, and deregisters it.
 * Rotation then links the new key to the account, moves the name with the old
 * key recorded as revoked at the naming service, and unlinks the old key.
 */
import type { AgentKeyRevocation } from "../shared/agent-key-revocations.js";
import type { CredentialRevokeResult } from "./credential-revoke.js";

const USER_KEY = /^U[A-Z2-7]{55}$/;

/** The signed statements, one spelling each, shared with the adapter. */
export function revokeOwnStatement(ts: number, key: string): string {
  return `mesh-agent-key-revoke-v1:${ts}:${key}`;
}
export function rotateStatement(ts: number, oldKey: string, newKey: string): string {
  return `mesh-key-rotate-v1:${ts}:${oldKey}:${newKey}`;
}

export interface AgentKeyRevokeDeps {
  markRevoked(key: string, rec: { reason: string; by: string; replaced_by?: string }): Promise<AgentKeyRevocation>;
  revokeCredentials(key: string, reason: string, by: string): Promise<CredentialRevokeResult>;
}

export interface AgentKeyRevokeResult {
  ok: true;
  key: string;
  revoked_at: string;
  credential: CredentialRevokeResult | { error: string };
  note: string;
}

/** Revoke one agent signing key: the record first, then its credentials. */
export async function revokeAgentKey(
  deps: AgentKeyRevokeDeps,
  key: string,
  reason: string,
  by: string,
  replacedBy?: string,
): Promise<AgentKeyRevokeResult> {
  if (!USER_KEY.test(key)) throw new Error("not an agent public key");
  const rec = await deps.markRevoked(key, { reason, by, ...(replacedBy ? { replaced_by: replacedBy } : {}) });
  let credential: AgentKeyRevokeResult["credential"];
  try {
    credential = await deps.revokeCredentials(key, reason, by);
  } catch (err) {
    credential = { error: (err as Error).message };
  }
  const credNote = "note" in credential ? credential.note : `The credential could not be revoked: ${credential.error}.`;
  return {
    ok: true,
    key,
    revoked_at: rec.at,
    credential,
    note: `Receivers now refuse messages signed by this key. ${credNote}`,
  };
}

export interface RotateDeps extends AgentKeyRevokeDeps {
  /** Is this key already revoked? A revoked key is never a destination. */
  revokedAlready(key: string): Promise<boolean>;
  /** Is this key held by an account other than `accountId`? */
  heldElsewhere(key: string, accountId: string): Promise<boolean>;
  link(newKey: string, label: string): Promise<"linked" | "cap" | "failed">;
  unlink(oldKey: string): Promise<boolean>;
  /** The handle bound to `oldKey` and the email it anchors to. Null: none.
   *  Undefined: the naming service could not be asked. */
  handleOf(oldKey: string): Promise<{ handle: string; email: string } | null | undefined>;
  /** Re-bind `handle` to `newKey`, recording the old key as revoked. */
  moveName(handle: string, anchorEmail: string, newKey: string): Promise<"moved" | string>;
}

export interface RotateResult extends AgentKeyRevokeResult {
  new_key: string;
  handle: string | null;
  name: "moved" | "none" | string;
  linked: "linked" | "cap" | "failed";
}

/**
 * The owner's rotation. The caller has already checked the authority (see the
 * module note) and that the account holds `oldKey`; this checks the new key and
 * does the work.
 */
export async function rotateAgentKey(
  deps: RotateDeps,
  input: { accountId: string; accountEmail: string; oldKey: string; newKey: string; label: string },
): Promise<RotateResult | { ok: false; status: number; error: string }> {
  const { accountId, oldKey, newKey } = input;
  if (!USER_KEY.test(newKey)) return { ok: false, status: 400, error: "new_key must be an agent public key (U..., 56 characters)" };
  if (newKey === oldKey) return { ok: false, status: 400, error: "the new key is the key being revoked" };
  if (await deps.revokedAlready(newKey)) return { ok: false, status: 409, error: "the new key has itself been revoked; make another" };
  if (await deps.heldElsewhere(newKey, accountId)) return { ok: false, status: 409, error: "the new key belongs to another account" };

  // Revoke first: this is an incident, and every step after it is recovery.
  const revoked = await revokeAgentKey(deps, oldKey, "the owner reported the key leaked", `owner:${accountId}`, newKey);

  const linked = await deps.link(newKey, input.label);

  let handle: string | null = null;
  let name: RotateResult["name"] = "none";
  const bound = await deps.handleOf(oldKey).catch(() => undefined);
  if (bound === undefined) {
    name = "the naming service could not be asked which name the old key had";
  } else if (bound) {
    handle = bound.handle;
    name = bound.email.toLowerCase() === input.accountEmail.toLowerCase()
      ? await deps.moveName(bound.handle, bound.email, newKey).catch((e) => `failed: ${(e as Error).message}`)
      : "the name is anchored to another email, so it was not moved";
  }

  // Unlink the old key only once the new one is in, so the agent is never
  // missing from the account.
  if (linked === "linked") await deps.unlink(oldKey).catch(() => false);

  const parts = [revoked.note];
  if (linked === "linked") parts.push("The account now holds the new key in its place.");
  else parts.push(`The new key could not be added to the account (${linked}); the old key stays listed so the agent is not lost.`);
  if (name === "moved") parts.push(`The name ${handle} now points at the new key, and the naming service records the old key as revoked.`);
  else if (name !== "none") parts.push(`The name was not moved: ${name}.`);
  return { ...revoked, note: parts.join(" "), new_key: newKey, handle, name, linked };
}
