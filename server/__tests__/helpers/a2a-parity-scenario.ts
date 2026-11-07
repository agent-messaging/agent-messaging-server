/**
 * One A2A Task from request to cancel on a real store: the origin ledger and
 * the A2A task store over the broker's keyed stores (task-records.ts joins
 * mesh_tasks and mesh_a2a_tasks), the outputs the platform reads, and the
 * admin read. Run on Postgres (PGlite, unit/a2a-parity-postgres.test.ts) and
 * on JetStream (integration/a2a-parity-jetstream.test.ts), so the fields the
 * task manager writes beside an A2A Task survive each broker's store.
 */
import { expect } from "vitest";
import { nkeys, createEnvelope, encode, decode, signEnvelope } from "../../src/sdk.js";
import type { Envelope } from "../../src/sdk.js";
import type { KeyedStore, Storage } from "../../src/storage/index.js";
import { A2ATaskStore } from "../../src/task-manager/a2a-store.js";
import { OriginLedger } from "../../src/task-manager/origin.js";
import { OriginTap } from "../../src/task-manager/origin-tap.js";
import { taskRecords } from "../../src/task-manager/task-records.js";
import { adminViews } from "../../src/admin/admin-views.js";
import { OverdueSweep } from "../../src/task-manager/overdue-sweep.js";
import { EXT_BUDGET, EXT_CANCEL, EXT_OFFERING } from "../../../sdk-typescript/src/a2a/extensions.js";

type Kp = ReturnType<typeof nkeys.createUser>;
const frame = (kp: Kp, p: Record<string, unknown>): Envelope => signEnvelope(createEnvelope({ v: "0.4.0", from: kp.getPublicKey(), ...p } as never), kp as never);

