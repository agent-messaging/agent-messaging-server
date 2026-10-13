/**
 * The storage layer's JetStream wrapper passes each call to the bucket exactly
 * as the services made it before the layer existed: the same method, the same
 * arguments, and no option the caller did not give. That is what keeps the
 * services' run-time behaviour, and every test that watches a fake bucket,
 * unchanged. The behaviour against a real server is in
 * __tests__/integration/storage-jetstream.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  KEYED_STORES,
  isStoreSettingError,
  jetStreamOf,
  keyedOf,
  messagingOf,
  storageOf,
} from "../../src/storage/index.js";
import { fakeJs } from "../helpers/fake-kv.js";

function rawBucket() {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => 1),
    create: vi.fn(async () => 2),
    update: vi.fn(async () => 3),
    delete: vi.fn(async () => undefined),
    purge: vi.fn(async () => undefined),
    watch: vi.fn(async () => ({ stop() {}, async *[Symbol.asyncIterator]() {} })),
  };
}

describe("a JetStream bucket behind the layer", () => {
  it("writes with the arguments it was given and nothing more", async () => {
    const raw = rawBucket();
    const kv = keyedOf(raw as never);
    await kv.put("k", "v");
    expect(raw.put.mock.calls[0]).toEqual(["k", "v"]);
    await kv.put("k", "v", { previousRevision: 4 });
    expect(raw.put.mock.calls[1]).toEqual(["k", "v", { previousSeq: 4 }]);
    await kv.create("k", "v");
    expect(raw.create.mock.calls[0]).toEqual(["k", "v"]);
    await kv.update("k", "v", 9);
    expect(raw.update.mock.calls[0]).toEqual(["k", "v", 9]);
  });

  it("removes with the arguments it was given, translating the revision option", async () => {
    const raw = rawBucket();
    const kv = keyedOf(raw as never);
    await kv.delete("k");
    await kv.delete("k", { previousRevision: 7 });
    await kv.purge("k");
    await kv.purge("k", { previousRevision: 8 });
    expect(raw.delete.mock.calls).toEqual([["k"], ["k", { previousSeq: 7 }]]);
    expect(raw.purge.mock.calls).toEqual([["k"], ["k", { previousSeq: 8 }]]);
  });

  it("watches with the bucket's own resume option", async () => {
    const raw = rawBucket();
    const kv = keyedOf(raw as never);
    await kv.watch();
    await kv.watch({});
    await kv.watch({ fromRevision: 12 });
    expect(raw.watch.mock.calls).toEqual([[], [{}], [{ resumeFromRevision: 12 }]]);
  });

  it("lists through the backing stream's subjects, never kv.keys()", async () => {
    const h = fakeJs();
    const live = new Map([["a.1", "x"], ["a.2", "y"], ["b.1", "z"]]);
    const raw = {
      ...rawBucket(),
      keys: vi.fn(() => { throw new Error("kv.keys() must not be used"); }),
      get: vi.fn(async (k: string) => (live.has(k) ? { key: k, operation: "PUT", length: 1, json: () => live.get(k) } : null)),
      status: h.bucket("mesh_test", () => [...live.keys()]),
    };
    const kv = keyedOf(raw as never, h.js as never);
    expect((await kv.list()).keys.sort()).toEqual(["a.1", "a.2", "b.1"]);
    expect((await kv.list({ prefix: "a." })).keys.sort()).toEqual(["a.1", "a.2"]);
    expect(raw.keys).not.toHaveBeenCalled();
  });
});

describe("the messaging interface on a NATS connection", () => {
  function rawConnection() {
    const sub = { unsubscribe() {}, async *[Symbol.asyncIterator]() {} };
    return {
      publish: vi.fn(),
      subscribe: vi.fn(() => sub),
      request: vi.fn(async () => ({ subject: "r", data: new Uint8Array(), respond: () => true })),
    };
  }

  it("publishes, subscribes and requests with the arguments it was given and nothing more", async () => {
    const nc = rawConnection();
    const bus = messagingOf(nc as never);
    const data = new Uint8Array([1]);
    bus.publish("a", data);
    bus.publish("b", data, { reply: "inbox" });
    bus.subscribe("c");
    bus.subscribe("d", { queue: "q" });
    await bus.request("e", data, { timeout: 2000 });
    expect(nc.publish.mock.calls).toEqual([["a", data], ["b", data, { reply: "inbox" }]]);
    expect(nc.subscribe.mock.calls).toEqual([["c"], ["d", { queue: "q" }]]);
    expect(nc.request.mock.calls).toEqual([["e", data, { timeout: 2000 }]]);
  });

  it("sends a live request (the registry's probe) as the plain request it always was", async () => {
    const nc = rawConnection();
    const bus = messagingOf(nc as never);
    const data = new Uint8Array([2]);
    await bus.request("mesh.agent.UX.inbox", data, { timeout: 3000, live: true });
    expect(nc.request.mock.calls).toEqual([["mesh.agent.UX.inbox", data, { timeout: 3000 }]]);
  });

  it("carries a message id as the Nats-Msg-Id header, and makes private inboxes", () => {
    const nc = rawConnection();
    const bus = messagingOf(nc as never);
    bus.publish("mesh.feed.x.y", new Uint8Array(), { msgId: "env-1" });
    const opts = (nc.publish.mock.calls[0] as unknown[])[2] as { headers: { get(k: string): string } };
    expect(opts.headers.get("Nats-Msg-Id")).toBe("env-1");
    expect(bus.newInbox()).toMatch(/^_INBOX\./);
    expect(messagingOf(nc as never)).toBe(bus);
    expect(messagingOf(bus)).toBe(bus);
  });
});

describe("storage from the handle the core has always been given", () => {
  it("opens a store by its name with the catalog's settings", async () => {
    const views = { kv: vi.fn(async () => rawBucket()) };
    const js = { views };
    await storageOf(js as never).keyed("mesh_boot_tokens");
    expect(views.kv).toHaveBeenCalledWith("mesh_boot_tokens", {
      history: KEYED_STORES.mesh_boot_tokens.history,
      ttl: KEYED_STORES.mesh_boot_tokens.ttlMs,
      replicas: 1,
    });
    await storageOf(js as never).keyed("mesh_held");
    expect(views.kv).toHaveBeenLastCalledWith("mesh_held", { history: 1, ttl: undefined, replicas: 1 });
  });

  it("is one storage per handle, and hands the platform its client back", () => {
    const js = { views: { kv: vi.fn() } };
    expect(storageOf(js as never)).toBe(storageOf(js as never));
    expect(storageOf(storageOf(js as never))).toBe(storageOf(js as never));
    expect(jetStreamOf(js as never)).toBe(js);
  });

  it("lets a replica count the cluster cannot hold stop the boot", () => {
    expect(isStoreSettingError(new Error("replicas > 1 not supported in non-clustered mode"))).toBe(true);
    expect(isStoreSettingError(new Error("stream not found"))).toBe(false);
  });
});
