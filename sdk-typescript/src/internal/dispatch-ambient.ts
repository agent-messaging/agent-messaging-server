/**
 * Ambient dispatch context (§10.8): while an offering handler runs, the task id
 * and offering it is serving are held here, so a `request` the handler makes can
 * be recorded as a DELEGATION of that task — the basis for cancel
 * propagation (an inbound cancel for the task auto-cancels its still-live
 * sub-requests as `upstream_cancelled`).
 *
 * Same shape and same platform caveat as the ambient trace (trace-ambient.ts):
 * backed by AsyncLocalStorage where the platform has it (Node, Bun, Deno). In
 * browsers there is no ambient store — `currentDispatch()` returns undefined,
 * sub-requests are not auto-tracked, and cancel propagation is the handler's
 * own job there.
 */

/** What a running handler is serving: the inbound task and the offering. */
export interface DispatchContext {
  taskId: string;
  offering: string;
}

interface AlsLike {
  getStore(): DispatchContext | undefined;
  run<T>(store: DispatchContext, fn: () => T): T;
}

let als: AlsLike | null = null;

// Non-literal specifier + ignore hints keep browser bundlers from trying to
// resolve the Node builtin; at runtime the import simply rejects there.
const specifier = "node:async_hooks";
import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)
  .then((m) => {
    als = new m.AsyncLocalStorage() as AlsLike;
  })
  .catch(() => {
    /* no ambient store on this platform; propagation is opt-in manual there */
  });

/** Run `fn` with `ctx` as the ambient dispatch context (where supported). */
export function runWithDispatch<T>(ctx: DispatchContext, fn: () => T): T {
  return als ? als.run(ctx, fn) : fn();
}

/** The ambient dispatch context, if any. */
export function currentDispatch(): DispatchContext | undefined {
  return als?.getStore();
}
