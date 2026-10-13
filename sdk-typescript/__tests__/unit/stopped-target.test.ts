// What a caller is told when it sends to an agent the mesh has stopped (§4.12)
// or whose key was revoked (§4.10).
//
// A pause keeps the message: the mesh answers for the paused agent with a
// queued answer that says so, and the caller's REQUEST_QUEUED now says the
// agent is paused (it used to read as an ordinary held mailbox). A terminated
// agent, or a revoked key, never reads the message: when the target is silent
// the SDK asks the registry, and says so instead of "may just be offline".
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { MeshError } from "../../src/types/errors.js";
import type { Envelope } from "../../src/types/envelope.js";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

type RegistryAnswer = { payload?: unknown; error?: { code: string; message: string; details?: Record<string, unknown> } };

/** In-process connection. An inbox request gets `inbox(req)` delivered to the
 *  requester's inbox (nothing: silence); a registry get gets `registry`. */
function makeConn(inbox: (req: Envelope) => Envelope[], registry: RegistryAnswer) {
  const subs = new Map<string, Set<(msg: unknown) => void>>();
  const service = nkeys.createUser();
  const answer = (req: Envelope, a: RegistryAnswer) => ({
    data: encode(
      signEnvelope(
        createEnvelope({
          type: "respond",
          from: service.getPublicKey(),
          to: req.from,
          in_reply_to: req.id,
          ...(a.error ? { error: { ...a.error, retryable: false } } : { payload: a.payload }),
        }),
        service,
      ),
    ),
  });
  return {
    publish: vi.fn((subject: string, data: Uint8Array) => {
      for (const cb of subs.get(subject) ?? []) cb({ subject, data, reply: undefined, respond: () => true });
    }),
    request: vi.fn(async (subject: string, data: Uint8Array, opts?: { timeout?: number }) => {
      const req = decodeUnverified(data);
      if (subject.endsWith(".inbox")) {
        for (const env of inbox(req)) {
          for (const cb of subs.get(Subjects.agentInbox(req.from)) ?? []) {
            cb({ subject: Subjects.agentInbox(req.from), data: encode(env), reply: undefined, respond: () => true });
          }
        }
        return await new Promise<never>((_, reject) =>
          setTimeout(() => reject(new MeshError("TRANSPORT_TIMEOUT" as never, "timed out")), opts?.timeout ?? 300),
        );
      }
      if (subject.startsWith("mesh.registry.get.")) return answer(req, registry);
      return answer(req, { payload: { status: "registered" } });
    }),
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
      if (!subs.has(subject)) subs.set(subject, new Set());
      subs.get(subject)!.add(cb);
      return { unsubscribe: () => subs.get(subject)?.delete(cb), drain: async () => {} };
    }),
    flush: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    raw: { publish: () => {}, subscribe: () => ({ unsubscribe() {}, [Symbol.asyncIterator]: async function* () {} }) },
    get isClosed() {
      return false;
    },
  };
}

async function caller(conn: ReturnType<typeof makeConn>) {
  const a = AgentMesh.withConnection(conn as unknown as ConnectionManager, nkeys.createUser(), nkeys.createUser(), {});
  openAgents.push(a);
  await a.register({ name: "caller" });
  return a;
}

async function failure(p: Promise<unknown>): Promise<MeshError> {
  try {
    await p;
  } catch (e) {
    return e as MeshError;
  }
  throw new Error("expected the request to fail");
}

/** The mesh's signed answer for a paused agent (the admission service's stop
 *  answerer), in the shape it sends. */
function pausedNotice(kp: KeyPair, req: Envelope): Envelope {
  return signEnvelope(
    createEnvelope({
      type: "respond",
      from: kp.getPublicKey(),
      to: req.from,
      in_reply_to: req.id,
      payload: { output: { queued: true, paused: true, code: "agent_paused", inbox_id: "inbox-1", text: "This agent is paused." } },
    }),
    kp,
  );
}

