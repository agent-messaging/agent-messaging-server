/**
 * A2A binding 0.3.0-draft: several streams on one Task, each with its own
 * streamId and seq; a stream kept open through an interrupted state; Task
 * changes on the update subject; budget refused on a 0.4.0 frame; channel
 * frames at 0.4.0; the overdue and completed-late marks; failure reasons;
 * cancel reasons listed on a refusal; the audience marks agreeing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { makeBus, tick, type Bus } from "./a2a-bus.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode } from "../../src/types/errors.js";
import {
  A2AError,
  A2A_WIRE_VERSION,
  EXT_BUDGET,
  EXT_CANCEL,
  EXT_FAILURE,
  failureReasonOf,
  forPerson,
  isOverdue,
  budgetOutcomeOf,
  type Message,
  type StreamResponse,
} from "../../src/a2a/index.js";

let bus: Bus;
afterEach(async () => {
  bus.drop = null;
  await bus.close();
});

const msg = (text: string, extra: Partial<Message> = {}): Message => ({
  messageId: `m-${Math.random().toString(36).slice(2)}`,
  role: "ROLE_USER",
  parts: [{ text }],
  ...extra,
});

function setup() {
  bus = makeBus();
  return { client: bus.agent(), server: bus.agent() };
}

type StreamFrame = { a2a: { streamId?: string; seq?: number; final?: boolean; result: StreamResponse } };

describe("§8 streams share a Task's subject, each by its streamId", () => {
  it("two streams on one Task count their own seq, and each ends at the terminal state", async () => {
    const { client, server } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.a2a.serve(async (_m, ctx) => {
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      await gate;
      await tick(30);
      t.artifact({ artifactId: "a", parts: [{ text: "x" }] });
      t.complete();
      return t;
    });
    const first = client.a2a.sendStreamingMessage(server.id, msg("go"));
    const a: StreamResponse[] = [];
    const b: StreamResponse[] = [];
    let second: ReturnType<typeof client.a2a.subscribeToTask> | undefined;
    const runA = (async () => {
      for await (const ev of first) {
        a.push(ev);
        if (a.length === 1) {
          second = client.a2a.subscribeToTask(server.id, first.taskId!);
          const runB = (async () => {
            for await (const e of second!) {
              b.push(e);
              if (b.length === 1) release();
            }
          })();
          void runB;
        }
      }
    })();
    await runA;
    await tick(30);
    expect((a.at(-1)?.statusUpdate?.status.state ?? a.at(-1)?.task?.status.state)).toBe("TASK_STATE_COMPLETED");
    expect((b.at(-1)?.statusUpdate?.status.state ?? b.at(-1)?.task?.status.state)).toBe("TASK_STATE_COMPLETED");

    const frames = bus.log.filter((l) => l.subject === Subjects.taskStream(first.taskId!)).map((l) => l.env.payload as StreamFrame);
    const byStream = new Map<string, number[]>();
    for (const f of frames) byStream.set(f.a2a.streamId!, [...(byStream.get(f.a2a.streamId!) ?? []), f.a2a.seq!]);
    expect([...byStream.keys()].sort()).toEqual([first.streamId, second!.streamId].sort());
    for (const seqs of byStream.values()) expect(seqs).toEqual([1, 2]);
    expect(frames.filter((f) => f.a2a.final).length).toBe(2);
  });

  it("an interrupted state keeps the stream open; the continuing message's events end it", async () => {
    const { client, server } = setup();
    server.a2a.serve(async (m, ctx) => {
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      await tick(30);
      if (ctx.existingTask) t.complete(`Shipping to ${m.parts[0].text}.`);
      else t.requireInput("Where to?");
      return t;
    });
    const s = client.a2a.sendStreamingMessage(server.id, msg("ship it"));
    const events: StreamResponse[] = [];
    for await (const ev of s) {
      events.push(ev);
      if ((ev?.statusUpdate?.status.state ?? ev?.task?.status.state) === "TASK_STATE_INPUT_REQUIRED") {
        void client.a2a.sendMessage(server.id, msg("Denver", { taskId: s.taskId! }));
      }
    }
    const states = events.map((e) => e.task?.status.state ?? e.statusUpdate?.status.state);
    expect(states).toContain("TASK_STATE_INPUT_REQUIRED");
    expect(states.at(-1)).toBe("TASK_STATE_COMPLETED");
  });
});

describe("§4 frames", () => {
  it("refuses a 0.4.0 frame carrying the envelope budget", async () => {
    const { server } = setup();
    let ran = false;
    server.a2a.serve(() => ((ran = true), { messageId: "r", role: "ROLE_AGENT", parts: [] }));
    const kp = nkeys.createUser();
    const env = signEnvelope(
      createEnvelope({
        type: "request",
        from: kp.getPublicKey(),
        to: server.id,
        v: A2A_WIRE_VERSION,
        budget: { revision: 0, deadline: "2026-12-01T00:00:00Z" },
        payload: { a2a: { method: "SendMessage", params: { message: msg("hi") } } },
      }),
      kp,
    );
    bus.publishRaw(Subjects.agentInbox(server.id), encode(env));
    await tick(40);
    expect(ran).toBe(false);
    expect(bus.log.find((l) => l.env.in_reply_to === env.id)?.env.error?.code).toBe(ErrorCode.INVALID_ENVELOPE);
  });

  it("a channel frame at 0.4.0 (no a2a member) goes on to the channel, never to the A2A side", async () => {
    const { server } = setup();
    server.a2a.serve(() => undefined);
    const kp = nkeys.createUser();
    const env = signEnvelope(
      createEnvelope({ type: "request", from: kp.getPublicKey(), to: server.id, v: A2A_WIRE_VERSION, payload: { offering: "describe", input: {} } }),
      kp,
    );
    bus.publishRaw(Subjects.agentInbox(server.id), encode(env));
    await tick(60);
    const answer = bus.log.find((l) => l.env.in_reply_to === env.id)?.env;
    expect(answer).toBeDefined();
    expect(["InvalidRequestError", "MethodNotFoundError"]).not.toContain(answer?.error?.code);
  });
});

describe("§12 extension marks", () => {
  it("overdue on a status update, completed_late on the completed Task", async () => {
    const { client, server } = setup();
    server.a2a.serve(async (_m, ctx) => {
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      await tick(40);
      t.overdue("Past the deadline; still working.");
      await tick(20);
      t.completeLate();
      return t;
    });
    const s = client.a2a.sendStreamingMessage(server.id, msg("go"));
    const events: StreamResponse[] = [];
    for await (const ev of s) events.push(ev);
    const all = [events[0].task, ...events.map((e) => e.statusUpdate)];
    expect(all.some((x) => x && isOverdue(x))).toBe(true);
    const res = await client.a2a.getTask(server.id, s.taskId!);
    expect(res.status.state).toBe("TASK_STATE_COMPLETED");
    expect(budgetOutcomeOf(res)?.outcome).toBe("completed_late");
  });

  it("a failed Task states its reason under the failure extension", async () => {
    const { client, server } = setup();
    server.a2a.serve((_m, ctx) => {
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      t.fail("The billing service is down.", { reason: "dependency_failed", dependency: "billing" });
      return t;
    });
    const res = await client.a2a.sendMessage(server.id, msg("go"));
    expect(res.task?.status.state).toBe("TASK_STATE_FAILED");
    expect(failureReasonOf(res.task)).toEqual({ reason: "dependency_failed", dependency: "billing" });
    expect(res.task?.metadata?.[EXT_FAILURE]).toBeDefined();
  });

  it("a cancel reason off the list is refused, listing the reasons", async () => {
    const { client, server } = setup();
    server.a2a.serve((_m, ctx) => ctx.startTask({ state: "TASK_STATE_WORKING" }));
    const t = await client.a2a.sendMessage(server.id, msg("go"));
    const err = (await client.a2a
      .call(server.id, "CancelTask", { id: t.task!.id, metadata: { [EXT_CANCEL]: { reason: "bored" } } })
      .catch((e) => e)) as A2AError;
    expect(err.code).toBe("InvalidParamsError");
    expect(err.data.reasons).toContain("user_requested");
  });

  it("a message marked for the person carries meta.audience too; a disagreeing frame is treated as the person's", async () => {
    const { client, server } = setup();
    let ran = false;
    server.a2a.serve(() => ((ran = true), { messageId: "r", role: "ROLE_AGENT", parts: [] }));
    void client.a2a.sendMessage(server.id, forPerson(msg("for you")), { timeoutMs: 200 }).catch(() => undefined);
    await tick(60);
    const req = bus.log.find((l) => l.env.type === "request" && l.env.to === server.id)!.env;
    expect((req.meta as Record<string, unknown>).audience).toBe("person");
    expect(ran).toBe(false);

    // Signed without meta.audience but with the extension's mark.
    const kp = nkeys.createUser();
    const env = signEnvelope(
      createEnvelope({
        type: "request",
        from: kp.getPublicKey(),
        to: server.id,
        v: A2A_WIRE_VERSION,
        payload: { a2a: { method: "SendMessage", params: { message: forPerson(msg("hello")) } } },
      }),
      kp,
    );
    bus.publishRaw(Subjects.agentInbox(server.id), encode(env));
    await tick(60);
    expect(ran).toBe(false);
    void EXT_BUDGET;
  });
});
