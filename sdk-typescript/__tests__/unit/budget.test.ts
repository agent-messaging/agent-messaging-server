// The budget (§7.7): validation, the deadline predicates under §22.3 skew,
// attach/revise/monotonicity on the requester side, latest-wins on out-of-order
// revisions, and the responder's admission/ceiling refusals.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { MeshError, ErrorCode } from "../../src/types/errors.js";
import { MAX_CLOCK_SKEW_AHEAD_MS } from "../../src/constants.js";
import {
  validateBudget,
  pastDeadline,
  budgetRemainingMs,
  budgetInsufficient,
  deadlineUnmeetable,
  BudgetExhaustedError,
} from "../../src/budget.js";
import type { Budget, Envelope } from "../../src/types/envelope.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import type { TaskUpdate } from "../../src/mesh.js";
import type { RespondPayload } from "../../src/types/primitives.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const CEILING = { amount_micro: 4_000_000, currency: "USD" };
const DEADLINE = "2030-01-01T12:00:00Z";
const budget0: Budget = { revision: 0, deadline: DEADLINE, cost_ceiling: { ...CEILING } };

// ── a fake connection, in the house style ───────────────────────────────────
//
// publish() loops a message back to a matching subscription synchronously, the
// way the broker would deliver it — which is what lets the reviseBudget echo
// and the update-subject tests run without a broker. request() answers with a
// registry-style ok unless a test installs its own answer.

interface PublishedMsg {
  subject: string;
  data: Uint8Array;
}

function makeConn() {
  const published: PublishedMsg[] = [];
  const subs = new Map<string, (msg: unknown) => void>();
  const registryKp = nkeys.createUser();
  let answer: ((subject: string, req: Envelope) => Envelope | undefined) | null = null;

  const conn = {
    published,
    subs,
    registryKp,
    setAnswer(fn: (subject: string, req: Envelope) => Envelope | undefined) {
      answer = fn;
    },
    publish: vi.fn((subject: string, data: Uint8Array) => {
      published.push({ subject, data });
      subs.get(subject)?.({ subject, data, reply: undefined, respond: () => true });
    }),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      const custom = answer?.(subject, req);
      if (custom) {
        const bytes = encode(custom);
        // §6.4 cutover: an agent's answer travels to the requester's inbox;
        // the reply subject is liveness-only and its data is ignored.
        if (subject.endsWith(".inbox")) {
          subs.get(Subjects.agentInbox(req.from))?.({
            subject: Subjects.agentInbox(req.from),
            data: bytes,
            reply: undefined,
            respond: () => true,
          });
        }
        return { data: bytes };
      }
      return {
        data: encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: registryKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload: { status: "registered" },
            }),
            registryKp,
          ),
        ),
      };
    }),
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
      subs.set(subject, cb);
      return { unsubscribe: () => subs.delete(subject), drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    // No jetstreamManager: the §16.4 drain no-ops through its catch, which is
    // the sandbox/older-deployment path and not what this file tests.
    raw: {
      publish: (subject: string, data: Uint8Array) => published.push({ subject, data }),
    },
    get isClosed() {
      return false;
    },
  };
  return conn;
}
type Conn = ReturnType<typeof makeConn>;

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

function makeAgent(conn: Conn, kp: KeyPair = nkeys.createUser()): AgentMesh {
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    kp,
    nkeys.createUser(),
  );
  openAgents.push(agent);
  return agent;
}

/** Install a Task-mode answer from `responderKp` for any agent-inbox request. */
function answerAsTask(
  conn: Conn,
  responderKp: KeyPair,
  taskId: string,
  over: Partial<{ payload: RespondPayload; error: Envelope["error"] }> = {},
) {
  conn.setAnswer((subject, req) => {
    if (!subject.endsWith(".inbox")) return undefined;
    return signEnvelope(
      createEnvelope({
        type: "respond",
        from: responderKp.getPublicKey(),
        to: req.from,
        in_reply_to: req.id,
        task_id: taskId,
        payload: over.payload ?? { status: "working" },
        error: over.error,
      }),
      responderKp,
    );
  });
}

