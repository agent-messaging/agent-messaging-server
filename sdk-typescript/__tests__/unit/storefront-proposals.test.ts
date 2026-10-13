// Storefront proposals (§8.7, §8.12): the owner edits the listing in the
// console, the agent adopts it.
//
// The console cannot sign this agent's manifest, so an owner's save is stored
// as a proposal and the agent has to come and fetch it. Two implementations of
// that door now exist — mesh-adapter's `storefrontProposalApply` and this one —
// and they must agree, because the app tells every owner their edit "takes
// effect when the agent adopts it" without knowing which one is answering.
//
// What these tests pin, in order of how badly each would hurt if it broke:
//
//   1. THE SIGNATURE. It is the whole of the authorization: no session, no
//      token, just proof that whoever is asking holds the key the listing
//      belongs to. The bytes signed and their encoding have to match what the
//      server verifies (`verifyAgentSig`, standard base64, untagged canonical
//      string) or the door is closed to every SDK agent.
//   2. THE MERGE RULES, which are the adapter's: an empty description CLEARS
//      rather than being ignored, offerings replace wholesale rather than
//      merging, and a §8.12 member arriving as null means the owner cleared it
//      and must be deleted rather than stored empty.
//   3. THE ACK WAITS FOR THE RE-REGISTRATION. The adapter can ack a failed
//      republish because its merge is on disk; an SDK agent holds it in memory,
//      so acking a failed re-register would clear the proposal server-side and
//      lose the owner's words at the next restart.
//   4. A descriptor draft is adopted by neither half of this SDK, so a proposal
//      carrying one is NOT acked. Telling an owner their document was adopted
//      by an agent that threw it away is the failure this whole item exists to
//      stop.
//   5. Nothing polls unless a host asked for it.
import { describe, it, expect, afterEach, vi } from "vitest";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import type { Manifest } from "../../src/types/manifest.js";
import type { RegisterOptions } from "../../src/types/options.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode } from "../../src/internal/codec.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import {
  buildStorefrontProposalRequest,
  fetchStorefrontProposal,
  mergeStorefrontProposal,
  storefrontProposalCanonical,
  storefrontProposalEndpoint,
  type StorefrontProposal,
} from "../../src/storefront.js";

const REGISTER = "mesh.registry.register";

/** A registry that records every manifest it is sent and answers the way the
 *  real one does (signed, bound to the request), because the SDK refuses
 *  anything else. */
function makeConn() {
  const registryKp = nkeys.createUser();
  const registers: Manifest[] = [];
  return {
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
}

/** The control plane, as the SDK sees it: one POST door that hands out a
 *  pending proposal and clears it when acked. Records every call so a test can
 *  say what the agent asked for and in what order. */
function makeDoor(proposal: StorefrontProposal | null) {
  const calls: Array<{ agent: string; ts: string; sig: string; ack?: string }> = [];
  let pending = proposal;
  let failFetch: string | null = null;
  let failAck: string | null = null;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ ...body, url: String(url) });
    if (body.ack !== undefined) {
      if (failAck) return new Response(JSON.stringify({ error: failAck }), { status: 503 });
      const cleared = pending?.proposed_at === body.ack;
      if (cleared) pending = null;
      return new Response(JSON.stringify({ ok: true, cleared }), { status: 200 });
    }
    if (failFetch) return new Response(JSON.stringify({ error: failFetch }), { status: 503 });
    return new Response(JSON.stringify({ proposal: pending }), { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    get pending() {
      return pending;
    },
    set pending(p: StorefrontProposal | null) {
      pending = p;
    },
    failFetchWith(reason: string | null) {
      failFetch = reason;
    },
    failAckWith(reason: string | null) {
      failAck = reason;
    },
    get fetches() {
      return calls.filter((c) => c.ack === undefined);
    },
    get acks() {
      return calls.filter((c) => c.ack !== undefined);
    },
  };
}

const open: AgentMesh[] = [];
afterEach(async () => {
  for (const a of open.splice(0)) await a.close().catch(() => {});
});

/** An agent on a recording connection, with its own key so signatures can be
 *  verified against it. Registered, so the adopter is armed. */
