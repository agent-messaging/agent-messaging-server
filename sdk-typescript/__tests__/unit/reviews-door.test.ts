// mesh.reviews (platform-services/reviews.json): signed here, by this agent's
// own key, over the bytes the platform checks and the bureau keeps.
import { describe, it, expect } from "vitest";
import { createUser, fromPublic } from "nkeys.js";
import { ReviewsDoor } from "../../src/reviews-door.js";
import { canonicalJSON } from "../../src/internal/identity.js";
import { ServiceRefusal } from "../../src/services.generated.js";

const kp = createUser();
const ME = kp.getPublicKey();
const SELLER = "U" + "S".repeat(55);
const sign = (m: string): string => btoa(String.fromCharCode(...kp.sign(new TextEncoder().encode(m))));
const verifies = (m: string, sig: string): boolean =>
  fromPublic(ME).verify(new TextEncoder().encode(m), Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)));

function door(answer: { status: number; body: Record<string, unknown> }, seen: Array<{ url: string; body: Record<string, unknown> }>): ReviewsDoor {
  return new ReviewsDoor({
    agentId: ME,
    sign,
    resolve: async (t) => (t === "maker.maya@example.com" ? SELLER : null),
    api: "https://api.example",
    fetchImpl: (async (url: string, init: { body: string }) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return { status: answer.status, json: async () => answer.body };
    }) as unknown as typeof fetch,
  });
}

describe("mesh.reviews", () => {
  it("signs a review over the platform's bytes and posts it to the review door", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const out = await door({ status: 200, body: { ok: true, count: 1 } }, seen).file({ of_agent: "maker.maya@example.com", offering: "explain", verdict: "accepted" });
    expect(out).toMatchObject({ filed: "accepted", about: "seller", review_number: 1 });
    expect(seen[0]!.url).toBe("https://api.example/v1/reviews");
    const { sig, ...signed } = seen[0]!.body as { sig: string };
    expect(signed).toMatchObject({ client: ME, seller: SELLER });
    expect(verifies(`agent-sow-review-v1\n${canonicalJSON(signed)}`, sig)).toBe(true);
  });

  it("refuses in the definition's words: an unknown agent, no relationship, a poor judgment with no reason", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const d = door({ status: 403, body: { error: "no engagement or agreement between these two parties: a review needs a relationship to judge" } }, seen);
    await expect(d.file({ of_agent: "nobody@example.com", offering: "x", verdict: "accepted" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(d.file({ of_agent: SELLER, offering: "x", verdict: "accepted" })).rejects.toMatchObject({ code: "NO_RELATIONSHIP" });
    await expect(d.rate({ of_agent: SELLER, offering: "x", judgment: "poor" })).rejects.toBeInstanceOf(ServiceRefusal);
  });
});
