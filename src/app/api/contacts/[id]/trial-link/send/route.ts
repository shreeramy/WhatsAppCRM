import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { engineSendTemplate } from '@/lib/automations/meta-send';
import { getTrialLink } from '@/lib/dsa-trial/issue';
import { loadV2Flows } from '@/lib/flows/v2/engine';
import { pickBundle } from '@/lib/flows/v2/settings';

// POST: send the contact their stored free-trial link as an approved
// template — used by the inbox when the 24h window is closed (inside the
// window the inbox sends it as plain text). The template names live in the
// v2 flow settings (`trial_link_templates`); body {{1}} = link, {{2}} = expiry.
// Never creates a link: the agent must have one already.

function expiryDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: timezone }).format(new Date(iso));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as { conversation_id?: string } | null;
    const conversationId = body?.conversation_id;
    if (!conversationId) return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 });

    const { data: contact } = await ctx.supabase
      .from('contacts')
      .select('id, phone')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    const { data: conv } = await ctx.supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('contact_id', id)
      .maybeSingle();
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

    const db = supabaseAdmin();
    const link = await getTrialLink(db, { accountId: ctx.accountId, contactId: id });
    if (link?.status !== 'issued') {
      return NextResponse.json({ error: 'No active trial link for this contact' }, { status: 409 });
    }

    const bundle = pickBundle(await loadV2Flows(db, ctx.accountId), contact.phone as string | null);
    const templates = bundle?.settings.trial_link_templates;
    if (!templates?.en) {
      return NextResponse.json({ error: 'Trial-link template is not configured' }, { status: 503 });
    }

    // The language the lead last used with the welcome flow.
    const { data: run } = await db
      .from('flow_runs')
      .select('vars')
      .eq('contact_id', id)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const lang = (run?.vars as { lang?: string } | null)?.lang === 'hi' && templates.hi ? 'hi' : 'en';
    const tpl = templates[lang] ?? templates.en;

    await engineSendTemplate({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId,
      contactId: id,
      templateName: tpl.name,
      language: tpl.language,
      params: [link.url, expiryDate(link.expiresAt, bundle!.settings.working_hours.timezone)],
    });
    return NextResponse.json({ ok: true, via: 'template' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 401 || status === 403) return toErrorResponse(error);
    const message = error instanceof Error ? error.message : String(error);
    // Meta's reason helps the agent (e.g. template paused); it never contains the link.
    return NextResponse.json({ error: message.slice(0, 200) }, { status: 502 });
  }
}
