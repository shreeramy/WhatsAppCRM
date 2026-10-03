import { addDays, addMonths, format, startOfDay, startOfMonth } from "date-fns";

// New-lead counts per day or per month, from contact created_at
// timestamps. Buckets use the browser's local time.

export type LeadGranularity = "day" | "month";

export interface LeadBucket {
  /** yyyy-MM-dd (day) or yyyy-MM (month). */
  key: string;
  start: Date;
  count: number;
}

/** First instant covered by `periods` buckets ending with the current one. */
export function leadSeriesStart(
  granularity: LeadGranularity,
  periods: number,
  now: Date = new Date(),
): Date {
  return granularity === "day"
    ? startOfDay(addDays(now, -(periods - 1)))
    : startOfMonth(addMonths(now, -(periods - 1)));
}

export function buildLeadSeries(
  createdAt: string[],
  granularity: LeadGranularity,
  periods: number,
  now: Date = new Date(),
): LeadBucket[] {
  const keyOf = (d: Date) => format(d, granularity === "day" ? "yyyy-MM-dd" : "yyyy-MM");
  const first = leadSeriesStart(granularity, periods, now);
  const buckets: LeadBucket[] = [];
  const index = new Map<string, LeadBucket>();
  for (let i = 0; i < periods; i++) {
    const start = granularity === "day" ? addDays(first, i) : addMonths(first, i);
    const b = { key: keyOf(start), start, count: 0 };
    buckets.push(b);
    index.set(b.key, b);
  }
  for (const ts of createdAt) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    const b = index.get(keyOf(d));
    if (b) b.count += 1;
  }
  return buckets;
}
