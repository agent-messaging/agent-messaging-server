import { afterEach, describe, expect, it } from "vitest";
import { handleDiscover } from "../../src/registry/handlers/discover.js";
import { setUnlistedResolver } from "../../src/registry/unlisted.js";
import type { Envelope, Manifest, DiscoverResult } from "../../src/sdk.js";
import type { PresenceStore } from "../../src/registry/presence-store.js";
import type { NodeProfileStore } from "../../src/registry/node-profile-store.js";

// Discover never lists a Mesh Internal Test Agent, an archived agent or one in
// the trash (docs/agent-categories-plan.md item 13). The registry is told
// which keys those are by the API, through setUnlistedResolver.

const manifest = (id: string): Manifest => ({ id, name: id, description: "d", version: "1.0.0", protocol_version: "0.2.0", endpoint: `mesh.agent.${id}.inbox`, capabilities: [], offerings: [] }) as unknown as Manifest;
const presence = { status: () => "online" } as unknown as PresenceStore;
const profiles = { get: () => undefined } as unknown as NodeProfileStore;
const env = { id: "e1", from: "UCALLER", payload: {}, trace: { trace_id: "t", span_id: "s" } } as unknown as Envelope;
const cache = new Map([["UTEST", manifest("UTEST")], ["UPROVIDED", manifest("UPROVIDED")]]);
const ids = async (): Promise<string[]> => ((await handleDiscover(env, "svc", cache, presence, profiles)).payload as DiscoverResult).agents.map((a) => (a as { id: string }).id);

describe("discover and the agents never listed", () => {
  afterEach(() => setUnlistedResolver(null));

  it("lists everything when nothing is installed", async () => {
    expect(await ids()).toEqual(["UTEST", "UPROVIDED"]);
  });

  it("drops the keys the API says are never listed", async () => {
    setUnlistedResolver(async () => new Set(["UTEST"]));
    expect(await ids()).toEqual(["UPROVIDED"]);
  });

  it("returns a never-listed agent when the caller names it, and only what was named", async () => {
    setUnlistedResolver(async () => new Set(["UTEST"]));
    const named = { ...env, payload: { agent_ids: ["UTEST"] } } as unknown as Envelope;
    const got = ((await handleDiscover(named, "svc", cache, presence, profiles)).payload as DiscoverResult).agents.map((a) => (a as { id: string }).id);
    expect(got).toEqual(["UTEST"]);
  });

  it("returns an unlisted agent when named, and never a private one to a stranger", async () => {
    const c = new Map([
      ["UUNL", { ...manifest("UUNL"), visibility: "unlisted", owner: "OWNER" } as Manifest],
      ["UPRIV", { ...manifest("UPRIV"), visibility: "private", owner: "OWNER" } as Manifest],
    ]);
    const named = { ...env, payload: { agent_ids: ["UUNL", "UPRIV"] } } as unknown as Envelope;
    const got = ((await handleDiscover(named, "svc", c, presence, profiles)).payload as DiscoverResult).agents.map((a) => (a as { id: string }).id);
    expect(got).toEqual(["UUNL"]);
    const listing = ((await handleDiscover(env, "svc", c, presence, profiles)).payload as DiscoverResult).agents;
    expect(listing).toEqual([]);
  });

  // What conformance c06 and c14 rely on (docs/no-anonymous-agents-plan.md item
  // 15): their agents are named test agents, so they discover them by id. That
  // path must still join presence (§9.3), apply the availability filter (§9.6)
  // and return the stored manifest's fields, or those tests prove nothing.
  it("by id, a never-listed agent keeps the presence join, the availability filter and its fields", async () => {
    setUnlistedResolver(async () => new Set(["UTEST"]));
    const c = new Map([["UTEST", { ...manifest("UTEST"), interaction: "service", node: { id: "NODE" } } as unknown as Manifest]]);
    let state = "online";
    const p = { status: () => state } as unknown as PresenceStore;
    const ask = async (payload: Record<string, unknown>) =>
      ((await handleDiscover({ ...env, payload } as unknown as Envelope, "svc", c, p, profiles)).payload as DiscoverResult).agents as Array<Record<string, unknown>>;
    expect(await ask({})).toEqual([]);
    const live = await ask({ agent_ids: ["UTEST"] });
    expect(live.map((a) => [a.id, a.availability, a.interaction])).toEqual([["UTEST", "online", "service"]]);
    state = "offline";
    expect((await ask({ agent_ids: ["UTEST"] })).map((a) => a.availability)).toEqual(["offline"]);
    expect(await ask({ agent_ids: ["UTEST"], availability: "online" })).toEqual([]);
  });

  it("drops nothing when the answer fails, rather than returning nothing", async () => {
    setUnlistedResolver(async () => { throw new Error("no accounts"); });
    expect(await ids()).toEqual(["UTEST", "UPROVIDED"]);
  });
});
