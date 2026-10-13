import { describe, it, expect } from "vitest";
import { encode, decode, decodeUnsafe } from "../../src/internal/codec.js";
import { makeSigned } from "../helpers.js";

describe("codec", () => {
  it("round-trips an envelope through encode/decode", () => {
    const env = makeSigned({
      type: "request",
      from: "agent-a",
      to: "agent-b",
      payload: { offering: "chat", input: "hello" },
    });

    const bytes = encode(env);
    expect(bytes).toBeInstanceOf(Uint8Array);

    const decoded = decode(bytes);
    expect(decoded.id).toBe(env.id);
    expect(decoded.type).toBe(env.type);
    expect(decoded.from).toBe(env.from);
    expect(decoded.to).toBe(env.to);
    expect(decoded.payload).toEqual(env.payload);
  });

  it("decodeUnsafe skips validation", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ v: "0.1.0", id: "x", type: "request", ts: "t", from: "a", trace: {} }),
    );
    const env = decodeUnsafe(bytes);
    expect(env.id).toBe("x");
  });

  it("decode throws on invalid JSON", () => {
    const bytes = new TextEncoder().encode("not json");
    expect(() => decode(bytes)).toThrow();
  });

  it("decode throws on invalid envelope structure", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ foo: "bar" }));
    expect(() => decode(bytes)).toThrow();
  });
});
