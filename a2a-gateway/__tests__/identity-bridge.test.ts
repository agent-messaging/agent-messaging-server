/**
 * The identity bridge (SPEC §4.15): callers that hold no mesh key present an
 * OAuth token or a SPIFFE JWT-SVID, checked with the key chain; they get one
 * lasting hosted identity each, the identity-bridge marker, and the MCP and
 * HTTPS fronts with their sixteen tools. The key chain is faked here; the
 * server's side is tested in the server's own suite.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createUser, fromPublic } from "nkeys.js";
import { SignJWT, generateKeyPair, exportJWK, calculateJwkThumbprint } from "jose";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { FileCallerIdentityStore } from "../src/inbound/identity-store.js";
import { ProofGate, presentedCredential, checkDpop, ProofRefused } from "../src/inbound/proofs.js";
import { TOOL_NAMES } from "../src/inbound/bridge-door.js";
import { IDENTITY_BRIDGE_URI } from "../src/core/card.js";
import { fakeConnect } from "./helpers.js";
import { createHash } from "node:crypto";

const nodeKp = createUser();
const nodeSeed = new TextDecoder().decode(nodeKp.getSeed());
let dir = "";
let issuerKey: CryptoKey;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "idbridge-"));
  issuerKey = (await generateKeyPair("ES256")).privateKey as CryptoKey;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const token = (claims: Record<string, unknown>) =>
  new SignJWT({ iss: "https://login.example.com", aud: "mesh", sub: "buyer-1", ...claims }).setProtectedHeader({ alg: "ES256" }).setIssuedAt().setExpirationTime("10m").sign(issuerKey);

/** A fake key chain: checks the signatures the bridge sends, answers like the server's door. */
function fakeCore(answer: (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> } = () => ({ status: 200, body: {} })) {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, string> & { proof: { token: string } };
    calls.push(body);
    const enc = (s: string) => new TextEncoder().encode(s);
    const okNode = fromPublic(body.node_id).verify(enc(`mesh-bridge-caller-v1:${body.ts}:${body.node_id}:${body.caller_id}`), Buffer.from(body.node_sig, "base64"));
    const okCaller = fromPublic(body.caller_id).verify(enc(`mesh-bridge-hosted-v1:${body.ts}:${body.node_id}:${body.caller_id}`), Buffer.from(body.caller_sig, "base64"));
    if (!okNode || !okCaller) return { ok: false, status: 401, json: async () => ({ error: "bad signature", code: "bad_sig" }) };
    const a = answer(body);
    const claims = JSON.parse(Buffer.from(body.proof.token.split(".")[1]!, "base64url").toString());
    const ref = createHash("sha256").update(`${claims.iss}\n${claims.sub}`).digest("hex");
    return {
      ok: a.status < 300,
      status: a.status,
      json: async () => (a.status < 300 ? { tenant: "acme", caller_kind: "oauth", caller_ref: ref, workload_id: claims.sub, issuer: claims.iss, expires_at: new Date(Date.now() + 600_000).toISOString(), identity_source: { kind: "bridged", issuer: claims.iss, workload_id: claims.sub, bridge: body.node_id, since: "x" }, ...a.body } : a.body),
    };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function boot(core = fakeCore()) {
  const callerStore = new FileCallerIdentityStore(join(dir, "callers.json"));
  await callerStore.load();
  const proofs = new ProofGate({ coreUrl: "http://core", nodeSeed, fetchImpl: core.fetchImpl });
  const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://localhost:8090", port: 0, callerStore, proofs, apiKeys: { k1: "partner" } });
  const mesh = fakeConnect(bridge);
  (bridge as unknown as { node: { id: string } }).node.id = nodeKp.getPublicKey();
  const server: Server = await startInboundServer(bridge);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { bridge, mesh, server, base, core, callerStore };
}

const mcp = (base: string, auth: string | null, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}), ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) });

