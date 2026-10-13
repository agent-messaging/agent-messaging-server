// Credential-renewal health detection.
//
// The scheduled renewal path has a twenty-day feedback loop: a credential
// minted today is not due to renew for twenty days, so a broken renewal path
// is invisible until the first lease quietly runs out and an agent fails to
// reconnect. These cases pin the two things the watcher exists for — saying
// "this lease should have been renewed by now and was not" while there is
// still time to act, and announcing the FIRST renewal ever observed, which is
// the only real proof the path works.
//
// The same two failure modes process-watch guards against are guarded here:
// alerting per check instead of per change (at an hourly cadence, one stuck
// lease would be 24 emails a day), and a monitor that can crash the thing it
// monitors (every I/O failure must be swallowed).
import { describe, it, expect } from "vitest";
import {
  assess, firstRenewalOf, lifetimeFraction, OVERDUE_FRACTION,
  type CredSeen, type TrackedCred,
} from "../../src/keychain/cred-renewal-watch.js";
import { runCredRenewalWatch, type CredWatchDeps } from "../../src/keychain/cred-renewal-watch-job.js";
import type { KeyedStore, StorageLike } from "../../src/storage/index.js";
import type { OpsAlert } from "../../src/shared/ops-events.js";

// A thirty-day lease: issued Aug 1, expires Aug 31. The client's renewal point
// (2/3) is Aug 21; the watcher's line (80%) is Aug 25.
const ISSUED = "2026-08-01T00:00:00.000Z";
const EXPIRES = "2026-08-31T00:00:00.000Z";
const at = (iso: string) => Date.parse(iso);

const cred = (over: Partial<TrackedCred> = {}): TrackedCred => ({
  key: "UCONNAAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
  agents: ["UAGENTAAAABBBBCCCCDDDDEEEEFFFFGGGG"],
  issuedAt: ISSUED,
  expiresAt: EXPIRES,
  renewals: 0,
  ...over,
});

describe("the overdue line sits at 80% of the lifetime, not at the renewal point", () => {
  it("computes the fraction from the credential's own window", () => {
    expect(lifetimeFraction(ISSUED, EXPIRES, at("2026-08-16T00:00:00Z"))).toBeCloseTo(0.5);
    expect(lifetimeFraction(ISSUED, EXPIRES, at("2026-08-25T00:00:00Z"))).toBeCloseTo(OVERDUE_FRACTION);
    // No expiry, or a nonsense window, is "no usable window", never a number.
    expect(lifetimeFraction(ISSUED, null, at("2026-08-25T00:00:00Z"))).toBeNull();
    expect(lifetimeFraction(EXPIRES, ISSUED, at("2026-08-25T00:00:00Z"))).toBeNull();
  });

  it("stays quiet at the client's own renewal point — the retry loop is not an incident", () => {
    // Day 22 of 30 (~73%): past 2/3, before 80%. The client is retrying
    // hourly; alerting here would fire on every healthy-but-unlucky renewal.
    const { findings, alerts } = assess([cred()], {}, at("2026-08-23T00:00:00Z"));
    expect(findings[0].verdict).toBe("ok");
    expect(alerts).toEqual([]);
  });

  it("calls a lease overdue at 80% with no renewal seen, naming the expiry and days left", () => {
    const { findings, alerts } = assess([cred()], {}, at("2026-08-25T00:00:00Z"));
    expect(findings[0].verdict).toBe("overdue");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detail).toContain(EXPIRES);
    expect(alerts[0].daysRemaining).toBe(6);
    expect(alerts[0].detail).toMatch(/no renewal seen/);
  });

  it("a credential minted without an expiry is never due", () => {
    const { findings, alerts } = assess(
      [cred({ expiresAt: null })],
      {},
      at("2027-01-01T00:00:00Z"), // however far in the future
    );
    expect(findings[0].verdict).toBe("ok");
    expect(alerts).toEqual([]);
  });

  it("an expired lease is its own, worse verdict", () => {
    const { findings } = assess([cred()], {}, at("2026-09-02T00:00:00Z"));
    expect(findings[0].verdict).toBe("expired");
    expect(findings[0].detail).toMatch(/cannot reconnect/);
    expect(findings[0].daysRemaining).toBeLessThan(0);
  });
});