export async function a2aParityScenario(stores: { tasks: KeyedStore; a2a: KeyedStore; origins: KeyedStore; storage: Storage }): Promise<void> {
  const client = nkeys.createUser();
  const server = nkeys.createUser();
  const svc = nkeys.createUser();
  const C = client.getPublicKey();
  const S = server.getPublicKey();
  const id = `t-${Math.random().toString(36).slice(2)}`;
  const published: Array<{ subject: string; data: Record<string, unknown> }> = [];
  const nc = {
    publish(subject: string, data?: Uint8Array) {
      const env = decode(data!);
      published.push({ subject, data: ((env.payload as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown> });
    },
  } as never;
  const records = taskRecords(stores.tasks, stores.a2a);
  const ledger = new OriginLedger(stores.origins, records);
  const store = new A2ATaskStore(stores.a2a, { nc, kp: svc as never, origins: ledger, records });
  const tap = new OriginTap(ledger, { sleep: async () => undefined });
  const inbox = (k: string) => `mesh.agent.${k}.inbox`;
  const both = async (subject: string, env: Envelope) => {
    await tap.push(subject, encode(env));
    await tap.drain();
    await store.observe(subject, encode(env));
  };
  const task = (state: string, metadata?: Record<string, unknown>) => ({ id, contextId: "ctx", status: { state }, ...(metadata ? { metadata } : {}) });

  const req = frame(client, { type: "request", to: S, payload: { a2a: { method: "SendMessage", params: { message: { messageId: "m1", role: "ROLE_USER", parts: [], metadata: { [EXT_OFFERING]: { offering: "quote" } } } } } }, meta: { engagement: "eng-1" } });
  await both(inbox(S), req);
  await both(inbox(C), frame(server, { type: "respond", to: C, in_reply_to: req.id, payload: { a2a: { result: { task: task("TASK_STATE_WORKING") } } } }));
  await store.observe(`mesh.task.${id}.update`, encode(frame(server, { type: "respond", to: C, in_reply_to: req.id, payload: { a2a: { result: { task: task("TASK_STATE_WORKING") }, seq: 0 } } })));

  const cancel = frame(client, { type: "request", to: S, payload: { a2a: { method: "CancelTask", params: { id, metadata: { [EXT_CANCEL]: { reason: "superseded" } } } } } });
  await both(inbox(S), cancel);
  await store.observe(`mesh.task.${id}.update`, encode(frame(server, {
    type: "respond", to: C,
    payload: { a2a: { result: { statusUpdate: { taskId: id, contextId: "ctx", status: { state: "TASK_STATE_CANCELED" }, metadata: { [EXT_CANCEL]: { reason: "superseded" } } } }, seq: 1 }, cost: { amount_micro: 500, currency: "USD" } },
  })));

  // The record beside the Task, as the broker's store keeps it.
  const stored = (await stores.a2a.get(id))!.json<Record<string, unknown>>();
  expect(stored).toMatchObject({
    requester: C, responder: S, offering: "quote", engagement: "eng-1", cancel_reason: "superseded",
    reported_spend: { amount_micro: 500, currency: "USD" },
    origin: { request_id: req.id, requester: C, responder: S, offering: "quote", bound_by: "answer" },
    canceled_by: { party: "responder", requester_request: { request_id: cancel.id, via: "cancel_request" } },
  });
  // Nothing was written to the 0.3.0 store.
  expect(await stores.tasks.get(id)).toBeNull();

  // The outputs a consumer reads.
  const subjects = published.map((p) => p.subject);
  expect(subjects).toEqual(expect.arrayContaining(["mesh.event.task.working", "mesh.event.task.canceled", "mesh.event.metering.task_canceled", "mesh.event.metering.usage"]));
  expect(published.find((p) => p.subject === "mesh.event.metering.task_canceled")!.data).toMatchObject({
    task_id: id, requester: C, responder: S, offering: "quote", context_id: "ctx", status: "canceled", cancel_reason: "superseded",
    cost: { amount_micro: 500, currency: "USD" }, canceled_by: { requester_request: { request_id: cancel.id } },
  });

  // The admin read, on the same store.
  const views = adminViews({ storage: stores.storage });
  const one = await views.handle({ method: "GET", path: `/admin/v1/a2a-tasks/${id}`, query: new URLSearchParams(), body: null, caller: "t" } as never);
  expect(one!.body).toMatchObject({ task_id: id, wire: "0.4.0", record: { offering: "quote", task: { status: { state: "TASK_STATE_CANCELED" } } } });
  const list = await views.handle({ method: "GET", path: "/admin/v1/a2a-tasks", query: new URLSearchParams(), body: null, caller: "t" } as never);
  expect((list!.body as { tasks: Array<{ task_id: string }> }).tasks.map((t) => t.task_id)).toContain(id);
}

/**
 * Server 0.5.3's fields beside an A2A Task on a real store: the creating
 * Message's parts (`inputs`), the problem reports of an input wait
 * (`waiting_on`), the overdue mark the sweep writes, and an exhausted Task's
 * cancel fields; each read back through the admin list.
 */
export async function a2aFollowupsScenario(stores: { a2a: KeyedStore; storage: Storage }): Promise<void> {
  const client = nkeys.createUser();
  const server = nkeys.createUser();
  const svc = nkeys.createUser();
  const C = client.getPublicKey();
  const S = server.getPublicKey();
  const id = `f-${Math.random().toString(36).slice(2)}`;
  const nc = { publish() {} } as never;
  const store = new A2ATaskStore(stores.a2a, { nc, kp: svc as never });
  const problems = [{ input: "invoice", problem: "missing", description: "Attach the March invoice." }];

  const req = frame(client, {
    type: "request", to: S,
    payload: { a2a: { method: "SendMessage", params: { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "quote" }, { data: { qty: 3 } }], metadata: { [EXT_BUDGET]: { deadline: "2026-01-01T00:00:00Z", revision: 0 } } } } } },
  });
  await store.observe(`mesh.agent.${S}.inbox`, encode(req));
  await store.observe(`mesh.task.${id}.update`, encode(frame(server, { type: "respond", to: C, in_reply_to: req.id, payload: { a2a: { result: { task: { id, contextId: "ctx", status: { state: "TASK_STATE_WORKING" } } }, seq: 0 } } })));
  const update = (seq: number, status: Record<string, unknown>, metadata?: Record<string, unknown>) =>
    store.observe(`mesh.task.${id}.update`, encode(frame(server, { type: "respond", to: C, payload: { a2a: { result: { statusUpdate: { taskId: id, contextId: "ctx", status, ...(metadata ? { metadata } : {}) } }, seq } } })));
  await update(1, { state: "TASK_STATE_INPUT_REQUIRED", message: { messageId: "s", role: "ROLE_AGENT", parts: [{ data: { problems } }] } });

  const sweep = new OverdueSweep(nc, {} as never, {} as never, svc as never, async () => new Map(), { store: stores.a2a });
  expect(await sweep.sweep()).toContain(id);

  let stored = (await stores.a2a.get(id))!.json<Record<string, unknown>>();
  expect(stored).toMatchObject({
    inputs: { message_id: "m1", parts: [{ text: "quote" }, { data: { qty: 3 } }] },
    waiting_on: problems,
    overdue: true,
    task: { status: { state: "TASK_STATE_INPUT_REQUIRED" } },
  });

  await update(2, { state: "TASK_STATE_CANCELED" }, { [EXT_BUDGET]: { outcome: "exhausted" }, [EXT_CANCEL]: { reason: "policy" } });
  stored = (await stores.a2a.get(id))!.json<Record<string, unknown>>();
  expect(stored).toMatchObject({ cancel_reason: "policy", canceled_by: { party: "responder" }, overdue: true, inputs: { message_id: "m1" } });
  expect(stored).not.toHaveProperty("waiting_on");

  const views = adminViews({ storage: stores.storage });
  const list = await views.handle({ method: "GET", path: "/admin/v1/a2a-tasks", query: new URLSearchParams(), body: null, caller: "t" } as never);
  const row = (list!.body as { tasks: Array<{ task_id: string; record: Record<string, unknown> }> }).tasks.find((t) => t.task_id === id);
  expect(row!.record).toMatchObject({ inputs: { message_id: "m1" }, cancel_reason: "policy", overdue: true });
}
