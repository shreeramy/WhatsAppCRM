import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { submitMessageTemplate } from '@/lib/whatsapp/meta-api'
import { validateTemplatePayload, type TemplatePayload } from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureMediaHeaderHandle } from '@/lib/whatsapp/template-header-handle'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'

/**
 * Validate → (dry run | upload header media + submit to Meta) → upsert the
 * local message_templates row. Shared by the admin route and internal
 * tooling; `db` decides the access (RLS client or service role).
 * Returns the HTTP status + body the route should send.
 */
export async function submitTemplate(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  payload: TemplatePayload,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (payload.category === 'Authentication') {
    return {
      status: 400,
      body: {
        error:
          'AUTHENTICATION templates are not yet supported here — create them in Meta WhatsApp Manager and use "Sync from Meta".',
      },
    }
  }
  try {
    validateTemplatePayload(payload)
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : 'Validation failed.' } }
  }

  const dryRun =
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' || process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  let metaTemplateId: string
  let metaStatus: string

  if (dryRun) {
    metaTemplateId = `dry-run-${crypto.randomUUID()}`
    metaStatus = 'PENDING'
  } else {
    const { data: config, error: configError } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()
    if (configError || !config) {
      return {
        status: 400,
        body: { error: 'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.' },
      }
    }
    if (!config.waba_id) {
      return {
        status: 400,
        body: { error: 'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.' },
      }
    }
    const accessToken = decrypt(config.access_token)

    // Media headers need a Resumable-Upload handle (Meta rejects a plain URL).
    try {
      await ensureMediaHeaderHandle(payload, accessToken)
    } catch (e) {
      return { status: 400, body: { error: e instanceof Error ? e.message : 'Header media upload failed.' } }
    }

    try {
      const meta = await submitMessageTemplate({
        wabaId: config.waba_id,
        accessToken,
        payload: buildMetaTemplatePayload(payload),
      })
      metaTemplateId = meta.id
      metaStatus = meta.status
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Meta submit failed.'
      // Keep the failed attempt as a DRAFT so it can be fixed and retried.
      await upsertTemplateRow(
        db,
        buildUpsertRow(accountId, userId, payload, { status: 'DRAFT', metaTemplateId: null, submissionError: message }),
      )
      const isRateLimit = /\b429\b/.test(message)
      return {
        status: isRateLimit ? 429 : 502,
        body: { error: isRateLimit ? 'Meta rate limit hit (100 template creates per hour). Try again later.' : message },
      }
    }
  }

  const { data: row, error: upsertErr } = await upsertTemplateRow(
    db,
    buildUpsertRow(accountId, userId, payload, {
      status: normalizeStatus(metaStatus),
      metaTemplateId,
      submissionError: null,
    }),
  )
  if (upsertErr) {
    return {
      status: 500,
      body: {
        error: `Submitted to Meta but failed to save locally: ${upsertErr.message}. Run "Sync from Meta" to recover.`,
        meta_template_id: metaTemplateId,
      },
    }
  }
  return { status: 200, body: { success: true, template: row, dry_run: dryRun } }
}

/**
 * Shared upsert payload builder — both the Meta-failure path and the
 * Meta-success path write nearly identical rows.
 */
function buildUpsertRow(
  accountId: string,
  userId: string,
  payload: TemplatePayload,
  extras: { status: 'DRAFT' | string; metaTemplateId: string | null; submissionError: string | null },
) {
  return {
    // Account tenancy — required NOT NULL on message_templates (017).
    account_id: accountId,
    // Original author — audit only; the unique index is still on
    // (user_id, name, language).
    user_id: userId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    status: extras.status,
    meta_template_id: extras.metaTemplateId,
    submission_error: extras.submissionError,
    // Cleared on every re-submit; the webhook sets it again if Meta rejects.
    rejection_reason: null,
    last_submitted_at: new Date().toISOString(),
  }
}

function upsertTemplateRow(db: SupabaseClient, row: ReturnType<typeof buildUpsertRow>) {
  // TODO(account-sharing): conflict target is still scoped to user_id.
  return db.from('message_templates').upsert(row, { onConflict: 'user_id,name,language' }).select().single()
}
