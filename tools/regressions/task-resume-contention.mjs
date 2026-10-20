// A stranger naming a paused task cannot block its requester's resume.
// Failed on #39 at 67dbd06: the SDK claimed a named task id before checking
// the sender, so a stranger's request 5 ms ahead held the id through the
// record read, and the requester's resume was refused for good
// (TASK_INVALID_TRANSITION, not retryable). Repeated, nobody could resume.
//
//   node tools/regressions/task-resume-contention.mjs
//
// The provider restarts after the pause, so it remembers nothing and reads
// the record for both requests. Settings as for the examples (MESH_API,
// MESH_ADMIN_TOKEN_FILE).

import { admin, check, connect, enroll, run, say, sdk, sleep, tenant } from "../../examples/lib/mesh.mjs";

const { InputProblemsError, createEnvelope, signEnvelope, keyPairFromSeed, encode, decode, Subjects } = sdk;

const t = await tenant(`contention-${run}`);
const buyerAgent = await enroll(t, "contention buyer");
const sellerAgent = await enroll(t, "contention provider");
const strangerAgent = await enroll(t, "contention stranger");

const ran = [];
async function provider() {
  const p = await connect(sellerAgent);
  p.onRequest("needs-file", async (input) => {
    if (!input?.file) throw new InputProblemsError({ input: "file", problem: "missing", description: "attach the file" });
    ran.push(input.who);
    return { ok: true };
  });
  await p.register({
    name: `contention-seller-${run}`,
    description: "Pauses for a file.",
    offerings: [{ id: "needs-file", name: "Needs a file", description: "Pauses for a file." }],
  });
  return p;
}

let seller = await provider();
const buyer = await connect(buyerAgent);
await buyer.register({ name: `contention-buyer-${run}`, description: "Asks.", offerings: [] });
const stranger = await connect(strangerAgent);
await stranger.register({ name: `contention-stranger-${run}`, description: "Names other people's tasks.", offerings: [] });
await sleep(500);

const record = async (id) => {
  const r = await admin("GET", `/tasks/${encodeURIComponent(id)}`);
  return r.status === 200 ? r.json.record : null;
};
const answers = { buyer: [], stranger: [] };
const listen = (mesh, agent, into) =>
  mesh.conn.subscribe(Subjects.agentInbox(agent.id), (m) => {
    try {
      const e = decode(m.data);
      into.push({ irt: e.in_reply_to, status: e.payload?.status, err: e.error?.code, retryable: e.error?.retryable });
    } catch {
      /* not an envelope */
    }
  });

// The pause.
const first = await buyer.request(sellerAgent.id, "needs-file", {}, { timeout_ms: 10_000 });
const T = first.task_id;
check(first.payload?.status === "input_required" && T, `the first call pauses (${JSON.stringify(first.payload)})`);
for (let i = 0; i < 40 && (await record(T))?.state !== "input_required"; i++) await sleep(100);

// The provider restarts: it remembers nothing of the pause.
await seller.close();
seller = await provider();
await sleep(500);

listen(buyer, buyerAgent, answers.buyer);
listen(stranger, strangerAgent, answers.stranger);
const send = (mesh, agent, who) => {
  const env = signEnvelope(
    createEnvelope({ type: "request", from: agent.id, to: sellerAgent.id, task_id: T, payload: { offering: "needs-file", input: { file: "here", who } } }),
    keyPairFromSeed(agent.seed),
  );
  mesh.conn.publish(Subjects.agentInbox(sellerAgent.id), encode(env));
  return env;
};
const fromStranger = send(stranger, strangerAgent, "stranger");
await sleep(5);
const resume = send(buyer, buyerAgent, "buyer");
await sleep(4000);

const rec = await record(T);
const toStranger = answers.stranger.find((a) => a.irt === fromStranger.id);
const toBuyer = answers.buyer.filter((a) => a.irt === resume.id);
say(`  ran ${JSON.stringify(ran)}; stranger ${JSON.stringify(toStranger)}; buyer ${JSON.stringify(toBuyer)}; record ${rec?.state}`);
await buyer.close();
await stranger.close();
await seller.close();
check(ran.length === 1 && ran[0] === "buyer", "only the buyer's resume ran");
check(toStranger?.err === "UNAUTHORIZED", `the stranger was refused as not its requester (${toStranger?.err})`);
check(toBuyer.length > 0 && toBuyer.every((a) => !a.err), "the buyer's resume was answered, not refused");
check(rec?.state === "completed", `the resumed task completed on its record (${rec?.state})`);
process.exit(0);