async function agentWith(opts: Partial<RegisterOptions> = {}, warnings: unknown[] = []) {
  const conn = makeConn();
  const kp = nkeys.createUser();
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    kp,
    nkeys.createUser(),
    { onSecurityWarning: (w) => warnings.push(w) },
  );
  open.push(agent);
  await agent.register({ name: "Listed Agent", ...opts });
  return { agent, conn, kp, warnings };
}

describe("the signature is the authorization", () => {
  it("signs the untagged canonical string the server verifies", () => {
    const kp = nkeys.createUser();
    const seed = new TextDecoder().decode(kp.getSeed());
    const body = buildStorefrontProposalRequest(kp.getPublicKey(), seed);
    const canonical = storefrontProposalCanonical(kp.getPublicKey(), body.ts);
    expect(canonical).toBe(`storefront-proposal-v1:${kp.getPublicKey()}:${body.ts}:fetch`);
    // Standard base64, decoded the way server/src/api/held-store.ts decodes
    // it, verified against the agent's public key.
    const sig = Uint8Array.from(atob(body.sig), (c) => c.charCodeAt(0));
    expect(nkeys.fromPublic(kp.getPublicKey()).verify(new TextEncoder().encode(canonical), sig)).toBe(true);
  });

  it("signs a different string for an ack than for a fetch", () => {
    // The literal "fetch" stands in for the absent ack precisely so a captured
    // fetch signature cannot be replayed as an acknowledgement of anything.
    const kp = nkeys.createUser();
    const seed = new TextDecoder().decode(kp.getSeed());
    const at = new Date("2026-09-12T10:00:00.000Z");
    const f = buildStorefrontProposalRequest(kp.getPublicKey(), seed, undefined, at);
    const a = buildStorefrontProposalRequest(kp.getPublicKey(), seed, "2026-09-12T09:00:00.000Z", at);
    expect(f.sig).not.toBe(a.sig);
    expect(a.ack).toBe("2026-09-12T09:00:00.000Z");
    expect("ack" in f).toBe(false);
  });

  it("stamps a fresh ISO timestamp, because the server only accepts a recent one", () => {
    const kp = nkeys.createUser();
    const body = buildStorefrontProposalRequest(kp.getPublicKey(), new TextDecoder().decode(kp.getSeed()));
    expect(Math.abs(Date.now() - Date.parse(body.ts))).toBeLessThan(5 * 60_000);
  });

  it("knocks on the door the adapter knocks on", () => {
    expect(storefrontProposalEndpoint("https://api.agentmesh.ai")).toBe(
      "https://api.agentmesh.ai/v1/storefront-proposals",
    );
    expect(storefrontProposalEndpoint("https://api.agentmesh.ai/")).toBe(
      "https://api.agentmesh.ai/v1/storefront-proposals",
    );
  });
});

