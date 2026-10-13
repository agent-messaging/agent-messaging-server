import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore, PEER_OTHER, dayKey } from "../../src/activity/usage-store.js";
import { applyBatch } from "../../src/activity/metering-fold.js";
import {
  declaredUsage,
  usageReceiptParties,
  observedRefusal,
  observedRequest,
  observedResponse,
  observedResponseBytes,
  observedTaskTerminal,
  validMeterEvent,
  readBatch,
  type MeterEventBatch,
} from "../../src/shared/metering.js";
import type { Envelope } from "../../src/sdk.js";

const P = "UPROVIDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const C = "UCONSUMERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("meter events (SPEC 13.5)", () => {
  it("builders produce valid events, and validation fails closed", () => {
    for (const batch of [
      observedRequest(P, C, "E1", 100, "summarize"),
      observedResponse(P, C, "E2", 200, false),
      observedResponseBytes(P, C, "E3", 50),
      observedRefusal(P, C, "E4", "BUDGET_INSUFFICIENT"),
      observedTaskTerminal(P, C, "E5", "task-1", 8000, true),
    ]) {
      for (const e of batch.events) expect(validMeterEvent(e)).toBe(true);
    }
    // The fixture's invalid shapes, asserted from the service side too.
    const ok = observedRequest(P, C, "E1", 100).events[0];
    expect(validMeterEvent({ ...ok, quantity: -1 })).toBe(false);
    expect(validMeterEvent({ ...ok, quantity: 1.5 })).toBe(false);
    expect(validMeterEvent({ ...ok, envelope_id: "" })).toBe(false);
    expect(validMeterEvent({ ...ok, consumer: "" })).toBe(false);
    expect(validMeterEvent({ ...ok, class: "estimated" })).toBe(false);
    // Declared names must not collide with the observed set, and vice versa.
    expect(validMeterEvent({ ...ok, class: "declared" })).toBe(false);
    expect(validMeterEvent({ ...ok, meter: "tokens_out" })).toBe(false);
    // A refusal event carries quantity 0, always.
    expect(validMeterEvent({ ...ok, refused: true, quantity: 1 })).toBe(false);
  });

  it("lifts payload.usage into declared events, dropping what fails validation", () => {
    const { batch, dropped } = declaredUsage(
      P,
      C,
      "E9",
      [
        { meter: "tokens_out", quantity: 4210 },
        { meter: "tool_calls", quantity: 3 },
        { meter: "requests", quantity: 5 }, // observed name: a claim laundered as an observation
        { meter: "tokens_out", quantity: -1 }, // negative
        { quantity: 1 }, // no meter
      ],
      "caselaw-summary",
      "task-1",
    );
    expect(dropped).toBe(3);
    expect(batch.events).toHaveLength(2);
    for (const e of batch.events) {
      expect(e.class).toBe("declared");
      expect(e.provider).toBe(P);
      expect(e.consumer).toBe(C);
      expect(e.envelope_id).toBe("E9");
      expect(e.task_id).toBe("task-1");
      expect(validMeterEvent(e)).toBe(true);
    }
  });

  it("declared events are not folded into the counters (the stream is their record)", async () => {
    // applyBatch is the COUNTER fold; declared quantities have no stats column
    // and must fold to nothing — rating (§19.6) reads them from the stream.
    const s = new UsageStore(join(mkdtempSync(join(tmpdir(), "decl-")), "usage.db"));
    try {
      applyBatch(s, declaredUsage(P, C, "E9", [{ meter: "tokens_out", quantity: 4210 }]).batch);
      await s.flush();
      expect(await s.list()).toHaveLength(0);
      expect((await s.peers(P)).served).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it("readBatch drops malformed events and keeps the exchange context", () => {
    const good = observedRequest(P, C, "E1", 100).events[0];
    const env = {
      payload: {
        domain: "metering",
        event_type: "usage",
        data: { events: [good, { meter: "nope!", quantity: -1 }], failed: true },
      },
    } as unknown as Envelope;
    const { batch, dropped } = readBatch(env);
    expect(batch.events).toHaveLength(1);
    expect(dropped).toBe(1);
    expect(batch.failed).toBe(true);
  });
});

describe("the usage fold", () => {
  let dir: string;
  const stores: UsageStore[] = [];

  function fresh(): UsageStore {
    dir = mkdtempSync(join(tmpdir(), "fold-"));
    const s = new UsageStore(join(dir, "usage.db"));
    stores.push(s);
    return s;
  }

  afterEach(async () => {
    for (const s of stores.splice(0)) {
      try { await s.close(); } catch { /* already closed */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** The exit criterion for the rewire: the SAME traffic, driven through the
   *  legacy direct calls and through the fold of the builders' events, leaves
   *  IDENTICAL agent_stats — the counters are a consumer of the stream and
   *  nobody's numbers moved. */
  it("reconciles with the legacy direct-write path exactly", async () => {
    const legacy = fresh();
    const folded = fresh();

    // One completed exchange (300 in / 500 out over two responds), one failed.
    legacy.recordIn(P, 300);
    legacy.recordDelivered(C, 300);
    legacy.recordOut(P, false, 400);
    legacy.recordOutBytes(P, 100);
    legacy.recordIn(P, 50);
    legacy.recordDelivered(C, 50);
    legacy.recordOut(P, true, 20);

    applyBatch(folded, observedRequest(P, C, "R1", 300));
    applyBatch(folded, observedResponse(P, C, "S1", 400, false));
    applyBatch(folded, observedResponseBytes(P, C, "S2", 100));
    applyBatch(folded, observedRequest(P, C, "R2", 50));
    applyBatch(folded, observedResponse(P, C, "S3", 20, true));

    await legacy.flush();
    await folded.flush();
    // first_seen/last_active are wall-clock stamps taken inside each store, so
    // the two runs can differ by a millisecond; everything counted must not.
    //
    // ORDER is dropped for the same reason, and dropping the fields alone was
    // not enough: `list()` orders by `last_active DESC, agent_id ASC`, so when
    // both agents land in the same millisecond the id breaks the tie and when
    // they straddle a tick the clock does. The two stores are written in
    // different orders, so whether this passed depended on where the
    // millisecond fell — a red CI at random, on a commit that touched nothing
    // near it, which then refuses the deploy. What this test is about is that
    // the COUNTERS agree.
    const clockless = (rows: Awaited<ReturnType<UsageStore["list"]>>) =>
      rows
        .map(({ first_seen: _f, last_active: _l, ...rest }) => rest)
        .sort((a, b) => a.agent_id.localeCompare(b.agent_id));
    expect(clockless(await folded.list())).toEqual(clockless(await legacy.list()));
    expect(await folded.today([P, C])).toEqual(await legacy.today([P, C]));
  });

  it("answers both group-bys: who did I serve, whose agents did I consume", async () => {
    const s = fresh();
    const C2 = "UCONSUMERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    applyBatch(s, observedRequest(P, C, "R1", 300));
    applyBatch(s, observedResponse(P, C, "S1", 400, false));
    applyBatch(s, observedRequest(P, C2, "R2", 100));
    applyBatch(s, observedRefusal(P, C2, "S2", "BUDGET_INSUFFICIENT"));

    const provider = await s.peers(P);
    expect(provider.served.map((r) => r.peer_id).sort()).toEqual([C, C2].sort());
    const toC = provider.served.find((r) => r.peer_id === C)!;
    expect(toC.requests).toBe(1);
    expect(toC.responses).toBe(1);
    expect(toC.bytes_in).toBe(300);
    expect(toC.bytes_out).toBe(400);
    const toC2 = provider.served.find((r) => r.peer_id === C2)!;
    expect(toC2.refusals).toBe(1);
    expect(provider.consumed).toHaveLength(0);

    const consumer = await s.peers(C);
    expect(consumer.served).toHaveLength(0);
    expect(consumer.consumed).toHaveLength(1);
    expect(consumer.consumed[0].peer_id).toBe(P);
    expect(consumer.consumed[0].requests).toBe(1);
  });

  it("a refusal is recorded on the peers and charged to nobody's counters", async () => {
    const s = fresh();
    applyBatch(s, observedRefusal(P, C, "S1", "AGREEMENT_REQUIRED"));
    await s.flush();
    expect(await s.list()).toHaveLength(0); // no counter moved
    const peers = await s.peers(P);
    expect(peers.served[0].refusals).toBe(1);
    expect(peers.served[0].requests).toBe(0);
  });

  it("caps distinct counterparties per provider-day into ~other", async () => {
    const s = fresh();
    // Uses the real cap via many peers is slow; instead drive the backend cap
    // indirectly: 205 distinct consumers in one flush against the real cap of
    // 200 leaves 200 named rows plus one ~other row holding the overflow.
    for (let i = 0; i < 205; i++) {
      const consumer = `UC${String(i).padStart(54, "0")}`;
      applyBatch(s, observedRequest(P, consumer, `R${i}`, 10));
    }
    await s.flush();
    const peers = await s.peers(P, 30, 200);
    const other = peers.served.find((r) => r.peer_id === PEER_OTHER);
    expect(other).toBeDefined();
    // 205 distinct consumers, cap 200: exactly 5 landed in ~other — which is
    // the invariant (the write capped at 200 named rows). The read page is
    // itself capped at 200 rows and ~other sorts first on requests, so the
    // page shows ~other + 199 named, not all 200.
    expect(other!.requests).toBe(5);
    expect(peers.served).toHaveLength(200);
    expect(peers.served.filter((r) => r.peer_id !== PEER_OTHER)).toHaveLength(199);
    // And the overflow keeps accumulating across flushes for known-new peers.
    applyBatch(s, observedRequest(P, `UC${"9".repeat(54)}`, "RX", 10));
    await s.flush();
    const again = await s.peers(P, 30, 200);
    expect(again.served.find((r) => r.peer_id === PEER_OTHER)!.requests).toBe(6);
  });

  it("account closure removes peer rows on both sides", async () => {
    const s = fresh();
    applyBatch(s, observedRequest(P, C, "R1", 100));
    applyBatch(s, observedResponse(P, C, "S1", 50, false));
    await s.flush();
    await s.deleteAgent(C);
    expect((await s.peers(P)).served).toHaveLength(0);
    expect((await s.peers(C)).consumed).toHaveLength(0);
  });

  it("task meters do not touch the counters (the stream is their record)", async () => {
    const s = fresh();
    applyBatch(s, observedTaskTerminal(P, C, "T1", "task-1", 8000, true));
    await s.flush();
    expect(await s.list()).toHaveLength(0);
    expect((await s.peers(P)).served).toHaveLength(0);
  });
});

describe("fold idempotency (the 13.5 dedupe key)", () => {
  it("a redelivered batch folds once", async () => {
    // The dedupe ledger lives in MeteringFold (which needs a stream); its rule
    // is pinned here at the batch level the way the fold applies it: any seen
    // (meter, envelope_id) key means the whole batch was applied already.
    const seen = new Set<string>();
    const foldOnce = (batch: MeterEventBatch, apply: () => void) => {
      const keys = batch.events.map((e) => `${e.meter}|${e.envelope_id}`);
      if (keys.some((k) => seen.has(k))) return;
      keys.forEach((k) => seen.add(k));
      apply();
    };
    let applied = 0;
    const b = observedRequest(P, C, "R1", 100);
    foldOnce(b, () => applied++);
    foldOnce(b, () => applied++); // redelivery
    foldOnce(observedResponse(P, C, "S1", 50, false), () => applied++);
    expect(applied).toBe(2);
  });
});

describe("who provided and who consumed", () => {
  // The direction swap. Getting it backwards does not fail loudly: it bills
  // the buyer's work to the seller and the seller's to the buyer, and every
  // downstream number stays internally consistent while being exactly wrong.
  const usage = [{ meter: "tokens_out", quantity: 10 }];

  it("reads a terminal respond as: the responder is `to`", () => {
    const r = usageReceiptParties({ payload: { status: "completed", usage } }, { to: "USELLER", from: "UBUYER" });
    expect(r).toEqual({ provider: "USELLER", consumer: "UBUYER", raw: usage });
  });

  it("reads an inbox answer the other way: the answering agent is `from`", () => {
    // A fresh request carrying in_reply_to — what every inbox-mode agent sends.
    const r = usageReceiptParties({ in_reply_to: "E1", payload: { usage } }, { to: "UBUYER", from: "USELLER" });
    expect(r).toEqual({ provider: "USELLER", consumer: "UBUYER", raw: usage });
  });

  it("takes a failed respond as terminal too — failed work still burned tokens", () => {
    expect(usageReceiptParties({ payload: { status: "failed", usage } }, { to: "P", from: "C" })?.provider).toBe("P");
  });

  it("declines a plain request that answers nothing", () => {
    expect(usageReceiptParties({ payload: { usage } }, { to: "P", from: "C" })).toBeNull();
  });

  it("declines a working respond, whose report is not yet final", () => {
    expect(usageReceiptParties({ payload: { status: "working", usage } }, { to: "P", from: "C" })).toBeNull();
  });

  it("declines a receipt with no usage, and an unreadable sealed one", () => {
    expect(usageReceiptParties({ payload: { status: "completed" } }, { to: "P", from: "C" })).toBeNull();
    expect(usageReceiptParties({ payload: { status: "completed", usage: [] } }, { to: "P", from: "C" })).toBeNull();
    // A sealed payload is an opaque blob: no readable usage, so no claim.
    expect(usageReceiptParties({ in_reply_to: "E1", payload: { sealed: "…" } }, { to: "P", from: "C" })).toBeNull();
  });

  it("declines when an endpoint could not be named", () => {
    expect(usageReceiptParties({ in_reply_to: "E1", payload: { usage } }, { to: "", from: "P" })).toBeNull();
  });
});
