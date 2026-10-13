// Vouch renewal (§4.4).
//
// An agent is on the mesh because a node vouched for it, and the vouch expires.
// The registry treats that expiry as real at BOTH ends of the lifecycle: it
// refuses an expired attestation at register (§9.7,
// server/src/registry/handlers/register.ts) and its reaper reclaims a
// registration whose attestation has lapsed (server/src/registry/reaper.ts,
// rule 2). Nothing used to re-mint it, so a process that registered once and
// stayed up simply stopped being discoverable at the 30-day mark — still
// running, still heartbeating, silently gone from discovery.
//
// These tests pin the fix: the vouch is renewed well before it expires, in both
// the standalone and node-hosted shapes; the loop is torn down with the agent;
// and a failed renewal is visible and retried instead of lost.
//
// The TTLs here are milliseconds rather than days, on a fake clock. Everything
// downstream (the renewal deadline, the check cadence) is derived from the TTL,
// so a 600ms vouch exercises exactly the same arithmetic as a 30-day one — and
// on a fake clock the timings are exact rather than jittery.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { MeshNode } from "../../src/node.js";
import type { Manifest } from "../../src/types/manifest.js";
import type { SecurityWarning } from "../../src/types/options.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope, verifyAttestation, verifyManifestSignature } from "../../src/internal/identity.js";
import { encode, decode } from "../../src/internal/codec.js";
import { setUnrefInterval } from "../../src/internal/timers.js";
import { vouchRenewAt, vouchCheckIntervalMs } from "../../src/internal/vouch.js";
import {
  DEFAULT_VOUCH_TTL_MS,
  MAX_VOUCH_CHECK_INTERVAL_MS,
  VOUCH_RENEWAL_FRACTION,
} from "../../src/constants.js";
import type { ConnectionManager } from "../../src/internal/connection.js";

/** A short vouch: renewal due at 400ms, expiry at 600ms, checks every 50ms. */
const TTL = 600;
const REGISTER = "mesh.registry.register";

/**
 * Fake registry over a duck-typed ConnectionManager. Answers `register` the way
 * the real one does — signed by a stable service key and bound to the request
 * (`to` + `in_reply_to`, §6.2) — because the SDK refuses anything else.
 */
function makeConn() {
  const registryKp = nkeys.createUser();
  const admissionKp = nkeys.createUser();
  /** Every accepted register/renewal, with the manifest and the clock. */
  const registers: Array<{ manifest: Manifest; at: number }> = [];
  const guardCalls: number[] = [];

  const bound = (req: { id: string; from: string }, extra: Record<string, unknown>) => ({
    data: encode(
      signEnvelope(
        createEnvelope({
          type: "respond",
          from: registryKp.getPublicKey(),
          to: req.from,
          in_reply_to: req.id,
          ...extra,
        }),
        registryKp,
      ),
    ),
  });

  const conn = {
    registryKp,
    admissionKp,
    registers,
    guardCalls,
    /** Refuse the next N registers the way handleRegister refuses: a bound
     *  error envelope. */
    failNextRegisters: 0,
    publish: vi.fn(),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      const req = decode(data);
      if (subject === "mesh.admission.guard") {
        guardCalls.push(Date.now());
        return {
          data: encode(
            signEnvelope(
              createEnvelope({
                type: "respond",
                from: admissionKp.getPublicKey(),
                to: req.from,
                in_reply_to: req.id,
                payload: { output: { ok: true, guarded: true } },
              }),
              admissionKp,
            ),
          ),
        };
      }
      if (subject === REGISTER) {
        if (conn.failNextRegisters > 0) {
          conn.failNextRegisters--;
          return bound(req, {
            error: { code: "RATE_LIMITED", message: "too many registrations", retryable: true },
          });
        }
        registers.push({ manifest: req.payload as Manifest, at: Date.now() });
      }
      return bound(req, { payload: { status: "registered" } });
    }),
    subscribe: vi.fn(() => ({ unsubscribe: () => {}, drain: async () => {} })),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    get isClosed() {
      return false;
    },
  };
  return conn;
}

