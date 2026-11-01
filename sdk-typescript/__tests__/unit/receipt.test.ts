// EXT-15 call receipts: the request field, and the receipt's signature, tiers and shape.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decodeUnverified } from "../../src/internal/codec.js";
import type { Envelope } from "../../src/types/envelope.js";
import {
  CALL_RECEIPT_TAG,
  receiptLevelOf,
  signCallReceipt,
  summaryOfReceipt,
  verifyCallReceipt,
  type CallReceiptFull,
} from "../../src/receipt.js";

const open: AgentMesh[] = [];
afterEach(async () => {
  for (const a of open.splice(0)) await a.close();
});

function makeConn() {
  const registryKp = nkeys.createUser();
  return {
    publish: vi.fn(),
    request: vi.fn(async (_subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      return { data: encode(signEnvelope(createEnvelope({ type: "respond", from: registryKp.getPublicKey(), to: req.from, in_reply_to: req.id, payload: { status: "registered" } }), registryKp)) };
    }),
    subscribe: vi.fn(() => ({ unsubscribe: () => {}, drain: async () => {} })),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    raw: { publish: () => {} },
    get isClosed() { return false; },
  };
}

function sample(issuerKey: string): CallReceiptFull {
  return {
    format: "agent-call-receipt-v1", tier: "full", receipt_id: "rcpt_1", request_id: "req_1", task_id: "task_1", context_id: "ctx_1",
    job: "task_1", provider: { key: nkeys.createUser().getPublicKey(), handle: "scout.ann@example.com" }, offering: "chat",
    requested_at: "2026-11-01T17:00:00.000Z", delivered_at: "2026-11-01T17:00:04.000Z", elapsed_ms: 4000,
    total: 303, currency: "XCR", arrangement: "per_call", settled: "settled", agent_version: "1.2.0", status: "completed", error_code: null,
    issued_at: "2026-11-01T17:00:09.000Z", issuer: { key: issuerKey, name: "example.net" },
    trace_id: "t1", asked_by: "acct_1", paid_by: "acct_1", queued_ms: 0, working_ms: 4000, waiting_on_you_ms: 0, waiting_on_person_ms: 0, rounds: 1,
    price_source: { kind: "attachment", id: "att_1", version: null, digest: null },
    lines: [{ meter: "requests", count: 1, unit: "call", rate: 303, amount: 303, capped: false, pass_through: 0, upstream_receipt: null }],
    ceiling: null, absorbed: 0, refunds: [], ledger_refs: ["att_1:task_1"],
    package_digest: null, descriptor_digest: null, run_config: null, manifest_verified: null, reused: null, artifacts: { count: 0, bytes: 0 },
  };
}

describe("the request field", () => {
  it("request() carries payload.config.receipt only when asked", async () => {
    const conn = makeConn();
    const agent = AgentMesh.withConnection(conn as unknown as ConnectionManager, nkeys.createUser(), nkeys.createUser());
    open.push(agent);
    const target = nkeys.createUser().getPublicKey();
    const sent = () => [...conn.publish.mock.calls, ...conn.request.mock.calls]
      .map((c) => { try { return decodeUnverified(c[1] as Uint8Array); } catch { return null; } })
      .filter((e): e is Envelope => !!e && e.type === "request" && e.to === target);
    void agent.request(target, "work", "hi", { receipt: "full", timeout_ms: 50 }).catch(() => {});
    await vi.waitFor(() => expect(sent().length).toBe(1));
    expect((sent()[0]!.payload as { config?: { receipt?: string } }).config?.receipt).toBe("full");
    expect(receiptLevelOf(sent()[0]!.payload)).toBe("full");
    void agent.request(target, "work", "hi", { timeout_ms: 50 }).catch(() => {});
    await vi.waitFor(() => expect(sent().length).toBe(2));
    expect((sent()[1]!.payload as { config?: Record<string, unknown> }).config).not.toHaveProperty("receipt");
    expect(receiptLevelOf(sent()[1]!.payload)).toBeNull();
  });

  it("receiptLevelOf reads only the three levels", () => {
    expect(receiptLevelOf({ config: { receipt: "summary" } })).toBe("summary");
    expect(receiptLevelOf({ config: { receipt: "none" } })).toBe("none");
    expect(receiptLevelOf({ config: { receipt: "all" } })).toBeNull();
    expect(receiptLevelOf(null)).toBeNull();
  });
});

describe("the receipt", () => {
  it("signs under agent-call-receipt-v1 and verifies; a changed byte fails", () => {
    const issuer = nkeys.createUser();
    const signed = signCallReceipt(sample(issuer.getPublicKey()), issuer);
    expect(signed.signatures[0]).toMatchObject({ tag: CALL_RECEIPT_TAG, by: issuer.getPublicKey(), alg: "ed25519" });
    expect(verifyCallReceipt(signed).ok).toBe(true);
    expect(verifyCallReceipt(signed, issuer.getPublicKey()).ok).toBe(true);
    expect(verifyCallReceipt(signed, nkeys.createUser().getPublicKey()).ok).toBe(false);
    expect(verifyCallReceipt({ ...signed, total: 1 }).ok).toBe(false);
  });

  it("refuses a receipt signed by someone other than its issuer", () => {
    const issuer = nkeys.createUser();
    expect(() => signCallReceipt(sample(issuer.getPublicKey()), nkeys.createUser())).toThrow();
  });

  it("the summary tier keeps the summary members only, and signs on its own", () => {
    const issuer = nkeys.createUser();
    const summary = summaryOfReceipt(sample(issuer.getPublicKey()));
    expect(summary.tier).toBe("summary");
    expect(summary).not.toHaveProperty("lines");
    expect(summary).not.toHaveProperty("asked_by");
    expect(summary.total).toBe(303);
    expect(verifyCallReceipt(signCallReceipt(summary, issuer)).ok).toBe(true);
  });

  it("never carries the model or the balance", () => {
    const issuer = nkeys.createUser();
    const doc = { ...sample(issuer.getPublicKey()), model: "x" } as unknown as CallReceiptFull;
    expect(verifyCallReceipt(signCallReceipt(doc, issuer))).toMatchObject({ ok: false });
  });
});
