import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse, ForbiddenError } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { logOutcome } from '@/lib/call-next/server'
import type { Outcome } from '@/lib/call-next/queue'

const OUTCOMES: Outcome[] = ['demo_booked', 'will_pay', 'call_later', 'no_answer', 'not_interested']

// POST /api/call-next/outcome
// { contactId, conversationId?, outcome, at?, reason?, note? }
// Saves what happened on the call and does the follow-on work (tags,
// deal stage, next follow-up). The caller must be able to see the contact.
export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    if (ctx.role === 'viewer') throw new ForbiddenError('Viewers cannot log calls')
    const body = (await request.json().catch(() => null)) as {
      contactId?: string
      conversationId?: string | null
      outcome?: Outcome
      at?: string | null
      reason?: string | null
      note?: string | null
    } | null
    if (!body?.contactId || !body.outcome || !OUTCOMES.includes(body.outcome)) {
      return NextResponse.json({ error: 'contactId and a valid outcome are required' }, { status: 400 })
    }

    // Access check through RLS: agents only see their own chats.
    const { data: visible } = await ctx.supabase.from('contacts').select('id').eq('id', body.contactId).maybeSingle()
    if (!visible) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    const done = await logOutcome(supabaseAdmin(), {
      accountId: ctx.accountId,
      agentId: ctx.userId,
      contactId: body.contactId,
      conversationId: body.conversationId ?? null,
      outcome: body.outcome,
      at: body.at ?? null,
      reason: body.reason ?? null,
      note: body.note ?? null,
    })
    return NextResponse.json({ ok: true, done })
  } catch (err) {
    if (err instanceof Error && err.message === 'Pick a time') {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    return toErrorResponse(err)
  }
}
