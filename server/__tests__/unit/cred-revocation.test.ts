import { describe, it, expect, vi } from "vitest";
import { decideRenewal, type CredRevocation, type RenewalContext } from "../../src/keychain/cred-revocation.js";

// Revocation as refusal-to-renew (§4.8). The decision function, exercised
// without a broker: this is the whole of the mechanism, so the four outcomes
// below ARE the security property. Read cred-revocation.ts for why the weaker
// guarantee is the right primary one and what its honest window is.

const KEY_A = "U".padEnd(56, "A");
const KEY_B = "U".padEnd(56, "B");

function ctx(over: Partial<RenewalContext> = {}): RenewalContext {
  return {
    holderOf: async () => null,
    revocationOf: async () => null,
    ...over,
  };
}

const tomb = (reason = "retired by owner"): CredRevocation => ({
  at: new Date().toISOString(),
  reason,
  by: "acct-1",
});

describe("decideRenewal", () => {
  it("allows an agent held by a live account", async () => {
    const d = await decideRenewal(ctx({ holderOf: async () => ({ id: "acct-1" }) }), [KEY_A]);
    expect(d).toEqual({ allow: true, accountId: "acct-1" });
  });

  it("REFUSES a retired agent — this is what revocation is here", async () => {
    const d = await decideRenewal(ctx({ revocationOf: async () => tomb() }), [KEY_A]);
    expect(d.allow).toBe(false);
    if (d.allow) return;
    expect(d.status).toBe(403);
    expect(d.error).toMatch(/retired or revoked/);
    // The refusal says how to undo it, because retiring by mistake is common
    // and re-linking is the fix.
    expect(d.error).toMatch(/Re-link it to an account/);
  });

  it("REFUSES an agent whose account is disabled", async () => {
    const d = await decideRenewal(
      ctx({ holderOf: async () => ({ id: "acct-1", disabled: true }) }),
      [KEY_A],
    );
    expect(d.allow).toBe(false);
    if (d.allow) return;
    expect(d.status).toBe(403);
    // And is honest that the credential in hand keeps working.
    expect(d.error).toMatch(/keeps working until it expires/);
  });

  it("ALLOWS a key held by nobody and not tombstoned", async () => {
    // A self-hosted node that never linked to an account is not a revoked one.
    // Silence is not consent to refuse, and this door granted on
    // proof-of-possession alone before any of this existed.
    const d = await decideRenewal(ctx(), [KEY_A]);
    expect(d).toEqual({ allow: true, accountId: null });
  });

  it("lifts a stale tombstone when the key turns up under a live account", async () => {
    // Retired by mistake, then re-linked. The next renewal must not be refused
    // for something the owner already undid — and must not leave the trap in
    // place for the renewal after that.
    const clear = vi.fn(async () => undefined);
    const d = await decideRenewal(
      ctx({
        holderOf: async () => ({ id: "acct-1" }),
        revocationOf: async () => tomb(),
        clearRevocation: clear,
      }),
      [KEY_A],
    );
    expect(d.allow).toBe(true);
    expect(clear).toHaveBeenCalledWith(KEY_A);
  });

  it("refuses a roster that straddles two accounts", async () => {
    const d = await decideRenewal(
      ctx({ holderOf: async (k) => ({ id: k === KEY_A ? "acct-1" : "acct-2" }) }),
      [KEY_A, KEY_B],
    );
    expect(d.allow).toBe(false);
    if (d.allow) return;
    expect(d.status).toBe(409);
  });

  it("one revoked agent refuses the whole credential", async () => {
    // A credential is a single blast radius: it covers every agent on it, so a
    // roster with a revoked member cannot be partially issued.
    const d = await decideRenewal(
      ctx({
        holderOf: async (k) => (k === KEY_A ? { id: "acct-1" } : null),
        revocationOf: async (k) => (k === KEY_B ? tomb() : null),
      }),
      [KEY_A, KEY_B],
    );
    expect(d.allow).toBe(false);
  });

  // The renewal door of a node of many (docs/kill-switch-plan.md item 6):
  // retiring or terminating one agent leaves it off, and the node keeps the
  // others instead of losing its whole credential.
  it("with leaveOff, a retired or key-revoked agent is left off and the rest are issued", async () => {
    const KEY_C = "U".padEnd(56, "C");
    const d = await decideRenewal(
      ctx({
        holderOf: async (k) => (k === KEY_A ? { id: "acct-1" } : null),
        revocationOf: async (k) => (k === KEY_B ? tomb() : null),
        signingKeyRevoked: async (k) => k === KEY_C,
      }),
      [KEY_A, KEY_B, KEY_C],
      { leaveOff: true },
    );
    expect(d).toEqual({ allow: true, accountId: "acct-1", leftOff: [{ id: KEY_B, reason: "retired" }, { id: KEY_C, reason: "key_revoked" }] });
  });

  it("with leaveOff, a roster of only retired agents is still refused", async () => {
    const d = await decideRenewal(ctx({ revocationOf: async () => tomb() }), [KEY_A, KEY_B], { leaveOff: true });
    expect(d.allow).toBe(false);
  });
});