describe("the merge rules, which are the adapter's", () => {
  const at = "2026-09-12T10:00:00.000Z";

  it("takes the owner's description", () => {
    const a = mergeStorefrontProposal(
      { public: { description: "old" } },
      { public: { description: "  what this agent actually does  " }, proposed_at: at },
    );
    expect(a.public?.description).toBe("what this agent actually does");
    expect(a.changed).toEqual(["description"]);
  });

  it("CLEARS a description the owner emptied", () => {
    // Present-and-empty is an instruction, not a mistake. Reading it as "no
    // change" would make a description impossible to withdraw once written.
    const a = mergeStorefrontProposal({ public: { description: "old" } }, { public: { description: "" }, proposed_at: at });
    expect(a.public?.description).toBeUndefined();
    expect(a.changed).toEqual(["description"]);
  });

  it("replaces the advertised offerings wholesale rather than merging them", () => {
    // §8.7's field is a SELECTION OF IDS. A union would make unticking
    // something in the console impossible.
    const a = mergeStorefrontProposal(
      { public: { offerings: ["chat", "summarize"] } },
      { public: { offerings: ["chat"] }, proposed_at: at },
    );
    expect(a.public?.offerings).toEqual(["chat"]);
  });

  it("adopts the example questions the console sends on every save", () => {
    // The one place this deliberately differs from mesh-adapter, whose merge
    // drops the field: the console sends it, the API validates and stores it,
    // and dropping it breaks the same promise this client exists to keep.
    const a = mergeStorefrontProposal({}, { public: { example_queries: ["What is my balance?"] }, proposed_at: at });
    expect(a.public?.example_queries).toEqual(["What is my balance?"]);
    expect(a.changed).toContain("example_queries");
  });

  it("takes the §8.12 declarations one member at a time", () => {
    const a = mergeStorefrontProposal(
      { listing: { serves: "hirer" } },
      { listing: { coverage: { regions: ["US"] } }, proposed_at: at },
    );
    expect(a.listing).toEqual({ serves: "hirer", coverage: { regions: ["US"] } });
    expect(a.changed).toEqual(["listing.coverage"]);
  });

  it("DELETES a §8.12 member the owner cleared rather than storing it empty", () => {
    // An empty `coverage` publishes "I have said something about my coverage
    // and it is nothing", which is a different and worse claim than silence.
    const a = mergeStorefrontProposal(
      { listing: { serves: "hirer", coverage: { regions: ["US"] } } },
      { listing: { coverage: null }, proposed_at: at },
    );
    expect(a.listing).toEqual({ serves: "hirer" });
    expect(a.changed).toEqual(["listing.coverage"]);
  });

  it("reports nothing changed when the proposal matches what is already published", () => {
    const current = { public: { description: "same", offerings: ["chat"] } };
    const a = mergeStorefrontProposal(current, { public: { description: "same", offerings: ["chat"] }, proposed_at: at });
    expect(a.changed).toEqual([]);
  });

  it("never mutates what the agent is currently registering", () => {
    const current = { public: { description: "old" }, listing: { serves: "hirer" as const } };
    mergeStorefrontProposal(current, { public: { description: "new" }, listing: { serves: null }, proposed_at: at });
    expect(current.public.description).toBe("old");
    expect(current.listing.serves).toBe("hirer");
  });

  it("flags a descriptor draft as unadopted rather than pretending", () => {
    const a = mergeStorefrontProposal({}, { public: { description: "hi" }, descriptor: { agent_version: "2" }, proposed_at: at });
    expect(a.unadopted).toEqual(["descriptor"]);
    expect(a.public?.description).toBe("hi");
  });
});

describe("fetching", () => {
  it("returns null when nothing is pending", async () => {
    const kp = nkeys.createUser();
    const door = makeDoor(null);
    const got = await fetchStorefrontProposal({
      apiBase: "https://api.example",
      agentKey: kp.getPublicKey(),
      seed: new TextDecoder().decode(kp.getSeed()),
      fetchImpl: door.fetchImpl,
    });
    expect(got).toBeNull();
  });

  it("treats a proposal with no proposed_at as nothing", async () => {
    // The ack names `proposed_at`. A proposal without one could never be
    // cleared, so adopting it would re-register the same edit forever.
    const kp = nkeys.createUser();
    const door = makeDoor({ public: { description: "hi" } } as unknown as StorefrontProposal);
    const got = await fetchStorefrontProposal({
      apiBase: "https://api.example",
      agentKey: kp.getPublicKey(),
      seed: new TextDecoder().decode(kp.getSeed()),
      fetchImpl: door.fetchImpl,
    });
    expect(got).toBeNull();
  });

  it("throws on a refusal, so 'could not ask' is not read as 'nothing to adopt'", async () => {
    const kp = nkeys.createUser();
    const door = makeDoor(null);
    door.failFetchWith("stale timestamp");
    await expect(
      fetchStorefrontProposal({
        apiBase: "https://api.example",
        agentKey: kp.getPublicKey(),
        seed: new TextDecoder().decode(kp.getSeed()),
        fetchImpl: door.fetchImpl,
      }),
    ).rejects.toThrow(/stale timestamp/);
  });
});

