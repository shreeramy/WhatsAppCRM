import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { MetaApiError, setUserBlocked } from '@/lib/whatsapp/meta-api';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';

// Block / unblock a contact (owners and admins only).
//
// The app-level flag (contacts.blocked_at) is always set — the webhook
// drops a blocked contact's messages — and Meta's block_users call is
// best-effort on top: it can be refused (e.g. the person hasn't messaged
// in the last 24h), in which case the response says so via `meta`.

async function handle(contactId: string, blocked: boolean) {
  const ctx = await requireRole('admin');
  const db = ctx.supabase;

  const { data: contact } = await db
    .from('contacts')
    .select('id, phone, wa_user_id, wa_username')
    .eq('id', contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  }

  // Meta first (best-effort), then our own flag.
  let meta: { ok: boolean; error?: string } = { ok: false, error: 'not attempted' };
  const target = resolveContactSendTarget(contact);
  const { data: config } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (target && config?.phone_number_id && config.access_token) {
    try {
      await setUserBlocked({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
        user: target.target,
        blocked,
      });
      meta = { ok: true };
    } catch (err) {
      meta = {
        ok: false,
        error: err instanceof MetaApiError || err instanceof Error ? err.message : 'Meta error',
      };
      console.warn('[contacts/block] Meta block_users failed:', meta.error);
    }
  } else {
    meta = { ok: false, error: 'WhatsApp is not connected' };
  }

  const { error } = await db
    .from('contacts')
    .update(
      blocked
        ? { blocked_at: new Date().toISOString(), blocked_by: ctx.userId }
        : { blocked_at: null, blocked_by: null },
    )
    .eq('id', contactId)
    .eq('account_id', ctx.accountId);
  if (error) {
    return NextResponse.json({ error: 'Failed to update contact' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, blocked, meta });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return await handle(id, true);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return await handle(id, false);
  } catch (error) {
    return toErrorResponse(error);
  }
}
