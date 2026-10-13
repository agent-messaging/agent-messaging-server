// Guard rehydration on boot — the site where a silently short KV read cost the
// most, and the reason `snapshotKvBucket` exists.
//
// A guard entry in `mesh_admission_guards` is a claim about the world outside the
// bucket: the agent has STOPPED subscribing its public inbox and listens on
// `mesh.agent.<id>.inbox.guarded` instead, trusting this service to subscribe the
// public subject and relay. So an entry the boot-time replay misses is not one
// less guarded agent. It is an agent with nobody subscribed to its inbox at all —
// every message to it dropped, in silence, for the life of the process, with the
// registry still listing it as registered and the console still showing it online.
//
// The replay used to be `for await (const k of await this.guardKv.keys(">"))` with
// the subscribe, the KV write-back and the mailbox re-point all inside the loop.
// `kv.keys()` discards whatever its producer queued while the caller was awaiting
// the previous batch (src/shared/kv.ts has the mechanism and the measurements),
// and it drops MORE the slower the caller is: a caller awaiting 1 ms per key
// measured 1 key of 500. Three awaited round trips per iteration made this the
// slowest caller in the codebase, reading the list whose incompleteness is the
// most expensive.
import { describe, it, expect, vi } from "vitest";
import { fakeJs, forbiddenKeys } from "../helpers/fake-kv.js";
import { AdmissionService } from "../../src/admission/admission-service.js";

const key = (n: number) => (`UGUARD${n}`.padEnd(56, "A") as string).slice(0, 56);

/**
 * A bucket that records puts and can be pre-seeded.
 *
 * `tombstoned` holds names the backing stream still lists as SUBJECTS but which
 * have no live value — a delete or purge marker. They are subjects like any other
 * and must be classified rather than replayed.
 */
