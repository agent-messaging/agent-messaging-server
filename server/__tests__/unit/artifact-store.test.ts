// The artifact store's three bounds (§7.5.2) and the one distinction that
// makes an old task record still readable (§7.5.2 GONE vs NOT_FOUND).
//
// The rooms drive never needed any of this, because the room WAS the lifecycle.
// Lifting it verbatim would have produced unbounded storage anyone can write to
// and nothing ever deletes, so every rule below is the difference between a
// feature and a cost hole.
import { describe, it, expect, beforeEach } from "vitest";
import {
  ArtifactStore,
  ARTIFACT_CONFIG,
  digestOf,
  mintObjectId,
  objectIdFrom,
  refFor,
  retentionFor,
  usageOf,
  type ArtifactRecord,
} from "../../src/artifacts/artifact-store.js";
import type { BlobStore } from "../../src/storage/blobs.js";
import type { KV } from "nats";

/** An in-memory blob backend — the interface is four methods precisely so this
 *  is possible without a broker. */
function fakeBlobs(): BlobStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    kind: "memory",
    objects,
    async put(key, bytes) {
      objects.set(key, bytes);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async del(key) {
      objects.delete(key);
    },
    async delPrefix(prefix) {
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) objects.delete(k);
    },
  };
}

function fakeKv(): KV & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async put(key: string, value: Uint8Array) {
      rows.set(key, new TextDecoder().decode(value));
      return 1;
    },
  } as unknown as KV & { rows: Map<string, string> };
}

const OWNER = "UOWNER";
const AGENT = "UAGENT";
const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(7);

describe("refs (§18.5)", () => {
  it("round-trips an id through a ref", () => {
    const id = mintObjectId();
    expect(objectIdFrom(refFor(id))).toBe(id);
  });

  it("mints unguessable ids", () => {
    // §7.5.4: possession of a ref IS the read capability, so a predictable id
    // is a public store with extra steps.
    const ids = new Set(Array.from({ length: 200 }, () => mintObjectId()));
    expect(ids.size).toBe(200);
    expect(mintObjectId().length).toBeGreaterThanOrEqual(16);
  });

  it("refuses a ref that is not ours", () => {
    expect(objectIdFrom("mesh:rooms:abc/drive/def")).toBeNull();
    expect(objectIdFrom("https://example.com/x")).toBeNull();
    expect(objectIdFrom(42)).toBeNull();
  });

  it("refuses an id that could become a path", () => {
    // The id reaches a storage key; a `/` or a `..` from the wire must never
    // become a directory traversal.
    expect(objectIdFrom("mesh:artifacts:../../etc/passwd")).toBeNull();
    expect(objectIdFrom("mesh:artifacts:a/b")).toBeNull();
    expect(objectIdFrom("mesh:artifacts:short")).toBeNull();
  });

  it("does not put the owner in the ref", () => {
    // §18.5: a ref gets forwarded, so anything encoded in it is disclosed to
    // everyone it reaches. The storage KEY has the owner; the reference does not.
    expect(refFor("abcdefghijklmnop")).not.toContain(OWNER);
  });
});

