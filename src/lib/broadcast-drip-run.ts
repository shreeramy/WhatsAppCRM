// ============================================================
// Drip broadcasts — the sender, run every minute by
// /api/broadcasts/drip (pg_cron, migration 063).
//
//   scheduled → (scheduled_at reached) resolve the audience, one
//               pending recipient row each, in their language
//   sending   → each tick sends what `dripQuota` allows; a language
//               whose template isn't APPROVED yet simply waits
//   sent      → no pending recipient left (finalizeBroadcastStatus)
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendTemplate } from '@/lib/automations/meta-send'
import { finalizeBroadcastStatus } from '@/lib/whatsapp/broadcast-core'
import {
  dripQuota,
  fillParams,
  localDayStart,
  tagExcluded,
  templateFor,
  type DripConfig,
} from './broadcast-drip'

interface DripBroadcast {
  id: string
  account_id: string
  user_id: string
  status: 'scheduled' | 'sending'
  drip: DripConfig
}

export interface DripTickResult {
  broadcast_id: string
  materialized?: number
  sent: number
  failed: number
  note?: string
}

const PAGE = 1000

async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

/** Resolve who gets the broadcast and write one pending row each. */
async function materialize(db: SupabaseClient, b: DripBroadcast): Promise<number> {
  const cfg = b.drip
  const contacts = await fetchAll<{ id: string; name: string | null; blocked_at: string | null }>((f, t) =>
    db.from('contacts').select('id, name, blocked_at').eq('account_id', b.account_id).order('id').range(f, t),
  )
  const tagRows = await fetchAll<{ contact_id: string; tags: { name: string } | null }>((f, t) =>
    db.from('contact_tags').select('contact_id, tags!inner(name, account_id)').eq('tags.account_id', b.account_id).range(f, t),
  )
  const tagsOf = new Map<string, string[]>()
  for (const r of tagRows) if (r.tags) tagsOf.set(r.contact_id, [...(tagsOf.get(r.contact_id) ?? []), r.tags.name])

  const stageOf = new Map<string, string[]>()
  if (cfg.audience.exclude_stages?.length) {
    const deals = await fetchAll<{ contact_id: string; stage: { name: string } | null }>((f, t) =>
      db.from('deals').select('contact_id, stage:pipeline_stages(name)').eq('account_id', b.account_id).range(f, t),
    )
    for (const d of deals) if (d.stage) stageOf.set(d.contact_id, [...(stageOf.get(d.contact_id) ?? []), d.stage.name])
  }

  // Language: the one the lead last used with the welcome flow.
  const runs = await fetchAll<{ contact_id: string; vars: { lang?: string } | null }>((f, t) =>
    db.from('flow_runs').select('contact_id, vars').eq('account_id', b.account_id).order('started_at').range(f, t),
  )
  const langOf = new Map<string, string>()
  for (const r of runs) if (r.vars?.lang) langOf.set(r.contact_id, r.vars.lang)

  const excludedStages = (cfg.audience.exclude_stages ?? []).map((s) => s.toLowerCase())
  const rows = contacts
    .filter((c) => !cfg.audience.contact_ids || cfg.audience.contact_ids.includes(c.id))
    .filter((c) => !c.blocked_at && !(c.name ?? '').startsWith('[TEST]'))
    .filter((c) => !cfg.audience.tag || tagExcluded(tagsOf.get(c.id) ?? [], [cfg.audience.tag]))
    .filter((c) => !tagExcluded(tagsOf.get(c.id) ?? [], cfg.audience.exclude_tags))
    .filter((c) => !(stageOf.get(c.id) ?? []).some((s) => excludedStages.includes(s.toLowerCase())))
    .map((c) => {
      const own = cfg.audience.force_lang ?? langOf.get(c.id)
      const lang = own === 'hi' && cfg.templates.hi ? 'hi' : 'en'
      const tpl = templateFor(cfg, lang)
      return {
        broadcast_id: b.id,
        contact_id: c.id,
        status: 'pending',
        template_params: fillParams(cfg.params, c.name, lang),
        template_name: tpl.name,
        template_language: tpl.language,
      }
    })

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('broadcast_recipients').insert(rows.slice(i, i + 500))
    if (error) throw new Error(`recipients insert failed: ${error.message}`)
  }
  await db
    .from('broadcasts')
    .update({ status: 'sending', total_recipients: rows.length, updated_at: new Date().toISOString() })
    .eq('id', b.id)
  return rows.length
}

async function approvedTemplates(db: SupabaseClient, accountId: string): Promise<Set<string>> {
  const { data } = await db.from('message_templates').select('name, language').eq('account_id', accountId).eq('status', 'APPROVED')
  return new Set((data ?? []).map((t) => `${t.name}|${t.language}`))
}

