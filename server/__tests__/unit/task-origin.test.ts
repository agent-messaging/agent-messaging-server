import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEnvelope, encode, decode, signEnvelope, nkeys } from "../../src/sdk.js";
import type { Envelope, TaskCanceledBy, TaskOrigin } from "../../src/sdk.js";
import { handleTaskUpdate } from "../../src/task-manager/handlers/task-update.js";
import { OriginLedger, ORIGIN_SKEW_MS, CANCEL_READ_TIMEOUT_MS, CANCEL_SETTLE_DELAYS_MS, requestKey } from "../../src/task-manager/origin.js";
import { OriginTap, flushOriginMisses, inboxAgentOf } from "../../src/task-manager/origin-tap.js";
import { OverdueSweep } from "../../src/task-manager/overdue-sweep.js";
import { handleTaskGet } from "../../src/task-manager/handlers/task-get.js";
import { adminViews } from "../../src/admin/admin-views.js";
import type { KeyedEntry, KeyedStore } from "../../src/storage/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Task origin and cancel attribution (origin.ts), pinned against
// conformance/task-origin.json. The envelopes below are the shapes the
// TypeScript SDK publishes on each path (sdk-typescript/src/mesh.ts), built
// here by hand so each test controls the order the tap and the update
// handler see them in. tools/regressions/task-origin.mjs runs the same paths
// through the real SDK on a live mesh.

const fixture = JSON.parse(
  readFileSync(new URL("../../../conformance/task-origin.json", import.meta.url), "utf8"),
) as {
  fields: {
    origin: { required: string[]; optional: string[]; bound_by: Record<string, string> };
    canceled_by: {
      required: string[];
      party: Record<string, string>;
      requester_request: { required: string[]; via: Record<string, string> };
      unverified: { required: string[]; absent: string[]; unverified_reason: Record<string, string> };
    };
  };
  cases: { origin: { case: string }[]; canceled_by: { case: string }[] };
};

type Kp = ReturnType<typeof nkeys.createUser>;
const buyerKp = nkeys.createUser();
const BUYER = buyerKp.getPublicKey();
const sellerKp = nkeys.createUser();
const SELLER = sellerKp.getPublicKey();
const strangerKp = nkeys.createUser();
const STRANGER = strangerKp.getPublicKey();
const tmKp = nkeys.createUser();

/** An in-memory keyed store with revisions and compare-and-set: the parts of
 *  storage/types.ts KeyedStore the ledger and the handler use. */
function memKeyed(): KeyedStore & { map: Map<string, { v: string; rev: number }> } {
  const map = new Map<string, { v: string; rev: number }>();
  let seq = 0;
  const entry = (key: string): KeyedEntry | null => {
    const x = map.get(key);
    if (!x) return null;
    const value = new TextEncoder().encode(x.v);
    return {
      key, value, revision: x.rev, created: new Date(), operation: "PUT", length: value.length,
      json: <T>() => JSON.parse(x.v) as T, string: () => x.v,
    };
  };
  const s = (v: Uint8Array | string) => (typeof v === "string" ? v : new TextDecoder().decode(v));
  return {
    map,
    get: async (k) => entry(k),
    put: async (k, v) => { map.set(k, { v: s(v), rev: ++seq }); return seq; },
    create: async (k, v) => {
      if (map.has(k)) throw new Error("wrong last sequence: key exists");
      map.set(k, { v: s(v), rev: ++seq });
      return seq;
    },
    update: async (k, v, revision) => {
      if (map.get(k)?.rev !== revision) throw new Error("wrong last sequence");
      map.set(k, { v: s(v), rev: ++seq });
      return seq;
    },
    delete: async (k) => { map.delete(k); },
    purge: async (k) => { map.delete(k); },
    list: async () => { throw new Error("not used"); },
    watch: async () => { throw new Error("not used"); },
  };
}

let tasks: ReturnType<typeof memKeyed>;
let store: ReturnType<typeof memKeyed>;
let ledger: OriginLedger;
let nc: { publish: ReturnType<typeof vi.fn> };

