import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createEnvelope,
  encode,
  decode,
  signEnvelope,
  nkeys,
} from "../../src/sdk.js";
import type { TaskState } from "../../src/sdk.js";
import { handleTaskUpdate } from "../../src/task-manager/handlers/task-update.js";
import { OverdueSweep } from "../../src/task-manager/overdue-sweep.js";
import {
  validateBudget,
  deadlinePassed,
  CLOCK_SKEW_MS,
  type Budget,
  type BudgetTask,
  type BudgetEnvelope,
} from "../../src/task-manager/budget.js";

// ─────────────────────────────────────────────────────────────────────────────
// The budget (§7.7): the requester's statement of the most a piece of work may
// cost and the latest it may finish, riding the §5.2 envelope `budget` field.
// The task manager's share of the mechanism, which is what these tests pin:
//
//   - INHERITANCE: a task created from a request carrying a budget persists it
//     with the record (revision 0), because a deferred Task inherits the
//     request's budget and the budget becomes live.
//   - REVISIONS: a task update carrying ONLY the block. Parties only
//     (UNAUTHORIZED — and, per task-parties.ts, a stranger's refusal is logged,
//     never published), strictly increasing revision, absolute replacement,
//     no revising a finished task, and no revision that renders the present
//     moment retroactively over budget (TASK_INVALID_TRANSITION). Accepted
//     revisions are rebroadcast to the counterparty as a normal task update.
//   - THE DEADLINE: the half the platform CAN enforce. The sweep marks a
//     non-terminal task overdue on the task manager's own clock (a flag, not a
//     state) and notifies the requester; a completion after the deadline is
//     accepted and recorded completed-late with DEADLINE_EXCEEDED (§12.2).
//   - THE RECEIPT: every completion emits §19.2's metering event — cost in
//     currency micro-units, the final budget, completed_late, and no token
//     counts anywhere.
//
// Comparisons are at second granularity under the §22.3 skew tolerance, so a
// deadline is only "past" once it is past beyond what two honest clocks may
// disagree by.

const requesterKp = nkeys.createUser();
const REQUESTER = requesterKp.getPublicKey();
const responderKp = nkeys.createUser();
const RESPONDER = responderKp.getPublicKey();
const strangerKp = nkeys.createUser();
const tmKp = nkeys.createUser();
const TASK_MANAGER = tmKp.getPublicKey();

const TASK_ID = "task-budget-abc";

/** Minutes relative to now, RFC 3339. */
const minutesFromNow = (m: number): string => new Date(Date.now() + m * 60_000).toISOString();

/** A deadline decisively in the past: beyond the §22.3 skew tolerance. */
const PAST_DEADLINE = () => minutesFromNow(-15);
/** A deadline decisively in the future. */
const FUTURE_DEADLINE = () => minutesFromNow(60);

function kvStub() {
  const store = new Map<string, string>();
  return {
    store,
    put: vi.fn(async (k: string, v: Uint8Array | string) => {
      store.set(k, typeof v === "string" ? v : new TextDecoder().decode(v));
      return 1;
    }),
    get: vi.fn(async (k: string) => {
      const v = store.get(k);
      return v === undefined ? null : {
        key: k, operation: "PUT" as const,
        value: new TextEncoder().encode(v),
        json: <T>() => JSON.parse(v) as T, string: () => v,
      };
    }),
  };
}

let kv: ReturnType<typeof kvStub>;
let nc: { publish: ReturnType<typeof vi.fn> };

