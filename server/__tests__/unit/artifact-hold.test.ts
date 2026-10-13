// Keep fixes the 90-day loss (2026-09-25): a file a published page shows is
// held past the sweep while the page is up, and let go when it is not.
//
// What is pinned:
//  - only the owner may hold or release, and a hold is a lease the sweep
//    honours whatever the file's own date says;
//  - a hold nobody renews runs out by itself, so a page removed without a
//    release, or an account that closed, never keeps a file for ever;
//  - release puts a file back on its own date, never sooner than the default
//    retention from now, so letting go never deletes on the spot;
//  - `mesh.artifacts.hold` answers the ref, the date and the hold, stat
//    reports the hold, and every credential the platform mints may ask it.
import { describe, it, expect, beforeEach } from "vitest";
import type { KV } from "nats";
import { ArtifactStore, ARTIFACT_CONFIG, reclaimAt, refFor, type ArtifactRecord } from "../../src/artifacts/artifact-store.js";
import { ArtifactsService, ArtifactSubjects } from "../../src/artifacts/artifacts-service.js";
import { durableAgentPermissions, jobWorkerPermissions } from "../../src/keychain/cred-template.js";
import type { BlobStore } from "../../src/storage/blobs.js";
import { createEnvelope, type Envelope } from "../../src/sdk.js";

const OWNER = "UACCOUNTOWNER";
const OTHER = "UOTHEROWNER";
const HOSTED = "UHOSTED";
const STRANGER = "USTRANGER";
const DAY = 86_400_000;

function blobs(): BlobStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    kind: "gcs:test-bucket",
    objects,
    async put(key, b) { objects.set(key, b); },
    async get(key) { return objects.get(key) ?? null; },
    async del(key) { objects.delete(key); },
    async delPrefix() {},
  };
}

function fakeKv(): KV & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async put(key: string, value: Uint8Array) { rows.set(key, new TextDecoder().decode(value)); return 1; },
    async delete(key: string) { rows.delete(key); },
  } as unknown as KV & { rows: Map<string, string> };
}

const VIDEO = "VideoObjectId00000001";
const POSTER = "PosterObjectId0000001";
const THEIRS = "TheirsObjectId0000001";

function rec(id: string, owner: string, expiresInDays: number, over: Partial<ArtifactRecord> = {}): ArtifactRecord {
  const now = Date.now();
  return {
    id, owner, agent: HOSTED, media_type: "video/mp4", name: `${id}.mp4`, size: 10,
    digest: `sha256:${"0".repeat(64)}`, created_at: new Date(now - 80 * DAY).toISOString(),
    expires_at: new Date(now + expiresInDays * DAY).toISOString(), store: "gcs", ...over,
  };
}

describe("holding a file while a page shows it", () => {
  let kv: ReturnType<typeof fakeKv>;
  let b: ReturnType<typeof blobs>;
  let store: ArtifactStore;

  beforeEach(() => {
    kv = fakeKv();
    b = blobs();
    for (const [id, owner] of [[VIDEO, OWNER], [POSTER, OWNER], [THEIRS, OTHER]] as const) b.objects.set(`${owner}/${id}`, new Uint8Array(10));
    store = ArtifactStore.forTest(kv, b, undefined, [rec(VIDEO, OWNER, 10), rec(POSTER, OWNER, 10), rec(THEIRS, OTHER, 10)]);
  });

  it("keeps a held file past its own date, and the sweep takes it once the hold runs out", async () => {
    const now = Date.now();
    const held = await store.hold(refFor(VIDEO), OWNER, true, now);
    if (!held.ok) throw new Error("expected a hold");
    expect(Date.parse(held.record.held_until!) - now).toBe(ARTIFACT_CONFIG.holdMs);
    expect(JSON.parse(kv.rows.get(VIDEO)!).held_until).toBe(held.record.held_until);

    // Past the file's own date (10 days) and inside the hold: kept.
    expect(await store.sweep(now + 30 * DAY)).toBe(2); // the poster and the other owner's file, not held, go
    expect(store.stat(refFor(VIDEO))?.gone).toBeUndefined();
    expect(b.objects.has(`${OWNER}/${VIDEO}`)).toBe(true);
    expect(store.stat(refFor(POSTER))?.gone).toBe(true);

    // Nobody renewed it: past the hold, it goes like any other file.
    expect(await store.sweep(now + ARTIFACT_CONFIG.holdMs + DAY)).toBe(1);
    expect(store.stat(refFor(VIDEO))?.gone).toBe(true);
  });

  it("renews: asking again moves the end of the hold", async () => {
    const t0 = Date.now();
    await store.hold(refFor(VIDEO), OWNER, true, t0);
    const again = await store.hold(refFor(VIDEO), OWNER, true, t0 + 40 * DAY);
    if (!again.ok) throw new Error("expected a hold");
    expect(Date.parse(again.record.held_until!)).toBe(t0 + 40 * DAY + ARTIFACT_CONFIG.holdMs);
    expect(reclaimAt(again.record)).toBe(again.record.held_until);
  });

  it("release puts the file back on its own date, never sooner than the default retention from now", async () => {
    const t0 = Date.now();
    await store.hold(refFor(VIDEO), OWNER, true, t0);
    // Its own date (10 days) passed while it was held: it gets the default from the release.
    const later = t0 + 50 * DAY;
    const let_go = await store.hold(refFor(VIDEO), OWNER, false, later);
    if (!let_go.ok) throw new Error("expected a release");
    expect(let_go.record.held_until).toBeUndefined();
    expect(Date.parse(let_go.record.expires_at)).toBe(later + ARTIFACT_CONFIG.defaultRetentionMs);
    expect(await store.sweep(later + DAY)).toBe(2); // the two files nobody held, not the video
    expect(store.stat(refFor(VIDEO))?.gone).toBeUndefined();
    expect(await store.sweep(later + ARTIFACT_CONFIG.defaultRetentionMs + DAY)).toBe(1);
    expect(store.stat(refFor(VIDEO))?.gone).toBe(true);
  });

  it("release keeps a later date of the file's own", async () => {
    store = ArtifactStore.forTest(kv, b, undefined, [rec(VIDEO, OWNER, 80)]);
    const t0 = Date.now();
    await store.hold(refFor(VIDEO), OWNER, true, t0);
    const let_go = await store.hold(refFor(VIDEO), OWNER, false, t0);
    if (!let_go.ok) throw new Error("expected a release");
    expect(Math.round((Date.parse(let_go.record.expires_at) - t0) / DAY)).toBe(80);
  });

  it("only the owner may hold or release, and a gone or unknown file is said so", async () => {
    expect(await store.hold(refFor(THEIRS), OWNER, true)).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(await store.hold(refFor("NoSuchObjectId000001"), OWNER, true)).toEqual({ ok: false, code: "NOT_FOUND" });
    await store.remove(refFor(POSTER), OWNER);
    expect(await store.hold(refFor(POSTER), OWNER, true)).toMatchObject({ ok: false, code: "GONE" });
    expect(store.stat(refFor(THEIRS))?.held_until).toBeUndefined();
  });
});

