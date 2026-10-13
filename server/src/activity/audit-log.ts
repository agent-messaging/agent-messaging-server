/**
 * The audit log — the account-facing, tamper-evident record of what agents
 * did on the mesh.
 *
 * Three existing stores answer nearby questions and none answers this one:
 * the activity ring (activity-service.ts) is an operator's RECENT view,
 * bounded to 500 rows and holding request content it must keep purging; the
 * usage counters are totals with no events under them; the recorder is
 * operator history in a Postgres nobody's customer can read or verify. The
 * audit log is for the account owner: everything MY agents were asked and
 * asked of others, readable from my console, exportable as a bundle whose
 * integrity anyone can check with no access to us.
 *
 * Two properties are load-bearing:
 *
 *   METADATA + HASH, NEVER CONTENT. A row names parties, skill, task,
 *   outcome, duration — and carries a SHA-256 of the request input instead
 *   of the input. The audit answers "did this happen as claimed": whoever
 *   holds the payload can prove it is THE payload; we hold nothing to leak,
 *   and retention stops being a privacy problem (18 months, AUDIT_MAX_AGE_MS).
 *
 *   HASH-CHAINED PER AGENT, SIGNED AT EXPORT. Each agent's rows form a
 *   chain (entry_hash covers the row and prev_hash), so removing or editing
 *   a row breaks every hash after it. The export bundle carries the chain
 *   heads, a digest of the entry lines, and an Ed25519 signature over the
 *   manifest (tagged, canonical JSON, no untagged fallback — this format is
 *   newer than the dual-accept window). Verification needs the signer's
 *   public key and this file's algorithm, nothing else of ours:
 *   tools/verify-audit.mjs does it offline.
 *
 * Storage is SQLite (WAL, secure_delete like usage-sqlite.ts, and for the
 * same erasure reason). The tap process writes; the API process reads the
 * same file — one host, one writer, N readers is exactly WAL's contract.
 * Capture is the live tap's best effort plus a durable backstop: a row
 * records either that we witnessed an exchange complete (the tap) or that the
 * platform durably captured a message without observing its outcome
 * ("witnessed" rows, witness-fold.ts), and the export manifest says so.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJSON, signTagged, toB64Url, nkeys } from "../sdk.js";

type KeyPair = ReturnType<typeof nkeys.createUser>;

export const AUDIT_SIG_PREFIX = "agentmesh-audit-bundle-v1\n";
export const GENESIS = "genesis";

/** Which side of the exchange this row records for its agent. */
export type AuditRole = "served" | "requested";

/** One line of a §13.5 usage receipt, as the responder declared it. */
export interface AuditUsageClaim {
  meter: string;
  quantity: number;
}

export interface AuditEntry {
  agent_id: string;
  seq: number;
  ts: string;
  role: AuditRole;
  counterparty: string;
  skill: string;
  task_id: string | null;
  request_id: string | null;
  status: string;
  duration_ms: number | null;
  input_sha256: string | null;
  /** The declared usage receipt, when the exchange carried one. OPTIONAL, not
   *  nullable, and the difference is load-bearing: the key is absent from the
   *  hashed row when there is no receipt, so rows written before this field
   *  existed (and rows without a receipt) hash identically to what their
   *  chains already commit to. A NULL column value reads back as absence
   *  (`inflate`), never as `usage: null`. */
  usage?: AuditUsageClaim[];
  prev_hash: string;
  entry_hash: string;
}

/** What a row looks like straight off the table: `usage` is the stored JSON
 *  text (or NULL), not the array the hash covers. */
type AuditDbRow = Omit<AuditEntry, "usage"> & { usage: string | null };

/** Rebuild the hashed shape from a stored row: parse the usage JSON, and turn
 *  NULL into an absent key so pre-usage rows recompute to their original
 *  hashes. An unparseable value is dropped the same way - the chain check
 *  will then say plainly that the row no longer matches its hash. */
