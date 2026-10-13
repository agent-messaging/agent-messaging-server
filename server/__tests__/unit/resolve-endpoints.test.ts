import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleRegister } from "../../src/registry/handlers/register.js";
import { handleDiscover } from "../../src/registry/handlers/discover.js";
import { handleGet } from "../../src/registry/handlers/get.js";
import { createEnvelope, ErrorCode, nkeys, createAttestation } from "../../src/sdk.js";
import type { Manifest } from "../../src/sdk.js";
import type { StoredManifest } from "../../src/registry/endpoints.js";
import { isWellFormedSubject, withEndpoints } from "../../src/registry/endpoints.js";
import { PresenceStore } from "../../src/registry/presence-store.js";
import { NodeProfileStore } from "../../src/registry/node-profile-store.js";

// The registry-side half of resolve-never-construct (§14.4): the manifest's
// `endpoints` block (§8.1) is registry-populated at register time (§8.2),
// validated when supplied, and stamped on read for records stored before the
// field existed — plus the `limits` declaration surface (§8.1/§6.4b).

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
function makeVouchedManifest(): { id: string; manifest: StoredManifest } {
  const kp = nkeys.createUser();
  const id = kp.getPublicKey();
  const manifest: StoredManifest = {
    id,
    name: "Test Agent",
    description: "A test agent",
    version: "1.0.0",
    protocol_version: "0.2.0",
    endpoint: `mesh.agent.${id}.inbox`,
    node: { id, attestation: createAttestation(kp, id) },
    capabilities: ["chat"],
    offerings: [{ id: "echo", name: "Echo", description: "Echo back" }],
  } as StoredManifest;
  return { id, manifest };
}

