import { describe, expect, it } from "vitest";
import { buildLeadSeries, leadSeriesStart } from "./leads";

// Saturday 2026-10-03 15:00 local.
const NOW = new Date(2026, 9, 3, 15, 0);
const at = (m: number, d: number, h = 12) => new Date(2026, m, d, h).toISOString();

describe("buildLeadSeries", () => {
  it("counts leads per day, including empty days, oldest first", () => {
    const s = buildLeadSeries([at(9, 3, 9), at(9, 3, 14), at(9, 1)], "day", 3, NOW);
    expect(s.map((b) => [b.key, b.count])).toEqual([
      ["2026-10-01", 1],
      ["2026-10-02", 0],
      ["2026-10-03", 2],
    ]);
  });

  it("counts leads per month", () => {
    const s = buildLeadSeries([at(8, 30), at(8, 1), at(9, 2), at(6, 5)], "month", 3, NOW);
    expect(s.map((b) => [b.key, b.count])).toEqual([
      ["2026-08", 0],
      ["2026-09", 2],
      ["2026-10", 1],
    ]);
  });

  it("ignores leads outside the window and bad timestamps", () => {
    const s = buildLeadSeries([at(0, 1), "nope"], "day", 7, NOW);
    expect(s.reduce((n, b) => n + b.count, 0)).toBe(0);
  });
});

describe("leadSeriesStart", () => {
  it("starts at midnight of the first day / first of the first month", () => {
    expect(leadSeriesStart("day", 30, NOW)).toEqual(new Date(2026, 8, 4));
    expect(leadSeriesStart("month", 12, NOW)).toEqual(new Date(2025, 10, 1));
  });
});
