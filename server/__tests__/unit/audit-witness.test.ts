// The audit log's witness-era additions, pinned from the customer's side:
// the §13.5 usage receipt actually PERSISTS now (it used to be spread into a
// row object with no column underneath and silently dropped), old files gain
// the column without any existing chain moving, `hasRequest` answers the
// backstop's only question, and a "witnessed" pair chains and verifies like
// any other row.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { AuditLog, GENESIS, entryHash, sha256hex } from "../../src/activity/audit-log.js";
import type { AuditEntry } from "../../src/activity/audit-log.js";
import { nkeys } from "../../src/sdk.js";

const A = "URESPONDER";
const B = "UREQUESTER";
const USAGE = [{ meter: "tokens_out", quantity: 4210 }, { meter: "tool_calls", quantity: 3 }];

describe("the usage column", () => {
  let dir: string;

  afterEach(() => {
    // Windows holds SQLite WAL files briefly even after close; a failed tmp
    // cleanup is not a failed test.
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leaked tmpdir on Windows - harmless */
    }
    dir = undefined as unknown as string;
  });

  function fresh(): string {
    dir = mkdtempSync(join(tmpdir(), "audit-witness-"));
    return join(dir, "audit.db");
  }

  it("persists the declared receipt, and its absence stays an absent key", () => {
    const path = fresh();
    const log = new AuditLog(path);
    log.appendExchange({ from: B, to: A, skill: "s", requestId: "r1", status: "completed", usage: USAGE });
    log.appendExchange({ from: B, to: A, skill: "s", requestId: "r2", status: "completed" });

    const rows = log.list([A], 10);
    const withUsage = rows.find((r) => r.request_id === "r1")!;
    const without = rows.find((r) => r.request_id === "r2")!;
    expect(withUsage.usage).toEqual(USAGE);
    // Absent, not null: the hash covers the key's absence, and a reader must
    // see the same shape the hash was computed over.
    expect("usage" in without).toBe(false);
    log.close();

    // On disk it is JSON text in a real column - the old code dropped it.
    const raw = new Database(path);
    const stored = raw
      .prepare(`SELECT usage FROM audit_entries WHERE request_id = 'r1' AND agent_id = ?`)
      .get(A) as { usage: string };
    raw.close();
    expect(JSON.parse(stored.usage)).toEqual(USAGE);
  });

  it("chains verify across a mix of rows with and without usage", () => {
    const log = new AuditLog(fresh());
    log.appendExchange({ from: B, to: A, skill: "s", requestId: "r1", status: "completed" });
    log.appendExchange({ from: B, to: A, skill: "s", requestId: "r2", status: "completed", usage: USAGE });
    log.appendExchange({ from: B, to: A, skill: "s", requestId: "r3", status: "failed" });
    expect(log.verifyChain(A)).toEqual({ ok: true, count: 3 });
    expect(log.verifyChain(B)).toEqual({ ok: true, count: 3 });
    log.close();
  });

  it("migrates a pre-usage file in place, and the old rows' hashes stand", () => {
    const path = fresh();
    // A file written by the OLD code: no usage column, rows hashed without
    // any usage key. Built raw so the test cannot quietly depend on the new
    // code's own write path.
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE audit_entries (
        agent_id     TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        ts           TEXT NOT NULL,
        role         TEXT NOT NULL,
        counterparty TEXT NOT NULL,
        skill        TEXT NOT NULL,
        task_id      TEXT,
        request_id   TEXT,
        status       TEXT NOT NULL,
        duration_ms  INTEGER,
        input_sha256 TEXT,
        prev_hash    TEXT NOT NULL,
        entry_hash   TEXT NOT NULL,
        PRIMARY KEY (agent_id, seq)
      );
    `);
    const insert = raw.prepare(
      `INSERT INTO audit_entries VALUES (@agent_id, @seq, @ts, @role, @counterparty, @skill, @task_id, @request_id, @status, @duration_ms, @input_sha256, @prev_hash, @entry_hash)`,
    );
    let prev = GENESIS;
    for (let seq = 1; seq <= 2; seq++) {
      const partial: Omit<AuditEntry, "entry_hash"> = {
        agent_id: A,
        seq,
        ts: new Date().toISOString(),
        role: "served",
        counterparty: B,
        skill: "legacy",
        task_id: null,
        request_id: `legacy-${seq}`,
        status: "completed",
        duration_ms: 40,
        input_sha256: null,
        prev_hash: prev,
      };
      prev = entryHash(partial);
      insert.run({ ...partial, entry_hash: prev });
    }
    raw.close();

    // Opening the file ALTERs the table; the legacy chain still verifies and
    // new usage-carrying rows extend it.
    const log = new AuditLog(path, nkeys.createUser());
    expect(log.verifyChain(A)).toEqual({ ok: true, count: 2 });
    log.appendExchange({ from: B, to: A, skill: "s", requestId: "r-new", status: "completed", usage: USAGE });
    expect(log.verifyChain(A)).toEqual({ ok: true, count: 3 });

    // And the offline tool passes the mixed old-shape/new-shape bundle.
    const bundle = log.export("acct_1", [A, B]);
    log.close();
    expect(bundle.entries.filter((e) => e.usage !== undefined)).toHaveLength(2);
    const file = join(dir, "bundle.json");
    writeFileSync(file, JSON.stringify(bundle));
    const tool = join(process.cwd(), "tools", "verify-audit.mjs");
    const out = execFileSync("node", [tool, file, bundle.manifest.signer_pub], { encoding: "utf8" });
    expect(out).toContain("bundle intact");
  });

  it("export rows carry the receipt, inside the digest", () => {
    const log = new AuditLog(fresh(), nkeys.createUser());
    log.appendExchange({ from: B, to: A, skill: "s", requestId: "r1", status: "completed", usage: USAGE });
    const bundle = log.export("acct_1", [A, B]);
    log.close();
    expect(bundle.entries).toHaveLength(2);
    for (const e of bundle.entries) expect(e.usage).toEqual(USAGE);
    // A doctored receipt must break verification like any other edit.
    const doctored = structuredClone(bundle) as typeof bundle;
    doctored.entries[0].usage = [{ meter: "tokens_out", quantity: 1 }];
    const file = join(dir, "doctored.json");
    writeFileSync(file, JSON.stringify(doctored));
    const tool = join(process.cwd(), "tools", "verify-audit.mjs");
    expect(() => execFileSync("node", [tool, file], { encoding: "utf8" })).toThrow();
  });
});

describe("hasRequest and the witnessed pair", () => {
  let dir: string;

  afterEach(() => {
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leaked tmpdir on Windows - harmless */
    }
    dir = undefined as unknown as string;
  });

  function fresh(): AuditLog {
    dir = mkdtempSync(join(tmpdir(), "audit-witness-"));
    return new AuditLog(join(dir, "audit.db"));
  }

  it("hasRequest answers from either write path", () => {
    const log = fresh();
    expect(log.hasRequest("nope")).toBe(false);
    log.appendExchange({ from: B, to: A, skill: "s", requestId: "r-tap", status: "completed" });
    log.appendWitnessed({ from: B, to: A, skill: "s", requestId: "r-witness" });
    expect(log.hasRequest("r-tap")).toBe(true);
    expect(log.hasRequest("r-witness")).toBe(true);
    log.close();
  });

  it("a witnessed pair advances both chains with status witnessed, no duration", () => {
    const log = fresh();
    log.appendWitnessed({
      from: B,
      to: A,
      skill: "summarize",
      taskId: "t1",
      requestId: "req-9",
      inputSha256: sha256hex('{"q":1}'),
    });
    const served = log.list([A], 10);
    const requested = log.list([B], 10);
    expect(served).toHaveLength(1);
    expect(requested).toHaveLength(1);
    expect(served[0]).toMatchObject({
      role: "served",
      counterparty: B,
      status: "witnessed",
      duration_ms: null,
      request_id: "req-9",
      skill: "summarize",
    });
    expect(requested[0]).toMatchObject({ role: "requested", counterparty: A, status: "witnessed" });
    expect(log.verifyChain(A)).toEqual({ ok: true, count: 1 });
    expect(log.verifyChain(B)).toEqual({ ok: true, count: 1 });
    log.close();
  });
});
