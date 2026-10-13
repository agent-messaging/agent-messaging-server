/**
 * §9.2 retention defaults: ephemerality is the default, durability is
 * declared. Pinned here after the July zombie harvest — 90+ dev-run
 * registrations sat in discovery for weeks because every registration got
 * the full 30-day vouch regardless of what it promised:
 *
 *   - an UNDECLARED registration (no availability_class) gets the short
 *     ephemeral vouch and self-cleans if abandoned;
 *   - declaring an availability class is the statement of intent that earns
 *     the full lease (the sleeping-laptop mailbox promise);
 *   - an explicit vouchTtlMs always wins over both defaults;
 *   - declared profile fields MERGE over the node's own, so declaring a
 *     class does not cost the platform/client attribution (EXT-1).
 */
import { describe, it, expect, vi } from "vitest";
import { nkeys } from "nats.ws";
import { MeshNode } from "../../src/node.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode } from "../../src/internal/codec.js";
import { DEFAULT_VOUCH_TTL_MS, EPHEMERAL_VOUCH_TTL_MS } from "../../src/constants.js";
import type { Manifest } from "../../src/types/manifest.js";

function makeFakeConn() {
  const registryKp = nkeys.createUser();
  const requests: Array<{ subject: string; env: ReturnType<typeof decode> }> = [];
  const fake = {
    requests,
    closed: false,
    publish: vi.fn(),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      const req = decode(data);
      requests.push({ subject, env: req });
      const resp = signEnvelope(
        createEnvelope({
          type: "respond",
          from: registryKp.getPublicKey(),
          to: req.from,
          in_reply_to: req.id,
          payload: { status: "registered" },
        }),
        registryKp,
      );
      return { data: encode(resp) };
    }),
    subscribe: vi.fn(() => ({ unsubscribe: () => undefined, drain: async () => undefined })),
    drain: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    get isClosed() {
      return fake.closed;
    },
  };
  return fake;
}

async function registeredManifest(
  opts: Parameters<ReturnType<MeshNode["addAgent"]>["register"]>[0],
  nodeProfile?: Parameters<typeof MeshNode.withConnection>[2],
): Promise<Manifest> {
  const conn = makeFakeConn();
  const node = MeshNode.withConnection(conn as unknown as ConnectionManager, nkeys.createUser(), nodeProfile);
  const agent = node.addAgent();
  await agent.register(opts);
  const reg = conn.requests.find((r) => r.subject.includes("register"));
  expect(reg).toBeDefined();
  return reg!.env.payload as Manifest; // register's payload IS the manifest
}

const ttlOf = (m: Manifest): number =>
  Date.parse(m.node!.attestation!.expires_at) - Date.parse(m.node!.attestation!.issued_at);

describe("§9.2 retention defaults", () => {
  it("an undeclared registration gets the short ephemeral vouch", async () => {
    const m = await registeredManifest({ name: "dev-spawn" });
    expect(ttlOf(m)).toBe(EPHEMERAL_VOUCH_TTL_MS);
    expect(m.node?.profile?.availability_class).toBeUndefined();
  });

  it("declaring an availability class earns the full lease", async () => {
    const m = await registeredManifest({
      name: "laptop-daemon",
      nodeProfile: { availability_class: "intermittent" },
    });
    expect(ttlOf(m)).toBe(DEFAULT_VOUCH_TTL_MS);
    expect(m.node?.profile?.availability_class).toBe("intermittent");
  });

  it("the node's own declared class covers every agent it vouches for", async () => {
    const m = await registeredManifest({ name: "service-agent" }, { availability_class: "always_on" });
    expect(ttlOf(m)).toBe(DEFAULT_VOUCH_TTL_MS);
    expect(m.node?.profile?.availability_class).toBe("always_on");
  });

  it("declared profile fields merge over the node's, keeping attribution", async () => {
    const m = await registeredManifest(
      { name: "merged", nodeProfile: { availability_class: "intermittent" } },
      { device: { platform: "linux", client: "test-host/1.0" } },
    );
    expect(m.node?.profile?.availability_class).toBe("intermittent");
    expect(m.node?.profile?.device?.platform).toBe("linux");
  });

  it("an explicit vouchTtlMs wins over both defaults", async () => {
    const conn = makeFakeConn();
    const node = MeshNode.withConnection(conn as unknown as ConnectionManager, nkeys.createUser());
    const agent = node.addAgent();
    // Private-field access via cast: the public door that sets the explicit
    // flag is a connect() option, which needs a live transport.
    (agent as unknown as { vouchTtlMs: number; vouchTtlExplicit: boolean }).vouchTtlMs = 12 * 60 * 60_000;
    (agent as unknown as { vouchTtlExplicit: boolean }).vouchTtlExplicit = true;
    await agent.register({ name: "pinned-ttl" });
    const reg = conn.requests.find((r) => r.subject.includes("register"));
    const m = reg!.env.payload as Manifest;
    expect(ttlOf(m)).toBe(12 * 60 * 60_000);
  });
});
