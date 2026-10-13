// §5.3: "Receivers MUST refuse a message signed by a revoked agent key."
// The receive path asks the registry about each sender (with a short memo),
// refuses a revoked one with UNAUTHORIZED / agent_key_revoked, lets everyone
// through when the registry cannot answer, and never forgets a key it has seen
// revoked.
import { describe, it, expect, vi } from "vitest";
import { nkeys } from "nats.ws";
import { MeshNode } from "../../src/node.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode } from "../../src/types/errors.js";
import { RevokedSenders } from "../../src/internal/revoked-senders.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import type { SecurityWarning } from "../../src/types/options.js";
import type { Envelope } from "../../src/types/envelope.js";

type Kp = ReturnType<typeof nkeys.createUser>;

/** A connection fake whose registry answers `get` for keys in `revoked` as
 *  revoked, and can be switched to failing. */
function makeConn(revoked: Set<string>) {
  const registryKp = nkeys.createUser();
  const published: { subject: string; data: Uint8Array }[] = [];
  const handlers = new Map<string, (msg: unknown) => void>();
  const state = { registryDown: false, gets: 0 };
  const answer = (req: Envelope, extra: Partial<Parameters<typeof createEnvelope>[0]>) => ({
    data: encode(signEnvelope(createEnvelope({
      type: "respond", from: registryKp.getPublicKey(), to: req.from, in_reply_to: req.id, ...extra,
    } as Parameters<typeof createEnvelope>[0]), registryKp)),
  });
  const conn = {
    published, handlers, state,
    raw: { publish: vi.fn(), jetstreamManager: vi.fn(async () => { throw new Error("no js"); }) },
    publish: vi.fn((subject: string, data: Uint8Array) => published.push({ subject, data })),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      const req = decode(data);
      if (subject.startsWith("mesh.registry.get.")) {
        state.gets++;
        if (state.registryDown) throw new Error("503 no responders");
        const key = subject.slice("mesh.registry.get.".length);
        if (revoked.has(key)) {
          return answer(req, {
            error: {
              code: ErrorCode.UNAUTHORIZED, message: "revoked", retryable: false,
              details: { reason: "agent_key_revoked", revoked_at: "2026-09-27T00:00:00.000Z", replaced_by: "UNEWKEY" },
            },
          });
        }
        return answer(req, { error: { code: ErrorCode.AGENT_UNAVAILABLE, message: "not found", retryable: false } });
      }
      return answer(req, { payload: { status: "registered" } });
    }),
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
      handlers.set(subject, cb);
      return { unsubscribe: () => {}, drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    get isClosed() { return false; },
  };
  return conn;
}

async function setup(revoked: Set<string>, opts?: { refuseRevokedSenders?: boolean }) {
  const conn = makeConn(revoked);
  const warnings: SecurityWarning[] = [];
  const node = MeshNode.withConnection(conn as unknown as ConnectionManager, nkeys.createUser(), undefined, {
    onSecurityWarning: (w) => warnings.push(w),
    ...(opts?.refuseRevokedSenders === false ? { refuseRevokedSenders: false } : {}),
  });
  const agent = node.addAgent();
  const handled: string[] = [];
  agent.onRequest("chat", (_input, ctx) => { handled.push(ctx.envelope.from); return { ok: true }; });
  await agent.register({ name: "receiver" });
  return { conn, agent, handled, warnings };
}

async function send(conn: ReturnType<typeof makeConn>, to: string, sender: Kp): Promise<Envelope[]> {
  const env = signEnvelope(createEnvelope({
    type: "request", from: sender.getPublicKey(), to, payload: { offering: "chat", input: { text: "hi" } },
  }), sender);
  const before = conn.published.length;
  conn.handlers.get(Subjects.agentInbox(to))!({
    data: encode(env), subject: Subjects.agentInbox(to), reply: "_INBOX.x", respond: () => true,
  });
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return conn.published.slice(before)
    .filter((p) => p.subject === Subjects.agentInbox(sender.getPublicKey()))
    .map((p) => decode(p.data));
}

