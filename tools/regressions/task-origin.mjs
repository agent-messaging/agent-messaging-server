// A Task record names the request that created it, as the server saw it, and
// says who asked for a cancellation. Failed on server 0.4.1 (no `origin`, no
// `canceled_by`), where the only link was the first history entry's
// in_reply_to, which these SDK paths leave out and which the history cap drops.
//
//   node tools/regressions/task-origin.mjs
//
// Every path runs through this repository's SDK on a live mesh:
//   - a stream request whose handler throws (the failed update carries no in_reply_to)
//   - a synchronous InputProblemsError (the creating update carries none), then
//     a resume that defers and fails
//   - a deferred completion
//   - the probe: a provider's extra respond naming an old, closed request and
//     the new task's id, sent before the real answer
//   - 55 budget revisions on a paused task (history keeps the newest 50)
//   - a buyer's cancel; a responder's cancel signed user_requested, unasked;
//     the same after the buyer's task.cancel request; a responder's own reason
// Settings as for the examples (MESH_API, MESH_ADMIN_TOKEN_FILE).

import { admin, check, connect, enroll, run, say, sdk, sleep, tenant } from "../../examples/lib/mesh.mjs";

const { InputProblemsError, createEnvelope, signEnvelope, keyPairFromSeed, encode, Subjects } = sdk;

const t = await tenant(`origin-${run}`);
const buyerAgent = await enroll(t, "task-origin buyer");
const sellerAgent = await enroll(t, "task-origin seller");
const sellerKp = keyPairFromSeed(sellerAgent.seed);
const buyerKp = keyPairFromSeed(buyerAgent.seed);

const seller = await connect(sellerAgent);
seller.onStreamRequest("stream-ok", async (_input, _ctx, writer) => {
  writer.write("a");
  writer.end("done");
});
seller.onStreamRequest("stream-boom", async () => {
  throw new Error("the stream handler broke");
});
seller.onRequest(
  "needs-file",
  async (input) => {
    if (!input?.file) {
      throw new InputProblemsError({ input: "file", problem: "missing", description: "attach the file" });
    }
    await sleep(400);
    throw new Error("failed after deferring");
  },
  { deferAfterMs: 100 },
);
seller.onRequest(
  "slow",
  async () => {
    await sleep(400);
    return { ok: true };
  },
  { deferAfterMs: 100 },
);
// The probe: a provider that tries to point a new task at an old, closed
// exchange. "quick" answers at once with no task; "probe-slow" defers and
// fails, and its admit hook first sends the buyer an extra respond that names
// the last "quick" request and the new task's id.
let lastQuick = null;
seller.onRequest("quick", async (_input, ctx) => {
  lastQuick = ctx.envelope.id;
  return { ok: true };
});
seller.onRequest(
  "probe-slow",
  async () => {
    await sleep(400);
    throw new Error("failed, so a refund would follow its origin");
  },
  {
    deferAfterMs: 100,
    admit: async ({ taskId }) => {
      publishAs(seller, sellerKp, Subjects.agentInbox(buyerAgent.id), {
        type: "respond",
        from: sellerAgent.id,
        to: buyerAgent.id,
        in_reply_to: lastQuick,
        task_id: taskId,
        payload: { status: "working" },
      });
    },
  },
);
await seller.register({
  name: `origin-seller-${run}`,
  description: "Fails and pauses in the ways the SDK can.",
  offerings: [
    { id: "stream-boom", name: "Stream boom", description: "A stream whose handler throws." },
    { id: "stream-ok", name: "Stream ok", description: "A stream that ends." },
    { id: "needs-file", name: "Needs a file", description: "Pauses for a file, then fails." },
    { id: "slow", name: "Slow", description: "Defers, then finishes." },
    { id: "quick", name: "Quick", description: "Answers at once." },
    { id: "probe-slow", name: "Probe", description: "Defers and fails after pointing its task at an old exchange." },
  ],
});
const buyer = await connect(buyerAgent);
await buyer.register({ name: `origin-buyer-${run}`, description: "Asks.", offerings: [] });
await sleep(500);

/** The stored record, through the operator's view. */
async function record(taskId) {
  const r = await admin("GET", `/tasks/${encodeURIComponent(taskId)}`);
  return r.status === 200 ? r.json.record : null;
}
/** Wait for the record to satisfy `ok`, or return the last one seen. */
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
/** A raw envelope on the wire, signed by `kp` (the paths no SDK call makes). */
function publishAs(mesh, kp, subject, fields) {
  const env = signEnvelope(createEnvelope(fields), kp);
  mesh.conn.publish(subject, encode(env));
  return env;
}

