"use client"

import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { UserPlus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import {
  buildLeadSeries,
  leadSeriesStart,
  type LeadBucket,
  type LeadGranularity,
} from '@/lib/dashboard/leads'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'
import { cn } from '@/lib/utils'

// A "lead" is a new contact — created the first time someone messages
// (or is added/imported). Counted per day or per month.

const RANGES: Record<LeadGranularity, number[]> = {
  day: [7, 30, 90],
  month: [6, 12],
}
const PAGE = 1000
const MAX_ROWS = 50_000

const VB_W = 760
const VB_H = 240
const PAD = { top: 20, right: 12, bottom: 28, left: 36 }

async function loadCreatedAt(since: Date): Promise<string[]> {
  const db = createClient()
  const out: string[] = []
  // PostgREST caps a response at 1000 rows — page through.
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await db
      .from('contacts')
      .select('created_at')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    for (const r of data ?? []) out.push(r.created_at as string)
    if (!data || data.length < PAGE) break
  }
  return out
}

export function LeadsChart() {
  const t = useTranslations('Dashboard.leadsChart')
  const [granularity, setGranularity] = useState<LeadGranularity>('day')
  const [periods, setPeriods] = useState(30)
  // Fetched once for the widest window (12 months); every view is
  // bucketed client-side from it, so toggles are instant.
  const [createdAt, setCreatedAt] = useState<string[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    const since = leadSeriesStart('month', 12)
    const ninetyDays = leadSeriesStart('day', 90)
    loadCreatedAt(since < ninetyDays ? since : ninetyDays)
      .then((rows) => !cancelled && setCreatedAt(rows))
      .catch((err) => {
        console.error('[dashboard] leads failed:', err)
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const series = useMemo(
    () => (createdAt ? buildLeadSeries(createdAt, granularity, periods) : null),
    [createdAt, granularity, periods],
  )
  const total = series?.reduce((n, b) => n + b.count, 0) ?? 0
  const current = series?.[series.length - 1]?.count ?? 0
  const average = series && series.length ? total / series.length : 0

  function switchGranularity(g: LeadGranularity) {
    setGranularity(g)
    setPeriods(g === 'day' ? 30 : 12)
  }

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {(['day', 'month'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => switchGranularity(g)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  granularity === g
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(g === 'day' ? 'dayWise' : 'monthWise')}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {RANGES[granularity].map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setPeriods(r)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  periods === r
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(granularity === 'day' ? 'days' : 'months', { count: r })}
              </button>
            ))}
          </div>
        </div>
      </header>

      {series && (
        <div className="grid grid-cols-3 divide-x divide-border border-b border-border text-center">
          <Stat label={t('total')} value={total.toLocaleString()} />
          <Stat
            label={t(granularity === 'day' ? 'today' : 'thisMonth')}
            value={current.toLocaleString()}
          />
          <Stat
            label={t(granularity === 'day' ? 'avgPerDay' : 'avgPerMonth')}
            value={average.toLocaleString(undefined, { maximumFractionDigits: 1 })}
          />
        </div>
      )}

      <div className="p-5">
        {error ? (
          <p className="text-sm text-destructive">{t('loadFailed')}</p>
        ) : !series ? (
          <Skeleton className="h-[240px] w-full" />
        ) : total === 0 ? (
          <EmptyState icon={UserPlus} title={t('none')} hint={t('noneHint')} />
        ) : (
          <Bars data={series} granularity={granularity} t={t} />
        )}
      </div>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2.5">
      <p className="text-lg font-semibold text-foreground">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  )
}

function Bars({
  data,
  granularity,
  t,
}: {
  data: LeadBucket[]
  granularity: LeadGranularity
  t: ReturnType<typeof useTranslations>
}) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...data.map((b) => b.count))
  const ceil = niceCeil(max)
  const ticks = Array.from(new Set([0, ceil / 2, ceil].map((v) => Math.round(v))))
  const chartW = VB_W - PAD.left - PAD.right
  const chartH = VB_H - PAD.top - PAD.bottom
  const slot = chartW / data.length
  const barW = Math.max(2, Math.min(36, slot * 0.7))
  const yFor = (v: number) => PAD.top + chartH - (v / ceil) * chartH
  // Thin out x labels so they never collide.
  const labelEvery = Math.ceil(data.length / (granularity === 'day' ? 10 : 12))
  const label = (b: LeadBucket) =>
    format(b.start, granularity === 'day' ? 'd MMM' : 'MMM yy')
  const h = hover !== null ? data[hover] : null

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="h-[240px] w-full" role="img" aria-label={t('title')}>
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={VB_W - PAD.right}
              y1={yFor(v)}
              y2={yFor(v)}
              className="stroke-border"
              strokeDasharray={v === 0 ? undefined : '3 3'}
            />
            <text x={PAD.left - 6} y={yFor(v) + 3} textAnchor="end" className="fill-muted-foreground text-[10px]">
              {v}
            </text>
          </g>
        ))}
        {data.map((b, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2
          const y = yFor(b.count)
          return (
            <g key={b.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* Full-height hit area so short bars are easy to hover. */}
              <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={chartH} fill="transparent" />
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(0, PAD.top + chartH - y)}
                rx={Math.min(3, barW / 3)}
                className={cn('fill-primary transition-opacity', hover !== null && hover !== i && 'opacity-40')}
              />
              {data.length <= 31 && b.count > 0 && (
                <text x={x + barW / 2} y={y - 4} textAnchor="middle" className="fill-foreground text-[10px]">
                  {b.count}
                </text>
              )}
              {i % labelEvery === 0 && (
                <text
                  x={PAD.left + i * slot + slot / 2}
                  y={VB_H - 8}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {label(b)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {h && (
        <div className="pointer-events-none absolute right-2 top-0 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md">
          <span className="text-muted-foreground">
            {format(h.start, granularity === 'day' ? 'EEE, d MMM yyyy' : 'MMMM yyyy')}:
          </span>{' '}
          <span className="font-semibold text-foreground">{t('leadsCount', { count: h.count })}</span>
        </div>
      )}
    </div>
  )
}

function niceCeil(n: number): number {
  if (n <= 5) return 5
  const pow = 10 ** Math.floor(Math.log10(n))
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow >= n) ?? 10
  return step * pow
}
