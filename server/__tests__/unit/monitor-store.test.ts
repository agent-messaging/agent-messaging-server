// The Monitor's storage (monitor-types.ts): hourly pair and compute rows, the
// exceptions log, alarms, retention and erasure, on the real SQLite backend.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore } from "../../src/activity/usage-store.js";
import {
  LAT_BUCKETS, PAIR_OTHER, MAX_EVENTS_PER_AGENT_HOUR, bucketOf, emptyPair, hourKey, quantileMs,
} from "../../src/activity/monitor-types.js";
import { tapOutcome, unansweredReason } from "../../src/activity/monitor-classify.js";

const A = "A".repeat(56), B = "B".repeat(56), C = "C".repeat(56);
let dir = "";
const open: UsageStore[] = [];
function store(): UsageStore {
  dir ||= mkdtempSync(join(tmpdir(), "monitor-"));
  const s = new UsageStore({ url: "", dbPath: join(dir, "usage.db") });
  open.push(s);
  return s;
}
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => {});
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("pair hours", () => {
  it("counts messages, outcomes and delivery times per sender and receiver, and keeps no message", async () => {
    const s = store();
    const now = Date.now();
    s.recordPair(A, B, { msgs: 1 }, now);
    s.recordPair(A, B, { msgs: 1 }, now);
    s.recordPair(A, B, { delivered: 1, latMs: 300 }, now);
    s.recordPair(A, B, { failed: 1, latMs: 9_000 }, now);
    s.recordPair(C, B, { msgs: 1, held: 1 }, now);
    const r = await s.monitorRead([B], hourKey(now - 3_600_000));
    const ab = r.pairs.find((p) => p.sender_id === A)!;
    expect(ab).toMatchObject({ msgs: 2, delivered: 1, failed: 1, lat_n: 2 });
    expect(ab.h[bucketOf(300)]).toBe(1);
    expect(ab.h[bucketOf(9_000)]).toBe(1);
    expect(r.pairs.find((p) => p.sender_id === C)!.held).toBe(1);
    expect(Object.keys(ab)).not.toContain("text");
  });

  it("two stores on one file add, never replace (the activity service and the API both write)", async () => {
    const s1 = store(), s2 = store();
    const now = Date.now();
    s1.recordPair(A, B, { msgs: 2 }, now);
    s2.recordPair(A, B, { msgs: 3, passed: 3 }, now);
    await s1.flush(); await s2.flush();
    const r = await s1.monitorRead([A], hourKey(now));
    expect(r.pairs[0]).toMatchObject({ msgs: 5, passed: 3 });
  });

  it("folds senders past the cap into ~other for that receiver and hour", async () => {
    const s = store();
    const now = Date.now();
    const senders = Array.from({ length: 205 }, (_, i) => `S${String(i).padStart(55, "0")}`);
    for (const x of senders) s.recordPair(x, B, { msgs: 1 }, now);
    const r = await s.monitorRead([B], hourKey(now));
    const other = r.pairs.find((p) => p.sender_id === PAIR_OTHER);
    expect(r.pairs.filter((p) => p.sender_id !== PAIR_OTHER)).toHaveLength(200);
    expect(other?.msgs).toBe(5);
  });
});

describe("compute hours", () => {
  it("sums jobs and spend under the sending agent and keeps the largest memory peak", async () => {
    const s = store();
    const now = Date.now();
    s.recordCompute(A, B, { jobs: 1, job_ms: 4_000, mem_mb: 300, tokens_in: 100, tokens_out: 20, cost_micros: 1500 }, now);
    s.recordCompute(A, B, { jobs: 1, job_ms: 6_000, mem_mb: 200, failed: 1 }, now);
    s.recordCompute(A, C, { jobs: 1, job_ms: 1_000 }, now);
    // Read for C's owner alone: only the jobs C sent to A.
    const mine = await s.monitorRead([C], hourKey(now));
    expect(mine.compute).toHaveLength(1);
    expect(mine.compute[0]).toMatchObject({ payer: C, jobs: 1 });
    const owner = await s.monitorRead([A], hourKey(now));
    const one = owner.compute.find((c) => c.payer === B)!;
    expect(one).toMatchObject({ jobs: 2, job_ms: 10_000, failed: 1, mem_mb: 300, tokens_in: 100, cost_micros: 1500 });
  });
});

