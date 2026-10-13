// The A2A bridge marker on the activity row — tracker #114.
//
// The bridge signs an external caller's traffic with a hosted mesh identity
// and puts the §8.3 marker in `meta.a2a_bridge` on every envelope it sends.
// The activity tap used to read everything BUT `meta`, so activity rows named
// the hosted identity and nothing on the row said the call was bridged. These
// tests pin the lift: a bridged request's row carries the marker (and keeps it
// through the response update), and — because the ring is a persisted store
// other things read back — an UNBRIDGED row serializes byte-identically to
// what the tap wrote before the field existed.
import { describe, it, expect, afterEach, vi } from "vitest";
import { fakeJs, forbiddenKeys } from "../helpers/fake-kv.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvelope } from "../../src/sdk.js";
import type { Envelope } from "../../src/sdk.js";
import type { ActivityEntry, ActivityService } from "../../src/activity/activity-service.js";

const AGENT = "UAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
/** The hosted identity the bridge minted — the envelope's `from`. */
const HOSTED = "UHOSTEDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NODE = "UBRIDGENODEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** The marker exactly as a2a-gateway/src/core/card.ts writes it. */
const MARKER = {
  direction: "inbound",
  node: NODE,
  caller_ref: "6f7c2a1e-caller-ref",
  caller_kind: "account",
  a2a_protocol_version: "0.3.0",
};

function createMockKv() {
  const store = new Map<string, string>();
  return {
    store,
    async put(key: string, data: Uint8Array): Promise<number> {
      store.set(key, new TextDecoder().decode(data));
      return 1;
    },
    async get(key: string) {
      const body = store.get(key);
      if (body === undefined) return null;
      return {
        key,
        operation: "PUT" as const,
        revision: 1,
        length: body.length,
        value: new TextEncoder().encode(body),
        json: <T>(): T => JSON.parse(body) as T,
        string: () => body,
      };
    },
    keys: forbiddenKeys(),
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async purge(key: string): Promise<void> {
      store.delete(key);
    },
  };
}

function createMockNc() {
  const sub = {
    unsubscribe() {},
    async *[Symbol.asyncIterator]() { /* no traffic */ },
  };
  return {
    subscribe: () => sub,
    request: async () => {
      throw new Error("no registry in this test");
    },
  };
}

/** Private surface these tests reach into: the two tap entry points. */
type Internals = {
  entries: ActivityEntry[];
  recordRequest(env: Envelope, bytes?: number): void;
  recordResponse(env: Envelope, bytes?: number): void;
};

describe("the bridge marker on the activity row", () => {
  let dir: string;
  const live: ActivityService[] = [];

  async function load(): Promise<{ svc: ActivityService; kv: ReturnType<typeof createMockKv> }> {
    dir ??= mkdtempSync(join(tmpdir(), "activity-bridge-"));
    vi.resetModules();
    vi.stubEnv("USAGE_DB_PATH", join(dir, "usage.db"));
    vi.stubEnv("AUDIT_DB_PATH", join(dir, "audit.db"));
    const mod = await import("../../src/activity/activity-service.js");
    const kv = createMockKv();
    const h = fakeJs();
    const bucket = Object.assign(kv, { status: h.bucket("mesh_activity", () => [...kv.store.keys()]) });
    const js = { views: { kv: async () => bucket }, jetstreamManager: h.jetstreamManager };
    const svc = await mod.ActivityService.create(createMockNc() as never, js as never);
    live.push(svc);
    return { svc, kv };
  }

  /** Let the fire-and-forget kv.put promises settle. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  const request = (over: Partial<Parameters<typeof createEnvelope>[0]> = {}) =>
    createEnvelope({
      type: "request",
      from: HOSTED,
      to: AGENT,
      payload: { offering: "summarize", input: { text: "hello" } },
      ...over,
    });

  afterEach(async () => {
    for (const svc of live.splice(0)) {
      try { await svc.stop(); } catch { /* already stopped */ }
    }
    vi.unstubAllEnvs();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined as unknown as string;
  });

  it("a bridged request's row says so on its face, in memory and in the bucket", async () => {
    const { svc, kv } = await load();
    const inner = svc as unknown as Internals;

    inner.recordRequest(request({ meta: { a2a_bridge: MARKER } }));
    await settle();

    const expected = { node: NODE, callerRef: MARKER.caller_ref, callerKind: "account" };
    expect(inner.entries).toHaveLength(1);
    expect(inner.entries[0].a2aBridge).toEqual(expected);
    // And on the persisted row, which is what a restart reloads the ring from.
    const [stored] = [...kv.store.values()].map((v) => JSON.parse(v) as ActivityEntry);
    expect(stored.a2aBridge).toEqual(expected);
    // The wire detail (direction, protocol version) is deliberately not kept.
    expect(JSON.stringify(stored)).not.toContain("a2a_protocol_version");
  });

  it("an unbridged row is byte-identical to what the tap wrote before the field existed", async () => {
    const { svc, kv } = await load();
    (svc as unknown as Internals).recordRequest(request());
    await settle();

    const [raw] = [...kv.store.values()];
    // The exact key set a pre-#114 row serialized with — no a2aBridge, and
    // nothing else new either. An empty-object spread must add nothing.
    expect(Object.keys(JSON.parse(raw))).toEqual([
      "id", "ts", "recordedAt", "from", "to", "offering",
      "taskId", "requestId", "inputPreview", "inputSha256", "status",
    ]);
    expect(raw).not.toContain("a2aBridge");
  });

  it("ignores a malformed or caller-less marker rather than storing an empty claim", async () => {
    const { svc } = await load();
    const inner = svc as unknown as Internals;

    inner.recordRequest(request({ meta: { a2a_bridge: "not an object" } }));
    inner.recordRequest(request({ meta: { a2a_bridge: { node: NODE, caller_kind: "account" } } })); // no ref
    inner.recordRequest(request({ meta: { a2a_bridge: { ...MARKER, caller_ref: "" } } }));
    inner.recordRequest(request({ meta: { something_else: true } }));
    await settle();

    expect(inner.entries).toHaveLength(4);
    expect(inner.entries.every((e) => e.a2aBridge === undefined)).toBe(true);
  });

  it("keeps the marker on the row through the response update", async () => {
    const { svc, kv } = await load();
    const inner = svc as unknown as Internals;

    const req = request({ meta: { a2a_bridge: MARKER } });
    inner.recordRequest(req);
    inner.recordResponse(
      createEnvelope({
        type: "respond",
        from: AGENT,
        to: HOSTED,
        in_reply_to: req.id,
        payload: { output: "done" },
      }),
    );
    await settle();

    const [row] = inner.entries;
    expect(row.respondedAt).toBeDefined();
    expect(row.a2aBridge).toEqual({ node: NODE, callerRef: MARKER.caller_ref, callerKind: "account" });
    // recordResponse rewrites the persisted row; the marker must survive that.
    const [stored] = [...kv.store.values()].map((v) => JSON.parse(v) as ActivityEntry);
    expect(stored.a2aBridge).toEqual({ node: NODE, callerRef: MARKER.caller_ref, callerKind: "account" });
  });
});
