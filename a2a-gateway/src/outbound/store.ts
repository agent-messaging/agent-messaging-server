/**
 * The attachment store: the durable half of the outbound direction.
 *
 * An attachment is the bridge's record of "this account presents this A2A
 * endpoint as its agent" — the policy object of the gateway. Everything an
 * operator or a billing system will later want to know about an attachment
 * lives HERE as data (visibility, rate caps, fee), never as a constant in the
 * forwarding path, so turning a knob is an update to a record rather than a
 * deploy.
 *
 * Storage is a JSON file with atomic replace (write tmp, rename). One host
 * runs one bridge, records are few and small, and a file survives every
 * restart the same way KV would — without requiring the bridge's mesh
 * credential to hold JetStream permissions it does not have today. The
 * interface is deliberately narrow so a KV-backed implementation can replace
 * the file when the platform wants one; nothing outside this module knows
 * which is behind it.
 *
 * The record carries the attachment's agent NKey seed, so the SAME mesh
 * identity survives bridge restarts — an attached agent's id is a fact other
 * agents store, and re-minting on every boot would quietly break them. The
 * seed never leaves this module unredacted: `redact()` is what every API
 * response passes through.
 */
import { readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentCard } from "../core/card.js";

/**
 * `review` — the card changed materially; the approved card is still being
 * served while the change waits for re-approval.
 * `suspended` — the card moved its ENDPOINT; the attachment is off the mesh
 * until someone approves following it, because silently forwarding an
 * account's traffic to a new address is how a hijacked domain becomes a
 * hijacked agent.
 */
export type AttachmentState = "active" | "review" | "suspended" | "unreachable" | "detached";

/** The policy fields — PATCHable, everything else is not. */
export interface AttachmentPolicy {
  visibility: "public" | "unlisted" | "private";
  /** Forwarded calls to the remote, all mesh callers together, per minute. */
  ratePerMinute: number;
  /** One mesh caller's share of that ceiling, per minute. */
  ratePerCallerPerMinute: number;
  /** One mesh caller's calls per HOUR — the signed volume clause of a
   *  standing proposal SoW, written here when the owner signs terms so the
   *  clause is gateway-enforced rather than declarative. Null = no signed
   *  volume clause; only the per-minute burst caps apply. */
  ratePerCallerPerHour: number | null;
  /** Spend ceiling for the attachment, in the account's currency. Null = none.
   *  Not yet enforced; carried so enforcement is a data change, not a schema one. */
  budgetCeiling: number | null;
  /** Fee per brokered request, in microcents. Zero until fees exist; the field
   *  exists so a nonzero fee is a policy update, not a migration. */
  feeMicrocents: number;
  /** The owner's WHOLESALE rate per brokered request, in credits: what the
   *  owner is paid when their agent serves a call. Zero = free. Callers pay
   *  the RETAIL price (rate + the platform's markup, manager.ts) — the
   *  reseller shape: the owner sets what they sell for, the platform sets
   *  what it charges, and the margin is the platform's, never a deduction
   *  from the owner. Requires clearing (CLEARING_URL); setting a nonzero
   *  rate on a mesh without clearing is refused at configuration time. */
  rateCredits: number;
}

/**
 * The owner's statement: the part of an Agent Descriptor that only the owner
 * can write, because an A2A card has no place for it. `refusals` is prose
 * (what the agent will not do); `records` names what the agent keeps of each
 * task. Both are optional; a statement with neither is stored as null.
 */
export interface AttachmentStatement {
  refusals?: string;
  records?: string[];
}

