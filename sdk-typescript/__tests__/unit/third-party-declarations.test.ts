// §8.8 `works_with` and §8.5.1's `credential` need — what an agent says about a
// service it does not own.
//
// Both exist for the same case: an agent that offers a better way to use
// somebody else's product, government site, or SaaS. The wrapper needs to be
// able to say what it connects to and what it will ask you to sign in to,
// because the alternative is that the honest one and the phishing one look
// identical. So what these tests pin is that the declarations survive
// registration verbatim, under the field names the spec gives them, and that
// the SDK never invents one on an agent's behalf: silence has to stay silence,
// or a caller cannot tell "did not say" from "declared none".
import { describe, it, expect, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import type { Manifest } from "../../src/types/manifest.js";
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
  await agent.register({ name: "DMV Helper", ...opts });
  return conn.registers[0]!;
}

describe("works_with (§8.8)", () => {
  it("rides the wire verbatim, under its own name", async () => {
    const m = await registered({
      works_with: [
        { service: "Colorado DMV", domain: "dmv.colorado.gov", description: "Renewals and lookups." },
      ],
    });
    expect(m.works_with).toEqual([
      { service: "Colorado DMV", domain: "dmv.colorado.gov", description: "Renewals and lookups." },
    ]);
  });

  it("is absent for an agent that did not say", async () => {
    const m = await registered();
    expect("works_with" in m && m.works_with !== undefined).toBe(false);
  });

  it("treats an empty array as having said nothing", async () => {
    // "Declared none" is a different claim from "did not say", and the SDK is
    // not entitled to make either one on the agent's behalf.
    const m = await registered({ works_with: [] });
    expect(m.works_with).toBeUndefined();
  });
});

describe("the credential need (§8.5.1)", () => {
  it("survives registration on the offering that will ask for it", async () => {
    const m = await registered({
      offerings: [
        {
          id: "renew",
          name: "Renew",
          description: "Renews a registration.",
          needs: [
            { credential: "Colorado DMV", scope: "read your registration record" },
            { text: "your plate number" },
          ],
        },
      ],
    });
    expect(m.offerings[0]?.needs).toEqual([
      { credential: "Colorado DMV", scope: "read your registration record" },
      { text: "your plate number" },
    ]);
  });

  it("does not appear on an offering that asks for nothing", async () => {
    const m = await registered({
      offerings: [{ id: "renew", name: "Renew", description: "Renews a registration." }],
    });
    expect(m.offerings[0]?.needs).toBeUndefined();
  });
});

describe("the card-level data_use declaration (§8.10)", () => {
  it("rides a manifest through serialization unchanged", () => {
    // Typed as Manifest so the compiler pins the §8.10 shape: promises spelled
    // as the literal true, retention a { max_days } ceiling, processors in the
    // §5.11 entry shape. The SDK carries the declaration; the registry is what
    // validates it (and drops an unreadable one whole) on the way in.
    const manifest: Manifest = {
      id: "UAGENT",
      name: "careful",
      description: "declares what happens to your content",
      version: "1.0.0",
      protocol_version: "0.2",
      endpoint: "mesh.agent.UAGENT.inbox",
      node: {
        id: "UNODE",
        attestation: { node: "UNODE", agent: "UAGENT", issued_at: "", expires_at: "", sig: "" },
      },
      capabilities: [],
      offerings: [],
      data_use: {
        promises: { no_training: true, no_third_party_sharing: true, no_human_reading: true },
        retention: { max_days: 30 },
        processors: [
          { service: "Anthropic API", domain: "anthropic.com", purpose: "model inference, zero-retention tier" },
        ],
      },
    };
    const bytes = JSON.stringify(manifest);
    const back = JSON.parse(bytes) as Manifest;
    expect(back.data_use).toEqual(manifest.data_use);
    expect(JSON.stringify(back)).toBe(bytes);
  });

  it("keeps absence absent, and an empty processors list as the statement it is", () => {
    // Absent means the agent has not said — a round-trip must not invent a
    // key for it. And Some([]) is a different statement from omission:
    // content leaves the operator for nowhere.
    const silent = { id: "UAGENT" } as unknown as Manifest;
    expect(JSON.stringify(silent)).not.toContain("data_use");
    const nowhere: Manifest["data_use"] = { processors: [] };
    expect(JSON.stringify(nowhere)).toBe('{"processors":[]}');
  });

  it("carries the §8.10 jurisdictions declaration through serialization unchanged", () => {
    // `processed_in` is a SET declaration in lowercase ISO 3166-1 alpha-2;
    // the SDK carries it verbatim — validation (two lowercase letters,
    // dedupe, empty refused) is the registry's job on the way in.
    const declared: Manifest["data_use"] = {
      promises: { no_training: true },
      processed_in: ["us", "de"],
    };
    const back = JSON.parse(JSON.stringify(declared)) as Manifest["data_use"];
    expect(back).toEqual(declared);
    expect(back?.processed_in).toEqual(["us", "de"]);
    // Absent stays absent: no jurisdiction key is invented for silence,
    // because an absent processed_in fails any jurisdiction requirement and
    // an invented one would change what the agent is claiming.
    expect(JSON.stringify({ promises: { no_training: true } } satisfies Manifest["data_use"])).not.toContain(
      "processed_in",
    );
  });
});

describe("the card-level compliance declarations (§8.11)", () => {
  it("ride a manifest through serialization unchanged", () => {
    // Typed as Manifest so the compiler pins the §8.11 shape: a lowercase
    // standard token, a scope in words, and the attestation POINTER — the
    // operator's own, never platform verification. The SDK carries the
    // declaration; the registry validates it (and drops an unreadable
    // member whole) on the way in.
    const manifest: Manifest = {
      id: "UAGENT",
      name: "regulated",
      description: "claims its compliance postures",
      version: "1.0.0",
      protocol_version: "0.2",
      endpoint: "mesh.agent.UAGENT.inbox",
      node: {
        id: "UNODE",
        attestation: { node: "UNODE", agent: "UAGENT", issued_at: "", expires_at: "", sig: "" },
      },
      capabilities: [],
      offerings: [],
      compliance: [
        {
          standard: "soc2",
          scope: "the hosted pipeline, Type II",
          attestation: { by: "Example Auditors LLP", url: "https://example.com/soc2", expires_at: "2027-03-01" },
        },
        { standard: "gdpr", scope: "as processor, under the engagement DPA" },
      ],
    };
    const bytes = JSON.stringify(manifest);
    const back = JSON.parse(bytes) as Manifest;
    expect(back.compliance).toEqual(manifest.compliance);
    expect(JSON.stringify(back)).toBe(bytes);
  });

  it("keeps absence absent: has-not-said must survive the round trip as silence", () => {
    const silent = { id: "UAGENT" } as unknown as Manifest;
    expect(JSON.stringify(silent)).not.toContain("compliance");
    // And an entry may carry the standard alone — scope and attestation are
    // the operator's to offer, not the type's to require.
    const bare: NonNullable<Manifest["compliance"]>[number] = { standard: "hipaa" };
    expect(JSON.stringify(bare)).toBe('{"standard":"hipaa"}');
  });
});
