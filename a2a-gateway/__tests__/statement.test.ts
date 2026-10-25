/**
 * The owner's statement and the descriptor it publishes. The invariants
 * pinned here:
 *
 *   - the statement's input is checked to the letter (types, lengths, counts,
 *     duplicates, unknown keys), and an empty statement is null;
 *   - the descriptor is built from the card, the EXPOSED offerings and the
 *     statement, and the registry's own validator accepts it;
 *   - an attachment with a statement puts its descriptor after register, as
 *     its own identity; a failed put is written on the record and the
 *     attachment keeps serving;
 *   - clearing the statement on a live attachment puts a descriptor without
 *     refusals or records, rather than leaving the old words standing;
 *   - a record written before statements existed loads, attaches, and puts
 *     nothing, exactly as before;
 *   - the admin route answers 200, 404 and 422 as the contract says.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "nkeys.js";
import { FileAttachmentStore } from "../src/outbound/store.js";
import { AttachmentManager } from "../src/outbound/manager.js";
import {
  descriptorBytes,
  descriptorForAttachment,
  parseStatement,
  DESCRIPTOR_PUT_SUBJECT,
} from "../src/outbound/descriptor.js";
import { startInboundServer } from "../src/inbound/server.js";
import { Bridge } from "../src/bridge.js";
import { fakeConnect } from "./helpers.js";
import { validateDescriptor } from "../../server/src/registry/descriptor-store.js";

const open: Server[] = [];
afterEach(() => {
  while (open.length) {
    const s = open.pop()!;
    s.closeAllConnections?.();
    s.close();
  }
});

function tmpStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "attach-statement-")), "attachments.json");
}

const SKILLS = [
  { id: "tagline", name: "Tagline", description: "Writes taglines" },
  { id: "brand-brief", name: "Brief", description: "Writes a brand brief" },
];

function card(base: string) {
  return {
    name: "Solstice Brand Studio",
    description: "Writes brand copy for small companies.",
    version: "2.1.0",
    skills: SKILLS,
    capabilities: { streaming: false },
    supportedInterfaces: [{ url: `${base}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  };
}

async function startRemote(): Promise<string> {
  let base = "";
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(card(base)));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(server);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return base;
}

interface Put {
  from: string;
  subject: string;
  doc: Record<string, unknown>;
}

/** A bridge whose hosted agents record registrations and service requests.
 *  `failPuts` makes the registry refuse every descriptor. */
function fakeBridge(opts: { failPuts?: boolean; registerGate?: Promise<void> } = {}) {
  const registered: string[] = [];
  const puts: Put[] = [];
  const keys = new Map<string, string>();
  const node = {
    addAgent: (o?: { nkeySeed?: string }) => {
      // A real public key per seed, so the registry's validator sees the
      // shape it would in production.
      const seed = o?.nkeySeed ?? "";
      if (!keys.has(seed)) keys.set(seed, createUser().getPublicKey());
      const id = keys.get(seed)!;
      return {
        id,
        onRequest: () => undefined,
        register: async () => {
          registered.push(id);
          await opts.registerGate;
        },
        deregister: async () => undefined,
        serviceRequest: async (subject: string, payload: { descriptor: string }) => {
          if (opts.failPuts) throw new Error("The descriptor is a draft (no subject).");
          const doc = JSON.parse(Buffer.from(payload.descriptor, "base64").toString("utf8"));
          puts.push({ from: id, subject, doc });
          return { stored: true };
        },
      };
    },
    removeAgent: async () => true,
  };
  const bridge = { meshNode: node, emitUsage: () => undefined } as unknown as Bridge;
  return { bridge, registered, puts };
}

// ─── The statement's input ───────────────────────────────────────────

describe("parseStatement", () => {
  it("trims, keeps what was said, and reads an empty statement as null", () => {
    expect(parseStatement({ refusals: "  No medical advice.  ", records: [" chat log ", "invoice"] })).toEqual({
      statement: { refusals: "No medical advice.", records: ["chat log", "invoice"] },
    });
    expect(parseStatement(undefined)).toEqual({ statement: null });
    expect(parseStatement(null)).toEqual({ statement: null });
    expect(parseStatement({})).toEqual({ statement: null });
    expect(parseStatement({ refusals: "   ", records: [] })).toEqual({ statement: null });
    expect(parseStatement({ records: ["a"] })).toEqual({ statement: { records: ["a"] } });
  });

  it("refuses everything the contract does not allow, each with one sentence", () => {
    const bad: unknown[] = [
      "no",
      [],
      { refusals: 5 },
      { refusals: "x".repeat(2001) },
      { records: "chat log" },
      { records: Array.from({ length: 21 }, (_, i) => `r${i}`) },
      { records: [7] },
      { records: ["  "] },
      { records: ["x".repeat(121)] },
      { records: ["chat log", " chat log"] },
      { refusals: "fine", extra: true },
    ];
    for (const input of bad) {
      const out = parseStatement(input);
      expect("error" in out, JSON.stringify(input)?.slice(0, 60)).toBe(true);
      if ("error" in out) expect(out.error).toMatch(/\.$/);
    }
    // The edges themselves are allowed.
    expect("statement" in parseStatement({ refusals: "x".repeat(2000) })).toBe(true);
    expect("statement" in parseStatement({ records: Array.from({ length: 20 }, (_, i) => `r${i}`) })).toBe(true);
    expect("statement" in parseStatement({ records: ["x".repeat(120)] })).toBe(true);
  });
});

