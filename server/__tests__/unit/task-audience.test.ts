// SPEC.md §5.7, the server's part (core profile, §1.6): the task manager
// applies no Task update whose `meta.audience` is present and is anything
// other than the string "agent". The cases are conformance/audience.json's
// `server.task_manager`, read from the fixture so the two cannot drift apart;
// core test c25 checks the same cases on a live mesh.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { createEnvelope, encode, decode, signEnvelope, nkeys } from "../../src/sdk.js";
import type { Task, TaskState } from "../../src/sdk.js";
import { handleTaskUpdate } from "../../src/task-manager/handlers/task-update.js";
import { audienceRefusal } from "../../src/task-manager/audience.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../conformance/audience.json", import.meta.url), "utf8"),
) as {
  server: {
    task_manager: { id: string; meta: Record<string, unknown> | null; applies: boolean; first_update?: boolean }[];
  };
};
const cases = fixture.server.task_manager;

const requesterKp = nkeys.createUser();
const REQUESTER = requesterKp.getPublicKey();
const responderKp = nkeys.createUser();
const RESPONDER = responderKp.getPublicKey();
const strangerKp = nkeys.createUser();
const tmKp = nkeys.createUser();
const TASK_ID = "task-c25-abc";

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

let kv: ReturnType<typeof kvStub>;
let nc: { publish: ReturnType<typeof vi.fn> };

beforeEach(() => {
  kv = kvStub();
  nc = { publish: vi.fn() };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

function plant(state: TaskState): void {
  const task: Task = {
    id: TASK_ID,
    requester: REQUESTER,
    responder: RESPONDER,
    offering: "summarize",
    state,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    history: [],
    artifacts: [],
  };
  kv.store.set(TASK_ID, JSON.stringify(task));
}

const stored = (): Task | null => {
  const v = kv.store.get(TASK_ID);
  return v === undefined ? null : (JSON.parse(v) as Task);
};

function updateMsg(
  kp: ReturnType<typeof nkeys.createUser>,
  status: TaskState,
  meta: Record<string, unknown> | null,
) {
  const env = createEnvelope({
    type: "respond",
    from: kp.getPublicKey(),
    to: REQUESTER,
    task_id: TASK_ID,
    payload: { status },
    ...(meta === null ? {} : { meta }),
  });
  signEnvelope(env, kp);
  return { subject: `mesh.task.${TASK_ID}.update`, data: encode(env) };
}

const apply = (msg: { subject: string; data: Uint8Array }) =>
  handleTaskUpdate(msg as never, kv as never, nc as never, tmKp);
const published = () => nc.publish.mock.calls.map((c) => c[0] as string);

describe("audience.json server.task_manager: an update to an existing Task", () => {
  for (const c of cases.filter((x) => !x.first_update)) {
    it(`${c.id}: ${c.applies ? "applies" : "leaves the Task as it was"}`, async () => {
      plant("submitted");
      await apply(updateMsg(responderKp, "working", c.meta));
      const t = stored()!;
      if (c.applies) {
        expect(t.state).toBe("working");
        expect(t.history).toHaveLength(1);
      } else {
        expect(t.state).toBe("submitted");
        expect(t.history).toHaveLength(0);
        expect(kv.put).not.toHaveBeenCalled();
        // Reported as an invalid transition is (§7.3), and nothing else.
        expect(published()).toEqual(["mesh.event.task.invalid_transition"]);
        const ev = decode(nc.publish.mock.calls[0][1] as Uint8Array);
        expect((ev.payload as { data: Record<string, unknown> }).data).toMatchObject({
          task_id: TASK_ID,
          from_state: "submitted",
          to_state: "working",
          agent: RESPONDER,
          reason: "audience",
        });
      }
    });
  }

  it("a marked terminal update does not complete a working Task", async () => {
    plant("working");
    await apply(updateMsg(responderKp, "completed", { audience: "person" }));
    expect(stored()!.state).toBe("working");
    expect(published()).toEqual(["mesh.event.task.invalid_transition"]);
  });

  it("a stranger's marked update gets no signed event", async () => {
    plant("submitted");
    await apply(updateMsg(strangerKp, "working", { audience: "person" }));
    expect(stored()!.state).toBe("submitted");
    expect(nc.publish).not.toHaveBeenCalled();
  });

  it("the requester's marked update is refused like the responder's", async () => {
    plant("working");
    await apply(updateMsg(requesterKp, "canceled", { audience: "person" }));
    expect(stored()!.state).toBe("working");
    expect(published()).toEqual(["mesh.event.task.invalid_transition"]);
  });
});

describe("audience.json server.task_manager: a first update", () => {
  for (const c of cases.filter((x) => x.first_update)) {
    it(`${c.id}: creates no Task and publishes nothing`, async () => {
      await apply(updateMsg(responderKp, "submitted", c.meta));
      expect(stored()).toBeNull();
      expect(kv.put).not.toHaveBeenCalled();
      expect(nc.publish).not.toHaveBeenCalled();
    });
  }

  it("an unmarked first update still creates the Task (the control)", async () => {
    await apply(updateMsg(responderKp, "submitted", null));
    expect(stored()!.state).toBe("submitted");
  });
});

describe("audienceRefusal reads the mark as §5.7 says", () => {
  const env = (meta: unknown) => ({ meta }) as never;
  it("applies with no meta, no key, or the string agent", () => {
    expect(audienceRefusal({} as never)).toBeNull();
    expect(audienceRefusal(env({}))).toBeNull();
    expect(audienceRefusal(env({ hops: 1 }))).toBeNull();
    expect(audienceRefusal(env({ audience: "agent" }))).toBeNull();
  });
  it("refuses person, an unknown string, and a value that is not a string", () => {
    expect(audienceRefusal(env({ audience: "person" }))).toBe("person");
    expect(audienceRefusal(env({ audience: "household" }))).toMatch(/unknown string/);
    expect(audienceRefusal(env({ audience: "Agent" }))).toMatch(/unknown string/);
    expect(audienceRefusal(env({ audience: 7 }))).toMatch(/malformed/);
    expect(audienceRefusal(env({ audience: null }))).toMatch(/malformed/);
    expect(audienceRefusal(env({ audience: ["person"] }))).toMatch(/malformed/);
  });
});
