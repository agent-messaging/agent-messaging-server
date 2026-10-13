import { describe, it, expect } from "vitest";
import { TaskTracker } from "../../src/internal/task-tracker.js";
import { MeshError } from "../../src/types/errors.js";
import type { Task } from "../../src/types/task.js";

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-1",
    requester: "agent-a",
    responder: "agent-b",
    offering: "chat",
    state: "submitted",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    history: [],
    artifacts: [],
    ...overrides,
  };
}

describe("TaskTracker", () => {
  it("creates and retrieves a task", () => {
    const tracker = new TaskTracker();
    tracker.create(makeTask());
    const task = tracker.get("task-1");
    expect(task).toBeDefined();
    expect(task!.id).toBe("task-1");
    expect(task!.state).toBe("submitted");
  });

  it("returns undefined for unknown task", () => {
    const tracker = new TaskTracker();
    expect(tracker.get("nope")).toBeUndefined();
  });

  it("returns a defensive copy", () => {
    const tracker = new TaskTracker();
    tracker.create(makeTask());
    const a = tracker.get("task-1")!;
    const b = tracker.get("task-1")!;
    expect(a).not.toBe(b);
    expect(a.history).not.toBe(b.history);
  });

  it("transitions through valid states", () => {
    const tracker = new TaskTracker();
    tracker.create(makeTask());
    tracker.transition("task-1", "working");
    expect(tracker.get("task-1")!.state).toBe("working");
    tracker.transition("task-1", "completed");
    expect(tracker.get("task-1")!.state).toBe("completed");
  });

  it("rejects invalid transitions", () => {
    const tracker = new TaskTracker();
    tracker.create(makeTask());
    expect(() => tracker.transition("task-1", "completed")).toThrow(MeshError);
  });

  it("throws on transition of unknown task", () => {
    const tracker = new TaskTracker();
    expect(() => tracker.transition("nope", "working")).toThrow(MeshError);
  });

  it("adds to history", () => {
    const tracker = new TaskTracker();
    tracker.create(makeTask());
    tracker.addToHistory("task-1", { id: "env-1" } as any);
    expect(tracker.get("task-1")!.history).toHaveLength(1);
  });

  it("adds artifacts", () => {
    const tracker = new TaskTracker();
    tracker.create(makeTask());
    tracker.addArtifacts("task-1", [
      { id: "a1", name: "file", media_type: "text/plain", parts: [] },
    ]);
    expect(tracker.get("task-1")!.artifacts).toHaveLength(1);
  });

  it("prunes terminal tasks older than maxAge", () => {
    const tracker = new TaskTracker();
    const old = makeTask({
      state: "completed",
      updated_at: new Date(Date.now() - 600_000).toISOString(),
    });
    tracker.create(old);
    tracker.prune(300_000);
    expect(tracker.get("task-1")).toBeUndefined();
  });

  it("does not prune non-terminal tasks", () => {
    const tracker = new TaskTracker();
    const active = makeTask({
      state: "working",
      updated_at: new Date(Date.now() - 600_000).toISOString(),
    });
    tracker.create(active);
    tracker.prune(300_000);
    expect(tracker.get("task-1")).toBeDefined();
  });

  it("caps history at 50 entries, keeping newest", () => {
    const tracker = new TaskTracker();
    tracker.create(makeTask());
    for (let i = 0; i < 60; i++) {
      tracker.addToHistory("task-1", { id: `env-${i}` } as any);
    }
    const task = tracker.get("task-1")!;
    expect(task.history).toHaveLength(50);
    // Should keep the newest entries (env-10 through env-59)
    expect((task.history[0] as any).id).toBe("env-10");
    expect((task.history[49] as any).id).toBe("env-59");
  });
});
