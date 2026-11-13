import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { submitTemplate } from '@/lib/whatsapp/template-submit'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'

// TEMPORARY: submit a batch of templates as the account owner from a
// script (the admin route needs a browser session). Guarded by
// PUSH_DISPATCH_SECRET. Remove after use.

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
  const payloads = (await request.json().catch(() => null)) as TemplatePayload[] | null
  if (!Array.isArray(payloads) || payloads.length === 0 || payloads.length > 20) {
    return NextResponse.json({ error: 'Send 1–20 templates' }, { status: 400 })
  }
  const db = supabaseAdmin()
  const { data: owner } = await db.from('profiles').select('user_id, account_id').eq('account_role', 'owner').limit(1).single()
  if (!owner) return NextResponse.json({ error: 'No owner' }, { status: 500 })
  const results = []
  for (const p of payloads) {
    const r = await submitTemplate(db, owner.account_id, owner.user_id, p)
    results.push({ name: p.name, language: p.language, status: r.status, result: r.body.error ?? (r.body.template as { status?: string } | undefined)?.status })
  }
  return NextResponse.json({ results })
}