/** Deliver a signed update on a task's update subject, as the broker would. */
function deliverUpdate(
  conn: Conn,
  taskId: string,
  kp: KeyPair,
  fields: Partial<Pick<Envelope, "budget" | "payload" | "artifacts">>,
) {
  const env = signEnvelope(
    createEnvelope({
      type: "respond",
      from: kp.getPublicKey(),
      task_id: taskId,
      ...fields,
    }),
    kp,
  );
  conn.subs.get(Subjects.taskUpdate(taskId))?.({
    subject: Subjects.taskUpdate(taskId),
    data: encode(env),
    reply: undefined,
    respond: () => true,
  });
  return env;
}

/** A requester with one live Task (budget revision 0) against `responderKp`. */
async function makeTask(conn: Conn, responderKp: KeyPair, budget: Budget | undefined = budget0) {
  const requester = makeAgent(conn);
  const taskId = "task-" + Math.random().toString(36).slice(2, 10);
  answerAsTask(conn, responderKp, taskId);
  const result = await requester.request(responderKp.getPublicKey(), "work", "go", { budget });
  expect(result.task_id).toBe(taskId);
  return { requester, taskId };
}

// ── validation ──────────────────────────────────────────────────────────────

describe("validateBudget", () => {
  it("accepts deadline-only, ceiling-only, and both", () => {
    expect(() => validateBudget({ revision: 0, deadline: DEADLINE })).not.toThrow();
    expect(() => validateBudget({ revision: 0, cost_ceiling: CEILING })).not.toThrow();
    expect(() => validateBudget(budget0)).not.toThrow();
  });

  it("accepts any RFC-3339 offset form (§22.3), including numeric offsets and lowercase z", () => {
    expect(() =>
      validateBudget({ revision: 0, deadline: "2030-01-01T12:00:00+02:00" }),
    ).not.toThrow();
    expect(() =>
      validateBudget({ revision: 0, deadline: "2030-01-01T12:00:00.250z" }),
    ).not.toThrow();
  });

  const rejected: [string, unknown][] = [
    ["a non-object", "budget"],
    ["null", null],
    ["an array", [budget0]],
    ["a missing revision", { deadline: DEADLINE }],
    ["a negative revision", { revision: -1, deadline: DEADLINE }],
    ["a fractional revision", { revision: 0.5, deadline: DEADLINE }],
    ["a string revision", { revision: "0", deadline: DEADLINE }],
    ["no axis at all", { revision: 0 }],
    ["a date-only deadline", { revision: 0, deadline: "2030-01-01" }],
    ["an unparseable deadline", { revision: 0, deadline: "tomorrow" }],
    ["a numeric deadline", { revision: 0, deadline: 1735689600000 }],
    ["a fractional amount_micro", { revision: 0, cost_ceiling: { amount_micro: 4_000_000.5, currency: "USD" } }],
    ["a negative amount_micro", { revision: 0, cost_ceiling: { amount_micro: -1, currency: "USD" } }],
    ["a string amount_micro", { revision: 0, cost_ceiling: { amount_micro: "4000000", currency: "USD" } }],
    ["a lowercase currency", { revision: 0, cost_ceiling: { amount_micro: 1, currency: "usd" } }],
    ["a missing currency", { revision: 0, cost_ceiling: { amount_micro: 1 } }],
  ];
  for (const [what, value] of rejected) {
    it(`rejects ${what} with INVALID_ENVELOPE`, () => {
      expect(() => validateBudget(value)).toThrowError(
        expect.objectContaining({ code: ErrorCode.INVALID_ENVELOPE }),
      );
    });
  }
});

// ── deadline predicates ─────────────────────────────────────────────────────

