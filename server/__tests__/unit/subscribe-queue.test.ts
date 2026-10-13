// A service subject cannot have a second instance until it has a queue group.
//
// Core NATS delivers a published message to EVERY matching subscriber. Two
// registry instances on `mesh.registry.register` therefore each receive every
// request, each run the handler, and each answer the requester's reply subject;
// the requester keeps the first reply and drops the rest, so the duplication is
// invisible from outside while every request is served, charged and applied
// twice. A queue group makes the server pick exactly one member per message.
//
// `subscribeWithHandler` typed its connection as `{ subscribe: (subject) => any }`,
// so no caller could have asked for a queue group even if it wanted one. This
// only removes that impossibility — nothing sets a queue name yet, and the
// no-queue call has to stay exactly what it was.
import { describe, it, expect, vi } from "vitest";
import { subscribeWithHandler } from "../../src/shared/handler.js";
import { createEnvelope } from "../../src/sdk.js";

function fakeNc() {
  const sub = { async *[Symbol.asyncIterator]() { /* no traffic */ } };
  const subscribe = vi.fn(() => sub);
  return { sub, nc: { subscribe } as never, subscribe };
}

const handler = async () => createEnvelope({ type: "respond", from: "svc" });

describe("subscribeWithHandler queue groups", () => {
  it("passes the queue name through when one is given", () => {
    const { nc, subscribe } = fakeNc();
    subscribeWithHandler(nc, "mesh.registry.register", "svc", handler, undefined, undefined, "registry");
    expect(subscribe).toHaveBeenCalledWith("mesh.registry.register", { queue: "registry" });
  });

  it("omits the options argument entirely when no queue is given", () => {
    // Not `{ queue: undefined }`: the existing subscriptions must produce the
    // identical `nc.subscribe(subject)` call they always did, since this item is
    // not meant to change any of them.
    const { nc, subscribe } = fakeNc();
    subscribeWithHandler(nc, "mesh.rooms.provision", "svc", handler);
    expect(subscribe).toHaveBeenCalledWith("mesh.rooms.provision");
    expect(subscribe.mock.calls[0].length).toBe(1);
  });

  it("still omits it when the optional arguments before queue are supplied", () => {
    const { nc, subscribe } = fakeNc();
    const boundKey = () => null;
    subscribeWithHandler(nc, "mesh.registry.get.*", "svc", handler, undefined, boundKey);
    expect(subscribe.mock.calls[0].length).toBe(1);
  });

  it("returns the subscription either way", () => {
    const a = fakeNc();
    const b = fakeNc();
    expect(subscribeWithHandler(a.nc, "s", "svc", handler)).toBe(a.sub);
    expect(subscribeWithHandler(b.nc, "s", "svc", handler, undefined, undefined, "q")).toBe(b.sub);
  });

  it("treats an empty queue name as no queue", () => {
    // "" is not a queue group in NATS, and passing `{ queue: "" }` would be a
    // silently different subscription. Config that arrives empty means absent.
    const { nc, subscribe } = fakeNc();
    subscribeWithHandler(nc, "s", "svc", handler, undefined, undefined, "");
    expect(subscribe.mock.calls[0].length).toBe(1);
  });
});
