import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";
import {
  createEnvelope,
  encode,
  decode,
  signEnvelope,
  nkeys,
} from "../../src/sdk.js";
import type { TaskState } from "../../src/sdk.js";
import { handleTaskUpdate } from "../../src/task-manager/handlers/task-update.js";
import {
  validateCancel,
  CANCEL_REASONS,
  type TaskCancelFields,
} from "../../src/task-manager/cancel.js";
import type { BudgetTask } from "../../src/task-manager/budget.js";

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation (§10.8) at the task manager, pinned against
// conformance/cancel.json — THE FIXTURE IS THE AUTHORITY for the six reason
// strings and the reject cases. What these tests cover:
//
//   - THE DOOR: a canceled update whose reason is missing, null, non-string,
//     or outside the closed enum — or whose note is a non-string — is refused
//     as INVALID_ENVELOPE at the door: warn-and-return, nothing persisted,
//     nothing published (the subject is fire-and-forget). From ANYONE: the
//     door runs before the KV load, so a stranger's malformed cancel is the
//     same silence.
//   - THE RECORD: a successful cancel stores `cancel_reason` (the enum, never
//     the free-text note) and the §7.3 rows added today — the paused states
//     input_required / auth_required can cancel.
//   - THE RECEIPT (§19.2): mesh.event.metering.task_canceled — a DISTINCT
//     subject from task_completed — with `canceled_at` in place of
//     `completed_at`, no `completed_late`, `cancel_reason`, and the note
//     deliberately not carried.
//   - STRANDED DELEGATES: the teeth on §10.8's propagation MUST. A canceled
//     task's live children (same context_id, requested by the canceled task's
//     responder) are flagged `stranded: true` and each announced on
//     mesh.event.task.stranded. Enumeration is an injected loader, exactly the
//     overdue sweep's seam — never kv.keys().

const fixture = JSON.parse(
  readFileSync(new URL("../../../conformance/cancel.json", import.meta.url), "utf8"),
) as {
  reasons: { enum: string[] };
  unmet_need: { kinds: string[]; valid: string[]; invalid: string[] };
  attribution: {
    cases: {
      case: string;
      reason: string | null;
      unmet_need?: string;
      dependency?: string;
      declared_needs?: string[] | null;
      party_asserted_attribution?: string;
      attribution: string;
    }[];
  };
  invalid: { cases: { case: string; input: Record<string, unknown> }[] };
};

/** The qualifier a reason needs to be legal on its own (§10.8). */
const qualifierFor = (reason: string): Record<string, unknown> =>
  reason === "needs_not_furnished" ? { unmet_need: fixture.unmet_need.valid[0] } : {};

const requesterKp = nkeys.createUser();
const REQUESTER = requesterKp.getPublicKey();
const responderKp = nkeys.createUser();
const RESPONDER = responderKp.getPublicKey();
const strangerKp = nkeys.createUser();
const tmKp = nkeys.createUser();
const TASK_MANAGER = tmKp.getPublicKey();
/** A delegate the responder farmed work out to (the stranded child's responder). */
const delegateKp = nkeys.createUser();
const DELEGATE = delegateKp.getPublicKey();

const TASK_ID = "task-cancel-abc";
const CTX = "ctx-cancel-0001";

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

type CancelTask = BudgetTask & TaskCancelFields;

let kv: ReturnType<typeof kvStub>;
let nc: { publish: ReturnType<typeof vi.fn> };
let warn: MockInstance;

