/**
 * Test seams. The bridge's mesh side needs a live NATS connection, which none
 * of these tests want; everything under test here is admission, addressing and
 * startup order, all of which happen before any mesh work.
 */
import { fromSeed } from "nkeys.js";
import type { Bridge } from "../src/bridge.js";
import type { Manifest } from "../../sdk-typescript/src/types/manifest.js";
import { currentTrace } from "../../sdk-typescript/src/internal/trace-ambient.js";

export interface FakeCourier {
  discover: (opts?: unknown) => Promise<{ agents: Manifest[]; total: number }>;
  getManifest: (id: string) => Promise<Manifest>;
}

/** A manifest a fake caller identity "registered", captured so a test can
 *  assert the §2.1 rule 2 marker without a registry. */
export interface FakeRegistration {
  agentId: string;
  opts: { extensions?: Array<{ uri: string }>; meta?: Record<string, unknown>; visibility?: string };
}

/** One mesh request a hosted caller identity sent, with the config it carried —
 *  which is where the §8.3 attribution marker rides. */
export interface FakeRequest {
  from: string;
  to: string;
  offering: string;
  input: unknown;
  config?: { meta?: Record<string, unknown>; context_id?: string; timeout_ms?: number };
  /** The ambient trace at the moment the request was made. `createEnvelope`
   *  reads exactly this when no explicit trace is passed, so capturing it here
   *  is what proves an inbound `traceparent` reached the mesh side. */
  trace?: { trace_id: string; span_id: string; parent_span_id?: string | null; tracestate?: string };
}

export interface FakeMesh {
  mintedAgentIds: string[];
  /** Every `register()` a hosted agent made, in order. */
  registrations: FakeRegistration[];
  /** Agent ids that were deregistered (eviction, sweep). */
  deregistered: string[];
  /** Every `request()` a hosted agent sent, in order. */
  requests: FakeRequest[];
  /** Set to decide what a hosted agent's `request()` returns or throws;
   *  unset, every request completes at once with `{ ok: true }`. */
  answer?: (req: FakeRequest) => unknown;
  /** The default handler each hosted identity registered, by agent id: the
   *  seam a test uses to deliver a late reply to a caller identity. */
  defaultHandlers: Map<string, (input: unknown, ctx: unknown) => unknown>;
  /** Envelopes the node relayed unchanged (Agent Messaging over A2A, §16). */
  relayed: Array<Record<string, unknown>>;
  /** Live watches by subject (MeshNode.watchEnvelopes). */
  watchers: Map<string, Array<(env: unknown) => void>>;
  /** Hand a verified envelope to every watch on a subject. */
  deliver: (subject: string, env: unknown) => void;
  /** The person surface each hosted identity registered, by agent id. */
  personHandlers: Map<string, (m: unknown) => void>;
  /** Every sendToPerson a hosted identity made. */
  personSends: Array<{ from: string; to: string; text: string; opts?: unknown }>;
  /** Set to decide what sendToPerson returns; unset, `queued`. */
  personAnswer?: (send: { from: string; to: string; text: string }) => unknown;
}

/** Put a Bridge into the "connected" state with a stub node and courier, so the
 *  HTTP surface can be exercised without a mesh. Reaches past `private` on
 *  purpose: the alternative is a production-only test hook.
 *
 *  The stub honours `nkeySeed` through the REAL nkeys derivation, so a test
 *  that persists a seed and reads it back in a fresh Bridge proves the actual
 *  property — the same seed yields the same mesh public key — rather than
 *  proving that a fake remembered a string. */
