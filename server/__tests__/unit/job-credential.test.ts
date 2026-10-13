// ONE JOB'S CREDENTIAL: what crosses the boundary when the work runs on a
// machine we do not own.
//
// The fleet runs every agent as a long-lived process on a host we own, holding
// a durable credential that can register, listen, drain a mailbox, open rooms
// and reach anyone. We are moving that work onto burstable sandboxes from
// providers we do not control, and the durable seed must not go with it: a
// provider holding it could BE the agent, across every job, until somebody
// noticed.
//
// So one process becomes two. A supervisor we run keeps the address, the
// registration and the mailbox. A worker somewhere else does one message and
// exits. These tests hold the line between them, and the one that matters most
// is that a worker can never listen as the agent.

import { describe, it, expect } from "vitest";
import {
  assertJobWorkerNarrow,
  durableAgentPermissions,
  jobWorkerPermissions,
} from "../../src/keychain/cred-template.js";

const KEY = "UAKCCX76EVFZHC4DNGPIF47ZBDV3W4PZAADPKL25F3ADW6KM6KFDQSMV";
const OTHER = "UDQSJEYPO7XZI3L2A233DXNI7OXUOAU43GJB7ITZRAWTRG5NJATRTQS5";

describe("what a worker may do", () => {
  it("answers the message it was given, and stores what it made", () => {
    const p = jobWorkerPermissions(KEY);
    expect(p.pub.allow).toContain(`mesh.agent.${KEY}.outbox`);
    expect(p.pub.allow).toContain("mesh.artifacts.put");
    expect(p.pub.allow).toContain("mesh.task.>");
    expect(p.pub.allow).toContain(`mesh.trace.${KEY}`);
  });

  it("never listens as the agent, which is the narrowing the whole split rests on", () => {
    const p = jobWorkerPermissions(KEY);
    // Not its own inbox, not anyone's, by any spelling.
    for (const s of p.sub.allow) expect(s.startsWith("mesh.agent.")).toBe(false);
    expect(p.sub.deny).toContain("mesh.agent.>");
    // A worker that could subscribe here could take the message meant for the
    // next job, and nothing would record that it had.
  });

  it("cannot change what the agent is, or who may reach it", () => {
    const p = jobWorkerPermissions(KEY);
    for (const s of [
      "mesh.registry.register",
      "mesh.registry.deregister",
      "mesh.admission.guard",
      "mesh.admission.unguard",
      "mesh.rooms.provision",
      "mesh.board.post",
    ]) {
      expect(p.pub.allow).not.toContain(s);
    }
  });

  it("cannot reach the mailbox, because the mailbox is the supervisor's", () => {
    const p = jobWorkerPermissions(KEY);
    expect(p.pub.allow.filter((s) => s.startsWith("$JS."))).toEqual([]);
    expect(p.pub.allow.filter((s) => s.startsWith("$KV."))).toEqual([]);
  });

  it("does not publish the agent's feed: a worker speaks about its job, not for the agent", () => {
    const p = jobWorkerPermissions(KEY);
    expect(p.pub.allow.filter((s) => s.startsWith("mesh.feed."))).toEqual([]);
  });

  it("is far narrower than the durable credential it replaces", () => {
    const worker = jobWorkerPermissions(KEY);
    const durable = durableAgentPermissions(KEY);
    expect(worker.pub.allow.length).toBeLessThan(durable.pub.allow.length / 2);
    expect(worker.sub.allow.length).toBeLessThan(durable.sub.allow.length);
    // Everything a worker may publish, the durable credential could too: this
    // is a restriction of an existing grant, never a new power.
    const extra = worker.pub.allow.filter((s) => !durable.pub.allow.includes(s));
    expect(extra).toEqual([]);
  });
});

describe("a job whose work is to send to other agents", () => {
  it("is granted that per JOB, never per agent", () => {
    expect(jobWorkerPermissions(KEY).pub.allow).not.toContain("mesh.agent.*.inbox");
    const sender = jobWorkerPermissions(KEY, { sends: true });
    expect(sender.pub.allow).toContain("mesh.agent.*.inbox");
    // Our process runner sends each phase to its holder, so it also has to be
    // able to look a holder up. Nothing else on the fleet needs either.
    expect(sender.pub.allow).toContain("mesh.registry.discover");
    // And still cannot register or deregister anything.
    expect(sender.pub.allow).not.toContain("mesh.registry.register");
  });

  it("still cannot listen as the agent", () => {
    const sender = jobWorkerPermissions(KEY, { sends: true });
    for (const s of sender.sub.allow) expect(s.startsWith("mesh.agent.")).toBe(false);
  });
});

describe("the guard that runs before anything is minted", () => {
  const ok = (p: ReturnType<typeof jobWorkerPermissions>, opts?: { sends?: boolean }) =>
    expect(() => assertJobWorkerNarrow(p, KEY, opts)).not.toThrow();

  it("passes what the template produces", () => {
    ok(jobWorkerPermissions(KEY));
    ok(jobWorkerPermissions(KEY, { sends: true }), { sends: true });
  });

  it("refuses an empty allow list, because empty INHERITS the account defaults", () => {
    const p = jobWorkerPermissions(KEY);
    expect(() => assertJobWorkerNarrow({ ...p, pub: { allow: [], deny: p.pub.deny } }, KEY)).toThrow(/INHERITS/);
    expect(() => assertJobWorkerNarrow({ ...p, sub: { allow: [], deny: p.sub.deny } }, KEY)).toThrow(/INHERITS/);
  });

  it("refuses a subscribe that reaches an inbox", () => {
    const p = jobWorkerPermissions(KEY);
    p.sub.allow.push(`mesh.agent.${KEY}.inbox`);
    expect(() => assertJobWorkerNarrow(p, KEY)).toThrow(/never listen as the agent/);
  });

  it("refuses speaking as another agent", () => {
    const p = jobWorkerPermissions(KEY);
    p.pub.allow.push(`mesh.agent.${OTHER}.outbox`);
    expect(() => assertJobWorkerNarrow(p, KEY)).toThrow(/another agent's outbox/);
  });

  it("refuses a mailbox grant: that belongs to the supervisor", () => {
    const p = jobWorkerPermissions(KEY);
    p.pub.allow.push("$JS.API.STREAM.INFO.anything");
    expect(() => assertJobWorkerNarrow(p, KEY)).toThrow(/belongs to the supervisor/);
  });

  it("refuses reaching other agents unless the job said it sends, and refuses saying so without the grant", () => {
    const quiet = jobWorkerPermissions(KEY);
    quiet.pub.allow.push("mesh.agent.*.inbox");
    expect(() => assertJobWorkerNarrow(quiet, KEY)).toThrow(/without the job declaring/);
    const sender = jobWorkerPermissions(KEY);
    expect(() => assertJobWorkerNarrow(sender, KEY, { sends: true })).toThrow(/nothing grants it a way to/);
  });

  it("refuses when a deny the account relies on has been dropped", () => {
    const p = jobWorkerPermissions(KEY);
    p.pub.deny = p.pub.deny.filter((s) => s !== "$KV.>");
    expect(() => assertJobWorkerNarrow(p, KEY)).toThrow(/pub\.deny is missing/);
  });
});
