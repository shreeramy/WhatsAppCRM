import { describe, expect, it } from 'vitest'
import { notificationToPush } from './notification'

const base = { id: 'n1', body: null, conversation_id: null, actor_user_id: null }

describe('notificationToPush', () => {
  it('rewrites the system assignment body and shares the chat tag', () => {
    expect(
      notificationToPush({
        ...base,
        type: 'conversation_assigned',
        title: 'New conversation assigned',
        body: 'Someone assigned you a conversation with Ravi',
        conversation_id: 'c1',
      }),
    ).toEqual({
      title: '🆕 New conversation assigned',
      body: 'New lead assigned to you: Ravi',
      url: '/inbox?c=c1',
      tag: 'c1',
    })
  })

  it('keeps the body when a teammate assigned it', () => {
    const p = notificationToPush({
      ...base,
      type: 'conversation_assigned',
      title: 'New conversation assigned',
      body: 'Rahul Patel assigned you a conversation with Ravi',
      conversation_id: 'c1',
      actor_user_id: 'u1',
    })
    expect(p.body).toBe('Rahul Patel assigned you a conversation with Ravi')
  })

  it('links a follow-up without a chat to the follow-ups page', () => {
    expect(
      notificationToPush({ ...base, type: 'follow_up_due', title: 'Follow-up due: Call back', body: 'Ravi' }),
    ).toEqual({ title: '⏰ Follow-up due: Call back', body: 'Ravi', url: '/follow-ups', tag: 'notif-n1' })
  })
})
