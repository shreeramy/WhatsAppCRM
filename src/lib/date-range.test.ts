import { describe, expect, it } from "vitest";
import { inRange, isRangeActive, resolveRange } from "./date-range";

// Wednesday 2026-09-23 14:30 local time.
const NOW = new Date(2026, 8, 23, 14, 30);
const at = (m: number, d: number, h = 12) => new Date(2026, m, d, h).toISOString();

describe("resolveRange", () => {
  it("'all' has no bounds", () => {
    expect(resolveRange({ preset: "all" }, NOW)).toEqual({ from: null, to: null });
  });

  it("last 7 days includes today and the six days before", () => {
    const r = resolveRange({ preset: "last7" }, NOW);
    expect(r.from).toEqual(new Date(2026, 8, 17));
    expect(r.to?.getDate()).toBe(23);
  });

  it("last month is the whole previous calendar month", () => {
    const r = resolveRange({ preset: "lastMonth" }, NOW);
    expect(r.from).toEqual(new Date(2026, 7, 1));
    expect(r.to?.getMonth()).toBe(7);
    expect(r.to?.getDate()).toBe(31);
  });

  it("custom range with only a start date is open-ended", () => {
    const r = resolveRange({ preset: "custom", from: "2026-09-01" }, NOW);
    expect(r.from).toEqual(new Date(2026, 8, 1));
    expect(r.to).toBeNull();
  });
});

describe("inRange", () => {
  it("matches everything, including missing dates, when no range is set", () => {
    expect(inRange(null, { preset: "all" }, NOW)).toBe(true);
    expect(inRange(at(0, 1), { preset: "custom" }, NOW)).toBe(true);
  });

  it("excludes missing dates once a range is set", () => {
    expect(inRange(null, { preset: "today" }, NOW)).toBe(false);
  });

  it("today includes this morning and excludes yesterday evening", () => {
    expect(inRange(at(8, 23, 1), { preset: "today" }, NOW)).toBe(true);
    expect(inRange(at(8, 22, 23), { preset: "today" }, NOW)).toBe(false);
  });

  it("custom 'to' date includes that whole day", () => {
    const v = { preset: "custom" as const, from: "2026-09-10", to: "2026-09-20" };
    expect(inRange(at(8, 20, 23), v, NOW)).toBe(true);
    expect(inRange(at(8, 21, 0), v, NOW)).toBe(false);
  });

  it("treats bare dates as local calendar days", () => {
    expect(inRange("2026-09-25", { preset: "next7" }, NOW)).toBe(true);
    expect(inRange("2026-10-05", { preset: "next7" }, NOW)).toBe(false);
    expect(inRange("2026-10-05", { preset: "nextMonth" }, NOW)).toBe(true);
  });
});

describe("isRangeActive", () => {
  it("is false for all-time and an empty custom range", () => {
    expect(isRangeActive({ preset: "all" })).toBe(false);
    expect(isRangeActive({ preset: "custom" })).toBe(false);
    expect(isRangeActive({ preset: "yesterday" })).toBe(true);
  });
});
