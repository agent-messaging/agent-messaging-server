/**
 * The admission roster's own door (admission/roster-door.ts, EXT-6 §7): a
 * roster is stored only when it is signed by the owner key it is stored
 * under, and anyone may read one back.
 */
import { describe, it, expect } from "vitest";
import { canonicalJSON, nkeys } from "../../src/sdk.js";
import { rosterDoor } from "../../src/admission/roster-door.js";
import { ADMISSION_ROSTER_SIG_PREFIX } from "../../src/sdk.js";
import { verifyRoster } from "../../src/admission/admission-store.js";

function signed(kp: ReturnType<typeof nkeys.createUser>, over: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    admission: "v1",
    owner_key: kp.getPublicKey(),
    defaults: { registered: "hold", anonymous: "block" },
    entries: [],
    updated_at: "2026-10-13T12:00:00.000Z",
    ...over,
  };
  const sig = kp.sign(new TextEncoder().encode(ADMISSION_ROSTER_SIG_PREFIX + canonicalJSON(body)));
  return { ...body, sig: Buffer.from(sig).toString("base64") };
}

function memoryStore() {
  const kept = new Map<string, Record<string, unknown>>();
  return {
    kept,
    async get(owner: string) { return kept.get(owner) ?? null; },
    async put(owner: string, roster: Record<string, unknown>) {
      if (roster.owner_key !== owner || !verifyRoster(roster)) return false;
      kept.set(owner, roster);
      return true;
    },
  };
}

describe("PUT and GET /v1/rosters/:owner", () => {
  it("stores a roster its owner key signed, and serves it back as signed", async () => {
    const kp = nkeys.createUser();
    const store = memoryStore();
    const door = rosterDoor(store);
    const roster = signed(kp);
    const put = await door("PUT", `/v1/rosters/${kp.getPublicKey()}`, async () => roster);
    expect(put).toEqual({ status: 200, body: { stored: true } });
    const got = await door("GET", `/v1/rosters/${kp.getPublicKey()}`, async () => null);
    expect(got?.status).toBe(200);
    expect(got?.body).toEqual(roster);
  });

  it("refuses a roster signed by another key, and one stored under another key", async () => {
    const owner = nkeys.createUser();
    const other = nkeys.createUser();
    const door = rosterDoor(memoryStore());
    const forged = { ...signed(other), owner_key: owner.getPublicKey() };
    expect((await door("PUT", `/v1/rosters/${owner.getPublicKey()}`, async () => forged))?.status).toBe(400);
    expect((await door("PUT", `/v1/rosters/${owner.getPublicKey()}`, async () => signed(other)))?.status).toBe(400);
  });

  it("refuses an edited roster whose signature no longer covers it", async () => {
    const kp = nkeys.createUser();
    const door = rosterDoor(memoryStore());
    const edited = { ...signed(kp), entries: [{ subject: "UANYONE", stance: "allow" }] };
    expect((await door("PUT", `/v1/rosters/${kp.getPublicKey()}`, async () => edited))?.status).toBe(400);
  });

  it("answers 404 for a key with no roster, 400 for a malformed key, and leaves other paths alone", async () => {
    const door = rosterDoor(memoryStore());
    expect((await door("GET", `/v1/rosters/${nkeys.createUser().getPublicKey()}`, async () => null))?.status).toBe(404);
    expect((await door("GET", "/v1/rosters/not-a-key", async () => null))?.status).toBe(400);
    expect(await door("GET", "/v1/capabilities", async () => null)).toBeNull();
  });

  it("limits writes for one key", async () => {
    const kp = nkeys.createUser();
    const door = rosterDoor(memoryStore());
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await door("PUT", `/v1/rosters/${kp.getPublicKey()}`, async () => signed(kp)))!.status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });
});