beforeEach(() => {
  tasks = memKeyed();
  store = memKeyed();
  ledger = new OriginLedger(store, tasks);
  nc = { publish: vi.fn() };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const sign = (kp: Kp, fields: Parameters<typeof createEnvelope>[0]): Envelope =>
  signEnvelope(createEnvelope(fields), kp);

/** The tap: what the server observed on an inbox or outbox subject. The
 *  ledger is handed the decoded envelope, signature verified, exactly as
 *  the service's tap decodes it, delivered to its addressee's inbox. */
const tap = (env: Envelope) => ledger.observe(decode(encode(env)), env.to ?? "");

/** The task manager handling one update on mesh.task.<id>.update. */
const update = (env: Envelope, withLedger = true) =>
  handleTaskUpdate(
    { subject: `mesh.task.${env.task_id}.update`, data: encode(env) } as never,
    tasks,
    nc as never,
    tmKp,
    undefined,
    undefined,
    withLedger ? ledger : undefined,
  );

const record = (taskId: string) => JSON.parse(tasks.map.get(taskId)!.v) as {
  state: string;
  history: Envelope[];
  origin?: TaskOrigin;
  canceled_by?: TaskCanceledBy;
  cancel_reason?: string;
  requester: string;
  responder: string;
};

/** A buyer's request to the seller (mesh.ts request / stream). */
/** A request naming a Task id is a stream request (the SDK's requestStream)
 *  unless `resume` says it is a follow-up naming an existing Task. */
const request = (opts: { taskId?: string; resume?: boolean; offering?: string; from?: Kp; to?: string; input?: unknown } = {}) =>
  sign(opts.from ?? buyerKp, {
    type: "request",
    from: (opts.from ?? buyerKp).getPublicKey(),
    to: opts.to ?? SELLER,
    ...(opts.taskId ? { task_id: opts.taskId } : {}),
    payload: {
      offering: opts.offering ?? "summarize",
      input: opts.input ?? { text: "hello" },
      ...(opts.taskId && !opts.resume ? { config: { stream: true } } : {}),
    },
  });

/** A stream as the SDK runs it: the request naming its Task id, then the
 *  provider's opening `working` respond carrying that id (§11.3). Only the
 *  answer ties the request to the Task. Returns what the answer came to. */
const open = async (req: Envelope) => {
  await tap(req);
  return tap(answer(req, req.task_id!, "working"));
};

/** The seller's answer to a request, on the buyer's inbox (sendRespond). */
const answer = (req: Envelope, taskId: string, status: string, kp: Kp = sellerKp, to = req.from) =>
  sign(kp, {
    type: "respond",
    from: kp.getPublicKey(),
    to,
    in_reply_to: req.id,
    task_id: taskId,
    payload: { status },
  });

/** A task update. `inReplyTo` is what the SDK path sets, often nothing. */
const taskUpdate = (
  taskId: string,
  payload: Record<string, unknown>,
  opts: { kp?: Kp; to?: string; inReplyTo?: string; extra?: Record<string, unknown> } = {},
) => {
  const kp = opts.kp ?? sellerKp;
  const env = createEnvelope({
    type: "respond",
    from: kp.getPublicKey(),
    to: opts.to ?? (kp === sellerKp ? BUYER : SELLER),
    task_id: taskId,
    ...(opts.inReplyTo ? { in_reply_to: opts.inReplyTo } : {}),
    payload,
  });
  Object.assign(env, opts.extra ?? {});
  return signEnvelope(env, kp);
};

const expectOrigin = (taskId: string, req: Envelope, boundBy: TaskOrigin["bound_by"]) => {
  const o = record(taskId).origin;
  expect(o).toBeDefined();
  // Every required field, and nothing but the optional contest fields beside them.
  for (const f of fixture.fields.origin.required) expect(o).toHaveProperty(f);
  for (const k of Object.keys(o!)) {
    expect([...fixture.fields.origin.required, ...fixture.fields.origin.optional]).toContain(k);
  }
  expect(o).toMatchObject({
    request_id: req.id,
    requester: BUYER,
    responder: SELLER,
    offering: "summarize",
    bound_by: boundBy,
  });
  expect(Number.isFinite(Date.parse(o!.observed_at))).toBe(true);
  expect(Object.keys(fixture.fields.origin.bound_by)).toContain(boundBy);
};

describe("the fixture names every case these tests run", () => {
  it("lists the origin and canceled_by cases", () => {
    expect(fixture.cases.origin.map((c) => c.case)).toContain("stream_request_then_handler_throws");
    expect(fixture.cases.origin.map((c) => c.case)).toContain("input_problems_then_deferred_failure");
    expect(fixture.cases.canceled_by.map((c) => c.case)).toContain("responder_cancels_user_requested_unasked");
  });
});

describe("origin is set on creation, through each SDK path", () => {
  it("a stream request whose handler throws: the failed update carries no in_reply_to", async () => {
    const T = "task-stream-throws";
    const req = request({ taskId: T }); // stream(): the task id is requester-generated
    await open(req);
    await tap(answer(req, T, "working")); // §11.3 opening respond
    // mesh.ts stream catch: failEnv, no in_reply_to
    const failEnv = taskUpdate(T, { status: "failed" });
    expect(failEnv.in_reply_to).toBeUndefined();
    await update(failEnv);
    expect(record(T).state).toBe("failed");
    expectOrigin(T, req, "request");
  });

  it("a synchronous InputProblemsError, a resume, then a deferred failure", async () => {
    const T = "task-input-problems";
    const req = request(); // a bare request: the responder picks the task id
    await tap(req);
    await tap(answer(req, T, "input_required")); // pauseEnv, to the buyer's inbox
    // recordEnv: the CREATING update, with no in_reply_to
    const recordEnv = taskUpdate(T, { status: "input_required", message: "need a file", problems: [] });
    expect(recordEnv.in_reply_to).toBeUndefined();
    await update(recordEnv);
    expectOrigin(T, req, "answer");

    // The buyer resumes on the same task; the handler defers, then fails.
    const resume = request({ taskId: T, resume: true, input: { text: "with the file" } });
    await tap(resume);
    await update(taskUpdate(T, { status: "working" }, { inReplyTo: resume.id }));
    await update(taskUpdate(T, { status: "failed" }, { inReplyTo: resume.id }));
    expect(record(T).state).toBe("failed");
    // Still the request that CREATED the task, not the resume.
    expectOrigin(T, req, "answer");
  });

  it("a deferred completion: the working answer binds, the terminal update creates the record", async () => {
    const T = "task-deferred";
    const req = request();
    await tap(req);
    await tap(answer(req, T, "working"));
    await update(taskUpdate(T, { status: "completed", output: { ok: true } }, { inReplyTo: req.id }));
    expectOrigin(T, req, "answer");
  });

  it("the creating update recorded before the tap sees the request: attached afterwards, by compare-and-set", async () => {
    const T = "task-update-first";
    const req = request({ taskId: T });
    await update(taskUpdate(T, { status: "working" }));
    expect(record(T).origin).toBeUndefined();
    await open(req);
    expectOrigin(T, req, "request");
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, req, "request");
  });

  it("the answer seen before its request: the tap reports it so the service can look again", async () => {
    const T = "task-answer-first";
    const req = request();
    expect(await tap(answer(req, T, "input_required"))).toBe("unknown_request");
    await tap(req);
    expect(await tap(answer(req, T, "input_required"))).toBe("recorded");
    await update(taskUpdate(T, { status: "input_required", message: "?" }));
    expectOrigin(T, req, "answer");
  });

  it("the outbox mirror and a second instance see the same envelopes: one origin, written once", async () => {
    const T = "task-twice";
    const req = request({ taskId: T });
    const other = new OriginLedger(store, tasks);
    await open(req);
    await other.observe(decode(encode(req)), SELLER);
    await other.observe(decode(encode(answer(req, T, "working"))), BUYER);
    await update(taskUpdate(T, { status: "working" }));
    expectOrigin(T, req, "request");
  });

  it("no observed request: no origin, and nothing guessed from the update", async () => {
    const T = "task-unobserved";
    await update(taskUpdate(T, { status: "working" }, { inReplyTo: "some-request-id" }));
    await update(taskUpdate(T, { status: "completed" }, { inReplyTo: "some-request-id" }));
    expect(record(T).origin).toBeUndefined();
  });

  it("without the ledger wired, records are exactly as before", async () => {
    const T = "task-no-ledger";
    const req = request({ taskId: T });
    await open(req);
    await update(taskUpdate(T, { status: "working" }), false);
    expect(record(T).origin).toBeUndefined();
  });

  it("the signed lifecycle event carries the origin", async () => {
    const T = "task-event";
    const req = request({ taskId: T });
    await open(req);
    await update(taskUpdate(T, { status: "working" }));
    const ev = decode(nc.publish.mock.calls.at(-1)![1] as Uint8Array);
    expect((ev.payload as { data: { origin?: TaskOrigin } }).data.origin?.request_id).toBe(req.id);
  });
});

describe("origin survives the history cap", () => {
  it("60 updates later the history has dropped the creating entry and the origin has not moved", async () => {
    const T = "task-long";
    const req = request();
    await tap(req);
    await tap(answer(req, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    const first = record(T).origin;
    for (let i = 0; i < 30; i++) {
      await update(taskUpdate(T, { status: "input_required", message: `q${i}` }));
      await update(taskUpdate(T, { status: "working" }));
    }
    const r = record(T);
    expect(r.history).toHaveLength(50);
    expect(r.history.some((h) => h.in_reply_to === req.id)).toBe(false);
    expect(r.origin).toEqual(first);
    expectOrigin(T, req, "answer");
  });
});

describe("a responder cannot set or change origin", () => {
  const forged: TaskOrigin = {
    request_id: "forged-request",
    requester: BUYER,
    responder: SELLER,
    offering: "free-sample",
    observed_at: new Date().toISOString(),
    bound_by: "request",
  };

  it("an origin carried on the creating update is ignored, in the payload or on the envelope", async () => {
    const T = "task-forged-create";
    await update(taskUpdate(T, { status: "working", origin: forged }, { extra: { origin: forged } }));
    expect(record(T).origin).toBeUndefined();
  });

  it("an origin carried on a later update does not replace the observed one", async () => {
    const T = "task-forged-later";
    const req = request({ taskId: T });
    await open(req);
    await update(taskUpdate(T, { status: "working" }));
    await update(taskUpdate(T, { status: "completed", origin: forged }, { extra: { origin: forged } }));
    expectOrigin(T, req, "request");
  });

  it("an answer to another request cannot rebind the task: it is listed as contesting it", async () => {
    const T = "task-rebind";
    const req = request();
    const cheap = request({ offering: "summarize", input: { text: "cheap" } });
    await tap(req);
    await tap(cheap);
    await tap(answer(req, T, "working"));
    // The seller tries to move T to `cheap`: the first binding stands, and
    // `cheap` is listed as contesting it.
    expect(await tap(answer(cheap, T, "working"))).toBe("contested");
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, req, "answer");
    expect(record(T).origin!.contested_by).toEqual([cheap.id]);
  });

  it("a request naming T that the provider answers under U is tied to U, never to T", async () => {
    const T = "task-named";
    const U = "task-answered";
    const req = request({ taskId: T });
    await tap(req);
    await tap(answer(req, U, "working")); // the provider ran it as fresh work under U
    await update(taskUpdate(U, { status: "completed" }));
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(U, req, "answer");
    expect(record(T).origin).toBeUndefined();
    expect((record(T) as { contested_by?: string[] }).contested_by).toBeUndefined();
  });

  it("a responder that names another requester gets no origin", async () => {
    const T = "task-wrong-requester";
    const req = request();
    await tap(req);
    await tap(answer(req, T, "working"));
    await update(taskUpdate(T, { status: "working" }, { to: STRANGER }));
    expect(record(T).requester).toBe(STRANGER);
    expect(record(T).origin).toBeUndefined();
  });

  it("only the asked agent's answer, to the asker, binds", async () => {
    const T = "task-impostor";
    const req = request();
    await tap(req);
    await tap(answer(req, T, "working", strangerKp)); // a third agent answering
    await tap(answer(req, T, "working", sellerKp, STRANGER)); // the seller, to someone else
    await update(taskUpdate(T, { status: "working" }));
    expect(record(T).origin).toBeUndefined();
  });

  it("a stranger's request naming the task id binds nothing", async () => {
    const T = "task-stranger";
    const req = request({ taskId: T });
    await open(req);
    await update(taskUpdate(T, { status: "working" }));
    await tap(request({ taskId: T, from: strangerKp }));
    expectOrigin(T, req, "request");
  });

  it("a request first seen long after its task existed did not create it", async () => {
    const T = "task-old";
    await update(taskUpdate(T, { status: "working" }));
    const r = JSON.parse(tasks.map.get(T)!.v);
    r.created_at = new Date(Date.now() - ORIGIN_SKEW_MS - 60_000).toISOString();
    tasks.map.set(T, { v: JSON.stringify(r), rev: 999 });
    await tap(request({ taskId: T, resume: true })); // a resume, naming a task that already existed
    await update(taskUpdate(T, { status: "completed" }));
    expect(record(T).origin).toBeUndefined();
  });

  it("a message for a person binds nothing (§5.7)", async () => {
    const T = "task-person";
    const req = request({ taskId: T });
    req.meta = { audience: "person" };
    signEnvelope(req, buyerKp);
    await open(req);
    await update(taskUpdate(T, { status: "working" }));
    expect(record(T).origin).toBeUndefined();
  });
});

describe("cancel attribution", () => {
  const cancelUpdate = (T: string, kp: Kp, reason: string) =>
    taskUpdate(T, { status: "canceled", reason }, { kp });

  /** The buyer's §10.8 notification to the seller (mesh.ts cancel()). */
  const cancelRequest = (T: string, kp: Kp = buyerKp) =>
    sign(kp, {
      type: "request",
      from: kp.getPublicKey(),
      to: SELLER,
      payload: { offering: "task.cancel", input: { task_id: T, reason: "user_requested" } },
    });

  async function started(T: string) {
    const req = request({ taskId: T });
    await open(req);
    await update(taskUpdate(T, { status: "working" }));
    expectOrigin(T, req, "request");
    return req;
  }

  const expectShape = (c: TaskCanceledBy | undefined) => {
    expect(c).toBeDefined();
    expect(Object.keys(c!).sort()).toEqual([...fixture.fields.canceled_by.required].sort());
    expect(Object.keys(fixture.fields.canceled_by.party)).toContain(c!.party);
    if (c!.requester_request) {
      expect(Object.keys(c!.requester_request).sort()).toEqual(
        [...fixture.fields.canceled_by.requester_request.required].sort(),
      );
      expect(Object.keys(fixture.fields.canceled_by.requester_request.via)).toContain(c!.requester_request.via);
    }
  };

  it("a buyer's cancel: the requester asked, through its own update", async () => {
    const T = "cancel-buyer";
    await started(T);
    const env = cancelUpdate(T, buyerKp, "user_requested");
    await update(env);
    await tap(cancelRequest(T)); // the SDK's notification follows the update
    const c = record(T).canceled_by;
    expectShape(c);
    expect(c!.party).toBe("requester");
    expect(c!.requester_request).toMatchObject({ request_id: env.id, via: "update" });
    expect(record(T).cancel_reason).toBe("user_requested");
  });

  it("a responder's cancel signed user_requested, with no cancel from the buyer: the responder's", async () => {
    const T = "cancel-seller-claims-user";
    await started(T);
    await update(cancelUpdate(T, sellerKp, "user_requested"));
    const c = record(T).canceled_by;
    expectShape(c);
    expect(c).toMatchObject({ party: "responder", requester_request: null });
    expect(record(T).cancel_reason).toBe("user_requested");
  });

  it("a responder's cancel after the buyer's task.cancel request: the responder signed it, the buyer asked", async () => {
    const T = "cancel-seller-after-ask";
    await started(T);
    const ask = cancelRequest(T);
    await tap(ask);
    await update(cancelUpdate(T, sellerKp, "user_requested"));
    const c = record(T).canceled_by;
    expectShape(c);
    expect(c!.party).toBe("responder");
    expect(c!.requester_request).toMatchObject({ request_id: ask.id, via: "cancel_request" });
    expect(Date.parse(c!.requester_request!.observed_at)).toBeLessThanOrEqual(Date.parse(c!.at));
  });

  for (const reason of ["superseded", "budget_exhausted", "policy"]) {
    it(`a responder's own reason (${reason}) is the responder's`, async () => {
      const T = `cancel-seller-${reason}`;
      await started(T);
      await update(cancelUpdate(T, sellerKp, reason));
      expect(record(T).canceled_by).toMatchObject({ party: "responder", requester_request: null });
      expect(record(T).cancel_reason).toBe(reason);
    });
  }

  it("a stranger's task.cancel request does not count as the buyer asking", async () => {
    const T = "cancel-stranger-ask";
    await started(T);
    await tap(cancelRequest(T, strangerKp));
    await update(cancelUpdate(T, sellerKp, "user_requested"));
    expect(record(T).canceled_by).toMatchObject({ party: "responder", requester_request: null });
  });

  it("a buyer's cancel request seen only after the responder canceled does not count", async () => {
    const T = "cancel-ask-after";
    await started(T);
    await update(cancelUpdate(T, sellerKp, "superseded"));
    await tap(cancelRequest(T));
    expect(record(T).canceled_by).toMatchObject({ party: "responder", requester_request: null });
  });

  it("without an origin, the requester's cancel is the requester's and vouches for nothing", async () => {
    const T = "cancel-no-origin";
    await update(taskUpdate(T, { status: "working" }));
    await update(cancelUpdate(T, buyerKp, "user_requested"));
    expect(record(T).canceled_by).toMatchObject({ party: "requester", requester_request: null });
  });

  /** Make the ledger's reads of cancel requests (keys `c.`) fail or hang. */
  function breakCancelReads(how: "fail" | "hang") {
    const get = store.get.bind(store);
    const spy = vi.spyOn(store, "get").mockImplementation(async (k: string) => {
      if (!k.startsWith("c.")) return get(k);
      if (how === "fail") throw new Error("store unavailable");
      return new Promise<never>(() => {});
    });
    return () => spy.mockRestore();
  }

  const expectUnverified = (c: TaskCanceledBy | undefined, reason: string) => {
    const u = fixture.fields.canceled_by.unverified;
    expect(c).toBeDefined();
    expect(Object.keys(c!).sort()).toEqual([...u.required].sort());
    for (const k of u.absent) expect(c).not.toHaveProperty(k);
    expect(c).toMatchObject({ party: "responder", unverified: true, unverified_reason: reason });
    expect(Object.keys(u.unverified_reason)).toContain(reason);
  };

  it("a failed cancel-request read: unverified, never requester_request null", async () => {
    const T = "cancel-read-fails";
    await started(T);
    await tap(cancelRequest(T)); // the buyer did ask
    const restore = breakCancelReads("fail");
    nc.publish.mockClear();
    await update(cancelUpdate(T, sellerKp, "user_requested"));
    restore();
    expectUnverified(record(T).canceled_by, "read_failed");
    expect(record(T).state).toBe("canceled");
    expect(record(T).cancel_reason).toBe("user_requested");
    // The signed event and the receipt carry the same unknown.
    const bySubject = new Map(nc.publish.mock.calls.map((c) => [c[0] as string, decode(c[1] as Uint8Array)]));
    for (const subject of ["mesh.event.task.canceled", "mesh.event.metering.task_canceled"]) {
      const data = (bySubject.get(subject)!.payload as { data: { canceled_by?: TaskCanceledBy } }).data;
      expectUnverified(data.canceled_by, "read_failed");
    }
  });

  it("a cancel-request read that times out: unverified", async () => {
    const T = "cancel-read-hangs";
    await started(T);
    const restore = breakCancelReads("hang");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const done = update(cancelUpdate(T, sellerKp, "superseded"));
      await vi.advanceTimersByTimeAsync(CANCEL_READ_TIMEOUT_MS + 1);
      await done;
    } finally {
      vi.useRealTimers();
      restore();
    }
    expectUnverified(record(T).canceled_by, "read_timed_out");
  });

  it("a buyer's own cancel needs no read, so a broken ledger store leaves it verified", async () => {
    const T = "cancel-buyer-ledger-down";
    await started(T);
    const restore = breakCancelReads("fail");
    const env = cancelUpdate(T, buyerKp, "user_requested");
    await update(env);
    restore();
    expect(record(T).canceled_by).toMatchObject({ party: "requester", requester_request: { request_id: env.id, via: "update" } });
    expect(record(T).canceled_by).not.toHaveProperty("unverified");
  });

  it("unverified is settled in the background once the read succeeds, counting the buyer's earlier ask", async () => {
    const T = "cancel-settles";
    await started(T);
    const ask = cancelRequest(T);
    await tap(ask);
    const restore = breakCancelReads("fail");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await update(cancelUpdate(T, sellerKp, "user_requested"));
      expectUnverified(record(T).canceled_by, "read_failed");
      // Still failing at the first retry: stays unverified.
      await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_DELAYS_MS[0]! + 1);
      expectUnverified(record(T).canceled_by, "read_failed");
      restore();
      await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_DELAYS_MS[1]! + 1);
    } finally {
      vi.useRealTimers();
      restore();
    }
    const c = record(T).canceled_by!;
    expect(c).toMatchObject({ party: "responder", requester_request: { request_id: ask.id, via: "cancel_request" } });
    expect(c).not.toHaveProperty("unverified");
    expect(Object.keys(c).sort()).toEqual([...fixture.fields.canceled_by.required, "resolved_at"].sort());
  });

  it("settling ignores a cancel request observed after the transition", async () => {
    const T = "cancel-settles-late-ask";
    await started(T);
    const restore = breakCancelReads("fail");
    await update(cancelUpdate(T, sellerKp, "superseded"));
    restore();
    const at = Date.parse(record(T).canceled_by!.at);
    vi.useFakeTimers({ toFake: ["Date"], now: at + 1_000 });
    try {
      await tap(cancelRequest(T));
    } finally {
      vi.useRealTimers();
    }
    expect(await ledger.settleCanceledBy(T)).toBe("settled");
    expect(record(T).canceled_by).toMatchObject({ party: "responder", requester_request: null });
    expect(record(T).canceled_by).toHaveProperty("resolved_at");
    expect(await ledger.settleCanceledBy(T)).toBe("nothing");
  });

  it("a read of the record settles an unverified attribution on its copy, and shows it unverified while the store still fails", async () => {
    const T = "cancel-view-settles";
    await started(T);
    const ask = cancelRequest(T);
    await tap(ask);
    const restore = breakCancelReads("fail");
    await update(cancelUpdate(T, sellerKp, "user_requested"));
    const stored = record(T) as unknown as Record<string, unknown>;
    expect(((await ledger.view(stored, T)) as { canceled_by?: TaskCanceledBy }).canceled_by).toMatchObject({ unverified: true });
    restore();
    const seen = (await ledger.view(stored, T)) as { canceled_by?: TaskCanceledBy };
    expect(seen.canceled_by).toMatchObject({ requester_request: { request_id: ask.id, via: "cancel_request" } });
    expect(record(T).canceled_by).toMatchObject({ unverified: true }); // the view writes nothing
  });

  it("the canceled event and the §19.2 receipt carry canceled_by", async () => {
    const T = "cancel-event";
    await started(T);
    nc.publish.mockClear();
    await update(cancelUpdate(T, sellerKp, "user_requested"));
    const bySubject = new Map(
      nc.publish.mock.calls.map((c) => [c[0] as string, decode(c[1] as Uint8Array)]),
    );
    for (const subject of ["mesh.event.task.canceled", "mesh.event.metering.task_canceled"]) {
      const data = (bySubject.get(subject)!.payload as { data: { canceled_by?: TaskCanceledBy } }).data;
      expect(data.canceled_by).toMatchObject({ party: "responder", requester_request: null });
    }
  });
});

