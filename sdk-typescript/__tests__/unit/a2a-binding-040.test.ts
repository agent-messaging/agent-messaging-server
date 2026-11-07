// A2A binding 0.4.0-draft §12.8 to §12.10: trial work, replies and receipt
// requests on the binding, and the receipt in the Task's metadata.
import { describe, it, expect } from "vitest";
import {
  EXT_RECEIPTS,
  EXT_REPLY,
  EXT_TRIAL,
  isTrialMessage,
  isTrialTask,
  receiptOf,
  receiptRequestOf,
  replyToOf,
  trialRefusalOf,
  trialRefusedTask,
  withReceipt,
  withReceiptRequest,
  withReplyTo,
  withTrial,
  cardExtensions,
} from "../../src/a2a/extensions.js";
import { receiptLevelOf, RECEIPTS_EXTENSION_URI } from "../../src/receipt.js";
import type { Message, Task } from "../../src/a2a/types.js";

const msg = (extra: Partial<Message> = {}): Message => ({ messageId: "m1", role: "ROLE_USER", parts: [{ text: "hi" }], ...extra });
const task = (state: Task["status"]["state"], history: Message[] = []): Task => ({ id: "t1", contextId: "c1", status: { state }, history });

describe("§12.8 trial work", () => {
  it("marks the starting Message and reads it back, on the Message and on the Task", () => {
    const m = withTrial(msg());
    expect(m.metadata?.[EXT_TRIAL]).toEqual({ trial: true });
    expect(m.extensions).toContain(EXT_TRIAL);
    expect(isTrialMessage(m)).toBe(true);
    expect(isTrialMessage(msg())).toBe(false);
    expect(isTrialMessage(msg({ metadata: { [EXT_TRIAL]: { trial: "yes" } } }))).toBe(false);
    expect(isTrialTask(task("TASK_STATE_WORKING", [m]))).toBe(true);
    expect(isTrialTask(task("TASK_STATE_WORKING", [msg()]))).toBe(false);
  });

  it("a refused trial is a rejected Task carrying TRIAL_REFUSED and its fields", () => {
    const t = trialRefusedTask(task("TASK_STATE_WORKING"), { reason: "requester_day", limit: 3 });
    expect(t.status.state).toBe("TASK_STATE_REJECTED");
    expect(t.metadata?.[EXT_TRIAL]).toEqual({ refusal: "TRIAL_REFUSED", reason: "requester_day", limit: 3 });
    expect(trialRefusalOf(t)).toMatchObject({ refusal: "TRIAL_REFUSED", reason: "requester_day" });
    expect(trialRefusalOf(task("TASK_STATE_REJECTED"))).toBeUndefined();
  });
});

describe("§12.9 replies", () => {
  it("names the Message it answers and keeps its context", () => {
    const r = withReplyTo(msg({ messageId: "m2" }), { messageId: "m1", contextId: "c9" });
    expect(r.metadata?.[EXT_REPLY]).toEqual({ inReplyTo: "m1" });
    expect(r.contextId).toBe("c9");
    expect(replyToOf(r)).toBe("m1");
    expect(replyToOf(msg())).toBeUndefined();
  });
});

describe("§12.10 receipts", () => {
  it("asks on the starting Message, and the receipt rides in the Task's metadata", () => {
    const m = withReceiptRequest(msg(), "full");
    expect(EXT_RECEIPTS).toBe(RECEIPTS_EXTENSION_URI);
    expect(receiptRequestOf(m)).toBe("full");
    expect(receiptRequestOf(msg({ metadata: { [EXT_RECEIPTS]: { receipt: "everything" } } }))).toBeNull();
    const t = withReceipt(task("TASK_STATE_COMPLETED"), { receipt_id: "r1", settled: "provisional" });
    expect(receiptOf(t)).toEqual({ receipt_id: "r1", settled: "provisional" });
    expect(receiptOf(withReceipt(t, { receipt_id: "r1", settled: "settled" }))?.settled).toBe("settled");
  });

  it("receiptLevelOf reads the 0.4.0 request as it reads payload.config.receipt", () => {
    const payload = { a2a: { method: "SendMessage", params: { message: withReceiptRequest(msg(), "summary") } } };
    expect(receiptLevelOf(payload)).toBe("summary");
    expect(receiptLevelOf({ config: { receipt: "full" } })).toBe("full");
    expect(receiptLevelOf({ a2a: { method: "SendMessage", params: { message: msg() } } })).toBeNull();
  });

  it("cards list the three only when asked", () => {
    expect(cardExtensions().map((e) => e.uri)).not.toContain(EXT_TRIAL);
    expect(cardExtensions([EXT_TRIAL, EXT_REPLY, EXT_RECEIPTS]).every((e) => e.required === false && !!e.description)).toBe(true);
  });
});

describe("A2ACallOptions.meta", () => {
  it("rides on the request frame, under the keys the call sets itself", async () => {
    const { makeBus } = await import("./a2a-bus.js");
    const bus = makeBus();
    try {
      const client = bus.agent();
      const server = bus.agent();
      server.a2a.serve(() => ({ messageId: "r1", role: "ROLE_AGENT", parts: [{ text: "ok" }] }));
      await client.a2a.sendMessage(server.id, msg(), { meta: { a2a_bridge: { direction: "inbound" }, a2a: "ignored", engagement: "x" }, engagement: "eng-1" });
      const req = bus.log.find((l) => l.env.type === "request" && l.env.to === server.id)!.env;
      const meta = req.meta as Record<string, unknown>;
      expect(meta.a2a_bridge).toEqual({ direction: "inbound" });
      expect((meta.a2a as Record<string, string>)["A2A-Version"]).toBe("1.0");
      expect(meta.engagement).toBe("eng-1");
    } finally {
      await bus.close();
    }
  });
});
