// On the RabbitMQ binding, register() resolves once the agent's inbox is in
// place (docs/rabbitmq-binding.md §6.1).
//
// Nothing keeps a message published on an agent's inbox subject except a queue
// bound to it: the agent's mailbox queue, consumed by its node, or, where there
// is no mailbox, the node's live subscription. Both are set up after the
// registry answers, and register() used to resolve without waiting for either.
// A sender that asked the moment register() returned could find the mailbox
// with nobody reading it (until the node's next pass, a minute later) or no
// queue at all. What these pin: register() waits for the mailbox consumer to
// attach, or, with no mailbox, for the live subscription to be bound.
//
// Against a fake AMQP connection, because what needs pinning is the order in
// which register() waits, not the broker.
import { describe, expect, it, vi } from "vitest";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { decode, encode } from "../../src/internal/codec.js";
import type { ConnectionManager } from "../../src/internal/connection.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** An AMQP-shaped connection: the registry answers, the mailbox exists or not,
 *  and the mailbox consumer and the live subscription's binding finish only
 *  when the test says so. */
function amqpConn(opts: { mailbox: boolean }) {
  const registryKp = nkeys.createUser();
  const consumerAttached = deferred();
  const subscriptionBound = deferred();
  const conn = {
    binding: "amqp" as const,
    maxPayload: 1_048_576,
    subscribed: [] as string[],
    consumed: [] as string[],
    publish: vi.fn(),
    request: vi.fn(async (_subject: string, data: Uint8Array) => {
      const req = decode(data);
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
      conn.subscribed.push(subject);
      return { unsubscribe: () => {}, drain: async () => {} };
    }),
    queueExists: vi.fn(async () => opts.mailbox),
    consume: vi.fn(async (queue: string) => {
      await consumerAttached.promise;
      conn.consumed.push(queue);
      return {
        stop: () => {},
        async *[Symbol.asyncIterator]() {
          /* nothing waits */
        },
      };
    }),
    // Resolves once everything asked of the connection so far is done, the
    // live subscription's binding included.
    flush: vi.fn(() => subscriptionBound.promise),
    onReconnect: vi.fn(() => () => {}),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    get isClosed() {
      return false;
    },
  };
  return { conn, consumerAttached, subscriptionBound };
}

async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
  return done;
}

function agentOver(conn: unknown): AgentMesh {
  return AgentMesh.withConnection(conn as ConnectionManager, nkeys.createUser(), nkeys.createUser());
}

describe("register() on an AMQP mesh resolves once the inbox is in place", () => {
  it("waits for the mailbox consumer to attach", async () => {
    const { conn, consumerAttached, subscriptionBound } = amqpConn({ mailbox: true });
    subscriptionBound.resolve();
    const agent = agentOver(conn);
    const registering = agent.register({ name: "ready-agent" });

    expect(await settled(registering)).toBe(false);
    expect(conn.queueExists).toHaveBeenCalledWith(`MESH_INBOX_${agent.id}`);

    consumerAttached.resolve();
    await registering;
    expect(conn.consumed).toEqual([`MESH_INBOX_${agent.id}`]);
    await agent.close();
  });

  it("with no mailbox, waits for the live subscription to be bound", async () => {
    const { conn, consumerAttached, subscriptionBound } = amqpConn({ mailbox: false });
    consumerAttached.resolve();
    const agent = agentOver(conn);
    const registering = agent.register({ name: "live-only-agent" });

    expect(await settled(registering)).toBe(false);
    expect(conn.subscribed).toContain(`mesh.agent.${agent.id}.inbox`);

    subscriptionBound.resolve();
    await registering;
    expect(conn.consume).not.toHaveBeenCalled();
    await agent.close();
  });
});
