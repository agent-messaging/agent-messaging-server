/**
 * Who may reach the core's admin API, and how the limits it sets are applied
 * (step 6 of docs/agent-messaging-server-plan.md):
 *
 *   - the admin token file (admin/admin-auth.ts): off without one, a wrong
 *     token refused, a changed file read again, nothing printed;
 *   - the door (keychain/mesh-api.ts adminAnswer): a request that came through
 *     a proxy is refused unless allowed;
 *   - each tenant's own limits (keychain/tenant-limits.ts) and the rate cap
 *     every service handler applies (shared/handler.ts);
 *   - the headless CLI (tools/mesh-admin.mjs) against a fake admin API.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminAuth, parseAdminTokens } from "../../src/admin/admin-auth.js";
import { adminAnswer, cameThroughProxy } from "../../src/keychain/mesh-api.js";
import { mergeLimits, TenantLimitCache } from "../../src/keychain/tenant-limits.js";
import { setTenantRateCheck } from "../../src/shared/tenant-rate.js";
import { wrapHandler } from "../../src/shared/handler.js";
import { RateLimiter } from "../../src/shared/rate-limiter.js";
import { createEnvelope, decode, encode, ErrorCode, newTraceContext, nkeys, signEnvelope } from "../../src/sdk.js";
import { run, parseArgs, readToken, UsageError } from "../../tools/mesh-admin.mjs";

let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "admin-door-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = "t".repeat(40);
const OTHER = "o".repeat(40);

describe("the admin token file", () => {
  it("reads named and unnamed tokens, skips comments and short lines", () => {
    const { tokens, skipped } = parseAdminTokens(`# admin tokens\nops ${TOKEN}\n\n${OTHER}\nshort\n`);
    expect(tokens.map((t) => t.name)).toEqual(["ops", "token 2"]);
    expect(skipped).toBe(1);
  });

  it("is off without a file, refuses a wrong token, and reads the file again when it changes", () => {
    expect(new AdminAuth(null).check(`Bearer ${TOKEN}`)).toMatchObject({ ok: false, status: 503 });
    const file = join(dir, "tokens");
    expect(new AdminAuth(file).check(`Bearer ${TOKEN}`)).toMatchObject({ ok: false, status: 503 });
    writeFileSync(file, `ops ${TOKEN}\n`);
    const auth = new AdminAuth(file);
    expect(auth.describe()).toBe("on (1 token: ops)");
    expect(auth.describe()).not.toContain(TOKEN);
    expect(auth.check(`Bearer ${TOKEN}`)).toEqual({ ok: true, name: "ops" });
    expect(auth.check(`Bearer ${OTHER}`)).toMatchObject({ ok: false, status: 401 });
    expect(auth.check(undefined)).toMatchObject({ ok: false, status: 401 });
    expect(auth.check(TOKEN)).toMatchObject({ ok: false, status: 401 });
    // A second token, added without a restart.
    writeFileSync(file, `ops ${TOKEN}\nci ${OTHER}\n# a longer file\n`);
    expect(auth.check(`Bearer ${OTHER}`)).toEqual({ ok: true, name: "ci" });
  });
});

describe("the admin door", () => {
  const file = () => { const f = join(dir, "door-tokens"); writeFileSync(f, `ops ${TOKEN}\n`); return f; };
  const req = (headers: Record<string, string>, body?: string) => {
    const chunks = body ? [Buffer.from(body)] : [];
    return { headers, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } } as never;
  };
  const admin = { handle: vi.fn(async (r: { caller: string; body: unknown }) => ({ status: 200, body: { caller: r.caller, body: r.body } })) };

  it("refuses a proxied request unless a proxy is allowed, then asks for the token", async () => {
    const auth = new AdminAuth(file());
    const q = new URLSearchParams();
    const viaProxy = await adminAnswer(admin as never, auth, req({ "x-forwarded-for": "198.51.100.4", authorization: `Bearer ${TOKEN}` }), "GET", "/admin/v1/status", q, {});
    expect(viaProxy.status).toBe(403);
    expect(viaProxy.headers).toMatchObject({ "cache-control": "no-store" });
    expect(cameThroughProxy({ forwarded: "for=198.51.100.4" } as never)).toBe(true);
    expect(cameThroughProxy({ "x-mesh-ip": "198.51.100.4" } as never, { MESH_REAL_IP_HEADER: "X-Mesh-IP" })).toBe(true);
    const allowed = await adminAnswer(admin as never, auth, req({ "x-forwarded-for": "198.51.100.4", authorization: `Bearer ${TOKEN}` }), "GET", "/admin/v1/status", q, { MESH_ADMIN_THROUGH_PROXY: "on" });
    expect(allowed.status).toBe(200);
    expect((await adminAnswer(admin as never, auth, req({}), "GET", "/admin/v1/status", q, {})).status).toBe(401);
    expect((await adminAnswer(admin as never, new AdminAuth(null), req({ authorization: `Bearer ${TOKEN}` }), "GET", "/admin/v1/status", q, {})).status).toBe(503);
  });

  it("reads a JSON object body and refuses anything else", async () => {
    const auth = new AdminAuth(file());
    const q = new URLSearchParams();
    const h = { authorization: `Bearer ${TOKEN}` };
    const okAns = await adminAnswer(admin as never, auth, req(h, '{"id":"acme"}'), "POST", "/admin/v1/tenants", q, {});
    expect(okAns.body).toEqual({ caller: "ops", body: { id: "acme" } });
    expect((await adminAnswer(admin as never, auth, req(h, "not json"), "POST", "/admin/v1/tenants", q, {})).status).toBe(400);
    expect((await adminAnswer(admin as never, auth, req(h, "[1]"), "POST", "/admin/v1/tenants", q, {})).status).toBe(400);
    expect((await adminAnswer(admin as never, auth, req(h), "GET", "/admin/other", q, {})).status).toBe(404);
  });
});

describe("each tenant's own limits", () => {
  it("merges a change, removes a limit with null, and refuses what is not a limit", () => {
    expect(mergeLimits({ max_agents: 3 }, { max_rooms: 2, max_agents: null })).toEqual({ ok: true, limits: { max_rooms: 2 } });
    expect(mergeLimits(null, { max_rooms: 1.5 }).ok).toBe(false);
    expect(mergeLimits(null, { colour: 1 }).ok).toBe(false);
  });

  it("caps a tenant's requests a minute across all its agents, and nobody else's", async () => {
    const owners = new Map([["UA", "acme"], ["UB", "acme"], ["UC", "beta"]]);
    const cache = new TenantLimitCache({ agent: async (k: string) => (owners.has(k) ? { account: owners.get(k) } as never : null) });
    expect(await cache.rateCheck("UA")).toBeNull();
    cache.load(new Map([["acme", { requests_per_minute: 2 }]]));
    expect((await cache.rateCheck("UA"))?.allowed).toBe(true);
    expect((await cache.rateCheck("UB"))?.allowed).toBe(true);
    const third = await cache.rateCheck("UA");
    expect(third).toMatchObject({ allowed: false, tenant: "acme", limit: 2 });
    expect(await cache.rateCheck("UC")).toBeNull();
    expect(await cache.rateCheck("UNOBODY")).toBeNull();
    // A new limit takes effect with a fresh window.
    cache.apply("acme", { requests_per_minute: 5 });
    expect((await cache.rateCheck("UA"))?.allowed).toBe(true);
    cache.apply("acme", null);
    expect(cache.limitsFor("acme")).toBeNull();
    expect(cache.anyRateCap).toBe(false);
  });

  describe("in every service handler", () => {
    afterEach(() => setTenantRateCheck(null));
    const svc = nkeys.createUser();
    const msgFrom = (kp: ReturnType<typeof nkeys.createUser>) => {
      const env = createEnvelope({ type: "request", from: kp.getPublicKey(), trace: newTraceContext(), payload: {} });
      signEnvelope(env, kp);
      const responses: Uint8Array[] = [];
      return { data: encode(env), reply: "_INBOX.t", respond: (d: Uint8Array) => { responses.push(d); }, responses };
    };

    it("refuses a request over the sender's tenant's cap with RATE_LIMITED, and runs the handler otherwise", async () => {
      const handler = vi.fn(async (env: { from: string }) => createEnvelope({ type: "respond", from: svc.getPublicKey(), to: env.from, payload: { ok: true } }));
      const wrapped = wrapHandler(svc, handler as never, new RateLimiter(100, 60_000));
      const sender = nkeys.createUser();
      setTenantRateCheck(async (from) => (from === sender.getPublicKey() ? { allowed: false, retryAfterMs: 1000, tenant: "acme", limit: 2 } : null));
      const over = msgFrom(sender);
      await wrapped(over as never);
      expect(handler).not.toHaveBeenCalled();
      const err = decode(over.responses[0]!).error;
      expect(err?.code).toBe(ErrorCode.RATE_LIMITED);
      expect(err?.message).toContain("limit of 2 requests a minute");
      const fine = msgFrom(nkeys.createUser());
      await wrapped(fine as never);
      expect(handler).toHaveBeenCalledOnce();
    });
  });
});

describe("the mesh-admin CLI", () => {
  const tokenFile = () => { const f = join(dir, "cli-tokens"); writeFileSync(f, `ops ${TOKEN}\n`); return f; };
  function fakeApi(answers: Record<string, unknown>) {
    const calls: Array<{ method: string; url: string; auth: string; body: unknown }> = [];
    const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ method: init.method, url, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
      const key = `${init.method} ${new URL(url).pathname}`;
      const body = answers[key] ?? { error: "no such route" };
      return { ok: key in answers, status: key in answers ? 200 : 404, text: async () => JSON.stringify(body) };
    };
    return { calls, fetch };
  }

  it("parses repeated and valued options", () => {
    expect(parseArgs(["credentials", "mint", "--agent", "UA", "--agent=UB", "--out", "f", "--json"])).toEqual({ pos: ["credentials", "mint"], opt: { agent: ["UA", "UB"], out: "f", json: true } });
    expect(() => parseArgs(["--out"])).toThrow(UsageError);
  });

  it("reads the token from the file or MESH_ADMIN_TOKEN, by name when asked", () => {
    const f = join(dir, "two-tokens");
    writeFileSync(f, `ops ${TOKEN}\nci ${OTHER}\n`);
    expect(readToken({ MESH_ADMIN_TOKEN_FILE: f }, {})).toBe(TOKEN);
    expect(readToken({}, { "token-file": f, "token-name": "ci" })).toBe(OTHER);
    expect(readToken({ MESH_ADMIN_TOKEN: "x".repeat(40) }, {})).toBe("x".repeat(40));
    expect(() => readToken({}, {})).toThrow(UsageError);
  });

  it("token new writes a token to the file with nothing secret printed", async () => {
    const out: string[] = [];
    const f = join(dir, "new-tokens");
    await run(["token", "new", "--out", f, "--name", "ops"], { env: {}, print: (s: string) => out.push(s) });
    const text = readFileSync(f, "utf8");
    const token = text.trim().split(/\s+/)[1]!;
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(out.join("\n")).not.toContain(token);
    if (process.platform !== "win32") expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(new AdminAuth(f).check(`Bearer ${token}`)).toEqual({ ok: true, name: "ops" });
  });

  it("sends each command to its admin route with the token", async () => {
    const api = fakeApi({
      "GET /admin/v1/status": { mesh: "test.mesh", agent_messaging: "0.7.0", profile: "core", protocol: "0.3", tenancy: "one_nats_account", platform_beside: false, live_revocation: "on", minting: "on", counts: { tenants: 1, agents: 2, credentials: 3, stops_in_force: 0, revoked_by_admin: 0 }, token: "ops" },
      "POST /admin/v1/credentials/revoke": { revoked: "agent", target: "UA".padEnd(56, "A"), agents: 1, cut: { note: "1 connection closed within 0.4 seconds." }, what_now: "No credential is issued." },
      "PUT /admin/v1/agents/UAGENT": { agent: { tenant: "acme" }, revoke_lifted: true },
      "PUT /admin/v1/tenants/acme/limits": { limits: { max_agents: 2, max_drive_bytes: 5 * 1024 * 1024 } },
    });
    const out: string[] = [];
    const opts = { env: { MESH_ADMIN_TOKEN_FILE: tokenFile(), MESH_ADMIN_URL: "http://mesh.test:3005/" }, fetch: api.fetch, print: (s: string) => out.push(s) };
    await run(["status"], opts);
    expect(out.pop()).toContain("Tenants 1, agents 2, credentials 3");
    await run(["credentials", "revoke", "--agent", "UA".padEnd(56, "A"), "--reason", "test"], opts);
    expect(out.pop()).toContain("1 connection closed");
    await run(["agents", "enroll", "UAGENT", "--tenant", "acme"], opts);
    expect(out.pop()).toContain("the revoke on it was lifted");
    await run(["tenants", "limits", "acme", "--max-agents", "2", "--max-drive-mb", "5"], opts);
    expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET http://mesh.test:3005/admin/v1/status",
      "POST http://mesh.test:3005/admin/v1/credentials/revoke",
      "PUT http://mesh.test:3005/admin/v1/agents/UAGENT",
      "PUT http://mesh.test:3005/admin/v1/tenants/acme/limits",
    ]);
    expect(api.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(api.calls[1]!.body).toEqual({ agent: "UA".padEnd(56, "A"), reason: "test" });
    expect(api.calls[3]!.body).toEqual({ max_agents: 2, max_drive_bytes: 5 * 1024 * 1024 });
  });

  it("writes a minted creds file and an enrollment key to --out, never to the screen", async () => {
    const api = fakeApi({
      "POST /admin/v1/credentials": { user_key: "UKEY", agents: ["UA"], expires_at: "2026-10-19", creds: "a creds file holding SUSEED\n", what_now: "Keep it private." },
      "POST /admin/v1/tenants/acme/enroll-keys": { key: "am_secretkey", label: "bot", expires_in_days: 7 },
    });
    const out: string[] = [];
    const opts = { env: { MESH_ADMIN_TOKEN_FILE: tokenFile() }, fetch: api.fetch, print: (s: string) => out.push(s) };
    const creds = join(dir, "node.creds");
    await run(["credentials", "mint", "--agent", "UA", "--out", creds, "--json"], opts);
    expect(readFileSync(creds, "utf8")).toContain("SUSEED");
    const keyFile = join(dir, "enroll.key");
    await run(["tenants", "key", "acme", "--label", "bot", "--out", keyFile], opts);
    expect(readFileSync(keyFile, "utf8").trim()).toBe("am_secretkey");
    expect(out.join("\n")).not.toContain("SUSEED");
    expect(out.join("\n")).not.toContain("am_secretkey");
    await expect(run(["credentials", "mint", "--agent", "UA"], opts)).rejects.toThrow(/--out/);
  });

  it("says what the admin API refused", async () => {
    const api = fakeApi({});
    await expect(run(["tenants", "show", "nope"], { env: { MESH_ADMIN_TOKEN_FILE: tokenFile() }, fetch: api.fetch, print: () => {} })).rejects.toThrow("no such route");
  });
});
