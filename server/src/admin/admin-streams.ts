/**
 * The core's event streams, consumed for a platform beside the core (step 10a
 * of docs/agent-messaging-server-plan.md).
 *
 * AgentMesh's platform folds two of the core's streams: the task manager's
 * receipts on the events stream (the spend rollup) and the meter events on the
 * metering stream (the rating fold, SPEC §19.6). It used to bind a durable
 * consumer on each with the broker's own API, which tied it to the NATS
 * binding. The core now holds those same durable consumers on the platform's
 * behalf, through the storage layer, and hands their deliveries over HTTP:
 * the platform asks for the next messages, handles each, and acknowledges it.
 *
 * A durable consumer, not a read by sequence, because the events stream keeps
 * a message only while some consumer still has an interest in it (SPEC §18.3,
 * interest retention): the durable consumer is what keeps a receipt there
 * until the platform has taken it. Using the platform's old consumers' names
 * means each fold resumes exactly where its consumer stood.
 *
 *   POST /admin/v1/event-streams/:stream/consumers/:durable/next { max?, wait_ms?, filter?, from? }
 *       stream is "events" (MESH_EVENTS) or "metering" (MESH_METERING). Binds
 *       the durable consumer (made on first use, with `filter` and, when `from`
 *       is "all", from the first message the stream holds) and answers up to
 *       `max` (at most 200) of its deliveries, waiting up to `wait_ms` (at most
 *       10000) for the first: { messages: [{ seq, subject, data }] }, the bytes
 *       base64. A delivery is not acknowledged until the caller says so; one
 *       left unacknowledged is delivered again after the consumer's wait.
 *   POST /admin/v1/event-streams/:stream/consumers/:durable/ack { seqs }
 *       acknowledge those deliveries: { acked }.
 *   GET /admin/v1/event-streams/feeds/subjects
 *       how many messages the feed stream holds for each feed subject, counted
 *       by reading it: { subjects: [{ subject, messages }], complete }. Counts
 *       only, never a feed's value.
 *   GET /admin/v1/scheduler/runs/:job
 *       the core scheduler's run record for a job (mesh_sched), { last }, as
 *       stored, or null. The platform's scheduler carries its jobs' last runs
 *       over from here once.
 *
 * Each answer is { status, body } and never throws.
 */
import type { DoorAnswer } from "../keychain/doors.js";
import type { AdminRequest } from "./admin-api.js";
import type { KeyedStore, SingleStream, StreamConsumer, StreamDelivery } from "../storage/index.js";

const STREAMS = { events: "MESH_EVENTS", metering: "MESH_METERING" } as const;
type StreamKey = keyof typeof STREAMS;
const MAX_BATCH = 200;
const MAX_WAIT_MS = 10_000;
/** The most feed messages one overview counts before it says it stopped. */
const MAX_FEED_COUNT = 200_000;
const DURABLE = /^[A-Za-z0-9_-]{1,64}$/;
const SUBJECT = /^[A-Za-z0-9_.*>-]{1,256}$/;
const JOB = /^[a-z0-9_-]{1,48}$/;

export interface AdminStreamsDeps {
  stream(name: "MESH_EVENTS" | "MESH_METERING" | "MESH_FEED"): SingleStream;
  /** The core scheduler's bucket (mesh_sched). */
  schedule?: () => Promise<KeyedStore>;
}

const ok = (body: Record<string, unknown>, status = 200): DoorAnswer => ({ status, body });
const no = (status: number, error: string): DoorAnswer => ({ status, body: { error } });

/** One durable consumer the core holds open for a caller: its deliveries as
 *  they arrive, and those handed over and not yet acknowledged. */
class Held {
  private buffer: StreamDelivery[] = [];
  private wakers: Array<() => void> = [];
  private out = new Map<number, StreamDelivery>();
  closed = false;

  constructor(private readonly consumer: StreamConsumer) {
    void (async () => {
      try {
        for await (const d of consumer) {
          this.buffer.push(d);
          for (const w of this.wakers.splice(0)) w();
        }
      } catch (err) {
        console.warn(`[admin] a held consumer stopped: ${(err as Error).message}`);
      } finally {
        this.closed = true;
        for (const w of this.wakers.splice(0)) w();
      }
    })();
  }

  async next(max: number, waitMs: number): Promise<StreamDelivery[]> {
    if (!this.buffer.length && !this.closed && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, waitMs);
        this.wakers.push(() => { clearTimeout(t); resolve(); });
      });
    }
    const taken = this.buffer.splice(0, max);
    // A redelivery of the same message replaces the one handed over before.
    for (const d of taken) this.out.set(d.seq, d);
    return taken;
  }

  ack(seqs: number[]): number {
    let n = 0;
    for (const s of seqs) {
      const d = this.out.get(s);
      if (!d) continue;
      d.ack();
      this.out.delete(s);
      n++;
    }
    return n;
  }

  stop(): void {
    this.consumer.stop();
  }
}

