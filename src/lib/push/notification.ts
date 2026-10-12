import { conversationHref } from '@/lib/notifications/browser-notify'
import type { PushPayload } from './send'

/** The `notifications` columns needed to build a push. */
export interface NotificationRow {
  id: string
  type: string
  title: string
  body: string | null
  conversation_id: string | null
  actor_user_id: string | null
}

/**
 * Turn an in-app notification row into a phone push.
 *
 * - Chat assigned → opens the chat. Shares the chat's tag with the
 *   "new message" push, so a brand-new lead shows as one alert, not two.
 * - Follow-up due → opens the chat if there is one, else the list.
 */
export function notificationToPush(n: NotificationRow): PushPayload {
  if (n.type === 'conversation_assigned') {
    // Auto-assignment (round-robin, flow, automation) has no actor and
    // the stored body reads "Someone assigned you…" — say it plainly.
    const body =
      !n.actor_user_id && n.body
        ? n.body.replace(/^Someone assigned you a conversation with /, 'New lead assigned to you: ')
        : n.body ?? ''
    return {
      title: '🆕 ' + n.title,
      body,
      url: n.conversation_id ? conversationHref(n.conversation_id) : '/inbox',
      tag: n.conversation_id ?? `notif-${n.id}`,
    }
  }
  if (n.type === 'follow_up_due') {
    return {
      title: '⏰ ' + n.title,
      body: n.body ?? '',
      url: n.conversation_id ? conversationHref(n.conversation_id) : '/follow-ups',
      tag: `notif-${n.id}`,
    }
  }
  return { title: n.title, body: n.body ?? '', url: '/inbox', tag: `notif-${n.id}` }
}
