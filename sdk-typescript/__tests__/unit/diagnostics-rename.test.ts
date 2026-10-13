// SPEC-NAMING §5.8 (2026-10-05): a renamed agent's old handle, as the SDK's
// resolver reads it. In its window it resolves to the same card and the answer
// carries a notice; after it, it does not resolve and says where the agent went.
import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import nkeys from "nkeys.js";
import { Diagnostics } from "../../src/diagnostics.js";
import { canonicalJSON } from "../../src/internal/identity.js";
import type { AgentMesh } from "../../src/mesh.js";

const diag = (opts: Record<string, unknown> = {}) => new Diagnostics({} as AgentMesh, opts as never);
const open: Server[] = [];
afterAll(() => { for (const s of open) s.close(); });
const serve = (handler: Parameters<typeof createServer>[1]): Promise<Server> =>
  new Promise((resolve) => { const s = createServer(handler); open.push(s); s.listen(0, "127.0.0.1", () => resolve(s)); });
const portOf = (s: Server) => (s.address() as AddressInfo).port;
const keyDoc = (k: ReturnType<typeof nkeys.createAccount>) => ({ keys: [k.getPublicKey()] });
const signed = (k: ReturnType<typeof nkeys.createAccount>, card: Record<string, unknown>) => ({
  ok: true, card, registrar_key: k.getPublicKey(),
  registrar_sig: Buffer.from(k.sign(new TextEncoder().encode(canonicalJSON(card)))).toString("base64"),
});

const OLD = "old.someone@example.com";
const NEW = "new.someone@example.com";

describe("Diagnostics.resolve: a renamed agent's old handle", () => {
  it("in the window: resolves to the same agent, with the notice and the new handle", async () => {
    const key = nkeys.createAccount();
    const agentId = nkeys.createUser().getPublicKey();
    const says = `${OLD} was renamed to ${NEW}. This name stops working on 2026-11-04; use ${NEW}.`;
    const registrar = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/api/registrar-key")) return res.end(JSON.stringify(keyDoc(key)));
      res.end(JSON.stringify({ ...signed(key, { handle: OLD, binding: "agent-key", endpoints: [{ protocol: "agentmesh", agent_id: agentId }] }), notice: { renamed_to: NEW, stops_at: "2026-11-04T18:00:00Z", says } }));
    });
    const out = await diag({ registrar: `http://127.0.0.1:${portOf(registrar)}` }).resolve(OLD);
    expect(out.resolved).toBe(true);
    expect(out.agentId).toBe(agentId);
    expect(out.notice).toBe(says);
    expect(out.renamedTo).toBe(NEW);
  });

  it("after the window: does not resolve, and says where the agent went", async () => {
    const registrar = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/api/registrar-key")) return res.end(JSON.stringify(keyDoc(nkeys.createAccount())));
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: `${OLD} was renamed to ${NEW} and stopped working on 2026-11-04. Use ${NEW}.`, moved_to: NEW }));
    });
    const out = await diag({ registrar: `http://127.0.0.1:${portOf(registrar)}` }).resolve(OLD);
    expect(out.resolved).toBe(false);
    expect(out.movedTo).toBe(NEW);
    expect(out.error).toMatch(/stopped working on 2026-11-04\. Use new\.someone@example\.com\./);
  });

  it("a plain not-found stays a plain not-found", async () => {
    const registrar = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: "no agent by that name" }));
    });
    const out = await diag({ registrar: `http://127.0.0.1:${portOf(registrar)}` }).resolve(OLD);
    expect(out.resolved).toBe(false);
    expect(out.movedTo).toBeUndefined();
  });
});
