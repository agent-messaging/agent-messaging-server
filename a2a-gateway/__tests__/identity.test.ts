/**
 * FIX 1 — the bridge must fail closed.
 *
 * `API_KEYS` is unset in production. Before this, that meant `callerIdentity`
 * fell through to the `ip:` branch and minted a hosted mesh identity for any
 * anonymous caller on the internet, node-vouched, at 30 mesh requests a minute.
 * BRIDGE-A2A.md §9 PERMITS an anonymous guest tier; it does not make one the
 * default, and a deployment bundle must not hand an operator an open bridge.
 */
import { describe, it, expect } from "vitest";
import { Bridge } from "../src/bridge.js";
import { fakeConnect } from "./helpers.js";

function bridgeWith(overrides: Partial<ConstructorParameters<typeof Bridge>[0]> = {}): Bridge {
  return new Bridge({
    meshUrl: "ws://127.0.0.1:1",
    publicBaseUrl: "http://localhost:8090",
    port: 8090,
    ...overrides,
  });
}

describe("callerIdentity fails closed (BRIDGE-A2A.md §9)", () => {
  it("refuses a caller with no credentials when nothing is configured", async () => {
    const bridge = bridgeWith();
    const result = await bridge.callerIdentity(undefined, "203.0.113.7");
    expect(result).toMatchObject({ error: "unauthorized", reason: "credentials_required" });
  });

  it("refuses anonymous callers even when API keys ARE configured", async () => {
    const bridge = bridgeWith({ apiKeys: { k1: "partner" } });
    expect(await bridge.callerIdentity(undefined, "203.0.113.7")).toMatchObject({
      error: "unauthorized",
      reason: "credentials_required",
    });
  });

  it("mints nothing for a refused caller", async () => {
    const bridge = bridgeWith();
    const { mintedAgentIds } = fakeConnect(bridge);
    await bridge.callerIdentity(undefined, "203.0.113.7");
    await bridge.callerIdentity(undefined, "203.0.113.8");
    expect(mintedAgentIds).toEqual([]);
  });

  it("distinguishes a bad key from a missing one", async () => {
    const bridge = bridgeWith({ apiKeys: { good: "partner" } });
    expect(await bridge.callerIdentity("bad", "203.0.113.7")).toMatchObject({ reason: "invalid_key" });
    expect(await bridge.callerIdentity(undefined, "203.0.113.7")).toMatchObject({
      reason: "credentials_required",
    });
  });

  it("admits a valid key and reuses its identity across calls", async () => {
    const bridge = bridgeWith({ apiKeys: { good: "partner" } });
    fakeConnect(bridge);
    const first = await bridge.callerIdentity("good", "203.0.113.7");
    const second = await bridge.callerIdentity("good", "198.51.100.4");
    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);
    if ("error" in first || "error" in second) return;
    expect(first.key).toBe("key:good");
    expect(second.agent.id).toBe(first.agent.id);
  });

  it("admits anonymous callers only when the operator turns ALLOW_ANONYMOUS on", async () => {
    const bridge = bridgeWith({ allowAnonymous: true });
    fakeConnect(bridge);
    const a = await bridge.callerIdentity(undefined, "203.0.113.7");
    const b = await bridge.callerIdentity(undefined, "198.51.100.4");
    expect("error" in a).toBe(false);
    expect("error" in b).toBe(false);
    if ("error" in a || "error" in b) return;
    // §2.1 rule 1: distinct callers, distinct identities.
    expect(a.key).toBe("ip:203.0.113.7");
    expect(b.key).toBe("ip:198.51.100.4");
    expect(a.agent.id).not.toBe(b.agent.id);
  });

  it("still rejects an unknown key when anonymous access is allowed", async () => {
    const bridge = bridgeWith({ allowAnonymous: true, apiKeys: { good: "partner" } });
    fakeConnect(bridge);
    expect(await bridge.callerIdentity("bad", "203.0.113.7")).toMatchObject({ reason: "invalid_key" });
  });
});

describe("configWarnings tells the operator what the policy actually is", () => {
  it("says so when the bridge will refuse everything", () => {
    expect(bridgeWith().configWarnings().join("\n")).toMatch(/refused with 401/);
  });

  it("says so when the bridge is open", () => {
    expect(bridgeWith({ allowAnonymous: true }).configWarnings().join("\n")).toMatch(
      /ALLOW_ANONYMOUS is ON/,
    );
  });
});

describe("rate budget is charged per caller key", () => {
  it("throttles one caller without touching another", () => {
    const bridge = bridgeWith({ apiKeys: { a: "a", b: "b" }, ratePerMinute: 2 });
    expect(bridge.rateOk("key:a")).toBe(true);
    expect(bridge.rateOk("key:a")).toBe(true);
    expect(bridge.rateOk("key:a")).toBe(false);
    expect(bridge.rateOk("key:b")).toBe(true);
  });
});