// ─── The descriptor ──────────────────────────────────────────────────

describe("descriptorForAttachment", () => {
  const agentId = createUser().getPublicKey();

  it("builds the document from the card, the exposed offerings and the statement", () => {
    const doc = descriptorForAttachment({
      card: card("https://x.example"),
      agentId,
      offerings: [SKILLS[0]],
      statement: { refusals: "No medical advice.", records: ["chat log"] },
    });
    expect(doc).toEqual({
      format: "agent-descriptor-v1",
      agent_version: "2.1.0",
      subject: { id: agentId },
      does: "Writes brand copy for small companies.",
      offerings: [{ id: "tagline", name: "Tagline", does: "Writes taglines" }],
      interaction: "service",
      refusals: "No medical advice.",
      records: [{ name: "chat log", when: "per_task" }],
    });
    expect(validateDescriptor(descriptorBytes(doc), agentId)).toBeNull();
  });

  it("falls back to version \"0\" and the card's name, and leaves out what was not said", () => {
    const doc = descriptorForAttachment({
      card: { name: "Bare", description: "", version: undefined as unknown as string },
      agentId,
      offerings: [{ id: "only" } as { id: string }],
      statement: null,
    });
    expect(doc.agent_version).toBe("0");
    expect(doc.does).toBe("Bare");
    expect(doc.offerings).toEqual([{ id: "only", name: "only" }]);
    expect("refusals" in doc).toBe(false);
    expect("records" in doc).toBe(false);
    expect(validateDescriptor(descriptorBytes(doc), agentId)).toBeNull();
  });

  it("is refused by the registry as anyone else's descriptor", () => {
    const doc = descriptorForAttachment({ card: card("https://x.example"), agentId, offerings: [], statement: null });
    expect(validateDescriptor(descriptorBytes(doc), createUser().getPublicKey())).toMatch(/subject\.id/);
  });
});

// ─── The manager ─────────────────────────────────────────────────────

