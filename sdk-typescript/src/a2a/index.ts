/**
 * `mesh.a2a`: A2A over Agent Messaging (bindings/a2a.md). The client calls of
 * every A2A operation, and `serve` for the server agent's handler.
 */
import { A2AClient, type A2AClientHost } from "./client.js";
import { A2AServerAgent, type A2AHandler, type A2AServeOptions, type TaskHandle } from "./server.js";

export class A2ANamespace extends A2AClient {
  constructor(
    host: A2AClientHost,
    private readonly server: A2AServerAgent,
    private readonly onServe: () => void,
  ) {
    super(host);
  }

  /**
   * Serve A2A: `handler` receives each A2A Message a client sends and returns
   * a Message or a Task (or the Task's handle), emitting status and artifact
   * updates through the handle while it runs.
   *
   * ```ts
   * mesh.a2a.serve(async (message, ctx) => {
   *   const task = ctx.startTask({ state: "TASK_STATE_WORKING" });
   *   task.artifact({ artifactId: "quote", parts: [{ data: { price: 40 } }] });
   *   task.complete("Here is the quote.");
   *   return task;
   * });
   * ```
   */
  serve(handler: A2AHandler, opts?: A2AServeOptions): void {
    this.server.serve(handler, opts);
    this.onServe();
  }

  /** The handle of a Task this agent runs, for work that goes on after its
   *  handler returned. */
  task(taskId: string): TaskHandle | undefined {
    return this.server.handleFor(taskId);
  }

  /**
   * The handle of a Task this agent answers, also after a restart: the one
   * held in memory, else rebuilt from `A2AServeOptions.taskState` (with its
   * open streams) and the mesh's task store, whichever is further along.
   * Undefined when neither knows the Task, or it is not this agent's.
   *
   * ```ts
   * const task = await mesh.a2a.taskHandle(savedId);
   * task?.complete("Done after the restart.");
   * ```
   */
  taskHandle(taskId: string): Promise<TaskHandle | undefined> {
    return this.server.resumeTask(taskId);
  }
}

export * from "./types.js";
export * from "./binding.js";
export * from "./errors.js";
export * from "./extensions.js";
export * from "./readings.js";
export * from "./card.js";
export {
  A2AClient,
  type A2AClientHost,
  type A2ACallOptions,
  type A2ACallResult,
  type A2AStreamOptions,
  type A2AEventStream,
} from "./client.js";
export {
  A2AServerAgent,
  A2A_STORE_SUBJECTS,
  LIST_PAGE_DEFAULT,
  LIST_PAGE_MAX,
  listFrom,
  legacyInputOf,
  messageOfLegacyInput,
  outputOfParts,
  partsOfOutput,
  type A2AServerHost,
  type A2AHandler,
  type A2AHandlerResult,
  type A2AContext,
  type A2AAdmission,
  type A2AServeOptions,
  type A2ATaskState,
  type A2ATaskStateStore,
  type TaskHandle,
} from "./server.js";