describe("digests", () => {
  it("uses the same sha256:<hex> shape as the rooms drive", () => {
    expect(digestOf(new Uint8Array([1, 2, 3]))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("retention (§7.5.2)", () => {
  const now = Date.UTC(2026, 0, 1);

  it("defaults to the task window plus grace when nothing is asked for", () => {
    const expires = Date.parse(retentionFor(undefined, now));
    expect(expires - now).toBe(ARTIFACT_CONFIG.defaultRetentionMs);
  });

  it("honours a declared retention", () => {
    expect(Date.parse(retentionFor(30, now)) - now).toBe(30 * 86_400_000);
  });

  it("clamps a declaration beyond the cap rather than refusing it", () => {
    // The write is legitimate; the caller learns the real expiry in the reply.
    expect(Date.parse(retentionFor(9_999, now)) - now).toBe(ARTIFACT_CONFIG.maxRetentionMs);
  });

  it("ignores nonsense and falls back to the default", () => {
    for (const bad of [0, -5, NaN, "forever", null]) {
      expect(Date.parse(retentionFor(bad, now)) - now).toBe(ARTIFACT_CONFIG.defaultRetentionMs);
    }
  });
});

describe("usage", () => {
  const rec = (over: Partial<ArtifactRecord>): ArtifactRecord =>
    ({ id: "i", owner: OWNER, agent: AGENT, media_type: "x", size: 10, digest: "d", created_at: "", expires_at: "", ...over }) as ArtifactRecord;

  it("counts only this owner's live objects", () => {
    const all = [rec({}), rec({ owner: "UOTHER" }), rec({ gone: true })];
    expect(usageOf(all, OWNER)).toEqual({ bytes: 10, objects: 1 });
  });
});

describe("ArtifactStore", () => {
  let store: ArtifactStore;
  let blobs: ReturnType<typeof fakeBlobs>;

  beforeEach(() => {
    blobs = fakeBlobs();
    store = ArtifactStore.forTest(fakeKv(), blobs);
  });

  it("stores bytes and returns a usable reference", async () => {
    const result = await store.put({ owner: OWNER, agent: AGENT, bytes: bytes(64), media_type: "application/pdf", name: "r.pdf" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.digest).toBe(digestOf(bytes(64)));
    expect(result.record.size).toBe(64);
    expect(result.record.name).toBe("r.pdf");
    const fetched = await store.fetch(refFor(result.record.id));
    expect(fetched.ok).toBe(true);
  });

  it("refuses a write it cannot attribute", async () => {
    // §7.5.2: nothing is ever stored anonymously.
    expect(await store.put({ owner: "", agent: AGENT, bytes: bytes(4) })).toMatchObject({ ok: false, code: "INVALID" });
    expect(await store.put({ owner: OWNER, agent: "", bytes: bytes(4) })).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("refuses an object over the per-object limit", async () => {
    const big = new Uint8Array(ARTIFACT_CONFIG.maxBytes + 1);
    const result = await store.put({ owner: OWNER, agent: AGENT, bytes: big });
    expect(result).toMatchObject({ ok: false, code: "TOO_LARGE" });
  });

  it("refuses a write past the owner's byte quota, naming the limit", async () => {
    const store2 = ArtifactStore.forTest(fakeKv(), fakeBlobs());
    // Fill to just under the ceiling with one object, then try to exceed it.
    const chunk = ARTIFACT_CONFIG.maxBytes;
    const needed = Math.ceil(ARTIFACT_CONFIG.maxBytesPerOwner / chunk);
    for (let i = 0; i < needed; i++) {
      await store2.put({ owner: OWNER, agent: AGENT, bytes: new Uint8Array(chunk) });
    }
    const result = await store2.put({ owner: OWNER, agent: AGENT, bytes: bytes(1024) });
    expect(result).toMatchObject({ ok: false, code: "QUOTA_EXCEEDED" });
    if (!result.ok) expect(result.message).toContain(String(ARTIFACT_CONFIG.maxBytesPerOwner));
  });

  it("keeps one owner's usage out of another's quota", async () => {
    await store.put({ owner: OWNER, agent: AGENT, bytes: bytes(1000) });
    expect(store.usage(OWNER).bytes).toBe(1000);
    expect(store.usage("UOTHER").bytes).toBe(0);
  });

  it("refuses zero bytes rather than storing an empty object", async () => {
    expect(await store.put({ owner: OWNER, agent: AGENT, bytes: new Uint8Array(0) })).toMatchObject({
      ok: false,
      code: "INVALID",
    });
  });

  it("answers NOT_FOUND for a reference that was never here", async () => {
    expect(await store.fetch(refFor("aaaaaaaaaaaaaaaaaaaa"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await store.fetch("not-a-ref")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("answers GONE — not NOT_FOUND — once the bytes are reclaimed", async () => {
    // The distinction that keeps an old task record readable: "this expired"
    // and "this never existed" are different facts about a deliverable.
    const put = await store.put({ owner: OWNER, agent: AGENT, bytes: bytes(32), retain_days: 1 });
    if (!put.ok) throw new Error("setup failed");
    const reclaimed = await store.sweep(Date.now() + 2 * 86_400_000);
    expect(reclaimed).toBe(1);
    const result = await store.fetch(refFor(put.record.id));
    expect(result).toMatchObject({ ok: false, code: "GONE" });
    if (result.ok || result.code !== "GONE") return;
    // The reference stays truthful about what it WAS.
    expect(result.record.size).toBe(32);
    expect(result.record.digest).toBe(digestOf(bytes(32)));
  });

  it("does not reclaim anything still inside its window", async () => {
    await store.put({ owner: OWNER, agent: AGENT, bytes: bytes(8) });
    expect(await store.sweep(Date.now())).toBe(0);
  });

  it("frees quota when an artifact is reclaimed", async () => {
    await store.put({ owner: OWNER, agent: AGENT, bytes: bytes(5000), retain_days: 1 });
    expect(store.usage(OWNER).bytes).toBe(5000);
    await store.sweep(Date.now() + 2 * 86_400_000);
    expect(store.usage(OWNER).bytes).toBe(0);
  });

  it("lets the owner delete, and nobody else", async () => {
    // §7.5.4: holding a ref lets you READ. A forwarded reference must not be a
    // delete button handed to everyone it reached.
    const put = await store.put({ owner: OWNER, agent: AGENT, bytes: bytes(16) });
    if (!put.ok) throw new Error("setup failed");
    const ref = refFor(put.record.id);
    expect(await store.remove(ref, "USOMEONEELSE")).toBe("forbidden");
    expect(await store.remove(ref, OWNER)).toBe("removed");
    expect(await store.fetch(ref)).toMatchObject({ ok: false, code: "GONE" });
  });

  it("self-corrects an index that claims bytes the store does not have", async () => {
    const put = await store.put({ owner: OWNER, agent: AGENT, bytes: bytes(16) });
    if (!put.ok) throw new Error("setup failed");
    blobs.objects.clear();
    const result = await store.fetch(refFor(put.record.id));
    expect(result).toMatchObject({ ok: false, code: "GONE" });
    // And the index now agrees, rather than failing this way forever.
    expect(store.stat(refFor(put.record.id))?.gone).toBe(true);
  });

  it("reports usage against the published limits", async () => {
    await store.put({ owner: OWNER, agent: AGENT, bytes: bytes(100) });
    expect(store.usage(OWNER)).toEqual({
      bytes: 100,
      objects: 1,
      max_bytes: ARTIFACT_CONFIG.maxBytesPerOwner,
      max_objects: ARTIFACT_CONFIG.maxObjectsPerOwner,
    });
  });

  it("stores under an owner-scoped key so a per-owner sweep is one prefix", async () => {
    const put = await store.put({ owner: OWNER, agent: AGENT, bytes: bytes(8) });
    if (!put.ok) throw new Error("setup failed");
    expect([...blobs.objects.keys()][0]).toBe(`${OWNER}/${put.record.id}`);
  });

  it("defaults an unstated media type rather than guessing one", async () => {
    const put = await store.put({ owner: OWNER, agent: AGENT, bytes: bytes(8) });
    if (!put.ok) throw new Error("setup failed");
    expect(put.record.media_type).toBe("application/octet-stream");
  });
});
