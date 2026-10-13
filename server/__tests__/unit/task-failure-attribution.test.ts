/**
 * Failure attribution (SPEC.md §10.8, §10.8a) at the task manager.
 *
 * Three endings used to be one row in the record: the responder took the work
 * and did not deliver, the caller never furnished something the offering
 * declared it needed, and an outside service the responder depends on broke.
 * These tests are about keeping them apart, and about the one property that
 * makes the middle one worth anything — a provider cannot get it by asserting
 * it.
 *
 * What is covered:
 *
 *   - THE DOOR on a `failed` update: the reason is OPTIONAL, but a stated
 *     reason outside the enum, a `needs_not_furnished` with no `unmet_need`, a
 *     malformed `unmet_need`, and a qualifier riding the wrong reason are all
 *     refused as INVALID_ENVELOPE with nothing persisted and nothing
 *     published.
 *   - ATTRIBUTION, which the service COMPUTES: `client` only when the named
 *     need is declared on the responder's own registered manifest; `provider`
 *     for an undeclared claim, an unreadable registry, a resolver that threw,
 *     a dependency failure, and a bare failure.
 *   - The party's own `attribution` field is not an input.
 *   - The signed `mesh.event.task.failed` carries the computed answer, because
 *     that event is the only thing the reputation bureau is allowed to read it
 *     from.
 */
import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";
import { createEnvelope, encode, decode, signEnvelope, nkeys } from "../../src/sdk.js";
import type { TaskState } from "../../src/sdk.js";
import { handleTaskUpdate } from "../../src/task-manager/handlers/task-update.js";
import {
  attributionOf,
  declaredNeedRefs,
  validateStopFields,
  type DeclaredNeedsFn,
  type TaskCancelFields,
} from "../../src/task-manager/cancel.js";
import type { BudgetTask } from "../../src/task-manager/budget.js";

const requesterKp = nkeys.createUser();
const REQUESTER = requesterKp.getPublicKey();
const responderKp = nkeys.createUser();
const RESPONDER = responderKp.getPublicKey();
const tmKp = nkeys.createUser();

const TASK_ID = "task-fail-attr-001";
const NEED = "credential:Salesforce";

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
      return v === undefined
        ? null
        : {
            key: k,
            operation: "PUT" as const,
            value: new TextEncoder().encode(v),
            json: <T>() => JSON.parse(v) as T,
            string: () => v,
          };
    }),
  };
}

type FailTask = BudgetTask & TaskCancelFields;

let kv: ReturnType<typeof kvStub>;
let nc: { publish: ReturnType<typeof vi.fn> };
let warn: MockInstance;

