/**
 * The storage layer's JetStream implementation against a real nats-server
 * (docs/agent-messaging-server-plan.md, step 8).
 *
 * The point of the JetStream implementation is that nothing changes at run
 * time: a bucket written before the layer existed is read through it exactly as
 * before, with the same keys, values and revisions, and a bucket the layer
 * creates has the settings the service used to give it. These tests hold it to
 * that, and to the keyed-record interface the core services use.
 *
 * Needs a nats-server binary (NATS_SERVER_BIN, or the checked-in Windows one);
 * without one every test skips.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JetStreamClient, JetStreamManager, KV } from "nats";
import { startNatsServer, type TestServer } from "../helpers/nats-server.js";
import {
  KEYED_STORES,
  keyedOf,
  messagingOf,
  openBlobStore,
  storageOf,
  type KeyedEntry,
  type KeyedStore,
} from "../../src/storage/index.js";

let server: TestServer | null = null;
let js: JetStreamClient;
let jsm: JetStreamManager;

beforeAll(async () => {
  server = await startNatsServer("storage-jetstream");
  if (!server) return;
  js = server.nc.jetstream();
  jsm = await server.nc.jetstreamManager();
}, 30_000);

afterAll(async () => {
  await server?.stop();
});

const enc = (s: string) => new TextEncoder().encode(s);

describe("keyed records on JetStream", () => {
  it("creates a store with the catalog's settings, under the store's own name", async (ctx) => {
    if (!server) return ctx.skip();
    await storageOf(js).keyed("mesh_tasks");
    const info = await jsm.streams.info("KV_mesh_tasks");
    expect(info.config.max_msgs_per_subject).toBe(KEYED_STORES.mesh_tasks.history);
    expect(info.config.max_age).toBe(KEYED_STORES.mesh_tasks.ttlMs * 1_000_000);
    await storageOf(js).keyed("mesh_held");
    const held = await jsm.streams.info("KV_mesh_held");
    expect(held.config.max_msgs_per_subject).toBe(1);
    expect(held.config.max_age).toBe(0);
  });

  it("reads a bucket written before the layer existed, with the same values and revisions", async (ctx) => {
    if (!server) return ctx.skip();
    // Written the way the services wrote it: straight on the bucket.
    const raw: KV = await js.views.kv("mesh_registry", { history: 5 });
    const r1 = await raw.put("UAAA", enc('{"name":"a"}'));
    const r2 = await raw.put("UBBB", enc('{"name":"b"}'));
    const r3 = await raw.put("UAAA", enc('{"name":"a2"}'));
    await raw.delete("UBBB");

    const store = await storageOf(js).keyed("mesh_registry");
    const a = await store.get("UAAA");
    expect(a?.revision).toBe(r3);
    expect(a?.json<{ name: string }>().name).toBe("a2");
    expect(a?.operation).toBe("PUT");
    const b = await store.get("UBBB");
    expect(b === null || b.operation !== "PUT").toBe(true);
    expect(r1).toBeLessThan(r2);

    const snap = await store.list();
    expect(snap.keys).toEqual(["UAAA"]);
    expect(snap.tombstoned).toEqual(["UBBB"]);
    expect(snap.entries.get("UAAA")?.revision).toBe(r3);

    // And the reverse: what the layer writes, the bucket holds as before.
    const r4 = await store.put("UCCC", '{"name":"c"}');
    const c = await raw.get("UCCC");
    expect(c?.revision).toBe(r4);
    expect(c?.string()).toBe('{"name":"c"}');
  });

  it("compares and sets on a revision, and a lost race throws", async (ctx) => {
    if (!server) return ctx.skip();
    const store = await storageOf(js).keyed("mesh_board_items");
    const first = await store.create("room.item1", "v1");
    await expect(store.create("room.item1", "again")).rejects.toThrow();
    const second = await store.update("room.item1", "v2", first);
    await expect(store.update("room.item1", "v3", first)).rejects.toThrow();
    expect((await store.get("room.item1"))?.string()).toBe("v2");

    await expect(store.put("room.item1", "v4", { previousRevision: first })).rejects.toThrow();
    const third = await store.put("room.item1", "v4", { previousRevision: second });
    await expect(store.delete("room.item1", { previousRevision: second })).rejects.toThrow();
    await store.delete("room.item1", { previousRevision: third });
    const gone = await store.get("room.item1");
    expect(gone === null || gone.operation === "DEL").toBe(true);
    // A deleted key can be created again.
    await store.create("room.item1", "v5");
  });

  it("purges a key and its history, on a revision when asked", async (ctx) => {
    if (!server) return ctx.skip();
    const store = await storageOf(js).keyed("mesh_boot_tokens");
    const rev = await store.put("am_token", '{"accountId":"acct"}');
    await expect(store.purge("am_token", { previousRevision: rev + 100 })).rejects.toThrow();
    await store.purge("am_token", { previousRevision: rev });
    const e = await store.get("am_token");
    expect(e === null || e.operation === "PURGE").toBe(true);
    expect((await store.list()).keys).not.toContain("am_token");
  });

  it("lists by prefix, filters, and refuses to answer short of a known floor", async (ctx) => {
    if (!server) return ctx.skip();
    const store = await storageOf(js).keyed("mesh_room_notes");
    for (const k of ["r1.a", "r1.b", "r2.a", "r10.a"]) await store.put(k, k);
    expect((await store.list({ prefix: "r1." })).keys.sort()).toEqual(["r1.a", "r1.b"]);
    expect((await store.list({ prefix: "r1", only: (k) => k.endsWith(".a") })).keys.sort()).toEqual(["r1.a", "r10.a"]);
    await expect(store.list({ minKeys: 99 })).rejects.toThrow(/fewer than the 99/);
  });

  it("watches: every current value, then each change, and resumes from a revision", async (ctx) => {
    if (!server) return ctx.skip();
    const store = await storageOf(js).keyed("mesh_tenant_limits");
    await store.put("t1", '{"max_agents":1}');
    const seen: KeyedEntry[] = [];
    const w = await store.watch();
    const done = (async () => {
      for await (const e of w) {
        seen.push(e);
        if (seen.length === 3) break;
      }
    })();
    await store.put("t2", '{"max_agents":2}');
    await store.purge("t1");
    await done;
    w.stop();
    expect(seen.map((e) => `${e.key}:${e.operation}`)).toEqual(["t1:PUT", "t2:PUT", "t1:PURGE"]);

    // Resume after the second entry: only what came later is replayed.
    const resumed = await store.watch({ fromRevision: seen[1].revision + 1 });
    const first = await resumed[Symbol.asyncIterator]().next();
    resumed.stop();
    expect(first.value?.key).toBe("t1");
    expect(first.value?.operation).toBe("PURGE");
  });

  it("adopts a bucket handed in raw, and leaves a store from the layer as it is (keyed)", async (ctx) => {
    if (!server) return ctx.skip();
    const raw = await js.views.kv("mesh_stops", { history: 1 });
    await raw.put("stp_1", enc('{"id":"stp_1"}'));
    const adopted = keyedOf(raw, js);
    expect((await adopted.list()).keys).toEqual(["stp_1"]);
    const layered: KeyedStore = await storageOf(js).keyed("mesh_stops");
    expect(keyedOf(layered)).toBe(layered);
    // One storage per handle.
    expect(storageOf(js)).toBe(storageOf(js));
  });
});

describe("messaging on NATS", () => {
  it("answers a request, shares a queue's messages, and relays with a reply subject", async (ctx) => {
    if (!server) return ctx.skip();
    const bus = messagingOf(server.nc);
    const sub = bus.subscribe("t.echo", { queue: "echo" });
    void (async () => {
      for await (const m of sub) m.respond(enc(`echo:${new TextDecoder().decode(m.data)}`));
    })();
    const answer = await bus.request("t.echo", enc("hi"), { timeout: 2000 });
    expect(new TextDecoder().decode(answer.data)).toBe("echo:hi");

    // A relay: publish with a reply subject, answer comes back on it.
    const inbox = bus.newInbox();
    const replies = bus.subscribe(inbox);
    bus.publish("t.echo", enc("relayed"), { reply: inbox });
    const it = replies[Symbol.asyncIterator]();
    const got = await it.next();
    expect(new TextDecoder().decode(got.value!.data)).toBe("echo:relayed");
    replies.unsubscribe();
    sub.unsubscribe();
    await expect(bus.request("t.nobody", enc("x"), { timeout: 500 })).rejects.toThrow();
  });

  it("a message id makes a repeated publish one message in the feed stream", async (ctx) => {
    if (!server) return ctx.skip();
    const storage = storageOf(js, server.nc);
    expect(await storage.stream("MESH_FEED").ensure()).toBe(true);
    // Interest retention keeps nothing without a consumer, so one stands.
    await (await storage.stream("MESH_FEED").consume("dedupe_test")).stop();
    const bus = messagingOf(server.nc);
    const subject = `mesh.feed.U${"D".repeat(55)}.topic`;
    for (let i = 0; i < 3; i++) bus.publish(subject, enc("same"), { msgId: "env-dedupe-1" });
    bus.publish(subject, enc("other"), { msgId: "env-dedupe-2" });
    await server.nc.flush();
    await wait(200);
    const st = (await storage.stream("MESH_FEED").info())!;
    expect(st.messages).toBe(2);
  });
});

describe("blobs on JetStream", () => {
  it("puts, gets and deletes in the object store of the store's name, as the binding's own store", async (ctx) => {
    if (!server) return ctx.skip();
    const storage = storageOf(js, server.nc);
    const blobs = await openBlobStore(storage, "rooms_drive", { fsDir: "", label: "test" });
    expect(blobs.kind).toBe("nats-object-store:rooms_drive");
    expect(blobs.own).toBe(true);
    await blobs.put("room-1/drive/a", enc("bytes"));
    expect(new TextDecoder().decode((await blobs.get("room-1/drive/a"))!)).toBe("bytes");
    await blobs.del("room-1/drive/a");
    expect(await blobs.get("room-1/drive/a")).toBeNull();
    // Written the old way, read through the layer.
    const os = await js.views.os("rooms_drive");
    await os.putBlob({ name: "old" }, enc("from before"));
    expect(new TextDecoder().decode((await (await storage.blobs("rooms_drive")).get("old"))!)).toBe("from before");
  });
});

const AGENT = `U${"A".repeat(55)}`;
const mailboxSpec = (subject: string) => ({
  subjects: [subject],
  maxAgeMs: 7 * 24 * 3600_000,
  maxBytes: 25 * 1024 * 1024,
  discard: "old" as const,
  silent: true,
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("streams on JetStream", () => {
  it("makes the single streams with the settings their services gave them", async (ctx) => {
    if (!server) return ctx.skip();
    const storage = storageOf(js, server.nc);
    expect(await storage.stream("MESH_METERING").ensure()).toBe(true);
    const events = await jsm.streams.info("MESH_EVENTS");
    expect(events.config.subjects).toEqual(["mesh.event.>"]);
    expect(events.config.retention).toBe("interest");
    const metering = await jsm.streams.info("MESH_METERING");
    expect(metering.config.subjects ?? []).toEqual([]);
    expect(metering.config.sources?.[0]).toMatchObject({ name: "MESH_EVENTS", filter_subject: "mesh.event.metering.usage" });
    expect(await storage.stream("MESH_FEED").ensure()).toBe(true);
    expect((await jsm.streams.info("MESH_FEED")).config.subjects).toEqual(["mesh.feed.*.*"]);
  });

  it("makes a mailbox exactly as the inbox buffer did, and reads one made the old way", async (ctx) => {
    if (!server) return ctx.skip();
    const boxes = storageOf(js, server.nc).streams("MESH_INBOX_<agent>");
    const box = boxes.member(AGENT);
    expect(await box.info()).toBeNull();
    await box.create(mailboxSpec(`mesh.agent.${AGENT}.inbox`));
    const cfg = (await jsm.streams.info(`MESH_INBOX_${AGENT}`)).config;
    expect(cfg.subjects).toEqual([`mesh.agent.${AGENT}.inbox`]);
    expect(cfg.no_ack).toBe(true);
    expect(cfg.retention).toBe("limits");
    expect(cfg.discard).toBe("old");
    expect(cfg.max_bytes).toBe(25 * 1024 * 1024);
    expect(cfg.max_age).toBe(7 * 24 * 3600_000 * 1_000_000);

    // A mailbox made before the layer, without no_ack: the layer names the repair.
    const OLD = `U${"B".repeat(55)}`;
    await jsm.streams.add({ name: `MESH_INBOX_${OLD}`, subjects: [`mesh.agent.${OLD}.inbox`], no_ack: false });
    const old = boxes.member(OLD);
    const st = (await old.info())!;
    expect(st.repairs).toEqual(["no_ack enabled"]);
    await old.reconfigure(st, { repair: true, subjects: [`mesh.agent.${OLD}.inbox.guarded`] });
    const healed = (await jsm.streams.info(`MESH_INBOX_${OLD}`)).config;
    expect(healed.no_ack).toBe(true);
    expect(healed.subjects).toEqual([`mesh.agent.${OLD}.inbox.guarded`]);
    expect((await old.info())!.repairs).toEqual([]);

    const ids: string[] = [];
    for await (const s of boxes.list()) ids.push(s.id);
    expect(ids.sort()).toEqual([AGENT, OLD].sort());
  });

  it("holds what is published, reads by sequence, removes one, and purges", async (ctx) => {
    if (!server) return ctx.skip();
    const box = storageOf(js, server.nc).streams("MESH_INBOX_<agent>").member(AGENT);
    for (const t of ["one", "two", "three"]) server.nc.publish(`mesh.agent.${AGENT}.inbox`, enc(t));
    await server.nc.flush();
    await wait(100);
    const st = (await box.info())!;
    expect(st.messages).toBe(3);
    const second = await box.read(st.firstSeq + 1);
    expect(new TextDecoder().decode(second.data)).toBe("two");
    expect(second.time.getTime()).toBeGreaterThan(Date.now() - 60_000);
    await box.removeMessage(st.firstSeq + 1);
    await expect(box.read(st.firstSeq + 1)).rejects.toThrow();
    expect((await box.info())!.messages).toBe(2);
    await box.purge();
    expect((await box.info())!.messages).toBe(0);
  });

  it("reads from a point", async (ctx) => {
    if (!server) return ctx.skip();
    const rec = storageOf(js, server.nc).streams("rooms_<room>").member("room-test1");
    await rec.create({ subjects: ["mesh.aclroom.room-test1.>"], maxMsgs: 100, maxBytes: 1024 * 1024, discard: "new" });
    for (let i = 1; i <= 5; i++) server.nc.publish("mesh.aclroom.room-test1.say", enc(`m${i}`));
    await server.nc.flush();
    await wait(100);
    const got: string[] = [];
    for await (const m of rec.readFrom(3, { max: 10, waitMs: 1000 })) got.push(`${m.seq}:${new TextDecoder().decode(m.data)}`);
    expect(got).toEqual(["3:m3", "4:m4", "5:m5"]);
    // A stream that answers its publishers takes an append and says where it landed.
    expect(await rec.append("mesh.aclroom.room-test1.say", enc("m6"))).toBe(6);
    const cfg = (await jsm.streams.info("rooms_room-test1")).config;
    expect(cfg.discard).toBe("new");
    expect(cfg.max_msgs).toBe(100);
    await rec.destroy();
    expect(await rec.info()).toBeNull();
  });

  it("keeps a durable consumer's place, redelivers what was not acknowledged, and reports its state", async (ctx) => {
    if (!server) return ctx.skip();
    const C = `U${"C".repeat(55)}`;
    const box = storageOf(js, server.nc).streams("MESH_INBOX_<agent>").member(C);
    await box.create(mailboxSpec(`mesh.agent.${C}.inbox`));
    for (const t of ["a", "b"]) server.nc.publish(`mesh.agent.${C}.inbox`, enc(t));
    await server.nc.flush();
    await wait(100);
    const seen: string[] = [];
    const c = await box.consume("test_durable", { from: "all" });
    for await (const m of c) {
      const t = new TextDecoder().decode(m.data);
      seen.push(t);
      if (t === "a" && seen.filter((x) => x === "a").length === 1) m.nak(50);
      else m.ack();
      if (seen.length === 3) break;
    }
    c.stop();
    expect(seen).toEqual(["a", "b", "a"]);
    await wait(100);
    const state = await box.consumerState("test_durable");
    expect(state.pending).toBe(0);
    expect(state.ackPending).toBe(0);
    await expect(box.consumerState("no_such_durable")).rejects.toThrow();
  });
});
