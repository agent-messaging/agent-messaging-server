import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleRegister } from "../../src/registry/handlers/register.js";
import { createEnvelope, ErrorCode, nkeys, createAttestation } from "../../src/sdk.js";
import type { Manifest } from "../../src/sdk.js";
import { PresenceStore } from "../../src/registry/presence-store.js";
import { NodeProfileStore } from "../../src/registry/node-profile-store.js";

function createMockKv() {
  const store = new Map<string, unknown>();
  return {
    put: vi.fn(async (key: string, data: Uint8Array) => {
      store.set(key, JSON.parse(new TextDecoder().decode(data)));
      return 1;
    }),
    get: vi.fn(async (key: string) => {
      const val = store.get(key);
      return val ? { json: () => val, string: () => JSON.stringify(val) } : null;
    }),
    store,
  };
}

function createMockNc() {
  return { publish: vi.fn() };
}

/** A 0.2 manifest for a self-hosting agent, with a valid node vouch. */
function makeVouchedManifest(): { id: string; manifest: Manifest } {
  const kp = nkeys.createUser();
  const id = kp.getPublicKey();
  const manifest: Manifest = {
    id,
    name: "Test Agent",
    description: "A test agent",
    version: "1.0.0",
    protocol_version: "0.2.0",
    endpoint: `mesh.agent.${id}.inbox`,
    node: { id, attestation: createAttestation(kp, id) },
    capabilities: ["chat"],
    offerings: [{ id: "echo", name: "Echo", description: "Echo back" }],
  } as Manifest;
  return { id, manifest };
}

