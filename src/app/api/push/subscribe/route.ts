import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

// Save / remove this device's Web Push subscription for the signed-in user.
//
//   POST   { endpoint, keys: { p256dh, auth } }
//   DELETE { endpoint }
//
// The save goes through the service role so a phone that was used by
// another teammate before (same endpoint) is handed over cleanly.

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    } | null;
    const endpoint = body?.endpoint;
    const p256dh = body?.keys?.p256dh;
    const auth = body?.keys?.auth;
    if (!endpoint?.startsWith('https://') || !p256dh || !auth) {
      return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 });
    }

    const db = admin();
    await db.from('push_subscriptions').delete().eq('endpoint', endpoint);
    const { error } = await db.from('push_subscriptions').insert({
      user_id: ctx.userId,
      account_id: ctx.accountId,
      endpoint,
      p256dh,
      auth,
      user_agent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
    });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as { endpoint?: string } | null;
    if (body?.endpoint) {
      await ctx.supabase.from('push_subscriptions').delete().eq('endpoint', body.endpoint);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
