import { messagingOf, type MessagingLike } from "../storage/index.js";
import type { BusSubscription, Messaging } from "../storage/index.js";
import { keyedOf, storageOf, type KeyedLike, type KeyedStore, type StorageLike } from "../storage/index.js";
import { subscribeWithHandler } from "../shared/handler.js";
import { serviceQueue } from "../shared/queue-groups.js";
import { identityFromEnv } from "../shared/seed.js";
import { handleTaskUpdate, publishCanceledBySettled } from "./handlers/task-update.js";
import { handleTaskGet } from "./handlers/task-get.js";
import { OverdueSweep } from "./overdue-sweep.js";
import { declaredNeedRefs, type DeclaredNeedsFn } from "./cancel.js";
import { OriginLedger, CANCEL_SWEEP_INTERVAL_MS } from "./origin.js";
import { OriginTap } from "./origin-tap.js";

/** TASK_CANCEL_SETTLE_GRACE_MS: the grace period G before a cancel may be
 *  settled as "the requester did not ask" (origin.ts); a positive integer of
 *  milliseconds, else the default. */
function settleGraceFromEnv(): number | undefined {
  const raw = process.env.TASK_CANCEL_SETTLE_GRACE_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  console.warn(`[task-manager] TASK_CANCEL_SETTLE_GRACE_MS=${raw} is not a positive integer; using the default`);
  return undefined;
}

export class TaskManagerService {
  /** Signing identity (§4.5). Stable if TASK_MANAGER_SEED is set; a set-but-
   *  unusable seed refuses to boot rather than falling back (shared/seed.ts). */
  private readonly kp = identityFromEnv("TASK_MANAGER_SEED");
  private readonly SERVICE_ID = this.kp.getPublicKey();
  private subs: BusSubscription[] = [];
  /** §7.7 deadline enforcement: marks non-terminal tasks overdue on this
   *  service's clock and notifies the requester. */
  private overdueSweep: OverdueSweep | null = null;
  /** Settles `canceled_by` attributions still unverified past their
   *  background retries (origin.ts sweepCanceledBy). */
  private cancelSweep: ReturnType<typeof setInterval> | null = null;

  private kv: KeyedStore;
  /** The registry's bucket, once it has opened (see `declaredNeeds`). */
  private registryKv: KeyedStore | null = null;
  /** Task origins (origin.ts): the requests this server observed routing and
   *  which Task id each is bound to. Null when its store is not wired, which
   *  leaves records without `origin`. */
  private origins: OriginLedger | null;

  constructor(
    private nc: Messaging,
    private js: StorageLike,
    kv: KeyedLike,
    origins?: KeyedLike,
  ) {
    this.kv = keyedOf(kv, js);
    this.origins = origins
      ? new OriginLedger(keyedOf(origins, js), this.kv, {
          onCanceledBySettled: (record) => publishCanceledBySettled(this.nc, this.kp, record),
          graceMs: settleGraceFromEnv(),
        })
      : null;
  }

  /**
   * §10.8a: read the responder's own declared `needs` out of the registry so a
   * "the caller did not furnish X" claim can be checked against something the
   * responder published before the work started.
   *
   * Read-only, and opened on first use rather than at boot: the registry
   * bucket may not exist yet in a task-manager-only deployment, and a task
   * manager that refused to boot without it would be trading a working mesh
   * for a reputation nicety. An open that fails is tried again on the next
   * call. Every failure here returns null, which the attribution rule reads as
   * "could not check" and attributes to the provider.
   */
  private declaredNeeds: DeclaredNeedsFn = async (responder, offering) => {
    try {
      const kv = (this.registryKv ??= await storageOf(this.js).keyed("mesh_registry"));
      const entry = await kv.get(responder);
      if (!entry) return null;
      return declaredNeedRefs(entry.json<unknown>(), offering);
    } catch {
      return null;
    }
  };

