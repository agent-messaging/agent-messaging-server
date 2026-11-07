/**
 * The gateway's half of conformance/a2a-binding.json: each binding error
 * becomes the JSON-RPC error the fixture names (by its integer, with its
 * data), and the older offering keys gain the extension's key before a frame
 * is signed (the A2A Bridge §4.5).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bindingErrorToRpc, withOfferingKey } from "../src/inbound/binding-pass.js";
import { A2AError, isA2AErrorName } from "../../sdk-typescript/src/a2a/errors.js";
import { MeshError } from "../../sdk-typescript/src/types/errors.js";

const here = dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const F: any = JSON.parse(readFileSync(join(here, "..", "..", "conformance", "a2a-binding.json"), "utf8"));

describe("binding errors as JSON-RPC errors (§9; the A2A Bridge §7)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.errors.cases as any[]) {
    it(c.name, () => {
      const e = c.frames[1].error;
      const err = isA2AErrorName(e.code) ? A2AError.fromErrorObject(e)! : MeshError.fromErrorObject(e);
      expect(bindingErrorToRpc(c.jsonrpc.id, err).body).toEqual(c.jsonrpc);
    });
  }
});

describe("the older offering keys (§12.1; the A2A Bridge §4.5)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of (F.offering.cases as any[]).filter((x) => x.window && (x.metadata["agentmesh.offering"] ?? x.metadata["agentmesh.skill"]) !== undefined)) {
    it(c.name, () => {
      const out = withOfferingKey({ message: { messageId: "m", role: "ROLE_USER", parts: [], metadata: c.metadata } }, c.declared);
      if ("error" in c.expect) {
        expect(out).toEqual({ error: true, offerings: c.expect.offerings });
      } else {
        const md = (out as { params: { message: { metadata: Record<string, unknown> } } }).params.message.metadata;
        expect(md["https://agentmessaging.ai/extensions/offering/v1"]).toEqual({ offering: c.expect.offering });
      }
    });
  }
});
