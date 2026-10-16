import { NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { POST as webhookPOST } from '@/app/api/whatsapp/webhook/route'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { phoneInList } from '@/lib/flows/v2/settings'

// Test harness entry for scripts/simulate-flow-v2.mjs: replays a
// WhatsApp webhook payload through the real webhook handler, signed
// server-side. Locked down twice:
//   - x-push-secret must match PUSH_DISPATCH_SECRET
//   - every sender must be on a v2 flow's `sim_phones` list (fake test
//     numbers), so it can never inject messages for real contacts.

export const maxDuration = 60

function secretMatches(given: string | null): boolean {
  const expected = process.env.PUSH_DISPATCH_SECRET
  if (!expected || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  if (!secretMatches(request.headers.get('x-push-secret'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const raw = await request.text()
  let body: { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ from?: string }> } }> }> }
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { data } = await supabaseAdmin().from('flow_engine_settings').select('settings')
  const allowed = (data ?? []).flatMap((r) => ((r.settings as { sim_phones?: string[] }).sim_phones ?? []))
  const senders = (body.entry ?? []).flatMap((e) =>
    (e.changes ?? []).flatMap((c) => (c.value?.messages ?? []).map((m) => m.from ?? '')),
  )
  if (!senders.length || !senders.every((p) => phoneInList(p, allowed))) {
    return NextResponse.json({ error: 'Only simulation numbers are accepted' }, { status: 403 })
  }

  const secret = (process.env.META_APP_SECRET ?? '').split(',')[0].trim()
  if (!secret) return NextResponse.json({ error: 'META_APP_SECRET missing' }, { status: 503 })
  const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
  return webhookPOST(
    new Request(new URL('/api/whatsapp/webhook', request.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
    }),
  )
}
