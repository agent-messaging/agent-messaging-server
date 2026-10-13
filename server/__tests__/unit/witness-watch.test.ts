// The watcher for the audit backstop.
//
// The witness fold's guarantee is bounded by the mailboxes' 7-day retention:
// a backstop down or wedged longer than that loses the tail, and the loss
// leaves no trace because the failure is an absence. These cases pin the three
// judgments (missing, lagging, stale), the warm-up grace that keeps a brand
// new mailbox from paging anyone, the off-switch that respects a deliberate
// operator choice, and the once-per-transition alert rule that keeps a wedged
// consumer from emailing 48 times a day.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { JetStreamClient, KV, NatsConnection } from "nats";
import {
  assessWitness,
  composeWitnessAlert,
  observeMailboxes,
  runWitnessWatch,
  lagThreshold,
  staleMs,
  watchIntervalMs,
  CREATE_GRACE_MS,
  type MailboxInspector,
  type MailboxObservation,
  type OperatorAlert,
} from "../../src/activity/witness-watch.js";
import { storageOf } from "../../src/storage/index.js";

/** The scripted stream manager as the storage layer's mailbox family, the way
 *  the JetStream binding reads it. */
const mailboxesOf = (jsm: MailboxInspector) =>
  storageOf({ jetstreamManager: async () => jsm } as never).streams("MESH_INBOX_<agent>");

const NOW = Date.parse("2026-08-17T12:00:00Z");
const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const obs = (over: Partial<MailboxObservation> = {}): MailboxObservation => ({
  stream: "MESH_INBOX_pan_alice",
  createdMs: NOW - 24 * HOUR,
  consumer: { numPending: 3, outstanding: 3, oldestOutstandingMs: NOW - 5 * 60_000 },
  ...over,
});

interface FakeStream {
  name: string;
  created: string;
  messages?: number;
  first_seq?: number;
  first_ts?: string;
  // undefined consumer = consumers.info throws, i.e. no durable exists
  consumer?: { num_pending: number; num_ack_pending?: number; ack_floor?: number };
  // timestamp getMessage returns; "error" scripts a refused precise read
  msgAt?: string | "error";
}

function fakeJsm(streams: FakeStream[]): MailboxInspector & { getMessageCalls: number } {
  const self = {
    getMessageCalls: 0,
    streams: {
      async *list() {
        for (const s of streams) {
          yield {
            config: { name: s.name },
            created: s.created,
            state: {
              messages: s.messages ?? 10,
              first_seq: s.first_seq ?? 1,
              first_ts: s.first_ts ?? iso(NOW - 6 * 24 * HOUR),
            },
          };
        }
      },
      async getMessage(name: string, _q: { seq: number }) {
        self.getMessageCalls++;
        const s = streams.find((x) => x.name === name);
        if (!s || s.msgAt === undefined || s.msgAt === "error") throw new Error("no message found");
        return { time: new Date(s.msgAt) };
      },
    },
    consumers: {
      async info(name: string, _durable: string) {
        const s = streams.find((x) => x.name === name);
        if (!s?.consumer) throw new Error("consumer not found");
        return {
          num_pending: s.consumer.num_pending,
          num_ack_pending: s.consumer.num_ack_pending ?? 0,
          ack_floor: { stream_seq: s.consumer.ack_floor ?? 0 },
        };
      },
    },
  };
  return self;
}

function fakeKv(): KV & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(k: string) {
      const v = store.get(k);
      return v === undefined ? null : { string: () => v };
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
  } as unknown as KV & { store: Map<string, string> };
}

/** The alerts the watch handed over; `taken` is what whoever delivers them answers. */
function fakeAlerts(taken = true) {
  const sent: OperatorAlert[] = [];
  const alerts = {
    taken,
    async alert(a: OperatorAlert) {
      sent.push(a);
      return alerts.taken;
    },
  };
  return { email: alerts, sent };
}

// runWitnessWatch never touches nc/js when jsm and openState are overridden.
// The alert stands in for the `mesh.ops.alert` request the platform answers.
const deadDeps = (alerts: ReturnType<typeof fakeAlerts>["email"]) => ({
  nc: null as unknown as NatsConnection,
  js: null as unknown as JetStreamClient,
  alert: (a: OperatorAlert) => alerts.alert(a),
});

