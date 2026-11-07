// A2A over Agent Messaging (bindings/a2a.md §15), asserted case by case
// against conformance/a2a-binding.json.
//
// The fixture is iterated, not restated: every frame verifies, every
// operation and error is read as the binding says, and each of the client's
// readings (streams, budget outcomes, cancel objects, offerings, Parts, the
// wire window, carriers without subjects) gives what the fixture expects.
// A case group this file does not know fails the suite rather than being
// skipped, so a new group in the fixture is noticed.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src to agree with the fixture, never the fixture to agree
// with the code (it changes only with the binding, in the standards repo).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nkeys } from "nats.ws";
import { decode, encode } from "../../src/internal/codec.js";
import type { Envelope } from "../../src/types/envelope.js";
import {
  A2AError,
  A2A_BINDING_URI,
  A2A_ERROR_CODES,
  A2A_METHODS,
  A2A_WIRE_VERSION,
  budgetReading,
  forbiddenFieldsRefusal,
  isA2AErrorName,
  isValidBudgetBlock,
  isValidCancelObject,
  isValidFailureObject,
  isValidPart,
  overdueReading,
  readRequestPayload,
  readRespondPayload,
  readStreamFrames,
  readTaskSnapshots,
  routeOffering,
  wireRefusal,
  trialRefusalOf,
  trialReplyReceiptReading,
  type StreamDelivery,
  type Task,
} from "../../src/a2a/index.js";
import { cancelReasonFor } from "../../src/a2a/server.js";

const here = dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const F: any = JSON.parse(readFileSync(join(here, "..", "..", "..", "conformance", "a2a-binding.json"), "utf8"));

const KNOWN = new Set([
  "fixture",
  "spec",
  "comment",
  "identities",
  "binding_uri",
  "wire_version",
  "extensions",
  "operations",
  "errors",
  "part_by_reference",
  "stream_resume",
  "long_task",
  "budget",
  "cancel_reasons",
  "carrier_without_subjects",
  "offering",
  "legacy_fields",
  "failure_reasons",
  "trial_reply_receipt",
]);

const verifies = (f: Envelope): boolean => {
  try {
    decode(encode(f));
    return true;
  } catch {
    return false;
  }
};

describe("the fixture", () => {
  it("names this binding, its wire version, and only groups this suite reads", () => {
    expect(F.binding_uri).toBe(A2A_BINDING_URI);
    expect(F.wire_version).toBe(A2A_WIRE_VERSION);
    expect(Object.keys(F).filter((k) => !KNOWN.has(k))).toEqual([]);
  });

  it("its seeds name its keys", () => {
    expect(nkeys.fromSeed(new TextEncoder().encode(F.identities.client_seed)).getPublicKey()).toBe(F.identities.client);
    expect(nkeys.fromSeed(new TextEncoder().encode(F.identities.server_seed)).getPublicKey()).toBe(F.identities.server);
  });
});

describe("operations (§5)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.operations.cases as any[]) {
    it(c.name, () => {
      const [req, ans] = c.frames as Envelope[];
      expect(verifies(req)).toBe(true);
      expect(forbiddenFieldsRefusal(req)).toBeNull();
      expect(readRequestPayload(req)?.method).toBe(c.operation);
      if (ans) {
        expect(verifies(ans)).toBe(true);
        expect(forbiddenFieldsRefusal(ans)).toBeNull();
        expect(ans.in_reply_to).toBe(req.id);
        if (ans.error) {
          expect(isA2AErrorName(ans.error.code)).toBe(true);
          expect((ans.error.details as { a2a: { code: number } }).a2a.code).toBe(A2A_ERROR_CODES[ans.error.code as keyof typeof A2A_ERROR_CODES]);
        } else {
          expect(readRespondPayload(ans)).not.toBeNull();
        }
      }
      if (c.deliveries) {
        const got = readStreamFrames(c.deliveries as StreamDelivery[], req.id);
        expect(got.complete).toBe(true);
        expect(got.events).toEqual(c.http.response.events);
      }
    });
  }
  it("covers every operation", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(new Set((F.operations.cases as any[]).map((c) => c.operation))).toEqual(new Set(A2A_METHODS));
  });
});

describe("errors (§9)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.errors.cases as any[]) {
    it(c.name, () => {
      const ans = c.frames[1] as Envelope;
      expect(verifies(ans)).toBe(true);
      expect(ans.error?.code).toBe(c.error);
      const a2a = A2AError.fromErrorObject(ans.error!);
      if (isA2AErrorName(c.error)) {
        expect(a2a?.code).toBe(c.error);
        expect(a2a?.rpcCode).toBe(c.jsonrpc.error.code);
        expect(a2a?.toErrorObject()).toEqual({ ...ans.error, retryable: ans.error!.retryable === true });
      } else {
        // A channel error keeps its Agent Messaging code and has no A2A name.
        expect(a2a).toBeNull();
      }
    });
  }
});

describe("the wire and its fields (§4, §14)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.legacy_fields.cases as any[]) {
    it(c.name, () => {
      const f = c.frame as Envelope;
      const refusal = verifies(f) ? wireRefusal(f, { window: c.window }) : { code: "IDENTITY_MISMATCH" };
      expect(refusal ? { ok: false, code: refusal.code } : { ok: true }).toEqual(c.expect);
    });
  }
});

