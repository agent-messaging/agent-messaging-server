import { describe, it, expect } from "vitest";
import { applyDiscoveryFilters } from "../../src/registry/discovery-filter.js";
import type { Manifest, Availability, NodeProfile } from "../../src/sdk.js";

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: "agent-1",
    name: "Test Agent",
    description: "A test agent",
    version: "1.0.0",
    protocol_version: "0.2.0",
    endpoint: "mesh.agent.agent-1.inbox",
    capabilities: [],
    offerings: [],
    ...overrides,
  } as Manifest;
}

describe("applyDiscoveryFilters", () => {
  it("returns all agents with empty query", () => {
    const agents = [makeManifest(), makeManifest({ id: "agent-2" })];
    expect(applyDiscoveryFilters(agents, {})).toHaveLength(2);
  });

  it("filters by capabilities (AND semantics)", () => {
    const agents = [
      makeManifest({ id: "a", capabilities: ["chat", "search", "translate"] }),
      makeManifest({ id: "b", capabilities: ["chat"] }),
      makeManifest({ id: "c", capabilities: ["search"] }),
    ];
    const result = applyDiscoveryFilters(agents, { capabilities: ["chat", "search"] });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("filters by offering_id", () => {
    const agents = [
      makeManifest({ id: "a", offerings: [{ id: "echo", name: "Echo", description: "d" }] }),
      makeManifest({ id: "b", offerings: [{ id: "chat", name: "Chat", description: "d" }] }),
    ];
    const result = applyDiscoveryFilters(agents, { offering_id: "echo" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("filters by tags (OR across offerings)", () => {
    const agents = [
      makeManifest({ id: "a", offerings: [{ id: "s1", name: "S1", description: "d", tags: ["nlp", "ai"] }] }),
      makeManifest({ id: "b", offerings: [{ id: "s2", name: "S2", description: "d", tags: ["data"] }] }),
      makeManifest({ id: "c", offerings: [{ id: "s3", name: "S3", description: "d" }] }),
    ];
    const result = applyDiscoveryFilters(agents, { tags: ["nlp", "data"] });
    expect(result.map((a) => a.id).sort()).toEqual(["a", "b"]);
  });

  it("filters by availability — joined from presence, not the manifest", () => {
    const agents = [makeManifest({ id: "a" }), makeManifest({ id: "b" }), makeManifest({ id: "c" })];
    const status: Record<string, Availability> = { a: "online", b: "offline", c: "busy" };
    const statusOf = (m: Manifest) => status[m.id] ?? "offline";

    const result = applyDiscoveryFilters(agents, { availability: "online" }, statusOf);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("filters by node", () => {
    const withNode = (id: string, node: string) =>
      makeManifest({ id, node: { id: node, attestation: {} as any } });
    const agents = [withNode("a", "node-1"), withNode("b", "node-2"), withNode("c", "node-1")];
    const result = applyDiscoveryFilters(agents, { node: "node-1" });
    expect(result.map((a) => a.id).sort()).toEqual(["a", "c"]);
  });

  it("applies multiple filters with AND semantics (incl. presence availability)", () => {
    const agents = [
      makeManifest({ id: "a", capabilities: ["chat"], offerings: [{ id: "echo", name: "E", description: "d" }] }),
      makeManifest({ id: "b", capabilities: ["chat"], offerings: [{ id: "echo", name: "E", description: "d" }] }),
      makeManifest({ id: "c", capabilities: ["search"], offerings: [{ id: "echo", name: "E", description: "d" }] }),
    ];
    const status: Record<string, Availability> = { a: "online", b: "offline", c: "online" };
    const result = applyDiscoveryFilters(
      agents,
      { capabilities: ["chat"], availability: "online", offering_id: "echo" },
      (m) => status[m.id] ?? "offline",
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("returns empty array when no agents match", () => {
    const agents = [makeManifest({ id: "a", capabilities: [] })];
    expect(applyDiscoveryFilters(agents, { capabilities: ["nonexistent"] })).toHaveLength(0);
  });

  // ── Node profile filters (§9.7), joined via profileOf ──────────────
  const onNode = (id: string, node: string) =>
    makeManifest({ id, node: { id: node, attestation: {} as any } });

  it("filters by trust_tier as a minimum standing (sandbox < standard < verified)", () => {
    const agents = [onNode("a", "n-v"), onNode("b", "n-s"), onNode("c", "n-box")];
    const profiles: Record<string, NodeProfile> = {
      "n-v": { node: "n-v", trust_tier: "verified" },
      "n-s": { node: "n-s", trust_tier: "standard" },
      "n-box": { node: "n-box", trust_tier: "sandbox" },
    };
    const profileOf = (m: Manifest) => profiles[m.node?.id ?? ""];

    // floor = standard → verified + standard pass, sandbox excluded
    const standard = applyDiscoveryFilters(agents, { trust_tier: "standard" }, undefined, profileOf);
    expect(standard.map((a) => a.id).sort()).toEqual(["a", "b"]);

    // floor = verified → only verified
    const verified = applyDiscoveryFilters(agents, { trust_tier: "verified" }, undefined, profileOf);
    expect(verified.map((a) => a.id)).toEqual(["a"]);
  });

  it("excludes nodes with no known profile when a profile filter is set", () => {
    const agents = [onNode("a", "n-v"), onNode("b", "n-unknown")];
    const profileOf = (m: Manifest): NodeProfile | undefined =>
      m.node?.id === "n-v" ? { node: "n-v", trust_tier: "verified" } : undefined;

    const result = applyDiscoveryFilters(agents, { trust_tier: "standard" }, undefined, profileOf);
    expect(result.map((a) => a.id)).toEqual(["a"]);
  });

  it("filters by availability_class and reachability (exact match)", () => {
    const agents = [onNode("a", "n1"), onNode("b", "n2"), onNode("c", "n3")];
    const profiles: Record<string, NodeProfile> = {
      n1: { node: "n1", availability_class: "always_on", reachability: "direct" },
      n2: { node: "n2", availability_class: "intermittent", reachability: "leaf" },
      n3: { node: "n3", availability_class: "always_on", reachability: "leaf" },
    };
    const profileOf = (m: Manifest) => profiles[m.node?.id ?? ""];

    expect(
      applyDiscoveryFilters(agents, { availability_class: "always_on" }, undefined, profileOf)
        .map((a) => a.id)
        .sort(),
    ).toEqual(["a", "c"]);

    // AND: always_on AND direct → only a
    expect(
      applyDiscoveryFilters(
        agents,
        { availability_class: "always_on", reachability: "direct" },
        undefined,
        profileOf,
      ).map((a) => a.id),
    ).toEqual(["a"]);
  });

  it("joins profile AND presence together (verified + online)", () => {
    const agents = [onNode("a", "n1"), onNode("b", "n2")];
    const status: Record<string, Availability> = { a: "online", b: "online" };
    const profiles: Record<string, NodeProfile> = {
      n1: { node: "n1", trust_tier: "verified" },
      n2: { node: "n2", trust_tier: "sandbox" },
    };
    const result = applyDiscoveryFilters(
      agents,
      { availability: "online", trust_tier: "verified" },
      (m) => status[m.id] ?? "offline",
      (m) => profiles[m.node?.id ?? ""],
    );
    expect(result.map((a) => a.id)).toEqual(["a"]); // sandbox node excluded despite being online
  });
});
