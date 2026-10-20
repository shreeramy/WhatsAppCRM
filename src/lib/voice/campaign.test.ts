import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/automations/meta-send', () => ({ engineSendTemplate: vi.fn() }))

import { callToken, statusFromHangup, tokenOk } from './campaign'

describe('voice campaign helpers', () => {
  it('maps Plivo hangup causes', () => {
    expect(statusFromHangup('NORMAL_CLEARING', 24, false)).toBe('answered')
    expect(statusFromHangup('NO_ANSWER', 0, false)).toBe('no_answer')
    expect(statusFromHangup('USER_BUSY', 0, false)).toBe('busy')
    expect(statusFromHangup('ORIGINATOR_CANCEL', 0, false)).toBe('no_answer')
    expect(statusFromHangup('UNALLOCATED_NUMBER', 0, false)).toBe('failed')
    expect(statusFromHangup('NORMAL_CLEARING', 0, true)).toBe('answered')
  })
  it('only our own call ids pass the callback token check', () => {
    process.env.PUSH_DISPATCH_SECRET = 'test-secret'
    const t = callToken('abc')
    expect(tokenOk('abc', t)).toBe(true)
    expect(tokenOk('abd', t)).toBe(false)
    expect(tokenOk('abc', null)).toBe(false)
  })
})
