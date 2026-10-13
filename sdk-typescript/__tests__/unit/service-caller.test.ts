// Which key rides with which platform service request (debt 378). An agent
// that connects with its account's API token sends that token only with an
// owner's acts (the definition's account_scopes), and an operator key only
// with an operator's (operator_scopes). Its other requests carry its
// signature alone: the platform reads an account token on any request as the
// token speaking, and refuses one whose scopes do not cover the mesh. The
// adapter's svcCall and the Rust SDK draw the same lines.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platformCaller, bearerFor } from "../../src/service-caller.js";
import { PlatformServices, SDK_REQUESTS } from "../../src/services.generated.js";

const DEFS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "platform-services");

/** What each platform request's definition says it needs. */
function keysByRequest(): Map<string, "owner" | "operator" | "signature"> {
  const out = new Map<string, "owner" | "operator" | "signature">();
  for (const f of readdirSync(DEFS).filter((n) => n.endsWith(".json") && n !== "baseline.json")) {
    const def = JSON.parse(readFileSync(join(DEFS, f), "utf8")) as { service: string; requests?: Array<{ name: string; account_scopes?: string[]; operator_scopes?: string[] }> };
    for (const r of def.requests ?? []) {
      out.set(`${def.service}.${r.name}`, r.operator_scopes ? "operator" : r.account_scopes ? "owner" : "signature");
    }
  }
  return out;
}

const agent = { id: "UAGENT", sign: () => "sig" };

/** A platform that records each request's bearer and whether it was signed. */
function recorder() {
  const seen: Array<{ request: string; bearer: string | null; signed: boolean }> = [];
  const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body) as { sig?: string };
    seen.push({
      request: decodeURIComponent(String(url).split("/v1/svc/")[1]),
      bearer: init.headers.authorization?.replace(/^Bearer /, "") ?? null,
      signed: !!body.sig,
    });
    return { ok: true, status: 200, json: async () => ({ result: {} }) };
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

describe("the keys a platform service request carries", () => {
  it("an agent with an account token makes an owner's request and a normal request", async () => {
    const { seen, fetchImpl } = recorder();
    const svc = new PlatformServices(platformCaller({ api: "https://api.example", agent, key: "amt_owner", fetchImpl }));
    await svc.credits.summary({});
    await svc.memory.recall({ query: "what runs on dev?" });
    await svc.schedules.list({});
    expect(seen).toEqual([
      { request: "credits.summary", bearer: "amt_owner", signed: true },
      { request: "memory.recall", bearer: null, signed: true },
      { request: "schedules.list", bearer: null, signed: true },
    ]);
  });

  it("an operator key rides only with an operator's request, and the account token never does", async () => {
    const { seen, fetchImpl } = recorder();
    const svc = new PlatformServices(platformCaller({ api: "https://api.example", agent, key: "amt_owner", operatorKey: "opk_ops", fetchImpl }));
    await svc.errors.list({});
    await svc.credits.summary({});
    await svc.jobs.list({});
    expect(seen.map((s) => [s.request, s.bearer])).toEqual([["errors.list", "opk_ops"], ["credits.summary", "amt_owner"], ["jobs.list", null]]);
  });

  // The definitions are the AgentMesh platform's (platform-services/), which the
  // Agent Messaging Server's repository does not carry (tools/server-repo.mjs).
  it.skipIf(!existsSync(DEFS))("sends every request with the key its definition calls for", async () => {
    const want = keysByRequest();
    const { seen, fetchImpl } = recorder();
    const svc = new PlatformServices(platformCaller({ api: "https://api.example", agent, key: "amt_owner", operatorKey: "opk_ops", fetchImpl })) as unknown as Record<string, Record<string, (i: unknown) => Promise<unknown>>>;
    const platform = SDK_REQUESTS.filter((r) => r.transport === "platform");
    expect(platform.length).toBeGreaterThan(20);
    for (const r of platform) await svc[r.service][r.request]({});
    const bearerOf = { owner: "amt_owner", operator: "opk_ops", signature: null } as const;
    for (const s of seen) expect([s.request, s.bearer]).toEqual([s.request, bearerOf[want.get(s.request)!]]);
    expect(seen).toHaveLength(platform.length);
  });

  it("a caller that is not an agent sends the key it has with every request", () => {
    expect(bearerFor({ key: "opk_script" }, "signature")).toBe("opk_script");
    expect(bearerFor({ key: "opk_script" }, "operator")).toBe("opk_script");
    expect(bearerFor({ key: "amt_x", operatorKey: "opk_y" }, "operator")).toBe("opk_y");
    // A caller written before requests said which key they need.
    expect(bearerFor({ agent, key: "amt_x" })).toBe("amt_x");
    expect(bearerFor({ agent, key: "amt_x" }, "operator")).toBeUndefined();
  });
});
