/**
 * RequestConfig.task_id: the follow-up request that answers a responder
 * waiting in input_required names the Task (§6.4, §7.3). The A2A gateway
 * sends it when an A2A caller answers on the same task.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import { decodeUnverified } from "../../src/internal/codec.js";
import type { Envelope } from "../../src/types/envelope.js";

const open: AgentMesh[] = [];
afterEach(async () => {
  for (const a of open.splice(0)) await a.close();
});

function conn() {
  const sent: Envelope[] = [];
  const c = {
    sent,
    publish: vi.fn((_s: string, data: Uint8Array) => void sent.push(decodeUnverified(data))),
    // Nobody answers: the request times out, which is all this test needs.
    request: vi.fn(async (_s: string, data: Uint8Array) => {
      sent.push(decodeUnverified(data));
      return new Promise(() => {});
    }),
    requestMulti: vi.fn((_s: string, data: Uint8Array) => {
      sent.push(decodeUnverified(data));
      return new Promise(() => {});
    }),
    subscribe: vi.fn(() => ({ unsubscribe: () => {}, drain: async () => {} })),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    raw: { publish: () => {} },
    isClosed: false,
  };
  return c;
}

describe("request with task_id", () => {
  it("carries the Task's id on the envelope", async () => {
    const c = conn();
    const a = AgentMesh.withConnection(c as unknown as ConnectionManager, nkeys.createUser(), nkeys.createUser());
    open.push(a);
    const target = nkeys.createUser().getPublicKey();
    void a.request(target, "quote", { answer: "40" }, { task_id: "task-9", context_id: "ctx-9", timeout_ms: 30 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    const env = c.sent.find((e) => e.type === "request" && e.to === target)!;
    expect(env.task_id).toBe("task-9");
    expect(env.context_id).toBe("ctx-9");
  });

  it("leaves task_id off a fresh request", async () => {
    const c = conn();
    const a = AgentMesh.withConnection(c as unknown as ConnectionManager, nkeys.createUser(), nkeys.createUser());
    open.push(a);
    const target = nkeys.createUser().getPublicKey();
    void a.request(target, "quote", {}, { timeout_ms: 30 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(c.sent.find((e) => e.type === "request" && e.to === target)!.task_id).toBeUndefined();
  });
});
