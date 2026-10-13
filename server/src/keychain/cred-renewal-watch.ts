/**
 * Credential renewal health: notice when an issued lease is running out with no
 * renewal seen, and tell the operator ONCE.
 *
 * ## Why this exists
 *
 * Node credentials expire (SPEC §4.8) and clients renew them at two thirds of
 * their own lifetime, retrying roughly hourly through the last third. The whole
 * design rests on that scheduled renewal actually firing — and until it fires
 * for the first time, "renewal works" is a claim proven only by hand-run
 * `mesh-adapter credential renew`. If the scheduled path is broken, the first
 * anyone hears of it is an agent failing to reconnect one lifetime (seven
 * days by default) after its mint, with nothing in the logs to explain why. This watcher closes that gap
 * from the platform side: it knows what was minted and when, so it can say
 * "this lease should have been renewed by now and was not" while there is
 * still time to act.
 *
 * ## What it deliberately does NOT do
 *
 * It does not alert at the renewal point itself. The client renews at 2/3 and
 * then RETRIES hourly — a renewal that is an hour late is the retry loop
 * working, not an incident. The alert line is drawn at 80% of the lifetime:
 * for a seven-day credential (the default since 2026-09-27) that is about
 * twenty-two hours past the renewal point and some twenty hourly retries in,
 * which is a broken path, not a slow one, with about a day and a third left to
 * fix it before the agent dies. For a thirty-day credential still in the
 * field it is four days past the renewal point, with six days left.
 *
 * It does not treat a routine renewal as news. Renewals are counted (they show
 * in the daily digest) but only two renewals ever email anyone: the FIRST one
 * this watcher observes — the proof the path works at all — and one that
 * closes an open overdue alert.
 *
 * Like process-watch, the decision logic here is pure: the previous
 * observation comes in, the next one goes out, and alerts are TRANSITIONS
 * only, so a permanently un-renewed credential produces exactly one email.
 */

/** Fraction of a credential's lifetime past which a missing renewal is an
 *  incident. Clients renew at 2/3 (~0.67) and retry hourly; see the module
 *  note for why 0.8 and not 0.67. */
export const OVERDUE_FRACTION = 0.8;

/** One minted credential, as the mint log records it (cred-mint-log.ts). */
export interface TrackedCred {
  /** The connection key the JWT is bound to — the stable thing across
   *  renewals, because a renewal is a re-mint on the SAME key. */
  key: string;
  /** The agent keys the credential covers. At least one. */
  agents: string[];
  /** Human name when the mint path knew one (bootstrap's label). */
  label?: string;
  /** ISO-8601 instant of the newest mint on this key. */
  issuedAt: string;
  /** ISO-8601, or null for a credential minted without an expiry — which is
   *  never due and therefore never overdue. */
  expiresAt: string | null;
  /** Re-mints observed through the renewal door for this key. A record
   *  CREATED by a renewal (a key first seen at its own re-mint) starts at 1. */
  renewals: number;
  /** The account the covered agents belong to, when the door knew it
   *  (docs/kill-switch-plan.md item 1): a person's stop finds its
   *  connections without resolving every agent again. */
  account?: string;
  /** The organization holding the covered agents, when the door knew it. */
  org?: string;
  /** The second this connection key was last cut by the kill switch, so a
   *  mint in another process waits until it is issued after the cut
   *  (kill-switch-cut.ts mintAfterCut). Gone at the next mint. */
  cutAt?: number;
}

export type CredVerdict = "ok" | "overdue" | "expired";

/** What was true at the previous observation, persisted so a delta exists. */
export interface CredSeen {
  verdict: CredVerdict;
  /** The mint the verdict was formed against; a different issuedAt on the
   *  next pass means the credential was renewed in between. */
  issuedAt: string;
  /** When the operator was first told about a NON-ok verdict. */
  alertedAt?: string;
}

