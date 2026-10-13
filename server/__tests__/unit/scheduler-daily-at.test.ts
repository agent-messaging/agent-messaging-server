// The daily digest is supposed to arrive at a habitual hour. It did not: the
// scheduler only knew "every intervalMs", so a 24h job fired 24h after it last
// fired and its hour was whatever hour the feature happened to ship on — 14:02
// UTC, i.e. 08:02 in Denver, drifting a little later each day by however long
// the run took.
//
// `lastDailyOccurrence` is the wall-clock half of the fix. These tests pin the
// two things that are easy to get subtly wrong and impossible to notice from a
// passing deploy: which side of the target hour "most recent" falls on, and
// whether the answer survives daylight saving.

import { describe, it, expect } from "vitest";
import { lastDailyOccurrence } from "../../src/shared/scheduler.js";

const DENVER = "America/Denver";

/** The instant, as an ISO string, for readable failures. */
const iso = (ms: number) => new Date(ms).toISOString();

describe("lastDailyOccurrence", () => {
  it("is today's target when the target has already passed", () => {
    // 2026-08-01 14:02 UTC = 08:02 MDT, so 06:00 MDT today has passed.
    const now = new Date("2026-08-01T14:02:00Z");
    expect(iso(lastDailyOccurrence(6, 0, DENVER, now))).toBe("2026-08-01T12:00:00.000Z");
  });

  it("is YESTERDAY's target when the target has not yet arrived", () => {
    // 2026-08-01 09:00 UTC = 03:00 MDT — before 6am, so the most recent 6am was
    // the previous day. Getting this backwards would fire the digest twice in
    // one morning.
    const now = new Date("2026-08-01T09:00:00Z");
    expect(iso(lastDailyOccurrence(6, 0, DENVER, now))).toBe("2026-07-31T12:00:00.000Z");
  });

  it("holds the LOCAL hour across daylight saving, not a fixed offset", () => {
    // Denver is UTC-6 in summer and UTC-7 in winter. 6am local is therefore a
    // different UTC instant in each — which is the entire reason the config
    // names a zone instead of an offset.
    const summer = lastDailyOccurrence(6, 0, DENVER, new Date("2026-08-01T20:00:00Z"));
    const winter = lastDailyOccurrence(6, 0, DENVER, new Date("2026-12-01T20:00:00Z"));
    expect(iso(summer)).toBe("2026-08-01T12:00:00.000Z");
    expect(iso(winter)).toBe("2026-12-01T13:00:00.000Z");
  });

  it("honours minutes, so an operator can dodge a contended slot", () => {
    const now = new Date("2026-08-01T14:00:00Z");
    expect(iso(lastDailyOccurrence(6, 30, DENVER, now))).toBe("2026-08-01T12:30:00.000Z");
  });

  it("works for a zone on the other side of UTC", () => {
    // Tokyo is UTC+9, so 6am local is 21:00 UTC the PREVIOUS day — the case
    // where a naive "today at 06:00 UTC minus offset" goes negative.
    const now = new Date("2026-08-01T14:00:00Z"); // 23:00 JST on the 1st
    expect(iso(lastDailyOccurrence(6, 0, "Asia/Tokyo", now))).toBe("2026-07-31T21:00:00.000Z");
  });

  it("never returns a moment in the future", () => {
    // The due-check compares the last run against this value, so a future
    // answer would mean the job is never due again.
    for (const h of [0, 6, 12, 23]) {
      for (const t of ["2026-08-01T00:30:00Z", "2026-08-01T12:00:00Z", "2026-08-01T23:59:00Z"]) {
        const now = new Date(t);
        expect(lastDailyOccurrence(h, 0, DENVER, now)).toBeLessThanOrEqual(now.getTime());
      }
    }
  });
});
