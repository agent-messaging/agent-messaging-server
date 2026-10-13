/**
 * The attachment store, the manager, and the admin surface — the gateway's
 * durable half. The invariants pinned here:
 *
 *   - records survive restarts, and so do their mesh identities (the seed is
 *     minted once, not per boot);
 *   - the env bootstrap is idempotent (a URL already recorded is left alone);
 *   - the admin API answers ONLY local, unproxied callers — in particular, a
 *     request that arrived through the reverse proxy on the loopback socket
 *     is refused, because that is the internet wearing a local address;
 *   - key material never leaves the store through any API response;
 *   - policy PATCHes refuse unknown keys instead of dropping them;
 *   - every brokered request emits one usage event, and a broken usage tap
 *     cannot fail the request it describes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileAttachmentStore, newRecord, redact, DEFAULT_POLICY } from "../src/outbound/store.js";
import { AttachmentManager, AdminError, guardedFetchCard } from "../src/outbound/manager.js";
import { adminAllowed, startInboundServer } from "../src/inbound/server.js";
import { Bridge } from "../src/bridge.js";
import { fakeConnect } from "./helpers.js";
import type { RegisterOptions } from "../../sdk-typescript/src/types/options.js";

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

function tmpStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "attach-store-")), "attachments.json");
}

function card(base: string, skills = [{ id: "tagline", name: "Tagline", description: "Writes taglines" }]) {
  return {
    name: "Solstice Brand Studio",
    skills,
    capabilities: { streaming: false },
    supportedInterfaces: [{ url: `${base}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  };
}

/** A remote A2A server: the well-known card plus an echoing RPC method. */
async function startRemote(cardBody?: (base: string) => unknown): Promise<{ base: string; calls: number }> {
  const remote = { base: "", calls: 0 };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify((cardBody ?? card)(remote.base)));
      return;
    }
    if (req.method === "POST" && req.url === "/rpc") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        remote.calls++;
        const rpc = JSON.parse(Buffer.concat(chunks).toString()) as { id: unknown };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { message: { role: "ROLE_AGENT", parts: [{ data: { ok: true } }] } },
          }),
        );
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

interface FakeBridge {
  bridge: Bridge;
  registered: RegisterOptions[];
  seeds: (string | undefined)[];
  handlers: Map<string, (input: unknown, ctx: unknown) => Promise<unknown>>;
  usage: Record<string, unknown>[];
}

