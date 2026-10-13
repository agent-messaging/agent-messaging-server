// The tap after the §6.4 hard cutover, where a respond travels the REQUESTER's
// inbox subject (which the inbox tap sees) and is still mirrored on the
// responder's outbox (which the outbox tap sees) - the same envelope, twice.
// And nearly every answer is now preceded by signals that are not the answer:
// the responder's §6.4a accept, and intermediary queued acks (a node's, or the
// admission service's benign ack) signed by someone other than the responder.
//
// These pin what recording must do about all of that: classify by the
// envelope, never the arrival subject (a respond on an inbox subject is still
// a respond); count each envelope once (no double bytes, no double audit
// append); refuse to let an accept or an intermediary's ack stand in for the
// exchange's response (duration, status and the audit row wait for the real
// answer, or for the unanswered sweep).
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../../src/activity/audit-log.js";
import type { ActivityEntry } from "../../src/activity/activity-service.js";
import type { Envelope } from "../../src/sdk.js";
import { uuid7 } from "../../src/sdk.js";

const AGENT = "UAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CALLER = "UCALLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ADMISSION = "UADMISSIONAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function requestEnv(): Envelope {
  return {
    v: "0.1",
    id: uuid7(),
    type: "request",
    from: CALLER,
    to: AGENT,
    ts: new Date().toISOString(),
    payload: { offering: "summarize", input: { q: 1 } },
  } as unknown as Envelope;
}

function respondEnv(
  inReplyTo: string,
  over: Partial<{ from: string; payload: Record<string, unknown>; error: { code: string; message: string } }> = {},
): Envelope {
  return {
    v: "0.1",
    id: uuid7(),
    type: "respond",
    from: over.from ?? AGENT,
    to: CALLER,
    in_reply_to: inReplyTo,
    ts: new Date().toISOString(),
    ...(over.error ? { error: over.error } : {}),
    payload: over.payload ?? { status: "completed", output: { a: 1 } },
  } as unknown as Envelope;
}

interface Svc {
  entries: ActivityEntry[];
  recordRequest(env: Envelope, bytes?: number): void;
  recordResponse(env: Envelope, bytes?: number): void;
  audit: AuditLog;
  usage: {
    recordIn: ReturnType<typeof vi.fn>;
    recordDelivered: ReturnType<typeof vi.fn>;
    recordOut: ReturnType<typeof vi.fn>;
    recordOutBytes: ReturnType<typeof vi.fn>;
    close(): Promise<void>;
  };
}

