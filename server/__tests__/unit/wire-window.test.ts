/**
 * MESH_WIRE_0_3_0 (shared/wire-window.ts): the operator ends the 0.3.0 wire's
 * transition window. Credentials then stop granting subscribe on Task
 * subjects (a 0.4.0 reader is delivered its stream by the task manager), and
 * the 0.3.0 Task read is refused with INVALID_VERSION.
 */
import { describe, it, expect, afterEach } from "vitest";
import { WIRE_0_3_0_SETTING, wire030Refused, wire030RefusalError } from "../../src/shared/wire-window.js";
import { durableAgentPermissions, nodePermissions, sandboxPermissions, consoleReaderPermissions, jobWorkerPermissions } from "../../src/keychain/cred-template.js";
import { nkeys } from "../../src/sdk.js";

const KEY = nkeys.createUser().getPublicKey();

afterEach(() => {
  delete process.env[WIRE_0_3_0_SETTING];
});

const taskSubs = (subs: string[]) => subs.filter((s) => s.startsWith("mesh.task."));

describe("the 0.3.0 window", () => {
  it("is open by default, and on anything but refuse", () => {
    expect(wire030Refused()).toBe(false);
    process.env[WIRE_0_3_0_SETTING] = "accept";
    expect(wire030Refused()).toBe(false);
    process.env[WIRE_0_3_0_SETTING] = "Refuse";
    expect(wire030Refused()).toBe(true);
  });

  it("while open, credentials grant subscribe on Task subjects for 0.3.0 readers", () => {
    expect(taskSubs(durableAgentPermissions(KEY).sub.allow)).toEqual(["mesh.task.>"]);
    expect(taskSubs(nodePermissions(KEY, [KEY]).sub.allow)).toEqual(["mesh.task.>"]);
  });

  it("once over, no credential subscribes to a Task's subjects; publishing stays", () => {
    process.env[WIRE_0_3_0_SETTING] = "refuse";
    for (const perms of [
      durableAgentPermissions(KEY),
      nodePermissions(KEY, [KEY]),
      sandboxPermissions(KEY),
      consoleReaderPermissions(KEY),
      jobWorkerPermissions(KEY),
    ]) {
      expect(taskSubs(perms.sub.allow)).toEqual([]);
    }
    expect(durableAgentPermissions(KEY).pub.allow).toContain("mesh.task.>");
    expect(sandboxPermissions(KEY).pub.allow).toContain("mesh.task.a2a.follow");
  });

  it("refuses a 0.3.0 call in plain words, as INVALID_VERSION", () => {
    const e = wire030RefusalError();
    expect(e.code).toBe("INVALID_VERSION");
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/0\.3\.0/);
    expect(e.details).toMatchObject({ setting: WIRE_0_3_0_SETTING });
  });
});
