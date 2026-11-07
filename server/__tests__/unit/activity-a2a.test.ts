// The activity tap on 0.4.0 frames (the A2A binding): the offering and the
// Task id are inside the A2A object (bindings/a2a.md §4), so the tap reads
// them there (shared/a2a-frames.ts). Billing prices by offering, so a call is
// recorded under the offering it names, else the agent's one offering
// (§12.1), never "unknown" when the agent has one. The Task id is the one
// the request names, else the one its answer carries. The 0.4.0 accept is a
// delivery signal, a usage receipt beside `payload.a2a` is lifted as on
// 0.3.0, a reply naming a Message (§12.9) is that exchange's answer, and a
// trial call (§12.8) is metered as trial work.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METERING_SUBJECT, type MeterEvent, type MeterEventBatch } from "../../src/shared/metering.js";
import type { Envelope } from "../../src/sdk.js";
import { uuid7 } from "../../src/sdk.js";
import { OfferingDirectory } from "../../src/shared/a2a-frames.js";
import { memoryKv } from "../helpers/memory-kv.js";
import { EXT_OFFERING, EXT_REPLY, EXT_TRIAL } from "../../../sdk-typescript/src/a2a/extensions.js";

vi.setConfig({ testTimeout: 60_000 });

const AGENT = "UAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CALLER = "UCALLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SERVICE = "USERVICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

interface Entry { requestId?: string; offering: string; taskId: string; status: string; trial?: true; respondedAt?: string; inputPreview: string }
interface Svc {
  entries: Entry[];
  tapOne(env: Envelope, bytes: number): Promise<void>;
  audit: { close(): void };
  usage: { close(): Promise<void> };
}

const frame = (p: Record<string, unknown>): Envelope =>
  ({ v: "0.4.0", id: uuid7(), ts: new Date().toISOString(), ...p }) as unknown as Envelope;

const send = (message: Record<string, unknown>, method = "SendMessage") =>
  frame({ type: "request", from: CALLER, to: AGENT, payload: { a2a: { method, params: { message: { messageId: uuid7(), role: "ROLE_USER", parts: [{ text: "hello" }], ...message } } } } });

const answer = (inReplyTo: string | undefined, result: unknown, extra: Record<string, unknown> = {}) =>
  frame({ type: "respond", from: AGENT, to: CALLER, ...(inReplyTo ? { in_reply_to: inReplyTo } : {}), payload: { a2a: { result }, ...extra } });

let dir: string | undefined;
let closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
  vi.unstubAllEnvs();
  try {
    if (dir) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows holds SQLite WAL files briefly */
  }
  dir = undefined;
});

async function makeTap(offerings: string[] | null = null) {
  dir ??= mkdtempSync(join(tmpdir(), "activity-a2a-"));
  vi.resetModules();
  vi.stubEnv("AUDIT_DB_PATH", join(dir, `audit-${uuid7()}.db`));
  vi.stubEnv("USAGE_DB_PATH", join(dir, `usage-${uuid7()}.db`));
  const mod = await import("../../src/activity/activity-service.js");
  const events: MeterEvent[] = [];
  const nc = {
    publish: (subject: string, data: Uint8Array) => {
      if (subject !== METERING_SUBJECT) return;
      events.push(...(JSON.parse(new TextDecoder().decode(data)) as { payload: { data: MeterEventBatch } }).payload.data.events);
    },
  };
  const kv = { put: async () => 1, purge: async () => {} };
  const svc = new mod.ActivityService(nc as never, {} as never, kv as never) as unknown as Svc;
  (svc as unknown as { meteringOn: boolean }).meteringOn = true;
  Object.defineProperty(svc, "kp", { value: SERVICE });
  const registry = memoryKv();
  if (offerings) await registry.put(AGENT, JSON.stringify({ offerings: offerings.map((id) => ({ id })) }));
  Object.defineProperty(svc, "offerings", { value: new OfferingDirectory(async () => registry) });
  closers.push(() => svc.audit.close());
  closers.push(() => svc.usage.close());
  return { svc, events };
}

const of = (events: MeterEvent[], id: string) => events.filter((e) => e.envelope_id === id);

