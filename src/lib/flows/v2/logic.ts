/**
 * Pure decision logic for the v2 flow engine — no DB, no Meta, no clock
 * reads (callers pass `now`). Unit-tested in logic.test.ts.
 */
import type { TextIntent, V2Lang, V2Settings, WorkingHours } from "./settings";

// ------------------------------------------------------------
// Language
// ------------------------------------------------------------

const DEVANAGARI = /[ऀ-ॿ]/;

function looseText(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s​-‍]+/g, " ")
    .replace(/[!?.,।'"“”‘’]/g, "")
    .trim();
}

/**
 * Hindi when the first message has Devanagari, matches a Hindi ad
 * pre-fill, or the form says Hindi. English otherwise.
 */
export function detectLanguage(
  text: string | null | undefined,
  settings: Pick<V2Settings, "language">,
  formLanguage?: string | null,
): V2Lang {
  const f = (formLanguage ?? "").trim().toLowerCase();
  if (f === "hi" || f === "hindi" || f === "हिंदी" || f === "हिन्दी") return "hi";
  const t = text ?? "";
  if (DEVANAGARI.test(t)) return "hi";
  const lt = looseText(t);
  if (lt && settings.language.hindi_prefill.some((p) => looseText(p) === lt)) return "hi";
  return "en";
}

// ------------------------------------------------------------
// Forms (WhatsApp Flow / Instant Form submissions, `nfm_reply`)
// ------------------------------------------------------------

export interface ParsedForm {
  name: string | null;
  email: string | null;
  language: string | null;
  fields: Record<string, string>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseFormSubmission(
  responseJson: string | null | undefined,
  form: V2Settings["form"],
): ParsedForm {
  const out: ParsedForm = { name: null, email: null, language: null, fields: {} };
  if (!responseJson) return out;
  let data: unknown;
  try {
    data = JSON.parse(responseJson);
  } catch {
    return out;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
    if (key === "flow_token" || raw == null) continue;
    const value = Array.isArray(raw) ? raw.join(", ") : String(raw).trim();
    if (!value) continue;
    out.fields[key] = value;
    const target = form.field_map[key];
    if (target === "name" && !out.name) out.name = value;
    if (target === "email" && !out.email && EMAIL.test(value)) out.email = value;
    if (!out.email && EMAIL.test(value)) out.email = value;
    if (form.language_field && key === form.language_field) out.language = value;
  }
  return out;
}

// ------------------------------------------------------------
// Working hours / time (IST by config)
// ------------------------------------------------------------

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 1 = Mon … 7 = Sun
  minutes: number; // minutes since local midnight
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(date: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: WEEKDAY[get("weekday")] ?? 1,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function hhmm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** UTC offset of `timezone` at `date`, in minutes (IST = +330). */
function offsetMinutes(date: Date, timezone: string): number {
  const p = localParts(date, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, 0, p.minutes);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** The instant for local date (y-m-d) + local minutes in `timezone`. */
export function zonedTime(y: number, m: number, d: number, minutes: number, timezone: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, 0, minutes));
  return new Date(guess.getTime() - offsetMinutes(guess, timezone) * 60000);
}

export function isWithinWorkingHours(now: Date, wh: WorkingHours): boolean {
  const p = localParts(now, wh.timezone);
  return wh.days.includes(p.weekday) && p.minutes >= hhmm(wh.start) && p.minutes < hhmm(wh.end);
}

/** Local calendar date `n` days after `date`'s local date. */
function addLocalDays(p: LocalParts, n: number): { y: number; m: number; d: number; weekday: number } {
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return {
    y: base.getUTCFullYear(),
    m: base.getUTCMonth() + 1,
    d: base.getUTCDate(),
    weekday: ((p.weekday - 1 + n) % 7 + 7) % 7 + 1,
  };
}

/** First working day strictly after the local date of `now`, at local `time`. */
export function nextWorkingDayAt(now: Date, wh: WorkingHours, time: string): Date {
  const p = localParts(now, wh.timezone);
  for (let i = 1; i <= 14; i++) {
    const day = addLocalDays(p, i);
    if (wh.days.includes(day.weekday)) return zonedTime(day.y, day.m, day.d, hhmm(time), wh.timezone);
  }
  return new Date(now.getTime() + 24 * 3600 * 1000);
}

/**
 * Callback due time: +30 min inside working hours, else the next
 * working day at `offHoursTime` (today, if today is a working day and
 * we're before opening).
 */
export function callFollowUpDue(now: Date, wh: WorkingHours, open: boolean, slaMinutes = 30, offHoursTime = "10:00"): Date {
  if (open) return new Date(now.getTime() + slaMinutes * 60000);
  const p = localParts(now, wh.timezone);
  if (wh.days.includes(p.weekday) && p.minutes < hhmm(wh.start)) {
    return zonedTime(p.year, p.month, p.day, hhmm(offHoursTime), wh.timezone);
  }
  return nextWorkingDayAt(now, wh, offHoursTime);
}

/**
 * Nudge due time: now + delay if that lands inside working hours, else
 * the next working opening at `offHoursTime`.
 */
export function nudgeDue(now: Date, wh: WorkingHours, delayMinutes: number, offHoursTime = "10:30", ignoreHours = false): Date {
  const due = new Date(now.getTime() + delayMinutes * 60000);
  if (ignoreHours || isWithinWorkingHours(due, wh)) return due;
  const p = localParts(due, wh.timezone);
  if (wh.days.includes(p.weekday) && p.minutes < hhmm(wh.start)) {
    return zonedTime(p.year, p.month, p.day, hhmm(offHoursTime), wh.timezone);
  }
  return nextWorkingDayAt(due, wh, offHoursTime);
}

// ------------------------------------------------------------
// Demo slots
// ------------------------------------------------------------

export interface SlotTemplate {
  /** "today" slots go on the base day, "next" on the working day after it. */
  day: "today" | "next";
  start: string; // "17:00"
  end: string; // "19:00"
  /** Time-range part of the label, per language: "5–7 PM" / "शाम 5–7". */
  range: Record<V2Lang, string>;
}

export interface SlotConfig {
  slots: SlotTemplate[];
  /** After this local time, "today" moves to the next working day. */
  cutoff: string; // "17:00"
  words: Record<V2Lang, { today: string; tomorrow: string; days: string[] }>; // days: Mon..Sun
  months?: string[];
}

export interface DemoSlot {
  start: string; // ISO
  end: string; // ISO
  label: string; // button label, ≤ 20 chars
  /** Absolute label for the confirmation, e.g. "Fri 17 Oct, 5–7 PM". */
  long: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Today/tomorrow slots in the configured zone. When it's past the
 * cutoff or not a working day, every slot shifts forward (today → next
 * working day, tomorrow → the working day after) and labels switch to
 * day names.
 */
export function computeDemoSlots(now: Date, wh: WorkingHours, cfg: SlotConfig, lang: V2Lang): DemoSlot[] {
  const p = localParts(now, wh.timezone);
  const todayOk = wh.days.includes(p.weekday) && p.minutes < hhmm(cfg.cutoff);

  const workingDayFrom = (offsetStart: number) => {
    for (let i = offsetStart; i <= offsetStart + 14; i++) {
      const d = addLocalDays(p, i);
      if (wh.days.includes(d.weekday)) return { ...d, offset: i };
    }
    return { ...addLocalDays(p, offsetStart), offset: offsetStart };
  };
  const base = todayOk ? { ...addLocalDays(p, 0), offset: 0 } : workingDayFrom(1);
  const next = workingDayFrom(base.offset + 1);

  const words = cfg.words[lang];
  const months = cfg.months ?? MONTHS;
  return cfg.slots.map((s) => {
    const day = s.day === "today" ? base : next;
    const startAt = zonedTime(day.y, day.m, day.d, hhmm(s.start), wh.timezone);
    const endAt = zonedTime(day.y, day.m, day.d, hhmm(s.end), wh.timezone);
    const dayWord =
      day.offset === 0 ? words.today : day.offset === 1 ? words.tomorrow : words.days[day.weekday - 1];
    return {
      start: startAt.toISOString(),
      end: endAt.toISOString(),
      label: `${dayWord} ${s.range[lang]}`,
      long: `${words.days[day.weekday - 1]} ${day.d} ${months[day.m - 1]}, ${s.range[lang]}`,
    };
  });
}

/** Slot buttons carry their slot in the reply id: `slot|<node>|<start>|<end>|<long>`. */
export function encodeSlotReplyId(nodeKey: string, slot: DemoSlot): string {
  return ["slot", nodeKey, slot.start, slot.end, slot.long].join("|");
}

export function decodeSlotReplyId(
  replyId: string,
): { nodeKey: string; start: string; end: string; long: string } | null {
  const parts = replyId.split("|");
  if (parts.length < 5 || parts[0] !== "slot") return null;
  const [, nodeKey, start, end, ...rest] = parts;
  if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return null;
  return { nodeKey, start, end, long: rest.join("|") };
}

// ------------------------------------------------------------
// Buttons: every button the flow ever sent stays valid
// ------------------------------------------------------------

export interface V2NodeLike {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

function cleanTitle(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

export type TapTarget =
  | { kind: "node"; node_key: string; via: "reply_id" | "title" }
  | { kind: "slot"; node_key: string; start: string; end: string; long: string };

/**
 * Resolve a tap against the WHOLE flow, not just the current step: by
 * exact reply id first (v2 ids are unique per flow), then a slot id,
 * then by visible title (lets taps on buttons from the old flow's
 * messages, e.g. "Book free demo", land on the matching v2 step).
 */
/** Every tappable option of a step: reply buttons, list rows, slot-list extra rows. */
function optionsOf(n: V2NodeLike): Array<{ reply_id: string; title: string; next_node_key: string }> {
  type Opt = { reply_id: string; title: string; next_node_key: string };
  const c = n.config as {
    buttons?: Opt[];
    list?: { rows?: Opt[] };
    dynamic_slots?: { extra_rows?: Opt[] };
  };
  return [...(c.buttons ?? []), ...(c.list?.rows ?? []), ...(c.dynamic_slots?.extra_rows ?? [])];
}

export function resolveTap(
  nodes: Iterable<V2NodeLike>,
  replyId: string,
  title?: string | null,
): TapTarget | null {
  const list = [...nodes];
  for (const n of list) {
    const buttons = optionsOf(n);
    const hit = buttons.find((b) => b.reply_id === replyId);
    if (hit) return { kind: "node", node_key: hit.next_node_key, via: "reply_id" };
  }
  const slot = decodeSlotReplyId(replyId);
  if (slot) {
    const picker = list.find((n) => n.node_key === slot.nodeKey);
    const next = (picker?.config.dynamic_slots as { next_node_key?: string } | undefined)?.next_node_key;
    if (next) return { kind: "slot", node_key: next, start: slot.start, end: slot.end, long: slot.long };
  }
  const t = title ? cleanTitle(title) : "";
  if (t) {
    for (const n of list) {
      const buttons = optionsOf(n);
      const aliases = (n.config.title_aliases as Record<string, string> | undefined) ?? {};
      const hit = buttons.find((b) => cleanTitle(b.title) === t);
      if (hit) return { kind: "node", node_key: hit.next_node_key, via: "title" };
      for (const [alias, target] of Object.entries(aliases)) {
        if (cleanTitle(alias) === t) return { kind: "node", node_key: target, via: "title" };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------
// Free text that clearly answers the current question
// ------------------------------------------------------------

export function matchTextIntent(
  text: string,
  intents: TextIntent[],
  currentNode: string | null,
  lang: V2Lang,
  vars: Record<string, unknown>,
): string | null {
  const t = looseText(text);
  for (const intent of intents) {
    if (intent.at_nodes?.length && (!currentNode || !intent.at_nodes.includes(currentNode))) continue;
    const hit = intent.keywords.some((k) => {
      const kw = looseText(k);
      if (!kw) return false;
      // Whole-word match so "team" doesn't fire on "steam".
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(t);
    });
    if (!hit) continue;
    if (intent.by_var) {
      const v = vars[intent.by_var.var];
      const mapped = typeof v === "string" ? intent.by_var.map[v]?.[lang] : undefined;
      if (mapped) return mapped;
    }
    return intent.target[lang] ?? intent.target.en ?? null;
  }
  return null;
}

// ------------------------------------------------------------
// Entry decision
// ------------------------------------------------------------

export interface EntryFacts {
  kind: "text" | "tap" | "form";
  isFirstInbound: boolean;
  /** Newest message (any sender) in this conversation before this one. */
  lastPriorMessageAt: Date | null;
  /** Newest human agent message in the conversation. */
  lastAgentMessageAt: Date | null;
  /** When the newest finished v2 run for this contact ended. */
  lastFinishedRunAt: Date | null;
  hasActiveRun: boolean;
  now: Date;
}

export type EntryDecision =
  | { action: "start"; reason: "first_message" | "reengaged" | "form" }
  | { action: "continue" }
  | { action: "agent_active" }
  | { action: "fallback"; reason: "recently_finished" | "recent_contact" };

const H = 3600 * 1000;
const D = 24 * H;

export function isBotPaused(lastAgentMessageAt: Date | null, now: Date, pauseHours: number): boolean {
  return !!lastAgentMessageAt && now.getTime() - lastAgentMessageAt.getTime() < pauseHours * H;
}

/**
 * Should a message from a contact WITHOUT a usable active run start v2?
 *   start  — new contact, re-engaged after N quiet days, or a form
 *   agent_active — a human is working the chat (bot stays out)
 *   fallback — known contact / recently finished: hand to an agent
 */
export function decideEntry(f: EntryFacts, s: V2Settings["entry"]): EntryDecision {
  if (f.hasActiveRun) return { action: "continue" };
  if (isBotPaused(f.lastAgentMessageAt, f.now, s.skip_if_agent_active_hours)) return { action: "agent_active" };
  if (f.lastFinishedRunAt && f.now.getTime() - f.lastFinishedRunAt.getTime() < s.skip_if_run_finished_days * D) {
    return { action: "fallback", reason: "recently_finished" };
  }
  if (f.kind === "form") return { action: "start", reason: "form" };
  if (f.isFirstInbound) return { action: "start", reason: "first_message" };
  if (!f.lastPriorMessageAt || f.now.getTime() - f.lastPriorMessageAt.getTime() >= s.reengage_after_days * D) {
    return { action: "start", reason: "reengaged" };
  }
  return { action: "fallback", reason: "recent_contact" };
}

// ------------------------------------------------------------
// Interpolation
// ------------------------------------------------------------

export function fill(template: string, values: Record<string, string | null | undefined>): string {
  return (template ?? "").replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key: string) => {
    const k = key.startsWith("vars.") ? key.slice(5) : key;
    const v = values[k];
    return v == null ? "" : String(v);
  });
}

export function firstName(fullName: string | null | undefined): string | null {
  const f = (fullName ?? "").trim().split(/\s+/)[0];
  return f || null;
}
