import { describe, it, expect } from "vitest";
import type { JetStreamClient } from "nats";
import { KvLease, Scheduler, type LeaseKv } from "../../src/shared/scheduler.js";

/**
 * The lease is the only thing standing between "one replica runs this job" and
 * "five replicas rotate the credential pool at the same time". Everything below
 * defends one of the three properties the scheduler is required to have
 * (docs/operator-obligations.md, "Where the scheduled work runs"):
 *
 *   - two claimants, exactly one winner;
 *   - a crashed holder's lease expires and can be taken over;
 *   - a job that throws does not wedge the loop or poison the lease.
 */

/** A JetStream KV faithful in the ways that matter here: `create` fails when a
 *  live value exists, `update` fails unless you name the current revision, and
 *  every write bumps a monotonic revision. Those three are what make the lease
 *  atomic, so a fake that skipped them would prove nothing. */
function fakeKv() {
  let seq = 0;
  const store = new Map<string, { value: string; revision: number }>();
  const conflict = () => new Error("wrong last sequence");
  const kv = {
    store,
    async create(k: string, data: string): Promise<number> {
      if (store.has(k)) throw conflict();
      store.set(k, { value: String(data), revision: ++seq });
      return seq;
    },
    async update(k: string, data: string, version: number): Promise<number> {
      const cur = store.get(k);
      if (!cur || cur.revision !== version) throw conflict();
      store.set(k, { value: String(data), revision: ++seq });
      return seq;
    },
    async put(k: string, data: string): Promise<number> {
      store.set(k, { value: String(data), revision: ++seq });
      return seq;
    },
    async get(k: string) {
      const cur = store.get(k);
      if (!cur) return null;
      return {
        value: new TextEncoder().encode(cur.value),
        revision: cur.revision,
        json: <T>() => JSON.parse(cur.value) as T,
      };
    },
    async delete(k: string, opts?: { previousSeq: number }): Promise<void> {
      const cur = store.get(k);
      if (opts?.previousSeq !== undefined && cur && cur.revision !== opts.previousSeq) throw conflict();
      store.delete(k);
    },
  };
  return kv;
}

/** A JetStreamClient stub whose `views.kv` hands back one shared fake, so two
 *  Scheduler instances are two replicas against one bucket. */
function fakeJs(kv: ReturnType<typeof fakeKv>): JetStreamClient {
  return { views: { kv: async () => kv } } as unknown as JetStreamClient;
}

