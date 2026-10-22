import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import type { V2Routing } from '@/lib/flows/v2/settings'

// Traffic switch for a v2 flow (flow_engine_settings.settings.routing):
//   off  — nobody gets v2; the original flow handles everyone
//   test — only the allow-listed test numbers get v2
//   live — everyone gets v2; the flow it replaces stops starting runs
// Admins only (RLS on flow_engine_settings enforces it too).

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const { data, error } = await ctx.supabase
      .from('flow_engine_settings')
      .select('settings')
      .eq('flow_id', id)
      .maybeSingle()
    if (error) throw error
    if (!data) return NextResponse.json({ v2: false })
    const s = data.settings as {
      routing?: V2Routing
      test_phones?: string[]
      replaces_flow_id?: string | null
      agent_pool?: string[]
    }
    // Team members who can be in the lead-assignment pool.
    const { data: members } = await ctx.supabase
      .from('profiles')
      .select('user_id, full_name, account_role')
      .eq('account_id', ctx.accountId)
      .order('full_name')
    return NextResponse.json({
      v2: true,
      routing: s.routing ?? 'off',
      test_phones: s.test_phones ?? [],
      replaces_flow_id: s.replaces_flow_id ?? null,
      agent_pool: s.agent_pool ?? [],
      members: (members ?? []).map((m) => ({ id: m.user_id, name: m.full_name ?? '—', role: m.account_role })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as {
      routing?: V2Routing
      test_phones?: string[]
      agent_pool?: string[]
    } | null
    if (!body || (body.routing && !['off', 'test', 'live'].includes(body.routing))) {
      return NextResponse.json({ error: 'routing must be off, test or live' }, { status: 400 })
    }
    const { data, error } = await ctx.supabase
      .from('flow_engine_settings')
      .select('settings')
      .eq('flow_id', id)
      .maybeSingle()
    if (error) throw error
    if (!data) return NextResponse.json({ error: 'Not a v2 flow' }, { status: 404 })

    const next = { ...(data.settings as Record<string, unknown>) }
    if (body.routing) next.routing = body.routing
    if (Array.isArray(body.test_phones)) {
      next.test_phones = body.test_phones.map((p) => String(p).trim()).filter(Boolean).slice(0, 50)
    }
    if (Array.isArray(body.agent_pool)) {
      // Only members of this account; at least one, so new leads always get an owner.
      const wanted = [...new Set(body.agent_pool.map(String))]
      const { data: valid } = await ctx.supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', ctx.accountId)
        .in('user_id', wanted.length ? wanted : ['00000000-0000-0000-0000-000000000000'])
      const pool = (valid ?? []).map((v) => v.user_id as string)
      if (!pool.length) {
        return NextResponse.json({ error: 'Pick at least one team member' }, { status: 400 })
      }
      next.agent_pool = pool
    }
    const { error: updErr } = await ctx.supabase
      .from('flow_engine_settings')
      .update({ settings: next, updated_at: new Date().toISOString() })
      .eq('flow_id', id)
    if (updErr) throw updErr
    return NextResponse.json({ ok: true, routing: next.routing, test_phones: next.test_phones, agent_pool: next.agent_pool })
  } catch (err) {
    return toErrorResponse(err)
  }
}
