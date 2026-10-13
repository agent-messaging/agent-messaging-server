/**
 * The registry's copy of where each agent's identity came from (SPEC §9.7
 * `identity_source`, step 12 of the bring-your-own-identity plan).
 *
 * The key chain writes `mesh_identity_sources` when an agent enrolls
 * (keychain/identity-records.ts); the registry joins it into every discovery
 * result and filters on it, the same way it joins node profiles. It is never
 * read from a registration: a manifest that carries `identity_source` has it
 * replaced by this record, or removed when there is none, so a node cannot
 * claim a source the mesh did not attest.
 *
 * Kept in memory and followed with a watch, so discovery never reads the
 * store per query. A watch that ends is reopened from the revision it had
 * reached.
 */
import type { IdentitySource } from "../sdk.js";
import type { KeyedEntry, KeyedStore, KeyedWatch } from "../storage/index.js";

const REOPEN_MS = 5000;

export class IdentitySourceView {
  private map = new Map<string, IdentitySource>();
  private attestations = new Map<string, Record<string, unknown>>();
  private iter: KeyedWatch | null = null;
  private lastRevision = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private kv: KeyedStore | null) {}

  /** The identity source of one agent, or undefined when the mesh holds none. */
  get(agent: string): IdentitySource | undefined {
    return this.map.get(agent);
  }

  get size(): number {
    return this.map.size;
  }

  /** The signed portable attestation that carries it (§9.7), when there is one. */
  attestation(agent: string): Record<string, unknown> | undefined {
    return this.attestations.get(agent);
  }

  /** Set one directly (tests, and the doors in the same process). */
  set(agent: string, source: IdentitySource, attestation?: Record<string, unknown>): void {
    this.map.set(agent, source);
    if (attestation) this.attestations.set(agent, attestation); else this.attestations.delete(agent);
  }

  async start(): Promise<void> {
    if (!this.kv) return;
    await this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.iter?.stop();
    this.iter = null;
  }

  private apply(e: KeyedEntry): void {
    if (e.revision > this.lastRevision) this.lastRevision = e.revision;
    if (e.operation !== "PUT" || !e.value.length) { this.map.delete(e.key); this.attestations.delete(e.key); return; }
    const rec = e.json<{ identity_source?: IdentitySource; attestation?: Record<string, unknown> }>();
    if (rec?.identity_source && typeof rec.identity_source.kind === "string") this.set(e.key, rec.identity_source, rec.attestation);
    else { this.map.delete(e.key); this.attestations.delete(e.key); }
  }

  private async open(): Promise<void> {
    if (this.stopped || !this.kv) return;
    try {
      const iter = await this.kv.watch(this.lastRevision > 0 ? { fromRevision: this.lastRevision + 1 } : {});
      if (this.stopped) { iter.stop(); return; }
      this.iter = iter;
      void this.drain(iter);
    } catch (err) {
      console.error(`[registry] could not watch mesh_identity_sources, so discovery may miss identity sources until it can: ${(err as Error).message}`);
      this.reopen();
    }
  }

  private async drain(iter: KeyedWatch): Promise<void> {
    try {
      for await (const e of iter) {
        try { this.apply(e); } catch (err) { console.error(`[registry] an identity source could not be read (${e.key.slice(0, 12)}…): ${(err as Error).message}`); }
      }
    } catch (err) {
      if (!this.stopped) console.error(`[registry] the identity source watch failed: ${(err as Error).message}`);
    }
    if (!this.stopped) this.reopen();
  }

  private reopen(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.open(); }, REOPEN_MS);
    this.timer.unref?.();
  }
}

/** Whether an identity source meets a discovery filter (§9.3): every member
 *  given matches, `kind` being one kind or a list of them. An agent with no
 *  record counts as `kind: "mesh"`, with no issuer and no trust domain. */
export function identitySourceMatches(
  source: IdentitySource | undefined,
  want: { kind?: unknown; issuer?: unknown; trust_domain?: unknown } | undefined,
): boolean {
  if (!want || typeof want !== "object") return true;
  const kinds = typeof want.kind === "string" ? [want.kind] : Array.isArray(want.kind) ? want.kind.filter((k): k is string => typeof k === "string") : null;
  const kind = source?.kind ?? "mesh";
  if (kinds && !kinds.includes(kind)) return false;
  if (typeof want.issuer === "string" && source?.issuer !== want.issuer) return false;
  if (typeof want.trust_domain === "string" && source?.trust_domain !== want.trust_domain) return false;
  return true;
}

/** A manifest with the mesh's own identity source in place of anything the registration said. */
export function withIdentitySource<M extends { id: string; identity_source?: unknown }>(m: M, view: IdentitySourceView | null): M {
  const { identity_source: _drop, identity_source_attestation: _dropAtt, ...rest } = m as M & { identity_source_attestation?: unknown };
  const source = view?.get(m.id);
  if (!source) return rest as M;
  const att = view?.attestation(m.id);
  return { ...rest, identity_source: source, ...(att ? { identity_source_attestation: att } : {}) } as M;
}