export interface CredFinding {
  key: string;
  /** Operator-facing name: the label when one is known, else the first agent
   *  key, shortened. */
  name: string;
  agents: string[];
  verdict: CredVerdict;
  expiresAt: string | null;
  /** Days until expiry, one decimal; negative once expired; null when the
   *  credential has no expiry. */
  daysRemaining: number | null;
  /** Human sentence, used in the email and the log. */
  detail: string;
}

/** How far through its life a credential is at `nowMs`, 0..∞, or null when
 *  there is no usable window (no expiry, unparseable dates, empty window). */
export function lifetimeFraction(issuedAt: string, expiresAt: string | null, nowMs: number): number | null {
  if (!expiresAt) return null;
  const iss = Date.parse(issuedAt);
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(iss) || !Number.isFinite(exp) || exp <= iss) return null;
  return (nowMs - iss) / (exp - iss);
}

/** The earliest renewal on record, or null if none has ever been observed.
 *  This is what the one-time "the renewal path works" email keys on. */
export function firstRenewalOf(records: TrackedCred[]): TrackedCred | null {
  const renewed = records.filter((r) => r.renewals > 0);
  if (!renewed.length) return null;
  renewed.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
  return renewed[0];
}

function nameOf(c: TrackedCred): string {
  return c.label?.trim() || `agent ${c.agents[0]?.slice(0, 12) ?? "?"}…`;
}

function days(ms: number): number {
  return Math.round((ms / 86_400_000) * 10) / 10;
}

/**
 * Compare this observation of the mint log with the previous one.
 *
 * Pure, so the debounce is testable without KV, a mailer or a clock. Alerts
 * are transitions only, exactly as process-watch does it:
 *
 *   ok → overdue          alert (the renewal should have happened and did not)
 *   overdue → expired     alert (the shape changed: the agent is now one
 *                         restart away from being off the mesh)
 *   overdue/expired → ok  alert (renewed at last — the inbox thread closes)
 *   unchanged             silence, however bad it is
 *
 * A credential SUPERSEDED by a newer mint covering the same agent (the agent
 * re-bootstrapped onto a fresh connection key) is not overdue — nobody is
 * going to renew a lease no one holds. It is dropped from tracking, with a
 * closing alert only if it had already been announced as a problem.
 */
