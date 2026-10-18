// ============================================================
// Drip broadcasts — pure pacing + audience rules (no I/O).
//
// The server side (broadcast-drip-run.ts) asks `dripQuota` how many
// messages it may send on this minute's tick, given what already went
// out today.
// ============================================================

export interface DripTemplate {
  name: string
  language: string
  /** Image/video header link, for templates that have a media header. */
  header_media_url?: string
}

export interface DripConfig {
  /** Messages per send, and minutes between sends. */
  per_tick: number
  every_minutes: number
  /** Only send between start and end (local time). Omit = any time. */
  window?: { timezone: string; start: string; end: string }
  /** Max messages per local day. Omit = no cap. */
  daily_cap?: number
  /** Template per language; `en` is the default for everyone else. */
  templates: { en: DripTemplate } & Partial<Record<string, DripTemplate>>
  /** Body params; tokens: {first_name} and any literal text. */
  params: string[]
  audience: {
    /** Only contacts with this tag (resolved when the broadcast starts). */
    tag?: string
    /** Skip contacts with any of these tags; a trailing * matches a prefix. */
    exclude_tags?: string[]
    /** Skip contacts whose deal is in one of these stages. */
    exclude_stages?: string[]
  }
}

function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return h * 60 + m
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + (m || 0)
}

/** Start of the local day containing `now`, as a UTC instant. */
export function localDayStart(now: Date, timezone: string): Date {
  return new Date(now.getTime() - localMinutes(now, timezone) * 60000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds())
}

export function inWindow(now: Date, cfg: Pick<DripConfig, 'window'>): boolean {
  if (!cfg.window) return true
  const t = localMinutes(now, cfg.window.timezone)
  return t >= toMinutes(cfg.window.start) && t < toMinutes(cfg.window.end)
}

/** How many messages this tick may send (0 = wait). */
export function dripQuota(
  now: Date,
  cfg: DripConfig,
  sentToday: number,
  lastSentAt: Date | null,
): number {
  if (!inWindow(now, cfg)) return 0
  // Ticks arrive roughly once a minute; allow a few seconds of jitter.
  if (lastSentAt && now.getTime() - lastSentAt.getTime() < cfg.every_minutes * 60000 - 5000) return 0
  const left = cfg.daily_cap === undefined ? Infinity : cfg.daily_cap - sentToday
  return Math.max(0, Math.min(cfg.per_tick, left))
}

export function tagExcluded(tagNames: string[], exclude: string[] = []): boolean {
  const lower = tagNames.map((t) => t.toLowerCase())
  return exclude.some((rule) => {
    const r = rule.toLowerCase()
    return r.endsWith('*') ? lower.some((t) => t.startsWith(r.slice(0, -1))) : lower.includes(r)
  })
}

/** A name fit for "Hi {{1}}" — first word, letters only; else a polite default. */
export function greetingName(name: string | null | undefined, lang: string): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? ''
  if (/^[\p{L}][\p{L}.'-]{1,24}$/u.test(first) && !first.startsWith('[')) {
    return first.charAt(0).toUpperCase() + first.slice(1)
  }
  return lang === 'hi' ? 'जी' : 'there'
}

export function fillParams(params: string[], name: string | null | undefined, lang: string): string[] {
  return params.map((p) => p.replaceAll('{first_name}', greetingName(name, lang)))
}

export function templateFor(cfg: DripConfig, lang: string): DripTemplate {
  return cfg.templates[lang] ?? cfg.templates.en
}
