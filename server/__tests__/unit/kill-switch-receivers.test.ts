// The kill switch at the receiving end (docs/kill-switch-plan.md item 3):
// registry status (§9), the answer a sender gets for a stopped agent, and the
// per-agent status the registry and the inbox read.
import { describe, it, expect, vi } from "vitest";
import { handleRegister } from "../../src/registry/handlers/register.js";
import { handleGet } from "../../src/registry/handlers/get.js";
import { createEnvelope, ErrorCode, nkeys, createAttestation, decode } from "../../src/sdk.js";
import type { Envelope, Manifest } from "../../src/sdk.js";
import { PresenceStore } from "../../src/registry/presence-store.js";
import { NodeProfileStore } from "../../src/registry/node-profile-store.js";
import { MemoryAgentStatus, type AgentStatusEntry } from "../../src/shared/agent-status.js";
import { answerStopped, stopNotice, StopAnswerer, PAUSED_TEXT, TERMINATED_TEXT } from "../../src/admission/stop-answerer.js";
import { AGENT_KEY_REVOKED } from "../../src/shared/agent-key-revocations.js";

const key = () => nkeys.createUser().getPublicKey();
const paused = (): AgentStatusEntry => ({ status: "paused", since: "2026-09-27T10:00:00.000Z", stop_id: "stp_1", scope: "person" });
const terminated = (): AgentStatusEntry => ({ status: "terminated", since: "2026-09-27T11:00:00.000Z", stop_id: "stp_2", scope: "agent" });

function manifestKv(m: Manifest) {
  const v = JSON.stringify(m);
  return { get: vi.fn(async () => ({ operation: "PUT", value: new TextEncoder().encode(v), json: () => JSON.parse(v) })) };
}

function vouched(): { id: string; manifest: Manifest } {
  const kp = nkeys.createUser();
  const id = kp.getPublicKey();
  const manifest = {
    id, name: "A", description: "a", version: "1.0.0", protocol_version: "0.2.0",
    endpoint: `mesh.agent.${id}.inbox`,
    node: { id, attestation: createAttestation(kp, id) },
    capabilities: ["chat"], offerings: [{ id: "echo", name: "Echo", description: "Echo" }],
  } as unknown as Manifest;
  return { id, manifest };
}

describe("registry status (§9)", () => {
  it("a paused agent is still found, and its manifest says paused and since when", async () => {
    const { id, manifest } = vouched();
    const st = new MemoryAgentStatus();
    await st.set(id, paused());
    const env = createEnvelope({ type: "discover", from: key(), payload: {} });
    const resp = await handleGet(env, { subject: `mesh.registry.get.${id}` } as never, manifestKv(manifest) as never, "svc", new Map(), undefined, st);
    expect(resp.error).toBeUndefined();
    expect(resp.payload).toMatchObject({ id, status: "paused", status_since: "2026-09-27T10:00:00.000Z" });
  });

  it("a terminated agent is refused with the reason receivers already refuse on, and says terminated", async () => {
    const id = key();
    const st = new MemoryAgentStatus();
    await st.set(id, terminated());
    const env = createEnvelope({ type: "discover", from: key(), payload: {} });
    const kv = { get: vi.fn(async () => null) };
    const resp = await handleGet(env, { subject: `mesh.registry.get.${id}` } as never, kv as never, "svc", new Map(), undefined, st);
    expect(resp.error?.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(resp.error?.details).toMatchObject({ reason: AGENT_KEY_REVOKED, status: "terminated" });
  });

  it("a running agent's manifest carries no status", async () => {
    const { id, manifest } = vouched();
    const env = createEnvelope({ type: "discover", from: key(), payload: {} });
    const resp = await handleGet(env, { subject: `mesh.registry.get.${id}` } as never, manifestKv(manifest) as never, "svc", new Map(), undefined, new MemoryAgentStatus());
    expect((resp.payload as { status?: string }).status).toBeUndefined();
  });

  it("a terminated agent cannot register again", async () => {
    const { id, manifest } = vouched();
    const st = new MemoryAgentStatus();
    await st.set(id, terminated());
    const env = createEnvelope({ type: "register", from: id, payload: manifest });
    const kv = { put: vi.fn(), get: vi.fn(async () => null) };
    const resp = await handleRegister(env, kv as never, { publish: vi.fn() } as never, "svc", new Map(),
      new PresenceStore(), new NodeProfileStore(), undefined, undefined, {}, undefined, st);
    expect(resp.error?.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(resp.error?.details?.reason).toBe("agent_terminated");
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("terminated is final: nothing downgrades it to paused or clears it", async () => {
    const st = new MemoryAgentStatus();
    const id = key();
    await st.set(id, terminated());
    await st.set(id, paused());
    expect((await st.get(id))?.status).toBe("terminated");
    expect(await st.clear(id)).toBe(false);
  });
});

describe("the sender of a message to a stopped agent is told", () => {
  const kp = nkeys.createUser();
  const sender = key();
  const req = createEnvelope({ type: "request", from: sender, payload: { offering: "chat", input: { text: "hi" } } });

  it("paused: a queued answer saying the message waits, signed by the intermediary", () => {
    const env = decode(stopNotice(req, key(), "paused", kp)) as unknown as Envelope;
    expect(env.error).toBeUndefined();
    expect(env.in_reply_to).toBe(req.id);
    expect(env.from).toBe(kp.getPublicKey());
    expect((env.payload as { output: { text: string; queued: boolean; code: string } }).output).toMatchObject({ queued: true, code: "agent_paused", text: PAUSED_TEXT });
  });

  it("terminated: an error saying it was not delivered", () => {
    const env = decode(stopNotice(req, key(), "terminated", kp)) as unknown as Envelope;
    expect(env.error?.message).toBe(TERMINATED_TEXT);
    expect(env.error?.details?.reason).toBe("agent_terminated");
  });

  it("the answer goes to the sender's inbox and the reply subject; answers are not answered", () => {
    const publish = vi.fn();
    const respond = vi.fn();
    expect(answerStopped({ publish } as never, { reply: "_INBOX.x", respond } as never, req, key(), "paused", kp)).toBe(true);
    expect(publish).toHaveBeenCalledWith(`mesh.agent.${sender}.inbox`, expect.any(Uint8Array));
    expect(respond).toHaveBeenCalledTimes(1);
    const reply = createEnvelope({ type: "respond", from: sender, payload: {} });
    expect(answerStopped({ publish } as never, { reply: undefined, respond } as never, reply, key(), "paused", kp)).toBe(false);
  });

  it("the answerer follows the status: it listens while stopped and lets go on resume, never for a guarded agent", () => {
    const subs: Array<{ subject: string; unsubscribe: () => void; closed: boolean }> = [];
    const nc = {
      subscribe: vi.fn((subject: string) => {
        const s = { subject, closed: false, unsubscribe() { s.closed = true; }, [Symbol.asyncIterator]: async function* () { /* no mail in this test */ } };
        subs.push(s);
        return s;
      }),
      publish: vi.fn(),
    };
    const guarded = key();
    const a = new StopAnswerer(nc as never, kp, (k) => k === guarded);
    const id = key();
    a.onStatus(id, paused());
    expect(a.size).toBe(1);
    expect(subs[0].subject).toBe(`mesh.agent.${id}.inbox`);
    a.onStatus(id, null);
    expect(a.size).toBe(0);
    expect(subs[0].closed).toBe(true);
    a.onStatus(guarded, paused());
    expect(a.size).toBe(0);
  });
});
