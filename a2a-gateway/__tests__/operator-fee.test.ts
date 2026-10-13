/**
 * The operator's fee is disclosed to callers (BRIDGE-A2A.md §9.2).
 *
 * Until 2026-08-07 this mapping said the rate an agent's owner set was
 * "between the owner and the operator, never quoted to callers". That rule is
 * withdrawn. A caller was quoted one number and was not told it contained two,
 * and the concealment was never effective anyway: `markup_pct` is served
 * without authentication, so anyone who read the endpoint and the quoted total
 * could invert the arithmetic. What the old rule kept from the caller was not
 * the split. It was that there WAS one.
 *
 * The four rules of §9.2, each exercised here: the refusal carries the line
 * beside `price_credits`; every `accepted` entry carries its OWN line in its
 * own denomination; the settlement carries the same line with the amount
 * actually taken; and a refusal with no line asserts there is no fee inside its
 * total.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import type { AttachmentManager } from "../src/outbound/manager.js";
import { operatorFeeOf, retailOf } from "../src/outbound/manager.js";
import { fakeConnect, manifestFixture, sendMessageBody } from "./helpers.js";
import { checkOperatorFee, providerNet } from "../../sdk-typescript/src/sow.js";

const open: Array<{ close(): void }> = [];

afterEach(() => {
  while (open.length) {
    const s = open.pop()!;
    try {
      (s as Server).closeAllConnections?.();
    } catch {
      /* older node */
    }
    s.close();
  }
});

/** A manager that prices one agent and knows nothing else. The 402 pre-check
 *  is the only surface under test, and it runs before any mesh work. */
function pricingManager(rate: number): AttachmentManager {
  return {
    priceForAgent: async () => ({
      rate,
      retail: retailOf(rate),
      operatorFee: operatorFeeOf(rate),
      ownerAccount: "acct_owner",
    }),
    ledgerBalance: async () => 0,
  } as unknown as AttachmentManager;
}

async function start(rate: number): Promise<string> {
  const bridge = new Bridge({
    meshUrl: "ws://127.0.0.1:1",
    publicBaseUrl: "http://127.0.0.1",
    port: 0,
    apiKeys: { k1: "partner" },
  });
  fakeConnect(bridge, {
    discover: async () => ({ agents: [manifestFixture()], total: 1 }),
    getManifest: async () => manifestFixture(),
  });
  const server = await startInboundServer(bridge, pricingManager(rate));
  open.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function refusal(rate: number): Promise<Record<string, unknown>> {
  const base = await start(rate);
  const res = await fetch(`${base}/agents/UAGENTPUBKEY/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer k1" },
    body: sendMessageBody(),
  });
  expect(res.status).toBe(402);
  const body = (await res.json()) as { error: { data: Record<string, unknown> } };
  expect(body.error.data.agentmesh_code).toBe("PAYMENT_REQUIRED");
  return body.error.data;
}

describe("the 402 refusal quotes both numbers, not one", () => {
  it("carries the operator fee beside price_credits — §9.2's own worked example", async () => {
    // The example printed in the mapping: 10% of 5 rounds up to 1, retail is 6.
    // The basis is FIXED, because Agent SoW 0.9.0-draft §5.5.8 makes a
    // percentage basis floor exactly: 10% of 5 floors to 0, so a percentage line
    // stating 1 would be refused by the caller's own node. §5.5.8's remedy for
    // a rate finer than a whole percent is to state the charge itself.
    const data = await refusal(5);
    expect(data.price_credits).toBe(6);
    expect(data.operator_fee).toEqual({
      operator: "agentmesh.ai",
      basis: { kind: "fixed", fixed: 1 },
      base: 5,
      amount: 1,
    });
    // And the line closes on its own terms, checked by the same reader a
    // caller would use.
    expect(checkOperatorFee(data.operator_fee as never).ok).toBe(true);
    // What disclosure reveals, and the mapping says so rather than letting an
    // owner discover it: retail minus the fee is the owner's net.
    expect(providerNet({ total: data.price_credits as number, operator_fee: data.operator_fee as never })).toBe(5);
  });

  it("gives every accepted entry its own line, in its own denomination", async () => {
    // §9.2 rule 2. One rail today; an x402 entry lands beside it later quoting
    // in its own unit, and it must carry its own fee rather than inherit this
    // one's.
    const data = await refusal(7);
    const accepted = data.accepted as Array<Record<string, unknown>>;
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ method: "agentmesh-credits", unit: "credit", amount: 8 });
    expect(accepted[0].operator_fee).toEqual({
      operator: "agentmesh.ai",
      basis: { kind: "fixed", fixed: 1 },
      base: 7,
      amount: 1,
    });
  });

  it("keeps the retail total as the number the caller pays", async () => {
    // The fee is INSIDE the total, not added to it at the till. A caller that
    // reads only `price_credits` still pays exactly that.
    const data = await refusal(227_272);
    expect(data.price_credits).toBe(250_000);
    const fee = data.operator_fee as { amount: number; base: number };
    expect(fee.base + fee.amount).toBe(data.price_credits);
  });
});

describe("the arithmetic is the SDK's, in one place", () => {
  it("retail is the rate plus the disclosed cut, for every rate", () => {
    // The regression: `rate + Math.ceil(rate * pct / 100)` was written out in
    // the bridge AND in services, so the number a caller was quoted and the
    // number it was charged were two implementations of one rule.
    for (const rate of [1, 2, 5, 7, 99, 227_272]) {
      const fee = operatorFeeOf(rate)!;
      expect(retailOf(rate)).toBe(rate + fee.amount);
      // EXACT since 0.9.0-draft: no tolerance of one credit, in either
      // direction. A percentage basis would fail this at rate 5 and at rate 7.
      expect(checkOperatorFee(fee).ok).toBe(true);
      expect(fee.basis).toEqual({ kind: "fixed", fixed: Math.ceil(rate / 10) });
    }
  });

  it("writes no line where the agent is not resold, which asserts there is no fee", () => {
    // §9.2: where an agent sells under its own SKU the operator takes nothing,
    // there is no fee, and no line appears. A refusal or receipt carrying no
    // line asserts exactly that.
    expect(operatorFeeOf(0)).toBeNull();
    expect(operatorFeeOf(-3)).toBeNull();
    expect(retailOf(0)).toBe(0);
  });
});
