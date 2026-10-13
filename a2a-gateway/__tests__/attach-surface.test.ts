/**
 * What an external A2A server (an eval agent, say) must actually expose for
 * this bridge to attach it — pinned in executable form rather than asserted in
 * a doc, because the requirement is scattered across fetchCard,
 * jsonRpcInterfaceUrl, cardToManifestFields and makeForwardHandler.
 *
 * Also covers the two things that blocked an unlisted eval agent:
 *   - `visibility` was never passed to register(), so every attached agent
 *     defaulted to public;
 *   - nothing rate-limited the outbound leg, so a mesh caller could drive
 *     unbounded HTTP at a third party under the bridge's vouch.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { attach, type AttachConfig } from "../src/outbound/attach.js";
import type { Bridge } from "../src/bridge.js";
import type { RegisterOptions } from "../../sdk-typescript/src/types/options.js";
import { MeshError, ErrorCode } from "../../sdk-typescript/src/types/errors.js";

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

type Handler = (input: unknown) => unknown;

/** The MINIMUM card this bridge accepts, per the code paths above. */
function minimalCard(base: string): Record<string, unknown> {
  return {
    name: "Eval Agent",
    skills: [{ id: "evaluate", name: "Evaluate", description: "Scores a submission" }],
    capabilities: { streaming: false },
    supportedInterfaces: [
      { url: `${base}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
  };
}

interface FakeRemote {
  base: string;
  calls: number;
}

/** A stock-shaped A2A server: a card at the well-known path and one JSON-RPC
 *  method. `card` receives the base URL so it can point at itself. */
async function startRemote(
  card: (base: string) => unknown = minimalCard,
  respond: Handler = (input) => ({ message: { role: "ROLE_AGENT", parts: [{ data: { echoed: input } }] } }),
): Promise<FakeRemote> {
  const remote: FakeRemote = { base: "", calls: 0 };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      const body = card(remote.base);
      if (body === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      return;
    }
    if (req.method === "POST" && req.url === "/rpc") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        remote.calls++;
        const rpc = JSON.parse(Buffer.concat(chunks).toString()) as { id: unknown; params: unknown };
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: respond(rpc.params) }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(server);
  remote.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return remote;
}

interface FakeMesh {
  bridge: Bridge;
  registered: RegisterOptions[];
  handlers: Map<string, (input: unknown, ctx: unknown) => Promise<unknown>>;
}

function fakeMesh(): FakeMesh {
  const registered: RegisterOptions[] = [];
  const handlers = new Map<string, (input: unknown, ctx: unknown) => Promise<unknown>>();
  const node = {
    addAgent: () => ({
      id: "UATTACHEDFAKE0000000",
      onRequest: (id: string, h: (input: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(id, h),
      register: async (opts: RegisterOptions) => {
        registered.push(opts);
      },
      deregister: async () => undefined,
    }),
    removeAgent: async () => true,
  };
  return { bridge: { meshNode: node } as unknown as Bridge, registered, handlers };
}

async function attachTo(remote: FakeRemote, config: Partial<AttachConfig> = {}) {
  const mesh = fakeMesh();
  const attachment = await attach(mesh.bridge, { url: remote.base, ...config });
  open.push({ close: () => void attachment.detach() } as unknown as Server);
  return { ...mesh, attachment };
}

// ─── The minimum surface ─────────────────────────────────────────────

describe("what an A2A eval agent must expose to be attachable", () => {
  it("attaches on name + skills[] + capabilities{} + a JSONRPC interface, and nothing else", async () => {
    const remote = await startRemote();
    const { registered } = await attachTo(remote);
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe("Eval Agent");
    expect(registered[0].offerings?.map((s: { id: string }) => s.id)).toEqual(["evaluate"]);
    // description and version are absent from the card and are NOT required:
    // the SDK defaults them and the registry only demands name + endpoint.
    expect(registered[0].description).toBeUndefined();
    expect(registered[0].version).toBeUndefined();
  });

  it("one JSON-RPC method is enough: the literal SendMessage returning {message}", async () => {
    const remote = await startRemote();
    const { handlers } = await attachTo(remote);
    const out = await handlers.get("evaluate")!({ submission: "x" }, {
      taskId: "t1",
      envelope: { from: "UCALLER" },
    });
    expect(out).toEqual({ echoed: { message: expect.anything(), configuration: { blocking: true } } });
    expect(remote.calls).toBe(1);
  });

  it("refuses a card with no JSONRPC interface", async () => {
    const remote = await startRemote((base) => ({
      ...minimalCard(base),
      supportedInterfaces: [{ url: `${base}/grpc`, protocolBinding: "GRPC", protocolVersion: "1.0" }],
    }));
    await expect(attachTo(remote)).rejects.toThrow(/No JSONRPC interface/);
  });

  it("refuses a card with no name, or with skills that are not an array", async () => {
    const noName = await startRemote((base) => {
      const c = minimalCard(base);
      delete c.name;
      return c;
    });
    await expect(attachTo(noName)).rejects.toThrow(/Could not fetch agent card/);

    const badSkills = await startRemote((base) => ({ ...minimalCard(base), skills: {} }));
    await expect(attachTo(badSkills)).rejects.toThrow(/Could not fetch agent card/);
  });

  it("throws on a card with no capabilities object — the read is unguarded", async () => {
    const remote = await startRemote((base) => {
      const c = minimalCard(base);
      delete c.capabilities;
      return c;
    });
    await expect(attachTo(remote)).rejects.toThrow(/streaming/);
  });

  it("accepts skills: [] but then registers an agent nothing can call", async () => {
    const remote = await startRemote((base) => ({ ...minimalCard(base), skills: [] }));
    const { registered, handlers } = await attachTo(remote);
    expect(registered[0].offerings).toEqual([]);
    expect(handlers.size).toBe(0);
  });
});

// ─── Visibility ──────────────────────────────────────────────────────

describe("visibility is the operator's to set (BRIDGE-A2A.md §8.2)", () => {
  it("defaults to unset, which the SDK reads as public", async () => {
    const remote = await startRemote();
    const { registered } = await attachTo(remote);
    expect(registered[0].visibility).toBeUndefined();
  });

  it("passes an explicit visibility through to register", async () => {
    const remote = await startRemote();
    const { registered } = await attachTo(remote, { visibility: "unlisted" });
    expect(registered[0].visibility).toBe("unlisted");
  });
});

// ─── Outbound rate limiting ──────────────────────────────────────────

describe("the outbound leg is capped (it was not)", () => {
  it("caps one mesh caller without capping another", async () => {
    const remote = await startRemote();
    const { handlers } = await attachTo(remote, { ratePerCallerPerMinute: 2, ratePerMinute: 100 });
    const call = (from: string) =>
      handlers.get("evaluate")!({ n: 1 }, { taskId: "t", envelope: { from } });

    await call("UCALLER_A");
    await call("UCALLER_A");
    await expect(call("UCALLER_A")).rejects.toThrow(MeshError);
    await expect(call("UCALLER_A")).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
    // A different mesh caller still has its own budget.
    await expect(call("UCALLER_B")).resolves.toBeDefined();
  });

  it("holds a ceiling across all callers, so the remote cannot be swamped", async () => {
    const remote = await startRemote();
    const { handlers } = await attachTo(remote, { ratePerMinute: 2, ratePerCallerPerMinute: 100 });
    const call = (from: string) =>
      handlers.get("evaluate")!({ n: 1 }, { taskId: "t", envelope: { from } });

    await call("A");
    await call("B");
    await expect(call("C")).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
    expect(remote.calls).toBe(2);
  });
});