describe("pastDeadline", () => {
  const deadline = "2030-01-01T12:00:00Z";
  const deadlineMs = Date.parse(deadline);
  const b: Budget = { revision: 0, deadline };

  it("is never past without a deadline", () => {
    expect(pastDeadline({ revision: 0, cost_ceiling: CEILING }, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("is not past at the deadline itself", () => {
    expect(pastDeadline(b, deadlineMs)).toBe(false);
  });

  it("tolerates the §22.3 clock-skew window, inclusive at the bound", () => {
    expect(pastDeadline(b, deadlineMs + MAX_CLOCK_SKEW_AHEAD_MS)).toBe(false);
  });

  it("ignores sub-second overshoot past the bound (second granularity, §7.7)", () => {
    expect(pastDeadline(b, deadlineMs + MAX_CLOCK_SKEW_AHEAD_MS + 999)).toBe(false);
  });

  it("is past one whole second beyond the skew bound", () => {
    expect(pastDeadline(b, deadlineMs + MAX_CLOCK_SKEW_AHEAD_MS + 1000)).toBe(true);
  });

  it("honours a caller-supplied skew", () => {
    expect(pastDeadline(b, deadlineMs + 1000, 0)).toBe(true);
    expect(pastDeadline(b, deadlineMs + 1000)).toBe(false);
  });

  it("compares at whole seconds: sub-second deadline vs sub-second now", () => {
    const halfPast: Budget = { revision: 0, deadline: "2030-01-01T12:00:00.500Z" };
    const base = Date.parse("2030-01-01T12:00:00.500Z");
    expect(pastDeadline(halfPast, base + 400, 0)).toBe(false); // same second
    expect(pastDeadline(halfPast, base + 900, 0)).toBe(true); // next second
  });
});

describe("budgetRemainingMs", () => {
  it("is the raw distance to the deadline, negative once past", () => {
    const d = Date.parse(DEADLINE);
    const b: Budget = { revision: 0, deadline: DEADLINE };
    expect(budgetRemainingMs(b, d - 5000)).toBe(5000);
    expect(budgetRemainingMs(b, d + 5000)).toBe(-5000);
  });

  it("is null without a deadline", () => {
    expect(budgetRemainingMs({ revision: 0, cost_ceiling: CEILING }, 0)).toBeNull();
  });
});

// ── requester: attach ───────────────────────────────────────────────────────

describe("attaching a budget to a request", () => {
  it("carries the budget as a top-level envelope field, covered by the signature", async () => {
    const conn = makeConn();
    const responderKp = nkeys.createUser();
    const { taskId, requester } = await makeTask(conn, responderKp);

    const sent = conn.request.mock.calls.find(([s]) => (s as string).endsWith(".inbox"));
    expect(sent).toBeDefined();
    // decode() verifies the signature — a budget the canonical bytes did not
    // cover would fail here.
    const env = decode(sent![1] as Uint8Array);
    expect(env.budget).toEqual(budget0);

    // The deferred Task inherited the budget (§7.7 scope) …
    expect(requester.getTask(taskId)?.budget).toEqual(budget0);
    expect(requester.currentBudget(taskId)).toEqual(budget0);
    // … and its update subject is watched for revisions.
    expect(conn.subs.has(Subjects.taskUpdate(taskId))).toBe(true);
  });

  it("refuses an initiating budget whose revision is not 0, before sending", async () => {
    const conn = makeConn();
    const requester = makeAgent(conn);
    await expect(
      requester.request("X", "work", "go", { budget: { ...budget0, revision: 2 } }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ENVELOPE });
    expect(conn.request).not.toHaveBeenCalled();
  });

  it("refuses an invalid budget before sending", async () => {
    const conn = makeConn();
    const requester = makeAgent(conn);
    await expect(
      requester.request("X", "work", "go", { budget: { revision: 0 } as Budget }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ENVELOPE });
    expect(conn.request).not.toHaveBeenCalled();
  });
});

// ── requester: revise ───────────────────────────────────────────────────────

describe("reviseBudget", () => {
  it("publishes a signed task update carrying only the budget block, revision incremented", async () => {
    const conn = makeConn();
    const { requester, taskId } = await makeTask(conn, nkeys.createUser());

    const sent = requester.reviseBudget(taskId, {
      deadline: DEADLINE,
      cost_ceiling: { amount_micro: 8_000_000, currency: "USD" },
    });
    expect(sent.revision).toBe(1);

    const update = conn.published.find((p) => p.subject === Subjects.taskUpdate(taskId));
    expect(update).toBeDefined();
    const env = decode(update!.data); // signed, verifies
    expect(env.task_id).toBe(taskId);
    expect(env.budget).toEqual(sent);
    // Only the budget block: no payload, no status assertion (§7.7).
    expect(env.payload).toBeUndefined();
    expect(env.error).toBeUndefined();

    expect(requester.currentBudget(taskId)).toEqual(sent);
  });

  it("enforces monotonicity locally: an explicit revision must be after the current one", async () => {
    const conn = makeConn();
    const { requester, taskId } = await makeTask(conn, nkeys.createUser());

    requester.reviseBudget(taskId, { deadline: DEADLINE, revision: 5 });
    expect(requester.currentBudget(taskId)?.revision).toBe(5);

    for (const revision of [5, 3, 0]) {
      expect(() =>
        requester.reviseBudget(taskId, { deadline: DEADLINE, revision }),
      ).toThrowError(expect.objectContaining({ code: ErrorCode.TASK_INVALID_TRANSITION }));
    }
    // Nothing below the current revision was sent.
    const updates = conn.published.filter((p) => p.subject === Subjects.taskUpdate(taskId));
    expect(updates).toHaveLength(1);
    // And the auto-increment continues from the highest.
    expect(requester.reviseBudget(taskId, { deadline: DEADLINE }).revision).toBe(6);
  });

  it("refuses an unknown task", () => {
    const conn = makeConn();
    const requester = makeAgent(conn);
    expect(() => requester.reviseBudget("nope", { deadline: DEADLINE })).toThrowError(
      expect.objectContaining({ code: ErrorCode.TASK_NOT_FOUND }),
    );
  });

  it("refuses a task in a terminal state", async () => {
    const conn = makeConn();
    const responderKp = nkeys.createUser();
    const { requester, taskId } = await makeTask(conn, responderKp);

    deliverUpdate(conn, taskId, responderKp, { payload: { status: "completed" } });
    expect(requester.getTask(taskId)?.state).toBe("completed");

    expect(() => requester.reviseBudget(taskId, { deadline: DEADLINE })).toThrowError(
      expect.objectContaining({ code: ErrorCode.TASK_INVALID_TRANSITION }),
    );
  });

  it("validates the revised budget", async () => {
    const conn = makeConn();
    const { requester, taskId } = await makeTask(conn, nkeys.createUser());
    expect(() => requester.reviseBudget(taskId, {} as Budget)).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_ENVELOPE }),
    );
  });
});

// ── live budget: latest wins ────────────────────────────────────────────────

describe("budget revisions on task updates", () => {
  it("latest wins on out-of-order revisions; lower or equal are ignored", async () => {
    const conn = makeConn();
    const responderKp = nkeys.createUser();
    const { requester, taskId } = await makeTask(conn, responderKp);

    const updates: TaskUpdate[] = [];
    requester.onTaskUpdate((u) => updates.push(u));

    const rev3: Budget = { revision: 3, deadline: DEADLINE, cost_ceiling: { amount_micro: 9_000_000, currency: "USD" } };
    deliverUpdate(conn, taskId, responderKp, { budget: rev3 });
    expect(requester.currentBudget(taskId)).toEqual(rev3);
    expect(updates.at(-1)?.budget).toEqual(rev3);

    // A reordered earlier revision arrives late: ignored, not merged.
    deliverUpdate(conn, taskId, responderKp, {
      budget: { revision: 2, cost_ceiling: { amount_micro: 1, currency: "USD" } },
    });
    expect(requester.currentBudget(taskId)).toEqual(rev3);
    expect(updates.at(-1)?.budget).toBeUndefined();

    // An equal revision (a replayed copy under a fresh envelope id): ignored.
    deliverUpdate(conn, taskId, responderKp, { budget: { ...rev3 } });
    expect(requester.currentBudget(taskId)).toEqual(rev3);
    expect(updates.at(-1)?.budget).toBeUndefined();
  });

  it("ignores updates from a third party entirely", async () => {
    const conn = makeConn();
    const responderKp = nkeys.createUser();
    const { requester, taskId } = await makeTask(conn, responderKp);

    const updates: TaskUpdate[] = [];
    requester.onTaskUpdate((u) => updates.push(u));

    deliverUpdate(conn, taskId, nkeys.createUser(), {
      budget: { revision: 9, deadline: DEADLINE },
      payload: { status: "canceled" },
    });
    expect(requester.currentBudget(taskId)?.revision).toBe(0);
    expect(requester.getTask(taskId)?.state).toBe("working");
    expect(updates).toHaveLength(0);
  });

  it("surfaces status transitions and stops watching after a terminal update", async () => {
    const conn = makeConn();
    const responderKp = nkeys.createUser();
    const { requester, taskId } = await makeTask(conn, responderKp);

    const updates: TaskUpdate[] = [];
    requester.onTaskUpdate((u) => updates.push(u));

    deliverUpdate(conn, taskId, responderKp, { payload: { status: "completed", output: 42 } });
    expect(updates.at(-1)).toMatchObject({ task_id: taskId, status: "completed", output: 42 });
    expect(requester.getTask(taskId)?.state).toBe("completed");
    expect(conn.subs.has(Subjects.taskUpdate(taskId))).toBe(false);
  });

  it("does not surface this agent's own revision echoed back", async () => {
    const conn = makeConn();
    const { requester, taskId } = await makeTask(conn, nkeys.createUser());
    const updates: TaskUpdate[] = [];
    requester.onTaskUpdate((u) => updates.push(u));
    // The fake conn loops the publish back to our own update subscription
    // synchronously, like the broker would.
    requester.reviseBudget(taskId, { deadline: DEADLINE });
    expect(updates).toHaveLength(0);
    expect(requester.currentBudget(taskId)?.revision).toBe(1);
  });
});

// ── responder side ──────────────────────────────────────────────────────────

/** A registered responder agent listening on its inbox. */
async function makeResponder(handler: Parameters<AgentMesh["onRequest"]>[1]) {
  const conn = makeConn();
  const kp = nkeys.createUser();
  const agent = makeAgent(conn, kp);
  agent.onRequest("work", handler);
  await agent.register({ name: "budget-test" });
  return { conn, agent, kp };
}

/** Deliver a signed request to the responder's live inbox; return its reply. */
async function deliverRequest(
  conn: Conn,
  agentId: string,
  senderKp: KeyPair,
  over: Partial<Pick<Envelope, "budget" | "task_id">> = {},
): Promise<Envelope | null> {
  const env = signEnvelope(
    createEnvelope({
      type: "request",
      from: senderKp.getPublicKey(),
      to: agentId,
      payload: { offering: "work", input: "go" },
      ...over,
    }),
    senderKp,
  );
  const replies: Uint8Array[] = [];
  const cb = conn.subs.get(Subjects.agentInbox(agentId));
  if (!cb) throw new Error("responder is not listening on its inbox");
  // §6.4 cutover: replies land on the SENDER's inbox (via the fake's publish
  // loopback), not on the reply subject.
  conn.subs.set(Subjects.agentInbox(senderKp.getPublicKey()), (m) => {
    replies.push((m as { data: Uint8Array }).data);
  });
  cb({
    subject: Subjects.agentInbox(agentId),
    data: encode(env),
    reply: "_INBOX.test",
    respond: () => true,
  });
  // §6.4a: an admitted request's first reply is the accept; the substantive
  // reply follows. Wait for (and return) the first NON-accept reply.
  const substantive = () =>
    replies
      .map((d) => decode(d))
      .find((e) => (e.payload as RespondPayload | undefined)?.status !== "accepted");
  await vi.waitFor(() => expect(substantive()).toBeDefined());
  return substantive() ?? null;
}

describe("responder admission and ceiling (§7.7)", () => {
  it("exposes the request's budget to the handler as ctx.budget", async () => {
    const seen: (Budget | undefined)[] = [];
    const { conn, agent } = await makeResponder((_input, ctx) => {
      seen.push(ctx.budget);
      return "ok";
    });
    const reply = await deliverRequest(conn, agent.id, nkeys.createUser(), { budget: budget0 });
    expect(reply?.error).toBeUndefined();
    expect(seen).toEqual([budget0]);
  });

  it("refuses a malformed budget with INVALID_ENVELOPE before the handler runs", async () => {
    const calls: unknown[] = [];
    const { conn, agent } = await makeResponder((input) => {
      calls.push(input);
      return "ok";
    });
    const reply = await deliverRequest(conn, agent.id, nkeys.createUser(), {
      budget: { revision: 0 } as Budget, // no axis
    });
    expect(reply?.error?.code).toBe(ErrorCode.INVALID_ENVELOPE);
    expect(calls).toHaveLength(0);
  });

  it("budgetInsufficient: refusal at admission carrying the responder's estimate", async () => {
    // §6.4a orders admission before the accept, so the admission decision
    // lives in HandlerOptions.admit — a refusal there is the FIRST reply,
    // never preceded by an accept.
    const estimate = { amount_micro: 12_000_000, currency: "USD" };
    const conn = makeConn();
    const agent = makeAgent(conn);
    agent.onRequest(
      "work",
      () => "never runs",
      {
        admit: () => {
          throw budgetInsufficient(estimate);
        },
      },
    );
    await agent.register({ name: "budget-test" });
    const reply = await deliverRequest(conn, agent.id, nkeys.createUser(), { budget: budget0 });
    expect(reply?.error).toMatchObject({
      code: ErrorCode.BUDGET_INSUFFICIENT,
      retryable: false,
      details: { estimate },
    });
    expect((reply?.payload as RespondPayload).status).toBe("failed");
  });

  it("deadlineUnmeetable: refusal at admission carrying the earliest realistic completion", async () => {
    const earliest = "2030-06-01T00:00:00Z";
    const conn = makeConn();
    const agent = makeAgent(conn);
    agent.onRequest(
      "work",
      () => "never runs",
      {
        admit: () => {
          throw deadlineUnmeetable(earliest);
        },
      },
    );
    await agent.register({ name: "budget-test" });
    const reply = await deliverRequest(conn, agent.id, nkeys.createUser(), { budget: budget0 });
    expect(reply?.error).toMatchObject({
      code: ErrorCode.DEADLINE_UNMEETABLE,
      retryable: false,
      details: { earliest_completion: earliest },
    });
  });

  it("BudgetExhaustedError: pauses into input_required with spent and estimate-to-finish", async () => {
    const spent = { amount_micro: 4_000_000, currency: "USD" };
    const estimate_to_finish = { amount_micro: 2_500_000, currency: "USD" };
    const { conn, agent } = await makeResponder(() => {
      throw new BudgetExhaustedError({ spent, estimate_to_finish });
    });
    const reply = await deliverRequest(conn, agent.id, nkeys.createUser(), { budget: budget0 });
    expect((reply?.payload as RespondPayload).status).toBe("input_required");
    expect(reply?.error).toMatchObject({
      code: ErrorCode.BUDGET_EXHAUSTED,
      retryable: false,
      details: { spent, estimate_to_finish },
    });
    // The §7.0 promotion: the pause names a Task for the budget conversation
    // to continue on.
    expect(typeof reply?.task_id).toBe("string");
    expect(reply?.task_id!.length).toBeGreaterThan(0);
  });
});

// ── the full loop: pause, revise, resume ────────────────────────────────────

describe("requester receiving BUDGET_EXHAUSTED", () => {
  it("throws with the task id in details, tracks the paused task, and can revise it", async () => {
    const conn = makeConn();
    const responderKp = nkeys.createUser();
    const requester = makeAgent(conn);
    const taskId = "task-paused";
    answerAsTask(conn, responderKp, taskId, {
      payload: { status: "input_required" },
      error: {
        code: ErrorCode.BUDGET_EXHAUSTED,
        message: "ceiling reached",
        retryable: false,
        details: { spent: CEILING },
      },
    });

    let thrown: MeshError | undefined;
    try {
      await requester.request(responderKp.getPublicKey(), "work", "go", { budget: budget0 });
    } catch (err) {
      thrown = err as MeshError;
    }
    expect(thrown?.code).toBe(ErrorCode.BUDGET_EXHAUSTED);
    expect(thrown?.details?.task_id).toBe(taskId);

    const task = requester.getTask(taskId);
    expect(task?.state).toBe("input_required");
    expect(task?.budget).toEqual(budget0);

    // The input required is money: raise the ceiling by revision.
    const revised = requester.reviseBudget(taskId, {
      deadline: DEADLINE,
      cost_ceiling: { amount_micro: 8_000_000, currency: "USD" },
    });
    expect(revised.revision).toBe(1);
    expect(requester.currentBudget(taskId)).toEqual(revised);
  });
});
