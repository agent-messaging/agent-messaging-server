// §19.5 enforcement at admission — the three states that are the point of the
// whole mechanism:
//
//   1. no agreement          → AGREEMENT_REQUIRED, before any work
//   2. agreement at the digest → the handler runs
//   3. the seller re-prices  → the digest moves, and (2) refuses again
//
// Driven through the real inbound dispatch (the allowance test's harness), so
// what is asserted is what an actual caller would receive.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode } from "../../src/types/errors.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { RespondPayload } from "../../src/types/primitives.js";
import { signAgreement, type AgreementDocument } from "../../src/agreement.js";
import { skuDigest, type Sku } from "../../src/sku.js";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

const APPROVAL = "https://app.example.com/agreements/approve";

/** The buyer: an agent whose manifest names `ownerKp` as its owner. */
const buyerKp = nkeys.createUser();
const buyerOwnerKp = nkeys.createUser();

/**
 * A connection double that answers the two service calls enforcement makes:
 * the registry `get` (owner resolution) and `mesh.agreements.list` (the
 * platform's filtered agreement record). `agreements` is mutable so a test can
 * approve between requests.
 */
function makeConn(state: { agreements: AgreementDocument[]; sellerOwner?: string }) {
  const subs = new Map<string, (msg: unknown) => void>();
  const serviceKp = nkeys.createUser();
  const answer = (req: Envelope, payload: Record<string, unknown>) =>
    encode(
      signEnvelope(
        createEnvelope({
          type: "respond",
          from: serviceKp.getPublicKey(),
          to: req.from,
          in_reply_to: req.id,
          payload,
        }),
        serviceKp,
      ),
    );
  return {
    subs,
    lookups: [] as string[],
    // Loop back to a matching subscription, the way the broker would: since
    // the §6.4 cutover, responds travel by publish to the sender's inbox.
    publish: vi.fn((subject: string, data: Uint8Array) => {
      subs.get(subject)?.({ subject, data, reply: undefined, respond: () => true });
    }),
    request: vi.fn(async function (this: { lookups: string[] }, subject: string, data: Uint8Array) {
      const req = decodeUnverified(data);
      if (subject === "mesh.agreements.list") {
        const owner = (req.payload as { consumer_owner: string }).consumer_owner;
        conn.lookups.push(owner);
        // The service filters to the asking seller; mirror that here.
        return {
          data: answer(req, {
            agreements: state.agreements.filter((a) => a.seller_agent === req.from),
          }),
        };
      }
      // The platform serves the funds hold beside the agreement lookup (the
      // funds-hold contract), and a covered request now asks for one before
      // the work is admitted. Coverage is what THIS file is about, so the
      // balance always authorises here; funds-hold.test.ts is where the
      // balance itself is the question.
      if (subject === "mesh.funds.hold") {
        return {
          data: answer(req, {
            hold_id: "job:agreement-unit",
            amount_micro: 1500,
            currency: "USD",
            free: false,
          }),
        };
      }
      if (subject === "mesh.funds.release") {
        return { data: answer(req, { released: true }) };
      }
      if (subject === Subjects.registryGet(buyerKp.getPublicKey())) {
        return { data: answer(req, { id: buyerKp.getPublicKey(), owner: buyerOwnerKp.getPublicKey() }) };
      }
      // The SELLER's own manifest, which enforcement reads to find out whether
      // it is being asked to sell to its own owner. Unset means the deployment
      // cannot establish it, which must leave enforcement unchanged.
      if (state.sellerOwner && subject.startsWith("mesh.registry.get.")) {
        return { data: answer(req, { owner: state.sellerOwner }) };
      }
      return { data: answer(req, { status: "registered" }) };
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
let conn: ReturnType<typeof makeConn>;

const paidSku = (amountMicro: number): Sku => ({
  sku: "default",
  covers: { agent: true },
  price: { model: "per_unit", currency: "USD", meter: "tokens_out", per: 1000, amount_micro: amountMicro },
  provider: { id: "internal", checkout_url: APPROVAL },
});

const freeSku: Sku = {
  sku: "gratis",
  covers: { offerings: ["free-thing"] },
  price: { model: "free" },
  provider: { id: "internal" },
};

async function makeSeller(skus: Sku[], state: { agreements: AgreementDocument[]; sellerOwner?: string }) {
  conn = makeConn(state);
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
  );
  openAgents.push(agent);
  agent.onRequest("work", () => "did the work");
  agent.onRequest("free-thing", () => "free work");
  await agent.register({ name: "seller-unit", skus });
  return agent;
}

/** Deliver a request from the buyer and collect the replies. */
function send(agent: AgentMesh, offering = "work"): Envelope[] {
  const reqEnv = signEnvelope(
    createEnvelope({
      type: "request",
      from: buyerKp.getPublicKey(),
      to: agent.id,
      payload: { offering, input: "please" },
    }),
    buyerKp,
  );
  const replies: Envelope[] = [];
  // §6.4 cutover: replies land on the SENDER's inbox (via the fake's publish
  // loopback), not on the reply subject.
  conn.subs.set(Subjects.agentInbox(buyerKp.getPublicKey()), (m) => {
    replies.push(decode((m as { data: Uint8Array }).data));
  });
  conn.subs.get(Subjects.agentInbox(agent.id))!({
    subject: Subjects.agentInbox(agent.id),
    data: encode(reqEnv),
    reply: "_INBOX.agreement-unit",
    respond: () => true,
  });
  return replies;
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const terminalOf = (replies: Envelope[]) =>
  replies.find((e) => (e.payload as RespondPayload | undefined)?.status !== "accepted");

const agreementFor = (seller: string, digest: string): AgreementDocument =>
  signAgreement(
    {
      v: 1,
      seller_agent: seller,
      sku: "default",
      sku_digest: digest,
      agreed_at: "2026-08-02T15:00:00Z",
    } as never,
    buyerOwnerKp,
  );

describe("§19.5 admission enforcement", () => {
  it("1. no agreement: AGREEMENT_REQUIRED, before any work, naming where to approve", async () => {
    const state = { agreements: [] as AgreementDocument[] };
    const agent = await makeSeller([paidSku(1500)], state);
    const replies = send(agent);
    await settle();

    const terminal = terminalOf(replies);
    expect(terminal?.error?.code).toBe(ErrorCode.AGREEMENT_REQUIRED);
    expect(terminal?.error?.retryable).toBe(false);
    const details = terminal?.error?.details as { sku: string; sku_digest: string; approval_url: string };
    expect(details.sku).toBe("default");
    expect(details.approval_url).toBe(APPROVAL);
    expect(details.sku_digest).toBe(await skuDigest(paidSku(1500)));
    // Refused at admission means the handler never ran: no output came back.
    expect(replies.some((e) => (e.payload as RespondPayload)?.output !== undefined)).toBe(false);
    // And the refusal is the FIRST reply — never after an accept (§6.4a).
    expect((replies[0].payload as RespondPayload).status).toBe("failed");
  });

  it("2. an agreement at the current digest admits the work", async () => {
    const sku = paidSku(1500);
    const state = { agreements: [] as AgreementDocument[] };
    const agent = await makeSeller([sku], state);
    state.agreements = [agreementFor(agent.id, await skuDigest(sku))];

    const replies = send(agent);
    await settle();
    const terminal = terminalOf(replies);
    expect(terminal?.error).toBeUndefined();
    expect((terminal?.payload as RespondPayload).output).toBe("did the work");
  });

  it("3. the seller re-prices: the digest moves and the standing agreement goes stale", async () => {
    const oldSku = paidSku(1500);
    const state = { agreements: [] as AgreementDocument[] };
    const agent = await makeSeller([oldSku], state);
    state.agreements = [agreementFor(agent.id, await skuDigest(oldSku))];

    // Proven covered at the old price.
    expect(terminalOf(send(agent))?.error).toBeUndefined();
    await settle();

    // One micro-unit more: a new registration, a new digest, and the standing
    // agreement now covers terms that no longer exist.
    const newSku = paidSku(1501);
    await agent.register({ name: "seller-unit", skus: [newSku] });
    const replies = send(agent);
    await settle();

    const terminal = terminalOf(replies);
    expect(terminal?.error?.code).toBe(ErrorCode.AGREEMENT_REQUIRED);
    expect((terminal?.error?.details as { sku_digest: string }).sku_digest).toBe(await skuDigest(newSku));
  });
});

describe("calling your own agent", () => {
  // An agreement exists so a stranger cannot be charged a price they never saw.
  // When both sides are one account there is no stranger, and the ceremony is a
  // signature you give yourself, recording a promise to pay yourself, checked
  // against your own price.

  it("admits a caller whose owner is the seller's own owner, with no agreement", async () => {
    const state = {
      agreements: [] as AgreementDocument[],
      sellerOwner: buyerOwnerKp.getPublicKey(), // same account on both sides
    };
    const agent = await makeSeller([paidSku(1500)], state);
    const replies = send(agent);
    await settle();

    const terminal = terminalOf(replies);
    expect(terminal?.error).toBeUndefined();
    expect((terminal?.payload as RespondPayload).output).toBe("did the work");
  });

  it("does not go looking for an agreement it has already decided it does not need", async () => {
    const state = {
      agreements: [] as AgreementDocument[],
      sellerOwner: buyerOwnerKp.getPublicKey(),
    };
    const agent = await makeSeller([paidSku(1500)], state);
    send(agent);
    await settle();
    // The exemption is checked before the platform lookup, so a self-call costs
    // no round trip to the agreement service.
    expect(conn.lookups).toHaveLength(0);
  });

  it("still refuses a caller owned by somebody else", async () => {
    // The exemption must turn on identity, not merely on an owner being known.
    const state = {
      agreements: [] as AgreementDocument[],
      sellerOwner: nkeys.createUser().getPublicKey(),
    };
    const agent = await makeSeller([paidSku(1500)], state);
    const replies = send(agent);
    await settle();
    expect(terminalOf(replies)?.error?.code).toBe(ErrorCode.AGREEMENT_REQUIRED);
  });

  it("still refuses when the seller's own owner cannot be established", async () => {
    // A null owner on either side must never read as "same owner": that would
    // turn an unreachable registry into free paid work.
    const state = { agreements: [] as AgreementDocument[] }; // no sellerOwner
    const agent = await makeSeller([paidSku(1500)], state);
    const replies = send(agent);
    await settle();
    expect(terminalOf(replies)?.error?.code).toBe(ErrorCode.AGREEMENT_REQUIRED);
  });
});

describe("§19.1 what enforcement does NOT touch", () => {
  it("an offering covered by a free SKU runs without any lookup", async () => {
    const state = { agreements: [] as AgreementDocument[] };
    const agent = await makeSeller([paidSku(1500), freeSku], state);
    const replies = send(agent, "free-thing");
    await settle();
    expect((terminalOf(replies)?.payload as RespondPayload).output).toBe("free work");
    expect(conn.lookups).toHaveLength(0); // free never pays for a lookup
  });

  it("an agent that declares no SKUs at all is free and never refuses", async () => {
    const state = { agreements: [] as AgreementDocument[] };
    const agent = await makeSeller([], state);
    const replies = send(agent);
    await settle();
    expect((terminalOf(replies)?.payload as RespondPayload).output).toBe("did the work");
  });

  it("a paid SKU with no approval route advertises but does not enforce", async () => {
    // Refusing a buyer who has nowhere to go is a dead end; the SDK warns at
    // registration instead (asserted here so the trade stays deliberate).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const noRoute: Sku = { ...paidSku(1500), provider: { id: "internal" } };
    const state = { agreements: [] as AgreementDocument[] };
    const agent = await makeSeller([noRoute], state);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NOT enforced"));
    const replies = send(agent);
    await settle();
    expect((terminalOf(replies)?.payload as RespondPayload).output).toBe("did the work");
    warn.mockRestore();
  });
});

describe("armed agreements and the platform lookup", () => {
  it("setAgreements arms verified documents and drops what does not check out", async () => {
    const sku = paidSku(1500);
    const state = { agreements: [] as AgreementDocument[] };
    const agent = await makeSeller([sku], state);
    const good = agreementFor(agent.id, await skuDigest(sku));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = agent.setAgreements([good, { ...good, sku_digest: "tampered" }, { v: 1 }]);
    warn.mockRestore();
    expect(res.armed).toBe(1);
    expect(res.rejected).toBe(2);
    expect(agent.heldAgreements()).toHaveLength(1);
  });

  it("an armed agreement admits without ever asking the platform", async () => {
    const sku = paidSku(1500);
    const state = { agreements: [] as AgreementDocument[] };
    const agent = await makeSeller([sku], state);
    agent.setAgreements([agreementFor(agent.id, await skuDigest(sku))]);
    const replies = send(agent);
    await settle();
    expect(terminalOf(replies)?.error).toBeUndefined();
    expect(conn.lookups).toHaveLength(0);
  });

  it("a lookup failure refuses paid work rather than giving it away", async () => {
    const state = { agreements: [] as AgreementDocument[] };
    const agent = await makeSeller([paidSku(1500)], state);
    agent.onAgreementLookup(async () => {
      throw new Error("platform unreachable");
    });
    const replies = send(agent);
    await settle();
    expect(terminalOf(replies)?.error?.code).toBe(ErrorCode.AGREEMENT_REQUIRED);
  });

  it("an uncovered request always asks, so approve-then-retry works at once", async () => {
    // Caching a miss for the full TTL made "approve, then send again" fail
    // for five minutes with the same refusal — which reads as broken rather
    // than as caching. Found live on the mesh, 2026-08-02.
    const sku = paidSku(1500);
    const state = { agreements: [] as AgreementDocument[] };
    const agent = await makeSeller([sku], state);

    const first = send(agent);
    await settle();
    expect(terminalOf(first)?.error?.code).toBe(ErrorCode.AGREEMENT_REQUIRED);
    expect(conn.lookups).toHaveLength(1);

    // The buyer approves, then retries immediately.
    state.agreements = [agreementFor(agent.id, await skuDigest(sku))];
    const replies = send(agent);
    await settle();
    expect(conn.lookups.length).toBeGreaterThan(1); // asked again rather than serving a cached answer
    expect(terminalOf(replies)?.error).toBeUndefined();
  });

  it("a re-price invalidates a HIT too: the seller asks again and refuses", async () => {
    // The second way a cache broke this live: having found the agreement for
    // the old terms, the seller kept serving it after re-pricing.
    const oldSku = paidSku(1500);
    const state = { agreements: [] as AgreementDocument[] };
    const agent = await makeSeller([oldSku], state);
    state.agreements = [agreementFor(agent.id, await skuDigest(oldSku))];
    const first = send(agent);
    await settle();
    expect(terminalOf(first)?.error).toBeUndefined(); // covered at the old price

    const newSku = paidSku(1501);
    await agent.register({ name: "seller-unit", skus: [newSku] });
    const replies = send(agent);
    await settle();
    expect(terminalOf(replies)?.error?.code).toBe(ErrorCode.AGREEMENT_REQUIRED);

    // And re-approving takes effect immediately, with no wait.
    state.agreements = [agreementFor(agent.id, await skuDigest(newSku))];
    const third = send(agent);
    await settle();
    expect(terminalOf(third)?.error).toBeUndefined();
  });

  it("an agreement naming a different seller is somebody else's business", async () => {
    const sku = paidSku(1500);
    const state = { agreements: [] as AgreementDocument[] };
    const agent = await makeSeller([sku], state);
    const foreign = agreementFor(nkeys.createUser().getPublicKey(), await skuDigest(sku));
    expect(agent.setAgreements([foreign]).rejected).toBe(1);
  });
});
