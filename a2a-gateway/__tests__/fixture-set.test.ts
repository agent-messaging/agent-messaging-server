/**
 * The gateway against the fixture set for the A2A Bridge's mapping
 * (messaging/conformance/a2a-bridge.json in the Common Agent Standards
 * repository). The copy here is byte for byte that file; the digest below
 * pins it, so a change there arrives here on purpose.
 *
 * Each section runs the gateway's own code: the checks on a carried request,
 * the state spellings, the answer on an existing task (over HTTP, through the
 * real handler), the knock's input and the reading of a queued
 * acknowledgement, and the readable-text check.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { checkCarriedRequest, doorHeld, knockInput, stateMetadata } from "../src/core/over-a2a.js";
import { meshStateToA2A, a2aStateToMesh } from "../src/core/states.js";
import { stateEnum } from "../src/core/a2a10.js";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { fakeConnect, manifestFixture } from "./helpers.js";
import { verifyEnvelopeSig } from "../../sdk-typescript/src/internal/identity.js";
import { checkReadableText } from "../../sdk-typescript/src/readable-text.js";
import type { Envelope } from "../../sdk-typescript/src/types/envelope.js";

const RAW = readFileSync(new URL("./fixtures/a2a-bridge.json", import.meta.url));
const FX = JSON.parse(RAW.toString("utf8"));
const PINNED = "0167b7114dfc602e2454291f85aac0ffff9a7076f63551e3fd37bdc9db5bbfcd";

describe("the fixture set for the A2A Bridge's mapping", () => {
  it("is the pinned copy", () => {
    expect(createHash("sha256").update(RAW).digest("hex")).toBe(PINNED);
  });

  it("signed callers: the checks on a carried request", () => {
    const manifest = manifestFixture({ id: FX.identities.agent, offerings: FX.declared_offerings.map((id: string) => ({ id, name: id, description: id })) });
    for (const c of FX.signed_callers.cases) {
      const r = checkCarriedRequest(c.envelope, { agentId: FX.identities.agent, manifest, message: c.message, now: Date.parse(FX.now) });
      expect({ name: c.name, ok: r.ok, ...(r.ok ? {} : { reason: r.reason }) }).toEqual({ name: c.name, ...c.expect });
    }
  });

  it("states: the spellings, exhausted marked, canceled never read back as exhausted", () => {
    for (const c of FX.states.cases) {
      expect(meshStateToA2A(c.mesh)).toBe(c.json);
      expect(stateEnum(c.json)).toBe(c.enum);
      expect(stateMetadata(c.mesh)).toEqual(c.metadata ?? {});
      expect(a2aStateToMesh(c.json)).toBe(c.back ?? c.mesh);
    }
  });

  it("knock: the input, and the reading of a queued acknowledgement", () => {
    for (const c of FX.knock.inputs) {
      const r = knockInput(c.knock);
      expect(r.ok ? { input: r.input } : { refused: "KNOCK_CARRIES_NO_MESSAGE" }).toEqual(c.expect);
    }
    for (const c of FX.knock.acknowledgements) {
      expect(doorHeld({ payload: c.payload }) ? "auth-required" : "submitted").toBe(c.answer);
    }
  });

  it("readable text: the signature and §5.8's check together", async () => {
    for (const c of FX.readable_text.cases) {
      const ok = verifyEnvelopeSig(c.envelope as Envelope) && (await checkReadableText(c.envelope, c.text)).ok;
      expect({ name: c.name, ok }).toEqual({ name: c.name, ok: c.expect.ok });
    }
  });

  describe("state relay, through the real handler", () => {
    const open: Server[] = [];
    afterEach(() => {
      while (open.length) open.pop()!.close();
    });

    for (const c of FX.state_relay.cases) {
      it(c.name, async () => {
        const AGENT = "UAGENTPUBKEY";
        const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, apiKeys: { k1: "one", k2: "two" } });
        const manifest = manifestFixture({ offerings: [{ id: "request-quote", name: "Quote", description: "q" }] });
        const mesh = fakeConnect(bridge, { discover: async () => ({ agents: [manifest], total: 1 }), getManifest: async () => manifest });
        const server = await startInboundServer(bridge);
        open.push(server);
        const port = (server.address() as AddressInfo).port;
        if (c.task) {
          bridge.putTask({ task: { id: c.task.id, contextId: c.task.context, status: { state: meshStateToA2A(c.task.state) } }, responder: AGENT, callerKey: `key:${c.task.caller}`, offering: c.task.offering });
        }
        mesh.answer = () => ({ task_id: c.task?.id ?? null, payload: { status: "working" }, envelope: { id: "e-1" } });
        const res = await fetch(`http://127.0.0.1:${port}/agents/${AGENT}/rpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.caller}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ data: { split_delivery: true } }], ...c.message } } }),
        });
        const out = (await res.json()) as { error?: { code: number; data?: { agentmesh_code?: string } } };
        if (c.expect.relay) {
          expect(out.error).toBeUndefined();
          expect(mesh.requests).toHaveLength(1);
          expect(mesh.requests[0].offering).toBe(c.expect.relay.offering);
          expect(mesh.requests[0].config).toMatchObject({ task_id: c.expect.relay.task_id, context_id: c.expect.relay.context_id });
        } else {
          expect(out.error?.code).toBe(c.expect.error);
          if (c.expect.agentmesh_code) expect(out.error?.data?.agentmesh_code).toBe(c.expect.agentmesh_code);
          expect(mesh.requests).toHaveLength(0);
        }
      });
    }
  });
});
