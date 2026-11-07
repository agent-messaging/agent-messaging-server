/**
 * An in-memory broker for the A2A binding tests: several agents on one bus,
 * publishes delivered to every matching subscription (with `*` and `>`), and
 * request-reply to services a test registers. A request to an agent's inbox
 * is delivered like a publish, and its transport reply never comes (the
 * answer travels inbox to inbox, §6.4). A subject nobody listens on answers
 * no-responders, the way the broker does.
 */
import { vi } from "vitest";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import { decodeUnverified, encode } from "../../src/internal/codec.js";
import { MeshError, ErrorCode } from "../../src/types/errors.js";
import type { Envelope } from "../../src/types/envelope.js";

type Handler = (msg: { subject: string; data: Uint8Array; reply?: string; respond: (d: Uint8Array) => boolean }) => void;

function matches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== "*" && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

export interface Bus {
  /** Every publish, in order: subject and decoded envelope. */
  log: { subject: string; env: Envelope }[];
  /** Drop a publish before delivery when this returns true. */
  drop: ((subject: string, env: Envelope) => boolean) | null;
  /** Answer requests on a service subject. Return an envelope (signed by the
   *  service) or throw a MeshError. */
  service(subject: string, fn: (req: Envelope) => Envelope | Promise<Envelope>): void;
  conn(): ConnectionManager;
  agent(kp?: KeyPair, opts?: { encryptionSeed?: string }): AgentMesh;
  /** Publish raw bytes onto the bus, as a misbehaving sender would. */
  publishRaw(subject: string, data: Uint8Array): void;
  close(): Promise<void>;
}

export function makeBus(): Bus {
  const subs: { pattern: string; handler: Handler }[] = [];
  const services = new Map<string, (req: Envelope) => Envelope | Promise<Envelope>>();
  const agents: AgentMesh[] = [];
  const bus: Bus = {
    log: [],
    drop: null,
    service(subject, fn) {
      services.set(subject, fn);
    },
    publishRaw(subject, data) {
      deliver(subject, data);
    },
    conn() {
      const c = {
        publish: vi.fn((subject: string, data: Uint8Array) => deliver(subject, data)),
        request: vi.fn(async (subject: string, data: Uint8Array) => {
          const svc = services.get(subject);
          if (svc) return { data: encode(await svc(decodeUnverified(data))) };
          if (subs.some((s) => matches(s.pattern, subject))) {
            deliver(subject, data);
            return new Promise(() => {});
          }
          throw new MeshError(ErrorCode.TRANSPORT_NO_RESPONDERS, `no responders on ${subject}`);
        }),
        subscribe: vi.fn((subject: string, handler: Handler) => {
          const entry = { pattern: subject, handler };
          subs.push(entry);
          return {
            unsubscribe: () => {
              const i = subs.indexOf(entry);
              if (i >= 0) subs.splice(i, 1);
            },
            drain: async () => {},
          };
        }),
        drain: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        raw: { publish: () => {} },
        isClosed: false,
        maxPayload: 1024 * 1024,
      };
      return c as unknown as ConnectionManager;
    },
    agent(kp, opts) {
      const k = kp ?? nkeys.createUser();
      const a = AgentMesh.withConnection(bus.conn(), k, k, opts?.encryptionSeed ? { encryptionSeed: opts.encryptionSeed } : undefined);
      agents.push(a);
      return a;
    },
    async close() {
      for (const a of agents.splice(0)) await a.close().catch(() => undefined);
    },
  };
  function deliver(subject: string, data: Uint8Array): void {
    let env: Envelope | null = null;
    try {
      env = decodeUnverified(data);
    } catch {
      /* raw bytes */
    }
    if (env) {
      if (bus.drop?.(subject, env)) return;
      bus.log.push({ subject, env });
    }
    for (const s of [...subs]) {
      if (!matches(s.pattern, subject)) continue;
      setTimeout(() => s.handler({ subject, data, reply: undefined, respond: () => true }), 0);
    }
  }
  return bus;
}

export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
