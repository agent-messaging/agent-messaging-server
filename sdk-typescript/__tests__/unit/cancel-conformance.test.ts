// The cancel wire shapes (SPEC.md §10.8, §7.3, §12.2), asserted case by case
// against conformance/cancel.json.
//
// Like budget-conformance.test.ts, this file ITERATES the fixture instead of
// restating its cases: the fixture pins the bytes two independent
// implementations (this SDK and sdk-rust) must agree on — the eight reason
// strings, the cancel-request, canceled-update and failed-update payload
// shapes, the unmet_need reference format, the propagated-cancel note format,
// and the reject cases. Adding a case to the JSON grows this suite without
// touching this file.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix
// sdk-typescript/src to agree with the fixture — never the fixture to agree
// with the code (the fixture changes only with a spec change alongside).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  canonicalEnvelopeBytes,
  ENVELOPE_SIG_PREFIX,
} from "../../src/internal/identity.js";
import { encode, decode } from "../../src/internal/codec.js";
import { ErrorCode } from "../../src/types/errors.js";
import { parseCancelInput, validateCancelReason, validateStopFields } from "../../src/cancel.js";
import {
  CANCEL_REASONS,
  NEED_KINDS,
  isCancelReason,
  isUnmetNeedRef,
  parseUnmetNeedRef,
  needRefOf,
  propagatedCancelNote,
  isValidTransition,
  TERMINAL_STATES,
  type CancelReason,
  type TaskState,
} from "../../src/types/task.js";
import type { Envelope } from "../../src/types/envelope.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(here, "..", "..", "..", "conformance", "cancel.json");

interface Fixture {
  version: number;
  spec: string;
  identities: { sender_seed: string; sender: string; recipient: string };
  reasons: { enum: string[]; descriptions: Record<string, string> };
  unmet_need: { kinds: string[]; valid: string[]; invalid: string[] };
  attribution: {
    cases: {
      case: string;
      reason: string | null;
      unmet_need?: string;
      dependency?: string;
      declared_needs?: string[] | null;
      party_asserted_attribution?: string;
      attribution: string;
    }[];
  };
  shapes: {
    cancel_request_payload: { offering: string; input: Record<string, unknown> };
    cancel_request_payload_no_note: { offering: string; input: Record<string, unknown> };
    canceled_update_payload: Record<string, unknown>;
    canceled_update_payload_no_note: Record<string, unknown>;
    canceled_update_payload_unmet_need: Record<string, unknown>;
    failed_update_payload: Record<string, unknown>;
    failed_update_payload_unmet_need: Record<string, unknown>;
    failed_update_payload_bare: Record<string, unknown>;
  };
  propagation: {
    cases: {
      case: string;
      original: { reason: CancelReason; note?: string };
      forwarded: { reason: string; note: string };
    }[];
  };
  invalid: { cases: { case: string; input: Record<string, unknown>; why: string }[] };
  envelope: { signed_bytes_prefix: string; canonical: string; signed: Envelope };
  transitions: { cancelable_from: TaskState[]; not_cancelable_from: TaskState[] };
}

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

// ── reasons.enum ────────────────────────────────────────────────────────────

/** The qualifier a reason needs to be legal on its own (§10.8): only
 *  `needs_not_furnished` has a REQUIRED one. Taken from the fixture's own
 *  valid list so the two never drift. */
const qualifierFor = (reason: string): string | undefined =>
  reason === "needs_not_furnished" ? fixture.unmet_need.valid[0] : undefined;

describe("§10.8 reasons.enum — the eight strings, exactly, and nothing else", () => {
  it("the fixture's enum IS this SDK's CANCEL_REASONS — same size, same bytes", () => {
    expect(new Set(fixture.reasons.enum)).toEqual(new Set(CANCEL_REASONS));
    expect(fixture.reasons.enum).toHaveLength(8);
  });

  it("descriptions cover exactly the enum, no stragglers", () => {
    expect(new Set(Object.keys(fixture.reasons.descriptions))).toEqual(
      new Set(fixture.reasons.enum),
    );
  });

  for (const reason of fixture.reasons.enum) {
    it(`"${reason}" is accepted by isCancelReason and validateCancelReason`, () => {
      expect(isCancelReason(reason)).toBe(true);
      expect(() => validateCancelReason(reason, undefined, qualifierFor(reason))).not.toThrow();
    });
  }
});

