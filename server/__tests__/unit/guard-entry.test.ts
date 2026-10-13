// EXT-6 guard entries, and the write-only-state bug behind safety item 4.4.
//
// A guard entry is a claim about something outside the bucket: that the agent has
// stopped listening on its public inbox and that admission is filtering on its
// behalf. Nothing ever revoked one and nothing reconciled one, so the claim
// outlived the fact — 25 of the 27 entries on the reference instance belong to
// agents with no manifest at all. These tests pin the three registry-side halves
// of the fix: the entry dies with the registration (deregister, reap), and a
// guard lookup that FAILED is `"unknown"`, which is never a licence to re-point a
// mailbox at the raw, unfiltered inbox.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDeregister } from "../../src/registry/handlers/deregister.js";
import { Reaper } from "../../src/registry/reaper.js";
import { InboxBuffer, inboxStreamName } from "../../src/registry/inbox-buffer.js";
import type { GuardState } from "../../src/registry/inbox-buffer.js";
import { guardStateResolver, guardEntryClearer } from "../../src/registry/registry-service.js";
import { PresenceStore } from "../../src/registry/presence-store.js";
import { createEnvelope, nkeys } from "../../src/sdk.js";
import type { Manifest } from "../../src/sdk.js";

const AGENT = "UAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** A manifest whose node vouch has already lapsed — reaper rule 2, which
 *  reclaims regardless of liveness and needs no probe. */
function expiredManifest(id = AGENT): Manifest {
  return {
    id,
    name: "stale-agent",
    node: { id, attestation: { expires_at: new Date(Date.now() - 60_000).toISOString() } },
  } as unknown as Manifest;
}

describe("deregister deletes the guard entry", () => {
  const serviceId = "mesh.service.registry";
  let kv: { get: ReturnType<typeof vi.fn>; purge: ReturnType<typeof vi.fn> };
  let nc: { publish: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    kv = {
      get: vi.fn(async () => ({ json: () => expiredManifest(), string: () => "{}" })),
      // PURGE, not delete: `mesh_registry` keeps history 5, so a deleted manifest
      // left up to five prior copies (name, owner key, node, EXT-1 device fields)
      // readable off the backing stream. The reaper already purged; deregistration
      // now does too, so the removal a person asks for is not weaker than the one
      // that happens to them automatically.
      purge: vi.fn(async () => undefined),
    };
    nc = { publish: vi.fn() };
  });

  it("clears the entry alongside the manifest and the mailbox", async () => {
    const clearGuard = vi.fn(async () => undefined);
    const inboxBuffer = { remove: vi.fn(async () => undefined) };
    const env = createEnvelope({ type: "register", from: AGENT, payload: { deregister: true } });

    const resp = await handleDeregister(
      env,
      kv as never,
      nc as never,
      serviceId,
      new Map(),
      inboxBuffer as never,
      clearGuard,
    );

    expect(resp.error).toBeUndefined();
    expect(kv.purge).toHaveBeenCalledWith(AGENT);
    expect(inboxBuffer.remove).toHaveBeenCalledWith(AGENT);
    expect(clearGuard).toHaveBeenCalledWith(AGENT);
  });

  it("still deregisters when clearing the entry fails", async () => {
    // Best effort by design: losing a registration must not fail on the guard
    // bucket. The entry is reconciled later — the agent's own SDK revokes it on
    // its next registration, and the next deregister/reap tries again.
    const clearGuard = vi.fn(async () => {
      throw new Error("kv unavailable");
    });
    const env = createEnvelope({ type: "register", from: AGENT, payload: { deregister: true } });

    const resp = await handleDeregister(env, kv as never, nc as never, serviceId, new Map(), undefined, clearGuard);

    expect(resp.error).toBeUndefined();
    expect((resp.payload as { status?: string }).status).toBe("deregistered");
  });

  it("does not clear the entry when there was no registration to remove", async () => {
    kv.get = vi.fn(async () => null);
    const clearGuard = vi.fn(async () => undefined);
    const env = createEnvelope({ type: "register", from: AGENT, payload: { deregister: true } });

    const resp = await handleDeregister(env, kv as never, nc as never, serviceId, new Map(), undefined, clearGuard);

    expect(resp.error).toBeDefined();
    expect(clearGuard).not.toHaveBeenCalled();
  });
});

