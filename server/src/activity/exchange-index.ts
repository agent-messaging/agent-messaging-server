/**
 * The exchange index: a durable, content-free record of each request the
 * activity tap saw, keyed by the request's envelope id, so a response's meter
 * events never depend on the in-memory activity ring.
 *
 * ## Why it exists
 *
 * The activity ring (activity-service.ts) holds the last ACTIVITY_MAX_ENTRIES
 * exchanges MESH-WIDE, 500 by default, and it is how `recordResponse` found
 * the request a respond answers: who asked, who was asked, which offering, and
 * whether the exchange had already been counted once. A respond whose request
 * had been pushed out of the ring found nothing and recorded nothing — no
 * `responses`, no `bytes_out`, no failed flag, no refusal event, no declared
 * usage, and so no `request_id` either. Any bare exchange slower than 500
 * mesh-wide requests was under-billed on its answer side, the answer could
 * not be joined to its request (§13.5 request_id), and a buyer could flood
 * cheap requests to push a request out on purpose before its answer came.
 *
 * The ring is bounded because its rows carry `inputPreview`, the first 200
 * characters of real request input; that bound is a privacy commitment and
 * stays exactly as it is. This index carries NO content — the parties, the
 * offering, the task id and two timestamps — so it can live as long as an
 * answer can reasonably take, on its own clock.
 *
 * ## What it holds
 *
 *  - `r.<sha256(request id)>` → the {@link ExchangeRecord}.
 *  - `t.<sha256(requester \n task id)>` → `{ requestId }`, for a task-mode
 *    respond that carries `task_id` and no `in_reply_to` (the ring correlated
 *    those by task id too). Scoped by the requester, because a task id is the
 *    requester's own string and two requesters may pick the same one.
 *
 * Keys are hashed because ids are sender-supplied strings and a keyed store's
 * key alphabet is narrower than an envelope id's.
 *
 * Values expire with the store (`mesh_activity_requests`, storage/catalog.ts:
 * seven days, the same horizon as a Task record), so deferred work answered
 * inside a week still meters, and the index never grows past a week of
 * requests.
 *
 * ## Ordering
 *
 * Every read-modify-write on one request runs in order, one after another
 * (`serial`). The activity service is single-instance by design (see the
 * comment on the taps in activity-service.ts), so in-process ordering is what
 * makes "is this the exchange's first answer" well defined: two responds to
 * the same evicted request — or the two sightings of one respond — read the
 * record one at a time, and the second sees what the first wrote.
 */

import { createHash } from "node:crypto";
import type { KeyedStore } from "../storage/index.js";

/** One request as the tap saw it. Content-free by construction. */
export interface ExchangeRecord {
  v: 1;
  /** The request envelope's id (also what the key hashes). */
  requestId: string;
  /** The requester's key (the request's `from`). */
  from: string;
  /** The agent asked (the request's `to`): the responder of record. */
  to: string;
  offering: string;
  /** The request's own `task_id`, only when the requester set one. */
  taskId?: string;
  /** When the tap saw the request (our clock). */
  recordedAt: string;
  /** When the exchange's first answer was counted. Once set, every later
   *  answer is a follow-up: bytes only, exactly as in the ring. */
  respondedAt?: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function requestKey(requestId: string): string {
  return `r.${sha(requestId)}`;
}

export function taskKey(requester: string, taskId: string): string {
  return `t.${sha(`${requester}\n${taskId}`)}`;
}

const te = new TextEncoder();
const enc = (x: unknown) => te.encode(JSON.stringify(x));

export class ExchangeIndex {
  /** request id → the tail of that request's chain of work. */
  private chains = new Map<string, Promise<unknown>>();
  /** Task aliases written but not yet landed, so a lookup in that window
   *  still finds the request (a lookup by request id waits on the chain). */
  private aliasesInFlight = new Map<string, string>();

  constructor(private readonly store: KeyedStore) {}

  /** Run `fn` after everything already queued for `requestId`. Never rejects
   *  the chain: one failed write must not wedge every later answer. */
  private serial<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(requestId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(requestId, tail);
    void tail.then(() => {
      if (this.chains.get(requestId) === tail) this.chains.delete(requestId);
    });
    return run;
  }

  /** Write a request's record (and its task alias). Fire-and-forget on the
   *  tap's hot path; a later lookup on the same request waits for it. */
  remember(rec: ExchangeRecord): void {
    const alias = rec.taskId ? taskKey(rec.from, rec.taskId) : undefined;
    if (alias) this.aliasesInFlight.set(alias, rec.requestId);
    this.serial(rec.requestId, async () => {
      try {
        await this.store.put(requestKey(rec.requestId), enc(rec));
        if (alias) await this.store.put(alias, enc({ requestId: rec.requestId }));
      } finally {
        if (alias && this.aliasesInFlight.get(alias) === rec.requestId) this.aliasesInFlight.delete(alias);
      }
    }).catch((err) => console.error("[activity] exchange index write failed:", err instanceof Error ? err.message : err));
  }

  /** Write a record only if the request has none yet — for the ring's rows at
   *  boot, which may predate this index. Never overwrites what is there. */
  seed(rec: ExchangeRecord): void {
    this.serial(rec.requestId, async () => {
      if (await this.store.get(requestKey(rec.requestId))) return;
      await this.store.create(requestKey(rec.requestId), enc(rec));
      if (rec.taskId) await this.store.create(taskKey(rec.from, rec.taskId), enc({ requestId: rec.requestId })).catch(() => {});
    }).catch(() => { /* already there, or the store refused: the ring still has the row */ });
  }

  /** The request a task-mode respond answers, by its requester and task id. */
  async requestForTask(requester: string, taskId: string): Promise<string | undefined> {
    const key = taskKey(requester, taskId);
    const inFlight = this.aliasesInFlight.get(key);
    if (inFlight !== undefined) return inFlight;
    const raw = await this.store.get(key);
    if (!raw || raw.operation !== "PUT") return undefined;
    const id = raw.json<{ requestId?: unknown }>().requestId;
    return typeof id === "string" && id !== "" ? id : undefined;
  }

  /**
   * Read a request's record, hand it to `fn`, and write back what `fn`
   * returns (nothing: no write). Serial per request. `fn` sees null when the
   * index never saw the request or it has expired.
   */
  update(
    requestId: string,
    fn: (rec: ExchangeRecord | null) => ExchangeRecord | null | void,
  ): Promise<void> {
    return this.serial(requestId, async () => {
      const raw = await this.store.get(requestKey(requestId));
      let rec: ExchangeRecord | null = null;
      if (raw && raw.operation === "PUT") {
        try {
          const r = raw.json<ExchangeRecord>();
          if (r && r.requestId === requestId && typeof r.to === "string" && typeof r.from === "string") rec = r;
        } catch { /* unreadable: treated as unknown */ }
      }
      const next = fn(rec);
      if (next) await this.store.put(requestKey(requestId), enc(next));
    });
  }

  /** Wait until every queued write has landed (tests, and stop()). */
  async drain(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }
}
