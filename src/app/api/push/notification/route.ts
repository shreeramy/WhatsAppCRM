import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import { notificationToPush, type NotificationRow } from '@/lib/push/notification';
import { sendPushToUsers } from '@/lib/push/send';

// Called by the database (pg_net trigger, migration 056) for every new
// in-app notification — chat assigned, follow-up due — and mirrors it
// to the recipient's phones as a Web Push.
//
// Auth: shared secret in `x-push-secret` (PUSH_DISPATCH_SECRET). Only
// the notification id is sent; the row is re-read here.

function secretMatches(given: string | null): boolean {
  const expected = process.env.PUSH_DISPATCH_SECRET;
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!secretMatches(request.headers.get('x-push-secret'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data: n, error } = await db
    .from('notifications')
    .select('id, account_id, user_id, type, title, body, conversation_id, actor_user_id')
    .eq('id', body.id)
    .maybeSingle();
  if (error || !n) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const sent = await sendPushToUsers(
    db,
    n.account_id as string,
    [n.user_id as string],
    notificationToPush(n as NotificationRow),
  );
  return NextResponse.json({ sent });
}