const results = [];
const expectOrigin = (name, rec, requestId, boundBy) => {
  const o = rec?.origin;
  const good =
    !!o && o.request_id === requestId && o.requester === buyerAgent.id && o.responder === sellerAgent.id && o.bound_by === boundBy;
  results.push([good, `${name}: origin is the creating request (${boundBy})`]);
  if (!good) say(`  ${name}: record ${JSON.stringify({ state: rec?.state, origin: o, first: rec?.history?.[0]?.in_reply_to })}`);
};

// 1. A stream request whose handler throws.
{
  const s = await buyer.requestStream(sellerAgent.id, "stream-boom", { go: true });
  try {
    for await (const _ of s.chunks) { /* the error chunk ends it */ }
  } catch { /* expected */ }
  const rec = await until(s.task_id, (r) => r.state === "failed" && r.origin);
  expectOrigin("stream throw", rec, s.initial_envelope.in_reply_to, "request");
}

// 2. A synchronous InputProblemsError, then a resume that defers and fails.
let paused;
{
  const r = await buyer.request(sellerAgent.id, "needs-file", {}, { timeout_ms: 10_000 });
  paused = { taskId: r.task_id, requestId: r.envelope?.in_reply_to };
  check(r.payload?.status === "input_required" && r.task_id, `the paused answer carries a task id (${JSON.stringify(r.payload)})`);
  const rec = await until(r.task_id, (x) => x.origin);
  results.push([rec?.history?.[0]?.in_reply_to === undefined, "input problems: the creating update carries no in_reply_to"]);
  expectOrigin("input problems", rec, paused.requestId, "answer");
  // The resume: the same task id on a request with the file this time.
  publishAs(buyer, buyerKp, Subjects.agentInbox(sellerAgent.id), {
    type: "request",
    from: buyerAgent.id,
    to: sellerAgent.id,
    task_id: r.task_id,
    payload: { offering: "needs-file", input: { file: "here" } },
  });
  await sleep(1500);
  const after = await record(r.task_id);
  say(`  after the resume and its deferred failure the record is ${after?.state}`);
  expectOrigin("input problems, after the resume", after, paused.requestId, "answer");
}

// 3. A deferred completion.
{
  const r = await buyer.request(sellerAgent.id, "slow", {}, { timeout_ms: 10_000 });
  check(r.payload?.status === "working" && r.task_id, `the slow answer defers (${JSON.stringify(r.payload)})`);
  const rec = await until(r.task_id, (x) => x.state === "completed" && x.origin);
  expectOrigin("deferred completion", rec, r.envelope?.in_reply_to, "answer");
}

// 3b. The probe: the new task's origin is its own request, not the old one.
{
  const quick = await buyer.request(sellerAgent.id, "quick", {}, { timeout_ms: 10_000 });
  check(quick.task_id === null && quick.payload?.status === "completed", "the quick request completes with no task");
  await sleep(300);
  const r = await buyer.request(sellerAgent.id, "probe-slow", {}, { timeout_ms: 10_000 });
  check(r.payload?.status === "working" && r.task_id, `the probe defers (${JSON.stringify(r.payload)})`);
  const rec = await until(r.task_id, (x) => x.state === "failed" && x.origin);
  results.push([rec?.origin?.request_id !== quick.envelope?.in_reply_to, "the probe: an old, closed exchange is not the new task's origin"]);
  expectOrigin("the probe", rec, r.envelope?.in_reply_to, "answer");
}

// 4. More than 50 updates.
{
  const r = await buyer.request(sellerAgent.id, "needs-file", {}, { timeout_ms: 10_000 });
  await until(r.task_id, (x) => x.origin);
  for (let i = 0; i < 55; i++) {
    buyer.reviseBudget(r.task_id, { deadline: new Date(Date.now() + 3600_000 + i * 1000).toISOString() });
    await sleep(20);
  }
  const rec = await until(r.task_id, (x) => (x.budget?.revision ?? -1) >= 54);
  results.push([rec?.history?.length === 50, `the history kept the newest 50 entries (${rec?.history?.length})`]);
  expectOrigin("55 revisions later", rec, r.envelope?.in_reply_to, "answer");
}

