import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { UsageStore, deleteAgentUsage, dayKey } from "../../src/activity/usage-store.js";

/** The counters behind the published limits (plans.html): lifetime totals,
 *  per-day buckets, and delivered-on-your-behalf accounting. */
describe("UsageStore", () => {
  let dir: string;
  let store: UsageStore;

  function fresh(): UsageStore {
    dir = mkdtempSync(join(tmpdir(), "usage-"));
    store = new UsageStore(join(dir, "usage.db"));
    return store;
  }

  afterEach(async () => {
    try { await store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps lifetime totals with bytes", async () => {
    const s = fresh();
    s.recordIn("A", 100);
    s.recordIn("A", 50);
    s.recordOut("A", false, 200);
    s.recordOut("A", true, 10);
    await s.flush();
    const [a] = await s.list();
    expect(a.agent_id).toBe("A");
    expect(a.messages_in).toBe(2);
    expect(a.messages_out).toBe(2);
    expect(a.bytes_in).toBe(150);
    expect(a.bytes_out).toBe(210);
    expect(a.errors).toBe(1);
  });

  it("buckets today's traffic per agent per UTC day", async () => {
    const s = fresh();
    s.recordIn("A", 100);
    s.recordDelivered("B", 100); // B sent the message A received
    await s.flush();
    const [a] = await s.today(["A"]);
    expect(a.day).toBe(dayKey());
    expect(a.msgs_in).toBe(1);
    expect(a.bytes_in).toBe(100);
    const [b] = await s.today(["B"]);
    expect(b.delivered_msgs).toBe(1);
    expect(b.delivered_bytes).toBe(100);
    // An agent with no traffic today simply has no row.
    expect(await s.today(["C"])).toHaveLength(0);
  });

  it("counts bytes on every response but the message once per exchange", async () => {
    const s = fresh();
    s.recordOut("A", false, 100);   // first response: count + bytes
    s.recordOutBytes("A", 400);     // task-mode follow-ups: bytes only
    await s.flush();
    const [a] = await s.list();
    expect(a.messages_out).toBe(1);
    expect(a.bytes_out).toBe(500);
  });

  it("summary aggregates today and ranks top talkers by delivered bytes", async () => {
    const s = fresh();
    s.recordIn("quiet", 10);
    s.recordDelivered("loud", 5_000_000);
    s.recordDelivered("loud", 5_000_000);
    s.recordOut("loud", false, 1_000_000);
    await s.flush();
    const sum = await s.summary();
    expect(sum.today.day).toBe(dayKey());
    expect(sum.today.active_agents).toBe(2);
    expect(sum.today.delivered_bytes).toBe(10_000_000);
    expect(sum.top[0].agent_id).toBe("loud");
    // delivered = delivered_bytes + bytes_out: what egress actually billed
    expect(sum.top[0].delivered_bytes).toBe(11_000_000);
  });

  it("survives reopening the database (older DBs gain byte columns)", async () => {
    const s = fresh();
    s.recordIn("A", 42);
    await s.close();
    const reopened = new UsageStore(join(dir, "usage.db"));
    const [a] = await reopened.list();
    expect(a.bytes_in).toBe(42);
    await reopened.close();
    store = new UsageStore(join(dir, "usage.db")); // for afterEach close
  });
});

/**
 * The 90-day bound on the daily counters.
 *
 * The prune used to sit at the BOTTOM of `flush()`, below the
 * `if (this.pending.size === 0) return` that fires when there is nothing to
 * write. So retention was conditional on traffic: a mesh with no messages took
 * the early return on every timer tick, never reached the DELETE, and kept daily
 * rows forever — on exactly the quiet deployment where nothing else would trim
 * them either. These tests pin that the prune runs off the timer, not off the
 * traffic, and that hoisting it did not turn a once-a-day DELETE into one every
 * five seconds.
 */
describe("pruning the daily counters at 90 days", () => {
  let dir: string;
  let path: string;
  const open: UsageStore[] = [];

  function fresh(): UsageStore {
    dir ??= mkdtempSync(join(tmpdir(), "usage-prune-"));
    path = join(dir, "usage.db");
    const s = new UsageStore(path);
    open.push(s);
    return s;
  }

  /** A daily row for an arbitrary day — flush() can only write today's. */
  function seedDay(agentId: string, day: string): void {
    const db = new Database(path);
    db.prepare("INSERT INTO agent_stats_daily (agent_id, day, msgs_in) VALUES (?, ?, 3)").run(agentId, day);
    db.close();
  }

  /** Days present in the table, read straight from the file: `today()` only
   *  answers for today and `summary()` caps its window at 90 days, so neither
   *  can see whether an older row is still there. */
  function daysOnDisk(): string[] {
    const db = new Database(path);
    const rows = db.prepare("SELECT day FROM agent_stats_daily ORDER BY day").all() as Array<{ day: string }>;
    db.close();
    return rows.map((r) => r.day);
  }

  const daysAgo = (n: number) => dayKey(Date.now() - n * 86_400_000);

  afterEach(async () => {
    for (const s of open.splice(0)) {
      try { await s.close(); } catch { /* already closed */ }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined as unknown as string;
  });

  it("prunes on a flush with nothing pending — a quiet mesh still expires rows", async () => {
    const s = fresh();
    seedDay("A", daysAgo(200));
    seedDay("A", daysAgo(91));
    seedDay("A", daysAgo(89));
    expect(daysOnDisk()).toHaveLength(3);

    // No traffic at all. This is every tick of the flush timer on an idle mesh,
    // and it is the call that used to return before reaching the DELETE.
    expect((s as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
    await s.flush();

    expect(daysOnDisk()).toEqual([daysAgo(89)]);
  });

  it("keeps rows inside the window, and takes the ones outside it, on the same flush", async () => {
    const s = fresh();
    seedDay("A", daysAgo(120));
    seedDay("B", daysAgo(10));
    s.recordIn("C", 100); // and today's traffic still lands
    await s.flush();

    expect(daysOnDisk()).toEqual([daysAgo(10), dayKey()]);
    expect((await s.today(["C"]))[0].msgs_in).toBe(1);
  });

  it("prunes at most once per UTC day, not on every flush", async () => {
    // The guard that keeps this off the hot path. Hoisting the prune above the
    // early return means flush() reaches it every FLUSH_INTERVAL_MS; if that
    // also meant a DELETE every time, the fix would have traded unbounded
    // retention for a scan of the table every five seconds.
    const s = fresh();
    seedDay("A", daysAgo(200));
    await s.flush();
    expect(daysOnDisk()).toEqual([]);

    seedDay("A", daysAgo(300)); // arrives after today's prune already ran
    await s.flush();
    await s.flush();
    expect(daysOnDisk()).toEqual([daysAgo(300)]); // waits for tomorrow's pass
  });

  it("prunes even when the only calls are reads", async () => {
    // list()/today()/summary() all flush to serve fresh numbers, so they reach
    // the prune too. On a mesh whose only activity is an operator looking at the
    // console, that is the whole enforcement path.
    const s = fresh();
    seedDay("A", daysAgo(365));
    await s.list();
    expect(daysOnDisk()).toEqual([]);
  });
});

/**
 * The erasure path — safety register 6.6.
 *
 * The daily counters expire after 90 days; the lifetime row beside them had no
 * age limit and no way out at all, so a closed account's totals stayed forever
 * and EXT-2 §8 ("account deletion purges usage records") was unimplemented.
 * These tests pin the delete path an account-closure cascade calls.
 */
describe("deleting one agent's usage stats", () => {
  let dir: string;
  let path: string;
  const open: UsageStore[] = [];

  function fresh(): UsageStore {
    dir ??= mkdtempSync(join(tmpdir(), "usage-del-"));
    path = join(dir, "usage.db");
    const s = new UsageStore(path);
    open.push(s);
    return s;
  }

  /** A daily row for a day other than today, which flush() cannot write. */
  function seedDay(agentId: string, day: string): void {
    const db = new Database(path);
    db.prepare(
      "INSERT INTO agent_stats_daily (agent_id, day, msgs_in) VALUES (?, ?, 7)",
    ).run(agentId, day);
    db.close();
  }

  afterEach(async () => {
    for (const s of open.splice(0)) {
      try { await s.close(); } catch { /* already closed */ }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined as unknown as string;
  });

  it("removes the lifetime row and every daily row, and leaves other agents alone", async () => {
    const s = fresh();
    s.recordIn("GOING", 100);
    s.recordOut("GOING", false, 100);
    s.recordIn("STAYING", 50);
    await s.flush();
    seedDay("GOING", "2026-01-01");
    seedDay("GOING", "2026-01-02");

    const removed = await s.deleteAgent("GOING");
    expect(removed).toEqual({ lifetime: 1, daily: 3 }); // today + the two seeded

    expect((await s.list()).map((a) => a.agent_id)).toEqual(["STAYING"]);
    expect(await s.today(["GOING"])).toHaveLength(0);
    expect(await s.today(["STAYING"])).toHaveLength(1);
  });

  it("drops un-flushed counters too, so the next flush does not write the row back", async () => {
    const s = fresh();
    s.recordIn("GOING", 100);
    await s.flush();
    s.recordIn("GOING", 100); // in memory, not yet on disk

    await s.deleteAgent("GOING");
    await s.flush(); // the resurrection this guards against

    expect(await s.list()).toHaveLength(0);
    expect(await s.today(["GOING"])).toHaveLength(0);
  });

  it("is idempotent and safe for an agent that was never seen", async () => {
    const s = fresh();
    s.recordIn("A", 1);
    await s.flush();
    expect(await s.deleteAgent("NEVER-HEARD-OF")).toEqual({ lifetime: 0, daily: 0 });
    expect(await s.deleteAgent("A")).toEqual({ lifetime: 1, daily: 1 });
    expect(await s.deleteAgent("A")).toEqual({ lifetime: 0, daily: 0 });
  });

  it("deleteAgentUsage works over the database file, for a caller in another process", async () => {
    // The account-closure cascade runs in the API gateway, which has no handle on
    // the live UsageStore. It gets a plain function over the file instead.
    const s = fresh();
    s.recordIn("GOING", 100);
    s.recordIn("STAYING", 100);
    await s.flush();

    expect(await deleteAgentUsage("GOING", path)).toEqual({ lifetime: 1, daily: 1 });

    // Gone for the still-open service too, not just for the connection that
    // deleted it — and still gone after everything closes and reopens.
    expect((await s.list()).map((a) => a.agent_id)).toEqual(["STAYING"]);
    await s.close();
    const reopened = fresh();
    expect((await reopened.list()).map((a) => a.agent_id)).toEqual(["STAYING"]);
  });

  it("leaves no readable trace of the agent id in the database file", async () => {
    // The SQLite counterpart of purge-rather-than-soft-delete: secure_delete
    // zeroes the freed pages and deleteAgent checkpoints the WAL, so the row is
    // gone from the file rather than merely unreachable by query.
    const s = fresh();
    s.recordIn("UNIQUEAGENTIDTOFIND", 100);
    await s.flush();
    await s.deleteAgent("UNIQUEAGENTIDTOFIND");
    await s.close();

    const bytes = readFileSync(path);
    expect(bytes.includes(Buffer.from("UNIQUEAGENTIDTOFIND"))).toBe(false);
    const wal = join(dir, "usage.db-wal");
    if (existsSync(wal)) {
      expect(readFileSync(wal).includes(Buffer.from("UNIQUEAGENTIDTOFIND"))).toBe(false);
    }
  });
});
