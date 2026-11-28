import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { engineSendText } from '@/lib/automations/meta-send'

// TEMPORARY: send one plain-text message (inside the 24h window) to a list
// of contacts as the account owner. Guarded by PUSH_DISPATCH_SECRET. Remove after use.

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
  const body = (await request.json().catch(() => null)) as { account?: string; contact_ids?: string[]; text?: string } | null
  if (!body?.account || !body.text || !Array.isArray(body.contact_ids) || body.contact_ids.length === 0 || body.contact_ids.length > 50) {
    return NextResponse.json({ error: 'account, text and 1–50 contact_ids required' }, { status: 400 })
  }
  const db = supabaseAdmin()
  const { data: owner } = await db.from('profiles').select('user_id').eq('account_role', 'owner').eq('account_id', body.account).limit(1).single()
  if (!owner) return NextResponse.json({ error: 'No owner' }, { status: 500 })
  const results = []
  for (const contactId of body.contact_ids) {
    const { data: conv } = await db.from('conversations').select('id').eq('contact_id', contactId).eq('account_id', body.account).limit(1).maybeSingle()
    if (!conv) { results.push({ contactId, ok: false, error: 'no conversation' }); continue }
    try {
      await engineSendText({ accountId: body.account, userId: owner.user_id, conversationId: conv.id, contactId, text: body.text })
      results.push({ contactId, ok: true })
    } catch (err) {
      results.push({ contactId, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) })
    }
  }
  return NextResponse.json({ results })
}
