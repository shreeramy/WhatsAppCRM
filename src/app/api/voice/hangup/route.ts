import { statusFromHangup, tokenOk } from '@/lib/voice/campaign'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// Plivo hangup URL: record how the call ended (answered / no answer / busy).

export async function POST(request: Request) {
  const url = new URL(request.url)
  const id = url.searchParams.get('c')
  if (!tokenOk(id, url.searchParams.get('k'))) return new Response('ok')
  const form = await request.formData().catch(() => null)
  const cause = String(form?.get('HangupCause') ?? form?.get('CallStatus') ?? '')
  const duration = Number(form?.get('Duration') ?? form?.get('BillDuration') ?? 0) || 0
  const db = supabaseAdmin()
  const { data: row } = await db.from('voice_campaign_calls').select('status').eq('id', id!).single()
  const answered = row?.status === 'answered' || row?.status === 'link_sent'
  await db
    .from('voice_campaign_calls')
    .update({
      status: row?.status === 'link_sent' ? 'link_sent' : statusFromHangup(cause, duration, answered),
      hangup_cause: cause || null,
      duration_seconds: duration,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id!)
  return new Response('ok')
}

export const GET = POST