const ENV_KEYS = [
  "MESH_AUDIT_WITNESS",
  "OPERATOR_ALERT_EMAIL",
  "WITNESS_WATCH_INTERVAL_MS",
  "WITNESS_LAG_THRESHOLD",
  "WITNESS_STALE_MS",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Judgment
// ---------------------------------------------------------------------------

describe("a healthy fleet produces no findings", () => {
  it("consumers present, shallow, fresh", () => {
    const findings = assessWitness([obs(), obs({ stream: "MESH_INBOX_pan_bob" })], NOW);
    expect(findings).toEqual([]);
  });

  it("a fully caught-up consumer is never stale, whatever the stream's age", () => {
    const findings = assessWitness(
      [obs({ consumer: { numPending: 0, outstanding: 0, oldestOutstandingMs: null } })],
      NOW,
    );
    expect(findings).toEqual([]);
  });
});

describe("missing consumer", () => {
  it("is a finding once the stream is past the warm-up grace", () => {
    const findings = assessWitness([obs({ consumer: null, createdMs: NOW - 2 * HOUR })], NOW);
    expect(findings).toEqual([
      { stream: "MESH_INBOX_pan_alice", kind: "missing", pending: 0 },
    ]);
  });

  it("is NOT a finding for a stream created within the grace, because the fold's reconcile has 5-minute passes to meet it", () => {
    const fresh = obs({ consumer: null, createdMs: NOW - CREATE_GRACE_MS + 60_000 });
    expect(assessWitness([fresh], NOW)).toEqual([]);
  });

  it("gets no grace from an unparseable created date", () => {
    const findings = assessWitness([obs({ consumer: null, createdMs: NaN })], NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("missing");
  });
});

describe("lag and staleness", () => {
  it("flags num_pending over the threshold", () => {
    const findings = assessWitness(
      [obs({ consumer: { numPending: 5001, outstanding: 5001, oldestOutstandingMs: NOW - 60_000 } })],
      NOW,
    );
    expect(findings).toEqual([
      { stream: "MESH_INBOX_pan_alice", kind: "lagging", pending: 5001 },
    ]);
  });

  it("does not flag num_pending at the threshold", () => {
    const findings = assessWitness(
      [obs({ consumer: { numPending: 5000, outstanding: 5000, oldestOutstandingMs: NOW - 60_000 } })],
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it("flags outstanding work older than the stale window", () => {
    const oldMs = NOW - 49 * HOUR;
    const findings = assessWitness(
      [obs({ consumer: { numPending: 4, outstanding: 4, oldestOutstandingMs: oldMs } })],
      NOW,
    );
    expect(findings).toEqual([
      { stream: "MESH_INBOX_pan_alice", kind: "stale", pending: 4, oldestMs: oldMs },
    ]);
  });

  it("reports lagging AND stale on the same stream, because they call for different reactions", () => {
    const oldMs = NOW - 72 * HOUR;
    const findings = assessWitness(
      [obs({ consumer: { numPending: 9000, outstanding: 9000, oldestOutstandingMs: oldMs } })],
      NOW,
    );
    expect(findings.map((f) => f.kind).sort()).toEqual(["lagging", "stale"]);
  });
});

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

describe("observeMailboxes", () => {
  it("reads only MESH_INBOX_* streams and reports an absent durable as consumer null", async () => {
    const jsm = fakeJsm([
      { name: "MESH_INBOX_pan_alice", created: iso(NOW - 3 * HOUR) },
      { name: "MESH_AUDIT", created: iso(NOW - 30 * 24 * HOUR) },
    ]);
    const seen = await observeMailboxes(mailboxesOf(jsm));
    expect(seen).toHaveLength(1);
    expect(seen[0].stream).toBe("MESH_INBOX_pan_alice");
    expect(seen[0].consumer).toBeNull();
  });

  it("takes the oldest-outstanding age from the message past the ack floor", async () => {
    const jsm = fakeJsm([
      {
        name: "MESH_INBOX_pan_alice",
        created: iso(NOW - 10 * 24 * HOUR),
        first_ts: iso(NOW - 6 * 24 * HOUR),
        consumer: { num_pending: 2, ack_floor: 40 },
        msgAt: iso(NOW - 10 * 60_000),
      },
    ]);
    const [o] = await observeMailboxes(mailboxesOf(jsm));
    expect(o.consumer?.oldestOutstandingMs).toBe(NOW - 10 * 60_000);
  });

  it("falls back to the stream's first_ts when the precise read is refused", async () => {
    const jsm = fakeJsm([
      {
        name: "MESH_INBOX_pan_alice",
        created: iso(NOW - 10 * 24 * HOUR),
        first_ts: iso(NOW - 6 * 24 * HOUR),
        consumer: { num_pending: 2, ack_floor: 40 },
        msgAt: "error",
      },
    ]);
    const [o] = await observeMailboxes(mailboxesOf(jsm));
    expect(o.consumer?.oldestOutstandingMs).toBe(NOW - 6 * 24 * HOUR);
  });

  it("does not ask for a message at all when nothing is outstanding", async () => {
    const jsm = fakeJsm([
      {
        name: "MESH_INBOX_pan_alice",
        created: iso(NOW - 10 * 24 * HOUR),
        consumer: { num_pending: 0 },
      },
    ]);
    const [o] = await observeMailboxes(mailboxesOf(jsm));
    expect(o.consumer?.oldestOutstandingMs).toBeNull();
    expect(jsm.getMessageCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The alert text
// ---------------------------------------------------------------------------

describe("composeWitnessAlert", () => {
  it("says the numbers in plain sentences and names the retention deadline", () => {
    const { subject, lines } = composeWitnessAlert(
      [
        { stream: "MESH_INBOX_a", kind: "lagging", pending: 7000 },
        { stream: "MESH_INBOX_b", kind: "lagging", pending: 5000 },
        { stream: "MESH_INBOX_a", kind: "stale", pending: 7000, oldestMs: NOW - 2 * 24 * HOUR },
      ],
      NOW,
    );
    expect(lines.join(" ")).toContain("12000 messages behind on 2 mailbox streams");
    expect(lines.join(" ")).toContain("about 2 days old");
    expect(lines.join(" ")).toContain("drop messages at 7 days");
    expect(subject).toContain("about 2 days");
  });

  it("puts a missing consumer at the top of the subject, above everything else", () => {
    const { subject, lines } = composeWitnessAlert(
      [
        { stream: "MESH_INBOX_a", kind: "missing", pending: 0 },
        { stream: "MESH_INBOX_b", kind: "lagging", pending: 6000 },
      ],
      NOW,
    );
    expect(subject).toBe("audit backstop missing on 1 mailbox stream");
    expect(lines[0]).toContain("MESH_INBOX_a");
  });
});

// ---------------------------------------------------------------------------
// The scheduled run: alerting and its transition rule
// ---------------------------------------------------------------------------

describe("runWitnessWatch", () => {
  const quiet = () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  };

  it("a healthy fleet sends nothing and records a clean baseline", async () => {
    quiet();
    process.env.OPERATOR_ALERT_EMAIL = "ops@example.com";
    const { email, sent } = fakeAlerts();
    const kv = fakeKv();
    const jsm = fakeJsm([
      {
        name: "MESH_INBOX_pan_alice",
        created: iso(NOW - 24 * HOUR),
        consumer: { num_pending: 1, ack_floor: 9 },
        msgAt: iso(NOW - 2 * 60_000),
      },
    ]);
    const findings = await runWitnessWatch(deadDeps(email), {
      mailboxes: mailboxesOf(jsm),
      openState: async () => kv,
      now: () => NOW,
    });
    expect(findings).toEqual([]);
    expect(sent).toEqual([]);
    expect(JSON.parse(kv.store.get("state")!).hadFindings).toBe(false);
  });

  it("hands the alert function the composed message when findings appear", async () => {
    quiet();
    process.env.OPERATOR_ALERT_EMAIL = "ops@example.com";
    const { email, sent } = fakeAlerts();
    const kv = fakeKv();
    const jsm = fakeJsm([
      { name: "MESH_INBOX_pan_alice", created: iso(NOW - 24 * HOUR), consumer: { num_pending: 6000 } , msgAt: iso(NOW - 60_000) },
    ]);
    const findings = await runWitnessWatch(deadDeps(email), {
      mailboxes: mailboxesOf(jsm),
      openState: async () => kv,
      now: () => NOW,
    });
    expect(findings).toEqual([{ stream: "MESH_INBOX_pan_alice", kind: "lagging", pending: 6000 }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("witness watch");
    expect(sent[0].subject).toBe("audit backstop 6000 messages behind");
    expect(sent[0].lines.join(" ")).toContain("6000 messages behind on 1 mailbox stream");
    expect(JSON.parse(kv.store.get("state")!).hadFindings).toBe(true);
  });

  it("asks again at the next pass when nobody took the alert", async () => {
    quiet();
    const { email, sent } = fakeAlerts(false);
    const kv = fakeKv();
    const bad = () =>
      fakeJsm([
        { name: "MESH_INBOX_pan_alice", created: iso(NOW - 24 * HOUR), consumer: { num_pending: 6000 }, msgAt: iso(NOW - 60_000) },
      ]);
    const pass = () => runWitnessWatch(deadDeps(email), { mailboxes: mailboxesOf(bad()), openState: async () => kv, now: () => NOW });
    await pass();
    expect(JSON.parse(kv.store.get("state")!).hadFindings).toBe(false);
    await pass();
    expect(sent).toHaveLength(2);
    email.taken = true;
    await pass();
    await pass(); // taken now: the same problem is silent
    expect(sent).toHaveLength(3);
  });

  it("does not email again while the problem persists, and emails again after a clean pass in between", async () => {
    quiet();
    process.env.OPERATOR_ALERT_EMAIL = "ops@example.com";
    const { email, sent } = fakeAlerts();
    const kv = fakeKv();
    const bad = () =>
      fakeJsm([
        { name: "MESH_INBOX_pan_alice", created: iso(NOW - 24 * HOUR), consumer: { num_pending: 6000 }, msgAt: iso(NOW - 60_000) },
      ]);
    const good = () =>
      fakeJsm([
        { name: "MESH_INBOX_pan_alice", created: iso(NOW - 24 * HOUR), consumer: { num_pending: 1 }, msgAt: iso(NOW - 60_000) },
      ]);
    const pass = (jsm: MailboxInspector) =>
      runWitnessWatch(deadDeps(email), { mailboxes: mailboxesOf(jsm), openState: async () => kv, now: () => NOW });

    await pass(bad());
    await pass(bad()); // same problem, second pass: silence
    expect(sent).toHaveLength(1);
    await pass(good()); // clean pass resets the edge
    await pass(bad());
    expect(sent).toHaveLength(2);
  });

  it("MESH_AUDIT_WITNESS=off reports no findings and never touches JetStream", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.MESH_AUDIT_WITNESS = "off";
    process.env.OPERATOR_ALERT_EMAIL = "ops@example.com";
    const { email, sent } = fakeAlerts();
    const jsm = fakeJsm([{ name: "MESH_INBOX_pan_alice", created: iso(NOW - 24 * HOUR) }]);
    let listed = 0;
    const origList = jsm.streams.list.bind(jsm.streams);
    jsm.streams.list = () => {
      listed++;
      return origList();
    };
    const findings = await runWitnessWatch(deadDeps(email), { mailboxes: mailboxesOf(jsm), openState: async () => fakeKv(), now: () => NOW });
    expect(findings).toEqual([]);
    expect(sent).toEqual([]);
    expect(listed).toBe(0);
    expect(log.mock.calls.some((c) => String(c[0]).includes("MESH_AUDIT_WITNESS=off"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tunables and their floors
// ---------------------------------------------------------------------------

describe("env floors", () => {
  it("interval floors at 5 minutes", () => {
    process.env.WITNESS_WATCH_INTERVAL_MS = "1";
    expect(watchIntervalMs()).toBe(5 * 60_000);
    delete process.env.WITNESS_WATCH_INTERVAL_MS;
    expect(watchIntervalMs()).toBe(30 * 60_000);
  });

  it("lag threshold floors at 100", () => {
    process.env.WITNESS_LAG_THRESHOLD = "1";
    expect(lagThreshold()).toBe(100);
    process.env.WITNESS_LAG_THRESHOLD = "250";
    expect(lagThreshold()).toBe(250);
    delete process.env.WITNESS_LAG_THRESHOLD;
    expect(lagThreshold()).toBe(5000);
  });

  it("stale window floors at an hour", () => {
    process.env.WITNESS_STALE_MS = "1000";
    expect(staleMs()).toBe(3600_000);
    delete process.env.WITNESS_STALE_MS;
    expect(staleMs()).toBe(48 * 3600_000);
  });

  it("a floored threshold changes the judgment, not just the number", () => {
    process.env.WITNESS_LAG_THRESHOLD = "1"; // floors to 100
    const findings = assessWitness(
      [obs({ consumer: { numPending: 50, outstanding: 50, oldestOutstandingMs: NOW - 60_000 } })],
      NOW,
    );
    // 50 pending is under the floored threshold of 100, so no finding.
    expect(findings).toEqual([]);
  });
});
