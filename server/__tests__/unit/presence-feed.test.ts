/**
 * Presence as a derived feed (registry/presence-feed.ts; tracker 184,
 * design gate docs/presence-feed.md).
 *
 * The properties worth pinning:
 *
 *  - identity mints ONCE via kv.create, so a boot race yields one identity,
 *    not two (the feed subject embeds the key; two would strand somebody);
 *  - the publisher speaks only on TRANSITIONS: same-presence flips publish
 *    nothing, and a node flip fans out to the node's agents' topics;
 *  - the value confesses its decay: {presence, as_of, stale_after} — the
 *    §9.6 reconciliation, printed into every value;
 *  - forgetAgent publishes a final offline and purges the topic's stored
 *    value under the PRESENCE AGENT's prefix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PresenceFeedStore, PresenceFeedPublisher } from "../../src/registry/presence-feed.js";
import { FeedStateStore, feedKvKey } from "../../src/shared/feed-state.js";
import { memKv, fakeJs } from "../helpers/fake-kv.js";
import { loadAtRestKey } from "../../src/shared/at-rest.js";
import { decode, nkeys } from "../../src/sdk.js";

let dir: string;

function kvStub() {
  const store = new Map<string, string>();
  return {
    put: vi.fn(async (k: string, v: string | Uint8Array) => {
      store.set(k, typeof v === "string" ? v : new TextDecoder().decode(v));
    }),
    create: vi.fn(async (k: string, v: string | Uint8Array) => {
      if (store.has(k)) throw new Error(`key exists: ${k}`);
      store.set(k, typeof v === "string" ? v : new TextDecoder().decode(v));
    }),
    get: vi.fn(async (k: string) => {
      const v = store.get(k);
      return v === undefined
        ? null
        : { key: k, operation: "PUT" as const, value: new TextEncoder().encode(v), json: <T>() => JSON.parse(v) as T, string: () => v };
    }),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "presence-feed-"));
  const keyFile = join(dir, "at-rest.key");
  writeFileSync(keyFile, randomBytes(32).toString("hex"));
  process.env.HOSTED_AGENT_KEY_FILE = keyFile;
});

afterEach(() => {
  delete process.env.HOSTED_AGENT_KEY_FILE;
  rmSync(dir, { recursive: true, force: true });
});

function fakeNc() {
  const published: Array<{ subject: string; data: Uint8Array }> = [];
  return {
    published,
    nc: { publish: vi.fn((subject: string, data: Uint8Array) => void published.push({ subject, data })) },
  };
}

async function startPublisher(agentsOf: (node: string) => string[]) {
  const store = new PresenceFeedStore(kvStub() as never, loadAtRestKey());
  const { nc, published } = fakeNc();
  const pub = await PresenceFeedPublisher.start(nc as never, store, null, agentsOf);
  return { pub: pub!, published };
}

describe("PresenceFeedStore identity", () => {
  it("mints once; a create race resolves to the winner's identity", async () => {
    const kv = kvStub();
    const a = new PresenceFeedStore(kv as never, loadAtRestKey());
    const b = new PresenceFeedStore(kv as never, loadAtRestKey());
    const ka = await a.ensureIdentity();
    const kb = await b.ensureIdentity();
    expect(kb.agentKey).toBe(ka.agentKey);
  });

  it("is off without an at-rest key, in the routes' words", async () => {
    delete process.env.HOSTED_AGENT_KEY_FILE;
    const s = new PresenceFeedStore(kvStub() as never, loadAtRestKey());
    expect(s.enabled).toBe(false);
    await expect(s.ensureIdentity()).rejects.toThrow(/not configured/);
  });
});

describe("PresenceFeedPublisher", () => {
  const NODE = nkeys.createUser().getPublicKey();
  const AGENT_A = nkeys.createUser().getPublicKey();
  const AGENT_B = nkeys.createUser().getPublicKey();

  it("fans a node flip to its agents' topics, transitions only", async () => {
    const { pub, published } = await startPublisher(() => [AGENT_A, AGENT_B]);
    pub.nodeFlip(NODE, "online");
    pub.nodeFlip(NODE, "online"); // same presence: publishes nothing new
    expect(published).toHaveLength(2);
    const subjects = published.map((p) => p.subject).sort();
    expect(subjects).toEqual(
      [
        `mesh.feed.${pub.key}.${AGENT_A}`,
        `mesh.feed.${pub.key}.${AGENT_B}`,
      ].sort(),
    );
    pub.nodeFlip(NODE, "offline");
    expect(published).toHaveLength(4);
  });

  it("values carry presence, as_of and stale_after, signed by the feed owner", async () => {
    const { pub, published } = await startPublisher(() => [AGENT_A]);
    pub.nodeFlip(NODE, "online");
    const env = decode(published[0].data); // verifies the signature
    expect(env.from).toBe(pub.key);
    const p = env.payload as { topic: string; kind: string; data: { presence: string; as_of: string; stale_after: string } };
    expect(p.topic).toBe(AGENT_A);
    expect(p.kind).toBe("state");
    expect(p.data.presence).toBe("online");
    expect(Date.parse(p.data.stale_after)).toBeGreaterThan(Date.parse(p.data.as_of));
  });

  it("forgetAgent: a final offline, then the stored value goes", async () => {
    const h = fakeJs();
    const mem = memKv("mesh_feed_state", h);
    const feedStates = new FeedStateStore(h.js as never, mem.kv as never);
    const store = new PresenceFeedStore(kvStub() as never, loadAtRestKey());
    const { nc, published } = fakeNc();
    const pub = (await PresenceFeedPublisher.start(nc as never, store, feedStates, () => [AGENT_A]))!;
    pub.nodeFlip(NODE, "online");
    // Simulate the writer having stored the value.
    await feedStates.put(pub.key!, AGENT_A, published[0].data);
    expect(mem.store.has(feedKvKey(pub.key!, AGENT_A))).toBe(true);
    await pub.forgetAgent(AGENT_A);
    expect(published).toHaveLength(2);
    expect((decode(published[1].data).payload as { data: { presence: string } }).data.presence).toBe("offline");
    expect(mem.store.has(feedKvKey(pub.key!, AGENT_A))).toBe(false);
  });
});
