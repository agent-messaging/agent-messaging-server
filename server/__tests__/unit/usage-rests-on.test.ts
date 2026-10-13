// The signed usage receipt carries what it was rated against (SPEC.md §5.6),
// and both shapes of seller still verify.
//
// WHY THIS TEST IS ABOUT BYTES, NOT FEATURES
//
// POST /v1/engage/usage does not trust the body it is handed: it REBUILDS the
// signed body from named fields and verifies the seller's signature over the
// rebuilt bytes. That is the right design and it makes every added field a
// wire-compatibility event. A field the seller signs and the platform does not
// reconstruct produces a signature failure on a perfectly honest report, and
// the seller is then looking at their key for a fault that is on our side.
//
// So the contract has two halves and both are asserted here: a seller that
// predates `rests_on` signs exactly the bytes it always did, and a seller that
// sends it signs bytes that include it. Neither may break the other, because
// the fleet and the field upgrade at different times.
import { describe, it, expect } from "vitest";
import { nkeys, canonicalJSON, validateRestsOn, type RestsOnEntry } from "../../src/sdk.js";

/** The platform's reconstruction, exactly as handleEngageUsage does it.
 *  Kept in the test as a transcription rather than imported, because what is
 *  being pinned is that the two sides build the SAME object from the same
 *  input — importing the implementation would assert only that it equals
 *  itself. */
function rebuild(b: {
  client: string; seller: string; offering: string; at: string;
  meters: Array<{ meter: string; count: number }>;
  task_id?: string; rests_on?: unknown;
}): Record<string, unknown> {
  return {
    client: b.client, seller: b.seller, offering: b.offering, at: b.at, meters: b.meters,
    ...(b.task_id ? { task_id: b.task_id } : {}),
    ...(b.rests_on !== undefined ? { rests_on: b.rests_on } : {}),
  };
}

const SIG_PREFIX = "agent-sow-usage-v1";
const digest = (c: string) => `sha256:${c.repeat(64).slice(0, 64)}`;

function report(over: Partial<{ rests_on: unknown; task_id: string }> = {}) {
  const seller = nkeys.createUser();
  const body = {
    client: "UCLIENT", seller: seller.getPublicKey(), offering: "audit",
    at: new Date().toISOString(),
    meters: [{ meter: "tokens_out", count: 1200 }],
    ...over,
  };
  const signed = rebuild(body);
  const sig = seller.sign(new TextEncoder().encode(`${SIG_PREFIX}\n${canonicalJSON(signed)}`));
  return { seller, body, signed, sig };
}

function verifies(pub: string, signed: Record<string, unknown>, sig: Uint8Array): boolean {
  return nkeys.fromPublic(pub).verify(
    new TextEncoder().encode(`${SIG_PREFIX}\n${canonicalJSON(signed)}`),
    sig,
  );
}

describe("§5.6 on the usage receipt", () => {
  it("a seller that predates the field signs the bytes it always did", () => {
    // The compatibility that matters most: the fleet is not upgraded in step
    // with the platform, and an older adapter reporting usage must keep working
    // the day this ships.
    const { seller, signed, sig } = report();
    expect(signed.rests_on).toBeUndefined();
    expect(Object.keys(signed)).toEqual(["client", "seller", "offering", "at", "meters"]);
    expect(verifies(seller.getPublicKey(), signed, sig)).toBe(true);
  });

  it("a seller that declares what it rated against still verifies", () => {
    const rests_on: RestsOnEntry[] = [{ digest: digest("a"), role: "rate-schedule" }];
    const { seller, signed, sig } = report({ rests_on });
    expect(signed.rests_on).toEqual(rests_on);
    expect(verifies(seller.getPublicKey(), signed, sig)).toBe(true);
  });

  it("dropping a declared rests_on breaks the signature, which is why the platform rebuilds it", () => {
    // The failure this whole design avoids. If the platform reconstructed the
    // body WITHOUT a field the seller signed, an honest report would be
    // rejected as forged.
    const rests_on: RestsOnEntry[] = [{ digest: digest("b"), role: "rate-schedule" }];
    const { seller, body, sig } = report({ rests_on });
    const dropped = rebuild({ ...body, rests_on: undefined });
    expect(verifies(seller.getPublicKey(), dropped, sig)).toBe(false);
  });

  it("changing what it rested on breaks the signature", () => {
    // The property the field exists for: the declaration is covered by the
    // signature, so a seller cannot quietly re-point a receipt at a different
    // schedule after the fact.
    const { seller, body, sig } = report({ rests_on: [{ digest: digest("c"), role: "rate-schedule" }] });
    const altered = rebuild({ ...body, rests_on: [{ digest: digest("d"), role: "rate-schedule" }] });
    expect(verifies(seller.getPublicKey(), altered, sig)).toBe(false);
  });

  it("the platform validates the list before it reaches the signed bytes", () => {
    // Refused as a bad request rather than folded in and failing as a
    // signature error, which would send the seller looking at their key for a
    // fault that is in their payload.
    expect(() => validateRestsOn([{ digest: "sha256:nope" }])).toThrow();
    expect(() => validateRestsOn([])).toThrow();
    expect(() => validateRestsOn([{ digest: digest("e") }])).not.toThrow();
  });
});