beforeEach(() => {
  kv = kvStub();
  nc = { publish: vi.fn() };
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

function plant(state: TaskState, over: Partial<CancelTask> = {}): CancelTask {
  const task: CancelTask = {
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
  kv.store.set(task.id, JSON.stringify(task));
  return task;
}

const stored = (id: string = TASK_ID): CancelTask =>
  JSON.parse(kv.store.get(id)!) as CancelTask;

/** A signed canceled update whose reason/note presence the test controls
 *  exactly — including "reason absent", "reason: null", and a non-string
 *  note, which the wire can carry even though the SDK types cannot. */
function cancelMsg(
  kp: ReturnType<typeof nkeys.createUser>,
  opts: {
    reason?: unknown;
    note?: unknown;
    omitReason?: boolean;
    status?: TaskState;
    /** §10.8's qualifying fields, and anything else a hostile sender might
     *  put beside the reason. */
    extra?: Record<string, unknown>;
  } = {},
) {
  const payload: Record<string, unknown> = { status: opts.status ?? "canceled" };
  if (!opts.omitReason) payload.reason = opts.reason;
  if (opts.note !== undefined) payload.note = opts.note;
  Object.assign(payload, opts.extra ?? {});
  const env = createEnvelope({
    type: "respond",
    from: kp.getPublicKey(),
    to: RESPONDER,
    task_id: TASK_ID,
    payload,
  });
  signEnvelope(env, kp);
  return { subject: `mesh.task.${TASK_ID}.update`, data: encode(env) };
}

type Loader = () => Promise<Map<string, { json<T>(): T }>>;

const apply = (msg: { subject: string; data: Uint8Array }, loadEntries?: Loader) =>
  handleTaskUpdate(msg as never, kv as never, nc as never, tmKp, loadEntries);

const published = () => nc.publish.mock.calls.map((c) => c[0] as string);
const publishedEnv = (i: number) => decode(nc.publish.mock.calls[i][1] as Uint8Array);
const dataOf = (i: number) =>
  (publishedEnv(i).payload as { data: Record<string, unknown> }).data;

/** The overdue-sweep test seam: a loader over plain objects with json(). */
const entriesFrom = (tasks: CancelTask[]): Loader =>
  async () =>
    new Map(tasks.map((t) => [t.id, { json: <T>() => JSON.parse(JSON.stringify(t)) as T }]));

// ─────────────────────────────────────────────────────────────────────────────

describe("the §10.8 door: a malformed cancel is refused before anything happens", () => {
  const expectRefused = () => {
    expect(stored().state).toBe("working");
    expect(kv.put).not.toHaveBeenCalled();
    expect(nc.publish).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("(INVALID_ENVELOPE, §10.8)"),
    );
  };

  it("refuses an unknown reason — the enum is closed", async () => {
    plant("working");
    await apply(cancelMsg(requesterKp, { reason: "bored" }));
    expectRefused();
  });

  it("refuses a missing reason — reason is REQUIRED on every cancel", async () => {
    plant("working");
    await apply(cancelMsg(requesterKp, { omitReason: true }));
    expectRefused();
  });

  it("refuses a null reason — absent is omitted, never null", async () => {
    plant("working");
    await apply(cancelMsg(requesterKp, { reason: null }));
    expectRefused();
  });

  it("refuses a non-string note", async () => {
    plant("working");
    await apply(cancelMsg(requesterKp, { reason: "policy", note: 42 }));
    expectRefused();
  });

  it("a stranger's malformed cancel is the same silence — the door runs before the party check", async () => {
    plant("working");
    await apply(cancelMsg(strangerKp, { reason: "bored" }));
    expectRefused();
  });

  it("a stranger's WELL-FORMED cancel is still refused by the party gate, silently", async () => {
    plant("working");
    await apply(cancelMsg(strangerKp, { reason: "user_requested" }));
    expect(stored().state).toBe("working");
    expect(nc.publish).not.toHaveBeenCalled();
  });
});

describe("the record: the reason, not the note, is the meaning it keeps", () => {
  it("records cancel_reason on a canceled task", async () => {
    plant("working");
    await apply(cancelMsg(requesterKp, { reason: "superseded", note: "re-planned" }));

    const t = stored();
    expect(t.state).toBe("canceled");
    expect(t.cancel_reason).toBe("superseded");
    // The note is not a record field; it lives only inside the sender's own
    // signed envelope in `history`.
    expect("note" in t).toBe(false);
  });

  it("input_required → canceled now succeeds (§7.3: the paused states can cancel)", async () => {
    // Invalid before today: a §7.7 BUDGET_EXHAUSTED pause parks a task in
    // input_required precisely so the requester can revise the budget OR
    // cancel and keep the partial artifacts.
    plant("input_required");
    await apply(cancelMsg(requesterKp, { reason: "budget_exhausted" }));
    expect(stored().state).toBe("canceled");
    expect(stored().cancel_reason).toBe("budget_exhausted");
    expect(published()).not.toContain("mesh.event.task.invalid_transition");
  });

  it("auth_required → canceled succeeds too", async () => {
    plant("auth_required");
    await apply(cancelMsg(requesterKp, { reason: "user_requested" }));
    expect(stored().state).toBe("canceled");
  });

  it("the mesh.event.task.canceled lifecycle event carries cancel_reason, additively", async () => {
    plant("working");
    await apply(cancelMsg(requesterKp, { reason: "policy" }));

    expect(published()[0]).toBe("mesh.event.task.canceled");
    const ev = publishedEnv(0);
    expect(ev.from).toBe(TASK_MANAGER);
    expect(dataOf(0).cancel_reason).toBe("policy");
  });
});

describe("the §19.2 canceled receipt: mesh.event.metering.task_canceled", () => {
  it("emits the receipt with cancel_reason, canceled_at, status canceled — and no completed_late, no note", async () => {
    plant("working", {
      budget: { revision: 0, cost_ceiling: { amount_micro: 4_000_000, currency: "USD" } },
      reported_spend: { amount_micro: 17_000, currency: "USD" },
    });
    await apply(cancelMsg(requesterKp, { reason: "deadline_exceeded", note: "overdue since 16:00Z" }));

    expect(published()).toEqual([
      "mesh.event.task.canceled",
      "mesh.event.metering.task_canceled",
      "mesh.event.metering.usage",
    ]);
    const ev = publishedEnv(1);
    expect(ev.from).toBe(TASK_MANAGER); // decode() verified the platform signature
    expect((ev.payload as { event_type: string }).event_type).toBe("task_canceled");
    const data = dataOf(1);
    expect(data.task_id).toBe(TASK_ID);
    expect(data.requester).toBe(REQUESTER);
    expect(data.responder).toBe(RESPONDER);
    expect(data.offering).toBe("summarize");
    expect(data.status).toBe("canceled");
    expect(data.cancel_reason).toBe("deadline_exceeded");
    expect(typeof data.started_at).toBe("string");
    expect(typeof data.canceled_at).toBe("string");
    expect(typeof data.duration_ms).toBe("number");
    expect(data.cost).toEqual({ amount_micro: 17_000, currency: "USD" });
    expect(data.completed_at).toBeUndefined(); // canceled_at takes its place
    expect(data.completed_late).toBeUndefined(); // §19.2: not on a canceled receipt
    // §19.2: the free-text note is deliberately not carried — the enum is the
    // meaning the record keeps.
    expect(JSON.stringify(data)).not.toContain("overdue since 16:00Z");
  });

  it("omits cost and budget when never supplied — same rule as the completed receipt", async () => {
    plant("working");
    await apply(cancelMsg(requesterKp, { reason: "user_requested" }));
    const data = dataOf(1);
    expect(data.cost).toBeUndefined();
    expect(data.budget).toBeUndefined();
  });
});

describe("the fixture is the authority (conformance/cancel.json)", () => {
  it("all eight fixture reasons pass the validator", () => {
    expect(fixture.reasons.enum).toHaveLength(8);
    for (const reason of fixture.reasons.enum) {
      const qualifier = qualifierFor(reason);
      const checked = validateCancel({ status: "canceled", reason, ...qualifier });
      expect(checked, `reason '${reason}' must be accepted`).toEqual({ reason, ...qualifier });
    }
  });

  it("the service's enum and the fixture's enum are the same set", () => {
    expect(new Set(fixture.reasons.enum)).toEqual(new Set(CANCEL_REASONS));
  });

  it("every invalid.cases entry is refused with a named reason", () => {
    expect(fixture.invalid.cases.length).toBeGreaterThan(0);
    for (const { case: name, input } of fixture.invalid.cases) {
      // The fixture inputs are cancel-request inputs ({task_id, reason, note});
      // on the update wire the same reason/note ride beside status.
      const { task_id: _ignored, ...rest } = input;
      const checked = validateCancel({ status: "canceled", ...rest });
      expect(typeof checked, `case '${name}' must be refused`).toBe("string");
    }
  });

  it("each fixture reason drives a real cancel through the handler", async () => {
    for (const reason of fixture.reasons.enum) {
      kv = kvStub();
      nc = { publish: vi.fn() };
      plant("working");
      await apply(cancelMsg(requesterKp, { reason, extra: qualifierFor(reason) }));
      expect(stored().state, `reason '${reason}'`).toBe("canceled");
      expect(stored().cancel_reason).toBe(reason);
    }
  });
});

describe("stranded delegates (§10.8): the canceled task's live children are flagged and announced", () => {
  /** A child of the delegation chain: requested BY the canceled task's
   *  responder, in the same context. */
  const child = (id: string, over: Partial<CancelTask> = {}): CancelTask => ({
    id,
    context_id: CTX,
    requester: RESPONDER, // the canceled task's performer requested it
    responder: DELEGATE,
    offering: "sub-work",
    state: "working",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    history: [],
    artifacts: [],
    ...over,
  });

  it("flags the live delegated child, emits one stranded event, and leaves the others alone", async () => {
    const parent = plant("working", { context_id: CTX });
    const live = child("task-child-live");
    const otherRequester = child("task-child-other", { requester: REQUESTER });
    const finished = child("task-child-done", { state: "completed" });
    for (const t of [live, otherRequester, finished]) kv.store.set(t.id, JSON.stringify(t));

    await apply(
      cancelMsg(requesterKp, { reason: "user_requested" }),
      entriesFrom([parent, live, otherRequester, finished]),
    );

    // Exactly one stranded child, after the lifecycle event and the receipt.
    expect(published()).toEqual([
      "mesh.event.task.canceled",
      "mesh.event.metering.task_canceled",
      "mesh.event.metering.usage",
      "mesh.event.task.stranded",
    ]);
    const ev = publishedEnv(3);
    expect(ev.from).toBe(TASK_MANAGER);
    expect((ev.payload as { domain: string; event_type: string }).domain).toBe("task");
    expect((ev.payload as { event_type: string }).event_type).toBe("stranded");
    expect(dataOf(3)).toEqual({
      task_id: "task-child-live",
      context_id: CTX,
      canceled_task_id: TASK_ID,
      requester: RESPONDER,
      responder: DELEGATE,
      cancel_reason: "user_requested",
    });

    // The flagged record: stranded is a flag, NOT a lifecycle state.
    const flagged = stored("task-child-live");
    expect(flagged.stranded).toBe(true);
    expect(typeof flagged.stranded_at).toBe("string");
    expect(flagged.state).toBe("working");

    // Untouched: the child requested by someone else, and the terminal child.
    expect(stored("task-child-other").stranded).toBeUndefined();
    expect(stored("task-child-done").stranded).toBeUndefined();
    // Only the canceled task and the flagged child were written.
    expect(kv.put.mock.calls.map((c) => c[0] as string)).toEqual([
      TASK_ID,
      "task-child-live",
    ]);
  });

  it("a canceled task with no context_id does no fan-out — there is no chain to look for", async () => {
    plant("working"); // no context_id
    const loader = vi.fn(entriesFrom([child("task-child-live")]));
    await apply(cancelMsg(requesterKp, { reason: "user_requested" }), loader);

    expect(loader).not.toHaveBeenCalled();
    expect(published()).toEqual([
      "mesh.event.task.canceled",
      "mesh.event.metering.task_canceled",
      "mesh.event.metering.usage",
    ]);
  });

  it("with no loader wired, the fan-out is skipped (the default), never a crash", async () => {
    plant("working", { context_id: CTX });
    await apply(cancelMsg(requesterKp, { reason: "user_requested" }));
    expect(published()).toEqual([
      "mesh.event.task.canceled",
      "mesh.event.metering.task_canceled",
      "mesh.event.metering.usage",
    ]);
  });

  it("skips an unparseable record with a warn and still flags the rest — like the overdue sweep", async () => {
    const parent = plant("working", { context_id: CTX });
    const live = child("task-child-live");
    kv.store.set(live.id, JSON.stringify(live));
    const good = await entriesFrom([parent, live])();
    good.set("task-broken", { json: <T>(): T => { throw new Error("bad json"); } });

    await apply(cancelMsg(requesterKp, { reason: "superseded" }), async () => good);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("task-broken"));
    expect(stored("task-child-live").stranded).toBe(true);
    expect(published()).toContain("mesh.event.task.stranded");
  });

  it("the stranded event carries the CANCELED task's reason — upstream context an operator can read", async () => {
    const parent = plant("working", { context_id: CTX });
    const live = child("task-child-live");
    kv.store.set(live.id, JSON.stringify(live));

    await apply(
      cancelMsg(requesterKp, { reason: "budget_exhausted" }),
      entriesFrom([parent, live]),
    );
    expect(dataOf(3).cancel_reason).toBe("budget_exhausted");
  });
});
