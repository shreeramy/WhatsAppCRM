import webpush from 'web-push'
import type { SupabaseClient } from '@supabase/supabase-js'

// Web Push (mobile / background notifications). Needs three env vars:
//   NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
// Without them every send is a silent no-op, so a deploy that hasn't
// configured push yet behaves exactly as before.

export interface PushPayload {
  title: string
  body: string
  /** Path to open when the notification is tapped. */
  url: string
  /** Same tag replaces an earlier alert (one per conversation). */
  tag?: string
}

let configured: boolean | null = null

export function pushConfigured(): boolean {
  if (configured !== null) return configured
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) return (configured = false)
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    pub,
    priv,
  )
  return (configured = true)
}

/**
 * Push to every device the given users turned push on for. Dead
 * subscriptions (404/410 from the push service) are deleted. Never
 * throws — notification failures must not break message handling.
 * `db` must be a service-role client.
 */
export async function sendPushToUsers(
  db: SupabaseClient,
  accountId: string,
  userIds: string[],
  payload: PushPayload,
): Promise<number> {
  if (!pushConfigured() || userIds.length === 0) return 0
  try {
    const { data: subs, error } = await db
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('account_id', accountId)
      .in('user_id', userIds)
    if (error || !subs?.length) return 0

    const body = JSON.stringify(payload)
    const dead: string[] = []
    let sent = 0
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            { TTL: 60 * 60, urgency: 'high' },
          )
          sent++
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode
          if (code === 404 || code === 410) dead.push(s.id)
          else console.error('[push] send failed:', code, (err as Error).message)
        }
      }),
    )
    if (dead.length) await db.from('push_subscriptions').delete().in('id', dead)
    return sent
  } catch (err) {
    console.error('[push] unexpected error:', err)
    return 0
  }
}

/**
 * Who should hear about a new customer message: the assigned agent, or —
 * for an unassigned chat — the account's owners and admins.
 */
export async function pushRecipientsForConversation(
  db: SupabaseClient,
  accountId: string,
  assignedAgentId: string | null,
): Promise<string[]> {
  if (assignedAgentId) return [assignedAgentId]
  const { data } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('account_role', ['owner', 'admin'])
  return (data ?? []).map((r) => r.user_id as string)
}
