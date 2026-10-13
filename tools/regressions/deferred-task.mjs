// A deferred task's terminal answer reaches the requester whenever it lands.
// Failed on server 0.1.3 with SDK 0.60.0 on RabbitMQ.
//
//   node tools/regressions/deferred-task.mjs
//
// A worker defers ("working") after 100 ms and finishes `d` ms later, for d
// from 0 to 300 ms. The requester waits with awaitTask. On RabbitMQ the
// requester's subscription to the task's update subject used to bind a few
// tens of milliseconds after "working" arrived, so a terminal update that
// landed in that gap was routed to no queue and never arrived (awaitTask
// timed out). Settings as for the examples (MESH_API, MESH_ADMIN_TOKEN_FILE).

import { check, connect, enroll, run, say, sleep, tenant } from "../../examples/lib/mesh.mjs";

const DEFER_MS = 100;
const GAPS = (process.env.DEFER_GAPS ?? "0,10,20,30,40,50,60,70,80,90,100,125,150,200,250,300").split(",").map(Number);
const ROUNDS = Number(process.env.DEFER_ROUNDS ?? 2);

const t = await tenant(`defer-${run}`);
const callerAgent = await enroll(t, "deferred-task caller");
const workerAgent = await enroll(t, "deferred-task worker");

const worker = await connect(workerAgent);
worker.onRequest(
  "slow",
  async (input) => {
    await sleep(DEFER_MS + input.gap_ms);
    return { done: true, gap_ms: input.gap_ms };
  },
  { deferAfterMs: DEFER_MS },
);
await worker.register({ name: `defer-worker-${run}`, description: "Finishes a little after it defers.", offerings: [{ id: "slow", name: "Slow", description: "Defers, then finishes." }] });
const caller = await connect(callerAgent);
await caller.register({ name: `defer-caller-${run}`, description: "Waits for deferred work.", offerings: [] });
await sleep(500);

const failures = [];
let late = 0; // the longest awaitTask took beyond the work itself, in ms
for (let round = 0; round < ROUNDS; round++) {
  for (const gap of GAPS) {
    const r = await caller.request(workerAgent.id, "slow", { gap_ms: gap }, { timeout_ms: 15_000 });
    if (r.payload?.status === "completed" && !r.task_id) continue; // finished before the deferral: nothing to wait for
    if (r.payload?.status !== "working" || !r.task_id) {
      failures.push(`gap ${gap} ms: unexpected answer (${JSON.stringify(r.payload)})`);
      continue;
    }
    try {
      const waited = Date.now();
      const done = await caller.awaitTask(r.task_id, 8_000);
      late = Math.max(late, Date.now() - waited - gap);
      if (done.status !== "completed" || done.output?.gap_ms !== gap) failures.push(`gap ${gap} ms: wrong terminal ${JSON.stringify(done)}`);
    } catch (e) {
      failures.push(`gap ${gap} ms (round ${round + 1}): ${e.message}`);
    }
  }
}
for (const f of failures) say(`  lost: ${f}`);
say(`  the slowest terminal answer came ${late} ms after the work finished`);
await caller.close();
await worker.close();
check(late < 1000, `every terminal answer came within a second of the work finishing (slowest ${late} ms)`);
check(failures.length === 0, `every deferred task's terminal answer arrived (${GAPS.length * ROUNDS} tasks, finishing 0 to ${Math.max(...GAPS)} ms after "working")`);
process.exit(0);