/** A bridge whose mesh side records instead of connecting. */
function fakeBridge(): FakeBridge {
  const registered: RegisterOptions[] = [];
  const seeds: (string | undefined)[] = [];
  const handlers = new Map<string, (input: unknown, ctx: unknown) => Promise<unknown>>();
  const usage: Record<string, unknown>[] = [];
  let n = 0;
  const node = {
    addAgent: (opts?: { nkeySeed?: string }) => {
      seeds.push(opts?.nkeySeed);
      return {
        id: `UFAKE${(n++).toString().padStart(10, "0")}`,
        onRequest: (id: string, h: (input: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(id, h),
        register: async (opts: RegisterOptions) => {
          registered.push(opts);
        },
        deregister: async () => undefined,
      };
    },
    removeAgent: async () => true,
  };
  const bridge = {
    meshNode: node,
    emitUsage: (e: Record<string, unknown>) => usage.push(e),
  } as unknown as Bridge;
  return { bridge, registered, seeds, handlers, usage };
}

// ─── The store ───────────────────────────────────────────────────────

describe("the attachment store", () => {
  it("round-trips records through the file, across store instances", async () => {
    const path = tmpStorePath();
    const a = new FileAttachmentStore(path);
    const rec = newRecord({ url: "https://x.example", card: card("https://x.example") as never, identitySeed: "SUAFAKESEED" });
    await a.put(rec);

    const b = new FileAttachmentStore(path);
    const loaded = await b.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(rec.id);
    expect(loaded[0].identitySeed).toBe("SUAFAKESEED");
    expect(loaded[0].policy).toEqual(DEFAULT_POLICY);
  });

  it("redact() strips the seed and the remote auth headers, and nothing else important", () => {
    const rec = newRecord({
      url: "https://x.example",
      card: card("https://x.example") as never,
      headers: { Authorization: "Bearer remote-secret" },
      identitySeed: "SUAFAKESEED",
    });
    const safe = redact(rec) as Record<string, unknown>;
    expect(safe.identitySeed).toBeUndefined();
    expect(safe.headers).toBeUndefined();
    expect(safe.id).toBe(rec.id);
    expect(safe.policy).toEqual(DEFAULT_POLICY);
  });

  // The file holds auth headers and identity seeds; only the owner may read
  // it. POSIX modes are meaningless on Windows, and production is Linux.
  it.skipIf(process.platform === "win32")(
    "writes the file 0600 and its directory 0700, even when a stale tmp file has looser bits",
    async () => {
      // A path whose directory does not exist yet, so the store's own mkdir
      // creates it and its mode is the store's choice.
      const path = join(mkdtempSync(join(tmpdir(), "attach-store-")), "nested", "attachments.json");
      const store = new FileAttachmentStore(path);
      await store.put(
        newRecord({
          url: "https://x.example",
          card: card("https://x.example") as never,
          headers: { Authorization: "Bearer remote-secret" },
          identitySeed: "SUAFAKESEED",
        }),
      );
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);

      // A tmp file surviving a crashed earlier write must not carry its old
      // permissive bits onto the real file: writeFile's mode only applies at
      // creation, so the store has to chmod.
      writeFileSync(`${path}.tmp`, "stale", { mode: 0o644 });
      await store.put(
        newRecord({ url: "https://y.example", card: card("https://y.example") as never, identitySeed: "SUAFAKESEED2" }),
      );
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );
});

// ─── The manager ─────────────────────────────────────────────────────

describe("the attachment manager", () => {
  it("creates, attaches, and keeps the SAME identity across a restart", async () => {
    const path = tmpStorePath();
    const remote = await startRemote();

    const first = fakeBridge();
    const m1 = new AttachmentManager(first.bridge, new FileAttachmentStore(path));
    const rec = await m1.create({ url: remote.base, accountId: "acct_1", label: "kurt-standin" });
    expect(rec.state).toBe("active");
    expect(rec.agentId).toBe("UFAKE0000000000");
    expect(first.seeds[0]).toMatch(/^SU/); // a real user seed was minted and used
    await m1.stop();

    // A new manager over the same store: same record, same seed handed to addAgent.
    const second = fakeBridge();
    const m2 = new AttachmentManager(second.bridge, new FileAttachmentStore(path));
    await m2.start();
    expect(second.seeds[0]).toBe(first.seeds[0]);
    await m2.stop();
  });

  it("bootstraps the env list once: the second boot adds nothing", async () => {
    const path = tmpStorePath();
    const remote = await startRemote();

    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(path));
    await m.bootstrapFromEnv([{ url: remote.base }]);
    await m.bootstrapFromEnv([{ url: `${remote.base}/` }]); // same URL, trailing slash
    const list = await m.list();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("env-bootstrap");
    await m.stop();
  });

  it("refuses exposedSkills the card does not declare, and narrows what it does", async () => {
    const path = tmpStorePath();
    const remote = await startRemote((base) =>
      card(base, [
        { id: "tagline", name: "Tagline", description: "d" },
        { id: "brand-brief", name: "Brief", description: "d" },
      ]),
    );
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(path));

    await expect(m.create({ url: remote.base, exposedSkills: ["nonsense"] })).rejects.toMatchObject({ status: 422 });

    await m.create({ url: remote.base, exposedSkills: ["tagline"] });
    expect(fb.registered[0].offerings?.map((s: { id: string }) => s.id)).toEqual(["tagline"]);
    expect(fb.handlers.has("brand-brief")).toBe(false);
    await m.stop();
  });

  it("PATCH takes policy fields, refuses everything else, and validates values", async () => {
    const path = tmpStorePath();
    const remote = await startRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(path));
    const rec = await m.create({ url: remote.base });

    await expect(m.patch(rec.id, { url: "https://evil.example" })).rejects.toMatchObject({ status: 422 });
    await expect(m.patch(rec.id, { ratePerMinute: -5 })).rejects.toMatchObject({ status: 422 });
    const patched = await m.patch(rec.id, { feeMicrocents: 250, visibility: "unlisted" });
    expect(patched.policy.feeMicrocents).toBe(250);
    expect(patched.policy.visibility).toBe("unlisted");
    await m.stop();
  });

  it("emits one usage event per brokered request, carrying the attachment and account", async () => {
    const path = tmpStorePath();
    const remote = await startRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(path));
    const rec = await m.create({ url: remote.base, accountId: "acct_9" });

    await fb.handlers.get("tagline")!({ product: "x" }, { taskId: "t1", envelope: { from: "UCALLER" } });
    expect(fb.usage).toHaveLength(1);
    expect(fb.usage[0]).toMatchObject({
      attachment_id: rec.id,
      account_id: "acct_9",
      skill: "tagline",
      caller: "UCALLER",
      outcome: "ok",
    });
    expect(typeof fb.usage[0].latencyMs).toBe("number");
    await m.stop();
  });

  it("a throwing usage tap does not fail the brokered request", async () => {
    const path = tmpStorePath();
    const remote = await startRemote();
    const fb = fakeBridge();
    (fb.bridge as unknown as { emitUsage: () => void }).emitUsage = () => {
      throw new Error("meter on fire");
    };
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(path));
    await m.create({ url: remote.base });
    await expect(
      fb.handlers.get("tagline")!({ product: "x" }, { taskId: "t1", envelope: { from: "UCALLER" } }),
    ).resolves.toBeDefined();
    await m.stop();
  });

  it("detach deregisters and keeps the record as history", async () => {
    const path = tmpStorePath();
    const remote = await startRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(path));
    const rec = await m.create({ url: remote.base });
    await m.detach(rec.id);
    const after = await m.get(rec.id);
    expect(after?.state).toBe("detached");
    // and a restart does not resurrect it
    const fb2 = fakeBridge();
    const m2 = new AttachmentManager(fb2.bridge, new FileAttachmentStore(path));
    await m2.start();
    expect(fb2.registered).toHaveLength(0);
    await m2.stop();
  });
});

