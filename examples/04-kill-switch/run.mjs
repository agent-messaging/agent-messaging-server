// The kill switch: revoke an agent and watch it get cut off live.
//
//   node examples/04-kill-switch/run.mjs
//
// A worker agent is connected and answering. The mesh's operator revokes it
// (the admin API's POST /admin/v1/credentials/revoke, which is what
// `mesh-admin credentials revoke --agent KEY` sends). The broker closes the
// worker's connection within seconds, without a restart; its credential stops
// working, and it can get no new one. The operator restores it, the worker
// enrolls again, and it is back.

import { admin, check, connect, enroll, run, say, sleep, tenant } from "../lib/mesh.mjs";

const team = await tenant(`ops-${run}`);
const worker = await enroll(team, "worker");
const caller = await enroll(team, "caller");

/** The worker. It does not reconnect on its own, so a cut shows as a closed connection. */
async function startWorker(agent) {
  const mesh = await connect(agent, { reconnect: false });
  mesh.onRequest("ping", () => ({ pong: true, at: new Date().toISOString() }));
  await mesh.register({ name: "worker", visibility: "public", offerings: [{ id: "ping", name: "Ping", description: "Answers pong." }] });
  return mesh;
}

let workerMesh = await startWorker(worker);
const callerMesh = await connect(caller);
const first = await callerMesh.request(worker.id, "ping", {}, { timeout_ms: 10_000 });
check(first.payload?.output?.pong === true, "the worker is online and answering");

say("The operator revokes the worker.");
const revokedAt = Date.now();
const revoke = await admin("POST", "/credentials/revoke", { agent: worker.id, reason: "kill switch example" });
check(revoke.status === 200, `the revoke was accepted (${JSON.stringify(revoke.json).slice(0, 160)})`);

let cutAfter = null;
for (let i = 0; i < 150; i++) {
  if (workerMesh.isClosed) { cutAfter = (Date.now() - revokedAt) / 1000; break; }
  await sleep(100);
}
check(cutAfter !== null, `the broker cut the worker's connection live, ${cutAfter?.toFixed(1)} s after the revoke`);

const view = await admin("GET", `/agents/${worker.id}`);
const standing = view.json?.standing ?? {};
check(standing.stopped?.by_admin === true, `the operator's view of the worker says it is stopped by the operator (status ${standing.status}, ${standing.stopped?.action})`);

let refused = false;
try {
  const again = await connect(worker, { reconnect: false });
  await again.close();
} catch {
  refused = true;
}
check(refused, "the worker's old credential no longer connects");

let reenrolled = true;
try {
  await enroll(team, "worker, again", { publicKey: worker.id, seed: worker.seed });
} catch {
  reenrolled = false;
}
check(!reenrolled, "while it is revoked, the worker cannot enroll again either");

say("The operator restores the worker, and it enrolls again.");
const restore = await admin("POST", "/credentials/restore", { agent: worker.id });
check(restore.status === 200, "the restore was accepted");
const fresh = await enroll(team, "worker, restored", { publicKey: worker.id, seed: worker.seed });
workerMesh = await startWorker(fresh);
const back = await callerMesh.request(worker.id, "ping", {}, { timeout_ms: 10_000 });
check(back.payload?.output?.pong === true, "the worker is back and answering");

await workerMesh.close();
await callerMesh.close();
say("Done: revoked, cut off live, restored.");
process.exit(0);
