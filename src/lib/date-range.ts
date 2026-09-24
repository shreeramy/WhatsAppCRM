import {
  addDays,
  addMonths,
  endOfDay,
  endOfMonth,
  startOfDay,
  startOfMonth,
  subDays,
  subMonths,
} from "date-fns";

// Shared date-range filter logic for list pages (Inbox, Contacts,
// Pipelines, Follow-ups). All ranges are in the browser's local time.

export type DateRangePreset =
  | "all"
  | "today"
  | "yesterday"
  | "last7"
  | "last30"
  | "thisMonth"
  | "lastMonth"
  | "next7"
  | "next30"
  | "nextMonth"
  | "custom";

export interface DateRangeValue {
  preset: DateRangePreset;
  /** yyyy-mm-dd, only used when preset is 'custom'. */
  from?: string;
  to?: string;
}

export const ALL_TIME: DateRangeValue = { preset: "all" };

/** Presets for "when did this happen" filters. */
export const PAST_PRESETS: DateRangePreset[] = [
  "all",
  "today",
  "yesterday",
  "last7",
  "last30",
  "thisMonth",
  "lastMonth",
  "custom",
];

/** Presets for dates that can lie ahead (expected close date). */
export const PAST_AND_FUTURE_PRESETS: DateRangePreset[] = [
  "all",
  "today",
  "next7",
  "next30",
  "thisMonth",
  "nextMonth",
  "lastMonth",
  "custom",
];

export interface ResolvedRange {
  from: Date | null;
  to: Date | null;
}

function parseDay(s: string | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function resolveRange(value: DateRangeValue, now: Date = new Date()): ResolvedRange {
  const today = startOfDay(now);
  switch (value.preset) {
    case "all":
      return { from: null, to: null };
    case "today":
      return { from: today, to: endOfDay(now) };
    case "yesterday":
      return { from: subDays(today, 1), to: endOfDay(subDays(today, 1)) };
    case "last7":
      return { from: subDays(today, 6), to: endOfDay(now) };
    case "last30":
      return { from: subDays(today, 29), to: endOfDay(now) };
    case "thisMonth":
      return { from: startOfMonth(now), to: endOfMonth(now) };
    case "lastMonth": {
      const m = subMonths(now, 1);
      return { from: startOfMonth(m), to: endOfMonth(m) };
    }
    case "next7":
      return { from: today, to: endOfDay(addDays(today, 6)) };
    case "next30":
      return { from: today, to: endOfDay(addDays(today, 29)) };
    case "nextMonth": {
      const m = addMonths(now, 1);
      return { from: startOfMonth(m), to: endOfMonth(m) };
    }
    case "custom": {
      const from = parseDay(value.from);
      const to = parseDay(value.to);
      return { from, to: to ? endOfDay(to) : null };
    }
  }
}

export function isRangeActive(value: DateRangeValue): boolean {
  const r = resolveRange(value);
  return r.from !== null || r.to !== null;
}

/**
 * Whether a timestamp / date string falls in the range. Missing dates
 * only match when no range is set.
 */
export function inRange(
  date: string | null | undefined,
  value: DateRangeValue,
  now: Date = new Date(),
): boolean {
  const { from, to } = resolveRange(value, now);
  if (!from && !to) return true;
  if (!date) return false;
  // Bare yyyy-mm-dd (e.g. expected_close_date) is a local calendar day.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00`) : new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}