// ── unmet_need (§10.8) ──────────────────────────────────────────────────────

describe("§10.8 unmet_need — a claim about the caller has to name something", () => {
  it("the fixture's kinds ARE this SDK's NEED_KINDS", () => {
    expect(new Set(fixture.unmet_need.kinds)).toEqual(new Set(NEED_KINDS));
  });

  for (const ref of fixture.unmet_need.valid) {
    it(`"${ref}" is a well-formed reference`, () => {
      expect(isUnmetNeedRef(ref)).toBe(true);
      const parsed = parseUnmetNeedRef(ref);
      expect(parsed).not.toBeNull();
      expect(NEED_KINDS).toContain(parsed!.kind);
      // Split at the FIRST colon only: the value may carry its own.
      expect(`${parsed!.kind}:${parsed!.value}`).toBe(ref);
    });
  }

  for (const ref of fixture.unmet_need.invalid) {
    it(`"${ref}" is refused as a reference`, () => {
      expect(isUnmetNeedRef(ref)).toBe(false);
      expect(() => validateCancelReason("needs_not_furnished", undefined, ref)).toThrow();
    });
  }

  it("a §8.5.1 need entry maps onto the reference its offering would be judged by", () => {
    expect(needRefOf({ credential: "Salesforce", scope: "read invoices" })).toBe(
      "credential:Salesforce",
    );
    expect(needRefOf({ resource: "git-repo", access: "read-write" })).toBe("resource:git-repo");
    expect(needRefOf({ file: "application/pdf" })).toBe("file:application/pdf");
    expect(needRefOf({ description: "no kind at all" })).toBeNull();
  });
});

// ── shapes ──────────────────────────────────────────────────────────────────

describe("§10.8 shapes — both wire forms parse", () => {
  it("cancel_request_payload: offering is task.cancel and the input parses", () => {
    const p = fixture.shapes.cancel_request_payload;
    expect(p.offering).toBe("task.cancel");
    const parsed = parseCancelInput(p.input);
    expect(parsed.taskId).toBe(p.input.task_id);
    expect(parsed.reason).toBe(p.input.reason);
    expect(parsed.note).toBe(p.input.note);
  });

  it("cancel_request_payload_no_note: note is ABSENT, not null, and stays absent", () => {
    const p = fixture.shapes.cancel_request_payload_no_note;
    expect("note" in p.input).toBe(false);
    const parsed = parseCancelInput(p.input);
    expect("note" in parsed).toBe(false);
  });

  it("canceled_update_payload: status canceled with a valid reason (+ note)", () => {
    const p = fixture.shapes.canceled_update_payload;
    expect(p.status).toBe("canceled");
    expect(() => validateCancelReason(p.reason, p.note)).not.toThrow();
  });

  it("canceled_update_payload_no_note: status canceled, reason valid, note absent", () => {
    const p = fixture.shapes.canceled_update_payload_no_note;
    expect(p.status).toBe("canceled");
    expect("note" in p).toBe(false);
    expect(() => validateCancelReason(p.reason)).not.toThrow();
  });

  it("canceled_update_payload_unmet_need: the claim rides the cancel and names the need", () => {
    const p = fixture.shapes.canceled_update_payload_unmet_need;
    expect(p.status).toBe("canceled");
    expect(p.reason).toBe("needs_not_furnished");
    expect(isUnmetNeedRef(p.unmet_need)).toBe(true);
    expect(validateStopFields(p, true)).toEqual({
      reason: p.reason,
      note: p.note,
      unmet_need: p.unmet_need,
    });
  });

  it("failed_update_payload: a failure states its reason and the service that broke", () => {
    const p = fixture.shapes.failed_update_payload;
    expect(p.status).toBe("failed");
    expect(p.reason).toBe("dependency_failed");
    expect(validateStopFields(p, false)).toEqual({
      reason: p.reason,
      note: p.note,
      dependency: p.dependency,
    });
  });

  it("failed_update_payload_unmet_need: a failure may name the need the caller never furnished", () => {
    const p = fixture.shapes.failed_update_payload_unmet_need;
    expect(p.status).toBe("failed");
    expect(validateStopFields(p, false)).toEqual({
      reason: p.reason,
      unmet_need: p.unmet_need,
    });
  });

  it("failed_update_payload_bare: a failure with no reason is complete, and cancels are not", () => {
    const p = fixture.shapes.failed_update_payload_bare;
    expect(p.status).toBe("failed");
    expect("reason" in p).toBe(false);
    // Nobody is obliged to invent an excuse for a failure...
    expect(validateStopFields(p, false)).toEqual({});
    // ...but a cancel still has to say why.
    expect(() => validateStopFields(p, true)).toThrow();
  });
});

