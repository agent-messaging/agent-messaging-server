// c25 — a message for a person is never a Task transition (SPEC §5.7, §7.3).
//
// §5.7 lets a sender mark a message for the person behind the receiving agent
// with `meta.audience: "person"`, and makes the server's part of it core
// (§1.6): every service that stores or relays an envelope carries the mark
// unchanged, and the task manager applies no Task update whose
// `meta.audience` is present and is anything other than the string "agent".
// The update channel is the one path a server holds by which a message for a
// person could reach a requester's task handler, so this is where a server
// decides something, and this test checks it on a live mesh:
//
//   1. an unmarked first update creates the Task (the control);
//   2. updates marked "person", marked with an unknown string, marked with a
//      number and marked null each leave the Task as it was;
//   3. an update marked "agent" explicitly applies, like an unmarked one;
//   4. a marked update after that still does not move the Task;
//   5. a first update marked "person" creates no Task at all;
//   6. the requester's subscription receives a marked update byte for byte as
//      published, and its signature verifies (carriage, §5.7).
//
// The cases are conformance/audience.json's `server.task_manager`. Like c02,
// it needs no registered agent: the responder and the requester are fresh keys
// that only publish and subscribe.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { createEnvelope, signEnvelope, verifyEnvelopeSig } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c25",
  title: "a Task update marked for a person moves no Task",
  spec: "§5.7, §7.3, §1.6",
  profile: "core",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const nc = await connect({
      servers: env.meshWsUrl,
      authenticator: jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed)),
      timeout: 15_000, maxReconnectAttempts: 0,
    });
    const fails = [];
    const subs = [];
    try {
      const kpR = nkeys.createUser(); // the responder publishing updates
      const idR = kpR.getPublicKey();
      const kpQ = nkeys.createUser(); // the requester reading state
      const idQ = kpQ.getPublicKey();
      const newTaskId = (tag) => `c25-${tag}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

      // The requester's view of the update channel, raw bytes kept.
      const heard = new Map(); // task id -> [{ raw, env }]
      const listen = (taskId) => {
        const list = [];
        heard.set(taskId, list);
        const sub = nc.subscribe(`mesh.task.${taskId}.update`);
        subs.push(sub);
        (async () => {
          for await (const m of sub) {
            const raw = td.decode(m.data);
            try { list.push({ raw, env: JSON.parse(raw) }); } catch { /* skip */ }
          }
        })();
        return list;
      };

      // `meta` undefined publishes an unmarked update. Returns the bytes sent.
      const update = (taskId, status, meta) => {
        const fields = { type: "respond", from: idR, to: idQ, task_id: taskId, payload: { status, message: `c25 ${status}` } };
        if (meta !== undefined) fields.meta = meta;
        const raw = JSON.stringify(signEnvelope(createEnvelope(fields), kpR));
        nc.publish(`mesh.task.${taskId}.update`, te.encode(raw));
        return raw;
      };
      const getState = async (taskId) => {
        const q = signEnvelope(createEnvelope({ type: "request", from: idQ, to: "mesh.service.task-manager", payload: {} }), kpQ);
        try {
          const m = await nc.request(`mesh.task.get.${taskId}`, te.encode(JSON.stringify(q)), { timeout: 5000 });
          const body = JSON.parse(td.decode(m.data));
          return body.payload?.task?.state ?? body.payload?.state ?? null;
        } catch { return null; }
      };

      // 1. The control: an unmarked first update creates the Task.
      const taskA = newTaskId("a");
      const heardA = listen(taskA);
      update(taskA, "submitted");
      await sleep(700);
      const start = await getState(taskA);
      if (start !== "submitted") {
        return { status: "fail", detail: `control: an unmarked first update left state=${start}, want submitted; the task manager is not answering mesh.task.get, so nothing below can be judged` };
      }

      // 2. Marked updates leave the Task as it was.
      const marked = [
        ["person", { audience: "person" }],
        ["an unknown string", { audience: "household" }],
        ["a number", { audience: 7 }],
        ["null", { audience: null }],
      ];
      let personRaw = null;
      for (const [label, meta] of marked) {
        const raw = update(taskA, "working", meta);
        if (label === "person") personRaw = raw;
        await sleep(700);
        const s = await getState(taskA);
        if (s !== "submitted") fails.push(`an update with meta.audience ${label} moved the Task to ${s}`);
      }

      // 3. An explicit "agent" applies, as an unmarked update does.
      update(taskA, "working", { audience: "agent" });
      await sleep(700);
      const afterAgent = await getState(taskA);
      if (afterAgent !== "working") fails.push(`an update marked "agent" explicitly left state=${afterAgent}, want working`);

      // 4. A marked terminal update after that does not complete the Task.
      update(taskA, "completed", { audience: "person" });
      await sleep(1000);
      const afterMarkedTerminal = await getState(taskA);
      if (afterMarkedTerminal !== "working") fails.push(`a "completed" update marked "person" moved the Task to ${afterMarkedTerminal}`);

      // 5. A first update marked "person" creates no Task.
      const taskB = newTaskId("b");
      update(taskB, "submitted", { audience: "person" });
      await sleep(1000);
      const b = await getState(taskB);
      if (b !== null) fails.push(`a first update marked "person" created a Task in state ${b}`);

      // 6. Carriage: the requester heard the marked update as it was sent.
      const got = heardA.find((h) => h.env?.meta?.audience === "person" && h.env?.payload?.status === "working");
      if (!got) fails.push("the requester never heard the update marked \"person\" on the update channel");
      else {
        if (got.raw !== personRaw) fails.push("the update marked \"person\" arrived with different bytes than were published");
        if (!verifyEnvelopeSig(got.env)) fails.push("the update marked \"person\" arrived with a signature that does not verify");
      }
    } finally {
      for (const s of subs) s.unsubscribe();
      await nc.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "marked updates (person, unknown, number, null) moved nothing, explicit agent applied, a marked first update created no Task, and the marked update was carried byte for byte" };
  },
};
