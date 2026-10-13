// HeldStore keeps a parsed copy of mesh_held and applies its own writes to it,
// instead of reading the whole bucket every few seconds (2026-09-28: 594
// entries re-read every 5 s made 119 KV reads a second on the platform).
import { describe, it, expect, vi, afterEach } from "vitest";
import { HeldStore } from "../../src/admission/held-store.js";
import { fakeJs, forbiddenKeys } from "../helpers/fake-kv.js";

const A1 = "U" + "A".repeat(55);
const A2 = "U" + "B".repeat(55);
const S1 = "U" + "C".repeat(55);
const S2 = "U" + "D".repeat(55);

function bucket() {
  const h = fakeJs();
  const store = new Map<string, string>();
  const kv = {
    put: vi.fn(async (k: string, v: string) => { store.set(k, v); return 1; }),
    get: vi.fn(async (k: string) => {
      const v = store.get(k);
      if (v === undefined) return null;
      return { key: k, operation: "PUT" as const, value: new TextEncoder().encode(v), length: v.length, revision: 1, json: <T>() => JSON.parse(v) as T, string: () => v };
    }),
    purge: vi.fn(async (k: string) => { store.delete(k); }),
    delete: vi.fn(async () => undefined),
    keys: forbiddenKeys(),
    status: h.bucket("mesh_held", () => [...store.keys()]),
  };
  return { h, kv, store };
}

afterEach(() => { vi.useRealTimers(); });

describe("HeldStore's copy of mesh_held", () => {
  it("reads the bucket once for many polls, not once per poll", async () => {
    const { h, kv } = bucket();
    const held = new HeldStore(kv as never, h.js as never);
    await held.report(A1, S1, null, null);
    await held.report(A2, S2, null, null);
    await held.listWaiting(A1);
    const reads = h.info.mock.calls.length;
    for (let i = 0; i < 50; i++) {
      await held.listWaiting(A1);
      await held.decisions(A2);
    }
    expect(h.info.mock.calls.length).toBe(reads);
  });

  it("shows its own writes at once", async () => {
    const { h, kv } = bucket();
    const held = new HeldStore(kv as never, h.js as never);
    expect(await held.listWaiting(A1)).toEqual([]);
    await held.report(A1, S1, "scout.ann@example.com", "Ann");
    expect((await held.listWaiting(A1)).map((e) => e.sender)).toEqual([S1]);

    await held.decide(A1, S1, "allow");
    expect(await held.listWaiting(A1)).toEqual([]);
    expect((await held.decisions(A1))[0].decision?.stance).toBe("allow");

    await held.resolve(A1, S1);
    expect(await held.decisions(A1)).toEqual([]);
    expect(await held.allWaiting()).toEqual([]);
  });

  it("keeps a write made while a read of the bucket was in flight", async () => {
    const { h, kv, store } = bucket();
    const held = new HeldStore(kv as never, h.js as never);
    store.set(`${A1}.${S1}`, JSON.stringify({ agent: A1, sender: S1, handle: null, operator: null, first_at: new Date().toISOString(), last_at: new Date().toISOString(), count: 1 }));
    // Hold the read at the subject listing, write, then let the read finish.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realInfo = h.info.getMockImplementation()!;
    h.info.mockImplementationOnce(async (...a: Parameters<typeof realInfo>) => { const out = await realInfo(...a); await gate; return out; });
    const first = held.listWaiting(A1);
    await new Promise((r) => setTimeout(r, 5));
    await held.report(A1, S2, null, null);
    release();
    // The in-flight read listed only S1's subject; S2 was written after.
    const got = (await first).map((e) => e.sender).sort();
    expect(got).toContain(S1);
    expect((await held.listWaiting(A1)).map((e) => e.sender).sort()).toEqual([S1, S2].sort());
  });

  it("reads the bucket again after a minute, which picks up a write made elsewhere", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { h, kv, store } = bucket();
    const held = new HeldStore(kv as never, h.js as never);
    expect(await held.listWaiting(A1)).toEqual([]);
    const now = new Date().toISOString();
    store.set(`${A1}.${S1}`, JSON.stringify({ agent: A1, sender: S1, handle: null, operator: null, first_at: now, last_at: now, count: 1 }));
    expect(await held.listWaiting(A1)).toEqual([]);
    vi.setSystemTime(Date.now() + 61_000);
    // The stale copy is served while the re-read runs in the background.
    await held.listWaiting(A1);
    await new Promise((r) => setTimeout(r, 5));
    expect((await held.listWaiting(A1)).map((e) => e.sender)).toEqual([S1]);
  });

  it("a failed re-read keeps the copy it had", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { h, kv } = bucket();
    const held = new HeldStore(kv as never, h.js as never);
    await held.report(A1, S1, null, null);
    expect((await held.listWaiting(A1)).length).toBe(1);
    vi.setSystemTime(Date.now() + 61_000);
    h.info.mockRejectedValueOnce(new Error("no responders"));
    expect((await held.listWaiting(A1)).length).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    expect((await held.listWaiting(A1)).length).toBe(1);
  });

  it("closure reads the bucket fresh, not from the copy", async () => {
    const { h, kv, store } = bucket();
    const held = new HeldStore(kv as never, h.js as never);
    expect(await held.listWaiting(A1)).toEqual([]);
    const now = new Date().toISOString();
    store.set(`${A1}.${S1}`, JSON.stringify({ agent: A1, sender: S1, handle: null, operator: null, first_at: now, last_at: now, count: 1 }));
    expect(await held.purgeAgent(A1)).toBe(1);
    expect(store.size).toBe(0);
  });

  it("hands out copies, so a caller cannot change the store's copy", async () => {
    const { h, kv } = bucket();
    const held = new HeldStore(kv as never, h.js as never);
    await held.report(A1, S1, null, null);
    const [e] = await held.listWaiting(A1);
    e.count = 99;
    e.decision = { stance: "block", decided_at: "x" };
    const [again] = await held.listWaiting(A1);
    expect(again.count).toBe(1);
    expect(again.decision).toBeUndefined();
  });

  it("the first read still throws when the bucket cannot be read whole", async () => {
    const { h, kv } = bucket();
    const held = new HeldStore(kv as never, h.js as never);
    h.info.mockRejectedValueOnce(new Error("no responders for $JS.API.STREAM.INFO"));
    await expect(held.allWaiting()).rejects.toThrow(/no responders/);
  });
});