beforeEach(() => {
  kv = kvStub();
  nc = { publish: vi.fn() };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

function plant(state: TaskState, over: Partial<BudgetTask> = {}): BudgetTask {
  const task: BudgetTask = {
    id: TASK_ID,
    requester: REQUESTER,
    responder: RESPONDER,
    offering: "summarize",
    state,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    history: [],
    artifacts: [],
    ...over,
  };
  kv.store.set(TASK_ID, JSON.stringify(task));
  return task;
}

const stored = (): BudgetTask => JSON.parse(kv.store.get(TASK_ID)!) as BudgetTask;

/** A signed task update. `status: null` omits the payload entirely (a
 *  budget-only revision); `budget` attaches the §5.2 field before signing —
 *  the canonical signature covers every field except `sig`, so the block is
 *  inside what `decode()` verifies. */
function updateMsg(
  kp: ReturnType<typeof nkeys.createUser>,
  status: TaskState | null,
  opts: { to?: string; budget?: unknown; cost?: unknown } = {},
) {
  const env = createEnvelope({
    type: "respond",
    from: kp.getPublicKey(),
    ...(opts.to === undefined ? {} : { to: opts.to }),
    task_id: TASK_ID,
    ...(status === null
      ? {}
      : {
          payload: {
            status,
            // §10.8: a canceled update without a reason is refused at the
            // door; these tests are about budgets, so it carries a valid one.
            ...(status === "canceled" ? { reason: "user_requested" } : {}),
            ...(opts.cost !== undefined ? { cost: opts.cost } : {}),
          },
        }),
  }) as BudgetEnvelope;
  if (opts.budget !== undefined) env.budget = opts.budget;
  signEnvelope(env, kp);
  return { subject: `mesh.task.${TASK_ID}.update`, data: encode(env) };
}

const apply = (msg: { subject: string; data: Uint8Array }) =>
  handleTaskUpdate(msg as never, kv as never, nc as never, tmKp);

const published = () => nc.publish.mock.calls.map((c) => c[0] as string);
const publishedEnv = (i: number) => decode(nc.publish.mock.calls[i][1] as Uint8Array);

const BUDGET_0: Budget = {
  revision: 0,
  deadline: FUTURE_DEADLINE(),
  cost_ceiling: { amount_micro: 4_000_000, currency: "USD" },
};

// ─────────────────────────────────────────────────────────────────────────────

describe("a task created from a request carrying a budget inherits it (§7.7 scope)", () => {
  it("persists the block whole with the record, at revision 0", async () => {
    await apply(updateMsg(responderKp, "submitted", { to: REQUESTER, budget: BUDGET_0 }));

    const t = stored();
    expect(t.budget).toEqual(BUDGET_0);
    expect(t.budget!.revision).toBe(0);
    expect(t.overdue).toBeUndefined();
  });

  it("creates the task without a budget when the creating update carries none", async () => {
    await apply(updateMsg(responderKp, "submitted", { to: REQUESTER }));
    expect(stored().budget).toBeUndefined();
  });
});

describe("malformed budget blocks are refused at the door (§7.7 shape rules)", () => {
  // Nothing happens AT ALL: no record write, no signed event. A block bad
  // enough to fail validation refuses the whole update — same door as a
  // missing status.
  const malformed: [string, unknown][] = [
    ["missing revision", { deadline: FUTURE_DEADLINE() }],
    ["non-integer revision", { revision: 1.5, deadline: FUTURE_DEADLINE() }],
    ["negative revision", { revision: -1, deadline: FUTURE_DEADLINE() }],
    ["neither axis present", { revision: 0 }],
    ["non-integer amount_micro", { revision: 0, cost_ceiling: { amount_micro: 4.2, currency: "USD" } }],
    ["string amount_micro", { revision: 0, cost_ceiling: { amount_micro: "4000000", currency: "USD" } }],
    ["bad currency", { revision: 0, cost_ceiling: { amount_micro: 1, currency: "dollars" } }],
    ["bad timestamp", { revision: 0, deadline: "next tuesday" }],
    ["not an object", "USD 4"],
  ];

  for (const [name, block] of malformed) {
    it(`refuses a creating update whose budget has ${name}`, async () => {
      await apply(updateMsg(responderKp, "submitted", { to: REQUESTER, budget: block }));
      expect(kv.put).not.toHaveBeenCalled();
      expect(nc.publish).not.toHaveBeenCalled();
    });

    it(`refuses a revision with ${name}`, async () => {
      plant("working", { budget: BUDGET_0 });
      await apply(updateMsg(requesterKp, null, { budget: block }));
      expect(stored().budget).toEqual(BUDGET_0);
      expect(nc.publish).not.toHaveBeenCalled();
    });
  }

  it("validateBudget names the reason (the accept-or-say-why contract)", () => {
    expect(validateBudget({ deadline: FUTURE_DEADLINE() })).toMatch(/revision is required/);
    expect(validateBudget({ revision: 0 })).toMatch(/at least one of/);
    expect(typeof validateBudget(BUDGET_0)).toBe("object");
  });
});

describe("budget revisions (§7.7): parties, monotonic, absolute, future-only", () => {
  it("accepts either party's strictly-greater revision and replaces the block ENTIRELY", async () => {
    plant("working", { budget: BUDGET_0 });
    // Revision 1 drops the ceiling axis on purpose: revisions are absolute,
    // never deltas, so the axis is gone — not carried over from revision 0.
    const rev1: Budget = { revision: 1, deadline: FUTURE_DEADLINE() };
    await apply(updateMsg(requesterKp, null, { budget: rev1 }));

    const t = stored();
    expect(t.budget).toEqual(rev1);
    expect(t.budget!.cost_ceiling).toBeUndefined();
    expect(t.state).toBe("working"); // a revision is not a transition
    expect(t.history).toHaveLength(1); // the revision envelope is part of the record
  });

  it("rebroadcasts an accepted revision to the counterparty as a normal task update", async () => {
    plant("working", { budget: BUDGET_0 });
    const rev1: Budget = { revision: 1, deadline: FUTURE_DEADLINE() };
    await apply(updateMsg(requesterKp, null, { budget: rev1 }));

    expect(published()).toEqual([`mesh.task.${TASK_ID}.update`]);
    const out = publishedEnv(0) as BudgetEnvelope; // decode() verifies the signature
    expect(out.from).toBe(TASK_MANAGER);
    expect(out.to).toBe(RESPONDER); // the requester revised, so the responder is told
    expect(out.task_id).toBe(TASK_ID);
    expect(out.budget).toEqual(rev1);
    expect((out.payload as { status?: string } | undefined)?.status).toBeUndefined();
  });

  it("the responder's revision is rebroadcast to the requester", async () => {
    plant("working", { budget: BUDGET_0 });
    await apply(updateMsg(responderKp, null, { budget: { revision: 1, deadline: FUTURE_DEADLINE() } }));
    expect((publishedEnv(0) as BudgetEnvelope).to).toBe(REQUESTER);
  });

  it("the task manager's own rebroadcast, looped back, is dropped without effect", async () => {
    // The rebroadcast is published on the same subject this handler consumes.
    plant("working", { budget: BUDGET_0 });
    const echo = createEnvelope({
      type: "respond", from: TASK_MANAGER, to: RESPONDER, task_id: TASK_ID,
    }) as BudgetEnvelope;
    echo.budget = { revision: 1, deadline: FUTURE_DEADLINE() };
    signEnvelope(echo, tmKp);
    await apply({ subject: `mesh.task.${TASK_ID}.update`, data: encode(echo) });

    expect(stored().budget).toEqual(BUDGET_0);
    expect(nc.publish).not.toHaveBeenCalled();
  });

  it("refuses a stranger's revision (UNAUTHORIZED), publishing nothing", async () => {
    // Per task-parties.ts: a stranger's refusal is logged, never published —
    // a signed platform event per forged message would be the amplifier.
    plant("working", { budget: BUDGET_0 });
    await apply(updateMsg(strangerKp, null, { budget: { revision: 1, deadline: FUTURE_DEADLINE() } }));

    expect(stored().budget).toEqual(BUDGET_0);
    expect(nc.publish).not.toHaveBeenCalled();
  });

  const expectRejected = (reasonRe: RegExp) => {
    expect(published()).toEqual(["mesh.event.task.budget_rejected"]);
    const ev = publishedEnv(0);
    expect(ev.from).toBe(TASK_MANAGER);
    const data = (ev.payload as { data: Record<string, unknown> }).data;
    expect(data.code).toBe("TASK_INVALID_TRANSITION");
    expect(String(data.reason)).toMatch(reasonRe);
  };

  it("rejects a stale revision: the counter must be STRICTLY greater than stored", async () => {
    plant("working", { budget: { ...BUDGET_0, revision: 2 } });
    await apply(updateMsg(requesterKp, null, { budget: { revision: 2, deadline: FUTURE_DEADLINE() } }));

    expect(stored().budget!.revision).toBe(2);
    expect(stored().budget!.deadline).toBe(BUDGET_0.deadline); // the duplicate did not overwrite
    expectRejected(/not greater than the stored revision 2/);
  });

  it("rejects a lower (reordered) revision the same way", async () => {
    plant("working", { budget: { ...BUDGET_0, revision: 3 } });
    await apply(updateMsg(responderKp, null, { budget: { revision: 1, deadline: FUTURE_DEADLINE() } }));
    expect(stored().budget!.revision).toBe(3);
    expectRejected(/not greater/);
  });

  it("rejects a revision to a task in a terminal state (TASK_INVALID_TRANSITION)", async () => {
    plant("completed", { budget: BUDGET_0 });
    await apply(updateMsg(requesterKp, null, { budget: { revision: 1, deadline: FUTURE_DEADLINE() } }));
    expect(stored().budget).toEqual(BUDGET_0);
    expectRejected(/terminal/);
  });

  it("rejects a revision whose deadline is already past — no retroactive violation", async () => {
    plant("working", { budget: BUDGET_0 });
    await apply(updateMsg(requesterKp, null, { budget: { revision: 1, deadline: PAST_DEADLINE() } }));
    expect(stored().budget).toEqual(BUDGET_0);
    expectRejected(/already past/);
  });

  it("accepts a revision whose deadline is inside the §22.3 skew window", async () => {
    // One minute "ago" on the sender's clock is inside what two honest clocks
    // may disagree by; refusing it would punish clock skew, not lateness.
    plant("working", { budget: BUDGET_0 });
    const rev1: Budget = { revision: 1, deadline: minutesFromNow(-1) };
    await apply(updateMsg(requesterKp, null, { budget: rev1 }));
    expect(stored().budget).toEqual(rev1);
  });

  it("rejects a revision whose ceiling is below the responder's reported spend", async () => {
    plant("working", {
      budget: BUDGET_0,
      reported_spend: { amount_micro: 2_000_000, currency: "USD" },
    });
    await apply(updateMsg(requesterKp, null, {
      budget: { revision: 1, cost_ceiling: { amount_micro: 1_000_000, currency: "USD" } },
    }));
    expect(stored().budget).toEqual(BUDGET_0);
    expectRejected(/below the responder's reported spend/);
  });

  it("accepts a ceiling at exactly the reported spend — the present moment is inside it", async () => {
    plant("working", {
      budget: BUDGET_0,
      reported_spend: { amount_micro: 2_000_000, currency: "USD" },
    });
    const rev1: Budget = { revision: 1, cost_ceiling: { amount_micro: 2_000_000, currency: "USD" } };
    await apply(updateMsg(requesterKp, null, { budget: rev1 }));
    expect(stored().budget).toEqual(rev1);
  });

  it("accepts a first revision on a task with no stored budget (the block is the whole truth)", async () => {
    plant("working");
    const rev2: Budget = { revision: 2, deadline: FUTURE_DEADLINE() };
    await apply(updateMsg(requesterKp, null, { budget: rev2 }));
    expect(stored().budget).toEqual(rev2);
  });

  it("drops a revision for a task this service has no record of", async () => {
    await apply(updateMsg(requesterKp, null, { budget: { revision: 1, deadline: FUTURE_DEADLINE() } }));
    expect(kv.put).not.toHaveBeenCalled();
    expect(nc.publish).not.toHaveBeenCalled();
  });

  it("ignores a budget block riding a STATE update — §5.2: meaningful on request and revisions only", async () => {
    plant("working", { budget: BUDGET_0 });
    await apply(updateMsg(responderKp, "input_required", {
      to: REQUESTER,
      budget: { revision: 5, deadline: FUTURE_DEADLINE() },
    }));

    const t = stored();
    expect(t.state).toBe("input_required"); // the transition went through
    expect(t.budget).toEqual(BUDGET_0); // the block did not skip the revision checks
  });
});

describe("the overdue mark (§7.7): the platform-enforceable half of the deadline", () => {
  const sweepWith = (tasks: BudgetTask[]) =>
    new OverdueSweep(
      nc as never,
      undefined as never, // js unused when a loader is injected
      kv as never,
      tmKp,
      async () => new Map(tasks.map((t) => [t.id, { json: <T>() => JSON.parse(JSON.stringify(t)) as T }])),
    );

  it("marks a non-terminal task overdue at the deadline and notifies the requester", async () => {
    const t = plant("working", { budget: { revision: 0, deadline: PAST_DEADLINE() } });
    const marked = await sweepWith([t]).sweep();

    expect(marked).toEqual([TASK_ID]);
    const after = stored();
    expect(after.overdue).toBe(true);
    expect(after.state).toBe("working"); // a flag, NOT a lifecycle state

    expect(published()).toEqual([`mesh.task.${TASK_ID}.update`]);
    const notice = publishedEnv(0);
    expect(notice.from).toBe(TASK_MANAGER);
    expect(notice.to).toBe(REQUESTER);
    expect(notice.task_id).toBe(TASK_ID);
    expect(notice.meta?.overdue).toBe(true);
    expect((notice.payload as { status?: string } | undefined)?.status).toBeUndefined();
  });

  it("uses the task manager's own clock: the injected `now` decides, not the record", async () => {
    const deadline = minutesFromNow(30);
    const t = plant("working", { budget: { revision: 0, deadline } });
    // 30 minutes early: nothing.
    expect(await sweepWith([t]).sweep()).toEqual([]);
    // An hour later on the sweep's clock: overdue.
    expect(await sweepWith([t]).sweep(Date.now() + 90 * 60_000)).toEqual([TASK_ID]);
  });

  it("tolerates §22.3 clock skew: a deadline one minute past is not yet overdue", async () => {
    const t = plant("working", { budget: { revision: 0, deadline: minutesFromNow(-1) } });
    expect(await sweepWith([t]).sweep()).toEqual([]);
    expect(stored().overdue).toBeUndefined();
  });

  it("marks once: an already-flagged task is not re-notified", async () => {
    const t = plant("working", {
      budget: { revision: 0, deadline: PAST_DEADLINE() },
      overdue: true,
      overdue_at: new Date().toISOString(),
    });
    expect(await sweepWith([t]).sweep()).toEqual([]);
    expect(nc.publish).not.toHaveBeenCalled();
  });

  it("leaves terminal tasks alone — nothing left to enforce", async () => {
    const t = plant("completed", { budget: { revision: 0, deadline: PAST_DEADLINE() } });
    expect(await sweepWith([t]).sweep()).toEqual([]);
    expect(nc.publish).not.toHaveBeenCalled();
  });

  it("skips tasks with no deadline axis", async () => {
    const t = plant("working", {
      budget: { revision: 0, cost_ceiling: { amount_micro: 1, currency: "USD" } },
    });
    expect(await sweepWith([t]).sweep()).toEqual([]);
  });

  it("deadlinePassed is second-granularity with the skew bound inclusive", () => {
    const now = Date.parse("2026-07-27T12:00:00.000Z");
    // Exactly at the skew bound: NOT passed (§22.3: an envelope exactly at a
    // bound is inside the window; same rule here).
    expect(deadlinePassed(new Date(now - CLOCK_SKEW_MS).toISOString(), now)).toBe(false);
    // One second beyond it: passed.
    expect(deadlinePassed(new Date(now - CLOCK_SKEW_MS - 1000).toISOString(), now)).toBe(true);
    // Sub-second overshoot rounds away — §7.7: below one second a deadline
    // measures network jitter, not the work.
    expect(deadlinePassed(new Date(now - CLOCK_SKEW_MS - 999).toISOString(), now)).toBe(false);
  });
});

describe("late completion (§7.7): accepted, and recorded as completed late", () => {
  it("records completed_late with DEADLINE_EXCEEDED when the completion arrives after the deadline", async () => {
    plant("working", { budget: { revision: 0, deadline: PAST_DEADLINE() } });
    await apply(updateMsg(responderKp, "completed", { to: REQUESTER }));

    const t = stored();
    expect(t.state).toBe("completed"); // accepted — the deadline is not a kill switch
    expect(t.completed_late).toBe(true);
    expect(t.meta?.deadline_exceeded).toBe("DEADLINE_EXCEEDED");

    // The platform-signed completion event carries the marker the requester
    // can hold: a marker, not a failure (§12.2).
    const completedEv = publishedEnv(0);
    const data = (completedEv.payload as { data: Record<string, unknown> }).data;
    expect(data.completed_late).toBe(true);
    expect(data.code).toBe("DEADLINE_EXCEEDED");
  });

  it("a completion inside the deadline is not marked late", async () => {
    plant("working", { budget: { revision: 0, deadline: FUTURE_DEADLINE() } });
    await apply(updateMsg(responderKp, "completed", { to: REQUESTER }));

    const t = stored();
    expect(t.completed_late).toBeUndefined();
    const data = (publishedEnv(0).payload as { data: Record<string, unknown> }).data;
    expect(data.completed_late).toBeUndefined();
  });

  it("a completion within the skew window of the deadline is not late", async () => {
    plant("working", { budget: { revision: 0, deadline: minutesFromNow(-1) } });
    await apply(updateMsg(responderKp, "completed", { to: REQUESTER }));
    expect(stored().completed_late).toBeUndefined();
  });
});

describe("the metering receipt (§19.2): one per completed task", () => {
  it("emits mesh.event.metering.task_completed with cost, final budget, completed_late — and no token counts", async () => {
    plant("working", { budget: BUDGET_0 });
    await apply(updateMsg(responderKp, "completed", {
      to: REQUESTER,
      cost: { amount_micro: 17_000, currency: "USD" },
    }));

    expect(published()).toEqual([
      "mesh.event.task.completed",
      "mesh.event.metering.task_completed",
      "mesh.event.metering.usage",
    ]);
    const ev = publishedEnv(1);
    expect(ev.from).toBe(TASK_MANAGER); // decode() verified the platform signature
    const data = (ev.payload as { data: Record<string, unknown> }).data;
    expect(data.task_id).toBe(TASK_ID);
    expect(data.requester).toBe(REQUESTER);
    expect(data.responder).toBe(RESPONDER);
    expect(data.offering).toBe("summarize");
    expect(data.status).toBe("completed");
    expect(data.completed_late).toBe(false);
    expect(data.cost).toEqual({ amount_micro: 17_000, currency: "USD" });
    expect(data.budget).toEqual(BUDGET_0); // the final (highest-revision) budget that applied
    expect(typeof data.duration_ms).toBe("number");
    expect(JSON.stringify(data)).not.toMatch(/token/i); // §19.2: deliberately absent
  });

  it("emits the receipt for a budget-less completion too, omitting what was never supplied", async () => {
    plant("working");
    await apply(updateMsg(responderKp, "completed", { to: REQUESTER }));

    const ev = publishedEnv(1);
    const data = (ev.payload as { data: Record<string, unknown> }).data;
    expect(data.budget).toBeUndefined();
    expect(data.cost).toBeUndefined();
    expect(data.completed_late).toBe(false);
  });

  it("reports the FINAL budget: a completion after a revision carries the revised terms", async () => {
    plant("working", { budget: BUDGET_0 });
    const rev1: Budget = { revision: 1, deadline: FUTURE_DEADLINE(), cost_ceiling: { amount_micro: 8_000_000, currency: "USD" } };
    await apply(updateMsg(requesterKp, null, { budget: rev1 }));
    nc.publish.mockClear();

    await apply(updateMsg(responderKp, "completed", { to: REQUESTER }));
    const data = (publishedEnv(1).payload as { data: Record<string, unknown> }).data;
    expect(data.budget).toEqual(rev1);
  });

  it("does not emit a receipt for failed — a failure ends no spending authority to account for", async () => {
    plant("working", { budget: BUDGET_0 });
    await apply(updateMsg(responderKp, "failed", { to: REQUESTER }));
    expect(published()).toEqual(["mesh.event.task.failed"]);
  });

  it("emits the §19.2 canceled receipt — task_canceled, never task_completed", async () => {
    // A cancellation ends spending authority the way a completion does, so it
    // gets a receipt too — on a DISTINCT subject, so a consumer folding
    // completed receipts never sees cancellations arrive under that name.
    plant("working", { budget: BUDGET_0 });
    await apply(updateMsg(requesterKp, "canceled"));

    expect(published()).toEqual([
      "mesh.event.task.canceled",
      "mesh.event.metering.task_canceled",
      "mesh.event.metering.usage",
    ]);
    const data = (publishedEnv(1).payload as { data: Record<string, unknown> }).data;
    expect(data.status).toBe("canceled");
    expect(data.cancel_reason).toBe("user_requested");
    expect(data.budget).toEqual(BUDGET_0);
    expect(typeof data.canceled_at).toBe("string");
    expect(data.completed_at).toBeUndefined(); // canceled_at takes its place
    expect(data.completed_late).toBeUndefined(); // §19.2: no completed_late on a canceled receipt
  });

  it("spend is the RESPONDER's claim: a requester's `cost` is not recorded", async () => {
    plant("working", { budget: BUDGET_0 });
    await apply(updateMsg(requesterKp, "canceled", {
      cost: { amount_micro: 999, currency: "USD" },
    }));
    expect(stored().reported_spend).toBeUndefined();
  });

  it("records the responder's reported spend from any of its updates", async () => {
    plant("working", { budget: BUDGET_0 });
    await apply(updateMsg(responderKp, "input_required", {
      to: REQUESTER,
      cost: { amount_micro: 2_000_000, currency: "USD" },
    }));
    expect(stored().reported_spend).toEqual({ amount_micro: 2_000_000, currency: "USD" });
  });
});