type FakeConn = ReturnType<typeof makeConn>;
const asConn = (c: FakeConn) => c as unknown as ConnectionManager;

/** A standalone agent (its own connection, its own node key) on a fake mesh. */
function standalone(conn: FakeConn, onSecurityWarning?: (w: SecurityWarning) => void) {
  const agentKp = nkeys.createUser();
  const nodeKp = nkeys.createUser();
  const agent = AgentMesh.withConnection(asConn(conn), agentKp, nodeKp, {
    vouchTtlMs: TTL,
    onSecurityWarning,
  });
  return { agent, nodeKp };
}

function hostedNode(conn: FakeConn, onSecurityWarning?: (w: SecurityWarning) => void) {
  const nodeKp = nkeys.createUser();
  const node = MeshNode.withConnection(asConn(conn), nodeKp, undefined, {
    vouchTtlMs: TTL,
    onSecurityWarning,
  });
  return { node, nodeKp };
}

describe("renewal arithmetic", () => {
  it("renews two thirds of the way through the vouch's own lifetime", () => {
    const issued = Date.parse("2026-07-25T00:00:00.000Z");
    const ttl = 30 * 24 * 3_600_000;
    const at = vouchRenewAt({
      issued_at: new Date(issued).toISOString(),
      expires_at: new Date(issued + ttl).toISOString(),
    });
    // 20 days in, 10 days of runway left to retry in.
    expect((at! - issued) / (24 * 3_600_000)).toBeCloseTo(20, 6);
    expect(at!).toBeLessThan(issued + ttl);
  });

  it("derives the deadline from the attestation, not from the configured TTL", () => {
    // A vouch minted elsewhere (another SDK, a shorter operator policy) still
    // gets a proportionate deadline.
    const issued = Date.parse("2026-07-25T00:00:00.000Z");
    const at = vouchRenewAt({
      issued_at: new Date(issued).toISOString(),
      expires_at: new Date(issued + 3_000).toISOString(),
    });
    expect(at).toBeCloseTo(issued + 2_000, 6);
  });

  it("has no deadline for an unusable window", () => {
    expect(vouchRenewAt({ issued_at: "", expires_at: "" })).toBeNull();
    expect(vouchRenewAt({ issued_at: "nonsense", expires_at: "also nonsense" })).toBeNull();
    // Already inverted: nothing sane to schedule.
    expect(
      vouchRenewAt({ issued_at: "2026-07-25T00:00:10Z", expires_at: "2026-07-25T00:00:00Z" }),
    ).toBeNull();
  });

  it("checks hourly for the 30-day default, and proportionally for a short TTL", () => {
    expect(vouchCheckIntervalMs(DEFAULT_VOUCH_TTL_MS)).toBe(MAX_VOUCH_CHECK_INTERVAL_MS);
    expect(vouchCheckIntervalMs(TTL)).toBe(50); // four checks inside the last third
    expect(vouchCheckIntervalMs(1)).toBeGreaterThan(0); // never a zero-delay spin
  });
});

describe("the renewal loop does not hold the process open", () => {
  it("unrefs its timer", () => {
    const t = setUnrefInterval(() => {}, 1_000) as unknown as { hasRef?: () => boolean };
    // Node exposes hasRef(); a browser handle is a number and has nothing to hold.
    if (typeof t.hasRef === "function") expect(t.hasRef()).toBe(false);
    clearInterval(t as unknown as ReturnType<typeof setInterval>);
  });
});

