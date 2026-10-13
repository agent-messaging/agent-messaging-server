/**
 * The caller-identity file holds signing seeds, so its permissions are a
 * security claim and not a detail. `stat`-ing the file proves it on POSIX and
 * proves nothing on Windows, where Node reports 0666/0444 off the read-only
 * attribute — and the machine this is usually written on is Windows while the
 * machine it runs on is Linux. So this file asserts the calls instead: the
 * exact sequence that makes the claim true, checkable anywhere.
 *
 * The sequence matters, not just the flags. `mkdir`'s mode applies only when it
 * CREATES the directory and `writeFile`'s only when it creates the file, so on
 * every deployed bridge — where `data/` already exists, and where a crashed
 * earlier write may have left a `.tmp` behind — the mode arguments alone are
 * silently no-ops. The explicit chmods are what actually close those two holes,
 * and they have to land BEFORE the rename publishes the tmp file.
 *
 * It lives in its own file because `vi.mock` is hoisted per module.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }),
  mkdir: vi.fn(async (path: string, opts?: { mode?: number }) => {
    calls.push(`mkdir ${path} ${opts?.mode?.toString(8)}`);
  }),
  chmod: vi.fn(async (path: string, mode: number) => {
    calls.push(`chmod ${path} ${mode.toString(8)}`);
  }),
  writeFile: vi.fn(async (path: string, _body: string, opts?: { mode?: number }) => {
    calls.push(`write ${path} ${opts?.mode?.toString(8)}`);
  }),
  rename: vi.fn(async (from: string, to: string) => {
    calls.push(`rename ${from} -> ${to}`);
  }),
}));

const { FileCallerIdentityStore, newCallerRecord } = await import("../src/inbound/identity-store.js");

beforeEach(() => {
  calls.length = 0;
});

describe("the caller-identity file is owner-only, on every write", () => {
  it("chmods the directory and the tmp file before the rename publishes it", async () => {
    const store = new FileCallerIdentityStore("/srv/bridge/data/caller-identities.json");
    await store.load();
    await store.put(
      newCallerRecord({ callerKey: "acctkey:r1", agentId: "UAGENT", identitySeed: "SUASEED" }),
    );

    expect(calls).toEqual([
      "mkdir /srv/bridge/data 700",
      "chmod /srv/bridge/data 700",
      "write /srv/bridge/data/caller-identities.json.tmp 600",
      "chmod /srv/bridge/data/caller-identities.json.tmp 600",
      "rename /srv/bridge/data/caller-identities.json.tmp -> /srv/bridge/data/caller-identities.json",
    ]);
  });

  it("re-applies the modes on every subsequent write, not just the first", async () => {
    const store = new FileCallerIdentityStore("/srv/bridge/data/caller-identities.json");
    await store.load();
    await store.put(newCallerRecord({ callerKey: "acctkey:r1", agentId: "U1", identitySeed: "S1" }));
    calls.length = 0;
    await store.put(newCallerRecord({ callerKey: "acctkey:r2", agentId: "U2", identitySeed: "S2" }));

    expect(calls.filter((c) => c.startsWith("chmod"))).toEqual([
      "chmod /srv/bridge/data 700",
      "chmod /srv/bridge/data/caller-identities.json.tmp 600",
    ]);
  });
});
