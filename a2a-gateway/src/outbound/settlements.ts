/**
 * The settlement queue: the durable half of getting paid.
 *
 * A priced call settles AFTER the work succeeded and off the request path,
 * because the answer already went back to the caller and retracting it is not
 * an option. That decision is right and stays. What was wrong is what came
 * with it: the charge was one un-awaited POST, and if the ledger was down for
 * the second it took, the charge was gone. No record that it had ever been
 * owed, nothing to retry it, nothing anywhere that could tell you it had
 * happened. The interface draft calls that the weakest point in the design and
 * it is the only place in the money path where value disappears silently.
 *
 * So the attempt is written down before it is made. The shape is the one the
 * attachment store already uses — a JSON file replaced atomically (write tmp,
 * rename) — because one host runs one bridge, these records are few and short
 * lived, and a file survives a restart without the bridge's mesh credential
 * needing JetStream permissions it does not have. No new dependency, no new
 * service, no broker.
 *
 * Three states, and every attempt ends in one of them:
 *
 *   pending    — written down, not yet accepted by the ledger. Retried on a
 *                timer with a widening gap, and again from disk on the next
 *                boot. This is the state a crash leaves behind, and it is why
 *                the file exists.
 *   settled    — the ledger took it. The record is dropped, because the ledger
 *                is now the one holding it and keeping a second copy forever
 *                only grows a file nobody reads.
 *   abandoned  — it will not succeed. Either the ledger refused it in a way
 *                repeating cannot fix, or it has been retried past the point
 *                where the next attempt is worth more than the operator
 *                knowing. The record STAYS, with the reason, and is served on
 *                the admin surface. A charge that can never be collected is a
 *                fact somebody has to be able to find.
 *
 * Retrying is safe because the transaction identifier is the work's identity
 * (attachment id + task id) and every binding is required to be idempotent on
 * it. A charge posted twice is applied once and reports so.
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type SettlementState = "pending" | "abandoned";

export interface SettlementAttempt {
  /** The ledger's idempotency key, and this record's own identity. */
  txnId: string;
  /** The charge body exactly as it will be posted. Stored whole so a retry
   *  after a restart does not have to reconstruct it from an attachment record
   *  that may have been repriced since. What was owed is what was owed. */
  body: Record<string, unknown>;
  /** Which attachment, for the operator reading a list of these. */
  label: string;
  state: SettlementState;
  attempts: number;
  firstAt: string;
  lastAt: string | null;
  /** Earliest the next attempt may run, as an ISO instant. */
  nextAt: string;
  /** What the last attempt got back. */
  lastError: string | null;
  /** Why this will never succeed. Set with, and only with, `abandoned`. */
  abandonedReason?: string;
}

/** First retry gap. Doubles per attempt up to the ceiling. */
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * How many times an unreachable ledger is retried before the attempt is
 * abandoned. Twelve attempts under the backoff above spans roughly half a day,
 * which is long enough to ride out a restart, a deploy or a network partition,
 * and short enough that an operator finds out the same day rather than reading
 * about it in a reconciliation months later.
 */
const MAX_ATTEMPTS = 12;

export function backoffFor(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

export class SettlementQueue {
  private records = new Map<string, SettlementAttempt>();
  private loaded = false;
  /** Writes are chained so two of them cannot interleave their tmp/rename. */
  private writing: Promise<void> = Promise.resolve();

  /** A null path keeps the queue in memory only. That is for a test or a boot
   *  with no store at all; a deployment that takes money passes a path, and
   *  without one the retry machinery still runs but does not outlive the
   *  process. */
  constructor(private readonly path: string | null) {}

  async load(): Promise<SettlementAttempt[]> {
    if (!this.loaded) {
      if (this.path) {
        try {
          const raw = await readFile(this.path, "utf8");
          for (const rec of JSON.parse(raw) as SettlementAttempt[]) this.records.set(rec.txnId, rec);
        } catch (err) {
          // No file yet is a normal first boot. A corrupt one is not, and it
          // is said out loud rather than silently starting from empty, because
          // starting from empty is exactly the loss this module exists to
          // prevent.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            console.error(`[bridge:credits] the settlement queue at ${this.path} could not be read:`, err);
          }
        }
      }
      this.loaded = true;
    }
    return [...this.records.values()];
  }

  /**
   * Write an attempt down before it is made. Idempotent on the transaction
   * identifier: an attempt already recorded is returned as it stands, so a
   * redelivered usage sample does not reset a backoff or resurrect an
   * abandoned charge.
   */
  async record(x: { txnId: string; body: Record<string, unknown>; label: string }, nowIso = new Date().toISOString()): Promise<SettlementAttempt> {
    await this.load();
    const existing = this.records.get(x.txnId);
    if (existing) return existing;
    const rec: SettlementAttempt = {
      txnId: x.txnId,
      body: x.body,
      label: x.label,
      state: "pending",
      attempts: 0,
      firstAt: nowIso,
      lastAt: null,
      nextAt: nowIso,
      lastError: null,
    };
    this.records.set(rec.txnId, rec);
    await this.flush();
    return rec;
  }

  /** The ledger took it. Dropped: the ledger holds it now. */
  async settled(txnId: string): Promise<void> {
    await this.load();
    if (this.records.delete(txnId)) await this.flush();
  }

  /**
   * The attempt did not land. `terminal` marks a refusal repeating cannot fix
   * — the ledger understood the charge and said no — which is abandoned at
   * once rather than retried a dozen times to reach the same answer.
   */
  async failed(txnId: string, error: string, opts: { terminal?: boolean } = {}, nowIso = new Date().toISOString()): Promise<SettlementAttempt | null> {
    await this.load();
    const rec = this.records.get(txnId);
    if (!rec) return null;
    rec.attempts += 1;
    rec.lastAt = nowIso;
    rec.lastError = error;
    if (opts.terminal || rec.attempts >= MAX_ATTEMPTS) {
      rec.state = "abandoned";
      rec.abandonedReason = opts.terminal
        ? `The ledger refused this charge and repeating it will not change that: ${error}`
        : `This charge was posted ${rec.attempts} times without reaching the ledger. The last attempt got: ${error}`;
    } else {
      rec.nextAt = new Date(Date.parse(nowIso) + backoffFor(rec.attempts)).toISOString();
    }
    await this.flush();
    return rec;
  }

  /** Pending attempts whose next try is due. */
  async due(nowMs = Date.now()): Promise<SettlementAttempt[]> {
    await this.load();
    return [...this.records.values()].filter((r) => r.state === "pending" && Date.parse(r.nextAt) <= nowMs);
  }

  /** Every attempt that has not landed, whatever its backoff says. What an
   *  operator who has just fixed the ledger asks for, rather than waiting out
   *  a gap that exists only because nobody was watching. */
  async pending(): Promise<SettlementAttempt[]> {
    await this.load();
    return [...this.records.values()].filter((r) => r.state === "pending");
  }

  /** Everything still on the queue: what has not landed, and what never will.
   *  This is the operator's read. */
  async all(): Promise<SettlementAttempt[]> {
    await this.load();
    return [...this.records.values()].sort((a, b) => (a.firstAt < b.firstAt ? -1 : 1));
  }

  private async flush(): Promise<void> {
    if (!this.path) return;
    const path = this.path;
    const body = JSON.stringify([...this.records.values()], null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, body, "utf8");
      await rename(tmp, path);
    });
    await this.writing;
  }
}