describe("KvLease", () => {
  it("gives the lease to exactly one of two concurrent claimants", async () => {
    const kv = fakeKv();
    const a = new KvLease(kv as unknown as LeaseKv, "sched.job.lease", "replica-a", 60_000);
    const b = new KvLease(kv as unknown as LeaseKv, "sched.job.lease", "replica-b", 60_000);

    const [gotA, gotB] = await Promise.all([a.acquire(), b.acquire()]);
    expect([gotA, gotB].filter(Boolean)).toHaveLength(1);
    expect(a.held).toBe(gotA);
    expect(b.held).toBe(gotB);
  });

  it("refuses a second claimant while the holder's lease is live", async () => {
    const kv = fakeKv();
    const a = new KvLease(kv as unknown as LeaseKv, "sched.job.lease", "a", 60_000);
    const b = new KvLease(kv as unknown as LeaseKv, "sched.job.lease", "b", 60_000);
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
  });

  it("lets a new claimant take over an EXPIRED lease — a crashed holder must not block the job forever", async () => {
    const kv = fakeKv();
    // ttl 0: the value is written already expired, which is what a holder that
    // died mid-job leaves behind once its TTL passes.
    const dead = new KvLease(kv as unknown as LeaseKv, "sched.job.lease", "crashed", 0);
    expect(await dead.acquire()).toBe(true);
    expect(kv.store.has("sched.job.lease")).toBe(true); // value still there

    const fresh = new KvLease(kv as unknown as LeaseKv, "sched.job.lease", "alive", 60_000);
    expect(await fresh.acquire()).toBe(true);
    expect(JSON.parse(kv.store.get("sched.job.lease")!.value).holder).toBe("alive");
  });

  it("gives an expired lease to only ONE of several would-be stealers", async () => {
    const kv = fakeKv();
    const dead = new KvLease(kv as unknown as LeaseKv, "sched.job.lease", "crashed", 0);
    await dead.acquire();
    const stealers = ["x", "y", "z"].map((n) => new KvLease(kv as unknown as LeaseKv, "sched.job.lease", n, 60_000));
    const results = await Promise.all(stealers.map((s) => s.acquire()));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("renews while working, and a renewal that lost the lease reports it", async () => {
    const kv = fakeKv();
    const a = new KvLease(kv as unknown as LeaseKv, "sched.job.lease", "a", 60_000);
    expect(await a.acquire()).toBe(true);
    const revAfterAcquire = kv.store.get("sched.job.lease")!.revision;
    expect(await a.renew()).toBe(true);
    expect(kv.store.get("sched.job.lease")!.revision).toBeGreaterThan(revAfterAcquire);

    // Somebody else takes it (as would happen if we outran our TTL); our next
    // renewal must fail rather than silently write over the new holder.
    await kv.put("sched.job.lease", JSON.stringify({ holder: "thief", expires_at: new Date(Date.now() + 60_000).toISOString() }));
    expect(await a.renew()).toBe(false);
    expect(a.held).toBe(false);
    expect(JSON.parse(kv.store.get("sched.job.lease")!.value).holder).toBe("thief");
  });

  it("releases only its own lease, never one that was taken over", async () => {
    const kv = fakeKv();
    const a = new KvLease(kv as unknown as LeaseKv, "sched.job.lease", "a", 60_000);
    await a.acquire();
    await a.release();
    expect(kv.store.has("sched.job.lease")).toBe(false);

    // Re-acquire, then let a "thief" write a newer revision. Releasing must not
    // delete the thief's lease out from under it.
    const b = new KvLease(kv as unknown as LeaseKv, "sched.job.lease", "b", 60_000);
    await b.acquire();
    await kv.put("sched.job.lease", JSON.stringify({ holder: "thief", expires_at: new Date(Date.now() + 60_000).toISOString() }));
    await b.release();
    expect(JSON.parse(kv.store.get("sched.job.lease")!.value).holder).toBe("thief");
  });

  it("treats an unreadable lease value as expired rather than stalling forever", async () => {
    const kv = fakeKv();
    await kv.put("sched.job.lease", "not json at all");
    const a = new KvLease(kv as unknown as LeaseKv, "sched.job.lease", "a", 60_000);
    expect(await a.acquire()).toBe(true);
  });
});

describe("Scheduler", () => {
  it("runs a due job once and releases the lease", async () => {
    const kv = fakeKv();
    const sched = new Scheduler(fakeJs(kv));
    let runs = 0;
    sched.register({ name: "job-a", intervalMs: 60_000, run: async () => { runs++; } });

    await sched.tick();
    expect(runs).toBe(1);
    expect(kv.store.has("sched.job-a.lease")).toBe(false); // released
    const rec = await sched.lastRun("job-a");
    expect(rec?.ok).toBe(true);
  });

  it("does not re-run before the interval, even from a different replica", async () => {
    const kv = fakeKv();
    let runs = 0;
    const run = async () => { runs++; };
    const one = new Scheduler(fakeJs(kv));
    const two = new Scheduler(fakeJs(kv));
    one.register({ name: "job-a", intervalMs: 60_000, run });
    two.register({ name: "job-a", intervalMs: 60_000, run });

    await one.tick();
    await two.tick();
    await one.tick();
    // The durable run record — not per-replica local state — is what makes the
    // interval mesh-wide. Without it five replicas run the job five times.
    expect(runs).toBe(1);
  });

  it("runs a job exactly once when two replicas tick at the same moment", async () => {
    const kv = fakeKv();
    let runs = 0;
    const run = async () => { runs++; await new Promise((r) => setTimeout(r, 5)); };
    const one = new Scheduler(fakeJs(kv));
    const two = new Scheduler(fakeJs(kv));
    one.register({ name: "job-a", intervalMs: 60_000, run });
    two.register({ name: "job-a", intervalMs: 60_000, run });

    await Promise.all([one.tick(), two.tick()]);
    expect(runs).toBe(1);
  });

  it("a throwing job does not wedge the loop: the lease is released, later jobs still run, and the next tick is not blocked", async () => {
    const kv = fakeKv();
    const sched = new Scheduler(fakeJs(kv));
    let bad = 0, good = 0;
    sched.register({ name: "bad", intervalMs: 0, run: async () => { bad++; throw new Error("boom"); } });
    sched.register({ name: "good", intervalMs: 0, run: async () => { good++; } });

    await sched.tick();
    // The job after the failing one still ran — a scheduler that dies on its
    // first bad job silently stops doing everything else.
    expect(bad).toBe(1);
    expect(good).toBe(1);
    // Not poisoned: no lease left behind for either job.
    expect(kv.store.has("sched.bad.lease")).toBe(false);
    expect(kv.store.has("sched.good.lease")).toBe(false);
    // The failure is recorded, so it is visible instead of merely logged.
    const rec = await sched.lastRun("bad");
    expect(rec?.ok).toBe(false);
    expect(rec?.error).toBe("boom");

    // And the loop is still alive: interval 0 means always due.
    await sched.tick();
    expect(bad).toBe(2);
    expect(good).toBe(2);
  });

  it("skips every job when the lease bucket is unreachable, rather than throwing", async () => {
    const js = { views: { kv: async () => { throw new Error("no jetstream"); } } } as unknown as JetStreamClient;
    const sched = new Scheduler(js);
    let runs = 0;
    sched.register({ name: "job-a", intervalMs: 0, run: async () => { runs++; } });
    await expect(sched.tick()).resolves.toBeUndefined();
    expect(runs).toBe(0);
  });

  it("refuses duplicate and malformed job names", () => {
    const sched = new Scheduler(fakeJs(fakeKv()));
    sched.register({ name: "job-a", intervalMs: 1, run: async () => {} });
    expect(() => sched.register({ name: "job-a", intervalMs: 1, run: async () => {} })).toThrow(/already registered/);
    expect(() => sched.register({ name: "Job A", intervalMs: 1, run: async () => {} })).toThrow(/bad job name/);
    expect(sched.jobNames()).toEqual(["job-a"]);
  });
});
