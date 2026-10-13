/**
 * Leave when the process that started this one is gone.
 *
 * pm2 runs the services under `npx tsx`, so the process pm2 stops is a
 * wrapper and the service is its child. When the wrapper was killed and the
 * child did not stop in time, the child was left re-parented to init, still
 * holding its port and answering nothing, and every restart after it
 * crash-looped on EADDRINUSE (technical debt 19, 2026-09-28: app, personal
 * and api answered 502 for about sixteen minutes).
 *
 * A parent of 0 or 1 at start (a container's init) never changes, so the
 * guard is not armed there.
 */
export function exitWhenOrphaned(opts: {
  ppid?: () => number;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  everyMs?: number;
} = {}): ReturnType<typeof setInterval> | null {
  const ppid = opts.ppid ?? (() => process.ppid);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((line: string) => console.error(line));
  const parentAtStart = ppid();
  if (parentAtStart <= 1) return null;
  const timer = setInterval(() => {
    const now = ppid();
    if (now === parentAtStart) return;
    log(`[main] the process that started this one (${parentAtStart}) is gone; exiting so a new start can take the port`);
    clearInterval(timer);
    exit(1);
  }, opts.everyMs ?? 2_000);
  timer.unref?.();
  return timer;
}
