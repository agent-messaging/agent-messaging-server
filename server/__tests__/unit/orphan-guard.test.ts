import { describe, it, expect, vi, afterEach } from "vitest";
import { exitWhenOrphaned } from "../../src/shared/orphan-guard.js";

afterEach(() => { vi.useRealTimers(); });

describe("exitWhenOrphaned (technical debt 19)", () => {
  it("exits once when the parent changes, and not before", () => {
    vi.useFakeTimers();
    let parent = 4242;
    const exit = vi.fn();
    exitWhenOrphaned({ ppid: () => parent, exit, log: () => {}, everyMs: 2000 });
    vi.advanceTimersByTime(10_000);
    expect(exit).not.toHaveBeenCalled();
    parent = 1;
    vi.advanceTimersByTime(2000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(10_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("is not armed under a container's init", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    expect(exitWhenOrphaned({ ppid: () => 1, exit, log: () => {} })).toBeNull();
    expect(exitWhenOrphaned({ ppid: () => 0, exit, log: () => {} })).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(exit).not.toHaveBeenCalled();
  });
});
