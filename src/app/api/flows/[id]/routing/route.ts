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
    const s = data.settings as { routing?: V2Routing; test_phones?: string[]; replaces_flow_id?: string | null }
    return NextResponse.json({
      v2: true,
      routing: s.routing ?? 'off',
      test_phones: s.test_phones ?? [],
      replaces_flow_id: s.replaces_flow_id ?? null,
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
    const { error: updErr } = await ctx.supabase
      .from('flow_engine_settings')
      .update({ settings: next, updated_at: new Date().toISOString() })
      .eq('flow_id', id)
    if (updErr) throw updErr
    return NextResponse.json({ ok: true, routing: next.routing, test_phones: next.test_phones })
  } catch (err) {
    return toErrorResponse(err)
  }
}