function inflate(raw: AuditDbRow): AuditEntry {
  const { usage, ...rest } = raw;
  if (usage === null || usage === undefined) return rest;
  try {
    return { ...rest, usage: JSON.parse(usage) as AuditUsageClaim[] };
  } catch {
    return rest;
  }
}

export interface AuditBundle {
  manifest: {
    format: "agentmesh-audit-bundle-v1";
    account_id: string;
    exported_at: string;
    /** What a row means and what it does not: stated IN the artifact, because
     *  the artifact outlives every page that explains it. */
    capture: "live tap of completed exchanges plus a durable backstop for messages to mailbox-holding agents; metadata and input hashes only, no content";
    agents: Array<{ agent_id: string; count: number; head_seq: number; head_hash: string }>;
    entries_sha256: string;
    signer_pub: string;
    sig: string;
  };
  /** The rows, per agent in seq order — the exact lines entries_sha256 covers,
   *  each hashed as its canonical JSON, joined by newlines. */
  entries: AuditEntry[];
}

export function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** The hash a row commits to: everything but entry_hash itself. */
export function entryHash(e: Omit<AuditEntry, "entry_hash">): string {
  return sha256hex(canonicalJSON(e));
}

export class AuditLog {
  private db: Database.Database;
  private insert: Database.Statement;
  private head: Database.Statement;
  private byAgents: (n: number) => Database.Statement;
  private chainOf: Database.Statement;
  private deleteOf: Database.Statement;
  private hasReq: Database.Statement;