describe("one email per problem, not one per check", () => {
  it("stops tracking a credential whose agents are no longer registered, closing an open thread once", () => {
    // redline, 2026-09-24: deregistered, its last credential still warned as overdue.
    const overdueAt = at("2026-08-25T00:00:00Z");
    const first = assess([cred()], {}, overdueAt, new Set(["USOMEONEELSE"]));
    expect(first.findings).toEqual([]);
    expect(first.alerts).toEqual([]);
    expect(first.superseded).toEqual([cred().key]);
    // Already announced as overdue before it was known to be gone: one closing note.
    const announced = assess([cred()], {}, overdueAt).next;
    const closing = assess([cred()], announced, overdueAt + 3600_000, new Set());
    expect(closing.alerts).toHaveLength(1);
    expect(closing.alerts[0]!.detail).toContain("no longer registered");
    // A registry that could not be read skips nothing, and a registered agent is tracked as ever.
    expect(assess([cred()], {}, overdueAt).findings[0]!.verdict).toBe("overdue");
    expect(assess([cred()], {}, overdueAt, new Set([cred().agents[0]!])).findings[0]!.verdict).toBe("overdue");
  });

  it("alerts on the transition into overdue and then stays quiet", () => {
    let state: Record<string, CredSeen> = {};
    const first = assess([cred()], state, at("2026-08-25T00:00:00Z"));
    expect(first.alerts).toHaveLength(1);
    state = first.next;

    // Three more hourly passes with the same stuck lease: silence.
    for (let h = 1; h <= 3; h++) {
      const again = assess([cred()], state, at("2026-08-25T00:00:00Z") + h * 3600_000);
      expect(again.alerts, `pass ${h + 1} must not re-alert`).toEqual([]);
      expect(again.findings[0].verdict).toBe("overdue");
      state = again.next;
    }
  });

  it("alerts again when overdue worsens into expired — the shape changed", () => {
    const state: Record<string, CredSeen> = {
      [cred().key]: { verdict: "overdue", issuedAt: ISSUED, alertedAt: "2026-08-25T01:00:00Z" },
    };
    const { alerts } = assess([cred()], state, at("2026-09-01T00:00:00Z"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].verdict).toBe("expired");
  });

  it("alerts on the renewal that closes an overdue thread, and says it was a renewal", () => {
    const state: Record<string, CredSeen> = {
      [cred().key]: { verdict: "overdue", issuedAt: ISSUED, alertedAt: "2026-08-25T01:00:00Z" },
    };
    // The re-mint replaced the record on the same key: new issuedAt, new expiry.
    const renewed = cred({ issuedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-09-25T00:00:00.000Z", renewals: 1 });
    const { alerts, next } = assess([renewed], state, at("2026-08-26T01:00:00Z"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].verdict).toBe("ok");
    expect(alerts[0].detail).toMatch(/was renewed/);
    expect(next[renewed.key].alertedAt).toBeUndefined();
  });

  it("a routine renewal of a healthy lease is not news", () => {
    const state: Record<string, CredSeen> = {
      [cred().key]: { verdict: "ok", issuedAt: ISSUED },
    };
    const renewed = cred({ issuedAt: "2026-08-21T00:00:00.000Z", expiresAt: "2026-09-20T00:00:00.000Z", renewals: 1 });
    expect(assess([renewed], state, at("2026-08-21T01:00:00Z")).alerts).toEqual([]);
  });

  it("records when the problem STARTED, not when it was last seen", () => {
    let state: Record<string, CredSeen> = {};
    const first = assess([cred()], state, at("2026-08-25T00:00:00Z"));
    const startedAt = first.next[cred().key].alertedAt;
    expect(startedAt).toBeTruthy();
    state = first.next;
    const later = assess([cred()], state, at("2026-08-26T00:00:00Z"));
    expect(later.next[cred().key].alertedAt).toBe(startedAt);
  });
});

describe("cold start: a credential first seen at its own renewal", () => {
  // Codex's shape. Its current credential was minted before the log existed,
  // so the 2026-08-28 re-mint will be the first record its key ever gets —
  // written with the renewal already counted.
  it("is tracked from that first record with nothing to alert on", () => {
    const coldStart = cred({ issuedAt: "2026-08-28T00:00:00.000Z", expiresAt: null, renewals: 1 });
    const { findings, alerts } = assess([coldStart], {}, at("2026-08-28T00:30:00Z"));
    expect(findings[0].verdict).toBe("ok");
    expect(alerts).toEqual([]);
  });

  it("counts as the first renewal ever observed", () => {
    const coldStart = cred({ issuedAt: "2026-08-28T00:00:00.000Z", renewals: 1 });
    expect(firstRenewalOf([coldStart])?.key).toBe(coldStart.key);
    // And a log full of never-renewed mints proves nothing.
    expect(firstRenewalOf([cred(), cred({ key: "UOTHER" })])).toBeNull();
  });

  it("picks the EARLIEST renewal when several are on record", () => {
    const early = cred({ key: "UEARLY", agents: ["UA1"], issuedAt: "2026-08-20T00:00:00.000Z", renewals: 1 });
    const late = cred({ key: "ULATE", agents: ["UA2"], issuedAt: "2026-08-28T00:00:00.000Z", renewals: 2 });
    expect(firstRenewalOf([late, early])?.key).toBe("UEARLY");
  });
});

describe("a superseded lease is not an incident", () => {
  // An agent that re-bootstraps gets a fresh connection key. Its old lease
  // will never renew — nobody holds it — and must not ripen into a false
  // overdue alert at day 24.
  it("drops the old record instead of calling it overdue", () => {
    const old = cred();
    const fresh = cred({ key: "UCONNFRESH", issuedAt: "2026-08-20T00:00:00.000Z", expiresAt: "2026-09-19T00:00:00.000Z" });
    const { findings, alerts, superseded, next } = assess([old, fresh], {}, at("2026-08-26T00:00:00Z"));
    expect(superseded).toEqual([old.key]);
    expect(alerts).toEqual([]);
    expect(findings.every((f) => f.key !== old.key)).toBe(true);
    expect(next[old.key]).toBeUndefined();
  });

  it("closes an already-open thread when the supersession is discovered", () => {
    const old = cred();
    const fresh = cred({ key: "UCONNFRESH", issuedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-09-25T00:00:00.000Z" });
    const state: Record<string, CredSeen> = {
      [old.key]: { verdict: "overdue", issuedAt: ISSUED, alertedAt: "2026-08-25T01:00:00Z" },
    };
    const { alerts } = assess([old, fresh], state, at("2026-08-26T01:00:00Z"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].verdict).toBe("ok");
    expect(alerts[0].detail).toMatch(/superseded/);
  });

  it("closes the thread for a record that vanished from the log entirely", () => {
    const state: Record<string, CredSeen> = {
      UGONE: { verdict: "overdue", issuedAt: ISSUED, alertedAt: "2026-08-25T01:00:00Z" },
    };
    const first = assess([], state, at("2026-08-26T00:00:00Z"));
    expect(first.alerts).toHaveLength(1);
    expect(first.alerts[0].verdict).toBe("ok");
    // And only once: the next pass has nothing to compare against.
    expect(assess([], first.next, at("2026-08-26T01:00:00Z")).alerts).toEqual([]);
  });
});

// ── The job: state, the operator alert, and what must never break ───────────

/** In-memory stand-in for the state bucket: just get/put on one key. */
function fakeKv(): KeyedStore {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => (store.has(k) ? { string: () => store.get(k)! } : null),
    put: async (k: string, v: string) => {
      store.set(k, v);
      return 1;
    },
  } as unknown as KeyedStore;
}

type Sent = { subject: string; lines: string[] };

/** The job's dependencies, with an alert sink that records what it took.
 *  `fail` throws as a bus with nobody answering would; `refuse` answers that
 *  nobody took it. */
function deps(sent: Sent[], fail = false, refuse = false): CredWatchDeps {
  return {
    js: {} as StorageLike, // never touched: every seam is overridden
    alert: async (a: OpsAlert) => {
      if (fail) throw new Error("the bus is down");
      if (refuse) return false;
      sent.push({ subject: a.subject, lines: a.lines });
      return true;
    },
  };
}

describe("the scheduled job", () => {
  it("announces the FIRST renewal ever observed, exactly once", async () => {
    const kv = fakeKv();
    const sent: Sent[] = [];
    const renewed = cred({ issuedAt: "2026-08-28T00:00:00.000Z", expiresAt: null, renewals: 1 });
    const opts = {
      openState: async () => kv,
      readRecords: async () => [renewed],
      now: () => at("2026-08-28T00:30:00Z"),
    };

    await runCredRenewalWatch(deps(sent), opts);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/first credential renewal observed/);
    expect(sent[0].lines.join("\n")).toContain(renewed.agents[0].slice(0, 12));

    // The proof email must not repeat — not next pass, not after more renewals.
    await runCredRenewalWatch(deps(sent), opts);
    await runCredRenewalWatch(deps(sent), {
      ...opts,
      readRecords: async () => [{ ...renewed, renewals: 2 }],
    });
    expect(sent).toHaveLength(1);
  });

  it("logs an overdue lease and its recovery once each, across restarts, and emails neither", async () => {
    // The owner, 2026-09-24: "don't send emails for this event." Overdue,
    // expired and renewed are written to the log only.
    const kv = fakeKv(); // shared: this IS the persistence between "restarts"
    const sent: Sent[] = [];
    const logged: string[] = [];
    const was = console.log;
    console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    try {
      const base = { openState: async () => kv, readRecords: async () => [cred()] };
      await runCredRenewalWatch(deps(sent), { ...base, now: () => at("2026-08-25T00:00:00Z") });
      for (let h = 1; h <= 3; h++) {
        await runCredRenewalWatch(deps(sent), { ...base, now: () => at("2026-08-25T00:00:00Z") + h * 3600_000 });
      }
      const renewed = cred({ issuedAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-09-25T00:00:00.000Z", renewals: 1 });
      await runCredRenewalWatch(deps(sent), { openState: async () => kv, readRecords: async () => [renewed], now: () => at("2026-08-26T01:00:00Z") });
    } finally {
      console.log = was;
    }
    expect(sent.filter((s) => /overdue|EXPIRED|credential renewed/.test(s.subject))).toEqual([]);
    expect(logged.filter((l) => l.startsWith("[cred-watch] overdue:"))).toHaveLength(1);
    expect(logged.filter((l) => l.startsWith("[cred-watch] closed:"))).toHaveLength(1);
  });

  it("purges a superseded record so it cannot ripen into a false alarm", async () => {
    const purged: string[] = [];
    const old = cred();
    const fresh = cred({ key: "UCONNFRESH", issuedAt: "2026-08-20T00:00:00.000Z", expiresAt: "2026-09-19T00:00:00.000Z" });
    await runCredRenewalWatch(deps([]), {
      openState: async () => fakeKv(),
      readRecords: async () => [old, fresh],
      purgeRecord: async (k) => purged.push(k),
      now: () => at("2026-08-26T00:00:00Z"),
    });
    expect(purged).toEqual([old.key]);
  });

  it("a first-renewal notice nobody took is asked again next pass, and recorded once taken", async () => {
    const kv = fakeKv();
    const sent: Sent[] = [];
    const renewed = cred({ issuedAt: "2026-08-28T00:00:00.000Z", expiresAt: null, renewals: 1 });
    const opts = { openState: async () => kv, readRecords: async () => [renewed], now: () => at("2026-08-28T00:30:00Z") };
    await runCredRenewalWatch(deps(sent, false, true), opts);
    expect(sent).toEqual([]);
    await runCredRenewalWatch(deps(sent), opts);
    await runCredRenewalWatch(deps(sent), opts);
    expect(sent).toHaveLength(1);
  });

  it("with no bus and no alert sink, detection still runs and the notice waits", async () => {
    const kv = fakeKv();
    const renewed = cred({ issuedAt: "2026-08-28T00:00:00.000Z", expiresAt: null, renewals: 1 });
    const opts = { openState: async () => kv, readRecords: async () => [renewed], now: () => at("2026-08-28T00:30:00Z") };
    await expect(runCredRenewalWatch({ js: {} as StorageLike }, opts)).resolves.toBeUndefined();
    const sent: Sent[] = [];
    await runCredRenewalWatch(deps(sent), opts);
    expect(sent).toHaveLength(1);
  });

  it("never throws: no state bucket", async () => {
    await expect(
      runCredRenewalWatch(deps([]), {
        openState: async () => {
          throw new Error("no jetstream");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("never throws: unreadable mint log skips the pass rather than misdiagnosing", async () => {
    const kv = fakeKv();
    const sent: Sent[] = [];
    // First pass records an overdue lease…
    await runCredRenewalWatch(deps(sent), {
      openState: async () => kv,
      readRecords: async () => [cred()],
      now: () => at("2026-08-25T00:00:00Z"),
    });
    expect(sent).toHaveLength(0);
    // …then the log becomes unreadable. A partial or failed read must not be
    // taken as "the record vanished" (which would close the thread wrongly).
    await expect(
      runCredRenewalWatch(deps(sent), {
        openState: async () => kv,
        readRecords: async () => {
          throw new Error("enumeration lost keys");
        },
      }),
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("never throws when the bus is down, and an overdue lease is never sent at all", async () => {
    const kv = fakeKv();
    const failing: Sent[] = [];
    await expect(
      runCredRenewalWatch(deps(failing, true), {
        openState: async () => kv,
        readRecords: async () => [cred()],
        now: () => at("2026-08-25T00:00:00Z"),
      }),
    ).resolves.toBeUndefined();

    // The state update survived, so the next pass sends nothing: an overdue
    // lease is a log line, and the transition was consumed, not re-detected.
    const working: Sent[] = [];
    await runCredRenewalWatch(deps(working), {
      openState: async () => kv,
      readRecords: async () => [cred()],
      now: () => at("2026-08-25T01:00:00Z"),
    });
    expect(working).toEqual([]);
  });

  it("never throws when even the state put fails", async () => {
    const broken = {
      get: async () => null,
      put: async () => {
        throw new Error("kv write refused");
      },
    } as unknown as KeyedStore;
    await expect(
      runCredRenewalWatch(deps([]), {
        openState: async () => broken,
        readRecords: async () => [cred()],
        now: () => at("2026-08-25T00:00:00Z"),
      }),
    ).resolves.toBeUndefined();
  });
});