export interface AttachmentRecord {
  id: string;
  /** The account standing behind this attachment. Null for operator-side
   *  (env-bootstrap) attachments, which stand on the bridge's own vouch. */
  accountId: string | null;
  label: string;
  /** Base URL (or explicit card URL) as given at attach time. */
  url: string;
  /** The card as approved — verbatim, so "what changed" is answerable later. */
  card: AgentCard;
  /** A re-fetched card that differs MATERIALLY from the approved one, held for
   *  re-approval. The live registration keeps serving `card` — the approval was
   *  over a specific card, and a changed card is a new question, not an update. */
  pendingCard?: AgentCard | null;
  /** Skill ids to expose; null = every skill the card declares. */
  exposedSkills: string[] | null;
  policy: AttachmentPolicy;
  /** Static headers for the remote (e.g. Authorization). Redacted from reads. */
  headers?: Record<string, string>;
  /** Agent NKey seed ("SUA..."). Redacted from every API response. */
  identitySeed: string;
  /** Last-known mesh agent id for this attachment. */
  agentId: string | null;
  /** Running totals of brokered requests, kept on the record so the owner can
   *  see them without a usage-ingest service existing yet. The emitted events
   *  remain the ledger; these are the odometer. */
  usage?: { requests: number; errors: number; lastAt: string | null };
  /** What the owner says about the agent that its card cannot: what it
   *  refuses to do, and what records it keeps of the work. Null (or absent,
   *  on a record written before the field existed) means the owner has said
   *  nothing, and the gateway publishes no descriptor for the attachment.
   *  Shaped and checked by descriptor.ts; set at create time or replaced
   *  whole with PUT /admin/attachments/:id/statement. */
  statement?: AttachmentStatement | null;
  /** When the registry last accepted a descriptor for this attachment's
   *  identity. Null or absent: none has been published from here. */
  descriptorPublishedAt?: string | null;
  /** Why the last descriptor put failed, in the registry's (or the
   *  transport's) words. Null after a put that worked. A failed put never
   *  takes the attachment off the mesh; this is where it shows instead. */
  descriptorError?: string | null;
  state: AttachmentState;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_POLICY: AttachmentPolicy = {
  visibility: "public",
  ratePerMinute: 120,
  ratePerCallerPerMinute: 30,
  ratePerCallerPerHour: null,
  budgetCeiling: null,
  feeMicrocents: 0,
  rateCredits: 0,
};

/** What leaves the store toward any API response: no seed, no auth headers. */
export function redact(rec: AttachmentRecord): Omit<AttachmentRecord, "identitySeed" | "headers"> {
  const { identitySeed: _seed, headers: _headers, ...rest } = rec;
  return rest;
}

export function newRecord(fields: {
  url: string;
  card: AgentCard;
  accountId?: string | null;
  label?: string;
  exposedSkills?: string[] | null;
  policy?: Partial<AttachmentPolicy>;
  headers?: Record<string, string>;
  identitySeed: string;
  statement?: AttachmentStatement | null;
}): AttachmentRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    accountId: fields.accountId ?? null,
    label: fields.label ?? fields.card.name,
    url: fields.url,
    card: fields.card,
    pendingCard: null,
    exposedSkills: fields.exposedSkills ?? null,
    policy: { ...DEFAULT_POLICY, ...fields.policy },
    headers: fields.headers,
    identitySeed: fields.identitySeed,
    agentId: null,
    statement: fields.statement ?? null,
    descriptorPublishedAt: null,
    descriptorError: null,
    state: "active",
    createdAt: now,
    updatedAt: now,
  };
}

export interface AttachmentStore {
  load(): Promise<AttachmentRecord[]>;
  /** Insert or replace by id, persisted before resolving. */
  put(rec: AttachmentRecord): Promise<void>;
  get(id: string): Promise<AttachmentRecord | undefined>;
}

export class FileAttachmentStore implements AttachmentStore {
  private records = new Map<string, AttachmentRecord>();
  private loaded = false;
  /** Writes are chained so two put()s cannot interleave their tmp/rename pairs. */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<AttachmentRecord[]> {
    if (!this.loaded) {
      try {
        const raw = await readFile(this.path, "utf8");
        for (const rec of JSON.parse(raw) as AttachmentRecord[]) {
          // Pre-reseller records priced with `priceCredits` (the caller-facing
          // number under the old agency shape). Read it as the owner's rate —
          // the number the owner chose is the number the owner keeps.
          const legacy = rec.policy as AttachmentPolicy & { priceCredits?: number };
          if (legacy.priceCredits !== undefined) {
            legacy.rateCredits = legacy.rateCredits ?? legacy.priceCredits;
            delete legacy.priceCredits;
          }
          rec.policy = { ...DEFAULT_POLICY, ...rec.policy };
          // Records written before owners could make a statement have no
          // field at all; that reads as "nothing said", the same as null.
          rec.statement ??= null;
          this.records.set(rec.id, rec);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        // No file yet is a normal first boot, not an error.
      }
      this.loaded = true;
    }
    return [...this.records.values()];
  }

  async put(rec: AttachmentRecord): Promise<void> {
    await this.load();
    this.records.set(rec.id, { ...rec, updatedAt: new Date().toISOString() });
    this.writing = this.writing.then(() => this.flush());
    await this.writing;
  }

  async get(id: string): Promise<AttachmentRecord | undefined> {
    await this.load();
    return this.records.get(id);
  }

  private async flush(): Promise<void> {
    const body = JSON.stringify([...this.records.values()], null, 2);
    // The file holds every attachment's auth headers and identity seed:
    // owner-only, at every step. The dir is 0700, the file 0600. `writeFile`'s
    // mode only applies when it CREATES the file, so a tmp file left by a
    // crashed earlier write would keep its old bits — chmod closes that hole
    // before the rename makes the tmp file the real one.
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}