// ── the service ─────────────────────────────────────────────────────────────

interface Handlers {
  handleHold(env: Envelope): Promise<Envelope>;
  handleStat(env: Envelope): Promise<Envelope>;
}

function service(store: ArtifactStore): Handlers {
  const svc = Object.create(ArtifactsService.prototype) as Handlers;
  const now = Date.now();
  Object.assign(svc, {
    kp: "USERVICE",
    store,
    registry: null,
    nc: { info: { max_payload: 1024 * 1024 }, request: async () => { throw new Error("no registry here"); } },
    owners: new Map([[HOSTED, { at: now, owner: OWNER }], [STRANGER, { at: now, owner: OTHER }]]),
  });
  return svc;
}

const req = (from: string, payload: unknown): Envelope => createEnvelope({ type: "request", from, payload });

describe("mesh.artifacts.hold", () => {
  it("is its own subject, and every credential the platform mints may ask it", () => {
    expect(ArtifactSubjects.HOLD).toBe("mesh.artifacts.hold");
    expect(durableAgentPermissions("UAGENTKEY").pub.allow).toContain("mesh.artifacts.hold");
    expect(jobWorkerPermissions("UAGENTKEY").pub.allow).toContain("mesh.artifacts.hold");
  });

  it("answers the ref, its date and the hold; stat reports the hold; release answers null", async () => {
    const b = blobs();
    b.objects.set(`${OWNER}/${VIDEO}`, new Uint8Array(10));
    const store = ArtifactStore.forTest(fakeKv(), b, undefined, [rec(VIDEO, OWNER, 10)]);
    const svc = service(store);
    const held = await svc.handleHold(req(HOSTED, { ref: refFor(VIDEO) }));
    expect(held.error).toBeUndefined();
    const p = held.payload as { ref: string; expires_at: string; held_until: string | null };
    expect(p.ref).toBe(refFor(VIDEO));
    expect(typeof p.held_until).toBe("string");
    const st = (await svc.handleStat(req(HOSTED, { ref: refFor(VIDEO) }))).payload as Record<string, unknown>;
    expect(st.held_until).toBe(p.held_until);
    const let_go = await svc.handleHold(req(HOSTED, { ref: refFor(VIDEO), release: true }));
    expect((let_go.payload as { held_until: unknown }).held_until).toBeNull();
    const after = (await svc.handleStat(req(HOSTED, { ref: refFor(VIDEO) }))).payload as Record<string, unknown>;
    expect("held_until" in after).toBe(false);
  });

  it("refuses anybody but the owner in words", async () => {
    const b = blobs();
    const store = ArtifactStore.forTest(fakeKv(), b, undefined, [rec(VIDEO, OWNER, 10)]);
    const got = await service(store).handleHold(req(STRANGER, { ref: refFor(VIDEO) }));
    expect(got.error?.code).toBe("UNAUTHORIZED");
    expect(got.error?.message).toMatch(/another owner/);
    expect(store.stat(refFor(VIDEO))?.held_until).toBeUndefined();
  });
});
