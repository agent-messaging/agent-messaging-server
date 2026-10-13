import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";

/**
 * Scheduled work for the mesh: ONE mechanism, in-process, guarded by a
 * JetStream KV lease.
 *
 * The reasoning is in docs/operator-obligations.md ("Where the scheduled work
 * runs"). Short version: no cron, no systemd timer, no Kubernetes CronJob, no
 * Compose sidecar, and specifically NOT pm2 `cron_restart` — restarting a
 * service to make it do work conflates supervision with scheduling and drops
 * every live connection to do a job that does not need them. The same code has
 * to be correct at one instance under pm2 and at five replicas behind a load
 * balancer, and a self-hoster should install nothing extra to get it.
 *
 * The lease is the only coordination: before running a job a replica tries to
 * `create` its lease key, which is atomic in JetStream KV (create fails if a
 * live value is there). One replica wins, runs, and renews while it works; the
 * others see the failure and skip. The mesh already requires JetStream, so
 * this adds no dependency.
 */

/** Structural view of the bucket methods a lease needs, in JetStream's shape.
 *  Narrow on purpose: a JetStream bucket satisfies it, and a unit test can
 *  supply a Map-backed fake without pretending to implement watch/history/
 *  status. The lease reaches it through the storage layer (`keyedOf`), and a
 *  keyed store from any binding works as well. */
export interface LeaseKv {
  create(k: string, data: string): Promise<number>;
  update(k: string, data: string, version: number): Promise<number>;
  get(k: string): Promise<{ value: Uint8Array; revision: number; json<T>(): T } | null>;
  delete(k: string, opts?: { previousSeq: number }): Promise<void>;
}

interface LeaseValue {
  holder: string;
  acquired_at: string;
  expires_at: string;
}

/**
 * A single-holder lease over one KV key.
 *
 * Expiry is written INTO THE VALUE and checked by the code, not delegated to a
 * bucket `max_age`. Two reasons, both learned here already:
 *
 *  - nats.js has no per-key TTL in 2.x, so a bucket-level `max_age` is the only
 *    broker-side option, and it would apply equally to the run records that
 *    have to OUTLIVE the lease (see Scheduler: `.last` keys are the durable
 *    record of when a job last ran, and the obligations endpoint reads them).
 *  - `ensureKvBucket` only sets `max_age` when it CREATES the stream, so a
 *    bucket that already exists silently keeps whatever it was made with. The
 *    operator session store hit exactly this and settled on the same answer:
 *    the code decides, not the bucket config (see api/operator.ts
 *    sessionBucket()).
 *
 * So a crashed holder does not block the job forever: the next claimant reads
 * the expired value and takes it over with a revision-checked `update`, which
 * is atomic in the same way `create` is — of several replicas trying to steal
 * the same dead lease, exactly one update lands on that revision and the rest
 * fail.
 */
export class KvLease {
  /** Revision we last wrote. `null` = we do not hold the lease. */
  private revision: number | null = null;
  private kv: KeyedStore;

  constructor(
    kv: LeaseKv | KeyedStore,
    private key: string,
    private holder: string,
    private ttlMs: number,
  ) {
    this.kv = keyedOf(kv as KeyedLike);
  }

  get held(): boolean {
    return this.revision !== null;
  }

  private value(acquiredAt = new Date().toISOString()): string {
    return JSON.stringify({
      holder: this.holder,
      acquired_at: acquiredAt,
      expires_at: new Date(Date.now() + this.ttlMs).toISOString(),
    } satisfies LeaseValue);
  }

