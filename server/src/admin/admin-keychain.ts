/**
 * The admin API's key chain routes for a platform running beside the core
 * (step 10a of docs/agent-messaging-server-plan.md): the records the core's
 * credential doors decide by, record by record, and the actions that need
 * the broker's operator key. AgentMesh's platform runs its kill switch, its app
 * and job doors and its owners' key rotation on these, with the decisions its
 * own (who may stop what, whose agent it is); the core keeps the records and
 * holds the keys.
 *
 *   GET    /admin/v1/keychain/tombstones?retired=1      { keys }: every key retired for good
 *   GET    /admin/v1/keychain/tombstones/:agent         { tombstone }: the renewal refusal, or null
 *   PUT    /admin/v1/keychain/tombstones/:agent         { reason, by } -> { tombstone }
 *   DELETE /admin/v1/keychain/tombstones/:agent         { cleared }
 *   GET    /admin/v1/keychain/key-revocations/:key      { revocation }: a revoked signing key, or null
 *   PUT    /admin/v1/keychain/key-revocations/:key      { reason, by, replaced_by? } -> { revocation }
 *   GET    /admin/v1/keychain/status/:agent             { status }: paused or terminated, or null
 *   PUT    /admin/v1/keychain/status/:agent             { status, since, stop_id?, scope? }
 *   DELETE /admin/v1/keychain/status/:agent             { cleared }
 *   GET    /admin/v1/keychain/stops[?active=1]          { stops }
 *   GET    /admin/v1/keychain/stops/:id                 { stop }
 *   PUT    /admin/v1/keychain/stops/:id                 { stop } -> { stop }
 *   GET    /admin/v1/keychain/mints                     { mints }: what the mint log tracks (never a secret)
 *   POST   /admin/v1/keychain/mints                     a mint to track (key, agents, label?, expiresAt, door, account?, org?)
 *   POST   /admin/v1/keychain/boot-tokens               { token, account, label, name?, org?, opts? }: an enrollment token
 *   POST   /admin/v1/keychain/boot-tokens/take          { token } -> { data }: the token's grant, once
 *   POST   /admin/v1/keychain/revoke-credential         the revoke action (credential-revoke.ts): { agentKey?, userKeys?,
 *                                                       reason, by, refuseRenewal?, deregister? } -> its result
 *   POST   /admin/v1/keychain/cut                       { agents } -> the live cut of every connection carrying them
 *   POST   /admin/v1/keychain/mesh-pause                { pause } -> the customer signing key out of the account, or back
 *
 * Each answer is { status, body } and never throws.
 */
import type { DoorAnswer } from "../keychain/doors.js";
import type { AdminRequest } from "./admin-api.js";
import type { CredRevocationStore } from "../keychain/cred-revocation.js";
import type { AgentKeyRevocationStore } from "../shared/agent-key-revocations.js";
import type { AgentStatusEntry, AgentStatusStore } from "../shared/agent-status.js";
import type { StopStore } from "../keychain/stop-store.js";
import type { StopRecord } from "../keychain/stop-record.js";
import type { CredMintLog } from "../keychain/cred-mint-log.js";
import type { BootTokens, BootTokenOpts } from "../keychain/boot-tokens.js";
import type { CredentialRevokeInput, CredentialRevokeResult } from "../keychain/credential-revoke.js";
import type { CutResult } from "../keychain/kill-switch-cut.js";

const NKEY = /^U[A-Z2-7]{55}$/;
const STOP_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface AdminKeychainDeps {
  tombstones: CredRevocationStore | null;
  keyRevocations: AgentKeyRevocationStore | null;
  agentStatus: AgentStatusStore | null;
  stops: StopStore | null;
  mintLog: CredMintLog | null;
  bootTokens: BootTokens | null;
  revoke(input: CredentialRevokeInput): Promise<CredentialRevokeResult>;
  cut(agents: string[]): Promise<CutResult & { keys: string[] }>;
  meshPause(pause: boolean): Promise<Record<string, unknown>>;
}

const ok = (body: Record<string, unknown>, status = 200): DoorAnswer => ({ status, body });
const no = (status: number, error: string): DoorAnswer => ({ status, body: { error } });
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const missing = (what: string) => no(503, `The ${what} cannot be read on this server.`);

