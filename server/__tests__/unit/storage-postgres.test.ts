/**
 * The storage layer's Postgres side (step 9 of
 * docs/agent-messaging-server-plan.md): keyed records and streams, run on
 * PGlite, which is Postgres in this process. What is held here is what the
 * core services rely on from the JetStream binding: revisions that grow,
 * compare-and-set that refuses with "wrong last sequence", removal markers a
 * watch sees, values that expire, complete listings, streams with limits and
 * deduplication, and durable consumers that resume where they were.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresKeyed } from "../../src/storage/postgres/keyed.js";
import { pgSql, type Sql } from "../../src/storage/postgres/sql.js";
import { PostgresState } from "../../src/storage/postgres/state.js";
import { subjectRegex } from "../../src/storage/postgres/streams.js";
import type { KeyedEntry, StreamDelivery } from "../../src/storage/types.js";
import { pgliteSql } from "./pglite-sql.js";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sql: Sql & { close(): Promise<void> };
let state: PostgresState;

// PGlite by default. With AMS_TEST_POSTGRES_URL set (a throwaway database on
// a real server), the same tests run there instead, through the pg driver.
const REAL = process.env.AMS_TEST_POSTGRES_URL?.trim();

beforeEach(async () => {
  if (REAL) {
    sql = pgSql({ connectionString: REAL, max: 4 });
    await sql.query(
      "drop table if exists ams_keyed, ams_keyed_stores, ams_streams, ams_stream_messages, ams_stream_consumers, ams_account, ams_broker_sessions, ams_schema cascade",
    );
  } else {
    sql = await pgliteSql();
  }
  state = new PostgresState(sql);
  await state.open();
});
afterEach(async () => {
  await state.close();
  await sql.close();
});

async function take<T>(it: AsyncIterator<T>, n: number, ms = 5000): Promise<T[]> {
  const out: T[] = [];
  const deadline = Date.now() + ms;
  while (out.length < n) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`only ${out.length} of ${n} arrived`);
    const r = await Promise.race([it.next(), sleep(left).then(() => null)]);
    if (r === null) throw new Error(`only ${out.length} of ${n} arrived`);
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

describe("keyed records on Postgres", () => {
  it("puts, gets and counts revisions per store", async () => {
    const kv = state.keyed("mesh_registry");
    const r1 = await kv.put("a", "one");
    const r2 = await kv.put("b", te.encode("two"));
    const r3 = await kv.put("a", "three");
    expect([r1, r2, r3]).toEqual([1, 2, 3]);
    const a = await kv.get("a");
    expect(a?.string()).toBe("three");
    expect(a?.revision).toBe(3);
    expect(a?.operation).toBe("PUT");
    expect(await kv.get("missing")).toBeNull();
    // Another store counts on its own.
    expect(await state.keyed("mesh_tenants").put("x", "{}")).toBe(1);
  });

  it("compare-and-set refuses with JetStream's words", async () => {
    const kv = state.keyed("mesh_tasks");
    const r1 = await kv.create("t", JSON.stringify({ s: 1 }));
    await expect(kv.create("t", "again")).rejects.toThrow(/wrong last sequence/);
    const r2 = await kv.update("t", JSON.stringify({ s: 2 }), r1);
    await expect(kv.update("t", "stale", r1)).rejects.toThrow(/wrong last sequence: 2/);
    await expect(kv.put("t", "x", { previousRevision: 99 })).rejects.toThrow(/wrong last sequence/);
    expect((await kv.get("t"))?.json()).toEqual({ s: 2 });
    await kv.delete("t", { previousRevision: r2 });
    // A deleted key can be created again.
    await kv.create("t", "back");
    expect((await kv.get("t"))?.string()).toBe("back");
  });

  it("leaves a removal marker that reads as not PUT", async () => {
    const kv = state.keyed("mesh_held");
    await kv.put("k", "v");
    await kv.delete("k");
    const e = await kv.get("k");
    expect(e === null || e.operation !== "PUT").toBe(true);
    await kv.put("p", "v");
    await kv.purge("p");
    const snap = await kv.list();
    expect(snap.keys).toEqual([]);
    expect(snap.tombstoned.sort()).toEqual(["k", "p"]);
  });

  it("lists by prefix, completely, with a floor", async () => {
    const kv = state.keyed("mesh_board_items");
    await kv.put("room1.a", "1");
    await kv.put("room1.b", "2");
    await kv.put("room2.a", "3");
    await kv.put("room1%x", "4");
    const snap = await kv.list({ prefix: "room1." });
    expect(snap.keys).toEqual(["room1.a", "room1.b"]);
    expect(snap.entries.get("room1.b")?.string()).toBe("2");
    expect((await kv.list({ only: (k) => k.endsWith("a") })).keys).toEqual(["room1.a", "room2.a"]);
    await expect(kv.list({ minKeys: 10 })).rejects.toThrow(/cannot enumerate/);
  });

  it("expires a value with a time to live", async () => {
    const kv = new PostgresKeyed(sql, "mesh_boot_tokens", 150);
    await kv.put("tok", "v");
    expect((await kv.get("tok"))?.string()).toBe("v");
    await sleep(250);
    expect(await kv.get("tok")).toBeNull();
    expect((await kv.list()).keys).toEqual([]);
    // An expired key can be created again.
    await kv.create("tok", "new");
  });

  it("watches the current values, then each change, and resumes from a revision", async () => {
    const kv = state.keyed("mesh_agent_status");
    await kv.put("a", "1");
    await kv.put("b", "2");
    const w = await kv.watch();
    const it = w[Symbol.asyncIterator]();
    const first = await take(it, 2);
    expect(first.map((e) => e.key).sort()).toEqual(["a", "b"]);
    await kv.put("c", "3");
    await kv.delete("a");
    const next = await take(it, 2);
    expect(next.map((e: KeyedEntry) => `${e.key}:${e.operation}`)).toEqual(["c:PUT", "a:DEL"]);
    w.stop();
    const lastRev = next[1]!.revision;
    await kv.put("d", "4");
    const w2 = await kv.watch({ fromRevision: lastRev + 1 });
    const again = await take(w2[Symbol.asyncIterator](), 1);
    expect(again[0]!.key).toBe("d");
    w2.stop();
  });
});

describe("streams on Postgres", () => {
  it("maps subject patterns to regular expressions", () => {
    const re = (p: string) => new RegExp(subjectRegex(p));
    expect(re("mesh.event.>").test("mesh.event.a.b")).toBe(true);
    expect(re("mesh.event.>").test("mesh.event")).toBe(false);
    expect(re("mesh.feed.*.*").test("mesh.feed.A.t")).toBe(true);
    expect(re("mesh.feed.*.*").test("mesh.feed.get")).toBe(false);
    expect(re("mesh.agent.X.inbox").test("mesh.agent.X.inbox.guarded")).toBe(false);
  });

  it("appends, reads by sequence and from a point, and deduplicates by message id", async () => {
    const box = state.streams("MESH_INBOX_<agent>").member("AGENT1");
    expect(await box.info()).toBeNull();
    await box.create({ subjects: ["mesh.agent.AGENT1.inbox"], maxAgeMs: 7 * 86_400_000, maxBytes: 1_000_000, discard: "old", silent: true });
    const s1 = await box.append("mesh.agent.AGENT1.inbox", te.encode("m1"), { msgId: "id-1" });
    const s2 = await box.append("mesh.agent.AGENT1.inbox", te.encode("m2"));
    const dup = await box.append("mesh.agent.AGENT1.inbox", te.encode("m1 again"), { msgId: "id-1" });
    expect([s1, s2, dup]).toEqual([1, 2, 1]);
    expect(td.decode((await box.read(2)).data)).toBe("m2");
    await expect(box.read(9)).rejects.toThrow(/no message found/);
    const from = [];
    for await (const m of box.readFrom(1, { max: 10, waitMs: 1000 })) from.push(td.decode(m.data));
    expect(from).toEqual(["m1", "m2"]);
    const info = await box.info();
    expect(info).toMatchObject({ messages: 2, firstSeq: 1, lastSeq: 2, subjects: ["mesh.agent.AGENT1.inbox"], repairs: [] });
    expect(info!.lastAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const listed = [];
    for await (const s of state.streams("MESH_INBOX_<agent>").list()) listed.push(s.id);
    expect(listed).toEqual(["AGENT1"]);
  });

  it("applies its limits: drop the oldest, or refuse the new", async () => {
    const old = state.streams("rooms_<room>").member("r1");
    await old.create({ subjects: ["mesh.aclroom.r1.*"], maxMsgs: 2, discard: "old" });
    for (const m of ["a", "b", "c"]) await old.append("mesh.aclroom.r1.x", te.encode(m));
    expect(await old.info()).toMatchObject({ messages: 2, firstSeq: 2, lastSeq: 3 });

    const full = state.streams("rooms_<room>").member("r2");
    await full.create({ subjects: ["mesh.aclroom.r2.*"], maxMsgs: 1, discard: "new" });
    await full.append("mesh.aclroom.r2.x", te.encode("a"));
    await expect(full.append("mesh.aclroom.r2.x", te.encode("b"))).rejects.toThrow(/maximum messages/);

    const bytes = state.streams("rooms_<room>").member("r3");
    await bytes.create({ subjects: ["mesh.aclroom.r3.*"], maxBytes: 10, discard: "old" });
    for (const m of ["aaaa", "bbbb", "cccc"]) await bytes.append("mesh.aclroom.r3.x", te.encode(m));
    expect(await bytes.info()).toMatchObject({ messages: 2, bytes: 8, firstSeq: 2 });
  });

  it("removes one message, purges, and destroys", async () => {
    const box = state.streams("MESH_INBOX_<agent>").member("A2");
    await box.create({ subjects: ["mesh.agent.A2.inbox"], discard: "old" });
    for (const m of ["a", "b", "c"]) await box.append("mesh.agent.A2.inbox", te.encode(m));
    await box.removeMessage(2);
    await expect(box.removeMessage(2)).rejects.toThrow(/no message found/);
    expect((await box.info())!.messages).toBe(2);
    await box.purge();
    expect(await box.info()).toMatchObject({ messages: 0, lastSeq: 3, firstSeq: 4 });
    await box.destroy();
    expect(await box.info()).toBeNull();
  });

  it("hands a durable consumer each message until acknowledged, and resumes it", async () => {
    const events = state.stream("MESH_EVENTS");
    expect(await events.ensure()).toBe(true);
    expect((await events.info())!.subjects).toEqual(["mesh.event.>"]);
    await events.append("mesh.event.a.one", te.encode("1"));
    await events.append("mesh.event.metering.usage", te.encode("u1"));
    await events.append("mesh.event.a.two", te.encode("2"));

    const c = await events.consume("fold", { filter: "mesh.event.metering.usage" });
    const it = c[Symbol.asyncIterator]();
    const [d1] = await take(it, 1);
    expect(td.decode(d1!.data)).toBe("u1");
    d1!.nak(50); // asked for again after a delay
    const [again] = await take(it, 1);
    expect(again!.seq).toBe(d1!.seq);
    again!.ack();
    await events.append("mesh.event.metering.usage", te.encode("u2"));
    const [d2] = await take(it, 1);
    expect(td.decode(d2!.data)).toBe("u2");
    expect(await events.consumerState("fold")).toMatchObject({ ackPending: 1, pending: 0 });
    await c.close();

    // A new process: the unacknowledged one comes again, the acknowledged one does not.
    const c2 = await events.consume("fold", { filter: "mesh.event.metering.usage" });
    const [r] = await take(c2[Symbol.asyncIterator](), 1);
    expect(td.decode(r!.data)).toBe("u2");
    r!.ack();
    await sleep(50);
    await c2.close();
    expect(await events.consumerState("fold")).toMatchObject({ pending: 0, ackPending: 0, ackFloor: 4 });
  });

  it("ends a consumer when its stream is removed", async () => {
    const box = state.streams("MESH_INBOX_<agent>").member("A3");
    await box.create({ subjects: ["mesh.agent.A3.inbox"], discard: "old" });
    const c = await box.consume("audit_witness", { from: "all" });
    const it = c[Symbol.asyncIterator]();
    const done = (async () => {
      const got: StreamDelivery[] = [];
      for (;;) {
        const r = await it.next();
        if (r.done) return got;
        got.push(r.value);
        r.value.ack();
      }
    })();
    await box.append("mesh.agent.A3.inbox", te.encode("x"));
    await sleep(100);
    await box.destroy();
    const got = await Promise.race([done, sleep(5000).then(() => null)]);
    expect(got?.length).toBe(1);
  });

  it("tells its hooks when subjects change", async () => {
    const seen: string[] = [];
    const hooked = new PostgresState(sql, {
      subjects: async (ref, subjects) => void seen.push(`${ref.name}=${subjects.join(",")}`),
      destroyed: async (ref) => void seen.push(`${ref.name} gone`),
    });
    const box = hooked.streams("MESH_INBOX_<agent>").member("A4");
    await box.create({ subjects: ["mesh.agent.A4.inbox"], discard: "old" });
    const info = await box.info();
    await box.reconfigure(info!, { subjects: ["mesh.agent.A4.inbox.guarded"] });
    await box.destroy();
    expect(seen).toEqual(["MESH_INBOX_A4=mesh.agent.A4.inbox", "MESH_INBOX_A4=mesh.agent.A4.inbox.guarded", "MESH_INBOX_A4 gone"]);
  });

  it("removes several messages at once and tells its hooks which, so the queue loses them too", async () => {
    const removed: string[][] = [];
    const hooked = new PostgresState(sql, {
      removed: async (_ref, messages) => void removed.push(messages.map((m) => td.decode(m))),
    });
    const box = hooked.streams("MESH_INBOX_<agent>").member("A5");
    await box.create({ subjects: ["mesh.agent.A5.inbox"], discard: "old" });
    for (const m of ["a", "b", "c", "d"]) await box.append("mesh.agent.A5.inbox", te.encode(m));
    expect(await box.removeMessages!([4, 3])).toBe(2);
    await box.removeMessage(1);
    expect((await box.info())!.messages).toBe(1);
    expect(removed.map((r) => [...r].sort())).toEqual([["c", "d"], ["a"]]);
    await box.destroy();
  });
});
