// ============================================================
// Voice reminder campaigns over Plivo (migration 064).
//
//   scheduled → (scheduled_at reached) one queued call per contact
//   calling   → each tick dials queued calls (≈2 per second) and
//               queues a retry for no-answer / busy after a few minutes
//   done      → nothing queued, dialing or waiting for a retry
//
// Plivo calls back answer / digits / hangup URLs that carry an HMAC of
// the call row id, so only calls we placed can trigger a WhatsApp send.
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendTemplate } from '@/lib/automations/meta-send'
import { greetingName } from '@/lib/broadcast-drip'

export interface VoiceCampaign {
  id: string
  account_id: string
  name: string
  audio_url: string
  tag: string | null
  contact_ids: string[] | null
  join_link: string | null
  wa_templates: Record<string, { name: string; language: string }> | null
  scheduled_at: string
  retry_after_minutes: number
  max_attempts: number
  status: 'scheduled' | 'calling' | 'done' | 'cancelled'
}

const RETRY_STATUSES = ['no_answer', 'busy', 'failed']
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function callToken(callId: string): string {
  return createHmac('sha256', process.env.PUSH_DISPATCH_SECRET ?? '').update(`voice:${callId}`).digest('hex').slice(0, 32)
}

export function tokenOk(callId: string | null, token: string | null): boolean {
  if (!callId || !token || !process.env.PUSH_DISPATCH_SECRET) return false
  const a = Buffer.from(callToken(callId))
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Plivo hangup cause → our status. */
export function statusFromHangup(cause: string, durationSeconds: number, answered: boolean): string {
  const c = cause.toLowerCase().replace(/_/g, ' ')
  if (answered || durationSeconds > 0) return 'answered'
  if (c.includes('busy')) return 'busy'
  if (c.includes('no answer') || c.includes('timeout') || c.includes('cancel') || c.includes('rejected')) return 'no_answer'
  return 'failed'
}

async function materialize(db: SupabaseClient, c: VoiceCampaign): Promise<number> {
  let ids: string[] = c.contact_ids ?? []
  if (!ids.length && c.tag) {
    const { data } = await db
      .from('contact_tags')
      .select('contact_id, tags!inner(name, account_id)')
      .eq('tags.account_id', c.account_id)
      .ilike('tags.name', c.tag)
    ids = (data ?? []).map((r) => r.contact_id as string)
  }
  const { data: contacts } = ids.length
    ? await db.from('contacts').select('id, phone, blocked_at').eq('account_id', c.account_id).in('id', ids)
    : { data: [] as Array<{ id: string; phone: string | null; blocked_at: string | null }> }
  const rows = (contacts ?? [])
    .filter((x) => x.phone && !x.blocked_at)
    .map((x) => ({ campaign_id: c.id, contact_id: x.id, phone: x.phone!.replace(/\D/g, ''), attempt: 1 }))
  if (rows.length) {
    const { error } = await db.from('voice_campaign_calls').upsert(rows, { onConflict: 'campaign_id,contact_id,attempt', ignoreDuplicates: true })
    if (error) throw new Error(`queue calls: ${error.message}`)
  }
  await db.from('voice_campaigns').update({ status: 'calling' }).eq('id', c.id)
  return rows.length
}

async function dial(baseUrl: string, call: { id: string; phone: string }): Promise<string> {
  const id = process.env.PLIVO_AUTH_ID
  const token = process.env.PLIVO_AUTH_TOKEN
  const from = process.env.PLIVO_FROM_NUMBER
  if (!id || !token || !from) throw new Error('PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN / PLIVO_FROM_NUMBER not set')
  const q = `c=${call.id}&k=${callToken(call.id)}`
  const res = await fetch(`https://api.plivo.com/v1/Account/${id}/Call/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${id}:${token}`).toString('base64')}` },
    body: JSON.stringify({
      from: from.replace(/\D/g, ''),
      to: call.phone,
      answer_url: `${baseUrl}/api/voice/answer?${q}`,
      answer_method: 'POST',
      hangup_url: `${baseUrl}/api/voice/hangup?${q}`,
      hangup_method: 'POST',
      ring_timeout: 30,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as { request_uuid?: string; error?: string; message?: string }
  if (!res.ok || !body.request_uuid) throw new Error(`Plivo ${res.status}: ${body.error ?? body.message ?? 'no request_uuid'}`)
  return body.request_uuid
}

async function tickOne(db: SupabaseClient, c: VoiceCampaign, baseUrl: string, now: Date, deadline: number) {
  const out = { campaign: c.name, queued: 0, dialed: 0, failed: 0, retries: 0, done: false }
  if (c.status === 'scheduled') out.queued = await materialize(db, c)

  // Retries: an unanswered first attempt, a few minutes later.
  const cutoff = new Date(now.getTime() - c.retry_after_minutes * 60000).toISOString()
  const { data: retry } = await db
    .from('voice_campaign_calls')
    .select('id, contact_id, phone, attempt')
    .eq('campaign_id', c.id)
    .in('status', RETRY_STATUSES)
    .lt('attempt', c.max_attempts)
    .lt('updated_at', cutoff)
  for (const r of retry ?? []) {
    const { data: answeredSince } = await db
      .from('voice_campaign_calls')
      .select('id')
      .eq('campaign_id', c.id)
      .eq('contact_id', r.contact_id)
      .gt('attempt', r.attempt)
      .limit(1)
    if (answeredSince?.length) continue
    const { error } = await db
      .from('voice_campaign_calls')
      .insert({ campaign_id: c.id, contact_id: r.contact_id, phone: r.phone, attempt: r.attempt + 1 })
    if (!error) {
      // The first attempt keeps its hangup cause; it just isn't retried again.
      await db.from('voice_campaign_calls').update({ status: 'retried' }).eq('id', r.id)
      out.retries++
    }
  }

  const { data: queued } = await db
    .from('voice_campaign_calls')
    .select('id, phone')
    .eq('campaign_id', c.id)
    .eq('status', 'queued')
    .order('attempt')
    .limit(60)
  for (const call of queued ?? []) {
    if (Date.now() > deadline) break
    // Claim it so an overlapping tick can't dial twice.
    const { data: claimed } = await db
      .from('voice_campaign_calls')
      .update({ status: 'dialing', updated_at: new Date().toISOString() })
      .eq('id', call.id)
      .eq('status', 'queued')
      .select('id')
    if (!claimed?.length) continue
    try {
      const uuid = await dial(baseUrl, call)
      await db.from('voice_campaign_calls').update({ request_uuid: uuid }).eq('id', call.id)
      out.dialed++
    } catch (err) {
      await db
        .from('voice_campaign_calls')
        .update({ status: 'failed', error: err instanceof Error ? err.message : String(err), updated_at: new Date().toISOString() })
        .eq('id', call.id)
      out.failed++
    }
    await sleep(500)
  }

  // Finished: nothing queued or ringing, and no retry still to come.
  const { count: open } = await db
    .from('voice_campaign_calls')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', c.id)
    .in('status', ['queued', 'dialing'])
  const { count: retryable } = await db
    .from('voice_campaign_calls')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', c.id)
    .in('status', RETRY_STATUSES)
    .lt('attempt', c.max_attempts)
  const stale = now.getTime() - Date.parse(c.scheduled_at) > 90 * 60000
  if ((!open && !retryable && !out.retries && !out.queued) || stale) {
    await db.from('voice_campaigns').update({ status: 'done' }).eq('id', c.id)
    out.done = true
  }
  return out
}

export async function processVoiceCampaigns(baseUrl: string, now = new Date()) {
  const db = supabaseAdmin()
  const deadline = Date.now() + 45000
  const { data } = await db
    .from('voice_campaigns')
    .select('*')
    .or(`and(status.eq.scheduled,scheduled_at.lte.${now.toISOString()}),status.eq.calling`)
  const results = []
  for (const c of (data ?? []) as VoiceCampaign[]) results.push(await tickOne(db, c, baseUrl, now, deadline))
  return results
}

/** The lead pressed 1: send the joining link on WhatsApp. */
export async function sendJoinLink(callId: string): Promise<boolean> {
  const db = supabaseAdmin()
  const { data: call } = await db
    .from('voice_campaign_calls')
    .select('contact_id, campaign:voice_campaigns(account_id, join_link, wa_templates)')
    .eq('id', callId)
    .single()
  const camp = (Array.isArray(call?.campaign) ? call?.campaign[0] : call?.campaign) as
    | { account_id: string; join_link: string | null; wa_templates: VoiceCampaign['wa_templates'] }
    | undefined
  if (!call || !camp?.join_link || !camp.wa_templates) return false
  const [{ data: contact }, { data: conv }, { data: runs }, { data: owner }] = await Promise.all([
    db.from('contacts').select('name').eq('id', call.contact_id).single(),
    db.from('conversations').select('id').eq('contact_id', call.contact_id).order('last_message_at', { ascending: false, nullsFirst: false }).limit(1),
    db.from('flow_runs').select('vars').eq('contact_id', call.contact_id).order('started_at', { ascending: false }).limit(1),
    db.from('profiles').select('user_id').eq('account_id', camp.account_id).eq('account_role', 'owner').limit(1).single(),
  ])
  if (!conv?.[0] || !owner) return false
  const lang = (runs?.[0]?.vars as { lang?: string } | null)?.lang === 'hi' && camp.wa_templates.hi ? 'hi' : 'en'
  const tpl = camp.wa_templates[lang] ?? camp.wa_templates.en
  await engineSendTemplate({
    accountId: camp.account_id,
    userId: owner.user_id,
    conversationId: conv[0].id,
    contactId: call.contact_id,
    templateName: tpl.name,
    language: tpl.language,
    params: [greetingName(contact?.name, lang), camp.join_link],
  })
  return true
}

export async function campaignAudioFor(callId: string): Promise<string | null> {
  const db = supabaseAdmin()
  const { data } = await db.from('voice_campaign_calls').select('campaign:voice_campaigns(audio_url)').eq('id', callId).single()
  const camp = (Array.isArray(data?.campaign) ? data?.campaign[0] : data?.campaign) as { audio_url: string } | undefined
  return camp?.audio_url ?? null
}