  /** True if we now hold the lease. False means somebody else does — which is
   *  the ordinary, expected outcome on every replica but one. */
  async acquire(): Promise<boolean> {
    try {
      this.revision = await this.kv.create(this.key, this.value());
      return true;
    } catch {
      // `create` fails when a live value is present. Either the holder is alive
      // (skip) or it died mid-job and left the value behind (take it over).
    }
    let entry: Awaited<ReturnType<KeyedStore["get"]>>;
    try {
      entry = await this.kv.get(this.key);
    } catch {
      return false; // KV unreachable; try again next tick
    }
    if (!entry || !entry.value.length) return false;
    let current: LeaseValue | null = null;
    try { current = entry.json<LeaseValue>(); } catch { /* unreadable */ }
    // An unreadable or expiry-less value is treated as EXPIRED. The only values
    // like that would be corrupt or written by an older shape, and stalling a
    // scheduled job forever on one bad key is the worse failure.
    const expires = Date.parse(current?.expires_at ?? "");
    if (Number.isFinite(expires) && expires > Date.now()) return false; // live holder
    try {
      this.revision = await this.kv.update(this.key, this.value(), entry.revision);
      console.log(
        `[sched] took over expired lease ${this.key} from ${current?.holder ?? "an unreadable value"}` +
        (Number.isFinite(expires) ? ` (expired ${new Date(expires).toISOString()})` : ""),
      );
      return true;
    } catch {
      return false; // another replica stole it first — its update took the revision
    }
  }

  /** Push the expiry out. False means we LOST the lease (someone stole it
   *  because we were slow, or the KV rejected us) and must stop pretending to
   *  hold it. */
  async renew(): Promise<boolean> {
    if (this.revision === null) return false;
    try {
      this.revision = await this.kv.update(this.key, this.value(), this.revision);
      return true;
    } catch {
      this.revision = null;
      return false;
    }
  }

  /** Give the lease up. Revision-checked, so a lease that was already taken
   *  over by another replica is NOT deleted out from under it. */
  async release(): Promise<void> {
    const rev = this.revision;
    this.revision = null;
    if (rev === null) return;
    try {
      await this.kv.delete(this.key, { previousRevision: rev });
    } catch {
      // Already gone, or no longer ours. Either way the expiry covers it.
    }
  }
}

export interface ScheduledJob {
  /** KV-key-safe: letters, digits, dash, underscore. */
  name: string;
  /** How often the job should run, mesh-wide (not per replica). */
  intervalMs: number;
  /** How long a claim survives an unannounced death of the holder. Renewed at
   *  a third of this while the job runs, so two consecutive renewal failures
   *  are needed before another replica can take over. */
  leaseTtlMs?: number;
  /** Run at a WALL-CLOCK time instead of "every intervalMs".
   *
   *  An interval alone cannot hold a time of day. A 24h job fires 24h after it
   *  last fired, so its hour is whatever hour it happened to start on and it
   *  drifts forward by however long each run took — the daily digest settled on
   *  14:02 UTC purely because that was when the feature first shipped. A
   *  summary meant to be read with morning coffee has to name the hour it
   *  wants.
   *
   *  Named as a zone, not an offset, so the hour survives daylight saving:
   *  06:00 America/Denver is 12:00 UTC in summer and 13:00 UTC in winter, and
   *  an operator who asked for 6am means 6am in both. */
  dailyAt?: { hour: number; minute?: number; tz: string };
  run: () => Promise<void>;
}

/** The most recent moment `hour:minute` occurred in `tz`, as epoch ms.
 *
 *  Wall-clock arithmetic without a timezone library: format the instant IN the
 *  target zone to learn that zone's current offset, then apply the offset to
 *  the target wall-clock time. `sv-SE` is used because its locale format is
 *  ISO-shaped (`2026-08-01 06:00:00`), which parses without reconstruction.
 *
 *  DST: the offset is sampled at `now`, so on the two days a year the offset
 *  changes between the target hour and now, the computed instant can be off by
 *  the shift. The consequence for a daily job is that it runs an hour early or
 *  late twice a year, which is the correct thing to accept rather than pull in
 *  a timezone library for. */
export function lastDailyOccurrence(
  hour: number,
  minute: number,
  tz: string,
  now: Date = new Date(),
): number {
  const local = now.toLocaleString("sv-SE", { timeZone: tz }); // "YYYY-MM-DD HH:mm:ss"
  const offsetMs = Date.parse(`${local.replace(" ", "T")}Z`) - now.getTime();
  const day = local.slice(0, 10);
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const todayAt = Date.parse(`${day}T${hh}:${mm}:00Z`) - offsetMs;
  // Before today's target time, the most recent occurrence was yesterday's.
  return todayAt <= now.getTime() ? todayAt : todayAt - 24 * 3600_000;
}