describe("the receive path refuses a revoked sender", () => {
  it("refuses a revoked key with UNAUTHORIZED / agent_key_revoked, and handles a good one", async () => {
    const bad = nkeys.createUser();
    const good = nkeys.createUser();
    const { conn, agent, handled, warnings } = await setup(new Set([bad.getPublicKey()]));

    const refused = await send(conn, agent.id, bad);
    expect(handled).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.error?.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(refused[0]!.error?.details).toMatchObject({ reason: "agent_key_revoked", replaced_by: "UNEWKEY" });
    expect(warnings.some((w) => w.code === "revoked_sender" && w.from === bad.getPublicKey())).toBe(true);

    await send(conn, agent.id, good);
    expect(handled).toEqual([good.getPublicKey()]);
  });

  it("lets a sender through when the registry cannot answer", async () => {
    const sender = nkeys.createUser();
    const { conn, agent, handled } = await setup(new Set());
    conn.state.registryDown = true;
    await send(conn, agent.id, sender);
    expect(handled).toEqual([sender.getPublicKey()]);
  });

  it("keeps refusing a key it has seen revoked after the registry goes quiet", async () => {
    const bad = nkeys.createUser();
    const { conn, agent, handled } = await setup(new Set([bad.getPublicKey()]));
    await send(conn, agent.id, bad);
    conn.state.registryDown = true;
    const again = await send(conn, agent.id, bad);
    expect(handled).toEqual([]);
    expect(again[0]!.error?.details?.reason).toBe("agent_key_revoked");
  });

  it("asks once per sender, not once per message", async () => {
    const sender = nkeys.createUser();
    const { conn, agent } = await setup(new Set());
    await send(conn, agent.id, sender);
    await send(conn, agent.id, sender);
    expect(conn.state.gets).toBe(1);
  });

  it("does nothing when the host turned it off", async () => {
    const bad = nkeys.createUser();
    const { conn, agent, handled } = await setup(new Set([bad.getPublicKey()]), { refuseRevokedSenders: false });
    await send(conn, agent.id, bad);
    expect(handled).toEqual([bad.getPublicKey()]);
    expect(conn.state.gets).toBe(0);
  });
});

describe("RevokedSenders memo", () => {
  it("re-asks about a good key once the short memo runs out, so a new revocation is seen", async () => {
    let t = 0;
    let revoked = false;
    const lookup = vi.fn(async () => (revoked ? { revoked: true as const } : { revoked: false as const }));
    const r = new RevokedSenders(lookup, () => t);
    expect(await r.check("UK")).toBeNull();
    revoked = true;
    expect(await r.check("UK")).toBeNull();
    t += RevokedSenders.OK_MS + 1;
    expect(await r.check("UK")).not.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("refuses a paused sender, and lets it back in within a minute of the resume (the kill switch)", async () => {
    let t = 0;
    let paused = true;
    const lookup = vi.fn(async () => (paused ? { revoked: false as const, paused: true, since: "2026-09-27T10:00:00.000Z" } : { revoked: false as const }));
    const r = new RevokedSenders(lookup, () => t);
    expect(await r.check("UP")).toEqual({ paused: true, since: "2026-09-27T10:00:00.000Z" });
    paused = false;
    // Still remembered as paused inside the memo, then asked again.
    expect((await r.check("UP"))?.paused).toBe(true);
    t += RevokedSenders.OK_MS + 1;
    expect(await r.check("UP")).toBeNull();
  });

  it("treats a lookup that never answers as unknown, after its own timeout", async () => {
    vi.useFakeTimers();
    try {
      const r = new RevokedSenders(() => new Promise(() => {}));
      const p = r.check("UK");
      await vi.advanceTimersByTimeAsync(RevokedSenders.LOOKUP_TIMEOUT_MS + 1);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
