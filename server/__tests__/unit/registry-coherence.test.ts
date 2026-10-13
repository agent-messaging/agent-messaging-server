// Two registry instances have to agree about who is registered.
//
// Queue groups (shared/queue-groups.ts) made a second instance safe to WRITE:
// each `mesh.registry.register` reaches exactly one instance, so there is one KV
// write, one mailbox and one event per registration. They also made the read
// wrong. The manifest cache is in-memory and was written only by the boot seed
// and by the handlers that ran in THAT process, so the instance which did not
// handle a registration never learned of it and answered `mesh.registry.discover`
// from a directory missing that agent, for the life of the process — an agent
// visible or invisible depending on which instance the query happened to reach.
//
// The fix is a KV watch per instance (src/registry/manifest-watch.ts), and the
// property worth pinning is the end-to-end one, not the mechanism: register
// through A, discover through B. So these tests stand up TWO RegistryService
// instances in one process over one fake bus and one shared fake bucket — which
// is what two machines share — and drive them through the real subjects, real
// signed envelopes and the real queue groups. The caches are per-instance fields,
// so nothing is shared here that would not be shared in the deployment.
import { describe, it, expect, vi, afterEach } from "vitest";
import { fakeJs, memKv } from "../helpers/fake-kv.js";
import { RegistryService } from "../../src/registry/registry-service.js";
import { ManifestWatch } from "../../src/registry/manifest-watch.js";
import {
  createEnvelope,
  encode,
  decode,
  signEnvelope,
  nkeys,
  createAttestation,
  Subjects,
} from "../../src/sdk.js";
import type { Envelope, Manifest } from "../../src/sdk.js";

// ── the bus ──────────────────────────────────────────────────────────
//
// Core NATS delivery, including the one rule these tests exist to exercise: of
// the subscribers that joined the same queue group on a subject, exactly ONE
// receives each message. `route` picks which member — that is the coin flip the
// broker makes in production, made deterministic so a test can say "this
// registration was handled by A" and "this query reached B".