describe("handleRegister", () => {
  let kv: ReturnType<typeof createMockKv>;
  let nc: ReturnType<typeof createMockNc>;
  let cache: Map<string, Manifest>;
  let presence: PresenceStore;
  let profiles: NodeProfileStore;
  const serviceId = "mesh.service.registry";

  beforeEach(() => {
    kv = createMockKv();
    nc = createMockNc();
    cache = new Map();
    presence = new PresenceStore();
    profiles = new NodeProfileStore();
  });

  it("registers a valid vouched manifest", async () => {
    const { id, manifest } = makeVouchedManifest();
    const env = createEnvelope({ type: "register", from: id, payload: manifest });

    const resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);

    expect(resp.error).toBeUndefined();
    expect((resp.payload as any).status).toBe("registered");
    expect((resp.payload as any).agent_id).toBe(id);
    expect(kv.put).toHaveBeenCalledOnce();
    expect(nc.publish).toHaveBeenCalledOnce();
    // Presence seeded for the hosting node (separate from the manifest).
    expect(presence.status(manifest.node.id)).toBe("online");
    // The stored manifest carries NO liveness fields.
    const stored = kv.store.get(id) as any;
    expect(stored.availability).toBeUndefined();
    expect(stored.last_heartbeat).toBeUndefined();
  });

  it("rejects identity mismatch", async () => {
    const { manifest } = makeVouchedManifest();
    const env = createEnvelope({ type: "register", from: "different-agent", payload: manifest });

    const resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);

    expect(resp.error!.code).toBe(ErrorCode.IDENTITY_MISMATCH);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects manifest missing required fields", async () => {
    const env = createEnvelope({ type: "register", from: "agent-1", payload: { id: "agent-1" } });
    const resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);
    expect(resp.error!.code).toBe(ErrorCode.INVALID_MANIFEST);
  });

  it("rejects a manifest without a node vouch", async () => {
    const kp = nkeys.createUser();
    const id = kp.getPublicKey();
    const manifest = {
      id, name: "No Vouch", description: "", version: "1.0.0", protocol_version: "0.2.0",
      endpoint: `mesh.agent.${id}.inbox`, capabilities: [], offerings: [],
    } as unknown as Manifest;
    const env = createEnvelope({ type: "register", from: id, payload: manifest });

    const resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);
    expect(resp.error!.code).toBe(ErrorCode.INVALID_MANIFEST);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects a manifest with a tampered attestation", async () => {
    const { id, manifest } = makeVouchedManifest();
    manifest.node.attestation.sig = "AAAA"; // tamper
    const env = createEnvelope({ type: "register", from: id, payload: manifest });

    const resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);
    expect(resp.error!.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("populates the node's declared profile, preserving operator-attested fields (§9.7)", async () => {
    const { id, manifest } = makeVouchedManifest();
    manifest.node.profile = { availability_class: "always_on", reachability: "direct" };
    // Operator has already attested this node's trust tier + role.
    profiles.set({ node: manifest.node.id, trust_tier: "verified", role: "participant" });

    const env = createEnvelope({ type: "register", from: id, payload: manifest });
    const resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);
    expect(resp.error).toBeUndefined();

    const stored = profiles.get(manifest.node.id)!;
    // Declared attributes came from the node.
    expect(stored.availability_class).toBe("always_on");
    expect(stored.reachability).toBe("direct");
    // Operator-attested attributes are preserved, not clobbered by register.
    expect(stored.trust_tier).toBe("verified");
    expect(stored.role).toBe("participant");
  });

  it("enforces sandbox on agents hosted by a sandbox-attested node (§1.3, §9.7)", async () => {
    const { id, manifest } = makeVouchedManifest();
    // Operator attested this node as sandbox (e.g. a guest-pool credential).
    profiles.set({ node: manifest.node.id, trust_tier: "sandbox" });
    // The agent does NOT self-declare sandbox and asks for public visibility.
    manifest.visibility = "public";

    const env = createEnvelope({ type: "register", from: id, payload: manifest });
    const resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);
    expect(resp.error).toBeUndefined();

    const stored = kv.store.get(id) as any;
    expect(stored.sandbox).toBe(true); // enforced, not honor-system
    expect(stored.visibility).toBe("unlisted"); // clamped out of open discovery
  });

  it("materializes a readable §8.5.2 reporting declaration and drops an unreadable one", async () => {
    const { id, manifest } = makeVouchedManifest();
    manifest.offerings = [
      { id: "echo", name: "Echo", description: "Echo back", reporting: { level: "check_ins", every: "P1W" } },
      // check_ins without a calendar advertises nothing testable: DROPPED —
      // from the stored manifest and the storefront — while the offering lives.
      { id: "shout", name: "Shout", description: "Echo louder", reporting: { level: "check_ins" } } as any,
    ];
    manifest.public = { offerings: ["echo", "shout"] };

    const env = createEnvelope({ type: "register", from: id, payload: manifest });
    const resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);
    expect(resp.error).toBeUndefined();

    const stored = kv.store.get(id) as any;
    // The storefront carries the readable declaration and only that one.
    expect(stored.public.offering_details).toEqual([
      { id: "echo", name: "Echo", description: "Echo back", reporting: { level: "check_ins", every: "P1W" } },
      { id: "shout", name: "Shout", description: "Echo louder" },
    ]);
    // The stored manifest's own offerings were scrubbed the same way.
    expect(stored.offerings[0].reporting).toEqual({ level: "check_ins", every: "P1W" });
    expect(stored.offerings[1].reporting).toBeUndefined();
    expect(stored.offerings[1].id).toBe("shout");
  });

  it("scrubs an unreadable §8.10 data_use declaration WHOLE while the manifest survives", async () => {
    const { id, manifest } = makeVouchedManifest();
    // One readable member beside one unreadable member: per §8.10 the whole
    // declaration goes, because a partially readable privacy claim misleads
    // more than none at all — unlike reporting's per-field drop above.
    manifest.data_use = {
      promises: { no_training: true },
      retention: { max_days: 0 },
    } as unknown as Manifest["data_use"];

    const env = createEnvelope({ type: "register", from: id, payload: manifest });
    const resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);
    expect(resp.error).toBeUndefined();

    const stored = kv.store.get(id) as any;
    expect(stored.data_use).toBeUndefined();
    expect("data_use" in stored).toBe(false); // gone, not nulled
    expect(stored.id).toBe(id); // the registration itself survives
    expect(stored.offerings).toHaveLength(1);
  });

  it("stores a readable §8.10 data_use declaration normalized to the spec's members", async () => {
    const { id, manifest } = makeVouchedManifest();
    manifest.data_use = {
      promises: { no_training: true, no_third_party_sharing: true },
      retention: { max_days: 30 },
      processors: [
        // An extra key a registrant smuggles onto an entry stays out of storage.
        { service: "Anthropic API", domain: "anthropic.com", purpose: "model inference", badge: "verified!" },
      ],
    } as unknown as Manifest["data_use"];

    const env = createEnvelope({ type: "register", from: id, payload: manifest });
    const resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);
    expect(resp.error).toBeUndefined();

    const stored = kv.store.get(id) as any;
    expect(stored.data_use).toEqual({
      promises: { no_training: true, no_third_party_sharing: true },
      retention: { max_days: 30 },
      processors: [{ service: "Anthropic API", domain: "anthropic.com", purpose: "model inference" }],
    });
  });

  it("scrubs a data_use whose processed_in cannot be read — whole, jurisdictions and promises alike", async () => {
    const { id, manifest } = makeVouchedManifest();
    // "US" is somebody's true jurisdiction spelled wrongly (the declaration is
    // lowercase ISO 3166-1 alpha-2); per §8.10's family rule it poisons the
    // whole declaration, not just the jurisdictions line.
    manifest.data_use = {
      promises: { no_training: true },
      processed_in: ["US"],
    } as unknown as Manifest["data_use"];

    const env = createEnvelope({ type: "register", from: id, payload: manifest });
    const resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);
    expect(resp.error).toBeUndefined();

    const stored = kv.store.get(id) as any;
    expect("data_use" in stored).toBe(false);
    expect(stored.id).toBe(id);
  });

  it("stores a readable processed_in deduped, and drops an empty data_use object to absent (#148)", async () => {
    const first = makeVouchedManifest();
    first.manifest.data_use = {
      processed_in: ["us", "de", "us"],
    } as unknown as Manifest["data_use"];
    let env = createEnvelope({ type: "register", from: first.id, payload: first.manifest });
    let resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);
    expect(resp.error).toBeUndefined();
    expect((kv.store.get(first.id) as any).data_use).toEqual({ processed_in: ["us", "de"] });

    // `{}` said nothing; the stored spelling of nothing is absence.
    const second = makeVouchedManifest();
    second.manifest.data_use = {} as unknown as Manifest["data_use"];
    env = createEnvelope({ type: "register", from: second.id, payload: second.manifest });
    resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);
    expect(resp.error).toBeUndefined();
    expect("data_use" in (kv.store.get(second.id) as any)).toBe(false);
  });

  it("scrubs an unreadable §8.11 compliance member WHOLE while the manifest survives", async () => {
    const { id, manifest } = makeVouchedManifest();
    // One readable claim beside one unreadable claim: the whole member goes —
    // a partially readable claims list shows a posture nobody declared.
    (manifest as any).compliance = [
      { standard: "soc2", scope: "the hosted pipeline, Type II" },
      { standard: "SOC 2!" },
    ];

    const env = createEnvelope({ type: "register", from: id, payload: manifest });
    const resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);
    expect(resp.error).toBeUndefined();

    const stored = kv.store.get(id) as any;
    expect(stored.compliance).toBeUndefined();
    expect("compliance" in stored).toBe(false); // gone, not nulled
    expect(stored.id).toBe(id); // the registration itself survives
    expect(stored.offerings).toHaveLength(1);
  });

  it("stores a readable §8.11 compliance member normalized to the spec's members", async () => {
    const { id, manifest } = makeVouchedManifest();
    (manifest as any).compliance = [
      {
        standard: "soc2",
        scope: "the hosted pipeline, Type II",
        // An extra key a registrant smuggles in stays out of storage — and so
        // does a "verified" flag riding the attestation, which is exactly the
        // conclusion §8.11 says no platform may assert for an operator.
        badge: "platinum",
        attestation: { by: "Example Auditors LLP", url: "https://example.com/soc2", expires_at: "2027-03-01", verified: true },
      },
      { standard: "gdpr", scope: "as processor, under the engagement DPA" },
    ];

    const env = createEnvelope({ type: "register", from: id, payload: manifest });
    const resp = await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);
    expect(resp.error).toBeUndefined();

    const stored = kv.store.get(id) as any;
    expect(stored.compliance).toEqual([
      {
        standard: "soc2",
        scope: "the hosted pipeline, Type II",
        attestation: { by: "Example Auditors LLP", url: "https://example.com/soc2", expires_at: "2027-03-01" },
      },
      { standard: "gdpr", scope: "as processor, under the engagement DPA" },
    ]);
  });

  it("never accepts a self-declared trust_tier via register", async () => {
    const { id, manifest } = makeVouchedManifest();
    // A node tries to smuggle an attested field into its declared profile.
    (manifest.node as any).profile = { availability_class: "intermittent", trust_tier: "verified" };

    const env = createEnvelope({ type: "register", from: id, payload: manifest });
    await handleRegister(env, kv as any, nc as any, serviceId, cache, presence, profiles);

    const stored = profiles.get(manifest.node.id)!;
    expect(stored.availability_class).toBe("intermittent");
    expect(stored.trust_tier).toBeUndefined(); // self-declared trust is ignored
  });
});

