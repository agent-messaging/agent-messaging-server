// What a caller is told when it sends to an agent the operator stopped.
// Failed on server 0.1.3 with SDK 0.60.0, on both brokers.
//
//   node tools/regressions/stopped-agent.mjs
//
// SPEC §4.12: a paused agent's mail waits, and the sender is told it is paused
// and that the message waits. A revoked signing key (§4.10) is never read
// again, so its sender is refused, whether the agent was paused or running
// when it was revoked. Settings as for the examples (MESH_API,
// MESH_ADMIN_TOKEN_FILE).

import { admin, check, connect, enroll, run, say, sleep, tenant } from "../../examples/lib/mesh.mjs";

const t = await tenant(`stopped-${run}`);
const caller = await enroll(t, "stopped-agent caller");
const callerMesh = await connect(caller);
await callerMesh.register({ name: `stopped-caller-${run}`, offerings: [] });

async function startWorker(label) {
  const agent = await enroll(t, label);
  const mesh = await connect(agent, { reconnect: false });
  mesh.onRequest("ping", () => ({ pong: true }));
  await mesh.register({ name: `${label.replace(/\W+/g, "-")}-${run}`, visibility: "public", offerings: [{ id: "ping", name: "Ping", description: "Answers pong." }] });
  return { agent, mesh };
}

async function outcome(to) {
  try {
    const r = await callerMesh.request(to, "ping", {}, { timeout_ms: 6_000 });
    return { answered: r.payload };
  } catch (e) {
    return { code: e.code, message: e.message, details: e.details ?? {} };
  }
}

const paused = await startWorker("paused worker");
const running = await startWorker("running worker");
check((await outcome(paused.agent.id)).answered?.output?.pong === true, "the first worker answers while it runs");

// A pause: the operator's revoke (mesh-admin credentials revoke).
check((await admin("POST", "/credentials/revoke", { agent: paused.agent.id, reason: "regression: pause" })).status === 200, "the operator paused the first worker");
await sleep(2_000);
const p = await outcome(paused.agent.id);
say(`  paused: ${p.code} ${JSON.stringify(p.details)}`);
check(p.code === "REQUEST_QUEUED" && p.details.paused === true && p.details.reason === "agent_paused", "a caller is told the agent is paused, and that the message waits");
check(/is paused/.test(p.message ?? ""), "the error's own sentence says paused");

// Revoked signing keys: permanent. One on the paused worker, one on a worker
// still running. The registry and the admission service learn of a
// revocation within their 15-second memo of "not revoked", so wait that out.
for (const w of [paused, running]) {
  check((await admin("POST", "/agent-keys/revoke", { agent: w.agent.id, reason: "regression: revoked key" })).status === 200, `the operator revoked a worker's signing key`);
}
await sleep(16_000);
for (const [label, w] of [["paused", paused], ["running", running]]) {
  const r = await outcome(w.agent.id);
  say(`  revoked while ${label}: ${r.code} ${JSON.stringify(r.details)}`);
  check(r.code === "AGENT_UNAVAILABLE" && r.details.reason === "agent_key_revoked" && r.details.captured !== true, `a caller is refused and told the key was revoked (the agent was ${label}), and nothing is said to be kept`);
}

await callerMesh.close();
for (const w of [paused, running]) await w.mesh.close().catch(() => {});
process.exit(0);
