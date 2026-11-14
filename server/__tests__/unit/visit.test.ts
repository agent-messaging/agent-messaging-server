/**
 * A visit (keychain/visit.ts, SPEC §21.14 to §21.20): the pass door's checks,
 * the pass it mints, the sweep that removes a finished visitor's mailbox, and
 * the registry's answer for a visitor's key.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { nkeys } from "nats";
import { canonicalJSON } from "../../src/sdk.js";
import {
  MemoryVisitors, VISITOR_GRACE_MS, meshOrigin, visitDoor, visitSettings, visitStatement,
  type VisitDeps,
} from "../../src/keychain/visit.js";
import { keyStandingStatement } from "../../src/keychain/doors.js";
import { assertNarrowVisitor, visitorPermissions } from "../../src/keychain/cred-template.js";
import { handleGet } from "../../src/registry/handlers/get.js";

const SELF = "https://mesh-b.example";
const HOME = "https://mesh-a.example";
const NAMING = "https://naming.example";
const HANDLE = "tz.alice@example.com";

const REGISTRAR = nkeys.createAccount();
const account = nkeys.createAccount();
const sign = (kp: ReturnType<typeof nkeys.createUser>, s: string) => Buffer.from(kp.sign(new TextEncoder().encode(s))).toString("base64");

/** A naming service and a home mesh, answering as the test says. */
function world(over: {
  card?: ((key: string) => Record<string, unknown>) | null;
  badSig?: boolean;
  enrolled?: boolean;
  check?: Record<string, unknown>;
  homeDown?: boolean;
  /** The naming service's signing key, read at each request (so a test can rotate it). */
  reg?: { kp: ReturnType<typeof nkeys.createAccount> };
} = {}, key: string) {
  const asked: string[] = [];
  const registrar = { getPublicKey: () => (over.reg?.kp ?? REGISTRAR).getPublicKey(), sign: (b: Uint8Array) => (over.reg?.kp ?? REGISTRAR).sign(b) };
  const card = over.card === undefined
    ? { handle: HANDLE, expires_at: new Date(Date.now() + 3600_000).toISOString(), endpoints: [{ protocol: "agentmesh", agent_id: key, mesh: `${HOME}/` }] }
    : over.card && over.card(key);
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    asked.push(`${init?.method ?? "GET"} ${url}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === `${NAMING}/api/registrar-key`) return json(200, { keys: [registrar.getPublicKey()] });
    if (url.startsWith(`${NAMING}/api/resolve?handle=`)) {
      if (!card) return json(404, { error: "not found" });
      const sig = Buffer.from(registrar.sign(new TextEncoder().encode(canonicalJSON(card)))).toString("base64");
      return json(200, { card, registrar_key: registrar.getPublicKey(), registrar_sig: over.badSig ? sig.replace(/^./, sig[0] === "A" ? "B" : "A") : sig });
    }
    if (over.homeDown && url.startsWith(HOME)) throw new Error("connection refused");
    if (url === `${HOME}/v1/key-standing`) return json(200, { agent_key: key, enrolled: over.enrolled ?? true });
    if (url === `${HOME}/v1/key-check/${key}`) return json(200, over.check ?? { revoked: false });
    return json(404, { error: "Not found" });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

function rig(over: Parameters<typeof world>[0] & { deps?: Partial<VisitDeps> } = {}) {
  const agent = nkeys.createUser();
  const key = agent.getPublicKey();
  const w = world(over, key);
  const visitors = new MemoryVisitors();
  const boxes = new Map<string, number>();
  const deps: VisitDeps = {
    self: SELF,
    visitors,
    mintSeed: () => ({ ok: true, seed: new TextDecoder().decode(account.getSeed()) }),
    meshInfo: () => ({ name: "mesh-b", endpoints: ["nats://mesh-b.example:4222"] }),
    mailbox: {
      ensure: async (k) => { if (!boxes.has(k)) boxes.set(k, 0); },
      pending: async (k) => boxes.get(k) ?? 0,
      remove: async (k) => { boxes.delete(k); },
    },
    localRefusal: async () => null,
    registrars: [NAMING],
    barred: [],
    passSeconds: 3600,
    maxVisitors: 200,
    fetch: w.fetchImpl,
    ...over.deps,
  };
  const door = visitDoor(deps);
  const ts = Math.floor(Date.now() / 1000);
  const body = (mesh = SELF) => ({
    handle: HANDLE,
    agent_key: key,
    ts,
    sig: sign(agent, visitStatement(ts, key, mesh)),
    standing_sig: sign(agent, keyStandingStatement(ts, key)),
  });
  return { door, deps, visitors, boxes, key, body, asked: w.asked };
}

const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));

describe("the pass door (§21.15, §21.16)", () => {
  it("issues a one-hour pass bound to the visitor's own key, after asking its home", async () => {
    const r = rig();
    const a = await r.door.visit(r.body(), "1.2.3.4");
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const c = claimsOf(a.body.jwt as string);
    expect(c.sub).toBe(r.key);
    expect(c.exp - c.iat).toBe(3600);
    expect(c.nats.sub.allow).toContain(`mesh.agent.${r.key}.inbox`);
    expect(c.nats.pub.deny).toContain("mesh.registry.register");
    expect(a.body.home_mesh).toBe(HOME);
    expect(a.body.mesh).toEqual({ name: "mesh-b", endpoints: ["nats://mesh-b.example:4222"] });
    // It asked the home both questions, and recorded the visitor with a mailbox.
    expect(r.asked).toContain(`POST ${HOME}/v1/key-standing`);
    expect(r.asked).toContain(`GET ${HOME}/v1/key-check/${r.key}`);
    expect((await r.visitors.get(r.key))?.home_mesh).toBe(HOME);
    expect(r.boxes.has(r.key)).toBe(true);
  });

  it("refuses a request signed for another mesh, so it cannot be replayed", async () => {
    const r = rig();
    const a = await r.door.visit(r.body("https://mesh-c.example"), "1.2.3.4");
    expect(a.status).toBe(401);
    expect(r.asked).toEqual([]);
  });

  it("refuses a card that carries another key, has no home, or is this mesh's own", async () => {
    const other = nkeys.createUser().getPublicKey();
    const cases: Array<[(key: string) => unknown, number]> = [
      [() => ({ protocol: "agentmesh", agent_id: other, mesh: HOME }), 403],
      [(key) => ({ protocol: "agentmesh", agent_id: key, mesh: null }), 403],
      [(key) => ({ protocol: "agentmesh", agent_id: key, mesh: `${SELF}/` }), 409],
    ];
    for (const [endpoint, status] of cases) {
      const r = rig({ card: (key) => ({ handle: HANDLE, endpoints: [endpoint(key)] }) });
      const a = await r.door.visit(r.body(), "1.2.3.4");
      expect(a.body.code).toBe("visitor_card_invalid");
      expect(a.status).toBe(status);
    }
  });

  it("refuses a card whose naming signature does not verify", async () => {
    const r = rig({ badSig: true });
    const a = await r.door.visit(r.body(), "1.2.3.4");
    expect(a.body.code).toBe("visitor_card_invalid");
  });

  it("takes a card signed by a key its naming service rotated to since it last asked", async () => {
    const reg = { kp: nkeys.createAccount() };
    const r = rig({ reg });
    expect((await r.door.visit(r.body(), "1.2.3.4")).status).toBe(200);
    reg.kp = nkeys.createAccount();
    const again = await r.door.visit(r.body(), "1.2.3.4");
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });

  it("resolves only at a naming service this mesh trusts", async () => {
    const r = rig();
    const a = await r.door.visit({ ...r.body(), registrar: "https://evil.example" }, "1.2.3.4");
    expect(a.status).toBe(403);
    expect(a.body.code).toBe("visitor_card_invalid");
  });

  it("refuses when the home holds no account for the key", async () => {
    const r = rig({ enrolled: false });
    expect((await r.door.visit(r.body(), "1.2.3.4")).body.code).toBe("visitor_not_in_standing");
  });

  it("refuses a key its home revoked or stopped", async () => {
    const a = rig({ check: { revoked: true } });
    expect((await a.door.visit(a.body(), "1.2.3.4")).body.code).toBe("visitor_key_revoked");
    const b = rig({ check: { revoked: false, stopped: "paused" } });
    expect((await b.door.visit(b.body(), "1.2.3.4")).body.code).toBe("visitor_key_revoked");
  });

  it("refuses rather than issues when the home cannot be asked", async () => {
    const r = rig({ homeDown: true });
    const a = await r.door.visit(r.body(), "1.2.3.4");
    expect(a.status).toBe(503);
    expect(a.body.code).toBe("visitor_check_unavailable");
    expect(await r.visitors.get(r.key)).toBeNull();
  });

  it("refuses a home its operator barred", async () => {
    const r = rig({ deps: { barred: ["mesh-a.example"] } });
    expect((await r.door.visit(r.body(), "1.2.3.4")).body.code).toBe("visitor_home_barred");
  });

  it("asks this mesh's own records too, as every issuing door does (§4.8)", async () => {
    const r = rig({ deps: { localRefusal: async () => ({ status: 403, code: "visitor_key_revoked", error: "revoked here" }) } });
    expect((await r.door.visit(r.body(), "1.2.3.4")).body.code).toBe("visitor_key_revoked");
  });

  it("takes no more visitors than its setting", async () => {
    const r = rig({ deps: { maxVisitors: 1 } });
    await r.visitors.put({ key: "UOTHER", handle: "x", home_mesh: HOME, first_at: "", last_at: "", pass_expires_at: new Date().toISOString(), passes: 1 });
    expect((await r.door.visit(r.body(), "1.2.3.4")).body.code).toBe("visitor_capacity");
  });
});

describe("the pass's permissions (§21.17)", () => {
  it("lets a visitor listen on its own inbox only, and never register or heartbeat", () => {
    const k = nkeys.createUser().getPublicKey();
    const p = visitorPermissions(k);
    expect(() => assertNarrowVisitor(p, k)).not.toThrow();
    expect(p.sub.allow.filter((s) => s.startsWith("mesh.agent."))).toEqual([`mesh.agent.${k}.inbox`]);
    expect(p.pub.allow).not.toContain("mesh.registry.>");
    expect(p.pub.allow).not.toContain("mesh.registry.register");
  });

  it("refuses to mint a widened pass", () => {
    const k = nkeys.createUser().getPublicKey();
    const p = visitorPermissions(k);
    expect(() => assertNarrowVisitor({ ...p, sub: { ...p.sub, allow: [...p.sub.allow, "mesh.agent.*.inbox"] } }, k)).toThrow(/own inbox/);
    expect(() => assertNarrowVisitor({ ...p, pub: { ...p.pub, allow: [...p.pub.allow, "mesh.registry.>"] } }, k)).toThrow(/not one of this mesh's agents/);
  });
});

describe("late answers wait, then the mailbox goes (§21.19)", () => {
  it("keeps a finished visitor through the grace, then removes an empty mailbox", async () => {
    let t = Date.now();
    const r = rig({ deps: { now: () => t } });
    await r.door.visit(r.body(), "1.2.3.4");
    t += 3600_000 + VISITOR_GRACE_MS - 60_000;
    expect(await r.door.sweep()).toBe(0);
    t += 120_000;
    expect(await r.door.sweep()).toBe(1);
    expect(r.boxes.has(r.key)).toBe(false);
    expect(await r.visitors.get(r.key)).toBeNull();
  });

  it("keeps a mailbox with mail in it until its retention ends", async () => {
    let t = Date.now();
    const r = rig({ deps: { now: () => t } });
    await r.door.visit(r.body(), "1.2.3.4");
    r.boxes.set(r.key, 2);
    t += 3600_000 + VISITOR_GRACE_MS + 60_000;
    expect(await r.door.sweep()).toBe(0);
    t += 7 * 24 * 3600_000;
    expect(await r.door.sweep()).toBe(1);
  });
});

describe("the registry answers a visitor's key (§21.18)", () => {
  const ask = (key: string, visitors: MemoryVisitors) =>
    handleGet(
      { id: "e1", from: "UASKER", trace: { trace_id: "t", span_id: "s" } } as never,
      { subject: `mesh.registry.get.${key}` } as never,
      { get: async () => null } as never,
      "USERVICE",
      new Map(),
      undefined, undefined, null,
      visitors,
    );

  it("as a visitor while its visit is current, with its inbox", async () => {
    const k = nkeys.createUser().getPublicKey();
    const v = new MemoryVisitors();
    await v.put({ key: k, handle: HANDLE, home_mesh: HOME, first_at: "", last_at: "", pass_expires_at: new Date(Date.now() + 3600_000).toISOString(), passes: 1 });
    const out = await ask(k, v);
    const p = out.payload as Record<string, any>;
    expect(out.error).toBeFalsy();
    expect(p.id).toBe(k);
    expect(p.visitor.home_mesh).toBe(HOME);
    expect(p.endpoints.inbox).toBe(`mesh.agent.${k}.inbox`);
  });

  it("as not found once the visit is over and its grace has run out", async () => {
    const k = nkeys.createUser().getPublicKey();
    const v = new MemoryVisitors();
    await v.put({ key: k, handle: HANDLE, home_mesh: HOME, first_at: "", last_at: "", pass_expires_at: new Date(Date.now() - VISITOR_GRACE_MS - 1000).toISOString(), passes: 1 });
    expect((await ask(k, v)).error?.code).toBe("AGENT_UNAVAILABLE");
  });
});

describe("settings", () => {
  it("are off unless MESH_VISITS=on, and need this mesh's public address", () => {
    expect(visitSettings({})).toBeNull();
    expect(visitSettings({ MESH_VISITS: "on" })).toBeNull();
    const s = visitSettings({ MESH_VISITS: "on", MESH_PUBLIC_URL: "https://api.example/", PAN_URL: "https://naming.example", MESH_VISIT_PASS_SECONDS: "99999" });
    expect(s?.self).toBe("https://api.example");
    expect(s?.registrars).toEqual(["https://naming.example"]);
    expect(s?.passSeconds).toBe(3600);
    expect(meshOrigin("ftp://x")).toBeNull();
  });
});
