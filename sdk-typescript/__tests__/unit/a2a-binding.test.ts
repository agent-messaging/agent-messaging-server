/**
 * A2A over Agent Messaging (bindings/a2a.md): every operation as frames
 * between two agents on one bus, the errors of §9, streaming with seq and a
 * resume after a lost frame (§8), a Task longer than the reply window, the
 * extensions of §12, the refusal of the old envelope fields (§4), and the
 * 0.3.0 wire beside 0.4.0 (§14).
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeBus, tick, waitFor, type Bus } from "./a2a-bus.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode } from "../../src/internal/codec.js";
import { nkeys } from "nats.ws";
import { Subjects } from "../../src/internal/subjects.js";
import { MeshError, ErrorCode } from "../../src/types/errors.js";
import type { Envelope } from "../../src/types/envelope.js";
import {
  A2A_BINDING_URI,
  A2A_WIRE_VERSION,
  A2AError,
  A2A_ERROR_CODES,
  A2A_STORE_SUBJECTS,
  EXT_BUDGET,
  EXT_OFFERING,
  activatedExtensions,
  artifactRefOf,
  artifactRefPart,
  budgetOf,
  budgetOutcomeOf,
  forPerson,
  isExhausted,
  isForPerson,
  paymentRequiredOf,
  paymentRequiredTask,
  insufficientBudgetTask,
  serviceParam,
  serviceParams,
  withBudget,
  withOffering,
  type Message,
  type StreamResponse,
  type Task,
} from "../../src/a2a/index.js";

let bus: Bus;
afterEach(async () => {
  bus.drop = null;
  await bus.close();
});

function setup() {
  bus = makeBus();
  const client = bus.agent();
  const server = bus.agent();
  return { client, server };
}

const userMsg = (text: string, extra: Partial<Message> = {}): Message => ({
  messageId: `m-${Math.random().toString(36).slice(2)}`,
  role: "ROLE_USER",
  parts: [{ text }],
  ...extra,
});

async function collect(stream: AsyncIterable<StreamResponse>): Promise<StreamResponse[]> {
  const out: StreamResponse[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

async function rejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("SendMessage", () => {
  it("answers a Message in one round, in 0.4.0 frames carrying the A2A objects", async () => {
    const { client, server } = setup();
    server.a2a.serve((m) => ({ messageId: "r1", role: "ROLE_AGENT", parts: [{ text: `echo ${m.parts[0].text}` }] }));
    const res = await client.a2a.sendMessage(server.id, userMsg("hi"));
    expect(res.message?.parts[0].text).toBe("echo hi");
    expect(res.task).toBeUndefined();

    const req = bus.log.find((l) => l.env.type === "request" && l.env.to === server.id)!.env;
    expect(req.v).toBe(A2A_WIRE_VERSION);
    expect((req.payload as { a2a: { method: string } }).a2a.method).toBe("SendMessage");
    expect((req.meta as { a2a: Record<string, string> }).a2a["A2A-Version"]).toBe("1.0");
    for (const f of ["task_id", "context_id", "artifacts"]) expect(f in req).toBe(false);

    const resp = bus.log.find((l) => l.env.type === "respond" && l.env.in_reply_to === req.id)!;
    expect(resp.subject).toBe(Subjects.agentInbox(client.id));
    expect(resp.env.v).toBe(A2A_WIRE_VERSION);
    for (const f of ["task_id", "context_id", "artifacts"]) expect(f in resp.env).toBe(false);
  });

  it("answers a finished Task with its artifacts when the work ends inside the call", async () => {
    const { client, server } = setup();
    server.a2a.serve((_m, ctx) => {
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      t.artifact({ artifactId: "a1", name: "quote", parts: [{ data: { price: 40 } }] });
      t.complete("Done.");
      return t;
    });
    const res = await client.a2a.sendMessage(server.id, userMsg("quote"));
    expect(res.task?.status.state).toBe("TASK_STATE_COMPLETED");
    expect(res.task?.artifacts?.[0].parts[0].data).toEqual({ price: 40 });
    expect(res.task?.history?.[0].parts[0].text).toBe("quote");
    // Nothing went to the stream subject: the client had not learned the Task.
    expect(bus.log.some((l) => l.subject.endsWith(".stream"))).toBe(false);
  });

  it("a Task longer than the reply window: answered WORKING, finished later, read with GetTask", async () => {
    const { client, server } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.a2a.serve(
      async (_m, ctx) => {
        const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
        await gate;
        t.artifact({ artifactId: "a1", parts: [{ text: "the report" }] });
        t.complete();
        return t;
      },
      { replyWindowMs: 50 },
    );
    const res = await client.a2a.sendMessage(server.id, userMsg("long job"));
    expect(res.task?.status.state).toBe("TASK_STATE_WORKING");
    const id = res.task!.id;

    release();
    await tick(50);
    // Every change went to the Task's update subject for the task store, in
    // the Task's own order: the Task itself (in reply to the request), the
    // artifact, the completion. No stream was open, so nothing went there.
    const updates = bus.log.filter((l) => l.subject === Subjects.taskUpdate(id)).map((l) => l.env);
    expect(updates.map((e) => (e.payload as { a2a: { seq: number } }).a2a.seq)).toEqual([0, 1, 2]);
    expect(updates[0].in_reply_to).toBeDefined();
    expect(Object.keys((updates[2].payload as { a2a: { result: object } }).a2a.result)).toEqual(["statusUpdate"]);
    expect(bus.log.some((l) => l.subject === Subjects.taskStream(id))).toBe(false);

    const task = await client.a2a.getTask(server.id, id);
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(task.artifacts?.[0].parts[0].text).toBe("the report");
  });

  it("returnImmediately answers with the Task as soon as it exists", async () => {
    const { client, server } = setup();
    server.a2a.serve(async (_m, ctx) => {
      const t = ctx.startTask();
      await tick(30);
      t.complete();
      return t;
    });
    const res = await client.a2a.sendMessage(server.id, { message: userMsg("go"), configuration: { returnImmediately: true } });
    expect(res.task?.status.state).toBe("TASK_STATE_SUBMITTED");
  });

  it("a message naming the Task continues it after input was required", async () => {
    const { client, server } = setup();
    server.a2a.serve((m, ctx) => {
      if (ctx.existingTask) {
        const t = ctx.startTask();
        t.complete(`Shipping to ${m.parts[0].text}.`);
        return t;
      }
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      t.requireInput("Where to?");
      return t;
    });
    const first = await client.a2a.sendMessage(server.id, userMsg("ship it"));
    expect(first.task?.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    const second = await client.a2a.sendMessage(server.id, userMsg("Denver", { taskId: first.task!.id }));
    expect(second.task?.status.state).toBe("TASK_STATE_COMPLETED");
    expect(second.task?.history?.map((h) => h.parts[0].text)).toEqual(["ship it", "Where to?", "Denver", "Shipping to Denver."]);
  });

  it("a stranger naming someone else's Task gets TaskNotFoundError", async () => {
    const { client, server } = setup();
    const stranger = bus.agent();
    server.a2a.serve((_m, ctx) => {
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      t.requireInput("More?");
      return t;
    });
    const first = await client.a2a.sendMessage(server.id, userMsg("start"));
    const err = (await rejects(stranger.a2a.sendMessage(server.id, userMsg("hijack", { taskId: first.task!.id })))) as A2AError;
    expect(err).toBeInstanceOf(A2AError);
    expect(err.code).toBe("TaskNotFoundError");
  });
});

describe("SendStreamingMessage (§8)", () => {
  it("delivers every event once, in seq order, the first on the inbox and the rest on the stream subject", async () => {
    const { client, server } = setup();
    server.a2a.serve(async (_m, ctx) => {
      const t = ctx.startTask();
      // Once the client listens and has made its first read (the catch-up a
      // stream without a durable buffer makes), every event goes live.
      await waitFor(() => bus.log.some((l) => l.env.type === "respond" && l.env.to === client.id && (l.env.payload as { a2a?: { result?: { id?: string } } })?.a2a?.result?.id === t.id));
      t.status("TASK_STATE_WORKING");
      t.artifact({ artifactId: "a1", parts: [{ text: "part one" }] });
      t.artifact({ artifactId: "a1", parts: [{ text: "part two" }] }, { append: true, lastChunk: true });
      t.complete("All done.");
      return t;
    });
    const s = client.a2a.sendStreamingMessage(server.id, userMsg("stream"));
    const events = await collect(s);
    expect(events.map((e) => Object.keys(e)[0])).toEqual(["task", "statusUpdate", "artifactUpdate", "artifactUpdate", "statusUpdate"]);
    expect(events[4].statusUpdate?.status.state).toBe("TASK_STATE_COMPLETED");
    expect(s.lastSeq).toBe(4);

    const id = s.taskId!;
    const first = bus.log.find((l) => l.env.type === "respond" && l.subject === Subjects.agentInbox(client.id))!;
    expect((first.env.payload as { a2a: { seq: number } }).a2a.seq).toBe(0);
    const later = bus.log.filter((l) => l.subject === Subjects.taskStream(id)).map((l) => l.env.payload as { a2a: { seq: number; final?: boolean } });
    expect(later.map((p) => p.a2a.seq)).toEqual([1, 2, 3, 4]);
    expect(later.map((p) => p.a2a.final === true)).toEqual([false, false, false, true]);
  });

  it("a Message without a Task ends the stream at once, marked final", async () => {
    const { client, server } = setup();
    server.a2a.serve(() => ({ messageId: "r", role: "ROLE_AGENT", parts: [{ text: "quick" }] }));
    const events = await collect(client.a2a.sendStreamingMessage(server.id, userMsg("q")));
    expect(events).toHaveLength(1);
    expect(events[0].message?.parts[0].text).toBe("quick");
    const resp = bus.log.find((l) => l.env.type === "respond")!;
    expect((resp.env.payload as { a2a: { final?: boolean; seq?: number } }).a2a).toMatchObject({ final: true, seq: 0 });
  });

  it("a lost frame: the gap is closed with the Task as the store holds it, and the stream goes on", async () => {
    const { client, server } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.a2a.serve(async (_m, ctx) => {
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      await gate;
      t.artifact({ artifactId: "a1", parts: [{ text: "one" }] });
      t.artifact({ artifactId: "a2", parts: [{ text: "two" }] });
      await tick(20);
      t.complete();
      return t;
    });
    // The broker loses seq 1 of the stream.
    bus.drop = (subject, env) => subject.endsWith(".stream") && (env.payload as { a2a?: { seq?: number } })?.a2a?.seq === 1;
    const s = client.a2a.sendStreamingMessage(server.id, userMsg("go"), { idleResyncMs: 1000 });
    const events: StreamResponse[] = [];
    const done = (async () => {
      for await (const ev of s) {
        events.push(ev);
        if (events.length === 1) release();
      }
    })();
    await done;
    // Event 0 (the Task), then the Task as it stands (holding the lost
    // artifact), then the rest of the stream to its completion.
    expect(events[0].task?.status.state).toBe("TASK_STATE_WORKING");
    const snap = events.find((e) => e.task && e.task.artifacts?.some((a) => a.artifactId === "a1"));
    expect(snap).toBeDefined();
    const last = events.at(-1)!;
    expect(last.statusUpdate?.status.state ?? last.task?.status.state).toBe("TASK_STATE_COMPLETED");
    expect(bus.log.some((l) => (l.env.payload as { a2a?: { method?: string } })?.a2a?.method === "GetTask")).toBe(true);
  });

  it("a quiet stream is checked, so a final event lost before the client listened still ends it", async () => {
    const { client, server } = setup();
    server.a2a.serve(async (_m, ctx) => {
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      t.complete("fast");
      return t;
    });
    // Lose every stream frame: only the resync can end this.
    bus.drop = (subject) => subject.endsWith(".stream");
    const events = await collect(client.a2a.sendStreamingMessage(server.id, userMsg("go"), { idleResyncMs: 30 }));
    expect(events.at(-1)?.task?.status.state ?? events.at(-1)?.statusUpdate?.status.state).toBe("TASK_STATE_COMPLETED");
  });
});

describe("SubscribeToTask", () => {
  it("starts from the Task's current state and follows it to the end", async () => {
    const { client, server } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.a2a.serve(
      async (_m, ctx) => {
        const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
        await gate;
        t.artifact({ artifactId: "a", parts: [{ text: "x" }] });
        t.complete();
        return t;
      },
      { replyWindowMs: 20 },
    );
    const res = await client.a2a.sendMessage(server.id, userMsg("go"));
    const s = client.a2a.subscribeToTask(server.id, res.task!.id);
    const events: StreamResponse[] = [];
    const done = (async () => {
      for await (const ev of s) {
        events.push(ev);
        if (events.length === 1) release();
      }
    })();
    await done;
    expect(events[0].task?.status.state).toBe("TASK_STATE_WORKING");
    expect((events.at(-1)?.statusUpdate?.status.state ?? events.at(-1)?.task?.status.state)).toBe("TASK_STATE_COMPLETED");
  });

  it("on a finished Task answers once, marked final", async () => {
    const { client, server } = setup();
    server.a2a.serve((_m, ctx) => {
      const t = ctx.startTask();
      t.complete();
      return t;
    });
    const res = await client.a2a.sendMessage(server.id, userMsg("go"));
    const events = await collect(client.a2a.subscribeToTask(server.id, res.task!.id));
    expect(events).toHaveLength(1);
    expect(events[0].task?.status.state).toBe("TASK_STATE_COMPLETED");
  });
});

describe("CancelTask", () => {
  it("cancels a working Task, reaching the handler's signal and cancel hook", async () => {
    const { client, server } = setup();
    let aborted = false;
    let hooked = false;
    server.a2a.serve(
      (_m, ctx) => {
        ctx.signal.addEventListener("abort", () => (aborted = true));
        return ctx.startTask({ state: "TASK_STATE_WORKING" });
      },
      { onCancel: () => void (hooked = true) },
    );
    const res = await client.a2a.sendMessage(server.id, userMsg("go"));
    const canceled = await client.a2a.cancelTask(server.id, res.task!.id);
    expect(canceled.status.state).toBe("TASK_STATE_CANCELED");
    expect(aborted && hooked).toBe(true);
  });

  it("refuses a Task in a terminal state with TaskNotCancelableError (-32002)", async () => {
    const { client, server } = setup();
    server.a2a.serve((_m, ctx) => {
      const t = ctx.startTask();
      t.complete();
      return t;
    });
    const res = await client.a2a.sendMessage(server.id, userMsg("go"));
    const err = (await rejects(client.a2a.cancelTask(server.id, res.task!.id))) as A2AError;
    expect(err.code).toBe("TaskNotCancelableError");
    expect(err.rpcCode).toBe(-32002);
    const frame = bus.log.find((l) => l.env.error?.code === "TaskNotCancelableError")!.env;
    expect(frame.error).toMatchObject({ code: "TaskNotCancelableError", details: { a2a: { code: -32002 } }, retryable: false });
    expect(frame.v).toBe(A2A_WIRE_VERSION);
  });
});

describe("GetTask and ListTasks: who may read a Task (§10)", () => {
  it("answers only the agent that created the Task; anyone else gets TaskNotFoundError", async () => {
    const { client, server } = setup();
    const other = bus.agent();
    server.a2a.serve((_m, ctx) => {
      const t = ctx.startTask();
      t.complete();
      return t;
    });
    const res = await client.a2a.sendMessage(server.id, userMsg("go"));
    expect((await client.a2a.getTask(server.id, res.task!.id)).id).toBe(res.task!.id);
    const err = (await rejects(other.a2a.getTask(server.id, res.task!.id))) as A2AError;
    expect(err.code).toBe("TaskNotFoundError");
    expect(err.rpcCode).toBe(-32001);
    expect((await other.a2a.listTasks(server.id)).tasks).toEqual([]);
  });

  it("lists the caller's Tasks, filtered and paged", async () => {
    const { client, server } = setup();
    server.a2a.serve((m, ctx) => {
      const t = ctx.startTask({ contextId: m.contextId });
      if (m.parts[0].text === "done") t.complete();
      return t;
    });
    for (const text of ["done", "open", "done"]) await client.a2a.sendMessage(server.id, userMsg(text, { contextId: "ctx-1" }));
    await client.a2a.sendMessage(server.id, userMsg("done", { contextId: "ctx-2" }));
    const all = await client.a2a.listTasks(server.id, {});
    expect(all.totalSize).toBe(4);
    const done1 = await client.a2a.listTasks(server.id, { contextId: "ctx-1", status: "TASK_STATE_COMPLETED" });
    expect(done1.totalSize).toBe(2);
    const page = await client.a2a.listTasks(server.id, { pageSize: 3 });
    expect(page.tasks).toHaveLength(3);
    expect(page.nextPageToken).not.toBe("");
    const rest = await client.a2a.listTasks(server.id, { pageSize: 3, pageToken: page.nextPageToken });
    expect(rest.tasks).toHaveLength(1);
    expect(rest.nextPageToken).toBe("");
    const bad = (await rejects(client.a2a.listTasks(server.id, { pageSize: 101 }))) as A2AError;
    expect(bad.code).toBe("InvalidParamsError");
  });

  it("reads from the durable task store when it answers, relaying the client's own signed frame", async () => {
    const { client, server } = setup();
    const svc = nkeys.createUser();
    const stored: Task = { id: "task-from-store", contextId: "c", status: { state: "TASK_STATE_COMPLETED", timestamp: "2026-11-07T00:00:00Z" } };
    let relayed: Envelope | null = null;
    bus.service(A2A_STORE_SUBJECTS.GET, (req) => {
      relayed = (req.payload as { frame: Envelope }).frame;
      const ok = relayed.from === client.id && relayed.to === server.id && req.from === server.id;
      return signEnvelope(
        createEnvelope({
          type: "respond",
          from: svc.getPublicKey(),
          in_reply_to: req.id,
          ...(ok ? { payload: { task: stored, seq: 3, requester: client.id } } : { error: new A2AError("TaskNotFoundError", "No task with that id.").toErrorObject() }),
        }),
        svc,
      );
    });
    server.a2a.serve(() => undefined);
    const task = await client.a2a.getTask(server.id, "task-from-store");
    expect(task).toEqual(stored);
    expect(relayed!.sig).toBeTruthy();
    const err = (await rejects(bus.agent().a2a.getTask(server.id, "task-from-store"))) as A2AError;
    expect(err.code).toBe("TaskNotFoundError");
  });
});

describe("the other operations", () => {
  it("push notification configs: PushNotificationNotSupportedError (-32003) for all four", async () => {
    const { client, server } = setup();
    server.a2a.serve(() => undefined);
    const calls = [
      client.a2a.createTaskPushNotificationConfig(server.id, { taskId: "t", url: "https://example.com/hook" }),
      client.a2a.getTaskPushNotificationConfig(server.id, { taskId: "t", id: "c" }),
      client.a2a.listTaskPushNotificationConfigs(server.id, { taskId: "t" }),
      client.a2a.deleteTaskPushNotificationConfig(server.id, { taskId: "t", id: "c" }),
    ];
    for (const c of calls) {
      const err = (await rejects(c)) as A2AError;
      expect(err.code).toBe("PushNotificationNotSupportedError");
      expect(err.rpcCode).toBe(-32003);
    }
  });

  it("GetExtendedAgentCard: the configured card, else ExtendedAgentCardNotConfiguredError (-32007)", async () => {
    const { client, server } = setup();
    server.a2a.serve(() => undefined);
    const err = (await rejects(client.a2a.getExtendedAgentCard(server.id))) as A2AError;
    expect(err.code).toBe("ExtendedAgentCardNotConfiguredError");
    expect(err.rpcCode).toBe(-32007);
    server.a2a.serve(() => undefined, {
      extendedCard: (caller) => ({
        name: "Quotes",
        description: `for ${caller.slice(0, 4)}`,
        supportedInterfaces: [],
        version: "1",
        capabilities: { pushNotifications: false },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: [],
      }),
    });
    const card = await client.a2a.getExtendedAgentCard(server.id);
    expect(card.description).toBe(`for ${client.id.slice(0, 4)}`);
  });

  it("an unknown method answers MethodNotFoundError", async () => {
    const { client, server } = setup();
    server.a2a.serve(() => undefined);
    const err = (await rejects(client.a2a.call(server.id, "Nope" as "GetTask", { id: "x" }))) as A2AError;
    expect(err.code).toBe("MethodNotFoundError");
    expect(err.rpcCode).toBe(-32601);
  });
});

describe("§4: a 0.4.0 frame never carries task_id, context_id or artifacts", () => {
  for (const field of ["task_id", "context_id", "artifacts"] as const) {
    it(`refuses one carrying ${field} with INVALID_ENVELOPE, and runs nothing`, async () => {
      const { client, server } = setup();
      let ran = false;
      server.a2a.serve(() => {
        ran = true;
        return { messageId: "r", role: "ROLE_AGENT", parts: [] };
      });
      const kp = nkeys.createUser();
      const value = field === "artifacts" ? [] : "x-1";
      const env = signEnvelope(
        createEnvelope({
          type: "request",
          from: kp.getPublicKey(),
          to: server.id,
          v: A2A_WIRE_VERSION,
          [field]: value,
          payload: { a2a: { method: "SendMessage", params: { message: userMsg("hi") } } },
        }),
        kp,
      );
      bus.publishRaw(Subjects.agentInbox(server.id), encode(env));
      await tick(40);
      expect(ran).toBe(false);
      const refusal = bus.log.find((l) => l.env.in_reply_to === env.id)!;
      expect(refusal.subject).toBe(Subjects.agentInbox(kp.getPublicKey()));
      expect(refusal.env.error?.code).toBe(ErrorCode.INVALID_ENVELOPE);
      expect(refusal.env.v).toBe(A2A_WIRE_VERSION);
      void client;
    });
  }
});

describe("errors (§9)", () => {
  it("an A2A error travels by name with its JSON-RPC integer and data", () => {
    const e = new A2AError("InvalidParamsError", "bad", { offerings: ["a"] });
    expect(e.toErrorObject()).toEqual({ code: "InvalidParamsError", message: "bad", details: { a2a: { code: -32602, data: { offerings: ["a"] } } }, retryable: false });
    expect(A2AError.fromErrorObject(e.toErrorObject())?.data).toEqual({ offerings: ["a"] });
    expect(A2A_ERROR_CODES).toMatchObject({
      TaskNotFoundError: -32001,
      TaskNotCancelableError: -32002,
      PushNotificationNotSupportedError: -32003,
      UnsupportedOperationError: -32004,
      ContentTypeNotSupportedError: -32005,
      InvalidAgentResponseError: -32006,
      ExtendedAgentCardNotConfiguredError: -32007,
      ExtensionSupportRequiredError: -32008,
      VersionNotSupportedError: -32009,
    });
  });

  it("a channel error keeps its Agent Messaging code and is never given an A2A name", async () => {
    expect(A2AError.fromErrorObject({ code: ErrorCode.UNAUTHORIZED, message: "no", retryable: false })).toBeNull();
    bus = makeBus();
    const client = bus.agent();
    const offline = nkeys.createUser().getPublicKey();
    const err = await rejects(client.a2a.sendMessage(offline, userMsg("anyone?"), { timeoutMs: 200 }));
    expect(err).toBeInstanceOf(MeshError);
    expect((err as MeshError).code).toBe(ErrorCode.TRANSPORT_NO_RESPONDERS);
  });

  it("a handler's A2AError reaches the client as that error", async () => {
    const { client, server } = setup();
    server.a2a.serve(() => {
      throw new A2AError("ContentTypeNotSupportedError", "No PDFs.", { mediaType: "application/pdf" });
    });
    const err = (await rejects(client.a2a.sendMessage(server.id, userMsg("pdf")))) as A2AError;
    expect(err.code).toBe("ContentTypeNotSupportedError");
    expect(err.data).toEqual({ mediaType: "application/pdf" });
  });
});

describe("service parameters (§7)", () => {
  it("ride in meta.a2a, names compared without case, at most 8 KiB", async () => {
    const { client, server } = setup();
    let seen: Record<string, string> = {};
    let exts: string[] = [];
    server.a2a.serve((_m, ctx) => {
      seen = ctx.serviceParams;
      exts = ctx.extensions;
      return { messageId: "r", role: "ROLE_AGENT", parts: [] };
    });
    await client.a2a.sendMessage(server.id, userMsg("x"), { extensions: [EXT_BUDGET, EXT_OFFERING], serviceParams: { "X-Trace-Note": "n" } });
    expect(serviceParam(seen, "a2a-version")).toBe("1.0");
    expect(serviceParam(seen, "x-trace-note")).toBe("n");
    expect(exts).toEqual([EXT_BUDGET, EXT_OFFERING]);
    expect(activatedExtensions({ "a2a-extensions": " a , b " })).toEqual(["a", "b"]);
    expect(() => serviceParams({ big: "x".repeat(9000) })).toThrow(MeshError);
  });
});

describe("extensions (§12)", () => {
  it("offering: one declared offering serves a message naming none; several need a name", async () => {
    const { client, server } = setup();
    let offering: string | undefined;
    server.a2a.serve(
      (_m, ctx) => {
        offering = ctx.offering;
        return { messageId: "r", role: "ROLE_AGENT", parts: [] };
      },
      { offerings: ["quote"] },
    );
    await client.a2a.sendMessage(server.id, userMsg("x"));
    expect(offering).toBe("quote");

    server.a2a.serve((_m, ctx) => ((offering = ctx.offering), { messageId: "r", role: "ROLE_AGENT", parts: [] }), { offerings: ["quote", "ship"] });
    const err = (await rejects(client.a2a.sendMessage(server.id, userMsg("x")))) as A2AError;
    expect(err.code).toBe("InvalidParamsError");
    expect(err.data).toEqual({ offerings: ["quote", "ship"] });
    const err2 = (await rejects(client.a2a.sendMessage(server.id, withOffering(userMsg("x"), "dance")))) as A2AError;
    expect(err2.code).toBe("InvalidParamsError");
    await client.a2a.sendMessage(server.id, withOffering(userMsg("x"), "ship"));
    expect(offering).toBe("ship");
  });

  it("budget: carried on the message, and the exhausted outcome ends the Task canceled, never failed", async () => {
    const { client, server } = setup();
    let budget: unknown;
    server.a2a.serve((_m, ctx) => {
      budget = ctx.budget;
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      t.artifact({ artifactId: "partial", parts: [{ text: "half" }] });
      t.exhausted();
      return t;
    });
    const msg = withBudget(userMsg("work"), { revision: 0, deadline: "2026-11-20T17:00:00Z", cost_ceiling: { amount_micro: 4_000_000, currency: "USD" } });
    expect(msg.metadata?.[EXT_BUDGET]).toEqual({ deadline: "2026-11-20T17:00:00Z", revision: 0, costCeiling: { amountMicro: 4000000, currency: "USD" } });
    const res = await client.a2a.sendMessage(server.id, msg);
    expect(budget).toEqual(budgetOf(msg));
    expect(res.task?.status.state).toBe("TASK_STATE_CANCELED");
    expect(res.task?.metadata?.[EXT_BUDGET]).toEqual({ outcome: "exhausted" });
    expect(isExhausted(res.task)).toBe(true);
    expect(res.task?.status.message?.parts[0].text).toMatch(/cap/);
    expect(res.task?.artifacts?.[0].artifactId).toBe("partial");
  });

  it("budget insufficient and payment required end the Task rejected", () => {
    const t: Task = { id: "t", contextId: "c", status: { state: "TASK_STATE_SUBMITTED" } };
    const ins = insufficientBudgetTask(t, { amountMicro: 9_000_000, currency: "USD" });
    expect(ins.status.state).toBe("TASK_STATE_REJECTED");
    expect(budgetOutcomeOf(ins)).toEqual({ outcome: "insufficient", estimate: { amountMicro: 9_000_000, currency: "USD" } });
    const pay = paymentRequiredTask(t, { price: { amountMicro: 1, currency: "USD" }, accepted: ["stripe"] });
    expect(pay.status.state).toBe("TASK_STATE_REJECTED");
    expect(paymentRequiredOf(pay)).toEqual({ price: { amountMicro: 1, currency: "USD" }, accepted: ["stripe"] });
  });

  it("audience and artifact references", () => {
    const m = forPerson(userMsg("for you"));
    expect(isForPerson(m)).toBe(true);
    expect(m.extensions).toContain("https://agentmessaging.ai/extensions/audience/v1");
    const part = artifactRefPart({ ref: "mesh:artifacts:abc", size: 12345, digest: `sha256:${"a".repeat(64)}`, media_type: "application/pdf", name: "r.pdf" });
    expect(part).toEqual({
      url: "mesh:artifacts:abc",
      mediaType: "application/pdf",
      filename: "r.pdf",
      metadata: { "https://agentmessaging.ai/extensions/artifact-refs/v1": { size: 12345, digest: `sha256:${"a".repeat(64)}` } },
    });
    expect(artifactRefOf(part)?.size).toBe(12345);
  });
});

describe("0.3.0 and 0.4.0 together (§14)", () => {
  it("a 0.4.0 SendMessage reaches an agent's 0.3.0 handler and comes back as an A2A Message in 0.4.0", async () => {
    const { client, server } = setup();
    server.onRequest("quote", async (input) => ({ price: 40, for: input }));
    (server as unknown as { listenInbox(): void }).listenInbox();
    const res = await client.a2a.sendMessage(server.id, withOffering({ messageId: "m", role: "ROLE_USER", parts: [{ data: { sku: 7741 } }] }, "quote"));
    expect(res.message?.parts[0].data).toEqual({ price: 40, for: { sku: 7741 } });
    const resp = bus.log.find((l) => l.env.type === "respond" && l.env.to === client.id)!;
    expect(resp.env.v).toBe(A2A_WIRE_VERSION);
  });

  it("a 0.3.0 request reaches an agent that only serves A2A, answered in 0.3.0", async () => {
    const { client, server } = setup();
    server.a2a.serve((m) => ({ messageId: "r", role: "ROLE_AGENT", parts: [{ data: { got: m.parts[0].data } }] }));
    const res = await client.request(server.id, "anything", { n: 1 }, { timeout_ms: 2000 });
    expect(res.payload.output).toEqual({ got: { n: 1 } });
    const req = bus.log.find((l) => l.env.type === "request" && l.env.to === server.id)!;
    expect(req.env.v).toBe("0.3.0");
    const resp = bus.log.find((l) => l.env.type === "respond" && l.env.to === client.id && l.env.in_reply_to === req.env.id && !(l.env.payload as { status?: string })?.status?.startsWith("accepted"))!;
    expect(resp.env.v).toBe("0.3.0");
  });

  it("an agent that serves A2A lists the binding in its manifest's capabilities", async () => {
    const { server } = setup();
    server.a2a.serve(() => undefined);
    const manifest = await (server as unknown as { buildManifest(o: { name: string }): Promise<{ capabilities: string[] }> }).buildManifest({ name: "q" });
    expect(manifest.capabilities).toContain(A2A_BINDING_URI);
  });
});
