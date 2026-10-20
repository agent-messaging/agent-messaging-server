// Two stream requests naming the same new task id, back to back, run as ONE
// task: the second is refused and never runs, and the record's origin is the
// first. Failed on #39 at 2083338 with the SDK on main: both dispatches
// resolved "no record" before either was remembered, so both ran under the
// id, and the record (failed, by the cheap one) named the expensive one as
// its origin.
//
//   node tools/regressions/task-origin-double-stream.mjs
//
// The reviewer's probe, kept as a check. Settings as for the examples
// (MESH_API, MESH_ADMIN_TOKEN_FILE).

import { admin, check, connect, enroll, run, say, sdk, sleep, tenant } from "../../examples/lib/mesh.mjs";

const { createEnvelope, signEnvelope, keyPairFromSeed, encode, decode, Subjects } = sdk;

const t = await tenant(`p39-${run}`);
const B = await enroll(t, "double-stream buyer");
const P = await enroll(t, "double-stream provider");
const bKp = keyPairFromSeed(B.seed);

const ran = [];
const seller = await connect(P);
seller.onStreamRequest("expensive-ok", async (_i, _c, w) => {
  ran.push("expensive");
  w.write("the expensive output");
  await sleep(1500);
  w.end("done");
});
seller.onStreamRequest("cheap-fail", async () => {
  ran.push("cheap");
  await sleep(200);
  throw new Error("bad input");
});
await seller.register({
  name: `p39-seller-${run}`,
  description: "One expensive stream, one cheap one.",
  offerings: [
    { id: "expensive-ok", name: "E", description: "Succeeds slowly." },
    { id: "cheap-fail", name: "C", description: "Fails fast." },
  ],
});
const buyer = await connect(B);
await buyer.register({ name: `p39-buyer-${run}`, description: "Sends two streams at once.", offerings: [] });
await sleep(500);

const rec = async (id) => {
  const r = await admin("GET", `/tasks/${encodeURIComponent(id)}`);
  return r.status === 200 ? r.json.record : null;
};
const T = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const answers = [];
buyer.conn.subscribe(Subjects.agentInbox(B.id), (m) => {
  try {
    const e = decode(m.data);
    answers.push({ irt: e.in_reply_to, task_id: e.task_id, status: e.payload?.status, err: e.error?.code });
  } catch {
    /* not an envelope */
  }
});
const mk = (offering) =>
  signEnvelope(
    createEnvelope({ type: "request", from: B.id, to: P.id, task_id: T, payload: { offering, input: { x: 1 }, config: { stream: true } } }),
    bKp,
  );
const rOk = mk("expensive-ok");
const rFail = mk("cheap-fail");
buyer.conn.publish(Subjects.agentInbox(P.id), encode(rOk));
buyer.conn.publish(Subjects.agentInbox(P.id), encode(rFail));
await sleep(4000);
const r = await rec(T);
say(`  record ${JSON.stringify({ state: r?.state, origin: r?.origin?.request_id, multiple: r?.origin?.multiple_requests })}`);
say(`  ran ${JSON.stringify(ran)}; answers ${JSON.stringify(answers.map((a) => ({ to: a.irt === rOk.id ? "ok" : a.irt === rFail.id ? "fail" : a.irt, status: a.status, err: a.err })))}`);

const refused = answers.find((a) => a.irt === rFail.id && a.err === "TASK_INVALID_TRANSITION");
await buyer.close();
await seller.close();
check(ran.length === 1 && ran[0] === "expensive", "only the first request ran under the task id");
check(!!refused, "the second request naming the id was refused (TASK_INVALID_TRANSITION)");
check(r?.state === "completed" && r?.origin?.request_id === rOk.id, `the record completed with the first request as its origin (${r?.state}, ${r?.origin?.request_id})`);
check(!r?.origin?.multiple_requests && !r?.origin?.contested_by, "nothing else is on the record");
process.exit(0);
