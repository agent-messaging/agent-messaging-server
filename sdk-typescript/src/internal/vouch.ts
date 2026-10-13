/**
 * Vouch renewal arithmetic (§4.4).
 *
 * An agent exists on the mesh because a node vouched for it, and that vouch
 * carries an `expires_at` that the registry enforces at both ends of the
 * lifecycle: `handleRegister` refuses an expired attestation (§9.7) and the
 * reaper reclaims a registration whose attestation has lapsed. Registering once
 * and staying connected is therefore not enough to stay discoverable — the vouch
 * has to be re-minted while it is still valid.
 *
 * SPEC §9.2 names the legitimate path: "re-registration with a fresh vouch".
 * That is all a renewal is. These two helpers decide *when*.
 */
import {
  MAX_VOUCH_CHECK_INTERVAL_MS,
  VOUCH_RENEWAL_FRACTION,
} from "../constants.js";
import type { AgentAttestation } from "../types/manifest.js";

/**
 * The instant (ms epoch) at which an attestation should be renewed: a fixed
 * fraction into its own lifetime. Derived from the attestation's own
 * `issued_at`/`expires_at` rather than from the configured TTL, so a vouch
 * minted with a different lifetime (a shorter operator policy, another SDK, a
 * hand-rolled attestation) still gets a proportionate renewal deadline.
 *
 * `null` when the attestation carries no usable window — nothing to schedule
 * from, and inventing a deadline would be guessing.
 */
export function vouchRenewAt(att: Pick<AgentAttestation, "issued_at" | "expires_at">): number | null {
  const issued = Date.parse(att.issued_at ?? "");
  const expires = Date.parse(att.expires_at ?? "");
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) return null;
  return issued + (expires - issued) * VOUCH_RENEWAL_FRACTION;
}

/**
 * How often to check whether renewal is due, for a given vouch TTL.
 *
 * Four checks inside the renewal window (the last third of the TTL): the first
 * one at or just after the deadline does the work, and the rest are the retries
 * a transient failure gets before the vouch actually lapses. Capped so the
 * 30-day default checks hourly instead of once every 30 hours — the cap is what
 * makes the loop robust to a host that suspends, since a tick that arrives late
 * still compares against the real clock and renews immediately.
 */
export function vouchCheckIntervalMs(ttlMs: number): number {
  const window = ttlMs * (1 - VOUCH_RENEWAL_FRACTION);
  return Math.max(1, Math.min(Math.floor(window / 4), MAX_VOUCH_CHECK_INTERVAL_MS));
}
