import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { processVoiceCampaigns } from '@/lib/voice/campaign'

// Places the calls of due voice reminder campaigns (migration 064).
// Called every minute by pg_cron while a campaign is due or calling.
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
    return NextResponse.json({ processed: await processVoiceCampaigns(new URL(request.url).origin) })
  } catch (err) {
    console.error('[voice-tick] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'voice tick failed' }, { status: 500 })
  }
}