/** Durable record of a job's last attempt. Kept after the lease is released:
 *  it is what makes the interval mesh-wide instead of per-replica, and the
 *  obligations endpoint reads it to show when work last happened. */
export interface JobRunRecord {
  at: string;
  ok: boolean;
  duration_ms: number;
  holder: string;
  error?: string;
}

const TICK_MS = 60_000;
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
export const SCHED_BUCKET = "mesh_sched";

export class Scheduler {
  private jobs: ScheduledJob[] = [];
  private kv: KeyedStore | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  /** Jobs this replica has in flight, so a long job is not started twice by
   *  our own next tick even if the lease somehow allowed it. */
  private inFlight = new Set<string>();
  /** Who we are, in logs and in the lease value. Host + pid identifies the
   *  replica; the random tail keeps two containers with the same hostname and
   *  pid (which happens) from looking like one holder. */
  private readonly holder = `${hostname()}/${process.pid}/${randomBytes(3).toString("hex")}`;

  constructor(private js: StorageLike) {}

  register(job: ScheduledJob): void {
    if (!/^[a-z0-9_-]{1,48}$/.test(job.name)) throw new Error(`[sched] bad job name '${job.name}'`);
    if (this.jobs.some((j) => j.name === job.name)) throw new Error(`[sched] job '${job.name}' already registered`);
    this.jobs.push(job);
  }

  /** Open the lease bucket, once. Called from `start()` and again at the top of
   *  every tick, so a broker that was unreachable at boot does not leave the
   *  scheduler permanently inert — it just misses ticks until KV answers. */
  private async ensureKv(): Promise<KeyedStore | null> {
    if (this.kv) return this.kv;
    try {
      // No bucket `ttl`: see KvLease. History 2 is enough to read a value and
      // update it on its revision (storage/catalog.ts).
      this.kv = await storageOf(this.js).keyed(SCHED_BUCKET);
    } catch (e) {
      console.warn(`[sched] lease bucket unavailable: ${e instanceof Error ? e.message : e}`);
      return null;
    }
    return this.kv;
  }

