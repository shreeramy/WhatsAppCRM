/**
 * Pure helpers for the v3 behaviours of the v2 engine (step nudges with
 * quiet hours, 30-minute demo slots with capacity, agent naming, tag
 * clean-up). No DB, no clock reads — callers pass `now`.
 */
import { localParts, zonedTime } from "./logic";
import type { V2Lang, WorkingHours } from "./settings";

const hhmm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
};

// ------------------------------------------------------------
// Quiet hours
// ------------------------------------------------------------

/**
 * Move a due time out of quiet hours: anything between quietStart
 * (e.g. 21:00) and quietEnd (10:00) goes to `shiftTo` (10:30) — the same
 * morning if it's after midnight, else the next morning.
 */
export function shiftOutOfQuietHours(
  due: Date,
  timezone: string,
  quietStart: string,
  quietEnd: string,
  shiftTo: string,
): Date {
  const p = localParts(due, timezone);
  const start = hhmm(quietStart);
  const end = hhmm(quietEnd);
  const inQuiet = start > end ? p.minutes >= start || p.minutes < end : p.minutes >= start && p.minutes < end;
  if (!inQuiet) return due;
  const sameMorning = start > end && p.minutes < end;
  const base = sameMorning ? p : localParts(new Date(due.getTime() + 24 * 3600 * 1000), timezone);
  return zonedTime(base.year, base.month, base.day, hhmm(shiftTo), timezone);
}

// ------------------------------------------------------------
// 30-minute demo slots (list message)
// ------------------------------------------------------------

export interface ListSlotConfig {
  /** Slot start times offered each working day, "HH:MM". */
  times: string[];
  slot_minutes: number;
  /** How many working days ahead (today counts if it's a working day). */
  days: number;
  max_rows: number;
  /** Don't offer a slot starting sooner than this. */
  min_lead_minutes: number;
  words: Record<V2Lang, { days: string[] }>; // Mon..Sun
}

export interface ListSlot {
  start: string;
  end: string;
  /** Row title, ≤ 24 chars: "Mon 11:00–11:30 AM". */
  label: string;
  /** For the confirmation: "Mon 19 Oct, 11:00–11:30 AM". */
  long: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function clock(minutes: number): { text: string; ampm: "AM" | "PM" } {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const ampm = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { text: `${h12}:${String(m).padStart(2, "0")}`, ampm };
}

export function slotRange(startMin: number, endMin: number): string {
  const a = clock(startMin);
  const b = clock(endMin);
  return a.ampm === b.ampm ? `${a.text}–${b.text} ${b.ampm}` : `${a.text} ${a.ampm}–${b.text} ${b.ampm}`;
}

/**
 * Free 30-minute slots over the next working days, earliest first, at
 * most `max_rows`. `booked` maps slot start (ISO) → bookings so far; a
 * slot at `capacity` is left out.
 */
export function computeListSlots(
  now: Date,
  wh: WorkingHours,
  cfg: ListSlotConfig,
  lang: V2Lang,
  booked: Record<string, number>,
  capacity: number,
): ListSlot[] {
  const p = localParts(now, wh.timezone);
  const out: ListSlot[] = [];
  let workingDaysSeen = 0;
  for (let offset = 0; offset < 14 && workingDaysSeen < cfg.days; offset++) {
    const base = new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
    const y = base.getUTCFullYear();
    const m = base.getUTCMonth() + 1;
    const d = base.getUTCDate();
    const weekday = ((p.weekday - 1 + offset) % 7 + 7) % 7 + 1;
    if (!wh.days.includes(weekday)) continue;
    workingDaysSeen++;
    for (const t of cfg.times) {
      const startMin = hhmm(t);
      const endMin = startMin + cfg.slot_minutes;
      if (startMin < hhmm(wh.start) || endMin > hhmm(wh.end)) continue;
      const start = zonedTime(y, m, d, startMin, wh.timezone);
      if (start.getTime() < now.getTime() + cfg.min_lead_minutes * 60000) continue;
      const iso = start.toISOString();
      if ((booked[iso] ?? 0) >= capacity) continue;
      const end = zonedTime(y, m, d, endMin, wh.timezone);
      const dayWord = cfg.words[lang].days[weekday - 1];
      const range = slotRange(startMin, endMin);
      out.push({
        start: iso,
        end: end.toISOString(),
        label: `${dayWord} ${range}`,
        long: `${dayWord} ${d} ${MONTHS[m - 1]}, ${range}`,
      });
      if (out.length >= cfg.max_rows) return out;
    }
  }
  return out;
}

// ------------------------------------------------------------
// Demo-day reminder time
// ------------------------------------------------------------

/**
 * 10:00 local on the demo day, or `earlyBeforeHours` before the slot when
 * it starts before `earlyCutoff` (e.g. 12:00). Null when that moment has
 * already passed (the confirmation just went out).
 */
export function demoReminderDue(
  slotStart: Date,
  now: Date,
  timezone: string,
  at: string,
  earlyCutoff: string,
  earlyBeforeHours: number,
): Date | null {
  const p = localParts(slotStart, timezone);
  const due =
    p.minutes < hhmm(earlyCutoff)
      ? new Date(slotStart.getTime() - earlyBeforeHours * 3600 * 1000)
      : zonedTime(p.year, p.month, p.day, hhmm(at), timezone);
  return due.getTime() > now.getTime() + 5 * 60000 ? due : null;
}

// ------------------------------------------------------------
// Agent naming + tags
// ------------------------------------------------------------

/**
 * The assignee's first name, but only when they're in the round-robin
 * pool (when `poolOnly`). Otherwise null → messages say "our team".
 */
export function agentNameFor(
  assigneeId: string | null | undefined,
  fullName: string | null | undefined,
  pool: string[],
  poolOnly: boolean,
): string | null {
  if (!assigneeId) return null;
  if (poolOnly && !pool.includes(assigneeId)) return null;
  const first = (fullName ?? "").trim().split(/\s+/)[0];
  return first || null;
}

/** "Lost:*" matches every tag starting with "Lost:" (case-insensitive); otherwise exact. */
export function tagMatches(pattern: string, name: string): boolean {
  const p = pattern.trim().toLowerCase();
  const n = name.trim().toLowerCase();
  return p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p;
}

/** Cap check for step nudges. */
export function canSendNudge(sentSoFar: number, maxPerLead: number): boolean {
  return sentSoFar < maxPerLead;
}

/** Bot pause: taps are still answered when `tapsBypass`; unprompted messages never. */
export function pauseBlocks(kind: "tap" | "text" | "scheduled", paused: boolean, tapsBypass: boolean): boolean {
  if (!paused) return false;
  return !(kind === "tap" && tapsBypass);
}