// ── propagation ─────────────────────────────────────────────────────────────

describe("§10.8 propagation.cases — the forwarded note is byte-exact", () => {
  for (const c of fixture.propagation.cases) {
    it(`${c.case}: ${JSON.stringify(c.original)} → ${JSON.stringify(c.forwarded.note)}`, () => {
      expect(c.forwarded.reason).toBe("upstream_cancelled");
      expect(propagatedCancelNote(c.original.reason, c.original.note)).toBe(c.forwarded.note);
    });
  }
});

// ── invalid ─────────────────────────────────────────────────────────────────

describe("§10.8 invalid.cases — every reject case is INVALID_ENVELOPE", () => {
  for (const { case: name, input, why } of fixture.invalid.cases) {
    it(`${name} (${why})`, () => {
      expect(() => parseCancelInput(input)).toThrowError(
        expect.objectContaining({ code: ErrorCode.INVALID_ENVELOPE }),
      );
    });
  }
});

// ── envelope: canonical bytes and signature ─────────────────────────────────

describe("§5.3 envelope — the signed cancel request verifies, byte for byte", () => {
  it("reproduces the fixture's canonical bytes exactly from the signed envelope", () => {
    const canonical = new TextDecoder().decode(canonicalEnvelopeBytes(fixture.envelope.signed));
    expect(canonical).toBe(fixture.envelope.canonical);
  });

  it("the signature verifies via decode(), and the prefix is this SDK's (§5.3)", () => {
    expect(fixture.envelope.signed_bytes_prefix).toBe(ENVELOPE_SIG_PREFIX);
    expect(() => decode(encode(fixture.envelope.signed))).not.toThrow();
  });

  it("one changed byte of reason fails verification", () => {
    const tampered = JSON.parse(JSON.stringify(fixture.envelope.signed)) as Envelope;
    (tampered.payload as { input: { reason: string } }).input.reason = "policy";
    expect(() => decode(encode(tampered))).toThrow();
  });

  it("the pinned request's input parses (it is a valid cancel, not just valid bytes)", () => {
    const payload = fixture.envelope.signed.payload as { offering: string; input: unknown };
    expect(payload.offering).toBe("task.cancel");
    expect(() => parseCancelInput(payload.input)).not.toThrow();
  });
});

// ── transitions ─────────────────────────────────────────────────────────────

describe("§7.3 transitions — which states may cancel", () => {
  // Nine since Agent SoW §5.5.5 added `exhausted` to the terminal side: a task
  // in flight when a time-and-materials cap is reached ends there.
  it("the two sets are disjoint and cover all nine states", () => {
    const all = [...fixture.transitions.cancelable_from, ...fixture.transitions.not_cancelable_from];
    expect(all).toHaveLength(9);
    expect(new Set(all).size).toBe(9);
  });

  for (const s of fixture.transitions.cancelable_from) {
    it(`${s} → canceled is a valid transition`, () => {
      expect(isValidTransition(s, "canceled")).toBe(true);
    });
  }

  for (const s of fixture.transitions.not_cancelable_from) {
    it(`${s} → canceled is refused (terminal — TASK_NOT_CANCELABLE territory)`, () => {
      expect(TERMINAL_STATES.has(s)).toBe(true);
      expect(isValidTransition(s, "canceled")).toBe(false);
    });
  }
});
