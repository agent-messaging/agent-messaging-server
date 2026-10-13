// MESH_REQUIRE_NAMES (shared/require-names.ts, docs/no-anonymous-agents-plan.md
// item 6): the setting read by exact name, the reverse lookup and its cache,
// the would-refuse log (names and key prefixes only, once a day), the door
// helper in both positions, and the registry refusing an unnamed agent while
// letting a sandbox-confined one through.
import { describe, it, expect, vi } from "vitest";
import type { KV, NatsConnection } from "nats";
import {
  requireNamesOn,
  isStandardShape,
  makeNameLookup,
  WouldRefuseLog,
  namesAtDoor,
  unnamedStrangerRefusal,
  namesUncheckedRefusal,
  REQUIRE_NAMES_SETTING,
  type NameAnswer,
} from "../../src/shared/require-names.js";
import { NAMING_STANDARD, UNNAMED_AGENT_CODE } from "../../src/shared/naming-words.js";
import { handleRegister } from "../../src/registry/handlers/register.js";
import { PresenceStore } from "../../src/registry/presence-store.js";
import { NodeProfileStore } from "../../src/registry/node-profile-store.js";
import { createEnvelope, createAttestation, nkeys, type Manifest } from "../../src/sdk.js";

const KEY = `U${"A".repeat(55)}`;

describe("the setting", () => {
  it("is read by its exact name and only \"on\" turns it on", async () => {
    const asked: string[] = [];
    const read = (v: string | undefined) => async (k: string) => { asked.push(k); return v; };
    expect(await requireNamesOn(read("on"))).toBe(true);
    expect(await requireNamesOn(read(" on "))).toBe(true);
    for (const v of [undefined, "", "off", "ON", "1", "true"]) expect(await requireNamesOn(read(v))).toBe(false);
    expect(new Set(asked)).toEqual(new Set([REQUIRE_NAMES_SETTING]));
    expect(REQUIRE_NAMES_SETTING).toBe("MESH_REQUIRE_NAMES");
  });

  it("a read that throws is off, never on", async () => {
    expect(await requireNamesOn(async () => { throw new Error("kv down"); })).toBe(false);
  });
});

describe("the handle shape", () => {
  it("is the agent's name, a dot, and an email", () => {
    for (const h of ["genesis.stephen@example.com", "help.system@agentmesh.ai", "codex.test@agentmesh.ai"]) expect(isStandardShape(h)).toBe(true);
    for (const h of ["", "genesis", "stephen@example.com", "web-01a0cc54", null, 7]) expect(isStandardShape(h)).toBe(false);
  });
});