function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return true;
    if (i >= s.length) return false;
    if (p[i] !== "*" && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

interface FakeMsg {
  subject: string;
  data: Uint8Array;
  reply?: string;
  respond(data: Uint8Array): void;
}

function fakeBus() {
  interface Sub {
    subject: string;
    queue?: string;
    closed: boolean;
    queued: FakeMsg[];
    wake: (() => void) | null;
  }
  const subs: Sub[] = [];
  const published: Array<{ subject: string; data: Uint8Array }> = [];
  /** Which member of each queue group receives the next message. */
  let route = 0;

  function targets(subject: string): Sub[] {
    const matching = subs.filter((s) => !s.closed && subjectMatches(s.subject, subject));
    const groups = new Map<string, Sub[]>();
    const broadcast: Sub[] = [];
    for (const s of matching) {
      if (!s.queue) broadcast.push(s);
      else groups.set(s.queue, [...(groups.get(s.queue) ?? []), s]);
    }
    const out = [...broadcast];
    for (const members of groups.values()) {
      out.push(members[Math.min(route, members.length - 1)]);
    }
    return out;
  }

  function deliver(subject: string, data: Uint8Array, respond?: (d: Uint8Array) => void): number {
    const t = targets(subject);
    for (const s of t) {
      s.queued.push({
        subject,
        data,
        reply: respond ? "_INBOX.test" : undefined,
        respond: (d) => respond?.(d),
      });
      s.wake?.();
      s.wake = null;
    }
    return t.length;
  }

  const nc = {
    subscribe(subject: string, opts?: { queue?: string }) {
      const s: Sub = { subject, queue: opts?.queue, closed: false, queued: [], wake: null };
      subs.push(s);
      return {
        subject,
        unsubscribe(): void {
          s.closed = true;
          s.wake?.();
          s.wake = null;
        },
        async *[Symbol.asyncIterator](): AsyncGenerator<FakeMsg> {
          for (;;) {
            if (s.queued.length) {
              yield s.queued.shift()!;
              continue;
            }
            if (s.closed) return;
            await new Promise<void>((r) => {
              s.wake = r;
            });
          }
        },
      };
    },
    publish(subject: string, data: Uint8Array): void {
      published.push({ subject, data });
      deliver(subject, data);
    },
    async request(subject: string, data: Uint8Array, opts?: { timeout?: number }) {
      return new Promise<{ data: Uint8Array }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no reply on ${subject}`)),
          opts?.timeout ?? 2000,
        );
        let answered = false;
        const n = deliver(subject, data, (d) => {
          if (answered) return;
          answered = true;
          clearTimeout(timer);
          resolve({ data: d });
        });
        if (n === 0) {
          clearTimeout(timer);
          reject(new Error(`no responders for ${subject}`));
        }
      });
    },
    // The inbox buffer asks for one of these per registration. It swallows every
    // failure by contract (registration must not fail because the buffer tier is
    // down), so a stub that answers is only here to keep the noise down.
    async jetstreamManager() {
      return {
        streams: {
          async *list(): AsyncGenerator<unknown> { /* no mailboxes */ },
          info: vi.fn(async () => { throw new Error("no stream"); }),
          add: vi.fn(async () => ({})),
          delete: vi.fn(async () => true),
          update: vi.fn(async () => ({})),
          purge: vi.fn(async () => ({})),
        },
      };
    },
  };

  return {
    nc,
    published,
    /** Route every queue group's messages to member `i` (0 = the first instance
     *  that subscribed). This is the broker's choice, made explicit. */
    routeTo(i: number): void {
      route = i;
    },
    /** Subjects a message was published on, for the event assertions. */
    publishedOn(subject: string): Array<{ subject: string; data: Uint8Array }> {
      return published.filter((p) => p.subject === subject);
    },
  };
}

// ── fixtures ─────────────────────────────────────────────────────────

/** A 0.2 manifest for a self-hosting agent, with a valid node vouch. */
function vouchedAgent(name = "Two Instance Agent") {
  const kp = nkeys.createUser();
  const id = kp.getPublicKey();
  const manifest = {
    id,
    name,
    description: "",
    version: "1.0.0",
    protocol_version: "0.2.0",
    endpoint: `mesh.agent.${id}.inbox`,
    node: { id, attestation: createAttestation(kp, id) },
    capabilities: ["chat"],
    offerings: [{ id: "echo", name: "Echo", description: "Echo back" }],
    // Said out loud because silence now means private: a first registration
    // that states nothing is its owner's alone. These agents exist to be found
    // by a stranger on the other instance, which is what this file is about.
    visibility: "public",
  } as unknown as Manifest;
  return { kp, id, manifest };
}

function signedBytes(env: Envelope, kp: ReturnType<typeof nkeys.createUser>): Uint8Array {
  signEnvelope(env, kp);
  return encode(env);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll an async predicate. Used instead of a fixed sleep because what is being
 *  waited on is a KV entry travelling through a watch into another instance's
 *  cache, and a fixed delay would either be flaky or slow. */
async function untilAsync(pred: () => Promise<boolean>, ms = 2000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - started > ms) throw new Error(`condition still false after ${ms}ms`);
    await sleep(2);
  }
}

/**
 * Two registry instances over one bus and one shared `mesh_registry` bucket.
 *
 * Both go through the real `RegistryService.create` — so the boot seed, the guard
 * bucket and the watch all run — and the real `start()`, so every subscription
 * carries the queue group it carries in production.
 */
async function twoInstances(seed?: Map<string, Manifest>) {
  const bus = fakeBus();
  const h = fakeJs();
  const registry = memKv("mesh_registry", h);
  const guards = memKv("mesh_admission_guards", h);
  for (const [k, m] of seed ?? []) registry.writeRaw(k, JSON.stringify(m));

  const js = {
    views: {
      kv: async (name: string) => (name === "mesh_registry" ? registry.kv : guards.kv),
    },
    jetstreamManager: h.jetstreamManager,
    // snapshotKvBucket reaches the manager off the client it is handed.
    nc: { info: {} },
  };

  const a = await RegistryService.create(bus.nc as never, js as never);
  const b = await RegistryService.create(bus.nc as never, js as never);
  await a.start();
  await b.start();

  /** Register through whichever instance the broker picks. */
  async function register(agent: ReturnType<typeof vouchedAgent>): Promise<Envelope> {
    const env = createEnvelope({ type: "register", from: agent.id, payload: agent.manifest });
    const reply = await bus.nc.request(Subjects.REGISTRY_REGISTER, signedBytes(env, agent.kp));
    return decode(reply.data);
  }

  async function deregister(agent: ReturnType<typeof vouchedAgent>): Promise<Envelope> {
    // Exactly what the SDK sends (sdk-typescript/src/mesh.ts): there is no
    // `deregister` envelope TYPE — the subject carries the intent, and the agent
    // id comes from the verified `from`.
    const env = createEnvelope({
      type: "register",
      from: agent.id,
      payload: { deregister: true },
    });
    const reply = await bus.nc.request(Subjects.REGISTRY_DEREGISTER, signedBytes(env, agent.kp));
    return decode(reply.data);
  }

  /** The agent ids `mesh.registry.discover` returns from the instance the query
   *  reaches — the only view of a cache that a caller ever gets. */
  async function discover(): Promise<string[]> {
    const caller = nkeys.createUser();
    const env = createEnvelope({ type: "discover", from: caller.getPublicKey(), payload: {} });
    const reply = await bus.nc.request(Subjects.REGISTRY_DISCOVER, signedBytes(env, caller));
    const payload = decode(reply.data).payload as { agents: Manifest[] };
    return payload.agents.map((m) => m.id);
  }

  async function stop(): Promise<void> {
    await a.stop();
    await b.stop();
  }

  return { bus, h, registry, guards, a, b, register, deregister, discover, stop };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── the property ─────────────────────────────────────────────────────

describe("two registry instances serve the same directory", () => {
  it("makes an agent registered through one instance discoverable through the other", async () => {
    const mesh = await twoInstances();
    const agent = vouchedAgent();

    // Instance A handles the registration; the queue group means B never sees
    // the request at all.
    mesh.bus.routeTo(0);
    const reply = await mesh.register(agent);
    expect(reply.error).toBeUndefined();

    // Exactly one instance wrote it, and exactly one event was emitted. If this
    // fails the queue groups are not doing their job and the rest of the test is
    // measuring the wrong thing.
    expect(mesh.registry.kv.put).toHaveBeenCalledTimes(1);
    expect(mesh.bus.publishedOn(Subjects.event("registry.agent_registered"))).toHaveLength(1);

    // A answers immediately from its own write: read-your-writes for the agent
    // that just registered.
    expect(await mesh.discover()).toContain(agent.id);

    // B never handled the request and never subscribed the event. It learns from
    // the bucket.
    mesh.bus.routeTo(1);
    await untilAsync(async () => (await mesh.discover()).includes(agent.id));
    expect(await mesh.discover()).toContain(agent.id);

    await mesh.stop();
  });

  it("makes a deregistration through one instance invisible on the other", async () => {
    const mesh = await twoInstances();
    const agent = vouchedAgent();

    mesh.bus.routeTo(0);
    await mesh.register(agent);
    mesh.bus.routeTo(1);
    await untilAsync(async () => (await mesh.discover()).includes(agent.id));

    // Deregister through A. This is the half that fails DANGEROUSLY when caches
    // diverge: "remove my agent" that only reaches one instance leaves the other
    // publishing the manifest — id, name, endpoint, owner key — to whoever asks.
    mesh.bus.routeTo(0);
    const reply = await mesh.deregister(agent);
    expect(reply.error).toBeUndefined();
    expect(await mesh.discover()).not.toContain(agent.id);

    mesh.bus.routeTo(1);
    await untilAsync(async () => !(await mesh.discover()).includes(agent.id));
    expect(await mesh.discover()).not.toContain(agent.id);

    await mesh.stop();
  });

  it("keeps both instances current across a run of registrations either one may take", async () => {
    // The realistic case: the broker spreads registrations across instances, and
    // every instance must end up with all of them. Alternating the route is the
    // load balancing being simulated.
    const mesh = await twoInstances();
    const agents = [vouchedAgent("A1"), vouchedAgent("A2"), vouchedAgent("A3"), vouchedAgent("A4")];

    for (const [i, agent] of agents.entries()) {
      mesh.bus.routeTo(i % 2);
      const reply = await mesh.register(agent);
      expect(reply.error).toBeUndefined();
    }
    expect(mesh.registry.kv.put).toHaveBeenCalledTimes(4);

    for (const instance of [0, 1]) {
      mesh.bus.routeTo(instance);
      await untilAsync(async () => {
        const ids = await mesh.discover();
        return agents.every((a) => ids.includes(a.id));
      });
    }

    await mesh.stop();
  });

  it("does not mutate a cache on a lifecycle event from the bus, signed or not", async () => {
    // The alternative design was to consume the registry's own signed
    // `agent_registered` / `agent_deregistered` events, as the catalog does. It
    // was not taken (manifest-watch.ts), and one of the reasons is here:
    // `decode()` proves an envelope was signed by whoever `from` names — NOT that
    // whoever that is is the registry. So a cache fed by bus events is only as
    // strong as the ACL on `mesh.event.registry.>`, and a forged removal would
    // evict a live agent from discovery on every instance that believed it.
    //
    // This pins the stronger property: NOTHING published on those subjects
    // changes what either instance serves. If a future change wires the cache to
    // the event bus, this fails.
    const mesh = await twoInstances();
    const real = vouchedAgent("Real");
    const ghost = vouchedAgent("Ghost");

    mesh.bus.routeTo(0);
    await mesh.register(real);
    mesh.bus.routeTo(1);
    await untilAsync(async () => (await mesh.discover()).includes(real.id));

    const stranger = nkeys.createUser();
    const event = (eventType: string, data: Record<string, unknown>, sign: boolean) => {
      const env = createEnvelope({
        type: "emit",
        from: stranger.getPublicKey(),
        payload: { domain: "registry", event_type: eventType, data },
      });
      if (sign) signEnvelope(env, stranger);
      mesh.bus.nc.publish(Subjects.event(`registry.${eventType}`), encode(env));
    };

    // A signed "this agent registered", from a key that is not the registry, for
    // an agent with no manifest in the bucket.
    event("agent_registered", { agent_id: ghost.id, name: "Ghost", node: ghost.id }, true);
    // A signed "this agent is gone" for one that is very much not.
    event("agent_deregistered", { agent_id: real.id }, true);
    event("agent_reaped", { agent_id: real.id, node: real.id, reason: "forged" }, true);
    // And the unsigned versions, which is what an attacker who cannot sign sends.
    event("agent_registered", { agent_id: ghost.id, name: "Ghost", node: ghost.id }, false);
    event("agent_deregistered", { agent_id: real.id }, false);
    await sleep(20);

    for (const instance of [0, 1]) {
      mesh.bus.routeTo(instance);
      const ids = await mesh.discover();
      expect(ids).toContain(real.id); // the forged removals did nothing
      expect(ids).not.toContain(ghost.id); // the forged registration did nothing
    }

    await mesh.stop();
  });
});

// ── the boot seed ────────────────────────────────────────────────────

describe("the boot seed is a complete read of the bucket", () => {
  it("loads every manifest the bucket already holds, through the enumeration that cannot come back short", async () => {
    // A cache seeded from a short read is incoherent from its first second no
    // matter what the watch does afterwards: the watch carries CHANGES forward,
    // so a key missed at boot and never written again stays missing. The fake
    // bucket's `keys()` throws (helpers/fake-kv.ts), so a seed that used
    // `kv.keys()` — which under-returns silently against a real server — fails
    // here rather than passing with a subset.
    const seed = new Map<string, Manifest>();
    for (let i = 0; i < 60; i++) {
      const { id, manifest } = vouchedAgent(`Seeded ${i}`);
      manifest.visibility = "public";
      seed.set(id, manifest);
    }

    const mesh = await twoInstances(seed);
    for (const instance of [0, 1]) {
      mesh.bus.routeTo(instance);
      const ids = await mesh.discover();
      expect(ids).toHaveLength(60);
      expect(new Set(ids)).toEqual(new Set(seed.keys()));
    }

    await mesh.stop();
  });

  it("reports a failed enumeration instead of booting on a plausible half of the registry", async () => {
    const h = fakeJs();
    const registry = memKv("mesh_registry", h);
    const guards = memKv("mesh_admission_guards", h);
    registry.writeRaw("UAAA", JSON.stringify({ id: "UAAA", name: "one" }));
    h.info.mockRejectedValueOnce(new Error("no responders for $JS.API.STREAM.INFO"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = fakeBus();

    const svc = await RegistryService.create(bus.nc as never, {
      views: { kv: async (name: string) => (name === "mesh_registry" ? registry.kv : guards.kv) },
      jetstreamManager: h.jetstreamManager,
    } as never);

    expect(err.mock.calls.flat().join(" ")).toMatch(/KV cache seed FAILED/);
    await svc.stop();
  });
});

// ── the watch itself ─────────────────────────────────────────────────

describe("ManifestWatch", () => {
  it("applies puts and removals from the bucket to the cache it was given", async () => {
    const mem = memKv("mesh_registry");
    const cache = new Map<string, Manifest>();
    const watch = new ManifestWatch(mem.kv as never, cache, 5);
    const { id, manifest } = vouchedAgent("Watched");

    await watch.start();
    mem.writeRaw(id, JSON.stringify(manifest));
    await untilAsync(async () => cache.has(id));
    expect(cache.get(id)!.name).toBe("Watched");

    await mem.kv.purge(id);
    await untilAsync(async () => !cache.has(id));

    // A DEL marker removes as well — the registry purges, but an operator or a
    // future path may delete, and either way the key is not live.
    mem.writeRaw(id, JSON.stringify(manifest));
    await untilAsync(async () => cache.has(id));
    await mem.kv.delete(id);
    await untilAsync(async () => !cache.has(id));

    watch.stop();
  });

  it("replays the bucket as it stands when it opens, so the seed→watch gap is covered", async () => {
    // The watch opens after the boot seed, and a registration handled by a peer
    // in between must not be lost. The client's default `include` is the last
    // value per key, which re-reads the bucket; that redundancy is the point.
    const mem = memKv("mesh_registry");
    const cache = new Map<string, Manifest>();
    const { id, manifest } = vouchedAgent("Written before the watch");
    mem.writeRaw(id, JSON.stringify(manifest));

    const watch = new ManifestWatch(mem.kv as never, cache, 5);
    await watch.start();
    await untilAsync(async () => cache.has(id));

    watch.stop();
  });

  it("keeps the previous manifest when a value cannot be parsed, rather than evicting", async () => {
    // A value we cannot read is not an agent that deregistered. Collapsing the
    // two would take a live agent out of discovery on every instance that read
    // it.
    const mem = memKv("mesh_registry");
    const cache = new Map<string, Manifest>();
    const watch = new ManifestWatch(mem.kv as never, cache, 5);
    const { id, manifest } = vouchedAgent("Still here");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await watch.start();
    mem.writeRaw(id, JSON.stringify(manifest));
    await untilAsync(async () => cache.has(id));

    mem.writeRaw(id, "{not json");
    // Give the entry time to be applied — the assertion is that nothing changed.
    await sleep(20);
    expect(cache.get(id)!.name).toBe("Still here");

    watch.stop();
  });

  it("reopens a watch that dies, resuming from the last revision it applied", async () => {
    // An ordered consumer that cannot be recreated ends the iterator, and a watch
    // that ends silently is a cache frozen at whatever it happened to hold — the
    // exact incoherence the class exists to prevent. So it reopens, and it
    // resumes rather than replaying: from `lastRevision + 1`.
    const mem = memKv("mesh_registry");
    const cache = new Map<string, Manifest>();
    const watch = new ManifestWatch(mem.kv as never, cache, 5);
    const first = vouchedAgent("Before the break");
    const second = vouchedAgent("After the break");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await watch.start();
    mem.writeRaw(first.id, JSON.stringify(first.manifest));
    await untilAsync(async () => cache.has(first.id));
    const appliedRevision = mem.revision;

    mem.breakWatch(new Error("consumer deleted"));
    await untilAsync(async () => watch.openCount === 2);
    expect(mem.watchOpts()[1]).toEqual({ resumeFromRevision: appliedRevision + 1 });

    // And it is live again.
    mem.writeRaw(second.id, JSON.stringify(second.manifest));
    await untilAsync(async () => cache.has(second.id));
    expect(cache.has(first.id)).toBe(true);

    watch.stop();
  });

  it("says so loudly and keeps retrying when the watch cannot be opened at all", async () => {
    // Not a throw: a registry whose watch will not open is still correct on its
    // own writes, so refusing to boot would turn "a second instance would drift"
    // into "the mesh has no registry". It is not safe to run a second instance in
    // that state, and the log says exactly that.
    const mem = memKv("mesh_registry");
    const cache = new Map<string, Manifest>();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const watch = new ManifestWatch(mem.kv as never, cache, 5);
    mem.failNextWatch(new Error("no responders for $JS.API.CONSUMER.CREATE"));

    await watch.start();
    expect(watch.watching).toBe(false);
    expect(err.mock.calls.flat().join(" ")).toMatch(/do not run a second\s+registry instance/);

    // The retry succeeds and the cache starts tracking the bucket.
    const { id, manifest } = vouchedAgent("Late");
    await untilAsync(async () => watch.watching);
    mem.writeRaw(id, JSON.stringify(manifest));
    await untilAsync(async () => cache.has(id));

    watch.stop();
  });

  it("does not let the reaper reclaim a registration it has only just learned of", async () => {
    // The one place coherence could have made things worse. Rule 1 of the
    // retention policy measures a never-heard-from node's silence from a clock,
    // and that clock used to be the reaper's own boot — safe while the cache could
    // only hold what this instance had itself handled, because `handleRegister`
    // stamps the node online in presence. A registration a PEER handled arrives
    // through the watch with no presence entry, so on an instance that has been up
    // longer than the TTL the old clock read as "silent since before this existed"
    // and reclaimed it on the next sweep.
    const { Reaper } = await import("../../src/registry/reaper.js");
    const { PresenceStore } = await import("../../src/registry/presence-store.js");
    vi.stubEnv("REAPER_SANDBOX_TTL_MS", "50");

    const cache = new Map<string, Manifest>();
    const kv = { purge: vi.fn(async () => undefined) };
    const nc = { publish: vi.fn(), request: vi.fn() };
    const reaper = new Reaper(
      nc as never,
      kv as never,
      cache,
      new PresenceStore(),
      nkeys.createUser(),
    );

    // This instance has been up for longer than the TTL...
    await sleep(80);
    // ...when the watch applies a registration another instance handled. Its node
    // has never heartbeated to us, and never will (sandbox agents are the class
    // least likely to).
    const { id, manifest } = vouchedAgent("Registered on the other instance");
    manifest.sandbox = true;
    cache.set(id, manifest);

    expect(await reaper.sweep()).toBe(0);
    expect(cache.has(id)).toBe(true);

    // A grace period, not an exemption: once a full TTL of silence has been
    // OBSERVED, retention applies exactly as before.
    await sleep(80);
    expect(await reaper.sweep()).toBe(1);
    expect(cache.has(id)).toBe(false);

    vi.unstubAllEnvs();
  });

  it("stops for good when it is stopped", async () => {
    const mem = memKv("mesh_registry");
    const cache = new Map<string, Manifest>();
    const watch = new ManifestWatch(mem.kv as never, cache, 5);
    await watch.start();
    watch.stop();

    const { id, manifest } = vouchedAgent("After stop");
    mem.writeRaw(id, JSON.stringify(manifest));
    await sleep(20);
    expect(cache.has(id)).toBe(false);
    expect(watch.openCount).toBe(1);
    expect(watch.watching).toBe(false);
  });
});