describe("the statement on an attachment", () => {
  it("puts the descriptor after register, as the attachment's own identity, with only the exposed offerings", async () => {
    const remote = await startRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(tmpStorePath()));
    const rec = await m.create({
      url: remote,
      exposedSkills: ["tagline"],
      statement: { refusals: "No medical advice.", records: ["chat log"] },
    });
    expect(rec.statement).toEqual({ refusals: "No medical advice.", records: ["chat log"] });
    expect(fb.registered).toHaveLength(1);
    expect(fb.puts).toHaveLength(1);
    const put = fb.puts[0];
    expect(put.subject).toBe(DESCRIPTOR_PUT_SUBJECT);
    expect(put.from).toBe(rec.agentId);
    expect(put.doc.subject).toEqual({ id: rec.agentId });
    expect(put.doc.offerings).toEqual([{ id: "tagline", name: "Tagline", does: "Writes taglines" }]);
    expect(put.doc.refusals).toBe("No medical advice.");
    expect(validateDescriptor(new TextEncoder().encode(JSON.stringify(put.doc)), rec.agentId!)).toBeNull();
    expect(typeof rec.descriptorPublishedAt).toBe("string");
    expect(rec.descriptorError).toBeNull();
    await m.stop();
  });

  it("a failed put is written on the record and the attachment keeps serving", async () => {
    const remote = await startRemote();
    const fb = fakeBridge({ failPuts: true });
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(tmpStorePath()));
    const rec = await m.create({ url: remote, statement: { refusals: "No medical advice." } });
    expect(rec.state).toBe("active");
    expect(rec.descriptorPublishedAt).toBeNull();
    expect(rec.descriptorError).toMatch(/draft/);
    await m.stop();
  });

  it("replaces the statement on a live attachment and republishes; clearing puts a descriptor without the old words", async () => {
    const remote = await startRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(tmpStorePath()));
    const rec = await m.create({ url: remote, statement: { refusals: "No medical advice.", records: ["chat log"] } });

    const replaced = await m.setStatement(rec.id, { records: ["invoice"] });
    expect(replaced.statement).toEqual({ records: ["invoice"] });
    expect(fb.puts).toHaveLength(2);
    expect(fb.puts[1].doc.refusals).toBeUndefined();
    expect(fb.puts[1].doc.records).toEqual([{ name: "invoice", when: "per_task" }]);

    const cleared = await m.setStatement(rec.id, undefined);
    expect(cleared.statement).toBeNull();
    expect(fb.puts).toHaveLength(3);
    expect("refusals" in fb.puts[2].doc).toBe(false);
    expect("records" in fb.puts[2].doc).toBe(false);

    await expect(m.setStatement(rec.id, { refusals: 1 })).rejects.toMatchObject({ status: 422 });
    await expect(m.setStatement("nope", {})).rejects.toMatchObject({ status: 404 });
    await m.detach(rec.id);
    await expect(m.setStatement(rec.id, {})).rejects.toMatchObject({ status: 404 });
    await m.stop();
  });

  it("puts the descriptor again when a changed card is approved", async () => {
    const remote = await startRemote();
    const fb = fakeBridge();
    const store = new FileAttachmentStore(tmpStorePath());
    const m = new AttachmentManager(fb.bridge, store);
    const rec = await m.create({ url: remote, statement: { refusals: "No medical advice." } });
    const stored = (await store.get(rec.id))!;
    stored.pendingCard = card(remote) as never;
    stored.state = "review";
    await m.approve(rec.id);
    expect(fb.puts).toHaveLength(2);
    expect(fb.puts[1].doc.refusals).toBe("No medical advice.");
    await m.stop();
  });

  it("does not put while the health probe has the agent off the mesh, and puts on recovery", async () => {
    const remote = await startRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(tmpStorePath()));
    const rec = await m.create({ url: remote, statement: { refusals: "No medical advice." } });
    const live = (m as unknown as { live: Map<string, { healthy: boolean }> }).live;
    live.get(rec.id)!.healthy = false;
    const changed = await m.setStatement(rec.id, { refusals: "No legal advice." });
    expect(changed.statement).toEqual({ refusals: "No legal advice." });
    expect(fb.puts).toHaveLength(1);

    live.get(rec.id)!.healthy = true;
    await (m as unknown as { recordHealth(id: string, h: boolean): Promise<void> }).recordHealth(rec.id, true);
    expect(fb.puts).toHaveLength(2);
    expect(fb.puts[1].doc.refusals).toBe("No legal advice.");
    await m.stop();
  });

  it("a statement PUT while the attachment is still coming up is the one that stands", async () => {
    const remote = await startRemote();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fb = fakeBridge({ registerGate: gate });
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(tmpStorePath()));
    const creating = m.create({ url: remote, statement: { refusals: "Old words." } });
    while (fb.registered.length === 0) await new Promise((r) => setTimeout(r, 5));
    const [pending] = await m.list();
    const changed = await m.setStatement(pending.id, { refusals: "New words." });
    expect(fb.puts).toHaveLength(0); // nothing live yet, so it only stored
    release();
    const rec = await creating;
    expect(rec.statement).toEqual({ refusals: "New words." });
    expect(changed.statement).toEqual({ refusals: "New words." });
    expect(fb.puts).toHaveLength(1);
    expect(fb.puts[0].doc.refusals).toBe("New words.");
    expect((await m.get(rec.id))?.statement).toEqual({ refusals: "New words." });
    await m.stop();
  });

  it("refuses a bad statement at create, before anything is stored", async () => {
    const remote = await startRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(tmpStorePath()));
    await expect(m.create({ url: remote, statement: { records: ["a", "a"] } })).rejects.toMatchObject({ status: 422 });
    expect(await m.list()).toHaveLength(0);
    await m.stop();
  });

  it("publishes again when the attachment comes back up after a restart", async () => {
    const remote = await startRemote();
    const path = tmpStorePath();
    const first = fakeBridge();
    const m1 = new AttachmentManager(first.bridge, new FileAttachmentStore(path));
    await m1.create({ url: remote, statement: { refusals: "No medical advice." } });
    await m1.stop();

    const second = fakeBridge();
    const m2 = new AttachmentManager(second.bridge, new FileAttachmentStore(path));
    await m2.start();
    expect(second.puts).toHaveLength(1);
    expect(second.puts[0].doc.refusals).toBe("No medical advice.");
    await m2.stop();
  });

  it("an attachment without a statement puts nothing", async () => {
    const remote = await startRemote();
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(tmpStorePath()));
    const rec = await m.create({ url: remote });
    expect(rec.statement).toBeNull();
    expect(fb.puts).toHaveLength(0);
    await m.stop();
  });

  it("a record written before statements existed loads and attaches as before", async () => {
    const remote = await startRemote();
    const path = tmpStorePath();
    // The shape a 0.4.4 gateway wrote: no statement, no descriptor fields.
    const old = {
      id: "0b6a7c1e-0000-4000-8000-000000000001",
      accountId: "acct_1",
      label: "old",
      url: remote,
      card: card(remote),
      pendingCard: null,
      exposedSkills: null,
      policy: { visibility: "public", ratePerMinute: 120, ratePerCallerPerMinute: 30, budgetCeiling: null, feeMicrocents: 0, rateCredits: 0 },
      identitySeed: new TextDecoder().decode(createUser().getSeed()),
      agentId: null,
      state: "active",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    writeFileSync(path, JSON.stringify([old]));
    const fb = fakeBridge();
    const m = new AttachmentManager(fb.bridge, new FileAttachmentStore(path));
    await m.start();
    const rec = await m.get(old.id);
    expect(rec?.state).toBe("active");
    expect(rec?.statement).toBeNull();
    expect(fb.registered).toHaveLength(1);
    expect(fb.puts).toHaveLength(0);
    await m.stop();
  });
});

