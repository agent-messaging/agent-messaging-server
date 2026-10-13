// §8.10 `data_use` at register — the card-level data-use declaration, settable
// as a register option instead of by hand-editing a manifest.
//
// What these tests pin is the pass-through contract: the declaration rides the
// registered manifest VERBATIM under the field name the spec gives it, the SDK
// never invents one on an agent's behalf (silence stays silence), and the SDK
// does NOT duplicate the registry's drop rules — a shape the registry would
// refuse still leaves this SDK untouched, because the registry is the one
// validator and its verdict must be the only verdict.
import { describe, it, expect, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import type { AgentDataUse, Manifest } from "../../src/types/manifest.js";
import type { RegisterOptions } from "../../src/types/options.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode } from "../../src/internal/codec.js";
import type { ConnectionManager } from "../../src/internal/connection.js";

const REGISTER = "mesh.registry.register";

/** A registry that records the manifest it was sent and answers the way the
 *  real one does (signed, bound to the request), because the SDK refuses
 *  anything else. */
function makeConn() {
  const registryKp = nkeys.createUser();
  const registers: Manifest[] = [];
  const conn = {
    registers,
    publish: () => {},
    request: async (subject: string, data: Uint8Array) => {
      const req = decode(data);
      if (subject === REGISTER) registers.push(req.payload as Manifest);
      return {
        data: encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: registryKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload: { status: "registered" },
            }),
            registryKp,
          ),
        ),
      };
    },
    subscribe: () => ({ unsubscribe: () => {}, drain: async () => {} }),
    drain: async () => {},
    close: async () => {},
    get isClosed() {
      return false;
    },
  };
  return conn;
}

const open: AgentMesh[] = [];
afterEach(async () => {
  for (const a of open.splice(0)) await a.close().catch(() => {});
});

/** Register once and hand back the manifest the registry actually received. */
async function registered(opts: Partial<RegisterOptions> = {}): Promise<Manifest> {
  const conn = makeConn();
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
  );
  open.push(agent);
  await agent.register({ name: "Careful Agent", ...opts });
  return conn.registers[0]!;
}

describe("data_use as a register option (§8.10)", () => {
  it("rides the registered manifest verbatim, under its own name", async () => {
    const declaration: AgentDataUse = {
      promises: { no_training: true, no_third_party_sharing: true },
      retention: { max_days: 30 },
      processors: [
        { service: "Anthropic API", domain: "anthropic.com", purpose: "model inference" },
      ],
    };
    const m = await registered({ data_use: declaration });
    expect(m.data_use).toEqual(declaration);
  });

  it("is absent for an agent that did not say", async () => {
    // Absence means "has not said" — the SDK must not invent the key, in
    // either direction, because a requirement stated against data_use treats
    // absence as not meeting it (fail closed).
    const m = await registered();
    expect("data_use" in m && m.data_use !== undefined).toBe(false);
  });

  it("keeps an empty processors list as the statement it is", async () => {
    // Some([]) is a different claim from omission: content leaves the
    // operator for NOWHERE. Pass-through must not normalize it away.
    const m = await registered({ data_use: { processors: [] } });
    expect(m.data_use).toEqual({ processors: [] });
  });

  it("does not enforce the registry's drop rules — pass-through only", async () => {
    // A promise spelled `false` is a spelling §8.10 refuses, and the REGISTRY
    // drops the declaration whole for it. The SDK deliberately does not: the
    // rules live in one place, and the registry's verdict is the only one.
    const misspelled = { promises: { no_training: false } } as unknown as AgentDataUse;
    const m = await registered({ data_use: misspelled });
    expect(m.data_use).toEqual(misspelled);
  });
});
