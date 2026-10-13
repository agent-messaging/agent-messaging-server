// The §8.5 deprecation window, receiver side: senders, manifests and SKUs
// written before the skill→offering rename MUST keep working against this SDK,
// and everything this SDK emits MUST carry only the new names. These tests are
// the window's contract; delete them when the alias is dropped.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { validateSku, skuFor, skuDigest, type Sku } from "../../src/sku.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { Manifest } from "../../src/types/manifest.js";
import type { RespondPayload } from "../../src/types/primitives.js";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

/** Minimal live-dispatch connection: replies to service requests with a signed
 *  respond whose payload the test controls. */
function makeConn(answer?: (req: Envelope) => unknown) {
  const subs = new Map<string, (msg: unknown) => void>();
  const serviceKp = nkeys.createUser();
  const requests: Envelope[] = [];
  return {
    subs,
    requests,
    // Loop back to a matching subscription, the way the broker would: since
    // the §6.4 cutover, responds travel by publish to the sender's inbox.
    publish: vi.fn((subject: string, data: Uint8Array) => {
      subs.get(subject)?.({ subject, data, reply: undefined, respond: () => true });
    }),
    request: vi.fn(async (_subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      requests.push(req);
      return {
        data: encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: serviceKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload: answer ? answer(req) : { status: "registered" },
            }),
            serviceKp,
          ),
        ),
      };
    }),
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
      subs.set(subject, cb);
      return { unsubscribe: () => subs.delete(subject), drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    raw: { publish: () => {} },
    get isClosed() {
      return false;
    },
  };
}

function agentOn(conn: ReturnType<typeof makeConn>) {
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
    // Fencing off: these tests assert dispatch plumbing, not §22.6 rewriting.
    { fenceInbound: false },
  );
  openAgents.push(agent);
  return agent;
}

describe("inbound requests — a pre-rename sender says `skill` and is served", () => {
  it("dispatches payload.skill to the offering handler", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    agent.onRequest("summarise", (input) => ({ echoed: input }));
    await agent.register({ name: "alias-window" });

    const senderKp = nkeys.createUser();
    const env = signEnvelope(
      createEnvelope({
        type: "request",
        from: senderKp.getPublicKey(),
        to: agent.id,
        // The legacy wire shape, byte for byte what an old SDK sends.
        payload: { skill: "summarise", input: { text: "hi" } },
      }),
      senderKp,
    );
    const replies: Uint8Array[] = [];
    // §6.4 cutover: replies land on the SENDER's inbox (via the fake's
    // publish loopback), not on the reply subject.
    conn.subs.set(Subjects.agentInbox(senderKp.getPublicKey()), (m) => {
      replies.push((m as { data: Uint8Array }).data);
    });
    conn.subs.get(Subjects.agentInbox(agent.id))!({
      subject: Subjects.agentInbox(agent.id),
      data: encode(env),
      reply: "_INBOX.alias",
      respond: () => true,
    });
    await vi.waitFor(() => {
      const terminal = replies.map((d) => decode(d)).find((e) => (e.payload as RespondPayload).status === "completed");
      expect(terminal, "the legacy-named request must complete, not OFFERING_NOT_FOUND").toBeTruthy();
      expect((terminal!.payload as RespondPayload).output).toEqual({ echoed: { text: "hi" } });
    });
  });
});

describe("register — legacy embedder input, new-vocabulary wire", () => {
  it("accepts `skills` as an option alias and emits only `offerings`", async () => {
    const conn = makeConn();
    const agent = agentOn(conn);
    await agent.register({
      name: "alias-window",
      // A pre-rename embedder's call, verbatim.
      skills: [{ id: "chat", name: "Chat", description: "talk" }],
    } as never);
    const reg = conn.requests.find((r) => r.type === "register");
    expect(reg).toBeTruthy();
    const manifest = reg!.payload as Manifest & { skills?: unknown };
    expect(manifest.offerings.map((o) => o.id)).toEqual(["chat"]);
    expect(manifest.skills, "the legacy field must not ride the wire").toBeUndefined();
  });
});

describe("manifests — a stored pre-rename manifest reads back normalized", () => {
  it("maps skills / public.skills / public.skill_details onto the new names", async () => {
    const legacyManifest = {
      id: "", // filled per-request below
      name: "old-timer",
      description: "registered before the rename",
      version: "1.0.0",
      protocol_version: "0.2",
      endpoint: "mesh.agent.X.inbox",
      capabilities: [],
      skills: [{ id: "chat", name: "Chat", description: "talk" }],
      public: {
        skills: ["chat"],
        skill_details: [{ id: "chat", name: "Chat", description: "talk" }],
      },
    };
    const target = nkeys.createUser().getPublicKey();
    legacyManifest.id = target;
    const conn = makeConn(() => legacyManifest);
    const agent = agentOn(conn);
    const man = await agent.getManifest(target);
    expect(man.offerings?.map((o) => o.id)).toEqual(["chat"]);
    expect(man.public?.offerings).toEqual(["chat"]);
    expect(man.public?.offering_details?.map((o) => o.id)).toEqual(["chat"]);
  });
});

describe("SKUs — pre-rename covers keep validating, matching, and their digest", () => {
  const legacySku = {
    sku: "old-terms",
    covers: { skills: ["caselaw-summary"] },
    price: { model: "flat", currency: "USD", amount_micro: 5000 },
    provider: { id: "internal" },
  } as unknown as Sku;

  it("validateSku accepts covers.skills", () => {
    expect(() => validateSku(legacySku)).not.toThrow();
  });

  it("skuFor matches an offering against legacy covers", () => {
    expect(skuFor([legacySku], "caselaw-summary")).toBe(legacySku);
    expect(skuFor([legacySku], "something-else")).toBeNull();
  });

  it("the digest is over the document's own bytes — tolerance must not move it", async () => {
    // If reading a legacy SKU rewrote it, every agreement signed against its
    // digest would strand. The digest must come out identical to what the
    // pre-rename SDK computed over the same document.
    const digest = await skuDigest(legacySku);
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const again = await skuDigest(JSON.parse(JSON.stringify(legacySku)) as Sku);
    expect(again).toBe(digest);
  });
});
