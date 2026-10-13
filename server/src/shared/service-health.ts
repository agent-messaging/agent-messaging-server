/**
 * Per-service liveness, so something other than one process can answer "is the
 * platform up".
 *
 * ## Why `/healthz` was not enough
 *
 * `/healthz` answers from whichever process owns port 3001. It proves that
 * process is alive and its NATS connection is open, and it says nothing about the
 * others. On 2026-07-30 that meant `agentmesh-bridge-a2a` was dead for weeks
 * behind a green check, and `agentmesh-aux` — which runs rooms — could have been
 * too without anything noticing.
 *
 * ## How this works
 *
 * Every process that runs services writes a heartbeat to KV naming the services
 * it is running. A reader (the public health route, the daily digest) reads all
 * heartbeats and treats one that has stopped being refreshed as down. Nothing
 * needs to reach the other processes, which matters because the whole problem is
 * that a dead process cannot be asked how it is.
 *
 * The bucket carries a TTL, so a process that dies stops appearing on its own
 * rather than leaving a stale record that has to be reaped. That also makes
 * "absent" and "dead" the same observable state, which is the honest reading: a
 * service nobody is heartbeating for is not running, whatever the reason.
 */

import { SERVICE_HEARTBEAT_MS, storageOf, type KeyedStore, type StorageLike } from "../storage/index.js";
import { publishHeartbeat } from "./ops-events.js";


const BUCKET = "mesh_service_health";

/** How often each process refreshes its heartbeat. */
export const HEARTBEAT_MS = SERVICE_HEARTBEAT_MS;

/**
 * How long a heartbeat survives without a refresh.
 *
 * Three intervals, not one: a single missed beat is a slow flush or a GC pause,
 * and reporting a healthy service as down is how a status page loses its
 * credibility. Three consecutive misses is a real signal.
 */
export const HEARTBEAT_TTL_MS = HEARTBEAT_MS * 3;

export interface Heartbeat {
  /** Services this process runs (`--service=` names). */
  services: string[];
  /** When this PROCESS started, so uptime is reportable without a second store. */
  startedAt: string;
  /** Refreshed every beat. */
  at: string;
  /** Whether its NATS connection was open at the last beat. A process can be
   *  alive and useless, and that distinction belongs in the health record. */
  natsOk: boolean;
}

/** Opaque handle so a caller can stop the beat on shutdown. */
export interface HeartbeatHandle {
  stop: () => void;
}

/**
 * Begin heartbeating for this process.
 *
 * `key` identifies the PROCESS, not the service: three processes may each run
 * different services, and two could run the same one during a rolling restart.
 * Keying by process means neither overwrites the other, and a reader unions the
 * service lists.
 *
 * Failures are swallowed. A health heartbeat that can crash the service it
 * describes would be worse than having none.
 */
export async function startHeartbeat(
  js: StorageLike,
  key: string,
  services: string[],
  isNatsOk: () => boolean,
): Promise<HeartbeatHandle> {
  // `key` identifies the process and is kept for the log line only. Records are
  // written PER SERVICE — see the note on `beat` below.
  void key;
  let kv: KeyedStore;
  try {
    kv = await storageOf(js).keyed(BUCKET);
  } catch (err) {
    console.warn(`[health] no heartbeat bucket, liveness will be unreported: ${(err as Error).message}`);
    return { stop: () => {} };
  }

  const startedAt = new Date().toISOString();
  /**
   * One record PER SERVICE, at a key derived from the service name.
   *
   * The first version of this wrote one record per PROCESS and had the reader
   * enumerate the bucket with `kv.keys()`. That was wrong, and wrong in a way that
   * looked right: `kv.keys()` under-returns on this deployment (it is a documented
   * KV gotcha here), so the reader saw only some processes and `/health` reported
   * five live services as DOWN on the first deploy. The comment above it even
   * claimed it avoided enumeration, which it did not.
   *
   * Keying by service removes the enumeration entirely: the expected set is
   * declared, so the reader does one direct `get` per service and there is nothing
   * to miss. The trade is that two processes running the same service overwrite
   * each other's record rather than both being visible — which for a health check
   * is the right answer anyway, since "the most recent heartbeat for this service"
   * is what a reader wants to know.
   */
  const beat = async (): Promise<void> => {
    const hb: Heartbeat = {
      services,
      startedAt,
      at: new Date().toISOString(),
      natsOk: isNatsOk(),
    };
    const body = JSON.stringify(hb);
    // The operator hears it too (mesh.ops.heartbeat, shared/ops-events.ts):
    // AgentMesh's platform keeps its own health record from these rather than
    // reading this store.
    publishHeartbeat(hb);
    for (const service of services) {
      try {
        await kv.put(serviceKey(service), body);
      } catch {
        // The next beat retries. A missed beat is not worth a log line every 15
        // seconds; three consecutive misses show up as "down" to every reader,
        // which is the signal that matters.
      }
    }
  };

  await beat();
  const timer = setInterval(() => void beat(), HEARTBEAT_MS);
  timer.unref?.();
  console.log(`[health] heartbeating as ${key} for: ${services.join(", ")}`);
  return {
    stop: () => {
      clearInterval(timer);
      // Deliberately NOT deleting the key on the way out. A clean shutdown and a
      // crash should look the same to a reader — otherwise a graceful stop
      // silently removes a service from the health page and nobody is told it
      // went away. The TTL expires it either way.
    },
  };
}

