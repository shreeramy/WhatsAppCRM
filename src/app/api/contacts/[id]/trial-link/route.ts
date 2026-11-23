import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { getOrIssueTrialLink, getTrialLink, trialNote, type TrialLinkState } from '@/lib/dsa-trial/issue';

// A contact's DSA Management free-trial link (agents and up).
//
//   GET  → the stored link, if any (never calls DSA Management)
//   POST → the stored link, or a new one from DSA Management
//
// The API key stays on the server (lib/dsa-trial/client). Responses
// carry only the link, its expiry, or a status the UI turns into the
// friendly "not available" message — never the other server's error.

function toJson(state: TrialLinkState | null) {
  if (!state) return { status: 'none' as const };
  if (state.status === 'issued') return { status: 'issued' as const, url: state.url, expires_at: state.expiresAt };
  if (state.status === 'expired') return { status: 'expired' as const, expires_at: state.expiresAt };
  return { status: 'unavailable' as const };
}

async function loadContact(contactId: string) {
  const ctx = await requireRole('agent');
  const { data: contact } = await ctx.supabase
    .from('contacts')
    .select('id, name, phone')
    .eq('id', contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  return { ctx, contact: contact as { id: string; name: string | null; phone: string | null } | null };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { ctx, contact } = await loadContact(id);
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    const state = await getTrialLink(supabaseAdmin(), { accountId: ctx.accountId, contactId: contact.id });
    return NextResponse.json(toJson(state), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { ctx, contact } = await loadContact(id);
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    const state = await getOrIssueTrialLink(supabaseAdmin(), {
      accountId: ctx.accountId,
      contactId: contact.id,
      source: 'agent',
      requestedBy: ctx.userId,
      note: trialNote({ who: 'CRM lead', name: contact.name, phone: contact.phone, contactId: contact.id }),
    });
    return NextResponse.json(toJson(state), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
