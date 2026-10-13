/**
 * Dynamic inbound API keys: the self-serve half of §9 caller identity.
 *
 * The env-var `API_KEYS` list stays what it always was — the operator's
 * hand-issued keys. This store adds keys minted at runtime through the admin
 * API, each standing on an ACCOUNT: the account console mints one, hands the
 * raw key to the user once, and the bridge admits `Authorization: Bearer`
 * calls against it from then on.
 *
 * The raw key is never stored. The record keeps a SHA-256 of it plus a short
 * display prefix; verification hashes what the caller presented and looks
 * that up. Losing the file therefore loses nothing secret, and reading the
 * file (or any admin listing) yields nothing a caller could present.
 *
 * Same durable-file pattern as the attachment store, same reasoning: one
 * bridge per host, few small records, atomic replace, a narrow interface a
 * KV implementation could stand behind later.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface ApiKeyRecord {
  id: string;
  /** The account this key stands on. Null for operator-minted records. */
  accountId: string | null;
  label: string;
  /** SHA-256 hex of the raw key. The raw key exists only in the mint reply. */
  sha256: string;
  /** First characters of the raw key, for "which key was that" in listings. */
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

/** What listings and API responses carry: no hash — a hash is not a secret,
 *  but there is no reason to hand out oracle material either. */
export function redactKey(rec: ApiKeyRecord): Omit<ApiKeyRecord, "sha256"> {
  const { sha256: _h, ...rest } = rec;
  return rest;
}

const KEY_BYTES = 24;
const PREFIX_LEN = 8;

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export class FileKeyStore {
  private records = new Map<string, ApiKeyRecord>();
  /** sha256 → record, live keys only. What `verify` reads on the hot path. */
  private byHash = new Map<string, ApiKeyRecord>();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      for (const rec of JSON.parse(raw) as ApiKeyRecord[]) {
        this.records.set(rec.id, rec);
        if (!rec.revokedAt) this.byHash.set(rec.sha256, rec);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.loaded = true;
  }

  /** Mint a key. The ONLY place the raw key ever exists is this return value. */
  async mint(fields: { accountId?: string | null; label?: string }): Promise<{ record: ApiKeyRecord; rawKey: string }> {
    await this.load();
    const rawKey = `amk_${randomBytes(KEY_BYTES).toString("hex")}`;
    const record: ApiKeyRecord = {
      id: randomUUID(),
      accountId: fields.accountId ?? null,
      label: fields.label?.trim() || "unnamed key",
      sha256: hash(rawKey),
      prefix: rawKey.slice(0, PREFIX_LEN),
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.records.set(record.id, record);
    this.byHash.set(record.sha256, record);
    await this.flushChained();
    return { record, rawKey };
  }

  /** The record a presented raw key stands for, or null. Synchronous on
   *  purpose: admission runs on every request and the index is in memory. */
  verify(rawKey: string): ApiKeyRecord | null {
    return this.byHash.get(hash(rawKey)) ?? null;
  }

  /** True when at least one live key exists — feeds the bridge's "are keys
   *  configured" posture alongside the env list. */
  hasLiveKeys(): boolean {
    return this.byHash.size > 0;
  }

  async list(accountId?: string | null): Promise<ApiKeyRecord[]> {
    await this.load();
    const all = [...this.records.values()];
    return accountId === undefined ? all : all.filter((r) => r.accountId === accountId);
  }

  async get(id: string): Promise<ApiKeyRecord | undefined> {
    await this.load();
    return this.records.get(id);
  }

  /** Revoke: the record stays as history, the hash index forgets it, and the
   *  next request presenting it is a stranger. */
  async revoke(id: string): Promise<boolean> {
    await this.load();
    const rec = this.records.get(id);
    if (!rec || rec.revokedAt) return false;
    rec.revokedAt = new Date().toISOString();
    this.byHash.delete(rec.sha256);
    await this.flushChained();
    return true;
  }

  private flushChained(): Promise<void> {
    this.writing = this.writing.then(() => this.flush());
    return this.writing;
  }

  private async flush(): Promise<void> {
    const body = JSON.stringify([...this.records.values()], null, 2);
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, this.path);
  }
}
