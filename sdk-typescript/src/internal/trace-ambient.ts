import type { TraceContext } from "../types/envelope.js";

/**
 * Ambient trace context (§13.1): while an offering handler runs, the inbound
 * envelope's trace is held here, and any envelope built without an explicit
 * trace becomes a child of it — so delegation (an agent calling other agents
 * from inside a handler) stays in one trace with no application code.
 *
 * Backed by AsyncLocalStorage where the platform has it (Node, Bun, Deno). In
 * browsers there is no ambient store: `currentTrace()` returns undefined and
 * callers fall back to explicit propagation via `ctx.traceContext` and
 * `RequestConfig.trace`.
 */
interface AlsLike {
  getStore(): TraceContext | undefined;
  run<T>(store: TraceContext, fn: () => T): T;
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
    /* no ambient store on this platform; explicit propagation still works */
  });

/** Run `fn` with `trace` as the ambient trace context (where supported). */
export function runWithTrace<T>(trace: TraceContext, fn: () => T): T {
  return als ? als.run(trace, fn) : fn();
}

/** The ambient trace context, if any. */
export function currentTrace(): TraceContext | undefined {
  return als?.getStore();
}
