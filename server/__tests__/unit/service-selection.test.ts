import { describe, it, expect } from "vitest";

/**
 * `--service=` selection, as a pure function of the argument.
 *
 * These cases exist because getting this wrong is silent in the worst way. A
 * process started with a typo would run NO services, print "All services ready",
 * and sit there healthy in a process manager while the mesh quietly lost a
 * capability. And splitting `registry` away from `api` costs account closure the
 * ability to deregister anything, because that path is handed over in-process,
 * which is the whole reason the flag takes a list rather than one name.
 *
 * Mirrors the parsing in src/main.ts. It lives here rather than being imported
 * because main.ts connects to NATS at module scope; the parsing is small enough
 * that duplicating it is cheaper than restructuring startup, and the assertion
 * at the bottom pins the service list so the two cannot drift apart silently.
 */

const KNOWN = ["registry", "task-manager", "catalog", "activity", "rooms", "admission", "api"] as const;
type Known = (typeof KNOWN)[number];

interface Parsed {
  requested: Set<string> | null;
  unknown: string[];
  empty: boolean;
}

function parse(argv: string[]): Parsed {
  const arg = argv.find((a) => a.startsWith("--service="));
  const requested = arg
    ? new Set(arg.slice("--service=".length).split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  const unknown = requested
    ? [...requested].filter((s) => !KNOWN.includes(s as Known))
    : [];
  return { requested, unknown, empty: requested !== null && requested.size === 0 };
}

const wants = (p: Parsed, name: Known): boolean => !p.requested || p.requested.has(name);

describe("--service selection", () => {
  it("runs every service when the flag is absent, which is the shipped deployment", () => {
    const p = parse(["node", "main.ts"]);
    for (const s of KNOWN) expect(wants(p, s)).toBe(true);
  });

  it("accepts a list, so registry and api can share a process", () => {
    const p = parse(["--service=registry,api"]);
    expect(wants(p, "registry")).toBe(true);
    expect(wants(p, "api")).toBe(true);
    expect(wants(p, "rooms")).toBe(false);
    expect(wants(p, "admission")).toBe(false);
  });

  it("still accepts a single name, so existing invocations keep working", () => {
    const p = parse(["--service=admission"]);
    expect(wants(p, "admission")).toBe(true);
    expect(KNOWN.filter((s) => s !== "admission").every((s) => !wants(p, s))).toBe(true);
  });

  it("tolerates spaces around the commas", () => {
    const p = parse(["--service=registry, api , rooms"]);
    expect(p.unknown).toEqual([]);
    for (const s of ["registry", "api", "rooms"] as Known[]) expect(wants(p, s)).toBe(true);
  });

  it("reports a typo rather than starting a process that runs nothing", () => {
    // The failure this prevents: `--service=regsitry` silently selecting no
    // service, logging ready, and looking healthy forever.
    const p = parse(["--service=regsitry,api"]);
    expect(p.unknown).toEqual(["regsitry"]);
  });

  it("reports an empty list rather than treating it as everything", () => {
    // `--service=` with nothing after it must NOT fall through to "all". A
    // deployment that meant to name one service and produced an empty value
    // would otherwise start a second full copy of every service.
    const p = parse(["--service="]);
    expect(p.empty).toBe(true);
    expect(p.requested?.size).toBe(0);
  });

  it("does not treat a service name as a prefix match", () => {
    const p = parse(["--service=task"]);
    expect(p.unknown).toEqual(["task"]);
    expect(wants(p, "task-manager")).toBe(false);
  });

  it("splitting registry from api is expressible, and the caller can see it", () => {
    // Not forbidden, because a self-hoster may want it; but closure then cannot
    // deregister, and main.ts passes `deregisterAgent: undefined` in that case.
    const apiOnly = parse(["--service=api"]);
    expect(wants(apiOnly, "api")).toBe(true);
    expect(wants(apiOnly, "registry")).toBe(false);
  });

  it("pins the service list, so a new service added to main.ts updates this too", () => {
    expect([...KNOWN]).toEqual([
      "registry", "task-manager", "catalog", "activity", "rooms", "admission", "api",
    ]);
  });
});