describe("only a request's first answer may bind it", () => {
  /** A bare, terminal answer: no task id (mesh.ts synchronous completion). */
  const bareAnswer = (req: Envelope) =>
    sign(sellerKp, { type: "respond", from: SELLER, to: BUYER, in_reply_to: req.id, payload: { status: "completed", output: 1 } });

  it("the probe: an old, closed request cannot become a new task's origin", async () => {
    const T = "task-probe";
    const r1 = request({ input: { text: "cheap, done long ago" } });
    await tap(r1);
    await tap(bareAnswer(r1)); // R1 completes with no task
    const r2 = request({ input: { text: "the real work" } });
    await tap(r2);
    // The provider's extra respond binds nothing, and is evidence.
    expect(await tap(answer(r1, T, "working"))).toBe("contested");
    await tap(answer(r2, T, "working"));
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, r2, "answer");
    expect(record(T).origin!.contested_by).toEqual([r1.id]);
  });

  it("the probe with the extra respond repeated around the real answer: T still goes to R2", async () => {
    const T = "task-probe-order";
    const r1 = request();
    await tap(r1);
    await tap(bareAnswer(r1));
    const r2 = request();
    await tap(r2);
    await tap(answer(r1, T, "working"));
    await tap(answer(r2, T, "working"));
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, r2, "answer");
    expect(record(T).origin!.contested_by).toEqual([r1.id]);
  });

  it("a refusal closes the request too", async () => {
    const T = "task-after-refusal";
    const r1 = request();
    await tap(r1);
    await tap(sign(sellerKp, {
      type: "respond", from: SELLER, to: BUYER, in_reply_to: r1.id,
      error: { code: "UNAUTHORIZED", message: "no", retryable: false }, payload: { status: "failed" },
    }));
    expect(await tap(answer(r1, T, "working"))).toBe("contested");
    await update(taskUpdate(T, { status: "failed" }));
    // No origin, and the evidence on the record itself.
    expect(record(T).origin).toBeUndefined();
    expect((record(T) as { contested_by?: string[] }).contested_by).toEqual([r1.id]);
  });

  it("an inbox-mode answer closes the request", async () => {
    const r1 = request();
    await tap(r1);
    await tap(sign(sellerKp, {
      type: "request", from: SELLER, to: BUYER, in_reply_to: r1.id, payload: { offering: "reply", input: "done" },
    }));
    expect(await tap(answer(r1, "task-after-inbox-answer", "working"))).toBe("contested");
  });

  it("an accept signal is not the first answer", async () => {
    const T = "task-after-accept";
    const r1 = request();
    await tap(r1);
    await tap(sign(sellerKp, { type: "respond", from: SELLER, to: BUYER, in_reply_to: r1.id, payload: { status: "accepted" } }));
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    expectOrigin(T, r1, "answer");
  });

  it("a first answer with one task id: a later answer naming another binds nothing", async () => {
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, "task-first", "working"));
    expect(await tap(answer(r1, "task-second", "working"))).toBe("contested");
    // The first answer's own task keeps answering normally.
    expect(await tap(answer(r1, "task-first", "input_required"))).toBe("recorded");
  });

  it("only the requester's inbox counts: an outbox-only copy is not observed", async () => {
    const T = "task-outbox-only";
    const r1 = request();
    await tap(r1);
    // The provider writes an answer only to its own outbox mirror.
    expect(await ledger.observe(decode(encode(answer(r1, T, "working"))), SELLER)).toBe("ignored");
    await tap(bareAnswer(r1)); // what the buyer actually received
    await update(taskUpdate(T, { status: "failed" }));
    expect(record(T).origin).toBeUndefined();
  });
});