  constructor(
    dbPath: string,
    /** Present where exports are made (the API process); the tap writes without one. */
    private readonly signer?: KeyPair,
  ) {
    const path = resolve(dbPath);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    // Closure's erasure must erase here too — usage-sqlite.ts says why.
    this.db.pragma("secure_delete = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_entries (
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
      CREATE INDEX IF NOT EXISTS audit_by_ts ON audit_entries (ts);
    `);
    // The usage column arrived after files of this table already existed, so
    // the frozen CREATE above stays as it is and the column is added in place.
    // Old rows read back NULL, which `inflate` turns into an absent key - the
    // shape their hashes were computed over - so no existing chain moves.
    const cols = this.db.pragma("table_info(audit_entries)") as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "usage")) {
      this.db.exec(`ALTER TABLE audit_entries ADD COLUMN usage TEXT`);
    }
    // The witness fold (witness-fold.ts) asks "was this request ever chained"
    // once per durably captured message; without an index that is a table scan
    // per message on an 18-month table.
    this.db.exec(`CREATE INDEX IF NOT EXISTS audit_by_request ON audit_entries (request_id);`);
    this.insert = this.db.prepare(
      `INSERT INTO audit_entries (agent_id, seq, ts, role, counterparty, skill, task_id, request_id, status, duration_ms, input_sha256, usage, prev_hash, entry_hash)
       VALUES (@agent_id, @seq, @ts, @role, @counterparty, @skill, @task_id, @request_id, @status, @duration_ms, @input_sha256, @usage, @prev_hash, @entry_hash)`,
    );
    this.head = this.db.prepare(
      `SELECT seq, entry_hash FROM audit_entries WHERE agent_id = ? ORDER BY seq DESC LIMIT 1`,
    );
    const byAgentsCache = new Map<number, Database.Statement>();
    this.byAgents = (n: number) => {
      let stmt = byAgentsCache.get(n);
      if (!stmt) {
        const marks = Array.from({ length: n }, () => "?").join(",");
        stmt = this.db.prepare(
          `SELECT * FROM audit_entries WHERE agent_id IN (${marks}) ORDER BY ts DESC, seq DESC LIMIT ?`,
        );
        byAgentsCache.set(n, stmt);
      }
      return stmt;
    };
    this.chainOf = this.db.prepare(`SELECT * FROM audit_entries WHERE agent_id = ? ORDER BY seq ASC`);
    this.deleteOf = this.db.prepare(`DELETE FROM audit_entries WHERE agent_id = ?`);
    this.hasReq = this.db.prepare(`SELECT 1 FROM audit_entries WHERE request_id = ? LIMIT 1`);
  }

  /** Append one row to one agent's chain. Serialized by better-sqlite3's
   *  synchronous execution: head-read and insert cannot interleave. */
  private append(fields: Omit<AuditEntry, "seq" | "prev_hash" | "entry_hash">): void {
    const head = this.head.get(fields.agent_id) as { seq: number; entry_hash: string } | undefined;
    const partial: Omit<AuditEntry, "entry_hash"> = {
      ...fields,
      seq: (head?.seq ?? 0) + 1,
      prev_hash: head?.entry_hash ?? GENESIS,
    };
    // The hash covers `partial` as-is (usage as an array, or no key at all);
    // the COLUMN holds its JSON text because an array does not bind. `inflate`
    // undoes exactly this on every read, so what verification recomputes is
    // what was hashed.
    this.insert.run({
      ...partial,
      usage: partial.usage ? JSON.stringify(partial.usage) : null,
      entry_hash: entryHash(partial),
    });
  }

  /**
   * One completed exchange, recorded for BOTH parties: the responder was
   * `served`, the requester `requested`. Two chains advance because the audit
   * question is per account and either side may be the customer asking it.
   */
  appendExchange(x: {
    from: string;
    to: string;
    skill: string;
    taskId?: string;
    requestId?: string;
    status: string;
    durationMs?: number;
    inputSha256?: string;
    /** The §13.5 usage receipt the responder declared on its terminal respond
     *  (payload.usage), carried into both parties' chains so the claim is
     *  tamper-evident after the fact — the same reason input_sha256 is here.
     *  Additive: rows written before this field simply lack it. */
    usage?: Array<{ meter: string; quantity: number }>;
  }): void {
    const ts = new Date().toISOString();
    const common = {
      ts,
      skill: x.skill,
      task_id: x.taskId ?? null,
      request_id: x.requestId ?? null,
      status: x.status,
      duration_ms: x.durationMs ?? null,
      input_sha256: x.inputSha256 ?? null,
      ...(x.usage && x.usage.length > 0 ? { usage: x.usage } : {}),
    };
    if (x.to) this.append({ ...common, agent_id: x.to, role: "served", counterparty: x.from });
    if (x.from) this.append({ ...common, agent_id: x.from, role: "requested", counterparty: x.to });
  }

  /** Whether any chain already carries this request id. The witness fold's
   *  question: an existing row means the tap saw the exchange (or an earlier
   *  delivery of the same capture was already folded), so the backstop has
   *  nothing to add. */
  hasRequest(requestId: string): boolean {
    return this.hasReq.get(requestId) !== undefined;
  }

  /**
   * The durable backstop's pair (witness-fold.ts). A "witnessed" row means
   * exactly this: the platform durably captured this message; the outcome is
   * not claimed. No duration and no status beyond "witnessed", because nobody
   * observed the exchange complete - the live tap was not there, and the
   * mailbox capture holds the message, not what became of it. `request_id` is
   * the captured envelope's own id, which is also what makes a redelivery of
   * the same capture a no-op (`hasRequest`).
   */
  appendWitnessed(x: {
    from: string;
    to: string;
    skill: string;
    taskId?: string;
    requestId: string;
    inputSha256?: string;
  }): void {
    const ts = new Date().toISOString();
    const common = {
      ts,
      skill: x.skill,
      task_id: x.taskId ?? null,
      request_id: x.requestId,
      status: "witnessed",
      duration_ms: null,
      input_sha256: x.inputSha256 ?? null,
    };
    if (x.to) this.append({ ...common, agent_id: x.to, role: "served", counterparty: x.from });
    if (x.from) this.append({ ...common, agent_id: x.from, role: "requested", counterparty: x.to });
  }

  /** Recent rows across a set of agents, newest first. The read the console
   *  makes; scoping to the ACCOUNT'S agents is the caller's job and the only
   *  authorization there is. */
  list(agentIds: string[], limit = 50): AuditEntry[] {
    if (!agentIds.length) return [];
    const rows = this.byAgents(agentIds.length).all(
      ...agentIds,
      Math.max(1, Math.min(limit, 500)),
    ) as AuditDbRow[];
    return rows.map(inflate);
  }

  /** Walk one agent's chain start to end, recomputing every link. */
  verifyChain(agentId: string): { ok: boolean; count: number; brokenAt?: number } {
    const rows = (this.chainOf.all(agentId) as AuditDbRow[]).map(inflate);
    let prev = GENESIS;
    for (const row of rows) {
      const { entry_hash, ...rest } = row;
      if (row.prev_hash !== prev || entryHash(rest) !== entry_hash) {
        return { ok: false, count: rows.length, brokenAt: row.seq };
      }
      prev = entry_hash;
    }
    return { ok: true, count: rows.length };
  }

  /**
   * The export: every row for the given agents plus a signed manifest. The
   * signature covers AUDIT_SIG_PREFIX + canonical JSON of the manifest minus
   * `sig`; `entries_sha256` covers the canonical JSON of each row joined by
   * newlines, in the order shipped. tools/verify-audit.mjs re-derives all of
   * it offline.
   */
  export(accountId: string, agentIds: string[]): AuditBundle {
    if (!this.signer) throw new Error("this AuditLog was opened without a signing identity");
    const entries: AuditEntry[] = [];
    const agents: AuditBundle["manifest"]["agents"] = [];
    for (const id of agentIds) {
      const rows = (this.chainOf.all(id) as AuditDbRow[]).map(inflate);
      if (!rows.length) continue;
      entries.push(...rows);
      const head = rows[rows.length - 1];
      agents.push({ agent_id: id, count: rows.length, head_seq: head.seq, head_hash: head.entry_hash });
    }
    const entriesSha = sha256hex(entries.map((e) => canonicalJSON(e)).join("\n"));
    const unsigned = {
      format: "agentmesh-audit-bundle-v1" as const,
      account_id: accountId,
      exported_at: new Date().toISOString(),
      capture:
        "live tap of completed exchanges plus a durable backstop for messages to mailbox-holding agents; metadata and input hashes only, no content" as const,
      agents,
      entries_sha256: entriesSha,
      signer_pub: this.signer.getPublicKey(),
    };
    const sig = toB64Url(signTagged(this.signer, AUDIT_SIG_PREFIX, canonicalJSON(unsigned)));
    return { manifest: { ...unsigned, sig }, entries };
  }

  /** Every agent with a chain here, for the whole-mesh export (step 10a: the
   *  operator's daily export asks the core for it rather than reading the file). */
  agentIds(): string[] {
    return (this.db.prepare(`SELECT DISTINCT agent_id FROM audit_entries ORDER BY agent_id`).all() as Array<{ agent_id: string }>).map((r) => r.agent_id);
  }

  /** Each chain's head (its last entry's sequence and hash), for anchoring. */
  heads(): Array<{ id: string; seq: number; entry_hash: string }> {
    return this.db
      .prepare(
        `SELECT agent_id AS id, seq, entry_hash FROM audit_entries
           WHERE seq = (SELECT MAX(seq) FROM audit_entries m WHERE m.agent_id = audit_entries.agent_id)
           ORDER BY agent_id`,
      )
      .all() as Array<{ id: string; seq: number; entry_hash: string }>;
  }

  /** Closure's erasure: an account's history leaves with the account. */
  deleteForAgents(agentIds: string[]): number {
    let n = 0;
    for (const id of agentIds) n += this.deleteOf.run(id).changes;
    return n;
  }

  close(): void {
    this.db.close();
  }
}
