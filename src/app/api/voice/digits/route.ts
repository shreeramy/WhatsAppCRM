import { sendJoinLink, tokenOk } from '@/lib/voice/campaign'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// Plivo GetDigits action: "1" → send the joining link on WhatsApp.

const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { 'Content-Type': 'application/xml' },
  })

export async function POST(request: Request) {
  const url = new URL(request.url)
  const id = url.searchParams.get('c')
  if (!tokenOk(id, url.searchParams.get('k'))) return xml('<Hangup/>')
  const form = await request.formData().catch(() => null)
  const digits = String(form?.get('Digits') ?? '')
  const db = supabaseAdmin()
  if (digits !== '1') {
    await db.from('voice_campaign_calls').update({ digits, updated_at: new Date().toISOString() }).eq('id', id!)
    return xml('<Hangup/>')
  }
  let sent = false
  let error: string | null = null
  try {
    sent = await sendJoinLink(id!)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  await db
    .from('voice_campaign_calls')
    .update({ digits, status: sent ? 'link_sent' : 'answered', error, updated_at: new Date().toISOString() })
    .eq('id', id!)
  return xml(
    sent
      ? '<Speak voice="Polly.Aditi" language="hi-IN">धन्यवाद! Joining link आपके WhatsApp पर भेज दिया है। मिलते हैं 9 बजे।</Speak>'
      : '<Speak voice="Polly.Aditi" language="hi-IN">धन्यवाद! हमारी team आपको link भेज रही है।</Speak>',
  )
}