describe("the reaper deletes the guard entry when it reclaims an agent", () => {
  it("clears the entry alongside the manifest and the mailbox", async () => {
    const nc = { publish: vi.fn() };
    const kv = { purge: vi.fn(async () => undefined) };
    const cache = new Map<string, Manifest>([[AGENT, expiredManifest()]]);
    const inboxBuffer = { remove: vi.fn(async () => undefined) };
    const clearGuard = vi.fn(async () => undefined);

    const reaper = new Reaper(
      nc as never,
      kv as never,
      cache,
      new PresenceStore(),
      nkeys.createUser(),
      inboxBuffer as never,
      clearGuard,
    );

    expect(await reaper.sweep()).toBe(1);
    expect(cache.has(AGENT)).toBe(false);
    expect(inboxBuffer.remove).toHaveBeenCalledWith(AGENT);
    expect(clearGuard).toHaveBeenCalledWith(AGENT);
  });

  it("keeps a reclaimed agent's mailbox while messages wait in it (technical debt 82)", async () => {
    const cache = new Map<string, Manifest>([[AGENT, expiredManifest()]]);
    const inboxBuffer = { remove: vi.fn(async () => undefined), pending: vi.fn(async () => 3) };
    const reaper = new Reaper({ publish: vi.fn() } as never, { purge: vi.fn(async () => undefined) } as never, cache, new PresenceStore(), nkeys.createUser(), inboxBuffer as never);
    expect(await reaper.sweep()).toBe(1);
    expect(inboxBuffer.remove).not.toHaveBeenCalled();
    // A mailbox that cannot be read counts as holding mail.
    const unknown = { remove: vi.fn(async () => undefined), pending: vi.fn(async () => null) };
    const r2 = new Reaper({ publish: vi.fn() } as never, { purge: vi.fn(async () => undefined) } as never, new Map([[AGENT, expiredManifest()]]), new PresenceStore(), nkeys.createUser(), unknown as never);
    expect(await r2.sweep()).toBe(1);
    expect(unknown.remove).not.toHaveBeenCalled();
  });

  it("never reclaims an unanswering agent on a live node while mail waits for it", async () => {
    const live = { ...expiredManifest(), name: "planner", node: { id: "UNODE", attestation: { expires_at: new Date(Date.now() + 3600_000).toISOString() } } } as unknown as Manifest;
    const presence = new PresenceStore();
    presence.update("UNODE");
    const cache = new Map<string, Manifest>([[AGENT, live]]);
    const inboxBuffer = { remove: vi.fn(async () => undefined), pending: vi.fn(async () => 3) };
    const nc = { publish: vi.fn(), request: vi.fn(async () => { throw new Error("timeout"); }) };
    const reaper = new Reaper(nc as never, { purge: vi.fn(async () => undefined) } as never, cache, presence, nkeys.createUser(), inboxBuffer as never);
    for (let i = 0; i < 5; i++) await reaper.sweep();
    expect(cache.has(AGENT)).toBe(true);
    expect(inboxBuffer.remove).not.toHaveBeenCalled();
  });

  it("does not clear entries for agents it did not reclaim", async () => {
    const live = {
      ...expiredManifest(),
      node: { id: AGENT, attestation: { expires_at: new Date(Date.now() + 3600_000).toISOString() } },
    } as unknown as Manifest;
    const cache = new Map<string, Manifest>([[AGENT, live]]);
    const clearGuard = vi.fn(async () => undefined);

    const reaper = new Reaper(
      { publish: vi.fn() } as never,
      { purge: vi.fn() } as never,
      cache,
      new PresenceStore(),
      nkeys.createUser(),
      undefined,
      clearGuard,
    );

    // Offline node, undeclared availability class: the vouch is the only clock
    // and it has not lapsed, so nothing is reclaimed.
    expect(await reaper.sweep()).toBe(0);
    expect(clearGuard).not.toHaveBeenCalled();
  });
});

describe("a failed guard lookup is unknown, not false", () => {
  it("reads a live PUT as guarded and a DEL tombstone as unguarded", async () => {
    const put = guardStateResolver({ get: async () => ({ operation: "PUT" }) } as never);
    const del = guardStateResolver({ get: async () => ({ operation: "DEL" }) } as never);
    const absent = guardStateResolver({ get: async () => null } as never);

    expect(await put(AGENT)).toBe(true);
    expect(await del(AGENT)).toBe(false);
    expect(await absent(AGENT)).toBe(false);
  });

  it("returns 'unknown' when the read throws, and says so", async () => {
    // The whole point of item 3.11's defect shape: a catch that cannot tell
    // absent from broken. `false` here would license re-pointing a guarded
    // agent's mailbox at the raw inbox on the strength of a KV hiccup.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolve = guardStateResolver({
      get: async () => {
        throw new Error("no responders");
      },
    } as never);

    expect(await resolve(AGENT)).toBe("unknown");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("clears an entry through the narrow verb the registry hands out", async () => {
    const del = vi.fn(async () => undefined);
    await guardEntryClearer({ delete: del } as never)(AGENT);
    expect(del).toHaveBeenCalledWith(AGENT);
  });
});

