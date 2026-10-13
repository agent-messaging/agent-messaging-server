/**
 * The identity source in discovery (registry/identity-source-view.ts, SPEC
 * §9.7, i10): joined from the key chain's record, filterable, and never taken
 * from the registration.
 */
import { describe, it, expect } from "vitest";
import { handleDiscover } from "../../src/registry/handlers/discover.js";
import { IdentitySourceView, identitySourceMatches } from "../../src/registry/identity-source-view.js";
import type { Envelope, Manifest, DiscoverResult } from "../../src/sdk.js";
import type { PresenceStore } from "../../src/registry/presence-store.js";
import type { NodeProfileStore } from "../../src/registry/node-profile-store.js";
import { memKv } from "../helpers/fake-kv.js";

const manifest = (id: string, extra: Record<string, unknown> = {}): Manifest =>
  ({ id, name: id, description: "d", version: "1.0.0", protocol_version: "0.2.0", endpoint: `mesh.agent.${id}.inbox`, capabilities: [], offerings: [], ...extra }) as unknown as Manifest;
const presence = { status: () => "online" } as unknown as PresenceStore;
const profiles = { get: () => undefined } as unknown as NodeProfileStore;
const env = (payload: Record<string, unknown> = {}) => ({ id: "e1", from: "UCALLER", payload, trace: { trace_id: "t", span_id: "s" } }) as unknown as Envelope;

function setup() {
  const view = new IdentitySourceView(null);
  view.set("UOAUTH", { kind: "oauth", issuer: "https://login.example.com", workload_id: "buyer", since: "2026-10-13T00:00:00Z" });
  view.set("USPIFFE", { kind: "spiffe", trust_domain: "example.org", workload_id: "spiffe://example.org/a", since: "2026-10-13T00:00:00Z" });
  view.set("UMESH", { kind: "mesh", since: "2026-10-13T00:00:00Z" });
  const cache = new Map<string, Manifest>([
    ["UOAUTH", manifest("UOAUTH")],
    ["USPIFFE", manifest("USPIFFE")],
    ["UMESH", manifest("UMESH")],
    // A registration that claims a source it was never given, and an agent with no record.
    ["ULIAR", manifest("ULIAR", { identity_source: { kind: "spiffe", trust_domain: "example.org", since: "x" } })],
  ]);
  return { view, cache };
}

const run = async (payload: Record<string, unknown>, s = setup()) =>
  ((await handleDiscover(env(payload), "svc", s.cache, presence, profiles, s.view)).payload as DiscoverResult).agents as Array<Manifest & { identity_source?: { kind: string } }>;

describe("identity_source in discovery", () => {
  it("is joined from the key chain's record onto every result (i10)", async () => {
    const got = await run({});
    expect(got.find((a) => a.id === "UOAUTH")?.identity_source).toMatchObject({ kind: "oauth", issuer: "https://login.example.com" });
    expect(got.find((a) => a.id === "UMESH")?.identity_source).toMatchObject({ kind: "mesh" });
  });

  it("is never taken from the registration: a claimed source with no record is dropped (i10)", async () => {
    const got = await run({});
    expect(got.find((a) => a.id === "ULIAR")).toBeDefined();
    expect(got.find((a) => a.id === "ULIAR")?.identity_source).toBeUndefined();
    const filtered = await run({ identity_source: { trust_domain: "example.org" } });
    expect(filtered.map((a) => a.id)).toEqual(["USPIFFE"]);
  });

  it("filters on kind, issuer and trust domain, every member given matching", async () => {
    expect((await run({ identity_source: { kind: "oauth" } })).map((a) => a.id)).toEqual(["UOAUTH"]);
    expect((await run({ identity_source: { kind: "oauth", issuer: "https://other.example" } })).map((a) => a.id)).toEqual([]);
    // An agent with no record counts as kind mesh, and kind may be a list.
    expect((await run({ identity_source: { kind: "mesh" } })).map((a) => a.id)).toEqual(["UMESH", "ULIAR"]);
    expect((await run({ identity_source: { kind: ["oauth", "spiffe"] } })).map((a) => a.id)).toEqual(["UOAUTH", "USPIFFE"]);
  });

  it("matches strictly", () => {
    expect(identitySourceMatches(undefined, { kind: "oauth" })).toBe(false);
    expect(identitySourceMatches(undefined, { kind: "mesh", issuer: "i" })).toBe(false);
    expect(identitySourceMatches(undefined, {})).toBe(true);
    expect(identitySourceMatches({ kind: "bridged", issuer: "i", since: "x" }, { kind: "bridged", issuer: "i" })).toBe(true);
  });

  it("follows the store: a record written, then removed", async () => {
    const { kv } = memKv("mesh_identity_sources");
    const store = kv as unknown as { put(k: string, v: string): Promise<number>; purge(k: string): Promise<void> };
    const view = new IdentitySourceView(kv as never);
    await store.put("UA", JSON.stringify({ agent: "UA", tenant: "t", identity_source: { kind: "oauth", issuer: "i", since: "x" } }));
    await view.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(view.get("UA")).toMatchObject({ kind: "oauth" });
    await store.purge("UA");
    await new Promise((r) => setTimeout(r, 20));
    expect(view.get("UA")).toBeUndefined();
    view.stop();
  });
});