describe("presented credentials", () => {
  it("reads a JWT as an outside proof, a SPIFFE subject as a JWT-SVID, and anything else as a key", async () => {
    expect(presentedCredential(`Bearer ${await token({})}`)).toMatchObject({ type: "proof", kind: "oauth", scheme: "Bearer" });
    expect(presentedCredential(`Bearer ${await token({ sub: "spiffe://example.org/a" })}`)).toMatchObject({ type: "proof", kind: "jwt-svid" });
    expect(presentedCredential(`DPoP ${await token({})}`)).toMatchObject({ type: "proof", scheme: "DPoP" });
    expect(presentedCredential("Bearer amk_123")).toEqual({ type: "key", key: "amk_123" });
    expect(presentedCredential(undefined)).toEqual({ type: "none" });
  });
});

describe("DPoP at the bridge", () => {
  it("is checked on every request: the right key passes once, a replay and another address fail", async () => {
    const k = await generateKeyPair("ES256");
    const jwk = await exportJWK(k.publicKey);
    const tok = "tok";
    const ath = createHash("sha256").update(tok).digest("base64url");
    const proof = (over: Record<string, unknown> = {}) =>
      new SignJWT({ htm: "POST", htu: "http://localhost:8090/mcp", jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000), ath, ...over })
        .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk }).sign(k.privateKey as CryptoKey);
    const seen = new Map<string, number>();
    const p = await proof();
    expect(await checkDpop(p, { method: "POST", url: "http://localhost:8090/mcp", accessToken: tok }, seen)).toBe(await calculateJwkThumbprint(jwk, "sha256"));
    await expect(checkDpop(p, { method: "POST", url: "http://localhost:8090/mcp", accessToken: tok }, seen)).rejects.toBeInstanceOf(ProofRefused);
    await expect(checkDpop(await proof({ htu: "http://elsewhere/mcp" }), { method: "POST", url: "http://localhost:8090/mcp", accessToken: tok }, seen)).rejects.toThrow(/another method or address/);
    await expect(checkDpop(undefined, { method: "POST", url: "http://localhost:8090/mcp", accessToken: tok }, seen)).rejects.toMatchObject({ code: "dpop_required" });
  });
});

