/**
 * Interop: the A2A project's own JavaScript client (@a2a-js/sdk 1.3.0) reads
 * a generated card, then calls a mesh agent served by the SDK's
 * `mesh.a2a.serve` through the gateway, over JSON-RPC and over HTTP+JSON.
 * The A2A objects it gets are the ones the agent built (bindings/a2a.md §13).
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fromSeed } from "nkeys.js";
import { ClientFactory, ClientFactoryOptions } from "@a2a-js/sdk/client";
import { Role, TaskState } from "@a2a-js/sdk";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { manifestFixture } from "./helpers.js";
import { makeBus, type Bus } from "../../sdk-typescript/__tests__/unit/a2a-bus.js";
import { A2A_BINDING_URI } from "../../sdk-typescript/src/a2a/binding.js";

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

async function gateway() {
  bus = makeBus();
  const target = bus.agent();
  target.a2a.serve(async (m, ctx) => {
    const text = m.parts.map((p) => p.text ?? "").join(" ");
    if (text === "quick") return { messageId: "r-1", role: "ROLE_AGENT", parts: [{ text: "a quick answer" }] };
    const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
    t.artifact({ artifactId: "quote", name: "quote", parts: [{ data: { price: 40, currency: "USD" } }] });
    t.complete("Here is the quote.");
    return t;
  });
  const manifest = manifestFixture({ id: target.id, endpoint: `mesh.agent.${target.id}.inbox`, capabilities: [A2A_BINDING_URI] });
  const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, allowAnonymous: true });
  const internals = bridge as unknown as { node: unknown; courier: unknown; config: { publicBaseUrl: string } };
  internals.node = {
    id: "UNODEFAKEFAKEFAKEFAKE",
    addAgent: (opts?: { nkeySeed?: string }) =>
      bus.agent(opts?.nkeySeed ? (fromSeed(new TextEncoder().encode(opts.nkeySeed)) as never) : undefined),
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
  internals.config.publicBaseUrl = `http://127.0.0.1:${port}`;
  return { base: `http://127.0.0.1:${port}/agents/${target.id}` };
}

/** A user message in the JS SDK's own types (its client writes ProtoJSON). */
const userMessage = (messageId: string, text: string) =>
  ({ messageId, role: Role.ROLE_USER, parts: [{ content: { $case: "text", value: text } }], contextId: "", taskId: "", extensions: [], referenceTaskIds: [] }) as never;

for (const transport of ["JSONRPC", "HTTP+JSON"] as const) {
  describe(`@a2a-js/sdk over ${transport}`, () => {
    it("sends a message, reads the Task, lists it, and streams", async () => {
      const { base } = await gateway();
      const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, { preferredTransports: [transport] }));
      const client = await factory.createFromUrl(`${base}/.well-known/agent-card.json`, "");

      // A Message answer.
      const quick = (await client.sendMessage({ message: userMessage("m-1", "quick") } as never)) as unknown as {
        messageId?: string;
        role?: number;
        parts?: Array<{ content?: { value?: unknown } }>;
      };
      expect(quick.messageId).toBe("r-1");
      expect(quick.role).toBe(Role.ROLE_AGENT);
      expect(quick.parts?.[0].content?.value).toBe("a quick answer");

      // A Task answer, read back, listed.
      const task = (await client.sendMessage({ message: userMessage("m-2", "quote please") } as never)) as unknown as {
        id: string;
        status: { state: number };
      };
      expect(typeof task.id).toBe("string");
      expect(task.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
      const got = (await client.getTask({ id: task.id, tenant: "" } as never)) as unknown as { id: string; artifacts: Array<{ artifactId: string; parts: unknown[] }> };
      expect(got.id).toBe(task.id);
      expect(got.artifacts[0].artifactId).toBe("quote");
      expect(JSON.stringify(got.artifacts[0].parts)).toContain("40");
      const list = (await client.listTasks({ tenant: "", contextId: "", status: TaskState.TASK_STATE_UNSPECIFIED } as never)) as unknown as { tasks: Array<{ id: string }> };
      expect(list.tasks.map((t) => t.id)).toContain(task.id);

      // A stream, to its end.
      const states: number[] = [];
      for await (const ev of client.sendMessageStream({ message: userMessage("m-3", "stream it") } as never)) {
        const e = ev as unknown as { payload?: { $case?: string; value?: { status?: { state: number } } } };
        const st = e.payload?.value?.status?.state;
        if (typeof st === "number") states.push(st);
      }
      expect(states.at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    });
  });
}
