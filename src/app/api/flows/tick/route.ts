import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { processDueJobs } from '@/lib/flows/v2/engine'

// Runs due flow-v2 jobs (video nudges, auto-close of "not a fit" chats).
// Called every minute by pg_cron via pg_net (migration 057) — only when
// a job is actually due. Auth: the shared PUSH_DISPATCH_SECRET.

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
  try {
    const processed = await processDueJobs()
    return NextResponse.json({ processed })
  } catch (err) {
    console.error('[flows-tick] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'tick failed' }, { status: 500 })
  }
}
