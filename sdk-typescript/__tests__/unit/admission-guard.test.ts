// EXT-6 §7.1, the guard handshake. A guarded agent listens ONLY on
// `mesh.agent.<id>.inbox.guarded`, and nothing relays to that subject unless
// the admission service is really guarding the agent — so believing a guard
// that did not happen makes the agent silently unreachable while it looks
// healthy. Hence the rule these tests pin down: only an explicit `ok` counts,
// and every other outcome leaves the agent on its public inbox.
import { describe, it, expect, vi } from "vitest";
import { nkeys } from "nats.ws";
import { MeshNode } from "../../src/node.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode } from "../../src/internal/codec.js";
import { MeshError, ErrorCode } from "../../src/types/errors.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { ConnectionManager } from "../../src/internal/connection.js";

/** How the fake admission service answers a guard request. Returning `null` is
 *  the service's documented refusal: it says nothing at all and the request
 *  times out. */
type GuardReply = (req: Envelope, admission: ReturnType<typeof nkeys.createUser>) => Envelope | null;

function makeConn(guardReply: GuardReply) {
  const subscribed: string[] = [];
  const registryKp = nkeys.createUser();
  const admissionKp = nkeys.createUser();
  const conn = {
    subscribed,
    admissionKp,
    publish: vi.fn(),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      const req = decode(data);
      if (subject === "mesh.admission.guard") {
        const reply = guardReply(req, admissionKp);
        if (!reply) {
          throw new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "no answer from the admission service");
        }
        return { data: encode(reply) };
      }
      // The registry: signed and bound to the request, like the real one.
      return {
        data: encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: registryKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload: { status: "registered" },
            }),
            registryKp,
          ),
        ),
      };
    }),
    subscribe: vi.fn((subject: string) => {
      subscribed.push(subject);
      return { unsubscribe: () => {}, drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    get isClosed() {
      return false;
    },
  };
  return conn;
}

/** Register one agent asking to be guarded, and report which inbox it ended up
 *  listening on. */
async function inboxAfterGuard(guardReply: GuardReply) {
  const conn = makeConn(guardReply);
  const node = MeshNode.withConnection(conn as unknown as ConnectionManager, nkeys.createUser());
  const agent = node.addAgent();
  await agent.register({ name: "guard-me", guarded: true });
  const inbox = conn.subscribed.find((s) => s.startsWith(`mesh.agent.${agent.id}.inbox`));
  return { agent, conn, inbox, guarded: inbox?.endsWith(".guarded") ?? false };
}

/** The ack the admission service actually sends on a successful guard:
 *  signed, bound to the request, `output.ok` true. */
const okAck: GuardReply = (req, admission) =>
  signEnvelope(
    createEnvelope({
      type: "respond",
      from: admission.getPublicKey(),
      to: req.from,
      in_reply_to: req.id,
      payload: { output: { ok: true, guarded: true } },
    }),
    admission,
  );

describe("register({ guarded: true }) — EXT-6 §7.1", () => {
  it("switches to the guarded inbox on an explicit ok", async () => {
    const { agent, inbox, guarded } = await inboxAfterGuard(okAck);
    expect(inbox).toBe(`mesh.agent.${agent.id}.inbox.guarded`);
    expect(guarded).toBe(true);
  });

  it("stays on the public inbox when the guard request is RATE_LIMITED", async () => {
    // The real path that made this a live defect: every service subject,
    // including this one, is wrapped in the shared rate limiter, which answers
    // over the limit with an error envelope — bound, signed, and emphatically
    // not an ack. Reading it as one unsubscribed the agent from the only inbox
    // anyone was writing to.
    const { agent, inbox, guarded } = await inboxAfterGuard((req, admission) =>
      signEnvelope(
        createEnvelope({
          type: "respond",
          from: admission.getPublicKey(),
          to: req.from,
          in_reply_to: req.id,
          error: {
            code: ErrorCode.RATE_LIMITED,
            message: "Rate limit exceeded. Try again in 42000ms.",
            retryable: true,
          },
        }),
        admission,
      ),
    );
    expect(inbox).toBe(`mesh.agent.${agent.id}.inbox`);
    expect(guarded).toBe(false);
    // Registration itself succeeded; only the guard did not.
    expect(agent.registered).toBe(true);
  });

  it("stays on the public inbox when the service says nothing", async () => {
    // The service's documented refusal (unregistered agent, guard ceiling) is
    // silence, so silence and an error must land in the same place.
    const { agent, inbox } = await inboxAfterGuard(() => null);
    expect(inbox).toBe(`mesh.agent.${agent.id}.inbox`);
  });

  it("refuses an ok that does not answer this request", async () => {
    // A perfect-looking ack from a real key with no `in_reply_to`: what anyone
    // able to publish into the reply inbox can race in. Accepting it would make
    // "silence that agent" a one-message trick.
    const { agent, inbox } = await inboxAfterGuard((req, admission) =>
      signEnvelope(
        createEnvelope({
          type: "respond",
          from: admission.getPublicKey(),
          to: req.from,
          payload: { output: { ok: true, guarded: true } },
        }),
        admission,
      ),
    );
    expect(inbox).toBe(`mesh.agent.${agent.id}.inbox`);
  });

  it("refuses an ok addressed to somebody else", async () => {
    const { agent, inbox } = await inboxAfterGuard((req, admission) =>
      signEnvelope(
        createEnvelope({
          type: "respond",
          from: admission.getPublicKey(),
          to: nkeys.createUser().getPublicKey(),
          in_reply_to: req.id,
          payload: { output: { ok: true, guarded: true } },
        }),
        admission,
      ),
    );
    expect(inbox).toBe(`mesh.agent.${agent.id}.inbox`);
  });

  it("refuses an unsigned ok", async () => {
    const { agent, inbox } = await inboxAfterGuard((req, admission) =>
      createEnvelope({
        type: "respond",
        from: admission.getPublicKey(),
        to: req.from,
        in_reply_to: req.id,
        payload: { output: { ok: true, guarded: true } },
      }),
    );
    expect(inbox).toBe(`mesh.agent.${agent.id}.inbox`);
  });

  it("refuses a reply that is not an ok at all", async () => {
    // The benign delivery receipt the service gives a SENDER whose message was
    // dropped. It is a reply, and it is not permission to leave the inbox.
    const { agent, inbox } = await inboxAfterGuard((req, admission) =>
      signEnvelope(
        createEnvelope({
          type: "respond",
          from: admission.getPublicKey(),
          to: req.from,
          in_reply_to: req.id,
          payload: { output: { queued: true, inbox_id: "01912f0e-0000-7000-8000-000000000000" } },
        }),
        admission,
      ),
    );
    expect(inbox).toBe(`mesh.agent.${agent.id}.inbox`);
  });

  it("refuses an ok that says it is NOT guarding (the unguard shape)", async () => {
    const { agent, inbox } = await inboxAfterGuard((req, admission) =>
      signEnvelope(
        createEnvelope({
          type: "respond",
          from: admission.getPublicKey(),
          to: req.from,
          in_reply_to: req.id,
          payload: { output: { ok: true, guarded: false } },
        }),
        admission,
      ),
    );
    expect(inbox).toBe(`mesh.agent.${agent.id}.inbox`);
  });

  it("sends an empty, signed guard request from the agent's own key", async () => {
    // §7.1: the service derives the inbox from the verified `from`, so the
    // payload carries nothing — there is no way to ask it to guard another
    // agent's inbox.
    const { agent, conn } = await inboxAfterGuard(okAck);
    const call = conn.request.mock.calls.find((c) => c[0] === "mesh.admission.guard");
    expect(call).toBeDefined();
    const req = decode(call![1] as Uint8Array);
    expect(req.from).toBe(agent.id);
    expect(req.payload).toEqual({});
  });

  it("does not ask to be guarded unless the caller asked for it", async () => {
    const conn = makeConn(okAck);
    const node = MeshNode.withConnection(conn as unknown as ConnectionManager, nkeys.createUser());
    const agent = node.addAgent();
    await agent.register({ name: "plain" });
    expect(conn.request.mock.calls.some((c) => c[0] === "mesh.admission.guard")).toBe(false);
    expect(conn.subscribed).toContain(`mesh.agent.${agent.id}.inbox`);
  });
});

// The other half of the handshake, and the fix for safety item 4.4. Guard state
// used to be write-only: nothing ever revoked an entry, so an agent guarded on
// one boot and refused on the next listened on its PUBLIC inbox while the mesh
// still held an entry saying otherwise — admission relaying its mail to a private
// subject nobody serves, its offline mailbox pointed at that same subject, and
// every message that did arrive reaching the handler with no filter at all. Only
// the agent knows the subscription is not there, so only the agent can say so.
describe("register({ guarded: true }) — revoking a guard the agent does not hold", () => {
  /** The unguard messages published on this connection, decoded — which also
   *  proves they were signed, since decode() verifies. */
  function unguards(conn: ReturnType<typeof makeConn>): Envelope[] {
    return conn.publish.mock.calls
      .filter((c) => c[0] === "mesh.admission.unguard")
      .map((c) => decode(c[1] as Uint8Array));
  }

  it("revokes when the guard request is RATE_LIMITED", async () => {
    const { agent, conn, inbox } = await inboxAfterGuard((req, admission) =>
      signEnvelope(
        createEnvelope({
          type: "respond",
          from: admission.getPublicKey(),
          to: req.from,
          in_reply_to: req.id,
          error: {
            code: ErrorCode.RATE_LIMITED,
            message: "Rate limit exceeded. Try again in 42000ms.",
            retryable: true,
          },
        }),
        admission,
      ),
    );
    expect(inbox).toBe(`mesh.agent.${agent.id}.inbox`);
    const sent = unguards(conn);
    expect(sent).toHaveLength(1);
    // Same shape as the guard request: signed by the agent's own key, empty
    // payload. The service derives the inbox from the verified `from`, so there
    // is no way to unguard anybody else.
    expect(sent[0].from).toBe(agent.id);
    expect(sent[0].payload).toEqual({});
  });

  it("revokes when the service says nothing at all", async () => {
    // Silence is the service's documented refusal (unregistered agent, guard
    // ceiling) — and it is also what a timeout or a missing admission service
    // looks like. In every one of those the agent is on its public inbox, so a
    // leftover entry has to go.
    const { conn } = await inboxAfterGuard(() => null);
    expect(unguards(conn)).toHaveLength(1);
  });

  it("revokes when the reply is the benign queued receipt rather than an ok", async () => {
    const { conn } = await inboxAfterGuard((req, admission) =>
      signEnvelope(
        createEnvelope({
          type: "respond",
          from: admission.getPublicKey(),
          to: req.from,
          in_reply_to: req.id,
          payload: { output: { queued: true, inbox_id: "01912f0e-0000-7000-8000-000000000000" } },
        }),
        admission,
      ),
    );
    expect(unguards(conn)).toHaveLength(1);
  });

  it("revokes when the ok does not answer this request", async () => {
    const { conn } = await inboxAfterGuard((req, admission) =>
      signEnvelope(
        createEnvelope({
          type: "respond",
          from: admission.getPublicKey(),
          to: req.from,
          payload: { output: { ok: true, guarded: true } },
        }),
        admission,
      ),
    );
    expect(unguards(conn)).toHaveLength(1);
  });

  it("does NOT revoke when the guard succeeded", async () => {
    const { agent, conn, inbox } = await inboxAfterGuard(okAck);
    expect(inbox).toBe(`mesh.agent.${agent.id}.inbox.guarded`);
    expect(unguards(conn)).toHaveLength(0);
  });

  it("does NOT revoke when the caller never asked to be guarded", async () => {
    // The condition matters: unguard on every registration would be a needless
    // message from every agent on the mesh, and this agent has no reason to
    // believe an entry exists for it.
    const conn = makeConn(okAck);
    const node = MeshNode.withConnection(conn as unknown as ConnectionManager, nkeys.createUser());
    const agent = node.addAgent();
    await agent.register({ name: "plain" });
    expect(conn.request.mock.calls.some((c) => c[0] === "mesh.admission.guard")).toBe(false);
    expect(unguards(conn)).toHaveLength(0);
    expect(conn.subscribed).toContain(`mesh.agent.${agent.id}.inbox`);
  });

  it("does NOT revoke while the live subscription is still on the guarded subject", async () => {
    // The one case where a refusal must NOT revoke. `listenInbox` does not
    // re-point a subscription that already exists, so after a successful guard
    // followed by a refused re-registration the agent is STILL listening only on
    // `.guarded` — and revoking there would strand it on a subject nobody relays
    // to, which is the exact failure the guard handshake is careful about.
    let reply: GuardReply = okAck;
    const conn = makeConn((req, admission) => reply(req, admission));
    const node = MeshNode.withConnection(conn as unknown as ConnectionManager, nkeys.createUser());
    const agent = node.addAgent();
    await agent.register({ name: "guard-me", guarded: true });
    expect(conn.subscribed).toContain(`mesh.agent.${agent.id}.inbox.guarded`);

    reply = () => null;
    await agent.register({ name: "guard-me", guarded: true });
    expect(unguards(conn)).toHaveLength(0);
    expect(conn.subscribed).not.toContain(`mesh.agent.${agent.id}.inbox`);
  });

  it("sends nothing else on the admission subjects than the one unguard", async () => {
    // A revocation is a publish, not a request: there is nothing to learn from
    // the answer, and a request would spend the SDK's timeout on every mesh with
    // no admission service deployed.
    const { conn } = await inboxAfterGuard(() => null);
    expect(conn.request.mock.calls.filter((c) => c[0] === "mesh.admission.unguard")).toHaveLength(0);
    expect(conn.publish.mock.calls.filter((c) => c[0] === "mesh.admission.guard")).toHaveLength(0);
  });
});