export function adminStreams(deps: AdminStreamsDeps) {
  const held = new Map<string, Promise<Held>>();

  function bind(which: StreamKey, durable: string, filter: string | undefined, from: "all" | undefined): Promise<Held> {
    const key = `${which}/${durable}`;
    let h = held.get(key);
    if (!h) {
      h = deps.stream(STREAMS[which]).consume(durable, { ...(filter ? { filter } : {}), ...(from ? { from } : {}) }).then((c) => new Held(c));
      h.catch(() => held.delete(key));
      held.set(key, h);
    }
    return h;
  }

  async function next(which: StreamKey, durable: string, b: Record<string, unknown>): Promise<DoorAnswer> {
    const filter = typeof b.filter === "string" && b.filter ? b.filter : undefined;
    if (filter !== undefined && !SUBJECT.test(filter)) return no(400, "filter is one subject or pattern.");
    const from = b.from === "all" ? "all" as const : undefined;
    const max = Math.max(1, Math.min(Number(b.max ?? 100) || 100, MAX_BATCH));
    const wait = Math.max(0, Math.min(Number(b.wait_ms ?? 0) || 0, MAX_WAIT_MS));
    let h = await bind(which, durable, filter, from);
    if (h.closed) {
      held.delete(`${which}/${durable}`);
      h = await bind(which, durable, filter, from);
    }
    const got = await h.next(max, wait);
    return ok({ messages: got.map((d) => ({ seq: d.seq, subject: d.subject, data: Buffer.from(d.data).toString("base64") })) });
  }

  async function ack(which: StreamKey, durable: string, b: Record<string, unknown>): Promise<DoorAnswer> {
    const seqs = Array.isArray(b.seqs) ? b.seqs.filter((s): s is number => Number.isSafeInteger(s) && (s as number) > 0) : [];
    if (!seqs.length) return no(400, "seqs lists the deliveries to acknowledge.");
    const h = held.get(`${which}/${durable}`);
    if (!h) return ok({ acked: 0 });
    return ok({ acked: (await h).ack(seqs) });
  }

  async function feedSubjects(): Promise<DoorAnswer> {
    const stream = deps.stream("MESH_FEED");
    const info = await stream.info();
    if (!info || info.messages === 0) return ok({ subjects: [], complete: true });
    const counts = new Map<string, number>();
    let seq = info.firstSeq;
    let read = 0;
    while (seq <= info.lastSeq && read < MAX_FEED_COUNT) {
      let got = 0;
      for await (const m of stream.readFrom(seq, { max: 1000, waitMs: 1000 })) {
        if (m.seq > info.lastSeq) break;
        counts.set(m.subject, (counts.get(m.subject) ?? 0) + 1);
        seq = m.seq + 1;
        got++;
      }
      if (!got) break;
      read += got;
    }
    return ok({
      subjects: [...counts].map(([subject, messages]) => ({ subject, messages })),
      complete: seq > info.lastSeq,
    });
  }

  async function route(seg: string[], m: string, b: Record<string, unknown>): Promise<DoorAnswer | null> {
    if (seg[0] === "scheduler" && seg[1] === "runs" && seg.length === 3 && m === "GET" && deps.schedule) {
      if (!JOB.test(seg[2]!)) return no(400, "That is not a job name.");
      const e = await (await deps.schedule()).get(`sched.${seg[2]}.last`);
      return ok({ last: e && e.operation === "PUT" && e.value.length ? e.string() : null });
    }
    if (seg[0] !== "event-streams") return null;
    if (seg[1] === "feeds" && seg[2] === "subjects" && seg.length === 3 && m === "GET") return feedSubjects();
    const which = seg[1] as StreamKey;
    if (!(which in STREAMS)) return seg.length >= 2 ? no(404, 'The streams consumed here are "events" and "metering".') : null;
    if (seg.length === 5 && seg[2] === "consumers" && m === "POST") {
      const durable = seg[3]!;
      if (!DURABLE.test(durable)) return no(400, "That is not a consumer name.");
      if (seg[4] === "next") return next(which, durable, b);
      if (seg[4] === "ack") return ack(which, durable, b);
    }
    return null;
  }

  async function handle(req: AdminRequest): Promise<DoorAnswer | null> {
    const seg = req.path.replace(/^\/admin\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    if (seg[0] !== "event-streams" && seg[0] !== "scheduler") return null;
    try {
      return await route(seg, req.method, req.body ?? {});
    } catch (err) {
      return no(503, `The stream could not be read: ${(err as Error).message}`);
    }
  }

  /** Let go of every consumer held open (the mesh API stopping). */
  async function close(): Promise<void> {
    for (const h of held.values()) (await h.catch(() => null))?.stop();
    held.clear();
  }

  return { handle, close };
}

export type AdminStreams = ReturnType<typeof adminStreams>;
