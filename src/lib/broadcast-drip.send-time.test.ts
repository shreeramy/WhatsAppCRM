import { describe, expect, it } from 'vitest'
import {
  dripTrialNote,
  fillSendTimeParams,
  formatIndianPhone,
  needsSendTimeValues,
  needsTrialLink,
  pickDripAgent,
} from './broadcast-drip'

const agents = { 'user-deepa': { phone: '919893795404' }, 'user-puru': { phone: '916207850082' } }

describe('drip send-time values', () => {
  it('spots params that need per-lead values', () => {
    expect(needsSendTimeValues(['{first_name}'])).toBe(false)
    expect(needsSendTimeValues(['{agent_name}'])).toBe(true)
    expect(needsTrialLink(['{agent_phone}'])).toBe(false)
    expect(needsTrialLink(['{trial_link}'])).toBe(true)
  })

  it('fills link, name and phone', () => {
    expect(
      fillSendTimeParams(['{trial_link}', '{agent_name}', '{agent_phone}'], {
        trial_link: 'https://x/s?t=1', agent_name: 'Deepa Tyagi', agent_phone: '+91 98937 95404',
      }),
    ).toEqual(['https://x/s?t=1', 'Deepa Tyagi', '+91 98937 95404'])
  })

  it('names the assigned agent when listed, else a stable pick', () => {
    expect(pickDripAgent(agents, 'user-puru', 'c1')).toBe('user-puru')
    const other = pickDripAgent(agents, 'admin', 'contact-abc')
    expect(['user-deepa', 'user-puru']).toContain(other)
    expect(pickDripAgent(agents, null, 'contact-abc')).toBe(other)
    expect(pickDripAgent({}, 'user-puru', 'c1')).toBeNull()
  })

  it('splits unassigned leads between agents', () => {
    const picks = Array.from({ length: 200 }, (_, i) => pickDripAgent(agents, null, `contact-${i}`))
    const deepa = picks.filter((p) => p === 'user-deepa').length
    expect(deepa).toBeGreaterThan(60)
    expect(deepa).toBeLessThan(140)
  })

  it('formats Indian numbers', () => {
    expect(formatIndianPhone('919893795404')).toBe('+91 98937 95404')
    expect(formatIndianPhone('6207850082')).toBe('+91 62078 50082')
    expect(formatIndianPhone('+1 555 0100')).toBe('+1 555 0100')
  })

  it('builds a filterable note within 120 chars', () => {
    expect(dripTrialNote('Bcast 24 Nov', 'Deepa Tyagi', '919876543210')).toBe('Bcast 24 Nov | Deepa Tyagi | 919876543210')
    expect(dripTrialNote(undefined, 'A'.repeat(200), '91').length).toBe(120)
  })
})
