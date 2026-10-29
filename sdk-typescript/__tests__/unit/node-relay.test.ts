/**
 * MeshNode.relayEnvelope and watchEnvelopes: a gateway passes an envelope
 * another key signed through to the mesh unchanged, and reads the answers at
 * an inbox it does not host (the A2A Bridge's Agent Messaging over A2A).
 */
import { describe, it, expect, vi } from "vitest";
import { nkeys } from "nats.ws";
import { MeshNode } from "../../src/node.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import type { Envelope } from "../../src/types/envelope.js";

function fakeConn() {
  const published: Array<{ subject: string; data: Uint8Array }> = [];
  const handlers = new Map<string, (m: { data: Uint8Array }) => void>();
  let unsubscribed = 0;
  return {
    published,
    handlers,
    get unsubscribed() {
      return unsubscribed;
    },
    publish: vi.fn((subject: string, data: Uint8Array) => published.push({ subject, data })),
    subscribe: vi.fn((subject: string, handler: (m: { data: Uint8Array }) => void) => {
      handlers.set(subject, handler);
      return { unsubscribe: () => void unsubscribed++ };
    }),
  };
}

const caller = nkeys.createUser();
const agent = nkeys.createUser();

function node(conn: ReturnType<typeof fakeConn>): MeshNode {
  return MeshNode.withConnection(conn as unknown as ConnectionManager, nkeys.createUser());
}

describe("MeshNode relay", () => {
  it("publishes a verified envelope unchanged to its addressee's inbox", () => {
    const conn = fakeConn();
    const env = signEnvelope(createEnvelope({ type: "request", from: caller.getPublicKey(), to: agent.getPublicKey(), payload: { offering: "echo", input: {} } }), caller);
    node(conn).relayEnvelope(env);
    expect(conn.published).toHaveLength(1);
    expect(conn.published[0].subject).toBe(Subjects.agentInbox(agent.getPublicKey()));
    expect(decode(conn.published[0].data)).toEqual(env);
  });

  it("refuses an envelope whose signature does not verify, and one with no addressee", () => {
    const conn = fakeConn();
    const env = signEnvelope(createEnvelope({ type: "request", from: caller.getPublicKey(), to: agent.getPublicKey(), payload: { offering: "echo", input: { n: 1 } } }), caller);
    expect(() => node(conn).relayEnvelope({ ...env, payload: { offering: "echo", input: { n: 2 } } })).toThrow(/signature/);
    const noTo = signEnvelope(createEnvelope({ type: "request", from: caller.getPublicKey(), payload: {} }), caller);
    expect(() => node(conn).relayEnvelope(noTo)).toThrow(/addressee/);
    expect(conn.published).toHaveLength(0);
  });

  it("hands only verified envelopes to a watch, and stops on request", () => {
    const conn = fakeConn();
    const seen: Envelope[] = [];
    const stop = node(conn).watchEnvelopes(Subjects.agentInbox(caller.getPublicKey()), (e) => seen.push(e));
    const h = conn.handlers.get(Subjects.agentInbox(caller.getPublicKey()))!;
    const good = signEnvelope(createEnvelope({ type: "respond", from: agent.getPublicKey(), to: caller.getPublicKey(), in_reply_to: "x", payload: { status: "completed" } }), agent);
    h({ data: encode(good) });
    h({ data: encode({ ...good, payload: { status: "failed" } }) });
    h({ data: new TextEncoder().encode("not json") });
    expect(seen).toEqual([good]);
    stop();
    expect(conn.unsubscribed).toBe(1);
  });
});
