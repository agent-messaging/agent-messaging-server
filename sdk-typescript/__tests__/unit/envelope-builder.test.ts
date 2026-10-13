import { describe, it, expect } from "vitest";
import { createEnvelope, validateEnvelope } from "../../src/internal/envelope-builder.js";
import { PROTOCOL_VERSION } from "../../src/types/envelope.js";
import { MeshError, ErrorCode } from "../../src/types/errors.js";

describe("createEnvelope", () => {
  it("builds a valid envelope with auto-filled fields", () => {
    const env = createEnvelope({
      type: "request",
      from: "agent-a",
      to: "agent-b",
      payload: { offering: "chat", input: "hello" },
    });

    expect(env.v).toBe(PROTOCOL_VERSION);
    expect(env.id).toBeTruthy();
    expect(env.type).toBe("request");
    expect(env.ts).toBeTruthy();
    expect(env.from).toBe("agent-a");
    expect(env.to).toBe("agent-b");
    expect(env.trace).toBeDefined();
    expect(env.trace.trace_id).toBeTruthy();
    expect(env.trace.span_id).toBeTruthy();
    expect(env.payload).toEqual({ offering: "chat", input: "hello" });
  });

  it("throws on missing type", () => {
    expect(() =>
      createEnvelope({ type: "" as "request", from: "a" }),
    ).toThrow(MeshError);
  });

  it("throws on missing from", () => {
    expect(() =>
      createEnvelope({ type: "request", from: "" }),
    ).toThrow(MeshError);
  });

  it("throws on invalid type", () => {
    expect(() =>
      createEnvelope({ type: "invalid" as "request", from: "a" }),
    ).toThrow(MeshError);
  });

  it("includes optional fields only when provided", () => {
    const env = createEnvelope({ type: "emit", from: "a" });
    expect(env.to).toBeUndefined();
    expect(env.task_id).toBeUndefined();
    expect(env.in_reply_to).toBeUndefined();
    expect(env.context_id).toBeUndefined();
    expect(env.error).toBeUndefined();
    expect(env.payload).toBeUndefined();
    expect(env.artifacts).toBeUndefined();
    expect(env.meta).toBeUndefined();
  });
});

describe("validateEnvelope", () => {
  it("passes for a valid envelope", () => {
    const env = createEnvelope({ type: "request", from: "a" });
    expect(() => validateEnvelope(env)).not.toThrow();
  });

  it("throws on null", () => {
    expect(() => validateEnvelope(null)).toThrow(MeshError);
  });

  it("throws on missing fields", () => {
    expect(() => validateEnvelope({})).toThrow(MeshError);
    expect(() => validateEnvelope({ v: "0.1.0" })).toThrow(MeshError);
  });

  it("throws on incompatible major version", () => {
    const env = createEnvelope({ type: "request", from: "a" });
    const bad = { ...env, v: "9.0.0" };
    expect(() => validateEnvelope(bad)).toThrow(/version/i);
  });
});