describe("the exceptions log", () => {
  it("keeps who, when, the outcome and a reason; a hold is open until decided once", async () => {
    const s = store();
    const id = s.recordEvent({ at: Date.now(), sender_id: A, receiver_id: B, outcome: "held", reason: "prompt injection, high confidence", ms: 400, account_id: "acct", message_id: "m1" })!;
    const [e] = await s.monitorEvents([B], 0);
    expect(e).toMatchObject({ id, outcome: "held", state: "open", message_id: "m1" });
    expect(await s.monitor.openHeld([B], 0)).toBe(1);
    expect(await s.monitor.decide(id, "released")).toBe(true);
    expect(await s.monitor.decide(id, "discarded")).toBe(false);
    expect((await s.monitor.event(id))!.state).toBe("released");
    expect(await s.monitor.openHeld([B], 0)).toBe(0);
  });

  it("shows a sender its failures and refusals, never the guard's verdicts at someone else's agent", async () => {
    const s = store();
    const at = Date.now();
    s.recordEvent({ at, sender_id: A, receiver_id: B, outcome: "held", reason: "x", ms: null, account_id: null, message_id: null });
    s.recordEvent({ at, sender_id: A, receiver_id: B, outcome: "refused", reason: "not admitted by its access rules", ms: null, account_id: null, message_id: null });
    s.recordEvent({ at, sender_id: A, receiver_id: B, outcome: "failed", reason: "no answer in time", ms: null, account_id: null, message_id: null });
    const seenBySender = await s.monitorEvents([A], 0);
    expect(seenBySender.map((e) => e.outcome).sort()).toEqual(["failed", "refused"]);
    expect((await s.monitorEvents([B], 0))).toHaveLength(3);
  });

  it("caps the log per receiving agent per hour", () => {
    const s = store();
    const at = Date.now();
    let kept = 0;
    for (let i = 0; i < MAX_EVENTS_PER_AGENT_HOUR + 5; i++) {
      if (s.recordEvent({ at, sender_id: A, receiver_id: B, outcome: "failed", reason: "r", ms: null, account_id: null, message_id: null })) kept++;
    }
    expect(kept).toBe(MAX_EVENTS_PER_AGENT_HOUR);
  });
});

describe("retention and erasure", () => {
  it("prunes hours and events older than 30 days", async () => {
    const s = store();
    const old = Date.now() - 31 * 86_400_000;
    s.recordPair(A, B, { msgs: 1 }, old);
    s.recordEvent({ at: old, sender_id: A, receiver_id: B, outcome: "failed", reason: "r", ms: null, account_id: null, message_id: null });
    s.recordPair(A, B, { msgs: 1 });
    await s.flush();
    const cutoff = Date.now() - 30 * 86_400_000;
    await s.monitor.prune(hourKey(cutoff), cutoff);
    const r = await s.monitorRead([A], "0000");
    expect(r.pairs).toHaveLength(1);
    expect(await s.monitorEvents([B], 0)).toHaveLength(0);
  });

  it("closing an agent forgets every monitor row naming it, pending ones too", async () => {
    const s = store();
    s.recordPair(A, B, { msgs: 1 });
    await s.flush();
    s.recordPair(B, A, { msgs: 1 });
    s.recordCompute(A, "acct", { jobs: 1 });
    s.recordEvent({ at: Date.now(), sender_id: C, receiver_id: A, outcome: "held", reason: "r", ms: null, account_id: "x", message_id: "m" });
    await s.deleteAgent(A);
    const r = await s.monitorRead([A, B, C], "0000");
    expect(r.pairs).toHaveLength(0);
    expect(r.compute).toHaveLength(0);
    expect(await s.monitorEvents([A], 0)).toHaveLength(0);
  });
});