// 4b. A third agent names the buyer's task in a stream request, and the real
// SDK provider answers it (with #41 it refuses a request naming somebody
// else's recorded Task, and answers under the id only while it cannot read
// the record). Either way the request was the third agent's own choice of id:
// nothing lands on the buyer's record.
{
  const thirdAgent = await enroll(t, "task-origin third party");
  const third = await connect(thirdAgent);
  await third.register({ name: `origin-third-${run}`, description: "Names other people's tasks.", offerings: [] });
  const thirdKp = keyPairFromSeed(thirdAgent.seed);
  const r = await buyer.request(sellerAgent.id, "needs-file", {}, { timeout_ms: 10_000 });
  await until(r.task_id, (x) => x.origin);
  publishAs(third, thirdKp, Subjects.agentInbox(sellerAgent.id), {
    type: "request",
    from: thirdAgent.id,
    to: sellerAgent.id,
    task_id: r.task_id,
    payload: { offering: "stream-ok", input: {}, config: { stream: true } },
  });
  await sleep(1500);
  const rec = await record(r.task_id);
  const clean = !rec?.contested_by_asker && !rec?.origin_mismatch && !rec?.origin?.contested_by && !rec?.contested_by;
  results.push([clean && rec?.origin?.request_id === r.envelope?.in_reply_to, `a third agent's stream naming the buyer's task leaves its record alone (${JSON.stringify({ origin: rec?.origin?.request_id, mismatch: rec?.origin_mismatch, asker: rec?.contested_by_asker })})`]);
  await third.close();
}

// 5. Cancels.
async function pausedTask() {
  const r = await buyer.request(sellerAgent.id, "needs-file", {}, { timeout_ms: 10_000 });
  await until(r.task_id, (x) => x.origin);
  return r.task_id;
}
const sellerCancel = (taskId, reason) =>
  publishAs(seller, sellerKp, Subjects.taskUpdate(taskId), {
    type: "respond",
    from: sellerAgent.id,
    to: buyerAgent.id,
    task_id: taskId,
    payload: { status: "canceled", reason },
  });
const cancelled = (taskId) => until(taskId, (x) => x.state === "canceled" && x.canceled_by);
{
  const T = await pausedTask();
  buyer.cancel(T, "user_requested");
  const c = (await cancelled(T))?.canceled_by;
  results.push([c?.party === "requester" && c?.requester_request?.via === "update", `a buyer's cancel is the requester's (${JSON.stringify(c)})`]);
}
// A responder's cancel with no ask from the buyer: unverified `settling` at
// the transition (null is never written then), and `requester_request: null`
// only from a settle at least the grace period (60 s) later. Both are started
// here and checked after one wait.
const unasked = [];
{
  const T = await pausedTask();
  sellerCancel(T, "user_requested");
  const c = (await cancelled(T))?.canceled_by;
  results.push([
    c?.party === "responder" && c?.unverified === true && c?.unverified_reason === "settling" && !("requester_request" in (c ?? {})),
    `a responder's cancel signed user_requested, unasked, is settling at the transition (${JSON.stringify(c)})`,
  ]);
  unasked.push([T, "a responder's cancel signed user_requested, unasked, settles as the responder's"]);
}
{
  const T = await pausedTask();
  const ask = publishAs(buyer, buyerKp, Subjects.agentInbox(sellerAgent.id), {
    type: "request",
    from: buyerAgent.id,
    to: sellerAgent.id,
    payload: { offering: "task.cancel", input: { task_id: T, reason: "user_requested" } },
  });
  await sleep(500);
  sellerCancel(T, "user_requested");
  const c = (await cancelled(T))?.canceled_by;
  results.push([
    c?.party === "responder" && c?.requester_request?.via === "cancel_request" && c?.requester_request?.request_id === ask.id,
    `a responder's cancel after the buyer's task.cancel request records the buyer's ask (${JSON.stringify(c)})`,
  ]);
}
{
  const T = await pausedTask();
  sellerCancel(T, "superseded");
  const c = (await cancelled(T))?.canceled_by;
  results.push([c?.party === "responder" && c?.unverified_reason === "settling", `a responder's own reason is settling at the transition (${JSON.stringify(c)})`]);
  unasked.push([T, "a responder's own reason settles as the responder's"]);
}
for (const [T, what] of unasked) {
  const c = (await until(T, (x) => x.canceled_by?.resolved_at, 120_000))?.canceled_by;
  results.push([c?.party === "responder" && c?.requester_request === null && !c?.unverified, `${what} (${JSON.stringify(c)})`]);
}

await buyer.close();
await seller.close();
for (const [ok, what] of results) say(`  ${ok ? "ok  " : "FAIL"} ${what}`);
check(results.every(([ok]) => ok), "every task names its creating request and every cancel says who asked");
process.exit(0);