describe("adopting, end to end through a registered agent", () => {
  const at = "2026-09-12T10:00:00.000Z";

  it("re-registers with the owner's words and then acks", async () => {
    const door = makeDoor({ public: { description: "Books meeting rooms.", offerings: ["book"] }, proposed_at: at });
    const { agent, conn } = await agentWith({
      offerings: [{ id: "book", name: "Book", description: "Book a room" }],
      storefrontProposals: { apiBase: "https://api.example", fetchImpl: door.fetchImpl },
    });

    const pass = await agent.adoptStorefront();
    expect(pass.registered).toBe(true);
    expect(pass.acked).toBe(true);
    // The manifest the registry actually received, signed by this agent's key.
    const last = conn.registers[conn.registers.length - 1]!;
    expect(last.public?.description).toBe("Books meeting rooms.");
    expect(last.public?.offerings).toEqual(["book"]);
    // The ack names the proposal it adopted, or it clears nothing.
    expect(door.acks.at(-1)?.ack).toBe(at);
    expect(door.pending).toBeNull();
  });

  it("keeps the owner's words across a vouch renewal months later", async () => {
    // The merge goes into what this agent REGISTERS, not only into the one
    // manifest it sent: a renewal rebuilds from the stored options, and a merge
    // that lived anywhere else would be undone by the next one.
    const door = makeDoor({ public: { description: "Adopted." }, proposed_at: at });
    const { agent, conn } = await agentWith({
      storefrontProposals: { apiBase: "https://api.example", fetchImpl: door.fetchImpl },
    });
    await agent.adoptStorefront();
    await agent.renewVouch();
    expect(conn.registers.at(-1)!.public?.description).toBe("Adopted.");
  });

  it("carries an adopted §8.12 declaration onto the manifest at card level", async () => {
    const door = makeDoor({ listing: { serves: "hirer", edge: "declines" }, proposed_at: at });
    const { agent, conn } = await agentWith({
      storefrontProposals: { apiBase: "https://api.example", fetchImpl: door.fetchImpl },
    });
    await agent.adoptStorefront();
    const last = conn.registers.at(-1)!;
    expect(last.serves).toBe("hirer");
    expect(last.edge).toBe("declines");
  });

  it("does not re-register when there is nothing pending", async () => {
    const door = makeDoor(null);
    const { agent, conn } = await agentWith({
      storefrontProposals: { apiBase: "https://api.example", fetchImpl: door.fetchImpl },
    });
    const before = conn.registers.length;
    const pass = await agent.adoptStorefront();
    expect(pass.proposal).toBeNull();
    expect(conn.registers.length).toBe(before);
    expect(door.acks).toHaveLength(0);
  });

  it("acknowledges a proposal that asks for what the manifest already says, without re-registering", async () => {
    const door = makeDoor({ public: { description: "Already this." }, proposed_at: at });
    const { agent, conn } = await agentWith({
      public: { description: "Already this." },
      storefrontProposals: { apiBase: "https://api.example", fetchImpl: door.fetchImpl },
    });
    const before = conn.registers.length;
    const pass = await agent.adoptStorefront();
    expect(pass.registered).toBe(false);
    expect(pass.acked).toBe(true);
    expect(conn.registers.length).toBe(before);
  });

  it("does NOT ack when the re-registration failed", async () => {
    // The adapter can ack a failed republish because its merge is on disk. This
    // one is in memory: acking would clear the proposal and lose the edit.
    const door = makeDoor({ public: { description: "Never published." }, proposed_at: at });
    const conn = makeConn();
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    open.push(agent);
    await agent.register({
      name: "Listed Agent",
      storefrontProposals: { apiBase: "https://api.example", fetchImpl: door.fetchImpl },
    });
    conn.request = async () => {
      throw new Error("registry is down");
    };
    const pass = await agent.adoptStorefront();
    expect(pass.acked).toBe(false);
    expect(door.acks).toHaveLength(0);
    expect(door.pending).not.toBeNull();
  });

  it("retries only the ack when the same proposal comes back", async () => {
    // A repeat means our ack did not land: the server clears on ack and would
    // not otherwise hand the same edit back. Re-registering again would be a
    // registry round trip for a manifest that is already correct.
    const door = makeDoor({ public: { description: "Adopted once." }, proposed_at: at });
    door.failAckWith("control plane unavailable");
    const { agent, conn } = await agentWith({
      storefrontProposals: { apiBase: "https://api.example", fetchImpl: door.fetchImpl },
    });
    await agent.adoptStorefront();
    const afterFirst = conn.registers.length;
    door.failAckWith(null);
    const second = await agent.adoptStorefront();
    expect(second.registered).toBe(false);
    expect(second.acked).toBe(true);
    expect(conn.registers.length).toBe(afterFirst);
    expect(door.pending).toBeNull();
  });

  it("adopts what it can of a proposal carrying a descriptor, and leaves it pending", async () => {
    const warnings: Array<{ code: string }> = [];
    const door = makeDoor({
      public: { description: "Half adoptable." },
      descriptor: { format: "agent-descriptor-v1", agent_version: "2" },
      proposed_at: at,
    });
    const { agent, conn } = await agentWith(
      { storefrontProposals: { apiBase: "https://api.example", fetchImpl: door.fetchImpl } },
      warnings,
    );
    const pass = await agent.adoptStorefront();
    expect(conn.registers.at(-1)!.public?.description).toBe("Half adoptable.");
    expect(pass.acked).toBe(false);
    expect(door.pending).not.toBeNull();
    expect(warnings.map((w) => w.code)).toContain("storefront_partly_unadopted");
    // And it STAYS pending on the next pass. Acking a minute later would undo
    // the decision one tick after making it, which is what the repeat branch
    // would otherwise do: a proposal coming back normally means our ack was
    // lost, and that reading is wrong for this one.
    const second = await agent.adoptStorefront();
    expect(second.acked).toBe(false);
    expect(door.acks).toHaveLength(0);
    expect(door.pending).not.toBeNull();
    // Once per condition, not once per tick: a sink that gets the same line
    // every minute is a sink somebody turns off.
    expect(warnings.filter((w) => w.code === "storefront_partly_unadopted")).toHaveLength(1);
  });

  it("reports a failed pass through the security-warning sink and keeps the agent up", async () => {
    const warnings: Array<{ code: string }> = [];
    const door = makeDoor(null);
    door.failFetchWith("service unavailable");
    const { agent } = await agentWith(
      { storefrontProposals: { apiBase: "https://api.example", fetchImpl: door.fetchImpl } },
      warnings,
    );
    const pass = await agent.adoptStorefront();
    expect(pass.proposal).toBeNull();
    expect(warnings.map((w) => w.code)).toContain("storefront_poll_failed");
  });
});

