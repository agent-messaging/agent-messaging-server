/**
 * FIX 3, the ordering half.
 *
 * The 2026-07-20 incident cost 1,364 NATS connections rather than 1,364 quick
 * failures because the bridge connected to the mesh BEFORE it tried to bind.
 * Each doomed attempt registered on the mesh, then died on EADDRINUSE — and
 * because that took longer than pm2's minimum uptime, pm2 counted every crash
 * as a healthy restart and `max_restarts: 10` never tripped.
 *
 * The invariant these tests hold: a port conflict must be discovered with the
 * mesh untouched.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Bridge } from "../src/bridge.js";
import { boot } from "../src/boot.js";
import { fakeConnect } from "./helpers.js";

const open: Server[] = [];
afterEach(() => {
  while (open.length) {
    const s = open.pop()!;
    try {
      s.closeAllConnections?.();
    } catch {
      /* older node */
    }
    s.close();
  }
});

/** A Bridge that counts mesh connections instead of making them. */
function countingBridge(port: number): { bridge: Bridge; connects: () => number } {
  let connects = 0;
  const bridge = new Bridge({
    meshUrl: "ws://127.0.0.1:1",
    publicBaseUrl: "http://127.0.0.1",
    port,
  });
  (bridge as unknown as { connect: () => Promise<void> }).connect = async () => {
    connects++;
    fakeConnect(bridge);
  };
  return { bridge, connects: () => connects };
}

describe("boot order", () => {
  it("binds the port before connecting to the mesh", async () => {
    const { bridge, connects } = countingBridge(0);
    const booted = await boot(bridge, []);
    open.push(booted.server);
    expect(booted.server.listening).toBe(true);
    expect(connects()).toBe(1);
    expect(bridge.ready).toBe(true);
  });

  it("never touches the mesh when the port is taken", async () => {
    const squatter = createServer(() => undefined);
    await new Promise<void>((resolve) => squatter.listen(0, resolve));
    open.push(squatter);
    const port = (squatter.address() as AddressInfo).port;

    const { bridge, connects } = countingBridge(port);
    await expect(boot(bridge, [])).rejects.toThrow(new RegExp(`port ${port} is already in use`));
    expect(connects()).toBe(0);
    expect(bridge.ready).toBe(false);
  });
});
