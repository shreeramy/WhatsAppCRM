import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { submitTemplate } from '@/lib/whatsapp/template-submit'

/**
 * Submit a template to Meta for approval AND persist it locally.
 *
 * Auth → validate → (DRY_RUN short-circuit) → POST to Meta → upsert the
 * local row by (user_id, name, language). The work lives in
 * submitTemplate(); this route only adds the admin check.
 *
 * When WHATSAPP_TEMPLATES_DRY_RUN=true, the network call is skipped and a
 * row with a synthetic `dry-run-<uuid>` meta_template_id is inserted.
 */
export async function POST(request: Request) {
  try {
    // Message templates are settings-class data: `canEditSettings` and the
    // message_templates_insert/update RLS policies (migration 017) both
    // require 'admin'. A viewer or agent must not push a template to Meta
    // — an external side effect RLS can't roll back.
    const { supabase, accountId, userId } = await requireRole('admin')

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    const result = await submitTemplate(supabase, accountId, userId, payload)
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    // Auth failures map to 401/403 rather than a generic 500.
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    console.error('Error submitting template:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to submit template.' },
      { status: 500 },
    )
  }
}