async function tickOne(db: SupabaseClient, b: DripBroadcast, now: Date): Promise<DripTickResult> {
  const result: DripTickResult = { broadcast_id: b.id, sent: 0, failed: 0 }
  if (b.status === 'scheduled') result.materialized = await materialize(db, b)

  const cfg = b.drip
  const dayStart = localDayStart(now, cfg.window?.timezone ?? 'Asia/Kolkata')
  const { count: sentToday } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', b.id)
    .gte('sent_at', dayStart.toISOString())
  const { data: last } = await db
    .from('broadcast_recipients')
    .select('sent_at')
    .eq('broadcast_id', b.id)
    .not('sent_at', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(1)
  const quota = dripQuota(now, cfg, sentToday ?? 0, last?.[0]?.sent_at ? new Date(last[0].sent_at) : null)
  if (quota === 0) {
    result.note = 'waiting (window, pace or daily cap)'
    return result
  }

  // Only languages whose template Meta has approved; the rest wait.
  const approved = await approvedTemplates(db, b.account_id)
  const { data: pending } = await db
    .from('broadcast_recipients')
    .select('id, contact_id, template_params, template_name, template_language')
    .eq('broadcast_id', b.id)
    .eq('status', 'pending')
    .order('created_at')
    .limit(200)
  const ready = (pending ?? []).filter((r) => approved.has(`${r.template_name}|${r.template_language}`)).slice(0, quota)
  if (!ready.length) {
    result.note = pending?.length ? 'waiting for template approval' : undefined
    if (!pending?.length) await finalizeBroadcastStatus(db, b.id)
    return result
  }

  for (const r of ready) {
    const { data: conv } = await db
      .from('conversations')
      .select('id')
      .eq('contact_id', r.contact_id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
    if (!conv?.[0]) {
      await db.from('broadcast_recipients').update({ status: 'failed', error_message: 'no conversation' }).eq('id', r.id)
      result.failed++
      continue
    }
    const tpl = Object.values(cfg.templates).find((t) => t?.name === r.template_name)
    try {
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: b.account_id,
        userId: b.user_id,
        conversationId: conv[0].id,
        contactId: r.contact_id,
        templateName: r.template_name,
        language: r.template_language,
        params: r.template_params ?? [],
        headerMediaUrl: tpl?.header_media_url,
      })
      await db
        .from('broadcast_recipients')
        .update({ status: 'sent', sent_at: new Date().toISOString(), whatsapp_message_id, error_message: null })
        .eq('id', r.id)
      result.sent++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Meta's rate / messaging-limit errors: leave this lead pending and
      // stop for this tick, so they're retried instead of lost.
      if (/131048|131056|130429|131049|rate limit|limit reached/i.test(message)) {
        result.note = `Meta limit: ${message.slice(0, 120)}`
        break
      }
      // Meta took it; only our inbox copy failed — don't send it twice.
      const reachedMeta = message.startsWith('sent to Meta')
      await db
        .from('broadcast_recipients')
        .update(reachedMeta ? { status: 'sent', sent_at: new Date().toISOString(), error_message: message } : { status: 'failed', error_message: message })
        .eq('id', r.id)
      if (reachedMeta) result.sent++
      else result.failed++
    }
  }
  return result
}

/** One minute's worth of drip sending across every due drip broadcast. */
export async function processDrips(now = new Date()): Promise<DripTickResult[]> {
  const db = supabaseAdmin()
  const { data: due } = await db
    .from('broadcasts')
    .select('id, account_id, user_id, status, drip')
    .not('drip', 'is', null)
    .in('status', ['scheduled', 'sending'])
    .lte('scheduled_at', now.toISOString())
  const results: DripTickResult[] = []
  for (const b of (due ?? []) as DripBroadcast[]) {
    // One runner per broadcast: take the lock unless a previous tick
    // still holds it (stale after 3 minutes).
    const staleBefore = new Date(now.getTime() - 3 * 60000).toISOString()
    const { data: locked } = await db
      .from('broadcasts')
      .update({ delivery_locked_at: now.toISOString() })
      .eq('id', b.id)
      .or(`delivery_locked_at.is.null,delivery_locked_at.lt.${staleBefore}`)
      .select('id')
    if (!locked?.length) continue
    try {
      results.push(await tickOne(db, b, now))
    } catch (err) {
      results.push({ broadcast_id: b.id, sent: 0, failed: 0, note: err instanceof Error ? err.message : String(err) })
    } finally {
      await db.from('broadcasts').update({ delivery_locked_at: null }).eq('id', b.id)
    }
  }
  return results
}