  async start(): Promise<void> {
    if (!this.jobs.length) return;
    await this.ensureKv();
    // Jitter the first tick. Replicas usually start together (a rolling
    // deploy, a node coming back), and without this they all reach the same
    // `create` in the same millisecond every minute — which works, but makes
    // every log line a contention story and wastes a round trip per replica.
    const delay = Math.floor(Math.random() * TICK_MS);
    setTimeout(() => {
      if (this.stopped) return;
      void this.tick();
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref?.();
    }, delay).unref?.();
    console.log(
      `[sched] ${this.jobs.length} job(s) registered as ${this.holder}: ` +
      this.jobs.map((j) => `${j.name} every ${Math.round(j.intervalMs / 60_000)}m`).join(", ") +
      ` (first tick in ${Math.round(delay / 1000)}s)`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Registered job names. The obligations endpoint reports on jobs that
   *  actually exist rather than on a hardcoded list of work we hope happens. */
  jobNames(): string[] {
    return this.jobs.map((j) => j.name);
  }

  /** Registered jobs with their intervals, so a reader can tell "has not run
   *  yet" from "is overdue". A job whose interval has not elapsed since this
   *  process started has not had a fair chance, and reporting it as owed would
   *  make every fresh deploy look like it had a backlog. */
  jobSchedule(): Array<{ name: string; intervalMs: number }> {
    return this.jobs.map((j) => ({ name: j.name, intervalMs: j.intervalMs }));
  }

  /** How long this scheduler has been ticking. */
  get uptimeMs(): number {
    return Date.now() - this.bootAt;
  }

  private readonly bootAt = Date.now();

  /** Read a job's last run. Public so the obligations endpoint can report
   *  staleness of scheduled work without duplicating the key layout. */
  async lastRun(name: string): Promise<JobRunRecord | null> {
    if (!this.kv) return null;
    try {
      const entry = await this.kv.get(`sched.${name}.last`);
      if (!entry?.value.length) return null;
      return entry.json<JobRunRecord>();
    } catch { return null; }
  }

  /** One pass over the registered jobs. Public for the same reason
   *  `Reaper.sweep()` is: a test drives the logic directly rather than starting
   *  a timer and waiting on wall-clock minutes. */
  async tick(): Promise<void> {
    // A tick that overruns the interval must not start a second pass. The
    // whole point of the lease is one runner, and racing ourselves is the
    // easiest way to look like two replicas.
    if (this.ticking || this.stopped) return;
    if (!(await this.ensureKv())) return;
    this.ticking = true;
    try {
      for (const job of this.jobs) {
        // Sequential, and each job is individually guarded: one job throwing
        // must not stop the ones after it, and must not stop the LOOP. A
        // scheduler that dies on its first bad job is worse than no scheduler,
        // because the jobs that did work go quiet without anybody noticing.
        try {
          await this.maybeRun(job);
        } catch (e) {
          console.error(`[sched] ${job.name}: scheduling error (not the job): ${e instanceof Error ? e.message : e}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async maybeRun(job: ScheduledJob): Promise<void> {
    if (!this.kv || this.inFlight.has(job.name)) return;

    // Is it due? Asked of the DURABLE record, not of local state: with local
    // state each replica counts the interval from its own boot, so five
    // replicas run the job five times per interval. The record is written by
    // whoever ran it last, wherever that was.
    const last = await this.lastRun(job.name);
    if (job.dailyAt) {
      // Wall-clock jobs are due when today's target time has passed and the
      // durable record shows the last run was before it. Asked of the record
      // for the same reason the interval is: whoever ran it last may have been
      // another replica, or this process may have restarted since.
      //
      // A missed day is NOT made up for. If the process was down at 06:00, the
      // next run is tomorrow at 06:00 — firing a "daily summary" at 15:00
      // because it was owed one delivers yesterday's news at the wrong time and
      // trains the reader to distrust the timestamp.
      const due = lastDailyOccurrence(job.dailyAt.hour, job.dailyAt.minute ?? 0, job.dailyAt.tz);
      if (last) {
        const ranAt = Date.parse(last.at);
        if (Number.isFinite(ranAt) && ranAt >= due) return;
      }
    } else if (last) {
      const since = Date.now() - Date.parse(last.at);
      if (Number.isFinite(since) && since < job.intervalMs) return;
    }

    const ttl = job.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    const lease = new KvLease(this.kv, `sched.${job.name}.lease`, this.holder, ttl);
    if (!(await lease.acquire())) return;

    this.inFlight.add(job.name);
    // A job that outruns its lease has to keep the lease alive while it works;
    // otherwise a slow-but-healthy run looks exactly like a dead holder and a
    // second replica starts the same job. Renew at a third of the TTL.
    const renew = setInterval(() => {
      void lease.renew().then((ok) => {
        if (!ok) console.warn(`[sched] ${job.name}: LOST the lease mid-run — another replica may start it`);
      });
    }, Math.max(5_000, Math.floor(ttl / 3)));
    renew.unref?.();

    const started = Date.now();
    const at = () => new Date().toISOString();
    let record: JobRunRecord;
    try {
      await job.run();
      record = { at: at(), ok: true, duration_ms: Date.now() - started, holder: this.holder };
      console.log(`[sched] ${job.name}: ok in ${record.duration_ms}ms`);
    } catch (e) {
      // A job that throws must not kill the loop or poison the lease: record
      // it, release, carry on. This catch is the only reason a single bad job
      // cannot silence every other job in the process.
      const error = e instanceof Error ? e.message : String(e);
      record = { at: at(), ok: false, duration_ms: Date.now() - started, holder: this.holder, error };
      console.error(`[sched] ${job.name}: FAILED after ${record.duration_ms}ms: ${error}`);
    }
    clearInterval(renew);
    this.inFlight.delete(job.name);
    // Record the ATTEMPT, pass or fail, before releasing. A job that throws
    // every time otherwise retries on every single tick forever, which turns
    // one broken job into a log flood and (for anything that talks to the
    // network) a self-inflicted load test.
    try {
      await this.kv.put(`sched.${job.name}.last`, JSON.stringify(record));
    } catch (e) {
      console.warn(`[sched] ${job.name}: could not record the run: ${e instanceof Error ? e.message : e}`);
    }
    // Always release, including after a throw. A poisoned lease would stall the
    // job until the TTL expired on every subsequent attempt.
    await lease.release();
  }
}
