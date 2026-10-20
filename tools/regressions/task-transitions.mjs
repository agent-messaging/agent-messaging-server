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
//   - a third agent naming the buyer's paused Task: refused, the Task untouched
//     (failed on the first #41 head, which took any request naming a Task as
//     its resume and recorded the stranger's outcome on the buyer's Task)
//   - a streaming request that falls through to a plain handler and answers
//     at once: no Task record (the first #41 head created one, and with it a
//     §19.2 receipt and meter events)
// Settings as for the examples (MESH_API, MESH_ADMIN_TOKEN_FILE).

import { admin, check, connect, enroll, run, say, sdk, sleep, tenant } from "../../examples/lib/mesh.mjs";

const { InputProblemsError, BudgetExhaustedError, createEnvelope, signEnvelope, keyPairFromSeed, encode, Subjects } = sdk;

const t = await tenant(`transitions-${run}`);
const buyerAgent = await enroll(t, "task-transitions buyer");
const sellerAgent = await enroll(t, "task-transitions seller");
const strangerAgent = await enroll(t, "task-transitions stranger");
const strangerKp = keyPairFromSeed(strangerAgent.seed);
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
seller.onRequest("plain", async () => ({ ok: true }));
await seller.register({
  name: `transitions-seller-${run}`,
  description: "Pauses, resumes, defers.",
  offerings: [
    { id: "needs-file", name: "Needs a file", description: "Pauses for a file." },
    { id: "over-budget", name: "Over budget", description: "Pauses on the budget." },
    { id: "slow", name: "Slow", description: "Defers, then finishes." },
    { id: "plain", name: "Plain", description: "Answers at once." },
  ],
});
const buyer = await connect(buyerAgent);
await buyer.register({ name: `transitions-buyer-${run}`, description: "Asks.", offerings: [] });
const stranger = await connect(strangerAgent);
await stranger.register({ name: `transitions-stranger-${run}`, description: "Names other agents' Tasks.", offerings: [] });
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
  // A budget pause answers with BUDGET_EXHAUSTED, which request() throws,
  // carrying the live Task's id in the error's details.
  let taskId = null;
  try {
    const r = await buyer.request(sellerAgent.id, "over-budget", {}, { timeout_ms: 10_000 });
    taskId = r.task_id;
  } catch (e) {
    taskId = e?.details?.task_id ?? null;
  }
  const rec = taskId ? await until(taskId, (x) => x.state === "input_required") : null;
  results.push([rec?.state === "input_required", `a synchronous budget pause has a record (${rec?.state ?? "none"})`]);
}

{
  const r = await buyer.request(sellerAgent.id, "slow", {}, { timeout_ms: 10_000 });
  const rec = await until(r.task_id, (x) => x.state === "completed");
  const states = statesOf(rec);
  results.push([states[0] === "working" && rec?.state === "completed", `a deferred completion records working first (${states.join(" → ")})`]);
}

/** A signed request on the seller's inbox, as `from`, naming `taskId`. */
function sendNaming(via, from, kp, taskId, payload) {
  const env = signEnvelope(
    createEnvelope({ type: "request", from: from.id, to: sellerAgent.id, task_id: taskId, payload }),
    kp,
  );
  via.conn.publish(Subjects.agentInbox(sellerAgent.id), encode(env));
}

{
  // A stranger names the buyer's paused Task. The seller is a party to it, so
  // the task manager would take whatever the seller recorded there.
  const r = await buyer.request(sellerAgent.id, "needs-file", {}, { timeout_ms: 10_000 });
  check(r.payload?.status === "input_required" && r.task_id, `the first call pauses (${JSON.stringify(r.payload)})`);
  const before = await until(r.task_id, (x) => x.state === "input_required");
  const seen = (before?.history ?? []).length;
  sendNaming(stranger, strangerAgent, strangerKp, r.task_id, { offering: "needs-file", input: { file: "mine", then: "complete" } });
  await sleep(2500);
  const after = await record(r.task_id);
  const untouched = after?.state === "input_required" && (after?.history ?? []).length === seen;
  results.push([untouched, `a stranger naming the buyer's paused Task leaves it alone (${statesOf(after).join(" → ")})`]);
  // The buyer still resumes it.
  sendNaming(buyer, buyerAgent, buyerKp, r.task_id, { offering: "needs-file", input: { file: "here", then: "complete" } });
  const rec = await until(r.task_id, (x) => x.state === "completed");
  results.push([rec?.state === "completed", `its own requester still resumes it (${statesOf(rec).join(" → ")})`]);
}

{
  // A requestStream's requester-made task id, on an offering with no stream
  // handler: the plain handler answers at once, a bare reply, no Task.
  const taskId = crypto.randomUUID();
  sendNaming(buyer, buyerAgent, buyerKp, taskId, { offering: "plain", input: {}, config: { stream: true } });
  await sleep(2500);
  const rec = await record(taskId);
  results.push([rec === null, `a stream that falls through to a plain answer creates no Task (${rec ? statesOf(rec).join(" → ") : "none"})`]);
}

await buyer.close();
await stranger.close();
await seller.close();
for (const [ok, what] of results) say(`  ${ok ? "ok  " : "FAIL"} ${what}`);
check(results.every(([ok]) => ok), "every Task reaches its record through legal transitions");
process.exit(0);