describe("InboxBuffer.ensure — unknown guard state never re-points a mailbox", () => {
  const name = inboxStreamName(AGENT);
  const raw = `mesh.agent.${AGENT}.inbox`;
  const guardedSubject = `${raw}.guarded`;

  function makeBuffer(state: GuardState | "absent", config: Record<string, unknown>) {
    const streams = {
      info: vi.fn(async () => ({ config: { name, ...config } })),
      update: vi.fn(async () => ({})),
      purge: vi.fn(async () => ({})),
      add: vi.fn(async () => ({})),
      list: vi.fn(),
    };
    const nc = { jetstreamManager: vi.fn(async () => ({ streams })) };
    const resolver = state === "absent" ? undefined : async () => state;
    return { streams, buffer: new InboxBuffer(nc as never, resolver) };
  }

  it("leaves a guarded mailbox alone when the lookup came back unknown", async () => {
    // The live failure this closes: a resolver IS installed, so the buffer used
    // to read "guard state is known", and a transient KV error (which used to
    // arrive as `false`) re-pointed a guarded agent's mailbox at the raw inbox
    // and logged it as a routine heal.
    const { streams, buffer } = makeBuffer("unknown", { subjects: [guardedSubject], no_ack: true });
    await buffer.ensure(AGENT);
    expect(streams.update).not.toHaveBeenCalled();
    expect(streams.purge).not.toHaveBeenCalled();
  });

  it("leaves the capture subject alone on a no_ack-only heal when state is unknown", async () => {
    // The heal still has to happen — no_ack is what keeps stream capture from
    // racing the agent's real replies — but it must not smuggle a re-point in
    // with it.
    const { streams, buffer } = makeBuffer("unknown", { subjects: [guardedSubject], no_ack: false });
    await buffer.ensure(AGENT);
    expect(streams.update).toHaveBeenCalledTimes(1);
    const patch = streams.update.mock.calls[0][1] as { no_ack: boolean; subjects: string[] };
    expect(patch.no_ack).toBe(true);
    expect(patch.subjects).toEqual([guardedSubject]);
  });

  it("leaves it alone when there is no resolver at all", async () => {
    const { streams, buffer } = makeBuffer("absent", { subjects: [guardedSubject], no_ack: true });
    await buffer.ensure(AGENT);
    expect(streams.update).not.toHaveBeenCalled();
  });

  it("does re-point when the lookup definitely says unguarded", async () => {
    const { streams, buffer } = makeBuffer(false, { subjects: [guardedSubject], no_ack: true });
    await buffer.ensure(AGENT);
    expect(streams.update).toHaveBeenCalledTimes(1);
    expect((streams.update.mock.calls[0][1] as { subjects: string[] }).subjects).toEqual([raw]);
    // Switching AWAY from guarded keeps the queued mail: it was admission-
    // approved when it was captured.
    expect(streams.purge).not.toHaveBeenCalled();
  });

  it("purges before switching a healed mailbox TO guarded", async () => {
    // The residual in the heal path. Whatever the stream captured off the raw
    // inbox is precisely what admission would have dropped; leaving it in place
    // hands it to the agent on its next offline drain — the same leak, arriving
    // late instead of live. `setGuarded` already purged for this reason; the heal
    // did not.
    const { streams, buffer } = makeBuffer(true, { subjects: [raw], no_ack: true });
    await buffer.ensure(AGENT);
    expect(streams.purge).toHaveBeenCalledWith(name);
    expect(streams.update).toHaveBeenCalledTimes(1);
    expect((streams.update.mock.calls[0][1] as { subjects: string[] }).subjects).toEqual([guardedSubject]);
    expect(streams.purge.mock.invocationCallOrder[0]).toBeLessThan(
      streams.update.mock.invocationCallOrder[0],
    );
  });

  it("does nothing when the mailbox already captures the right subject", async () => {
    const { streams, buffer } = makeBuffer(true, { subjects: [guardedSubject], no_ack: true });
    await buffer.ensure(AGENT);
    expect(streams.update).not.toHaveBeenCalled();
    expect(streams.purge).not.toHaveBeenCalled();
  });
});
