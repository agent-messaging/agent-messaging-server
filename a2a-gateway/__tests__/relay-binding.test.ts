/**
 * The relay doors (src/inbound/relay.ts) for an agent that serves the A2A
 * binding: the turn travels as A2A's SendMessage in a 0.4.0 frame, with the
 * offering in the offering extension and the attribution marker and the front
 * end's meta on the envelope, and the A2A answer comes back in the shape the
 * relay's callers read on 0.3.0 ({kind, status, output, message?}). And the
 * binding pass-through (binding-pass.ts) carries the attribution marker too.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fromSeed } from "nkeys.js";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { relayAnswerOfA2A } from "../src/inbound/relay.js";
import { manifestFixture } from "./helpers.js";
import { makeBus, type Bus } from "../../sdk-typescript/__tests__/unit/a2a-bus.js";
import { A2A_BINDING_URI } from "../../sdk-typescript/src/a2a/binding.js";
import { EXT_OFFERING, exhaustedTask } from "../../sdk-typescript/src/a2a/extensions.js";
import type { AgentMesh } from "../../sdk-typescript/src/mesh.js";
import type { Manifest } from "../../sdk-typescript/src/types/manifest.js";
import type { Task } from "../../sdk-typescript/src/a2a/types.js";
import { A2AError } from "../../sdk-typescript/src/a2a/errors.js";

const open: Server[] = [];
let bus: Bus;
afterEach(async () => {
  while (open.length) {
    const s = open.pop()!;
    s.closeAllConnections?.();
    s.close();
  }
  await bus?.close();
});

async function gateway(serve: (agent: AgentMesh) => void, offerings = ["chat"]) {
  bus = makeBus();
  const target = bus.agent();
  serve(target);
  const manifest: Manifest = manifestFixture({
    id: target.id,
    endpoint: `mesh.agent.${target.id}.inbox`,
    capabilities: [A2A_BINDING_URI],
    offerings: offerings.map((id) => ({ id, name: id, description: "x" })),
  } as never);
  const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, apiKeys: { k1: "partner" } });
  const internals = bridge as unknown as { node: unknown; courier: unknown };
  internals.node = {
    id: "UNODEFAKEFAKEFAKEFAKE",
    addAgent: (opts?: { nkeySeed?: string }) => bus.agent(opts?.nkeySeed ? (fromSeed(new TextEncoder().encode(opts.nkeySeed)) as never) : undefined),
    removeAgent: async () => true,
    drain: async () => undefined,
    startHeartbeat: () => undefined,
  };
  internals.courier = {
    discover: async () => ({ agents: [manifest], total: 1 }),
    getManifest: async (id: string) => {
      if (id !== target.id) throw new Error("no such agent");
      return manifest;
    },
  };
  const server = await startInboundServer(bridge);
  open.push(server);
  const port = (server.address() as AddressInfo).port;
  const turn = async (body: Record<string, unknown>) =>
    (await (await fetch(`http://127.0.0.1:${port}/admin/relay/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;
  const rpc = async (method: string, params: unknown) =>
    (await fetch(`http://127.0.0.1:${port}/agents/${target.id}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer k1", "A2A-Version": "1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })).json();
  return { target, turn, rpc };
}

const T = (responder: string, extra: Record<string, unknown> = {}) => ({
  caller_key: "pact:abc", responder, offering: "chat", input: { text: "hello" }, context_id: "ctx-1", meta: { pact: { pa: "iss", user: "u" } }, binding: "pact", ...extra,
});

const requestFrame = () => bus.log.find((l) => l.env.type === "request" && (l.env.payload as { a2a?: unknown }).a2a)!.env;

describe("the relay door to an agent that serves the A2A binding", () => {
  it("sends SendMessage in a 0.4.0 frame with the offering, the marker and the front end's meta; a Message answers done", async () => {
    const { target, turn } = await gateway((a) => a.a2a.serve((m) => ({ messageId: "r1", role: "ROLE_AGENT", parts: [{ text: `hi back to ${m.parts[0]!.text}` }] })));
    expect(await turn(T(target.id))).toEqual({ kind: "done", status: "completed", output: "hi back to hello" });
    const f = requestFrame();
    expect(f.v).toBe("0.4.0");
    const params = (f.payload as { a2a: { method: string; params: { message: { contextId?: string; metadata?: Record<string, unknown> } } } }).a2a;
    expect(params.method).toBe("SendMessage");
    expect(params.params.message.contextId).toBe("ctx-1");
    expect(params.params.message.metadata?.[EXT_OFFERING]).toEqual({ offering: "chat" });
    const meta = f.meta as Record<string, unknown>;
    expect(meta.pact).toEqual({ pa: "iss", user: "u" });
    expect(meta.a2a_bridge).toMatchObject({ direction: "inbound" });
    for (const k of ["task_id", "context_id"]) expect(k in f).toBe(false);
  });

  it("a Task finished in the call answers done with its artifacts; a failed one with its words", async () => {
    const ok = await gateway((a) =>
      a.a2a.serve(async (_m, ctx) => {
        const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
        t.artifact({ artifactId: "a", parts: [{ data: { total: 3 } }] });
        t.complete("Done.");
        return t;
      }),
    );
    expect(await ok.turn(T(ok.target.id))).toMatchObject({ kind: "done", status: "completed", output: { total: 3 } });
    await bus.close();
    const bad = await gateway((a) =>
      a.a2a.serve(async (_m, ctx) => {
        const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
        t.fail("The source was unreachable.");
        return t;
      }),
    );
    expect(await bad.turn(T(bad.target.id))).toEqual({ kind: "done", status: "failed", output: null, message: "The source was unreachable." });
  });

  it("a Task still running when the call returns is late, as a 0.3.0 Task answer is", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { target, turn } = await gateway((a) =>
      a.a2a.serve(
        async (_m, ctx) => {
          const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
          await gate;
          t.complete("Done.");
          return t;
        },
        { replyWindowMs: 30 },
      ),
    );
    expect(await turn(T(target.id))).toEqual({ kind: "late" });
    release();
  });

  it("an A2A error is a failed turn, with the error's name as the code", async () => {
    const { target, turn } = await gateway((a) =>
      a.a2a.serve(() => {
        throw new A2AError("InvalidParamsError", "No offering by that name.", { offerings: ["a", "b"] });
      }),
    );
    expect(await turn(T(target.id, { offering: "nope" }))).toEqual({ kind: "failed", code: "InvalidParamsError" });
  });
});

describe("relayAnswerOfA2A", () => {
  const task = (state: string, extra: Partial<Task> = {}): Task => ({ id: "t", contextId: "c", status: { state: state as Task["status"]["state"] }, ...extra });
  it("spells each ending as the 0.3.0 wire does", () => {
    expect(relayAnswerOfA2A({ task: task("TASK_STATE_REJECTED", { status: { state: "TASK_STATE_REJECTED", message: { messageId: "s", role: "ROLE_AGENT", parts: [{ text: "No." }] } } }) })).toEqual({ kind: "done", status: "rejected", output: null, message: "No." });
    expect(relayAnswerOfA2A({ task: exhaustedTask(task("TASK_STATE_WORKING"), "Cap reached.") })).toMatchObject({ kind: "done", status: "exhausted", output: null, message: "Cap reached." });
    expect(relayAnswerOfA2A({ task: task("TASK_STATE_INPUT_REQUIRED") })).toEqual({ kind: "late" });
    expect(relayAnswerOfA2A({ message: { messageId: "m", role: "ROLE_AGENT", parts: [{ text: "a" }, { text: "b" }] } })).toEqual({ kind: "done", status: "completed", output: "a\nb" });
  });
});

describe("the binding pass-through carries the attribution marker", () => {
  it("meta.a2a_bridge is on the frame, as on every 0.3.0 request the bridge sends", async () => {
    const { rpc } = await gateway((a) => a.a2a.serve(() => ({ messageId: "r1", role: "ROLE_AGENT", parts: [{ text: "ok" }] })));
    await rpc("SendMessage", { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hi" }] } });
    expect((requestFrame().meta as Record<string, unknown>).a2a_bridge).toMatchObject({ direction: "inbound" });
  });
});

describe("a queued A2A turn", () => {
  it("is held open for the agent's late answer, up to the turn's time", async () => {
    const { relayTurn } = await import("../src/inbound/relay.js");
    const { MeshError, ErrorCode } = await import("../../sdk-typescript/src/types/errors.js");
    let late: ((a: unknown, id: string) => void) | undefined;
    const requester = {
      a2a: {
        sendMessage: async (_to: string, _m: unknown, opts: { onLateAnswer?: (a: unknown, id: string) => void }) => {
          late = opts.onLateAnswer;
          throw new MeshError(ErrorCode.REQUEST_QUEUED, "queued", { details: { request_id: "req-1" } });
        },
      },
    };
    const bridge = {
      identityFor: async () => requester,
      attributionMeta: () => undefined,
      emitInboundCall: () => undefined,
      servesA2ABinding: async () => true,
    } as never;
    const t = { callerKey: "k", responder: "R".repeat(56), offering: "chat", input: "hi", timeoutMs: 5_000, binding: "pact" };
    const pending = relayTurn(bridge, t);
    await new Promise((r) => setTimeout(r, 20));
    late!({ result: { message: { messageId: "x", role: "ROLE_AGENT", parts: [{ text: "later words" }] } } }, "req-1");
    expect(await pending).toEqual({ kind: "done", status: "completed", output: "later words" });

    const refused = relayTurn(bridge, t);
    await new Promise((r) => setTimeout(r, 20));
    late!({ error: new MeshError(ErrorCode.INTERNAL_ERROR, "it broke") }, "req-1");
    expect(await refused).toEqual({ kind: "done", status: "rejected", output: null, message: "it broke" });

    const quiet = relayTurn(bridge, { ...t, timeoutMs: 1000 });
    expect(await quiet).toEqual({ kind: "late" });
  });
});