// ── everything below runs on a fake clock ───────────────────────────────────
describe("vouch renewal on the clock", () => {
  /** Move the fake clock, letting the timer callbacks (and their awaits) run. */
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("standalone agent: renews its own vouch (§4.4)", () => {
    it("re-registers with a fresh vouch BEFORE the first one expires", async () => {
      const conn = makeConn();
      const { agent, nodeKp } = standalone(conn);
      const t0 = Date.now();
      await agent.register({ name: "long-lived" });

      expect(conn.registers).toHaveLength(1);
      const first = conn.registers[0].manifest.node.attestation;
      const firstExpiry = Date.parse(first.expires_at);
      expect(firstExpiry).toBe(t0 + TTL);

      await advance(TTL * 0.85); // past the 2/3 deadline, still inside the TTL
      await agent.close();

      expect(conn.registers).toHaveLength(2);
      const renewal = conn.registers[1];
      // The renewal happened while the ORIGINAL vouch was still valid. That is
      // the whole point: the registry refuses an expired attestation (§9.7), so
      // a renewal that arrives late cannot register at all.
      expect(renewal.at).toBeLessThan(firstExpiry);
      expect(renewal.at - t0).toBeGreaterThanOrEqual(TTL * VOUCH_RENEWAL_FRACTION - 50);

      // A genuinely fresh, valid vouch — signed by the NODE key, binding THIS
      // agent, expiring later than the one it replaces.
      const att = renewal.manifest.node.attestation;
      expect(att.node).toBe(nodeKp.getPublicKey());
      expect(att.agent).toBe(agent.id);
      expect(verifyAttestation(att, agent.id)).toBe(true);
      expect(Date.parse(att.expires_at)).toBeGreaterThan(firstExpiry);
      // The manifest key claim (§8.3) is re-signed with it, so the renewed
      // manifest is as verifiable as the original.
      expect(verifyManifestSignature(renewal.manifest)).toBe(true);
    });

    it("keeps renewing, cycle after cycle", async () => {
      const conn = makeConn();
      const { agent } = standalone(conn);
      await agent.register({ name: "forever" });
      // Three renewal windows: a one-shot renewal would leave this at 2.
      await advance(TTL * 3);
      await agent.close();
      expect(conn.registers.length).toBeGreaterThanOrEqual(4);
      // Never lapsed: every vouch was replaced before the previous one expired.
      for (let i = 1; i < conn.registers.length; i++) {
        expect(conn.registers[i].at).toBeLessThan(
          Date.parse(conn.registers[i - 1].manifest.node.attestation.expires_at),
        );
      }
    });

    it("re-registers the same manifest it first registered", async () => {
      const conn = makeConn();
      const { agent } = standalone(conn);
      await agent.register({
        name: "steady",
        description: "unchanged across renewals",
        offerings: [{ name: "echo", description: "echo back" }],
        capabilities: ["chat"],
        visibility: "unlisted",
      });
      await advance(TTL * 0.85);
      await agent.close();

      const [a, b] = conn.registers.map((r) => r.manifest);
      expect(b.name).toBe(a.name);
      expect(b.description).toBe(a.description);
      expect(b.offerings).toEqual(a.offerings);
      expect(b.capabilities).toEqual(a.capabilities);
      expect(b.visibility).toBe("unlisted");
      expect(b.id).toBe(a.id);
    });

    it("renews the owner attestation on the same clock (§9.7)", async () => {
      // The registry applies the same expiry rule to the owner attestation, so
      // renewing only the node vouch would still fail the re-registration.
      const conn = makeConn();
      const { agent } = standalone(conn);
      const ownerKp = nkeys.createUser();
      await agent.register({
        name: "owned",
        ownerSeed: new TextDecoder().decode(ownerKp.getSeed()),
      });
      await advance(TTL * 0.85);
      await agent.close();

      const [a, b] = conn.registers.map((r) => r.manifest);
      expect(a.owner_attestation).toBeDefined();
      expect(Date.parse(b.owner_attestation!.expires_at)).toBeGreaterThan(
        Date.parse(a.owner_attestation!.expires_at),
      );
      expect(verifyAttestation(b.owner_attestation!, agent.id)).toBe(true);
    });

    it("reports the vouch window it is maintaining", async () => {
      const conn = makeConn();
      const { agent } = standalone(conn);
      expect(agent.vouch.expires_at).toBeNull();
      await agent.register({ name: "observable" });
      const { expires_at, renew_at, last_error } = agent.vouch;
      expect(last_error).toBeNull();
      expect(Date.parse(expires_at!) - Date.parse(renew_at!)).toBeCloseTo(
        TTL * (1 - VOUCH_RENEWAL_FRACTION),
        0,
      );
      await agent.close();
    });

    it("renewVouch() refuses when the agent never registered", async () => {
      const conn = makeConn();
      const { agent } = standalone(conn);
      await expect(agent.renewVouch()).rejects.toThrow(/has not registered/);
      await agent.close();
    });

    it("does not re-run the EXT-6 guard handshake on renewal", async () => {
      // Re-asking the admission service could be refused (rate limit, ceiling)
      // and move a healthy guarded agent off the inbox anyone writes to.
      const conn = makeConn();
      const { agent } = standalone(conn);
      await agent.register({ name: "guarded-one", guarded: true });
      expect(conn.guardCalls).toHaveLength(1);
      await advance(TTL * 0.85);
      await agent.close();

      expect(conn.registers).toHaveLength(2);
      expect(conn.guardCalls).toHaveLength(1);
    });
  });

  describe("renewal cleanup", () => {
    it("stops renewing after close()", async () => {
      const conn = makeConn();
      const { agent } = standalone(conn);
      await agent.register({ name: "closes-early" });
      await agent.close();

      await advance(TTL * 3); // several renewal windows
      expect(conn.registers).toHaveLength(1); // nothing after the original
    });

    it("stops renewing after drain()", async () => {
      const conn = makeConn();
      const { agent } = standalone(conn);
      await agent.register({ name: "drains" });
      await agent.drain();

      await advance(TTL * 3);
      expect(conn.registers).toHaveLength(1);
    });

    it("stops renewing after deregister(), and forgets the deadline", async () => {
      const conn = makeConn();
      const { agent } = standalone(conn);
      await agent.register({ name: "deregisters" });
      await agent.deregister();
      expect(agent.vouch.expires_at).toBeNull();
      expect(agent.vouch.renew_at).toBeNull();

      await advance(TTL * 3);
      expect(conn.registers).toHaveLength(1);
      await agent.close();
    });
  });

  describe("a failed renewal is visible and retried", () => {
    it("reports through onSecurityWarning and succeeds on the retry", async () => {
      const warnings: SecurityWarning[] = [];
      const conn = makeConn();
      const { agent } = standalone(conn, (w) => warnings.push(w));
      await agent.register({ name: "flaky-registry" });
      conn.failNextRegisters = 1; // the first renewal attempt is refused

      await advance(TTL * 0.85);
      await agent.close();

      // The failure surfaced, said what lapses and when, and did not throw.
      const failure = warnings.find((w) => w.code === "vouch_renewal_failed");
      expect(failure).toBeDefined();
      expect(failure!.message).toMatch(/too many registrations/);
      expect(failure!.message).toMatch(/expires/);
      expect(failure!.subject).toBe(agent.id);

      // And it retried on the next pass rather than giving up: a renewal did
      // land, before the original vouch expired.
      expect(conn.registers).toHaveLength(2);
      expect(conn.registers[1].at).toBeLessThan(
        Date.parse(conn.registers[0].manifest.node.attestation.expires_at),
      );
      expect(agent.vouch.last_error).toBeNull(); // cleared by the successful retry
    });

    it("keeps retrying while the registry is unreachable, and never throws", async () => {
      const warnings: SecurityWarning[] = [];
      const conn = makeConn();
      const { agent } = standalone(conn, (w) => warnings.push(w));
      await agent.register({ name: "registry-goes-away" });
      conn.request.mockImplementation(async () => {
        throw new Error("connection refused");
      });

      await advance(TTL * 1.4); // past the deadline AND past expiry
      await agent.close();

      const failures = warnings.filter((w) => w.code === "vouch_renewal_failed");
      expect(failures.length).toBeGreaterThanOrEqual(2); // retried, not one-shot
      expect(agent.vouch.last_error).toMatch(/connection refused/);
      // A failing renewal does not corrupt what the agent thinks it holds.
      expect(agent.vouch.expires_at).toBe(
        conn.registers[0].manifest.node.attestation.expires_at,
      );
    });
  });

  describe("node-hosted agents: one node re-vouches many agents (§4.4)", () => {
    it("renews every hosted agent's vouch, signed by the node key", async () => {
      const conn = makeConn();
      const { node, nodeKp } = hostedNode(conn);
      const a = node.addAgent();
      const b = node.addAgent();
      await a.register({ name: "hosted-a" });
      await b.register({ name: "hosted-b" });
      expect(conn.registers).toHaveLength(2);

      await advance(TTL * 0.85);
      await node.close();

      for (const agent of [a, b]) {
        const mine = conn.registers.filter((r) => r.manifest.id === agent.id);
        expect(mine).toHaveLength(2);
        const renewed = mine[1].manifest.node.attestation;
        // The NODE vouched — not the agent for itself.
        expect(renewed.node).toBe(nodeKp.getPublicKey());
        expect(verifyAttestation(renewed, agent.id)).toBe(true);
        expect(Date.parse(renewed.expires_at)).toBeGreaterThan(
          Date.parse(mine[0].manifest.node.attestation.expires_at),
        );
        // Still the agent's own signature on the key claim (§8.3).
        expect(verifyManifestSignature(mine[1].manifest)).toBe(true);
      }
    });

    it("the node drives it: an agent detached from the node stops being renewed", async () => {
      const conn = makeConn();
      const { node } = hostedNode(conn);
      const detached = node.addAgent();
      const kept = node.addAgent();
      await detached.register({ name: "detached" });
      await kept.register({ name: "kept" });

      await node.removeAgent(detached.id);
      await advance(TTL * 0.85);
      await node.close();

      expect(conn.registers.filter((r) => r.manifest.id === detached.id)).toHaveLength(1);
      expect(conn.registers.filter((r) => r.manifest.id === kept.id)).toHaveLength(2);
    });

    it("stops renewing after node.close()", async () => {
      const conn = makeConn();
      const { node } = hostedNode(conn);
      const agent = node.addAgent();
      await agent.register({ name: "hosted-closes" });
      await node.close();

      await advance(TTL * 3);
      expect(conn.registers).toHaveLength(1);
    });

    it("a hosted agent's renewal failure reaches the node's warning sink", async () => {
      const warnings: SecurityWarning[] = [];
      const conn = makeConn();
      const { node } = hostedNode(conn, (w) => warnings.push(w));
      const agent = node.addAgent();
      await agent.register({ name: "hosted-flaky" });
      conn.request.mockImplementation(async () => {
        throw new Error("registry unreachable");
      });

      await advance(TTL * 0.9);
      await node.close();

      expect(warnings.some((w) => w.code === "vouch_renewal_failed")).toBe(true);
    });

    it("renewVouches() is a no-op before anything is due", async () => {
      const conn = makeConn();
      const { node } = hostedNode(conn);
      const agent = node.addAgent();
      await agent.register({ name: "not-yet-due" });

      expect(await node.renewVouches()).toBe(0);
      expect(conn.registers).toHaveLength(1);
      await node.close();
    });

    it("an unregistered hosted agent is skipped, not vouched into existence", async () => {
      const conn = makeConn();
      const { node } = hostedNode(conn);
      node.addAgent(); // never registers
      const registered = node.addAgent();
      await registered.register({ name: "the-only-one" });

      await advance(TTL * 0.85);
      await node.close();

      expect(conn.registers.every((r) => r.manifest.id === registered.id)).toBe(true);
      expect(conn.registers).toHaveLength(2);
    });
  });
});
