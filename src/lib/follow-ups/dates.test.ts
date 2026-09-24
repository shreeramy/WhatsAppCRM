import { describe, expect, it } from "vitest";
import {
  followUpBucket,
  fromDateTimeInputs,
  quickPickDate,
  toDateTimeInputs,
} from "./dates";

// Wednesday 2026-09-23 14:30 local time.
const NOW = new Date(2026, 8, 23, 14, 30);

describe("followUpBucket", () => {
  it("puts completed follow-ups in done regardless of date", () => {
    expect(
      followUpBucket({ due_at: new Date(2026, 8, 1).toISOString(), completed_at: "x" }, NOW),
    ).toBe("done");
  });

  it("flags past due dates as overdue, including earlier today", () => {
    expect(
      followUpBucket({ due_at: new Date(2026, 8, 23, 9).toISOString(), completed_at: null }, NOW),
    ).toBe("overdue");
  });

  it("splits later-today from upcoming", () => {
    expect(
      followUpBucket({ due_at: new Date(2026, 8, 23, 18).toISOString(), completed_at: null }, NOW),
    ).toBe("today");
    expect(
      followUpBucket({ due_at: new Date(2026, 8, 24, 9).toISOString(), completed_at: null }, NOW),
    ).toBe("upcoming");
  });
});

describe("quickPickDate", () => {
  it("next Monday is the coming Monday at 10:00", () => {
    expect(quickPickDate("nextMonday", NOW)).toEqual(new Date(2026, 8, 28, 10, 0));
  });

  it("tomorrow is 10:00 the next day", () => {
    expect(quickPickDate("tomorrow", NOW)).toEqual(new Date(2026, 8, 24, 10, 0));
  });

  it("in one hour keeps the current minute", () => {
    expect(quickPickDate("inOneHour", NOW)).toEqual(new Date(2026, 8, 23, 15, 30));
  });
});

describe("date/time input round trip", () => {
  it("round-trips a local date and time", () => {
    const d = new Date(2026, 8, 28, 10, 5);
    const { date, time } = toDateTimeInputs(d);
    expect(date).toBe("2026-09-28");
    expect(time).toBe("10:05");
    expect(fromDateTimeInputs(date, time)).toBe(d.toISOString());
  });

  it("rejects a missing date and defaults a missing time to 10:00", () => {
    expect(fromDateTimeInputs("", "10:00")).toBeNull();
    expect(fromDateTimeInputs("2026-09-28", "")).toBe(new Date(2026, 8, 28, 10, 0).toISOString());
  });
});