export function adminKeychain(deps: AdminKeychainDeps) {
  async function route(seg: string[], m: string, q: URLSearchParams, b: Record<string, unknown>): Promise<DoorAnswer | null> {
    const [what, id, sub] = seg;
    if (what === "tombstones") {
      const t = deps.tombstones;
      if (!t) return missing("renewal refusals");
      if (seg.length === 1 && m === "GET" && q.get("retired") === "1") return ok({ keys: [...(await t.retiredKeys())] });
      if (seg.length !== 2) return null;
      if (!NKEY.test(id!)) return no(400, "That is not an agent public key.");
      if (m === "GET") return ok({ tombstone: await t.get(id!) });
      if (m === "DELETE") return ok({ cleared: await t.clear(id!) });
      if (m === "PUT") {
        const reason = str(b.reason);
        const by = str(b.by);
        if (!reason || !by) return no(400, "reason and by are required.");
        return ok({ tombstone: await t.revoke(id!, reason, by) });
      }
    }
    if (what === "key-revocations" && seg.length === 2) {
      const r = deps.keyRevocations;
      if (!r) return missing("signing key revocations");
      if (!NKEY.test(id!)) return no(400, "That is not an agent public key.");
      if (m === "GET") return ok({ revocation: await r.get(id!) });
      if (m === "PUT") {
        const reason = str(b.reason);
        const by = str(b.by);
        if (!reason || !by) return no(400, "reason and by are required.");
        const replaced = str(b.replaced_by);
        if (replaced && !NKEY.test(replaced)) return no(400, "replaced_by is an agent public key.");
        return ok({ revocation: await r.revoke(id!, { reason, by, ...(replaced ? { replaced_by: replaced } : {}) }) });
      }
    }
    if (what === "status" && seg.length === 2) {
      const s = deps.agentStatus;
      if (!s) return missing("agents' stopped states");
      if (!NKEY.test(id!)) return no(400, "That is not an agent public key.");
      if (m === "GET") return ok({ status: await s.get(id!) });
      if (m === "DELETE") return ok({ cleared: await s.clear(id!) });
      if (m === "PUT") {
        if (b.status !== "paused" && b.status !== "terminated") return no(400, 'status is "paused" or "terminated".');
        const since = str(b.since);
        if (!since || !Number.isFinite(Date.parse(since))) return no(400, "since is an ISO time.");
        const entry = { ...b, status: b.status, since } as unknown as AgentStatusEntry;
        await s.set(id!, entry);
        return ok({ status: entry as unknown as Record<string, unknown> });
      }
    }
    if (what === "stops") {
      const s = deps.stops;
      if (!s) return missing("stop list");
      if (seg.length === 1 && m === "GET") return ok({ stops: q.get("active") === "1" ? await s.active() : await s.all() });
      if (seg.length !== 2 || !STOP_ID.test(id!)) return seg.length === 2 ? no(400, "That is not a stop id.") : null;
      if (m === "GET") return ok({ stop: await s.get(id!) });
      if (m === "PUT") {
        const rec = b.stop as StopRecord | undefined;
        if (!rec || typeof rec !== "object" || rec.id !== id || typeof rec.scope !== "string" || typeof rec.action !== "string") {
          return no(400, "stop is a stop record whose id is the one in the path.");
        }
        return ok({ stop: await s.put(rec) as unknown as Record<string, unknown> });
      }
    }
    if (what === "mints" && seg.length === 1) {
      const l = deps.mintLog;
      if (!l) return missing("mint log");
      if (m === "GET") return ok({ mints: await l.all() });
      if (m === "POST") {
        const key = str(b.key);
        const agents = Array.isArray(b.agents) ? b.agents.filter((a): a is string => typeof a === "string" && NKEY.test(a)) : null;
        const door = b.door === "bootstrap" || b.door === "renewal" || b.door === "admin" ? b.door : null;
        if (!key || !NKEY.test(key) || !agents || !door) return no(400, "key, agents and door are required.");
        await l.recordMint({
          key,
          agents,
          ...(str(b.label) ? { label: str(b.label)! } : {}),
          expiresAt: str(b.expiresAt),
          door,
          account: str(b.account),
          org: str(b.org),
        });
        return ok({ recorded: true });
      }
    }
    if (what === "boot-tokens") {
      const t = deps.bootTokens;
      if (!t) return missing("enrollment tokens");
      if (seg.length === 1 && m === "POST") {
        const token = str(b.token);
        const account = str(b.account);
        const label = str(b.label);
        if (!token || !account || !label) return no(400, "token, account and label are required.");
        await t.put(token, account, label, str(b.name) ?? undefined, str(b.org) ?? undefined, (b.opts ?? {}) as BootTokenOpts);
        return ok({ stored: true });
      }
      if (seg.length === 2 && id === "take" && m === "POST") {
        const token = str(b.token);
        if (!token) return no(400, "token is required.");
        return ok({ data: (await t.take(token)) as unknown as Record<string, unknown> | null });
      }
    }
    if (seg.length === 1 && m === "POST") {
      if (what === "revoke-credential") {
        const input = b as unknown as CredentialRevokeInput;
        if (!str(input.reason) || !str(input.by)) return no(400, "reason and by are required.");
        if (input.agentKey !== undefined && !NKEY.test(input.agentKey)) return no(400, "agentKey is an agent public key.");
        if (!input.agentKey && !(Array.isArray(input.userKeys) && input.userKeys.length)) return no(400, "Name an agentKey or userKeys.");
        return ok(await deps.revoke(input) as unknown as Record<string, unknown>);
      }
      if (what === "cut") {
        const agents = Array.isArray(b.agents) ? b.agents.filter((a): a is string => typeof a === "string" && NKEY.test(a)) : [];
        if (!agents.length) return no(400, "agents is a list of agent public keys.");
        return ok(await deps.cut(agents) as unknown as Record<string, unknown>);
      }
      if (what === "mesh-pause") {
        if (typeof b.pause !== "boolean") return no(400, "pause is true or false.");
        return ok(await deps.meshPause(b.pause));
      }
    }
    void sub;
    return null;
  }

  async function handle(req: AdminRequest): Promise<DoorAnswer | null> {
    const seg = req.path.replace(/^\/admin\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    if (seg[0] !== "keychain") return null;
    try {
      return await route(seg.slice(1), req.method, req.query, req.body ?? {});
    } catch (err) {
      return no(503, `The key chain could not do that: ${(err as Error).message}`);
    }
  }

  return { handle };
}

export type AdminKeychain = ReturnType<typeof adminKeychain>;