// ─── Card drift (phase 4) ────────────────────────────────────────────

import { classifyCardDiff } from "../src/outbound/manager.js";
import type { AgentCard } from "../src/core/card.js";

const recheck = (m: AttachmentManager) =>
  (m as unknown as { recheckCards(): Promise<void> }).recheckCards();

describe("classifyCardDiff: what kind of change a re-fetched card is", () => {
  const base = card("https://x.example") as unknown as AgentCard;
  const vary = (patch: Partial<AgentCard>) => ({ ...structuredClone(base), ...patch }) as AgentCard;

  it("same bytes → same; prose → cosmetic; skills/capabilities → material; rpc url → endpoint", () => {
    expect(classifyCardDiff(base, structuredClone(base))).toBe("same");
    expect(classifyCardDiff(base, vary({ name: "Renamed Studio", description: "new words" } as never))).toBe("cosmetic");
    expect(
      classifyCardDiff(base, vary({ skills: [...base.skills, { id: "logo", name: "Logo", description: "d" }] } as never)),
    ).toBe("material");
    expect(classifyCardDiff(base, vary({ capabilities: { streaming: true } } as never))).toBe("material");
    expect(
      classifyCardDiff(
        base,
        vary({ supportedInterfaces: [{ url: "https://elsewhere.example/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" }] } as never),
      ),
    ).toBe("endpoint");
  });

  it("an endpoint move outranks a simultaneous skill change", () => {
    const moved = vary({
      skills: [{ id: "other", name: "Other", description: "d" }],
      supportedInterfaces: [{ url: "https://elsewhere.example/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    } as never);
    expect(classifyCardDiff(base, moved)).toBe("endpoint");
  });
});

describe("the drift pass", () => {
  /** A remote whose card the test can rewrite between fetches. */
  async function mutableRemote() {
    const state: { card: (base: string) => unknown } = { card };
    const remote = await startRemote((base) => state.card(base));
    return { remote, setCard: (fn: (base: string) => unknown) => (state.card = fn) };
  }

  it("absorbs cosmetic changes and refreshes the live registration", async () => {
    const { remote, setCard } = await mutableRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(tmpStorePath()));
    const rec = await m.create({ url: remote.base });
    setCard((base) => ({ ...card(base), description: "newly eloquent" }));

    await recheck(m);
    const after = await m.get(rec.id);
    expect(after?.state).toBe("active");
    expect((after?.card as { description?: string }).description).toBe("newly eloquent");
    expect(after?.pendingCard).toBeFalsy();
    expect(fb.registered.length).toBe(2); // re-registered with the new prose
    await m.stop();
  });

  it("holds a material change in review and keeps serving the approved card", async () => {
    const { remote, setCard } = await mutableRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(tmpStorePath()));
    const rec = await m.create({ url: remote.base });
    setCard((base) => card(base, [
      { id: "tagline", name: "Tagline", description: "d" },
      { id: "logo", name: "Logo", description: "d" },
    ]));

    await recheck(m);
    const after = await m.get(rec.id);
    expect(after?.state).toBe("review");
    expect((after?.pendingCard as { skills: { id: string }[] }).skills.map((s) => s.id)).toEqual(["tagline", "logo"]);
    // The approved card is untouched and the live handler set is the old one.
    expect((after?.card as { skills: { id: string }[] }).skills.map((s) => s.id)).toEqual(["tagline"]);
    expect(fb.handlers.has("logo")).toBe(false);
    await m.stop();
  });

  it("suspends on an endpoint move: off the mesh now, and still off after a restart", async () => {
    const path = tmpStorePath();
    const { remote, setCard } = await mutableRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(path));
    const rec = await m.create({ url: remote.base });
    setCard((base) => ({
      ...card(base),
      supportedInterfaces: [{ url: "https://elsewhere.example/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    }));

    await recheck(m);
    expect((await m.get(rec.id))?.state).toBe("suspended");
    expect(fb.registered.length).toBe(1); // the original attach; nothing since
    await m.stop();

    // A restart does NOT bring a suspended attachment back up.
    const fb2 = fakeBridge();
    const m2 = new AttachmentManager(fb2.bridge, new FileAttachmentStore(path));
    await m2.start();
    expect(fb2.registered).toHaveLength(0);
    expect((await m2.get(rec.id))?.state).toBe("suspended");
    await m2.stop();
  });

  it("clears the review by itself when the remote reverts", async () => {
    const { remote, setCard } = await mutableRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(tmpStorePath()));
    const rec = await m.create({ url: remote.base });
    setCard((base) => card(base, [
      { id: "tagline", name: "Tagline", description: "d" },
      { id: "logo", name: "Logo", description: "d" },
    ]));
    await recheck(m);
    expect((await m.get(rec.id))?.state).toBe("review");

    setCard(card); // the remote thinks better of it
    await recheck(m);
    const after = await m.get(rec.id);
    expect(after?.state).toBe("active");
    expect(after?.pendingCard).toBeFalsy();
    await m.stop();
  });

  it("approve makes the pending card the approved one, keeping only still-declared chosen skills", async () => {
    const { remote, setCard } = await mutableRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(tmpStorePath()));
    const two = (base: string) => card(base, [
      { id: "tagline", name: "Tagline", description: "d" },
      { id: "brand-brief", name: "Brief", description: "d" },
    ]);
    setCard(two);
    const rec = await m.create({ url: remote.base, exposedSkills: ["tagline", "brand-brief"] });
    // The remote drops brand-brief and adds logo.
    setCard((base) => card(base, [
      { id: "tagline", name: "Tagline", description: "d" },
      { id: "logo", name: "Logo", description: "d" },
    ]));
    await recheck(m);
    expect((await m.get(rec.id))?.state).toBe("review");

    const approved = await m.approve(rec.id);
    expect(approved.state).toBe("active");
    // Chosen-and-still-declared survives; dropped disappears; NEW is not
    // auto-granted.
    expect(approved.exposedSkills).toEqual(["tagline"]);
    expect(fb.handlers.has("logo")).toBe(false);
    await m.stop();
  });

  it("approve with nothing pending is a 409", async () => {
    const { remote } = await mutableRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(tmpStorePath()));
    const rec = await m.create({ url: remote.base });
    await expect(m.approve(rec.id)).rejects.toMatchObject({ status: 409 });
    await m.stop();
  });
});

// ─── URL guards ──────────────────────────────────────────────────────

describe("the card fetch guards", () => {
  it("refuses plain http to anywhere that is not localhost", async () => {
    await expect(guardedFetchCard("http://198.51.100.34/agent")).rejects.toMatchObject({ status: 422 });
    await expect(guardedFetchCard("not a url")).rejects.toMatchObject({ status: 422 });
    await expect(guardedFetchCard("ftp://example.com/x")).rejects.toMatchObject({ status: 422 });
  });
});

// ─── The admin gate ──────────────────────────────────────────────────

describe("adminAllowed: local and unproxied, or nothing", () => {
  it("admits only a loopback socket with no forwarding header", () => {
    expect(adminAllowed("127.0.0.1", undefined)).toBe(true);
    expect(adminAllowed("::1", undefined)).toBe(true);
    expect(adminAllowed("::ffff:127.0.0.1", undefined)).toBe(true);
  });

  it("refuses the reverse proxy: loopback socket WITH X-Forwarded-For", () => {
    // This is the trap: Caddy connects from 127.0.0.1 on behalf of the
    // internet. The header it always adds is what gives it away.
    expect(adminAllowed("127.0.0.1", "203.0.113.7")).toBe(false);
  });

  it("refuses non-loopback sockets regardless of headers", () => {
    expect(adminAllowed("10.128.0.9", undefined)).toBe(false);
    expect(adminAllowed(undefined, undefined)).toBe(false);
  });
});

// ─── The admin surface over HTTP ─────────────────────────────────────

describe("the admin surface", () => {
  async function adminSetup() {
    const remote = await startRemote();
    const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0 });
    fakeConnect(bridge);
    // Give the bridge a mesh side the manager can attach through.
    const fb = fakeBridge();
    (bridge as unknown as { node: unknown }).node = (fb.bridge as unknown as { meshNode: unknown }).meshNode;
    const manager = new AttachmentManager(bridge, new FileAttachmentStore(tmpStorePath()));
    const server = await startInboundServer(bridge, manager);
    open.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { remote, base, manager };
  }

  it("creates, lists and reads without ever disclosing key material", async () => {
    const { remote, base } = await adminSetup();
    const created = await fetch(`${base}/admin/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: remote.base, accountId: "acct_1" }),
    });
    expect(created.status).toBe(201);
    const rec = (await created.json()) as Record<string, unknown>;
    expect(rec.identitySeed).toBeUndefined();
    expect(rec.state).toBe("active");

    const list = (await (await fetch(`${base}/admin/attachments`)).json()) as {
      attachments: Record<string, unknown>[];
    };
    expect(list.attachments).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("SU"); // no seed under any name

    const one = await fetch(`${base}/admin/attachments/${rec.id}`);
    expect(one.status).toBe(200);
  });

  it("refuses a proxied request even though it arrives on the loopback socket", async () => {
    const { remote, base } = await adminSetup();
    const resp = await fetch(`${base}/admin/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7" },
      body: JSON.stringify({ url: remote.base }),
    });
    expect(resp.status).toBe(403);
  });

  it("previews without persisting", async () => {
    const { remote, base, manager } = await adminSetup();
    const resp = await fetch(`${base}/admin/attachments/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: remote.base }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { card: { name: string } };
    expect(body.card.name).toBe("Solstice Brand Studio");
    expect(await manager.list()).toHaveLength(0);
  });

  it("PATCH and DELETE round the lifecycle", async () => {
    const { remote, base } = await adminSetup();
    const rec = (await (
      await fetch(`${base}/admin/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: remote.base }),
      })
    ).json()) as { id: string };

    const patched = await fetch(`${base}/admin/attachments/${rec.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ratePerMinute: 10 }),
    });
    expect(patched.status).toBe(200);

    const badPatch = await fetch(`${base}/admin/attachments/${rec.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identitySeed: "SUEVIL" }),
    });
    expect(badPatch.status).toBe(422);

    const deleted = await fetch(`${base}/admin/attachments/${rec.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const after = (await (await fetch(`${base}/admin/attachments/${rec.id}`)).json()) as { state: string };
    expect(after.state).toBe("detached");
  });
});