describe("alarms", () => {
  it("stores an account's alarms and deletes only its own", async () => {
    const s = store();
    const base = { scope: "*", kind: "held" as const, threshold: null, created_at: 1, state: "OK" as const, value: 0, since: 1, emailed_at: 0 };
    await s.monitor.putAlarm({ ...base, id: "a1", account_id: "acct" });
    await s.monitor.putAlarm({ ...base, id: "a2", account_id: "other" });
    expect((await s.monitor.alarms("acct")).map((a) => a.id)).toEqual(["a1"]);
    expect(await s.monitor.deleteAlarm("a2", "acct")).toBe(false);
    await s.monitor.putAlarm({ ...base, id: "a1", account_id: "acct", state: "ALARM", value: 2 });
    expect((await s.monitor.alarms("acct"))[0]).toMatchObject({ state: "ALARM", value: 2 });
    expect((await s.monitor.alarms(null))).toHaveLength(2);
  });
});

describe("the words and the numbers", () => {
  it("reads a median and a slowest 5% off the histogram", () => {
    const h = emptyPair().h;
    h[bucketOf(400)] = 95; // 250 to 500 ms
    h[bucketOf(20_000)] = 5; // 15 to 30 s
    expect(quantileMs(h, 0.5)).toBeGreaterThan(250);
    expect(quantileMs(h, 0.5)).toBeLessThanOrEqual(500);
    expect(quantileMs(h, 0.99)).toBeGreaterThan(15_000);
    expect(quantileMs(new Array(LAT_BUCKETS).fill(0), 0.5)).toBeNull();
  });

  it("names an answer's outcome in words", () => {
    expect(tapOutcome(undefined)).toEqual({ outcome: "delivered" });
    expect(tapOutcome("UNAUTHORIZED")).toEqual({ outcome: "refused", reason: "not admitted by its access rules" });
    expect(tapOutcome("AGREEMENT_REQUIRED").outcome).toBe("refused");
    expect(tapOutcome("TRANSPORT_TIMEOUT")).toEqual({ outcome: "failed", reason: "no answer in time" });
    expect(tapOutcome("SOMETHING_NEW")).toEqual({ outcome: "failed", reason: "it answered with an error" });
    expect(unansweredReason(300_000)).toBe("no answer in 5 minutes");
  });
});

describe("the Postgres monitor tables (statement shape; no server here)", () => {
  it("adds every counter, keeps the largest memory peak, inserts an event once, all in one transaction", async () => {
    const { PostgresMonitorTables } = await import("../../src/activity/monitor-postgres.js");
    const sql: string[] = [];
    const q = async (text: string) => { sql.push(text.trim()); return { rows: [], rowCount: 0 }; };
    const pool = { query: q, connect: async () => ({ query: q, release: () => {} }) };
    const t = new PostgresMonitorTables(pool as never, Promise.resolve());
    const now = Date.now();
    await t.write(
      [{ hour: hourKey(now), sender_id: A, receiver_id: B, ...emptyPair(), msgs: 1 }],
      [{ hour: hourKey(now), agent_id: A, payer: "p", jobs: 1, job_ms: 1, failed: 0, mem_mb: 5, tokens_in: 0, tokens_out: 0, cost_micros: 0 }],
      [{ id: "e", at: now, sender_id: A, receiver_id: B, outcome: "failed", reason: "r", ms: null, account_id: null, message_id: null, state: "" }],
      200,
    );
    expect(sql[0]).toBe("BEGIN");
    expect(sql[sql.length - 1]).toBe("COMMIT");
    const pair = sql.find((s) => s.startsWith("INSERT INTO monitor_pair_hour"))!;
    for (const c of ["msgs", "delivered", "failed", "held", "lat_n", "h0", "h11"]) {
      expect(pair).toContain(`${c} = monitor_pair_hour.${c} + EXCLUDED.${c}`);
    }
    const compute = sql.find((s) => s.startsWith("INSERT INTO monitor_compute_hour"))!;
    expect(compute).toMatch(/mem_mb = GREATEST\(monitor_compute_hour\.mem_mb, EXCLUDED\.mem_mb\)/);
    expect(compute).toMatch(/jobs = monitor_compute_hour\.jobs \+ EXCLUDED\.jobs/);
    expect(sql.find((s) => s.startsWith("INSERT INTO monitor_events"))).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });
});