beforeEach(() => {
  kv = kvStub();
  nc = { publish: vi.fn() };
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

function plant(state: TaskState = "working", over: Partial<FailTask> = {}): FailTask {
  const task: FailTask = {
    id: TASK_ID,
    requester: REQUESTER,
    responder: RESPONDER,
    offering: "",
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

const stored = (): FailTask => JSON.parse(kv.store.get(TASK_ID)!) as FailTask;

/** A signed failed update whose payload the test controls exactly. */
function failMsg(payload: Record<string, unknown>) {
  const env = createEnvelope({
    type: "respond",
    from: RESPONDER,
    to: REQUESTER,
    task_id: TASK_ID,
    payload: { status: "failed", ...payload },
  });
  signEnvelope(env, responderKp);
  return { subject: `mesh.task.${TASK_ID}.update`, data: encode(env) };
}

const apply = (msg: { subject: string; data: Uint8Array }, declaredNeeds?: DeclaredNeedsFn) =>
  handleTaskUpdate(msg as never, kv as never, nc as never, tmKp, undefined, declaredNeeds);

/** A resolver that answers with a fixed declaration set. */
const declares = (...refs: string[]): DeclaredNeedsFn => async () => new Set(refs);
/** A resolver that could not read the registry at all. */
const unreadable: DeclaredNeedsFn = async () => null;

const failedEvent = () => {
  const idx = nc.publish.mock.calls.findIndex((c) => c[0] === "mesh.event.task.failed");
  expect(idx, "a task.failed event must have been published").toBeGreaterThanOrEqual(0);
  const env = decode(nc.publish.mock.calls[idx][1] as Uint8Array);
  return (env.payload as { data: Record<string, unknown> }).data;
};

// ─────────────────────────────────────────────────────────────────────────────

describe("the §10.8 door on a failure: the reason is optional, a bad one is not", () => {
  const expectRefused = () => {
    expect(stored().state).toBe("working");
    expect(kv.put).not.toHaveBeenCalled();
    expect(nc.publish).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("(INVALID_ENVELOPE, §10.8)"));
  };

  it("accepts a bare failure — nobody has to invent an excuse", async () => {
    plant();
    await apply(failMsg({}));
    expect(stored().state).toBe("failed");
    expect(stored().failure_reason).toBeUndefined();
  });

  it("refuses a reason outside the enum", async () => {
    plant();
    await apply(failMsg({ reason: "the client was rude" }));
    expectRefused();
  });

  it("refuses needs_not_furnished with no unmet_need — a claim must name something", async () => {
    plant();
    await apply(failMsg({ reason: "needs_not_furnished" }));
    expectRefused();
  });

  it("refuses a malformed unmet_need", async () => {
    plant();
    await apply(failMsg({ reason: "needs_not_furnished", unmet_need: "the licence" }));
    expectRefused();
  });

  it("refuses unmet_need riding a reason it does not belong to", async () => {
    plant();
    await apply(failMsg({ reason: "policy", unmet_need: NEED }));
    expectRefused();
  });

  it("refuses dependency riding a reason it does not belong to", async () => {
    plant();
    await apply(failMsg({ reason: "user_requested", dependency: "Colorado DMV" }));
    expectRefused();
  });

  it("refuses a qualifier with no reason to belong to", async () => {
    plant();
    await apply(failMsg({ unmet_need: NEED }));
    expectRefused();
  });
});

describe("§10.8a attribution is computed, not accepted", () => {
  it("a declared need the caller never furnished is the CLIENT's", async () => {
    plant();
    await apply(failMsg({ reason: "needs_not_furnished", unmet_need: NEED }), declares(NEED));
    const rec = stored();
    expect(rec.state).toBe("failed");
    expect(rec.failure_reason).toBe("needs_not_furnished");
    expect(rec.unmet_need).toBe(NEED);
    expect(rec.attribution).toBe("client");
    expect(rec.unmet_need_declared).toBe(true);
    expect(failedEvent()).toMatchObject({ attribution: "client", unmet_need: NEED });
  });

  it("the same claim with nothing declared is the PROVIDER's", async () => {
    plant();
    await apply(failMsg({ reason: "needs_not_furnished", unmet_need: NEED }), declares("file:text/csv"));
    expect(stored().attribution).toBe("provider");
    expect(stored().unmet_need_declared).toBe(false);
    expect(failedEvent()).toMatchObject({ attribution: "provider", unmet_need_declared: false });
  });

  it("fails closed when the registry cannot be read — an outage is not a defence", async () => {
    plant();
    await apply(failMsg({ reason: "needs_not_furnished", unmet_need: NEED }), unreadable);
    expect(stored().attribution).toBe("provider");
  });

  it("fails closed when the resolver throws, and says so rather than crashing", async () => {
    plant();
    const boom: DeclaredNeedsFn = async () => {
      throw new Error("registry unreachable");
    };
    await apply(failMsg({ reason: "needs_not_furnished", unmet_need: NEED }), boom);
    expect(stored().state).toBe("failed");
    expect(stored().attribution).toBe("provider");
  });

  it("fails closed when no resolver is wired at all", async () => {
    plant();
    await apply(failMsg({ reason: "needs_not_furnished", unmet_need: NEED }));
    expect(stored().attribution).toBe("provider");
  });

  it("a broken dependency is the PROVIDER's, and stays legible as its own kind", async () => {
    plant();
    await apply(failMsg({ reason: "dependency_failed", dependency: "Colorado DMV" }), declares(NEED));
    const rec = stored();
    expect(rec.attribution).toBe("provider");
    expect(rec.failure_reason).toBe("dependency_failed");
    expect(rec.dependency).toBe("Colorado DMV");
    // Legibility is the whole point: a reader can tell this apart from silence.
    expect(failedEvent()).toMatchObject({
      failure_reason: "dependency_failed",
      dependency: "Colorado DMV",
      attribution: "provider",
    });
  });

  it("a bare failure is the PROVIDER's and the event says so out loud", async () => {
    plant();
    await apply(failMsg({}));
    expect(stored().attribution).toBe("provider");
    expect(failedEvent().attribution).toBe("provider");
  });

  it("an attribution the responder put in its own payload is not an input", async () => {
    plant();
    // The party claims `client` while naming a need nothing declares.
    await apply(
      failMsg({ reason: "needs_not_furnished", unmet_need: NEED, attribution: "client" }),
      declares(),
    );
    expect(stored().attribution).toBe("provider");
    expect(failedEvent().attribution).toBe("provider");
  });

  it("attributes nothing on a completion — attribution is a failure's field", async () => {
    plant();
    const env = createEnvelope({
      type: "respond",
      from: RESPONDER,
      to: REQUESTER,
      task_id: TASK_ID,
      payload: { status: "completed" },
    });
    signEnvelope(env, responderKp);
    await apply({ subject: `mesh.task.${TASK_ID}.update`, data: encode(env) }, declares(NEED));
    expect(stored().attribution).toBeUndefined();
  });
});

describe("attributionOf: the rule on its own", () => {
  it("needs both halves — the reason AND a declaration behind it", () => {
    expect(attributionOf({ reason: "needs_not_furnished", unmet_need: NEED }, new Set([NEED])))
      .toEqual({ attribution: "client", unmet_need_declared: true });
    expect(attributionOf({ reason: "needs_not_furnished", unmet_need: NEED }, new Set()))
      .toEqual({ attribution: "provider", unmet_need_declared: false });
    expect(attributionOf({ reason: "needs_not_furnished", unmet_need: NEED }, null))
      .toEqual({ attribution: "provider", unmet_need_declared: false });
    expect(attributionOf({ reason: "dependency_failed" }, new Set([NEED])))
      .toEqual({ attribution: "provider" });
    expect(attributionOf({}, new Set([NEED]))).toEqual({ attribution: "provider" });
  });
});

describe("declaredNeedRefs: what the responder actually put on record", () => {
  const manifest = {
    offerings: [
      {
        id: "invoice-sync",
        needs: [
          { credential: "Salesforce", scope: "read invoices" },
          { file: "text/csv" },
          { description: "no kind here" },
        ],
      },
      { id: "other", needs: [{ resource: "git-repo", access: "read-write" }] },
    ],
  };

  it("reads every kind, in the reference form attribution compares against", () => {
    expect([...declaredNeedRefs(manifest)].sort()).toEqual([
      "credential:Salesforce",
      "file:text/csv",
      "resource:git-repo",
    ]);
  });

  it("scopes to one offering when the task names one that exists", () => {
    expect([...declaredNeedRefs(manifest, "other")]).toEqual(["resource:git-repo"]);
  });

  it("falls back to every offering when the task's offering names nothing", () => {
    // The task record's `offering` is empty for every task the SDKs create
    // (§6.5), so refusing to check without it would mean never checking.
    expect(declaredNeedRefs(manifest, "not-an-offering").has("credential:Salesforce")).toBe(true);
  });

  it("returns an empty set for a manifest that declares nothing", () => {
    expect(declaredNeedRefs({}).size).toBe(0);
    expect(declaredNeedRefs(null).size).toBe(0);
  });
});

describe("validateStopFields: a cancel must say why, a failure need not", () => {
  it("requires a reason on a cancel and not on a failure", () => {
    expect(typeof validateStopFields({ status: "canceled" }, true)).toBe("string");
    expect(validateStopFields({ status: "failed" }, false)).toEqual({});
  });

  it("keeps the note out of the meaning but lets it through", () => {
    expect(validateStopFields({ reason: "policy", note: "operator stopped it" }, false)).toEqual({
      reason: "policy",
      note: "operator stopped it",
    });
  });
});