describe("the tap's plumbing (origin-tap.ts)", () => {
  const inbox = (env: Envelope) => [`mesh.agent.${env.to}.inbox`, encode(env)] as const;

  it("an answer that arrives before its request is retried on a backoff, after the request", async () => {
    const tapper = new OriginTap(ledger, { retryDelaysMs: [5, 10, 20] });
    const T = "task-tap-order";
    const r1 = request();
    await tapper.push(...inbox(answer(r1, T, "working")));
    await tapper.push(...inbox(r1));
    await tapper.drain();
    await update(taskUpdate(T, { status: "working" }));
    expectOrigin(T, r1, "answer");
  });

  it("an answer whose request never arrives is counted and logged as missed", async () => {
    flushOriginMisses();
    const tapper = new OriginTap(ledger, { retryDelaysMs: [1, 1] });
    await tapper.push(...inbox(answer(request(), "task-tap-lost", "working")));
    await tapper.drain();
    expect(flushOriginMisses()).toMatchObject({ unknown_request: 1 });
  });

  it("answers to one request are judged in arrival order, the first one winning", async () => {
    const tapper = new OriginTap(ledger, { retryDelaysMs: [1] });
    const r1 = request();
    await tapper.push(...inbox(r1));
    await tapper.push(...inbox(answer(r1, "task-tap-a", "working")));
    await tapper.push(...inbox(answer(r1, "task-tap-b", "working")));
    await tapper.drain();
    await update(taskUpdate("task-tap-a", { status: "working" }));
    await update(taskUpdate("task-tap-b", { status: "working" }));
    expectOrigin("task-tap-a", r1, "answer");
    expect(record("task-tap-b").origin).toBeUndefined();
  });

  it("at its in-flight bound the tap stops taking messages and says so", async () => {
    flushOriginMisses();
    const tapper = new OriginTap(ledger, { maxInFlight: 2 });
    for (let i = 0; i < 5; i++) await tapper.push(...inbox(request()));
    await tapper.drain();
    expect(flushOriginMisses().backlog).toBeGreaterThan(0);
  });

  it("ignores what is not an agent's inbox", () => {
    expect(inboxAgentOf("mesh.agent.ABC.inbox")).toBe("ABC");
    expect(inboxAgentOf("mesh.agent.ABC.outbox")).toBeNull();
    expect(inboxAgentOf("mesh.agent.ABC.inbox.guarded")).toBeNull();
  });

  it("a task that ends with no origin is counted", async () => {
    flushOriginMisses();
    await update(taskUpdate("task-ends-bare", { status: "working" }));
    await update(taskUpdate("task-ends-bare", { status: "completed" }));
    expect(flushOriginMisses()).toMatchObject({ terminal_without_origin: 1 });
  });
});

