import type { BusSubscription, Messaging } from "../storage/index.js";
import type { Availability } from "../sdk.js";
import { decode, createEnvelope, Subjects } from "../sdk.js";
import { idOf, sealEnvelope, type ServiceIdentity } from "../shared/handler.js";
import type { PresenceStore } from "./presence-store.js";

const SWEEP_INTERVAL_MS = 30_000;

/** Ed25519 user nkey, public half — the shape every node id has. */
const NKEY_PUBLIC = /^U[A-Z2-7]{55}$/;

/** The closed set of §9.6 liveness values. The `Availability` union is a
 *  compile-time type and erases at runtime, so an arbitrary string in the
 *  payload otherwise flows straight through presence into discovery results and
 *  the operator console — where it becomes whatever the console renders it as. */
const AVAILABILITY: ReadonlySet<string> = new Set(["online", "busy", "degraded", "offline"]);

interface HeartbeatPayload {
  availability?: Availability;
}

/**
 * Consumes node heartbeats (§9.6, §10.9) and maintains the presence store.
 * 0.2: this NEVER touches manifests — presence is a separate, ephemeral store.
 * A node that stops heartbeating goes `offline` in presence; its registration
 * is untouched.
 *
 * Identity comes from the SIGNATURE, never the payload. A heartbeat is only
 * accepted for a node the sender can prove it speaks for:
 *   - the node itself (`env.from` is the node key — MeshNode's node heartbeat,
 *     and a self-hosting agent, where the agent key IS the node key), or
 *   - an agent that node vouched for at register (§4.4), which is why the
 *     monitor is given a vouch lookup.
 * Anything else is dropped. Without this, publishing `{node:"<victim>",
 * availability:"offline"}` to `mesh.heartbeat.<victim>` stamped every agent on
 * that node offline and out of online discovery, with no credential and no
 * signature — the payload's `node` field was believed over the verified sender.
 */
export class HeartbeatMonitor {
  private sub: BusSubscription | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Dropped heartbeats since the last report. Summarised on a timer rather than
   *  logged per message: the drop path is exactly what a flood hits, and a log
   *  line per forged heartbeat would be the amplifier. */
  private dropped = 0;
  private lastDropReport = 0;

  constructor(
    private nc: Messaging,
    private serviceId: ServiceIdentity,
    private presence: PresenceStore,
    /** The node that vouched for an agent at register time (§4.4), or undefined
     *  for an agent this registry has never seen. */
    private vouchedNode: (agentId: string) => string | undefined = () => undefined,
    /** Called when the join FLIPS — online on first beat after silence,
     *  offline on a stale sweep. The presence feed's whole input
     *  (registry/presence-feed.ts): transitions, never heartbeats. */
    private onFlip?: (node: string, presence: "online" | "offline") => void,
  ) {}

  start(): void {
    // NO queue group, deliberately (shared/queue-groups.ts lists this subject
    // as a broadcast). `this.presence` is in-memory and per-instance, and
    // `mesh.registry.discover` / `mesh.registry.nodes.list` answer from it. Load
    // balancing the heartbeats would give each registry instance a fraction of
    // them, and `sweep()` on each side would then mark every node it did not
    // happen to hear from offline within STALE_THRESHOLD_MS — so an agent would
    // be online or offline in discovery depending on which instance answered.
    this.sub = this.nc.subscribe("mesh.heartbeat.>");
    const sub = this.sub;
    (async () => {
      for await (const msg of sub) {
        try {
          this.handleHeartbeat(msg);
        } catch (err) {
          console.error("[presence] handler error:", err);
        }
      }
    })();

    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    console.log("[presence] monitor started");
  }

  stop(): void {
    this.sub?.unsubscribe();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private handleHeartbeat(msg: { subject: string; data: Uint8Array }): void {
    // Subject: mesh.heartbeat.{node_id}[.{agent_id}]
    const nodeFromSubject = msg.subject.split(".")[2];

    // decode() verifies the signature against `from`. A heartbeat that fails it
    // is dropped, not downgraded to a bare ping: an unsigned message proves
    // nothing about the node it names, and treating it as liveness is what made
    // presence forgeable without any credential at all.
    let env;
    try {
      env = decode(msg.data);
    } catch {
      return this.drop();
    }
    const hb = env.payload as HeartbeatPayload;

    // Which node this heartbeat speaks for. `env.from` is verified; the payload's
    // `node` is not, and is ignored (§10.9 puts the node id in the subject).
    let node: string | undefined;
    if (env.from === nodeFromSubject) {
      node = env.from; // the node itself (or a self-hosting agent: same key)
    } else if (nodeFromSubject && this.vouchedNode(env.from) === nodeFromSubject) {
      node = nodeFromSubject; // an agent this node vouched for at register (§4.4)
    } else {
      return this.drop(); // the sender cannot show it speaks for that node
    }
    if (!NKEY_PUBLIC.test(node)) return this.drop(); // node ids are nkeys, always

    const status: Availability =
      hb?.availability && AVAILABILITY.has(hb.availability) ? hb.availability : "online";

    const cameOnline = this.presence.update(node, status);
    if (cameOnline) {
      this.emit("node_online", { node });
      this.onFlip?.(node, "online");
      console.log(`[presence] node online: ${node}`);
    }
  }

  /** Count a dropped heartbeat and report the tally at most once a minute — an
   *  operator debugging "why is my node offline" needs to see these, and a
   *  flooder must not get a log line per message out of it. */
  private drop(): void {
    this.dropped++;
    const now = Date.now();
    if (now - this.lastDropReport < 60_000) return;
    this.lastDropReport = now;
    console.warn(
      `[presence] dropped ${this.dropped} heartbeat(s) that were unsigned or spoke for a node ` +
        `the sender is not (and was not vouched by)`,
    );
    this.dropped = 0;
  }

  private sweep(): void {
    for (const node of this.presence.sweep()) {
      this.emit("node_offline", { node, reason: "heartbeat_timeout" });
      this.onFlip?.(node, "offline");
      console.log(`[presence] node offline (stale): ${node}`);
    }
  }

  private emit(event_type: string, data: Record<string, unknown>): void {
    const env = createEnvelope({
      type: "emit",
      from: idOf(this.serviceId),
      payload: { domain: "presence", event_type, data },
    });
    this.nc.publish(Subjects.event(`presence.${event_type}`), sealEnvelope(env, this.serviceId));
  }
}