describe("offering (§12.1)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.offering.cases as any[]) {
    it(c.name, () => {
      expect(routeOffering(c.declared, c.metadata, { window: c.window, ...(c.default ? { default: c.default } : {}) })).toEqual(c.expect);
    });
  }
});

describe("trial work, replies and receipts (§12.8 to §12.10)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.trial_reply_receipt.messages as any[]) {
    it(c.name, () => {
      expect(trialReplyReceiptReading({ ...(c.contextId ? { contextId: c.contextId } : {}), metadata: c.metadata })).toEqual(c.expect);
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.trial_reply_receipt.tasks as any[]) {
    it(c.name, () => {
      const task = { id: "t", contextId: "c", status: { state: c.state }, metadata: { [F.trial_reply_receipt.uris.trial]: c.value } } as Task;
      expect({ ok: trialRefusalOf(task) !== undefined }).toEqual(c.expect);
    });
  }
});

describe("streams (§8)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.stream_resume.cases as any[]) {
    it(c.name, () => {
      const request = (c.request ?? F.stream_resume.request) as Envelope;
      expect(verifies(request)).toBe(true);
      for (const d of c.deliveries as StreamDelivery[]) if (!d.drop) expect(verifies(d.frame)).toBe(true);
      expect(readStreamFrames(c.deliveries, request.id)).toEqual(c.expect);
    });
  }
});

describe("a Task longer than the reply window (§15)", () => {
  it("the first answer comes inside the window, and later reads keep the Task id until it ends", () => {
    let id: string | null = null;
    let terminal = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const [i, x] of (F.long_task.exchanges as any[]).entries()) {
      const [r, a] = x.frames as Envelope[];
      expect(verifies(r) && verifies(a)).toBe(true);
      expect(Date.parse(a.ts) - Date.parse(r.ts)).toBeLessThan(F.long_task.reply_window_ms);
      const result = readRespondPayload(a)!.result as { task?: Task } & Task;
      const t = result.task ?? result;
      if (id !== null) expect(t.id).toBe(id);
      expect(terminal).toBe(false);
      id = t.id;
      terminal = ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"].includes(t.status.state);
      void i;
    }
    expect(terminal).toBe(true);
  });
});

describe("budget (§12.2)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const b of F.budget.blocks.valid as any[]) it(`a valid block: ${JSON.stringify(b)}`, () => expect(isValidBudgetBlock(b)).toBe(true));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const x of F.budget.blocks.invalid as any[]) it(`an invalid block: ${x.case}`, () => expect(isValidBudgetBlock(x.block)).toBe(false));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.budget.tasks as any[]) {
    it(c.name, () => {
      let task = c.task as Task | undefined;
      if (c.frames) {
        const result = readRespondPayload(c.frames[1])!.result as { task?: Task } & Task;
        task = result.task ?? result;
      }
      expect(budgetReading(task!, { window: c.window })).toEqual(c.expect);
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of (F.budget.overdue?.events ?? []) as any[]) it(`overdue: ${c.name}`, () => expect(overdueReading(c.event)).toEqual(c.expect));
});

describe("cancel reasons (§12.6)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.cancel_reasons.objects as any[]) it(`object: ${c.name}`, () => expect(isValidCancelObject(c.value)).toBe(c.expect.ok));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.cancel_reasons.exchanges as any[]) {
    it(`exchange: ${c.name}`, () => {
      const req = c.frames[0] as Envelope;
      expect(verifies(req)).toBe(true);
      const params = readRequestPayload(req)!.params as { id: string; metadata?: Record<string, unknown> };
      const declared = (((req.meta as { a2a?: Record<string, string> })?.a2a?.["A2A-Extensions"]) ?? "").split(/,\s*/).includes(F.cancel_reasons.uri);
      if (c.error) {
        expect(() => cancelReasonFor(params, declared)).toThrow(A2AError);
      } else {
        expect(cancelReasonFor(params, declared)).toEqual(c.recorded);
      }
    });
  }
});

describe("carriers without subjects (§8)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.carrier_without_subjects.cases as any[]) {
    it(c.name, () => {
      const got = readTaskSnapshots(c.frames);
      const { task: _task, ...reading } = got;
      expect(reading).toEqual(c.expect);
    });
  }
});

describe("Parts by reference (§6, §12.5)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.part_by_reference.parts as any[]) it(c.name, () => expect(isValidPart(c.part)).toBe(c.expect.ok));
  it("the request's Part by reference is well formed", () => {
    const f = F.part_by_reference.frames[0] as Envelope;
    expect(verifies(f)).toBe(true);
    const parts = (readRequestPayload(f)!.params as { message: { parts: unknown[] } }).message.parts;
    expect(parts.some((p) => isValidPart(p) && /^mesh:/.test(String((p as { url?: string }).url)))).toBe(true);
  });
});

describe("failure reasons (§12.7)", () => {
  it("a failed Task carries its reason on the wire", () => {
    const [r, a] = F.failure_reasons.exchange.frames as Envelope[];
    expect(verifies(r) && verifies(a)).toBe(true);
    const t = readRespondPayload(a)!.result as Task;
    expect(isValidFailureObject(t.status.state, t.metadata?.[F.failure_reasons.uri])).toBe(true);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of F.failure_reasons.tasks as any[]) it(`object: ${c.name}`, () => expect(isValidFailureObject(c.state, c.value)).toBe(c.expect.ok));
});