describe("sending to a stopped agent", () => {
  it("a paused agent: REQUEST_QUEUED that says it is paused, and that the message waits", async () => {
    const target = nkeys.createUser();
    const conn = makeConn((req) => [pausedNotice(target, req)], { payload: {} });
    const a = await caller(conn);
    const e = await failure(a.request(target.getPublicKey(), "ping", {}, { timeout_ms: 2_000 }));
    expect(e.code).toBe("REQUEST_QUEUED");
    expect(e.message).toContain("is paused");
    expect(e.details).toMatchObject({ queued: true, paused: true, reason: "agent_paused", inbox_id: "inbox-1" });
  });

  it("an ordinary held mailbox is still reported as before", async () => {
    const target = nkeys.createUser();
    const plain = (req: Envelope) => [
      signEnvelope(
        createEnvelope({ type: "respond", from: target.getPublicKey(), to: req.from, in_reply_to: req.id, payload: { queued: true, inbox_id: "inbox-2" } }),
        target,
      ),
    ];
    const a = await caller(makeConn(plain, { payload: {} }));
    const e = await failure(a.request(target.getPublicKey(), "ping", {}, { timeout_ms: 2_000 }));
    expect(e.code).toBe("REQUEST_QUEUED");
    expect(e.message).toContain("attended session");
    expect(e.details?.paused).toBeUndefined();
  });

  it("a silent target whose key was revoked: refused, not captured, with where it moved", async () => {
    const target = nkeys.createUser().getPublicKey();
    const moved = nkeys.createUser().getPublicKey();
    const conn = makeConn(() => [], {
      error: { code: "UNAUTHORIZED", message: "revoked", details: { reason: "agent_key_revoked", revoked_at: "2026-10-13T00:00:00.000Z", replaced_by: moved } },
    });
    const a = await caller(conn);
    const e = await failure(a.request(target, "ping", {}, { timeout_ms: 300 }));
    expect(e.code).toBe("AGENT_UNAVAILABLE");
    expect(e.message).toContain("signing key was revoked");
    expect(e.details).toMatchObject({ captured: false, reason: "agent_key_revoked", replaced_by: moved });
  });

  it("a silent target that was terminated: refused with agent_terminated", async () => {
    const target = nkeys.createUser().getPublicKey();
    const conn = makeConn(() => [], {
      error: { code: "UNAUTHORIZED", message: "terminated", details: { reason: "agent_key_revoked", status: "terminated" } },
    });
    const a = await caller(conn);
    const e = await failure(a.request(target, "ping", {}, { timeout_ms: 300 }));
    expect(e.code).toBe("AGENT_UNAVAILABLE");
    expect(e.message).toContain("terminated");
    expect(e.details).toMatchObject({ captured: false, reason: "agent_terminated" });
  });

  it("a silent target the registry says is paused: REQUEST_QUEUED, paused", async () => {
    const target = nkeys.createUser().getPublicKey();
    const conn = makeConn(() => [], { payload: { id: target, status: "paused", status_since: "2026-10-13T00:00:00.000Z" } });
    const a = await caller(conn);
    const e = await failure(a.request(target, "ping", {}, { timeout_ms: 300 }));
    expect(e.code).toBe("REQUEST_QUEUED");
    expect(e.details).toMatchObject({ paused: true, reason: "agent_paused", captured: true });
  });

  it("a silent target in good standing: 'may just be offline', captured, as before", async () => {
    const target = nkeys.createUser().getPublicKey();
    const conn = makeConn(() => [], { payload: { id: target } });
    const a = await caller(conn);
    const e = await failure(a.request(target, "ping", {}, { timeout_ms: 300 }));
    expect(e.code).toBe("AGENT_UNAVAILABLE");
    expect(e.message).toContain("may just be offline");
    expect(e.details).toMatchObject({ captured: true });
  });
});
