import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { processDrips } from '@/lib/broadcast-drip-run'

// Sends the next few messages of paced ("drip") broadcasts. Called every
// minute by pg_cron via pg_net (migration 063) while one is due.
// Auth: the shared PUSH_DISPATCH_SECRET.

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
    return NextResponse.json({ processed: await processDrips() })
  } catch (err) {
    console.error('[broadcast-drip] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'drip failed' }, { status: 500 })
  }
}