function bucket(name: string, h: ReturnType<typeof fakeJs>) {
  const store = new Map<string, string>();
  const tombstoned: string[] = [];
  const kv = {
    store,
    tombstoned,
    status: h.bucket(name, () => [...store.keys(), ...tombstoned]),
    keys: forbiddenKeys(),
    put: vi.fn(async (k: string, v: string) => { store.set(k, String(v)); return 1; }),
    get: vi.fn(async (k: string) => {
      if (tombstoned.includes(k)) {
        return {
          key: k, operation: "DEL" as const, revision: 2, length: 0,
          value: new Uint8Array(), json: () => null, string: () => "",
        };
      }
      const v = store.get(k);
      if (v === undefined) return null;
      return {
        key: k, operation: "PUT" as const, revision: 1, length: v.length,
        value: new TextEncoder().encode(v), json: <T>() => JSON.parse(v) as T, string: () => v,
      };
    }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
    purge: vi.fn(async (k: string) => { store.delete(k); }),
  };
  return kv;
}

/**
 * The connection and JetStream client `AdmissionService.create` needs.
 *
 * `streams.info` answers for two kinds of name: `KV_*` is a bucket enumeration
 * (handled by the harness), and `MESH_INBOX_*` is an agent's offline mailbox,
 * which `InboxBuffer.setGuarded` inspects. The mailbox is reported as ALREADY
 * pointing at the guarded subject so `setGuarded` returns early — otherwise a
 * missing stream makes it retry twelve times at 250 ms per guarded agent.
 */
function harness(seeded: string[]) {
  const h = fakeJs();
  const guards = bucket("mesh_admission_guards", h);
  const rosters = bucket("mesh_admission", h);
  for (const k of seeded) guards.store.set(k, "1");

  const info = vi.fn(async (name: string) => {
    if (name.startsWith("MESH_INBOX_")) {
      const agent = name.slice("MESH_INBOX_".length);
      return { config: { name, subjects: [`mesh.agent.${agent}.inbox.guarded`], no_ack: true } };
    }
    return h.info(name);
  });

  const subscribed: string[] = [];
  const sub = { unsubscribe() {}, async *[Symbol.asyncIterator]() { /* no traffic */ } };
  const nc = {
    subscribe: vi.fn((subject: string) => { subscribed.push(subject); return sub; }),
    publish: vi.fn(),
    request: vi.fn(),
    jetstreamManager: vi.fn(async () => ({ streams: { info } })),
  };
  const js = {
    views: { kv: vi.fn(async (name: string) => (name === "mesh_admission" ? rosters : guards)) },
    jetstreamManager: vi.fn(async () => ({ streams: { info } })),
  };
  return { h, nc, js, guards, subscribed };
}

/** The guarded agents this service is relaying for, i.e. the inbox subjects it
 *  actually subscribed. The two control subjects are excluded. */
function guardedInboxes(subscribed: string[]): string[] {
  return subscribed
    .filter((s) => s.endsWith(".inbox"))
    .map((s) => s.slice("mesh.agent.".length, -".inbox".length));
}

describe("AdmissionService.start — guard replay", () => {
  it("re-guards EVERY entry in the durable list", async () => {
    // 120 entries: enough that a producer/consumer race would resolve short, and
    // more than the reference instance's 27.
    const keys = Array.from({ length: 120 }, (_, i) => key(i));
    const { nc, js, subscribed } = harness(keys);

    const svc = await AdmissionService.create(nc as never, js as never);
    await svc.start();

    expect(guardedInboxes(subscribed).sort()).toEqual([...keys].sort());
    await svc.stop();
  });

  it("still re-guards them all when each guard is SLOW", async () => {
    // The condition that made the old code fail, reproduced as directly as a unit
    // test can: real per-key work between reads. Under `kv.keys()` this is the
    // 1-of-500 shape; a list that is already an array cannot shorten.
    const keys = Array.from({ length: 40 }, (_, i) => key(i));
    const { nc, js, guards, subscribed } = harness(keys);
    guards.put.mockImplementation(async (k: string, v: string) => {
      await new Promise((r) => setTimeout(r, 1));
      guards.store.set(k, String(v));
      return 1;
    });

    const svc = await AdmissionService.create(nc as never, js as never);
    await svc.start();

    expect(guardedInboxes(subscribed)).toHaveLength(40);
    await svc.stop();
  });

  it("refuses to start when the guard list cannot be read completely", async () => {
    // Loud beats half-guarded. `start()` is called unguarded from main.ts, so this
    // becomes a boot failure naming the bucket — visible, and fixed by a restart
    // once JetStream answers. Booting with a partial list produces black-holed
    // agents that nothing detects and nothing retries.
    const { h, nc, js, subscribed } = harness([key(1), key(2)]);
    h.info.mockRejectedValue(new Error("no responders for $JS.API.STREAM.INFO"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const svc = await AdmissionService.create(nc as never, js as never);
    await expect(svc.start()).rejects.toThrow(/no responders/);

    expect(guardedInboxes(subscribed)).toEqual([]); // nothing half-done
    expect(err.mock.calls.flat().join(" ")).toMatch(/half-guarded/);
    err.mockRestore();
    await svc.stop();
  });

  it("treats a genuinely empty guard list as empty, not as a failure", async () => {
    const { nc, js, subscribed } = harness([]);
    const svc = await AdmissionService.create(nc as never, js as never);
    await svc.start();
    expect(guardedInboxes(subscribed)).toEqual([]);
    await svc.stop();
  });

  it("does not count a deleted entry as a guarded agent", async () => {
    // An unguard leaves a delete marker, which is still a SUBJECT on the backing
    // stream. The enumeration must classify it rather than replay it — re-guarding
    // an agent that asked to be unguarded would subscribe its inbox and re-point
    // its mailbox behind its back.
    const live = key(1);
    const removed = key(2);
    const { nc, js, guards, subscribed } = harness([live]);
    guards.tombstoned.push(removed); // still a subject, newest revision is a DEL

    const svc = await AdmissionService.create(nc as never, js as never);
    await svc.start();

    expect(guardedInboxes(subscribed)).toEqual([live]);
    await svc.stop();
  });
});
