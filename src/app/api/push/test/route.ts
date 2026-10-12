import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { pushConfigured, sendPushToUsers } from '@/lib/push/send';

// Sends a test push to every device the caller turned push on for.
export async function POST() {
  try {
    const ctx = await getCurrentAccount();
    if (!pushConfigured()) {
      return NextResponse.json({ error: 'Push is not configured on the server' }, { status: 503 });
    }
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const sent = await sendPushToUsers(db, ctx.accountId, [ctx.userId], {
      title: 'Wangoes DSA CRM',
      body: 'Push notifications are working on this device ✅',
      url: '/inbox',
      tag: 'wacrm-test-push',
    });
    return NextResponse.json({ sent });
  } catch (err) {
    return toErrorResponse(err);
  }
}
