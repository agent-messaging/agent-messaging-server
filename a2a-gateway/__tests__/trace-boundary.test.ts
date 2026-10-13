/**
 * The trace has to survive the HTTP-to-mesh boundary (SPEC.md §13.1).
 *
 * This is the one hop where a trace would otherwise break, and it breaks at
 * exactly the interesting place: the edge between two companies. A caller
 * sends `traceparent`, the bridge turns the request into mesh work, and until
 * now that mesh work started a brand new trace with no link back. The caller's
 * tooling saw a request vanish; the responder's saw a span appear from nowhere.
 *
 * What these pin:
 *   - an inbound `traceparent` becomes the ambient mesh trace, which is what
 *     `createEnvelope` reads when no explicit trace is given;
 *   - the header's span becomes the PARENT, and the mesh side gets its own
 *     fresh span, so the two are linked rather than conflated;
 *   - a header a stranger typed badly is ignored rather than trusted;
 *   - the response says which span the bridge used, so the caller can link its
 *     own side without guessing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { FileCallerIdentityStore } from "../src/inbound/identity-store.js";
import { fakeConnect, manifestFixture, sendMessageBody, type FakeMesh } from "./helpers.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER_SPAN = "00f067aa0ba902b7";

let dir: string;
let server: Server | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-trace-"));
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function boot(): Promise<{ url: string; mesh: FakeMesh }> {
  const callerStore = new FileCallerIdentityStore(join(dir, "callers.json"));
  await callerStore.load();
  const bridge = new Bridge({
    meshUrl: "ws://127.0.0.1:1",
    publicBaseUrl: "http://localhost:0",
    port: 0,
    callerStore,
    apiKeys: { partnerkey: "partner" },
  });
  const mesh = fakeConnect(bridge, {
    discover: async () => ({ agents: [manifestFixture()], total: 1 }),
    getManifest: async () => manifestFixture(),
  });
  server = await startInboundServer(bridge);
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, mesh };
}

async function send(url: string, headers: Record<string, string>) {
  return fetch(`${url}/agents/${manifestFixture().id}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "A2A-Version": "1.0",
      Authorization: "Bearer partnerkey",
      ...headers,
    },
    body: sendMessageBody("what are lead times on a 40mm flange?"),
  });
}

describe("an inbound traceparent reaches the mesh", () => {
  it("carries the caller's trace and parents the mesh span under the caller's", async () => {
    const { url, mesh } = await boot();

    const resp = await send(url, { traceparent: `00-${TRACE_ID}-${CALLER_SPAN}-01` });
    expect(resp.status).toBe(200);

    const sent = mesh.requests.at(-1);
    expect(sent, "the bridge should have made a mesh request").toBeDefined();

    // Same trace as the caller...
    expect(sent!.trace?.trace_id).toBe(TRACE_ID);
    // ...the caller's span as the parent...
    expect(sent!.trace?.parent_span_id).toBe(CALLER_SPAN);
    // ...and our own span, not theirs.
    expect(sent!.trace?.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(sent!.trace?.span_id).not.toBe(CALLER_SPAN);

    // The caller is told which span we used, so it can link its side.
    expect(resp.headers.get("traceparent")).toBe(`00-${TRACE_ID}-${sent!.trace?.span_id}-01`);
  });

  it("carries tracestate through verbatim", async () => {
    const { url, mesh } = await boot();
    await send(url, {
      traceparent: `00-${TRACE_ID}-${CALLER_SPAN}-01`,
      tracestate: "contoso=t61rcWkgMzE",
    });
    expect(mesh.requests.at(-1)?.trace?.tracestate).toBe("contoso=t61rcWkgMzE");
  });

  it("ignores a header it cannot parse rather than trusting it", async () => {
    const { url, mesh } = await boot();

    for (const bad of ["garbage", "00-short-span-01", `01-${TRACE_ID}-${CALLER_SPAN}-01`, ""]) {
      await send(url, bad ? { traceparent: bad } : {});
      const sent = mesh.requests.at(-1);
      // No ambient trace at all: the SDK will start a fresh root when it builds
      // the envelope, which is the correct failure. What must NOT happen is the
      // malformed value travelling.
      expect(sent?.trace?.trace_id).not.toBe(TRACE_ID);
      expect(JSON.stringify(sent?.trace ?? {})).not.toContain("short");
    }
  });

  it("does nothing at all when no traceparent is sent", async () => {
    const { url, mesh } = await boot();
    const resp = await send(url, {});
    expect(resp.status).toBe(200);
    expect(mesh.requests.at(-1)?.trace).toBeUndefined();
    expect(resp.headers.get("traceparent")).toBeNull();
  });
});