function fakePan(answers: Record<string, { status: number; card?: unknown }>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const key = new URL(url).searchParams.get("agent_id")!;
    calls.push(key);
    const a = answers[key] ?? { status: 404 };
    if (a.status === 0) throw new Error("connection refused");
    return new Response(JSON.stringify(a.card ? { card: a.card } : {}), { status: a.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const card = (key: string, handle: string) => ({ handle, endpoints: [{ protocol: "agentmesh", agent_id: key }] });

describe("the reverse lookup", () => {
  it("named, unnamed, unbound and unreachable", async () => {
    const K2 = `U${"B".repeat(55)}`, K3 = `U${"C".repeat(55)}`, K4 = `U${"D".repeat(55)}`, K5 = `U${"E".repeat(55)}`;
    const { fetchImpl } = fakePan({
      [KEY]: { status: 200, card: card(KEY, "genesis.stephen@example.com") },
      [K2]: { status: 404 },
      [K3]: { status: 200, card: card(K2, "someone.else@example.com") }, // a card for another key
      [K4]: { status: 503 },
      [K5]: { status: 0 },
    });
    const lookup = makeNameLookup({ base: "http://pan.test", fetchImpl });
    expect(await lookup(KEY)).toEqual({ status: "named", handle: "genesis.stephen@example.com" });
    expect(await lookup(K2)).toEqual({ status: "unnamed", handle: null });
    expect((await lookup(K3)).status).toBe("unnamed");
    expect(await lookup(K4)).toEqual({ status: "unreachable" });
    expect(await lookup(K5)).toEqual({ status: "unreachable" });
  });

  it("keeps a name for hours and no-name for minutes, never keeps unreachable, and forgets on request", async () => {
    let t = 0;
    const answers: Record<string, { status: number; card?: unknown }> = { [KEY]: { status: 404 } };
    const { fetchImpl, calls } = fakePan(answers);
    const lookup = makeNameLookup({ base: "http://pan.test", fetchImpl, now: () => t });
    await lookup(KEY); await lookup(KEY);
    expect(calls.length).toBe(1);
    t += 10 * 60_000;
    answers[KEY] = { status: 200, card: card(KEY, "genesis.stephen@example.com") };
    expect((await lookup(KEY)).status).toBe("named");
    t += 5 * 3600_000;
    await lookup(KEY);
    expect(calls.length).toBe(2);
    lookup.forget(KEY);
    await lookup(KEY);
    expect(calls.length).toBe(3);
    answers[KEY] = { status: 503 };
    lookup.forget(KEY);
    await lookup(KEY); await lookup(KEY);
    expect(calls.length).toBe(5);
  });
});

describe("the would-refuse log", () => {
  it("once per door per agent per day, names and key prefixes only", () => {
    let t = Date.parse("2026-09-27T10:00:00Z");
    const lines: string[] = [];
    const log = new WouldRefuseLog(() => t, (l) => lines.push(l));
    expect(log.note("registry", KEY, "Transform helper", "no verified name")).toBe(true);
    expect(log.note("registry", KEY, "Transform helper", "no verified name")).toBe(false);
    expect(log.notedToday("registry", KEY)).toBe(true);
    expect(log.note("node-credential", KEY, "Transform helper", "no verified name")).toBe(true);
    t += 24 * 3600_000;
    expect(log.notedToday("registry", KEY)).toBe(false);
    expect(log.note("registry", KEY, null, "no verified name")).toBe(true);
    expect(lines.length).toBe(3);
    for (const l of lines) {
      expect(l).toContain(REQUIRE_NAMES_SETTING);
      expect(l).toContain(KEY.slice(0, 12));
      expect(l).not.toContain(KEY);
    }
    expect(lines[0]).toContain("Transform helper");
    expect(lines[2]).toContain("(no name)");
    expect(log.list().map((e) => e.key_prefix)).toEqual([KEY.slice(0, 12), KEY.slice(0, 12), KEY.slice(0, 12)]);
  });
});

function scripted(map: Record<string, NameAnswer>) {
  const calls: string[] = [];
  const lookup = Object.assign(async (k: string) => { calls.push(k); return map[k] ?? { status: "unnamed" as const, handle: null }; }, { forget: () => {} });
  return { lookup, calls };
}

describe("a door", () => {
  const NAMED = `U${"N".repeat(55)}`, BARE = `U${"B".repeat(55)}`, DOWN = `U${"D".repeat(55)}`;
  const answers: Record<string, NameAnswer> = {
    [NAMED]: { status: "named", handle: "genesis.stephen@example.com" },
    [BARE]: { status: "unnamed", handle: null },
    [DOWN]: { status: "unreachable" },
  };

  it("off: everyone passes at once, and the unnamed are logged in the background", async () => {
    const { lookup } = scripted(answers);
    const lines: string[] = [];
    const log = new WouldRefuseLog(Date.now, (l) => lines.push(l));
    const r = await namesAtDoor("node-credential", [NAMED, BARE, DOWN], { on: false, lookup, log, labelOf: (k) => (k === BARE ? "Copywriter" : null) });
    expect(r).toEqual({ on: false, pass: [NAMED, BARE, DOWN], unnamed: [], unreachable: [] });
    await vi.waitFor(() => expect(lines.length).toBe(1));
    expect(lines[0]).toContain("Copywriter");
  });

  it("off: a key already noted today is not looked up again", async () => {
    const { lookup, calls } = scripted(answers);
    const log = new WouldRefuseLog(Date.now, () => {});
    log.note("registry", BARE, "x", "y");
    await namesAtDoor("registry", [BARE], { on: false, lookup, log });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
  });

  it("on: only the named pass", async () => {
    const { lookup } = scripted(answers);
    const r = await namesAtDoor("job-credential", [NAMED, BARE, DOWN], { on: true, lookup, log: new WouldRefuseLog(Date.now, () => {}) });
    expect(r).toEqual({ on: true, pass: [NAMED], unnamed: [BARE], unreachable: [DOWN] });
  });

  it("the refusals open with the standard and carry the code, or say to try again", () => {
    const s = unnamedStrangerRefusal();
    expect(s.error.startsWith(NAMING_STANDARD)).toBe(true);
    expect(s.code).toBe(UNNAMED_AGENT_CODE);
    expect(namesUncheckedRefusal().error).toMatch(/Try again/);
    for (const w of [s.error, namesUncheckedRefusal().error]) expect(w).not.toMatch(/—/);
  });
});

// ── the registry ─────────────────────────────────────────────────────────────

function memKv(): KV {
  const m = new Map<string, Uint8Array>();
  return {
    get: async (k: string) => (m.has(k) ? { value: m.get(k)! } : null),
    put: async (k: string, v: Uint8Array) => { m.set(k, v); return 1; },
  } as unknown as KV;
}
const nc = { publish: () => {} } as unknown as NatsConnection;

function registration(opts: { sandboxNode?: boolean } = {}) {
  const agent = nkeys.createUser();
  const node = agent;
  const manifest = {
    id: agent.getPublicKey(),
    name: "c10-guest",
    endpoint: `mesh.agent.${agent.getPublicKey()}.inbox`,
    node: { id: node.getPublicKey(), attestation: createAttestation(node, agent.getPublicKey(), 3_600_000) },
  } as unknown as Manifest;
  const env = createEnvelope({ type: "register", from: agent.getPublicKey(), payload: manifest });
  const profiles = new NodeProfileStore();
  if (opts.sandboxNode) profiles.seedAttested(new Map([[node.getPublicKey(), { trust_tier: "sandbox" as const }]]));
  return { env, profiles, key: agent.getPublicKey() };
}

describe("the registry (SPEC §6.2)", () => {
  const serviceId = nkeys.createUser();

  it("setting on: refuses an agent with no verified name, in the words, with the code", async () => {
    const { env, profiles, key } = registration();
    const { lookup } = scripted({ [key]: { status: "unnamed", handle: null } });
    const out = await handleRegister(env, memKv(), nc, serviceId as never, new Map(), new PresenceStore(), profiles, undefined, undefined, { on: async () => true, lookup });
    expect(out.error?.code).toBe("UNAUTHORIZED");
    expect(out.error?.message.startsWith(NAMING_STANDARD)).toBe(true);
    expect(out.error?.details).toEqual({ reason: UNNAMED_AGENT_CODE });
    expect(out.error?.retryable).toBe(false);
  });

  it("setting on: a naming service that does not answer is not a yes, and says try again", async () => {
    const { env, profiles, key } = registration();
    const { lookup } = scripted({ [key]: { status: "unreachable" } });
    const out = await handleRegister(env, memKv(), nc, serviceId as never, new Map(), new PresenceStore(), profiles, undefined, undefined, { on: async () => true, lookup });
    expect(out.error?.details).toEqual({ reason: "name_unchecked" });
    expect(out.error?.retryable).toBe(true);
  });

  it("setting on: a named agent registers", async () => {
    const { env, profiles, key } = registration();
    const { lookup } = scripted({ [key]: { status: "named", handle: "c10.test@agentmesh.ai" } });
    const out = await handleRegister(env, memKv(), nc, serviceId as never, new Map(), new PresenceStore(), profiles, undefined, undefined, { on: async () => true, lookup });
    expect(out.error ?? null).toBeNull();
    expect((out.payload as { status?: string }).status).toBe("registered");
  });

  it("setting on: a throwaway confined to the sandbox registers, unnamed, and is never looked up", async () => {
    const { env, profiles } = registration({ sandboxNode: true });
    const { lookup, calls } = scripted({});
    const out = await handleRegister(env, memKv(), nc, serviceId as never, new Map(), new PresenceStore(), profiles, undefined, undefined, { on: async () => true, lookup });
    expect(out.error ?? null).toBeNull();
    expect(calls).toEqual([]);
  });

  it("setting off: an unnamed agent registers as it always did", async () => {
    const { env, profiles, key } = registration();
    const { lookup } = scripted({ [key]: { status: "unnamed", handle: null } });
    const out = await handleRegister(env, memKv(), nc, serviceId as never, new Map(), new PresenceStore(), profiles, undefined, undefined, { on: async () => false, lookup });
    expect(out.error ?? null).toBeNull();
  });
});
