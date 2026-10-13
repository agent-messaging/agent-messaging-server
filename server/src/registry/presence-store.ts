import type { Availability } from "../sdk.js";

/**
 * Node liveness store (AgentMesh 0.2 §9.6) — SEPARATE from the manifest
 * registry. Presence is ephemeral (heartbeats, TTL) and keyed by **node**;
 * it never mutates or deletes a manifest. Discovery joins manifests against
 * this store at query time.
 */
export interface NodePresence {
  node: string;
  status: Availability;
  last_seen: number;
}

/** Milliseconds without a heartbeat before a node is considered offline (2×30s). */
export const STALE_THRESHOLD_MS = 60_000;

/** Ceiling on tracked nodes. The store never deletes on its own — presence is
 *  keyed by whatever node key heartbeats, and node keys are free to mint — so an
 *  uncapped map is a memory-exhaustion primitive that also floods
 *  `registry.nodes.list`. Past the cap the stalest entries are evicted rather
 *  than new ones refused: refusing would let a flood of fresh keys lock the real
 *  nodes out of presence, which is the outage the cap exists to prevent. */
const MAX_NODES = Number(process.env.PRESENCE_MAX_NODES ?? 10_000);

export class PresenceStore {
  private nodes = new Map<string, NodePresence>();

  /** Record a heartbeat for a node. Returns true if it transitioned online. */
  update(node: string, status: Availability = "online"): boolean {
    const prev = this.nodes.get(node);
    const wasOffline = !prev || prev.status === "offline" || this.isStale(prev);
    if (!prev) this.makeRoom();
    this.nodes.set(node, { node, status, last_seen: Date.now() });
    return wasOffline && status !== "offline";
  }

  /** Make room for one new node: drop the entries with the oldest `last_seen`,
   *  which are the ones already reported `offline` everywhere. */
  private makeRoom(): void {
    if (this.nodes.size < MAX_NODES) return;
    const byAge = Array.from(this.nodes.values()).sort((a, b) => a.last_seen - b.last_seen);
    // Trim a batch, not a single entry: sorting per insertion at the ceiling
    // would make the flood expensive for us rather than for the flooder.
    const evict = Math.max(1, Math.ceil(MAX_NODES * 0.1));
    for (const p of byAge.slice(0, evict)) this.nodes.delete(p.node);
    console.warn(`[presence] node ceiling ${MAX_NODES} reached; evicted ${evict} stalest entr(ies)`);
  }

  /** Current status for a node — `offline` if unknown or stale. */
  status(node: string): Availability {
    const p = this.nodes.get(node);
    if (!p || this.isStale(p)) return "offline";
    return p.status;
  }

  get(node: string): NodePresence | undefined {
    return this.nodes.get(node);
  }

  /** All known node presence, with current (staleness-adjusted) status. */
  list(): NodePresence[] {
    return Array.from(this.nodes.values()).map((p) => ({
      ...p,
      status: this.isStale(p) ? "offline" : p.status,
    }));
  }

  /** Mark stale nodes offline; returns the nodes that just went offline. */
  sweep(): string[] {
    const gone: string[] = [];
    for (const p of this.nodes.values()) {
      if (p.status !== "offline" && this.isStale(p)) {
        p.status = "offline";
        gone.push(p.node);
      }
    }
    return gone;
  }

  private isStale(p: NodePresence): boolean {
    return Date.now() - p.last_seen > STALE_THRESHOLD_MS;
  }
}
