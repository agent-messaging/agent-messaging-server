/**
 * Who may call the admin API: the holder of an admin token.
 *
 * The tokens live in a file on the server, named by MESH_ADMIN_TOKEN_FILE, one
 * per line. A line may give the token a name first ("ops-laptop <token>"), so
 * the log can say which token made a change; a line with one word is a token
 * with no name. Blank lines and lines starting with # are skipped. A token is
 * at least 32 characters. `mesh-admin token new --out <file>` writes one.
 *
 * With no file set, every admin route answers 503: a new mesh is closed until
 * its operator makes a token, never open. The file is read again whenever it
 * changes, so adding or removing a token needs no restart.
 *
 * Tokens are compared as SHA-256 digests with a constant-time compare, and
 * nothing here prints or stores a token. Choosing who may hold a token stays
 * with the company's own identity system; an OIDC hook for that is a later
 * add-on (docs/agent-messaging-server-plan.md, "Admin: agents, not people").
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const ADMIN_TOKEN_SETTING = "MESH_ADMIN_TOKEN_FILE";
export const MIN_TOKEN_LENGTH = 32;

export interface AdminToken {
  /** The name given in the file, or "token 1", "token 2"… by line order. */
  name: string;
  hash: Buffer;
}

/** Read the tokens out of the file's text. Lines too short to be a token are
 *  skipped and counted, never echoed. */
export function parseAdminTokens(text: string): { tokens: AdminToken[]; skipped: number } {
  const tokens: AdminToken[] = [];
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const secret = parts[parts.length - 1]!;
    const name = parts.length > 1 ? parts.slice(0, -1).join(" ") : `token ${tokens.length + 1}`;
    if (secret.length < MIN_TOKEN_LENGTH) { skipped++; continue; }
    tokens.push({ name, hash: createHash("sha256").update(secret).digest() });
  }
  return { tokens, skipped };
}

export type AdminCaller = { ok: true; name: string } | { ok: false; status: number; error: string };

export class AdminAuth {
  private tokens: AdminToken[] = [];
  private seen: { mtimeMs: number; size: number } | null = null;
  private problem: string | null = null;

  constructor(private path: string | null, private read: (p: string) => string = (p) => readFileSync(p, "utf8"), private stat: (p: string) => { mtimeMs: number; size: number } = statSync) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): AdminAuth {
    const p = env[ADMIN_TOKEN_SETTING]?.trim();
    return new AdminAuth(p || null);
  }

  /** One line for the start-up log: on or off, and why. Never a token. */
  describe(): string {
    this.refresh();
    if (!this.path) return `off: no admin token file is set (${ADMIN_TOKEN_SETTING}), so every admin route answers 503`;
    if (this.problem) return `off: ${this.problem}`;
    return `on (${this.tokens.length} token${this.tokens.length === 1 ? "" : "s"}: ${this.tokens.map((t) => t.name).join(", ")})`;
  }

  /** Re-read the file when it changed. */
  private refresh(): void {
    if (!this.path) return;
    let st: { mtimeMs: number; size: number };
    try {
      st = this.stat(this.path);
    } catch {
      this.tokens = [];
      this.seen = null;
      this.problem = `the admin token file (${ADMIN_TOKEN_SETTING}) cannot be read`;
      return;
    }
    if (this.seen && this.seen.mtimeMs === st.mtimeMs && this.seen.size === st.size) return;
    try {
      const { tokens, skipped } = parseAdminTokens(this.read(this.path));
      this.tokens = tokens;
      this.seen = { mtimeMs: st.mtimeMs, size: st.size };
      this.problem = tokens.length ? null : `the admin token file (${ADMIN_TOKEN_SETTING}) holds no token${skipped ? ` (${skipped} line${skipped === 1 ? " was" : "s were"} shorter than ${MIN_TOKEN_LENGTH} characters)` : ""}`;
      if (skipped) console.warn(`[admin] ${skipped} line(s) in the admin token file are shorter than ${MIN_TOKEN_LENGTH} characters and were skipped`);
    } catch {
      this.tokens = [];
      this.seen = null;
      this.problem = `the admin token file (${ADMIN_TOKEN_SETTING}) cannot be read`;
    }
  }

  /** Check the request's `Authorization: Bearer <token>` header. */
  check(authorization: string | undefined): AdminCaller {
    this.refresh();
    if (!this.path) return { ok: false, status: 503, error: `The admin API is off on this mesh: no admin token file is set (${ADMIN_TOKEN_SETTING}).` };
    if (this.problem) return { ok: false, status: 503, error: `The admin API is off on this mesh: ${this.problem}.` };
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
    if (!m) return { ok: false, status: 401, error: "An admin token is required: send it as Authorization: Bearer <token>." };
    const presented = createHash("sha256").update(m[1]!).digest();
    let match: AdminToken | null = null;
    // Every token is compared, so the time taken does not say which one matched.
    for (const t of this.tokens) if (timingSafeEqual(presented, t.hash)) match = t;
    if (!match) return { ok: false, status: 401, error: "That admin token is not one this mesh accepts." };
    return { ok: true, name: match.name };
  }
}