describe("the activity tap on 0.4.0 frames", () => {
  it("records the offering the Message names, and the Task id its answer carries", async () => {
    const { svc, events } = await makeTap(["quote", "other"]);
    const req = send({ metadata: { [EXT_OFFERING]: { offering: "quote" } } });
    await svc.tapOne(req, 100);
    const entry = svc.entries.find((e) => e.requestId === req.id)!;
    expect(entry.offering).toBe("quote");
    expect(entry.inputPreview).toContain("hello");
    expect(of(events, req.id).map((e) => [e.meter, e.offering])).toEqual([["requests", "quote"], ["bytes_in", "quote"]]);
    const ans = answer(req.id, { task: { id: "task-9", contextId: "c", status: { state: "TASK_STATE_WORKING" } } });
    await svc.tapOne(ans, 50);
    expect(of(events, ans.id).map((e) => [e.meter, e.offering, e.task_id, e.request_id])).toEqual([
      ["responses", "quote", "task-9", req.id],
      ["bytes_out", "quote", "task-9", req.id],
    ]);
  });

  it("a call naming no offering is the agent's one offering; with several it stays unknown", async () => {
    const one = await makeTap(["summarize"]);
    const req = send({});
    await one.svc.tapOne(req, 10);
    expect(one.svc.entries.find((e) => e.requestId === req.id)!.offering).toBe("summarize");
    const many = await makeTap(["a", "b"]);
    const req2 = send({});
    await many.svc.tapOne(req2, 10);
    expect(many.svc.entries.find((e) => e.requestId === req2.id)!.offering).toBe("unknown");
  });

  it("a Message continuing a Task, and a CancelTask, carry the Task id they name", async () => {
    const { svc, events } = await makeTap(["quote"]);
    const resume = send({ taskId: "task-1" });
    await svc.tapOne(resume, 10);
    expect(svc.entries.find((e) => e.requestId === resume.id)!.taskId).toBe("task-1");
    const cancel = frame({ type: "request", from: CALLER, to: AGENT, payload: { a2a: { method: "CancelTask", params: { id: "task-1" } } } });
    await svc.tapOne(cancel, 10);
    const row = svc.entries.find((e) => e.requestId === cancel.id)!;
    expect(row).toMatchObject({ offering: "task.cancel", taskId: "task-1" });
    const get = frame({ type: "request", from: CALLER, to: AGENT, payload: { a2a: { method: "GetTask", params: { id: "task-1" } } } });
    await svc.tapOne(get, 10);
    expect(of(events, get.id)[0]).toMatchObject({ offering: "a2a.GetTask", task_id: "task-1" });
  });

  it("the 0.4.0 accept is not the answer; the answer's usage receipt is lifted", async () => {
    const { svc, events } = await makeTap(["quote"]);
    const req = send({});
    await svc.tapOne(req, 10);
    await svc.tapOne(frame({ type: "respond", from: AGENT, to: CALLER, in_reply_to: req.id, payload: { accepted: {} } }), 10);
    expect(svc.entries.find((e) => e.requestId === req.id)!.respondedAt).toBeUndefined();
    const ans = answer(req.id, { message: { messageId: "r", role: "ROLE_AGENT", parts: [{ text: "done" }] } }, { usage: [{ meter: "tokens_out", quantity: 42 }] });
    await svc.tapOne(ans, 10);
    expect(of(events, ans.id).map((e) => e.meter).sort()).toEqual(["bytes_out", "responses", "tokens_out"]);
    expect(of(events, ans.id).find((e) => e.meter === "tokens_out")).toMatchObject({ class: "declared", provider: AGENT, consumer: CALLER, quantity: 42 });
  });

  it("a reply naming the Message it answers is metered as that exchange's answer (§12.9)", async () => {
    const { svc, events } = await makeTap(["quote"]);
    const req = send({ messageId: "msg-1", contextId: "ctx" });
    await svc.tapOne(req, 10);
    const reply = frame({
      type: "request", from: AGENT, to: CALLER,
      payload: { a2a: { method: "SendMessage", params: { message: { messageId: "msg-2", role: "ROLE_USER", contextId: "ctx", parts: [{ text: "later" }], metadata: { [EXT_REPLY]: { inReplyTo: "msg-1" } } } } } },
    });
    await svc.tapOne(reply, 10);
    expect(of(events, reply.id).map((e) => [e.meter, e.provider, e.consumer, e.request_id])).toEqual([
      ["responses", AGENT, CALLER, req.id],
      ["bytes_out", AGENT, CALLER, req.id],
    ]);
  });

  it("a trial call is metered as trial work, its answer too", async () => {
    const { svc, events } = await makeTap(["quote"]);
    const req = send({ metadata: { [EXT_TRIAL]: { trial: true } } });
    await svc.tapOne(req, 10);
    expect(svc.entries.find((e) => e.requestId === req.id)!.trial).toBe(true);
    const ans = answer(req.id, { message: { messageId: "r", role: "ROLE_AGENT", parts: [] } });
    await svc.tapOne(ans, 10);
    expect(events.length).toBe(4);
    expect(events.every((e) => e.trial === true)).toBe(true);
  });

  it("a 0.3.0 envelope is recorded as before", async () => {
    const { svc, events } = await makeTap(["quote"]);
    const req = { v: "0.1", id: uuid7(), type: "request", from: CALLER, to: AGENT, ts: new Date().toISOString(), payload: { offering: "summarize", input: { q: 1 } } } as unknown as Envelope;
    await svc.tapOne(req, 10);
    expect(svc.entries.find((e) => e.requestId === req.id)!.offering).toBe("summarize");
    expect(of(events, req.id).every((e) => e.trial === undefined)).toBe(true);
  });
});

describe("the offering a call naming none goes to (§12.1, 0.4.2-draft)", () => {
  it("is the agent's default when it declares several and names one, else none", async () => {
    const registry = memoryKv();
    await registry.put(AGENT, JSON.stringify({ offerings: [{ id: "chat" }, { id: "help" }], default_offering: "chat" }));
    await registry.put(CALLER, JSON.stringify({ offerings: [{ id: "chat" }, { id: "help" }], default_offering: "launch" }));
    const dir = new OfferingDirectory(async () => registry);
    expect(await dir.single(AGENT)).toBe("chat");
    expect(await dir.single(CALLER)).toBeUndefined();
  });
});
