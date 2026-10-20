// Every Task the SDK drives reaches the task manager as a legal sequence of
// states (SPEC.md §7.3), so the record ends where the work did. Failed on
// server 0.4.1 with SDK 0.62.2: after a synchronous InputProblemsError, a
// resume that deferred and then failed published `failed` straight after
// `input_required`, which §7.3 refuses, so the record stayed input_required
// (and a refund keyed on a failed Task never came).
//
//   node tools/regressions/task-transitions.mjs
//
// The paths, through this repository's SDK on a live mesh:
//   - a synchronous InputProblemsError, then a resume that defers and fails
//   - the same, with a resume that completes at once
//   - the same, with a resume that fails at once
//   - a synchronous budget pause (the record must exist for a revision)
//   - a deferred completion, which records `working` first
// Settings as for the examples (MESH_API, MESH_ADMIN_TOKEN_FILE).

import { admin, check, connect, enroll, run, say, sdk, sleep, tenant } from "../../examples/lib/mesh.mjs";

const { InputProblemsError, BudgetExhaustedError, createEnvelope, signEnvelope, keyPairFromSeed, encode, Subjects } = sdk;

const t = await tenant(`transitions-${run}`);
const buyerAgent = await enroll(t, "task-transitions buyer");
const sellerAgent = await enroll(t, "task-transitions seller");
const buyerKp = keyPairFromSeed(buyerAgent.seed);

const seller = await connect(sellerAgent);
// The first call pauses for a file; a resume with { then } does what it says.
seller.onRequest(
  "needs-file",
  async (input) => {
    if (!input?.then) throw new InputProblemsError({ input: "file", problem: "missing", description: "attach the file" });
    if (input.then === "defer-fail") {
      await sleep(400);
      throw new Error("failed after deferring");
    }
    if (input.then === "fail") throw new Error("failed at once");
    return { ok: true };
  },
  { deferAfterMs: 150 },
);
seller.onRequest("over-budget", async () => {
  throw new BudgetExhaustedError({ message: "the ceiling is reached" });
});
seller.onRequest(
  "slow",
  async () => {
    await sleep(400);
    return { ok: true };
  },
  { deferAfterMs: 100 },
);
await seller.register({
  name: `transitions-seller-${run}`,
  description: "Pauses, resumes, defers.",
  offerings: [
    { id: "needs-file", name: "Needs a file", description: "Pauses for a file." },
    { id: "over-budget", name: "Over budget", description: "Pauses on the budget." },
    { id: "slow", name: "Slow", description: "Defers, then finishes." },
  ],
});
const buyer = await connect(buyerAgent);
await buyer.register({ name: `transitions-buyer-${run}`, description: "Asks.", offerings: [] });
await sleep(500);

async function record(taskId) {
  const r = await admin("GET", `/tasks/${encodeURIComponent(taskId)}`);
  return r.status === 200 ? r.json.record : null;
}
async function until(taskId, ok, ms = 8000) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await record(taskId);
    if (last && ok(last)) return last;
    await sleep(150);
  }
  return last;
}
const statesOf = (rec) => (rec?.history ?? []).map((h) => h.payload?.status).filter(Boolean);

const results = [];

for (const [then, end] of [["defer-fail", "failed"], ["complete", "completed"], ["fail", "failed"]]) {
  const r = await buyer.request(sellerAgent.id, "needs-file", {}, { timeout_ms: 10_000 });
  check(r.payload?.status === "input_required" && r.task_id, `the first call pauses (${JSON.stringify(r.payload)})`);
  await until(r.task_id, (x) => x.state === "input_required");
  // The resume: a request naming the Task, with what was missing.
  const env = signEnvelope(
    createEnvelope({
      type: "request",
      from: buyerAgent.id,
      to: sellerAgent.id,
      task_id: r.task_id,
      payload: { offering: "needs-file", input: { file: "here", then } },
    }),
    buyerKp,
  );
  buyer.conn.publish(Subjects.agentInbox(sellerAgent.id), encode(env));
  const rec = await until(r.task_id, (x) => x.state === end);
  results.push([rec?.state === end, `a resume that ends ${then}: the record is ${rec?.state} (${statesOf(rec).join(" → ")})`]);
}

{
  const r = await buyer.request(sellerAgent.id, "over-budget", {}, { timeout_ms: 10_000 });
  const rec = r.task_id ? await until(r.task_id, (x) => x.state === "input_required") : null;
  results.push([rec?.state === "input_required", `a synchronous budget pause has a record (${rec?.state ?? "none"})`]);
}

{
  const r = await buyer.request(sellerAgent.id, "slow", {}, { timeout_ms: 10_000 });
  const rec = await until(r.task_id, (x) => x.state === "completed");
  const states = statesOf(rec);
  results.push([states[0] === "working" && rec?.state === "completed", `a deferred completion records working first (${states.join(" → ")})`]);
}

await buyer.close();
await seller.close();
for (const [ok, what] of results) say(`  ${ok ? "ok  " : "FAIL"} ${what}`);
check(results.every(([ok]) => ok), "every Task reaches its record through legal transitions");
process.exit(0);