export function fakeConnect(
  bridge: Bridge,
  courier: FakeCourier = {
    discover: async () => ({ agents: [], total: 0 }),
    getManifest: async () => {
      throw new Error("no such agent");
    },
  },
): FakeMesh {
  const watchers = new Map<string, Array<(env: unknown) => void>>();
  const mesh: FakeMesh = {
    mintedAgentIds: [],
    registrations: [],
    deregistered: [],
    requests: [],
    defaultHandlers: new Map(),
    relayed: [],
    watchers,
    deliver: (subject, env) => {
      for (const h of [...(watchers.get(subject) ?? [])]) h(env);
    },
    personHandlers: new Map(),
    personSends: [],
  };
  let n = 0;
  const internals = bridge as unknown as { node: unknown; courier: unknown };
  internals.node = {
    id: "UNODEFAKEFAKEFAKEFAKE",
    addAgent: (opts?: { nkeySeed?: string }) => {
      const id = opts?.nkeySeed
        ? fromSeed(new TextEncoder().encode(opts.nkeySeed)).getPublicKey()
        : `UAGENTFAKE${(n++).toString().padStart(10, "0")}`;
      mesh.mintedAgentIds.push(id);
      return {
        id,
        request: async (to: string, offering: string, input: unknown, config?: FakeRequest["config"]) => {
          const req: FakeRequest = { from: id, to, offering, input, config, trace: currentTrace() };
          mesh.requests.push(req);
          if (mesh.answer) return await mesh.answer(req);
          // A bare terminal response (§4.3): the shape the inbound mapping
          // takes when the responder finished the work immediately.
          return {
            task_id: null,
            payload: { status: "completed", output: { ok: true } },
            envelope: { id: "envelope-fake" },
          };
        },
        onDefault: (handler: (input: unknown, ctx: unknown) => unknown) => {
          mesh.defaultHandlers.set(id, handler);
        },
        onPersonMessage: (handler: (m: unknown) => void) => {
          mesh.personHandlers.set(id, handler);
        },
        sendToPerson: async (to: string, text: string, opts?: unknown) => {
          mesh.personSends.push({ from: id, to, text, opts });
          if (mesh.personAnswer) return await mesh.personAnswer({ from: id, to, text });
          return { outcome: "queued", request_id: `person-${mesh.personSends.length}`, inbox_id: "inbox-1" };
        },
        register: async (opts: FakeRegistration["opts"]) => {
          mesh.registrations.push({ agentId: id, opts });
          return {};
        },
        deregister: async () => {
          mesh.deregistered.push(id);
        },
      };
    },
    removeAgent: async () => true,
    relayEnvelope: (env: Record<string, unknown>) => {
      mesh.relayed.push(env);
    },
    watchEnvelopes: (subject: string, handler: (env: unknown) => void) => {
      const list = watchers.get(subject) ?? [];
      list.push(handler);
      watchers.set(subject, list);
      return () => {
        const now = watchers.get(subject) ?? [];
        watchers.set(subject, now.filter((h) => h !== handler));
      };
    },
    drain: async () => undefined,
    startHeartbeat: () => undefined,
  };
  internals.courier = courier;
  return mesh;
}

export function manifestFixture(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: "UAGENTPUBKEY",
    name: "Echo",
    description: "Echoes input",
    version: "1.0.0",
    protocol_version: "0.2",
    endpoint: "mesh.agent.UAGENTPUBKEY.inbox",
    node: {
      id: "UNODE",
      attestation: { node: "UNODE", agent: "UAGENTPUBKEY", issued_at: "", expires_at: "", sig: "" },
    },
    capabilities: ["echo"],
    offerings: [{ id: "echo", name: "Echo", description: "Returns input" }],
    // Opened to outside callers: the gateway scheme in the access
    // declaration is what the door projects when its a2a tier is allow.
    public: { access: { schemes: [{ id: "a2a-gateway", transport: "http", type: "apiKey", in: "header", name: "Authorization" }] } } as never,
    ...overrides,
  };
}

/** A JSON-RPC SendMessage body, as a stock A2A client would send it. */
export function sendMessageBody(text = "hello"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "SendMessage",
    params: { message: { role: "ROLE_USER", parts: [{ text }] } },
  });
}
