import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse, ForbiddenError } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadCallNext } from '@/lib/call-next/server'

// GET /api/call-next[?agent=<userId>]
// The signed-in agent's call queue. Owners/admins may pass ?agent= to see
// a teammate's queue; they also get the team list for the picker.
export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const isAdmin = ctx.role === 'owner' || ctx.role === 'admin'
    const requested = new URL(request.url).searchParams.get('agent')
    const agentId = requested && requested !== ctx.userId ? requested : ctx.userId
    if (agentId !== ctx.userId && !isAdmin) throw new ForbiddenError('Only admins can view a teammate’s queue')

    const db = supabaseAdmin()
    if (agentId !== ctx.userId) {
      const { data: member } = await db.from('profiles').select('user_id').eq('account_id', ctx.accountId).eq('user_id', agentId).maybeSingle()
      if (!member) return NextResponse.json({ error: 'Not a member of this account' }, { status: 404 })
    }
    const data = await loadCallNext(db, ctx.accountId, agentId)
    let team: Array<{ userId: string; name: string }> | undefined
    if (isAdmin) {
      const { data: members } = await db
        .from('profiles')
        .select('user_id, full_name, email')
        .eq('account_id', ctx.accountId)
        .order('full_name')
      team = (members ?? []).map((m) => ({ userId: m.user_id as string, name: (m.full_name as string) || (m.email as string) }))
    }
    return NextResponse.json({ ...data, agentId, team })
  } catch (err) {
    return toErrorResponse(err)
  }
}
