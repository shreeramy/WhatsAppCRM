import {
  addDays,
  isBefore,
  isSameDay,
  nextMonday,
  setHours,
  setMinutes,
  startOfMinute,
} from "date-fns";

// Pure date helpers for follow-ups. Everything works in the browser's
// local time zone — that is the salesperson's "today" and "Monday".

export type FollowUpBucket = "overdue" | "today" | "upcoming" | "done";

export function followUpBucket(
  f: { due_at: string; completed_at: string | null },
  now: Date = new Date(),
): FollowUpBucket {
  if (f.completed_at) return "done";
  const due = new Date(f.due_at);
  if (isBefore(due, now)) return "overdue";
  if (isSameDay(due, now)) return "today";
  return "upcoming";
}

/** True once a timestamp is in the past. */
export function isPastDue(iso: string, now: Date = new Date()): boolean {
  return isBefore(new Date(iso), now);
}

export type QuickPick = "inOneHour" | "tomorrow" | "nextMonday" | "inThreeDays" | "nextWeek";

export const QUICK_PICKS: QuickPick[] = [
  "inOneHour",
  "tomorrow",
  "nextMonday",
  "inThreeDays",
  "nextWeek",
];

const DEFAULT_HOUR = 10;

function atDefaultTime(d: Date): Date {
  return startOfMinute(setMinutes(setHours(d, DEFAULT_HOUR), 0));
}

/** Due date for a quick-pick chip ("Next Monday" → Monday 10:00). */
export function quickPickDate(pick: QuickPick, now: Date = new Date()): Date {
  switch (pick) {
    case "inOneHour":
      return startOfMinute(new Date(now.getTime() + 60 * 60 * 1000));
    case "tomorrow":
      return atDefaultTime(addDays(now, 1));
    case "nextMonday":
      return atDefaultTime(nextMonday(now));
    case "inThreeDays":
      return atDefaultTime(addDays(now, 3));
    case "nextWeek":
      return atDefaultTime(addDays(now, 7));
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Split a Date into `<input type=date>` / `<input type=time>` values. */
export function toDateTimeInputs(d: Date): { date: string; time: string } {
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Combine local date + time inputs into an ISO timestamp, or null if invalid. */
export function fromDateTimeInputs(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = /^\d{2}:\d{2}$/.test(time) ? time : "10:00";
  const d = new Date(`${date}T${t}:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