describe("operator attestation seeding (§9.7)", () => {
  it("parses valid NODE_ATTESTATIONS and drops unknown values", async () => {
    const { parseNodeAttestations } = await import("../../src/registry/node-profile-store.js");
    const map = parseNodeAttestations(
      JSON.stringify({
        "node-a": { trust_tier: "verified", role: "service" },
        "node-b": { trust_tier: "bogus-tier", role: "participant" }, // bad tier dropped, role kept
        "node-c": { trust_tier: "nonsense" },                        // nothing valid → omitted
        "node-d": "not-an-object",                                   // omitted
      }),
    );
    expect(map.get("node-a")).toEqual({ trust_tier: "verified", role: "service" });
    expect(map.get("node-b")).toEqual({ role: "participant" });
    expect(map.has("node-c")).toBe(false);
    expect(map.has("node-d")).toBe(false);
  });

  it("returns an empty map for missing or malformed JSON", async () => {
    const { parseNodeAttestations } = await import("../../src/registry/node-profile-store.js");
    expect(parseNodeAttestations(undefined).size).toBe(0);
    expect(parseNodeAttestations("{oops").size).toBe(0);
    expect(parseNodeAttestations("[1,2]").size).toBe(0);
  });

  it("seedAttested merges over declared attributes without clobbering them", async () => {
    const { NodeProfileStore, parseNodeAttestations } = await import(
      "../../src/registry/node-profile-store.js"
    );
    const store = new NodeProfileStore();
    // Node already declared its hints (e.g. via a register that arrived first).
    store.set({ node: "node-a", availability_class: "intermittent", reachability: "leaf" });

    store.seedAttested(parseNodeAttestations(JSON.stringify({ "node-a": { trust_tier: "verified" } })));

    const p = store.get("node-a")!;
    expect(p.trust_tier).toBe("verified");           // attested applied
    expect(p.availability_class).toBe("intermittent"); // declared preserved
    expect(p.reachability).toBe("leaf");
  });
});