describe("the MCP front", () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  afterEach(async () => { await new Promise<void>((r) => ctx.server.close(() => r())); });

  it("asks for a credential with the resource metadata, and serves that metadata (RFC 9728)", async () => {
    ctx = await boot();
    const r = await mcp(ctx.base, null, { method: "initialize", params: {} });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('resource_metadata="http://localhost:8090/.well-known/oauth-protected-resource/mcp"');
    const meta = await (await fetch(`${ctx.base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(meta).toMatchObject({ resource: "http://localhost:8090/mcp", bearer_methods_supported: ["header"] });
  });

  it("initializes, lists the sixteen tools, and runs them as the caller's lasting bridged identity (i11)", async () => {
    ctx = await boot();
    const t = await token({});
    const auth = `Bearer ${t}`;
    const init = await (await mcp(ctx.base, auth, { method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    const list = await (await mcp(ctx.base, auth, { method: "tools/list" })).json();
    expect(list.result.tools.map((x: { name: string }) => x.name)).toEqual(TOOL_NAMES);
    expect(TOOL_NAMES).toHaveLength(16);
    // No tool takes a credential as an argument.
    expect(JSON.stringify(list.result.tools)).not.toMatch(/token|password|credential"/i);
    const who = await (await mcp(ctx.base, auth, { method: "tools/call", params: { name: "whoami", arguments: {} } })).json();
    expect(who.result.isError).toBe(false);
    expect(who.result.structuredContent).toMatchObject({ caller_kind: "oauth", tenant: "acme", workload_id: "buyer-1" });
    // One identity per issuer and subject: the same token's caller is the same agent, and the
    // key chain was asked once (the answer is kept).
    const again = await (await mcp(ctx.base, auth, { method: "tools/call", params: { name: "whoami", arguments: {} } })).json();
    expect(again.result.structuredContent.agent_id).toBe(who.result.structuredContent.agent_id);
    expect(ctx.core.calls).toHaveLength(1);
    // The hosted identity registered the identity-bridge marker, unlisted.
    const reg = ctx.mesh.registrations.find((r) => r.agentId === who.result.structuredContent.agent_id)!;
    expect(reg.opts).toMatchObject({ visibility: "unlisted", meta: { identity_bridge: { caller_kind: "oauth", bridge: nodeKp.getPublicKey() } } });
    expect(JSON.stringify(reg.opts)).toContain(IDENTITY_BRIDGE_URI);
    expect(JSON.stringify(reg.opts)).not.toContain("a2a_bridge");
    // send goes out as that identity.
    const sent = await (await mcp(ctx.base, auth, { method: "tools/call", params: { name: "send", arguments: { agent: "U" + "A".repeat(55), text: "hello" } } })).json();
    expect(sent.result.isError).toBe(false);
    expect(ctx.mesh.requests.at(-1)).toMatchObject({ from: who.result.structuredContent.agent_id, offering: "chat", input: { text: "hello" } });
  });

  it("answers a refused token with the key chain's reason, and keeps no identity for it", async () => {
    ctx = await boot(fakeCore(() => ({ status: 401, body: { error: "The token is not meant for this mesh.", code: "proof_wrong_audience" } })));
    const r = await mcp(ctx.base, `Bearer ${await token({})}`, { method: "tools/list" });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ code: "proof_wrong_audience" });
    expect(ctx.callerStore.list()).toHaveLength(0);
  });

  it("refuses a bound token without its DPoP proof, before asking the key chain", async () => {
    ctx = await boot();
    const r = await mcp(ctx.base, `DPoP ${await token({ cnf: { jkt: "abc" } })}`, { method: "tools/list" });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ code: "dpop_required" });
    expect(ctx.core.calls).toHaveLength(0);
  });

  it("still admits an API key caller, as before", async () => {
    ctx = await boot();
    const who = await (await mcp(ctx.base, "Bearer k1", { method: "tools/call", params: { name: "whoami", arguments: {} } })).json();
    expect(who.result.structuredContent).toMatchObject({ caller_kind: "operator" });
  });

  it("an unknown tool is a JSON-RPC error, a tool's refusal is a tool result marked as an error", async () => {
    ctx = await boot();
    const auth = `Bearer ${await token({})}`;
    expect((await (await mcp(ctx.base, auth, { method: "tools/call", params: { name: "nope", arguments: {} } })).json()).error.code).toBe(-32602);
    const bad = await (await mcp(ctx.base, auth, { method: "tools/call", params: { name: "send", arguments: { agent: "U" + "A".repeat(55), text: "" } } })).json();
    expect(bad.result).toMatchObject({ isError: true });
    expect(bad.result.content[0].text).toMatch(/INPUT_INVALID/);
  });
});

describe("the HTTPS front", () => {
  it("lists the tools and runs one with the same identity", async () => {
    const ctx = await boot();
    try {
      const list = await (await fetch(`${ctx.base}/v1/bridge/tools`)).json();
      expect(list.tools).toHaveLength(16);
      const auth = { authorization: `Bearer ${await token({})}`, "content-type": "application/json" };
      const who = await (await fetch(`${ctx.base}/v1/bridge/tools/whoami`, { method: "POST", headers: auth, body: "{}" })).json();
      expect(who).toMatchObject({ caller_kind: "oauth", tenant: "acme" });
      const missing = await fetch(`${ctx.base}/v1/bridge/tools/whoami`, { method: "POST", body: "{}" });
      expect(missing.status).toBe(401);
    } finally {
      await new Promise<void>((r) => ctx.server.close(() => r()));
    }
  });
});