export function assess(
  records: TrackedCred[],
  previous: Record<string, CredSeen>,
  nowMs: number,
  /** The agent keys the registry holds now; absent when it could not be read. */
  registered?: ReadonlySet<string>,
): { findings: CredFinding[]; alerts: CredFinding[]; next: Record<string, CredSeen>; superseded: string[] } {
  const findings: CredFinding[] = [];
  const alerts: CredFinding[] = [];
  const next: Record<string, CredSeen> = {};
  const superseded: string[] = [];

  // A newer mint covering any of the same agents makes the older one moot.
  // Strictly newer: two mints in the same instant supersede nothing.
  const isSuperseded = (c: TrackedCred): boolean =>
    records.some(
      (o) =>
        o.key !== c.key &&
        o.issuedAt > c.issuedAt &&
        o.agents.some((a) => c.agents.includes(a)),
    );

  // Every agent the credential covers is gone from the registry: nothing runs
  // it and nothing will renew it, so its lease is nobody's problem either. The
  // first test deploy (redline) was deregistered and its last credential still
  // warned as overdue (2026-09-24). Only when the caller could read the
  // registry: an unknown registry skips nothing.
  const unregistered = (c: TrackedCred): boolean =>
    !!registered && c.agents.length > 0 && c.agents.every((a) => !registered.has(a));

  for (const c of records) {
    const prev = previous[c.key];
    const was = prev?.verdict ?? "ok";

    if (unregistered(c)) {
      superseded.push(c.key);
      if (was !== "ok") {
        alerts.push({
          key: c.key,
          name: nameOf(c),
          agents: c.agents,
          verdict: "ok",
          expiresAt: c.expiresAt,
          daysRemaining: null,
          detail: `The credential for ${nameOf(c)} belongs to an agent that is no longer registered, so nothing runs it and nothing will renew it; it is no longer tracked.`,
        });
      }
      continue;
    }

    if (isSuperseded(c)) {
      superseded.push(c.key);
      // Not carried into `next` and purged by the caller. If the operator had
      // been told this lease was in trouble, close the thread.
      if (was !== "ok") {
        alerts.push({
          key: c.key,
          name: nameOf(c),
          agents: c.agents,
          verdict: "ok",
          expiresAt: c.expiresAt,
          daysRemaining: null,
          detail: `The credential for ${nameOf(c)} was superseded by a newer one covering the same agent(s); the old lease is nobody's problem and is no longer tracked.`,
        });
      }
      continue;
    }

    const expMs = c.expiresAt ? Date.parse(c.expiresAt) : NaN;
    const fraction = lifetimeFraction(c.issuedAt, c.expiresAt, nowMs);
    const remaining = Number.isFinite(expMs) ? days(expMs - nowMs) : null;

    let verdict: CredVerdict = "ok";
    let detail: string;
    if (c.expiresAt && Number.isFinite(expMs) && nowMs >= expMs) {
      verdict = "expired";
      detail =
        `The credential for ${nameOf(c)} (key ${c.key.slice(0, 12)}…) EXPIRED ${c.expiresAt} ` +
        `(${days(nowMs - expMs)} days ago) and no renewal was ever seen. An open connection keeps working, ` +
        `but the agent cannot reconnect: its next restart takes it off the mesh until the credential is renewed.`;
    } else if (fraction !== null && fraction >= OVERDUE_FRACTION) {
      verdict = "overdue";
      detail =
        `The credential for ${nameOf(c)} (key ${c.key.slice(0, 12)}…) is ${Math.round(fraction * 100)}% through its ` +
        `life with no renewal seen — clients renew at two thirds and retry hourly, so this one's renewal path ` +
        `is not working. It expires ${c.expiresAt} (${remaining} days left).`;
    } else if (prev && prev.issuedAt !== c.issuedAt && was !== "ok") {
      // Renewed since the last pass, and the operator had been told it was in
      // trouble: this ok is the recovery, and its detail says why.
      detail =
        `The credential for ${nameOf(c)} was renewed — the new lease expires ` +
        `${c.expiresAt ?? "never (minted without an expiry)"}.`;
    } else {
      detail = `The credential for ${nameOf(c)} is fine${c.expiresAt ? ` (expires ${c.expiresAt})` : " (no expiry, never due)"}.`;
    }

    const finding: CredFinding = {
      key: c.key,
      name: nameOf(c),
      agents: c.agents,
      verdict,
      expiresAt: c.expiresAt,
      daysRemaining: remaining,
      detail,
    };
    findings.push(finding);
    if (was !== verdict) alerts.push(finding);

    next[c.key] = {
      verdict,
      issuedAt: c.issuedAt,
      // Carry the timestamp forward while the problem persists so the record
      // shows when it STARTED, not when it was last observed.
      alertedAt: verdict === "ok" ? undefined : (was === verdict ? prev?.alertedAt : new Date(nowMs).toISOString()),
    };
  }

  // A previously tracked key whose record is gone entirely (purged out of
  // band). Not an incident — the mint log is bookkeeping, not the mesh — but
  // an open alert thread must not be left dangling forever.
  for (const [key, prev] of Object.entries(previous)) {
    if (records.some((r) => r.key === key)) continue;
    if (prev.verdict !== "ok") {
      const gone: CredFinding = {
        key,
        name: `key ${key.slice(0, 12)}…`,
        agents: [],
        verdict: "ok",
        expiresAt: null,
        daysRemaining: null,
        detail: `The credential on key ${key.slice(0, 12)}… is no longer in the mint log and is no longer tracked.`,
      };
      findings.push(gone);
      alerts.push(gone);
    }
    // Not carried into `next`: once closed, a vanished record stops being news.
  }

  return { findings, alerts, next, superseded };
}