describe("other writers keep an attached origin", () => {
  it("the overdue sweep writes against the stored record, not its snapshot", async () => {
    const T = "task-overdue-origin";
    const req = request({ taskId: T });
    await update(taskUpdate(T, { status: "working" }));
    const r = JSON.parse(tasks.map.get(T)!.v);
    r.budget = { revision: 0, deadline: new Date(Date.now() - 3600_000).toISOString() };
    await tasks.put(T, JSON.stringify(r));
    // The sweep's snapshot is taken BEFORE the origin attaches.
    const snapshot = new Map([[T, { json: <U>() => JSON.parse(JSON.stringify(r)) as U }]]);
    await open(req); // attaches by compare-and-set
    const sweep = new OverdueSweep(nc as never, undefined as never, tasks, tmKp, async () => snapshot);
    expect(await sweep.sweep()).toEqual([T]);
    expect(record(T)).toMatchObject({ overdue: true });
    expectOrigin(T, req, "request");
  });

  it("a stranded-delegate flag keeps the child's origin", async () => {
    const PARENT = "task-parent";
    const CHILD = "task-child";
    // The parent: the buyer asked the seller. The child: the seller asked the stranger.
    await open(request({ taskId: PARENT }));
    await update(taskUpdate(PARENT, { status: "working" }, { extra: { context_id: "ctx-1" } }));
    const childReq = request({ taskId: CHILD, from: sellerKp, to: STRANGER });
    const childUpdate = createEnvelope({
      type: "respond", from: STRANGER, to: SELLER, task_id: CHILD, context_id: "ctx-1", payload: { status: "working" },
    });
    await update(signEnvelope(childUpdate, strangerKp));
    const snapshot = new Map([...tasks.map].map(([k, v]) => [k, { json: <U>() => JSON.parse(v.v) as U }]));
    await ledger.observe(decode(encode(childReq)), STRANGER);
    // The child's provider opens it: that answer attaches after the snapshot.
    await ledger.observe(decode(encode(answer(childReq, CHILD, "working", strangerKp, SELLER))), SELLER);
    await handleTaskUpdate(
      {
        subject: `mesh.task.${PARENT}.update`,
        data: encode(taskUpdate(PARENT, { status: "canceled", reason: "user_requested" }, { kp: buyerKp })),
      } as never,
      tasks, nc as never, tmKp, async () => snapshot, undefined, ledger,
    );
    const child = JSON.parse(tasks.map.get(CHILD)!.v);
    expect(child.stranded).toBe(true);
    expect(child.origin?.request_id).toBe(childReq.id);
  });
});