describe("nothing polls unless a host asked for it", () => {
  it("makes no HTTP call at all for an agent that did not configure adoption", async () => {
    const spy = vi.fn();
    const { agent } = await agentWith({});
    // There is no adopter to drive, and saying so is better than doing nothing:
    // a silent no-op is indistinguishable from having adopted nothing.
    await expect(agent.adoptStorefront()).rejects.toThrow(/storefrontProposals/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("stops adopting when the agent deregisters", async () => {
    const door = makeDoor({ public: { description: "gone" }, proposed_at: "2026-09-12T10:00:00.000Z" });
    const { agent } = await agentWith({
      storefrontProposals: { apiBase: "https://api.example", fetchImpl: door.fetchImpl },
    });
    await agent.deregister();
    await expect(agent.adoptStorefront()).rejects.toThrow(/storefrontProposals/);
  });
});

describe("§8.12 declarations at register", () => {
  it("rides the manifest at card level, verbatim", async () => {
    const { conn } = await agentWith({
      audience: { built_for: ["operations teams"] },
      coverage: { regions: ["US", "CA"] },
      edge: "declines",
      acts: { mode: "read" },
      serves: "hirer",
      parties: [{ name: "Example Ltd", role: "operator" }],
      origin: { written_by: "developer", run_by: "builder" },
    } as Partial<RegisterOptions>);
    const m = conn.registers[0]!;
    expect(m.audience).toEqual({ built_for: ["operations teams"] });
    expect(m.coverage).toEqual({ regions: ["US", "CA"] });
    expect(m.edge).toBe("declines");
    expect(m.acts).toEqual({ mode: "read" });
    expect(m.serves).toBe("hirer");
    expect(m.parties).toEqual([{ name: "Example Ltd", role: "operator" }]);
    expect(m.origin).toEqual({ written_by: "developer", run_by: "builder" });
  });

  it("leaves every member off for an agent that said nothing", async () => {
    // Absent means "has not said", which §8.12 makes a distinct answer. The SDK
    // must not invent a key in either direction.
    const { conn } = await agentWith({});
    const m = conn.registers[0]! as unknown as Record<string, unknown>;
    for (const k of ["audience", "coverage", "edge", "acts", "serves", "parties", "origin"]) {
      expect(k in m).toBe(false);
    }
  });
});
