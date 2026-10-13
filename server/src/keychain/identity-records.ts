/**
 * What the key chain records about an agent whose identity came from outside
 * (SPEC §4.14, §4.15 and §9.7; steps 11 and 12 of the bring-your-own-identity
 * plan). Two buckets:
 *
 *   mesh_identity_sources  agent key → { identity_source, attestation }
 *       Where the agent's identity came from: this mesh's own enrollment, an
 *       OAuth issuer, a SPIFFE trust domain, or a bridge. Written by the key
 *       chain when the agent enrolls, signed by the mesh's account signing key
 *       as a portable trust attestation (§9.7), and never by the agent or its
 *       node. The registry joins it into discovery and `describe`.
 *
 *   mesh_workload_ids      digest of (scope, workload id) → WorkloadBinding
 *       Which agent holds each outside identity now. One workload identifier
 *       maps to one agent at a time: enrolling again with the same identity
 *       and a new agent key moves the binding, and the old key is revoked
 *       (§4.10). The scope is the issuer for OAuth, so two issuers' subjects
 *       never collide, and `spiffe` for SPIFFE IDs, which name their domain.
 */
import { createHash } from "node:crypto";
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";
import type { IdentitySource } from "./outside-proof.js";

export const IDENTITY_SOURCES_BUCKET = "mesh_identity_sources";
export const WORKLOAD_IDS_BUCKET = "mesh_workload_ids";

/** One agent's identity source, with the attestation that carries it. */
export interface IdentitySourceRecord {
  agent: string;
  identity_source: IdentitySource;
  /** The portable trust attestation (§9.7) whose claims carry it, when the
   *  mesh could sign one. */
  attestation?: Record<string, unknown>;
  tenant: string | null;
}

export interface WorkloadBinding {
  agent: string;
  tenant: string;
  kind: "oauth" | "spiffe";
  workload_id: string;
  issuer?: string;
  trust_domain?: string;
  /** Bridged: the bridge node that holds the agent's key. */
  bridge?: string;
  since: string;
  updated_at: string;
}

/** The record key for an outside identity. */
export function workloadKey(kind: "oauth" | "spiffe", scope: string, workloadId: string): string {
  return createHash("sha256").update(`${kind}\n${scope}\n${workloadId}`).digest("hex");
}

export interface IdentitySourceList {
  get(agent: string): Promise<IdentitySourceRecord | null>;
  put(rec: IdentitySourceRecord): Promise<void>;
  remove(agent: string): Promise<void>;
  all(): Promise<Map<string, IdentitySourceRecord>>;
}

export interface WorkloadBindingList {
  get(key: string): Promise<WorkloadBinding | null>;
  put(key: string, b: WorkloadBinding): Promise<void>;
}

export class IdentitySourceStore implements IdentitySourceList {
  private kv: KeyedStore;
  constructor(kv: KeyedLike, js?: StorageLike) { this.kv = keyedOf(kv, js); }

  static async create(js: StorageLike): Promise<IdentitySourceStore> {
    // The name is written out because closure-registry.test.ts finds buckets by reading these calls.
    return new IdentitySourceStore(await storageOf(js).keyed("mesh_identity_sources"));
  }

  get bucket(): KeyedStore { return this.kv; }

  async get(agent: string): Promise<IdentitySourceRecord | null> {
    const e = await this.kv.get(agent);
    return e?.value.length ? e.json<IdentitySourceRecord>() : null;
  }

  async put(rec: IdentitySourceRecord): Promise<void> {
    await this.kv.put(rec.agent, JSON.stringify(rec));
  }

  async remove(agent: string): Promise<void> {
    await this.kv.purge(agent);
  }

  async all(): Promise<Map<string, IdentitySourceRecord>> {
    const snap = await this.kv.list();
    const out = new Map<string, IdentitySourceRecord>();
    for (const [k, e] of snap.entries) {
      try { out.set(k, e.json<IdentitySourceRecord>()); } catch { console.warn(`[identity] an unreadable identity source was skipped (${k.slice(0, 12)}…)`); }
    }
    return out;
  }
}

export class WorkloadBindingStore implements WorkloadBindingList {
  private kv: KeyedStore;
  constructor(kv: KeyedLike, js?: StorageLike) { this.kv = keyedOf(kv, js); }

  static async create(js: StorageLike): Promise<WorkloadBindingStore> {
    // The name is written out because closure-registry.test.ts finds buckets by reading these calls.
    return new WorkloadBindingStore(await storageOf(js).keyed("mesh_workload_ids"));
  }

  async get(key: string): Promise<WorkloadBinding | null> {
    const e = await this.kv.get(key);
    return e?.value.length ? e.json<WorkloadBinding>() : null;
  }

  async put(key: string, b: WorkloadBinding): Promise<void> {
    await this.kv.put(key, JSON.stringify(b));
  }
}

/** The same in memory, for tests. */
export class MemoryIdentitySources implements IdentitySourceList {
  readonly map = new Map<string, IdentitySourceRecord>();
  async get(a: string) { return this.map.get(a) ?? null; }
  async put(r: IdentitySourceRecord) { this.map.set(r.agent, r); }
  async remove(a: string) { this.map.delete(a); }
  async all() { return new Map(this.map); }
}

export class MemoryWorkloadBindings implements WorkloadBindingList {
  readonly map = new Map<string, WorkloadBinding>();
  async get(k: string) { return this.map.get(k) ?? null; }
  async put(k: string, b: WorkloadBinding) { this.map.set(k, b); }
}