// ─── The admin route ─────────────────────────────────────────────────

describe("the statement on the admin surface", () => {
  async function adminSetup() {
    const remote = await startRemote();
    const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0 });
    fakeConnect(bridge);
    const fb = fakeBridge();
    (bridge as unknown as { node: unknown }).node = (fb.bridge as unknown as { meshNode: unknown }).meshNode;
    const manager = new AttachmentManager(bridge, new FileAttachmentStore(tmpStorePath()));
    const server = await startInboundServer(bridge, manager);
    open.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { remote, base, fb };
  }

  const put = (url: string, body?: string) =>
    fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body });

  it("POST takes a statement, PUT replaces it, an empty body clears it, and reads show it", async () => {
    const { remote, base, fb } = await adminSetup();
    const created = await fetch(`${base}/admin/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: remote, statement: { refusals: "No medical advice." } }),
    });
    expect(created.status).toBe(201);
    const rec = (await created.json()) as { id: string; statement: unknown; descriptorPublishedAt: unknown };
    expect(rec.statement).toEqual({ refusals: "No medical advice." });
    expect(typeof rec.descriptorPublishedAt).toBe("string");

    const replaced = await put(`${base}/admin/attachments/${rec.id}/statement`, JSON.stringify({ records: ["chat log"] }));
    expect(replaced.status).toBe(200);
    const body = (await replaced.json()) as Record<string, unknown>;
    expect(body.statement).toEqual({ records: ["chat log"] });
    expect(body.identitySeed).toBeUndefined();

    const one = (await (await fetch(`${base}/admin/attachments/${rec.id}`)).json()) as { statement: unknown };
    expect(one.statement).toEqual({ records: ["chat log"] });
    const list = (await (await fetch(`${base}/admin/attachments`)).json()) as { attachments: { statement: unknown }[] };
    expect(list.attachments[0].statement).toEqual({ records: ["chat log"] });

    const cleared = await put(`${base}/admin/attachments/${rec.id}/statement`);
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { statement: unknown }).statement).toBeNull();
    expect(fb.puts).toHaveLength(3);
  });

  it("answers 422 for a bad statement, at create and on PUT, and 404 for an unknown id", async () => {
    const { remote, base } = await adminSetup();
    const badCreate = await fetch(`${base}/admin/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: remote, statement: { refusals: "ok", mood: "sunny" } }),
    });
    expect(badCreate.status).toBe(422);
    expect(((await badCreate.json()) as { error: string }).error).toMatch(/mood/);

    const rec = (await (
      await fetch(`${base}/admin/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: remote }),
      })
    ).json()) as { id: string };
    const bad = await put(`${base}/admin/attachments/${rec.id}/statement`, JSON.stringify({ records: "chat log" }));
    expect(bad.status).toBe(422);

    const notJson = await put(`${base}/admin/attachments/${rec.id}/statement`, "{refusals:");
    expect(notJson.status).toBe(422);

    const missing = await put(`${base}/admin/attachments/no-such-id/statement`, "{}");
    expect(missing.status).toBe(404);

    await fetch(`${base}/admin/attachments/${rec.id}`, { method: "DELETE" });
    const detached = await put(`${base}/admin/attachments/${rec.id}/statement`, "{}");
    expect(detached.status).toBe(404);
  });
});