  static async create(
    nc: MessagingLike,
    js: StorageLike,
  ): Promise<TaskManagerService> {
    // Ten revisions a task, kept seven days (storage/catalog.ts).
    const kv = await storageOf(js).keyed("mesh_tasks");
    // Seven days, the Task horizon (storage/catalog.ts).
    const origins = await storageOf(js).keyed("mesh_task_origins");
    // EXT-8 §3's reported-spend rollup is not this service's: whoever
    // operates the mesh folds it from the §19.2 receipts this service
    // publishes (on AgentMesh, platform-shared/spend-rollup.ts).
    return new TaskManagerService(messagingOf(nc), js, kv, origins);
  }

  async start(): Promise<void> {
    // Subscribe to all task updates: mesh.task.*.update
    //
    // Queue group, even though this one never replies. `handleTaskUpdate` is a
    // read-modify-write on the task record: it loads the task from KV, validates
    // the transition, appends the update envelope to `task.history`, and writes
    // the whole record back. Two instances handling the same update both read
    // the same prior state and both write their own version back, so one of the
    // two history entries is lost — and each instance also publishes its own
    // `mesh.event.task.<state>` event, so every subscriber sees the transition
    // twice. Exactly one instance must apply an update.
    const updateSubject = "mesh.task.*.update";
    const updateSub = this.nc.subscribe(updateSubject, { queue: serviceQueue(updateSubject) });
    this.subs.push(updateSub);

    (async () => {
      for await (const msg of updateSub) {
        try {
          await handleTaskUpdate(
            msg,
            this.kv,
            this.nc,
            this.kp,
            // §10.8 stranded-delegate fan-out: the same snapshot enumeration
            // the overdue sweep uses (never `kv.keys()` — shared/kv.ts).
            async () => (await this.kv.list()).entries,
            // §10.8a: the responder's declared needs, for attributing a
            // failure the responder says was the caller's doing.
            this.declaredNeeds,
            // The task origins the tap below records.
            this.origins ?? undefined,
          );
        } catch (err) {
          console.error("[task-manager] update handler error:", err);
        }
      }
    })();

    // The origin tap (origin.ts, origin-tap.ts): the requests this server
    // routes, and the first answers that tell it which Task id each one became,
    // so a Task record carries the request that created it as the server saw
    // it. The inbox only, where requests are delivered and answers reach their
    // requesters; broadcast like the activity service's tap (queue-groups.ts):
    // every write the ledger makes is create-only, so every instance observing
    // the same envelope writes the same thing once.
    if (this.origins) {
      const subject = "mesh.agent.*.inbox";
      const sub = this.nc.subscribe(subject, { queue: serviceQueue(subject) });
      this.subs.push(sub);
      const tap = new OriginTap(this.origins);
      (async () => {
        for await (const msg of sub) {
          try {
            await tap.push(msg.subject, msg.data);
          } catch (err) {
            console.error("[task-manager] origin tap:", err);
          }
        }
      })();
    }

    // Request-reply for task lookup: mesh.task.get.*
    this.subs.push(
      subscribeWithHandler(
        this.nc,
        "mesh.task.get.*",
        this.kp,
        (env, msg) => handleTaskGet(env, msg, this.kv, this.SERVICE_ID, this.origins ?? undefined),
        undefined,
        undefined,
        serviceQueue("mesh.task.get.*"),
      ),
    );

    // §7.7: the deadline half of the budget is the half the platform CAN
    // enforce without the responder's cooperation, because this service holds
    // Task state and the clock centrally.
    this.overdueSweep = new OverdueSweep(this.nc, this.js, this.kv, this.kp);
    this.overdueSweep.start();

    if (this.origins) {
      const origins = this.origins;
      this.cancelSweep = setInterval(() => {
        origins
          .sweepCanceledBy(async () => (await this.kv.list()).entries)
          .catch((err) => console.error("[task-manager] canceled_by sweep failed:", err));
      }, CANCEL_SWEEP_INTERVAL_MS);
      this.cancelSweep.unref?.();
    }

    console.log("[task-manager] service started (task updates + task lookup + overdue sweep)");
  }

  async stop(): Promise<void> {
    for (const sub of this.subs) {
      sub.unsubscribe();
    }
    this.overdueSweep?.stop();
    if (this.cancelSweep) clearInterval(this.cancelSweep);
    this.cancelSweep = null;
    console.log("[task-manager] service stopped");
  }
}
