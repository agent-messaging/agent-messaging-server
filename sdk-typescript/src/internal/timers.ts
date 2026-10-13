/**
 * Background timers that must never be the reason a process stays alive.
 *
 * On Node a pending `setInterval` keeps the event loop open, so a long-lived
 * housekeeping loop turns "my script finished" into "my script hangs". `unref()`
 * is the fix, and it is what the rest of this codebase does for exactly this
 * (server/src/shared/recorder.ts, mesh-adapter's console sync). Browsers have no `unref` and no such problem, so
 * the call is optional-chained rather than assumed — this SDK runs in both.
 */

/** A platform timer handle: `number` in the DOM, `NodeJS.Timeout` on Node. */
export type TimerHandle = ReturnType<typeof setInterval>;

/** `setInterval` that does not hold the process open. */
export function setUnrefInterval(fn: () => void, ms: number): TimerHandle {
  const t = setInterval(fn, ms);
  (t as unknown as { unref?: () => void }).unref?.();
  return t;
}