describe("re-review: contested bindings, delivery signals, storage, hot path", () => {
  const accept = (req: Envelope) =>
    sign(sellerKp, { type: "respond", from: SELLER, to: BUYER, in_reply_to: req.id, payload: { status: "accepted" } });
  const queuedAck = (req: Envelope) =>
    sign(sellerKp, {
      type: "respond", from: SELLER, to: BUYER, in_reply_to: req.id,
      payload: { status: "completed", output: { queued: true, inbox_id: "inbox-123" } },
    });

  it("an old request that only got an accept, bound first: it stays the origin, and the real request is listed", async () => {
    flushOriginMisses();
    const T = "task-contested";
    const r1 = request();
    await tap(r1);
    await tap(accept(r1)); // the buyer timed out waiting
    const r2 = request();
    await tap(r2);
    await tap(answer(r1, T, "working")); // the provider binds T to the old R1...
    expect(await tap(answer(r2, T, "working"))).toBe("contested"); // ...then answers R2 with T
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, r1, "answer");
    // R2 is on the record, so a refund of the origin covers it as well.
    expect(record(T).origin!.contested_by).toEqual([r2.id]);
    expect(flushOriginMisses()).toMatchObject({ contested: 1 });
  });

  it("the other order: the first binding stands, and the late request is listed", async () => {
    const T = "task-contested-late";
    const r2 = request();
    await tap(r2);
    await tap(answer(r2, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    const r1 = request();
    await tap(r1);
    expect(await tap(answer(r1, T, "working"))).toBe("contested");
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, r2, "answer");
    expect(record(T).origin!.contested_by).toEqual([r1.id]);
  });

  it("a stale copy written after a contest cannot drop the contest at the end", async () => {
    const T = "task-contested-stale";
    const r2 = request();
    await tap(r2);
    await tap(answer(r2, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    const stale = tasks.map.get(T)!; // a copy read before the contest
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    tasks.map.set(T, { v: stale.v, rev: 9_999 }); // written back by a racing writer
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, r2, "answer");
    // The binding still lists the contest, and a lookup returns it.
    expect((await ledger.evidenceFor(BUYER, SELLER, T))!.contested_by).toEqual([r1.id]);
    expect(record(T).origin!.contested_by).toEqual([r1.id]);
  });

  it("the handler's write never loses a contest appended after it read the record", async () => {
    const T = "task-contest-race";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    // The handler reads the record, then the tap appends a contest, then the
    // handler writes: compare-and-set takes the stored origin over.
    const realGet = tasks.get.bind(tasks);
    let raced = false;
    tasks.get = async (k: string) => {
      const e = await realGet(k);
      if (!raced && k === T) {
        raced = true;
        const r2 = request();
        await tap(r2);
        await tap(answer(r2, T, "working"));
      }
      return e;
    };
    await update(taskUpdate(T, { status: "failed" }));
    tasks.get = realGet;
    expect(record(T).state).toBe("failed");
    expect(record(T).origin!.contested_by).toHaveLength(1);
  });

  it("Q3 padding: contested_by holds 256; past that the rest are counted, and when the first did not fit", async () => {
    const T = "task-many-contests";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    const startedAt = Date.now();
    for (let i = 0; i < 260; i++) {
      const r = request();
      await tap(r);
      await tap(answer(r, T, "working"));
    }
    const o = record(T).origin! as TaskOrigin;
    expect(o.contested_by).toHaveLength(256);
    expect(o.contested_overflow).toBe(4);
    expect(Date.parse(o.contested_overflow_since!)).toBeGreaterThanOrEqual(startedAt - 1000);
    expectOrigin(T, r1, "answer");
  });

  // The probes from the re-review: none of them may strip or move an origin.
  it("P1: a follow-up request answered with the live task id leaves the origin, listed", async () => {
    const T = "task-p1";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    const followUp = request({ input: { text: "and also" } });
    await tap(followUp);
    expect(await tap(answer(followUp, T, "working"))).toBe("contested");
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, r1, "answer");
    expect(record(T).origin!.contested_by).toEqual([followUp.id]);
  });

  it("P2: an old queued-acked request, older than the task, cannot strip the origin", async () => {
    const T = "task-p2";
    const old = request();
    await tap(old);
    await tap(queuedAck(old)); // held, never really answered
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    expect(await tap(answer(old, T, "working"))).toBe("contested");
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, r1, "answer");
    expect(record(T).origin!.contested_by).toEqual([old.id]);
  });

  it("P3: a stream task bound by its request cannot be stripped", async () => {
    const T = "task-p3";
    const s1 = request({ taskId: T });
    await open(s1);
    await update(taskUpdate(T, { status: "working" }));
    const other = request();
    await tap(other);
    expect(await tap(answer(other, T, "working"))).toBe("contested");
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, s1, "request");
    expect(record(T).origin!.contested_by).toEqual([other.id]);
  });

  it("P4 / Q2: a terminal record's origin keeps every field, and gains the contest append-only", async () => {
    const T = "task-p4";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "failed" }));
    const before = record(T).origin!;
    const late = request();
    await tap(late);
    expect(await tap(answer(late, T, "working"))).toBe("contested");
    expect(record(T).state).toBe("failed");
    expect(record(T).origin).toEqual({ ...before, contested_by: [late.id] });
  });

  it("P5: a buyer's cancel keeps its attribution and the origin through a contest", async () => {
    const T = "task-p5";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "input_required"));
    await update(taskUpdate(T, { status: "input_required", message: "?" }));
    const cancelEnv = taskUpdate(T, { status: "canceled", reason: "user_requested" }, { kp: buyerKp });
    await update(cancelEnv);
    const late = request();
    await tap(late);
    await tap(answer(late, T, "working"));
    expectOrigin(T, r1, "answer");
    expect(record(T).canceled_by).toMatchObject({ party: "requester", requester_request: { request_id: cancelEnv.id, via: "update" } });
  });

  it("a resume is not a contest", async () => {
    const T = "task-resume-not-contest";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "input_required"));
    await update(taskUpdate(T, { status: "input_required", message: "?" }));
    const resume = request({ taskId: T, resume: true });
    await tap(resume);
    expect(await tap(answer(resume, T, "working"))).toBe("recorded");
    expectOrigin(T, r1, "answer");
  });

  for (const path of ["a door hold", "an attended session", "a mailbox"]) {
    it(`a queued acknowledgement (${path}) does not close the request: the later task answer binds`, async () => {
      const T = `task-held-${path.replace(/\W+/g, "-")}`;
      const r1 = request();
      await tap(r1);
      expect(await tap(queuedAck(r1))).toBe("ignored");
      await tap(answer(r1, T, "input_required"));
      await update(taskUpdate(T, { status: "input_required", message: "?" }));
      expectOrigin(T, r1, "answer");
    });
  }

  it("an inbox-mode answer seen before its request is retried, and closes the request", async () => {
    const tapper = new OriginTap(ledger, { retryDelaysMs: [5, 10, 20] });
    const inbox = (env: Envelope) => [`mesh.agent.${env.to}.inbox`, encode(env)] as const;
    const r1 = request();
    const inboxAnswer = sign(sellerKp, {
      type: "request", from: SELLER, to: BUYER, in_reply_to: r1.id, payload: { offering: "reply", input: "done" },
    });
    await tapper.push(...inbox(inboxAnswer));
    await tapper.push(...inbox(r1));
    await tapper.drain();
    expect(await tap(answer(r1, "task-after-early-inbox-answer", "working"))).toBe("contested");
  });

  it("an inbox-mode answer is not stored as a request of its own", async () => {
    const r1 = request();
    await tap(r1);
    const inboxAnswer = sign(sellerKp, {
      type: "request", from: SELLER, to: BUYER, in_reply_to: r1.id, payload: { offering: "reply", input: "done" },
    });
    await tap(inboxAnswer);
    expect(store.map.has(requestKey(inboxAnswer.id))).toBe(false);
  });

  for (const offering of ["describe", "knock", "__registry_probe__"]) {
    it(`a ${offering} exchange stores nothing`, async () => {
      const r = request({ offering });
      const before = store.map.size;
      await tap(r);
      await tap(sign(sellerKp, { type: "respond", from: SELLER, to: BUYER, in_reply_to: r.id, payload: { status: "completed", output: {} } }));
      expect(store.map.size).toBe(before);
    });
  }

  it("an update to a task that has its origin reads the record once (no extra read)", async () => {
    const T = "task-hot-path";
    const req = request({ taskId: T });
    await open(req);
    await update(taskUpdate(T, { status: "working" }));
    expectOrigin(T, req, "request");
    const get = vi.spyOn(tasks, "get");
    await update(taskUpdate(T, { status: "input_required", message: "?" }));
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("an inbox-mode answer whose request never shows up", () => {
  it("is recorded as an ordinary request after the last retry, and counted as a miss", async () => {
    flushOriginMisses();
    const tapper = new OriginTap(ledger, { retryDelaysMs: [1, 1] });
    const stray = sign(sellerKp, {
      type: "request", from: SELLER, to: BUYER, in_reply_to: "a-request-nobody-saw", payload: { offering: "reply", input: "hi" },
    });
    await tapper.push(`mesh.agent.${BUYER}.inbox`, encode(stray));
    await tapper.drain();
    expect(store.map.has(requestKey(stray.id))).toBe(true);
    expect(flushOriginMisses()).toMatchObject({ unknown_request: 1 });
  });
});

describe("round 4: contest evidence is never dropped or hidden", () => {
  it("Q1 burst: twelve contests at once are all recorded", async () => {
    const T = "task-burst";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    const rivals = Array.from({ length: 12 }, () => request());
    for (const r of rivals) await tap(r);
    // All answered at once, racing on the same evidence and the same record.
    const outcomes = await Promise.all(rivals.map((r) => tap(answer(r, T, "working"))));
    expect(outcomes.every((o) => o === "contested")).toBe(true);
    expect([...record(T).origin!.contested_by!].sort()).toEqual(rivals.map((r) => r.id).sort());
    expect([...(await ledger.evidenceFor(BUYER, SELLER, T))!.contested_by].sort()).toEqual(rivals.map((r) => r.id).sort());
  });

  it("Q1 burst, with updates racing too: the handler's writes keep every contest", async () => {
    const T = "task-burst-updates";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    const rivals = Array.from({ length: 12 }, () => request());
    for (const r of rivals) await tap(r);
    await Promise.all([
      ...rivals.map((r) => tap(answer(r, T, "working"))),
      update(taskUpdate(T, { status: "input_required", message: "?" })),
    ]);
    await update(taskUpdate(T, { status: "working" }));
    expect(record(T).origin!.contested_by).toHaveLength(12);
  });

  it("a record that lost its contests repairs itself on the next update", async () => {
    const T = "task-repair";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    const r2 = request();
    await tap(r2);
    await tap(answer(r2, T, "working"));
    const r = JSON.parse(tasks.map.get(T)!.v);
    delete r.origin.contested_by; // a record-side loss
    tasks.map.set(T, { v: JSON.stringify(r), rev: 77_777 });
    await update(taskUpdate(T, { status: "completed" }));
    expect(record(T).origin!.contested_by).toEqual([r2.id]);
  });

  it("Q4 late: a first answer seen long after the task existed is evidence, with no origin", async () => {
    const T = "task-q4";
    // The provider creates the record naming the buyer, with nothing bound...
    await update(taskUpdate(T, { status: "working" }));
    const r = JSON.parse(tasks.map.get(T)!.v);
    r.created_at = new Date(Date.now() - ORIGIN_SKEW_MS - 5_000).toISOString();
    tasks.map.set(T, { v: JSON.stringify(r), rev: 88_888 });
    // ...then, more than a minute on, answers the buyer's real request with T.
    const real = request();
    await tap(real);
    expect(await tap(answer(real, T, "working"))).toBe("contested");
    expect(record(T).origin).toBeUndefined();
    expect((record(T) as { contested_by?: string[] }).contested_by).toEqual([real.id]);
    await update(taskUpdate(T, { status: "failed" }));
    expect((record(T) as { contested_by?: string[] }).contested_by).toEqual([real.id]);
  });

  it("Q4 late, but a genuine resume: not evidence", async () => {
    const T = "task-q4-resume";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "input_required"));
    await update(taskUpdate(T, { status: "input_required", message: "?" }));
    const r = JSON.parse(tasks.map.get(T)!.v);
    r.created_at = new Date(Date.now() - ORIGIN_SKEW_MS - 5_000).toISOString();
    tasks.map.set(T, { v: JSON.stringify(r), rev: 99_999 });
    const resume = request({ taskId: T, resume: true });
    await tap(resume);
    await tap(answer(resume, T, "working"));
    expect(record(T).origin!.contested_by).toBeUndefined();
  });

  it("Q5 stream race: a stream naming a task an answer already bound is the requester's choice, not evidence", async () => {
    const T = "task-q5";
    const r0 = request();
    await tap(r0);
    await tap(answer(r0, T, "working")); // the provider binds the stream's id to an old request first
    const stream = request({ taskId: T, input: { stream: true } });
    stream.payload = { ...(stream.payload as object), config: { stream: true } };
    signEnvelope(stream, buyerKp);
    expect(await open(stream)).not.toBe("contested");
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, r0, "answer");
    expect(record(T).origin!.contested_by).toBeUndefined();
  });

  it("Q5, but a stream that bound its own task first: an answer naming it is the contest", async () => {
    const T = "task-q5-own";
    const stream = request({ taskId: T });
    await open(stream);
    const other = request();
    await tap(other);
    await tap(answer(other, T, "working"));
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, stream, "request");
    expect(record(T).origin!.contested_by).toEqual([other.id]);
  });
});

