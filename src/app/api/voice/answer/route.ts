import { campaignAudioFor, callToken, tokenOk } from '@/lib/voice/campaign'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// Plivo answer URL: play the campaign's recording and listen for "1".

const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { 'Content-Type': 'application/xml' },
  })
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export async function POST(request: Request) {
  const url = new URL(request.url)
  const id = url.searchParams.get('c')
  if (!tokenOk(id, url.searchParams.get('k'))) return xml('<Hangup/>')
  const audio = await campaignAudioFor(id!)
  if (!audio) return xml('<Hangup/>')
  await supabaseAdmin()
    .from('voice_campaign_calls')
    .update({ status: 'answered', updated_at: new Date().toISOString() })
    .eq('id', id!)
  const action = `${url.origin}/api/voice/digits?c=${id}&k=${callToken(id!)}`
  return xml(
    `<GetDigits action="${esc(action)}" method="POST" numDigits="1" timeout="7" validDigits="1" retries="1" redirect="true">` +
      `<Play>${esc(audio)}</Play>` +
      `</GetDigits>`,
  )
}

export const GET = POST