describe("respond sightings after the §6.4 cutover", () => {
  let dir: string;
  let closers: Array<() => unknown> = [];

  afterEach(async () => {
    for (const c of closers) await c();
    closers = [];
    vi.unstubAllEnvs();
    // Windows holds SQLite WAL files briefly even after close; a failed tmp
    // cleanup is not a failed test.
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leaked tmpdir on Windows - harmless */
    }
    dir = undefined as unknown as string;
  });

  async function makeService(): Promise<Svc> {
    dir = mkdtempSync(join(tmpdir(), "activity-sightings-"));
    vi.resetModules();
    vi.stubEnv("AUDIT_DB_PATH", join(dir, "audit.db"));
    vi.stubEnv("USAGE_DB_PATH", join(dir, "usage.db"));
    const mod = await import("../../src/activity/activity-service.js");
    const kv = { put: async () => 1 };
    const svc = new mod.ActivityService({} as never, {} as never, kv as never) as unknown as Svc;
    // The direct-write (metering-degraded) counter path, observed rather than
    // queried: this is the path with no downstream dedupe ledger, so a double
    // sighting that reaches it is counted money.
    const real = svc.usage as unknown as { close(): Promise<void> };
    svc.usage.recordIn = vi.fn();
    svc.usage.recordDelivered = vi.fn();
    svc.usage.recordOut = vi.fn();
    svc.usage.recordOutBytes = vi.fn();
    closers.push(() => (svc as unknown as { audit: AuditLog }).audit.close());
    closers.push(() => real.close());
    return svc;
  }

  it("counts the same respond once across the inbox and outbox sightings", async () => {
    const svc = await makeService();
    const req = requestEnv();
    svc.recordRequest(req, 100);
    const resp = respondEnv(req.id);

    svc.recordResponse(resp, 500); // the inbox tap: requester's reply channel
    svc.recordResponse(resp, 500); // the outbox tap: responder's mirror

    // One response counted, no follow-up bytes for the duplicate.
    expect(svc.usage.recordOut).toHaveBeenCalledTimes(1);
    expect(svc.usage.recordOutBytes).not.toHaveBeenCalled();

    // One exchange on the chains: a row per party, not per sighting.
    const audit = new AuditLog(join(dir, "audit.db"));
    const rows = audit.list([AGENT, CALLER], 20);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.request_id === req.id && r.status === "completed")).toBe(true);
    // Direction attribution: the responder was served, the caller requested.
    expect(rows.find((r) => r.agent_id === AGENT)?.role).toBe("served");
    expect(rows.find((r) => r.agent_id === CALLER)?.role).toBe("requested");
    audit.close();
  });

  it("a follow-up respond with its own id still counts its bytes (task-mode shape preserved)", async () => {
    const svc = await makeService();
    const req = requestEnv();
    svc.recordRequest(req, 100);
    svc.recordResponse(respondEnv(req.id, { payload: { status: "working" } }), 200);
    svc.recordResponse(respondEnv(req.id), 300); // a different envelope, later

    expect(svc.usage.recordOut).toHaveBeenCalledTimes(1);
    expect(svc.usage.recordOutBytes).toHaveBeenCalledTimes(1);
  });

  it("an accept is a signal, not the exchange's response", async () => {
    const svc = await makeService();
    const req = requestEnv();
    svc.recordRequest(req, 100);

    // The §6.4a accept arrives first, on both tapped subjects.
    const accept = respondEnv(req.id, { payload: { status: "accepted" } });
    svc.recordResponse(accept, 150);
    svc.recordResponse(accept, 150);

    const entry = svc.entries.find((e) => e.requestId === req.id)!;
    expect(entry.respondedAt).toBeUndefined();
    expect(entry.durationMs).toBeUndefined();
    expect(svc.usage.recordOut).not.toHaveBeenCalled();
    expect(svc.audit.list([AGENT, CALLER], 20)).toHaveLength(0);

    // The real answer - a FAILURE - must still land as one, not be shadowed by
    // an exchange the accept already "completed".
    svc.recordResponse(
      respondEnv(req.id, {
        payload: { status: "failed" },
        error: { code: "INTERNAL_ERROR", message: "boom" },
      }),
      400,
    );
    expect(entry.respondedAt).toBeTruthy();
    expect(entry.status).toBe("failed");
    expect(svc.usage.recordOut).toHaveBeenCalledTimes(1);
    expect(svc.usage.recordOut.mock.calls[0][1]).toBe(true); // failed
    const audit = new AuditLog(join(dir, "audit.db"));
    const rows = audit.list([AGENT, CALLER], 20);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "failed")).toBe(true);
    audit.close();
  });

  it("an intermediary's queued ack does not close the exchange as the agent's answer", async () => {
    const svc = await makeService();
    const req = requestEnv();
    svc.recordRequest(req, 100);

    // The admission service's benign ack (or a node's queued ack): a respond
    // correlated to the exchange but signed by a third party, which the inbox
    // tap now sees.
    svc.recordResponse(
      respondEnv(req.id, {
        from: ADMISSION,
        payload: { output: { queued: true, inbox_id: uuid7(), text: "Delivered to the recipient's inbox." } },
      }),
      120,
    );

    const entry = svc.entries.find((e) => e.requestId === req.id)!;
    expect(entry.respondedAt).toBeUndefined();
    expect(svc.usage.recordOut).not.toHaveBeenCalled();
    expect(svc.audit.list([AGENT, CALLER], 20)).toHaveLength(0);

    // The agent's own late answer still lands normally.
    svc.recordResponse(respondEnv(req.id), 300);
    expect(entry.respondedAt).toBeTruthy();
    expect(svc.usage.recordOut).toHaveBeenCalledTimes(1);
  });
});