describe("round 5", () => {
  type Loose = {
    contested_by?: string[];
    contested_overflow?: number;
    origin_mismatch?: { requester: string };
    contested_by_asker?: Record<string, { contested_by: string[] }>;
  };

  it("1. the tap never waits on a record that does not exist yet", async () => {
    const T = "task-no-record-yet";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    const rival = request();
    await tap(rival);
    const started = Date.now();
    expect(await tap(answer(rival, T, "working"))).toBe("contested");
    expect(Date.now() - started).toBeLessThan(25);
    // The record created afterwards still gets it, from the ledger.
    await update(taskUpdate(T, { status: "failed" }));
    expect(record(T).origin!.contested_by).toEqual([rival.id]);
  });

  it("1. the update handler re-reads the evidence after it creates the record", async () => {
    const T = "task-born-terminal-handler";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    const rival = request();
    await tap(rival);
    // The evidence is written between the handler's read and its create.
    const realCreate = tasks.create.bind(tasks);
    tasks.create = async (k: string, v: Uint8Array | string) => {
      if (k === T) {
        tasks.create = realCreate;
        const quiet = new OriginLedger(store, memKeyed()); // its mirror finds no record and gives up
        await quiet.observe(decode(encode(answer(rival, T, "working"))), BUYER);
      }
      return realCreate(k, v);
    };
    await update(taskUpdate(T, { status: "failed" }));
    expect(record(T).origin!.contested_by).toEqual([rival.id]);
  });

  it("2. a record naming a stranger still carries the buyer's request, and the mismatch", async () => {
    const T = "task-stranger-named";
    const real = request();
    await tap(real);
    await tap(answer(real, T, "working"));
    await update(taskUpdate(T, { status: "failed" }, { to: STRANGER }));
    const r = record(T) as ReturnType<typeof record> & Loose;
    expect(r.requester).toBe(STRANGER);
    expect(r.origin).toBeUndefined();
    // Kept under the asker the server saw, apart from the record's own requester's.
    expect(r.contested_by).toBeUndefined();
    expect(r.contested_by_asker).toEqual({ [BUYER]: { contested_by: [real.id] } });
    expect(r.origin_mismatch).toEqual({ requester: BUYER });
  });

  it("2. the same, when the record exists before the buyer's request is answered", async () => {
    const T = "task-stranger-first";
    await update(taskUpdate(T, { status: "working" }, { to: STRANGER }));
    const real = request();
    await tap(real);
    await tap(answer(real, T, "working"));
    const r = record(T) as ReturnType<typeof record> & Loose;
    expect(r.contested_by_asker).toEqual({ [BUYER]: { contested_by: [real.id] } });
    expect(r.origin_mismatch).toEqual({ requester: BUYER });
  });

  it("2. a third party's own stream naming the task id puts nothing on the buyer's record", async () => {
    const T = "task-third-party";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    await tap(request({ taskId: T, from: strangerKp }));
    await update(taskUpdate(T, { status: "failed" }));
    const r = record(T) as ReturnType<typeof record> & Loose;
    expect(r.origin_mismatch).toBeUndefined();
    expect(r.contested_by).toBeUndefined();
    expect(r.origin!.contested_by).toBeUndefined();
  });

  it("3. a second stream naming its own stream-bound task is part of that task, not evidence", async () => {
    const T = "task-two-streams";
    const s1 = request({ taskId: T });
    await open(s1);
    await update(taskUpdate(T, { status: "working" }));
    const s2 = request({ taskId: T });
    expect(await open(s2)).not.toBe("contested");
    expectOrigin(T, s1, "request");
    expect(record(T).origin!.contested_by).toBeUndefined();
    expect((record(T).origin as { multiple_requests?: string[] }).multiple_requests).toEqual([s1.id, s2.id]);
  });

  it("3. a non-stream naming its own task before the record exists is not evidence", async () => {
    const T = "task-early-follow-up";
    const s1 = request({ taskId: T });
    await open(s1);
    const early = request({ taskId: T, resume: true });
    expect(await open(early)).not.toBe("contested");
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, s1, "request");
    expect(record(T).origin!.contested_by).toBeUndefined();
    expect((record(T).origin as { multiple_requests?: string[] }).multiple_requests).toEqual([s1.id, early.id]);
  });

  it("3. the rule does not flip after a minute: a late second stream on its own task is not evidence either", async () => {
    const T = "task-late-stream";
    const s1 = request({ taskId: T });
    await open(s1);
    await update(taskUpdate(T, { status: "working" }));
    const r = JSON.parse(tasks.map.get(T)!.v);
    r.created_at = new Date(Date.now() - ORIGIN_SKEW_MS - 5_000).toISOString();
    tasks.map.set(T, { v: JSON.stringify(r), rev: 123_456 });
    const s2 = request({ taskId: T });
    expect(await open(s2)).not.toBe("contested");
    expect(record(T).origin!.contested_by).toBeUndefined();
  });

  it("4. a request past the cap seen twice is counted once", async () => {
    const T = "task-overflow-exact";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    for (let i = 0; i < 256; i++) {
      const r = request();
      await tap(r);
      await tap(answer(r, T, "working"));
    }
    const extra = request();
    await tap(extra);
    const a = answer(extra, T, "working");
    await tap(a);
    await tap(a); // the same answer, seen again (another instance, a redelivery)
    await tap(answer(extra, T, "input_required")); // and a second answer to it
    expect(record(T).origin!.contested_overflow).toBe(1);
  });
});

describe("round 6", () => {
  type Loose = {
    contested_by?: string[];
    origin_mismatch?: { requester: string };
    contested_by_asker?: Record<string, { contested_by: string[] }>;
  };

  it("probe 1: a request naming the buyer's failed task, run as fresh work, is not listed on it", async () => {
    const T = "task-probe1";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "failed" }));
    // The buyer names T again; the provider runs it fresh under U, which completes.
    const again = request({ taskId: T });
    await tap(again);
    await tap(answer(again, "task-probe1-fresh", "working"));
    await update(taskUpdate("task-probe1-fresh", { status: "completed" }));
    expect(record(T).origin!.contested_by).toBeUndefined();
    expectOrigin(T, r1, "answer");
  });

  it("probe 1b: a request that only names the task, with no answer under it, puts nothing on it", async () => {
    const T = "task-probe1b";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    for (const r of [request({ taskId: T }), request({ taskId: T, resume: true })]) {
      await tap(r);
      await tap(sign(sellerKp, { type: "respond", from: SELLER, to: BUYER, in_reply_to: r.id, payload: { status: "completed", output: 1 } }));
    }
    await update(taskUpdate(T, { status: "failed" }));
    expect(record(T).origin!.contested_by).toBeUndefined();
    expect((record(T) as Loose).contested_by).toBeUndefined();
  });

  it("a stream naming its own paused task, answered under it, is a resume: not listed", async () => {
    const T = "task-stream-resumed";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "input_required"));
    await update(taskUpdate(T, { status: "input_required", message: "?" }));
    const s2 = request({ taskId: T });
    expect(await open(s2)).not.toBe("contested");
    expect(record(T).origin!.contested_by).toBeUndefined();
  });

  it("another asker's requests never move into the record requester's origin", async () => {
    const T = "task-no-mixing";
    // The provider names a sock puppet as the record's requester...
    await update(taskUpdate(T, { status: "working" }, { to: STRANGER }));
    // ...answers the real buyer with T...
    const real = request();
    await tap(real);
    await tap(answer(real, T, "working"));
    // ...and then binds T to a request from the puppet itself.
    const puppet = sign(strangerKp, {
      type: "request", from: STRANGER, to: SELLER, payload: { offering: "summarize", input: {} },
    });
    await ledger.observe(decode(encode(puppet)), SELLER);
    await ledger.observe(decode(encode(answer(puppet, T, "working", sellerKp, STRANGER))), STRANGER);
    await update(taskUpdate(T, { status: "failed" }, { to: STRANGER }));
    const r = record(T) as ReturnType<typeof record> & Loose;
    expect(r.origin!.request_id).toBe(puppet.id);
    expect(r.origin!.contested_by).toBeUndefined();
    expect(r.contested_by_asker).toEqual({ [BUYER]: { contested_by: [real.id] } });
    expect(r.origin_mismatch).toEqual({ requester: BUYER });
  });

  it("two other askers are kept apart", async () => {
    const T = "task-two-askers";
    await update(taskUpdate(T, { status: "working" }, { to: STRANGER }));
    const third = nkeys.createUser();
    const a1 = request();
    await tap(a1);
    await tap(answer(a1, T, "working"));
    const a2 = sign(third, { type: "request", from: third.getPublicKey(), to: SELLER, payload: { offering: "summarize", input: {} } });
    await ledger.observe(decode(encode(a2)), SELLER);
    await ledger.observe(decode(encode(answer(a2, T, "working", sellerKp, third.getPublicKey()))), third.getPublicKey());
    const r = record(T) as ReturnType<typeof record> & Loose;
    expect(r.contested_by_asker).toEqual({
      [BUYER]: { contested_by: [a1.id] },
      [third.getPublicKey()]: { contested_by: [a2.id] },
    });
  });
});

