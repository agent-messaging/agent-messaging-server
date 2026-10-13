/**
 * The mesh, not the scenario: a deferred task's result must reach the
 * requester however quickly the handler finishes after deferring. The
 * approval step depends on this. Each case defers at once (deferAfterMs 0)
 * and finishes after a different delay.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMesh } from "agent-messaging";
import { connect, enroll, runId, sleep, tenant } from "../src/mesh.js";

let caller: AgentMesh;
let worker: AgentMesh;
let workerId = "";

beforeAll(async () => {
  const t = await tenant(`timing-${runId()}`);
  const a = await enroll(t, "timing caller");
  const b = await enroll(t, "timing worker");
  workerId = b.id;
  worker = await connect(b);
  worker.onRequest("work", async (input) => {
    await sleep((input as { ms: number }).ms);
    return { done: true, ms: (input as { ms: number }).ms };
  }, { deferAfterMs: 0 });
  await worker.register({ name: `timing-worker`, description: "Finishes after a delay.", visibility: "unlisted", offerings: [{ id: "work", name: "Work", description: "Sleep, then answer." }] } as any);
  caller = await connect(a);
});
afterAll(async () => {
  await Promise.allSettled([caller?.close(), worker?.close()]);
});

describe("a deferred task's result reaches the requester", () => {
  for (const ms of [0, 50, 250, 1000]) {
    it(`when the handler finishes ${ms} ms after deferring`, async () => {
      const r = await caller.request(workerId, "work", { ms }, { timeout_ms: 10_000 });
      // A handler that wins the race answers bare, with no task: also correct.
      const output = r.task_id ? (await caller.awaitTask(r.task_id, 10_000)).output : r.payload?.output;
      expect(output).toEqual({ done: true, ms });
    });
  }
});
