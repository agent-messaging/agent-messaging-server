// c26 — A2A over Agent Messaging on a live mesh (A2A binding §4, §5, §8, §10,
// §12.6; conformance/a2a-binding.json is the same ground as fixtures).
//
// A server agent served by the SDK's `mesh.a2a.serve` and a client on the
// SDK's `mesh.a2a` calls, both on this mesh:
//   - SendMessage answered with a Message, and with a Task;
//   - GetTask answers the Task's creator and gives anyone else
//     TaskNotFoundError; ListTasks lists only the caller's Tasks (§10);
//   - CancelTask with a reason (the cancel extension) ends a working Task
//     canceled, with the reason on the record (§12.6);
//   - a stream the client was away for: the client sends its opening frame,
//     takes only the first answer, and comes back after the Task ended; it
//     asks the task manager to follow the stream (mesh.task.a2a.follow), and
//     every frame of that stream reaches its inbox from seq 1, in order, under
//     its streamId, ending with final (§8, MESH_TASKS);
//   - a 0.4.0 frame carrying task_id is refused with INVALID_ENVELOPE (§4).
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CANCEL = "https://agentmessaging.ai/extensions/cancel/v1";

export default {
  id: "c26",
  title: "A2A binding: operations, the readers rule, cancel reasons, a stream resumed from MESH_TASKS, old fields refused",
  spec: "A2A binding §4, §5, §8, §10, §12.6",
  profile: "core",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const { AgentMesh, createEnvelope, signEnvelope } = sdk;
    if (!AgentMesh?.prototype || !("a2a" in AgentMesh.prototype)) throw new Error("not-validated: the SDK under test has no mesh.a2a (SDK 0.66 or later)");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const seed = () => td.decode(nkeys.createUser().getSeed());
    const msg = (text, extra = {}) => ({ messageId: `c26-${Math.random().toString(36).slice(2)}`, role: "ROLE_USER", parts: [{ text }], ...extra });

    const server = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: seed() });
    const client = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: seed() });
    const stranger = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: seed() });
    const raw = await connect({ servers: env.meshWsUrl, authenticator: auth(), timeout: 15_000, maxReconnectAttempts: 0 });
    const fails = [];
    try {
      server.a2a.serve(async (m, ctx) => {
        const text = m.parts?.[0]?.text ?? "";
        if (text === "quick") return { messageId: "c26-r", role: "ROLE_AGENT", parts: [{ text: "a quick answer" }] };
        const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
        if (text === "hold") return t; // stays working until canceled
        if (text === "stream") {
          for (const part of ["one", "two", "three"]) {
            await sleep(300);
            t.artifact({ artifactId: `a-${part}`, parts: [{ text: part }] });
          }
          await sleep(300);
          t.complete("streamed");
          return t;
        }
        t.artifact({ artifactId: "quote", parts: [{ data: { price: 40 } }] });
        t.complete("done");
        return t;
      });
      await sleep(300);

      // SendMessage: a Message, then a Task.
      const quick = await client.a2a.sendMessage(server.id, msg("quick"), { timeoutMs: 15_000 });
      if (quick.message?.parts?.[0]?.text !== "a quick answer") fails.push(`SendMessage did not answer with the Message: ${JSON.stringify(quick).slice(0, 200)}`);
      const res = await client.a2a.sendMessage(server.id, msg("task"), { timeoutMs: 15_000 });
      const taskId = res.task?.id;
      if (res.task?.status?.state !== "TASK_STATE_COMPLETED") fails.push(`SendMessage Task state ${res.task?.status?.state}, want TASK_STATE_COMPLETED`);

      // §10: the creator reads it, a stranger does not learn it exists.
      if (taskId) {
        await sleep(500); // the task store folds the update
        const got = await client.a2a.getTask(server.id, taskId, { timeoutMs: 15_000 }).catch((e) => e);
        if (got?.id !== taskId) fails.push(`GetTask by the creator failed: ${got?.code ?? got?.message ?? JSON.stringify(got).slice(0, 120)}`);
        const theirs = await stranger.a2a.getTask(server.id, taskId, { timeoutMs: 15_000 }).catch((e) => e);
        if (theirs?.code !== "TaskNotFoundError") fails.push(`GetTask by a stranger answered ${theirs?.code ?? "a Task"}, want TaskNotFoundError`);
        const mine = await client.a2a.listTasks(server.id, {}, { timeoutMs: 15_000 }).catch((e) => e);
        if (!mine?.tasks?.some((t) => t.id === taskId)) fails.push("ListTasks by the creator does not list its Task");
        const notMine = await stranger.a2a.listTasks(server.id, {}, { timeoutMs: 15_000 }).catch((e) => e);
        if (notMine?.tasks?.some((t) => t.id === taskId)) fails.push("ListTasks by a stranger lists another agent's Task");
      }

      // §12.6: CancelTask with a reason.
      const held = await client.a2a.sendMessage(server.id, msg("hold"), { timeoutMs: 15_000 });
      if (held.task?.id) {
        const canceled = await client.a2a.cancelTask(server.id, held.task.id, { cancel: { reason: "superseded", note: "c26" }, timeoutMs: 15_000 }).catch((e) => e);
        if (canceled?.status?.state !== "TASK_STATE_CANCELED") fails.push(`CancelTask answered ${canceled?.status?.state ?? canceled?.code}`);
        if (canceled?.metadata?.[CANCEL]?.reason !== "superseded") fails.push("the canceled Task does not carry its reason");
      } else fails.push("the held Task was not created");

      // §8: a stream the client was away for, delivered from MESH_TASKS.
      const kpQ = nkeys.createUser();
      const Q = kpQ.getPublicKey();
      const inbox = [];
      const sub = raw.subscribe(`mesh.agent.${Q}.inbox`);
      (async () => {
        for await (const m of sub) {
          try { inbox.push(JSON.parse(td.decode(m.data))); } catch { /* skip */ }
        }
      })();
      const opening = signEnvelope(createEnvelope({
        type: "request", from: Q, to: server.id, v: "0.4.0",
        payload: { a2a: { method: "SendStreamingMessage", params: { message: msg("stream") } } },
        meta: { a2a: { "A2A-Version": "1.0" } },
      }), kpQ);
      raw.publish(`mesh.agent.${server.id}.inbox`, te.encode(JSON.stringify(opening)));
      for (let i = 0; i < 50 && !inbox.some((e) => e.in_reply_to === opening.id); i++) await sleep(100);
      const first = inbox.find((e) => e.in_reply_to === opening.id);
      const streamTask = first?.payload?.a2a?.result?.task?.id;
      if (!streamTask || first.payload.a2a.streamId !== opening.id || first.payload.a2a.seq !== 0) {
        fails.push(`the stream's first answer: ${JSON.stringify(first?.payload?.a2a ?? first?.error ?? null).slice(0, 200)}`);
      } else {
        await sleep(2500); // away while the Task runs to its end
        const ask = signEnvelope(createEnvelope({ type: "request", from: Q, v: "0.4.0", payload: { frame: opening, taskId: streamTask } }), kpQ);
        const answer = JSON.parse(td.decode((await raw.request("mesh.task.a2a.follow", te.encode(JSON.stringify(ask)), { timeout: 10_000 })).data));
        if (answer.error) fails.push(`follow refused: ${answer.error.code} ${answer.error.message}`);
        for (let i = 0; i < 50 && !inbox.some((e) => e.payload?.a2a?.final && e.payload?.a2a?.streamId === opening.id); i++) await sleep(100);
        const frames = inbox.filter((e) => !e.in_reply_to && e.payload?.a2a?.streamId === opening.id);
        const seqs = frames.map((e) => e.payload.a2a.seq);
        const want = seqs.map((_, i) => i + 1);
        if (seqs.length < 4 || seqs.join(",") !== want.join(",")) fails.push(`stream seqs after the return [${seqs.join(",")}], want 1..n in order`);
        if (!frames.at(-1)?.payload?.a2a?.final) fails.push("the stream did not end with final");
        if (frames.some((e) => e.from !== server.id || e.to !== Q)) fails.push("a delivered frame is not the server agent's, addressed to the client");
      }
      sub.unsubscribe();

      // §4: a 0.4.0 frame carrying task_id is refused.
      const kpB = nkeys.createUser();
      const B = kpB.getPublicKey();
      const refusals = [];
      const subB = raw.subscribe(`mesh.agent.${B}.inbox`);
      (async () => {
        for await (const m of subB) {
          try { refusals.push(JSON.parse(td.decode(m.data))); } catch { /* skip */ }
        }
      })();
      const bad = signEnvelope(createEnvelope({
        type: "request", from: B, to: server.id, v: "0.4.0", task_id: "c26-old-field",
        payload: { a2a: { method: "SendMessage", params: { message: msg("quick") } } },
      }), kpB);
      raw.publish(`mesh.agent.${server.id}.inbox`, te.encode(JSON.stringify(bad)));
      for (let i = 0; i < 30 && !refusals.some((e) => e.in_reply_to === bad.id); i++) await sleep(100);
      const refusal = refusals.find((e) => e.in_reply_to === bad.id);
      if (refusal?.error?.code !== "INVALID_ENVELOPE") fails.push(`a 0.4.0 frame with task_id was answered ${refusal?.error?.code ?? (refusal ? "without an error" : "with nothing")}, want INVALID_ENVELOPE`);
      subB.unsubscribe();
    } finally {
      await server.close().catch(() => {});
      await client.close().catch(() => {});
      await stranger.close().catch(() => {});
      await raw.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : {
          status: "pass",
          detail: "Message and Task answers, readers-only GetTask and ListTasks, a reasoned cancel, a stream delivered from seq 1 after the client returned, and task_id refused on 0.4.0",
        };
  },
};
