import { describe, it, expect } from "vitest";
import { OfferingRouter } from "../../src/internal/offering-router.js";

describe("OfferingRouter", () => {
  it("registers and resolves a handler", () => {
    const router = new OfferingRouter();
    const handler = async () => "result";
    router.register("chat", handler);
    expect(router.resolve("chat")).toBe(handler);
  });

  it("returns null for unregistered offerings without default", () => {
    const router = new OfferingRouter();
    expect(router.resolve("unknown")).toBeNull();
  });

  it("falls back to default handler", () => {
    const router = new OfferingRouter();
    const fallback = async () => "default";
    router.setDefault(fallback);
    expect(router.resolve("anything")).toBe(fallback);
  });

  it("prefers specific handler over default", () => {
    const router = new OfferingRouter();
    const specific = async () => "specific";
    const fallback = async () => "default";
    router.register("chat", specific);
    router.setDefault(fallback);
    expect(router.resolve("chat")).toBe(specific);
    expect(router.resolve("other")).toBe(fallback);
  });

  it("unregisters a handler", () => {
    const router = new OfferingRouter();
    router.register("chat", async () => "x");
    router.unregister("chat");
    expect(router.resolve("chat")).toBeNull();
  });

  it("lists registered offering IDs", () => {
    const router = new OfferingRouter();
    router.register("chat", async () => {});
    router.register("translate", async () => {});
    expect(router.offerings).toEqual(["chat", "translate"]);
  });
});
