/**
 * Starting the core services: the registry, the task manager, activity (the
 * audit and usage log), rooms, artifacts and admission. This is the core's
 * startup path for the Agent Messaging Server (docs/agent-messaging-server-plan.md).
 *
 * Nothing here installs the Unified Error Log reporter or registers a
 * platform job, and nothing here imports platform code
 * (tools/ci/check-core-imports.mjs holds it to that). The server's entry,
 * server-main.ts, calls startCore; AgentMesh's core processes run that entry
 * too (step 10a), and the platform's entry (main.ts) starts no core service.
 */
import type { MessagingLike, StorageLike } from "./storage/index.js";
import { RegistryService } from "./registry/registry-service.js";
import { TaskManagerService } from "./task-manager/task-manager-service.js";
import { ActivityService } from "./activity/activity-service.js";
import { RoomsService } from "./rooms/rooms-service.js";
import { ArtifactsService } from "./artifacts/artifacts-service.js";
import { AdmissionService } from "./admission/admission-service.js";
import { MeshApi } from "./keychain/mesh-api.js";
import { installTenantLimits } from "./keychain/tenant-limits.js";
import { registerWitnessWatchJob } from "./activity/witness-watch.js";
import { registerCredRenewalWatchJob } from "./keychain/cred-renewal-watch-job.js";
import { Scheduler } from "./shared/scheduler.js";

/** The core services, in the order they start. */
export const CORE_SERVICES = ["registry", "task-manager", "activity", "rooms", "artifacts", "admission", "mesh-api"] as const;
export type CoreServiceName = (typeof CORE_SERVICES)[number];

export interface Stoppable {
  stop(): Promise<void>;
}

/** Create and start one core service. */
/** What a core service may need from the others in its process. */
export interface CoreContext {
  /** The registry, when it runs in this process: the mesh API deregisters
   *  through it when a revoke asks. */
  registry?: RegistryService | null;
}

export async function startCoreService(name: "registry", nc: MessagingLike, js: StorageLike, ctx?: CoreContext): Promise<RegistryService>;
export async function startCoreService(name: CoreServiceName, nc: MessagingLike, js: StorageLike, ctx?: CoreContext): Promise<Stoppable>;
export async function startCoreService(name: CoreServiceName, nc: MessagingLike, js: StorageLike, ctx: CoreContext = {}): Promise<Stoppable> {
  // Each tenant's own limits, read once per process (keychain/tenant-limits.ts):
  // the rate cap in every service handler and the rooms service's caps.
  await installTenantLimits(js);
  switch (name) {
    case "registry": {
      const registry = await RegistryService.create(nc, js);
      await registry.start();
      return registry;
    }
    case "task-manager": {
      const taskManager = await TaskManagerService.create(nc, js);
      await taskManager.start();
      return taskManager;
    }
    // Request/response tap, the audit chains and the usage counters.
    case "activity": {
      const activity = await ActivityService.create(nc, js);
      await activity.start();
      return activity;
    }
    // Durable record + drive provisioning, quota-capped.
    case "rooms": {
      const rooms = await RoomsService.create(nc, js);
      await rooms.start();
      return rooms;
    }
    // Artifact store (SPEC 7.5): mesh-wide byte storage for deliverables that
    // do not belong to a room. Quota-capped per owner and reclaimed on expiry —
    // ephemerality is the default, durability is declared (7.5.2).
    case "artifacts": {
      const artifacts = await ArtifactsService.create(nc, js);
      await artifacts.start();
      return artifacts;
    }
    case "admission": {
      const admission = await AdmissionService.create(nc, js);
      await admission.start();
      return admission;
    }
    // The credential doors over HTTP (keychain/mesh-api.ts): enrollment,
    // renewal, revocation and the key check.
    case "mesh-api": {
      const registry = ctx.registry ?? null;
      const api = await MeshApi.create(js, { deregister: registry ? (k) => registry.deregisterOwned(k) : null });
      await api.start();
      // The audit backstop's watch (activity/witness-watch.ts), beside the
      // mesh API rather than inside the activity service it watches. Its
      // alert goes out as a `mesh.ops.alert` request (shared/ops-events.ts).
      // The credential renewal watch (keychain/cred-renewal-watch-job.ts)
      // reads the key chain's mint log, so it runs here too.
      const scheduler = new Scheduler(js);
      registerWitnessWatchJob(scheduler, { nc, js });
      registerCredRenewalWatchJob(scheduler, { nc, js });
      await scheduler.start();
      return {
        async stop() {
          await scheduler.stop();
          await api.stop();
        },
      };
    }
  }
}

/** Start every core service `wants` names, in order. */
export async function startCore(
  nc: MessagingLike,
  js: StorageLike,
  wants: (name: CoreServiceName) => boolean = () => true,
): Promise<{ services: Stoppable[]; registry: RegistryService | null }> {
  const services: Stoppable[] = [];
  let registry: RegistryService | null = null;
  for (const name of CORE_SERVICES) {
    if (!wants(name)) continue;
    if (name === "registry") {
      registry = await startCoreService("registry", nc, js);
      services.push(registry);
    } else {
      services.push(await startCoreService(name, nc, js, { registry }));
    }
  }
  return { services, registry };
}