/** One service's health, as a reader sees it. */
export interface ServiceHealth {
  service: string;
  up: boolean;
  /** Seconds since the process running it started. Null when it is down. */
  uptimeSec: number | null;
  /** Whether the process holding it has an open NATS connection. */
  natsOk: boolean;
}

/**
 * Every service the deployment expects to be running.
 *
 * A health page built only from what IS heartbeating cannot report an absence,
 * which is the failure it most needs to report. So the expected set is declared
 * and anything missing from it is reported as down.
 */
export const EXPECTED_SERVICES = [
  "registry", "task-manager", "catalog", "activity", "rooms", "admission", "api",
] as const;

/**
 * Read each expected service's heartbeat and reduce it to health.
 *
 * `processes` counts records FOUND, which is a count of live services rather than
 * of operating-system processes now that records are keyed by service. It exists
 * for diagnostics only; nothing renders it.
 */
export async function readServiceHealth(
  js: StorageLike,
  expected: readonly string[] = EXPECTED_SERVICES,
  now = Date.now(),
): Promise<{ services: ServiceHealth[]; processes: number }> {
  const beats: Heartbeat[] = [];
  let found = 0;
  try {
    const kv = await storageOf(js).keyed(BUCKET);
    // ONE DIRECT GET PER EXPECTED SERVICE. Deliberately not `kv.keys()`: that call
    // under-returns on this deployment, and a health page that silently misses a
    // record reports a live service as down — which is exactly what happened the
    // first time this shipped. A declared expected set plus direct lookups has
    // nothing to miss.
    for (const service of expected) {
      const e = await kv.get(serviceKey(service)).catch(() => null);
      if (!e) continue;
      try {
        const hb = JSON.parse(e.string()) as Heartbeat;
        // Belt and braces over the bucket TTL: a reader must not trust a record
        // whose own clock says it is stale, whatever the store still holds.
        if (isFresh(hb, now)) {
          // Narrowed to the service this key belongs to, so a process that runs
          // several services cannot make one of them vouch for another.
          beats.push({ ...hb, services: [service] });
          found++;
        }
      } catch { /* a corrupt record is an absent one */ }
    }
  } catch (err) {
    console.warn(`[health] cannot read heartbeats: ${(err as Error).message}`);
  }

  return { services: reduceHealth(beats, expected, now), processes: found };
}

/** The KV key for one service's heartbeat. Sanitized because a KV key has a
 *  restricted character set and a service name is otherwise free-form. */
function serviceKey(service: string): string {
  return `svc_${service.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * Reduce heartbeats to per-service health. Pure, so the rules are testable
 * without a broker.
 *
 * A service is up if ANY live process reports running it, which is what keeps
 * this correct during a rolling restart when two processes briefly claim the
 * same one. Uptime comes from the LONGEST-running holder, because during that
 * overlap the older process is the one that has actually been serving — taking
 * the newest would report a freshly-restarted second later as the service's
 * uptime and hide that it has been up for a week.
 *
 * `natsOk` is ORed for the same reason: one holder with a working connection is
 * enough for the service to be reachable.
 */
export function reduceHealth(
  beats: Heartbeat[],
  expected: readonly string[] = EXPECTED_SERVICES,
  now = Date.now(),
): ServiceHealth[] {
  return expected.map((service) => {
    const holders = beats.filter((hb) => hb.services.includes(service));
    if (!holders.length) return { service, up: false, uptimeSec: null, natsOk: false };
    const best = holders.reduce((a, b) => (Date.parse(a.startedAt) <= Date.parse(b.startedAt) ? a : b));
    return {
      service,
      up: true,
      uptimeSec: Math.max(0, Math.round((now - Date.parse(best.startedAt)) / 1000)),
      natsOk: holders.some((h) => h.natsOk),
    };
  });
}

/** Whether a heartbeat is recent enough to trust. Exported because the reader
 *  and any future consumer must agree on staleness, not each guess. */
export function isFresh(hb: Heartbeat, now = Date.now()): boolean {
  return now - Date.parse(hb.at) <= HEARTBEAT_TTL_MS;
}
