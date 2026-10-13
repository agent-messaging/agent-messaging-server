import { describe, it, expect } from "vitest";
import { Subjects } from "../../src/internal/subjects.js";

describe("Subjects", () => {
  it("has correct static subjects", () => {
    expect(Subjects.REGISTRY_REGISTER).toBe("mesh.registry.register");
    expect(Subjects.REGISTRY_DEREGISTER).toBe("mesh.registry.deregister");
    expect(Subjects.REGISTRY_DISCOVER).toBe("mesh.registry.discover");
  });

  it("builds agent inbox subject", () => {
    expect(Subjects.agentInbox("agent-123")).toBe("mesh.agent.agent-123.inbox");
  });

  it("builds task update subject", () => {
    expect(Subjects.taskUpdate("task-456")).toBe("mesh.task.task-456.update");
  });

  it("builds task stream subject", () => {
    expect(Subjects.taskStream("task-456")).toBe("mesh.task.task-456.stream");
  });

  it("builds event subject", () => {
    expect(Subjects.event("user.online")).toBe("mesh.event.user.online");
  });

  it("builds heartbeat subject", () => {
    expect(Subjects.heartbeat("agent-123")).toBe("mesh.heartbeat.agent-123");
  });
});