describe("round 7: only provider-caused evidence counts; askers capped; privacy; read-time projection", () => {
  type Loose = {
    contested_by?: string[];
    origin_mismatch?: { requester: string };
    contested_by_asker?: Record<string, { contested_by: string[] }>;
    askers_overflow?: number;
    askers_overflow_since?: string;
  };
  const strangerStream = (T: string) => request({ taskId: T, from: strangerKp });
  const answerTo = (req: Envelope, T: string) => answer(req, T, "working", sellerKp, req.from);
  const tapStranger = (env: Envelope) => ledger.observe(decode(encode(env)), env.to ?? "");

  async function buyersTask(T: string) {
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "working"));
    await update(taskUpdate(T, { status: "working" }));
    return r1;
  }

  it("probe A: the buyer naming its own task, answered under it, adds nothing", async () => {
    const T = "task-r7-a";
    const r1 = await buyersTask(T);
    for (const r of [request({ taskId: T }), request({ taskId: T, resume: true })]) {
      await tap(r);
      expect(await tap(answer(r, T, "working"))).not.toBe("contested");
    }
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, r1, "answer");
    expect(record(T).origin!.contested_by).toBeUndefined();
  });

  it("probe B: a stranger naming the buyer's task, answered under it, records nothing on it", async () => {
    flushOriginMisses();
    const T = "task-r7-b";
    const r1 = await buyersTask(T);
    const s = strangerStream(T);
    await tapStranger(s);
    expect(await ledger.observe(decode(encode(answerTo(s, T))), STRANGER)).toBe("ignored");
    await update(taskUpdate(T, { status: "failed" }));
    const r = record(T) as ReturnType<typeof record> & Loose;
    expectOrigin(T, r1, "answer");
    expect(r.origin!.contested_by).toBeUndefined();
    expect(r.origin_mismatch).toBeUndefined();
    expect(r.contested_by_asker).toBeUndefined();
    expect(flushOriginMisses()).toMatchObject({ foreign_task_named: 1 });
  });

  it("probe C: the provider answers a stranger's stream under the buyer's task while the task manager is down", async () => {
    // #41's unconfirmed stream path: the provider could not read the record,
    // so it answered the stream under the id it named. The tap still sees it
    // after the task manager is back; nothing lands on the buyer's record.
    const T = "task-r7-c";
    const r1 = await buyersTask(T);
    const s = strangerStream(T);
    const opening = answerTo(s, T);
    // Observed late, in a burst, as a tap catching up would.
    await tapStranger(s);
    await ledger.observe(decode(encode(opening)), STRANGER);
    await ledger.observe(decode(encode(opening)), STRANGER);
    await update(taskUpdate(T, { status: "failed" }));
    const r = record(T) as ReturnType<typeof record> & Loose;
    expectOrigin(T, r1, "answer");
    expect(r.origin!.contested_by).toBeUndefined();
    expect(r.origin_mismatch).toBeUndefined();
    expect(r.contested_by_asker).toBeUndefined();
  });

  it("evidence still comes from a request that did NOT name the task, answered under it", async () => {
    const T = "task-r7-evidence";
    const r1 = await buyersTask(T);
    const other = request();
    await tap(other);
    expect(await tap(answer(other, T, "working"))).toBe("contested");
    expectOrigin(T, r1, "answer");
    expect(record(T).origin!.contested_by).toEqual([other.id]);
  });

  it("askers past 64 are counted, with when the first did not fit", async () => {
    const T = "task-r7-askers";
    await update(taskUpdate(T, { status: "working" }, { to: STRANGER }));
    const askers = Array.from({ length: 66 }, () => nkeys.createUser());
    for (const kp of askers) {
      const r = sign(kp, { type: "request", from: kp.getPublicKey(), to: SELLER, payload: { offering: "summarize", input: {} } });
      await ledger.observe(decode(encode(r)), SELLER);
      await ledger.observe(decode(encode(answer(r, T, "working", sellerKp, kp.getPublicKey()))), kp.getPublicKey());
    }
    // One asker seen again: still counted once.
    await update(taskUpdate(T, { status: "failed" }, { to: STRANGER }));
    const r = record(T) as ReturnType<typeof record> & Loose;
    expect(Object.keys(r.contested_by_asker!)).toHaveLength(64);
    expect(r.askers_overflow).toBe(2);
    expect(Number.isFinite(Date.parse(r.askers_overflow_since!))).toBe(true);
  });

  async function get(kp: Kp, T: string) {
    const env = sign(kp, { type: "request", from: kp.getPublicKey(), to: "task-manager", payload: { task_id: T } });
    const resp = await handleTaskGet(env, { subject: `mesh.task.get.${T}` } as never, tasks, "task-manager", ledger);
    return resp.payload as Record<string, unknown> & Loose & { origin?: TaskOrigin };
  }

  it("task-get: the requester sees only its own entries, the responder sees all", async () => {
    const T = "task-r7-privacy";
    // The record names a puppet as requester; the real buyer was answered too.
    await update(taskUpdate(T, { status: "working" }, { to: STRANGER }));
    const real = request();
    await tap(real);
    await tap(answer(real, T, "working"));
    const asRequester = await get(strangerKp, T);
    expect(asRequester.requester).toBe(STRANGER);
    expect(asRequester.contested_by_asker).toBeUndefined();
    expect(asRequester.origin_mismatch).toBeUndefined();
    const asResponder = await get(sellerKp, T);
    expect(asResponder.contested_by_asker).toEqual({ [BUYER]: { contested_by: [real.id] } });
    expect(asResponder.origin_mismatch).toEqual({ requester: BUYER });
  });

  it("task-get: a requester's own origin and contests are shown to it", async () => {
    const T = "task-r7-own";
    const r1 = await buyersTask(T);
    const other = request();
    await tap(other);
    await tap(answer(other, T, "working"));
    const asRequester = await get(buyerKp, T);
    expect(asRequester.origin!.request_id).toBe(r1.id);
    expect(asRequester.origin!.contested_by).toEqual([other.id]);
  });

  it("task-get and the privileged read show evidence whose mirror was lost", async () => {
    const T = "task-r7-lost-mirror";
    const r1 = await buyersTask(T);
    await update(taskUpdate(T, { status: "failed" }));
    const other = request();
    await tap(other);
    await tap(answer(other, T, "working"));
    // A crash between the ledger write and the record write: the record lost it.
    const stored = JSON.parse(tasks.map.get(T)!.v);
    delete stored.origin.contested_by;
    tasks.map.set(T, { v: JSON.stringify(stored), rev: 424_242 });
    expect((await get(buyerKp, T)).origin!.contested_by).toEqual([other.id]);
    // The privileged read (admin-views), over the same stores.
    const views = adminViews({ storage: { keyed: async (n: string) => (n === "mesh_tasks" ? tasks : store) } as never });
    const answerOf = await views.handle({ method: "GET", path: `/admin/v1/tasks/${T}`, query: new URLSearchParams() } as never);
    expect((answerOf!.body as { record: { origin: TaskOrigin } }).record.origin.contested_by).toEqual([other.id]);
    expectOrigin(T, r1, "answer");
  });
});

describe("round 8: several requests in one task; the broadcast event", () => {
  type WithMultiple = TaskOrigin & { multiple_requests?: string[] };

  it("two streams naming the same new task, both answered under it: the first is the origin, both are listed, neither is evidence", async () => {
    const T = "task-r8-double";
    const expensive = request({ taskId: T, input: { work: "expensive" } });
    const cheap = request({ taskId: T, input: { work: "cheap" } });
    // Back to back, both seen before the provider answers either.
    await tap(expensive);
    await tap(cheap);
    await tap(answer(expensive, T, "working"));
    await tap(answer(cheap, T, "working"));
    await update(taskUpdate(T, { status: "failed" }));
    expectOrigin(T, expensive, "request");
    const o = record(T).origin as WithMultiple;
    expect(o.multiple_requests).toEqual([expensive.id, cheap.id]);
    expect(o.contested_by).toBeUndefined();
  });

  it("the same when the second is answered after the record exists", async () => {
    const T = "task-r8-double-late";
    const s1 = request({ taskId: T });
    await open(s1);
    await update(taskUpdate(T, { status: "working" }));
    const s2 = request({ taskId: T });
    await open(s2);
    expect((record(T).origin as WithMultiple).multiple_requests).toEqual([s1.id, s2.id]);
  });

  it("multiple_requests is the requester's own: a request bound by an answer has none, and resumes add none", async () => {
    const T = "task-r8-answer-bound";
    const r1 = request();
    await tap(r1);
    await tap(answer(r1, T, "input_required"));
    await update(taskUpdate(T, { status: "input_required", message: "?" }));
    const resume = request({ taskId: T, resume: true });
    await open(resume);
    expect((record(T).origin as WithMultiple).multiple_requests).toBeUndefined();
  });

  it("the broadcast lifecycle event carries no contest lists and no multiple_requests", async () => {
    const T = "task-r8-event";
    const s1 = request({ taskId: T });
    await open(s1);
    await update(taskUpdate(T, { status: "working" }));
    const s2 = request({ taskId: T });
    await open(s2);
    const rival = request();
    await tap(rival);
    await tap(answer(rival, T, "working"));
    nc.publish.mockClear();
    await update(taskUpdate(T, { status: "failed" }));
    const ev = nc.publish.mock.calls.map((c) => [c[0] as string, decode(c[1] as Uint8Array)] as const)
      .find(([subject]) => subject === "mesh.event.task.failed")![1];
    const o = (ev.payload as { data: { origin: WithMultiple } }).data.origin;
    expect(o.request_id).toBe(s1.id);
    expect(o.contested_by).toBeUndefined();
    expect(o.contested_overflow).toBeUndefined();
    expect(o.multiple_requests).toBeUndefined();
    // ...while the record keeps them.
    const r = record(T).origin as WithMultiple;
    expect(r.contested_by).toEqual([rival.id]);
    expect(r.multiple_requests).toEqual([s1.id, s2.id]);
  });
});
