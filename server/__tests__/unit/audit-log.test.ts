// The audit log: the account-facing, tamper-evident record.
//
// The claims a customer will rely on, pinned: an edited or deleted row is
// DETECTABLE (the chain breaks), an exported bundle carries its own proof
// (digest + signature that the offline tool re-derives with no access to
// us), content never lands in the store (hashes only), scoping is exactly
// the agent set the caller passes, and closure's erasure actually erases.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { AuditLog, AUDIT_SIG_PREFIX, entryHash, sha256hex } from "../../src/activity/audit-log.js";
import { nkeys, canonicalJSON, verifyTagged } from "../../src/sdk.js";

const dir = () => mkdtempSync(join(tmpdir(), "audit-"));
const dbPath = () => join(dir(), "audit.db");

function exchange(log: AuditLog, n = 1, over: Partial<Parameters<AuditLog["appendExchange"]>[0]> = {}) {
  for (let i = 0; i < n; i++) {
    log.appendExchange({
      from: "UREQUESTER",
      to: "URESPONDER",
      skill: "tagline",
      taskId: `t${i}`,
      requestId: `r${i}`,
      status: "completed",
      durationMs: 40 + i,
      inputSha256: sha256hex(`{"product":"x${i}"}`),
      ...over,
    });
  }
}

describe("the chains", () => {
  it("one exchange advances BOTH parties' chains, and both verify", () => {
    const log = new AuditLog(dbPath());
    exchange(log, 3);
    expect(log.verifyChain("URESPONDER")).toEqual({ ok: true, count: 3 });
    expect(log.verifyChain("UREQUESTER")).toEqual({ ok: true, count: 3 });
    const served = log.list(["URESPONDER"], 10);
    expect(served.every((e) => e.role === "served" && e.counterparty === "UREQUESTER")).toBe(true);
    log.close();
  });

  it("an edited row breaks the chain from that seq on — the tamper is detectable", () => {
    const path = dbPath();
    const log = new AuditLog(path);
    exchange(log, 3);
    log.close();

    const raw = new Database(path);
    raw.prepare(`UPDATE audit_entries SET skill = 'something-nicer' WHERE agent_id = 'URESPONDER' AND seq = 2`).run();
    raw.close();

    const reopened = new AuditLog(path);
    expect(reopened.verifyChain("URESPONDER")).toMatchObject({ ok: false, brokenAt: 2 });
    expect(reopened.verifyChain("UREQUESTER").ok).toBe(true); // the other chain is untouched
    reopened.close();
  });

  it("a DELETED row breaks the chain too — history cannot be quietly thinned", () => {
    const path = dbPath();
    const log = new AuditLog(path);
    exchange(log, 3);
    log.close();
    const raw = new Database(path);
    raw.prepare(`DELETE FROM audit_entries WHERE agent_id = 'URESPONDER' AND seq = 2`).run();
    raw.close();
    const reopened = new AuditLog(path);
    expect(reopened.verifyChain("URESPONDER").ok).toBe(false);
    reopened.close();
  });

  it("stores hashes, never content", () => {
    const path = dbPath();
    const log = new AuditLog(path);
    log.appendExchange({
      from: "UA",
      to: "UB",
      skill: "s",
      status: "completed",
      inputSha256: sha256hex('{"secret":"the launch codes"}'),
    });
    log.close();
    const raw = new Database(path);
    const all = JSON.stringify(raw.prepare("SELECT * FROM audit_entries").all());
    raw.close();
    expect(all).not.toContain("launch codes");
    expect(all).toContain(sha256hex('{"secret":"the launch codes"}'));
  });
});

describe("reads", () => {
  it("lists only the given agents, newest first, capped", () => {
    const log = new AuditLog(dbPath());
    exchange(log, 5);
    exchange(log, 2, { from: "USTRANGER", to: "UOTHER" });
    const rows = log.list(["URESPONDER", "UREQUESTER"], 4);
    expect(rows).toHaveLength(4);
    expect(rows.every((e) => e.agent_id === "URESPONDER" || e.agent_id === "UREQUESTER")).toBe(true);
    expect(log.list([], 10)).toEqual([]);
    log.close();
  });
});

describe("the export bundle", () => {
  it("carries intact chains, a matching digest, and a signature that verifies", () => {
    const kp = nkeys.createUser();
    const log = new AuditLog(dbPath(), kp);
    exchange(log, 4);
    const bundle = log.export("acct_1", ["URESPONDER", "UREQUESTER", "UNOROWS"]);
    log.close();

    expect(bundle.manifest.agents.map((a) => a.agent_id).sort()).toEqual(["UREQUESTER", "URESPONDER"]);
    expect(bundle.manifest.agents.every((a) => a.count === 4)).toBe(true);
    expect(bundle.entries).toHaveLength(8);
    expect(sha256hex(bundle.entries.map((e) => canonicalJSON(e)).join("\n"))).toBe(bundle.manifest.entries_sha256);

    const { sig, ...unsigned } = bundle.manifest;
    const sigBytes = new Uint8Array(Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    expect(
      verifyTagged(bundle.manifest.signer_pub, AUDIT_SIG_PREFIX, canonicalJSON(unsigned), sigBytes, {
        allowUntagged: false,
      }),
    ).toBe(true);

    // And each shipped row's own hash is recomputable — the tool's check 1.
    for (const row of bundle.entries) {
      const { entry_hash, ...rest } = row;
      expect(entryHash(rest)).toBe(entry_hash);
    }
  });

  it("the offline tool passes an intact bundle and fails a doctored one", () => {
    const kp = nkeys.createUser();
    const log = new AuditLog(dbPath(), kp);
    exchange(log, 2);
    const bundle = log.export("acct_1", ["URESPONDER", "UREQUESTER"]);
    log.close();

    const d = dir();
    const good = join(d, "good.json");
    writeFileSync(good, JSON.stringify(bundle));
    const tool = join(process.cwd(), "tools", "verify-audit.mjs");
    const out = execFileSync("node", [tool, good, bundle.manifest.signer_pub], { encoding: "utf8" });
    expect(out).toContain("bundle intact");

    const doctored = structuredClone(bundle) as typeof bundle;
    doctored.entries[0].skill = "revised-history";
    const badPath = join(d, "bad.json");
    writeFileSync(badPath, JSON.stringify(doctored));
    let failed = false;
    try {
      execFileSync("node", [tool, badPath], { encoding: "utf8" });
    } catch (e) {
      failed = true;
      expect(String((e as { stdout?: string }).stdout ?? "") + String((e as { stderr?: string }).stderr ?? "")).toMatch(/chain|FAILED/);
    }
    expect(failed).toBe(true);
  });

  it("refuses to export without a signing identity", () => {
    const log = new AuditLog(dbPath());
    expect(() => log.export("acct_1", ["UX"])).toThrow(/signing identity/);
    log.close();
  });
});

describe("erasure", () => {
  it("deletes exactly the given agents' rows", () => {
    const log = new AuditLog(dbPath());
    exchange(log, 3);
    exchange(log, 2, { from: "USTRANGER", to: "UOTHER" });
    const n = log.deleteForAgents(["URESPONDER", "UREQUESTER"]);
    expect(n).toBe(6);
    expect(log.list(["URESPONDER", "UREQUESTER"], 10)).toEqual([]);
    expect(log.list(["USTRANGER", "UOTHER"], 10)).toHaveLength(4);
    log.close();
  });
});
