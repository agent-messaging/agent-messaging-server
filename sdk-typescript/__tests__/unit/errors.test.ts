import { describe, it, expect } from "vitest";
import { MeshError, ErrorCode, RETRYABLE_CODES } from "../../src/types/errors.js";

describe("MeshError", () => {
  it("sets code and message", () => {
    const err = new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "timed out");
    expect(err.code).toBe(ErrorCode.TRANSPORT_TIMEOUT);
    expect(err.message).toBe("timed out");
    expect(err.name).toBe("MeshError");
  });

  it("auto-detects retryable from code", () => {
    const retryable = new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "t");
    expect(retryable.retryable).toBe(true);

    const notRetryable = new MeshError(ErrorCode.OFFERING_NOT_FOUND, "s");
    expect(notRetryable.retryable).toBe(false);
  });

  it("allows explicit retryable override", () => {
    const err = new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "t", {
      retryable: false,
    });
    expect(err.retryable).toBe(false);
  });

  it("converts to and from ErrorObject", () => {
    const err = new MeshError(ErrorCode.INTERNAL_ERROR, "boom", {
      details: { foo: "bar" },
      retry_after_ms: 1000,
    });
    const obj = err.toErrorObject();
    expect(obj.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(obj.message).toBe("boom");
    expect(obj.retryable).toBe(true);
    expect(obj.retry_after_ms).toBe(1000);
    expect(obj.details).toEqual({ foo: "bar" });

    const restored = MeshError.fromErrorObject(obj);
    expect(restored.code).toBe(err.code);
    expect(restored.message).toBe(err.message);
    expect(restored.retryable).toBe(err.retryable);
    expect(restored.retry_after_ms).toBe(err.retry_after_ms);
  });

  it("has correct retryable codes", () => {
    expect(RETRYABLE_CODES.has(ErrorCode.RATE_LIMITED)).toBe(true);
    expect(RETRYABLE_CODES.has(ErrorCode.OFFERING_NOT_FOUND)).toBe(false);
  });
});
