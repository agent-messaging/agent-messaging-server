// Silence is audit-relevant: "I asked and got nothing" is precisely the kind
// of claim an audit exists to settle. These tests pin the unanswered sweep:
// a request past the threshold with no response gets its `unanswered` rows on
// BOTH chains, exactly once (the marker survives re-sweeps), while answered
// and merely-young requests get nothing from it.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../../src/activity/audit-log.js";
import type { ActivityEntry } from "../../src/activity/activity-service.js";

const AGENT = "UAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CALLER = "UCALLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("the unanswered sweep", () => {
  let dir: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    // Windows holds SQLite WAL files briefly even after close; a failed tmp
    // cleanup is not a failed test.
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leaked tmpdir on Windows — harmless */
    }
    dir = undefined as unknown as string;
  });

  function row(id: string, over: Partial<ActivityEntry> = {}): ActivityEntry {
    return {
      id,
      ts: new Date(Date.now() - 10 * 60_000).toISOString(),
      recordedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      from: CALLER,
      to: AGENT,
      offering: "summarize",
      taskId: `task-${id}`,
      requestId: `req-${id}`,
      inputPreview: "",
      inputSha256: "aabbcc",
      status: "completed",
      ...over,
    };
  }

  async function makeService() {
    dir = mkdtempSync(join(tmpdir(), "audit-unanswered-"));
    vi.resetModules();
    vi.stubEnv("AUDIT_DB_PATH", join(dir, "audit.db"));
    vi.stubEnv("USAGE_DB_PATH", join(dir, "usage.db"));
    vi.stubEnv("AUDIT_UNANSWERED_AFTER_MS", "60000");
    const mod = await import("../../src/activity/activity-service.js");
    const puts: string[] = [];
    const kv = { put: async (k: string) => (puts.push(k), 1) };
    const svc = new mod.ActivityService({} as never, {} as never, kv as never);
    return {
      svc: svc as unknown as {
        entries: ActivityEntry[];
        sweepUnanswered(): void;
        audit: AuditLog;
        usage: { close(): Promise<void> };
      },
      puts,
    };
  }

  it("audits old-and-silent once, and leaves answered and young requests alone", async () => {
    const { svc, puts } = await makeService();
    svc.entries.push(row("silent"));
    svc.entries.push(row("answered", { respondedAt: new Date().toISOString() }));
    svc.entries.push(row("young", { recordedAt: new Date().toISOString() }));

    svc.sweepUnanswered();
    svc.sweepUnanswered(); // the marker must make the second pass a no-op

    const audit = new AuditLog(join(dir, "audit.db"));
    const rows = audit.list([AGENT, CALLER], 20);
    expect(rows).toHaveLength(2); // one exchange, both chains
    expect(rows.every((r) => r.status === "unanswered")).toBe(true);
    expect(rows.every((r) => r.request_id === "req-silent")).toBe(true);
    expect(rows.every((r) => r.input_sha256 === "aabbcc")).toBe(true);
    expect(audit.verifyChain(AGENT).ok).toBe(true);
    expect(audit.verifyChain(CALLER).ok).toBe(true);
    audit.close();

    // The marker was persisted, so a restart cannot re-audit it either.
    expect(svc.entries.find((e) => e.id === "silent")?.auditedUnansweredAt).toBeTruthy();
    expect(puts).toContain("silent");
    svc.audit.close();
    await svc.usage.close();
  });

  it("a late response after the unanswered row still records normally — both events, in order", async () => {
    const { svc } = await makeService();
    svc.entries.push(row("late"));
    svc.sweepUnanswered();

    // recordResponse's own path appends the completed exchange when a response
    // finally arrives; here we assert the log ACCEPTS the second event on the
    // same chain rather than treating it as a conflict.
    svc.audit.appendExchange({
      from: CALLER,
      to: AGENT,
      skill: "summarize",
      taskId: "task-late",
      requestId: "req-late",
      status: "completed",
      durationMs: 500_000,
    });
    const audit = new AuditLog(join(dir, "audit.db"));
    const chain = audit.list([AGENT], 10).sort((a, b) => a.seq - b.seq);
    expect(chain.map((r) => r.status)).toEqual(["unanswered", "completed"]);
    expect(audit.verifyChain(AGENT).ok).toBe(true);
    audit.close();
    svc.audit.close();
    await svc.usage.close();
  });
});