describe("endpoints stamping at register (§8.2)", () => {
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

  const register = (id: string, manifest: StoredManifest) =>
    handleRegister(
      createEnvelope({ type: "register", from: id, payload: manifest }),
      kv as any,
      nc as any,
      serviceId,
      cache,
      presence,
      profiles,
    );

  it("stamps `endpoints` from `endpoint` when the registrant supplied none", async () => {
    const { id, manifest } = makeVouchedManifest();
    expect(manifest.endpoints).toBeUndefined();

    const resp = await register(id, manifest);
    expect(resp.error).toBeUndefined();

    // Stored AND cached manifests both carry the stamped block — the stored
    // manifest never lacks it (§8.2), whatever the registrant sent.
    const stored = kv.store.get(id) as StoredManifest;
    expect(stored.endpoints).toEqual({ inbox: `mesh.agent.${id}.inbox` });
    expect((cache.get(id) as StoredManifest).endpoints).toEqual({
      inbox: `mesh.agent.${id}.inbox`,
    });
  });

  it("stores a supplied, valid block verbatim and fills a missing inbox", async () => {
    const { id, manifest } = makeVouchedManifest();
    // Extra endpoint names are legal (§8.1: "at minimum inbox") — the block
    // omits inbox, which the registry fills from `endpoint`.
    manifest.endpoints = { stream: `mesh.agent.${id}.stream` };

    const resp = await register(id, manifest);
    expect(resp.error).toBeUndefined();

    const stored = kv.store.get(id) as StoredManifest;
    expect(stored.endpoints).toEqual({
      stream: `mesh.agent.${id}.stream`,
      inbox: `mesh.agent.${id}.inbox`,
    });
  });

  it("refuses a block claiming another agent's inbox subject", async () => {
    const { id, manifest } = makeVouchedManifest();
    const victim = nkeys.createUser().getPublicKey();
    manifest.endpoints = { inbox: `mesh.agent.${victim}.inbox` };

    const resp = await register(id, manifest);
    // An identity claim, not a shape problem: discovery would serve this
    // verbatim and redirect the victim's callers.
    expect(resp.error!.code).toBe(ErrorCode.IDENTITY_MISMATCH);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("refuses an `endpoint` field claiming another agent's namespace (it stamps the block)", async () => {
    const { id, manifest } = makeVouchedManifest();
    const victim = nkeys.createUser().getPublicKey();
    manifest.endpoint = `mesh.agent.${victim}.inbox`;

    const resp = await register(id, manifest);
    expect(resp.error!.code).toBe(ErrorCode.IDENTITY_MISMATCH);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("refuses malformed endpoint subjects (wildcards, empty tokens, non-strings)", async () => {
    for (const bad of [
      { inbox: "mesh.agent.*.inbox" }, // wildcard is not a concrete subject
      { inbox: "mesh.agent..inbox" }, // empty token
      { inbox: "mesh agent inbox" }, // whitespace
      { inbox: 42 }, // not a string
      "mesh.agent.x.inbox", // block is not an object
      [], // block is not an object
    ]) {
      const { id, manifest } = makeVouchedManifest();
      manifest.endpoints = bad as never;
      const resp = await register(id, manifest);
      expect(resp.error?.code, JSON.stringify(bad)).toBe(ErrorCode.INVALID_MANIFEST);
    }
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("allows endpoints outside the mesh.agent namespace if well-formed", async () => {
    const { id, manifest } = makeVouchedManifest();
    manifest.endpoints = {
      inbox: `mesh.agent.${id}.inbox`,
      // §14.4 exists so the convention is not the law of what an endpoint may
      // be — a subject outside the per-agent namespace carries no identity.
      custom: "acme.worker.intake",
    };

    const resp = await register(id, manifest);
    expect(resp.error).toBeUndefined();
    expect((kv.store.get(id) as StoredManifest).endpoints!.custom).toBe("acme.worker.intake");
  });
});

describe("limits pass-through and refusal (§8.1)", () => {
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

  const register = (id: string, manifest: StoredManifest) =>
    handleRegister(
      createEnvelope({ type: "register", from: id, payload: manifest }),
      kv as any,
      nc as any,
      serviceId,
      cache,
      presence,
      profiles,
    );

  it("stores a well-formed limits block untouched, unknown keys included", async () => {
    const { id, manifest } = makeVouchedManifest();
    manifest.limits = { max_inbound_chars: 1024, future_knob: "kept" };

    const resp = await register(id, manifest);
    expect(resp.error).toBeUndefined();
    expect((kv.store.get(id) as StoredManifest).limits).toEqual({
      max_inbound_chars: 1024,
      future_knob: "kept",
    });
  });

  it("allows an explicit 0 (§22.5: explicit no-cap is legal)", async () => {
    const { id, manifest } = makeVouchedManifest();
    manifest.limits = { max_inbound_chars: 0 };
    const resp = await register(id, manifest);
    expect(resp.error).toBeUndefined();
    expect((kv.store.get(id) as StoredManifest).limits).toEqual({ max_inbound_chars: 0 });
  });

  it("refuses a malformed max_inbound_chars (non-integer, negative, non-number) and a non-object block", async () => {
    for (const bad of [
      { max_inbound_chars: 1.5 },
      { max_inbound_chars: -1 },
      { max_inbound_chars: "65536" },
      { max_inbound_chars: NaN },
      "not-an-object",
      [1024],
    ]) {
      const { id, manifest } = makeVouchedManifest();
      manifest.limits = bad as never;
      const resp = await register(id, manifest);
      expect(resp.error?.code, JSON.stringify(bad)).toBe(ErrorCode.INVALID_MANIFEST);
    }
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe("stamp-on-read fallback for pre-`endpoints` records (§8.2/§14.4)", () => {
  const serviceId = "mesh.service.registry";

  it("discover carries the block on records stored before the field existed", async () => {
    const { id, manifest } = makeVouchedManifest();
    // An OLD record: reached the cache via the boot seed / manifest watch with
    // no endpoints block, because it was stored before the field existed.
    const cache = new Map<string, Manifest>([[id, manifest as Manifest]]);
    const env = createEnvelope({ type: "discover", from: "some-caller", payload: {} });

    const resp = await handleDiscover(env, serviceId, cache, new PresenceStore(), new NodeProfileStore());
    expect(resp.error).toBeUndefined();
    const agents = (resp.payload as { agents: StoredManifest[] }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].endpoints).toEqual({ inbox: `mesh.agent.${id}.inbox` });
    // The shared cache entry is NOT mutated by the read path — the manifest
    // watch compares cached bytes against KV echoes, and a read must not make
    // those disagree.
    expect((cache.get(id) as StoredManifest).endpoints).toBeUndefined();
  });

  it("get carries the block on an old stored record", async () => {
    const { id, manifest } = makeVouchedManifest();
    const kv = {
      get: vi.fn(async () => ({ json: () => manifest })),
    };
    const env = createEnvelope({ type: "discover", from: "some-caller", payload: {} });
    const msg = { subject: `mesh.registry.get.${id}` };

    const resp = await handleGet(env, msg as any, kv as any, serviceId, new Map());
    expect(resp.error).toBeUndefined();
    expect((resp.payload as StoredManifest).endpoints).toEqual({
      inbox: `mesh.agent.${id}.inbox`,
    });
  });

  it("get answers a deregistered agent (a delete marker) as not found, never an internal error", async () => {
    const { id } = makeVouchedManifest();
    const kv = {
      get: vi.fn(async () => ({ operation: "DEL", value: new Uint8Array(0), json: () => { throw new Error("Bad JSON"); } })),
    };
    const env = createEnvelope({ type: "discover", from: "some-caller", payload: {} });
    const resp = await handleGet(env, { subject: `mesh.registry.get.${id}` } as any, kv as any, serviceId, new Map());
    expect(resp.error?.code).toBe(ErrorCode.AGENT_UNAVAILABLE);
    expect(resp.error?.message).toContain("not found");
  });

  it("withEndpoints leaves an already-stamped manifest alone (same object)", () => {
    const { id, manifest } = makeVouchedManifest();
    manifest.endpoints = { inbox: `mesh.agent.${id}.inbox`, stream: `mesh.agent.${id}.stream` };
    expect(withEndpoints(manifest)).toBe(manifest);
  });
});

describe("isWellFormedSubject", () => {
  it("accepts concrete subjects and refuses wildcards, whitespace and empties", () => {
    expect(isWellFormedSubject("mesh.agent.KEY.inbox")).toBe(true);
    expect(isWellFormedSubject("acme.worker-1.intake")).toBe(true);
    expect(isWellFormedSubject("mesh.agent.>")).toBe(false);
    expect(isWellFormedSubject("mesh.*.inbox")).toBe(false);
    expect(isWellFormedSubject(".leading.dot")).toBe(false);
    expect(isWellFormedSubject("trailing.dot.")).toBe(false);
    expect(isWellFormedSubject("")).toBe(false);
    expect(isWellFormedSubject("has space")).toBe(false);
    expect(isWellFormedSubject(undefined)).toBe(false);
  });
});
