/**
 * The three fixes, exercised through the real HTTP surface a caller reaches.
 *
 * FIX 1 — no credential, no mesh work (BRIDGE-A2A.md §9).
 * FIX 2 — behind a trusted proxy, distinct callers get distinct rate budgets
 *         (§2.1 rule 1); from an untrusted peer the header buys nothing.
 * FIX 3 — a taken port fails once, by name, before any mesh connection.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { fakeConnect, manifestFixture, sendMessageBody } from "./helpers.js";

const open: Array<{ close(): void }> = [];

afterEach(() => {
  while (open.length) {
    const s = open.pop()!;
    try {
      (s as Server).closeAllConnections?.();
    } catch {
      /* older node */
    }
    s.close();
  }
});

interface Started {
  base: string;
  bridge: Bridge;
}

async function start(
  config: Partial<ConstructorParameters<typeof Bridge>[0]> = {},
  connect = true,
): Promise<Started> {
  const bridge = new Bridge({
    meshUrl: "ws://127.0.0.1:1",
    publicBaseUrl: "http://127.0.0.1",
    port: 0,
    ...config,
  });
  if (connect) {
    fakeConnect(bridge, {
      discover: async () => ({ agents: [manifestFixture()], total: 1 }),
      getManifest: async (id: string) => {
        if (id !== "UAGENTPUBKEY") throw new Error("no such agent");
        return manifestFixture();
      },
    });
  }
  const server = await startInboundServer(bridge);
  open.push(server);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, bridge };
}

// ─── FIX 1: fail closed ──────────────────────────────────────────────

describe("FIX 1 — the bridge refuses by default", () => {
  it("GET /agents needs a caller: enumerating the directory is a privileged read", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/agents`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    const body = (await res.json()) as { reason?: string; agents?: unknown };
    expect(body.reason).toBe("credentials_required");
    expect(body.agents).toBeUndefined();
  });

  it("GET /agents serves the index to a caller holding a key", async () => {
    const { base } = await start({ apiKeys: { k1: "partner" } });
    const res = await fetch(`${base}/agents`, { headers: { Authorization: "Bearer k1" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ id: string }> };
    expect(body.agents.map((a) => a.id)).toEqual(["UAGENTPUBKEY"]);
  });

  it("the agent card needs a caller too: serving it costs a registry lookup", async () => {
    const { base } = await start({ apiKeys: { k1: "partner" } });
    const path = "/agents/UAGENTPUBKEY/.well-known/agent-card.json";
    expect((await fetch(`${base}${path}`)).status).toBe(401);
    const ok = await fetch(`${base}${path}`, { headers: { Authorization: "Bearer k1" } });
    expect(ok.status).toBe(200);
    const card = (await ok.json()) as { securitySchemes?: Record<string, unknown> };
    // §9: generated cards MUST declare exactly what the bridge accepts.
    expect(Object.keys(card.securitySchemes ?? {})).toEqual(["a2a-gateway"]);
  });

  it("POST rpc without credentials is 401 and does no mesh work", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/agents/UAGENTPUBKEY/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: sendMessageBody(),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { data?: Record<string, unknown> } };
    expect(body.error?.data?.agentmesh_code).toBe("UNAUTHORIZED");
    expect(body.error?.data?.reason).toBe("credentials_required");
  });

  it("a bad key is refused as a bad key, not as a missing one", async () => {
    const { base } = await start({ apiKeys: { k1: "partner" } });
    const res = await fetch(`${base}/agents`, { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe("invalid_key");
  });

  it("liveness stays open — it costs nothing and an operator needs it", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean; auth: Record<string, boolean> };
    expect(body.ready).toBe(true);
    expect(body.auth).toEqual({ api_key: false, anonymous: false });
  });

  it("ALLOW_ANONYMOUS restores the open bridge, as an operator's choice", async () => {
    const { base } = await start({ allowAnonymous: true });
    const res = await fetch(`${base}/agents`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agents: unknown[] }).agents).toHaveLength(1);
  });
});

// ─── FIX 2: identity behind a proxy ──────────────────────────────────

async function rpc(base: string, forwardedFor?: string): Promise<number> {
  const res = await fetch(`${base}/agents/UAGENTPUBKEY/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
    },
    body: sendMessageBody(),
  });
  await res.arrayBuffer();
  return res.status;
}

describe("FIX 2 — X-Forwarded-For is believed only behind a trusted proxy", () => {
  it("without TRUSTED_PROXIES, a spoofed header buys no new budget", async () => {
    const { base } = await start({ allowAnonymous: true, ratePerMinute: 1 });
    expect(await rpc(base, "203.0.113.7")).toBe(200);
    // Same socket peer, so the same bucket, whatever the header claims.
    expect(await rpc(base, "198.51.100.4")).toBe(429);
  });

  it("behind a trusted proxy, two callers get two budgets", async () => {
    const { base } = await start({
      allowAnonymous: true,
      ratePerMinute: 1,
      trustedProxies: ["loopback"],
    });
    expect(await rpc(base, "203.0.113.7")).toBe(200);
    expect(await rpc(base, "198.51.100.4")).toBe(200);
    expect(await rpc(base, "192.0.2.9")).toBe(200);
    // ...and each is still capped on its own.
    expect(await rpc(base, "203.0.113.7")).toBe(429);
  });

  it("behind a trusted proxy, a caller-supplied prefix cannot mint budgets", async () => {
    const { base } = await start({
      allowAnonymous: true,
      ratePerMinute: 1,
      trustedProxies: ["loopback"],
    });
    // The proxy appends the address it saw; only that rightmost entry counts.
    expect(await rpc(base, "198.51.100.11, 203.0.113.7")).toBe(200);
    expect(await rpc(base, "198.51.100.22, 203.0.113.7")).toBe(429);
  });
});

// ─── FIX 3: honest port failure, before any mesh work ────────────────

describe("FIX 3 — a taken port fails once, by name", () => {
  it("rejects with a message naming the port and what to look for", async () => {
    const squatter = createServer(() => undefined);
    await new Promise<void>((resolve) => squatter.listen(0, resolve));
    open.push(squatter);
    const port = (squatter.address() as AddressInfo).port;

    const bridge = new Bridge({
      meshUrl: "ws://127.0.0.1:1",
      publicBaseUrl: "http://127.0.0.1",
      port,
    });

    const started: unknown = startInboundServer(bridge);
    // Guard: pre-fix this returns a Server whose `error` event is unhandled.
    if (started && typeof (started as Server).on === "function") {
      (started as Server).on("error", () => undefined);
      open.push(started as Server);
    }
    await expect(Promise.resolve(started as Promise<Server>)).rejects.toThrow(
      new RegExp(`port ${port} is already in use`),
    );
    await expect(Promise.resolve(started as Promise<Server>)).rejects.toThrow(/ss -ltnp/);
  });

  it("answers 503 while bound but not yet on the mesh", async () => {
    const { base } = await start({ apiKeys: { k1: "p" } }, false);
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(503);
    expect(((await health.json()) as { ready: boolean }).ready).toBe(false);

    const agents = await fetch(`${base}/agents`, { headers: { Authorization: "Bearer k1" } });
    expect(agents.status).toBe(503);
  });
});
